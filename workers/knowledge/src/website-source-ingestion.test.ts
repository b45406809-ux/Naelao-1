import { mintInternalToken } from "@naelao/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkSsrf } = vi.hoisted(() => ({
  checkSsrf: vi.fn(async () => ({ blocked: false as const })),
}));
vi.mock("@naelao/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@naelao/security")>();
  return { ...actual, checkSsrf };
});

import worker from "./index.js";

const connection = {
  id: "connection-1", tenant_id: "tenant-1", space_id: "space-1", owner_user_id: "owner-1",
  project_id: "project-1", origins_json: '["https://docs.example"]', status: "active",
};

function fixture(options: { connection?: typeof connection | null; projectRank?: number; refreshDocument?: Record<string, unknown> | null;
  refreshOperation?: Record<string, unknown> | null } = {}) {
  const sqlCalls: string[] = [];
  const db = {
    prepare: vi.fn((sql: string) => { sqlCalls.push(sql); return ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("JOIN orgs")) return { id: "space-1" };
          if (sql === "SELECT config_json FROM spaces WHERE id = ? AND status != 'deleted'") return { config_json: "{}" };
          if (sql.includes("FROM project_access")) return { visibility: "private", role_rank: options.projectRank ?? 50 };
          if (sql.includes("FROM kb_documents") && sql.includes("source_connection_ref")) return options.refreshDocument ?? null;
          if (sql.includes("FROM kb_source_refresh_operations")) return options.refreshOperation ?? null;
          if (sql.includes("FROM website_connections")) {
            const grant = options.connection === null ? null : options.connection ?? connection;
            if (!grant || grant.id !== args[0] || grant.tenant_id !== args[1] || grant.space_id !== args[2]
              || grant.owner_user_id !== args[3] || grant.project_id !== args[4] || grant.status !== "active") return null;
            return grant;
          }
          return null;
        },
        run: async () => ({ meta: { changes: 1 } }),
      }),
    }); }),
    batch: vi.fn(async (statements: unknown[]) => {
      return statements.map(() => ({ meta: { changes: 1 } }));
    }),
  };
  return { env: { ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db } as unknown as Parameters<NonNullable<typeof worker.fetch>>[1], db, sqlCalls };
}

async function request(body: unknown, role = "owner") {
  const token = await mintInternalToken("secret", "tenant-1");
  return new Request("https://knowledge/spaces/space-1/kb/projects/project-1/sources/website/preview", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "owner-1",
      "x-naelao-role": role, "x-naelao-internal-token": token },
    body: JSON.stringify(body),
  });
}

