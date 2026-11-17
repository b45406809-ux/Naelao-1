import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkSsrf } = vi.hoisted(() => ({ checkSsrf: vi.fn(async () => ({ blocked: false as const })) }));
vi.mock("@naelao/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@naelao/security")>();
  return { ...actual, checkSsrf };
});

import worker from "./index.js";

const migration = readFileSync(new URL("../../../infra/migrations/0277_knowledge_website_crawl_preview.sql", import.meta.url), "utf8");

function fixture(enabled = true) {
  const d1 = createFakeD1([
    "PRAGMA foreign_keys = ON",
    `CREATE TABLE orgs (id TEXT PRIMARY KEY, status TEXT NOT NULL)`,
    `CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL)`,
    `CREATE TABLE project_access (tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, project_id TEXT NOT NULL,
      user_id TEXT NOT NULL, role_rank INTEGER NOT NULL, PRIMARY KEY (tenant_id,space_id,project_id,user_id))`,
    `CREATE TABLE website_connections (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, space_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL, project_id TEXT, origins_json TEXT NOT NULL, knowledge_path_prefixes_json TEXT NOT NULL,
      status TEXT NOT NULL)`,
    migration,
  ]);
  d1.db.exec(`INSERT INTO orgs VALUES ('tenant-1','active');
    INSERT INTO spaces VALUES ('space-1','tenant-1','active','{}');
    INSERT INTO project_access VALUES ('tenant-1','space-1','project-1','owner-1',50);
    INSERT INTO website_connections VALUES ('connection-1','tenant-1','space-1','owner-1','project-1',
      '["https://docs.example"]','["/docs"]','active');`);
  const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: d1,
    KNOWLEDGE_WEBSITE_CRAWL_ENABLED: enabled ? "true" : "false" } as unknown as Parameters<NonNullable<typeof worker.fetch>>[1];
  return { d1, env };
}

