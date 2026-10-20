import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// §A1 Harness Excellence Phase HX2: the session token-budget guard's actual enforcement —
// exercised directly against NaelaoAgentDO's private checkSessionBudget (called from
// enforceRunGates before any payer-specific gate). SPACES_WORKER and HITL_APPROVAL_DO are
// in-memory test doubles that model just enough of the real routes' behavior (session-spend
// GET/POST, events/fire, HITL requests create/list) to drive every branch of the gate.

interface SpendState {
  credits_used: number;
  warned_80: boolean;
}

function makeSpacesWorkerStub(initialSpend: Record<string, SpendState> = {}) {
  const spend = new Map<string, SpendState>(Object.entries(initialSpend));
  const firedEvents: { type: string }[] = [];
  const stub = {
    async fetch(input: Request | string): Promise<Response> {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      const spendMatch = url.pathname.match(/\/session-spend\/([^/]+)$/);
      if (req.method === "GET" && spendMatch) {
        const s = spend.get(spendMatch[1]!) ?? { credits_used: 0, warned_80: false };
        return Response.json(s);
      }
      if (req.method === "POST" && spendMatch) {
        const body = await req.json<{ action: string; credits?: number }>();
        const s = spend.get(spendMatch[1]!) ?? { credits_used: 0, warned_80: false };
        if (body.action === "mark_warned") s.warned_80 = true;
        if (body.action === "continue") { s.credits_used = 0; s.warned_80 = false; }
        if (body.action === "increment") s.credits_used += body.credits ?? 0;
        spend.set(spendMatch[1]!, s);
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && url.pathname.endsWith("/events/fire")) {
        const body = await req.json<{ type: string }>();
        firedEvents.push({ type: body.type });
        return Response.json({ fired: true });
      }
      return Response.json({ error: "unhandled" }, { status: 404 });
    },
  };
  return { stub, spend, firedEvents };
}

interface ApprovalRow { id: string; tool_name: string; status: string; }

function makeHitlStub(initialApprovals: ApprovalRow[] = []) {
  const approvals: ApprovalRow[] = [...initialApprovals];
  let created = 0;
  const doStub = {
    async fetch(input: Request | string): Promise<Response> {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/requests") {
        return Response.json({ approvals });
      }
      if (req.method === "POST" && url.pathname === "/requests") {
        created++;
        const id = `approval-${created}`;
        approvals.push({ id, tool_name: "session_budget_continue", status: "pending" });
        return Response.json({ approval_id: id }, { status: 201 });
      }
      return Response.json({ error: "unhandled" }, { status: 404 });
    },
  };
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => doStub,
  };
  return { namespace, approvals, getCreatedCount: () => created };
}

function makeDO(env: Record<string, unknown>): NaelaoAgentDO {
  const ctx = { storage: { sql: createDOSqlStorage() }, waitUntil(promise: Promise<unknown>) { void promise.catch(() => undefined); } };
  return new NaelaoAgentDO(ctx as never, { PLATFORM_SECRET: "test", ...env } as never);
}

type CheckFn = (spaceId: string, tenantId: string, sessionId: string, agentId: string, runId: string, ceiling: number) => Promise<{ ok: true } | { ok: false; response: Response }>;

