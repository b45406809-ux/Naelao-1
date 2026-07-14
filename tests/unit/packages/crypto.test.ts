// Unit tests for @naelao/crypto (G-B02, G-CR01..CR06)
import { describe, it, expect } from "vitest";
import {
  hashPassword, verifyPassword,
  encrypt, decrypt, generateDek, exportDek, importDek,
  wrapDek, unwrapDek, deriveKek,
  signHmac, verifyHmac,
} from "../../../packages/crypto/src/index.js";

describe("PBKDF2 password hashing (G-B02)", () => {
  it("hashes a password and returns salt+hash+iterations", async () => {
    const result = await hashPassword("hunter2");
    expect(result.hash).toBeTruthy();
    expect(result.salt).toBeTruthy();
    // Cloudflare Workers' WebCrypto PBKDF2 caps iterations at 100,000 (a real deployment throws
    // NotSupportedError above that, confirmed via a live wrangler tail session) — 600k was never
    // actually deployable.
    expect(result.iterations).toBe(100_000);
    expect(result.hash).not.toBe(result.salt);
  });

  it("verifies the correct password", async () => {
    const stored = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("correct-horse-battery-staple", stored)).toBe(true);
  });

  it("rejects wrong password", async () => {
    const stored = await hashPassword("correct-horse");
    expect(await verifyPassword("wrong-horse", stored)).toBe(false);
  });

  it("produces different hashes for the same password (random salt)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });

  it("hash is at least 32 bytes of hex (256 bits)", async () => {
    const { hash } = await hashPassword("test");
    // hex-encoded 32 bytes = 64 chars
    expect(hash.length).toBeGreaterThanOrEqual(64);
  });
});

describe("AES-256-GCM envelope encryption (G-CR01..CR04)", () => {
  it("encrypts and decrypts plaintext round-trip", async () => {
    const dek = await generateDek();
    const envelope = await encrypt("Hello, Naelao!", dek);
    expect(envelope.ciphertext).toBeTruthy();
    expect(envelope.iv).toBeTruthy();
    const plaintext = await decrypt(envelope, dek);
    expect(plaintext).toBe("Hello, Naelao!");
  });

  it("produces different ciphertext for same plaintext (random IV)", async () => {
    const dek = await generateDek();
    const a = await encrypt("same plaintext", dek);
    const b = await encrypt("same plaintext", dek);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it("fails to decrypt with a different DEK", async () => {
    const dek1 = await generateDek();
    const dek2 = await generateDek();
    const envelope = await encrypt("secret", dek1);
    await expect(decrypt(envelope, dek2)).rejects.toThrow();
  });

  it("exports and imports DEK round-trip", async () => {
    const dek = await generateDek();
    const exported = await exportDek(dek);
    const imported = await importDek(exported);
    // Should be able to use imported DEK to decrypt data encrypted with original
    const envelope = await encrypt("round-trip", dek);
    const decrypted = await decrypt(envelope, imported);
    expect(decrypted).toBe("round-trip");
  });

  it("wraps and unwraps DEK with KEK round-trip", async () => {
    const dek = await generateDek();
    const kek = await deriveKek("platform-secret-32bytes-min-length", "tenant123");
    const wrapped = await wrapDek(dek, kek);
    const unwrapped = await unwrapDek(wrapped, kek);

    const envelope = await encrypt("wrapped-dek-test", dek);
    const decrypted = await decrypt(envelope, unwrapped);
    expect(decrypted).toBe("wrapped-dek-test");
  });

  it("deriveKek produces deterministic output for same inputs", async () => {
    const kek1 = await deriveKek("secret", "tenant-abc");
    const kek2 = await deriveKek("secret", "tenant-abc");
    // Both should work for wrapping/unwrapping
    const dek = await generateDek();
    const wrapped = await wrapDek(dek, kek1);
    await expect(unwrapDek(wrapped, kek2)).resolves.toBeDefined();
  });
});

describe("HMAC-SHA256 signing (G-CR05)", () => {
  it("signs and verifies correctly", async () => {
    const sig = await signHmac("test-payload", "my-secret");
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
    expect(await verifyHmac("test-payload", sig, "my-secret")).toBe(true);
  });

  it("rejects wrong payload", async () => {
    const sig = await signHmac("original", "secret");
    expect(await verifyHmac("tampered", sig, "secret")).toBe(false);
  });

  it("rejects wrong secret", async () => {
    const sig = await signHmac("payload", "correct-secret");
    expect(await verifyHmac("payload", sig, "wrong-secret")).toBe(false);
  });

  it("produces hex output", async () => {
    const sig = await signHmac("data", "key");
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });
});
