import { getCache } from "@vercel/functions";

const BASE_URL = "https://app.omie.com.br/api/v1";
// O Omie pode aplicar a proteção de consumo por conta/aplicação, não somente
// por empresa. Uma única fila evita que MATRIZ e FILIAL se bloqueiem entre si.
const OMIE_MIN_INTERVAL_MS = 1_100;
const OMIE_MAX_ATTEMPTS = 5;
const OMIE_MAX_BACKOFF_MS = 30_000;
const OMIE_OPERATION_CACHE = Object.freeze({
  // Cadastro e estrutura mudam pouco. Estoque e pendências ficam curtos para
  // evitar sugerir compra com posição antiga.
  listar_produtos: { ttlMs: 15 * 60_000, staleMs: 60 * 60_000, sharedTtlSeconds: 15 * 60 },
  listar_posicao_estoque: { ttlMs: 30_000, staleMs: 0, sharedTtlSeconds: 30 },
  listar_saldo_pendente: { ttlMs: 60_000, staleMs: 0, sharedTtlSeconds: 60 },
  listar_locais_estoque: { ttlMs: 24 * 60 * 60_000, staleMs: 7 * 24 * 60 * 60_000, sharedTtlSeconds: 24 * 60 * 60 },
  listar_pedidos_venda: { ttlMs: 10 * 60_000, staleMs: 20 * 60_000, sharedTtlSeconds: 10 * 60 },
  listar_movimentos_estoque: { ttlMs: 10 * 60_000, staleMs: 20 * 60_000, sharedTtlSeconds: 10 * 60 },
  listar_produtos_fornecedor: { ttlMs: 60 * 60_000, staleMs: 6 * 60 * 60_000, sharedTtlSeconds: 60 * 60 }
});
const omieResponseCache = new Map();
const omieInflightRequests = new Map();
const omieCompanyQueues = new Map();
const salesAggregationCache = new Map();
let omieCooldownUntil = 0;

export function createOmieTelemetry(empresa = "matriz") {
  const startedAt = Date.now();
  const endpointStats = new Map();
  const totals = {
    chamadas_omie: 0,
    cache_hits: 0,
    cache_misses: 0,
    cache_stale_hits: 0,
    chamadas_coalescidas: 0,
    retries: 0,
    rate_limits: 0
  };

  function endpoint(operationName) {
    const current = endpointStats.get(operationName) || {
      chamadas: 0,
      cache_hits: 0,
      cache_misses: 0,
      coalescidas: 0,
      retries: 0,
      rate_limits: 0,
      duracao_ms: 0
    };
    endpointStats.set(operationName, current);
    return current;
  }

  return {
    cacheHit(operationName, stale = false) {
      totals.cache_hits += 1;
      if (stale) totals.cache_stale_hits += 1;
      endpoint(operationName).cache_hits += 1;
    },
    cacheMiss(operationName) {
      totals.cache_misses += 1;
      endpoint(operationName).cache_misses += 1;
    },
    coalesced(operationName) {
      totals.chamadas_coalescidas += 1;
      endpoint(operationName).coalescidas += 1;
    },
    request(operationName, durationMs) {
      totals.chamadas_omie += 1;
      const stats = endpoint(operationName);
      stats.chamadas += 1;
      stats.duracao_ms += Math.round(durationMs);
    },
    retry(operationName, rateLimited = false) {
      totals.retries += 1;
      endpoint(operationName).retries += 1;
      if (rateLimited) {
        totals.rate_limits += 1;
        endpoint(operationName).rate_limits += 1;
      }
    },
    snapshot(extra = {}) {
      return {
        empresa,
        duracao_total_ms: Date.now() - startedAt,
        ...totals,
        endpoints: Object.fromEntries([...endpointStats.entries()].map(([name, stats]) => [name, {
          ...stats,
          duracao_media_ms: stats.chamadas ? Math.round(stats.duracao_ms / stats.chamadas) : 0
        }])),
        ...extra
      };
    }
  };
}


