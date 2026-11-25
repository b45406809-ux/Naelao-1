import { describe, expect, it } from "vitest";
import { responseCacheIdentity, type ResponseCacheIdentityInput } from "./response-cache-identity.js";

const base: ResponseCacheIdentityInput = {
  tenantId: "t1", spaceId: "s1", projectId: "p1", userId: "u1", role: "editor",
  memoryRevision: "m1", grantRevision: "g1", readOnly: true, query: "What is X?",
};

describe("responseCacheIdentity", () => {
  it.each(["tenantId", "spaceId", "userId", "role", "memoryRevision", "grantRevision"] as const)(
    "returns null when %s is missing or empty", async (field) => {
      expect(await responseCacheIdentity({ ...base, [field]: "" })).toBeNull();
      expect(await responseCacheIdentity({ ...base, [field]: undefined })).toBeNull();
      expect(await responseCacheIdentity({ ...base, [field]: null })).toBeNull();
    });

  it("returns null unless readOnly is exactly true", async () => {
    expect(await responseCacheIdentity({ ...base, readOnly: false })).toBeNull();
    expect(await responseCacheIdentity({ ...base, readOnly: undefined })).toBeNull();
  });

  it.each([
    ["tenantId", "t2"], ["spaceId", "s2"], ["projectId", "p2"], ["userId", "u2"], ["role", "owner"],
    ["memoryRevision", "m2"], ["grantRevision", "g2"], ["query", "something else"],
  ] as const)("key changes when %s changes", async (field, value) => {
    const a = await responseCacheIdentity(base);
    const b = await responseCacheIdentity({ ...base, [field]: value });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).not.toBe(a);
  });

  it("is deterministic", async () => {
    expect(await responseCacheIdentity({ ...base })).toBe(await responseCacheIdentity({ ...base }));
  });

  it("normalizes query whitespace, case and unicode form", async () => {
    const a = await responseCacheIdentity(base);
    expect(await responseCacheIdentity({ ...base, query: "  what   IS\tx? " })).toBe(a);
    const e1 = await responseCacheIdentity({ ...base, query: "café" });
    expect(await responseCacheIdentity({ ...base, query: "café" })).toBe(e1);
  });

  it("treats absent projectId as _space", async () => {
    const { projectId: _p, ...rest } = base;
    expect(await responseCacheIdentity(rest)).toBe(await responseCacheIdentity({ ...base, projectId: "_space" }));
    expect(await responseCacheIdentity({ ...base, projectId: "" })).toBe(await responseCacheIdentity(rest));
  });
});
