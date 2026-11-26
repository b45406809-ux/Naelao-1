// Webhook constants, secret handling and signing (MS-34, MR-EM-6).
//
// Secret storage: a webhook secret must be recoverable because the dispatcher signs every delivery with it, so it
// cannot be a one-way hash. It is stored in nemail_webhooks.secret_ciphertext as AES-256-GCM ciphertext
//   "v1.<base64url iv>.<base64url ciphertext+tag>"
// under the key SHA-256(NEMAIL_WEBHOOK_KEY), with additional data "webhook:<tenant>:<webhook id>" so a ciphertext
// cannot be moved to another row. NEMAIL_WEBHOOK_KEY is a Worker secret (`wrangler secret put`), at least 32
// characters. Rotating it makes existing secrets unreadable, so existing webhooks stop delivering (dead-letter with
// `secret_unreadable`); a rotation must re-create the webhooks. The plaintext secret is returned once by
// POST /v1/webhooks and is never logged or stored in the idempotency table.

export const WEBHOOK_EVENT_TYPES = [
  "email.message.received",
  "email.delivery.sent",
  "email.delivery.failed",
  "email.delivery.bounced",
  "email.delivery.complained",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export const SIGNATURE_HEADER = "Naelao-Signature";
export const WEBHOOK_KEY_MIN_LENGTH = 32;
const SECRET_PREFIX = "whsec_";
const encoder = new TextEncoder();

export const isWebhookEventType = (value: unknown): value is WebhookEventType =>
  typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);

export const webhookKeyUsable = (keyMaterial: string | undefined): keyMaterial is string =>
  typeof keyMaterial === "string" && keyMaterial.length >= WEBHOOK_KEY_MIN_LENGTH;

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function fromBase64Url(value: string): ArrayBuffer {
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}
function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

/** `whsec_` + 32 random bytes. Returned once; the caller stores only the ciphertext. */
export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export const webhookAad = (tenantId: string, webhookId: string) => `webhook:${tenantId}:${webhookId}`;

async function aesKey(keyMaterial: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(keyMaterial));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
}

export async function encryptSecret(keyMaterial: string, secret: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, await aesKey(keyMaterial, "encrypt"), encoder.encode(secret));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

/** Returns the plaintext secret, or null when the ciphertext is malformed, bound to another row, or the key is wrong. */
export async function decryptSecret(keyMaterial: string, stored: string | null, aad: string): Promise<string | null> {
  const parts = (stored ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(parts[1]!), additionalData: encoder.encode(aad) }, await aesKey(keyMaterial, "decrypt"), fromBase64Url(parts[2]!));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Header value `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`. */
export async function signPayload(secret: string, timestampSeconds: number, body: string): Promise<string> {
  return `t=${timestampSeconds},v1=${await hmacHex(secret, `${timestampSeconds}.${body}`)}`;
}

/** Consumer-side verification: checks the HMAC in constant time and rejects timestamps outside the tolerance. */
export async function verifySignature(secret: string, header: string | null, body: string, nowSeconds: number, toleranceSeconds = 300): Promise<boolean> {
  const t = /(?:^|,)t=(\d+)/.exec(header ?? "")?.[1];
  const sigs = [...(header ?? "").matchAll(/(?:^|,)v1=([0-9a-f]{64})/g)].map(m => m[1]!);
  if (!t || sigs.length === 0 || Math.abs(nowSeconds - Number(t)) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return sigs.some(sig => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}
