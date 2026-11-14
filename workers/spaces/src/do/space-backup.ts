export interface SpaceArchivePayload {
  format: "naelao-space-archive";
  formatVersion: 1 | 2;
  tenantId: string;
  spaceId: string;
  archiveId: string;
  createdAt: string;
  migrationVersion: number;
  tableRows: Record<string, Array<Record<string, unknown>>>;
  rowCounts: Record<string, number>;
  objectReferences: Array<{ key: string; etag: string; size: number }>;
  /** Committed project workspace heads and merge bases from WorkspaceCoordinatorDO. */
  workspaceSnapshots?: SpaceArchiveWorkspaceSnapshot[];
  /** Absent only in legacy archives written before object-byte capture was added. */
  objectSnapshots?: Array<SpaceArchiveObjectSnapshot | SpaceArchiveChunkedObjectSnapshot>;
  selectionFingerprint?: string;
}

export interface SpaceArchiveWorkspaceSnapshot {
  version: 1;
  projectId: string;
  jurisdiction: "global" | "eu";
  policyGeneration: number;
  branches: Array<{
    head: {
      version: 1;
      branch: string;
      revision: number;
      manifestHash: string;
      parentRevision: number | null;
      publicationId: string | null;
      updatedAt: string;
    };
    base: { parentBranch: string; revision: number; manifestHash: string } | null;
  }>;
}

export interface SpaceArchiveObjectSnapshot {
  key: string;
  etag: string;
  size: number;
  checksum: string;
  bytesBase64: string;
  httpMetadata?: Omit<R2HTTPMetadata, "cacheExpiry"> & { cacheExpiry?: string };
  customMetadata?: Record<string, string>;
}

/** Version 2 keeps object bytes out of the encrypted manifest and stores each encrypted chunk
 *  under the archive's tenant/Space/archive prefix in R2. The descriptor contains no provider
 *  object IDs: callers derive each key from its position in the authenticated manifest. */
export interface SpaceArchiveChunkedObjectSnapshot {
  key: string;
  etag: string;
  size: number;
  checksum: string;
  objectIndex: number;
  chunkKeyVersion: string;
  chunkBytes: number;
  chunks: Array<{ checksum: string; plaintextBytes: number }>;
  httpMetadata?: SpaceArchiveObjectSnapshot["httpMetadata"];
  customMetadata?: Record<string, string>;
}

export interface SpaceArchiveEncryptedChunk { key: string; bytes: Uint8Array; }

interface ArchiveEnvelope {
  format: "naelao-space-archive-envelope";
  formatVersion: 1;
  tenantId: string;
  spaceId: string;
  archiveId: string;
  payloadVersion?: 1 | 2;
  keyVersion: string;
  iv: string;
  checksum: string;
  ciphertext: string;
}

export interface SpaceArchiveKeyring {
  active: { version: string; secret: string };
  keys: Record<string, string | string[]>;
}

export function spaceArchiveKeyringFromBindings(bindings: {
  platformSecret: string; activeKey?: string; activeVersion?: string;
  previousKey?: string; previousVersion?: string;
}): SpaceArchiveKeyring {
  const activeSecret = bindings.activeKey || bindings.platformSecret;
  const activeVersion = bindings.activeVersion || (bindings.activeKey ? "space-archive-current-v1" : "platform-secret-hkdf-v1");
  const keys: Record<string, string | string[]> = { [activeVersion]: activeSecret };
  if (bindings.previousKey) {
    const previousVersion = bindings.previousVersion || "platform-secret-hkdf-v1";
    keys[previousVersion] = bindings.previousKey;
  }
  // Legacy envelopes used one fixed label regardless of which deployment secret encrypted them.
  keys["platform-secret-hkdf-v1"] = [...new Set([bindings.previousKey, activeSecret, bindings.platformSecret].filter((value): value is string => Boolean(value)))];
  if (Object.keys(keys).some(version => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version))) throw new Error("archive_key_version_invalid");
  if (Object.values(keys).some(value => (Array.isArray(value) ? value : [value]).some(secret => secret.length < 32))) throw new Error("archive_encryption_key_unavailable");
  return { active: { version: activeVersion, secret: activeSecret }, keys };
}

