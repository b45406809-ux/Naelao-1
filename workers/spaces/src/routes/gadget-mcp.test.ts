import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerGadgetMcpRoutes } from "./gadget-mcp.js";

describe("gadget MCP host adapter", () => {
  it("checks tenant ownership before routing app, storage, and MCP requests", async () => {
    const idFromName = vi.fn((name: string) => name as never);
    const fetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname, method: request.method }));
    const app = new Hono();
    registerGadgetMcpRoutes(app as never);
    const env = {
      PLATFORM_DB: { prepare: () => ({ bind: (...args: unknown[]) => ({ first: async () => args[0] === "s" && args[1] === "t" ? { 1: 1 } : null }) }) },
      MICRO_APP_DO: { idFromName, get: () => ({ fetch }) },
    } as never;

    const denied = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "wrong" } }, env);
    expect(denied.status).toBe(404);
    expect(idFromName).not.toHaveBeenCalled();

    const allowed = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(await allowed.json()).toEqual({ path: "/mcp", method: "POST" });
    expect(idFromName).toHaveBeenCalledWith("gadget:app:space:s");
    expect(fetch).toHaveBeenCalledOnce();

    const page = await app.request("/spaces/s/apps/app/app", { headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(await page.json()).toEqual({ path: "/app", method: "GET" });
    const data = await app.request("/spaces/s/apps/app/api/data?key=x", { headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(await data.json()).toEqual({ path: "/api/data", method: "GET" });
    const storage = await app.request("/spaces/s/apps/app/api/storage", { headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(await storage.json()).toEqual({ path: "/api/storage", method: "GET" });
    const deniedPage = await app.request("/spaces/s/apps/app/app", { headers: { "x-naelao-tenant-id": "wrong", "x-naelao-role": "admin" } }, env);
    expect(deniedPage.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("requires an administrator to initialize a gadget", async () => {
    const app = new Hono();
    registerGadgetMcpRoutes(app as never);
    const env = {
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ ok: true }) }) },
    } as never;
    const denied = await app.request("/spaces/s/apps/app/initialize", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "member" }, body: "{}" }, env);
    expect(denied.status).toBe(403);
    const invalidScope = await app.request("/spaces/s/apps/app/initialize", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" }, body: JSON.stringify({ appId: "app", scope: "SPACE_WIDE", gadgetTier: 3 }) }, env);
    expect(invalidScope.status).toBe(400);
    const allowed = await app.request("/spaces/s/apps/app/initialize", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" }, body: JSON.stringify({ appId: "app", scope: "SPACE_SHARED", gadgetTier: 3 }) }, env);
    expect(allowed.status).toBe(200);
  });

  it("requires active space membership for non-admin gadget access", async () => {
    const app = new Hono();
    registerGadgetMcpRoutes(app as never);
    const prepare = vi.fn((query: string) => ({ bind: (...args: unknown[]) => ({ first: async () => query.includes("space_members") ? (args[2] === "active-member" ? { 1: 1 } : null) : { 1: 1 } }) }));
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const env = { PLATFORM_DB: { prepare }, MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch }) } } as never;
    const denied = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-user-id": "suspended", "x-naelao-role": "member" } }, env);
    expect(denied.status).toBe(403);
    const allowed = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-user-id": "active-member", "x-naelao-role": "member" } }, env);
    expect(allowed.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("mounts an owner-approved project gadget in its project-bound actor after project ACL checks", async () => {
    const idFromName = vi.fn((name: string) => name as never);
    const fetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname }));
    const app = new Hono();
    registerGadgetMcpRoutes(app as never);
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ id: "project-a" }) }) },
      MICRO_APP_DO: { idFromName, get: () => ({ fetch }) },
    } as never;
    const initialized = await app.request("/spaces/s/projects/project-a/apps/course-notes/initialize", { method: "POST",
      headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin", "content-type": "application/json" },
      body: JSON.stringify({ appId: "course-notes", scope: "PROJECT_BOUND", gadgetTier: 2, defaultSchemaSql: "CREATE TABLE notes(id TEXT PRIMARY KEY)" }) }, env);
    expect(initialized.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("gadget:course-notes:project:project-a");
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ url: "http://micro-app/initialize" }));
    const appPage = await app.request("/spaces/s/projects/project-a/apps/course-notes/app", { headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(await appPage.json()).toEqual({ path: "/app" });
  });

  it("rejects project Gadget initialization from a non-admin and rejects space-level Gadget scopes", async () => {
    const app = new Hono(); registerGadgetMcpRoutes(app as never);
    const env = { PLATFORM_SECRET: "secret", PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) }, SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ id: "p" }) }) }, MICRO_APP_DO: { idFromName: vi.fn(), get: vi.fn() } } as never;
    const headers = { "x-naelao-tenant-id": "t", "x-naelao-role": "admin", "content-type": "application/json" };
    const badScope = await app.request("/spaces/s/projects/p/apps/a/initialize", { method: "POST", headers, body: JSON.stringify({ appId: "a", scope: "SPACE_SHARED", gadgetTier: 3 }) }, env);
    expect(badScope.status).toBe(400);
    const denied = await app.request("/spaces/s/projects/p/apps/a/initialize", { method: "POST", headers: { ...headers, "x-naelao-role": "member", "x-naelao-user-id": "u" }, body: JSON.stringify({ appId: "a", scope: "PROJECT_BOUND", gadgetTier: 2 }) }, env);
    expect(denied.status).toBe(403);
  });

  it("does not serve an extension-owned project Canvas after its installation is removed", async () => {
    const actorFetch = vi.fn(async () => Response.json({ html: true }));
    const spaceStub = { fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/project-extension-runtime") return Response.json({ managed: true, active: false, releaseValid: false });
      return Response.json({ id: "project-a" });
    } };
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => spaceStub },
      MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: actorFetch }) },
    } as never;
    const app = new Hono(); registerGadgetMcpRoutes(app as never);
    const response = await app.request("/spaces/s/projects/project-a/apps/mentor_canvas/app", { headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error_code: "project_extension_inactive" });
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the active extension release attestation is invalid", async () => {
    const actorFetch = vi.fn(async () => Response.json({ html: true }));
    const spaceStub = { fetch: async (request: Request) => new URL(request.url).pathname === "/project-extension-runtime"
      ? Response.json({ managed: true, active: true, releaseValid: false }) : Response.json({ id: "project-a" }) };
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => spaceStub }, MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: actorFetch }) } } as never;
    const app = new Hono(); registerGadgetMcpRoutes(app as never);
    const response = await app.request("/spaces/s/projects/project-a/apps/mentor_canvas/app", { headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "project_extension_release_invalid" });
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("fails closed at request time when the signed publisher key is no longer trusted", async () => {
    const actorFetch = vi.fn(async () => Response.json({ html: true }));
    const spaceStub = { fetch: async (request: Request) => new URL(request.url).pathname === "/project-extension-runtime"
      ? Response.json({ managed: true, active: true, releaseValid: true, publisherKeyId: "a".repeat(64) }) : Response.json({ id: "project-a" }) };
    const prepare = vi.fn((query: string) => ({ bind: () => ({ first: async () => query.includes("extension_publisher_keys") ? null : { 1: 1 } }) }));
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => spaceStub },
      MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: actorFetch }) } } as never;
    const app = new Hono(); registerGadgetMcpRoutes(app as never);
    const response = await app.request("/spaces/s/projects/project-a/apps/mentor_canvas/app", { headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "admin" } }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "project_extension_publisher_revoked" });
    expect(actorFetch).not.toHaveBeenCalled();
  });
});
