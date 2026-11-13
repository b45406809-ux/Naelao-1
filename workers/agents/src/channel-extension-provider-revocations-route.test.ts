import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import { app } from "./index.js";

const secret = "channel-provider-revocation-test-secret";
const operationId = "operation-a";

function setup(
  outcomes: unknown[] = [],
  credentialFetch: (request: Request) => Promise<Response> = async () => Response.json({ credentials: [] }),
  provider = "discord",
  operationSnapshots: Record<string, Record<string, unknown>> = {},
) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const batches: unknown[][] = [];
  const receipts = new Map<string, { status: string; action_code: string | null; last_error_code: string | null }>();
  const receiptFor = (id: string) => receipts.get(id) ?? { status: "pending", action_code: null, last_error_code: null };
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              queries.push({ sql, values });
              if (sql.includes("FROM spaces s")) return { id: "space-a" };
              if (sql.includes("SELECT config_json FROM spaces")) return { config_json: null };
              if (sql.includes("FROM extension_provider_connections")) return { provider, account_id: "account-a",
                credential_name: `extension:instance-a:connection-a:${provider}`,
                webhook_secret_name: provider === "slack" ? "extension:instance-a:connection-a:webhook" : null, routing_keys_json: "[]" };
              if (sql.includes("FROM extension_provider_cleanup_operations")) {
                const id = String(values[3] ?? operationId);
                const snapshot = { operation_id: id, installation_id: "instance-a", connection_id: "connection-a", provider, account_id: "account-a",
                  credential_name: `extension:instance-a:connection-a:${provider}`,
                  webhook_secret_name: provider === "slack" ? "extension:instance-a:connection-a:webhook" : null,
                  routing_keys_json: "[]", ...operationSnapshots[id], ...receiptFor(id) };
                return sql.includes("credential_name,webhook_secret_name") ? snapshot : { ...snapshot,
                  attempt_count: 1, last_attempt_at: "2026-11-13T00:00:00.000Z", updated_at: "2026-11-13T00:00:01.000Z" };
              }
              return null;
            },
            all: async () => {
              queries.push({ sql, values });
              return { results: sql.includes("FROM extension_provider_cleanup_operations") ? outcomes : [] };
            },
            run: async () => {
              queries.push({ sql, values });
              const id = String(values.at(-1) ?? operationId);
              const receipt = receiptFor(id);
              if (sql.includes("SET action_code=?,last_error_code='credential_cleanup_pending'")) {
                receipts.set(id, { ...receipt, action_code: String(values[0]), last_error_code: "credential_cleanup_pending" });
              } else if (sql.includes("SET status=?,action_code=?,last_error_code=?,updated_at=?,completed_at=?")) {
                receipts.set(id, { status: String(values[0]), action_code: values[1] as string | null, last_error_code: values[2] as string | null });
              } else if (sql.includes("SET status=?,last_error_code=?,updated_at=?,completed_at=?")) {
                receipts.set(id, { ...receipt, status: String(values[0]), last_error_code: values[1] as string | null });
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

  it("retries only the exact tenant, Space, project, and cleanup operation and reports unsupported provider cleanup", async () => {
    const h = setup();
    const response = await call(h.env, { action: "retry", operationId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: {
        operation_id: operationId, connection_id: "connection-a", provider: "discord", status: "not_supported",
        action_code: "provider_cleanup_not_supported", last_error_code: "provider_revocation_not_supported",
      },
    });
    const operationQuery = h.queries.find(query => query.sql.includes("FROM extension_provider_cleanup_operations") && query.sql.includes("credential_name,webhook_secret_name"));
    expect(operationQuery?.values).toEqual(["tenant-a", "space-a", "project-a", operationId]);
    expect(h.credentials.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns bounded project-scoped receipts without exposing credential or provider payload fields", async () => {
    const h = setup([{
      operation_id: operationId, installation_id: "instance-a", connection_id: "connection-a", provider: "slack", status: "pending",
      attempt_count: 2, last_attempt_at: "2026-11-13T00:00:00.000Z", action_code: null,
      last_error_code: "provider_revoke_outcome_unknown", updated_at: "2026-11-13T00:00:00.000Z",
    }]);
    const response = await call(h.env, { action: "list" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcomes: [{
      operation_id: operationId, installation_id: "instance-a", connection_id: "connection-a", provider: "slack", status: "pending",
      attempt_count: 2, last_attempt_at: "2026-11-13T00:00:00.000Z", action_code: null,
      last_error_code: "provider_revoke_outcome_unknown", updated_at: "2026-11-13T00:00:00.000Z",
    }] });
    expect(h.queries.some(query => query.sql.includes("FROM extension_provider_cleanup_operations"))).toBe(true);
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
      providerRevocation: { operation_id: expect.any(String), installation_id: "instance-a", connection_id: "connection-a", provider: "discord", status: "not_supported", action_code: "provider_cleanup_not_supported" },
    });
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toHaveLength(3);
    expect(h.queries.some(query => query.sql.includes("FROM extension_provider_cleanup_operations"))).toBe(true);
  });

  it("keeps cleanup pending when the encrypted credential vault cannot confirm deletion", async () => {
    const h = setup([], () => Response.json({ error_code: "temporarily_unavailable" }, { status: 503 }));
    const response = await call(h.env, { action: "retry", operationId });
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
      const first = await call(h.env, { action: "retry", operationId });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ outcome: { status: "pending", action_code: "slack_token_revoked", last_error_code: "credential_cleanup_pending" } });
      const retry = await call(h.env, { action: "retry", operationId });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ outcome: { status: "complete", action_code: "slack_token_revoked", last_error_code: null } });
      expect(providerFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("keeps retries bound to each saved credential generation after the connection is reused", async () => {
    const firstName = "EXT_SLACK_generation_one";
    const secondName = "EXT_SLACK_generation_two";
    const plaintextNames: string[] = [];
    const credentialFetch = async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/plaintext")) {
        const name = decodeURIComponent(path.split("/").at(-2) ?? "");
        plaintextNames.push(name);
        return Response.json({ value: name === firstName ? "token-one" : "token-two" });
      }
      return Response.json({ credentials: [] });
    };
    const h = setup([], credentialFetch, "slack", {
      "operation-one": { credential_name: firstName, webhook_secret_name: null },
      "operation-two": { credential_name: secondName, webhook_secret_name: null },
    });
    const providerFetch = vi.fn(async () => Response.json({ ok: true }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", providerFetch);
    try {
      expect((await call(h.env, { action: "retry", operationId: "operation-one" })).status).toBe(200);
      expect((await call(h.env, { action: "retry", operationId: "operation-two" })).status).toBe(200);
      expect(plaintextNames).toEqual([firstName, secondName]);
      expect(providerFetch.mock.calls.map(([input, init]) => [String(input), new Headers(init?.headers).get("authorization")]))
        .toEqual([["https://slack.com/api/auth.revoke", "Bearer token-one"], ["https://slack.com/api/auth.revoke", "Bearer token-two"]]);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});
