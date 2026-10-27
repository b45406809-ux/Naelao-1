import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app, type Env } from "./index";

describe("extension provider connection route authorization", () => {
  const makeEnv = async (spaceFetch = vi.fn(async () => Response.json({
    instance: { instance_id: "install-a", tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a", status: "active", scope: "PROJECT_BOUND" },
    manifest: { id: "ext_mentor", bundle: { id: "ext_mentor", version: "1.0.0", connections: [{ id: "other", provider: "slack" }] } },
    release: { signatureValid: true },
  })), airGapped = false) => {
    const secret = "provider-route-auth-test-secret";
    const token = await mintInternalToken(secret, "tenant-a");
    const env = { PLATFORM_SECRET: secret, ENVIRONMENT: "test", SLACK_CLIENT_ID: "client", SLACK_CLIENT_SECRET: "secret",
      PUBLIC_AGENTS_URL: "https://agents.naelao.app", AGENT_CACHE: {},
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ config_json: airGapped ? '{"compliance":{"airGappedOnly":true}}' : "{}" }) }) }) },
      SPACES_WORKER: { fetch: spaceFetch },
    } as unknown as Env;
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token };
    return { env, headers, spaceFetch };
  };

  it("requires a router-minted internal tenant token", async () => {
    const { env, headers, spaceFetch } = await makeEnv();
    const response = await app.request("/spaces/space-a/projects/project-a/extensions/install-a/connections/slack-main/oauth/slack/start", {
      method: "POST", headers: { ...headers, "x-naelao-internal-token": "forged" }, body: JSON.stringify({ return_url: "https://agents.naelao.app/settings" }),
    }, env);
    expect(response.status).toBe(401);
    expect(spaceFetch).not.toHaveBeenCalled();
  });

  it("denies a project member before it resolves the provider installation", async () => {
    const { env, headers, spaceFetch } = await makeEnv();
    const response = await app.request("/spaces/space-a/projects/project-a/extensions/install-a/connections/slack-main/oauth/slack/start", {
      method: "POST", headers: { ...headers, "x-naelao-user-id": "member-a", "x-naelao-role": "member" }, body: JSON.stringify({ return_url: "https://agents.naelao.app/settings" }),
    }, env);
    expect(response.status).toBe(403);
    expect(spaceFetch).not.toHaveBeenCalled();
  });

  it("rejects a connection ID absent from the active signed extension bundle", async () => {
    const { env, headers, spaceFetch } = await makeEnv();
    const response = await app.request("/spaces/space-a/projects/project-a/extensions/install-a/connections/slack-main/oauth/slack/start", {
      method: "POST", headers: { ...headers, "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" }, body: JSON.stringify({ return_url: "https://agents.naelao.app/settings" }),
    }, env);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error_code: "extension_connection_not_declared" });
    expect(spaceFetch).toHaveBeenCalledOnce();
  });

  it("blocks provider setup and listing before provider or installation calls in an air-gapped Space", async () => {
    const { env, headers, spaceFetch } = await makeEnv(undefined, true);
    const base = "/spaces/space-a/projects/project-a/extensions/install-a/connections/slack-main";
    const requests: Array<{ path: string; method: string }> = [
      { path: `${base}/oauth/slack/start`, method: "POST" },
      { path: `${base}/telegram/connect`, method: "POST" },
      { path: `${base}/whatsapp/connect`, method: "POST" },
      { path: `${base}/routes/available`, method: "GET" },
    ];
    for (const request of requests) {
      const response = await app.request(request.path, {
        method: request.method,
        headers: { ...headers, "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" },
        ...(request.method === "POST" ? { body: JSON.stringify({ return_url: "https://agents.naelao.app/settings" }) } : {}),
      }, env);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error_code: "air_gap_egress_denied" });
    }
    expect(spaceFetch).not.toHaveBeenCalled();
  });

  it("does not subscribe a WhatsApp account before the installed handler is available", async () => {
    const secret = "provider-route-auth-test-secret";
    const token = await mintInternalToken(secret, "tenant-a");
    const spaceFetch = vi.fn(async () => Response.json({
      instance: { instance_id: "install-a", tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a", status: "active", scope: "PROJECT_BOUND" },
      manifest: {
        id: "ext_mentor",
        bundle: { id: "ext_mentor", version: "1.0.0", connections: [{ id: "whatsapp-main", provider: "whatsapp" }] },
        channels: [{ kind: "channel", provider: "whatsapp", connectionId: "whatsapp-main", handlerScript: "./handler.ts" }],
      },
      release: { signatureValid: true },
    }));
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/debug_token")) return Response.json({ data: { is_valid: true, app_id: "meta-app", scopes: ["whatsapp_business_messaging", "whatsapp_business_management"] } });
      if (url.includes("/123456789")) return Response.json({ id: "123456789", verified_name: "Test", display_phone_number: "+1 555 0100", whatsapp_business_account: { id: "987654321" } });
      if (url.includes("/subscribed_apps")) return Response.json({ success: true });
      throw new Error(`Unexpected provider request: ${url}`);
    });
    vi.stubGlobal("fetch", providerFetch);
    const env = {
      PLATFORM_SECRET: secret,
      ENVIRONMENT: "test",
      PUBLIC_AGENTS_URL: "https://agents.naelao.app",
      CREDENTIALS_WORKER: {},
      WHATSAPP_APP_ID: "meta-app",
      WHATSAPP_APP_SECRET: "meta-secret",
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
      SPACES_WORKER: { fetch: spaceFetch },
      SCRIPTS_R2: { get: async () => null },
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ config_json: "{}" }) }) }) },
    } as unknown as Env;
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token,
      "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" };
    try {
      const response = await app.request("/spaces/space-a/projects/project-a/extensions/install-a/connections/whatsapp-main/whatsapp/connect", {
        method: "POST", headers, body: JSON.stringify({ access_token: "x".repeat(64), phone_number_id: "123456789" }),
      }, env);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error_code: "extension_handler_unavailable" });
      expect(providerFetch.mock.calls.some(([input]) => String(input).includes("/subscribed_apps"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
