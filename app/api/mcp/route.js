import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  analyzeProductReplenishment,
  callOmie,
  createOmieTelemetry,
  countSalesOrdersByProject,
  dailyOpenFinancialMovements,
  dailyOpenReceivables,
  financeSnapshot,
  invoicedProductsReport,
  inactiveCustomersReport,
  purchasesSummary,
  READ_ONLY_OPERATIONS,
  salesSummary,
  searchProductsWithStock
} from "../../../lib/omie.js";


const LOCAL_READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});


const OMIE_READ_ONLY_ANNOTATIONS = Object.freeze({
  ...LOCAL_READ_ONLY_ANNOTATIONS,
  openWorldHint: true
});


// Mantém compatibilidade com clientes MCP já conectados que expõem MATRIZ,
// FILIAL e CONSOLIDADO, enquanto a implementação interna usa minúsculas.
const EMPRESA_SCHEMA = z.preprocess((value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return ({ consolidado: "ambas", matriz: "matriz", filial: "filial", ambas: "ambas" })[normalized] || value;
}, z.enum(["matriz", "filial", "ambas"])) .default("ambas")
  .describe("Empresa consultada. Use ambas para pesquisar matriz e filial na mesma chamada.");


function companyCaller(empresa) {
  const telemetry = createOmieTelemetry(empresa);
  const caller = (operationName, params = {}, options = {}) =>
    callOmie(operationName, params, { ...options, empresa, telemetry });
  // Identifica o invólucro interno sem expor credenciais. As consultas de
  // reposição usam esse sinal para aplicar a agregação rápida de vendas.
  caller.__omieFastAggregation = true;
  caller.__omieEmpresa = empresa;
  caller.__omieTelemetry = telemetry;
  return caller;
}


async function runByCompany(empresa, runner) {
  if (empresa !== "ambas") {
    const caller = companyCaller(empresa);
    const dados = await runner(caller, empresa);
    if (!dados || typeof dados !== "object" || Array.isArray(dados)) return dados;
    return {
      ...dados,
      diagnostico_omie: caller.__omieTelemetry.snapshot({ skus_processados: dados.produtos_analisados || dados.produtos?.length || 0 })
    };
  }

  const empresas = {};
  const erros_por_empresa = {};
  const consultas = ["matriz", "filial"].map(async (nome) => {
    const caller = companyCaller(nome);
    try {
      const dados = await runner(caller, nome);
      return { nome, dados, diagnostico: caller.__omieTelemetry.snapshot({ skus_processados: dados?.produtos_analisados || dados?.produtos?.length || 0 }) };
    } catch (error) {
      return { nome, erro: error.message, diagnostico: caller.__omieTelemetry.snapshot() };
    }
  });
  const resultados = await Promise.all(consultas);
  for (const resultado of resultados) {
    if (resultado.erro) {
      erros_por_empresa[resultado.nome] = resultado.erro;
    } else {
      empresas[resultado.nome] = resultado.dados;
    }
  }

  if (Object.keys(empresas).length === 0) {
    throw new Error(`Não foi possível consultar nenhuma empresa: ${JSON.stringify(erros_por_empresa)}`);
  }
  return {
    escopo: "ambas",
    empresas,
    diagnostico_omie: Object.fromEntries(resultados.map(({ nome, diagnostico }) => [nome, diagnostico])),
    ...(Object.keys(erros_por_empresa).length ? { erros_por_empresa } : {})
  };
}


async function scopedQuery(params, queryFn) {
  const { empresa = "ambas", ...query } = params;
  return runByCompany(empresa, (callFn) => queryFn(query, callFn));
}


function normalizedProductKey(product) {
  return `${String(product.descricao || "").trim().toLocaleLowerCase("pt-BR")}|${String(product.unidade || "").trim().toLocaleUpperCase("pt-BR")}`;
}


