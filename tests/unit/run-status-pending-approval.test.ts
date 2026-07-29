import { describe, it, expect } from "vitest";
import { fetchRunOrTaskStatus } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";

// Chat UI parity: a durably-dispatched (async, the DEFAULT) run that stops at a HITL gate used to
// report status:"awaiting_approval" through polling with NO detail about which approval, its
// action, or its parameters — the client had nothing to render an inline approval card from. This
// proves the fix end to end through the real fetchRunOrTaskStatus function (the SAME one both the
// plain GET /runs/:runId route and the SSE /stream endpoint's poll loop call).

// TaskDO's own GET /tasks/:id handler JSON.parses the stored `result` column before responding
// (`result: task.result ? JSON.parse(task.result) : null` — TaskDO.ts) — so the real wire
// contract this function reads is an ALREADY-PARSED object, never the raw stored string.
function makeEnv(taskResult: { status: string; result: Record<string, unknown> | null; error: string | null }): AgentsEnv {
  const agentDoStub = {
    // The DO's own /runs/:runId always 404s for a script-native (async-dispatched) run — no
    // agent_runs row exists for it — forcing the fallthrough to TaskDO this test is about.
    async fetch() {
      return new Response(JSON.stringify({ error_code: "not_found" }), { status: 404 });
    },
  };
  const taskDoStub = {
    async fetch() {
      return new Response(JSON.stringify({ task_id: "task-1", ...taskResult }), { status: 200 });
    },
  };
  return {
    PLATFORM_SECRET: "test-platform-secret",
    NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    TASK_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => taskDoStub },
  } as unknown as AgentsEnv;
}

describe("fetchRunOrTaskStatus — pending_approval surfaces through TaskDO polling", () => {
  it("includes approval_id/action_name/params when the task's stored result carries one", async () => {
    const env = makeEnv({
      status: "awaiting_approval",
      result: {
        final_answer: "Waiting for your approval to run 'commerce.payout'.",
        pending_approval: { approval_id: "appr-1", action_name: "commerce.payout", params: { amount_cents: 5000 }, expires_at: 1234567890 },
      },
      error: null,
    });
    const { status, body } = await fetchRunOrTaskStatus(env, "tenant-1", "session-1", "space-1", "task-1");
    expect(status).toBe(200);
    expect(body.status).toBe("awaiting_approval");
    expect(body.pending_approval).toEqual({
      approval_id: "appr-1", action_name: "commerce.payout", params: { amount_cents: 5000 }, expires_at: 1234567890,
    });
  });

  it("is absent for a completed task — never fabricated", async () => {
    const env = makeEnv({ status: "complete", result: { final_answer: "done" }, error: null });
    const { body } = await fetchRunOrTaskStatus(env, "tenant-1", "session-1", "space-1", "task-1");
    expect(body.status).toBe("completed");
    expect(body.pending_approval).toBeUndefined();
  });

  it("is absent for a failed task", async () => {
    const env = makeEnv({ status: "failed", result: null, error: "boom" });
    const { body } = await fetchRunOrTaskStatus(env, "tenant-1", "session-1", "space-1", "task-1");
    expect(body.status).toBe("failed");
    expect(body.pending_approval).toBeUndefined();
    expect(body.error).toBe("boom");
  });
});

// Live-reported bug (2026-07-29): a run that PARKED a real, still-open approval and continued
// (rather than fully suspending — see loop.ts's `deferred_approvals`) had that approval silently
// dropped by this exact function's TaskDO branch, which only ever read `pending_approval`. The
// approval genuinely existed (visible via the separate /approvals inbox, backed by
// HITLApprovalDO directly) but the chat itself showed nothing about it whatsoever.
describe("fetchRunOrTaskStatus — deferred_approvals surfaces through TaskDO polling", () => {
  it("includes deferred_approvals on an otherwise-completed run", async () => {
    const env = makeEnv({
      status: "complete",
      result: {
        final_answer: "I looked into it and also started a search that needs your OK.",
        deferred_approvals: [{ approval_id: "appr-2", action_name: "web-search.search", params: { query: "polsia ai" } }],
      },
      error: null,
    });
    const { body } = await fetchRunOrTaskStatus(env, "tenant-1", "session-1", "space-1", "task-1");
    expect(body.status).toBe("completed");
    expect(body.deferred_approvals).toEqual([
      { approval_id: "appr-2", action_name: "web-search.search", params: { query: "polsia ai" } },
    ]);
  });

  // The exact reproduction: the run parked a real approval, then a LATER, unrelated reasoning
  // step failed — the task is recorded as failed, but the approval it already opened is still
  // real and still open, and must not vanish along with the error.
  it("survives even when the task itself is recorded as failed", async () => {
    const env = makeEnv({
      status: "failed",
      result: { deferred_approvals: [{ approval_id: "appr-3", action_name: "web-search.search" }] },
      error: "unparseable reasoner output: no JSON object in reasoner output",
    });
    const { body } = await fetchRunOrTaskStatus(env, "tenant-1", "session-1", "space-1", "task-1");
    expect(body.status).toBe("failed");
    expect(body.error).toContain("unparseable reasoner output");
    expect(body.deferred_approvals).toEqual([{ approval_id: "appr-3", action_name: "web-search.search" }]);
  });

  it("is absent (not an empty array) when there are none", async () => {
    const env = makeEnv({ status: "complete", result: { final_answer: "done" }, error: null });
    const { body } = await fetchRunOrTaskStatus(env, "tenant-1", "session-1", "space-1", "task-1");
    expect(body.deferred_approvals).toBeUndefined();
  });
});
