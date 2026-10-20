import { describe, expect, it, vi } from "vitest";
import { documentProcessing } from "./document-processing.js";
import type { PrebuiltOpContext } from "./index.js";

const summarizeOperation = documentProcessing.operations["document.summarize"];
if (!summarizeOperation) throw new Error("document summarizer missing");
const partitionOperation = documentProcessing.operations["document.partition"];
if (!partitionOperation) throw new Error("document partitioner missing");

function fixture(privateRun = false) {
  const text = "Vendor: Acme";
  const get = vi.fn(async () => ({
    size: text.length,
    httpMetadata: { contentType: "text/plain" },
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  }));
  const summarize = vi.fn(async () => ({
    text: "Acme is the vendor",
    usage: { model: "specialist", inputTokens: 5, outputTokens: 0 },
  }));
  const ctx = {
    env: {
      spaceId: "s",
      projectId: "p",
      workspaceBranch: "task-a",
      scriptsBucket: { get },
      documentProcessor: { summarize },
      airGappedOnly: privateRun,
    },
    run: vi.fn(),
  } as unknown as PrebuiltOpContext;
  return { ctx, get, summarize };
}
describe("document workspace input boundary", () => {
  it("reads only the active project/branch and passes a stable source ID", async () => {
    const { ctx, get, summarize } = fixture();
    await summarizeOperation({ path: "/workspace/report.txt" }, ctx);
    expect(get).toHaveBeenCalledWith(
      "spaces/s/projects/p/workspace/branches/task-a/report.txt"
    );
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Vendor: Acme",
        sourceId: expect.stringMatching(
          /^workspace:report\.txt#sha256:[a-f0-9]{64}$/
        ),
      })
    );
  });
  it("refuses traversal and private cloud processing before opening file bytes", async () => {
    const a = fixture();
    await expect(
      summarizeOperation({ path: "../other/report.txt" }, a.ctx)
    ).rejects.toThrow("workspace_path_traversal");
    expect(a.get).not.toHaveBeenCalled();
    const b = fixture(true);
    await expect(
      summarizeOperation({ path: "report.txt" }, b.ctx)
    ).rejects.toThrow("private_document_cloud_processing_denied");
    expect(b.get).not.toHaveBeenCalled();
    const c = fixture();
    c.ctx.env.workspaceFileScope = ["assigned.txt"];
    await expect(
      summarizeOperation({ path: "other.txt" }, c.ctx)
    ).rejects.toThrow("worker_file_scope_denied");
    expect(c.get).not.toHaveBeenCalled();
  });
  it("partitions the authorized source with stable hash, offsets, and page metadata", async () => {
    const state = fixture();
    const result = (await partitionOperation(
      { path: "/workspace/report.txt" },
      state.ctx
    )) as {
      sourceId: string;
      sourceHash: string;
      chunks: Array<{
        text: string;
        start: number;
        end: number;
        offsetEncoding: string;
      }>;
    };
    expect(result.sourceId).toMatch(
      /^workspace:report\.txt#sha256:[a-f0-9]{64}$/
    );
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.chunks).toEqual([
      {
        index: 0,
        text: "Vendor: Acme",
        start: 0,
        end: 12,
        offsetEncoding: "utf16",
      },
    ]);
    expect(state.get).toHaveBeenCalledWith(
      "spaces/s/projects/p/workspace/branches/task-a/report.txt"
    );
  });
});
