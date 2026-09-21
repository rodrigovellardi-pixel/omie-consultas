import assert from "node:assert/strict";
import test from "node:test";
import { callOmie } from "../lib/omie.js";


test("seleciona credenciais da matriz e da filial sem misturá-las", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const requests = [];

  process.env.OMIE_APP_KEY = "matriz-legada-key";
  process.env.OMIE_APP_SECRET = "matriz-legada-secret";
  process.env.OMIE_FILIAL_APP_KEY = "filial-key";
  process.env.OMIE_FILIAL_APP_SECRET = "filial-secret";

  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  await callOmie("listar_produtos", {}, { empresa: "matriz", maxAttempts: 1 });
  await callOmie("listar_produtos", {}, { empresa: "filial", maxAttempts: 1 });

  assert.equal(requests[0].app_key, "matriz-legada-key");
  assert.equal(requests[0].app_secret, "matriz-legada-secret");
  assert.equal(requests[1].app_key, "filial-key");
  assert.equal(requests[1].app_secret, "filial-secret");
});


test("mantém matriz como padrão para compatibilidade com a Alexa", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let requestBody;

  process.env.OMIE_APP_KEY = "matriz-key";
  process.env.OMIE_APP_SECRET = "matriz-secret";
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  await callOmie("listar_produtos", {}, { maxAttempts: 1 });
  assert.equal(requestBody.app_key, "matriz-key");
});
