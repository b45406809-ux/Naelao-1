// packages/security/src/crypto.ts

/**
 * Mints an unforgeable, time-bound ephemeral grant token.
 */
export async function mintEphemeralGrant(
  userId: string,
  spaceId: string,
  credentialName: string,
  actionName: string,
  platformSecret: string
): Promise<string> {
  const payload = {
    sub: userId,
    spc: spaceId,
    crd: credentialName,
    act: actionName,
    iat: Date.now()
  };
  
  const dataString = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(dataString));
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return `${btoa(dataString)}.${signatureBase64}`;
}

/**
 * Verifies the ephemeral grant and enforces the 15-second (15000ms) Time-To-Live.
 */
export async function verifyEphemeralGrant(
  token: string, 
  platformSecret: string
): Promise<{ valid: boolean; payload?: any; reason?: string }> {
  try {
    const [encodedPayload, signatureBase64] = token.split(".");
    if (!encodedPayload || !signatureBase64) return { valid: false, reason: "Malformed token" };

    const payload = JSON.parse(atob(encodedPayload));
    
    // 1. Check TTL: Reject if older than 15,000 milliseconds (15 seconds)
    const now = Date.now();
    if (now - payload.iat > 15000) {
      return { valid: false, reason: "Ephemeral grant expired (TTL > 15s)." };
    }

    // 2. Verify Cryptographic Signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(platformSecret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["verify"]
    );
    
    const signatureBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(atob(encodedPayload)));

    if (!isValid) return { valid: false, reason: "Invalid HMAC signature" };

    return { valid: true, payload };
  } catch (err) {
    return { valid: false, reason: "Cryptographic verification failed" };
  }
}
