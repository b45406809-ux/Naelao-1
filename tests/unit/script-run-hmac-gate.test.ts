import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// S0.2: POST /agents/:agentId/script/run used to derive tenantId from body.tenantId or the
// caller-supplied x-naelao-tenant-id header with NO verification at all — and this endpoint runs
// the full reasoning loop against the platform's ANTHROPIC_API_KEY. Since the agents worker has
// no workers_dev=false backstop (the channel gateway needs public ingress), anyone reaching this
// worker's public URL directly could run arbitrary agents as any tenant, burning that tenant's
// credits. Now gated by the same verified HMAC scheme naelao-router's proxyTo always attaches.

const SECRET = "test-platform-secret";

function makeEnv(active = true): AgentsEnv & { __runCalls: unknown[] } {
  const runCalls: unknown[] = [];
  const agentDoStub = {
    async fetch(reqInput: Request) {
      const body = await reqInput.json().catch(() => null);
      runCalls.push(body);
      return new Response(JSON.stringify({ final_answer: "done" }), { status: 200 });
    },
  };
  return {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => active ? { id: "space-1" } : null }) }) },
    WHOP_API_KEY: "test-whop-key",
    NAELAO_WHOP_COMPANY_ID: "test-company",
    NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    ANALYTICS: { writeDataPoint() {} },
    __runCalls: runCalls,
  } as unknown as AgentsEnv & { __runCalls: unknown[] };
}

function scriptRunReq(body: unknown, headers: Record<string, string>): Request {
  return new Request("https://agents.naelao.com/agents/naelao-agent/script/run", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /agents/:agentId/script/run — auth boundary", () => {
  it("rejects the OLD forgeable static header (regression: this used to be sufficient)", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      scriptRunReq(
        { goal: "do something", spaceId: "space-1", tenantId: "tenant-1" },
        { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal": "billing" }
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects a request with no internal token at all", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      scriptRunReq({ goal: "do something", spaceId: "space-1", tenantId: "tenant-1" }, {}),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects a token signed with the wrong secret (spoofed tenant)", async () => {
    const env = makeEnv();
    const forged = await mintInternalToken("wrong-secret", "tenant-1");
    const res = await app.fetch(
      scriptRunReq(
        { goal: "do something", spaceId: "space-1", tenantId: "tenant-1" },
        { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": forged }
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects when body.tenantId does not match the verified header tenant", async () => {
    const env = makeEnv();
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      scriptRunReq(
        { goal: "do something", spaceId: "space-1", tenantId: "tenant-b" },
        { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": validToken, "x-naelao-space-id": "space-1" }
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("accepts a properly minted token whose tenant matches the header and body", async () => {
    const env = makeEnv();
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      scriptRunReq(
        { goal: "do something", spaceId: "space-1", tenantId: "tenant-a" },
        { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": validToken }
      ),
      env
    );
    expect(res.status).toBe(200);
    expect(env.__runCalls).toHaveLength(1);
  });

  it("rejects a valid internal request for a suspended tenant before reaching the agent DO", async () => {
    const env = makeEnv(false);
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(scriptRunReq(
      { goal: "do something", spaceId: "space-1", tenantId: "tenant-a" },
      { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": validToken },
    ), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error_code: "tenant_suspended" });
    expect(env.__runCalls).toHaveLength(0);
  });

  it("never forwards caller-supplied durable continuation state to the agent DO", async () => {
    const env = makeEnv();
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      scriptRunReq({
        goal: "do something",
        spaceId: "space-1",
        tenantId: "tenant-a",
        humanAnswer: "approved",
        resumeSteps: [{ name: "send_payment", params: { amount: 500 }, ok: true }],
        ledgerKey: "some-other-run",
        deliberationRound: 2,
      }, {
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-internal-token": validToken,
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(env.__runCalls).toHaveLength(1);
    const forwarded = env.__runCalls[0] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("humanAnswer");
    expect(forwarded).not.toHaveProperty("resumeSteps");
    expect(forwarded).not.toHaveProperty("ledgerKey");
    expect(forwarded).not.toHaveProperty("deliberationRound");
  });
});

describe("POST /spaces/:spaceId/sessions/:sessionId/agent/run — auth boundary", () => {
  it("rejects a spoofed x-naelao-tenant-id with no internal token", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/agent/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1" },
        body: JSON.stringify({ goal: "hello" }),
      }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("rejects a token minted for a different tenant than the header claims", async () => {
    const env = makeEnv();
    const forged = await mintInternalToken(SECRET, "tenant-other");
    const res = await app.fetch(
      new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/agent/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-1",
          "x-naelao-internal-token": forged,
        },
        body: JSON.stringify({ goal: "hello" }),
      }),
      env
    );
    expect(res.status).toBe(401);
  });
});
