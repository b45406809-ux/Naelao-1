import { describe, expect, it, vi } from "vitest";
import { verifyWorkspaceDualRead } from "./workspace-dual-read.js";

function bucket(files: Record<string, string>): R2Bucket {
  return {
    get: vi.fn(async (key: string) => {
      const value = files[key];
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return { size: bytes.byteLength, customMetadata: {}, arrayBuffer: async () => bytes.slice().buffer } as unknown as R2ObjectBody;
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      objects: Object.keys(files).filter((key) => key.startsWith(prefix)).map((key) => ({ key, customMetadata: {} })), truncated: false,
    } as unknown as R2Objects)),
  } as unknown as R2Bucket;
}

const scope = { tenantId: "t", spaceId: "s", projectId: "p", head: { branch: "main", revision: 4, updatedAt: "2026-11-08T00:00:00Z" } };
const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("bounded workspace dual-read verification", () => {
  it("compares hashes and classifies drift without including names or content", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await verifyWorkspaceDualRead({ bucket: bucket({ "prefix/a.txt": "legacy", "prefix/extra.txt": "only legacy" }), prefix: "prefix/", ...scope,
      entries: [{ path: "a.txt", sha256: await hash("canonical"), size: 9, executable: false, objectKey: "obj" }] });
    expect(result).toMatchObject({ compared: 2, mismatched: 2 });
    expect(result.drifts.map((drift) => drift.mismatchClass)).toEqual(["size_mismatch", "manifest_missing"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("only legacy");
    expect(JSON.stringify(log.mock.calls)).not.toContain("a.txt");
    log.mockRestore();
  });

  it("bounds one verification pass to 50 canonical files", async () => {
    const entries = Array.from({ length: 75 }, (_, index) => ({ path: `f${index}`, sha256: "a".repeat(64), size: 1, executable: false, objectKey: "obj" }));
    const result = await verifyWorkspaceDualRead({ bucket: bucket({}), prefix: "prefix/", ...scope, entries });
    expect(result.compared).toBe(50);
    expect(result.truncated).toBe(true);
    expect(result.drifts).toHaveLength(20);
  });

  it("does not read legacy object bytes beyond the per-request byte budget", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const get = vi.fn(async () => ({ size: 16 * 1024 * 1024 + 1, customMetadata: {}, arrayBuffer } as unknown as R2ObjectBody));
    const result = await verifyWorkspaceDualRead({ bucket: { get } as unknown as R2Bucket, prefix: "prefix/", ...scope, path: "large.bin",
      entries: [{ path: "large.bin", sha256: "a".repeat(64), size: 16 * 1024 * 1024 + 1, executable: false, objectKey: "obj" }] });
    expect(result).toMatchObject({ compared: 0, mismatched: 0, truncated: true });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