async function request(path: string, body?: unknown, role = "owner") {
  const token = await mintInternalToken("secret", "tenant-1");
  return new Request(`https://knowledge${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "owner-1",
      "x-naelao-role": role, "x-naelao-internal-token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const crawlPath = "/spaces/space-1/kb/projects/project-1/sources/website/crawl/preview";
const crawlInput = { connection_id: "connection-1", url: "https://docs.example/docs/start", idempotency_key: "crawl-request-0001",
  max_pages: 2, max_depth: 1, owner_confirmed_site_terms: true };

describe("owner-bounded website crawl route", () => {
  beforeEach(() => checkSsrf.mockReset().mockResolvedValue({ blocked: false }));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps rollout disabled and requires the owner to attest to site terms", async () => {
    const disabled = fixture(false);
    const hidden = await worker.fetch!(await request(crawlPath, crawlInput), disabled.env, {} as ExecutionContext);
    expect(hidden.status).toBe(404);

    const enabled = fixture(true);
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const rejected = await worker.fetch!(await request(crawlPath, { ...crawlInput, owner_confirmed_site_terms: false }),
      enabled.env, {} as ExecutionContext);
    expect(rejected.status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
    await expect((await worker.fetch!(await request("/spaces/space-1/kb/projects/project-1/sources/website/crawl/capability"),
      enabled.env, {} as ExecutionContext)).json()).resolves.toMatchObject({ available: true, active_operations_per_tenant: 2 });
  });

  it("persists bounded URL/hash checkpoints only, resumes idempotently and erases them on owner demotion", async () => {
    const f = fixture();
    const outbound = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://docs.example/robots.txt") return new Response(null, { status: 404 });
      if (url === "https://docs.example/docs/start") return new Response(
        '<main>Private start content</main><a href="/docs/child">Child</a>', { headers: { "content-type": "text/html" } });
      if (url === "https://docs.example/docs/child") return new Response(
        "Private child content", { headers: { "content-type": "text/plain" } });
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(await request(crawlPath, crawlInput), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const result = await response.json() as { operation_id: string; status: string; pages: Array<Record<string, unknown>> };
    expect(result.status).toBe("completed");
    expect(result.pages).toHaveLength(2);
    expect(result.pages.map((page) => page.status)).toEqual(["preview_ready", "preview_ready"]);
    expect(JSON.stringify(result)).not.toContain("Private start content");
    expect(JSON.stringify(result)).not.toContain("Private child content");
    expect(outbound.mock.calls.map(([url]) => String(url))).toEqual([
      "https://docs.example/robots.txt", "https://docs.example/docs/start", "https://docs.example/docs/child",
    ]);
    expect(f.d1.db.prepare("SELECT * FROM kb_website_crawl_pages ORDER BY depth").all().map((page) => page.byte_count))
      .toEqual([65, 21]);
    expect(f.d1.db.prepare("PRAGMA table_info(kb_website_crawl_pages)").all().some((column) => column.name === "content")).toBe(false);

    const statusPath = `/spaces/space-1/kb/projects/project-1/sources/website/crawl/operations/${result.operation_id}`;
    const statusResponse = await worker.fetch!(await request(statusPath), f.env, {} as ExecutionContext);
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({ operation_id: result.operation_id, status: "completed",
      continuation_available: false, totals: { page_count: 2, byte_count: 86 }, pages: [{ status: "preview_ready" }, { status: "preview_ready" }] });
    expect(outbound).toHaveBeenCalledTimes(3);

    const replay = await worker.fetch!(await request(crawlPath, crawlInput), f.env, {} as ExecutionContext);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { operation_id: string }).operation_id).toBe(result.operation_id);
    expect(outbound).toHaveBeenCalledTimes(3);

    f.d1.db.prepare("UPDATE project_access SET role_rank=20 WHERE project_id='project-1' AND user_id='owner-1'").run();
    expect(f.d1.db.prepare("SELECT COUNT(*) AS count FROM kb_website_crawl_operations").get()).toMatchObject({ count: 0 });
    expect(f.d1.db.prepare("SELECT COUNT(*) AS count FROM kb_website_crawl_pages").get()).toMatchObject({ count: 0 });
  });

  it("keeps crawl status bound to the original owner and live connection policy", async () => {
    const f = fixture();
    const outbound = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://docs.example/robots.txt") return new Response(null, { status: 404 });
      return new Response("A short page", { headers: { "content-type": "text/plain" } });
    });
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(await request(crawlPath, crawlInput), f.env, {} as ExecutionContext);
    const result = await response.json() as { operation_id: string };
    const statusPath = `/spaces/space-1/kb/projects/project-1/sources/website/crawl/operations/${result.operation_id}`;
    f.d1.db.prepare("UPDATE website_connections SET owner_user_id='owner-2' WHERE id='connection-1'").run();
    const status = await worker.fetch!(await request(statusPath), f.env, {} as ExecutionContext);
    expect(status.status).toBe(404);
    expect(f.d1.db.prepare("SELECT COUNT(*) AS count FROM kb_website_crawl_operations").get()).toMatchObject({ count: 0 });
  });

  it("revalidates the active grant after every fetch and rejects an out-of-prefix redirect", async () => {
    const f = fixture();
    const outbound = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://docs.example/robots.txt") return new Response(null, { status: 404 });
      if (url === "https://docs.example/docs/start") return new Response(null, { status: 302,
        headers: { location: "/private/secret" } });
      throw new Error(`Out-of-scope URL was fetched: ${url}`);
    });
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(await request(crawlPath, crawlInput), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const result = await response.json() as { pages: Array<{ status: string; error_code: string | null }> };
    expect(result.pages[0]).toMatchObject({ status: "blocked", error_code: "website_destination_rejected" });
    expect(outbound.mock.calls.map(([url]) => String(url))).toEqual([
      "https://docs.example/robots.txt", "https://docs.example/docs/start",
    ]);
  });

  it("deletes the URL frontier and rejects a response if the host grant is revoked mid-fetch", async () => {
    const f = fixture();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://docs.example/robots.txt") return new Response(null, { status: 404 });
      f.d1.db.prepare("UPDATE website_connections SET status='revoked' WHERE id='connection-1'").run();
      return new Response("Should not be persisted", { headers: { "content-type": "text/plain" } });
    }));
    const response = await worker.fetch!(await request(crawlPath, crawlInput), f.env, {} as ExecutionContext);
    expect(response.status).toBe(409);
    expect(f.d1.db.prepare("SELECT COUNT(*) AS count FROM kb_website_crawl_operations").get()).toMatchObject({ count: 0 });
    expect(f.d1.db.prepare("SELECT COUNT(*) AS count FROM kb_website_crawl_pages").get()).toMatchObject({ count: 0 });
  });

  it("blocks a third active crawl for a tenant before making an outbound request", async () => {
    const f = fixture();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    for (const id of ["active-a", "active-b"]) {
      f.d1.db.prepare(`INSERT INTO kb_website_crawl_operations
        (id,tenant_id,space_id,project_id,connection_ref,owner_user_id,root_url,connection_policy_sha256,
         idempotency_key_hash,request_sha256,max_pages,max_depth,owner_terms_confirmed_at,status,generation,
         lease_token,lease_expires_at,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,2,1,?,'running',1,?,?,?, ?,?)`)
        .run(id, "tenant-1", "space-1", "project-1", "connection-1", "owner-1", "https://docs.example/docs/start",
          "a".repeat(64), id === "active-a" ? "b".repeat(64) : "c".repeat(64), "d".repeat(64), new Date().toISOString(),
          `lease-${id}`, expiresAt, new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(), new Date().toISOString(), new Date().toISOString());
    }
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch!(await request(crawlPath, { ...crawlInput, idempotency_key: "crawl-request-0002" }),
      f.env, {} as ExecutionContext);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "website_crawl_in_progress" });
    expect(outbound).not.toHaveBeenCalled();
  });
});
