import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProductReplenishment, resetOmieRuntimeForTests } from "../lib/omie.js";


test("reposição encerra página vazia, preserva físico separado do trânsito e arredonda caixas", async () => {
  const calls = [];
  const callFn = async (operation, params) => {
    calls.push({ operation, params });
    if (operation === "listar_produtos") {
      return {
        total_de_paginas: 1,
        produto_servico_cadastro: [
          { codigo_produto: 1, codigo: "DOR-A", descricao: "Produto Dori A", unidade: "UN", inativo: "N" },
          { codigo_produto: 2, codigo: "DOR-B", descricao: "Produto Dori B", unidade: "UN", inativo: "N" }
        ]
      };
    }
    if (operation === "listar_posicao_estoque") {
      return {
        nTotPaginas: 1,
        produtos: [
          { nCodProd: 1, codigo_local_estoque: 1, fisico: 30, reservado: 0, nSaldo: 30 },
          { nCodProd: 2, codigo_local_estoque: 1, fisico: 100, reservado: 0, nSaldo: 100 }
        ]
      };
    }
    if (operation === "listar_movimentos_estoque") {
      if (params.idProd === 2) throw new Error("Não existem registros para a página [1]!");
      return {
        nTotPaginas: 1,
        movProdutoListar: [{ dtMov: "15/09/2026", operacao: "11", qtde: -90, cancelamento: "N" }]
      };
    }
    if (operation === "listar_saldo_pendente") {
      return {
        total_de_paginas: 1,
        saldo_pendente_lista: [
          { id_prod: 1, qtde_entrada: 12, data_entrada: null, status: "Faturada" },
          { id_prod: 2, qtde_entrada: 99, data_entrada: "14/09/2026", status: "Faturada" }
        ]
      };
    }
    if (operation === "listar_locais_estoque") {
      return { nTotPaginas: 1, locaisEncontrados: [{ codigo_local_estoque: 1, descricao: "Matriz" }] };
    }
    throw new Error(`operação inesperada: ${operation}`);
  };

  const report = await analyzeProductReplenishment({
    termo: "Dori",
    data_referencia: "15/09/2026",
    unidades_por_caixa: { "DOR-A": 12, "DOR-B": 12 }
  }, callFn);

  assert.equal(report.produtos.length, 2);
  assert.equal(report.produtos[0].estoque.fisico, 30);
  assert.equal(report.produtos[0].estoque.faturada_em_transito, 12);
  assert.equal(report.produtos[0].estoque.projetado, 42);
  assert.equal(report.produtos[0].quantidade_sugerida_caixas, 2);
  assert.equal(report.produtos[1].estoque.faturada_em_transito, 0);
  assert.equal(report.produtos[1].recomendacao_compra, "NAO_COMPRAR");
  assert.equal(calls.some(({ operation }) => operation === "listar_produtos_fornecedor"), false);
});

test("modo rápido varre vendas uma vez para vários SKUs e reaproveita a agregação", async () => {
  resetOmieRuntimeForTests();
  const calls = [];
  const callFn = async (operation) => {
    calls.push(operation);
    if (operation === "listar_produtos") return {
      total_de_paginas: 1,
      produto_servico_cadastro: [
        { codigo_produto: 1, codigo: "OB", descricao: "Ouro Branco", unidade: "UN", inativo: "N" },
        { codigo_produto: 2, codigo: "SV", descricao: "Sonho de Valsa", unidade: "UN", inativo: "N" }
      ]
    };
    if (operation === "listar_posicao_estoque") return {
      nTotPaginas: 1,
      produtos: [
        { nCodProd: 1, codigo_local_estoque: 1, fisico: 10, reservado: 0, nSaldo: 10 },
        { nCodProd: 2, codigo_local_estoque: 1, fisico: 20, reservado: 0, nSaldo: 20 }
      ]
    };
    if (operation === "listar_pedidos_venda") return {
      total_de_paginas: 1,
      total_de_registros: 1,
      pedido_venda_produto: [{
        infoCadastro: { dFat: "15/09/2026" },
        det: [{ produto: { codigo_produto: 1, quantidade: 30 } }, { produto: { codigo_produto: 2, quantidade: 15 } }]
      }]
    };
    if (operation === "listar_saldo_pendente") return { total_de_paginas: 1, saldo_pendente_lista: [] };
    if (operation === "listar_locais_estoque") return { nTotPaginas: 1, locaisEncontrados: [] };
    throw new Error(`operação inesperada: ${operation}`);
  };
  callFn.__omieFastAggregation = true;
  callFn.__omieEmpresa = "matriz";

  const params = { termos: ["Ouro Branco", "Sonho de Valsa"], data_referencia: "15/09/2026" };
  const first = await analyzeProductReplenishment(params, callFn);
  const second = await analyzeProductReplenishment(params, callFn);

  assert.equal(first.produtos.length, 2);
  assert.equal(second.produtos.length, 2);
  assert.equal(calls.filter((operation) => operation === "listar_pedidos_venda").length, 1);
  assert.equal(calls.includes("listar_movimentos_estoque"), false);
});

test("busca multi-termo ignora termo sem cadastro sem invalidar produtos encontrados", async () => {
  resetOmieRuntimeForTests();
  const callFn = async (operation, params) => {
    if (operation === "listar_produtos") {
      if (params.filtrar_apenas_descricao.includes("INEXISTENTE")) {
        throw new Error("ERROR: Não existem registros para a página [1]!");
      }
      return {
        total_de_paginas: 1,
        produto_servico_cadastro: [
          { codigo_produto: 1, codigo: "OB", descricao: "Ouro Branco", unidade: "UN", inativo: "N" }
        ]
      };
    }
    if (operation === "listar_posicao_estoque") return {
      nTotPaginas: 1,
      produtos: [{ nCodProd: 1, codigo_local_estoque: 1, fisico: 10, reservado: 0, nSaldo: 10 }]
    };
    if (operation === "listar_pedidos_venda") return {
      total_de_paginas: 1,
      total_de_registros: 0,
      pedido_venda_produto: []
    };
    if (operation === "listar_saldo_pendente") return { total_de_paginas: 1, saldo_pendente_lista: [] };
    if (operation === "listar_locais_estoque") return { nTotPaginas: 1, locaisEncontrados: [] };
    throw new Error(`operação inesperada: ${operation}`);
  };
  callFn.__omieFastAggregation = true;
  callFn.__omieEmpresa = "matriz";

  const report = await analyzeProductReplenishment({
    termos: ["OURO BRANCO", "INEXISTENTE"],
    data_referencia: "15/09/2026"
  }, callFn);

  assert.equal(report.produtos.length, 1);
  assert.equal(report.produtos[0].descricao, "Ouro Branco");
});
