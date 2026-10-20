export interface SpaceArchivePayload {
  format: "naelao-space-archive";
  formatVersion: 1;
  tenantId: string;
  spaceId: string;
  archiveId: string;
  createdAt: string;
  migrationVersion: number;
  tableRows: Record<string, Array<Record<string, unknown>>>;
  rowCounts: Record<string, number>;
  objectReferences: Array<{ key: string; etag: string; size: number }>;
  selectionFingerprint?: string;
}

interface ArchiveEnvelope {
  format: "naelao-space-archive-envelope";
  formatVersion: 1;
  tenantId: string;
  spaceId: string;
  archiveId: string;
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
  if (payload.format !== "naelao-space-archive" || payload.formatVersion !== 1 || !payload.spaceId || !payload.tenantId || !payload.archiveId) throw new Error("archive_manifest_invalid");
  const plain = new TextEncoder().encode(stable(payload));
  if (plain.byteLength > MAX_ARCHIVE_BYTES) throw new Error("archive_size_limit_exceeded");
  const checksum = await sha256(plain);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const active = activeArchiveKey(keys);
  const key = await archiveKey(active.secret, payload.tenantId, payload.spaceId);
  const additionalData = new TextEncoder().encode(active.version === "platform-secret-hkdf-v1"
    ? `${payload.tenantId}:${payload.spaceId}:${payload.archiveId}:1`
    : `${payload.tenantId}:${payload.spaceId}:${payload.archiveId}:1:${active.version}`);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, plain));
  const envelope: ArchiveEnvelope = {
    format: "naelao-space-archive-envelope", formatVersion: 1,
    tenantId: payload.tenantId, spaceId: payload.spaceId, archiveId: payload.archiveId,
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
  if (envelope.format !== "naelao-space-archive-envelope" || envelope.formatVersion !== 1 || typeof envelope.keyVersion !== "string"
    || envelope.tenantId !== expected.tenantId || envelope.spaceId !== expected.spaceId || envelope.archiveId !== expected.archiveId) {
    throw new Error("archive_scope_or_version_mismatch");
  }
  const iv = fromBase64(envelope.iv);
  if (iv.length !== 12) throw new Error("archive_envelope_invalid");
  const additionalData = new TextEncoder().encode(envelope.keyVersion === "platform-secret-hkdf-v1"
    ? `${expected.tenantId}:${expected.spaceId}:${expected.archiveId}:1`
    : `${expected.tenantId}:${expected.spaceId}:${expected.archiveId}:1:${envelope.keyVersion}`);
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
  if (payload.format !== "naelao-space-archive" || payload.formatVersion !== 1
    || payload.tenantId !== expected.tenantId || payload.spaceId !== expected.spaceId || payload.archiveId !== expected.archiveId) {
    throw new Error("archive_payload_scope_mismatch");
  }
  return payload;
}

export const spaceBackupTest = { stable };
