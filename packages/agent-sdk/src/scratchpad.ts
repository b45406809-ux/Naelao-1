export interface ScratchpadEnvelope { version: 1; iv: string; ciphertext: string }
const prefix = "naelao-scratchpad:v1:";
export const MAX_SCRATCHPAD_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_SCRATCHPAD_CIPHERTEXT_BYTES = MAX_SCRATCHPAD_PLAINTEXT_BYTES + 16; // AES-GCM tag
const MAX_SCRATCHPAD_ENVELOPE_CHARS = prefix.length + 128 + 4 * Math.ceil(MAX_SCRATCHPAD_CIPHERTEXT_BYTES / 3);
const encode = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};
const decode = (text: string) => {
  const decoded = Uint8Array.from(atob(text), char => char.charCodeAt(0));
  if (encode(decoded) !== text) throw new Error("scratchpad_base64_noncanonical");
  return decoded;
};
export function parseScratchpadCiphertext(text: string): ScratchpadEnvelope | undefined {
  if (typeof text !== "string" || text.length > MAX_SCRATCHPAD_ENVELOPE_CHARS || !text.startsWith(prefix)) return undefined;
  try {
    const value = JSON.parse(text.slice(prefix.length)) as ScratchpadEnvelope;
    if (value.version !== 1 || typeof value.iv !== "string" || typeof value.ciphertext !== "string"
      || value.iv.length !== 16 || value.ciphertext.length < 24) return undefined;
    const iv = decode(value.iv), ciphertext = decode(value.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > MAX_SCRATCHPAD_CIPHERTEXT_BYTES) return undefined;
    return value;
  } catch { return undefined; }
}
export async function createScratchpadKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
}
export async function sealScratchpad(text: string, key: CryptoKey, sessionId: string): Promise<string> {
  if (text.length > MAX_SCRATCHPAD_PLAINTEXT_BYTES) throw new Error("scratchpad_plaintext_too_large");
  const plaintext = new TextEncoder().encode(text);
  if (plaintext.byteLength > MAX_SCRATCHPAD_PLAINTEXT_BYTES) throw new Error("scratchpad_plaintext_too_large");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(sessionId) }, key, plaintext);
  return prefix + JSON.stringify({ version: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
}
export async function openScratchpad(text: string, key: CryptoKey, sessionId: string): Promise<string> {
  const envelope = parseScratchpadCiphertext(text);
  if (!envelope) throw new Error("scratchpad_ciphertext_required");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(envelope.iv), additionalData: new TextEncoder().encode(sessionId) }, key, decode(envelope.ciphertext));
  if (plaintext.byteLength > MAX_SCRATCHPAD_PLAINTEXT_BYTES) throw new Error("scratchpad_plaintext_too_large");
  return new TextDecoder().decode(plaintext);
}
