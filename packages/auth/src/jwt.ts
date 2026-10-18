import type { NaelaoJwtClaims } from "@naelao/types";

export interface JwtHeader {
  alg: "HS256";
  typ: "JWT";
}

function base64UrlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1)
    throw new Error("Invalid base64url");
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (padded.length % 4);
  const padded2 = pad !== 4 ? padded + "=".repeat(pad) : padded;
  const binary = atob(padded2);
  const decoded = new Uint8Array(binary.split("").map((c) => c.charCodeAt(0)));
  if (base64UrlEncode(decoded) !== s)
    throw new Error("Non-canonical base64url");
  return decoded;
}

const MAX_JWT_LENGTH = 32_768;
const USER_ROLES = new Set([
  "owner",
  "admin",
  "editor",
  "viewer",
  "product_end_user",
  "agent",
]);

function validClaims(value: unknown): value is NaelaoJwtClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Partial<NaelaoJwtClaims>;
  const issuedAt = claims.iat;
  const expiresAt = claims.exp;
  return (
    typeof claims.sub === "string" &&
    claims.sub.length > 0 &&
    claims.sub.length <= 256 &&
    typeof claims.tid === "string" &&
    claims.tid.length > 0 &&
    claims.tid.length <= 256 &&
    typeof claims.email === "string" &&
    claims.email.length <= 320 &&
    typeof claims.role === "string" &&
    USER_ROLES.has(claims.role) &&
    Array.isArray(claims.scopes) &&
    claims.scopes.length <= 256 &&
    claims.scopes.every(
      (scope) => typeof scope === "string" && scope.length <= 256
    ) &&
    typeof issuedAt === "number" &&
    Number.isSafeInteger(issuedAt) &&
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > issuedAt &&
    typeof claims.jti === "string" &&
    claims.jti.length > 0 &&
    claims.jti.length <= 256 &&
    (claims.tv === undefined ||
      (Number.isSafeInteger(claims.tv) && claims.tv >= 0))
  );
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signJwt(
  payload: Omit<NaelaoJwtClaims, "iat" | "exp" | "jti"> & {
    iat?: number;
    exp?: number;
    jti?: string;
  },
  secret: string,
  expiresInSeconds = 3600
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: NaelaoJwtClaims = {
    ...payload,
    iat: payload.iat ?? now,
    exp: payload.exp ?? now + expiresInSeconds,
    jti: payload.jti ?? crypto.randomUUID(),
  } as NaelaoJwtClaims;

  const header: JwtHeader = { alg: "HS256", typ: "JWT" };
  const enc = new TextEncoder();

  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(signingInput)
  );
  const sigB64 = base64UrlEncode(new Uint8Array(signature));

  return `${signingInput}.${sigB64}`;
}

export async function verifyJwt(
  token: string,
  secret: string
): Promise<NaelaoJwtClaims> {
  if (typeof token !== "string" || token.length > MAX_JWT_LENGTH)
    throw new AuthError("invalid_token", "JWT is malformed or too large");
  try {
    const parts = token.split(".");
    if (parts.length !== 3)
      throw new AuthError("invalid_token", "Malformed JWT");

    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    // G-B01: Pin algorithm — reject any token not using HS256 (prevents alg:none attacks)
    const header = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(headerB64))
    ) as { alg?: string; typ?: string };
    if (header.alg !== "HS256") {
      throw new AuthError("invalid_token", "JWT algorithm must be HS256");
    }

    const enc = new TextEncoder();
    const signingInput = `${headerB64}.${payloadB64}`;

    const key = await importHmacKey(secret);
    const sigBytes = base64UrlDecode(sigB64);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      enc.encode(signingInput)
    );
    if (!valid) throw new AuthError("invalid_token", "Invalid JWT signature");

    const decodedClaims: unknown = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64))
    );
    if (!validClaims(decodedClaims))
      throw new AuthError("invalid_token", "JWT claims are malformed");
    const claims = decodedClaims;

    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now)
      throw new AuthError("token_expired", "JWT has expired");
    if (claims.iat > now + 60)
      throw new AuthError("invalid_token", "JWT issued in the future");

    return claims;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("invalid_token", "Malformed JWT");
  }
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}
