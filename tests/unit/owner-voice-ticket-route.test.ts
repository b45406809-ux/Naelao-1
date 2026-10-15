import { describe, expect, it } from "vitest";
import { app, type AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

const SECRET = "owner-voice-route-secret";
const TENANT = "tenant-voice";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function requestTicket(configJson: string, role = "owner") {
  let sessionChecks = 0;
  const env = {
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ status: "active", config_json: configJson }) }) }) },
    SPACES_WORKER: { fetch: async () => { sessionChecks++; return Response.json({ id: "session-1" }); } },
  } as unknown as AgentsEnv;
  const response = await app.fetch(new Request("https://agents.naelao.test/spaces/space-1/sessions/session-1/voice-ticket", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": TENANT,
      "x-naelao-user-id": "user-1",
      "x-naelao-role": role,
      "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT),
    },
    body: JSON.stringify({}),
  }), env as never, execCtx);
  return { response, sessionChecks };
}

describe("owner voice ticket route", () => {
  it("issues a short-lived ticket only after session scope is checked", async () => {
    const { response, sessionChecks } = await requestTicket("{}");
    expect(response.status).toBe(200);
    expect(sessionChecks).toBe(1);
    const body = await response.json() as { agent: string; name: string; ticket: string; expires_at: number; session_id: string };
    expect(body).toMatchObject({ agent: "OWNER_VOICE_AGENT", session_id: "session-1" });
    expect(body.name).toBeTruthy();
    expect(body.ticket).toContain(".");
    expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("refuses Cloudflare-hosted voice before session access in air-gapped Spaces", async () => {
    const { response, sessionChecks } = await requestTicket('{"compliance":{"airGappedOnly":true}}');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: "private_voice_unavailable" });
    expect(sessionChecks).toBe(0);
  });

  it("refuses non-owner caller roles", async () => {
    const { response } = await requestTicket("{}", "viewer");
    expect(response.status).toBe(403);
  });
});

describe("safe dynamic model activation route", () => {
  it("refuses an OpenRouter request for an air-gapped Space before resolving any BYOK credential", async () => {
    let credentialCalls = 0;
    const env = {
      PLATFORM_SECRET: SECRET,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ status: "active", config_json: '{"compliance":{"airGappedOnly":true}}' }) }) }) },
      CREDENTIALS_WORKER: { fetch: async () => { credentialCalls++; return Response.json({}); } },
    } as unknown as AgentsEnv;
    const response = await app.fetch(new Request("https://agents.naelao.test/spaces/space-1/llm-byok/models/activate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": TENANT,
        "x-naelao-user-id": "user-1",
        "x-naelao-role": "owner",
        "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT),
      },
      body: JSON.stringify({ model: "openrouter/vendor/model" }),
    }), env as never, execCtx);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "compliance_violation" });
    expect(credentialCalls).toBe(0);
  });
});
