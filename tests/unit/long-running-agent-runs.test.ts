// Long-running background runs, and what a run that is waiting on a person reports.
//
// Three separate things are pinned here, all of which were wrong in ways that only showed up on a
// real task rather than in a test:
//
//  1. The approvals routes had NO auth whatsoever. This worker keeps a public workers.dev URL
//     (its channel gateway needs one), so anyone could read what any space's agent was about to
//     do — with its parameters — and approve it. Tolerable-ish when an unanswered approval
//     auto-rejected in 30 seconds; not once approvals stay open for a day.
//  2. A run suspended at a gate has no `result` and no `error`, which the response normalizer read
//     as ok-with-empty-output: it reported `completed` and a blank answer. That tells someone
//     their work finished when it is in fact sitting waiting for them.
//  3. `awaiting_approval` had to survive the whole way out to a polling client, because a status
//     the client doesn't recognise matches no branch and the reply silently vanishes.

import { describe, it, expect } from "vitest";
import { app, normalizeScriptRunResult } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

const SECRET = "test-platform-secret";
const TENANT = "victim-tenant";

function makeEnv(): AgentsEnv {
  // Everything downstream succeeds, so a 401 can only have come from the auth gate itself and
  // never from a downstream failure dressed up as a rejection.
  const okStmt = {
    bind() { return okStmt; },
    async first() { return { id: "space-1", tenant_id: TENANT, config_json: "{}", role: "owner" }; },
    async all() { return { results: [] }; },
    async run() { return { meta: { changes: 1 } }; },
  };
  return {
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: { prepare: () => okStmt } as unknown as D1Database,
    HITL_APPROVAL_DO: {
      idFromName: (n: string) => ({ toString: () => n }),
      get: () => ({ async fetch() { return Response.json({ status: "approved", resume_do_id: null }); } }),
    },
    NAELAO_AGENT_DO: {
      idFromName: (n: string) => ({ toString: () => n }),
      idFromString: (n: string) => ({ toString: () => n }),
      get: () => ({ async fetch() { return Response.json({ ok: true }); } }),
    },
    ANALYTICS: { writeDataPoint() {} },
  } as unknown as AgentsEnv;
}

const APPROVAL_ROUTES: Array<{ method: string; path: string }> = [
  { method: "GET", path: "/spaces/space-1/sessions/sess-1/approvals" },
  { method: "GET", path: "/spaces/space-1/sessions/sess-1/approvals/appr-1" },
  { method: "PUT", path: "/spaces/space-1/sessions/sess-1/approvals/appr-1/approve" },
  { method: "PUT", path: "/spaces/space-1/sessions/sess-1/approvals/appr-1/reject" },
];

describe("approvals routes are not reachable by anyone who can guess a space id", () => {
  for (const { method, path } of APPROVAL_ROUTES) {
    it(`${method} ${path} → 401 with a spoofed tenant header and no signed token`, async () => {
      const res = await app.fetch(
        new Request(`https://agents.naelao.com${path}`, {
          method,
          headers: { "x-naelao-tenant-id": TENANT, "content-type": "application/json" },
          ...(method === "PUT" ? { body: "{}" } : {}),
        }),
        makeEnv() as never
      );
      expect(res.status).toBe(401);
    });

    it(`${method} ${path} → passes with a real internal token`, async () => {
      // The other half of the assertion: the gate must not have simply broken the route.
      const env = makeEnv();
      const res = await app.fetch(
        new Request(`https://agents.naelao.com${path}`, {
          method,
          headers: {
            "x-naelao-tenant-id": TENANT,
            "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT),
            "content-type": "application/json",
            ...(method === "PUT" ? { "x-naelao-user-id": "owner-1", "x-naelao-role": "owner" } : {}),
          },
          ...(method === "PUT" ? { body: "{}" } : {}),
        }),
        env as never,
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
      );
      expect(res.status).toBe(200);
    });
  }

  it("a verified tenant cannot approve inside a space it does not own", async () => {
    // requireVerifiedTenant alone only proves the caller is SOME verified tenant. Without the
    // ownership check, tenant A could approve a money-moving action in tenant B's business by
    // naming B's space id.
    const env = makeEnv();
    (env as unknown as { PLATFORM_DB: D1Database }).PLATFORM_DB = {
      prepare: () => ({
        bind() { return this; },
        async first() { return null; }, // the space is not this tenant's
      }),
    } as unknown as D1Database;

    const res = await app.fetch(
      new Request("https://agents.naelao.com/spaces/someone-elses-space/sessions/s/approvals/appr-1/approve", {
        method: "PUT",
        headers: {
          "x-naelao-tenant-id": TENANT,
          "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT),
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env as never,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    );
    expect(res.status).toBe(401);
  });
});

describe("a run waiting on a person does not report as finished", () => {
  it("maps pending_approval to awaiting_approval, not completed-and-blank", () => {
    const out = normalizeScriptRunResult(
      { pending_approval: { approval_id: "appr-9", action_name: "commerce.payout" }, notes: [], trace: [] },
      "run-1"
    );
    expect(out.status).toBe("awaiting_approval");
    expect(out.pending_approval?.approval_id).toBe("appr-9");
    // The answer has to actually say something — a blank one is what the old behaviour produced.
    expect(out.final_answer).toContain("commerce.payout");
    expect(out.final_answer).toContain("approval");
    expect(out.error).toBeUndefined();
  });

  it("still reports a genuine success as completed", () => {
    const out = normalizeScriptRunResult({ result: { ok: true, output: "Done." } }, "run-2");
    expect(out.status).toBe("completed");
    expect(out.final_answer).toBe("Done.");
  });

  it("still reports a genuine failure as failed", () => {
    const out = normalizeScriptRunResult({ result: { ok: false, error: "tool blew up" } }, "run-3");
    expect(out.status).toBe("failed");
    expect(out.error).toBe("tool blew up");
    expect(out.final_answer).toBeNull();
  });
});