type ArchiveKeys = string | SpaceArchiveKeyring;
export function spaceArchiveKeyVersion(bytes: Uint8Array): string | null {
  try {
    const envelope = JSON.parse(new TextDecoder().decode(bytes)) as { format?: string; formatVersion?: number; keyVersion?: unknown };
    return envelope.format === "naelao-space-archive-envelope" && envelope.formatVersion === 1 && typeof envelope.keyVersion === "string" ? envelope.keyVersion : null;
  } catch { return null; }
}
function activeArchiveKey(keys: ArchiveKeys): { version: string; secret: string } {
  return typeof keys === "string" ? { version: "platform-secret-hkdf-v1", secret: keys } : keys.active;
}
function archiveKeysForVersion(keys: ArchiveKeys, version: string): string[] {
  if (typeof keys === "string") {
    if (version !== "platform-secret-hkdf-v1") throw new Error("archive_key_version_unavailable");
    return [keys];
  }
  const secrets = keys.keys[version];
  if (!secrets) throw new Error("archive_key_version_unavailable");
  return Array.isArray(secrets) ? secrets : [secrets];
}

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ENCRYPTED_ARCHIVE_BYTES = MAX_ARCHIVE_BYTES * 2;
const MULTIPART_PART_BYTES = 5 * 1024 * 1024;
export const MAX_ARCHIVE_OBJECT_BYTES = 2 * 1024 * 1024;
export const MAX_ARCHIVE_OBJECT_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_CHUNKED_OBJECT_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_CHUNKED_CAPTURE_BYTES = 64 * 1024 * 1024;
export const ARCHIVE_OBJECT_CHUNK_BYTES = 512 * 1024;

/** R2 archive loads must check object metadata before allocating the encrypted body. */
export async function readSpaceArchiveObject(
  object: Pick<R2ObjectBody, "size" | "arrayBuffer">
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_ENCRYPTED_ARCHIVE_BYTES)
    throw new Error("archive_size_limit_exceeded");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size || bytes.byteLength > MAX_ENCRYPTED_ARCHIVE_BYTES)
    throw new Error("archive_size_mismatch");
  return bytes;
}

export interface ResumableArchiveUploadState { uploadId: string | null; completedParts: R2UploadedPart[]; }

/** Upload an immutable encrypted byte sequence and checkpoint each completed multipart part. */
export async function uploadArchiveResumable(bucket: R2Bucket, key: string, bytes: Uint8Array, state: ResumableArchiveUploadState, persist: (state: ResumableArchiveUploadState) => void): Promise<void> {
  if (bytes.byteLength <= MULTIPART_PART_BYTES) {
    await bucket.put(key, bytes, { httpMetadata: { contentType: "application/vnd.naelao.space-archive+json" } });
    return;
  }
  let upload: R2MultipartUpload;
  if (state.uploadId) upload = bucket.resumeMultipartUpload(key, state.uploadId);
  else {
    upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/vnd.naelao.space-archive+json" } });
    state.uploadId = upload.uploadId;
    persist(state);
  }
  const completed = new Map(state.completedParts.map(part => [part.partNumber, part]));
  const partCount = Math.ceil(bytes.byteLength / MULTIPART_PART_BYTES);
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    if (completed.has(partNumber)) continue;
    const start = (partNumber - 1) * MULTIPART_PART_BYTES;
    const part = await upload.uploadPart(partNumber, bytes.subarray(start, Math.min(start + MULTIPART_PART_BYTES, bytes.byteLength)));
    completed.set(partNumber, part);
    state.completedParts = [...completed.values()].sort((a, b) => a.partNumber - b.partNumber);
    persist(state);
  }
  await upload.complete([...completed.values()].sort((a, b) => a.partNumber - b.partNumber));
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

export async function spaceArchiveChecksum(payload: SpaceArchivePayload): Promise<string> {
  return sha256(new TextEncoder().encode(stable(payload)));
}

/** Order included tables by FK dependency; return null for cycles so restore can fail before writes. */
export function topologicalRestoreOrder(tables: readonly string[], dependencies: Readonly<Record<string, readonly string[]>>): string[] | null {
  const included = new Set(tables);
  const pending = new Set(tables);
  const ordered: string[] = [];
  while (pending.size) {
    const ready = [...pending].filter(table => (dependencies[table] ?? []).every(parent => !included.has(parent) || !pending.has(parent))).sort();
    if (!ready.length) return null;
    for (const table of ready) { pending.delete(table); ordered.push(table); }
  }
  return ordered;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function checksumSpaceArchiveObject(object: Pick<R2ObjectBody, "size" | "arrayBuffer">): Promise<string> {
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_ARCHIVE_CHUNKED_OBJECT_BYTES) throw new Error("archive_object_capture_limit_exceeded");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size) throw new Error("archive_object_size_mismatch");
  return sha256(bytes);
}

