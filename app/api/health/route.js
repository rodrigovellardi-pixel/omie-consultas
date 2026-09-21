export function GET() {
  return Response.json({
    status: "ok",
    version: "1.0.0",
    mode: "read_only",
    omie_companies: {
      matriz_configured: Boolean(
        (process.env.OMIE_MATRIZ_APP_KEY || process.env.OMIE_APP_KEY) &&
        (process.env.OMIE_MATRIZ_APP_SECRET || process.env.OMIE_APP_SECRET)
      ),
      filial_configured: Boolean(
        process.env.OMIE_FILIAL_APP_KEY && process.env.OMIE_FILIAL_APP_SECRET
      )
    },
    access_token_configured: Boolean(process.env.MCP_ACCESS_TOKEN),
    jarvis_alexa: {
      endpoint: "/api/alexa",
      configured: Boolean(process.env.ALEXA_SKILL_ID),
      signature_verification: true,
      pin_required: false,
      ai_model: process.env.JARVIS_AI_MODEL || "openai/gpt-5-mini"
    },
    optimized_tools: [
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
  });
}