export const READ_ONLY_OPERATIONS = Object.freeze({
  listar_produtos: {
    path: "/geral/produtos/",
    call: "ListarProdutos",
    defaults: { pagina: 1, registros_por_pagina: 50, apenas_importado_api: "N", filtrar_apenas_omiepdv: "N" }
  },
  consultar_produto: { path: "/geral/produtos/", call: "ConsultarProduto", defaults: {} },
  listar_posicao_estoque: {
    path: "/estoque/consulta/",
    call: "ListarPosEstoque",
    defaults: { nPagina: 1, nRegPorPagina: 50, cExibeTodos: "N", lista_local_estoque: "TODOS" }
  },
  listar_movimentos_estoque: {
    path: "/estoque/consulta/",
    call: "ListarMovimentoEstoque",
    defaults: { nPagina: 1, nRegPorPagina: 50, lista_local_estoque: "TODOS" }
  },
  listar_saldo_pendente: {
    path: "/estoque/consulta/",
    call: "ListarSaldoPendente",
    defaults: { pagina: 1, registros_por_pagina: 50, lista_local_estoque: "TODOS", tipo: "TODOS" }
  },
  listar_notas_entrada: {
    path: "/produtos/nfentrada/",
    call: "ListarNF",
    defaults: { pagina: 1, registros_por_pagina: 50, apenas_importado_api: "N" }
  },
  consultar_movimento_produto: {
    path: "/estoque/consulta/",
    call: "MovimentoEstoque",
    defaults: {}
  },
  listar_locais_estoque: {
    path: "/estoque/local/",
    call: "ListarLocaisEstoque",
    defaults: { nPagina: 1, nRegPorPagina: 100 }
  },
  listar_produtos_fornecedor: {
    path: "/estoque/produtofornecedor/",
    call: "ListarProdutoFornecedor",
    defaults: { pagina: 1, registros_por_pagina: 10, apenas_importado_api: "N" },
    maxPageSize: 10
  },
  listar_pedidos_venda: {
    path: "/produtos/pedido/",
    call: "ListarPedidos",
    defaults: { pagina: 1, registros_por_pagina: 50, apenas_importado_api: "N" }
  },
  consultar_pedido_venda: { path: "/produtos/pedido/", call: "ConsultarPedido", defaults: {} },
  pesquisar_pedidos_compra: {
    path: "/produtos/pedidocompra/",
    call: "PesquisarPedCompra",
    defaults: { nPagina: 1, nRegsPorPagina: 50, lApenasImportadoApi: "F" }
  },
  consultar_pedido_compra: { path: "/produtos/pedidocompra/", call: "ConsultarPedCompra", defaults: {} },
  listar_contas_pagar: {
    path: "/financas/contapagar/",
    call: "ListarContasPagar",
    defaults: { pagina: 1, registros_por_pagina: 50, apenas_importado_api: "N" }
  },
  consultar_conta_pagar: { path: "/financas/contapagar/", call: "ConsultarContaPagar", defaults: {} },
  listar_contas_receber: {
    path: "/financas/contareceber/",
    call: "ListarContasReceber",
    defaults: { pagina: 1, registros_por_pagina: 50, apenas_importado_api: "N" }
  },
  listar_movimentos_financeiros: {
    path: "/financas/mf/",
    call: "ListarMovimentos",
    defaults: { nPagina: 1, nRegPorPagina: 100, lDadosCad: false, cExibirDepartamentos: "N" }
  },
  resumo_financas: {
    path: "/financas/resumo/",
    call: "ObterResumoFinancas",
    defaults: { lApenasResumo: true, lExibirCategoria: true }
  },
  listar_orcamento_caixa: {
    path: "/financas/caixa/",
    call: "ListarOrcamentos",
    defaults: {}
  },
  listar_clientes_fornecedores: {
    path: "/geral/clientes/",
    call: "ListarClientes",
    defaults: { pagina: 1, registros_por_pagina: 50, apenas_importado_api: "N" }
  },
  listar_projetos: {
    path: "/geral/projetos/",
    call: "ListarProjetos",
    defaults: { pagina: 1, registros_por_pagina: 50, apenas_importado_api: "N" }
  },
  listar_vendedores: {
    path: "/geral/vendedores/",
    call: "ListarVendedores",
    defaults: { pagina: 1, registros_por_pagina: 100, apenas_importado_api: "N" }
  },
  resumo_vendas_produtos: {
    path: "/produtos/vendas-resumo/",
    call: "ObterResumoProdutos",
    defaults: { lApenasResumo: true }
  },
  resumo_compras_produtos: {
    path: "/produtos/compras-resumo/",
    call: "ObterResumoCompras",
    defaults: {}
  }
});


function credentials(empresa = "matriz") {
  if (!new Set(["matriz", "filial"]).has(empresa)) {
    throw new Error("Empresa inválida. Use matriz ou filial.");
  }

  const isMatriz = empresa === "matriz";
  const appKey = isMatriz
    ? (process.env.OMIE_MATRIZ_APP_KEY || process.env.OMIE_APP_KEY)
    : process.env.OMIE_FILIAL_APP_KEY;
  const appSecret = isMatriz
    ? (process.env.OMIE_MATRIZ_APP_SECRET || process.env.OMIE_APP_SECRET)
    : process.env.OMIE_FILIAL_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error(`Credenciais da ${empresa} ainda não configuradas no ambiente seguro.`);
  }
  return { appKey, appSecret };
}


function capPageSize(params, maximum = 100) {
  const result = { ...params };
  for (const key of ["registros_por_pagina", "nRegPorPagina", "nRegsPorPagina"]) {
    if (key in result) result[key] = Math.min(Math.max(Number(result[key]) || 1, 1), maximum);
  }
  return result;
}


function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


function omieErrorMessage(dataOrMessage) {
  if (typeof dataOrMessage === "string") return dataOrMessage;
  return String(dataOrMessage?.faultstring || dataOrMessage?.message || dataOrMessage?.raw || "");
}

function isRateLimitResponse(response, data) {
  const message = omieErrorMessage(data).toLowerCase();
  return Number(response?.status) === 429 ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("consumo redundante") ||
    message.includes("(redundant)");
}

function isTransientResponse(response, data) {
  return isRateLimitResponse(response, data) || [408, 425, 500, 502, 503, 504].includes(Number(response?.status));
}

