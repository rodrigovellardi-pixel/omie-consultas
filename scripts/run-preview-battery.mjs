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

const cases = [];
for (const termos of CASES) cases.push(await runCase(termos));

console.info(`PREVIEW_BATTERY_RESULT ${JSON.stringify({
  only_preview: true,
  cases,
  finished_at: new Date().toISOString()
})}`);
