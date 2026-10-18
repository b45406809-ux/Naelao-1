// PBKDF2 password hashing, AES-256-GCM envelope encryption, DEK management
// Uses Web Crypto API — available in both CF Workers and Node.js 18+

// Cloudflare Workers' WebCrypto PBKDF2 implementation caps iterations at 100,000 — a real
// deployment throws "NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
// supported" at 600,000 (confirmed via a live wrangler tail session; Node's crypto has no such
// cap, so this never surfaced in unit tests). 100,000 is the platform's real ceiling, not a
// deliberate security tradeoff — still within OWASP's historical PBKDF2-SHA256 guidance.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 32;
const AES_KEY_LENGTH = 256;
const IV_BYTES = 12; // 96-bit IV for AES-GCM
const AES_GCM_TAG_BYTES = 16;
const MAX_PASSWORD_BYTES = 4096;
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;
const MAX_ENVELOPE_BASE64_CHARS =
  Math.ceil((MAX_ENVELOPE_BYTES + AES_GCM_TAG_BYTES) / 3) * 4;
const MAX_AUTHENTICATED_DATA_BYTES = 4096;

// ── Password hashing (PBKDF2, SHA-256, 100k iterations — the CF Workers WebCrypto ceiling) ──

export interface HashedPassword {
  hash: string; // hex-encoded 32-byte derived key
  salt: string; // hex-encoded 32-byte random salt
  iterations: number; // PBKDF2_ITERATIONS
  algorithm: "pbkdf2-sha256-100k";
}

export async function hashPassword(password: string): Promise<HashedPassword> {
  if (typeof password !== "string") throw new Error("invalid_password");
  if (new TextEncoder().encode(password).byteLength > MAX_PASSWORD_BYTES) {
    throw new Error("password_too_large");
  }
  const saltBytes = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return {
    hash: bufToHex(new Uint8Array(derivedBits)),
    salt: bufToHex(saltBytes),
    iterations: PBKDF2_ITERATIONS,
    algorithm: "pbkdf2-sha256-100k",
  };
}

export async function verifyPassword(
  password: string,
  stored: HashedPassword
): Promise<boolean> {
  if (
    !stored ||
    typeof password !== "string" ||
    stored.algorithm !== "pbkdf2-sha256-100k" ||
    stored.iterations !== PBKDF2_ITERATIONS ||
    typeof stored.salt !== "string" ||
    typeof stored.hash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(stored.salt) ||
    !/^[0-9a-f]{64}$/i.test(stored.hash) ||
    new TextEncoder().encode(password).byteLength > MAX_PASSWORD_BYTES
  ) {
    return false;
  }
  const saltBytes = hexToBuf(stored.salt);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: stored.iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return timingSafeEqual(new Uint8Array(derivedBits), hexToBuf(stored.hash));
}

// ── AES-256-GCM envelope encryption ─────────────────────────────────────────

export interface EncryptedEnvelope {
  ciphertext: string; // base64-encoded ciphertext+auth-tag
  iv: string; // base64-encoded 96-bit IV
  algorithm: "aes-256-gcm";
}

export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    true,
    ["encrypt", "decrypt"]
  ) as Promise<CryptoKey>;
}

export async function exportDek(dek: CryptoKey): Promise<string> {
  const raw = await (crypto.subtle.exportKey(
    "raw",
    dek
  ) as Promise<ArrayBuffer>);
  if (raw.byteLength !== AES_KEY_LENGTH / 8)
    throw new Error("invalid_dek_length");
  return bufToBase64(new Uint8Array(raw));
}

export async function importDek(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBuf(base64Key);
  if (raw.byteLength !== AES_KEY_LENGTH / 8)
    throw new Error("invalid_dek_length");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(
  plaintext: string,
  dek: CryptoKey
): Promise<EncryptedEnvelope> {
  if (typeof plaintext !== "string") throw new Error("invalid_plaintext");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  if (data.byteLength > MAX_ENVELOPE_BYTES)
    throw new Error("plaintext_too_large");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dek,
    data
  );
  return {
    ciphertext: bufToBase64(new Uint8Array(ciphertext)),
    iv: bufToBase64(iv),
    algorithm: "aes-256-gcm",
  };
}

