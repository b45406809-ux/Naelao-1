import { describe, expect, it } from "vitest";
import { issueScopedCapabilityToken, verifyScopedCapabilityToken } from "@naelao/security";

const claims = {
  issuer: "space-do", audience: "agents-worker", actorId: "agent-a", tenantId: "tenant-a",
  spaceId: "space-a", projectId: "project-a", installationId: "installation-a",
  operation: "storage.read", resource: "document-a", revocationEpoch: 2,
};
const secret = "test-only-capability-secret";
const context = { ...claims, now: 100 };

// Models a correctly signed but malformed token from an erroneous/compromised issuer.
// Verification must validate claims, not rely on the issuance helper doing that earlier.
async function signedClaims(payload: Record<string, unknown>): Promise<string> {
  const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const header = encode(JSON.stringify({ alg: "HS256", typ: "NAELAO-CAP" }));
  const body = encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${encode(String.fromCharCode(...mac))}`;
}

describe("capability boundary validation", () => {
  it("requires exact scope, including absent project and installation boundaries", async () => {
    const token = await issueScopedCapabilityToken({ ...claims, ttlSeconds: 60 }, secret, 100);
    await expect(verifyScopedCapabilityToken(token, secret, context)).resolves.toMatchObject(claims);
    await expect(verifyScopedCapabilityToken(token, secret, { ...context, projectId: undefined })).rejects.toThrow("scope_mismatch:projectId");
    await expect(verifyScopedCapabilityToken(token, secret, { ...context, installationId: undefined })).rejects.toThrow("scope_mismatch:installationId");
    const unbound = { ...claims, projectId: undefined, installationId: undefined };
    const spaceToken = await issueScopedCapabilityToken({ ...unbound, ttlSeconds: 60 }, secret, 100);
    await expect(verifyScopedCapabilityToken(spaceToken, secret, { ...unbound, now: 100 })).resolves.toMatchObject({ spaceId: "space-a" });
    await expect(verifyScopedCapabilityToken(spaceToken, secret, context)).rejects.toThrow("scope_mismatch:projectId");
  });

  it.each([
    { expiresAt: undefined }, { issuedAt: undefined }, { expiresAt: null },
    { expiresAt: "160" }, { expiresAt: 1000.5 }, { expiresAt: 1001 },
    { expiresAt: 99 }, { revocationEpoch: undefined }, { revocationEpoch: -1 },
    { tokenId: undefined }, { actorId: null },
  ])("rejects signed malformed claims %j", async (override) => {
    const token = await signedClaims({ ...claims, issuedAt: 100, expiresAt: 160, tokenId: "id", ...override });
    await expect(verifyScopedCapabilityToken(token, secret, context)).rejects.toThrow("invalid_claims");
  });

  it("rejects expiry and revocation across independent verifier calls", async () => {
    const token = await issueScopedCapabilityToken({ ...claims, ttlSeconds: 60 }, secret, 100);
    await expect(verifyScopedCapabilityToken(token, secret, { ...context, now: 160 })).rejects.toThrow("expired_token");
    await expect(verifyScopedCapabilityToken(token, secret, { ...context, revocationEpoch: 3 })).rejects.toThrow("revoked_token");
    await expect(verifyScopedCapabilityToken(token, "wrong-key", context)).rejects.toThrow("invalid_signature");
  });

  it("rejects invalid issuer clocks and revocation metadata", async () => {
    await expect(issueScopedCapabilityToken({ ...claims, ttlSeconds: 60, revocationEpoch: NaN }, secret, 100)).rejects.toThrow("invalid_claims");
    await expect(issueScopedCapabilityToken({ ...claims, ttlSeconds: 60 }, secret, NaN)).rejects.toThrow("invalid_claims");
  });
});
