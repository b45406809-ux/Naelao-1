import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// AgentMail wiring on the agents worker: the /internal/business-email/{provision,send} routes hold
// AGENTMAIL_API_KEY (the isolate never sees it) and the public /channels/email/agentmail-inbound
// route Svix-verifies. These prove the HMAC gate, honest degradation when the key is unset, and
// that the inbound route fails closed on a bad signature — WITHOUT needing a live AgentMail key.

const SECRET = "test-platform-secret";
const TENANT = "tenant-1";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(over: Partial<AgentsEnv> = {}): AgentsEnv {
  return {
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ tenant_id: TENANT, status: "active" }) }) }),
    },
    ...over,
  } as unknown as AgentsEnv;
}

async function post(path: string, body: unknown, env: AgentsEnv, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(
    new Request(`https://agents.naelao.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env as never,
    execCtx
  );
}

describe("/internal/business-email/provision", () => {
  it("rejects a request with no internal token (403)", async () => {
    const res = await post("/internal/business-email/provision", { spaceId: "s1", tenantId: TENANT }, makeEnv(), { "x-naelao-tenant-id": TENANT });
    expect(res.status).toBe(403);
  });

  it("rejects a tenant that doesn't match the token (403)", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/provision", { spaceId: "s1", tenantId: "other-tenant" }, makeEnv(),
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(403);
  });

  it("degrades honestly (configured:false) when AGENTMAIL_API_KEY is unset", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/provision", { spaceId: "s1", tenantId: TENANT }, makeEnv(),
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; configured: boolean };
    expect(body).toMatchObject({ ok: false, configured: false });
  });
});

describe("/internal/business-email/send", () => {
  it("degrades honestly (configured:false) when AGENTMAIL_API_KEY is unset — so the prebuilt falls back to Resend", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/send", { spaceId: "s1", tenantId: TENANT, to: "a@b.com" }, makeEnv(),
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; configured: boolean };
    expect(body).toMatchObject({ ok: false, configured: false });
  });

  it("400s when `to` is missing", async () => {
    const token = await mintInternalToken(SECRET, TENANT);
    const res = await post("/internal/business-email/send", { spaceId: "s1", tenantId: TENANT }, makeEnv(),
      { "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token });
    expect(res.status).toBe(400);
  });
});

describe("/channels/email/agentmail-inbound/:spaceId", () => {
  it("400s when no vaulted webhook secret exists (inbound not configured for this space)", async () => {
    // CREDENTIALS_WORKER returns non-OK for the secret lookup → no_webhook_secret.
    const env = makeEnv({
      CREDENTIALS_WORKER: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
    });
    const res = await post("/channels/email/agentmail-inbound/s1", { event_type: "message.received" }, env,
      { "svix-id": "x", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,deadbeef" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("no_webhook_secret");
  });

  it("401s on an invalid Svix signature even when a secret exists (fails closed)", async () => {
    const env = makeEnv({
      CREDENTIALS_WORKER: { fetch: async () => Response.json({ value: "whsec_" + btoa("k".repeat(24)) }) } as unknown as Fetcher,
    });
    const res = await post("/channels/email/agentmail-inbound/s1", { event_type: "message.received" }, env,
      { "svix-id": "x", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,not-a-real-signature" });
    expect(res.status).toBe(401);
  });
});