function retryAfterMilliseconds(response, data) {
  const value = response?.headers?.get?.("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(date - Date.now(), 0);
  }
  // Alguns endpoints Omie retornam o período de bloqueio no corpo, como
  // "Aguarde 47 segundos ... (REDUNDANT)", sem Retry-After HTTP.
  const match = omieErrorMessage(data).match(/aguarde\s+(\d+(?:[.,]\d+)?)\s*segundos?/i);
  return match ? Math.ceil(Number(match[1].replace(",", ".")) * 1_000) : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function operationCacheKey(operationName, params, empresa) {
  return `${empresa}:${operationName}:${stableJson(params)}`;
}

function cacheEntryIsFresh(entry, policy) {
  return entry && Date.now() - entry.createdAt <= policy.ttlMs;
}

function cacheEntryIsStaleButUsable(entry, policy) {
  return entry && policy.staleMs > 0 && Date.now() - entry.createdAt <= policy.ttlMs + policy.staleMs;
}

async function readSharedOperationCache(key) {
  if (!process.env.VERCEL) return null;
  try { return await getCache({ namespace: "omie-read" }).get(key); } catch { return null; }
}

async function storeSharedOperationCache(key, data, policy) {
  if (!process.env.VERCEL) return;
  try {
    await getCache({ namespace: "omie-read" }).set(key, { data, createdAt: Date.now() }, {
      ttl: policy.sharedTtlSeconds,
      tags: ["omie-read", key],
      name: "omie-read-through"
    });
  } catch {
    // O cache distribuído é opcional e nunca interrompe a consulta.
  }
}

async function enqueueOmieRequest(empresa, requestFn) {
  const queueKey = "omie-global";
  const state = omieCompanyQueues.get(queueKey) || { queue: Promise.resolve(), nextAt: 0 };
  const queued = state.queue.catch(() => undefined).then(async () => {
    const waitMilliseconds = Math.max(state.nextAt - Date.now(), omieCooldownUntil - Date.now(), 0);
    if (waitMilliseconds > 0) await sleep(waitMilliseconds);
    try {
      return await requestFn();
    } finally {
      state.nextAt = Date.now() + OMIE_MIN_INTERVAL_MS;
    }
  });
  state.queue = queued.then(() => undefined, () => undefined);
  omieCompanyQueues.set(queueKey, state);
  return queued;
}

function setOmieCooldown(milliseconds) {
  if (milliseconds > 0) omieCooldownUntil = Math.max(omieCooldownUntil, Date.now() + milliseconds);
}

export async function retryRateLimitedOmieRequest(
  requestFn,
  waitFn = sleep,
  maxAttempts = OMIE_MAX_ATTEMPTS,
  { telemetry, operationName, random = Math.random } = {}
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result;
    try {
      result = await requestFn();
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const rateLimited = isRateLimitResponse(null, error?.message || String(error));
      telemetry?.retry?.(operationName || "desconhecido", rateLimited);
      const base = Math.min(750 * (2 ** (attempt - 1)), OMIE_MAX_BACKOFF_MS);
      const cooldown = rateLimited ? retryAfterMilliseconds(null, error?.message || String(error)) : 0;
      setOmieCooldown(cooldown);
      await waitFn(Math.max(cooldown, Math.round(base * (0.7 + random() * 0.6))));
      continue;
    }
    const { response, data } = result;
    if (response.ok && !data?.faultstring) return data;
    const message = data?.faultstring || data?.message || `Erro HTTP ${response.status} na consulta ao Omie.`;
    if (!isTransientResponse(response, data) || attempt === maxAttempts) throw new Error(message);

    const rateLimited = isRateLimitResponse(response, data);
    telemetry?.retry?.(operationName || "desconhecido", rateLimited);
    const base = Math.min(750 * (2 ** (attempt - 1)), OMIE_MAX_BACKOFF_MS);
    const cooldown = retryAfterMilliseconds(response, data);
    if (rateLimited) setOmieCooldown(cooldown);
    await waitFn(Math.max(cooldown, Math.round(base * (0.7 + random() * 0.6))));
  }
  throw new Error("A consulta ao Omie excedeu o número máximo de tentativas.");
}

export async function callOmie(operationName, suppliedParams = {}, options = {}) {
  const operation = READ_ONLY_OPERATIONS[operationName];
  if (!operation) throw new Error("Operação bloqueada: o conector aceita somente consultas previamente autorizadas.");
  const empresa = options.empresa || "matriz";
  const { appKey, appSecret } = credentials(empresa);
  const params = capPageSize({ ...operation.defaults, ...suppliedParams }, operation.maxPageSize || 100);
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 25000, 1000), 25000);
  const maxAttempts = Math.min(Math.max(Number(options.maxAttempts) || OMIE_MAX_ATTEMPTS, 1), OMIE_MAX_ATTEMPTS);
  const telemetry = options.telemetry;
  const policy = !options.bypassCache ? OMIE_OPERATION_CACHE[operationName] : null;
  const key = policy ? operationCacheKey(operationName, params, empresa) : null;

  if (policy) {
    const cached = omieResponseCache.get(key);
    if (cacheEntryIsFresh(cached, policy)) {
      telemetry?.cacheHit?.(operationName);
      return cached.data;
    }
    if (cacheEntryIsStaleButUsable(cached, policy)) {
      telemetry?.cacheHit?.(operationName, true);
      // A atualização assíncrona também é coalescida. Sem isto, várias
      // perguntas que chegassem durante a janela stale disparariam a mesma
      // atualização em paralelo.
      if (!omieInflightRequests.has(key)) {
        const refresh = loadOmieOperation().finally(() => omieInflightRequests.delete(key));
        omieInflightRequests.set(key, refresh);
        void refresh.catch(() => undefined);
      }
      return cached.data;
    }
    telemetry?.cacheMiss?.(operationName);
  }

  if (key && omieInflightRequests.has(key)) {
    telemetry?.coalesced?.(operationName);
    return omieInflightRequests.get(key);
  }

  async function loadOmieOperation() {
    if (policy) {
      const shared = await readSharedOperationCache(key);
      if (shared?.data && cacheEntryIsFresh(shared, policy)) {
        omieResponseCache.set(key, shared);
        telemetry?.cacheHit?.(operationName);
        return shared.data;
      }
    }
    const data = await retryRateLimitedOmieRequest(() => enqueueOmieRequest(empresa, async () => {
      const startedAt = Date.now();
      try {
        const response = await fetch(`${BASE_URL}${operation.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "omie-consulta/1.1.0" },
          body: JSON.stringify({ call: operation.call, app_key: appKey, app_secret: appSecret, param: [params] }),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store"
        });
        const responseText = await response.text();
        let responseData;
        try { responseData = JSON.parse(responseText); } catch { responseData = { raw: responseText }; }
        return { response, data: responseData };
      } finally {
        telemetry?.request?.(operationName, Date.now() - startedAt);
      }
    }), sleep, maxAttempts, { telemetry, operationName });
    if (policy) {
      const entry = { data, createdAt: Date.now() };
      omieResponseCache.set(key, entry);
      await storeSharedOperationCache(key, data, policy);
    }
    return data;
  }

  const promise = loadOmieOperation();
  if (!key) return promise;
  omieInflightRequests.set(key, promise);
  try { return await promise; } finally { omieInflightRequests.delete(key); }
}


function todayInFortaleza() {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.day}/${values.month}/${values.year}`;
}


function cleanTerm(term) {
  const cleaned = String(term || "").trim().replaceAll("%", "");
  if (cleaned.length < 2) throw new Error("Informe um termo de busca com pelo menos 2 caracteres.");
  return cleaned;
}


function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}


function isEmptyPageError(error) {
  return /n[aã]o existem registros para a p[aá]gina\s*\[?\d+\]?/i.test(
    error instanceof Error ? error.message : String(error || "")
  );
}


// Algumas APIs do Omie respondem com fault quando uma página posterior não tem
// registros. Isso é fim de paginação, não falha da consulta já processada.
function pageIsEmpty(error) {
  return isEmptyPageError(error);
}


function normalizedText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR");
}


function parseDate(value, fieldName) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || ""));
  if (!match) throw new Error(`${fieldName} deve estar no formato DD/MM/AAAA.`);
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    throw new Error(`${fieldName} não é uma data válida.`);
  }
  return date;
}


