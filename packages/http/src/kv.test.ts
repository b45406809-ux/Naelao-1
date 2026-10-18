import { describe, expect, it, vi } from "vitest";
import { safeKvGet, safeKvPut } from "./kv.js";

function memoryKv() {
  const values = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
  return { kv: kv as unknown as KVNamespace, values };
}

describe("safe KV value boundaries", () => {
  it("writes ordinary values unchanged and carries the caller's options", async () => {
    const { kv, values } = memoryKv();
    const options = { expirationTtl: 60 };
    await safeKvPut(kv, "small", "hello", options);
    expect(kv.put).toHaveBeenCalledWith("small", "hello", options);
    await expect(safeKvGet(kv, "small")).resolves.toBe("hello");
    values.set("empty", "");
    await expect(safeKvGet(kv, "empty")).resolves.toBe("");
  });

  it("round-trips a value above the KV cap when a Unicode character crosses a chunk edge", async () => {
    const { kv, values } = memoryKv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const value = `${"x".repeat(20 * 1024 * 1024 - 1)}🧪${"z".repeat(5 * 1024 * 1024)}`;
    try {
      await safeKvPut(kv, "large", value);
      expect(JSON.parse(values.get("large") ?? "{}")).toMatchObject({
        chunked: true,
        num_chunks: 2,
      });
      await expect(safeKvGet(kv, "large")).resolves.toBe(value);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it("treats missing or malformed chunks as a cache miss", async () => {
    const { kv, values } = memoryKv();
    values.set(
      "missing",
      JSON.stringify({
        chunked: true,
        total_bytes: 5,
        num_chunks: 1,
        chunk_keys: ["missing_chunk_0"],
      })
    );
    values.set(
      "forged",
      JSON.stringify({
        chunked: true,
        total_bytes: 5,
        num_chunks: 1,
        chunk_keys: ["another-key"],
      })
    );
    await expect(safeKvGet(kv, "missing")).resolves.toBeNull();
    await expect(safeKvGet(kv, "forged")).resolves.toBeNull();
  });

  it("propagates KV read failures instead of returning a manifest as content", async () => {
    const failure = new Error("KV unavailable");
    const kv = {
      get: vi.fn(async (key: string) => {
        if (key === "broken") {
          return JSON.stringify({
            chunked: true,
            total_bytes: 1,
            num_chunks: 1,
            chunk_keys: ["broken_chunk_0"],
          });
        }
        throw failure;
      }),
    } as unknown as KVNamespace;
    await expect(safeKvGet(kv, "broken")).rejects.toThrow(failure);
  });
});
