// packages/security/src/gatekeeper.ts

export interface GatekeeperGrant {
  resource: string; // e.g., "sqlite_db", "slack_channel"
  target: string;   // e.g., "table:bug_reports", "#engineering"
  operations: Array<"read" | "write" | "delete" | "execute">;
}

export interface GatekeeperCapabilityPayload {
  appId: string;
  spaceId: string;
  creatorUserId: string;
  grants: GatekeeperGrant[];
  expiresAt: number; // Unix timestamp
  nonce: string;
}

export interface GatekeeperToken {
  payload: GatekeeperCapabilityPayload;
  signature: string; // Base64 encoded HMAC-SHA256
}

/**
 * Mints an unforgeable capability token for cross-subspace or cross-agent delegation.
 */
export async function mintGatekeeperToken(
  payload: Omit<GatekeeperCapabilityPayload, "nonce">,
  platformSecret: string
): Promise<string> {
  const fullPayload: GatekeeperCapabilityPayload = {
    ...payload,
    nonce: crypto.randomUUID()
  };

  const payloadString = JSON.stringify(fullPayload);
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadString)
  );

  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  
  // Return format: Base64Url(payload).Signature
  const payloadBase64Url = btoa(payloadString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${payloadBase64Url}.${signatureBase64}`;
}

/**
 * Verifies a Gatekeeper token and checks for expiration.
 */
export async function verifyGatekeeperToken(
  tokenString: string,
  platformSecret: string
): Promise<GatekeeperCapabilityPayload> {
  const [payloadBase64Url, signatureBase64] = tokenString.split(".");
  if (!payloadBase64Url || !signatureBase64) {
    throw new Error("Invalid Gatekeeper token format.");
  }

  // Restore Base64 formatting
  let base64 = payloadBase64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  
  const payloadString = atob(base64);
  const payload: GatekeeperCapabilityPayload = JSON.parse(payloadString);

  // Expiration Check
  if (Date.now() > payload.expiresAt) {
    throw new Error(`Gatekeeper Violation: Token expired at ${new Date(payload.expiresAt).toISOString()}`);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signatureBuffer = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));

  const isValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBuffer,
    encoder.encode(payloadString)
  );

  if (!isValid) {
    throw new Error("Gatekeeper Violation: Cryptographic signature mismatch. Token is forged or altered.");
  }

  return payload;
}
