import { Hono } from "hono";
import { it, expect, describe, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
const { checkSsrf } = vi.hoisted(() => ({ checkSsrf: vi.fn(async () => ({ blocked: false as const })) }));
vi.mock("@naelao/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@naelao/security")>();
  return { ...actual, checkSsrf };
});
import { normalizeKnowledgePathPrefixes, registerWebsiteConnectionRoutes } from "./website-connections.js";
import type { Env } from "../index.js";
const base = {
  tenantId: "tenant",
  spaceId: "space",
  actorId: "user",
  projectId: "project",
  agentId: "worker",
  connectionId: "connection",
  authorizedOrigins: ["https://example.com"],
};
function fixture(row: Record<string, unknown> | null) {
  const first = vi.fn(async () => row);
  const app = new Hono<{ Bindings: Env }>();
  registerWebsiteConnectionRoutes(app);
  return {
    app,
    env: {
      PLATFORM_SECRET: "secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first }) }) },
    } as unknown as Env,
    first,
  };
}
async function headers() {
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": "tenant",
    "x-naelao-internal-token": await mintInternalToken("secret", "tenant"),
  };
}
const row = {
  tenant_id: "tenant",
  space_id: "space",
  owner_user_id: "user",
  project_id: "project",
  agent_ids_json: '["worker"]',
  origins_json: '["https://example.com"]',
};
describe("website account authorization", () => {
  it("normalizes bounded canonical path prefixes and rejects traversal or query syntax", () => {
    expect(normalizeKnowledgePathPrefixes(["/docs", "/help/", "/docs"])).toEqual(["/docs", "/help/"]);
    expect(normalizeKnowledgePathPrefixes(["/docs/../private"])).toBeNull();
    expect(normalizeKnowledgePathPrefixes(["/docs?token=secret"])).toBeNull();
    expect(normalizeKnowledgePathPrefixes([])).toBeNull();
  });

  it("persists owner-selected Knowledge path prefixes on the host website connection", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = { prepare: vi.fn((sql: string) => ({ bind: (...args: unknown[]) => {
      calls.push({ sql, args });
      return {
        first: async () => sql.includes("SELECT id FROM spaces") ? { id: "space" }
          : sql.includes("space_members sm") ? { role: "owner" } : null,
        run: async () => ({ meta: { changes: 1 } }),
      };
    } })) };
    const app = new Hono<{ Bindings: Env }>();
    registerWebsiteConnectionRoutes(app);
    const env = { PLATFORM_SECRET: "secret", PLATFORM_DB: db,
      SPACE_DO: { idFromName: vi.fn(() => "space-id"), get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ data: [] })) })) } } as unknown as Env;
    const response = await app.request("/spaces/space/website-connections", {
      method: "POST", headers: { ...(await headers()), "x-naelao-user-id": "user" },
      body: JSON.stringify({ name: "Docs", start_url: "https://example.com/docs", knowledge_path_prefixes: ["/docs", "/help"] }),
    }, env);
    expect(response.status).toBe(201);
    const insert = calls.find(({ sql }) => sql.includes("INSERT INTO website_connections"));
    expect(insert?.sql).toContain("knowledge_path_prefixes_json");
    expect(insert?.args[8]).toBe('["/docs","/help"]');
    expect(checkSsrf).toHaveBeenCalledOnce();
  });

  it("returns the persisted Knowledge path policy to its exact owner", async () => {
    const db = { prepare: vi.fn((sql: string) => ({ bind: () => ({
      first: async () => sql.includes("SELECT id FROM spaces") ? { id: "space" }
        : sql.includes("space_members sm") ? { role: "owner" } : null,
      all: async () => ({ results: [{ id: "connection", name: "Docs", project_id: "project", start_url: "https://example.com/docs",
        origins_json: '["https://example.com"]', knowledge_path_prefixes_json: '["/docs","/help"]', agent_ids_json: "[]" }] }),
    }) })) };
    const app = new Hono<{ Bindings: Env }>();
    registerWebsiteConnectionRoutes(app);
    const env = { PLATFORM_SECRET: "secret", PLATFORM_DB: db,
      SPACE_DO: { idFromName: vi.fn(() => "space-id"), get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ data: [] })) })) } } as unknown as Env;
    const response = await app.request("/spaces/space/website-connections", {
      headers: { ...(await headers()), "x-naelao-user-id": "user" },
    }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [{ id: "connection", knowledge_path_prefixes: ["/docs", "/help"] }] });
  });

  it("rejects unsigned requests before reading account data", async () => {
    const f = fixture(row);
    const res = await f.app.request(
      "/spaces/space/website-connections",
      {},
      f.env
    );
    expect(res.status).toBe(403);
    expect(f.first).not.toHaveBeenCalled();
  });
  it.each([
    { actorId: "other" },
    { projectId: "other" },
    { spaceId: "other" },
    { tenantId: "other" },
    { agentId: "other" },
    { agentId: "website-login" },
    { authorizedOrigins: ["https://attacker.example"] },
  ])("rejects changed identity/workspace/origin %j", async (change) => {
    const f = fixture(row);
    const res = await f.app.request(
      "/internal/website-connection-authorize",
      {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ ...base, ...change }),
      },
      f.env
    );
    expect(res.status).toBe(403);
  });
  it("rejects revoked or nonexistent accounts", async () => {
    const f = fixture(null);
    const res = await f.app.request(
      "/internal/website-connection-authorize",
      { method: "POST", headers: await headers(), body: JSON.stringify(base) },
      f.env
    );
    expect(res.status).toBe(403);
  });

  it("revokes the host connection and calls Knowledge cleanup with a signed internal request", async () => {
    const dbCalls: Array<{ sql: string; args: unknown[] }> = [];
    const connection = { id: "connection", tenant_id: "tenant", space_id: "space", owner_user_id: "user", project_id: "project",
      name: "Docs", start_url: "https://example.com", origins_json: '["https://example.com"]', agent_ids_json: "[]", status: "active" };
    const db = {
      prepare: vi.fn((sql: string) => ({ bind: (...args: unknown[]) => {
        dbCalls.push({ sql, args });
        return {
          first: async () => sql.includes("FROM website_connections") ? connection
            : sql.includes("JOIN space_members") ? { role: "owner" }
              : sql.includes("SELECT id FROM spaces") ? { id: "space" } : null,
          run: async () => ({ meta: { changes: 1 } }),
        };
      } })),
    };
    const knowledgeFetch = vi.fn(async () => Response.json({ revoked: 1, cleanup_completed: 0, cleanup_pending: 1 }));
    const app = new Hono<{ Bindings: Env }>();
    registerWebsiteConnectionRoutes(app);
    const env = {
      PLATFORM_SECRET: "secret",
      PLATFORM_DB: db,
      SPACE_DO: {
        idFromName: vi.fn(() => "space-do-id"),
        get: vi.fn(() => ({ fetch: async (request: Request) => request.url.includes("assistant-access")
          ? Response.json({ effective_role: "editor" }) : Response.json({ data: [] }) })),
      },
      KNOWLEDGE_WORKER: { fetch: knowledgeFetch },
      BROWSER_WORKER: { fetch: vi.fn(async () => Response.json({ ok: true })) },
    } as unknown as Env;
    const token = await mintInternalToken("secret", "tenant");
    const response = await app.request("/spaces/space/website-connections?id=connection", { method: "DELETE", headers: {
      "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user", "x-naelao-internal-token": token,
    } }, env);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "revoked", cleanup_pending: 1 });
    expect(dbCalls.some(({ sql, args }) => sql.includes("UPDATE website_connections SET status='revoked'")
      && args.join(":") === "connection:tenant:space:user")).toBe(true);
    expect(knowledgeFetch).toHaveBeenCalledOnce();
    const knowledgeRequest = knowledgeFetch.mock.calls[0]?.[0] as Request;
    expect(new URL(knowledgeRequest.url).pathname).toBe("/internal/spaces/space/kb/sources/website/revoke");
    expect(knowledgeRequest.headers.get("x-naelao-tenant-id")).toBe("tenant");
    await expect(knowledgeRequest.json()).resolves.toEqual({ connection_id: "connection" });
  });

  it("still revokes the browser profile when Knowledge cleanup is temporarily unavailable", async () => {
    const connection = { id: "connection", tenant_id: "tenant", space_id: "space", owner_user_id: "user", project_id: "project",
      name: "Docs", start_url: "https://example.com", origins_json: '["https://example.com"]', agent_ids_json: "[]", status: "active" };
    const db = { prepare: (sql: string) => ({ bind: () => ({
      first: async () => sql.includes("FROM website_connections") ? connection
        : sql.includes("JOIN space_members") ? { role: "owner" }
          : sql.includes("SELECT id FROM spaces") ? { id: "space" } : null,
      run: async () => ({ meta: { changes: 1 } }),
    }) }) };
    const knowledgeFetch = vi.fn(async () => { throw new Error("Knowledge worker unavailable"); });
    const browserFetch = vi.fn(async () => Response.json({ ok: true }));
    const app = new Hono<{ Bindings: Env }>();
    registerWebsiteConnectionRoutes(app);
    const env = {
      PLATFORM_SECRET: "secret", PLATFORM_DB: db,
      SPACE_DO: { idFromName: vi.fn(() => "space-do-id"), get: vi.fn(() => ({ fetch: async (request: Request) => request.url.includes("assistant-access")
        ? Response.json({ effective_role: "editor" }) : Response.json({ data: [] }) })) },
      KNOWLEDGE_WORKER: { fetch: knowledgeFetch }, BROWSER_WORKER: { fetch: browserFetch },
    } as unknown as Env;
    const token = await mintInternalToken("secret", "tenant");
    const response = await app.request("/spaces/space/website-connections?id=connection", { method: "DELETE", headers: {
      "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user", "x-naelao-internal-token": token,
    } }, env);
    expect(response.status).toBe(503);
    expect(browserFetch).toHaveBeenCalledOnce();
  });
});