/** Capture one bounded R2 body and bind its bytes to the listed object identity. */
export async function captureSpaceArchiveObject(
  object: Pick<R2ObjectBody, "etag" | "size" | "arrayBuffer" | "httpMetadata" | "customMetadata">,
  key: string,
): Promise<SpaceArchiveObjectSnapshot> {
  if (!key || !Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_ARCHIVE_OBJECT_BYTES) {
    throw new Error("archive_object_capture_limit_exceeded");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size) throw new Error("archive_object_size_mismatch");
  const metadata = object.httpMetadata;
  const httpMetadata: SpaceArchiveObjectSnapshot["httpMetadata"] = metadata ? {
    ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
    ...(metadata.contentLanguage ? { contentLanguage: metadata.contentLanguage } : {}),
    ...(metadata.contentDisposition ? { contentDisposition: metadata.contentDisposition } : {}),
    ...(metadata.contentEncoding ? { contentEncoding: metadata.contentEncoding } : {}),
    ...(metadata.cacheControl ? { cacheControl: metadata.cacheControl } : {}),
    ...(metadata.cacheExpiry ? { cacheExpiry: metadata.cacheExpiry.toISOString() } : {}),
  } : undefined;
  return {
    key, etag: object.etag, size: object.size, checksum: await sha256(bytes), bytesBase64: base64(bytes),
    ...(httpMetadata ? { httpMetadata } : {}),
    ...(object.customMetadata ? { customMetadata: { ...object.customMetadata } } : {}),
  };
}

/** Decode and authenticate captured bytes against the original R2 listing record. */
export async function decodeSpaceArchiveObjectSnapshot(
  snapshot: SpaceArchiveObjectSnapshot,
  expected: { key: string; etag: string; size: number },
): Promise<Uint8Array> {
  if (!snapshot || snapshot.key !== expected.key || snapshot.etag !== expected.etag || snapshot.size !== expected.size
    || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.size > MAX_ARCHIVE_OBJECT_BYTES
    || !/^[a-f0-9]{64}$/.test(snapshot.checksum) || typeof snapshot.bytesBase64 !== "string") {
    throw new Error("archive_object_snapshot_invalid");
  }
  if (snapshot.httpMetadata && (typeof snapshot.httpMetadata !== "object" || Array.isArray(snapshot.httpMetadata)
    || Object.entries(snapshot.httpMetadata).some(([key, value]) => !["contentType", "contentLanguage", "contentDisposition", "contentEncoding", "cacheControl", "cacheExpiry"].includes(key)
      || typeof value !== "string" || (key === "cacheExpiry" && !Number.isFinite(Date.parse(value)))))) throw new Error("archive_object_snapshot_invalid");
  if (snapshot.customMetadata && (typeof snapshot.customMetadata !== "object" || Array.isArray(snapshot.customMetadata)
    || Object.values(snapshot.customMetadata).some(value => typeof value !== "string"))) throw new Error("archive_object_snapshot_invalid");
  let bytes: Uint8Array;
  try { bytes = fromBase64(snapshot.bytesBase64); }
  catch { throw new Error("archive_object_snapshot_invalid"); }
  if (bytes.byteLength !== snapshot.size || await sha256(bytes) !== snapshot.checksum) throw new Error("archive_object_checksum_mismatch");
  return bytes;
}

function isChunkedObjectSnapshot(snapshot: SpaceArchiveObjectSnapshot | SpaceArchiveChunkedObjectSnapshot): snapshot is SpaceArchiveChunkedObjectSnapshot {
  return "objectIndex" in snapshot && "chunks" in snapshot;
}

function archiveChunkObjectKey(scope: { tenantId: string; spaceId: string; archiveId: string }, keyVersion: string, objectIndex: number, chunkIndex: number): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyVersion)) throw new Error("archive_key_version_invalid");
  return `space-archives/${scope.tenantId}/${scope.spaceId}/${scope.archiveId}.chunks/${keyVersion}/${objectIndex}/${chunkIndex}.enc`;
}