export async function decrypt(
  envelope: EncryptedEnvelope,
  dek: CryptoKey
): Promise<string> {
  if (
    !envelope ||
    envelope.algorithm !== "aes-256-gcm" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    envelope.ciphertext.length > MAX_ENVELOPE_BASE64_CHARS
  ) {
    throw new Error("invalid_encrypted_envelope");
  }
  const iv = base64ToBuf(envelope.iv);
  const ciphertext = base64ToBuf(envelope.ciphertext);
  if (iv.byteLength !== IV_BYTES || ciphertext.byteLength < AES_GCM_TAG_BYTES) {
    throw new Error("invalid_encrypted_envelope");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    dek,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

/** AES-GCM envelope encryption with canonical caller-supplied authenticated metadata.
 * The additional data is authenticated but never encrypted or stored in the envelope. */
export async function encryptAuthenticated(
  plaintext: string,
  dek: CryptoKey,
  authenticatedData: string
): Promise<EncryptedEnvelope> {
  if (typeof plaintext !== "string" || typeof authenticatedData !== "string") {
    throw new Error("invalid_encryption_input");
  }
  const data = new TextEncoder().encode(plaintext);
  if (data.byteLength > MAX_ENVELOPE_BYTES)
    throw new Error("plaintext_too_large");
  const aad = new TextEncoder().encode(authenticatedData);
  if (aad.byteLength > MAX_AUTHENTICATED_DATA_BYTES)
    throw new Error("authenticated_data_too_large");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: aad,
    },
    dek,
    data
  );
  return {
    ciphertext: bufToBase64(new Uint8Array(ciphertext)),
    iv: bufToBase64(iv),
    algorithm: "aes-256-gcm",
  };
}

/** Decrypt an authenticated envelope. Metadata mismatch and tampering fail closed. */
export async function decryptAuthenticated(
  envelope: EncryptedEnvelope,
  dek: CryptoKey,
  authenticatedData: string
): Promise<string> {
  if (
    !envelope ||
    envelope.algorithm !== "aes-256-gcm" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof authenticatedData !== "string" ||
    envelope.ciphertext.length > MAX_ENVELOPE_BASE64_CHARS
  ) {
    throw new Error("invalid_encrypted_envelope");
  }
  const iv = base64ToBuf(envelope.iv);
  const ciphertext = base64ToBuf(envelope.ciphertext);
  const aad = new TextEncoder().encode(authenticatedData);
  if (iv.byteLength !== IV_BYTES || ciphertext.byteLength < AES_GCM_TAG_BYTES) {
    throw new Error("invalid_encrypted_envelope");
  }
  if (aad.byteLength > MAX_AUTHENTICATED_DATA_BYTES)
    throw new Error("authenticated_data_too_large");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: aad,
    },
    dek,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

// Wrap (encrypt) a DEK with a Key Encryption Key — returns compact base64(iv||ciphertext)
export async function wrapDek(dek: CryptoKey, kek: CryptoKey): Promise<string> {
  const rawDek = await (crypto.subtle.exportKey(
    "raw",
    dek
  ) as Promise<ArrayBuffer>);
  if (rawDek.byteLength !== AES_KEY_LENGTH / 8)
    throw new Error("invalid_dek_length");
  const envelope = await encrypt(bufToBase64(new Uint8Array(rawDek)), kek);
  // Pack iv + ciphertext into a single string for storage
  const ivBytes = base64ToBuf(envelope.iv);
  const ctBytes = base64ToBuf(envelope.ciphertext);
  const combined = new Uint8Array(ivBytes.byteLength + ctBytes.byteLength);
  combined.set(ivBytes, 0);
  combined.set(ctBytes, ivBytes.byteLength);
  return bufToBase64(combined);
}

