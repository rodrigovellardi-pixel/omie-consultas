import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProductReplenishment } from "../lib/omie.js";


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