function consolidateProductStock(result) {
  if (result?.escopo !== "ambas") return result;
  const consolidated = new Map();
  for (const empresa of ["matriz", "filial"]) {
    for (const product of result.empresas?.[empresa]?.produtos || []) {
      const key = normalizedProductKey(product);
      const current = consolidated.get(key) || {
        descricao: product.descricao,
        unidade: product.unidade,
        estoque_fisico_total: 0,
        estoque_reservado_total: 0,
        estoque_disponivel_total: 0,
        empresas_presentes: [],
        codigos_por_empresa: {},
        precos_por_empresa: {}
      };
      current.estoque_fisico_total += Number(product.estoque_fisico_total) || 0;
      current.estoque_reservado_total += Number(product.estoque_reservado_total) || 0;
      current.estoque_disponivel_total += Number(product.estoque_disponivel_total) || 0;
      current.empresas_presentes.push(empresa);
      current.codigos_por_empresa[empresa] = {
        id_produto: product.id_produto,
        codigo: product.codigo
      };
      current.precos_por_empresa[empresa] = product.preco;
      consolidated.set(key, current);
    }
  }
  return {
    ...result,
    consolidado: {
      criterio: "descrição e unidade iguais, sem diferenciar maiúsculas, minúsculas ou espaços nas pontas",
      quantidade_produtos: consolidated.size,
      produtos: [...consolidated.values()]
    }
  };
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((asNumber(value) + Number.EPSILON) * factor) / factor;
}

function combinedTrend(d30, d60, d90) {
  if (d30 === 0 && d60 === 0 && d90 === 0) return "ESTAVEL";
  if (d30 >= d60 * 1.1 && d60 >= d90 * 1.1) return "ACELERANDO";
  if (d30 <= d60 * 0.9 && d60 <= d90 * 0.9) return "DESACELERANDO";
  return "ESTAVEL";
}

