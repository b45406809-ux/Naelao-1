const TTL_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();

export interface WebsiteSourceScope {
  tenantId: string;
  spaceId: string;
  projectId: string;
  userId: string;
  connectionId: string;
}

interface WebsitePreviewClaims extends WebsiteSourceScope {
  version: 1;
  requestedUrl: string;
  finalUrl: string;
  previewSha256: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("website_preview_signing_unavailable");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sha256TextHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createWebsitePreviewToken(input: {
  secret: string;
  scope: WebsiteSourceScope;
  requestedUrl: string;
  finalUrl: string;
  previewSha256: string;
  now?: number;
  nonce?: string;
}): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(input.previewSha256)) throw new Error("website_preview_hash_invalid");
  const now = input.now ?? Date.now();
  const claims: WebsitePreviewClaims = {
    version: 1,
    ...input.scope,
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    previewSha256: input.previewSha256,
    issuedAt: now,
    expiresAt: now + TTL_MS,
    nonce: input.nonce ?? crypto.randomUUID(),
  };
  const encoded = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(input.secret), encoder.encode(encoded)));
  return `${encoded}.${toBase64Url(signature)}`;
}

export async function verifyWebsitePreviewToken(input: {
  token: string;
  secret: string;
  scope: WebsiteSourceScope;
  requestedUrl: string;
  finalUrl: string;
  previewSha256: string;
  now?: number;
}): Promise<boolean> {
  if (typeof input.token !== "string" || input.token.length > 4096) return false;
  const [encoded, signature, extra] = input.token.split(".");
  if (!encoded || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) return false;
  try {
    const validSignature = await crypto.subtle.verify("HMAC", await key(input.secret), fromBase64Url(signature), encoder.encode(encoded));
    if (!validSignature) return false;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as Partial<WebsitePreviewClaims>;
    const now = input.now ?? Date.now();
    return claims.version === 1 && claims.tenantId === input.scope.tenantId && claims.spaceId === input.scope.spaceId
      && claims.projectId === input.scope.projectId && claims.userId === input.scope.userId
      && claims.connectionId === input.scope.connectionId && claims.requestedUrl === input.requestedUrl
      && claims.finalUrl === input.finalUrl && claims.previewSha256 === input.previewSha256
      && typeof claims.nonce === "string" && claims.nonce.length >= 16
      && Number.isSafeInteger(claims.issuedAt) && Number.isSafeInteger(claims.expiresAt)
      && Number(claims.issuedAt) <= now && Number(claims.expiresAt) > now
      && Number(claims.expiresAt) - Number(claims.issuedAt) === TTL_MS;
  } catch {
    return false;
  }
}
