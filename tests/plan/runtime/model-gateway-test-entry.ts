let totalRequests = 0;
const modelCounts = new Map<string, number>();

/** Deterministic, local-only OpenAI-compatible endpoint. It records model IDs and counts only. */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__runtime_ready") return Response.json({ ok: true });
    if (url.pathname === "/__test/metrics" && request.method === "GET") {
      return Response.json({ totalRequests, modelCounts: Object.fromEntries(modelCounts) });
    }
    if (!url.pathname.endsWith("/ai/v1/chat/completions") || request.method !== "POST") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.headers.get("authorization") !== "Bearer test-only-model-gateway-token") {
      return Response.json({ error: "test_gateway_auth_missing" }, { status: 401 });
    }
    const body = await request.json().catch(() => null) as { model?: unknown } | null;
    const model = typeof body?.model === "string" ? body.model.slice(0, 120) : "unknown";
    totalRequests++;
    modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    // Do not persist or echo the synthetic prompt. A small stable response exercises the actual
    // Reasoner parser and AgentDO completion path without contacting an external model provider.
    return Response.json({
      id: `local-test-${totalRequests}`,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ action: "answer", text: "Synthetic Project Assistant run completed through the local test model." }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 24, completion_tokens: 14, total_tokens: 38 },
    });
  },
};