// A ferramenta de reposição devolve também uma visão única por SKU. O modelo
// não precisa somar empresas nem inferir a regra de trânsito fora do backend.
function consolidateReplenishment(result) {
  if (result?.escopo !== "ambas") return result;
  const products = new Map();
  const dadosCompletos = !result.erros_por_empresa && ["matriz", "filial"].every((empresa) => result.empresas?.[empresa]);
  const parametros = Object.values(result.empresas || {}).find((value) => value?.parametros_reposicao)?.parametros_reposicao || {};

  for (const empresa of ["matriz", "filial"]) {
    for (const product of result.empresas?.[empresa]?.produtos || []) {
      const key = normalizedProductKey(product);
      const current = products.get(key) || {
        produto: product.descricao,
        sku: product.codigo,
        unidade: product.unidade,
        estoque_fisico_matriz: 0,
        estoque_fisico_filial: 0,
        estoque_em_transito: 0,
        faturada_ainda_nao_recebida: 0,
        venda_30d: 0,
        venda_60d: 0,
        venda_90d: 0,
        empresas_presentes: []
      };
      const physical = asNumber(product.estoque?.fisico);
      current[`estoque_fisico_${empresa}`] += physical;
      current.estoque_em_transito += asNumber(product.estoque?.faturada_em_transito);
      current.faturada_ainda_nao_recebida += asNumber(product.estoque?.faturada_em_transito);
      current.venda_30d += asNumber(product.vendas?.ultimos_30_dias?.venda_liquida);
      current.venda_60d += asNumber(product.vendas?.ultimos_60_dias?.venda_liquida);
      current.venda_90d += asNumber(product.vendas?.ultimos_90_dias?.venda_liquida);
      current.empresas_presentes.push(empresa);
      products.set(key, current);
    }
  }

  const consolidated = [...products.values()].map((product) => {
    const estoqueFisico = product.estoque_fisico_matriz + product.estoque_fisico_filial;
    const media30 = product.venda_30d / 30;
    const media60 = product.venda_60d / 60;
    const media90 = product.venda_90d / 90;
    const demandaBase = (media30 * 0.5) + (media60 * 0.3) + (media90 * 0.2);
    const estoqueProjetado = estoqueFisico + product.estoque_em_transito;
    const coberturaFisica = demandaBase > 0 ? estoqueFisico / demandaBase : null;
    const coberturaProjetada = demandaBase > 0 ? estoqueProjetado / demandaBase : null;
    const coberturaAlvo = Math.max(asNumber(parametros.dias_cobertura_alvo), asNumber(parametros.dias_lead_time) + asNumber(parametros.dias_seguranca));
    const quantidadeSugerida = dadosCompletos ? Math.max(Math.ceil((demandaBase * coberturaAlvo) - estoqueFisico - product.estoque_em_transito), 0) : null;
    return {
      ...product,
      estoque_fisico_total_consolidado: round(estoqueFisico),
      estoque_em_transito: round(product.estoque_em_transito),
      faturada_ainda_nao_recebida: round(product.faturada_ainda_nao_recebida),
      estoque_projetado: round(estoqueProjetado),
      venda_30d: round(product.venda_30d),
      venda_60d: round(product.venda_60d),
      venda_90d: round(product.venda_90d),
      media_dia_30d: round(media30),
      media_dia_60d: round(media60),
      media_dia_90d: round(media90),
      media_dia_base: round(demandaBase),
      tendencia: combinedTrend(media30, media60, media90),
      cobertura_fisica_dias: coberturaFisica === null ? null : round(coberturaFisica, 1),
      cobertura_projetada_dias: coberturaProjetada === null ? null : round(coberturaProjetada, 1),
      quantidade_sugerida_compra: quantidadeSugerida,
      recomendacao_compra: quantidadeSugerida === null ? "DADOS_INSUFICIENTES" : (quantidadeSugerida > 0 ? "COMPRAR" : "NAO_COMPRAR")
    };
  });
  return {
    ...result,
    consolidado: {
      criterio: "SKU por descrição e unidade; estoque físico soma MATRIZ + FILIAL. data_entrada nula é trânsito e não compõe o físico.",
      dados_completos: dadosCompletos,
      quantidade_produtos: consolidated.length,
      produtos: consolidated
    }
  };
}


