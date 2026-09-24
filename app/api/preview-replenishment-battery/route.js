import {
  analyzeProductReplenishment,
  callOmie,
  createOmieTelemetry
} from "../../../lib/omie.js";

// Esta rota existe somente durante a validação técnica do Preview. Ela não é
// disponibilizada em produção e exige o mesmo token do MCP para executar.
const TEST_CASES = [
  ["OURO BRANCO"],
  ["SONHO DE VALSA"],
  ["OURO BRANCO", "SONHO DE VALSA"],
  ["OURO BRANCO", "SONHO DE VALSA"],
  ["OURO BRANCO", "SONHO DE VALSA"],
  ["OURO BRANCO", "SONHO DE VALSA"],
  ["OURO BRANCO", "SONHO DE VALSA"],
  ["OURO BRANCO", "SONHO DE VALSA"],
  ["OURO BRANCO", "SONHO DE VALSA"],
  ["OURO BRANCO", "SONHO DE VALSA", "BIS", "LACTA", "DIAMANTE NEGRO"]
];

function callerFor(empresa, telemetry) {
  const caller = (operationName, params = {}, options = {}) =>
    callOmie(operationName, params, { ...options, empresa, telemetry });
  caller.__omieFastAggregation = true;
  caller.__omieEmpresa = empresa;
  return caller;
}

function productKey(product) {
  return `${String(product.descricao || "").trim().toLocaleLowerCase("pt-BR")}|${String(product.unidade || "").trim().toLocaleUpperCase("pt-BR")}`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function consolidate(matriz, filial) {
  const products = new Map();
  for (const [empresa, data] of [["matriz", matriz], ["filial", filial]]) {
    for (const item of data?.produtos || []) {
      const key = productKey(item);
      const current = products.get(key) || {
        produto: item.descricao,
        unidade: item.unidade,
        estoque_fisico_matriz: 0,
        estoque_fisico_filial: 0,
        faturada_ainda_nao_recebida: 0,
        venda_90d: 0
      };
      current[`estoque_fisico_${empresa}`] += number(item.estoque?.fisico);
      current.faturada_ainda_nao_recebida += number(item.estoque?.faturada_em_transito);
      current.venda_90d += number(item.vendas?.ultimos_90_dias?.venda_liquida);
      products.set(key, current);
    }
  }
  return [...products.values()].map((item) => ({
    ...item,
    estoque_fisico_total_consolidado: item.estoque_fisico_matriz + item.estoque_fisico_filial,
    estoque_projetado: item.estoque_fisico_matriz + item.estoque_fisico_filial + item.faturada_ainda_nao_recebida,
    media_dia_90d: item.venda_90d / 90
  }));
}

async function executeCase(termos) {
  const started = performance.now();
  const runs = await Promise.all(["matriz", "filial"].map(async (empresa) => {
    const telemetry = createOmieTelemetry(empresa);
    try {
      const data = await analyzeProductReplenishment({
        termos,
        dias_historico: 90,
        limite_produtos: 50
      }, callerFor(empresa, telemetry));
      return {
        empresa,
        data,
        diagnostico: telemetry.snapshot({ skus_processados: data.produtos_analisados || 0 })
      };
    } catch (error) {
      return { empresa, erro: error.message, diagnostico: telemetry.snapshot() };
    }
  }));
  const byCompany = Object.fromEntries(runs.map((run) => [run.empresa, run]));
  const matrix = byCompany.matriz?.data;
  const branch = byCompany.filial?.data;
  return {
    termos,
    duracao_ms: Math.round(performance.now() - started),
    sucesso: Boolean(matrix && branch),
    erros_por_empresa: Object.fromEntries(runs.filter((run) => run.erro).map((run) => [run.empresa, run.erro])),
    diagnostico_omie: Object.fromEntries(runs.map((run) => [run.empresa, run.diagnostico])),
    consolidado: {
      criterio: "MATRIZ + FILIAL; data_entrada nula integra somente faturada_ainda_nao_recebida/estoque projetado.",
      produtos: consolidate(matrix, branch)
    }
  };
}

export async function GET(request) {
  if (process.env.VERCEL_ENV !== "preview") {
    return new Response(null, { status: 404 });
  }
  const expected = process.env.MCP_ACCESS_TOKEN;
  const supplied = new URL(request.url).searchParams.get("access_token");
  if (!expected || supplied !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const results = [];
  for (const terms of TEST_CASES) results.push(await executeCase(terms));
  return Response.json({
    only_preview: true,
    operation: "temporary_replenishment_validation",
    cases: results
  }, { headers: { "cache-control": "no-store" } });
}
