import {
  analyzeProductReplenishment,
  callOmie,
  createOmieTelemetry
} from "../lib/omie.js";

if (process.env.VERCEL_ENV !== "preview" || process.env.RUN_PREVIEW_BATTERY !== "1") {
  process.exit(0);
}

const CASES = [
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
  const caller = (operation, params = {}, options = {}) =>
    callOmie(operation, params, { ...options, empresa, telemetry });
  caller.__omieFastAggregation = true;
  caller.__omieEmpresa = empresa;
  return caller;
}

async function runCase(termos) {
  const started = performance.now();
  const companies = await Promise.all(["matriz", "filial"].map(async (empresa) => {
    const telemetry = createOmieTelemetry(empresa);
    try {
      const data = await analyzeProductReplenishment({ termos, dias_historico: 90, limite_produtos: 50 }, callerFor(empresa, telemetry));
      return {
        empresa,
        ok: true,
        produtos: data.produtos_analisados,
        transito_total: data.produtos.reduce((sum, item) => sum + Number(item.estoque?.faturada_em_transito || 0), 0),
        diagnostico: telemetry.snapshot({ skus_processados: data.produtos_analisados })
      };
    } catch (error) {
      return { empresa, ok: false, erro: error.message, diagnostico: telemetry.snapshot() };
    }
  }));
  return { termos, duracao_ms: Math.round(performance.now() - started), empresas: companies };
}

function compact(result) {
  return {
    termos: result.termos,
    duracao_ms: result.duracao_ms,
    empresas: result.empresas.map((item) => ({
      empresa: item.empresa,
      ok: item.ok,
      erro: item.erro || null,
      produtos: item.produtos || 0,
      transito_total: item.transito_total || 0,
      chamadas_omie: item.diagnostico.chamadas_omie,
      cache_hits: item.diagnostico.cache_hits,
      cache_misses: item.diagnostico.cache_misses,
      cache_stale_hits: item.diagnostico.cache_stale_hits,
      chamadas_coalescidas: item.diagnostico.chamadas_coalescidas,
      retries: item.diagnostico.retries,
      rate_limits: item.diagnostico.rate_limits
    }))
  };
}

for (let index = 0; index < CASES.length; index += 1) {
  const result = compact(await runCase(CASES[index]));
  console.info(`PREVIEW_BATTERY_CASE ${JSON.stringify({ indice: index + 1, ...result })}`);
}
console.info("PREVIEW_BATTERY_COMPLETE");
