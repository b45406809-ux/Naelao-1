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
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (padded.length % 4);
  const padded2 = pad !== 4 ? padded + "=".repeat(pad) : padded;
  const binary = atob(padded2);
  return new Uint8Array(binary.split("").map((c) => c.charCodeAt(0)));
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
  payload: Omit<NaelaoJwtClaims, "iat" | "exp" | "jti"> & { iat?: number; exp?: number; jti?: string },
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
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  const sigB64 = base64UrlEncode(new Uint8Array(signature));

  return `${signingInput}.${sigB64}`;
}

export async function verifyJwt(
  token: string,
  secret: string
): Promise<NaelaoJwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("invalid_token", "Malformed JWT");

  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
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

  const claims = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadB64))
  ) as NaelaoJwtClaims;

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) throw new AuthError("token_expired", "JWT has expired");
  if (claims.iat > now + 60)
    throw new AuthError("invalid_token", "JWT issued in the future");

  return claims;
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
