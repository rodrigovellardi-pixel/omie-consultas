import { generateText, Output } from "ai";
import { z } from "zod";
import {
  analyzeProductReplenishment,
  dailyOpenFinancialMovements,
  salesSummaryForAlexa,
  searchProductsWithStock
} from "./omie.js";


const HELP = "Posso consultar estoque, reposição, vendas faturadas, contas a pagar, contas a receber e fluxo de caixa. Por exemplo: estoque de Barion.";
const CONTINUE = "Você pode pedir outra consulta.";


const jarvisRouteSchema = z.object({
  acao: z.enum(["estoque", "reposicao", "vendas", "contas_pagar", "contas_receber", "fluxo_caixa", "ajuda", "conversa"]),
  termo: z.string().nullable(),
  data_inicio: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).nullable(),
  data_fim: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).nullable()
});


function fortalezaToday() {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date());
}


function formatMoney(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}


function plainText(value) {
  return String(value || "").replace(/[<>]/g, "").trim();
}


function response(speech, {
  endSession = false,
  reprompt = CONTINUE,
  sessionAttributes = {},
  cardTitle = "Jarvis — Omie Consultas",
  cardContent
} = {}) {
  const text = plainText(speech).slice(0, 7600);
  const result = {
    version: "1.0",
    sessionAttributes,
    response: {
      outputSpeech: { type: "PlainText", text },
      shouldEndSession: endSession
    }
  };
  if (!endSession && reprompt) {
    result.response.reprompt = { outputSpeech: { type: "PlainText", text: plainText(reprompt) } };
  }
  if (cardContent || text) {
    result.response.card = {
      type: "Simple",
      title: cardTitle,
      content: plainText(cardContent || text).slice(0, 8000)
    };
  }
  return result;
}


function slot(intent, name) {
  return intent?.slots?.[name]?.value?.trim() || null;
}


function isoToBr(value, today = fortalezaToday()) {
  const match = /^(\d{4}|XXXX)-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const currentYear = today.split("/")[2];
  const year = match[1] === "XXXX" ? currentYear : match[1];
  return `${match[3]}/${match[2]}/${year}`;
}


const MONTHS = Object.freeze({
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12
});


const PORTUGUESE_NUMBERS = Object.freeze({
  zero: 0, um: 1, uma: 1, primeiro: 1, primeira: 1, dois: 2, duas: 2, segundo: 2, segunda: 2,
  tres: 3, terceiro: 3, terceira: 3, quatro: 4, quarto: 4, quarta: 4, cinco: 5, quinto: 5, quinta: 5,
  seis: 6, sexto: 6, sexta: 6, sete: 7, setimo: 7, setima: 7, oito: 8, oitavo: 8, oitava: 8,
  nove: 9, nono: 9, nona: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14,
  quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30,
  quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90,
  cem: 100, cento: 100, duzentos: 200, trezentos: 300, quatrocentos: 400, quinhentos: 500,
  seiscentos: 600, setecentos: 700, oitocentos: 800, novecentos: 900
});


function normalizeSpokenText(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9/\-\s]/g, " ")
    .replace(/\s+/g, " ").trim();
}


function portugueseNumber(value) {
  const text = normalizeSpokenText(value);
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  let current = 0;
  for (const word of text.split(" ")) {
    if (!word || word === "e") continue;
    if (word === "mil") {
      total += (current || 1) * 1000;
      current = 0;
      continue;
    }
    if (!(word in PORTUGUESE_NUMBERS)) return null;
    current += PORTUGUESE_NUMBERS[word];
  }
  return total + current;
}


