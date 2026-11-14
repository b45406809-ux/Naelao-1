import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { captureSpaceArchiveObjectChunked, decodeSpaceArchive, encodeSpaceArchive, spaceArchiveChecksum, spaceArchiveKeyringFromBindings, spaceArchiveKeyVersion, verifySpaceArchiveObjectSnapshots } from "./space-backup.js";
import { SpaceDO } from "./SpaceDO.js";
import { WorkspaceCoordinatorDO } from "../../../agents/src/workspace/WorkspaceCoordinatorDO.js";

function mockR2() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  let failNext = false, failPutKey: string | null = null, failChunkAfter: number | null = null;
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
    failNextWriteForKey(key: string) { failPutKey = key; },
    failChunkWriteAfter(successfulChunkWrites: number) { failChunkAfter = successfulChunkWrites; },
    failMultipartPart(partNumber: number) { failPart = partNumber; },
    uploadedPartCount() { return uploadedParts; },
    async put(key: string, value: Uint8Array | string | ArrayBuffer, options?: { onlyIf?: { etagDoesNotMatch?: string }; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }) { if (failNext) { failNext = false; throw new Error("simulated R2 outage"); } if (failPutKey === key) { failPutKey = null; throw new Error("simulated keyed R2 outage"); } if (key.includes(".chunks/") && failChunkAfter !== null) { if (failChunkAfter === 0) { failChunkAfter = null; throw new Error("simulated archive chunk outage"); } failChunkAfter--; } if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null; const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value); const etag = options?.onlyIf ? `restored-etag-${bytes.byteLength}-${key}` : `etag-${bytes.byteLength}-${key}`; objects.set(key, { bytes, etag, ...(options?.httpMetadata ? { httpMetadata: { ...options.httpMetadata } } : {}), ...(options?.customMetadata ? { customMetadata: { ...options.customMetadata } } : {}) }); return { etag }; },
    async createMultipartUpload(key: string) { const uploadId = crypto.randomUUID(); uploads.set(uploadId, { key, parts: new Map() }); return multipart(key, uploadId); },
    resumeMultipartUpload(key: string, uploadId: string) { return multipart(key, uploadId); },
    async get(key: string) { const entry = objects.get(key); return entry && { etag: entry.etag, size: entry.bytes.byteLength, ...(entry.httpMetadata ? { httpMetadata: entry.httpMetadata } : {}), ...(entry.customMetadata ? { customMetadata: entry.customMetadata } : {}), arrayBuffer: async () => entry.bytes.slice().buffer }; },
    async head(key: string) { const entry = objects.get(key); return entry && { etag: entry.etag, size: entry.bytes.byteLength }; },
    async delete(key: string | string[]) { if (Array.isArray(key)) for (const item of key) objects.delete(item); else objects.delete(key); },
    async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const matching = [...objects.entries()].filter(([key]) => key.startsWith(options.prefix ?? "")).sort(([a], [b]) => a.localeCompare(b));
      const offset = Number(options.cursor ?? 0), limit = options.limit ?? 1000, selected = matching.slice(offset, offset + limit);
      const next = offset + selected.length;
      return { objects: selected.map(([key, value]) => ({ key, etag: value.etag, size: value.bytes.byteLength })), truncated: next < matching.length, cursor: next < matching.length ? String(next) : undefined };
    },
  };
}

class WorkspaceStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) { let deleted = false; for (const item of key) deleted = this.values.delete(item) || deleted; return deleted; }
    return this.values.delete(key);
  }
  async list<T>({ prefix = "", startAfter, limit = 1000 }: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort(([left], [right]) => left.localeCompare(right)).slice(0, limit) as Array<[string, T]>);
  }
  async transaction<T>(callback: (transaction: this) => Promise<T>): Promise<T> { return callback(this); }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(at: number | Date): Promise<void> { this.alarm = at instanceof Date ? at.getTime() : at; }
  async deleteAlarm(): Promise<void> { this.alarm = null; }
}

function workspaceCoordinator(storage: WorkspaceStorage, r2: ReturnType<typeof mockR2>, secret: string): WorkspaceCoordinatorDO {
  return new WorkspaceCoordinatorDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
}

