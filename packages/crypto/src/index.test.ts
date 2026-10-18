import { describe, expect, it } from "vitest";
import {
  decrypt,
  decryptAuthenticated,
  deriveKek,
  deriveSpaceDataKey,
  encrypt,
  encryptAuthenticated,
  generateDek,
  hashPassword,
  importDek,
  signHmac,
  unwrapDek,
  verifyHmac,
  verifyPassword,
  wrapDek,
} from "./index.js";

describe("cryptographic input boundaries", () => {
  it("rejects malformed and attacker-controlled PBKDF2 metadata before deriving", async () => {
    const stored = await hashPassword("correct horse");
    await expect(
      verifyPassword("correct horse", { ...stored, iterations: 1 })
    ).resolves.toBe(false);
    await expect(
      verifyPassword("correct horse", {
        ...stored,
        algorithm: "pbkdf2-sha256-weak" as never,
      })
    ).resolves.toBe(false);
    await expect(
      verifyPassword("correct horse", { ...stored, salt: "0g" })
    ).resolves.toBe(false);
    await expect(
      verifyPassword("correct horse", { ...stored, hash: "f" })
    ).resolves.toBe(false);
  });

  it("rejects HMAC encodings with malformed hex while accepting canonical case-insensitive hex", async () => {
    const signature = await signHmac("payload", "secret");
    expect(await verifyHmac("payload", signature, "secret")).toBe(true);
    expect(await verifyHmac("payload", signature.toUpperCase(), "secret")).toBe(
      true
    );
    expect(
      await verifyHmac(
        "payload",
        `${signature.slice(0, 2)}g${signature.slice(3)}`,
        "secret"
      )
    ).toBe(false);
    expect(await verifyHmac("payload", `${signature}00`, "secret")).toBe(false);
    expect(await verifyHmac("payload", signature, "")).toBe(false);
  });

  it("rejects non-canonical base64 and malformed wrapped DEKs", async () => {
    await expect(importDek("%%%=")).rejects.toThrow("invalid_base64");
    await expect(importDek(btoa("short"))).rejects.toThrow(
      "invalid_dek_length"
    );
    await expect(
      unwrapDek(btoa("short"), await deriveKek("platform-secret", "tenant-a"))
    ).rejects.toThrow("invalid_wrapped_dek");
  });

  it("validates envelope algorithm, IV length, tag length, and authenticated metadata", async () => {
    const dek = await generateDek();
    const envelope = await encryptAuthenticated(
      "secret",
      dek,
      "tenant-a:credential-1"
    );
    await expect(
      decryptAuthenticated(envelope, dek, "tenant-b:credential-1")
    ).rejects.toThrow();
    await expect(
      decrypt({ ...envelope, algorithm: "unknown" as never }, dek)
    ).rejects.toThrow("invalid_encrypted_envelope");
    await expect(
      decrypt({ ...envelope, iv: btoa("short") }, dek)
    ).rejects.toThrow("invalid_encrypted_envelope");
    await expect(
      decrypt({ ...envelope, ciphertext: btoa("tiny") }, dek)
    ).rejects.toThrow("invalid_encrypted_envelope");
  });

  it("round-trips megabyte envelopes without spreading unbounded arrays into btoa", async () => {
    const dek = await generateDek();
    const plaintext = "x".repeat(1_000_000);
    const envelope = await encrypt(plaintext, dek);
    await expect(decrypt(envelope, dek)).resolves.toBe(plaintext);
  });

  it("rejects missing key derivation scope and separates space keys", async () => {
    await expect(deriveKek("", "tenant-a")).rejects.toThrow(
      "encryption_scope_required"
    );
    await expect(deriveKek("platform-secret", "")).rejects.toThrow(
      "encryption_scope_required"
    );
    const keyA = await deriveSpaceDataKey(
      "master-secret",
      "tenant-a",
      "space-a"
    );
    const keyB = await deriveSpaceDataKey(
      "master-secret",
      "tenant-a",
      "space-b"
    );
    const envelope = await encrypt("space data", keyA);
    await expect(decrypt(envelope, keyB)).rejects.toThrow();
  });
});
