import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// §A1 Phase HX1: GET .../sessions/:sessionId/agent/runs/:runId/trace — the structured trace's
// HTTP side. A builder JWT always passes; a product_end_user must be an actual member of the
// target business (checked via SPACES_WORKER's /internal/business-role, same posture as the
// Sub-agents/Memory/Files panels) so the shell's own chat surface can re-fetch a completed run's
// activity trail after a reload.

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

function makeEnv(agentDoStub: { fetch: () => Promise<Response> }, businessRole?: string) {
  return {
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: makeDb(),
    NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    SPACES_WORKER: { async fetch(request: Request) {
      if (new URL(request.url).pathname.endsWith("/compact-scope")) return Response.json({ project_id: "project-1", owned_by_caller: true, private_scratchpad: false });
      return businessRole ? Response.json({ role: businessRole }) : new Response(null, { status: 404 });
    } },
  } as unknown as AgentsEnv;
}

async function getTrace(env: AgentsEnv, role?: string, userId?: string) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  const headers: Record<string, string> = { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token };
  if (role) headers["x-naelao-role"] = role;
  if (userId) headers["x-naelao-user-id"] = userId;
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

  it("rejects a product_end_user caller who owns the session but isn't a business member", async () => {
    let called = false;
    const agentDoStub = { async fetch() { called = true; return Response.json({ run_id: "run-1", trace: [] }); } };
    const res = await getTrace(makeEnv(agentDoStub), "product_end_user", "user-1");
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });

  it("allows a product_end_user who IS a member of the business", async () => {
    const traceBody = { run_id: "run-1", trace: [{ seq: 0, phase: "observe", ts: 1000 }] };
    const agentDoStub = { async fetch() { return Response.json(traceBody); } };
    const env = makeEnv(agentDoStub, "member");
    const res = await getTrace(env, "product_end_user", "user-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(traceBody);
  });

  it("propagates a 404 from the DO unchanged", async () => {
    const agentDoStub = { async fetch() { return Response.json({ error: "not found" }, { status: 404 }); } };
    const res = await getTrace(makeEnv(agentDoStub));
    expect(res.status).toBe(404);
  });
});
