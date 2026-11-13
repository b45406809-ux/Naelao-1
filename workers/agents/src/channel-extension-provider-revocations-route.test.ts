import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import { app } from "./index.js";

const secret = "channel-provider-revocation-test-secret";

function setup(
  outcomes: unknown[] = [],
  credentialFetch: (request: Request) => Promise<Response> = async () => Response.json({ credentials: [] }),
  provider = "discord",
) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const batches: unknown[][] = [];
  let receipt = { status: "pending", action_code: null as string | null, last_error_code: null as string | null };
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              queries.push({ sql, values });
              if (sql.includes("FROM spaces s")) return { id: "space-a" };
              if (sql.includes("SELECT config_json FROM spaces")) return { config_json: null };
              if (sql.includes("FROM extension_provider_connections")) return sql.includes("status='revoked'")
                ? { provider, credential_name: `extension:instance-a:connection-a:${provider}`, webhook_secret_name: provider === "slack" ? "extension:instance-a:connection-a:webhook" : null, routing_keys_json: "[]" }
                : { provider };
              if (sql.includes("FROM extension_provider_revocation_outcomes")) return sql.includes("SELECT status,action_code,last_error_code")
                ? receipt
                : { installation_id: "instance-a", connection_id: "connection-a", provider, ...receipt,
                  attempt_count: 1, last_attempt_at: "2026-11-13T00:00:00.000Z", updated_at: "2026-11-13T00:00:01.000Z" };
              return null;
            },
            all: async () => {
              queries.push({ sql, values });
              return { results: sql.includes("FROM extension_provider_revocation_outcomes") ? outcomes : [] };
            },
            run: async () => {
              queries.push({ sql, values });
              if (sql.includes("SET action_code=?,last_error_code='credential_cleanup_pending'")) {
                receipt = { ...receipt, action_code: String(values[0]), last_error_code: "credential_cleanup_pending" };
              } else if (sql.includes("SET status=?,action_code=?,last_error_code=?,updated_at=?,completed_at=?")) {
                receipt = { status: String(values[0]), action_code: values[1] as string | null, last_error_code: values[2] as string | null };
              } else if (sql.includes("SET status=?,last_error_code=?,updated_at=?,completed_at=?")) {
                receipt = { ...receipt, status: String(values[0]), last_error_code: values[1] as string | null };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    batch: async (statements: unknown[]) => { batches.push(statements); return []; },
  };
  const credentials = { fetch: vi.fn(async (request: Request) => credentialFetch(request)) };
  const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db, CREDENTIALS_WORKER: credentials } as never;
  return { env, queries, credentials, batches };
}

async function call(env: unknown, body: Record<string, unknown>, tokenTenant = "tenant-a") {
  const token = await mintInternalToken(secret, tokenTenant);
  return app.request("/internal/channel-extensions/provider-revocations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": tokenTenant,
      "x-naelao-internal-token": token,
    },
    body: JSON.stringify({ spaceId: "space-a", projectId: "project-a", ...body }),
  }, env as never);
}

describe("channel extension provider cleanup route", () => {
  it("rejects requests without a valid internal tenant token", async () => {
    const h = setup();
    const response = await app.request("/internal/channel-extensions/provider-revocations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: JSON.stringify({ spaceId: "space-a", projectId: "project-a", action: "list" }),
    }, h.env as never);
    expect(response.status).toBe(403);
    expect(h.queries).toHaveLength(0);
  });

  it("retries only the exact tenant, Space, project, installation, and connection and reports unsupported provider cleanup", async () => {
    const h = setup();
    const response = await call(h.env, { action: "retry", installationId: "instance-a", connectionId: "connection-a" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: {
        connection_id: "connection-a", provider: "discord", status: "not_supported",
        action_code: "provider_cleanup_not_supported", last_error_code: "provider_revocation_not_supported",
      },
    });
    const connectionQuery = h.queries.find(query => query.sql.includes("FROM extension_provider_connections"));
    expect(connectionQuery?.values).toEqual(["tenant-a", "space-a", "project-a", "instance-a", "connection-a"]);
    expect(h.credentials.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns bounded project-scoped receipts without exposing credential or provider payload fields", async () => {
    const h = setup([{
      installation_id: "instance-a", connection_id: "connection-a", provider: "slack", status: "pending",
      attempt_count: 2, last_attempt_at: "2026-11-13T00:00:00.000Z", action_code: null,
      last_error_code: "provider_revoke_outcome_unknown", updated_at: "2026-11-13T00:00:00.000Z",
    }]);
    const response = await call(h.env, { action: "list" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcomes: [{
      installation_id: "instance-a", connection_id: "connection-a", provider: "slack", status: "pending",
      attempt_count: 2, last_attempt_at: "2026-11-13T00:00:00.000Z", action_code: null,
      last_error_code: "provider_revoke_outcome_unknown", updated_at: "2026-11-13T00:00:00.000Z",
    }] });
    expect(h.queries.some(query => query.sql.includes("FROM extension_provider_revocation_outcomes"))).toBe(true);
  });

  it("makes direct disconnect locally authoritative and durably records unsupported provider cleanup", async () => {
    const h = setup();
    const response = await app.request("/spaces/space-a/projects/project-a/extensions/instance-a/connections/connection-a", {
      method: "DELETE",
      headers: {
        "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
      },
    }, h.env as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      removed: true,
      providerRevocation: { connection_id: "connection-a", provider: "discord", status: "not_supported", action_code: "provider_cleanup_not_supported" },
    });
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toHaveLength(3);
    expect(h.queries.some(query => query.sql.includes("FROM extension_provider_revocation_outcomes"))).toBe(true);
  });

  it("keeps cleanup pending when the encrypted credential vault cannot confirm deletion", async () => {
    const h = setup([], () => Response.json({ error_code: "temporarily_unavailable" }, { status: 503 }));
    const response = await call(h.env, { action: "retry", installationId: "instance-a", connectionId: "connection-a" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: { status: "pending", action_code: "provider_cleanup_not_supported", last_error_code: "credential_cleanup_pending" },
    });
    expect(h.queries.some(query => query.sql.includes("SET action_code=?,last_error_code='credential_cleanup_pending'"))).toBe(true);
  });

  it("resumes credential deletion after provider acceptance without repeating the external revoke", async () => {
    let listCount = 0;
    const credentialFetch = async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/plaintext")) return Response.json({ value: "slack-secret" });
      if (request.method === "DELETE") return Response.json({ deleted: true });
      listCount++;
      if (listCount === 2) return Response.json({ error_code: "temporarily_unavailable" }, { status: 503 });
      return Response.json({ credentials: listCount === 1 ? [{ id: "token-id", name: "extension:instance-a:connection-a:slack" }] : [] });
    };
    const h = setup([], credentialFetch, "slack");
    const providerFetch = vi.fn(async () => Response.json({ ok: true }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", providerFetch);
    try {
      const first = await call(h.env, { action: "retry", installationId: "instance-a", connectionId: "connection-a" });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ outcome: { status: "pending", action_code: "slack_token_revoked", last_error_code: "credential_cleanup_pending" } });
      const retry = await call(h.env, { action: "retry", installationId: "instance-a", connectionId: "connection-a" });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ outcome: { status: "complete", action_code: "slack_token_revoked", last_error_code: null } });
      expect(providerFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});
