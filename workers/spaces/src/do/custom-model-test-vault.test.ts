import { describe, expect, it } from "vitest";
import {
  decryptTestSet,
  encryptTestSet,
  validateCustomModelTestSet,
} from "./custom-model-test-vault.js";

const set = {
  id: "support",
  version: "v1",
  cases: [
    { input: "How do I reset my password?", expected: "Use the reset link." },
  ],
};
const secret = "test-platform-secret-for-encrypted-test-set-vault";

describe("custom model evaluation test-set vault", () => {
  it("validates bounds and encrypts data with Space and version binding", async () => {
    expect(validateCustomModelTestSet(set)).toBe(true);
    const twentyCases = {
      id: "support",
      version: "support-v4",
      cases: Array.from({ length: 20 }, (_, i) => ({
        input: `Question ${i}`,
        expected: `Answer ${i}`,
      })),
    };
    expect(twentyCases.cases.length).toBe(20);
    expect(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(twentyCases.id)).toBe(true);
    expect(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(twentyCases.version)).toBe(
      true
    );
    expect(validateCustomModelTestSet(twentyCases)).toBe(true);
    expect(
      validateCustomModelTestSet({
        ...set,
        cases: Array.from({ length: 21 }, () => set.cases[0]),
      })
    ).toBe(false);
    const ciphertext = await encryptTestSet(set, secret, "tenant-1", "space-1");
    expect(ciphertext).not.toContain(set.cases.at(0)?.input ?? "");
    await expect(
      decryptTestSet(
        ciphertext,
        secret,
        "tenant-1",
        "space-1",
        set.id,
        set.version
      )
    ).resolves.toEqual(set);
    await expect(
      decryptTestSet(
        ciphertext,
        secret,
        "tenant-2",
        "space-1",
        set.id,
        set.version
      )
    ).rejects.toThrow("test_set_authentication_failed");
    await expect(
      decryptTestSet(ciphertext, secret, "tenant-1", "space-1", set.id, "v2")
    ).rejects.toThrow("test_set_authentication_failed");
  });
});
