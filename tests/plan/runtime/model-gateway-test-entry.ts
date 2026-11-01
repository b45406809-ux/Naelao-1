let totalRequests = 0;
let leafWorkerMode = false;
let leafWorkerRequests = 0;
const modelCounts = new Map<string, number>();
const requestMetrics: Array<{ model: string; message_count: number; tool_names: string[]; content_chars: number }> = [];

/** Deterministic, local-only OpenAI-compatible endpoint. It records model IDs and counts only. */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__runtime_ready") return Response.json({ ok: true });
    if (url.pathname === "/__test/configure" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { leafWorkerMode?: unknown } | null;
      leafWorkerMode = body?.leafWorkerMode === true;
      leafWorkerRequests = 0;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/metrics" && request.method === "GET") {
      return Response.json({ totalRequests, modelCounts: Object.fromEntries(modelCounts), requests: requestMetrics.slice(-20) });
    }
    if (!url.pathname.endsWith("/ai/v1/chat/completions") || request.method !== "POST") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.headers.get("authorization") !== "Bearer test-only-model-gateway-token") {
      return Response.json({ error: "test_gateway_auth_missing" }, { status: 401 });
    }
    const body = await request.json().catch(() => null) as { model?: unknown; messages?: unknown; tools?: unknown } | null;
    const model = typeof body?.model === "string" ? body.model.slice(0, 120) : "unknown";
    totalRequests++;
    modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    requestMetrics.push({
      model,
      message_count: messages.length,
      tool_names: tools.flatMap((tool) => tool && typeof tool === "object" && typeof (tool as Record<string, unknown>).name === "string" ? [(tool as Record<string, unknown>).name as string] : []),
      content_chars: messages.reduce((total, message) => total + (message && typeof message === "object" && typeof (message as Record<string, unknown>).content === "string" ? ((message as Record<string, unknown>).content as string).length : 0), 0),
    });
    if (leafWorkerMode) {
      const ordinal = ++leafWorkerRequests;
      if (ordinal === 1) {
        const plan = {
          objective: "Create and verify the local Project Bot worker report",
          tasks: [{
            id: "write-report",
            title: "Write the Project Bot smoke artifact",
            subtask_spec: "Create reports/blackboard-worker-smoke.txt in the scoped project workspace with the exact content: project bot leaf worker completed. Do not use external services.",
            assigned_role: "DEV_OPERATOR",
            acceptance_criteria: ["The Project Bot leaf worker artifact exists in its assigned project workspace branch"],
            evidence_checks: [{ criterion: "The Project Bot leaf worker artifact exists in its assigned project workspace branch", operation: "workspace.exists:reports/blackboard-worker-smoke.txt" }],
            file_paths: ["reports/blackboard-worker-smoke.txt"],
            // The leaf needs an action turn plus a separate terminal summary turn.
            budget_tokens: 12_000,
          }],
        };
        return Response.json({
          id: `local-test-${totalRequests}`, model,
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ action: "run", name: "Bash", params: { command: `naelao goal plan --json '${JSON.stringify(plan)}'`, doing: "Plan the scoped Project Bot worker task" } }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 80, completion_tokens: 60, total_tokens: 140 },
        });
      }
      if (ordinal === 2) {
        return Response.json({
          id: `local-test-${totalRequests}`, model,
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ action: "run", name: "Write", params: { path: "reports/blackboard-worker-smoke.txt", content: "project bot leaf worker completed\n", expectedHash: null }, doing: "Write the smoke report in the assigned project workspace" }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
        });
      }
    }
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
