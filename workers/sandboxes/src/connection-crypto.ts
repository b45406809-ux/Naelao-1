const encoder = new TextEncoder();
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export interface SealedConnection {
  ciphertext: string;
  iv: string;
}
const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

/** AES-GCM envelope with per-tenant key derivation and identity-bound additional data. */
export async function sealConnection(
  secret: string,
  tenantId: string,
  ownerId: string,
  connectionId: string,
  plaintext: string
): Promise<SealedConnection> {
  const key = await connectionKey(secret, tenantId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(
    `naelao-sandbox-connection:v1:${tenantId}:${ownerId}:${connectionId}`
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      encoder.encode(plaintext)
    )
  );
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}
export async function openConnection(
  secret: string,
  tenantId: string,
  ownerId: string,
  connectionId: string,
  sealed: SealedConnection
): Promise<string> {
  const key = await connectionKey(secret, tenantId);
  const aad = encoder.encode(
    `naelao-sandbox-connection:v1:${tenantId}:${ownerId}:${connectionId}`
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: aad },
    key,
    fromBase64(sealed.ciphertext)
  );
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    plaintext
  );
}
async function connectionKey(
  secret: string,
  tenantId: string
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("naelao-sandbox-connections-v1"),
      info: encoder.encode(tenantId),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
