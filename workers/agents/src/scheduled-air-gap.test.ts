import { describe, expect, it, vi } from "vitest";
import { resolveWakeContext } from "./index.js";

function envFor(first: unknown) {
  return {
    PLATFORM_DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first: vi.fn(async () => first) })),
      })),
    },
  } as never;
}

describe("scheduled wake compliance policy", () => {
  it("fails closed when the space row is unavailable", async () => {
    await expect(resolveWakeContext(envFor(null), "space-1", "tenant-1")).resolves.toMatchObject({ airGappedOnly: true });
  });

  it("fails closed when stored policy JSON is malformed", async () => {
    await expect(resolveWakeContext(envFor({ name: "Acme", config_json: "{" }), "space-1", "tenant-1"))
      .resolves.toMatchObject({ airGappedOnly: true });
  });

  it("preserves an explicit non-air-gapped policy", async () => {
    await expect(resolveWakeContext(envFor({ name: "Acme", config_json: '{"compliance":{"airGappedOnly":false}}' }), "space-1", "tenant-1"))
      .resolves.toMatchObject({ airGappedOnly: false });
  });
});
