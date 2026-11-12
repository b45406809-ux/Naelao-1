import { describe, expect, it } from "vitest";
import { openSandboxRecord, sealSandboxRecord } from "./record-crypto.js";

describe("encrypted sandbox records", () => {
  it("binds ciphertext to tenant, owner, record and purpose", async () => {
    const sealed = await sealSandboxRecord("test-secret", "tenant-a", "user-a", "exec-a", "request", JSON.stringify({ command: "echo private" }));
    expect(await openSandboxRecord("test-secret", "tenant-a", "user-a", "exec-a", "request", sealed)).toContain("echo private");
    await expect(openSandboxRecord("test-secret", "tenant-b", "user-a", "exec-a", "request", sealed)).rejects.toThrow();
    await expect(openSandboxRecord("test-secret", "tenant-a", "user-b", "exec-a", "request", sealed)).rejects.toThrow();
    await expect(openSandboxRecord("test-secret", "tenant-a", "user-a", "exec-a", "result", sealed)).rejects.toThrow();
  });
});
