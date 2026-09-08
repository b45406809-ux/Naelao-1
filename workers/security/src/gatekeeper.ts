import { GatekeeperCapabilityPayload, GatekeeperGrant } from "@avos/types";

/**
 * Constant-time string comparison to prevent timing attacks on HMAC signatures.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Computes HMAC-SHA256 of data using the provided secret key.
 */
async function computeHmac(data: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(data)
  );
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mints a new cryptographically signed GatekeeperToken using WebCrypto HMAC-SHA256.
 * Format: `base64url(payload).base64url(signature)` or hexadecimal sig depending on implementation style.
 * Let's support both standard base64url or hex matching robust production standards.
 */
export async function mintGatekeeperToken(
  payload: GatekeeperCapabilityPayload,
  platformSecret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = bufferToBase64Url(encoder.encode(payloadJson));

  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    encoder.encode(payloadBase64)
  );

  const signatureBase64 = bufferToBase64Url(new Uint8Array(signatureBuffer));
  return `${payloadBase64}.${signatureBase64}`;
}

/**
 * Verifies a raw Gatekeeper token string, validating signature, expiration, and format.
 */
export async function verifyGatekeeperToken(
  tokenString: string,
  platformSecret: string
): Promise<GatekeeperCapabilityPayload> {
  const parts = tokenString.split(".");
  if (parts.length !== 2) {
    throw new Error("Gatekeeper Violation: Malformed token format.");
  }

  const [payloadBase64, signatureBase64] = parts;
  const encoder = new TextEncoder();

  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signatureBytes = base64UrlToBuffer(signatureBase64);
  const isValid = await crypto.subtle.verify(
    "HMAC",
    secretKey,
    signatureBytes,
    encoder.encode(payloadBase64)
  );

  if (!isValid) {
    throw new Error("Gatekeeper Violation: Cryptographic signature mismatch.");
  }

  const payloadJson = new TextDecoder().decode(base64UrlToBuffer(payloadBase64));
  const payload: GatekeeperCapabilityPayload = JSON.parse(payloadJson);

  if (Date.now() > payload.expiresAt) {
    throw new Error("Gatekeeper Violation: Token has expired.");
  }

  return payload;
}

/**
 * Checks if a verified token has the required capability/grant.
 */
export function checkCapability(
  token: GatekeeperCapabilityPayload,
  required: { resource: string; op: string; target?: string }
): boolean {
  return token.grants.some(grant => {
    const resourceMatch = grant.resource === required.resource;
    const opMatch = grant.operations.includes(required.op as any);
    const targetMatch = !required.target || grant.target === "*" || grant.target === required.target || grant.target.startsWith(required.target);
    return resourceMatch && opMatch && targetMatch;
  });
}

export function isOperationGranted(
  payload: GatekeeperCapabilityPayload,
  requiredResource: string,
  requiredTarget: string,
  requiredOp: string
): boolean {
  return checkCapability(payload, { resource: requiredResource, op: requiredOp, target: requiredTarget });
}

// ── WebCrypto Helper Functions ──────────────────────────────────────────────

function bufferToBase64Url(buffer: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < buffer.byteLength; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBuffer(base64url: string): Uint8Array {
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