const mcpHandler = createMcpHandler(
  (server) => {
    server.tool(
      "omie_status",
      "Verifica a configuração do conector sem revelar credenciais e sem consultar ou alterar dados.",
      {},
      LOCAL_READ_ONLY_ANNOTATIONS,
      async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            versao_conector: "1.0.0",
            modo: "somente_leitura",
            empresas: {
              matriz_configurada: Boolean(
                (process.env.OMIE_MATRIZ_APP_KEY || process.env.OMIE_APP_KEY) &&
                (process.env.OMIE_MATRIZ_APP_SECRET || process.env.OMIE_APP_SECRET)
              ),
              filial_configurada: Boolean(
                process.env.OMIE_FILIAL_APP_KEY && process.env.OMIE_FILIAL_APP_SECRET
              )
            },
            acesso_protegido: Boolean(process.env.MCP_ACCESS_TOKEN),
            operacoes_permitidas: Object.keys(READ_ONLY_OPERATIONS),
            consultas_otimizadas: [
              "buscar_produtos_com_estoque",
              "analisar_reposicao_produtos",
              "contar_pedidos_por_projeto",
              "listar_produtos_vendidos_periodo",
              "relatorio_clientes_inativos",
              "resumir_boletos_receber_por_vencimento",
              "resumir_contas_por_vencimento",
              "resumo_financeiro",
              "resumo_vendas_periodo",
              "resumo_compras_periodo"
            ]
          }, null, 2)
        }]
      })
    );


    server.tool(
      "omie_consultar",
      "Executa uma operação da lista fechada de consultas ao Omie. Não inclui, altera, baixa, fatura, cancela ou exclui registros.",
      {
        empresa: EMPRESA_SCHEMA,
        operacao: z.enum(Object.keys(READ_ONLY_OPERATIONS)),
        parametros: z.record(z.unknown()).optional()
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async ({ empresa, operacao, parametros }) => {
        try {
          const data = await runByCompany(empresa, (callFn) => callFn(operacao, parametros || {}));
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );


    server.tool(
      "buscar_produtos_com_estoque",
      "Busca produtos por texto usando o filtro nativo do Omie e consulta somente o estoque dos IDs encontrados. Use esta ferramenta para pedidos de cadastro + estoque; ela ignora o campo obsoleto quantidade_estoque e pode consolidar todos os locais. Operação exclusivamente de leitura.",
      {
        empresa: EMPRESA_SCHEMA,
        termo: z.string().min(2).describe("Texto simples contido na descrição do produto, sem curingas."),
        data: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).optional()
          .describe("Data da posição no formato DD/MM/AAAA. Se omitida, usa hoje em America/Fortaleza."),
        consolidar_locais: z.boolean().default(true)
          .describe("True soma todos os locais; false também detalha cada local de estoque.")
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async (params) => {
        try {
          const data = consolidateProductStock(await scopedQuery(params, searchProductsWithStock));
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );


    server.tool(
      "analisar_reposicao_produtos",
      "Analisa reposição e necessidade de compra em modo somente leitura. Calcula vendas líquidas faturadas em 30/60/90 dias somente para os SKUs encontrados, separa estoque físico de NF faturada em trânsito (data_entrada nula), calcula tendência, cobertura física/projetada e sugestão de compra. Use esta ferramenta para decisões de compra; não use somente o saldo de estoque.",
      {
        empresa: EMPRESA_SCHEMA,
        termo: z.string().min(2)
          .describe("Texto contido na descrição do produto, por exemplo Cobertop."),
        data_referencia: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).optional()
          .describe("Data-base no formato DD/MM/AAAA. Se omitida, usa hoje em America/Fortaleza."),
        dias_historico: z.number().int().min(90).max(365).default(90)
          .describe("Histórico de movimentos. Mínimo 90 dias para calcular as janelas de 30/60/90."),
        dias_cobertura_alvo: z.number().int().min(1).max(180).default(30)
          .describe("Cobertura desejada após considerar vendas e compras pendentes."),
        dias_lead_time: z.number().int().min(0).max(180).default(15)
          .describe("Prazo estimado entre pedir e receber do fornecedor."),
        dias_seguranca: z.number().int().min(0).max(90).default(7)
          .describe("Margem adicional de segurança usada no ponto de reposição."),
        limite_produtos: z.number().int().min(1).max(50).default(50)
          .describe("Máximo de produtos analisados por chamada. O padrão permite uma família completa de fornecedor."),
        unidades_por_caixa: z.record(z.number().positive()).optional()
          .describe("Mapa opcional de SKU para unidades por caixa, por exemplo {\"DOR123\": 12}. Prevalece sobre eventual cadastro do produto.")
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async (params) => {
        try {
          const data = consolidateReplenishment(await scopedQuery(params, analyzeProductReplenishment));
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );


    server.tool(
      "listar_produtos_vendidos_periodo",
      "Lista e consolida os produtos vendidos em um período a partir dos itens de pedidos FATURADOS, usando os filtros nativos de data de faturamento do Omie. Retorna código, descrição, unidade, quantidade, pedidos, valores, preço médio e última venda. Use para giro, curva de vendas, margem e bases de CMV; não use listar_movimentos_estoque para esse pedido. Exclui cancelados, denegados, ainda não faturados e devolvidos. Operação exclusivamente de leitura.",
      {
        empresa: EMPRESA_SCHEMA,
        data_inicio: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Início do período no formato DD/MM/AAAA."),
        data_fim: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Fim do período no formato DD/MM/AAAA."),
        ordenar_por: z.enum(["valor_total", "quantidade", "descricao"]).default("valor_total")
          .describe("Ordenação final dos produtos consolidados.")
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async (params) => {
        try {
          const data = await scopedQuery(params, invoicedProductsReport);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );


    server.tool(
      "contar_pedidos_por_projeto",
      "Conta pedidos de venda de um projeto em um período sem baixar todas as vendas. Resolve o ID do projeto pelo nome e usa, por padrão, a data de faturamento e somente pedidos FATURADOS. Use para perguntas sobre quantos pedidos ou vendas saíram de uma unidade identificada pelo campo Projeto. Operação exclusivamente de leitura.",
      {
        empresa: EMPRESA_SCHEMA,
        projeto: z.string().min(2)
          .describe("Nome completo ou trecho único do projeto, por exemplo Entrega Messejana."),
        data_inicio: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Início do período no formato DD/MM/AAAA."),
        data_fim: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Fim do período no formato DD/MM/AAAA."),
        criterio_data: z.enum(["faturamento", "previsao"]).default("faturamento")
          .describe("Faturamento representa a saída efetiva; previsão usa a data prevista do pedido."),
        status: z.enum(["FATURADO", "CANCELADO", "AUTORIZADO", "DENEGADO", "DEVOLVIDO"])
          .default("FATURADO")
          .describe("Status dos pedidos que serão contados.")
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async (params) => {
        try {
          const data = await scopedQuery(params, countSalesOrdersByProject);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );


    server.tool(
      "resumir_contas_por_vencimento",
      "Consulta contas a pagar, contas a receber ou ambas por intervalo de vencimento usando filtros nativos do Omie. Agrupa dia a dia, soma apenas o saldo em aberto de títulos não liquidados e calcula o saldo líquido previsto. Use esta ferramenta para contas a pagar, contas a receber e fluxo de caixa de um período; não faça paginação manual. Operação exclusivamente de leitura.",
      {
        empresa: EMPRESA_SCHEMA,
        data_inicio: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Primeiro vencimento do período, no formato DD/MM/AAAA."),
        data_fim: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Último vencimento do período, no formato DD/MM/AAAA."),
        natureza: z.enum(["pagar", "receber", "ambos"]).default("ambos")
          .describe("Escolha pagar, receber ou ambos. Use ambos para fluxo de caixa e cruzamentos."),
        tipo_documento: z.enum([
          "TODOS", "ADI", "BOL", "CRT", "CHQ", "CON", "CRE", "DRF", "DAS",
          "DEB", "DIN", "DOC", "GUIA", "PROT", "REC", "RPA", "TED", "TRA", "99999"
        ]).default("TODOS")
          .describe("Tipo de documento. Use TODOS salvo quando o usuário pedir especificamente boletos, cartões, transferências ou outro tipo.")
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async (params) => {
        try {
          const data = await scopedQuery(params, dailyOpenFinancialMovements);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );


    server.tool(
      "resumir_boletos_receber_por_vencimento",
      "Soma boletos a receber por dia de vencimento usando o endpoint de movimentos financeiros e seus filtros nativos de vencimento. Retorna todos os dias do intervalo, inclusive os dias com zero, soma o saldo ainda em aberto e ignora títulos pagos, recebidos ou cancelados. Prefira esta ferramenta a listar_contas_receber para perguntas sobre vencimentos. Operação exclusivamente de leitura.",
      {
        empresa: EMPRESA_SCHEMA,
        data_inicio: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Primeiro vencimento do período, no formato DD/MM/AAAA."),
        data_fim: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Último vencimento do período, no formato DD/MM/AAAA.")
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async (params) => {
        try {
          const data = await scopedQuery(params, dailyOpenReceivables);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );


    server.tool(
      "resumo_financeiro",
      "Obtém em uma única chamada o panorama financeiro do Omie em uma data: saldo das contas correntes, total e atraso de contas a pagar, total e atraso de contas a receber, fluxo de caixa e, opcionalmente, totais por categoria. Use para posição financeira, atrasos e visão executiva. Operação exclusivamente de leitura.",
      {
        empresa: EMPRESA_SCHEMA,
        data_referencia: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).optional()
          .describe("Data-base no formato DD/MM/AAAA. Se omitida, usa hoje em America/Fortaleza."),
        exibir_categorias: z.boolean().default(true)
          .describe("Inclui os totais de contas a pagar e receber por categoria.")
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async (params) => {
        try {
          const data = await scopedQuery(params, financeSnapshot);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );


    server.tool(
      "resumo_vendas_periodo",
      "Obtém o resumo oficial de vendas de produtos em um período: faturamento, documentos fiscais, cupons, pedidos, propostas, cancelamentos, pendências e formas de pagamento disponíveis no Omie. Use para perguntas de vendas totais e desempenho geral; para uma unidade/projeto específico, use contar_pedidos_por_projeto. Operação exclusivamente de leitura.",
      {
        empresa: EMPRESA_SCHEMA,
        data_inicio: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Início do período no formato DD/MM/AAAA."),
        data_fim: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Fim do período no formato DD/MM/AAAA."),
        detalhar: z.boolean().default(false)
          .describe("False retorna o resumo essencial; true solicita todas as estruturas do painel de vendas.")
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async (params) => {
        try {
          const data = await scopedQuery(params, salesSummary);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );


    server.tool(
      "resumo_compras_periodo",
      "Obtém o resumo oficial de compras em um período: notas fiscais de entrada, CT-e de entrada, requisições, pedidos de compra, valores faturados, pendentes, cancelados e totais disponíveis no Omie. Use para visão geral de compras; para decidir reposição de produtos, use analisar_reposicao_produtos. Operação exclusivamente de leitura.",
      {
        empresa: EMPRESA_SCHEMA,
        data_inicio: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Início do período no formato DD/MM/AAAA."),
        data_fim: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
          .describe("Fim do período no formato DD/MM/AAAA.")
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async (params) => {
        try {
          const data = await scopedQuery(params, purchasesSummary);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );


    server.tool(
      "relatorio_clientes_inativos",
      "Gera uma lista de reativação com clientes que possuem compras faturadas no histórico, mas estão sem comprar há pelo menos o número informado de dias. Retorna última compra, dias de inatividade, frequência, contato, vendedor, projeto e prioridade, já ordenados do menor para o maior tempo sem compra. Por padrão analisa 180 dias e retorna até 100 clientes. Não inclui cadastros sem nenhuma compra dentro do histórico analisado. Operação exclusivamente de leitura.",
      {
        empresa: EMPRESA_SCHEMA,
        data_referencia: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).optional()
          .describe("Data-base no formato DD/MM/AAAA. Se omitida, usa hoje em America/Fortaleza."),
        dias_sem_compra_minimo: z.number().int().min(1).max(365).default(30)
          .describe("Quantidade mínima de dias desde a última compra faturada."),
        dias_historico: z.number().int().min(31).max(365).default(180)
          .describe("Janela histórica analisada. Deve ser maior que os dias mínimos sem compra."),
        limite_resultados: z.number().int().min(1).max(200).default(100)
          .describe("Quantidade máxima de clientes retornados, priorizando os mais recentes.")
      },
      OMIE_READ_ONLY_ANNOTATIONS,
      async (params) => {
        try {
          const data = await scopedQuery(params, inactiveCustomersReport);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );
  },
  {},
  { basePath: "/api" }
);


function authorized(request) {
  const expected = process.env.MCP_ACCESS_TOKEN;
  if (!expected) return false;
  const bearer = request.headers.get("authorization");
  const queryToken = new URL(request.url).searchParams.get("access_token");
  return bearer === `Bearer ${expected}` || queryToken === expected;
}


async function protectedHandler(request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return mcpHandler(request);
}


export { protectedHandler as GET, protectedHandler as POST, protectedHandler as DELETE };
