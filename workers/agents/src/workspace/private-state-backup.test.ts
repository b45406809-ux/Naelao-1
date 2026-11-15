import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { createPrivateStateBackup, decryptPrivateStateBackup, encryptPrivateStateBackup, privateStateBackupConfig, privateStateBackupObjectKey,
  eraseProjectPrivateStateBackups, readPrivateStateBackup, readPrivateStateSelection, savePrivateStateSelection,
  sweepPrivateStateBackupRetention, validatePrivateStateCapture, validatePrivateStatePaths, validatePrivateStateRestoreAuthority } from "./private-state-backup.js";

const scope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" as const };
const bytes = new TextEncoder().encode("selected private preferences");
const paths = ["settings/preferences.json"];
const files = [{ path: paths[0]!, bytes }];
const metadata = { backupId: "backup-1", requestId: "req-1", allocationGeneration: 3,
  imageFingerprint: "a".repeat(64), toolchainFingerprint: "b".repeat(64),
  createdAt: "2026-11-14T12:00:00.000Z", expiresAt: "2026-12-14T12:00:00.000Z" };
const config = { enabled: true as const, key: "private-state-test-encryption-key-material-0001", keyVersion: "private-state-test-v1",
  retentionDays: 30, quotaBytes: 1024 * 1024, bucket: {} as R2Bucket };
function recoveryDb() {
  const db = createFakeD1([
    readFileSync(new URL("../../../../infra/migrations/0189_project_main_runtime_registry.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../../infra/migrations/0255_project_main_private_state_recovery.sql", import.meta.url), "utf8"),
  ]);
  db.db.exec(`CREATE TABLE workspace_erasure_tombstones(
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT NOT NULL,tombstone_id TEXT NOT NULL,
    jurisdiction TEXT NOT NULL,status TEXT NOT NULL,requested_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(tenant_id,space_id,project_id))`);
  return db;
}
function bucket() {
  const objects = new Map<string, Uint8Array>();
  let failDeleteAck = false;
  const value = {
    put: async (key: string, body: Uint8Array, options?: { onlyIf?: { etagDoesNotMatch?: string } }) => {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      objects.set(key, new Uint8Array(body));
      return { key };
    },
    get: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
    },
    delete: async (key: string) => {
      objects.delete(key);
      if (failDeleteAck) { failDeleteAck = false; throw new Error("simulated lost delete acknowledgment"); }
    },
    loseNextDeleteAcknowledgment: () => { failDeleteAck = true; },
    objects,
  };
  return value;
}