interface ArchiveChunkEnvelope {
  format: "naelao-space-archive-chunk-envelope";
  formatVersion: 1;
  tenantId: string;
  spaceId: string;
  archiveId: string;
  objectIndex: number;
  chunkIndex: number;
  keyVersion: string;
  iv: string;
  plaintextBytes: number;
  ciphertext: string;
}

async function encodeArchiveObjectChunk(
  plain: Uint8Array,
  scope: { tenantId: string; spaceId: string; archiveId: string; objectKey: string; objectIndex: number; chunkIndex: number },
  keys: ArchiveKeys,
  preparedKey?: { version: string; key: CryptoKey },
): Promise<Uint8Array> {
  const active = activeArchiveKey(keys);
  const key = preparedKey?.key ?? await archiveKey(active.secret, scope.tenantId, scope.spaceId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(`${scope.tenantId}:${scope.spaceId}:${scope.archiveId}:2:${scope.objectKey}:${scope.objectIndex}:${scope.chunkIndex}:${active.version}`);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, plain));
  const envelope: ArchiveChunkEnvelope = {
    format: "naelao-space-archive-chunk-envelope", formatVersion: 1,
    tenantId: scope.tenantId, spaceId: scope.spaceId, archiveId: scope.archiveId,
    objectIndex: scope.objectIndex, chunkIndex: scope.chunkIndex,
    keyVersion: active.version, iv: base64(iv), plaintextBytes: plain.byteLength, ciphertext: base64(ciphertext),
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/** Read one R2 object under a fixed per-object limit, then emit scoped encrypted chunks for an
 *  authenticated v2 manifest. Stable object keys make retries idempotent; source ETags are
 *  checked by the caller again before publishing the final manifest. */
export async function captureSpaceArchiveObjectChunked(
  object: Pick<R2ObjectBody, "etag" | "size" | "arrayBuffer" | "httpMetadata" | "customMetadata">,
  expected: { key: string; etag: string; size: number },
  objectIndex: number,
  scope: { tenantId: string; spaceId: string; archiveId: string },
  keys: ArchiveKeys,
): Promise<{ snapshot: SpaceArchiveChunkedObjectSnapshot; chunks: SpaceArchiveEncryptedChunk[] }> {
  if (!expected.key || object.etag !== expected.etag || object.size !== expected.size
    || !Number.isSafeInteger(objectIndex) || objectIndex < 0
    || !Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_ARCHIVE_CHUNKED_OBJECT_BYTES) {
    throw new Error("archive_object_capture_limit_exceeded");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== expected.size) throw new Error("archive_object_size_mismatch");
  const metadata = object.httpMetadata;
  const httpMetadata: SpaceArchiveObjectSnapshot["httpMetadata"] = metadata ? {
    ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
    ...(metadata.contentLanguage ? { contentLanguage: metadata.contentLanguage } : {}),
    ...(metadata.contentDisposition ? { contentDisposition: metadata.contentDisposition } : {}),
    ...(metadata.contentEncoding ? { contentEncoding: metadata.contentEncoding } : {}),
    ...(metadata.cacheControl ? { cacheControl: metadata.cacheControl } : {}),
    ...(metadata.cacheExpiry ? { cacheExpiry: metadata.cacheExpiry.toISOString() } : {}),
  } : undefined;
  const chunks: SpaceArchiveEncryptedChunk[] = [];
  const chunkDescriptors: SpaceArchiveChunkedObjectSnapshot["chunks"] = [];
  const active = activeArchiveKey(keys);
  const preparedKey = { version: active.version, key: await archiveKey(active.secret, scope.tenantId, scope.spaceId) };
  for (let offset = 0, chunkIndex = 0; offset < bytes.byteLength; offset += ARCHIVE_OBJECT_CHUNK_BYTES, chunkIndex++) {
    const plain = bytes.subarray(offset, Math.min(offset + ARCHIVE_OBJECT_CHUNK_BYTES, bytes.byteLength));
    const chunkBytes = await encodeArchiveObjectChunk(plain, { ...scope, objectKey: expected.key, objectIndex, chunkIndex }, keys, preparedKey);
    chunks.push({ key: archiveChunkObjectKey(scope, active.version, objectIndex, chunkIndex), bytes: chunkBytes });
    chunkDescriptors.push({ checksum: await sha256(plain), plaintextBytes: plain.byteLength });
  }
  return {
    snapshot: {
      key: expected.key, etag: expected.etag, size: expected.size, checksum: await sha256(bytes), objectIndex,
      chunkKeyVersion: active.version, chunkBytes: ARCHIVE_OBJECT_CHUNK_BYTES, chunks: chunkDescriptors,
      ...(httpMetadata ? { httpMetadata } : {}), ...(object.customMetadata ? { customMetadata: { ...object.customMetadata } } : {}),
    },
    chunks,
  };
}

async function decodeArchiveObjectChunk(
  stored: Pick<R2ObjectBody, "size" | "arrayBuffer">,
  expected: { checksum: string; plaintextBytes: number },
  scope: { tenantId: string; spaceId: string; archiveId: string; objectKey: string; objectIndex: number; chunkIndex: number },
  keys: ArchiveKeys,
  keyCache: Map<string, Promise<CryptoKey[]>>,
  expectedKeyVersion: string,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(stored.size) || stored.size < 0 || stored.size > ARCHIVE_OBJECT_CHUNK_BYTES * 2 + 4096) throw new Error("archive_chunk_size_limit_exceeded");
  const encoded = new Uint8Array(await stored.arrayBuffer());
  if (encoded.byteLength !== stored.size) throw new Error("archive_chunk_size_mismatch");
  let envelope: ArchiveChunkEnvelope;
  try { envelope = JSON.parse(new TextDecoder().decode(encoded)) as ArchiveChunkEnvelope; }
  catch { throw new Error("archive_chunk_envelope_invalid"); }
  if (envelope.format !== "naelao-space-archive-chunk-envelope" || envelope.formatVersion !== 1
    || envelope.tenantId !== scope.tenantId || envelope.spaceId !== scope.spaceId || envelope.archiveId !== scope.archiveId
    || envelope.objectIndex !== scope.objectIndex || envelope.chunkIndex !== scope.chunkIndex
    || envelope.keyVersion !== expectedKeyVersion || typeof envelope.keyVersion !== "string"
    || envelope.plaintextBytes !== expected.plaintextBytes || !Number.isSafeInteger(envelope.plaintextBytes)
    || envelope.plaintextBytes < 1 || envelope.plaintextBytes > ARCHIVE_OBJECT_CHUNK_BYTES
    ) throw new Error("archive_chunk_scope_or_manifest_mismatch");
  const iv = fromBase64(envelope.iv);
  if (iv.byteLength !== 12) throw new Error("archive_chunk_envelope_invalid");
  const ciphertext = fromBase64(envelope.ciphertext);
  const additionalData = new TextEncoder().encode(`${scope.tenantId}:${scope.spaceId}:${scope.archiveId}:2:${scope.objectKey}:${scope.objectIndex}:${scope.chunkIndex}:${envelope.keyVersion}`);
  let candidateKeys = keyCache.get(envelope.keyVersion);
  if (!candidateKeys) {
    candidateKeys = Promise.all(archiveKeysForVersion(keys, envelope.keyVersion).map(secret => archiveKey(secret, scope.tenantId, scope.spaceId)));
    keyCache.set(envelope.keyVersion, candidateKeys);
  }
  let plain: Uint8Array | undefined;
  for (const key of await candidateKeys) {
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, ciphertext));
      break;
    } catch { /* Try the next configured legacy key for this key version. */ }
  }
  if (!plain) throw new Error("archive_chunk_authentication_failed");
  if (plain.byteLength !== expected.plaintextBytes || await sha256(plain) !== expected.checksum) throw new Error("archive_chunk_checksum_mismatch");
  return plain;
}

