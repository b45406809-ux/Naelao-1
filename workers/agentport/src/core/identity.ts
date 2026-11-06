const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ED25519 = { name: "Ed25519" } as AlgorithmIdentifier;

function b64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function unb64url(value: string) { return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), ch => ch.charCodeAt(0)); }
function jsonPart(value: unknown) { return b64url(encoder.encode(JSON.stringify(value))); }

async function sealingKey(secret: string, agentId: string) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("agentport-agent-signing-key-seal-v1"), info: encoder.encode(agentId) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function createSealedAgentKey(secret: string, agentId: string, issuer: string) {
  if (secret.length < 32) throw new Error("agentport_identity_seal_secret_too_short");
  const pair = await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"]) as CryptoKeyPair;
  const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = `${issuer.replace(/\/$/, "")}/.well-known/agentport/agents/${encodeURIComponent(agentId)}/jwks.json#key-1`;
  const jwk = { ...publicJwk, kid, alg: "EdDSA", use: "sig" };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealingKey(secret, agentId), privateKey);
  return { id: kid, publicJwk: JSON.stringify(jwk), ciphertext: b64url(new Uint8Array(ciphertext)), iv: b64url(iv) };
}

export async function signAgentCredential(input: {
  secret: string; agentId: string; kid: string; ciphertext: string; iv: string;
  issuer: string; audience: string; principal: { id: string; type: string; verificationLevel: string };
  host: { platform: string; resourceId?: string | null }; actions: string[]; ttlSeconds: number; now?: number;
}) {
  const privateKeyBytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(input.iv) }, await sealingKey(input.secret, input.agentId), unb64url(input.ciphertext));
  const privateKey = await crypto.subtle.importKey("pkcs8", privateKeyBytes, ED25519, false, ["sign"]);
  const issuedAt = Math.floor((input.now ?? Date.now()) / 1000);
  const jti = `apc_${crypto.randomUUID().replaceAll("-", "")}`;
  const header = jsonPart({ alg: "EdDSA", typ: "JWT", kid: input.kid });
  const claims = jsonPart({
    iss: input.issuer.replace(/\/$/, ""), sub: input.agentId, aud: input.audience,
    iat: issuedAt, exp: issuedAt + input.ttlSeconds, jti,
    principal: input.principal, host: input.host,
    scope: [...new Set(input.actions)], credential_type: "agentport_mandate_v1",
  });
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(ED25519, privateKey, encoder.encode(signingInput));
  return { credential: `${signingInput}.${b64url(new Uint8Array(signature))}`, jti, expiresAt: new Date((issuedAt + input.ttlSeconds) * 1000).toISOString() };
}

export async function verifyAgentCredentialLocal(input: { credential: string; audience: string; trustedIssuer: string; jwks: { keys: Array<JsonWebKey & { kid?: string; alg?: string }> }; now?: number }) {
  const parts = input.credential.split(".");
  if (parts.length !== 3) return { valid: false as const, reason: "malformed_credential" };
  try {
    const header = JSON.parse(decoder.decode(unb64url(parts[0]!))) as { alg?: string; kid?: string };
    const claims = JSON.parse(decoder.decode(unb64url(parts[1]!))) as { iss?: string; aud?: string | string[]; exp?: number; iat?: number; jti?: string; sub?: string };
    if (header.alg !== "EdDSA" || !header.kid) return { valid: false as const, reason: "unsupported_credential" };
    if (claims.iss !== input.trustedIssuer.replace(/\/$/, "")) return { valid: false as const, reason: "untrusted_issuer" };
    if (!(Array.isArray(claims.aud) ? claims.aud.includes(input.audience) : claims.aud === input.audience)) return { valid: false as const, reason: "audience_mismatch" };
    const now = Math.floor((input.now ?? Date.now()) / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= now || typeof claims.iat !== "number" || claims.iat > now + 30 || typeof claims.jti !== "string") return { valid: false as const, reason: "credential_expired_or_invalid" };
    const jwk = input.jwks.keys.find(key => key.kid === header.kid && key.alg === "EdDSA");
    if (!jwk) return { valid: false as const, reason: "signing_key_untrusted" };
    const publicKey = await crypto.subtle.importKey("jwk", jwk, ED25519, false, ["verify"]);
    const verified = await crypto.subtle.verify(ED25519, publicKey, unb64url(parts[2]!), encoder.encode(`${parts[0]}.${parts[1]}`));
    return verified ? { valid: true as const, claims } : { valid: false as const, reason: "invalid_signature" };
  } catch { return { valid: false as const, reason: "malformed_credential" }; }
}