describe("project main private-state recovery envelope", () => {
  it("keeps the selected path set strict and rejects shared, secret, cache, and traversal paths", () => {
    expect(validatePrivateStatePaths(["settings/preferences.json", "state/local-index.json"])).toEqual([
      "settings/preferences.json", "state/local-index.json",
    ]);
    for (const bad of ["../workspace.txt", ".env", "settings/.ssh/key", "browser/profile", "cache/index", "credentials.json", "node_modules/x"]) {
      expect(() => validatePrivateStatePaths([bad])).toThrow("project_main_private_state_paths_invalid");
    }
    expect(() => validatePrivateStateCapture(paths, [{ path: "shared/readme.md", bytes }])).toThrow("project_main_private_state_capture_invalid");
    expect(() => validatePrivateStateCapture(paths, [{ path: paths[0]!, bytes: new TextEncoder().encode('{"apiKey":"sk-abcdefghijklmnopqrstuvwx"}') }]))
      .toThrow("project_main_private_state_secret_material_rejected");
    expect(() => validatePrivateStateCapture(paths, [{ path: paths[0]!, bytes: new Uint8Array([0xff, 0x00]) }]))
      .toThrow("project_main_private_state_content_unsupported");
  });

  it("fails closed when the feature, jurisdiction bucket, key, retention, or quota is not configured", () => {
    const bucket = {} as R2Bucket;
    expect(() => privateStateBackupConfig({ enabled: "false" }, "global")).toThrow("project_main_private_state_backup_disabled");
    expect(() => privateStateBackupConfig({ enabled: "true", jurisdiction: "global", key: config.key,
      keyVersion: config.keyVersion, retentionDays: "30", quotaBytes: "1000000" }, "global"))
      .toThrow("project_main_private_state_bucket_unavailable");
    expect(() => privateStateBackupConfig({ enabled: "true", jurisdiction: "global", key: config.key,
      keyVersion: config.keyVersion, retentionDays: "30", quotaBytes: "1000000", globalBucket: bucket }, "eu"))
      .toThrow("project_main_private_state_jurisdiction_unconfigured");
    expect(privateStateBackupConfig({ enabled: "true", jurisdiction: "global", key: config.key,
      keyVersion: config.keyVersion, retentionDays: "30", quotaBytes: "1000000", globalBucket: bucket }, "global").bucket).toBe(bucket);
  });

  it("encrypts selected bytes with scope and provenance AAD and restores only matching metadata", async () => {
    const encoded = await encryptPrivateStateBackup(scope, metadata, paths, files, config);
    expect(new TextDecoder().decode(encoded)).not.toContain("selected private preferences");
    const restored = await decryptPrivateStateBackup(encoded, { scope, backupId: metadata.backupId,
      allocationGeneration: 4, imageFingerprint: metadata.imageFingerprint,
      toolchainFingerprint: metadata.toolchainFingerprint, now: Date.parse("2026-11-15T00:00:00.000Z") }, config);
    expect(restored.metadata).toEqual(metadata);
    expect(restored.files.map(file => file.path)).toEqual(paths);
    expect(restored.files[0]!.bytes).toEqual(bytes);
    expect(privateStateBackupObjectKey(scope, metadata.backupId)).toBe(
      "project-main-private-state/v1/global/tenant-a/space-a/project-a/backup-1.enc");
  });

  it("rejects cross-scope, stale generation, changed image/toolchain, expired, or tampered restores", async () => {
    const encoded = await encryptPrivateStateBackup(scope, metadata, paths, files, config);
    const expectBlocked = (input: Parameters<typeof decryptPrivateStateBackup>[1]) =>
      expect(decryptPrivateStateBackup(encoded, input, config)).rejects.toThrow("project_main_private_state_restore_incompatible");
    await expectBlocked({ scope: { ...scope, tenantId: "other-tenant" }, backupId: metadata.backupId, allocationGeneration: 4,
      imageFingerprint: metadata.imageFingerprint, toolchainFingerprint: metadata.toolchainFingerprint });
    await expectBlocked({ scope, backupId: metadata.backupId, allocationGeneration: 2,
      imageFingerprint: metadata.imageFingerprint, toolchainFingerprint: metadata.toolchainFingerprint });
    await expectBlocked({ scope, backupId: metadata.backupId, allocationGeneration: 4,
      imageFingerprint: "c".repeat(64), toolchainFingerprint: metadata.toolchainFingerprint });
    await expectBlocked({ scope, backupId: metadata.backupId, allocationGeneration: 4,
      imageFingerprint: metadata.imageFingerprint, toolchainFingerprint: metadata.toolchainFingerprint,
      now: Date.parse("2027-01-01T00:00:00.000Z") });
    const envelope = JSON.parse(new TextDecoder().decode(encoded)) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
    await expect(decryptPrivateStateBackup(new TextEncoder().encode(JSON.stringify(envelope)), { scope,
      backupId: metadata.backupId, allocationGeneration: 4, imageFingerprint: metadata.imageFingerprint,
      toolchainFingerprint: metadata.toolchainFingerprint }, config)).rejects.toThrow("project_main_private_state_authentication_failed");
  });

  it("requires a live non-erased scope and exact image/toolchain fingerprints before restore", () => {
    expect(() => validatePrivateStateRestoreAuthority({ erased: true, generation: 4, imageFingerprint: "a".repeat(64),
      toolchainFingerprint: "b".repeat(64), backupGeneration: 3, backupImageFingerprint: "a".repeat(64), backupToolchainFingerprint: "b".repeat(64) }))
      .toThrow("project_main_private_state_erased");
    expect(() => validatePrivateStateRestoreAuthority({ erased: false, generation: 4, imageFingerprint: "a".repeat(64),
      toolchainFingerprint: "b".repeat(64), backupGeneration: 5, backupImageFingerprint: "a".repeat(64), backupToolchainFingerprint: "b".repeat(64) }))
      .toThrow("project_main_private_state_restore_incompatible");
    expect(() => validatePrivateStateRestoreAuthority({ erased: false, generation: 4, imageFingerprint: "a".repeat(64),
      toolchainFingerprint: "b".repeat(64), backupGeneration: 3, backupImageFingerprint: "a".repeat(64), backupToolchainFingerprint: "b".repeat(64) }))
      .not.toThrow();
  });

  it("persists a bounded versioned selection and backup ledger shape in the migration", async () => {
    const db = createFakeD1([readFileSync(new URL("../../../../infra/migrations/0255_project_main_private_state_recovery.sql", import.meta.url), "utf8")]);
    await db.prepare(`INSERT INTO project_main_private_state_manifests VALUES(?,?,?,?,?,?,?)`)
      .bind("tenant-a", "space-a", "project-a", JSON.stringify(paths), 1, "owner-a", "2026-11-14T12:00:00.000Z").run();
    await db.prepare(`INSERT INTO project_main_private_state_manifest_audit VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind("audit-1", "tenant-a", "space-a", "project-a", 0, 1, 1, "d".repeat(64), "owner-a", "2026-11-14T12:00:00.000Z").run();
    await db.prepare(`INSERT INTO project_main_private_state_backups VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind("backup-1", "req-1", "tenant-a", "space-a", "project-a", "global", 3, "a".repeat(64), "b".repeat(64),
        "private-state-test-v1", privateStateBackupObjectKey(scope, "backup-1"), 320, 1, "available",
        "2026-11-14T12:00:00.000Z", "2026-12-14T12:00:00.000Z").run();
    expect(await db.prepare("SELECT paths_json,version FROM project_main_private_state_manifests").first())
      .toEqual({ paths_json: JSON.stringify(paths), version: 1 });
    expect(await db.prepare("SELECT state,file_count FROM project_main_private_state_backups").first())
      .toEqual({ state: "available", file_count: 1 });
  });

  it("saves selected paths with optimistic fencing, audit metadata, and an empty default", async () => {
    const db = recoveryDb();
    expect(await readPrivateStateSelection(db, scope)).toEqual({ paths: [], version: 0, updatedBy: null, updatedAt: null });
    await expect(savePrivateStateSelection(db, scope, { paths, expectedVersion: 0, actorId: "owner-a" }, new Date("2026-11-14T12:00:00.000Z")))
      .resolves.toEqual({ paths, version: 1, changed: true });
    await expect(savePrivateStateSelection(db, scope, { paths: ["state/local.json"], expectedVersion: 0, actorId: "owner-b" }))
      .rejects.toThrow("project_main_private_state_manifest_version_conflict");
    expect(await db.prepare("SELECT path_count,actor_id FROM project_main_private_state_manifest_audit").first())
      .toEqual({ path_count: 1, actor_id: "owner-a" });
    await expect(savePrivateStateSelection(db, scope, { paths: [], expectedVersion: 1, actorId: "owner-a" }))
      .resolves.toMatchObject({ paths: [], version: 2, changed: true });
  });

  it("writes an idempotent encrypted R2 backup only for the current manifest and allocation, then checks restore authority", async () => {
    const db = recoveryDb();
    const storage = bucket();
    const bindings = { enabled: "true", key: config.key, keyVersion: config.keyVersion, jurisdiction: "global",
      globalBucket: storage as never, retentionDays: "30", quotaBytes: "1000000" };
    await db.prepare(`INSERT INTO project_main_runtime_registry
      (tenant_id,space_id,project_id,runtime_kind,runtime_object_name,allocation_generation,fencing_token,active_branch,state,last_seen_at)
      VALUES(?,?,?,'dynamic_sandbox',?,3,1,'main','active','2026-11-14T12:00:00.000Z')`)
      .bind(scope.tenantId, scope.spaceId, scope.projectId, "sandbox:space-a:project-a").run();
    await savePrivateStateSelection(db, scope, { paths, expectedVersion: 0, actorId: "owner-a" });
    const request = { requestId: "req-1", expectedManifestVersion: 1, allocationGeneration: 3,
      imageFingerprint: "a".repeat(64), toolchainFingerprint: "b".repeat(64), files };
    const created = await createPrivateStateBackup(db, bindings, scope, request, new Date("2026-11-14T12:00:00.000Z"));
    expect(created).toMatchObject({ requestId: "req-1", allocationGeneration: 3, fileCount: 1, state: "available" });
    expect(storage.objects.has(privateStateBackupObjectKey(scope, created.backupId))).toBe(true);
    const retried = await createPrivateStateBackup(db, bindings, scope, { ...request, files: [{ path: paths[0]!, bytes: new TextEncoder().encode("changed retry") }] }, new Date("2026-11-14T12:01:00.000Z"));
    expect(retried.backupId).toBe(created.backupId);
    const restored = await readPrivateStateBackup(db, bindings, scope, { backupId: created.backupId, allocationGeneration: 3,
      imageFingerprint: request.imageFingerprint, toolchainFingerprint: request.toolchainFingerprint }, Date.parse("2026-11-14T12:02:00.000Z"));
    expect(restored.files[0]!.bytes).toEqual(bytes);
    await db.prepare("UPDATE project_main_runtime_registry SET allocation_generation=4 WHERE tenant_id=? AND space_id=? AND project_id=?")
      .bind(scope.tenantId,scope.spaceId,scope.projectId).run();
    const recoveredAck = await createPrivateStateBackup(db, bindings, scope, { ...request, allocationGeneration: 4 });
    expect(recoveredAck.backupId).toBe(created.backupId);
    expect(recoveredAck.allocationGeneration).toBe(3);
    await expect(readPrivateStateBackup(db, bindings, { ...scope, jurisdiction: "eu" }, { backupId: created.backupId, allocationGeneration: 3,
      imageFingerprint: request.imageFingerprint, toolchainFingerprint: request.toolchainFingerprint }, Date.parse("2026-11-14T12:02:00.000Z")))
      .rejects.toThrow("project_main_private_state_jurisdiction_unconfigured");
    await db.prepare(`INSERT INTO workspace_erasure_tombstones(tenant_id,space_id,project_id,tombstone_id,jurisdiction,status,requested_at,updated_at)
      VALUES(?,?,?,?,?,'pending',?,?)`).bind(scope.tenantId,scope.spaceId,scope.projectId,"tombstone-1","global","2026-11-14T12:03:00.000Z","2026-11-14T12:03:00.000Z").run();
    await expect(readPrivateStateBackup(db, bindings, scope, { backupId: created.backupId, allocationGeneration: 3,
      imageFingerprint: request.imageFingerprint, toolchainFingerprint: request.toolchainFingerprint }, Date.parse("2026-11-14T12:04:00.000Z")))
      .rejects.toThrow("project_main_private_state_erased");
  });

  it("expires and erases objects with retryable delete acknowledgments, while the tombstone blocks restore", async () => {
    const db = recoveryDb();
    const storage = bucket();
    const bindings = { globalBucket: storage as never };
    const backupId = "pmsb_cleanup-test";
    const objectKey = privateStateBackupObjectKey(scope, backupId);
    storage.objects.set(objectKey, new Uint8Array([1, 2, 3]));
    await db.prepare(`INSERT INTO project_main_private_state_backups(
      backup_id,request_id,tenant_id,space_id,project_id,jurisdiction,allocation_generation,image_fingerprint,
      toolchain_fingerprint,key_version,object_key,ciphertext_bytes,file_count,state,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(backupId,"req-cleanup",scope.tenantId,scope.spaceId,scope.projectId,"global",3,"a".repeat(64),"b".repeat(64),
        config.keyVersion,objectKey,3,1,"available","2026-01-01T00:00:00.000Z","2026-01-02T00:00:00.000Z").run();
    const expired = await sweepPrivateStateBackupRetention(db, bindings, new Date("2026-01-03T00:00:00.000Z"));
    expect(expired).toMatchObject({ deleted: 1, pending: 0, examined: 1 });
    expect(storage.objects.has(objectKey)).toBe(false);
    expect(await db.prepare("SELECT state FROM project_main_private_state_backups WHERE backup_id=?").bind(backupId).first())
      .toEqual({ state: "deleted" });

    const raceBackupId = "pmsb_tombstone-race";
    const raceKey = privateStateBackupObjectKey(scope, raceBackupId);
    storage.objects.set(raceKey, new Uint8Array([4, 5, 6]));
    await db.prepare(`INSERT INTO project_main_private_state_backups(
      backup_id,request_id,tenant_id,space_id,project_id,jurisdiction,allocation_generation,image_fingerprint,
      toolchain_fingerprint,key_version,object_key,ciphertext_bytes,file_count,state,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(raceBackupId,"req-race",scope.tenantId,scope.spaceId,scope.projectId,"global",3,"a".repeat(64),"b".repeat(64),
        config.keyVersion,raceKey,3,1,"available","2026-01-01T00:00:00.000Z","2026-02-01T00:00:00.000Z").run();
    await db.prepare(`INSERT INTO workspace_erasure_tombstones(tenant_id,space_id,project_id,tombstone_id,jurisdiction,status,requested_at,updated_at)
      VALUES(?,?,?,?,?,'pending',?,?)`).bind(scope.tenantId,scope.spaceId,scope.projectId,"tombstone-cleanup","global",
        "2026-01-03T00:00:00.000Z","2026-01-03T00:00:00.000Z").run();
    storage.loseNextDeleteAcknowledgment();
    expect(await eraseProjectPrivateStateBackups(db, bindings, scope)).toMatchObject({ deleted: 0, pending: 1, examined: 1 });
    expect(storage.objects.has(raceKey)).toBe(false);
    await expect(readPrivateStateBackup(db, { ...bindings, enabled: "true", key: config.key, keyVersion: config.keyVersion,
      jurisdiction: "global", retentionDays: "30", quotaBytes: "1000000" }, scope, { backupId: raceBackupId,
      allocationGeneration: 3, imageFingerprint: "a".repeat(64), toolchainFingerprint: "b".repeat(64) }))
      .rejects.toThrow("project_main_private_state_erased");
    expect(await eraseProjectPrivateStateBackups(db, bindings, scope)).toMatchObject({ deleted: 1, pending: 0, examined: 1 });
    expect(await db.prepare("SELECT state FROM project_main_private_state_backups WHERE backup_id=?").bind(raceBackupId).first())
      .toEqual({ state: "deleted" });
  });
});