function parseSpokenSalesDay(value, today = fortalezaToday()) {
  const normalized = normalizeSpokenText(value).replace(/^dia\s+/, "");
  if (normalized === "hoje") return today;
  const numeric = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(normalized);
  if (numeric) {
    const year = numeric[3] || today.split("/")[2];
    return `${numeric[1].padStart(2, "0")}/${numeric[2].padStart(2, "0")}/${year}`;
  }
  const iso = isoToBr(normalized, today);
  if (iso) return iso;
  const match = /^(.+?)\s+de\s+([a-z]+)(?:\s+de\s+(.+))?$/.exec(normalized);
  if (!match || !MONTHS[match[2]]) return null;
  const day = portugueseNumber(match[1]);
  const year = match[3] ? portugueseNumber(match[3]) : Number(today.split("/")[2]);
  if (!Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return `${String(day).padStart(2, "0")}/${String(MONTHS[match[2]]).padStart(2, "0")}/${year}`;
}


function parseSpokenMonth(value, today = fortalezaToday()) {
  const normalized = normalizeSpokenText(value).replace(/^(?:mes\s+de|mes)\s+/, "");
  const isoMonth = /^(\d{4})-(\d{2})$/.exec(normalized);
  let year;
  let month;
  if (isoMonth) {
    year = Number(isoMonth[1]);
    month = Number(isoMonth[2]);
  } else {
    const match = /^([a-z]+)(?:\s+de\s+(.+))?$/.exec(normalized);
    if (!match || !MONTHS[match[1]]) return null;
    month = MONTHS[match[1]];
    year = match[2] ? portugueseNumber(match[2]) : Number(today.split("/")[2]);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthText = String(month).padStart(2, "0");
  return {
    data_inicio: `01/${monthText}/${year}`,
    data_fim: `${String(lastDay).padStart(2, "0")}/${monthText}/${year}`
  };
}


function datesFromSpokenSlot(intent) {
  const spoken = slot(intent, "dataFalado");
  if (!spoken) return null;
  const normalized = normalizeSpokenText(spoken);
  const month = parseSpokenMonth(normalized);
  if (month) return month;
  const parts = normalized.split(/\s+(?:ate|a)\s+/);
  const start = parseSpokenSalesDay(parts[0]);
  const end = parts[1] ? parseSpokenSalesDay(parts[1]) : start;
  if (!start || !end) return null;
  return { data_inicio: start, data_fim: end };
}


function hasFutureAlexaDate(intent, today = fortalezaToday()) {
  const currentYear = Number(today.split("/")[2]);
  return ["periodo", "inicio", "fim"].some((name) => {
    const value = slot(intent, name);
    const match = /^(\d{4})-\d{2}-\d{2}$/.exec(String(value || ""));
    return match && Number(match[1]) > currentYear;
  });
}


function currentYearForFutureDates(date, today = fortalezaToday()) {
  if (!date) return date;
  const [day, month, year] = date.split("/");
  const currentYear = Number(today.split("/")[2]);
  return Number(year) > currentYear ? `${day}/${month}/${currentYear}` : date;
}


function datesFromIntent(intent, { historical = false } = {}) {
  const period = slot(intent, "periodo");
  if (period?.includes("/")) {
    const [start, end] = period.split("/");
    return { data_inicio: isoToBr(start), data_fim: isoToBr(end) };
  }
  const start = isoToBr(slot(intent, "inicio"));
  const end = isoToBr(slot(intent, "fim"));
  const single = isoToBr(period);
  const today = fortalezaToday();
  const dates = { data_inicio: start || single || today, data_fim: end || single || start || today };
  if (!historical) return dates;
  return {
    data_inicio: currentYearForFutureDates(dates.data_inicio, today),
    data_fim: currentYearForFutureDates(dates.data_fim, today)
  };
}


function hasRecognizedDate(intent) {
  return ["dataFalado", "periodo", "inicio", "fim"].some((name) => Boolean(slot(intent, name)));
}


function describeStock(result) {
  if (!result.quantidade_produtos) return `Não encontrei produtos com ${result.termo}.`;
  const items = result.produtos.slice(0, 3).map((product) =>
    `${product.descricao}: ${product.estoque_disponivel_total} ${product.unidade || "unidades"} disponíveis`
  );
  const remainder = result.quantidade_produtos > 3
    ? ` Há mais ${result.quantidade_produtos - 3} produtos; os detalhes aparecem na tela.`
    : "";
  return `Encontrei ${result.quantidade_produtos} produtos. ${items.join(". ")}.${remainder}`;
}


function stockCard(result) {
  return result.produtos.map((product) =>
    `${product.codigo} — ${product.descricao}\nDisponível: ${product.estoque_disponivel_total} ${product.unidade || ""}\nPreço: ${formatMoney(product.preco)}`
  ).join("\n\n");
}


function describeReplenishment(result) {
  if (!result.produtos_analisados) return `Não encontrei produto ativo com ${result.termo}.`;
  const product = result.produtos[0];
  return `${product.descricao}. Estoque disponível: ${product.estoque.disponivel}. Cobertura atual: ${product.cobertura_dias_atual ?? "sem giro calculado"} dias. Sugestão de compra: ${product.quantidade_sugerida_compra} ${product.unidade || "unidades"}. Urgência ${product.urgencia_reposicao}.`;
}


function describeFinance(result, nature) {
  const payable = result.totais.contas_a_pagar;
  const receivable = result.totais.contas_a_receber;
  if (nature === "pagar") return `De ${result.data_inicio} a ${result.data_fim}, há ${payable.quantidade} títulos a pagar, totalizando ${formatMoney(payable.valor_em_aberto)}.`;
  if (nature === "receber") return `De ${result.data_inicio} a ${result.data_fim}, há ${receivable.quantidade} títulos a receber, totalizando ${formatMoney(receivable.valor_em_aberto)}.`;
  return `De ${result.data_inicio} a ${result.data_fim}, há ${formatMoney(receivable.valor_em_aberto)} a receber e ${formatMoney(payable.valor_em_aberto)} a pagar. O saldo previsto é ${formatMoney(result.totais.saldo_liquido_previsto)}.`;
}


function financeCard(result) {
  const rows = result.por_dia
    .filter((row) => row.contas_a_pagar.quantidade || row.contas_a_receber.quantidade)
    .map((row) => `${row.vencimento}: receber ${formatMoney(row.contas_a_receber.valor_em_aberto)} | pagar ${formatMoney(row.contas_a_pagar.valor_em_aberto)} | saldo ${formatMoney(row.saldo_liquido_previsto)}`);
  return rows.join("\n") || "Nenhum título em aberto no período.";
}


function describeSalesSummary(result, data_inicio, data_fim) {
  const orders = Number(result?.pedidoVenda?.nFaturadas) || 0;
  const total = Number(result?.pedidoVenda?.vFaturadas) || 0;
  return `De ${data_inicio} a ${data_fim}, encontrei ${orders} pedidos faturados e faturamento de ${formatMoney(total)}.`;
}


function salesSummaryCard(result, data_inicio, data_fim) {
  const sales = result?.pedidoVenda || {};
  return `Período: ${data_inicio} a ${data_fim}\nPedidos faturados: ${Number(sales.nFaturadas) || 0}\nFaturamento: ${formatMoney(sales.vFaturadas)}\nPedidos cancelados: ${Number(sales.nCanceladas) || 0}\nValor cancelado: ${formatMoney(sales.vCanceladas)}`;
}


async function classifyFreeQuery(query, today, generate = generateText) {
  const { output } = await generate({
    model: process.env.JARVIS_AI_MODEL || "openai/gpt-5-mini",
    output: Output.object({ schema: jarvisRouteSchema }),
    providerOptions: { openai: { reasoningEffort: "minimal" } },
    prompt: `Você roteia comandos falados para o assistente Jarvis. Hoje é ${today}.\n` +
      "Escolha somente uma ação de consulta. Nunca escolha nem sugira alteração, inclusão, baixa, cancelamento ou exclusão no Omie. " +
      "Para estoque e reposição, extraia o termo do produto. Para consultas por período, resolva as datas em DD/MM/AAAA. " +
      "Se não for uma consulta empresarial suportada, use conversa.\nComando: " + query
  });
  return output;
}


async function answerGeneralQuery(query, generate = generateText) {
  const { text } = await generate({
    model: process.env.JARVIS_AI_MODEL || "openai/gpt-5-mini",
    providerOptions: { openai: { reasoningEffort: "minimal" } },
    maxOutputTokens: 140,
    system: "Você é Jarvis, um assistente de escritório em português do Brasil. Responda em no máximo duas frases, próprias para voz. Não afirme ter consultado dados ou integrações que não foram fornecidos. Não execute ações.",
    prompt: query
  });
  return plainText(text);
}


export async function executeJarvisAction(action, parameters, dependencies = {}) {
  const searchStock = dependencies.searchProductsWithStock || searchProductsWithStock;
  const replenish = dependencies.analyzeProductReplenishment || analyzeProductReplenishment;
  const finance = dependencies.dailyOpenFinancialMovements || dailyOpenFinancialMovements;
  const salesSummary = dependencies.salesSummaryForAlexa || salesSummaryForAlexa;


  if (action === "estoque") {
    if (!parameters.termo) return response("Diga o nome do produto que deseja consultar.");
    const result = await searchStock({ termo: parameters.termo, consolidar_locais: true });
    return response(describeStock(result), { cardContent: stockCard(result) });
  }
  if (action === "reposicao") {
    if (!parameters.termo) return response("Diga o nome do produto que deseja analisar.");
    const result = await replenish({ termo: parameters.termo, limite_produtos: 3 });
    return response(describeReplenishment(result), { cardContent: JSON.stringify(result.produtos, null, 2) });
  }
  if (["contas_pagar", "contas_receber", "fluxo_caixa"].includes(action)) {
    const nature = action === "contas_pagar" ? "pagar" : action === "contas_receber" ? "receber" : "ambos";
    const result = await finance({
      data_inicio: parameters.data_inicio || fortalezaToday(),
      data_fim: parameters.data_fim || parameters.data_inicio || fortalezaToday(),
      natureza: nature
    });
    return response(describeFinance(result, nature), { cardContent: financeCard(result) });
  }
  if (action === "vendas") {
    const data_inicio = parameters.data_inicio || fortalezaToday();
    const data_fim = parameters.data_fim || parameters.data_inicio || fortalezaToday();
    const result = await salesSummary({ data_inicio, data_fim });
    return response(describeSalesSummary(result, data_inicio, data_fim), {
      cardContent: salesSummaryCard(result, data_inicio, data_fim)
    });
  }
  if (action === "ajuda") return response(HELP);
  return null;
}


async function dispatchIntent(intent, dependencies = {}) {
  const name = intent?.name;
  if (name === "AMAZON.HelpIntent") return response(HELP);
  if (name === "EstoqueProdutoIntent") return executeJarvisAction("estoque", { termo: slot(intent, "produto") }, dependencies);
  if (name === "ReposicaoProdutoIntent") return executeJarvisAction("reposicao", { termo: slot(intent, "produto") }, dependencies);
  if (["ContasPagarIntent", "ContasReceberIntent", "FluxoCaixaIntent", "VendasPeriodoIntent"].includes(name)) {
    const action = {
      ContasPagarIntent: "contas_pagar",
      ContasReceberIntent: "contas_receber",
      FluxoCaixaIntent: "fluxo_caixa",
      VendasPeriodoIntent: "vendas"
    }[name];
    if (action === "vendas" && !hasRecognizedDate(intent)) {
      return response("Não consegui identificar a data da venda. Diga, por exemplo: vendas de três de setembro.");
    }
    if (slot(intent, "dataFalado")) {
      const dates = datesFromSpokenSlot(intent);
      if (!dates) return response("Não consegui entender a data. Diga, por exemplo: vendas de três de setembro de dois mil e vinte e seis.");
      return executeJarvisAction(action, dates, dependencies);
    }
    // Compatibilidade com modelos antigos da Alexa: frases de venda estavam sendo
    // classificadas como fluxo de caixa e AMAZON.DATE convertia 2026 em 2027.
    // Uma data futura recebida nesse formato é tratada como venda histórica no ano atual.
    if (name === "FluxoCaixaIntent" && hasFutureAlexaDate(intent)) {
      return executeJarvisAction("vendas", datesFromIntent(intent, { historical: true }), dependencies);
    }
    return executeJarvisAction(action, datesFromIntent(intent, { historical: action === "vendas" }), dependencies);
  }
  if (name === "ConsultaLivreIntent") {
    const query = slot(intent, "consulta");
    if (!query) return response(HELP);
    try {
      const route = await classifyFreeQuery(query, fortalezaToday(), dependencies.generateText || generateText);
      const businessResponse = await executeJarvisAction(route.acao, route, dependencies);
      if (businessResponse) return businessResponse;
      if (route.acao === "ajuda") return response(HELP);
      return response(await answerGeneralQuery(query, dependencies.generateText || generateText));
    } catch {
      return response("Não consegui interpretar essa frase agora. " + HELP);
    }
  }
  return response("Não entendi o pedido. " + HELP);
}


async function dispatchIntentSafely(intent, sessionAttributes, dependencies = {}) {
  try {
    const result = await dispatchIntent(intent, dependencies);
    result.sessionAttributes = sessionAttributes;
    return result;
  } catch (error) {
    console.error("Jarvis query error:", error instanceof Error ? error.message : "unknown error");
    return response(
      "Não consegui concluir essa consulta no Omie agora. Tente novamente em instantes ou faça outra consulta.",
      { sessionAttributes }
    );
  }
}


export function validateAlexaApplication(requestEnvelope, expectedSkillId = process.env.ALEXA_SKILL_ID) {
  const actual = requestEnvelope?.session?.application?.applicationId || requestEnvelope?.context?.System?.application?.applicationId;
  if (!expectedSkillId) throw new Error("ALEXA_SKILL_ID não configurado.");
  if (actual !== expectedSkillId) throw new Error("A Skill Alexa não foi autorizada para este endpoint.");
}


export async function handleAlexaEnvelope(envelope, dependencies = {}) {
  const type = envelope?.request?.type;
  const attributes = { ...(envelope?.session?.attributes || {}) };


  if (type === "SessionEndedRequest") return response("Até logo.", { endSession: true });
  if (type === "LaunchRequest") {
    return response("Jarvis conectado ao Omie Consultas. O que deseja consultar?");
  }


  const intent = envelope?.request?.intent;
  if (["AMAZON.StopIntent", "AMAZON.CancelIntent"].includes(intent?.name)) {
    return response("Sessão encerrada. Até logo.", { endSession: true });
  }


  return dispatchIntentSafely(intent, attributes, dependencies);
}
