import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { decodeSpaceArchive, encodeSpaceArchive, spaceArchiveChecksum } from "./space-backup.js";
import { SpaceDO } from "./SpaceDO.js";

function mockR2() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let failNext = false;
  return {
    objects,
    failNextWrite() { failNext = true; },
    async put(key: string, value: Uint8Array) { if (failNext) { failNext = false; throw new Error("simulated R2 outage"); } const bytes = new Uint8Array(value); const etag = `etag-${bytes.byteLength}-${key}`; objects.set(key, { bytes, etag }); return { etag }; },
    async get(key: string) { const entry = objects.get(key); return entry && { etag: entry.etag, size: entry.bytes.byteLength, arrayBuffer: async () => entry.bytes.slice().buffer }; },
    async head(key: string) { const entry = objects.get(key); return entry && { etag: entry.etag, size: entry.bytes.byteLength }; },
    async list() { return { objects: [], truncated: false }; },
  };
}

describe("SpaceDO owner data operations", () => {
  it("previews retention, requires an exact archive when configured, then deletes only selected messages", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough";
    const r2 = mockR2();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token }, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    storage.sql.exec("INSERT INTO sessions (id,space_id,tenant_id) VALUES (?,?,?)", "session-a", "space-a", "tenant-a");
    storage.sql.exec("INSERT INTO sessions (id,space_id,tenant_id) VALUES (?,?,?)", "session-held", "space-a", "tenant-a");
    storage.sql.exec("INSERT INTO sessions (id,space_id,tenant_id) VALUES (?,?,?)", "session-b", "space-b", "tenant-a");
    storage.sql.exec("INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)", "old-a", "session-a", "user", "old text", "2020-01-01T00:00:00.000Z");
    storage.sql.exec("INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)", "old-held", "session-held", "user", "held text", "2020-01-01T00:00:00.000Z");
    storage.sql.exec("INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)", "old-b", "session-b", "user", "other space", "2020-01-01T00:00:00.000Z");
    expect((await post({ action: "configure", message_retention_days: 30, archive_before_delete: true })).status).toBe(200);
    expect((await post({ action: "set_retention_hold", session_id: "session-held", held: true })).status).toBe(200);
    const preview = await post({ action: "preview_retention" });
    const previewBody = await preview.json() as { preview_id: string; message_count: number; held_message_count_excluded: number };
    expect(previewBody.message_count).toBe(1);
    expect(previewBody.held_message_count_excluded).toBe(1);
    expect(storage.sql.exec("SELECT id FROM messages WHERE id='old-a'").toArray()).toHaveLength(1);
    expect((await post({ action: "apply_retention", preview_id: previewBody.preview_id })).status).toBe(409);
    const archivedResponse = await post({ action: "export", kind: "retention_messages", request_id: "retention-1", preview_id: previewBody.preview_id });
    expect(archivedResponse.status).toBe(201);
    const archived = await archivedResponse.json() as { archive_id: string };
    const archiveKey = `space-archives/tenant-a/space-a/${archived.archive_id}.enc`;
    const archiveObject = r2.objects.get(archiveKey)!;
    const originalArchiveBytes = archiveObject.bytes.slice();
    archiveObject.bytes[archiveObject.bytes.length - 1] ^= 1;
    expect((await post({ action: "apply_retention", preview_id: previewBody.preview_id })).status).toBe(409);
    expect(storage.sql.exec("SELECT id FROM messages WHERE id='old-a'").toArray()).toHaveLength(1);
    archiveObject.bytes = originalArchiveBytes;
    expect((await post({ action: "apply_retention", preview_id: previewBody.preview_id })).status).toBe(200);
    expect(storage.sql.exec("SELECT id FROM messages WHERE id='old-a'").toArray()).toHaveLength(0);
    expect(storage.sql.exec("SELECT id FROM messages WHERE id='old-b'").toArray()).toHaveLength(1);
    expect(storage.sql.exec("SELECT id FROM messages WHERE id='old-held'").toArray()).toHaveLength(1);
    expect(storage.sql.exec("SELECT id FROM sessions WHERE id='session-a'").toArray()).toHaveLength(1);
    expect(storage.sql.exec("SELECT action FROM space_retention_events WHERE action='retention_applied'").toArray()).toHaveLength(1);
  });

  it("exports encrypted state, verifies same-Space restore, and replays idempotently", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    let space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token }, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    storage.sql.exec("INSERT INTO sessions (id,space_id,tenant_id) VALUES (?,?,?)", "session-a", "space-a", "tenant-a");
    storage.sql.exec("INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)", "message-a", "session-a", "user", "preserved", "2020-01-01T00:00:00.000Z");
    const exported = await post({ action: "export", request_id: "full-1" });
    const archive = await exported.json() as { archive_id: string };
    expect(exported.status).toBe(201);
    space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const replayed = await post({ action: "export", request_id: "full-1" });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ archive_id: archive.archive_id, replayed: true });
    const firstPreview = await post({ action: "preview_restore", archive_id: archive.archive_id });
    expect(firstPreview.status, JSON.stringify(await firstPreview.clone().json())).toBe(200);
    const previewResponse = await post({ action: "preview_restore", archive_id: archive.archive_id });
    const preview = await previewResponse.json() as { preview_id: string };
    storage.sql.exec("DELETE FROM messages WHERE id='message-a'");
    const applied = await post({ action: "apply_restore", archive_id: archive.archive_id, preview_id: preview.preview_id });
    expect(applied.status, JSON.stringify(await applied.clone().json())).toBe(200);
    expect(storage.sql.exec<{ content: string }>("SELECT content FROM messages WHERE id='message-a'").toArray()[0]?.content).toBe("preserved");
    const replay = await post({ action: "apply_restore", archive_id: archive.archive_id, preview_id: preview.preview_id });
    expect(replay.status).toBe(409);
  });

  it("retries a failed archive write with the same request and archive identity", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token }, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    r2.failNextWrite();
    const failed = await post({ action: "export", request_id: "restart-1" });
    const first = await failed.json() as { archive_id: string };
    expect(failed.status).toBe(503);
    const retried = await post({ action: "export", request_id: "restart-1" });
    const second = await retried.json() as { archive_id: string };
    expect(retried.status).toBe(201);
    expect(second.archive_id).toBe(first.archive_id);
  });

  it("rolls back all restore writes when deferred foreign keys fail at commit", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token }, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    storage.sql.exec("INSERT INTO sessions (id,space_id,tenant_id) VALUES (?,?,?)", "session-rollback", "space-a", "tenant-a");
    storage.sql.exec("INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)", "message-rollback", "session-rollback", "user", "must roll back", "2020-01-01T00:00:00.000Z");
    const exported = await post({ action: "export", request_id: "invalid-fk-archive" });
    const { archive_id: archiveId } = await exported.json() as { archive_id: string };
    const key = `space-archives/tenant-a/space-a/${archiveId}.enc`, stored = r2.objects.get(key)!;
    const payload = await decodeSpaceArchive(stored.bytes, secret, { tenantId: "tenant-a", spaceId: "space-a", archiveId });
    payload.tableRows.sessions = [];
    payload.rowCounts.sessions = 0;
    const encoded = await encodeSpaceArchive(payload, secret);
    stored.bytes = encoded.bytes;
    storage.sql.exec("UPDATE space_archive_records SET checksum=? WHERE archive_id=?", await spaceArchiveChecksum(payload), archiveId);
    storage.sql.exec("DELETE FROM messages WHERE id='message-rollback'");
    storage.sql.exec("DELETE FROM sessions WHERE id='session-rollback'");
    const preview = await post({ action: "preview_restore", archive_id: archiveId });
    const { preview_id: previewId } = await preview.json() as { preview_id: string };
    const applied = await post({ action: "apply_restore", archive_id: archiveId, preview_id: previewId });
    expect(applied.status).toBe(409);
    expect(storage.sql.exec("SELECT id FROM messages WHERE id='message-rollback'").toArray()).toHaveLength(0);
    expect(storage.sql.exec("SELECT id FROM sessions WHERE id='session-rollback'").toArray()).toHaveLength(0);
    expect(storage.sql.exec("SELECT id FROM space_archive_restores WHERE archive_id=?", archiveId).toArray()).toHaveLength(0);
  });
});