/** Reassemble and validate one chunked snapshot. The per-object bound keeps this allocation capped. */
export async function decodeSpaceArchiveChunkedObjectSnapshot(
  snapshot: SpaceArchiveChunkedObjectSnapshot,
  expected: { key: string; etag: string; size: number },
  scope: { tenantId: string; spaceId: string; archiveId: string },
  bucket: Pick<R2Bucket, "get">,
  keys: ArchiveKeys,
): Promise<Uint8Array> {
  if (!snapshot || snapshot.key !== expected.key || snapshot.etag !== expected.etag || snapshot.size !== expected.size
    || !Number.isSafeInteger(snapshot.objectIndex) || snapshot.objectIndex < 0
    || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.size > MAX_ARCHIVE_CHUNKED_OBJECT_BYTES
    || typeof snapshot.chunkKeyVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(snapshot.chunkKeyVersion)
    || snapshot.chunkBytes !== ARCHIVE_OBJECT_CHUNK_BYTES || !Array.isArray(snapshot.chunks)
    || snapshot.chunks.length !== Math.ceil(snapshot.size / ARCHIVE_OBJECT_CHUNK_BYTES)
    || !/^[a-f0-9]{64}$/.test(snapshot.checksum)) throw new Error("archive_object_snapshot_invalid");
  if (snapshot.httpMetadata && (typeof snapshot.httpMetadata !== "object" || Array.isArray(snapshot.httpMetadata)
    || Object.entries(snapshot.httpMetadata).some(([key, value]) => !["contentType", "contentLanguage", "contentDisposition", "contentEncoding", "cacheControl", "cacheExpiry"].includes(key)
      || typeof value !== "string" || (key === "cacheExpiry" && !Number.isFinite(Date.parse(value)))))) throw new Error("archive_object_snapshot_invalid");
  if (snapshot.customMetadata && (typeof snapshot.customMetadata !== "object" || Array.isArray(snapshot.customMetadata)
    || Object.values(snapshot.customMetadata).some(value => typeof value !== "string"))) throw new Error("archive_object_snapshot_invalid");
  const chunks: Uint8Array[] = [];
  const keyCache = new Map<string, Promise<CryptoKey[]>>();
  let total = 0;
  for (let index = 0; index < snapshot.chunks.length; index++) {
    const descriptor = snapshot.chunks[index]!;
    const expectedBytes = Math.min(ARCHIVE_OBJECT_CHUNK_BYTES, snapshot.size - total);
    if (!descriptor || descriptor.plaintextBytes !== expectedBytes || !/^[a-f0-9]{64}$/.test(descriptor.checksum)) throw new Error("archive_object_snapshot_invalid");
    const key = archiveChunkObjectKey(scope, snapshot.chunkKeyVersion, snapshot.objectIndex, index);
    const stored = await bucket.get(key);
    if (!stored) throw new Error("archive_object_chunk_missing");
    const plain = await decodeArchiveObjectChunk(stored, descriptor, { ...scope, objectKey: snapshot.key, objectIndex: snapshot.objectIndex, chunkIndex: index }, keys, keyCache, snapshot.chunkKeyVersion);
    chunks.push(plain); total += plain.byteLength;
  }
  if (total !== snapshot.size) throw new Error("archive_object_size_mismatch");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (await sha256(bytes) !== snapshot.checksum) throw new Error("archive_object_checksum_mismatch");
  return bytes;
}

