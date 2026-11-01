import { verifyInternalToken } from "@naelao/http";

let totalRequests = 0;
let leafWorkerMode = false;
let leafWorkerRequests = 0;
let decisionCalls = 0;
let decisionOutcome: "passed" | "uncertain" = "passed";
let decisionGeneration = 0;
const billingReservations = new Map<string, { tenantId: string; status: "reserved" | "settled" | "uncertain"; runId: string; maxCredits: number }>();
const billingEvents: Array<{ kind: "reserve" | "settle"; outcome?: string; credits?: number }> = [];
const decisionTimeline: Array<{ kind: "model" | "decision" | "billing_reserve" | "billing_settle"; ordinal?: number }> = [];
const modelCounts = new Map<string, number>();
const requestMetrics: Array<{ model: string; message_count: number; tool_names: string[]; content_chars: number }> = [];

/** Deterministic, local-only OpenAI-compatible endpoint. It records model IDs and counts only. */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__runtime_ready") return Response.json({ ok: true });
    if (url.pathname === "/__test/configure" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { leafWorkerMode?: unknown; decisionOutcome?: unknown; resetDecisionTelemetry?: unknown } | null;
      leafWorkerMode = body?.leafWorkerMode === true;
      leafWorkerRequests = 0;
      if (body?.decisionOutcome === "passed" || body?.decisionOutcome === "uncertain") decisionOutcome = body.decisionOutcome;
      if (body?.resetDecisionTelemetry === true) {
        decisionCalls = 0;
        decisionGeneration = 0;
        billingReservations.clear();
        billingEvents.length = 0;
        decisionTimeline.length = 0;
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/metrics" && request.method === "GET") {
      return Response.json({ totalRequests, modelCounts: Object.fromEntries(modelCounts), requests: requestMetrics.slice(-20), decisions: { calls: decisionCalls, billingEvents: billingEvents.slice(), timeline: decisionTimeline.slice() } });
    }
    if (url.pathname === "/api/alpha/decisions" && request.method === "POST") {
      if (request.headers.get("authorization") !== "Bearer test-only-decisions-token") return Response.json({ error: "test_decision_auth_missing" }, { status: 401 });
      const body = await request.json().catch(() => null) as { model?: unknown; questions?: Record<string, { type?: unknown; criteria?: Record<string, unknown> }> } | null;
      const model = typeof body?.model === "string" ? body.model : "";
      const criterion = body?.questions?.decision;
      if (model !== "cloudflare/clef-flash" || criterion?.type !== "choice" || !criterion.criteria || typeof criterion.criteria !== "object") return Response.json({ error: "test_decision_request_invalid" }, { status: 400 });
      const allowed = Object.keys(criterion.criteria);
      if (!allowed.includes("passed") || !allowed.includes("uncertain")) return Response.json({ error: "test_decision_criteria_invalid" }, { status: 400 });
      decisionCalls++;
      const generationId = `gen-runtime-${++decisionGeneration}`;
      decisionTimeline.push({ kind: "decision", ordinal: decisionCalls });
      return Response.json({
        id: generationId,
        model,
        answers: { decision: { type: "choice", choice: decisionOutcome, probabilities: Object.fromEntries(allowed.map(key => [key, key === decisionOutcome ? 1 : 0])), confidence: 1 } },
        usage: { input_tokens: 48, output_tokens: 4, cost: 0.000000052 },
      });
    }
    if (url.pathname === "/internal/decisions/reservations/reserve" && request.method === "POST") {
      const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
      if (!tenantId || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, "blackboard-integration-test-secret")) return Response.json({ error_code: "forbidden" }, { status: 403 });
      const body = await request.json().catch(() => null) as { reservation_id?: unknown; run_id?: unknown; max_credits?: unknown; model_id?: unknown } | null;
      if (typeof body?.reservation_id !== "string" || typeof body.run_id !== "string" || !Number.isSafeInteger(body.max_credits) || (body.max_credits as number) < 1 || body.model_id !== "cloudflare/clef-flash") return Response.json({ error_code: "invalid_test_reservation" }, { status: 400 });
      const existing = billingReservations.get(body.reservation_id);
      if (existing) return existing.tenantId === tenantId && existing.runId === body.run_id ? Response.json({ reservation_id: body.reservation_id, status: existing.status }) : Response.json({ error_code: "reservation_conflict" }, { status: 409 });
      billingReservations.set(body.reservation_id, { tenantId, status: "reserved", runId: body.run_id, maxCredits: body.max_credits as number });
      billingEvents.push({ kind: "reserve" });
      decisionTimeline.push({ kind: "billing_reserve", ordinal: billingEvents.length });
      return Response.json({ reservation_id: body.reservation_id, status: "reserved" });
    }
    if (url.pathname === "/internal/decisions/reservations/settle" && request.method === "POST") {
      const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
      if (!tenantId || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, "blackboard-integration-test-secret")) return Response.json({ error_code: "forbidden" }, { status: 403 });
      const body = await request.json().catch(() => null) as { reservation_id?: unknown; outcome?: unknown; generation_id?: unknown; cost_usd?: unknown } | null;
      const reservation = typeof body?.reservation_id === "string" ? billingReservations.get(body.reservation_id) : undefined;
      if (!reservation || reservation.tenantId !== tenantId) return Response.json({ error_code: "reservation_missing" }, { status: 404 });
      if (body?.outcome === "confirmed") {
        if (typeof body.generation_id !== "string" || !/^gen-[A-Za-z0-9-]{1,124}$/.test(body.generation_id) || typeof body.cost_usd !== "number" || body.cost_usd < 0) return Response.json({ error_code: "settlement_receipt_invalid" }, { status: 400 });
        reservation.status = "settled";
        billingEvents.push({ kind: "settle", outcome: "confirmed", credits: 1 });
        decisionTimeline.push({ kind: "billing_settle", ordinal: billingEvents.length });
        return Response.json({ reservation_id: body.reservation_id, status: "settled", cost_credits: 1 });
      }
      if (body?.outcome === "uncertain") {
        reservation.status = "uncertain";
        billingEvents.push({ kind: "settle", outcome: "uncertain" });
        decisionTimeline.push({ kind: "billing_settle", ordinal: billingEvents.length });
        return Response.json({ reservation_id: body.reservation_id, status: "uncertain" });
      }
      return Response.json({ error_code: "settlement_outcome_invalid" }, { status: 400 });
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
    decisionTimeline.push({ kind: "model", ordinal: totalRequests });
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
