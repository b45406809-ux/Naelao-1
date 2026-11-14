import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "./SpaceDO.js";

describe("Space-owned advisory coordination registry", () => {
  async function setup(enableMemberFacts = true) {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, {} as never);
    const root = "http://space/space-coordination-registry";
    const policyUrl = "http://space/space-coordination-policy?tenant_id=tenant&space_id=space";
    const readPolicy = () => space.fetch(new Request(policyUrl));
    const updatePolicy = (memberFactsEnabled: boolean, expectedRevision: number) => space.fetch(new Request(policyUrl, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ member_facts_enabled: memberFactsEnabled, expected_revision: expectedRevision,
        actor_id: "owner", actor_role: "owner", confirmed: true }),
    }));
    await readPolicy(); // ensure current migrations are applied in the test storage
    if (enableMemberFacts) expect((await updatePolicy(true, 0)).status).toBe(200);
    const publish = (entryId: string, label = entryId) => space.fetch(new Request(root, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", entry_id: entryId, actor_id: "owner", approved_role: "owner", confirmed: true,
        draft: { capability_key: "official.website", label, description: "Approved for all members" } }),
    }));
    const publishV2 = (entryId: string, audience: "space_members" | "space_admins", label = entryId, expiresAt: string | null = null) => space.fetch(new Request(root, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", entry_id: entryId, schema_version: 2, actor_id: "owner", approved_role: "owner", confirmed: true,
        draft: { schema_version: 2, capability_key: "official.website", label, description: "Approved for selected audience", audience, expires_at: expiresAt } }),
    }));
    return { space, storage, root, publish, publishV2, readPolicy, updatePolicy };
  }

  it("persists only bounded Space facts and keyset pages active entries", async () => {
    const { space, root, publish } = await setup();
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
    const { space, root, publish } = await setup();
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
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", actor_id: "owner", approved_role: "owner", expected_version: version }) }));
    expect((await revoke(1)).status).toBe(200);
    expect(await (await revoke(1)).json()).toMatchObject({ error_code: "coordination_entry_version_conflict" });
    expect(await (await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space`))).json()).toMatchObject({ entries: [] });
    const row = storageRow(space);
    expect(row).toMatchObject({ status: "revoked", version: 2, revoked_by: "owner", approved_by: "owner", approved_role: "owner" });
  });

  it("preserves legacy member facts and filters administrator facts before role-bound pagination", async () => {
    const { space, storage, root, publish, publishV2 } = await setup();
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
    expect(page1.entries[0]).not.toHaveProperty("created_by");
    expect(page1.entries[0]).not.toHaveProperty("approved_by");
    expect(page1.next_after).toMatch(/^v2~members~/);

    const second = await memberRead(page1.next_after ?? undefined);
    const page2 = await second.json() as { entries: Array<Record<string, unknown>>; next_after: string | null };
    expect(page2.entries.map(entry => entry.entry_id)).toEqual(["member-v2-a"]);
    expect(page2.entries[0]).not.toHaveProperty("created_by");
    expect(page2.entries[0]).not.toHaveProperty("approved_by");
    expect(page2.next_after).toMatch(/^v2~members~/);
    const third = await memberRead(page2.next_after ?? undefined);
    expect(await third.json()).toMatchObject({ entries: [{ entry_id: "member-v2-b", schema_version: 2 }], next_after: null });

    const reusedOwnerCursor = await memberRead("v2~administrators~2026-11-13T00%3A00%3A01.000Z~admin-before");
    expect(reusedOwnerCursor.status).toBe(400);
    const ownerParams = new URLSearchParams({ tenant_id: "tenant", space_id: "space", schema_version: "2", viewer_role: "owner", limit: "10" });
    const ownerPage = await space.fetch(new Request(`${root}?${ownerParams}`)).then(response => response.json()) as { entries: Array<Record<string, unknown>> };
    expect(ownerPage.entries.map(entry => entry.entry_id)).toEqual(["admin-before", "legacy-member", "member-v2-a", "admin-middle", "member-v2-b"]);
    expect(ownerPage.entries[0]).toMatchObject({ created_by: "owner", approved_by: "owner", approved_role: "owner", provenance: "explicit_owner_or_admin_approval" });

    const legacyPage = await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&schema_version=1&viewer_role=member&limit=10`)).then(response => response.json()) as { entries: Array<Record<string, unknown>> };
    expect(legacyPage.entries.map(entry => entry.entry_id)).toEqual(["legacy-member"]);
  });

  it("keeps v2 entries out of the legacy revoke contract", async () => {
    const { space, root, publishV2 } = await setup();
    expect((await publishV2("admin-only", "space_admins")).status).toBe(201);
    const legacyRevoke = await space.fetch(new Request(`${root}/admin-only`, { method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", actor_id: "owner", approved_role: "owner", expected_version: 1 }) }));
    expect(legacyRevoke.status).toBe(404);
    const revokeV2 = await space.fetch(new Request(`${root}/admin-only`, { method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", actor_id: "owner", approved_role: "owner", schema_version: 2, expected_version: 1 }) }));
    expect(await revokeV2.json()).toMatchObject({ entry: { status: "revoked", revoked_by: "owner", created_by: "owner", provenance: "explicit_owner_or_admin_approval" } });
    expect((await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&schema_version=2&viewer_role=owner`)).then(response => response.json())).entries)
      .toMatchObject([{ entry_id: "admin-only", status: "revoked", revoked_by: "owner", created_by: "owner", approved_by: "owner", approved_role: "owner", provenance: "explicit_owner_or_admin_approval" }]);
    expect((await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&schema_version=2&viewer_role=member`)).then(response => response.json())).entries).toEqual([]);
  });

  it("expires facts for their selected audience and lets administrators review and renew them", async () => {
    const { space, storage, root, publishV2 } = await setup();
    const initialExpiry = new Date(Date.now() + 60_000).toISOString();
    expect((await publishV2("expiring", "space_members", "Published service", initialExpiry)).status).toBe(201);
    const memberRead = () => space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&schema_version=2&viewer_role=member`));
    const ownerRead = () => space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&schema_version=2&viewer_role=owner`));
    expect(await (await memberRead()).json()).toMatchObject({ entries: [{ entry_id: "expiring", status: "active", expires_at: initialExpiry }] });

    storage.sql.exec("UPDATE space_coordination_entries SET expires_at=? WHERE entry_id='expiring'", new Date(Date.now() - 1_000).toISOString());
    expect(await (await memberRead()).json()).toMatchObject({ entries: [] });
    expect(await (await ownerRead()).json()).toMatchObject({ entries: [{ entry_id: "expiring", status: "expired" }] });

    const renewedExpiry = new Date(Date.now() + 86_400_000).toISOString();
    const renewed = await space.fetch(new Request(`${root}/expiring`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
      tenant_id: "tenant", space_id: "space", actor_id: "owner", approved_role: "owner", schema_version: 2, expected_version: 1, confirmed: true,
      draft: { schema_version: 2, capability_key: "official.website", label: "Published service", audience: "space_members", expires_at: renewedExpiry },
    }) }));
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({ entry: { status: "active", version: 2, expires_at: renewedExpiry } });
    expect(await (await memberRead()).json()).toMatchObject({ entries: [{ entry_id: "expiring", status: "active" }] });
  });

  it("records metadata-only publish, amend and revoke history atomically with stable paging", async () => {
    const { space, storage, root, publishV2 } = await setup();
    const firstExpiry = new Date(Date.now() + 86_400_000).toISOString();
    expect((await publishV2("audit-entry", "space_members", "Private label is not copied", firstExpiry)).status).toBe(201);
    expect((await publishV2("audit-entry", "space_members", "Private label is not copied", firstExpiry)).status).toBe(200);

    const amendedExpiry = new Date(Date.now() + 172_800_000).toISOString();
    const amended = await space.fetch(new Request(`${root}/audit-entry`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
      tenant_id: "tenant", space_id: "space", actor_id: "admin", approved_role: "admin", schema_version: 2, expected_version: 1, confirmed: true,
      draft: { schema_version: 2, capability_key: "official.website", label: "Updated private label", audience: "space_admins", expires_at: amendedExpiry },
    }) }));
    expect(amended.status).toBe(200);
    const revoked = await space.fetch(new Request(`${root}/audit-entry`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({
      tenant_id: "tenant", space_id: "space", actor_id: "owner", approved_role: "owner", schema_version: 2, expected_version: 2,
    }) }));
    expect(revoked.status).toBe(200);

    const history = (after?: string) => space.fetch(new Request(`${root}/audit-entry/history?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", limit: "1", ...(after ? { after } : {}) })}`));
    const first = await (await history()).json() as { events: Array<Record<string, unknown>>; next_after: string | null };
    expect(first.events).toMatchObject([{ action: "published", prior_version: null, version: 1, actor_id: "owner", actor_role: "owner",
      audience_before: null, audience_after: "space_members", expires_at_before: null, expires_at_after: firstExpiry, status_after: "active" }]);
    expect(first.events[0]).not.toHaveProperty("label");
    expect(first.events[0]).not.toHaveProperty("description");
    expect(first.next_after).toBeTruthy();

    const second = await (await history(first.next_after ?? undefined)).json() as { events: Array<Record<string, unknown>>; next_after: string | null };
    expect(second.events).toMatchObject([{ action: "amended", prior_version: 1, version: 2, actor_id: "admin", actor_role: "admin",
      audience_before: "space_members", audience_after: "space_admins", expires_at_before: firstExpiry, expires_at_after: amendedExpiry }]);
    expect(second.next_after).toBeTruthy();
    const third = await (await history(second.next_after ?? undefined)).json() as { events: Array<Record<string, unknown>>; next_after: string | null };
    expect(third.events).toMatchObject([{ action: "revoked", prior_version: 2, version: 3, actor_id: "owner", actor_role: "owner",
      audience_before: "space_admins", audience_after: "space_admins", expires_at_before: amendedExpiry, expires_at_after: amendedExpiry, status_after: "revoked" }]);
    expect(third.next_after).toBeNull();
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM space_coordination_audit_events WHERE entry_id='audit-entry'").toArray()).toEqual([{ count: 3 }]);
  });

  it("rolls back a coordination fact mutation when its audit event cannot be recorded", async () => {
    const { space, storage, root, publishV2 } = await setup();
    await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space`)); // apply migrations before installing the failure trigger
    storage.sql.exec(`CREATE TRIGGER reject_coordination_audit BEFORE INSERT ON space_coordination_audit_events
      WHEN NEW.entry_id='atomic-entry' BEGIN SELECT RAISE(ABORT,'audit storage unavailable'); END`);
    expect((await publishV2("atomic-entry", "space_members", "Do not publish without its audit record")).status).toBe(503);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM space_coordination_entries WHERE entry_id='atomic-entry'").toArray()).toEqual([{ count: 0 }]);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM space_coordination_audit_events WHERE entry_id='atomic-entry'").toArray()).toEqual([{ count: 0 }]);

    storage.sql.exec("DROP TRIGGER reject_coordination_audit");
    expect((await publishV2("atomic-entry", "space_members", "Published fact")).status).toBe(201);
    storage.sql.exec(`CREATE TRIGGER reject_coordination_amend BEFORE INSERT ON space_coordination_audit_events
      WHEN NEW.entry_id='atomic-entry' AND NEW.action='amended' BEGIN SELECT RAISE(ABORT,'audit storage unavailable'); END`);
    const failedAmendment = await space.fetch(new Request(`${root}/atomic-entry`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
      tenant_id: "tenant", space_id: "space", actor_id: "admin", approved_role: "admin", schema_version: 2, expected_version: 1, confirmed: true,
      draft: { schema_version: 2, capability_key: "official.website", label: "Changed label", audience: "space_admins", expires_at: null },
    }) }));
    expect(failedAmendment.status).toBe(503);
    expect(storage.sql.exec("SELECT version,label,audience FROM space_coordination_entries WHERE entry_id='atomic-entry'").toArray())
      .toEqual([{ version: 1, label: "Published fact", audience: "space_members" }]);
    expect(storage.sql.exec("SELECT COUNT(*) AS count FROM space_coordination_audit_events WHERE entry_id='atomic-entry'").toArray()).toEqual([{ count: 1 }]);
  });

  it("amends a fact with explicit audience confirmation and expected-version fencing", async () => {
    const { space, storage, root, publish } = await setup();
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
    const ownerEntry = (await space.fetch(new Request(`${root}?tenant_id=tenant&space_id=space&schema_version=2&viewer_role=owner`)).then(response => response.json())).entries[0];
    expect(ownerEntry).toMatchObject({ created_by: "owner", approved_by: "admin", approved_role: "admin", provenance: "explicit_owner_or_admin_approval" });
    expect(ownerEntry).toHaveProperty("revoked_by", null);
  });

  it("defaults member visibility off while preserving admin-only facts and legacy member rows", async () => {
    const { space, storage, publish, publishV2, readPolicy } = await setup(false);
    await expect((await readPolicy()).json()).resolves.toMatchObject({
      schema_version: 2, configured: false, member_facts_enabled: false, revision: 0, active_member_facts: 0,
    });
    expect((await publishV2("blocked-member", "space_members")).status).toBe(409);
    expect(await (await space.fetch(new Request("http://space/space-coordination-registry?tenant_id=tenant&space_id=space&schema_version=2&viewer_role=owner"))).json())
      .toMatchObject({ entries: [] });
    expect((await publishV2("admin-fact", "space_admins")).status).toBe(201);
    expect((await publish("legacy-contract-member")).status).toBe(409);

    // A row created before migration 130 remains readable; disabling a new-sharing policy never silently revokes it.
    storage.sql.exec(`INSERT INTO space_coordination_entries
      (tenant_id,space_id,entry_id,schema_version,capability_key,label,description,audience,status,advisory_only,version,provenance,created_by,approved_by,approved_role,created_at,updated_at,last_confirmed_at,last_confirmed_by,expires_at)
      VALUES ('tenant','space','legacy-member',1,'official.website','Legacy approved fact',NULL,'space_members','active',1,1,'explicit_owner_or_admin_approval','owner','owner','owner','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','owner',NULL)`);
    const memberPage = await space.fetch(new Request("http://space/space-coordination-registry?tenant_id=tenant&space_id=space&schema_version=2&viewer_role=member"));
    expect(await memberPage.json()).toMatchObject({ entries: [{ entry_id: "legacy-member" }] });
    expect(storage.sql.exec("SELECT member_facts_enabled FROM space_coordination_policies").toArray()).toEqual([]);
  });

  it("requires active member facts to be unpublished before disabling and fences stale policy revisions", async () => {
    const { space, root, publishV2, readPolicy, updatePolicy } = await setup();
    expect((await publishV2("member-fact", "space_members")).status).toBe(201);
    const blocked = await updatePolicy(false, 1);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error_code: "coordination_member_facts_must_be_unpublished_first" });
    const unpublish = await space.fetch(new Request(`${root}/member-fact`, { method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", actor_id: "owner", approved_role: "owner", schema_version: 2, expected_version: 1 }) }));
    expect(unpublish.status).toBe(200);
    const disabled = await updatePolicy(false, 1);
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({ configured: true, member_facts_enabled: false, revision: 2, active_member_facts: 0 });
    expect((await updatePolicy(true, 1)).status).toBe(409);
    await expect((await readPolicy()).json()).resolves.toMatchObject({ member_facts_enabled: false, revision: 2 });
    const events = storagePolicyEvents(space);
    expect(events).toMatchObject([
      { prior_revision: null, revision: 1, prior_member_facts_enabled: null, member_facts_enabled: 1, actor_id: "owner", actor_role: "owner" },
      { prior_revision: 1, revision: 2, prior_member_facts_enabled: 1, member_facts_enabled: 0, actor_id: "owner", actor_role: "owner" },
    ]);
    const history = (after?: string) => space.fetch(new Request(`http://space/space-coordination-policy/history?${new URLSearchParams({ tenant_id: "tenant", space_id: "space", limit: "1", ...(after ? { after } : {}) })}`));
    const firstPage = await (await history()).json() as { events: Array<Record<string, unknown>>; next_after: string | null };
    expect(firstPage).toMatchObject({ schema_version: 2, events: [{ prior_revision: null, revision: 1, member_facts_enabled: true, actor_id: "owner" }], next_after: "1" });
    const secondPage = await (await history(firstPage.next_after ?? undefined)).json() as { events: Array<Record<string, unknown>>; next_after: string | null };
    expect(secondPage).toMatchObject({ events: [{ prior_revision: 1, revision: 2, member_facts_enabled: false, actor_id: "owner" }], next_after: null });
    expect((await history("01")).status).toBe(400);
  });

  it("blocks new member-visible amendments under the default-off policy but permits narrowing to admins", async () => {
    const { space, storage, root } = await setup(false);
    storage.sql.exec(`INSERT INTO space_coordination_entries
      (tenant_id,space_id,entry_id,schema_version,capability_key,label,description,audience,status,advisory_only,version,provenance,created_by,approved_by,approved_role,created_at,updated_at,last_confirmed_at,last_confirmed_by,expires_at)
      VALUES ('tenant','space','legacy-amend',1,'official.website','Legacy approved fact',NULL,'space_members','active',1,1,'explicit_owner_or_admin_approval','owner','owner','owner','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','owner',NULL)`);
    const amend = (audience: "space_members" | "space_admins") => space.fetch(new Request(`${root}/legacy-amend`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant", space_id: "space", actor_id: "admin", approved_role: "admin", schema_version: 2,
        expected_version: 1, confirmed: true, draft: { schema_version: 2, capability_key: "official.website", label: "Updated fact", audience } }),
    }));
    expect((await amend("space_members")).status).toBe(409);
    expect(storage.sql.exec("SELECT version,label,audience FROM space_coordination_entries WHERE entry_id='legacy-amend'").toArray())
      .toEqual([{ version: 1, label: "Legacy approved fact", audience: "space_members" }]);
    expect((await amend("space_admins")).status).toBe(200);
    expect(storage.sql.exec("SELECT version,label,audience FROM space_coordination_entries WHERE entry_id='legacy-amend'").toArray())
      .toEqual([{ version: 2, label: "Updated fact", audience: "space_admins" }]);
  });

  it("serializes concurrent policy disable and member publication without a disabled visible fact", async () => {
    const { publishV2, readPolicy, updatePolicy } = await setup();
    const [published, disabled] = await Promise.all([publishV2("racing-member", "space_members"), updatePolicy(false, 1)]);
    const policy = await (await readPolicy()).json() as { member_facts_enabled: boolean; active_member_facts: number };
    if (!policy.member_facts_enabled) {
      expect(published.status).toBe(409);
      expect(policy.active_member_facts).toBe(0);
    } else {
      expect(published.status).toBe(201);
      expect(disabled.status).toBe(409);
      expect(policy.active_member_facts).toBe(1);
    }
  });

  it("rolls back policy changes when their metadata audit cannot be recorded", async () => {
    const { space, storage, readPolicy, updatePolicy } = await setup(false);
    storage.sql.exec(`CREATE TRIGGER reject_coordination_policy_audit BEFORE INSERT ON space_coordination_policy_events
      BEGIN SELECT RAISE(ABORT,'policy audit unavailable'); END`);
    const failed = await updatePolicy(true, 0);
    expect(failed.status).toBe(503);
    await expect((await readPolicy()).json()).resolves.toMatchObject({ configured: false, member_facts_enabled: false, revision: 0 });
    expect(storagePolicyEvents(space)).toEqual([]);
  });
});

function storageRow(space: SpaceDO) {
  const internals = space as unknown as { ctx: { storage: { sql: { exec<T>(query: string, ...args: unknown[]): { toArray(): T[] } } } } };
  return internals.ctx.storage.sql.exec<{ status: string; version: number; revoked_by: string; approved_by: string; approved_role: string }>(
    "SELECT status,version,revoked_by,approved_by,approved_role FROM space_coordination_entries WHERE entry_id='entry'").toArray()[0];
}

function storagePolicyEvents(space: SpaceDO) {
  const internals = space as unknown as { ctx: { storage: { sql: { exec<T>(query: string, ...args: unknown[]): { toArray(): T[] } } } } };
  return internals.ctx.storage.sql.exec("SELECT prior_revision,revision,prior_member_facts_enabled,member_facts_enabled,actor_id,actor_role FROM space_coordination_policy_events ORDER BY revision").toArray();
}
