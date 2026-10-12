export interface ScratchpadEnvelope { version: 1; iv: string; ciphertext: string }
const prefix = "naelao-scratchpad:v1:";
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
const decode = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));
export function parseScratchpadCiphertext(text: string): ScratchpadEnvelope | undefined {
  if (!text.startsWith(prefix)) return undefined;
  try {
    const value = JSON.parse(text.slice(prefix.length)) as ScratchpadEnvelope;
    if (value.version !== 1 || typeof value.iv !== "string" || typeof value.ciphertext !== "string" || decode(value.iv).length !== 12 || decode(value.ciphertext).length < 16) return undefined;
    return value;
  } catch { return undefined; }
}
export async function createScratchpadKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
}
export async function sealScratchpad(text: string, key: CryptoKey, sessionId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(sessionId) }, key, new TextEncoder().encode(text));
  return prefix + JSON.stringify({ version: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
}
export async function openScratchpad(text: string, key: CryptoKey, sessionId: string): Promise<string> {
  const envelope = parseScratchpadCiphertext(text);
  if (!envelope) throw new Error("scratchpad_ciphertext_required");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(envelope.iv), additionalData: new TextEncoder().encode(sessionId) }, key, decode(envelope.ciphertext));
  return new TextDecoder().decode(plaintext);
}
