import { GatekeeperToken, GatekeeperGrant, MintTokenOptions } from "./types";

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
 * Mints a new cryptographically signed GatekeeperToken.
 * Enforces the Human Permission Ceiling (roleRank attenuation).
 */
export async function mintGatekeeperToken(options: MintTokenOptions, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds || 3600;

  // Attenuate grants based on roleRank (e.g., Viewer roleRank=1 cannot have delete privileges)
  const attenuatedGrants: GatekeeperGrant[] = (options.requestedGrants || []).map(grant => {
    let allowedOps = [...grant.operations];
    if (options.roleRank <= 1) {
      // Viewers can only read
      allowedOps = allowedOps.filter(op => op === "read");
    } else if (options.roleRank <= 2 && allowedOps.includes("delete")) {
      // Contributors cannot delete
      allowedOps = allowedOps.filter(op => op !== "delete");
    }
    return {
      ...grant,
      operations: allowedOps,
    };
  }).filter(g => g.operations.length > 0);

  const payloadObj = {
    appId: options.appId,
    spaceId: options.spaceId,
    userId: options.userId,
    roleRank: options.roleRank,
    grants: attenuatedGrants,
    iat: now,
    exp: now + expiresIn,
  };

  const payloadString = JSON.stringify(payloadObj);
  const sig = await computeHmac(payloadString, secret);

  const token: GatekeeperToken = {
    ...payloadObj,
    sig,
  };

  return btoa(JSON.stringify(token));
}

/**
 * Verifies a raw Gatekeeper token string, validating signature, expiration, and format.
 */
export async function verifyGatekeeperToken(rawToken: string, secret: string): Promise<GatekeeperToken> {
  let jsonStr: string;
  try {
    jsonStr = atob(rawToken);
  } catch {
    throw new Error("Invalid token encoding (not base64)");
  }

  let token: GatekeeperToken;
  try {
    token = JSON.parse(jsonStr);
  } catch {
    throw new Error("Invalid token format (not JSON)");
  }

  if (!token.appId || !token.spaceId || !token.userId || typeof token.exp !== "number" || !token.sig) {
    throw new Error("Malformed Gatekeeper token structure");
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (token.exp < now) {
    throw new Error("Gatekeeper token has expired");
  }

  // Re-compute HMAC and verify
  const { sig, ...payloadObj } = token;
  const payloadString = JSON.stringify(payloadObj);
  const expectedSig = await computeHmac(payloadString, secret);

  if (!timingSafeEqual(sig, expectedSig)) {
    throw new Error("Invalid Gatekeeper token signature");
  }

  return token;
}

/**
 * Checks if a verified token has the required capability/grant.
 */
export function checkCapability(
  token: GatekeeperToken,
  required: { resource: string; op: string; target?: string }
): boolean {
  return token.grants.some(grant => {
    const resourceMatch = grant.resource === required.resource;
    const opMatch = grant.operations.includes(required.op as any);
    const targetMatch = !required.target || grant.target === "*" || grant.target === required.target || grant.target.startsWith(required.target);
    return resourceMatch && opMatch && targetMatch;
  });
}