async function refreshRequestHash() {
  const bytes = new TextEncoder().encode(JSON.stringify({ tenantId: "tenant-1", spaceId: "space-1", projectId: "project-1",
    documentId: "doc-1", connectionId: "connection-1", sourceRevision: 4, requestedUrl: "https://docs.example/guide" }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

describe("scoped website Knowledge preview", () => {
  beforeEach(() => checkSsrf.mockReset().mockResolvedValue({ blocked: false }));
  afterEach(() => vi.unstubAllGlobals());

  it("fetches only an approved page, strips markup, and returns an owner-bound receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://docs.example/guide");
      expect(init?.redirect).toBe("manual");
      return new Response("<h1>Guide</h1><script>bad()</script><p>Approved text</p>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }));
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ preview: {
      content: "Guide  Approved text", requested_url: "https://docs.example/guide", final_url: "https://docs.example/guide",
      content_type: "text/html", preview_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), preview_token: expect.any(String),
    } });
  });

  it("rejects non-owner Project roles before making a network request", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }, "member"), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("resolves the product-user owner role from the exact Project ACL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# Project guide", { headers: { "content-type": "text/markdown" } })));
    const owner = fixture({ projectRank: 50 });
    const allowed = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }, "product_end_user"), owner.env, {} as ExecutionContext);
    expect(allowed.status).toBe(200);

    const member = fixture({ projectRank: 20 });
    const denied = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }, "product_end_user"), member.env, {} as ExecutionContext);
    expect(denied.status).toBe(403);
  });

  it("rejects a connection from another owner or Project", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const f = fixture({ connection: { ...connection, owner_user_id: "someone-else" } });
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects a URL outside the owner-approved connection origins", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://attacker.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects query strings and fragments so URL credentials cannot enter the source record", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide?token=secret#section" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("revalidates origin allowlists on every redirect before fetching the destination", async () => {
    const outbound = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example/secret" } }));
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(checkSsrf).toHaveBeenCalledTimes(1);
  });

  it("records an idempotent, source-revision-bound refresh before returning an owner review receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Updated guide", { headers: { "content-type": "text/plain" } })));
    const f = fixture({ refreshDocument: { id: "doc-1", source_url: "https://docs.example/guide", source_revision: 4,
      source_connection_ref: "connection-1", source_state: "current", source_adapter: "website" } });
    const response = await worker.fetch!(await request({ document_id: "doc-1", idempotency_key: "refresh-request-0001",
      url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const body = await response.json() as { preview: { refresh_operation_id: string; expected_source_revision: number; preview_token: string } };
    expect(body.preview).toMatchObject({ refresh_operation_id: expect.any(String), expected_source_revision: 4 });
    expect(f.sqlCalls.some((sql) => sql.includes("INSERT INTO kb_source_refresh_operations"))).toBe(true);
    expect(f.sqlCalls.some((sql) => sql.includes("source_last_attempt_at"))).toBe(true);
    expect(f.db.prepare).toHaveBeenCalledWith(expect.stringContaining("SET state='preview_ready'"));
  });

  it("records refresh failure and retry backoff without replacing the current source", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("temporary network failure"); }));
    const f = fixture({ refreshDocument: { id: "doc-1", source_url: "https://docs.example/guide", source_revision: 4,
      source_connection_ref: "connection-1", source_state: "current", source_adapter: "website" } });
    const response = await worker.fetch!(await request({ document_id: "doc-1", idempotency_key: "refresh-request-0002",
      url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(502);
    expect(f.sqlCalls.some((sql) => sql.includes("state='failed'") && sql.includes("next_attempt_at"))).toBe(true);
    expect(f.sqlCalls.some((sql) => sql.includes("source_refresh_failures=source_refresh_failures+1"))).toBe(true);
  });

  it("blocks a second refresh while the durable operation is fetching", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const f = fixture({ refreshDocument: { id: "doc-1", source_url: "https://docs.example/guide", source_requested_url: "https://docs.example/guide",
      source_revision: 4, source_connection_ref: "connection-1", source_state: "current", source_adapter: "website" },
      refreshOperation: { id: "refresh-op", state: "fetching", request_sha256: "a".repeat(64), attempt_count: 1,
        next_attempt_at: null, last_attempt_at: new Date().toISOString() } });
    const response = await worker.fetch!(await request({ document_id: "doc-1", idempotency_key: "refresh-request-0003",
      url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(409);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("recovers an abandoned refresh after the bounded lease and returns a retry time", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const f = fixture({ refreshDocument: { id: "doc-1", source_url: "https://docs.example/guide", source_requested_url: "https://docs.example/guide",
      source_revision: 4, source_connection_ref: "connection-1", source_state: "current", source_adapter: "website" },
      refreshOperation: { id: "refresh-op", state: "fetching", request_sha256: await refreshRequestHash(), attempt_count: 1,
        next_attempt_at: null, last_attempt_at: new Date(Date.now() - 3 * 60_000).toISOString() } });
    const response = await worker.fetch!(await request({ document_id: "doc-1", idempotency_key: "refresh-request-0003",
      url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error_code: "website_refresh_interrupted", retry_at: expect.any(String) });
    expect(outbound).not.toHaveBeenCalled();
    expect(f.sqlCalls.some((sql) => sql.includes("error_code='website_refresh_interrupted'") && sql.includes("state='fetching'"))).toBe(true);
    expect(f.sqlCalls.some((sql) => sql.includes("source_refresh_failures=source_refresh_failures+1"))).toBe(true);
  });
});
