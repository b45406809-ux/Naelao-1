import type { BrowserRuntimeScope } from "@naelao/agent-sdk";
export interface WebsiteState {
  cookies: unknown[];
  localStorage: Record<string, Array<[string, string]>>;
}
export function profileOwner(scope: BrowserRuntimeScope): string {
  return JSON.stringify([
    scope.tenantId,
    scope.spaceId,
    scope.projectId ?? "",
    scope.actorId,
    scope.connectionId,
  ]);
}
async function profileKey(secret: string, owner: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(owner),
      info: new TextEncoder().encode("naelao.website-profile.v1"),
    },
    root,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
export async function sealProfile(
  secret: string,
  owner: string,
  state: WebsiteState
): Promise<{ iv: number[]; data: string }> {
  const plain = new TextEncoder().encode(JSON.stringify(state));
  if (plain.byteLength > 64_000)
    throw new Error("browser_profile_storage_limit");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(owner) },
    await profileKey(secret, owner),
    plain
  );
  return {
    iv: Array.from(iv),
    data: btoa(
      Array.from(new Uint8Array(data), (byte) =>
        String.fromCharCode(byte)
      ).join("")
    ),
  };
}
export async function openProfile(
  secret: string,
  owner: string,
  sealed: { iv: number[]; data: string }
): Promise<WebsiteState> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(sealed.iv),
      additionalData: new TextEncoder().encode(owner),
    },
    await profileKey(secret, owner),
    Uint8Array.from(atob(sealed.data), (char) => char.charCodeAt(0))
  );
  return JSON.parse(new TextDecoder().decode(plain)) as WebsiteState;
}
export function leaseOwner(scope: BrowserRuntimeScope): string {
  return JSON.stringify([scope.agentId, scope.runId, scope.sessionId]);
}
