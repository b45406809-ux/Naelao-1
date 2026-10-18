const encoder = new TextEncoder();
const MAX_TOKEN_CHARS = 16_384;
const MAX_IDENTIFIER_CHARS = 256;
const MAX_PERMISSIONS = 64;

export interface CapabilityTokenPayload {
  granteeSpaceId: string;
  targetSpaceId: string;
  resourceId: string;
  permissions: string[];
  exp: number;
  nonce: string;
}

export interface DelegationClaim {
  initiatorUserId: string;
  originatingRoleRank: number;
  targetResourceId: string;
  depth: 1 | 2 | 3;
  exp: number;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Malformed signed token");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  if (!secret) throw new Error("HMAC secret is required");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  );
}

async function issue<T extends object>(
  kind: string,
  payload: T,
  secret: string
): Promise<string> {
  if (!secret || secret.length > 4_096)
    throw new Error("Invalid signing secret");
  const body = encode(
    encoder.encode(JSON.stringify({ v: 1, kind, ...payload }))
  );
  if (body.length > MAX_TOKEN_CHARS)
    throw new Error("Delegation token is too large");
  return `${body}.${encode(await hmac(secret, body))}`;
}

async function verify<T extends object>(
  token: string,
  kind: string,
  secret: string
): Promise<T | null> {
  try {
    if (
      typeof token !== "string" ||
      token.length > MAX_TOKEN_CHARS ||
      !secret ||
      secret.length > 4_096
    )
      return null;
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signatureBytes = decode(signature);
    // Reject non-canonical base64url. Otherwise changing unused trailing bits can produce a
    // different token string that decodes to the same MAC and incorrectly passes as untampered.
    if (encode(signatureBytes) !== signature) return null;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        signatureBytes,
        encoder.encode(body)
      ))
    )
      return null;
    const parsed = JSON.parse(new TextDecoder().decode(decode(body))) as T & {
      v?: number;
      kind?: string;
    };
    if (parsed.v !== 1 || parsed.kind !== kind) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function issueCapabilityToken(
  payload: CapabilityTokenPayload,
  secret: string
): Promise<string> {
  if (
    !payload ||
    ![
      payload.granteeSpaceId,
      payload.targetSpaceId,
      payload.resourceId,
      payload.nonce,
    ].every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= MAX_IDENTIFIER_CHARS
    ) ||
    !Array.isArray(payload.permissions) ||
    payload.permissions.length > MAX_PERMISSIONS ||
    !payload.permissions.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= MAX_IDENTIFIER_CHARS
    ) ||
    !Number.isSafeInteger(payload.exp)
  )
    throw new Error("Invalid capability payload");
  return issue("cross-space-capability", payload, secret);
}

export async function verifyCapabilityToken(
  token: string,
  secret: string,
  expected: {
    granteeSpaceId: string;
    targetSpaceId: string;
    resourceId: string;
    permission?: string;
  },
  now = Date.now()
): Promise<CapabilityTokenPayload | null> {
  const claim = await verify<CapabilityTokenPayload>(
    token,
    "cross-space-capability",
    secret
  );
  if (
    !claim ||
    claim.exp <= now ||
    claim.granteeSpaceId !== expected.granteeSpaceId ||
    claim.targetSpaceId !== expected.targetSpaceId ||
    claim.resourceId !== expected.resourceId ||
    (expected.permission && !claim.permissions.includes(expected.permission))
  )
    return null;
  return claim;
}

export async function issueDelegationClaim(
  claim: DelegationClaim,
  secret: string
): Promise<string> {
  if (
    !claim ||
    typeof claim.initiatorUserId !== "string" ||
    !claim.initiatorUserId ||
    claim.initiatorUserId.length > MAX_IDENTIFIER_CHARS ||
    typeof claim.targetResourceId !== "string" ||
    !claim.targetResourceId ||
    claim.targetResourceId.length > MAX_IDENTIFIER_CHARS ||
    claim.depth < 1 ||
    claim.depth > 3 ||
    !Number.isSafeInteger(claim.originatingRoleRank) ||
    !Number.isSafeInteger(claim.exp)
  ) {
    throw new Error("Invalid delegation claim");
  }
  return issue("agent-delegation", claim, secret);
}

export async function verifyDelegationClaim(
  token: string,
  secret: string,
  constraints: { targetResourceId?: string; maximumRoleRank?: number } = {},
  now = Date.now()
): Promise<DelegationClaim | null> {
  const claim = await verify<DelegationClaim>(
    token,
    "agent-delegation",
    secret
  );
  if (
    !claim ||
    claim.exp <= now ||
    claim.depth < 1 ||
    claim.depth > 3 ||
    (constraints.targetResourceId &&
      claim.targetResourceId !== constraints.targetResourceId) ||
    (constraints.maximumRoleRank !== undefined &&
      claim.originatingRoleRank > constraints.maximumRoleRank)
  )
    return null;
  return claim;
}
