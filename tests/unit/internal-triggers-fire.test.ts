import { describe, it, expect, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// B3 regression: POST /internal/triggers/fire used to accept a static, forgeable
// "x-naelao-internal: spaces-trigger" string as its only auth. Anyone who could reach the
// agents worker directly (before workers_dev was disabled) could run any named script in any
// tenant's space for free. Now gated by the same verified HMAC scheme naelao-router's proxyTo
// uses, plus a tenantId-header-vs-body cross-check.

const SECRET = "test-platform-secret";

function makeEnv(): AgentsEnv {
  const fireCalls: Array<{ body: unknown }> = [];
  const agentDoStub = {
    async fetch(reqInput: Request) {
      const body = await reqInput.json().catch(() => null);
      fireCalls.push({ body });
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    },
  };
  return {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET: SECRET,
    WHOP_API_KEY: "test-whop-key",
    NAELAO_WHOP_COMPANY_ID: "test-company",
    NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    ANALYTICS: { writeDataPoint() {} },
    __fireCalls: fireCalls,
  } as unknown as AgentsEnv & { __fireCalls: typeof fireCalls };
}

function fireReq(body: unknown, headers: Record<string, string>): Request {
  return new Request("https://agents.naelao.com/internal/triggers/fire", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /internal/triggers/fire — auth boundary", () => {
  it("rejects the OLD forgeable static-string header (regression: this used to be sufficient)", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      fireReq(
        { spaceId: "space-1", tenantId: "tenant-1", scriptName: "notifications.notify" },
        { "x-naelao-internal": "spaces-trigger" } // the old, forgeable check — no token at all
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects a request with no internal token and no tenant header", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      fireReq({ spaceId: "space-1", tenantId: "tenant-1", scriptName: "s" }, {}),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const env = makeEnv();
    const forged = await mintInternalToken("wrong-secret", "tenant-1");
    const res = await app.fetch(
      fireReq(
        { spaceId: "space-1", tenantId: "tenant-1", scriptName: "s" },
        { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": forged }
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects when the token's tenant does not match the header tenant", async () => {
    const env = makeEnv();
    const tokenForTenantA = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      fireReq(
        { spaceId: "space-1", tenantId: "tenant-a", scriptName: "s" },
        { "x-naelao-tenant-id": "tenant-b", "x-naelao-internal-token": tokenForTenantA }
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects when body.tenantId does not match the verified header tenant (cross-tenant script execution attempt)", async () => {
    const env = makeEnv();
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      fireReq(
        // Token legitimately proves the caller is acting for tenant-a, but the body tries to
        // run a script against tenant-b's space — must be rejected even though the token verifies.
        { spaceId: "space-1", tenantId: "tenant-b", scriptName: "s" },
        { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": validToken }
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("accepts a properly minted token whose tenant matches the header and body", async () => {
    const env = makeEnv();
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      fireReq(
        { spaceId: "space-1", tenantId: "tenant-a", scriptName: "notifications.notify" },
        { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": validToken }
      ),
      env
    );
    expect(res.status).toBe(200);
    expect((env as unknown as { __fireCalls: unknown[] }).__fireCalls).toHaveLength(1);
  });
});