export async function unwrapDek(
  wrappedDek: string,
  kek: CryptoKey
): Promise<CryptoKey> {
  const combined = base64ToBuf(wrappedDek);
  // The current persisted format wraps the base64 text of the 32-byte DEK (44 bytes),
  // then packs the 12-byte IV and GCM tag alongside the encrypted text.
  if (combined.byteLength !== IV_BYTES + 44 + AES_GCM_TAG_BYTES) {
    throw new Error("invalid_wrapped_dek");
  }
  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);
  const envelope: EncryptedEnvelope = {
    ciphertext: bufToBase64(ciphertext),
    iv: bufToBase64(iv),
    algorithm: "aes-256-gcm",
  };
  const rawBase64 = await decrypt(envelope, kek);
  return importDek(rawBase64);
}

// Derive a KEK from PLATFORM_SECRET + tenantId
export async function deriveKek(
  platformSecret: string,
  tenantId: string
): Promise<CryptoKey> {
  if (
    typeof platformSecret !== "string" ||
    !platformSecret ||
    typeof tenantId !== "string" ||
    !tenantId
  ) {
    throw new Error("encryption_scope_required");
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(platformSecret),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const salt = new TextEncoder().encode(tenantId);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1, hash: "SHA-256" },
    keyMaterial,
    AES_KEY_LENGTH
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

// ── Durable Object name derivation (G-BA01) ─────────────────────────────────
// DO names MUST use HMAC to prevent enumeration/prediction by compromised workers.
// Format: "<hmac-hex(tenantId, platformSecret)>:<type>:<resourceId>"

export async function getDOName(
  type: string,
  resourceId: string,
  tenantId: string,
  platformSecret: string
): Promise<string> {
  const tenantHash = await signHmac(tenantId, platformSecret);
  return `${tenantHash}:${type}:${resourceId}`;
}

// ── HMAC-SHA256 signing ──────────────────────────────────────────────────────

export async function signHmac(
  payload: string,
  secret: string
): Promise<string> {
  if (typeof payload !== "string" || typeof secret !== "string" || !secret) {
    throw new Error("hmac_secret_required");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return bufToHex(new Uint8Array(sig));
}

export async function verifyHmac(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  if (
    typeof payload !== "string" ||
    typeof signature !== "string" ||
    !/^[0-9a-f]{64}$/i.test(signature) ||
    typeof secret !== "string" ||
    !secret
  )
    return false;
  const expected = await signHmac(payload, secret);
  return timingSafeEqual(hexToBuf(expected), hexToBuf(signature));
}

// ── Utilities ────────────────────────────────────────────────────────────────

function bufToBase64(buf: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < buf.length; offset += chunkSize) {
    binary += String.fromCharCode(...buf.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBuf(b64: string): Uint8Array {
  if (
    typeof b64 !== "string" ||
    b64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      b64
    )
  ) {
    throw new Error("invalid_base64");
  }
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (bufToBase64(bytes) !== b64) throw new Error("invalid_base64");
  return bytes;
}

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBuf(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex))
    throw new Error("invalid_hex");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Independent non-exportable space keys; no HSM or disk-encryption claim is implied. */
export async function deriveSpaceDataKey(
  masterSecret: string,
  tenantId: string,
  spaceId: string
): Promise<CryptoKey> {
  if (
    typeof masterSecret !== "string" ||
    !masterSecret ||
    typeof tenantId !== "string" ||
    !tenantId ||
    tenantId.length > 256 ||
    typeof spaceId !== "string" ||
    !spaceId ||
    spaceId.length > 256
  )
    throw new Error("space_encryption_scope_required");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterSecret),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("naelao:space-data:v1"),
      info: new TextEncoder().encode(JSON.stringify([tenantId, spaceId])),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
