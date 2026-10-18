import { validateExtensionManifest } from "./extensions.js";

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_extension_publisher_signature_encoding");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), char => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function canonicalEntries(artifacts: Readonly<Record<string, string>>): Array<[string, string]> {
  return Object.entries(artifacts).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

/** Canonical bytes signed by an extension publisher. The host may compile source after verifying
 * this signature; the separate host release digest attests the compiled runtime artifact set. */
export function extensionPublisherSigningPayload(manifestJson: string, artifacts: Readonly<Record<string, string>>): string {
  if (manifestJson.length > 256_000 || Object.keys(artifacts).length > 128) throw new Error("extension_publisher_payload_limit");
  const entries = canonicalEntries(artifacts);
  if (entries.some(([path, source]) => !/^\.\/[A-Za-z0-9._-]{1,128}\.(?:html|ts|js)$/.test(path) || typeof source !== "string")) {
    throw new Error("extension_publisher_artifact_invalid");
  }
  return JSON.stringify(["naelao-extension-publisher-release-v1", manifestJson, entries]);
}

export async function extensionPublisherKeyId(publicKeyRaw: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", publicKeyRaw);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Validates and serializes the same canonical manifest representation used at the host trust boundary. */
export function canonicalExtensionManifestForPublisher(manifest: unknown): string {
  const validated = validateExtensionManifest(manifest);
  if (!("bundle" in validated) || !validated.bundle) throw new Error("versioned_extension_bundle_required");
  return JSON.stringify(validated);
}

export function decodeExtensionPublisherPublicKey(encoded: string): ArrayBuffer {
  const bytes = fromBase64Url(encoded);
  if (bytes.byteLength !== 65 || bytes[0] !== 4) throw new Error("invalid_extension_publisher_public_key");
  return toArrayBuffer(bytes);
}

export async function generateExtensionPublisherKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

/** Returns a raw uncompressed P-256 public key in base64url form for owner trust registration. */
export async function exportExtensionPublisherPublicKey(publicKey: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", publicKey) as ArrayBuffer));
}

/** Signs the manifest and every original artifact. Keep the private key outside Naelao. */
export async function signExtensionPublisherRelease(input: {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  manifestJson: string;
  artifacts: Readonly<Record<string, string>>;
}): Promise<{ keyId: string; signature: string }> {
  if (input.privateKey.type !== "private" || input.privateKey.algorithm.name !== "ECDSA"
    || input.publicKey.type !== "public" || input.publicKey.algorithm.name !== "ECDSA") throw new Error("extension_publisher_key_pair_required");
  const payload = extensionPublisherSigningPayload(input.manifestJson, input.artifacts);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.privateKey, encoder.encode(payload)));
  return { keyId: await extensionPublisherKeyId(await crypto.subtle.exportKey("raw", input.publicKey) as ArrayBuffer), signature: toBase64Url(signature) };
}

export async function verifyExtensionPublisherRelease(input: {
  publicKeyRaw: BufferSource;
  signature: string;
  manifestJson: string;
  artifacts: Readonly<Record<string, string>>;
}): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", input.publicKeyRaw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signature = fromBase64Url(input.signature);
    if (signature.byteLength !== 64) return false;
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, toArrayBuffer(signature), encoder.encode(extensionPublisherSigningPayload(input.manifestJson, input.artifacts)));
  } catch { return false; }
}
