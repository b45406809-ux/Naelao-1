export const KNOWLEDGE_PDF_PARSER_VERSION = "cohere:parse-v5.0";
export const KNOWLEDGE_PDF_PREVIEW_TTL_MS = 15 * 60 * 1000;

export interface KnowledgePdfPreviewScope {
  tenantId: string;
  spaceId: string;
  projectId: string | null;
}

interface PdfPreviewClaims extends KnowledgePdfPreviewScope {
  version: 1;
  sourceSha256: string;
  extractionSha256: string;
  parserVersion: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

const encoder = new TextEncoder();
const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("knowledge_pdf_preview_signing_unavailable");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createKnowledgePdfPreviewToken(input: {
  secret: string;
  scope: KnowledgePdfPreviewScope;
  sourceSha256: string;
  extractionSha256: string;
  parserVersion?: string;
  now?: number;
  nonce?: string;
}): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256) || !/^[a-f0-9]{64}$/.test(input.extractionSha256)) {
    throw new Error("knowledge_pdf_preview_hash_invalid");
  }
  const now = input.now ?? Date.now();
  const claims: PdfPreviewClaims = {
    version: 1,
    ...input.scope,
    sourceSha256: input.sourceSha256,
    extractionSha256: input.extractionSha256,
    parserVersion: input.parserVersion ?? KNOWLEDGE_PDF_PARSER_VERSION,
    nonce: input.nonce ?? crypto.randomUUID(),
    issuedAt: now,
    expiresAt: now + KNOWLEDGE_PDF_PREVIEW_TTL_MS,
  };
  const encodedClaims = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(input.secret), encoder.encode(encodedClaims)));
  return `${encodedClaims}.${toBase64Url(signature)}`;
}

export async function verifyKnowledgePdfPreviewToken(input: {
  token: string;
  secret: string;
  scope: KnowledgePdfPreviewScope;
  sourceSha256: string;
  extractionSha256: string;
  parserVersion?: string;
  now?: number;
}): Promise<boolean> {
  if (typeof input.token !== "string" || input.token.length > 4096) return false;
  const [encodedClaims, encodedSignature, extra] = input.token.split(".");
  if (!encodedClaims || !encodedSignature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encodedClaims) || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) return false;
  try {
    const decodeBase64Url = (value: string): Uint8Array => {
      const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    };
    if (!await crypto.subtle.verify("HMAC", await hmacKey(input.secret), decodeBase64Url(encodedSignature), encoder.encode(encodedClaims))) return false;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedClaims))) as Partial<PdfPreviewClaims>;
    const now = input.now ?? Date.now();
    return claims.version === 1 && claims.tenantId === input.scope.tenantId && claims.spaceId === input.scope.spaceId
      && claims.projectId === input.scope.projectId && claims.sourceSha256 === input.sourceSha256
      && claims.extractionSha256 === input.extractionSha256
      && claims.parserVersion === (input.parserVersion ?? KNOWLEDGE_PDF_PARSER_VERSION)
      && typeof claims.nonce === "string" && claims.nonce.length >= 16 && Number.isSafeInteger(claims.issuedAt)
      && Number.isSafeInteger(claims.expiresAt) && Number(claims.expiresAt) > now
      && Number(claims.issuedAt) <= now && Number(claims.expiresAt) - Number(claims.issuedAt) === KNOWLEDGE_PDF_PREVIEW_TTL_MS;
  } catch {
    return false;
  }
}