function formatDate(date) {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}


function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}


function daysBetween(earlier, later) {
  return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
}


function stockLocation(row) {
  return {
    codigo_local_estoque: row.codigo_local_estoque,
    fisico: number(row.fisico),
    reservado: number(row.reservado),
    disponivel: number(row.nSaldo)
  };
}


function rounded(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}


async function listAllMatchingProducts(term, callFn) {
  const products = [];
  let page = 1;
  let totalPages = 1;


  do {
    const response = await callFn("listar_produtos", {
      pagina: page,
      registros_por_pagina: 100,
      filtrar_apenas_descricao: `%${term}%`
    });
    products.push(...(response.produto_servico_cadastro || []));
    totalPages = Math.max(number(response.total_de_paginas), 1);
    page += 1;
  } while (page <= totalPages);


  return products;
}


async function listStockForProducts(productIds, date, callFn) {
  const rows = [];
  const chunkSize = 50;


  for (let offset = 0; offset < productIds.length; offset += chunkSize) {
    const productList = productIds
      .slice(offset, offset + chunkSize)
      .map((id) => ({ nCodProd: id }));
    let page = 1;
    let totalPages = 1;


    do {
      const response = await callFn("listar_posicao_estoque", {
        nPagina: page,
        nRegPorPagina: 100,
        dDataPosicao: date,
        cExibeTodos: "S",
        lista_local_estoque: "TODOS",
        lista_produtos: productList
      });
      rows.push(...(response.produtos || []));
      totalPages = Math.max(number(response.nTotPaginas), 1);
      page += 1;
    } while (page <= totalPages);
  }


  return rows;
}


export async function searchProductsWithStock(
  { termo, data, consolidar_locais = true },
  callFn = callOmie
) {
  const searchTerm = cleanTerm(termo);
  const positionDate = data || todayInFortaleza();
  const products = await listAllMatchingProducts(searchTerm, callFn);


  if (products.length === 0) {
    return {
      termo: searchTerm,
      data_posicao: positionDate,
      quantidade_produtos: 0,
      produtos: []
    };
  }


  const productIds = products.map((product) => product.codigo_produto);
  const stockRows = await listStockForProducts(productIds, positionDate, callFn);
  const stockByProduct = new Map();


  for (const row of stockRows) {
    const locations = stockByProduct.get(row.nCodProd) || [];
    locations.push(stockLocation(row));
    stockByProduct.set(row.nCodProd, locations);
  }


  const result = products.map((product) => {
    const locations = stockByProduct.get(product.codigo_produto) || [];
    const physical = locations.reduce((sum, location) => sum + location.fisico, 0);
    const reserved = locations.reduce((sum, location) => sum + location.reservado, 0);
    const available = locations.reduce((sum, location) => sum + location.disponivel, 0);


    return {
      id_produto: product.codigo_produto,
      codigo: product.codigo,
      descricao: product.descricao,
      unidade: product.unidade,
      preco: number(product.valor_unitario),
      status: product.inativo === "S" ? "Inativo" : "Ativo",
      estoque_fisico_total: physical,
      estoque_reservado_total: reserved,
      estoque_disponivel_total: available,
      ...(consolidar_locais ? {} : { estoque_por_local: locations })
    };
  });


  return {
    termo: searchTerm,
    data_posicao: positionDate,
    quantidade_produtos: result.length,
    locais_consolidados: consolidar_locais,
    produtos: result
  };
}


