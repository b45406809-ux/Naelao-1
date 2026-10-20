import { describe, expect, it } from "vitest";
import { createScratchpadKey, MAX_SCRATCHPAD_PLAINTEXT_BYTES, parseScratchpadCiphertext, sealScratchpad, openScratchpad } from "./scratchpad.js";

describe("encrypted scratchpad bounds", () => {
  it("round trips text at the configured UTF-8 byte ceiling", async () => {
    const key = await createScratchpadKey();
    const text = "é".repeat(MAX_SCRATCHPAD_PLAINTEXT_BYTES / 2);
    const encrypted = await sealScratchpad(text, key, "session");
    expect(parseScratchpadCiphertext(encrypted)).toBeDefined();
    expect(await openScratchpad(encrypted, key, "session")).toBe(text);
  });

  it("rejects plaintext over the byte ceiling before encryption", async () => {
    const key = await createScratchpadKey();
    await expect(sealScratchpad("é".repeat(MAX_SCRATCHPAD_PLAINTEXT_BYTES / 2 + 1), key, "session"))
      .rejects.toThrow("scratchpad_plaintext_too_large");
    await expect(sealScratchpad("x".repeat(MAX_SCRATCHPAD_PLAINTEXT_BYTES + 1), key, "session"))
      .rejects.toThrow("scratchpad_plaintext_too_large");
  });

  it("rejects oversized and noncanonical encrypted envelopes before decryption", async () => {
    const key = await createScratchpadKey();
    const encrypted = await sealScratchpad("x", key, "session");
    expect(parseScratchpadCiphertext(`${encrypted}${" ".repeat(1_500_000)}`)).toBeUndefined();
    const envelope = JSON.parse(encrypted.slice("naelao-scratchpad:v1:".length)) as { version: number; iv: string; ciphertext: string };
    const lastDataChar = envelope.ciphertext.length - (envelope.ciphertext.endsWith("==") ? 3 : 2);
    const decoded = atob(envelope.ciphertext);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const alias = [...alphabet].find(char => {
      if (char === envelope.ciphertext[lastDataChar]) return false;
      const candidate = envelope.ciphertext.slice(0, lastDataChar) + char + envelope.ciphertext.slice(lastDataChar + 1);
      return atob(candidate) === decoded;
    });
    expect(alias).toBeDefined();
    envelope.ciphertext = envelope.ciphertext.slice(0, lastDataChar) + alias + envelope.ciphertext.slice(lastDataChar + 1);
    expect(parseScratchpadCiphertext(`naelao-scratchpad:v1:${JSON.stringify(envelope)}`)).toBeUndefined();
  });
});
