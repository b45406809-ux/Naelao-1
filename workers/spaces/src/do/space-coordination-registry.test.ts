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
    return { space, root, publish };
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
    expect(pageBody.next_after).toMatch(/~entry-b$/);
    expect(pageBody.entries[0]).not.toHaveProperty("created_by");
    expect(pageBody.entries[0]).not.toHaveProperty("approved_by");
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
    expect(await created.json()).not.toMatchObject({ entry: { created_by: "owner", approved_by: "owner" } });
    expect((await publish("entry", "Company website")).status).toBe(200);
    const revoke = (version: number) => space.fetch(new Request(`${root}/entry`, { method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", actor_id: "owner", expected_version: version }) }));
    expect((await revoke(1)).status).toBe(200);
    expect(await (await revoke(1)).json()).toMatchObject({ error_code: "coordination_entry_version_conflict" });
    expect(await (await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space`))).json()).toMatchObject({ entries: [] });
    const row = storageRow(space);
    expect(row).toMatchObject({ status: "revoked", version: 2, revoked_by: "owner", approved_by: "owner", approved_role: "owner" });
  });
});

function storageRow(space: SpaceDO) {
  const internals = space as unknown as { ctx: { storage: { sql: { exec<T>(query: string, ...args: unknown[]): { toArray(): T[] } } } } };
  return internals.ctx.storage.sql.exec<{ status: string; version: number; revoked_by: string; approved_by: string; approved_role: string }>(
    "SELECT status,version,revoked_by,approved_by,approved_role FROM space_coordination_entries WHERE entry_id='entry'").toArray()[0];
}
