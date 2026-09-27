import type { RepositoryScope } from "./repository.js";

export interface RepositoryTokenClaims extends RepositoryScope {
  repoId: string;
  exp: number;
}

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array): string => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};
const decodeBase64url = (value: string): Uint8Array => {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  );
}

/** Short-lived, repository-scoped capability used only by an ArtifactFS mount. */
export async function createRepositoryToken(
  secret: string,
  claims: RepositoryTokenClaims
): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  return `${payload}.${base64url(await hmac(secret, payload))}`;
}

export async function verifyRepositoryToken(
  secret: string,
  token: string,
  repoId: string,
  now = Date.now()
): Promise<RepositoryTokenClaims | null> {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) return null;
  const expected = await hmac(secret, payload);
  const supplied = decodeBase64url(suppliedSignature);
  if (supplied.byteLength !== expected.byteLength) return null;
  let difference = 0;
  for (let index = 0; index < expected.byteLength; index++)
    difference |= (expected[index] ?? 0) ^ (supplied[index] ?? 0);
  if (difference !== 0) return null;
  try {
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64url(payload))
    ) as RepositoryTokenClaims;
    if (
      claims.repoId !== repoId ||
      claims.projectId !== repoId ||
      claims.exp <= now
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}
