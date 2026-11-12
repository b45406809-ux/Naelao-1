const encoder = new TextEncoder();
const encode = (value: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < value.length; i += 32_768) binary += String.fromCharCode(...value.subarray(i, i + 32_768));
  return btoa(binary);
};
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

export interface SealedRecord { ciphertext: string; iv: string; }

/** Tenant and record bound encryption for command payloads and execution output. */
export async function sealSandboxRecord(
  secret: string,
  tenantId: string,
  ownerId: string,
  recordId: string,
  purpose: "request" | "result",
  plaintext: string,
): Promise<SealedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(secret, tenantId);
  const aad = encoder.encode(`naelao-sandbox-record:v1:${tenantId}:${ownerId}:${recordId}:${purpose}`);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, encoder.encode(plaintext));
  return { ciphertext: encode(new Uint8Array(ciphertext)), iv: encode(iv) };
}

export async function openSandboxRecord(
  secret: string,
  tenantId: string,
  ownerId: string,
  recordId: string,
  purpose: "request" | "result",
  sealed: SealedRecord,
): Promise<string> {
  const key = await keyFor(secret, tenantId);
  const aad = encoder.encode(`naelao-sandbox-record:v1:${tenantId}:${ownerId}:${recordId}:${purpose}`);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(sealed.iv), additionalData: aad }, key, decode(sealed.ciphertext));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
}

async function keyFor(secret: string, tenantId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("naelao-sandbox-records-v1"), info: encoder.encode(tenantId) },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
