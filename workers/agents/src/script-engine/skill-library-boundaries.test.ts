import { describe, expect, it, vi } from "vitest";
import { SkillLibrary } from "./skill-library.js";

describe("SkillLibrary R2 size boundaries", () => {
  it("rejects an oversized code object before materializing its body", async () => {
    const codeArrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const metadata = JSON.stringify({
      name: "sample",
      version: 1,
      description: "sample",
      domain: "general",
      requires_tier: 1,
    });
    const metadataBytes = new TextEncoder().encode(metadata);
    const bucket = {
      get: async (key: string) =>
        key.endsWith("SCRIPT.md")
          ? {
              size: metadataBytes.byteLength,
              arrayBuffer: async () => metadataBytes.buffer,
            }
          : { size: 1024 * 1024 + 1, arrayBuffer: codeArrayBuffer },
    } as unknown as R2Bucket;

    await expect(
      new SkillLibrary(bucket, "space-1").read("sample")
    ).rejects.toThrow("skill_code_too_large");
    expect(codeArrayBuffer).not.toHaveBeenCalled();
  });
});
