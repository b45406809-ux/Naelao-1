import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import spacesWorker from "../index.js";

describe("project subspace routes", () => {
  function environment(role: string) {
    const forwarded: Request[] = [];
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        forwarded.push(request);
        const url = new URL(request.url);
        if (url.pathname === "/hierarchy-authorize") {
          const action = url.searchParams.get("action") ?? "manage";
          return Response.json({ permitted: role !== "none" && (action !== "manage" || role === "admin" || role === "owner"), role });
        }
        if (url.pathname === "/projects") return Response.json({ created: true }, { status: 201 });
        return Response.json({ ok: true });
      }),
    };
    const env = {
      PLATFORM_SECRET: "project-subspace-test-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ spacetype_id: "launchpad", config_json: null, tenancy_mode: "team", depth: 0, parent_space_id: null }) }) }) },
      NAELAO_CONFIG_KV: { get: async () => ({ productConfig: {} }), put: vi.fn() },
      SPACE_DO: { idFromName: (name: string) => name, get: () => stub },
    } as never;
    return { env, forwarded, secret: "project-subspace-test-secret" };
  }

  it("binds child project creates to the authenticated user and selected subspace", async () => {
    const { env, forwarded, secret } = environment("member");
    const token = await mintInternalToken(secret, "tenant-a");
    const response = await spacesWorker.fetch(new Request(
      "https://spaces.test/spaces/root/sub-spaces/department-a/projects",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-internal-token": token,
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": "member-a",
          "x-naelao-role": "owner",
        },
        body: JSON.stringify({ name: "Forecast", space_id: "attacker-space", subspace_id: "other", created_by: "attacker" }),
      }
    ), env);
    expect(response.status).toBe(201);
    const forwardedCreate = forwarded.find((request) => new URL(request.url).pathname === "/projects");
    expect(forwardedCreate).toBeTruthy();
    expect(await forwardedCreate!.json()).toMatchObject({
      name: "Forecast",
      space_id: "root",
      subspace_id: "department-a",
      tenant_id: "tenant-a",
      created_by: "member-a",
      system_caller: false,
    });
  });

  it("denies a child viewer project creation before forwarding a write", async () => {
    const { env, forwarded, secret } = environment("viewer");
    const token = await mintInternalToken(secret, "tenant-a");
    const response = await spacesWorker.fetch(new Request(
      "https://spaces.test/spaces/root/sub-spaces/department-a/projects",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-internal-token": token,
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": "viewer-a",
          "x-naelao-role": "owner",
        },
        body: JSON.stringify({ name: "Forbidden" }),
      }
    ), env);
    expect(response.status).toBe(403);
    expect(forwarded.some((request) => new URL(request.url).pathname === "/projects" && request.method === "POST")).toBe(false);
  });

  it("requires root and department management before linking a project department", async () => {
    const { env, forwarded, secret } = environment("admin");
    const token = await mintInternalToken(secret, "tenant-a");
    const response = await spacesWorker.fetch(new Request(
      "https://spaces.test/spaces/root/projects/project-a/sub-spaces",
      { method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": token, "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "admin" }, body: JSON.stringify({ subspace_id: "department-b" }) }
    ), env);
    expect(response.status).toBe(200);
    const forwardedWrite = forwarded.find((request) => new URL(request.url).pathname === "/projects/project-a/sub-spaces");
    expect(await forwardedWrite!.json()).toEqual({ subspace_id: "department-b", actor_id: "owner-a" });
    expect(forwarded.filter((request) => new URL(request.url).pathname === "/hierarchy-authorize")).toHaveLength(2);
  });

  it("rejects linking when the caller cannot manage the target department", async () => {
    const { env, forwarded, secret } = environment("member");
    const token = await mintInternalToken(secret, "tenant-a");
    const response = await spacesWorker.fetch(new Request(
      "https://spaces.test/spaces/root/projects/project-a/sub-spaces",
      { method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": token, "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "member-a", "x-naelao-role": "member" }, body: JSON.stringify({ subspace_id: "department-b" }) }
    ), env);
    expect(response.status).toBe(403);
    expect(forwarded.some((request) => new URL(request.url).pathname === "/projects/project-a/sub-spaces" && request.method === "POST")).toBe(false);
  });

  it("rejects department creation when hierarchy authorization returns permitted false", async () => {
    const { env, forwarded, secret } = environment("member");
    const token = await mintInternalToken(secret, "tenant-a");
    const response = await spacesWorker.fetch(new Request(
      "https://spaces.test/spaces/root/sub-spaces",
      { method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": token, "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "member-a", "x-naelao-role": "member" }, body: JSON.stringify({ name: "Research" }) }
    ), env);
    expect(response.status).toBe(403);
    expect(forwarded.some((request) => new URL(request.url).pathname === "/sub-spaces" && request.method === "POST")).toBe(false);
  });

  it("lets an authorized end-user Space owner create a subspace beneath that Space", async () => {
    const forwarded: Request[] = [];
    const stub = { fetch: vi.fn(async (request: Request) => {
      forwarded.push(request);
      return new URL(request.url).pathname === "/hierarchy-authorize"
        ? Response.json({ permitted: true }) : Response.json({ id: "subspace", parent_id: "workspace" }, { status: 201 });
    }) };
    const secret = "product-subspace-secret";
    const db = { prepare: (sql: string) => ({ bind: () => ({ first: async () => {
      if (sql.includes("JOIN space_members")) return { role: "owner" };
      if (sql.includes("FROM products")) return { id: "product" };
      return { spacetype_id: "launchpad", config_json: null, tenancy_mode: "team", depth: 1, parent_space_id: "product" };
    } }) }) };
    const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db,
      NAELAO_CONFIG_KV: { get: async () => ({ productConfig: {} }), put: vi.fn() },
      SPACE_DO: { idFromName: (name: string) => name, get: () => stub } } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/workspace/sub-spaces", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(secret, "tenant"),
        "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user", "x-naelao-role": "product_end_user" },
      body: JSON.stringify({ name: "Research", space_type: "untrusted-type" }),
    }), env);
    expect(response.status).toBe(201);
    const create = forwarded.find(request => new URL(request.url).pathname === "/sub-spaces");
    const payload = await create!.json();
    expect(payload).toMatchObject({ parent_id: "workspace", name: "Research", force_parent_type: true });
    expect(payload).not.toHaveProperty("space_type");
  });

  it("denies a Product account without membership in the requested Space", async () => {
    const { env, forwarded, secret } = environment("none");
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/other/sub-spaces", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
        "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "other-user", "x-naelao-role": "product_end_user" },
      body: JSON.stringify({ name: "Forbidden" }),
    }), env);
    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("only lists subspaces the Space member may read", async () => {
    const secret = "product-subspace-secret";
    const stub = { fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/spaces") return Response.json({ data: [{ id: "workspace" }, { id: "visible" }, { id: "private" }] });
      return Response.json({ permitted: url.searchParams.get("target_space_id") !== "private" });
    }) };
    const env = { PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ role: "member" }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name, get: () => stub } } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/workspace/sub-spaces", {
      headers: { "x-naelao-internal-token": await mintInternalToken(secret, "tenant"),
        "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "member", "x-naelao-role": "product_end_user" },
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: "workspace" }, { id: "visible" }] });
  });

  it("includes only authorized subspace projects in an aggregate project list", async () => {
    const secret = "project-subspace-test-secret";
    const stub = { fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/spaces") return Response.json({ data: [
        { id: "visible", parent_id: "workspace", status: "active" },
        { id: "private", parent_id: "workspace", status: "active" },
      ] });
      if (url.pathname === "/hierarchy-authorize") return Response.json({ permitted: url.searchParams.get("target_space_id") === "visible" });
      if (url.pathname === "/projects") return Response.json({ data: [{ id: url.searchParams.has("subspace_id") ? "child-project" : "root-project" }] });
      return Response.json({ error: "unexpected" }, { status: 500 });
    }) };
    const env = { PLATFORM_SECRET: secret, SPACE_DO: { idFromName: (name: string) => name, get: () => stub } } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/workspace/projects?include_subspaces=1", {
      headers: { "x-naelao-internal-token": await mintInternalToken(secret, "tenant"),
        "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "member", "x-naelao-role": "owner" },
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: "root-project" }, { id: "child-project" }], count: 2 });
    expect(stub.fetch.mock.calls.some(([request]) => new URL(request.url).searchParams.get("subspace_id") === "private")).toBe(false);
  });
});
