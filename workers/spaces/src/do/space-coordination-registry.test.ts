import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "./SpaceDO.js";

describe("Space-owned advisory coordination registry", () => {
  function setup() {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, {} as never);
    const root = "http://space/space-coordination-registry";
    const publish = (entryId: string, label = entryId) => space.fetch(new Request(root, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", entry_id: entryId, actor_id: "owner", approved_role: "owner", confirmed: true,
        draft: { capability_key: "official.website", label, description: "Approved for all members" } }),
    }));
    const publishV2 = (entryId: string, audience: "space_members" | "space_admins", label = entryId) => space.fetch(new Request(root, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", entry_id: entryId, schema_version: 2, actor_id: "owner", approved_role: "owner", confirmed: true,
        draft: { schema_version: 2, capability_key: "official.website", label, description: "Approved for selected audience", audience } }),
    }));
    return { space, storage, root, publish, publishV2 };
  }

  it("persists only bounded Space facts and keyset pages active entries", async () => {
    const { space, root, publish } = setup();
    expect((await publish("entry-a")).status).toBe(201);
    expect((await publish("entry-b")).status).toBe(201); // duplicates are advisory and permitted
    expect((await publish("entry-c")).status).toBe(201);
    const page = await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&limit=2`));
    const pageBody = await page.json() as { entries: Array<Record<string, unknown>>; next_after: string | null };
    expect(pageBody).toMatchObject({ schema_version: 1, entries: [
      { entry_id: "entry-a", audience: "space_members", advisory_only: true, version: 1 },
      { entry_id: "entry-b", audience: "space_members", advisory_only: true, version: 1 },
    ] });
    expect(typeof pageBody.entries[0].last_confirmed_at).toBe("string");
    expect(pageBody.next_after).toMatch(/~entry-b$/);
    expect(pageBody.entries[0]).not.toHaveProperty("created_by");
    expect(pageBody.entries[0]).not.toHaveProperty("approved_by");
    expect(pageBody.entries[0]).not.toHaveProperty("last_confirmed_by");
    await space.fetch(new Request(`${root}/entry-b`, { method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", actor_id: "owner", expected_version: 1 }) }));
    const next = await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&limit=2&after=${encodeURIComponent(pageBody.next_after ?? "")}`));
    expect(await next.json()).toMatchObject({ entries: [{ entry_id: "entry-c" }], next_after: null });
    const bad = await space.fetch(new Request(root, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      tenant_id: "tenant", space_id: "space", entry_id: "private", actor_id: "owner", confirmed: true,
      draft: { capability_key: "site", label: "Site", project_id: "private-project" },
    }) }));
    expect(bad.status).toBe(400);
    expect(await space.fetch(new Request(`${root}?tenant_id=other&space_id=space`)).then(response => response.json())).toMatchObject({ entries: [] });
  });

  it("requires publication confirmation, supports idempotency, and fences stale revocations", async () => {
    const { space, root, publish } = setup();
    const unconfirmed = await space.fetch(new Request(root, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      tenant_id: "tenant", space_id: "space", entry_id: "entry", actor_id: "owner", approved_role: "owner", confirmed: false,
      draft: { capability_key: "official.website", label: "Company website" },
    }) }));
    expect(unconfirmed.status).toBe(400);
    const created = await publish("entry", "Company website");
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { entry: Record<string, unknown> };
    expect(typeof createdBody.entry.last_confirmed_at).toBe("string");
    expect(createdBody.entry).not.toHaveProperty("last_confirmed_by");
    expect(createdBody.entry).not.toHaveProperty("created_by");
    expect(createdBody.entry).not.toHaveProperty("approved_by");
    expect((await publish("entry", "Company website")).status).toBe(200);
    const revoke = (version: number) => space.fetch(new Request(`${root}/entry`, { method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", actor_id: "owner", expected_version: version }) }));
    expect((await revoke(1)).status).toBe(200);
    expect(await (await revoke(1)).json()).toMatchObject({ error_code: "coordination_entry_version_conflict" });
    expect(await (await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space`))).json()).toMatchObject({ entries: [] });
    const row = storageRow(space);
    expect(row).toMatchObject({ status: "revoked", version: 2, revoked_by: "owner", approved_by: "owner", approved_role: "owner" });
  });

  it("preserves legacy member facts and filters administrator facts before role-bound pagination", async () => {
    const { space, storage, root, publish, publishV2 } = setup();
    expect((await publishV2("admin-before", "space_admins")).status).toBe(201);
    expect((await publish("legacy-member")).status).toBe(201);
    expect((await publishV2("member-v2-a", "space_members")).status).toBe(201);
    expect((await publishV2("admin-middle", "space_admins")).status).toBe(201);
    expect((await publishV2("member-v2-b", "space_members")).status).toBe(201);
    storage.sql.exec("UPDATE space_coordination_entries SET created_at=CASE entry_id WHEN 'admin-before' THEN '2026-11-13T00:00:01.000Z' WHEN 'legacy-member' THEN '2026-11-13T00:00:02.000Z' WHEN 'member-v2-a' THEN '2026-11-13T00:00:03.000Z' WHEN 'admin-middle' THEN '2026-11-13T00:00:04.000Z' ELSE '2026-11-13T00:00:05.000Z' END");

    const memberRead = (after?: string) => {
      const params = new URLSearchParams({ tenant_id: "tenant", space_id: "space", schema_version: "2", viewer_role: "member", limit: "1", ...(after ? { after } : {}) });
      return space.fetch(new Request(`${root}?${params}`));
    };
    const first = await memberRead();
    const page1 = await first.json() as { entries: Array<Record<string, unknown>>; next_after: string | null };
    expect(page1.entries.map(entry => entry.entry_id)).toEqual(["legacy-member"]);
    expect(page1.entries[0]).toMatchObject({ schema_version: 1, audience: "space_members" });
    expect(page1.next_after).toMatch(/^v2~members~/);

    const second = await memberRead(page1.next_after ?? undefined);
    const page2 = await second.json() as { entries: Array<Record<string, unknown>>; next_after: string | null };
    expect(page2.entries.map(entry => entry.entry_id)).toEqual(["member-v2-a"]);
    expect(page2.next_after).toMatch(/^v2~members~/);
    const third = await memberRead(page2.next_after ?? undefined);
    expect(await third.json()).toMatchObject({ entries: [{ entry_id: "member-v2-b", schema_version: 2 }], next_after: null });

    const reusedOwnerCursor = await memberRead("v2~administrators~2026-11-13T00%3A00%3A01.000Z~admin-before");
    expect(reusedOwnerCursor.status).toBe(400);
    const ownerParams = new URLSearchParams({ tenant_id: "tenant", space_id: "space", schema_version: "2", viewer_role: "owner", limit: "10" });
    const ownerPage = await space.fetch(new Request(`${root}?${ownerParams}`)).then(response => response.json()) as { entries: Array<Record<string, unknown>> };
    expect(ownerPage.entries.map(entry => entry.entry_id)).toEqual(["admin-before", "legacy-member", "member-v2-a", "admin-middle", "member-v2-b"]);

    const legacyPage = await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&schema_version=1&viewer_role=member&limit=10`)).then(response => response.json()) as { entries: Array<Record<string, unknown>> };
    expect(legacyPage.entries.map(entry => entry.entry_id)).toEqual(["legacy-member"]);
  });

  it("keeps v2 entries out of the legacy revoke contract", async () => {
    const { space, root, publishV2 } = setup();
    expect((await publishV2("admin-only", "space_admins")).status).toBe(201);
    const legacyRevoke = await space.fetch(new Request(`${root}/admin-only`, { method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", actor_id: "owner", expected_version: 1 }) }));
    expect(legacyRevoke.status).toBe(404);
    expect((await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&schema_version=2&viewer_role=owner`)).then(response => response.json())).entries)
      .toMatchObject([{ entry_id: "admin-only", status: "active" }]);
  });

  it("amends a fact with explicit audience confirmation and expected-version fencing", async () => {
    const { space, storage, root, publish } = setup();
    expect((await publish("entry", "Old company site")).status).toBe(201);
    const amend = (expectedVersion: number, confirmed: boolean, audience: "space_members" | "space_admins" = "space_admins") =>
      space.fetch(new Request(`${root}/entry`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
        tenant_id: "tenant", space_id: "space", actor_id: "admin", approved_role: "admin", schema_version: 2,
        expected_version: expectedVersion, confirmed,
        draft: { schema_version: 2, capability_key: "official.website", label: "Current company site", audience },
      }) }));

    const unconfirmed = await amend(1, false);
    expect(unconfirmed.status).toBe(400);
    const updated = await amend(1, true);
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json() as { entry: Record<string, unknown> };
    expect(updatedBody).toMatchObject({ entry: {
      entry_id: "entry", schema_version: 2, label: "Current company site", audience: "space_admins", version: 2, advisory_only: true,
    } });
    const amendmentReceipt = storage.sql.exec<{ created_by: string; approved_by: string; approved_role: string; provenance: string; last_confirmed_at: string; last_confirmed_by: string }>(
      "SELECT created_by,approved_by,approved_role,provenance,last_confirmed_at,last_confirmed_by FROM space_coordination_entries WHERE entry_id='entry'").toArray()[0];
    expect(amendmentReceipt).toMatchObject({
      created_by: "owner", approved_by: "admin", approved_role: "admin", provenance: "explicit_owner_or_admin_approval", last_confirmed_by: "admin",
    });
    expect(Number.isFinite(Date.parse(amendmentReceipt.last_confirmed_at))).toBe(true);
    expect(typeof updatedBody.entry.last_confirmed_at).toBe("string");
    expect(updatedBody.entry).not.toHaveProperty("last_confirmed_by");
    expect((await amend(1, true)).status).toBe(409);
    expect((await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&schema_version=2&viewer_role=member`)).then(response => response.json()))
      .entries).toEqual([]);
    expect((await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&schema_version=2&viewer_role=owner`)).then(response => response.json()))
      .entries).toMatchObject([{ entry_id: "entry", version: 2, label: "Current company site" }]);
  });
});

function storageRow(space: SpaceDO) {
  const internals = space as unknown as { ctx: { storage: { sql: { exec<T>(query: string, ...args: unknown[]): { toArray(): T[] } } } } };
  return internals.ctx.storage.sql.exec<{ status: string; version: number; revoked_by: string; approved_by: string; approved_role: string }>(
    "SELECT status,version,revoked_by,approved_by,approved_role FROM space_coordination_entries WHERE entry_id='entry'").toArray()[0];
}
