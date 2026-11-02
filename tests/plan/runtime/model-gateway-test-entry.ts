import { verifyInternalToken } from "@naelao/http";

let totalRequests = 0;
let leafWorkerMode = false;
let dependentTaskMode = false;
let spaceAssistantMode = false;
let leafWorkerRequests = 0;
let decisionCalls = 0;
let decisionOutcome: "passed" | "uncertain" = "passed";
let sharePeerTasks = false;
let decisionGeneration = 0;
const billingReservations = new Map<string, { tenantId: string; status: "reserved" | "settled" | "uncertain"; runId: string; maxCredits: number }>();
const billingEvents: Array<{ kind: "reserve" | "settle"; outcome?: string; credits?: number }> = [];
const llmTokenReservations = new Map<string, { tenantId: string; spaceId: string; runId: string; estimatedTokens: number; status: "held" | "settled" | "released" }>();
const llmTokenSettlements = new Map<string, { actualTokens: number; modelId?: string }>();
const decisionTimeline: Array<{ kind: "model" | "decision" | "billing_reserve" | "billing_settle"; ordinal?: number }> = [];
const modelCounts = new Map<string, number>();
const requestMetrics: Array<{ model: string; message_count: number; tool_names: string[]; content_chars: number }> = [];

/** Deterministic, local-only OpenAI-compatible endpoint. It records model IDs and counts only. */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__runtime_ready") return Response.json({ ok: true });
    if (url.pathname === "/__test/configure" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { leafWorkerMode?: unknown; dependentTaskMode?: unknown; spaceAssistantMode?: unknown; decisionOutcome?: unknown; sharePeerTasks?: unknown; resetDecisionTelemetry?: unknown } | null;
      leafWorkerMode = body?.leafWorkerMode === true;
      dependentTaskMode = leafWorkerMode && body?.dependentTaskMode === true;
      spaceAssistantMode = leafWorkerMode && body?.spaceAssistantMode === true;
      sharePeerTasks = leafWorkerMode && body?.sharePeerTasks === true;
      leafWorkerRequests = 0;
      if (body?.decisionOutcome === "passed" || body?.decisionOutcome === "uncertain") decisionOutcome = body.decisionOutcome;
      if (body?.resetDecisionTelemetry === true) {
        decisionCalls = 0;
        decisionGeneration = 0;
        billingReservations.clear();
        billingEvents.length = 0;
        decisionTimeline.length = 0;
        llmTokenReservations.clear();
        llmTokenSettlements.clear();
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/metrics" && request.method === "GET") {
      return Response.json({ totalRequests, modelCounts: Object.fromEntries(modelCounts), requests: requestMetrics.slice(-20), decisions: { calls: decisionCalls, billingEvents: billingEvents.slice(), timeline: decisionTimeline.slice() }, llmUsage: {
        reservations: [...llmTokenReservations.values()].map(({ tenantId: _tenantId, ...row }) => row),
        settlements: [...llmTokenSettlements.entries()].map(([runId, settlement]) => ({ runId, ...settlement })),
      } });
    }
    if (url.pathname.startsWith("/internal/usage/llm-tokens/")) {
      const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
      if (!tenantId || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, "blackboard-integration-test-secret")) return Response.json({ error_code: "forbidden" }, { status: 403 });
      if (url.pathname === "/internal/usage/llm-tokens/check" && request.method === "GET") {
        const used = [...llmTokenSettlements.entries()].filter(([runId]) => [...llmTokenReservations.values()].some(row => row.tenantId === tenantId && row.runId === runId))
          .reduce((total, [, row]) => total + row.actualTokens, 0);
        return Response.json({ allowed: used < 1_000_000, current: used, limit: 1_000_000, plan_tier: "growth" });
      }
      if (url.pathname === "/internal/usage/llm-tokens/reservations/reserve" && request.method === "POST") {
        const body = await request.json().catch(() => null) as { reservation_id?: unknown; run_id?: unknown; space_id?: unknown; estimated_tokens?: unknown } | null;
        if (typeof body?.reservation_id !== "string" || typeof body.run_id !== "string" || typeof body.space_id !== "string"
          || !Number.isSafeInteger(body.estimated_tokens) || (body.estimated_tokens as number) <= 0) return Response.json({ error_code: "bad_request" }, { status: 400 });
        const existing = llmTokenReservations.get(body.reservation_id);
        if (existing) return existing.tenantId === tenantId && existing.runId === body.run_id && existing.estimatedTokens === body.estimated_tokens
          ? Response.json({ reserved: true, deduplicated: true, reservation_id: body.reservation_id })
          : Response.json({ error_code: "reservation_id_conflict" }, { status: 409 });
        llmTokenReservations.set(body.reservation_id, { tenantId, spaceId: body.space_id, runId: body.run_id, estimatedTokens: body.estimated_tokens as number, status: "held" });
        return Response.json({ reserved: true, reservation_id: body.reservation_id }, { status: 201 });
      }
      if (url.pathname === "/internal/usage/llm-tokens/reservations/settle" && request.method === "POST") {
        const body = await request.json().catch(() => null) as { run_id?: unknown; actual_tokens?: unknown; model_id?: unknown } | null;
        if (typeof body?.run_id !== "string" || !Number.isSafeInteger(body.actual_tokens) || (body.actual_tokens as number) < 0) return Response.json({ error_code: "bad_request" }, { status: 400 });
        const held = [...llmTokenReservations.values()].some(row => row.tenantId === tenantId && row.runId === body.run_id && row.status === "held");
        const existing = llmTokenSettlements.get(body.run_id);
        if (existing) return Response.json({ settled: true, deduplicated: true, actual_tokens: existing.actualTokens });
        if (!held) return Response.json({ settled: false, error_code: "reservation_not_found" }, { status: 409 });
        for (const row of llmTokenReservations.values()) if (row.tenantId === tenantId && row.runId === body.run_id && row.status === "held") row.status = "settled";
        llmTokenSettlements.set(body.run_id, { actualTokens: body.actual_tokens as number, ...(typeof body.model_id === "string" ? { modelId: body.model_id } : {}) });
        return Response.json({ settled: true, actual_tokens: body.actual_tokens });
      }
      if (url.pathname === "/internal/usage/llm-tokens/reservations/release" && request.method === "POST") {
        const body = await request.json().catch(() => null) as { run_id?: unknown } | null;
        if (typeof body?.run_id !== "string") return Response.json({ error_code: "bad_request" }, { status: 400 });
        for (const row of llmTokenReservations.values()) if (row.tenantId === tenantId && row.runId === body.run_id && row.status === "held") row.status = "released";
        return Response.json({ released: true });
      }
      return Response.json({ error_code: "not_found" }, { status: 404 });
    }
    if (url.pathname === "/api/alpha/decisions" && request.method === "POST") {
      if (request.headers.get("authorization") !== "Bearer test-only-decisions-token") return Response.json({ error: "test_decision_auth_missing" }, { status: 401 });
      const body = await request.json().catch(() => null) as { model?: unknown; questions?: Record<string, { type?: unknown; criteria?: Record<string, unknown> }>; state?: unknown } | null;
      const model = typeof body?.model === "string" ? body.model : "";
      const questions = body?.questions;
      if (model !== "cloudflare/clef-flash" || !questions || typeof questions !== "object" || !Object.keys(questions).length) return Response.json({ error: "test_decision_request_invalid" }, { status: 400 });
      const isVerification = Object.keys(questions).length === 1 && Object.hasOwn(questions, "decision");
      if (isVerification) {
        const criterion = questions.decision;
        if (criterion?.type !== "choice" || !criterion.criteria || typeof criterion.criteria !== "object") return Response.json({ error: "test_decision_request_invalid" }, { status: 400 });
        const allowed = Object.keys(criterion.criteria);
        if (!allowed.includes("passed") || !allowed.includes("uncertain")) return Response.json({ error: "test_decision_criteria_invalid" }, { status: 400 });
      } else {
        if (!sharePeerTasks || Object.keys(questions).some(key => !/^pair_\d+$/.test(key) || questions[key]?.type !== "choice" || !questions[key]?.criteria || !Object.hasOwn(questions[key]!.criteria!, "share") || !Object.hasOwn(questions[key]!.criteria!, "none"))) return Response.json({ error: "test_task_communication_request_invalid" }, { status: 400 });
      }
      decisionCalls++;
      const generationId = `gen-runtime-${++decisionGeneration}`;
      decisionTimeline.push({ kind: "decision", ordinal: decisionCalls });
      const answers = isVerification
        ? { decision: { type: "choice", choice: decisionOutcome, probabilities: Object.fromEntries(Object.keys(questions.decision!.criteria!).map(key => [key, key === decisionOutcome ? 1 : 0])), confidence: 1 } }
        : Object.fromEntries(Object.entries(questions).map(([key, question]) => {
          const criteria = Object.keys(question.criteria!);
          const choice = sharePeerTasks ? "share" : "none";
          return [key, { type: "choice", choice, probabilities: Object.fromEntries(criteria.map(item => [item, item === choice ? 1 : 0])), confidence: 1 }];
        }));
      return Response.json({
        id: generationId,
        model,
        answers,
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
        const assistantLabel = spaceAssistantMode ? "Space Assistant" : "Project Bot";
        const artifactContent = spaceAssistantMode ? "space assistant leaf worker completed\n" : "project bot leaf worker completed\n";
        const tasks: Array<Record<string, unknown>> = [{
          id: "write-report",
          title: `Write the ${assistantLabel} smoke artifact`,
          subtask_spec: `Create reports/blackboard-worker-smoke.txt in the assigned assistant workspace with the exact content: ${artifactContent.trim()}. Do not use external services.`,
          assigned_role: "DEV_OPERATOR",
          acceptance_criteria: [`The ${assistantLabel} leaf worker artifact exists in its assigned workspace branch`],
          evidence_checks: [{ criterion: `The ${assistantLabel} leaf worker artifact exists in its assigned workspace branch`, operation: "workspace.exists:reports/blackboard-worker-smoke.txt" }],
          file_paths: ["reports/blackboard-worker-smoke.txt"],
          budget_tokens: 12_000,
        }];
        if (dependentTaskMode) tasks.push({
          id: "write-follow-up",
          title: "Write the dependent Project Bot follow-up",
          subtask_spec: "Create reports/blackboard-worker-followup.txt in the scoped project workspace. Do not use external services.",
          assigned_role: "DEV_OPERATOR",
          dependencies: ["write-report"],
          acceptance_criteria: ["The dependent Project Bot follow-up artifact exists in its assigned project workspace branch"],
          evidence_checks: [{ criterion: "The dependent Project Bot follow-up artifact exists in its assigned project workspace branch", operation: "workspace.exists:reports/blackboard-worker-followup.txt" }],
          file_paths: ["reports/blackboard-worker-followup.txt"],
          budget_tokens: 12_000,
        });
        if (sharePeerTasks) tasks.push({
          id: "write-follow-up",
          title: "Reuse the independent Project Bot report finding",
          subtask_spec: "Read the authorized task blackboard message from write-report, then create reports/blackboard-worker-followup.txt in the scoped project workspace. Do not use external services.",
          assigned_role: "DEV_OPERATOR",
          acceptance_criteria: ["The independent Project Bot follow-up artifact exists in its assigned project workspace branch"],
          evidence_checks: [{ criterion: "The independent Project Bot follow-up artifact exists in its assigned project workspace branch", operation: "workspace.exists:reports/blackboard-worker-followup.txt" }],
          file_paths: ["reports/blackboard-worker-followup.txt"],
          budget_tokens: 12_000,
        });
        const plan = {
          objective: "Create and verify the local Project Bot worker report",
          tasks,
        };
        return Response.json({
          id: `local-test-${totalRequests}`, model,
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ action: "run", name: "Bash", params: { command: `naelao goal plan --json '${JSON.stringify(plan)}'`, doing: "Plan the scoped Project Bot worker task" } }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 80, completion_tokens: 60, total_tokens: 140 },
        });
      }
      if (ordinal === 2) {
        const content = spaceAssistantMode ? "space assistant leaf worker completed\n" : "project bot leaf worker completed\n";
        return Response.json({
          id: `local-test-${totalRequests}`, model,
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ action: "run", name: "Write", params: { path: "reports/blackboard-worker-smoke.txt", content, expectedHash: null }, doing: "Write the smoke report in the assigned assistant workspace" }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
        });
      }
      if ((dependentTaskMode || sharePeerTasks) && ordinal === 4) {
        return Response.json({
          id: `local-test-${totalRequests}`, model,
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ action: "run", name: "Write", params: { path: "reports/blackboard-worker-followup.txt", content: sharePeerTasks ? "follow-up reused the host-authorized report completion\n" : "dependent worker dispatched after verified prerequisite\n", expectedHash: null }, doing: "Write the follow-up after the report task completed" }) }, finish_reason: "stop" }],
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