async function listProductMovements(productId, startDate, endDate, callFn) {
  const movements = [];
  let page = 1;
  let totalPages = 1;
  do {
    let response;
    try {
      response = await callFn("listar_movimentos_estoque", {
        nPagina: page,
        nRegPorPagina: 100,
        idProd: productId,
        dDtInicial: formatDate(startDate),
        dDtFinal: formatDate(endDate),
        lista_local_estoque: "TODOS"
      });
    } catch (error) {
      if (pageIsEmpty(error)) break;
      throw error;
    }
    movements.push(...(response.movProdutoListar || []));
    totalPages = Math.max(number(response.nTotPaginas), 1);
    page += 1;
  } while (page <= totalPages);
  return { movements, totalPages };
}


async function listAllPendingPurchaseStock(callFn) {
  const rows = [];
  let page = 1;
  let totalPages = 1;
  do {
    let response;
    try {
      response = await callFn("listar_saldo_pendente", {
        pagina: page,
        registros_por_pagina: 100,
        lista_local_estoque: "TODOS",
        tipo: "ENTRADA"
      });
    } catch (error) {
      if (pageIsEmpty(error)) break;
      throw error;
    }
    rows.push(...(response.saldo_pendente_lista || []));
    totalPages = Math.max(number(response.total_de_paginas), 1);
    page += 1;
  } while (page <= totalPages);
  return rows;
}


async function listAllStockLocations(callFn) {
  const locations = [];
  let page = 1;
  let totalPages = 1;
  do {
    const response = await callFn("listar_locais_estoque", { nPagina: page, nRegPorPagina: 100 });
    locations.push(...(response.locaisEncontrados || []));
    totalPages = Math.max(number(response.nTotPaginas), 1);
    page += 1;
  } while (page <= totalPages);
  return locations;
}


async function listAllProductSuppliers(callFn) {
  const suppliers = [];
  let page = 1;
  let totalPages = 1;
  do {
    const response = await callFn("listar_produtos_fornecedor", {
      pagina: page,
      registros_por_pagina: 10,
      apenas_importado_api: "N"
    });
    suppliers.push(...(response.cadastros || []));
    totalPages = Math.max(number(response.total_de_paginas), 1);
    page += 1;
  } while (page <= totalPages);
  return suppliers;
}


function salesMetrics(movements, referenceDate, days) {
  const startDate = addDays(referenceDate, -(days - 1));
  let gross = 0;
  let cancellations = 0;
  let returns = 0;
  for (const movement of movements) {
    let movementDate;
    try {
      movementDate = parseDate(movement.dtMov, "dtMov");
    } catch {
      continue;
    }
    if (movementDate < startDate || movementDate > referenceDate) continue;
    const operation = String(movement.operacao || "");
    const quantity = number(movement.qtde);
    if (["11", "12"].includes(operation) && quantity < 0 && movement.cancelamento !== "S") {
      gross += Math.abs(quantity);
    } else if (["11", "12"].includes(operation) && quantity > 0 && movement.cancelamento === "S") {
      cancellations += quantity;
    } else if (operation === "13" || movement.devolucao === "S") {
      returns += Math.abs(quantity);
    }
  }
  return {
    dias: days,
    venda_bruta: rounded(gross, 3),
    cancelamentos: rounded(cancellations, 3),
    devolucoes: rounded(returns, 3),
    venda_liquida: rounded(gross - cancellations - returns, 3)
  };
}


function dailySalesMetric(metrics) {
  return rounded(Math.max(metrics.venda_liquida, 0) / metrics.dias, 3);
}


function salesTrend(demand30, demand60, demand90) {
  // Faixa de 10% evita rotular oscilações normais de demanda como tendência.
  if (demand30 === 0 && demand60 === 0 && demand90 === 0) return "ESTAVEL";
  if (demand30 >= demand60 * 1.1 && demand60 >= demand90 * 1.1) return "ACELERANDO";
  if (demand30 <= demand60 * 0.9 && demand60 <= demand90 * 0.9) return "DESACELERANDO";
  return "ESTAVEL";
}


function weightedDailyDemand(demand30, demand60, demand90) {
  // A janela recente orienta a compra, sem descartar por completo o histórico.
  return rounded((demand30 * 0.5) + (demand60 * 0.3) + (demand90 * 0.2), 3);
}


function pendingTransitForProduct(rows, productId) {
  return rows
    .filter((row) => number(row.id_prod || row.nCodProd) === productId)
    .filter((row) => {
      const entryField = Object.hasOwn(row, "data_entrada")
        ? "data_entrada"
        : (Object.hasOwn(row, "dDataEntrada") ? "dDataEntrada" : null);
      // Sem o campo de entrada não há evidência suficiente para chamar de trânsito.
      return entryField !== null && row[entryField] == null;
    })
    .filter((row) => {
      const status = normalizedText(row.status || row.cStatus || row.situacao || "faturada");
      return !status || status.includes("fatur") || status.includes("transito");
    })
    .reduce((sum, row) => sum + number(row.qtde_entrada || row.quantidade || row.nQtde), 0);
}


function unitsPerBox(product, packingByCode) {
  const configured = number(packingByCode?.[product.codigo]);
  const registered = number(
    product.unidades_por_caixa || product.quantidade_por_caixa ||
    product.qtd_por_caixa || product.qtd_embalagem
  );
  return configured > 0 ? configured : (registered > 0 ? registered : null);
}