describe("NaelaoAgentDO.checkSessionBudget (session token-budget guard)", () => {
  it("allows the run through when well under the ceiling, no warning fired", async () => {
    const { stub, firedEvents } = makeSpacesWorkerStub({ "sess-1": { credits_used: 10, warned_80: false } });
    const { namespace } = makeHitlStub();
    const doInstance = makeDO({ SPACES_WORKER: stub, HITL_APPROVAL_DO: namespace }) as unknown as { checkSessionBudget: CheckFn };

    const result = await doInstance.checkSessionBudget("space-1", "tenant-1", "sess-1", "naelao-agent", "run-1", 100);
    expect(result.ok).toBe(true);
    expect(firedEvents.length).toBe(0);
  });

  it("fires agent.session_budget_warning exactly once when crossing 80%", async () => {
    const { stub, firedEvents } = makeSpacesWorkerStub({ "sess-1": { credits_used: 85, warned_80: false } });
    const { namespace } = makeHitlStub();
    const doInstance = makeDO({ SPACES_WORKER: stub, HITL_APPROVAL_DO: namespace }) as unknown as { checkSessionBudget: CheckFn };

    const result = await doInstance.checkSessionBudget("space-1", "tenant-1", "sess-1", "naelao-agent", "run-1", 100);
    expect(result.ok).toBe(true);
    expect(firedEvents).toEqual([{ type: "agent.session_budget_warning" }]);
  });

  it("does NOT re-fire the warning once already warned_80 for this cycle", async () => {
    const { stub, firedEvents } = makeSpacesWorkerStub({ "sess-1": { credits_used: 90, warned_80: true } });
    const { namespace } = makeHitlStub();
    const doInstance = makeDO({ SPACES_WORKER: stub, HITL_APPROVAL_DO: namespace }) as unknown as { checkSessionBudget: CheckFn };

    await doInstance.checkSessionBudget("space-1", "tenant-1", "sess-1", "naelao-agent", "run-1", 100);
    expect(firedEvents.length).toBe(0);
  });

  it("at the ceiling with no prior approval: opens a new HITL request and refuses the run (402)", async () => {
    const { stub } = makeSpacesWorkerStub({ "sess-1": { credits_used: 100, warned_80: true } });
    const { namespace, getCreatedCount } = makeHitlStub();
    const doInstance = makeDO({ SPACES_WORKER: stub, HITL_APPROVAL_DO: namespace }) as unknown as { checkSessionBudget: CheckFn };

    const result = await doInstance.checkSessionBudget("space-1", "tenant-1", "sess-1", "naelao-agent", "run-1", 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(402);
      const body = await result.response.json() as { error_code: string; approval_id: string };
      expect(body.error_code).toBe("session_budget_ceiling");
      expect(body.approval_id).toBeTruthy();
    }
    expect(getCreatedCount()).toBe(1);
  });

  it("a second concurrent call over the ceiling reuses the SAME pending approval, never opens a duplicate", async () => {
    const { stub } = makeSpacesWorkerStub({ "sess-1": { credits_used: 100, warned_80: true } });
    const { namespace, getCreatedCount } = makeHitlStub();
    const doInstance = makeDO({ SPACES_WORKER: stub, HITL_APPROVAL_DO: namespace }) as unknown as { checkSessionBudget: CheckFn };

    const first = await doInstance.checkSessionBudget("space-1", "tenant-1", "sess-1", "naelao-agent", "run-1", 100);
    const second = await doInstance.checkSessionBudget("space-1", "tenant-1", "sess-1", "naelao-agent", "run-2", 100);
    expect(getCreatedCount()).toBe(1);
    if (!first.ok && !second.ok) {
      const firstBody = await first.response.json() as { approval_id: string };
      const secondBody = await second.response.json() as { error_code: string; approval_id: string };
      expect(secondBody.error_code).toBe("session_budget_pending_approval");
      expect(secondBody.approval_id).toBe(firstBody.approval_id);
    } else {
      throw new Error("expected both calls to be refused");
    }
  });

  it("once a human approves, the run proceeds AND the tally resets for the next cycle", async () => {
    const { stub, spend } = makeSpacesWorkerStub({ "sess-1": { credits_used: 100, warned_80: true } });
    const { namespace } = makeHitlStub([{ id: "approval-1", tool_name: "session_budget_continue", status: "approved" }]);
    const doInstance = makeDO({ SPACES_WORKER: stub, HITL_APPROVAL_DO: namespace }) as unknown as { checkSessionBudget: CheckFn };

    const result = await doInstance.checkSessionBudget("space-1", "tenant-1", "sess-1", "naelao-agent", "run-1", 100);
    expect(result.ok).toBe(true);
    expect(spend.get("sess-1")).toEqual({ credits_used: 0, warned_80: false });
  });

  it("a rejected prior approval does not permanently block — a fresh request opens", async () => {
    const { stub } = makeSpacesWorkerStub({ "sess-1": { credits_used: 100, warned_80: true } });
    const { namespace, getCreatedCount } = makeHitlStub([{ id: "approval-old", tool_name: "session_budget_continue", status: "rejected" }]);
    const doInstance = makeDO({ SPACES_WORKER: stub, HITL_APPROVAL_DO: namespace }) as unknown as { checkSessionBudget: CheckFn };

    const result = await doInstance.checkSessionBudget("space-1", "tenant-1", "sess-1", "naelao-agent", "run-1", 100);
    expect(result.ok).toBe(false);
    expect(getCreatedCount()).toBe(1);
  });

  it("fails CLOSED (refuses) at the ceiling when HITL_APPROVAL_DO isn't configured", async () => {
    const { stub } = makeSpacesWorkerStub({ "sess-1": { credits_used: 100, warned_80: true } });
    const doInstance = makeDO({ SPACES_WORKER: stub }) as unknown as { checkSessionBudget: CheckFn };

    const result = await doInstance.checkSessionBudget("space-1", "tenant-1", "sess-1", "naelao-agent", "run-1", 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = await result.response.json() as { error_code: string };
      expect(body.error_code).toBe("session_budget_ceiling");
    }
  });
});
