import { describe, expect, it } from "vitest";
import {
  exportExtensionPublisherPublicKey,
  extensionPublisherKeyId,
  extensionPublisherSigningPayload,
  generateExtensionPublisherKeyPair,
  signExtensionPublisherRelease,
  verifyExtensionPublisherRelease,
} from "./extension-publisher-signatures.js";

describe("extension publisher release signatures", () => {
  it("signs the canonical manifest and complete original artifact map with a stable key fingerprint", async () => {
    const pair = await generateExtensionPublisherKeyPair();
    const publicRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
    const publicKey = await exportExtensionPublisherPublicKey(pair.publicKey);
    const artifacts = { "./index.html": "<main>Canvas</main>", "./worker.ts": "export async function run() {}" };
    const manifestJson = JSON.stringify({ id: "ext_signed_demo", bundle: { version: "1.0.0" } });
    const signed = await signExtensionPublisherRelease({ privateKey: pair.privateKey, publicKey: pair.publicKey, manifestJson, artifacts });
    expect(signed.keyId).toBe(await extensionPublisherKeyId(publicRaw));
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(extensionPublisherSigningPayload(manifestJson, artifacts)).toBe(extensionPublisherSigningPayload(manifestJson, { "./worker.ts": artifacts["./worker.ts"]!, "./index.html": artifacts["./index.html"]! }));
    expect(await verifyExtensionPublisherRelease({ publicKeyRaw: publicRaw, signature: signed.signature, manifestJson, artifacts })).toBe(true);
    expect(await verifyExtensionPublisherRelease({ publicKeyRaw: publicRaw, signature: signed.signature, manifestJson, artifacts: { ...artifacts, "./index.html": "<main>changed</main>" } })).toBe(false);
    expect(await verifyExtensionPublisherRelease({ publicKeyRaw: publicRaw, signature: signed.signature, manifestJson: `${manifestJson} `, artifacts })).toBe(false);
  });

  it("rejects unsafe artifact paths and malformed signature encodings", async () => {
    expect(() => extensionPublisherSigningPayload("{}", { "../escape.js": "x" })).toThrow("extension_publisher_artifact_invalid");
    const pair = await generateExtensionPublisherKeyPair();
    const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
    expect(await verifyExtensionPublisherRelease({ publicKeyRaw: raw, signature: "!", manifestJson: "{}", artifacts: {} })).toBe(false);
  });
});
