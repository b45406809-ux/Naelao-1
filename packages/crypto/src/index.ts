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

// ── Password hashing (PBKDF2, SHA-256, 100k iterations — the CF Workers WebCrypto ceiling) ──

export interface HashedPassword {
  hash: string;       // hex-encoded 32-byte derived key
  salt: string;       // hex-encoded 32-byte random salt
  iterations: number; // PBKDF2_ITERATIONS
  algorithm: "pbkdf2-sha256-100k";
}

export async function hashPassword(password: string): Promise<HashedPassword> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
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

export async function verifyPassword(password: string, stored: HashedPassword): Promise<boolean> {
  const saltBytes = hexToBuf(stored.salt);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: stored.iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return timingSafeEqual(new Uint8Array(derivedBits), hexToBuf(stored.hash));
}

// ── AES-256-GCM envelope encryption ─────────────────────────────────────────

export interface EncryptedEnvelope {
  ciphertext: string; // base64-encoded ciphertext+auth-tag
  iv: string;         // base64-encoded 96-bit IV
  algorithm: "aes-256-gcm";
}

export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: AES_KEY_LENGTH }, true, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
}

export async function exportDek(dek: CryptoKey): Promise<string> {
  const raw = await (crypto.subtle.exportKey("raw", dek) as Promise<ArrayBuffer>);
  return bufToBase64(new Uint8Array(raw));
}

export async function importDek(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBuf(base64Key), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

export async function encrypt(plaintext: string, dek: CryptoKey): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dek, data);
  return {
    ciphertext: bufToBase64(new Uint8Array(ciphertext)),
    iv: bufToBase64(iv),
    algorithm: "aes-256-gcm",
  };
}

export async function decrypt(envelope: EncryptedEnvelope, dek: CryptoKey): Promise<string> {
  const iv = base64ToBuf(envelope.iv);
  const ciphertext = base64ToBuf(envelope.ciphertext);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, dek, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// Wrap (encrypt) a DEK with a Key Encryption Key — returns compact base64(iv||ciphertext)
export async function wrapDek(dek: CryptoKey, kek: CryptoKey): Promise<string> {
  const rawDek = await (crypto.subtle.exportKey("raw", dek) as Promise<ArrayBuffer>);
  const envelope = await encrypt(bufToBase64(new Uint8Array(rawDek)), kek);
  // Pack iv + ciphertext into a single string for storage
  const ivBytes = base64ToBuf(envelope.iv);
  const ctBytes = base64ToBuf(envelope.ciphertext);
  const combined = new Uint8Array(ivBytes.byteLength + ctBytes.byteLength);
  combined.set(ivBytes, 0);
  combined.set(ctBytes, ivBytes.byteLength);
  return bufToBase64(combined);
}

export async function unwrapDek(wrappedDek: string, kek: CryptoKey): Promise<CryptoKey> {
  const combined = base64ToBuf(wrappedDek);
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
export async function deriveKek(platformSecret: string, tenantId: string): Promise<CryptoKey> {
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
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
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

export async function signHmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bufToHex(new Uint8Array(sig));
}

export async function verifyHmac(payload: string, signature: string, secret: string): Promise<boolean> {
  const expected = await signHmac(payload, secret);
  return timingSafeEqual(hexToBuf(expected), hexToBuf(signature));
}

// ── Utilities ────────────────────────────────────────────────────────────────

function bufToBase64(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf));
}

function base64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
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