/** Verify all captured R2 objects before archive replay, recovery, retention or restore acceptance. */
export async function verifySpaceArchiveObjectSnapshots(
  payload: SpaceArchivePayload,
  bucket: Pick<R2Bucket, "get">,
  keys: ArchiveKeys,
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(payload, "objectSnapshots")) {
    if (payload.formatVersion === 2) throw new Error("archive_object_snapshot_set_incomplete");
    return;
  }
  const snapshots = payload.objectSnapshots;
  if (!Array.isArray(snapshots) || snapshots.length !== payload.objectReferences.length) throw new Error("archive_object_snapshot_set_incomplete");
  let total = 0;
  for (let index = 0; index < payload.objectReferences.length; index++) {
    const ref = payload.objectReferences[index]!;
    const snapshot = snapshots[index];
    if (!snapshot || snapshot.key !== ref.key) throw new Error("archive_object_snapshot_invalid");
    total += ref.size;
    if (total > (payload.formatVersion === 2 ? MAX_ARCHIVE_CHUNKED_CAPTURE_BYTES : MAX_ARCHIVE_OBJECT_CAPTURE_BYTES)) throw new Error("archive_object_capture_limit_exceeded");
    if (payload.formatVersion === 2) {
      if (!isChunkedObjectSnapshot(snapshot) || snapshot.objectIndex !== index) throw new Error("archive_object_snapshot_invalid");
      await decodeSpaceArchiveChunkedObjectSnapshot(snapshot, ref, { tenantId: payload.tenantId, spaceId: payload.spaceId, archiveId: payload.archiveId }, bucket, keys);
    } else {
      if (isChunkedObjectSnapshot(snapshot)) throw new Error("archive_object_snapshot_invalid");
      await decodeSpaceArchiveObjectSnapshot(snapshot, ref);
    }
  }
}

