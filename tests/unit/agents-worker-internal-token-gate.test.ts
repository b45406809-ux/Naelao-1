import { describe, it, expect, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// Go-live audit F1: naelao-agents has NO workers_dev=false backstop (its channel gateway needs
// public ingress), so a direct caller at the workers.dev URL can set any x-naelao-tenant-id it
// likes. `/agent/run` has verified the router-minted x-naelao-internal-token since S0.2 — but a
// batch of routes added in later phases (Phase Q's runs/tasks polling, the connectors/channels/
// skills/assistant/bootstrap surfaces, and the entirely-unauthenticated /internal/tasks/:id/run)
// only read the spoofable header and stopped, exposing cross-tenant reads/writes and a free,
// unattributed LLM-execution oracle billed to the platform's own Anthropic key. Every one of
// those routes now shares requireVerifiedTenant() — this file locks in that a bare spoofed
// tenant header (no signed token) is rejected, and that the SAME request WITH a valid token is
// accepted (proving the fix didn't just break the route for everyone).

const SECRET = "test-platform-secret";
const OTHER_SECRET = "attacker-guessed-secret";
const TENANT = "victim-tenant";

function makeEnv(spaceActive = true): AgentsEnv {
  // A DB/stub that would succeed if the handler were ever reached — so a 401/403 can only come
  // from the auth gate, never from a downstream failure masquerading as a rejection.
  const okStmt = {
    bind() { return okStmt; },
    async first() { return spaceActive ? { id: "space-1", tenant_id: TENANT, config_json: "{}" } : null; },
    async all() { return { results: [] }; },
    async run() { return { meta: { changes: 1 } }; },
  };
  const agentDoStub = { fetch: vi.fn(async () => Response.json({ ok: true })) };
  return {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET: SECRET,
    WHOP_API_KEY: "k",
    NAELAO_WHOP_COMPANY_ID: "c",
    PLATFORM_DB: { prepare: () => okStmt } as unknown as D1Database,
    NAELAO_AGENT_DO: { idFromName: (n: string) => ({ toString: () => n }), get: () => agentDoStub },
    SPACES_WORKER: { fetch: async () => Response.json({ role: "owner" }) },
    TASK_DO: { idFromName: (n: string) => ({ toString: () => n }), get: () => ({ fetch: async () => Response.json({ tasks: [] }) }) },
    ANALYTICS: { writeDataPoint() {} },
    agentDoFetch: agentDoStub.fetch,
  } as unknown as AgentsEnv & { agentDoFetch: typeof agentDoStub.fetch };
}

// Representative routes across each phase family that shared the vulnerable getCallerIdentity-only
// pattern. GET routes are the cross-tenant *read* surface; the internal task-run route is the
// free-LLM-oracle surface.
const GET_ROUTES = [
  "/spaces/space-1/sessions/sess-1/agent/runs/run-1",
  "/spaces/space-1/tasks",
  "/spaces/space-1/tasks/task-1",
  "/connectors/status?space_id=space-1",
  "/spaces/space-1/channels/sessions",
  "/spaces/space-1/assistant/memory",
];

describe("F1 — agents-worker routes reject a spoofed tenant header with no valid internal token", () => {
  for (const path of GET_ROUTES) {
    it(`GET ${path} → 401 when the internal token is absent`, async () => {
      const res = await app.fetch(
        new Request(`https://agents.naelao.com${path}`, { headers: { "x-naelao-tenant-id": TENANT } }),
        makeEnv()
      );
      expect(res.status).toBe(401);
    });

    it(`GET ${path} → 401 when the token is signed with the wrong secret`, async () => {
      const forged = await mintInternalToken(OTHER_SECRET, TENANT);
      const res = await app.fetch(
        new Request(`https://agents.naelao.com${path}`, {
          headers: { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": forged },
        }),
        makeEnv()
      );
      expect(res.status).toBe(401);
    });

    it(`GET ${path} → passes the auth gate with a validly-minted token`, async () => {
      const token = await mintInternalToken(SECRET, TENANT);
      const res = await app.fetch(
        new Request(`https://agents.naelao.com${path}`, {
          headers: { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token },
        }),
        makeEnv()
      );
      // Past the gate: anything but 401/403 (200 for the reads whose stubs succeed).
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  }

  it("POST /internal/tasks/:id/run → 403 with no token (was completely unauthenticated)", async () => {
    const res = await app.fetch(
      new Request("https://agents.naelao.com/internal/tasks/task-1/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT },
        body: JSON.stringify({ taskId: "task-1", spaceId: "space-1", sessionId: "s", tenantId: TENANT, goal: "x", systemPrompt: "", tools: [], kbContext: "", model: "claude-sonnet-4-6" }),
      }),
      makeEnv()
    );
    expect(res.status).toBe(403);
  });

  it("POST /internal/tasks/:id/run → 403 when the body tenantId doesn't match the signed token", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await app.fetch(
      new Request("https://agents.naelao.com/internal/tasks/task-1/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token },
        body: JSON.stringify({ taskId: "task-1", spaceId: "space-1", sessionId: "s", tenantId: "some-other-tenant", goal: "x", systemPrompt: "", tools: [], kbContext: "", model: "claude-sonnet-4-6" }),
      }),
      makeEnv()
    );
    expect(res.status).toBe(403);
  });

  it("POST /internal/tasks/:id/run → blocks a validly signed task after its Space or tenant is suspended", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const env = makeEnv(false) as AgentsEnv & { agentDoFetch: ReturnType<typeof vi.fn> };
    const res = await app.fetch(
      new Request("https://agents.naelao.com/internal/tasks/task-1/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token },
        body: JSON.stringify({ taskId: "task-1", spaceId: "space-1", sessionId: "s", tenantId: TENANT, goal: "x", model: "claude-sonnet-4-6" }),
      }),
      env
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(env.agentDoFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["/internal/triggers/fire", { spaceId: "space-1", tenantId: TENANT, scriptName: "cleanup" }],
    ["/internal/scripts/run-durable", { spaceId: "space-1", tenantId: TENANT, scriptName: "cleanup" }],
  ])("POST %s → blocks a signed script dispatch after suspension", async (path, payload) => {
    const token = await mintInternalToken(SECRET, TENANT);
    const env = makeEnv(false) as AgentsEnv & { agentDoFetch: ReturnType<typeof vi.fn> };
    const res = await app.fetch(
      new Request(`https://agents.naelao.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token },
        body: JSON.stringify(payload),
      }),
      env
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(env.agentDoFetch).not.toHaveBeenCalled();
  });

  it("POST /internal/workflows/effect → blocks a resumed side effect after suspension", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const env = makeEnv(false) as AgentsEnv & { agentDoFetch: ReturnType<typeof vi.fn> };
    const res = await app.fetch(
      new Request("https://agents.naelao.com/internal/workflows/effect", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token },
        body: JSON.stringify({
          identity: { tenantId: TENANT, spaceId: "space-1", runId: "run-1" },
          key: "effect-1", operation: "external.send", params: {}, idempotencyKey: "run-1:effect-1",
        }),
      }),
      env
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(env.agentDoFetch).not.toHaveBeenCalled();
  });
});

/**
 * The on-demand heartbeat sweep runs the SAME enqueueAgentTicks the hourly cron runs, which
 * dispatches real reasoning runs against the platform's own LLM budget for every space with a
 * due job. That makes it exactly the shape of route F1 was written about — it must never be
 * reachable from the public workers.dev URL with a spoofed tenant header alone.
 */
describe("POST /internal/agent-ticks/run is internal-only", () => {
  it("403 with a spoofed tenant header and no token", async () => {
    const res = await app.fetch(
      new Request("https://agents.naelao.com/internal/agent-ticks/run", {
        method: "POST",
        headers: { "x-naelao-tenant-id": TENANT },
      }),
      makeEnv()
    );
    expect(res.status).toBe(403);
  });

  it("403 when the token is signed with the wrong secret", async () => {
    const token = await mintInternalToken(OTHER_SECRET, TENANT);
    const res = await app.fetch(
      new Request("https://agents.naelao.com/internal/agent-ticks/run", {
        method: "POST",
        headers: { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token },
      }),
      makeEnv()
    );
    expect(res.status).toBe(403);
  });

  it("sweeps with a validly-minted token", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await app.fetch(
      new Request("https://agents.naelao.com/internal/agent-ticks/run", {
        method: "POST",
        headers: { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token },
      }),
      makeEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, swept: true });
  });
});
