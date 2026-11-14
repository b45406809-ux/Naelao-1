import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app, type Env } from "./index";

const secret = "provider-setup-recovery-test-secret";
const spaceId = "space-a", projectId = "project-a", installationId = "install-a", connectionId = "provider-main";

function setup(provider: "telegram" | "whatsapp", failConnectionCommit = false, setupClaimConflict = false) {
  const events: string[] = [];
  const credentials = new Map<string, { id: string; value: string }>();
  let operation: Record<string, unknown> | null = null;
  let connectionStatus: "error" | "active" | "revoked" | null = null;
  let batches = 0;
  let setupStatementSql: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
          all: async () => ({ results: [] }),
        bind(...values: unknown[]) {
          return {
            sql,
            values,
            first: async () => {
              if (sql.includes("SELECT config_json FROM spaces")) return { config_json: "{}" };
              if (sql.includes("FROM extension_provider_cleanup_operations") && sql.includes("SELECT operation_id,operation_kind")) return operation;
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (sql.includes("SET action_code='provider_setup_in_flight'")) {
                if (operation) Object.assign(operation, { action_code: "provider_setup_in_flight", last_error_code: "provider_setup_outcome_unknown", last_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() });
              } else if (sql.includes("SET status=?,action_code=?,last_error_code=?,updated_at=?,completed_at=?")) {
                if (operation) Object.assign(operation, { status: values[0], action_code: values[1], last_error_code: values[2] });
              } else if (sql.includes("SET action_code=?,last_error_code='credential_cleanup_pending'")) {
                if (operation) Object.assign(operation, { action_code: values[0], last_error_code: "credential_cleanup_pending" });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
      batches++;
      events.push(`d1_batch_${batches}`);
      const operationInsert = statements.find(statement => statement.sql.includes("INSERT INTO extension_provider_cleanup_operations") && statement.sql.includes("provider_setup_unstarted"));
      if (operationInsert) setupStatementSql = statements.map(statement => statement.sql);
      if (operationInsert && setupClaimConflict) return statements.map((_, index) => ({ meta: { changes: index === 0 || index === 2 ? 0 : 1 } }));
      if (operationInsert) {
        const values = operationInsert.values;
        operation = { operation_id: values[0], operation_kind: "setup", installation_id: values[4], connection_id: values[5], provider: values[6],
          account_id: values[7], credential_name: values[9], webhook_secret_name: values[10], routing_keys_json: values[11], status: "pending",
          action_code: "provider_setup_unstarted", last_error_code: null };
      }
      if (operation && statements.some(statement => statement.sql.includes("SET action_code='provider_setup_compensation_required'"))) {
        Object.assign(operation, { action_code: "provider_setup_compensation_required", last_error_code: "provider_setup_outcome_unknown" });
      }
      if (operation && statements.some(statement => statement.sql.includes("SET action_code='provider_setup_unstarted'"))) {
        Object.assign(operation, { action_code: "provider_setup_unstarted", last_error_code: "provider_setup_cancelled" });
      }
      if (statements.some(statement => statement.sql.includes("INSERT INTO extension_provider_connections"))) connectionStatus = "error";
      const isConnectionCommit = statements.some(statement => statement.sql.includes("SET status='active'"));
      if (isConnectionCommit && failConnectionCommit) throw new Error("simulated local commit failure");
      if (isConnectionCommit && !failConnectionCommit) {
        connectionStatus = "active";
        if (operation) Object.assign(operation, { status: "complete", action_code: "provider_setup_committed", last_error_code: null });
      }
      if (statements.some(statement => statement.sql.includes("SET status='revoked'"))) connectionStatus = "revoked";
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  const credentialsWorker = {
    fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/plaintext")) {
        const name = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const credential = credentials.get(name);
        return credential ? Response.json({ value: credential.value }) : Response.json({ error_code: "not_found" }, { status: 404 });
      }
      if (request.method === "POST") {
        const body = await request.json() as { name: string; value: string };
        credentials.set(body.name, { id: `id:${body.name}`, value: body.value });
        events.push("credential_saved");
        return Response.json({ saved: true });
      }
      if (request.method === "DELETE") {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const name = id.startsWith("id:") ? id.slice(3) : id;
        credentials.delete(name);
        events.push("credential_deleted");
        return Response.json({ deleted: true });
      }
      return Response.json({ credentials: [...credentials.entries()].map(([name, value]) => ({ id: value.id, name })) });
    }),
  };
  const instance = {
    instance_id: installationId, tenant_id: "tenant-a", space_id: spaceId, project_id: projectId, status: "active", scope: "PROJECT_BOUND",
  };
  const manifest = {
    id: "ext_test", bundle: { id: "ext_test", version: "1.0.0", connections: [{ id: connectionId, provider }] },
    channels: [{ kind: "channel", provider, connectionId, handlerScript: "./handler.ts" }],
  };
  const scriptBytes = new TextEncoder().encode("export default {}; ");
  const env = {
    PLATFORM_SECRET: secret,
    ENVIRONMENT: "test",
    PUBLIC_AGENTS_URL: "https://agents.naelao.app",
    PLATFORM_DB: db,
    CREDENTIALS_WORKER: credentialsWorker,
    SPACES_WORKER: { fetch: async () => Response.json({ instance, manifest, release: { signatureValid: true } }) },
    SCRIPTS_R2: { get: async () => ({ size: scriptBytes.byteLength, arrayBuffer: async () => scriptBytes.buffer }) },
    WHATSAPP_APP_ID: "meta-app",
    WHATSAPP_APP_SECRET: "meta-secret",
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
  } as unknown as Env;
  return { env, events, credentials, operation: () => operation, connectionStatus: () => connectionStatus, batches: () => batches, setupStatementSql: () => setupStatementSql };
}

async function connect(env: Env, provider: "telegram" | "whatsapp") {
  const headers = {
    "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    "x-naelao-user-id": "owner-a", "x-naelao-role": "owner",
  };
  const body = provider === "telegram"
    ? { bot_token: `12345:${"A".repeat(30)}` }
    : { access_token: "X".repeat(64), phone_number_id: "123456789" };
  return app.request(`/spaces/${spaceId}/projects/${projectId}/extensions/${installationId}/connections/${connectionId}/${provider}/connect`, {
    method: "POST", headers, body: JSON.stringify(body),
  }, env);
}

describe("Telegram and WhatsApp setup compensation", () => {
  it.each(["telegram", "whatsapp"] as const)("does not store credentials or call %s when its provider-wide setup claim loses", async provider => {
    const h = setup(provider, false, true);
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? "GET";
      if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 777, username: "test_bot" } });
      if (url.endsWith("/getWebhookInfo")) return Response.json({ ok: true, result: { url: "" } });
      if (url.includes("/debug_token")) return Response.json({ data: { is_valid: true, app_id: "meta-app", scopes: ["whatsapp_business_messaging", "whatsapp_business_management"] } });
      if (url.includes("/123456789?fields=")) return Response.json({ id: "123456789", verified_name: "Test", whatsapp_business_account: { id: "987654321" } });
      throw new Error(`Unexpected provider side effect ${method} ${url}`);
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", providerFetch);
    try {
      const response = await connect(h.env, provider);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error_code: "provider_setup_conflict" });
      expect(h.credentials.size).toBe(0);
      expect(h.operation()).toBeNull();
      expect(h.connectionStatus()).toBeNull();
      expect(h.setupStatementSql()[0]).toContain("WHERE NOT EXISTS (SELECT 1 FROM extension_provider_");
      expect(h.setupStatementSql()[2]).toContain("WHERE EXISTS (SELECT 1 FROM extension_provider_cleanup_operations");
      expect(providerFetch.mock.calls.some(([input]) => String(input).endsWith("/setWebhook") || String(input).endsWith("/subscribed_apps"))).toBe(false);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("commits a Telegram connection only after its persisted setup receives provider acceptance", async () => {
    const h = setup("telegram");
    const providerCalls: string[] = [];
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 777, username: "test_bot" } });
      if (url.endsWith("/getWebhookInfo")) return Response.json({ ok: true, result: { url: "" } });
      if (url.endsWith("/setWebhook")) {
        providerCalls.push("setWebhook");
        expect(h.operation()).toMatchObject({ operation_kind: "setup", status: "pending", action_code: "provider_setup_in_flight" });
        expect(h.connectionStatus()).toBe("error");
        return Response.json({ ok: true, result: true });
      }
      if (url.endsWith("/deleteWebhook")) { providerCalls.push("deleteWebhook"); return Response.json({ ok: true, result: true }); }
      throw new Error(`Unexpected Telegram request ${url}`);
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", providerFetch);
    try {
      const response = await connect(h.env, "telegram");
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ connected: true, account_label: "@test_bot" });
      expect(providerCalls).toEqual(["setWebhook"]);
      expect(h.operation()).toMatchObject({ status: "complete", action_code: "provider_setup_committed" });
      expect(h.connectionStatus()).toBe("active");
      expect(h.credentials.size).toBe(2);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("records Telegram setup before setWebhook and compensates an accepted provider action when the local commit fails", async () => {
    const h = setup("telegram", true);
    const providerCalls: Array<{ url: string; method: string }> = [];
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? "GET";
      providerCalls.push({ url, method });
      if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 777, username: "test_bot" } });
      if (url.endsWith("/getWebhookInfo")) return Response.json({ ok: true, result: { url: "" } });
      if (url.endsWith("/setWebhook")) {
        expect(h.batches()).toBe(1);
        expect(h.operation()).toMatchObject({ operation_kind: "setup", status: "pending", action_code: "provider_setup_in_flight" });
        expect(h.connectionStatus()).toBe("error");
        return Response.json({ ok: true, result: true });
      }
      if (url.endsWith("/deleteWebhook")) return Response.json({ ok: true, result: true });
      throw new Error(`Unexpected Telegram request ${url}`);
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", providerFetch);
    try {
      const response = await connect(h.env, "telegram");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error_code: "provider_setup_commit_failed" });
      expect(providerCalls.map(call => call.url.endsWith("/setWebhook") ? "setWebhook" : call.url.endsWith("/deleteWebhook") ? "deleteWebhook" : "read"))
        .toContain("deleteWebhook");
      expect(h.operation()).toMatchObject({ status: "not_supported", action_code: "telegram_webhook_deleted", last_error_code: "telegram_token_revocation_manual" });
      expect(h.connectionStatus()).toBe("revoked");
      expect(h.credentials.size).toBe(0);
      expect(h.events.indexOf("d1_batch_1")).toBeLessThan(h.events.indexOf("credential_saved"));
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("reconciles an ambiguous Telegram setWebhook response from the persisted operation", async () => {
    const h = setup("telegram");
    const providerCalls: string[] = [];
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 777, username: "test_bot" } });
      if (url.endsWith("/getWebhookInfo")) return Response.json({ ok: true, result: { url: "" } });
      if (url.endsWith("/setWebhook")) { providerCalls.push("setWebhook"); throw new Error("connection lost after request"); }
      if (url.endsWith("/deleteWebhook")) { providerCalls.push("deleteWebhook"); return Response.json({ ok: true, result: true }); }
      throw new Error(`Unexpected Telegram request ${url}`);
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", providerFetch);
    try {
      const response = await connect(h.env, "telegram");
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error_code: "telegram_webhook_registration_failed" });
      expect(providerCalls).toEqual(["setWebhook", "deleteWebhook"]);
      expect(h.operation()).toMatchObject({ status: "not_supported", action_code: "telegram_webhook_deleted" });
      expect(h.connectionStatus()).toBe("revoked");
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("compensates a successful WhatsApp subscription when local connection persistence fails", async () => {
    const h = setup("whatsapp", true);
    const providerCalls: Array<{ url: string; method: string }> = [];
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? "GET";
      providerCalls.push({ url, method });
      if (url.includes("/debug_token")) return Response.json({ data: { is_valid: true, app_id: "meta-app", scopes: ["whatsapp_business_messaging", "whatsapp_business_management"] } });
      if (url.includes("/123456789?fields=")) return Response.json({ id: "123456789", verified_name: "Test", whatsapp_business_account: { id: "987654321" } });
      if (url.endsWith("/subscribed_apps") && method === "POST") {
        expect(h.batches()).toBe(1);
        expect(h.operation()).toMatchObject({ operation_kind: "setup", account_id: "987654321", status: "pending", action_code: "provider_setup_in_flight" });
        expect(h.connectionStatus()).toBe("error");
        return Response.json({ success: true });
      }
      if (url.endsWith("/subscribed_apps") && method === "DELETE") return Response.json({ success: true });
      throw new Error(`Unexpected WhatsApp request ${url}`);
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", providerFetch);
    try {
      const response = await connect(h.env, "whatsapp");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error_code: "provider_setup_commit_failed" });
      expect(providerCalls).toContainEqual({ url: expect.stringMatching(/\/subscribed_apps$/), method: "DELETE" });
      expect(h.operation()).toMatchObject({ status: "not_supported", action_code: "whatsapp_subscription_removed", last_error_code: "whatsapp_token_revocation_manual" });
      expect(h.connectionStatus()).toBe("revoked");
      expect(h.credentials.size).toBe(0);
      expect(h.events.indexOf("d1_batch_1")).toBeLessThan(h.events.indexOf("credential_saved"));
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});