export async function deleteSpaceArchiveChunkObjects(bucket: Pick<R2Bucket, "list" | "delete">, scope: { tenantId: string; spaceId: string; archiveId: string }, keyVersion?: string): Promise<void> {
  if (keyVersion !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyVersion)) throw new Error("archive_key_version_invalid");
  const prefix = `space-archives/${scope.tenantId}/${scope.spaceId}/${scope.archiveId}.chunks/${keyVersion ? `${keyVersion}/` : ""}`;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Re-encrypt chunked object data before the archive manifest is rotated to a new key. Mixed old
 *  and new chunk keys remain readable during a resumable rotation while both keys are configured. */
export async function rewrapSpaceArchiveObjectChunks(
  payload: SpaceArchivePayload,
  bucket: Pick<R2Bucket, "get" | "put">,
  keys: ArchiveKeys,
): Promise<SpaceArchivePayload> {
  if (payload.formatVersion !== 2 || !Array.isArray(payload.objectSnapshots)) return payload;
  const active = activeArchiveKey(keys);
  const snapshots = payload.objectSnapshots;
  if (snapshots.every(snapshot => isChunkedObjectSnapshot(snapshot) && snapshot.chunkKeyVersion === active.version)) return payload;
  const preparedKey = { version: active.version, key: await archiveKey(active.secret, payload.tenantId, payload.spaceId) };
  const nextSnapshots = [] as NonNullable<SpaceArchivePayload["objectSnapshots"]>;
  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index];
    const ref = payload.objectReferences[index];
    if (!snapshot || !ref || !isChunkedObjectSnapshot(snapshot) || snapshot.objectIndex !== index) throw new Error("archive_object_snapshot_invalid");
    const whole = await decodeSpaceArchiveChunkedObjectSnapshot(snapshot, ref, { tenantId: payload.tenantId, spaceId: payload.spaceId, archiveId: payload.archiveId }, bucket, keys);
    for (let chunkIndex = 0; chunkIndex < snapshot.chunks.length; chunkIndex++) {
      const start = chunkIndex * ARCHIVE_OBJECT_CHUNK_BYTES;
      const plain = whole.subarray(start, Math.min(start + ARCHIVE_OBJECT_CHUNK_BYTES, whole.byteLength));
      const key = archiveChunkObjectKey({ tenantId: payload.tenantId, spaceId: payload.spaceId, archiveId: payload.archiveId }, active.version, index, chunkIndex);
      await bucket.put(key, await encodeArchiveObjectChunk(plain, { tenantId: payload.tenantId, spaceId: payload.spaceId, archiveId: payload.archiveId, objectKey: snapshot.key, objectIndex: index, chunkIndex }, keys, preparedKey), { httpMetadata: { contentType: "application/vnd.naelao.space-archive-chunk+json" } });
    }
    nextSnapshots.push({ ...snapshot, chunkKeyVersion: active.version });
  }
  const nextPayload: SpaceArchivePayload = { ...payload, objectSnapshots: nextSnapshots };
  await verifySpaceArchiveObjectSnapshots(nextPayload, bucket, keys);
  return nextPayload;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function archiveKey(secret: string, tenantId: string, spaceId: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("archive_encryption_key_unavailable");
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(`naelao-space-archive-v1:${tenantId}:${spaceId}`),
    info: new TextEncoder().encode("space-backup/aes-gcm/v1"),
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encodeSpaceArchive(payload: SpaceArchivePayload, keys: ArchiveKeys): Promise<{ bytes: Uint8Array; checksum: string; plaintextBytes: number }> {
  if (payload.format !== "naelao-space-archive" || ![1, 2].includes(payload.formatVersion) || !payload.spaceId || !payload.tenantId || !payload.archiveId) throw new Error("archive_manifest_invalid");
  if (payload.formatVersion === 2 && Array.isArray(payload.objectSnapshots) && payload.objectSnapshots.some(snapshot => !isChunkedObjectSnapshot(snapshot))) throw new Error("archive_object_snapshot_invalid");
  if (payload.formatVersion === 1 && Array.isArray(payload.objectSnapshots) && payload.objectSnapshots.some(isChunkedObjectSnapshot)) throw new Error("archive_object_snapshot_invalid");
  const plain = new TextEncoder().encode(stable(payload));
  if (plain.byteLength > MAX_ARCHIVE_BYTES) throw new Error("archive_size_limit_exceeded");
  const checksum = await sha256(plain);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const active = activeArchiveKey(keys);
  const key = await archiveKey(active.secret, payload.tenantId, payload.spaceId);
  const payloadVersion = payload.formatVersion;
  const additionalData = new TextEncoder().encode(payloadVersion === 1
    ? (active.version === "platform-secret-hkdf-v1"
      ? `${payload.tenantId}:${payload.spaceId}:${payload.archiveId}:1`
      : `${payload.tenantId}:${payload.spaceId}:${payload.archiveId}:1:${active.version}`)
    : `${payload.tenantId}:${payload.spaceId}:${payload.archiveId}:2:${active.version}`);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, plain));
  const envelope: ArchiveEnvelope = {
    format: "naelao-space-archive-envelope", formatVersion: 1,
    tenantId: payload.tenantId, spaceId: payload.spaceId, archiveId: payload.archiveId,
    ...(payloadVersion === 2 ? { payloadVersion: 2 as const } : {}),
    keyVersion: active.version, iv: base64(iv), checksum, ciphertext: base64(ciphertext),
  };
  return { bytes: new TextEncoder().encode(JSON.stringify(envelope)), checksum, plaintextBytes: plain.byteLength };
}

