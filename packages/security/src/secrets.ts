const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function toBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let result = "";
  while (num > 0n) {
    result = (BASE58_ALPHABET[Number(num % 58n)] ?? "") + result;
    num = num / 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    result = `1${result}`;
  }
  return result;
}

// Generate a cryptographically secure API key
// Format: nk_{prefix}_{base58(32 random bytes)}
export function generateApiKey(): { key: string; prefix: string } {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const prefixBytes = crypto.getRandomValues(new Uint8Array(4));
  const prefix = Array.from(prefixBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
  const key = `nk_${prefix}_${toBase58(randomBytes)}`;
  return { key, prefix };
}

export async function hashApiKey(key: string): Promise<string> {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) {
    throw new RangeError("api_key_length_invalid");
  }
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(key));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyApiKey(
  key: string,
  hash: string
): Promise<boolean> {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return false;
  let computed: string;
  try {
    computed = await hashApiKey(key);
  } catch {
    return false;
  }
  // Constant-time comparison
  if (computed.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return diff === 0;
}

export function validatePasswordStrength(password: string): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (typeof password !== "string")
    return { valid: false, issues: ["password must be text"] };
  if (password.length > 1024)
    return { valid: false, issues: ["maximum length is 1024 characters"] };
  if (password.length < 8) issues.push("at least 8 characters required");
  if (!/[A-Z]/.test(password))
    issues.push("at least one uppercase letter required");
  if (!/[a-z]/.test(password))
    issues.push("at least one lowercase letter required");
  if (!/\d/.test(password)) issues.push("at least one digit required");
  if (!/[^A-Za-z0-9]/.test(password))
    issues.push("at least one special character required");
  return { valid: issues.length === 0, issues };
}

// CSRF token: HMAC-SHA256(sessionId:timestamp, secret) encoded as hex
export async function generateCsrfToken(
  sessionId: string,
  secret: string
): Promise<string> {
  if (
    typeof sessionId !== "string" ||
    !sessionId ||
    sessionId.length > 256 ||
    typeof secret !== "string" ||
    !secret ||
    secret.length > 4096
  ) {
    throw new Error("csrf_session_or_secret_invalid");
  }
  const timestamp = Date.now();
  const message = `${sessionId}:${timestamp}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${timestamp}.${sigHex}`;
}

export async function verifyCsrfToken(
  token: string,
  sessionId: string,
  secret: string,
  maxAgeMs = 3_600_000 // 1 hour
): Promise<boolean> {
  if (
    typeof token !== "string" ||
    token.length > 128 ||
    typeof sessionId !== "string" ||
    !sessionId ||
    sessionId.length > 256 ||
    typeof secret !== "string" ||
    !secret ||
    secret.length > 4096 ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 0 ||
    maxAgeMs > 7 * 24 * 60 * 60 * 1000
  )
    return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [tsStr, sigHex] = parts as [string, string];
  if (!/^\d{1,16}$/.test(tsStr) || !/^[a-f0-9]{64}$/.test(sigHex)) return false;
  const timestamp = Number(tsStr);
  if (!Number.isSafeInteger(timestamp) || timestamp > Date.now() + 30_000)
    return false;
  if (Date.now() - timestamp > maxAgeMs) return false;

  const message = `${sessionId}:${timestamp}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const expectedHex = Array.from(new Uint8Array(expected))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (sigHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < sigHex.length; i++) {
    diff |= sigHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}
