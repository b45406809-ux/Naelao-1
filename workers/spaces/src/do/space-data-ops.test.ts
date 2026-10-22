import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { decodeSpaceArchive, encodeSpaceArchive, spaceArchiveChecksum, spaceArchiveKeyringFromBindings, spaceArchiveKeyVersion } from "./space-backup.js";
import { SpaceDO } from "./SpaceDO.js";

function mockR2() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  let failNext = false;
  let failPart: number | null = null, uploadedParts = 0;
  const multipart = (key: string, uploadId: string) => ({
    key, uploadId,
    async uploadPart(partNumber: number, value: Uint8Array) {
      if (failPart === partNumber) { failPart = null; throw new Error("simulated multipart outage"); }
      uploadedParts++;
      const bytes = new Uint8Array(value); uploads.get(uploadId)?.parts.set(partNumber, bytes);
      return { partNumber, etag: `part-${partNumber}-${bytes.byteLength}` };
    },
    async complete(parts: Array<{ partNumber: number }>) {
      const session = uploads.get(uploadId)!;
      const bytes = new Uint8Array(parts.reduce((sum, part) => sum + (session.parts.get(part.partNumber)?.byteLength ?? 0), 0));
      let offset = 0;
      for (const part of parts) { const chunk = session.parts.get(part.partNumber)!; bytes.set(chunk, offset); offset += chunk.byteLength; }
      const etag = `etag-${bytes.byteLength}-${key}`; objects.set(key, { bytes, etag }); uploads.delete(uploadId); return { etag };
    },
    async abort() { uploads.delete(uploadId); },
  });
  return {
    objects,
    failNextWrite() { failNext = true; },
    failMultipartPart(partNumber: number) { failPart = partNumber; },
    uploadedPartCount() { return uploadedParts; },
    async put(key: string, value: Uint8Array) { if (failNext) { failNext = false; throw new Error("simulated R2 outage"); } const bytes = new Uint8Array(value); const etag = `etag-${bytes.byteLength}-${key}`; objects.set(key, { bytes, etag }); return { etag }; },
    async createMultipartUpload(key: string) { const uploadId = crypto.randomUUID(); uploads.set(uploadId, { key, parts: new Map() }); return multipart(key, uploadId); },
    resumeMultipartUpload(key: string, uploadId: string) { return multipart(key, uploadId); },
    async get(key: string) { const entry = objects.get(key); return entry && { etag: entry.etag, size: entry.bytes.byteLength, arrayBuffer: async () => entry.bytes.slice().buffer }; },
    async head(key: string) { const entry = objects.get(key); return entry && { etag: entry.etag, size: entry.bytes.byteLength }; },
    async delete(key: string) { objects.delete(key); },
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

  it("resumes multipart parts after a Durable Object restart without rebuilding ciphertext", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    let space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token }, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    storage.sql.exec("INSERT INTO sessions (id,space_id,tenant_id) VALUES (?,?,?)", "session-big", "space-a", "tenant-a");
    storage.sql.exec("INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)", "message-big", "session-big", "user", "x".repeat(6 * 1024 * 1024), "2020-01-01T00:00:00.000Z");
    r2.failMultipartPart(2);
    const failed = await post({ action: "export", request_id: "multipart-resume-1" });
    expect(failed.status).toBe(503);
    const first = await failed.json() as { archive_id: string };
    const parts = storage.sql.exec<{ completed_parts_json: string }>("SELECT completed_parts_json FROM space_archive_uploads WHERE archive_id=?", first.archive_id).toArray()[0]?.completed_parts_json;
    expect(JSON.parse(parts ?? "[]")).toHaveLength(1);
    expect(storage.sql.exec<{ bytes: Uint8Array }>("SELECT encrypted_bytes AS bytes FROM space_archive_uploads WHERE archive_id=?", first.archive_id).toArray()[0]?.bytes.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const retried = await post({ action: "export", request_id: "multipart-resume-1" });
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({ archive_id: first.archive_id, resumed: true });
    expect(r2.uploadedPartCount()).toBe(2);
    expect(storage.sql.exec("SELECT archive_id FROM space_archive_uploads WHERE archive_id=?", first.archive_id).toArray()).toHaveLength(0);
    expect(storage.sql.exec("SELECT archive_id FROM space_archive_records WHERE archive_id=? AND status='verified'", first.archive_id).toArray()).toHaveLength(1);
  }, 15_000);

  it("rewraps an archive to the active key before removing the previous copy", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", nextKey = "new-archive-key-secret-material-over-32";
    const r2 = mockR2();
    let space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token }, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    const exported = await post({ action: "export", request_id: "rewrap-archive-1" });
    const archive = await exported.json() as { archive_id: string };
    const recordBefore = storage.sql.exec<{ object_key: string }>("SELECT object_key FROM space_archive_records WHERE archive_id=?", archive.archive_id).toArray()[0]!;
    space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SPACE_ARCHIVE_KEY: nextKey, SPACE_ARCHIVE_KEY_ID: "archive-2026-10", SPACE_ARCHIVE_KEY_PREVIOUS: secret, SPACE_ARCHIVE_KEY_PREVIOUS_ID: "archive-2026-04", SCRIPTS_R2: r2 as never } as never);
    const result = await post({ action: "rewrap_archive", archive_id: archive.archive_id });
    expect(result.status, JSON.stringify(await result.clone().json())).toBe(200);
    const recordAfter = storage.sql.exec<{ object_key: string }>("SELECT object_key FROM space_archive_records WHERE archive_id=?", archive.archive_id).toArray()[0]!;
    expect(recordAfter.object_key).not.toBe(recordBefore.object_key);
    expect(r2.objects.has(recordBefore.object_key)).toBe(false);
    const stored = r2.objects.get(recordAfter.object_key)!;
    expect(spaceArchiveKeyVersion(stored.bytes)).toBe("archive-2026-10");
    const activeOnly = spaceArchiveKeyringFromBindings({ platformSecret: secret, activeKey: nextKey, activeVersion: "archive-2026-10" });
    await expect(decodeSpaceArchive(stored.bytes, activeOnly, { tenantId: "tenant-a", spaceId: "space-a", archiveId: archive.archive_id })).resolves.toMatchObject({ archiveId: archive.archive_id });
  });

  it("resumes a bounded bulk rewrap job after a Durable Object restart", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", nextKey = "rotated-archive-key-material-with-more-than-32-chars";
    const r2 = mockR2();
    let space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token }, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    const originalKeys: string[] = [];
    for (let index = 0; index < 5; index++) {
      const response = await post({ action: "export", request_id: `bulk-rewrap-${index}` });
      expect(response.status).toBe(201);
      const archive = await response.json() as { archive_id: string };
      originalKeys.push(storage.sql.exec<{ object_key: string }>("SELECT object_key FROM space_archive_records WHERE archive_id=?", archive.archive_id).toArray()[0]!.object_key);
    }
    space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SPACE_ARCHIVE_KEY: nextKey, SPACE_ARCHIVE_KEY_ID: "archive-2026-10", SPACE_ARCHIVE_KEY_PREVIOUS: secret, SPACE_ARCHIVE_KEY_PREVIOUS_ID: "archive-2026-04", SCRIPTS_R2: r2 as never } as never);
    let result = await post({ action: "start_rewrap_archives" });
    const started = await result.json() as { job_id: string; status: string };
    expect(started.status).toBe("active");
    r2.failNextWrite();
    result = await post({ action: "resume_rewrap_archives", job_id: started.job_id });
    expect(result.status).toBe(503);
    expect(await post({ action: "get_rewrap_archives", job_id: started.job_id }).then(response => response.json())).toMatchObject({ status: "blocked", scanned_count: 0 });
    result = await post({ action: "resume_rewrap_archives", job_id: started.job_id });
    expect(await result.json()).toMatchObject({ status: "active", scanned_count: 3, rewrapped_count: 3 });
    space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SPACE_ARCHIVE_KEY: nextKey, SPACE_ARCHIVE_KEY_ID: "archive-2026-10", SPACE_ARCHIVE_KEY_PREVIOUS: secret, SPACE_ARCHIVE_KEY_PREVIOUS_ID: "archive-2026-04", SCRIPTS_R2: r2 as never } as never);
    result = await post({ action: "resume_rewrap_archives", job_id: started.job_id });
    expect(await result.json()).toMatchObject({ status: "completed", scanned_count: 5, rewrapped_count: 5 });
    expect(storage.sql.exec<{ status: string }>("SELECT status FROM space_archive_rewrap_jobs WHERE job_id=?", started.job_id).toArray()[0]?.status).toBe("completed");
    for (const key of originalKeys) expect(r2.objects.has(key)).toBe(false);
    const currentKeys = storage.sql.exec<{ object_key: string }>("SELECT object_key FROM space_archive_records WHERE tenant_id='tenant-a' AND space_id='space-a'").toArray();
    for (const item of currentKeys) expect(spaceArchiveKeyVersion(r2.objects.get(item.object_key)!.bytes)).toBe("archive-2026-10");
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
