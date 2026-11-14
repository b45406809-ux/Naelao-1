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
        if (new URL(request.url).pathname === "/space-coordination-policy") return Response.json({ schema_version: 2, configured: false, member_facts_enabled: false, revision: 0, active_member_facts: 0 });
        if (request.method === "GET") return Response.json({ schema_version: 1, entries: [], next_after: null });
        return Response.json({ entry: { entry_id: "entry-1", version: request.method === "PATCH" ? 2 : 1 }, ...(request.method === "PATCH" ? { disclosure: { audience: "Space owners and administrators", effect: "advisory only" } } : {}) }, { status: request.method === "DELETE" || request.method === "PATCH" || request.method === "PUT" ? 200 : 201 });
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

  it("restricts policy reads and writes to Space owners and admins and host-stamps the actor", async () => {
    const member = env("member");
    expect((await app.fetch(await request("/spaces/space/coordination-registry/v2/policy"), member.bindings)).status).toBe(403);
    expect((await app.fetch(await request("/spaces/space/coordination-registry/v2/policy", "product_end_user", "PUT", {
      member_facts_enabled: true, expected_revision: 0, confirm: true,
    }), member.bindings)).status).toBe(403);
    expect((await app.fetch(await request("/spaces/space/coordination-registry/v2/policy/history", "product_end_user"), member.bindings)).status).toBe(403);
    expect(member.calls).toHaveLength(0);

    const owner = env("owner");
    const loaded = await app.fetch(await request("/spaces/space/coordination-registry/v2/policy"), owner.bindings);
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get("cache-control")).toBe("no-store");
    await expect(loaded.json()).resolves.toMatchObject({ schema_version: 2, member_facts_enabled: false, revision: 0 });

    const missingConfirmation = await app.fetch(await request("/spaces/space/coordination-registry/v2/policy", "product_end_user", "PUT", {
      member_facts_enabled: true, expected_revision: 0, confirm: false,
    }), owner.bindings);
    expect(missingConfirmation.status).toBe(400);
    const changed = await app.fetch(await request("/spaces/space/coordination-registry/v2/policy", "product_end_user", "PUT", {
      member_facts_enabled: true, expected_revision: 0, confirm: true,
    }), owner.bindings);
    expect(changed.status).toBe(200);
    expect(owner.calls).toHaveLength(2);
    const forwarded = await owner.calls[1]!.json() as Record<string, unknown>;
    expect(forwarded).toEqual({ member_facts_enabled: true, expected_revision: 0, actor_id: "user", actor_role: "owner", confirmed: true });
    expect(new URL(owner.calls[1]!.url).searchParams.get("tenant_id")).toBe("tenant");

    const history = await app.fetch(await request("/spaces/space/coordination-registry/v2/policy/history?after=2"), owner.bindings);
    expect(history.status).toBe(200);
    expect(history.headers.get("cache-control")).toBe("no-store");
    expect(new URL(owner.calls[2]!.url).pathname).toBe("/space-coordination-policy/history");
    expect(new URL(owner.calls[2]!.url).searchParams.get("after")).toBe("2");
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

  it("restricts metadata-only lifecycle history to owners and administrators", async () => {
    const member = env("member");
    const denied = await app.fetch(await request("/spaces/space/coordination-registry/v2/entry-a/history", "product_end_user"), member.bindings);
    expect(denied.status).toBe(403);
    expect(member.calls).toHaveLength(0);

    const owner = env("owner");
    const allowed = await app.fetch(await request("/spaces/space/coordination-registry/v2/entry-a/history?after=cursor", "product_end_user"), owner.bindings);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(owner.calls).toHaveLength(1);
    expect(owner.calls[0]!.url).toContain("/space-coordination-registry/entry-a/history?");
    expect(new URL(owner.calls[0]!.url).searchParams.get("after")).toBe("cursor");
  });

  it("passes the authenticated role to v2 reads and requires an explicit selected audience on writes", async () => {
    const member = env("member");
    const read = await app.fetch(await request("/spaces/space/coordination-registry/v2?after=v2%7Emembers%7Etime%7Eentry", "product_end_user"), member.bindings);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    const readUrl = new URL(member.calls[0]!.url);
    expect(readUrl.searchParams.get("schema_version")).toBe("2");
    expect(readUrl.searchParams.get("viewer_role")).toBe("member");
    expect(readUrl.searchParams.get("after")).toBe("v2~members~time~entry");
    const owner = env("owner");
    expect((await app.fetch(await request("/spaces/space/coordination-registry/v2", "product_end_user"), owner.bindings)).status).toBe(200);
    expect(new URL(owner.calls[0]!.url).searchParams.get("viewer_role")).toBe("owner");

    const preview = await app.fetch(await request("/spaces/space/coordination-registry/v2/preview", "product_end_user", "POST", {
      schema_version: 2, capability_key: "official.website", label: "Company site", audience: "space_admins",
    }), member.bindings);
    expect(await preview.json()).toMatchObject({ schema_version: 2, disclosure: { audience: "Space owners and administrators" }, no_project_source: true });
    expect(member.calls).toHaveLength(1); // previews do not write to the Durable Object
    const expiredPreview = await app.fetch(await request("/spaces/space/coordination-registry/v2/preview", "product_end_user", "POST", {
      schema_version: 2, capability_key: "official.website", label: "Company site", audience: "space_admins", expires_at: new Date(Date.now() - 1_000).toISOString(),
    }), member.bindings);
    expect(expiredPreview.status).toBe(400);
    expect(await expiredPreview.json()).toMatchObject({ error_code: "coordination_expiry_must_be_future" });
    expect(member.calls).toHaveLength(1);

    const expiresAt = "2026-12-01T23:59:59.999Z";
    const draft = { schema_version: 2, capability_key: "official.website", label: "Company site", audience: "space_admins", expires_at: expiresAt };
    const unconfirmed = await app.fetch(await request("/spaces/space/coordination-registry/v2", "product_end_user", "POST", { ...draft, confirm_disclosure: false }), owner.bindings);
    expect(await unconfirmed.json()).toMatchObject({ error_code: "coordination_disclosure_confirmation_required", disclosure: { audience: "Space owners and administrators" } });
    const published = await app.fetch(await request("/spaces/space/coordination-registry/v2", "product_end_user", "POST", { ...draft, confirm_disclosure: true }), owner.bindings);
    expect(published.status).toBe(201);
    const publishedBody = await owner.calls[1]!.json() as Record<string, unknown>;
    expect(publishedBody).toMatchObject({ schema_version: 2, approved_role: "owner", confirmed: true, draft });

    const revoked = await app.fetch(await request("/spaces/space/coordination-registry/v2/entry-a", "product_end_user", "DELETE", { schema_version: 2, expected_version: 1 }), owner.bindings);
    expect(revoked.status).toBe(200);
    expect(await owner.calls[2]!.json()).toMatchObject({ schema_version: 2, expected_version: 1, actor_id: "user", approved_role: "owner" });

    const needsConfirmation = await app.fetch(await request("/spaces/space/coordination-registry/v2/entry-a", "product_end_user", "PATCH", {
      ...draft, expected_version: 1, confirm_disclosure: false,
    }), owner.bindings);
    expect(await needsConfirmation.json()).toMatchObject({ error_code: "coordination_disclosure_confirmation_required", disclosure: { audience: "Space owners and administrators" } });
    const amended = await app.fetch(await request("/spaces/space/coordination-registry/v2/entry-a", "product_end_user", "PATCH", {
      ...draft, expected_version: 1, label: "Updated company site", confirm_disclosure: true,
    }), owner.bindings);
    expect(amended.status).toBe(200);
    await expect(amended.json()).resolves.toMatchObject({ entry: { version: 2 }, disclosure: { audience: "Space owners and administrators" } });
    expect(await owner.calls[3]!.json()).toMatchObject({ schema_version: 2, expected_version: 1, confirmed: true, approved_role: "owner",
      draft: { label: "Updated company site", audience: "space_admins" } });
  });
});
