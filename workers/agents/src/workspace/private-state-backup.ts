import { validateWorkspaceScope, type WorkspaceScope } from "./workspace-contract.js";

export type PrivateStateSelection = { paths: string[]; version: number; updatedBy: string | null; updatedAt: string | null };
export type PrivateStateBackupBindings = {
  enabled?: string;
  key?: string;
  keyVersion?: string;
  jurisdiction?: string;
  globalBucket?: R2Bucket;
  euBucket?: R2Bucket;
  retentionDays?: string;
  quotaBytes?: string;
};
export type PrivateStateBackupConfig = {
  enabled: true;
  key: string;
  keyVersion: string;
  retentionDays: number;
  quotaBytes: number;
  bucket: R2Bucket;
};
export type PrivateStateBackupMetadata = {
  backupId: string;
  requestId: string;
  allocationGeneration: number;
  imageFingerprint: string;
  toolchainFingerprint: string;
  createdAt: string;
  expiresAt: string;
};
export type PrivateStateBackupFile = { path: string; bytes: Uint8Array };
export type PrivateStateManifestScope = Pick<WorkspaceScope, "tenantId" | "spaceId" | "projectId">;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN = /(?:^|\/)(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.config|browser|browser-profile|cache|caches|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|tokens?(?:\.[^/]*)?|cookies?(?:\.[^/]*)?|sessions?(?:\.[^/]*)?|node_modules|\.npm|\.pnpm|\.yarn)(?:\/|$)/i;
const SECRET_FIELD = /(?:^|[\s"'_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:entication|orization)?|password|passwd|secret|credential|cookie|private[_-]?key)(?:[\s"'_-]|$)\s*[:=]/i;
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b|\beyJ[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b)/;
const MAX_PATHS = 20;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;

function validateManifestScope(scope: PrivateStateManifestScope): void {
  if (!scope || !ID.test(scope.tenantId) || !ID.test(scope.spaceId) || !ID.test(scope.projectId))
    throw new Error("project_main_private_state_scope_invalid");
}

export async function readPrivateStateSelection(db: Pick<D1Database, "prepare">, scope: PrivateStateManifestScope): Promise<PrivateStateSelection> {
  validateManifestScope(scope);
  const row = await db.prepare(`SELECT paths_json,version,updated_by,updated_at FROM project_main_private_state_manifests
    WHERE tenant_id=? AND space_id=? AND project_id=?`).bind(scope.tenantId, scope.spaceId, scope.projectId)
    .first<{ paths_json: string; version: number; updated_by: string; updated_at: string }>();
  if (!row) return { paths: [], version: 0, updatedBy: null, updatedAt: null };
  let paths: string[];
  try { paths = validatePrivateStatePaths(JSON.parse(row.paths_json)); }
  catch { throw new Error("project_main_private_state_manifest_corrupt"); }
  if (JSON.stringify(paths) !== row.paths_json || !Number.isSafeInteger(row.version) || row.version < 1
    || !ID.test(row.updated_by) || !Number.isFinite(Date.parse(row.updated_at))) throw new Error("project_main_private_state_manifest_corrupt");
  return { paths, version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function savePrivateStateSelection(
  db: Pick<D1Database, "prepare" | "batch">,
  scope: PrivateStateManifestScope,
  input: { paths: unknown; expectedVersion: number; actorId: string },
  now = new Date(),
): Promise<{ paths: string[]; version: number; changed: boolean }> {
  validateManifestScope(scope);
  if (!ID.test(input.actorId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
    throw new Error("project_main_private_state_manifest_invalid");
  const paths = validatePrivateStatePaths(input.paths);
  const prior = await readPrivateStateSelection(db, scope);
  if (prior.version !== input.expectedVersion) throw new Error("project_main_private_state_manifest_version_conflict");
  if (JSON.stringify(prior.paths) === JSON.stringify(paths) && prior.version > 0) return { paths, version: prior.version, changed: false };
  const version = prior.version + 1;
  const at = now.toISOString();
  const pathsJson = JSON.stringify(paths);
  const manifestHash = await sha256(new TextEncoder().encode(pathsJson));
  const auditId = `pmsma_${crypto.randomUUID().replaceAll("-", "")}`;
  const results = await db.batch([
    db.prepare(`INSERT INTO project_main_private_state_manifests(tenant_id,space_id,project_id,paths_json,version,updated_by,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,space_id,project_id) DO UPDATE SET
      paths_json=excluded.paths_json,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at
      WHERE project_main_private_state_manifests.version=?`)
      .bind(scope.tenantId,scope.spaceId,scope.projectId,pathsJson,version,input.actorId,at,prior.version),
    db.prepare(`INSERT INTO project_main_private_state_manifest_audit(id,tenant_id,space_id,project_id,previous_version,new_version,path_count,manifest_sha256,actor_id,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,? FROM project_main_private_state_manifests WHERE tenant_id=? AND space_id=? AND project_id=?
      AND version=? AND paths_json=? AND updated_by=?`)
      .bind(auditId,scope.tenantId,scope.spaceId,scope.projectId,prior.version,version,paths.length,manifestHash,input.actorId,at,
        scope.tenantId,scope.spaceId,scope.projectId,version,pathsJson,input.actorId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
    throw new Error("project_main_private_state_manifest_version_conflict");
  return { paths, version, changed: true };
}

export function validatePrivateStatePaths(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_PATHS) throw new Error("project_main_private_state_paths_invalid");
  const paths = input.map((value) => {
    if (typeof value !== "string" || value.length > 192 || value.includes("\\") || value.startsWith("/")
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")
      || FORBIDDEN.test(value)) throw new Error("project_main_private_state_paths_invalid");
    return value;
  });
  if (new Set(paths).size !== paths.length || JSON.stringify(paths).length > 8192) throw new Error("project_main_private_state_paths_invalid");
  return paths.sort();
}

export function privateStateBackupConfig(
  bindings: PrivateStateBackupBindings,
  jurisdiction: "global" | "eu",
): PrivateStateBackupConfig {
  if (bindings.enabled !== "true") throw new Error("project_main_private_state_backup_disabled");
  if (bindings.jurisdiction !== jurisdiction) throw new Error("project_main_private_state_jurisdiction_unconfigured");
  const bucket = jurisdiction === "eu" ? bindings.euBucket : bindings.globalBucket;
  if (!bucket) throw new Error("project_main_private_state_bucket_unavailable");
  if (typeof bindings.key !== "string" || bindings.key.length < 32 || !KEY_VERSION.test(bindings.keyVersion ?? ""))
    throw new Error("project_main_private_state_key_unavailable");
  const retentionDays = Number(bindings.retentionDays);
  const quotaBytes = Number(bindings.quotaBytes);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365
    || !Number.isSafeInteger(quotaBytes) || quotaBytes < 1 || quotaBytes > 100 * 1024 * 1024) {
    throw new Error("project_main_private_state_limits_unconfigured");
  }
  return { enabled: true, key: bindings.key, keyVersion: bindings.keyVersion!, retentionDays, quotaBytes, bucket };
}

export function privateStateBackupAvailability(bindings: PrivateStateBackupBindings, jurisdiction: "global" | "eu"):
  { enabled: true; retentionDays: number; quotaBytes: number } | { enabled: false; reason: string } {
  try {
    const config = privateStateBackupConfig(bindings, jurisdiction);
    return { enabled: true, retentionDays: config.retentionDays, quotaBytes: config.quotaBytes };
  } catch (error) {
    return { enabled: false, reason: error instanceof Error ? error.message : "project_main_private_state_backup_unavailable" };
  }
}

export function validatePrivateStateCapture(
  selectedPaths: string[],
  files: PrivateStateBackupFile[],
): PrivateStateBackupFile[] {
  const allowed = new Set(validatePrivateStatePaths(selectedPaths));
  if (!Array.isArray(files) || files.length > allowed.size) throw new Error("project_main_private_state_capture_invalid");
  const seen = new Set<string>();
  let total = 0;
  const checked = files.map(file => {
    if (!file || typeof file !== "object" || !allowed.has(file.path) || seen.has(file.path)
      || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error("project_main_private_state_capture_invalid");
    }
    seen.add(file.path);
    total += file.bytes.byteLength;
    assertNonSecretText(file.bytes);
    return { path: file.path, bytes: file.bytes };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (!checked.length || total > MAX_TOTAL_BYTES) throw new Error("project_main_private_state_capture_empty_or_oversized");
  return checked;
}

export function privateStateBackupObjectKey(scope: WorkspaceScope, backupId: string): string {
  if (!validateWorkspaceScope(scope) || !ID.test(backupId)) throw new Error("project_main_private_state_scope_invalid");
  return `project-main-private-state/v1/${scope.jurisdiction}/${encodeURIComponent(scope.tenantId)}/${encodeURIComponent(scope.spaceId)}/${encodeURIComponent(scope.projectId)}/${backupId}.enc`;
}

type PrivateStateEnvelope = {
  format: "naelao-project-main-private-state";
  version: 1;
  scope: WorkspaceScope;
  backupId: string;
  requestId: string;
  allocationGeneration: number;
  imageFingerprint: string;
  toolchainFingerprint: string;
  keyVersion: string;
  createdAt: string;
  expiresAt: string;
  iv: string;
  ciphertext: string;
};

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
  return btoa(text);
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
function assertNonSecretText(bytes: Uint8Array): void {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new Error("project_main_private_state_content_unsupported"); }
  if (SECRET_FIELD.test(text) || SECRET_VALUE.test(text)) throw new Error("project_main_private_state_secret_material_rejected");
}
function aadFor(envelope: Pick<PrivateStateEnvelope, "scope" | "backupId" | "requestId" | "allocationGeneration" | "imageFingerprint" | "toolchainFingerprint" | "keyVersion" | "createdAt" | "expiresAt">): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(["private-state-v1", envelope.scope.tenantId, envelope.scope.spaceId,
    envelope.scope.projectId, envelope.scope.jurisdiction, envelope.backupId, envelope.requestId,
    envelope.allocationGeneration, envelope.imageFingerprint, envelope.toolchainFingerprint, envelope.keyVersion,
    envelope.createdAt, envelope.expiresAt]));
}
async function encryptionKey(secret: string, scope: WorkspaceScope, keyVersion: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}\0${scope.jurisdiction}`));
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(`naelao-private-state:${keyVersion}`) },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptPrivateStateBackup(
  scope: WorkspaceScope,
  metadata: PrivateStateBackupMetadata,
  selectedPaths: string[],
  files: PrivateStateBackupFile[],
  config: PrivateStateBackupConfig,
): Promise<Uint8Array> {
  if (!validateWorkspaceScope(scope) || !ID.test(metadata.backupId) || !ID.test(metadata.requestId)
    || !Number.isSafeInteger(metadata.allocationGeneration) || metadata.allocationGeneration < 0
    || !HASH.test(metadata.imageFingerprint) || !HASH.test(metadata.toolchainFingerprint)
    || !Number.isFinite(Date.parse(metadata.createdAt)) || !Number.isFinite(Date.parse(metadata.expiresAt))
    || Date.parse(metadata.expiresAt) <= Date.parse(metadata.createdAt)) throw new Error("project_main_private_state_metadata_invalid");
  const checked = validatePrivateStateCapture(selectedPaths, files);
  const plain = new TextEncoder().encode(JSON.stringify({ version: 1, files: checked.map(file => ({ path: file.path, bytes: toBase64(file.bytes) })) }));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const envelope: PrivateStateEnvelope = { format: "naelao-project-main-private-state", version: 1, scope,
    backupId: metadata.backupId, requestId: metadata.requestId, allocationGeneration: metadata.allocationGeneration,
    imageFingerprint: metadata.imageFingerprint, toolchainFingerprint: metadata.toolchainFingerprint,
    keyVersion: config.keyVersion, createdAt: metadata.createdAt, expiresAt: metadata.expiresAt,
    iv: toBase64(iv), ciphertext: "" };
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadFor(envelope) },
    await encryptionKey(config.key, scope, config.keyVersion), plain);
  envelope.ciphertext = toBase64(new Uint8Array(ciphertext));
  const encoded = new TextEncoder().encode(JSON.stringify(envelope));
  if (encoded.byteLength > config.quotaBytes) throw new Error("project_main_private_state_quota_exceeded");
  return encoded;
}

export async function decryptPrivateStateBackup(
  bytes: Uint8Array,
  expected: { scope: WorkspaceScope; backupId: string; allocationGeneration: number; imageFingerprint: string; toolchainFingerprint: string; now?: number },
  config: PrivateStateBackupConfig,
): Promise<{ metadata: PrivateStateBackupMetadata; files: PrivateStateBackupFile[] }> {
  let envelope: PrivateStateEnvelope;
  try { envelope = JSON.parse(new TextDecoder().decode(bytes)) as PrivateStateEnvelope; }
  catch { throw new Error("project_main_private_state_envelope_invalid"); }
  const sameScope = validateWorkspaceScope(expected.scope) && validateWorkspaceScope(envelope?.scope)
    && envelope.scope.tenantId === expected.scope.tenantId && envelope.scope.spaceId === expected.scope.spaceId
    && envelope.scope.projectId === expected.scope.projectId && envelope.scope.jurisdiction === expected.scope.jurisdiction;
  if (!envelope || envelope.format !== "naelao-project-main-private-state" || envelope.version !== 1
    || !sameScope || envelope.backupId !== expected.backupId
    || envelope.keyVersion !== config.keyVersion || !ID.test(envelope.requestId)
    || !Number.isSafeInteger(envelope.allocationGeneration) || envelope.allocationGeneration < 0
    || envelope.allocationGeneration > expected.allocationGeneration
    || envelope.imageFingerprint !== expected.imageFingerprint || envelope.toolchainFingerprint !== expected.toolchainFingerprint
    || !Number.isFinite(Date.parse(envelope.createdAt)) || !Number.isFinite(Date.parse(envelope.expiresAt))
    || Date.parse(envelope.expiresAt) <= (expected.now ?? Date.now())) throw new Error("project_main_private_state_restore_incompatible");
  try {
    const iv = fromBase64(envelope.iv);
    if (iv.byteLength !== 12) throw new Error("invalid_iv");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aadFor(envelope) },
      await encryptionKey(config.key, expected.scope, envelope.keyVersion), fromBase64(envelope.ciphertext));
    const payload = JSON.parse(new TextDecoder().decode(plain)) as { version?: unknown; files?: unknown };
    if (payload.version !== 1 || !Array.isArray(payload.files)) throw new Error("invalid_payload");
    const files = payload.files.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_file");
      const file = value as { path?: unknown; bytes?: unknown };
      if (typeof file.path !== "string" || typeof file.bytes !== "string") throw new Error("invalid_file");
      return { path: file.path, bytes: fromBase64(file.bytes) };
    });
    return { metadata: { backupId: envelope.backupId, requestId: envelope.requestId,
      allocationGeneration: envelope.allocationGeneration, imageFingerprint: envelope.imageFingerprint,
      toolchainFingerprint: envelope.toolchainFingerprint, createdAt: envelope.createdAt, expiresAt: envelope.expiresAt },
      files: validatePrivateStateCapture(files.map(file => file.path), files) };
  } catch { throw new Error("project_main_private_state_authentication_failed"); }
}

export function validatePrivateStateRestoreAuthority(input: {
  erased: boolean;
  generation: number;
  imageFingerprint: string;
  toolchainFingerprint: string;
  backupGeneration: number;
  backupImageFingerprint: string;
  backupToolchainFingerprint: string;
}): void {
  if (input.erased) throw new Error("project_main_private_state_erased");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 || input.backupGeneration < 0
    || input.backupGeneration > input.generation || input.imageFingerprint !== input.backupImageFingerprint
    || input.toolchainFingerprint !== input.backupToolchainFingerprint) throw new Error("project_main_private_state_restore_incompatible");
}

type PrivateStateBackupRow = {
  backup_id: string;
  request_id: string;
  tenant_id: string;
  space_id: string;
  project_id: string;
  jurisdiction: "global" | "eu";
  allocation_generation: number;
  image_fingerprint: string;
  toolchain_fingerprint: string;
  key_version: string;
  object_key: string;
  ciphertext_bytes: number;
  file_count: number;
  state: "available" | "expired" | "erasure_notified" | "delete_pending" | "deleted";
  created_at: string;
  expires_at: string;
};

async function projectHasErasureTombstone(db: Pick<D1Database, "prepare">, scope: WorkspaceScope): Promise<boolean> {
  const tombstone = await db.prepare(`SELECT 1 AS erased FROM workspace_erasure_tombstones
    WHERE tenant_id=? AND space_id=? AND project_id=? LIMIT 1`).bind(scope.tenantId, scope.spaceId, scope.projectId).first();
  return Boolean(tombstone);
}

function publicBackup(row: PrivateStateBackupRow) {
  return { backupId: row.backup_id, requestId: row.request_id, allocationGeneration: row.allocation_generation,
    imageFingerprint: row.image_fingerprint, toolchainFingerprint: row.toolchain_fingerprint,
    createdAt: row.created_at, expiresAt: row.expires_at, ciphertextBytes: row.ciphertext_bytes,
    fileCount: row.file_count, state: row.state };
}

export async function createPrivateStateBackup(
  db: Pick<D1Database, "prepare" | "batch">,
  bindings: PrivateStateBackupBindings,
  scope: WorkspaceScope,
  input: { requestId: string; expectedManifestVersion: number; allocationGeneration: number; imageFingerprint: string; toolchainFingerprint: string; files: PrivateStateBackupFile[] },
  now = new Date(),
): Promise<ReturnType<typeof publicBackup>> {
  if (!validateWorkspaceScope(scope) || !ID.test(input.requestId) || !Number.isSafeInteger(input.expectedManifestVersion)
    || input.expectedManifestVersion < 1 || !Number.isSafeInteger(input.allocationGeneration) || input.allocationGeneration < 1
    || !HASH.test(input.imageFingerprint) || !HASH.test(input.toolchainFingerprint)) throw new Error("project_main_private_state_backup_request_invalid");
  const config = privateStateBackupConfig(bindings, scope.jurisdiction);
  if (await projectHasErasureTombstone(db, scope)) throw new Error("project_main_private_state_erased");
  const prior = await db.prepare(`SELECT backup_id,request_id,tenant_id,space_id,project_id,jurisdiction,allocation_generation,
      image_fingerprint,toolchain_fingerprint,key_version,object_key,ciphertext_bytes,file_count,state,created_at,expires_at
    FROM project_main_private_state_backups WHERE tenant_id=? AND space_id=? AND project_id=? AND request_id=?`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId,input.requestId).first<PrivateStateBackupRow>();
  if (prior) return publicBackup(prior);
  const registry = await db.prepare(`SELECT allocation_generation,state FROM project_main_runtime_registry
    WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_kind='dynamic_sandbox'`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId).first<{ allocation_generation: number; state: string }>();
  if (!registry || registry.state === "erased" || registry.allocation_generation !== input.allocationGeneration)
    throw new Error("project_main_private_state_generation_stale");
  const selection = await readPrivateStateSelection(db, scope);
  if (selection.version !== input.expectedManifestVersion || selection.paths.length === 0)
    throw new Error("project_main_private_state_selection_changed");
  const checked = validatePrivateStateCapture(selection.paths, input.files);

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const backupId = `pmsb_${(await sha256(new TextEncoder().encode(`${scope.tenantId}\0${scope.spaceId}\0${scope.projectId}\0${input.requestId}`))).slice(0, 40)}`;
  const metadata: PrivateStateBackupMetadata = { backupId, requestId: input.requestId,
    allocationGeneration: input.allocationGeneration, imageFingerprint: input.imageFingerprint,
    toolchainFingerprint: input.toolchainFingerprint, createdAt, expiresAt };
  const encoded = await encryptPrivateStateBackup(scope, metadata, selection.paths, checked, config);
  if (encoded.byteLength > config.quotaBytes) throw new Error("project_main_private_state_quota_exceeded");
  const quota = await db.prepare(`SELECT COALESCE(SUM(ciphertext_bytes),0) AS bytes FROM project_main_private_state_backups
    WHERE tenant_id=? AND space_id=? AND project_id=? AND state='available' AND expires_at>?`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId,createdAt).first<{ bytes: number }>();
  if (!Number.isSafeInteger(quota?.bytes ?? 0) || Number(quota?.bytes ?? 0) + encoded.byteLength > config.quotaBytes)
    throw new Error("project_main_private_state_quota_exceeded");
  const objectKey = privateStateBackupObjectKey(scope, backupId);
  let objectCreated = false;
  try {
    const put = await config.bucket.put(objectKey, encoded, { onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { keyVersion: config.keyVersion, backupId, requestId: input.requestId } });
    objectCreated = Boolean(put);
    if (!put) {
      const existing = await config.bucket.get(objectKey);
      if (!existing) throw new Error("project_main_private_state_object_write_uncertain");
      const existingBytes = new Uint8Array(await existing.arrayBuffer());
      const restored = await decryptPrivateStateBackup(existingBytes, { scope, backupId,
        allocationGeneration: input.allocationGeneration, imageFingerprint: input.imageFingerprint,
        toolchainFingerprint: input.toolchainFingerprint }, config);
      if (restored.metadata.requestId !== input.requestId) throw new Error("project_main_private_state_object_conflict");
    }
    const inserted = await db.prepare(`INSERT INTO project_main_private_state_backups(
        backup_id,request_id,tenant_id,space_id,project_id,jurisdiction,allocation_generation,image_fingerprint,
        toolchain_fingerprint,key_version,object_key,ciphertext_bytes,file_count,state,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE
        COALESCE((SELECT SUM(ciphertext_bytes) FROM project_main_private_state_backups
          WHERE tenant_id=? AND space_id=? AND project_id=? AND state='available' AND expires_at>?),0)+?<=?
        AND EXISTS(SELECT 1 FROM project_main_runtime_registry WHERE tenant_id=? AND space_id=? AND project_id=?
          AND runtime_kind='dynamic_sandbox' AND allocation_generation=? AND state<>'erased')
        AND NOT EXISTS(SELECT 1 FROM workspace_erasure_tombstones WHERE tenant_id=? AND space_id=? AND project_id=?)
      ON CONFLICT(tenant_id,space_id,project_id,request_id) DO NOTHING`)
      .bind(backupId,input.requestId,scope.tenantId,scope.spaceId,scope.projectId,scope.jurisdiction,input.allocationGeneration,
        input.imageFingerprint,input.toolchainFingerprint,config.keyVersion,objectKey,encoded.byteLength,checked.length,"available",createdAt,expiresAt,
        scope.tenantId,scope.spaceId,scope.projectId,createdAt,encoded.byteLength,config.quotaBytes,
        scope.tenantId,scope.spaceId,scope.projectId,input.allocationGeneration,
        scope.tenantId,scope.spaceId,scope.projectId).run();
    if (!inserted.meta.changes) {
      const recovered = await db.prepare(`SELECT backup_id,request_id,tenant_id,space_id,project_id,jurisdiction,allocation_generation,
          image_fingerprint,toolchain_fingerprint,key_version,object_key,ciphertext_bytes,file_count,state,created_at,expires_at
        FROM project_main_private_state_backups WHERE tenant_id=? AND space_id=? AND project_id=? AND request_id=?`)
        .bind(scope.tenantId,scope.spaceId,scope.projectId,input.requestId).first<PrivateStateBackupRow>();
      if (recovered) return publicBackup(recovered);
      if (await projectHasErasureTombstone(db, scope)) throw new Error("project_main_private_state_erased");
      const currentRegistry = await db.prepare(`SELECT allocation_generation,state FROM project_main_runtime_registry
        WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_kind='dynamic_sandbox'`)
        .bind(scope.tenantId,scope.spaceId,scope.projectId).first<{ allocation_generation: number; state: string }>();
      if (!currentRegistry || currentRegistry.state === "erased" || currentRegistry.allocation_generation !== input.allocationGeneration)
        throw new Error("project_main_private_state_generation_stale");
      throw new Error("project_main_private_state_quota_exceeded");
    }
    return publicBackup({ backup_id: metadata.backupId, request_id: metadata.requestId,
      tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId, jurisdiction: scope.jurisdiction,
      allocation_generation: metadata.allocationGeneration, image_fingerprint: metadata.imageFingerprint,
      toolchain_fingerprint: metadata.toolchainFingerprint, key_version: config.keyVersion, object_key: objectKey,
      ciphertext_bytes: encoded.byteLength, file_count: checked.length, state: "available",
      created_at: metadata.createdAt, expires_at: metadata.expiresAt });
  } catch (error) {
    if (objectCreated) await config.bucket.delete(objectKey).catch(() => undefined);
    throw error;
  }
}

export async function readPrivateStateBackup(
  db: Pick<D1Database, "prepare">,
  bindings: PrivateStateBackupBindings,
  scope: WorkspaceScope,
  input: { backupId: string; allocationGeneration: number; imageFingerprint: string; toolchainFingerprint: string },
  now = Date.now(),
): Promise<{ metadata: PrivateStateBackupMetadata; files: PrivateStateBackupFile[] }> {
  if (!validateWorkspaceScope(scope) || !ID.test(input.backupId)) throw new Error("project_main_private_state_scope_invalid");
  const config = privateStateBackupConfig(bindings, scope.jurisdiction);
  if (await projectHasErasureTombstone(db, scope)) throw new Error("project_main_private_state_erased");
  const row = await db.prepare(`SELECT backup_id,request_id,tenant_id,space_id,project_id,jurisdiction,allocation_generation,
      image_fingerprint,toolchain_fingerprint,key_version,object_key,ciphertext_bytes,file_count,state,created_at,expires_at
    FROM project_main_private_state_backups WHERE backup_id=? AND tenant_id=? AND space_id=? AND project_id=?`)
    .bind(input.backupId,scope.tenantId,scope.spaceId,scope.projectId).first<PrivateStateBackupRow>();
  if (!row || row.state !== "available" || row.jurisdiction !== scope.jurisdiction
    || row.expires_at !== new Date(Date.parse(row.expires_at)).toISOString() || Date.parse(row.expires_at) <= now)
    throw new Error("project_main_private_state_backup_unavailable");
  const registry = await db.prepare(`SELECT allocation_generation,state FROM project_main_runtime_registry
    WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_kind='dynamic_sandbox'`)
    .bind(scope.tenantId,scope.spaceId,scope.projectId).first<{ allocation_generation: number; state: string }>();
  if (!registry || registry.state === "erased" || registry.allocation_generation !== input.allocationGeneration)
    throw new Error("project_main_private_state_generation_stale");
  validatePrivateStateRestoreAuthority({ erased: false, generation: registry.allocation_generation,
    imageFingerprint: input.imageFingerprint, toolchainFingerprint: input.toolchainFingerprint,
    backupGeneration: row.allocation_generation, backupImageFingerprint: row.image_fingerprint,
    backupToolchainFingerprint: row.toolchain_fingerprint });
  const object = await config.bucket.get(row.object_key);
  if (!object) throw new Error("project_main_private_state_object_unavailable");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== row.ciphertext_bytes) throw new Error("project_main_private_state_object_corrupt");
  const result = await decryptPrivateStateBackup(bytes, { scope, backupId: row.backup_id,
    allocationGeneration: input.allocationGeneration, imageFingerprint: input.imageFingerprint,
    toolchainFingerprint: input.toolchainFingerprint, now }, config);
  if (result.metadata.requestId !== row.request_id || result.files.length !== row.file_count)
    throw new Error("project_main_private_state_object_corrupt");
  const selection = await readPrivateStateSelection(db, scope);
  if (!selection.paths.length || result.files.some(file => !selection.paths.includes(file.path)))
    throw new Error("project_main_private_state_selection_changed");
  return result;
}

export type PrivateStateBackupCleanupResult = { deleted: number; pending: number; examined: number };

function backupBucket(bindings: PrivateStateBackupBindings, jurisdiction: "global" | "eu"): R2Bucket | undefined {
  return jurisdiction === "eu" ? bindings.euBucket : bindings.globalBucket;
}

/** Mark a project’s private-state objects for deletion and retry a bounded batch.
 * The ledger stays in delete_pending until R2 acknowledges deletion, so a lost
 * response is retried safely and a restore cannot race a pending deletion. */
export async function eraseProjectPrivateStateBackups(
  db: Pick<D1Database, "prepare">,
  bindings: PrivateStateBackupBindings,
  scope: WorkspaceScope,
  limit = 50,
): Promise<PrivateStateBackupCleanupResult> {
  if (!validateWorkspaceScope(scope) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("project_main_private_state_cleanup_scope_invalid");
  await db.prepare(`UPDATE project_main_private_state_backups SET state='delete_pending'
    WHERE backup_id IN (SELECT backup_id FROM project_main_private_state_backups
      WHERE tenant_id=? AND space_id=? AND project_id=? AND state IN ('available','expired','erasure_notified')
      ORDER BY created_at LIMIT ?)`)
    .bind(scope.tenantId, scope.spaceId, scope.projectId, limit).run();
  return deletePendingPrivateStateBackups(db, bindings, { scope, limit });
}

/** Expire and drain a globally bounded batch. Runs independently of backup enablement so
 * disabling new backups does not strand already-created encrypted objects. */
export async function sweepPrivateStateBackupRetention(
  db: Pick<D1Database, "prepare">,
  bindings: PrivateStateBackupBindings,
  now = new Date(),
  limit = 50,
): Promise<PrivateStateBackupCleanupResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("project_main_private_state_cleanup_limit_invalid");
  const at = now.toISOString();
  await db.prepare(`UPDATE project_main_private_state_backups SET state='expired'
    WHERE backup_id IN (SELECT backup_id FROM project_main_private_state_backups
      WHERE state='available' AND expires_at<=? ORDER BY expires_at LIMIT ?)`)
    .bind(at, limit).run();
  return deletePendingPrivateStateBackups(db, bindings, { limit });
}

async function deletePendingPrivateStateBackups(
  db: Pick<D1Database, "prepare">,
  bindings: PrivateStateBackupBindings,
  input: { scope?: WorkspaceScope; limit: number },
): Promise<PrivateStateBackupCleanupResult> {
  const whereScope = input.scope ? " AND tenant_id=? AND space_id=? AND project_id=?" : "";
  const bindScope = input.scope ? [input.scope.tenantId, input.scope.spaceId, input.scope.projectId] : [];
  const rows = await db.prepare(`SELECT backup_id,tenant_id,space_id,project_id,jurisdiction,object_key,state
    FROM project_main_private_state_backups WHERE state IN ('expired','erasure_notified','delete_pending')${whereScope}
    ORDER BY expires_at,created_at LIMIT ?`).bind(...bindScope, input.limit)
    .all<Pick<PrivateStateBackupRow, "backup_id" | "tenant_id" | "space_id" | "project_id" | "jurisdiction" | "object_key" | "state">>();
  let deleted = 0;
  let pending = 0;
  for (const row of rows.results ?? []) {
    const scope = { tenantId: row.tenant_id, spaceId: row.space_id, projectId: row.project_id, jurisdiction: row.jurisdiction };
    if (!validateWorkspaceScope(scope) || row.object_key !== privateStateBackupObjectKey(scope, row.backup_id)) {
      pending++;
      continue;
    }
    const bucket = backupBucket(bindings, scope.jurisdiction);
    if (!bucket) {
      pending++;
      continue;
    }
    try {
      await bucket.delete(row.object_key);
      const updated = await db.prepare(`UPDATE project_main_private_state_backups SET state='deleted'
        WHERE backup_id=? AND tenant_id=? AND space_id=? AND project_id=? AND state IN ('expired','erasure_notified','delete_pending')`)
        .bind(row.backup_id, row.tenant_id, row.space_id, row.project_id).run();
      if (updated.meta.changes) deleted++;
      else pending++;
    } catch {
      pending++;
    }
  }
  const remainingQuery = input.scope
    ? db.prepare(`SELECT COUNT(*) AS count FROM project_main_private_state_backups
        WHERE tenant_id=? AND space_id=? AND project_id=? AND state!='deleted'`).bind(...bindScope)
    : db.prepare(`SELECT COUNT(*) AS count FROM project_main_private_state_backups
        WHERE state IN ('expired','erasure_notified','delete_pending')`);
  const remaining = await remainingQuery.first<{ count: number }>();
  return { deleted, pending: Math.max(pending, Number(remaining?.count ?? 0)), examined: rows.results?.length ?? 0 };
}