function latestMovement(movements, operations, direction) {
  return movements
    .filter((movement) => operations.includes(String(movement.operacao || "")))
    .filter((movement) => direction === "entrada" ? number(movement.qtde) > 0 : number(movement.qtde) < 0)
    .filter((movement) => movement.cancelamento !== "S")
    .toSorted((a, b) => {
      try { return parseDate(b.dtMov, "dtMov") - parseDate(a.dtMov, "dtMov"); } catch { return 0; }
    })[0] || null;
}


function replenishmentUrgency(projectedCoverage, leadTime, safetyDays, suggestedQuantity, demand) {
  if (demand <= 0) return "Sem giro no período";
  if (projectedCoverage <= leadTime) return "Crítica";
  if (projectedCoverage <= leadTime + safetyDays) return "Alta";
  if (suggestedQuantity > 0) return "Média";
  return "Baixa";
}

const SALES_AGGREGATION_TTL_MS = 15 * 60 * 1000;
const SALES_SHARED_CACHE_TTL_SECONDS = 15 * 60;

function emptySalesMetrics(days) {
  return { dias: days, venda_bruta: 0, cancelamentos: 0, devolucoes: 0, venda_liquida: 0 };
}

function serializeSalesAggregation(value) {
  return {
    ...value,
    byProduct: Object.fromEntries([...value.byProduct.entries()].map(([productId, metrics]) => [
      String(productId),
      Object.fromEntries(metrics.entries())
    ]))
  };
}

function hydrateSalesAggregation(value) {
  if (!value || typeof value !== "object" || !value.byProduct) return null;
  return {
    ...value,
    byProduct: new Map(Object.entries(value.byProduct).map(([productId, metrics]) => [
      number(productId),
      new Map(Object.entries(metrics || {}).map(([days, metric]) => [number(days), metric]))
    ]))
  };
}

async function readSharedSalesAggregation(key) {
  if (!process.env.VERCEL) return null;
  try {
    return hydrateSalesAggregation(await getCache({ namespace: "omie-sales" }).get(key));
  } catch {
    // O cache é uma otimização. A consulta continua funcional em ambiente local
    // ou se o serviço de cache estiver temporariamente indisponível.
    return null;
  }
}

async function storeSharedSalesAggregation(key, value) {
  if (!process.env.VERCEL) return;
  try {
    await getCache({ namespace: "omie-sales" }).set(key, serializeSalesAggregation(value), {
      ttl: SALES_SHARED_CACHE_TTL_SECONDS,
      tags: ["omie-sales", key],
      name: "omie-replenishment-sales"
    });
  } catch {
    // Sem impacto na resposta: o cache local ainda pode reaproveitar a leitura.
  }
}

