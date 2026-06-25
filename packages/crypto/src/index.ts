// PBKDF2 password hashing, AES-256-GCM envelope encryption, DEK management
// Uses Web Crypto API — available in both CF Workers and Node.js 18+

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 32;
const AES_KEY_LENGTH = 256;
const IV_BYTES = 12; // 96-bit IV for AES-GCM

// ── Password hashing (PBKDF2, SHA-256, 600k iterations) ─────────────────────

export interface HashedPassword {
  hash: string; // base64(salt || hash)
  algorithm: "pbkdf2-sha256-600k";
}

export async function hashPassword(password: string): Promise<HashedPassword> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const combined = new Uint8Array(PBKDF2_SALT_BYTES + 32);
  combined.set(salt, 0);
  combined.set(new Uint8Array(derivedBits), PBKDF2_SALT_BYTES);
  return { hash: bufToBase64(combined), algorithm: "pbkdf2-sha256-600k" };
}

export async function verifyPassword(password: string, stored: HashedPassword): Promise<boolean> {
  const combined = base64ToBuf(stored.hash);
  const salt = combined.slice(0, PBKDF2_SALT_BYTES);
  const expectedHash = combined.slice(PBKDF2_SALT_BYTES);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return timingSafeEqual(new Uint8Array(derivedBits), expectedHash);
}

// ── AES-256-GCM envelope encryption ─────────────────────────────────────────

export interface EncryptedEnvelope {
  ciphertext: string; // base64(iv || ciphertext || tag)
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
  const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_BYTES);
  return { ciphertext: bufToBase64(combined), algorithm: "aes-256-gcm" };
}

export async function decrypt(envelope: EncryptedEnvelope, dek: CryptoKey): Promise<string> {
  const combined = base64ToBuf(envelope.ciphertext);
  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, dek, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// Wrap (encrypt) a DEK with a Key Encryption Key
export async function wrapDek(dek: CryptoKey, kek: CryptoKey): Promise<string> {
  const rawDek = await (crypto.subtle.exportKey("raw", dek) as Promise<ArrayBuffer>);
  const envelope = await encrypt(bufToBase64(new Uint8Array(rawDek)), kek);
  return envelope.ciphertext;
}

export async function unwrapDek(wrappedDek: string, kek: CryptoKey): Promise<CryptoKey> {
  const rawBase64 = await decrypt({ ciphertext: wrappedDek, algorithm: "aes-256-gcm" }, kek);
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
