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
  keyVersion: "platform-secret-hkdf-v1";
  iv: string;
  checksum: string;
  ciphertext: string;
}

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

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

export async function encodeSpaceArchive(payload: SpaceArchivePayload, secret: string): Promise<{ bytes: Uint8Array; checksum: string; plaintextBytes: number }> {
  if (payload.format !== "naelao-space-archive" || payload.formatVersion !== 1 || !payload.spaceId || !payload.tenantId || !payload.archiveId) throw new Error("archive_manifest_invalid");
  const plain = new TextEncoder().encode(stable(payload));
  if (plain.byteLength > MAX_ARCHIVE_BYTES) throw new Error("archive_size_limit_exceeded");
  const checksum = await sha256(plain);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await archiveKey(secret, payload.tenantId, payload.spaceId);
  const additionalData = new TextEncoder().encode(`${payload.tenantId}:${payload.spaceId}:${payload.archiveId}:1`);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, plain));
  const envelope: ArchiveEnvelope = {
    format: "naelao-space-archive-envelope", formatVersion: 1,
    tenantId: payload.tenantId, spaceId: payload.spaceId, archiveId: payload.archiveId,
    keyVersion: "platform-secret-hkdf-v1", iv: base64(iv), checksum, ciphertext: base64(ciphertext),
  };
  return { bytes: new TextEncoder().encode(JSON.stringify(envelope)), checksum, plaintextBytes: plain.byteLength };
}

export async function decodeSpaceArchive(
  bytes: Uint8Array,
  secret: string,
  expected: { tenantId: string; spaceId: string; archiveId: string },
): Promise<SpaceArchivePayload> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES * 2) throw new Error("archive_size_limit_exceeded");
  let envelope: ArchiveEnvelope;
  try { envelope = JSON.parse(new TextDecoder().decode(bytes)) as ArchiveEnvelope; }
  catch { throw new Error("archive_envelope_invalid"); }
  if (envelope.format !== "naelao-space-archive-envelope" || envelope.formatVersion !== 1 || envelope.keyVersion !== "platform-secret-hkdf-v1"
    || envelope.tenantId !== expected.tenantId || envelope.spaceId !== expected.spaceId || envelope.archiveId !== expected.archiveId) {
    throw new Error("archive_scope_or_version_mismatch");
  }
  const key = await archiveKey(secret, expected.tenantId, expected.spaceId);
  const iv = fromBase64(envelope.iv);
  if (iv.length !== 12) throw new Error("archive_envelope_invalid");
  const additionalData = new TextEncoder().encode(`${expected.tenantId}:${expected.spaceId}:${expected.archiveId}:1`);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, fromBase64(envelope.ciphertext)));
  } catch { throw new Error("archive_authentication_failed"); }
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
