import {
  googleModeSearch,
  stableCitationNumbers,
  verifyCitationCoordinate,
} from "@naelao/rag";
import { describe, expect, it, vi } from "vitest";

const scope = {
  tenantId: "tenant-a",
  spaceId: "space-a",
  projectId: "project-a",
  roleRank: 4,
};
const hit = {
  id: "doc_chunk_0",
  score: 0.7,
  content: "fact",
  r2Key: "kb/space-a/project-a/doc/chunk_0.json",
  byteStart: 0,
  byteEnd: 4,
};

describe("grounded search production contract", () => {
  it("passes the complete scope to retrieval, grounds low confidence, caches, and emits latency", async () => {
    let clock = 100;
    const dense = vi.fn(async () => [hit]);
    const sparse = vi.fn(async () => []);
    const web = vi.fn(async () => [{ ...hit, id: "web", score: 1 }]);
    const store = vi.fn(async () => undefined);
    const emitTelemetry = vi.fn();
    const result = await googleModeSearch("question", scope, {
      cache: { lookup: async () => null, store },
      dense,
      sparse,
      web,
      emitTelemetry,
      now: () => clock++,
    });
    expect(dense).toHaveBeenCalledWith("question", scope);
    expect(web).toHaveBeenCalledWith("question", scope);
    expect(store.mock.calls[0]?.[1]).toEqual(scope);
    expect(result.liveGrounding).toBe(true);
    expect(emitTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        projectId: "project-a",
        latencyMs: 1,
      })
    );
  });

  it("does not permit incomplete authorization scope", async () => {
    await expect(
      googleModeSearch("q", { ...scope, projectId: "" }, {} as never)
    ).rejects.toThrow("complete tenant/space/project/role scope");
  });

  it("rejects forged citation keys and ranges and numbers duplicate streamed citations stably", () => {
    expect(() =>
      verifyCitationCoordinate(hit, { r2Key: "other", size: 100 })
    ).toThrow("not accessible");
    expect(() =>
      verifyCitationCoordinate(
        { ...hit, byteEnd: 101 },
        { r2Key: hit.r2Key, size: 100 }
      )
    ).toThrow("range");
    expect([...stableCitationNumbers([hit, hit]).values()]).toEqual([1]);
  });
});