export async function decodeSpaceArchive(
  bytes: Uint8Array,
  keys: ArchiveKeys,
  expected: { tenantId: string; spaceId: string; archiveId: string },
): Promise<SpaceArchivePayload> {
  if (bytes.byteLength > MAX_ENCRYPTED_ARCHIVE_BYTES) throw new Error("archive_size_limit_exceeded");
  let envelope: ArchiveEnvelope;
  try { envelope = JSON.parse(new TextDecoder().decode(bytes)) as ArchiveEnvelope; }
  catch { throw new Error("archive_envelope_invalid"); }
  if (envelope.format !== "naelao-space-archive-envelope" || envelope.formatVersion !== 1 || (envelope.payloadVersion !== undefined && envelope.payloadVersion !== 2 && envelope.payloadVersion !== 1) || typeof envelope.keyVersion !== "string"
    || envelope.tenantId !== expected.tenantId || envelope.spaceId !== expected.spaceId || envelope.archiveId !== expected.archiveId) {
    throw new Error("archive_scope_or_version_mismatch");
  }
  const iv = fromBase64(envelope.iv);
  if (iv.length !== 12) throw new Error("archive_envelope_invalid");
  const payloadVersion = envelope.payloadVersion ?? 1;
  const additionalData = new TextEncoder().encode(payloadVersion === 1
    ? (envelope.keyVersion === "platform-secret-hkdf-v1"
      ? `${expected.tenantId}:${expected.spaceId}:${expected.archiveId}:1`
      : `${expected.tenantId}:${expected.spaceId}:${expected.archiveId}:1:${envelope.keyVersion}`)
    : `${expected.tenantId}:${expected.spaceId}:${expected.archiveId}:2:${envelope.keyVersion}`);
  const ciphertext = fromBase64(envelope.ciphertext);
  let plain: Uint8Array | undefined;
  for (const secret of archiveKeysForVersion(keys, envelope.keyVersion)) {
    try {
      const key = await archiveKey(secret, expected.tenantId, expected.spaceId);
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, ciphertext));
      break;
    } catch { /* Try the next configured key for legacy key IDs. */ }
  }
  if (!plain) throw new Error("archive_authentication_failed");
  if (plain.byteLength > MAX_ARCHIVE_BYTES || await sha256(plain) !== envelope.checksum) throw new Error("archive_checksum_mismatch");
  let payload: SpaceArchivePayload;
  try { payload = JSON.parse(new TextDecoder().decode(plain)) as SpaceArchivePayload; }
  catch { throw new Error("archive_payload_invalid"); }
  if (payload.format !== "naelao-space-archive" || payload.formatVersion !== payloadVersion
    || payload.tenantId !== expected.tenantId || payload.spaceId !== expected.spaceId || payload.archiveId !== expected.archiveId) {
    throw new Error("archive_payload_scope_mismatch");
  }
  return payload;
}

export const spaceBackupTest = { stable };
