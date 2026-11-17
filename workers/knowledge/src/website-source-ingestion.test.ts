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
  project_id: "project-1", origins_json: '["https://docs.example"]', knowledge_path_prefixes_json: '["/"]', status: "active",
};

function fixture(options: { connection?: typeof connection | null; projectRank?: number; refreshDocument?: Record<string, unknown> | null;
  refreshOperation?: Record<string, unknown> | null; scheduleDocument?: Record<string, unknown> | null;
  scheduleRow?: Record<string, unknown> | null; scheduleEnabled?: boolean } = {}) {
  const sqlCalls: string[] = [];
  const db = {
    prepare: vi.fn((sql: string) => { sqlCalls.push(sql); return ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("JOIN orgs")) return { id: "space-1" };
          if (sql === "SELECT config_json FROM spaces WHERE id = ? AND status != 'deleted'") return { config_json: "{}" };
          if (sql.includes("FROM project_access")) return { visibility: "private", role_rank: options.projectRank ?? 50 };
          if (sql.includes("FROM kb_documents") && sql.includes("source_connection_ref")) return options.scheduleDocument ?? options.refreshDocument ?? null;
          if (sql.includes("FROM kb_source_refresh_operations")) return options.refreshOperation ?? null;
          if (sql.includes("FROM kb_source_refresh_schedules")) return options.scheduleRow ?? null;
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
  const analytics = { writeDataPoint: vi.fn() };
  const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db, KNOWLEDGE_ANALYTICS: analytics,
    KNOWLEDGE_WEBSITE_REFRESH_SCHEDULE_ENABLED: options.scheduleEnabled === false ? "false" : "true" } as unknown as Parameters<NonNullable<typeof worker.fetch>>[1];
  return { env, db, sqlCalls, analytics };
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

async function scheduleRequest(body: unknown, role = "product_end_user") {
  const token = await mintInternalToken("secret", "tenant-1");
  return new Request("https://knowledge/spaces/space-1/kb/projects/project-1/sources/website/doc-1/schedule", {
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
      if (String(input) === "https://docs.example/robots.txt") return new Response(null, { status: 404 });
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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/robots.txt")
      ? new Response(null, { status: 404 })
      : new Response("# Project guide", { headers: { "content-type": "text/markdown" } })));
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
    const outbound = vi.fn(async (input: RequestInfo | URL) => String(input) === "https://docs.example/robots.txt"
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 302, headers: { location: "https://other.example/secret" } }));
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).toHaveBeenCalledTimes(2);
    expect(checkSsrf).toHaveBeenCalledTimes(2);
  });

  it("rejects page paths outside the host connection's owner-approved prefixes", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const f = fixture({ connection: { ...connection, knowledge_path_prefixes_json: '["/docs"]' } });
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/docs-private/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("checks robots.txt and rejects a disallowed page before fetching its content", async () => {
    const outbound = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://docs.example/robots.txt");
      return new Response("User-agent: *\nDisallow: /private", { headers: { "content-type": "text/plain" } });
    });
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/private/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).toHaveBeenCalledOnce();
  });

  it("fails closed when robots.txt cannot be checked", async () => {
    const outbound = vi.fn(async () => new Response("Unavailable", { status: 503, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(502);
    expect(outbound).toHaveBeenCalledOnce();
  });

  it("reapplies owner path-prefix policy to each redirect destination", async () => {
    const outbound = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://docs.example/robots.txt") return new Response(null, { status: 404 });
      if (url === "https://docs.example/docs/guide") return new Response(null, { status: 302, headers: { location: "/private/guide" } });
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", outbound);
    const f = fixture({ connection: { ...connection, knowledge_path_prefixes_json: '["/docs"]' } });
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/docs/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).toHaveBeenCalledTimes(2);
  });

  it("honors the longest matching robots rule and checks redirects against each target's policy", async () => {
    const outbound = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://docs.example/robots.txt") {
        return new Response("User-agent: *\nDisallow: /\nAllow: /docs/", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://docs.example/docs/guide") {
        return new Response(null, { status: 302, headers: { location: "https://docs.example/private/guide" } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/docs/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).toHaveBeenCalledTimes(2);
  });

  it("records an idempotent, source-revision-bound refresh before returning an owner review receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/robots.txt")
      ? new Response("", { headers: { "content-type": "text/plain" } })
      : new Response("Updated guide", { headers: { "content-type": "text/plain" } })));
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
    f.analytics.writeDataPoint.mockImplementation(() => { throw new Error("analytics offline"); });
    const response = await worker.fetch!(await request({ document_id: "doc-1", idempotency_key: "refresh-request-0002",
      url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(502);
    expect(f.sqlCalls.some((sql) => sql.includes("state='failed'") && sql.includes("next_attempt_at"))).toBe(true);
    expect(f.sqlCalls.some((sql) => sql.includes("source_refresh_failures=source_refresh_failures+1"))).toBe(true);
    expect(f.analytics.writeDataPoint).toHaveBeenCalledWith({ blobs: ["knowledge_source_preview", "owner_approved_fetch", "preview_failed"], doubles: [1], indexes: [] });
  });

  it("records privacy-safe telemetry when an owner-approved first-time preview fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/robots.txt")) return new Response(null, { status: 404 });
      throw new Error("network failed for https://docs.example/private-token");
    }));
    const f = fixture();
    f.analytics.writeDataPoint.mockImplementation(() => { throw new Error("analytics offline"); });
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(502);
    expect(f.analytics.writeDataPoint).toHaveBeenCalledWith({ blobs: ["knowledge_source_preview", "owner_approved_fetch", "preview_failed"], doubles: [1], indexes: [] });
    expect(JSON.stringify(f.analytics.writeDataPoint.mock.calls)).not.toContain("private-token");
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
    f.analytics.writeDataPoint.mockImplementation(() => { throw new Error("analytics offline"); });
    const response = await worker.fetch!(await request({ document_id: "doc-1", idempotency_key: "refresh-request-0003",
      url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error_code: "website_refresh_interrupted", retry_at: expect.any(String) });
    expect(outbound).not.toHaveBeenCalled();
    expect(f.sqlCalls.some((sql) => sql.includes("error_code='website_refresh_interrupted'") && sql.includes("state='fetching'"))).toBe(true);
    expect(f.sqlCalls.some((sql) => sql.includes("source_refresh_failures=source_refresh_failures+1"))).toBe(true);
    expect(f.analytics.writeDataPoint).toHaveBeenCalledWith({ blobs: ["knowledge_source_refresh", "interrupted_recovered"], doubles: [1], indexes: [] });
  });

  it("records active source-refresh backoff using fixed labels and no source identifiers", async () => {
    const f = fixture({ refreshDocument: { id: "doc-1", source_url: "https://docs.example/guide", source_requested_url: "https://docs.example/guide",
      source_revision: 4, source_connection_ref: "connection-1", source_state: "current", source_adapter: "website" },
      refreshOperation: { id: "refresh-op", state: "failed", request_sha256: await refreshRequestHash(), attempt_count: 3,
        next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(), last_attempt_at: new Date().toISOString() } });
    const response = await worker.fetch!(await request({ document_id: "doc-1", idempotency_key: "refresh-request-0003",
      url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(429);
    expect(f.analytics.writeDataPoint).toHaveBeenCalledWith({ blobs: ["knowledge_source_refresh", "backoff_active"], doubles: [3], indexes: [] });
    expect(JSON.stringify(f.analytics.writeDataPoint.mock.calls)).not.toContain("doc-1");
    expect(JSON.stringify(f.analytics.writeDataPoint.mock.calls)).not.toContain("project-1");
  });
});

describe("owner-controlled website refresh schedule", () => {
  it("stores an explicit daily opt-in bound to the current Project source and owner grant", async () => {
    const f = fixture({ scheduleDocument: { id: "doc-1", status: "indexed", source_adapter: "website",
      source_state: "current", source_connection_ref: "connection-1" },
    scheduleRow: { enabled: 1, interval_hours: 24, next_run_at: "2026-11-17T12:00:00.000Z" } });
    const response = await worker.fetch!(await scheduleRequest({ enabled: true, interval_hours: 24 }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ schedule: { enabled: 1, interval_hours: 24 } });
    const insert = f.sqlCalls.findIndex((sql) => sql.includes("INSERT INTO kb_source_refresh_schedules"));
    expect(insert).toBeGreaterThanOrEqual(0);
    expect(f.sqlCalls[insert]).toContain("ON CONFLICT(document_id) DO UPDATE");
  });

  it("does not let a Project member opt a website source into automatic refresh", async () => {
    const f = fixture({ projectRank: 30, scheduleDocument: { id: "doc-1", status: "indexed", source_adapter: "website",
      source_state: "current", source_connection_ref: "connection-1" } });
    const response = await worker.fetch!(await scheduleRequest({ enabled: true, interval_hours: 24 }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(f.sqlCalls.some((sql) => sql.includes("INSERT INTO kb_source_refresh_schedules"))).toBe(false);
  });

  it("keeps schedule activation unavailable while the rollout flag is off", async () => {
    const f = fixture({ scheduleEnabled: false, scheduleDocument: { id: "doc-1", status: "indexed", source_adapter: "website",
      source_state: "current", source_connection_ref: "connection-1" } });
    const response = await worker.fetch!(await scheduleRequest({ enabled: true, interval_hours: 24 }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(f.sqlCalls.some((sql) => sql.includes("INSERT INTO kb_source_refresh_schedules"))).toBe(false);
  });

  it("clears the persisted lease when an owner pauses an active schedule", async () => {
    const f = fixture({ scheduleDocument: { id: "doc-1", status: "indexed", source_adapter: "website",
      source_state: "current", source_connection_ref: "connection-1" }, scheduleRow: null });
    const response = await worker.fetch!(await scheduleRequest({ enabled: false, interval_hours: 168 }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(f.sqlCalls.some((sql) => sql.includes("enabled=0,generation=generation+1") && sql.includes("lease_token=NULL"))).toBe(true);
  });
});
