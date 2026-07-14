import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// §A1 Phase HX1: GET .../sessions/:sessionId/agent/runs/:runId/trace — the builder-facing HTTP
// side of the structured trace. Builder-only (same rationale as agent-activity's own gate): a
// product end user must never see script names/params/token spend from a trace.

const SECRET = "test-platform-secret";
const execCtx = { waitUntil: (p: Promise<unknown>) => { void p; }, passThroughOnException() {} } as unknown as ExecutionContext;

function makeDb() {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) { return this; },
        async first() {
          if (sql.includes("FROM spaces")) return { id: "space-1" };
          return null;
        },
      };
    },
  };
}

function makeEnv(agentDoStub: { fetch: () => Promise<Response> }) {
  return {
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: makeDb(),
    NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
  } as unknown as AgentsEnv;
}

async function getTrace(env: AgentsEnv, role?: string) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  const headers: Record<string, string> = { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token };
  if (role) headers["x-naelao-role"] = role;
  return app.fetch(
    new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/agent/runs/run-1/trace", { headers }),
    env,
    execCtx
  );
}

describe("GET .../sessions/:sessionId/agent/runs/:runId/trace", () => {
  it("forwards to the DO's /runs/:runId/trace route and returns its body", async () => {
    const traceBody = { run_id: "run-1", trace: [{ seq: 0, phase: "observe", ts: 1000 }] };
    const agentDoStub = { async fetch() { return Response.json(traceBody); } };
    const res = await getTrace(makeEnv(agentDoStub));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(traceBody);
  });

  it("rejects a product_end_user caller with 403 before ever reaching the DO", async () => {
    let called = false;
    const agentDoStub = { async fetch() { called = true; return Response.json({ run_id: "run-1", trace: [] }); } };
    const res = await getTrace(makeEnv(agentDoStub), "product_end_user");
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });

  it("propagates a 404 from the DO unchanged", async () => {
    const agentDoStub = { async fetch() { return Response.json({ error: "not found" }, { status: 404 }); } };
    const res = await getTrace(makeEnv(agentDoStub));
    expect(res.status).toBe(404);
  });
});
