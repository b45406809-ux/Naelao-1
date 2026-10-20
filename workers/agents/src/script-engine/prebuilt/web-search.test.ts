import { describe, expect, it, vi } from "vitest";
import { webSearch } from "./web-search.js";
import type { PrebuiltOpContext } from "./index.js";

function context(fetch: (request: Request) => Promise<Response>, bucket?: R2Bucket): PrebuiltOpContext {
  return {
    env: {
      scriptsBucket: bucket ?? ({} as R2Bucket),
      workspaceBucket: bucket,
      spaceId: "space-a",
      tenantId: "tenant-a",
      platformSecret: "secret",
      knowledgeWorker: { fetch } as unknown as Fetcher,
    },
    run: vi.fn(),
  };
}

describe("bounded web-search tool inputs and download results", () => {
  it("rejects oversized queries, invalid result counts, and oversized filenames before egress", async () => {
    const fetch = vi.fn(async () => Response.json({ configured: true, results: [] }));
    const ctx = context(fetch);
    await expect(webSearch.operations.search!({ query: "x".repeat(1_001) }, ctx))
      .rejects.toThrow("1..1000 characters");
    await expect(webSearch.operations.search!({ query: "ok", max_results: Number.NaN }, ctx))
      .rejects.toThrow("max_results must be 1..20");
    await expect(webSearch.operations.download_file!({ url: "https://example.com/file", filename: "x".repeat(256) }, ctx))
      .rejects.toThrow("255 characters");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts download JSON larger than read-oriented tool output while storing decoded bytes", async () => {
    const base64 = "AAAA".repeat(1_250_000); // 5 MB JSON field, 3.75 MB binary file.
    const fetch = vi.fn(async () => Response.json({
      url: "https://example.com/file.pdf",
      status: 200,
      encoding: "base64",
      content_type: "application/pdf",
      content: base64,
      size: 3_750_000,
      truncated: false,
    }));
    const head = vi.fn(async () => null);
    const put = vi.fn(async () => ({ etag: "etag" }));
    const result = await webSearch.operations.download_file!({ url: "https://example.com/file.pdf" }, context(fetch, { head, put } as never)) as {
      ok: boolean;
      path: string;
      size: number;
      binary: boolean;
    };
    expect(result).toMatchObject({ ok: true, path: "downloads/file.pdf", size: 3_750_000, binary: true });
    expect(put).toHaveBeenCalledOnce();
    expect((put.mock.calls[0]?.[1] as Uint8Array).byteLength).toBe(3_750_000);
  });
});
