import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { registerSpaceCoordinationRoutes } from "./space-coordination.js";
import type { Env } from "../index.js";

describe("Space coordination registry gateway", () => {
  const app = new Hono<{ Bindings: Env }>();
  registerSpaceCoordinationRoutes(app);

  function env(spaceRole: string | null = "owner") {
    const calls: Request[] = [];
    const bindings = {
      PLATFORM_SECRET: "coordination-secret",
      PLATFORM_DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.includes("JOIN space_members") ? (spaceRole ? { role: spaceRole } : null) : { id: "space" } }) }) },
      SPACE_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
        calls.push(request);
        if (request.method === "GET") return Response.json({ schema_version: 1, entries: [], next_after: null });
        return Response.json({ entry: { entry_id: "entry-1", version: 1 } }, { status: 201 });
      } }) },
    } as unknown as Env;
    return { bindings, calls };
  }

  async function request(path: string, role = "product_end_user", method = "GET", body?: unknown, signed = true) {
    const headers = new Headers({ "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user", "x-naelao-role": role });
    if (signed) headers.set("x-naelao-internal-token", await mintInternalToken("coordination-secret", "tenant"));
    if (body !== undefined) headers.set("content-type", "application/json");
    return new Request(`http://spaces${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }

  it("requires a signed tenant route and an active Space membership", async () => {
    const missingMember = env(null);
    expect((await app.fetch(await request("/spaces/space/coordination-registry"), missingMember.bindings)).status).toBe(403);
    expect(missingMember.calls).toHaveLength(0);
    const unsigned = env();
    expect((await app.fetch(await request("/spaces/space/coordination-registry", "product_end_user", "GET", undefined, false), unsigned.bindings)).status).toBe(403);
    expect(unsigned.calls).toHaveLength(0);
  });

  it("allows member reads and previews while owner/admin role gates publication", async () => {
    const member = env("member");
    const read = await app.fetch(await request("/spaces/space/coordination-registry"), member.bindings);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect((await app.fetch(await request("/spaces/space/coordination-registry", "product_end_user", "POST", { capability_key: "website", label: "Official site" }), member.bindings)).status).toBe(403);
    const preview = await app.fetch(await request("/spaces/space/coordination-registry/preview", "product_end_user", "POST", { capability_key: "official.website", label: "Company website" }), member.bindings);
    expect(await preview.json()).toMatchObject({ schema_version: 1, disclosure: { audience: "all active members of this Space" }, no_project_source: true });
    expect(member.calls).toHaveLength(1); // preview performs no DO mutation
  });

  it("requires explicit disclosure confirmation and sends a host-stamped approved record", async () => {
    const owner = env("owner");
    const missingConfirmation = await app.fetch(await request("/spaces/space/coordination-registry", "product_end_user", "POST", {
      capability_key: "official.website", label: "Company website", confirm_disclosure: false,
    }), owner.bindings);
    expect(missingConfirmation.status).toBe(400);
    const privateSource = await app.fetch(await request("/spaces/space/coordination-registry", "product_end_user", "POST", {
      capability_key: "official.website", label: "Company website", confirm_disclosure: true, project_id: "private-project",
    }), owner.bindings);
    expect(privateSource.status).toBe(400);
    const created = await app.fetch(await request("/spaces/space/coordination-registry", "product_end_user", "POST", {
      capability_key: "official.website", label: "Company website", confirm_disclosure: true,
    }), owner.bindings);
    expect(created.status).toBe(201);
    const body = await owner.calls[0]?.json() as Record<string, unknown>;
    expect(body).toMatchObject({ tenant_id: "tenant", space_id: "space", actor_id: "user", approved_role: "owner", confirmed: true,
      draft: { capability_key: "official.website", label: "Company website" } });
    expect(body).not.toHaveProperty("project_id");
    expect(typeof body.entry_id).toBe("string");
  });
});
