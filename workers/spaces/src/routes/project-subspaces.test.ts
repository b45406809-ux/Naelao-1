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
          const action = url.searchParams.get("action");
          return Response.json({ permitted: role !== "none" && (action !== "manage" || role === "admin" || role === "owner"), role });
        }
        if (url.pathname === "/projects") return Response.json({ created: true }, { status: 201 });
        return Response.json({ ok: true });
      }),
    };
    const env = {
      PLATFORM_SECRET: "project-subspace-test-secret",
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
});
