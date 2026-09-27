const encoder = new TextEncoder();

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
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Malformed signed token");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  if (!secret) throw new Error("HMAC secret is required");
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

async function issue<T extends object>(kind: string, payload: T, secret: string): Promise<string> {
  const body = encode(encoder.encode(JSON.stringify({ v: 1, kind, ...payload })));
  return `${body}.${encode(await hmac(secret, body))}`;
}

async function verify<T extends object>(token: string, kind: string, secret: string): Promise<T | null> {
  try {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) return null;
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    if (!(await crypto.subtle.verify("HMAC", key, decode(signature), encoder.encode(body)))) return null;
    const parsed = JSON.parse(new TextDecoder().decode(decode(body))) as T & { v?: number; kind?: string };
    if (parsed.v !== 1 || parsed.kind !== kind) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function issueCapabilityToken(payload: CapabilityTokenPayload, secret: string): Promise<string> {
  if (!payload.granteeSpaceId || !payload.targetSpaceId || !payload.resourceId || !payload.nonce ||
      !Array.isArray(payload.permissions) || !payload.permissions.every((item) => typeof item === "string") ||
      !Number.isSafeInteger(payload.exp)) throw new Error("Invalid capability payload");
  return issue("cross-space-capability", payload, secret);
}

export async function verifyCapabilityToken(
  token: string,
  secret: string,
  expected: { granteeSpaceId: string; targetSpaceId: string; resourceId: string; permission?: string },
  now = Date.now()
): Promise<CapabilityTokenPayload | null> {
  const claim = await verify<CapabilityTokenPayload>(token, "cross-space-capability", secret);
  if (!claim || claim.exp <= now || claim.granteeSpaceId !== expected.granteeSpaceId ||
      claim.targetSpaceId !== expected.targetSpaceId || claim.resourceId !== expected.resourceId ||
      (expected.permission && !claim.permissions.includes(expected.permission))) return null;
  return claim;
}

export async function issueDelegationClaim(claim: DelegationClaim, secret: string): Promise<string> {
  if (!claim.initiatorUserId || !claim.targetResourceId || claim.depth < 1 || claim.depth > 3 ||
      !Number.isSafeInteger(claim.originatingRoleRank) || !Number.isSafeInteger(claim.exp)) {
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
  const claim = await verify<DelegationClaim>(token, "agent-delegation", secret);
  if (!claim || claim.exp <= now || claim.depth < 1 || claim.depth > 3 ||
      (constraints.targetResourceId && claim.targetResourceId !== constraints.targetResourceId) ||
      (constraints.maximumRoleRank !== undefined && claim.originatingRoleRank > constraints.maximumRoleRank)) return null;
  return claim;
}