async function invoicedSalesMetricsByProduct(referenceDate, historyDays, callFn, companyScope = "matriz") {
  // Uma única passagem pelos pedidos faturados substitui uma paginação de
  // movimentações para cada SKU. O cache é propositalmente curto: acelera
  // consultas repetidas sem transformar vendas recentes em dado defasado.
  const cache = salesAggregationCache;
  const key = `${companyScope}:${formatDate(referenceDate)}:${historyDays}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.createdAt < SALES_AGGREGATION_TTL_MS) {
    callFn.__omieTelemetry?.cacheHit?.("agregacao_vendas_90d");
    return cached.value;
  }

  const sharedCached = await readSharedSalesAggregation(key);
  if (sharedCached) {
    cache.set(key, { createdAt: Date.now(), value: sharedCached });
    callFn.__omieTelemetry?.cacheHit?.("agregacao_vendas_90d");
    return sharedCached;
  }
  callFn.__omieTelemetry?.cacheMiss?.("agregacao_vendas_90d");

  const historyStart = addDays(referenceDate, -(historyDays - 1));
  const windows = [30, 60, 90].filter((days) => days <= historyDays);
  const byProduct = new Map();
  let page = 1;
  let totalPages = 1;
  let totalOrders = 0;

  do {
    let response;
    try {
      response = await callFn("listar_pedidos_venda", {
        pagina: page,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        apenas_resumo: "N",
        data_faturamento_de: formatDate(historyStart),
        data_faturamento_ate: formatDate(referenceDate),
        status_pedido: "FATURADO"
      });
    } catch (error) {
      if (isEmptyPageError(error) || pageIsEmpty(error)) break;
      throw error;
    }

    const orders = response.pedido_venda_produto || [];
    for (const order of orders) {
      const billingText = order?.infoCadastro?.dFat;
      let billingDate;
      try { billingDate = parseDate(billingText, "data_faturamento"); } catch { continue; }
      if (billingDate < historyStart || billingDate > referenceDate) continue;

      for (const detail of order?.det || []) {
        const item = detail?.produto || {};
        const productId = number(item.codigo_produto);
        if (!productId || item.componente_kit === "S") continue;
        const metrics = byProduct.get(productId) || new Map();
        for (const days of windows) {
          if (billingDate < addDays(referenceDate, -(days - 1))) continue;
          const current = metrics.get(days) || emptySalesMetrics(days);
          current.venda_bruta = rounded(current.venda_bruta + Math.max(number(item.quantidade), 0), 3);
          current.venda_liquida = current.venda_bruta;
          metrics.set(days, current);
        }
        byProduct.set(productId, metrics);
      }
    }
    totalPages = Math.max(number(response.total_de_paginas), 1);
    totalOrders = Math.max(totalOrders, number(response.total_de_registros));
    page += 1;
  } while (page <= totalPages);

  const value = { byProduct, pages: totalPages, orders: totalOrders, cached_at: new Date().toISOString() };
  cache.set(key, { createdAt: Date.now(), value });
  await storeSharedSalesAggregation(key, value);
  return value;
}

// Somente para os testes automatizados: não exporta nem registra credenciais.
export function resetOmieRuntimeForTests() {
  omieResponseCache.clear();
  omieInflightRequests.clear();
  omieCompanyQueues.clear();
  omieCooldownUntil = 0;
  salesAggregationCache.clear();
}


export async function analyzeProductReplenishment(
  {
    termo,
    termos,
    data_referencia,
    dias_historico = 90,
    dias_cobertura_alvo = 30,
    dias_lead_time = 15,
    dias_seguranca = 7,
    limite_produtos = 50,
    unidades_por_caixa = {}
  },
  callFn = callOmie
) {
  const suppliedTerms = Array.isArray(termos) && termos.length > 0 ? termos : [termo];
  if (suppliedTerms.length === 0 || suppliedTerms.some((value) => !String(value || "").trim())) {
    throw new Error("Informe termo ou ao menos um item em termos para analisar a reposição.");
  }
  const searchTerms = suppliedTerms.map((value) => cleanTerm(value));
  const searchTerm = searchTerms.join(" | ");
  const referenceText = data_referencia || todayInFortaleza();
  const referenceDate = parseDate(referenceText, "data_referencia");
  const historyStart = addDays(referenceDate, -(dias_historico - 1));
  // Cada termo só resolve o cadastro uma vez; depois o conjunto completo é
  // processado localmente com uma única leitura de vendas faturadas.
  const matchingProducts = Array.from(new Map(
    (await Promise.all(searchTerms.map((term) => listAllMatchingProducts(term, callFn))))
      .flat()
      .filter((product) => product.inativo !== "S")
      .map((product) => [number(product.codigo_produto), product])
  ).values());
  const selectedProducts = matchingProducts.slice(0, limite_produtos);


  if (selectedProducts.length === 0) {
    return {
      termo: searchTerm,
      data_referencia: referenceText,
      produtos_encontrados: 0,
      produtos_analisados: 0,
      produtos: []
    };
  }


  const productIds = selectedProducts.map((product) => number(product.codigo_produto));
  const stockRows = await listStockForProducts(productIds, referenceText, callFn);
  // Os testes e integrações que injetam um cliente mantêm o percurso detalhado;
  // em produção, a agregação única evita repetir a mesma leitura para cada SKU.
  const useFastSalesAggregation = callFn === callOmie || callFn.__omieFastAggregation === true;
  const salesAggregation = useFastSalesAggregation
    ? await invoicedSalesMetricsByProduct(referenceDate, dias_historico, callFn, callFn.__omieEmpresa || "matriz")
    : null;
  const movementData = new Map();
  let movementPages = 0;
  if (!useFastSalesAggregation) {
    for (const productId of productIds) {
      const movementResult = await listProductMovements(productId, historyStart, referenceDate, callFn);
      movementData.set(productId, movementResult.movements);
      movementPages += movementResult.totalPages;
    }
  }
  const pendingRows = await listAllPendingPurchaseStock(callFn);
  const locations = await listAllStockLocations(callFn);


  const locationNames = new Map(locations.map((location) => [
    number(location.codigo_local_estoque),
    location.descricao || location.codigo || `Local ${location.codigo_local_estoque}`
  ]));
  const result = selectedProducts.map((product) => {
    const productId = number(product.codigo_produto);
    const productStock = stockRows.filter((row) => number(row.nCodProd) === productId);
    const movements = movementData.get(productId) || [];
    const productSales = salesAggregation?.byProduct.get(productId) || new Map();
    const metrics30 = useFastSalesAggregation
      ? (productSales.get(30) || emptySalesMetrics(30))
      : salesMetrics(movements, referenceDate, 30);
    const metrics60 = useFastSalesAggregation
      ? (productSales.get(60) || emptySalesMetrics(60))
      : salesMetrics(movements, referenceDate, 60);
    const metrics90 = useFastSalesAggregation
      ? (productSales.get(90) || emptySalesMetrics(90))
      : salesMetrics(movements, referenceDate, 90);
    const demand30 = dailySalesMetric(metrics30);
    const demand60 = dailySalesMetric(metrics60);
    const demand90 = dailySalesMetric(metrics90);
    const baseDailyDemand = weightedDailyDemand(demand30, demand60, demand90);
    const physical = productStock.reduce((sum, row) => sum + number(row.fisico), 0);
    const reserved = productStock.reduce((sum, row) => sum + number(row.reservado), 0);
    const available = productStock.reduce((sum, row) => sum + number(row.nSaldo), 0);
    const pendingSales = productStock.reduce((sum, row) => sum + number(row.nPendente), 0);
    const transit = pendingTransitForProduct(pendingRows, productId);
    // Estoque físico nunca incorpora trânsito. Reservas e vendas pendentes são
    // informados à parte e não reduzem a base física da decisão de compra.
    const projectedStock = physical + transit;
    const currentCoverage = baseDailyDemand > 0 ? physical / baseDailyDemand : null;
    const projectedCoverage = baseDailyDemand > 0 ? projectedStock / baseDailyDemand : null;
    const effectiveTargetDays = Math.max(dias_cobertura_alvo, dias_lead_time + dias_seguranca);
    const targetStock = baseDailyDemand * effectiveTargetDays;
    const suggestedQuantity = Math.max(Math.ceil(targetStock - physical - transit), 0);
    const unitsInBox = unitsPerBox(product, unidades_por_caixa);


    return {
      id_produto: productId,
      codigo: product.codigo,
      descricao: product.descricao,
      unidade: product.unidade,
      preco_venda_atual: number(product.valor_unitario),
      vendas: { ultimos_30_dias: metrics30, ultimos_60_dias: metrics60, ultimos_90_dias: metrics90 },
      demanda_diaria_base: rounded(baseDailyDemand, 3),
      medias_diarias: { ultimos_30_dias: demand30, ultimos_60_dias: demand60, ultimos_90_dias: demand90 },
      tendencia: salesTrend(demand30, demand60, demand90),
      criterio_demanda: "média ponderada: 50% últimos 30 dias, 30% últimos 60 dias e 20% últimos 90 dias",
      ultima_venda: useFastSalesAggregation ? null : latestMovement(movements, ["11", "12"], "saida")?.dtMov || null,
      estoque: {
        fisico: rounded(physical, 3),
        reservado: rounded(reserved, 3),
        disponivel: rounded(available, 3),
        venda_pendente: rounded(pendingSales, 3),
        faturada_em_transito: rounded(transit, 3),
        projetado: rounded(projectedStock, 3),
        por_local: productStock.map((row) => ({
          codigo_local_estoque: number(row.codigo_local_estoque),
          local: locationNames.get(number(row.codigo_local_estoque)) || `Local ${row.codigo_local_estoque}`,
          fisico: number(row.fisico),
          reservado: number(row.reservado),
          disponivel: number(row.nSaldo),
          venda_pendente: number(row.nPendente),
          estoque_minimo: number(row.estoque_minimo)
        }))
      },
      cobertura_dias_atual: currentCoverage === null ? null : rounded(currentCoverage, 1),
      cobertura_dias_projetada: projectedCoverage === null ? null : rounded(projectedCoverage, 1),
      cobertura_alvo_dias: effectiveTargetDays,
      quantidade_sugerida_compra: suggestedQuantity,
      unidades_por_caixa: unitsInBox,
      quantidade_sugerida_caixas: unitsInBox
        ? Math.ceil(suggestedQuantity / unitsInBox)
        : null,
      recomendacao_compra: suggestedQuantity > 0
        ? "COMPRAR"
        : "NAO_COMPRAR",
      aviso_embalagem: unitsInBox
        ? null
        : "Unidades por caixa não cadastradas; informe o mapa unidades_por_caixa por SKU para converter a sugestão.",
      urgencia_reposicao: replenishmentUrgency(
        projectedCoverage ?? Number.POSITIVE_INFINITY,
        dias_lead_time,
        dias_seguranca,
        suggestedQuantity,
        baseDailyDemand
      ),
      ultima_compra: useFastSalesAggregation ? null : (() => {
        const lastPurchase = latestMovement(movements, ["21", "22"], "entrada");
        return lastPurchase ? {
          fornecedor: lastPurchase.fornecedor || lastPurchase.nomeFornecedor || lastPurchase.cNomeForn || null,
          data: lastPurchase.dtMov,
          quantidade: number(lastPurchase.qtde),
          custo_unitario: number(lastPurchase.valor),
          documento: lastPurchase.numDoc || ""
        } : null;
      })(),
      fornecedores: [],
      ajustes_manuais_no_historico: useFastSalesAggregation
        ? { entrada: 0, saida: 0, alerta: "Não carregado no modo rápido; não interfere no giro faturado." }
        : (() => {
          const adjustments = movements.filter((movement) => String(movement.operacao) === "00");
          const adjustmentIn = adjustments.filter((movement) => number(movement.qtde) > 0)
            .reduce((sum, movement) => sum + number(movement.qtde), 0);
          const adjustmentOut = adjustments.filter((movement) => number(movement.qtde) < 0)
            .reduce((sum, movement) => sum + Math.abs(number(movement.qtde)), 0);
          return {
            entrada: rounded(adjustmentIn, 3),
            saida: rounded(adjustmentOut, 3),
            alerta: adjustmentIn > 0 || adjustmentOut > 0
              ? "Há ajustes manuais no período; valide divergências de estoque antes de fechar a compra."
              : null
          };
        })()
    };
  });


  return {
    termo: searchTerm,
    termos_consultados: searchTerms,
    fornecedor_ou_marca_consultado: searchTerm,
    data_referencia: referenceText,
    periodo_analisado_inicio: formatDate(historyStart),
    periodo_analisado_fim: referenceText,
    dias_historico,
    parametros_reposicao: { dias_cobertura_alvo, dias_lead_time, dias_seguranca },
    produtos_encontrados: matchingProducts.length,
    produtos_analisados: result.length,
    resultado_parcial: matchingProducts.length > selectedProducts.length,
    aviso_resultado_parcial: matchingProducts.length > selectedProducts.length
      ? `Foram encontrados ${matchingProducts.length} produtos ativos; refine o termo ou aumente limite_produtos para analisar todos.`
      : null,
    paginas_vendas_faturadas_processadas: salesAggregation?.pages || null,
    pedidos_faturados_processados: salesAggregation?.orders || null,
    paginas_movimentacao_processadas: movementPages || null,
    cache_vendas: useFastSalesAggregation
      ? "Agregação de vendas faturadas reaproveitada por até 15 minutos na mesma instância."
      : null,
    observacao_valores: "Vendas são agregadas diretamente dos itens de pedidos FATURADOS; custo, última compra e ajustes de estoque não são usados para calcular giro.",
    regra_transito: "Somente saldo de entrada faturado com data_entrada nula é FATURADA_EM_TRANSITO; ele compõe estoque projetado, nunca estoque físico.",
    produtos: result
  };
}


async function listAllProjects(callFn) {
  const projects = [];
  let page = 1;