import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";
import { mintInternalToken } from "@naelao/http";

// A live-reported bug: after approving a gated action from chat, the agent's continuation only
// ever showed up on the next page reload, with no activity trail — handleResumeRun mints a fresh
// run id for its continuation pass, but nothing ever surfaced that id anywhere a client could poll
// for it. These pin the fix: the id is recorded on `suspended_runs` the moment it's minted (not
// only once the continuation finishes), a new NaelaoAgentDO route reads it back by approval_id,
// and the agents-worker's single-approval GET route folds it in when the approval has a
// `resume_do_id` — the router-level surface a chat client actually calls.

describe("NaelaoAgentDO — GET /script/resume-status", () => {
  it("reports null until a continuation has actually been minted", async () => {
    const ctx = { storage: { sql: createDOSqlStorage() } };
    const spaceDO = new NaelaoAgentDO(ctx as never, { PLATFORM_SECRET: "test" } as never);
    // Trigger ensureInit() (runs at the top of every fetch()) so the table/column exist.
    await spaceDO.fetch(new Request("http://agent-do/script/resume-status?approvalId=nope"));

    const res = await spaceDO.fetch(new Request("http://agent-do/script/resume-status?approvalId=nope"));
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string | null; resumed_run_id: string | null }>();
    expect(body).toEqual({ status: null, resumed_run_id: null });
  });

  it("reports the resumed run id once a suspended_runs row records one", async () => {
    const ctx = { storage: { sql: createDOSqlStorage() } };
    const spaceDO = new NaelaoAgentDO(ctx as never, { PLATFORM_SECRET: "test" } as never);
    await spaceDO.fetch(new Request("http://agent-do/script/resume-status?approvalId=nope")); // init tables

    ctx.storage.sql.exec(
      `INSERT INTO suspended_runs (approval_id, run_id, space_id, tenant_id, agent_id, session_id, goal, action_name, status, created_at, resumed_run_id)
       VALUES ('appr-1', 'run-1', 'space-1', 'tenant-1', 'naelao-agent', 'sess-1', 'do a thing', 'commerce.payout', 'resuming', '2026-01-01T00:00:00Z', 'run-2')`
    );

    const res = await spaceDO.fetch(new Request("http://agent-do/script/resume-status?approvalId=appr-1"));
    const body = await res.json<{ status: string | null; resumed_run_id: string | null }>();
    expect(body).toEqual({ status: "resuming", resumed_run_id: "run-2" });
  });
});

describe("GET /spaces/:spaceId/sessions/:sessionId/approvals/:approvalId — folds in resume status", () => {
  const SECRET = "test-platform-secret";
  const TENANT = "tenant-1";

  function makeEnv(over: Partial<AgentsEnv> = {}): AgentsEnv {
    return {
      PLATFORM_SECRET: SECRET,
      PLATFORM_DB: {
        prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-1", tenant_id: TENANT }) }) }),
      },
      ...over,
    } as unknown as AgentsEnv;
  }

  async function getApproval(env: AgentsEnv) {
    const token = await mintInternalToken(SECRET, TENANT);
    return app.fetch(
      new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/approvals/appr-1", {
        headers: { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token },
      }),
      env as never,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    );
  }

  it("passes the approval through unchanged when it never suspended a loop (no resume_do_id)", async () => {
    const env = makeEnv({
      HITL_APPROVAL_DO: {
        idFromName: () => ({}),
        get: () => ({ async fetch() { return Response.json({ id: "appr-1", status: "pending", resume_do_id: null }); } }),
      } as unknown as AgentsEnv["HITL_APPROVAL_DO"],
    });
    const res = await getApproval(env);
    expect(res.status).toBe(200);
    const body = await res.json<{ id: string; resumed_run_id?: unknown }>();
    expect(body.id).toBe("appr-1");
    expect(body.resumed_run_id).toBeUndefined();
  });

  it("merges resumed_run_id/resume_status from the resuming DO when resume_do_id is present", async () => {
    let calledResumeStatus = false;
    const env = makeEnv({
      HITL_APPROVAL_DO: {
        idFromName: () => ({}),
        get: () => ({ async fetch() { return Response.json({ id: "appr-1", status: "approved", resume_do_id: "do-xyz" }); } }),
      } as unknown as AgentsEnv["HITL_APPROVAL_DO"],
      NAELAO_AGENT_DO: {
        idFromString: (n: string) => ({ toString: () => n }),
        get: () => ({
          async fetch(input: Request | string) {
            const url = typeof input === "string" ? input : input.url;
            expect(url).toContain("/script/resume-status?approvalId=appr-1");
            calledResumeStatus = true;
            return Response.json({ status: "resumed", resumed_run_id: "run-continuation-1" });
          },
        }),
      } as unknown as AgentsEnv["NAELAO_AGENT_DO"],
    });
    const res = await getApproval(env);
    expect(res.status).toBe(200);
    const body = await res.json<{ resumed_run_id: string | null; resume_status: string | null }>();
    expect(calledResumeStatus).toBe(true);
    expect(body.resumed_run_id).toBe("run-continuation-1");
    expect(body.resume_status).toBe("resumed");
  });

  it("still returns the approval row even when the resuming DO can't be reached", async () => {
    const env = makeEnv({
      HITL_APPROVAL_DO: {
        idFromName: () => ({}),
        get: () => ({ async fetch() { return Response.json({ id: "appr-1", status: "approved", resume_do_id: "do-xyz" }); } }),
      } as unknown as AgentsEnv["HITL_APPROVAL_DO"],
      NAELAO_AGENT_DO: {
        idFromString: (n: string) => ({ toString: () => n }),
        get: () => ({ async fetch() { throw new Error("down"); } }),
      } as unknown as AgentsEnv["NAELAO_AGENT_DO"],
    });
    const res = await getApproval(env);
    expect(res.status).toBe(200);
    const body = await res.json<{ id: string }>();
    expect(body.id).toBe("appr-1");
  });
});