describe("SpaceDO owner data operations", () => {
  it("purges local Space data, keeps a durable erasure tombstone, and rejects later writes and restores", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token };
    const dataOps = (action: string) => space.fetch(new Request("https://space/data-ops", {
      method: "POST", headers, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", action, request_id: "erasure-archive" }),
    }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers }));
    storage.sql.exec(`INSERT INTO extension_settings_audit_events(
      event_id,tenant_id,space_id,project_id,instance_id,extension_id,instance_scope,actor_id,actor_role,
      prior_revision,new_revision,schema_version,changed_field_ids_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, "audit-a", "tenant-a", "space-a", "project-a", "installation-a", "extension-a", "PROJECT_BOUND",
      "owner-a", "owner", 0, 1, 1, JSON.stringify(["greeting"]), "2026-01-01T00:00:00.000Z");
    storage.sql.exec("INSERT INTO sessions (id,space_id,tenant_id) VALUES (?,?,?)", "session-a", "space-a", "tenant-a");
    storage.sql.exec("INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)", "message-a", "session-a", "user", "personal content", "2026-01-01T00:00:00.000Z");
    const archived = await dataOps("export");
    expect(archived.status).toBe(201);
    const archive = await archived.json() as { archive_id: string };
    const archiveKey = `space-archives/tenant-a/space-a/${archive.archive_id}.enc`;
    expect(r2.objects.has(archiveKey)).toBe(true);

    const erase = (requestId: string) => space.fetch(new Request("https://space/internal/data-erasure", {
      method: "DELETE", headers, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", request_id: requestId }),
    }));
    const response = await erase("erase-request-a");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ erased: true, tenant_id: "tenant-a", space_id: "space-a", request_id: "erase-request-a", replayed: false });
    expect(storage.sql.exec("SELECT id FROM messages").toArray()).toHaveLength(0);
    expect(storage.sql.exec("SELECT id FROM sessions").toArray()).toHaveLength(0);
    expect(storage.sql.exec("SELECT event_id FROM extension_settings_audit_events").toArray()).toHaveLength(0);
    expect(storage.sql.exec("SELECT archive_id FROM space_archive_records").toArray()).toHaveLength(0);
    expect(storage.sql.exec("SELECT tenant_id,space_id,request_id FROM space_erasure_tombstones").toArray()).toEqual([
      { tenant_id: "tenant-a", space_id: "space-a", request_id: "erase-request-a" },
    ]);
    expect(r2.objects.has(archiveKey)).toBe(true); // The workflow performs the retryable prefix sweep after this tombstone.

    expect((await dataOps("preview_restore")).status).toBe(410);
    const directWriter = await space.fetch(new Request("https://space/internal/domain-glossary?space_id=space-a", {
      method: "POST", headers, body: JSON.stringify({ space_id: "space-a", actor_id: "owner-a", entry: { term: "x", meaning: "y" } }),
    }));
    expect(directWriter.status).toBe(410);
    expect(await erase("erase-request-a").then(result => result.json())).toMatchObject({ replayed: true });
    expect((await erase("different-request")).status).toBe(409);
  });

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

  it("inserts restored active event triggers disabled and records the safety action before owner reactivation", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never,
      AGENTS_WORKER: { async fetch() { return Response.json({ present: false }); } } as unknown as Fetcher } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token };
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers }));
    storage.sql.exec("INSERT INTO projects(id,space_id,name) VALUES(?,?,?)", "project-a", "space-a", "Project A");
    storage.sql.exec("INSERT INTO event_triggers(id,space_id,project_id,event_type,script_name,enabled) VALUES(?,?,?,?,?,1)", "trigger-a", "space-a", "project-a", "thread.created", "external-effect-script");

    const exported = await post({ action: "export", request_id: "trigger-archive" });
    expect(exported.status).toBe(201);
    const { archive_id: archiveId } = await exported.json() as { archive_id: string };
    storage.sql.exec("DELETE FROM event_triggers WHERE id=?", "trigger-a");

    const previewResponse = await post({ action: "preview_restore", archive_id: archiveId });
    const preview = await previewResponse.json() as { preview_id: string; safety_actions: { archived_active_event_trigger_count: number; missing_event_triggers_will_be_inserted_disabled: boolean; existing_event_trigger_state_will_be_preserved: boolean } };
    expect(previewResponse.status).toBe(200);
    expect(preview.safety_actions).toEqual({ archived_active_event_trigger_count: 1, missing_event_triggers_will_be_inserted_disabled: true, existing_event_trigger_state_will_be_preserved: true });

    const applied = await post({ action: "apply_restore", archive_id: archiveId, preview_id: preview.preview_id });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ safety_actions: { restored_event_triggers_inserted_disabled: 1 } });
    expect(storage.sql.exec<{ enabled: number }>("SELECT enabled FROM event_triggers WHERE id=?", "trigger-a").toArray()).toEqual([{ enabled: 0 }]);
    expect(JSON.parse(storage.sql.exec<{ safety_actions_json: string }>("SELECT safety_actions_json FROM space_archive_restores WHERE id=?", preview.preview_id).toArray()[0]!.safety_actions_json)).toEqual({ restored_event_triggers_inserted_disabled: 1 });
    const restoreList = await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a&actor_id=owner-a", { headers }));
    expect(await restoreList.json()).toMatchObject({ restores: [{ id: preview.preview_id, status: "completed", safety_actions: { restored_event_triggers_inserted_disabled: 1 } }] });

    storage.sql.exec("UPDATE projects SET status='archived' WHERE id=?", "project-a");
    const blockedReactivation = await space.fetch(new Request("https://space/event-triggers/trigger-a?space_id=space-a", { method: "PATCH", headers, body: JSON.stringify({ enabled: true, actor_id: "owner-a" }) }));
    expect(blockedReactivation.status).toBe(409);
    storage.sql.exec("UPDATE projects SET status='active' WHERE id=?", "project-a");
    const reactivated = await space.fetch(new Request("https://space/event-triggers/trigger-a?space_id=space-a", { method: "PATCH", headers, body: JSON.stringify({ enabled: true, actor_id: "owner-a" }) }));
    expect(reactivated.status).toBe(200);
    expect(storage.sql.exec<{ enabled: number; updated_by: string }>("SELECT enabled,updated_by FROM event_triggers WHERE id=?", "trigger-a").toArray()).toEqual([{ enabled: 1, updated_by: "owner-a" }]);
  });

  it("excludes owner-managed grants from new archives and skips them in legacy restores", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
    }));
    storage.sql.exec(`INSERT INTO local_grants(id,space_id,user_id,grant_type,commands_json,created_at)
      VALUES(?,?,?,?,?,?)`, "local-grant-a", "space-a", "user-a", "exec", JSON.stringify(["node"]), "2026-11-14T00:00:00.000Z");
    storage.sql.exec(`INSERT INTO extension_shared_filesystem_grants(instance_id,path,access,approved_by,approved_at)
      VALUES(?,?,?,?,?)`, "extension-a", "workspace/reports", "READ", "owner-a", "2026-11-14T00:00:00.000Z");
    storage.sql.exec(`INSERT INTO extension_project_knowledge_grants(tenant_id,space_id,project_id,instance_id,publication_id,granted_by,granted_at)
      VALUES(?,?,?,?,?,?,?)`, "tenant-a", "space-a", "project-a", "extension-a", "support_docs", "owner-a", "2026-11-14T00:00:00.000Z");

    const exported = await post({ action: "export", request_id: "grant-recovery-safety" });
    expect(exported.status).toBe(201);
    const { archive_id: archiveId } = await exported.json() as { archive_id: string };
    const archiveKey = `space-archives/tenant-a/space-a/${archiveId}.enc`;
    const stored = r2.objects.get(archiveKey)!;
    const payload = await decodeSpaceArchive(stored.bytes, secret, { tenantId: "tenant-a", spaceId: "space-a", archiveId });
    const grantRows: Record<string, Array<Record<string, unknown>>> = {
      local_grants: [{ id: "local-grant-a", space_id: "space-a", project_id: null, user_id: "user-a", grant_type: "exec", directory: null, commands_json: '["node"]', created_at: "2026-11-14T00:00:00.000Z" }],
      extension_shared_filesystem_grants: [{ instance_id: "extension-a", path: "workspace/reports", access: "READ", approved_by: "owner-a", approved_at: "2026-11-14T00:00:00.000Z" }],
      extension_project_knowledge_grants: [{ tenant_id: "tenant-a", space_id: "space-a", project_id: "project-a", instance_id: "extension-a", publication_id: "support_docs", granted_by: "owner-a", granted_at: "2026-11-14T00:00:00.000Z" }],
    };
    for (const table of Object.keys(grantRows)) {
      expect(payload.tableRows).not.toHaveProperty(table);
      expect(payload.rowCounts).not.toHaveProperty(table);
    }

    const legacyPayload = structuredClone(payload);
    for (const [table, rows] of Object.entries(grantRows)) {
      legacyPayload.tableRows[table] = rows;
      legacyPayload.rowCounts[table] = rows.length;
      storage.sql.exec(`DELETE FROM "${table}"`);
    }
    const encoded = await encodeSpaceArchive(legacyPayload, secret);
    stored.bytes = encoded.bytes;
    storage.sql.exec("UPDATE space_archive_records SET checksum=? WHERE archive_id=?", await spaceArchiveChecksum(legacyPayload), archiveId);

    const previewResponse = await post({ action: "preview_restore", archive_id: archiveId });
    expect(previewResponse.status, JSON.stringify(await previewResponse.clone().json())).toBe(200);
    const preview = await previewResponse.json() as { preview_id: string; row_counts: Record<string, number>; safety_actions: { owner_managed_grant_rows_not_restored?: Record<string, number> } };
    expect(preview.row_counts).not.toHaveProperty("extension_project_knowledge_grants");
    expect(preview.safety_actions.owner_managed_grant_rows_not_restored).toEqual({
      local_grants: 1, extension_shared_filesystem_grants: 1, extension_project_knowledge_grants: 1,
    });

    const applied = await post({ action: "apply_restore", archive_id: archiveId, preview_id: preview.preview_id });
    expect(applied.status, JSON.stringify(await applied.clone().json())).toBe(200);
    expect(await applied.json()).toMatchObject({ safety_actions: { owner_managed_grant_rows_not_restored: preview.safety_actions.owner_managed_grant_rows_not_restored } });
    for (const table of Object.keys(grantRows)) expect(storage.sql.exec(`SELECT * FROM "${table}"`).toArray()).toHaveLength(0);
    expect(JSON.parse(storage.sql.exec<{ safety_actions_json: string }>("SELECT safety_actions_json FROM space_archive_restores WHERE id=?", preview.preview_id).toArray()[0]!.safety_actions_json))
      .toMatchObject({ owner_managed_grant_rows_not_restored: preview.safety_actions.owner_managed_grant_rows_not_restored });
  });

  it("keeps an uninstalled Space extension inactive when restoring an older active installation row", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token };
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers,
      body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    const runtimeWork = (action: "acquire" | "release", workId: string) => space.fetch(new Request("https://space/extension-runtime-work", { method: "POST", headers,
      body: JSON.stringify({ action, tenantId: "tenant-a", spaceId: "space-a", projectId: null, instanceId: "installation-a", workId, workKind: "channel" }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers }));
    const extensionId = "ext_archive_restore";
    const manifest = JSON.stringify({ id: extensionId, name: "Archive recovery fixture" });
    storage.sql.exec("INSERT INTO installed_extensions(extension_id,manifest_json,installed_by,installed_at,updated_at) VALUES(?,?,?,?,?)",
      extensionId, manifest, "owner-a", "2026-11-14T00:00:00.000Z", "2026-11-14T00:00:00.000Z");
    storage.sql.exec(`INSERT INTO extension_instances(instance_id,extension_id,tenant_id,space_id,project_id,user_id,scope,instance_key,owner_key,installed_by,status,installed_at,removed_at,release_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,NULL,NULL)`, "installation-a", extensionId, "tenant-a", "space-a", null, null, "SPACE_SHARED", "default", "space:space-a", "owner-a", "2026-11-14T00:00:00.000Z");
    const initialAdmission = await runtimeWork("acquire", "before-archive");
    expect(initialAdmission.status).toBe(200);
    expect((await runtimeWork("release", "before-archive")).status).toBe(200);

    const exported = await post({ action: "export", request_id: "active-extension-before-uninstall" });
    expect(exported.status).toBe(201);
    const { archive_id: archiveId } = await exported.json() as { archive_id: string };
    const uninstalled = await space.fetch(new Request(`https://space/extensions/${extensionId}`, { method: "DELETE", headers }));
    expect(uninstalled.status).toBe(200);
    expect(storage.sql.exec<{ status: string }>("SELECT status FROM extension_instances WHERE instance_id='installation-a'").toArray()).toEqual([{ status: "removed" }]);

    const previewResponse = await post({ action: "preview_restore", archive_id: archiveId });
    expect(previewResponse.status, JSON.stringify(await previewResponse.clone().json())).toBe(200);
    const { preview_id: previewId } = await previewResponse.json() as { preview_id: string };
    const restored = await post({ action: "apply_restore", archive_id: archiveId, preview_id: previewId });
    expect(restored.status, JSON.stringify(await restored.clone().json())).toBe(200);
    expect(storage.sql.exec<{ status: string }>("SELECT status FROM extension_instances WHERE instance_id='installation-a'").toArray()).toEqual([{ status: "removed" }]);
    const admissionAfterRestore = await runtimeWork("acquire", "after-restore");
    expect(admissionAfterRestore.status).toBe(409);
    expect(await admissionAfterRestore.json()).toMatchObject({ error_code: "extension_installation_inactive", acquired: false });
  });

  it("previews exact merge inserts and skips without mutating current rows, then persists the applied outcome", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never,
      AGENTS_WORKER: { async fetch() { return Response.json({ present: false }); } } as unknown as Fetcher } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES(?,?,?,?)", "project-existing", "space-a", "Archived name", "active");
    storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES(?,?,?,?)", "project-missing", "space-a", "To restore", "active");
    const exported = await post({ action: "export", request_id: "merge-preview-receipt" });
    expect(exported.status).toBe(201);
    const archive = await exported.json() as { archive_id: string };
    storage.sql.exec("UPDATE projects SET name='Current name' WHERE id='project-existing'");
    storage.sql.exec("DELETE FROM projects WHERE id='project-missing'");

    const previewResponse = await post({ action: "preview_restore", archive_id: archive.archive_id });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { preview_id: string; row_merge: { would_insert: Record<string, number>; would_skip_by_constraints: Record<string, number> } };
    expect(preview.row_merge.would_insert.projects).toBe(1);
    expect(preview.row_merge.would_skip_by_constraints.projects).toBe(1);
    expect(storage.sql.exec("SELECT id,name FROM projects WHERE id IN ('project-existing','project-missing') ORDER BY id").toArray()).toEqual([
      { id: "project-existing", name: "Current name" },
    ]);

    const applied = await post({ action: "apply_restore", archive_id: archive.archive_id, preview_id: preview.preview_id });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ restored_counts: { projects: 1 }, skipped_counts: { projects: 1 } });
    expect(storage.sql.exec("SELECT id,name FROM projects WHERE id IN ('project-existing','project-missing') ORDER BY id").toArray()).toEqual([
      { id: "project-existing", name: "Current name" }, { id: "project-missing", name: "To restore" },
    ]);
    expect(storage.sql.exec<{ skipped_counts_json: string }>("SELECT skipped_counts_json FROM space_archive_restores WHERE id=?", preview.preview_id).toArray())
      .toEqual([{ skipped_counts_json: expect.any(String) }]);
    expect(JSON.parse(storage.sql.exec<{ skipped_counts_json: string }>("SELECT skipped_counts_json FROM space_archive_restores WHERE id=?", preview.preview_id).toArray()[0]!.skipped_counts_json))
      .toMatchObject({ projects: 1 });
    const listed = await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
    }));
    expect(await listed.json()).toMatchObject({ restores: [{ id: preview.preview_id, skipped_counts: { projects: 1 } }] });
  });

  it("captures bounded workspace bytes and retries a checksum-verified missing-object restore without overwriting conflicts", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token }, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    const key = "spaces/space-a/projects/project-a/assets/readme-a.txt", secondKey = "spaces/space-a/projects/project-a/assets/readme-b.txt";
    const extensionArtifactKey = "spaces/space-a/extensions/ext_example/1.0.0/dashboard.html";
    const agentConfigKeys = ["agents.md", "scripts.json", "skills.json", "system-prompt.md"].map(name => `spaces/space-a/agents/agent-a/${name}`);
    const assistantWorkspaceKey = "spaces/space-a/workspace/reports/summary.md";
    const learnedSkillKeys = ["code.ts", "SCRIPT.md"].map(name => `spaces/space-a/scripts/research/${name}`);
    const otherSpaceKey = "spaces/space-b/projects/project-b/assets/private.txt";
    const original = new TextEncoder().encode("canonical workspace object contents"), secondOriginal = new TextEncoder().encode("second canonical workspace object");
    const extensionArtifact = new TextEncoder().encode("<main>signed package dashboard artifact</main>");
    const agentConfigOriginals = agentConfigKeys.map((_, index) => new TextEncoder().encode(`agent configuration ${index + 1}`));
    const assistantWorkspaceOriginal = new TextEncoder().encode("Space Assistant report");
    const learnedSkillOriginals = learnedSkillKeys.map((_, index) => new TextEncoder().encode(`learned skill source ${index + 1}`));
    await r2.put(key, original, { httpMetadata: { contentType: "text/plain", cacheControl: "private, max-age=60", cacheExpiry: new Date("2027-01-02T03:04:05.000Z") }, customMetadata: { uploadedBy: "owner-a" } });
    await r2.put(secondKey, secondOriginal);
    await r2.put(extensionArtifactKey, extensionArtifact, { httpMetadata: { contentType: "text/html; charset=utf-8" }, customMetadata: { releaseVersion: "1.0.0" } });
    for (const [index, agentConfigKey] of agentConfigKeys.entries()) await r2.put(agentConfigKey, agentConfigOriginals[index]!);
    await r2.put(assistantWorkspaceKey, assistantWorkspaceOriginal);
    for (const [index, learnedSkillKey] of learnedSkillKeys.entries()) await r2.put(learnedSkillKey, learnedSkillOriginals[index]!);
    await r2.put(otherSpaceKey, new TextEncoder().encode("must stay outside the archive"));

    const exported = await post({ action: "export", request_id: "workspace-object-archive-1" });
    expect(exported.status).toBe(201);
    const { archive_id: archiveId } = await exported.json() as { archive_id: string };
    const archiveKey = `space-archives/tenant-a/space-a/${archiveId}.enc`;
    const archivedPayload = await decodeSpaceArchive(r2.objects.get(archiveKey)!.bytes, secret, { tenantId: "tenant-a", spaceId: "space-a", archiveId });
    expect(archivedPayload.objectReferences.map(ref => ref.key)).toEqual([key, secondKey, extensionArtifactKey, ...agentConfigKeys, assistantWorkspaceKey, ...learnedSkillKeys]);
    expect(archivedPayload.objectSnapshots).toHaveLength(10);
    await r2.delete(key);
    await r2.delete(secondKey);
    await r2.delete(extensionArtifactKey);
    for (const agentConfigKey of agentConfigKeys) await r2.delete(agentConfigKey);
    await r2.delete(assistantWorkspaceKey);
    for (const learnedSkillKey of learnedSkillKeys) await r2.delete(learnedSkillKey);

    const previewResponse = await post({ action: "preview_restore", archive_id: archiveId });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { preview_id: string; object_restore_required_count: number };
    expect(preview.object_restore_required_count).toBe(10);

    await r2.put(key, new TextEncoder().encode("concurrent replacement must not be overwritten"));
    const conflicted = await post({ action: "apply_restore", archive_id: archiveId, preview_id: preview.preview_id });
    expect(conflicted.status).toBe(409);
    expect(new TextDecoder().decode(new Uint8Array(await (await r2.get(key))!.arrayBuffer()))).toBe("concurrent replacement must not be overwritten");

    await r2.delete(key);
    r2.failNextWriteForKey(secondKey);
    const interrupted = await post({ action: "apply_restore", archive_id: archiveId, preview_id: preview.preview_id });
    expect(interrupted.status).toBe(503);
    expect(storage.sql.exec<{ status: string; restored_object_count: number }>("SELECT status,restored_object_count FROM space_archive_restores WHERE id=?", preview.preview_id).toArray()[0]).toEqual({ status: "partial", restored_object_count: 1 });
    expect(new Uint8Array(await (await r2.get(key))!.arrayBuffer())).toEqual(original);
    expect(await r2.get(secondKey)).toBeUndefined();

    const restored = await post({ action: "apply_restore", archive_id: archiveId, preview_id: preview.preview_id });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ restored_object_count: 10 });
    expect(new Uint8Array(await (await r2.get(key))!.arrayBuffer())).toEqual(original);
    expect(new Uint8Array(await (await r2.get(secondKey))!.arrayBuffer())).toEqual(secondOriginal);
    expect(new Uint8Array(await (await r2.get(extensionArtifactKey))!.arrayBuffer())).toEqual(extensionArtifact);
    for (const [index, agentConfigKey] of agentConfigKeys.entries()) {
      expect(new Uint8Array(await (await r2.get(agentConfigKey))!.arrayBuffer())).toEqual(agentConfigOriginals[index]);
    }
    expect(new Uint8Array(await (await r2.get(assistantWorkspaceKey))!.arrayBuffer())).toEqual(assistantWorkspaceOriginal);
    for (const [index, learnedSkillKey] of learnedSkillKeys.entries()) {
      expect(new Uint8Array(await (await r2.get(learnedSkillKey))!.arrayBuffer())).toEqual(learnedSkillOriginals[index]);
    }
    expect(r2.objects.get(extensionArtifactKey)).toMatchObject({ httpMetadata: { contentType: "text/html; charset=utf-8" }, customMetadata: { releaseVersion: "1.0.0" } });
    expect(r2.objects.get(key)).toMatchObject({ httpMetadata: { contentType: "text/plain", cacheControl: "private, max-age=60", cacheExpiry: new Date("2027-01-02T03:04:05.000Z") }, customMetadata: { uploadedBy: "owner-a" } });
    expect(r2.objects.has(otherSpaceKey)).toBe(true);
    expect(storage.sql.exec<{ status: string; restored_object_count: number }>("SELECT status,restored_object_count FROM space_archive_restores WHERE id=?", preview.preview_id).toArray()[0]).toEqual({ status: "completed", restored_object_count: 10 });
  });

  it("archives project coordinator heads and restores them through an authenticated retryable bridge", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    const workspaceScope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" as const };
    let coordinator = workspaceCoordinator(new WorkspaceStorage(), r2, secret);
    const coordinatorCall = async (target: WorkspaceCoordinatorDO, path: string, body: unknown) => target.fetch(new Request(`https://workspace${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") }, body: JSON.stringify(body),
    }));
    const agentsWorker = { async fetch(request: Request) {
      const body = await request.json() as Record<string, unknown>;
      const path = new URL(request.url).pathname;
      if (path.endsWith("/archive/export")) {
        const response = await coordinatorCall(coordinator, "/v1/archive/export", { scope: body.scope });
        if (!response.ok) return response;
        const result = await response.json() as { present: boolean; snapshot?: { policyGeneration: number; branches: Array<{ head: Record<string, unknown>; base: unknown }> }; objectReferences?: unknown[] };
        if (!result.present || !result.snapshot) return Response.json({ present: false });
        const branches = result.snapshot.branches.map(item => {
          const { scope: _scope, ...head } = item.head;
          return { head, base: item.base };
        });
        return Response.json({ present: true, snapshot: { version: 1, projectId: workspaceScope.projectId,
          jurisdiction: workspaceScope.jurisdiction, policyGeneration: result.snapshot.policyGeneration, branches }, objectReferences: result.objectReferences });
      }
      if (path.endsWith("/archive/restore")) {
        const snapshot = body.snapshot as { policyGeneration: number; branches: Array<{ head: Record<string, unknown>; base: unknown }> };
        const restoredSnapshot = { version: 1, scope: { tenantId: "tenant-a", spaceId: body.spaceId, projectId: body.projectId, jurisdiction: body.jurisdiction },
          policyGeneration: snapshot.policyGeneration, branches: snapshot.branches.map(item => ({ head: { ...item.head, version: 1, scope: {
            tenantId: "tenant-a", spaceId: body.spaceId, projectId: body.projectId, jurisdiction: body.jurisdiction,
          } }, base: item.base })) };
        return coordinatorCall(coordinator, "/v1/archive/restore", { snapshot: restoredSnapshot, restoreId: body.restoreId });
      }
      return Response.json({ error_code: "not_found" }, { status: 404 });
    } } as unknown as Fetcher;
    const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never, AGENTS_WORKER: agentsWorker } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token };
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers,
      body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers }));
    storage.sql.exec("INSERT INTO projects(id,space_id,name) VALUES(?,?,?)", "project-a", "space-a", "Project A");

    const committed = new TextEncoder().encode("committed canonical project workspace");
    const hash = await crypto.subtle.digest("SHA-256", committed).then(digest => [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join(""));
    const contentKey = `workspace-v1/tenant-a/space-a/project-a/global/content/${hash}`;
    await r2.put(contentKey, committed);
    expect((await coordinatorCall(coordinator, "/v1/initialize", { scope: workspaceScope, branch: "main", entries: [
      { path: "src/main.ts", sha256: hash, size: committed.byteLength, executable: false, objectKey: contentKey },
    ] })).status).toBe(200);
    expect((await coordinatorCall(coordinator, "/v1/branch", { scope: workspaceScope, sourceBranch: "main", branch: "runs/agent-a" })).status).toBe(200);

    const coordinatorExport = await coordinatorCall(coordinator, "/v1/archive/export", { scope: workspaceScope });
    expect(coordinatorExport.status, JSON.stringify(await coordinatorExport.clone().json())).toBe(200);
    const exported = await post({ action: "export", request_id: "project-workspace-archive" });
    expect(exported.status, JSON.stringify(await exported.clone().json())).toBe(201);
    const { archive_id: archiveId } = await exported.json() as { archive_id: string };
    const archiveKey = `space-archives/tenant-a/space-a/${archiveId}.enc`;
    const archived = await decodeSpaceArchive(r2.objects.get(archiveKey)!.bytes, secret, { tenantId: "tenant-a", spaceId: "space-a", archiveId });
    expect(archived.workspaceSnapshots).toHaveLength(1);
    expect(archived.workspaceSnapshots?.[0]).toMatchObject({ projectId: "project-a", jurisdiction: "global", branches: [
      { head: { branch: "main", revision: 1 } }, { head: { branch: "runs/agent-a", revision: 1 }, base: { parentBranch: "main", revision: 1 } },
    ] });
    const workspaceReferences = archived.objectReferences.filter(ref => ref.key.startsWith("workspace-v1/"));
    expect(workspaceReferences.length).toBeGreaterThanOrEqual(2);
    for (const ref of workspaceReferences) await r2.delete(ref.key);

    const conflictStorage = new WorkspaceStorage();
    let different = new WorkspaceCoordinatorDO({ storage: conflictStorage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const differentBytes = new TextEncoder().encode("concurrent current project head");
    const differentHash = await crypto.subtle.digest("SHA-256", differentBytes).then(digest => [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join(""));
    const differentKey = `workspace-v1/tenant-a/space-a/project-a/global/content/${differentHash}`;
    await r2.put(differentKey, differentBytes);
    await coordinatorCall(different, "/v1/initialize", { scope: workspaceScope, branch: "main", entries: [
      { path: "src/current.ts", sha256: differentHash, size: differentBytes.byteLength, executable: false, objectKey: differentKey },
    ] });
    const currentHeadResponse = await different.fetch(new Request("https://workspace/v1/head?branch=main", { headers: {
      "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    } }));
    const currentHeadBeforeRestore = await currentHeadResponse.json();
    coordinator = different;
    const previewResponse = await post({ action: "preview_restore", archive_id: archiveId });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { preview_id: string; workspace_restore_count: number; object_restore_required_count: number };
    expect(preview).toMatchObject({ workspace_restore_count: 1, object_restore_required_count: workspaceReferences.length });
    const rejected = await post({ action: "apply_restore", archive_id: archiveId, preview_id: preview.preview_id });
    expect(rejected.status).toBe(409);
    expect(storage.sql.exec<{ status: string }>("SELECT status FROM space_archive_restores WHERE id=?", preview.preview_id).toArray()[0]?.status).toBe("partial");
    const currentHead = await different.fetch(new Request("https://workspace/v1/head?branch=main", { headers: {
      "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    } }));
    expect(await currentHead.json()).toEqual(currentHeadBeforeRestore);

    coordinator = workspaceCoordinator(new WorkspaceStorage(), r2, secret);
    const restored = await post({ action: "apply_restore", archive_id: archiveId, preview_id: preview.preview_id });
    expect(restored.status, JSON.stringify(await restored.clone().json())).toBe(200);
    expect(await restored.json()).toMatchObject({ restored_workspace_count: 1 });
    const restoredHead = await coordinator.fetch(new Request("https://workspace/v1/head?branch=runs%2Fagent-a", { headers: {
      "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
    } }));
    expect(await restoredHead.json()).toMatchObject({ head: { revision: 1 }, branchBase: { parentBranch: "main", revision: 1 } });
    expect(storage.sql.exec<{ status: string }>("SELECT status FROM space_archive_restores WHERE id=?", preview.preview_id).toArray()[0]?.status).toBe("completed");
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

  it("resumes an interrupted v2 chunked object export and restores authenticated object bytes", async () => {
    const storage = createDOStorage(), secret = "space-data-ops-test-secret-long-enough", r2 = mockR2();
    let space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(secret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token }, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    const key = "spaces/space-a/projects/project-a/workspace/large.bin";
    const original = new Uint8Array(5 * 1024 * 1024 + 19);
    for (let index = 0; index < original.length; index++) original[index] = (index * 17) % 251;
    await r2.put(key, original);
    r2.failChunkWriteAfter(1);
    const failed = await post({ action: "export", request_id: "chunked-resume-1" });
    expect(failed.status).toBe(503);
    const first = await failed.json() as { archive_id: string; error_code?: string; message?: string };
    const chunkPrefix = `space-archives/tenant-a/space-a/${first.archive_id}.chunks/`;
    expect([...r2.objects.keys()].filter(candidate => candidate.startsWith(chunkPrefix)), JSON.stringify({ response: first, keys: [...r2.objects.keys()] })).toHaveLength(1);

    space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: secret, SCRIPTS_R2: r2 as never } as never);
    const retried = await post({ action: "export", request_id: "chunked-resume-1" });
    expect(retried.status, JSON.stringify(await retried.clone().json())).toBe(201);
    expect(await retried.json()).toMatchObject({ archive_id: first.archive_id });
    const archiveKey = `space-archives/tenant-a/space-a/${first.archive_id}.enc`;
    const archived = await decodeSpaceArchive(r2.objects.get(archiveKey)!.bytes, secret, { tenantId: "tenant-a", spaceId: "space-a", archiveId: first.archive_id });
    expect(archived.formatVersion).toBe(2);
    expect(archived.objectSnapshots?.[0]).toMatchObject({ key, objectIndex: 0, size: original.byteLength });
    expect(JSON.stringify(archived.objectSnapshots)).not.toContain("bytesBase64");

    await r2.delete(key);
    const previewResponse = await post({ action: "preview_restore", archive_id: first.archive_id });
    expect(previewResponse.status, JSON.stringify(await previewResponse.clone().json())).toBe(200);
    const preview = await previewResponse.json() as { preview_id: string; object_restore_required_count: number };
    expect(preview.object_restore_required_count).toBe(1);
    const restored = await post({ action: "apply_restore", archive_id: first.archive_id, preview_id: preview.preview_id });
    expect(restored.status, JSON.stringify(await restored.clone().json())).toBe(200);
    expect(new Uint8Array(await (await r2.get(key))!.arrayBuffer())).toEqual(original);
  }, 30_000);

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

  it("rewraps v2 object chunks before switching the archive pointer and removes old-key chunks", async () => {
    const storage = createDOStorage(), oldSecret = "space-data-ops-test-secret-long-enough", newKey = "new-archive-key-material-long-enough-2026", r2 = mockR2();
    let space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: oldSecret, SCRIPTS_R2: r2 as never } as never);
    const token = await mintInternalToken(oldSecret, "tenant-a");
    const post = (body: Record<string, unknown>) => space.fetch(new Request("https://space/data-ops", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token }, body: JSON.stringify({ tenant_id: "tenant-a", space_id: "space-a", actor_id: "owner-a", ...body }) }));
    await space.fetch(new Request("https://space/data-ops?tenant_id=tenant-a&space_id=space-a", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token } }));
    const archiveId = "archive-v2-rewrap", sourceKey = "spaces/space-a/projects/project-a/workspace/v2.bin";
    const sourceBytes = new TextEncoder().encode("immutable object content to re-encrypt");
    await r2.put(sourceKey, sourceBytes);
    const source = await r2.get(sourceKey)!;
    const ref = { key: sourceKey, etag: source.etag, size: source.size };
    const captured = await captureSpaceArchiveObjectChunked(source as never, ref, 0, { tenantId: "tenant-a", spaceId: "space-a", archiveId }, oldSecret);
    for (const chunk of captured.chunks) await r2.put(chunk.key, chunk.bytes);
    const payload = { format: "naelao-space-archive" as const, formatVersion: 2 as const, tenantId: "tenant-a", spaceId: "space-a", archiveId,
      createdAt: "2026-11-14T00:00:00.000Z", migrationVersion: 1, tableRows: {}, rowCounts: {}, objectReferences: [ref], objectSnapshots: [captured.snapshot] };
    const encoded = await encodeSpaceArchive(payload, oldSecret);
    const oldArchiveKey = `space-archives/tenant-a/space-a/${archiveId}.enc`;
    await r2.put(oldArchiveKey, encoded.bytes);
    storage.sql.exec(`INSERT INTO space_archive_records (archive_id,tenant_id,space_id,request_id,kind,status,object_key,schema_version,checksum,plaintext_bytes,row_counts_json,object_refs_json,selection_fingerprint,created_by,created_at)
      VALUES (?,?,?,?,'full','verified',?,?,?,?,?,?,NULL,?,?)`, archiveId, "tenant-a", "space-a", "rewrap-v2-route", oldArchiveKey, 1, encoded.checksum, encoded.plaintextBytes, "{}", JSON.stringify([ref]), "owner-a", "2026-11-14T00:00:00.000Z");
    const oldChunkKey = captured.chunks[0]!.key;
    expect(r2.objects.has(oldChunkKey)).toBe(true);

    space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: oldSecret, SPACE_ARCHIVE_KEY: newKey, SPACE_ARCHIVE_KEY_ID: "archive-2026-11",
      SPACE_ARCHIVE_KEY_PREVIOUS: oldSecret, SPACE_ARCHIVE_KEY_PREVIOUS_ID: "platform-secret-hkdf-v1", SCRIPTS_R2: r2 as never } as never);
    const rewrapped = await post({ action: "rewrap_archive", archive_id: archiveId });
    expect(rewrapped.status, JSON.stringify(await rewrapped.clone().json())).toBe(200);
    const outcome = await rewrapped.json() as { rewrapped: boolean };
    expect(outcome.rewrapped).toBe(true);
    const currentRecord = storage.sql.exec<{ object_key: string; checksum: string }>("SELECT object_key,checksum FROM space_archive_records WHERE archive_id=?", archiveId).toArray()[0]!;
    expect(currentRecord.object_key).not.toBe(oldArchiveKey);
    expect(currentRecord.checksum).not.toBe(encoded.checksum);
    expect(r2.objects.has(oldArchiveKey)).toBe(false);
    expect(r2.objects.has(oldChunkKey)).toBe(false);
    const activeOnly = spaceArchiveKeyringFromBindings({ platformSecret: "retired-platform-secret-material-long-enough", activeKey: newKey, activeVersion: "archive-2026-11" });
    const rotatedArchive = await decodeSpaceArchive(r2.objects.get(currentRecord.object_key)!.bytes, activeOnly, { tenantId: "tenant-a", spaceId: "space-a", archiveId });
    await expect(verifySpaceArchiveObjectSnapshots(rotatedArchive, r2 as never, activeOnly)).resolves.toBeUndefined();
  });

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
    expect(storage.sql.exec<{ status: string }>("SELECT status FROM space_archive_restores WHERE archive_id=?", archiveId).toArray()[0]?.status).toBe("partial");
  });
});
