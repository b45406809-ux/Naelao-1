export interface CustomModelTestCase {
  input: string;
  expected: string;
}
export interface CustomModelTestSet {
  id: string;
  version: string;
  cases: CustomModelTestCase[];
}

const MAX_CASES = 20;
const MAX_FIELD_BYTES = 4096;
const MAX_SET_BYTES = 64 * 1024;

export function validateCustomModelTestSet(
  value: unknown
): value is CustomModelTestSet {
  if (!value || typeof value !== "object") return false;
  const set = value as Record<string, unknown>;
  if (
    typeof set.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(set.id)
  )
    return false;
  if (
    typeof set.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(set.version)
  )
    return false;
  if (
    !Array.isArray(set.cases) ||
    set.cases.length < 1 ||
    set.cases.length > MAX_CASES
  )
    return false;
  let total = 0;
  for (const item of set.cases) {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    if (
      typeof row.input !== "string" ||
      typeof row.expected !== "string" ||
      !row.input.trim() ||
      !row.expected.trim()
    )
      return false;
    const inputBytes = new TextEncoder().encode(row.input).byteLength;
    const expectedBytes = new TextEncoder().encode(row.expected).byteLength;
    if (inputBytes > MAX_FIELD_BYTES || expectedBytes > MAX_FIELD_BYTES)
      return false;
    total += inputBytes + expectedBytes;
  }
  return total <= MAX_SET_BYTES;
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + 0x8000, bytes.length))
    );
  return btoa(binary);
}
function unb64(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function key(
  secret: string,
  tenantId: string,
  spaceId: string
): Promise<CryptoKey> {
  if (secret.length < 32)
    throw new Error("test_set_encryption_key_unavailable");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(
        `naelao-lora-test-set-v1:${tenantId}:${spaceId}`
      ),
      info: new TextEncoder().encode("custom-model-test-vault/aes-gcm/v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptTestSet(
  set: CustomModelTestSet,
  secret: string,
  tenantId: string,
  spaceId: string
): Promise<string> {
  if (!validateCustomModelTestSet(set))
    throw new Error("test_set_invalid_or_over_limit");
  const plaintext = new TextEncoder().encode(JSON.stringify(set));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(
    `${tenantId}:${spaceId}:${set.id}:${set.version}:1`
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
    await key(secret, tenantId, spaceId),
    plaintext
  );
  return JSON.stringify({
    v: 1,
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ciphertext)),
  });
}

export async function decryptTestSet(
  envelopeText: string,
  secret: string,
  tenantId: string,
  spaceId: string,
  id: string,
  version: string
): Promise<CustomModelTestSet> {
  let envelope: { v?: number; iv?: string; ciphertext?: string };
  try {
    envelope = JSON.parse(envelopeText) as typeof envelope;
  } catch {
    throw new Error("test_set_ciphertext_invalid");
  }
  if (
    envelope.v !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  )
    throw new Error("test_set_ciphertext_invalid");
  const iv = unb64(envelope.iv);
  if (iv.byteLength !== 12) throw new Error("test_set_ciphertext_invalid");
  const aad = new TextEncoder().encode(
    `${tenantId}:${spaceId}:${id}:${version}:1`
  );
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      await key(secret, tenantId, spaceId),
      unb64(envelope.ciphertext)
    );
  } catch {
    throw new Error("test_set_authentication_failed");
  }
  const set = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  if (
    !validateCustomModelTestSet(set) ||
    set.id !== id ||
    set.version !== version
  )
    throw new Error("test_set_integrity_failed");
  return set;
}
