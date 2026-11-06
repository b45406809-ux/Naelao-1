import { describe, expect, it } from "vitest";
import { openConnection, sealConnection } from "./connection-crypto.js";

describe("provider credential storage", () => {
  it("encrypts provider secrets with fresh nonces and tenant-specific derivation", async () => {
    const first = await sealConnection("platform-secret", "tenant-a", "user-a", "connection-a", JSON.stringify({ apiKey: "provider-secret-value" }));
    const second = await sealConnection("platform-secret", "tenant-a", "user-a", "connection-a", JSON.stringify({ apiKey: "provider-secret-value" }));
    const otherTenant = await sealConnection("platform-secret", "tenant-b", "user-a", "connection-a", JSON.stringify({ apiKey: "provider-secret-value" }));
    expect(first.ciphertext).not.toContain("provider-secret-value");
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(otherTenant.ciphertext);
    await expect(openConnection("platform-secret", "tenant-a", "user-a", "connection-a", first)).resolves.toContain("provider-secret-value");
    await expect(openConnection("platform-secret", "tenant-b", "user-a", "connection-a", first)).rejects.toThrow();
  });
});
