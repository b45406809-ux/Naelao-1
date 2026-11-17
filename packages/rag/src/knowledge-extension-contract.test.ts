import { describe, expect, it } from "vitest";
import { validateKnowledgeExtensionCandidates, validateKnowledgeExtensionChunks, type KnowledgeExtensionContext } from "./knowledge-extension-contract.js";

const context: KnowledgeExtensionContext = {
  tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", collectionId: "collection-a", installationId: "install-a",
  sourceId: "source-a", sourceVersion: 4, contentSha256: "a".repeat(64), sourceByteLength: 500, sourceLineCount: 20,
  deletionGeneration: 2, parserVersion: "parser-1", chunkerVersion: "chunker-3", indexVersion: "index-2", retrievalVersion: "search-1",
};

async function hash(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("custom Knowledge extension contracts", () => {
  it("projects parser output to the exact current lineage and drops unrecognized fields", async () => {
    const result = await validateKnowledgeExtensionChunks(context, [{
      chunkId: "chunk-a", text: "allowed derived text", sourceVersion: 4, contentSha256: context.contentSha256,
      chunkSha256: await hash("allowed derived text"), parserVersion: "parser-1", chunkerVersion: "chunker-3",
      byteStart: 10, byteEnd: 30, lineStart: 2, lineEnd: 3, tenantId: "forged-tenant", published: true,
    }]);
    expect(result).toEqual([{
      chunkId: "chunk-a", text: "allowed derived text", sourceVersion: 4, contentSha256: context.contentSha256,
      chunkSha256: await hash("allowed derived text"), parserVersion: "parser-1", chunkerVersion: "chunker-3",
      byteStart: 10, byteEnd: 30, lineStart: 2, lineEnd: 3,
    }]);
  });

  it("rejects stale source/parser lineage, invalid citation spans and oversized output", async () => {
    const chunk = { chunkId: "chunk-a", text: "derived", sourceVersion: 4, contentSha256: context.contentSha256,
      chunkSha256: await hash("derived"), parserVersion: "parser-1", chunkerVersion: "chunker-3", byteStart: 10, byteEnd: 30 };
    await expect(validateKnowledgeExtensionChunks(context, [{ ...chunk, sourceVersion: 3 }])).rejects.toThrow("lineage");
    await expect(validateKnowledgeExtensionChunks(context, [{ ...chunk, parserVersion: "old" }])).rejects.toThrow("lineage");
    await expect(validateKnowledgeExtensionChunks(context, [{ ...chunk, byteEnd: 501 }])).rejects.toThrow("lineage");
    await expect(validateKnowledgeExtensionChunks(context, [{ ...chunk, text: "long" }], { maxChunkBytes: 2 })).rejects.toThrow("bytes_exceeded");
    await expect(validateKnowledgeExtensionChunks(context, [{ ...chunk, chunkSha256: "b".repeat(64) }])).rejects.toThrow("chunk_hash_invalid");
  });

  it("accepts retrieval references only from the host-authorized current chunk set", () => {
    const candidate = { chunkId: "chunk-a", score: 0.8, sourceVersion: 4, contentSha256: context.contentSha256,
      deletionGeneration: 2, indexVersion: "index-2", retrievalVersion: "search-1", text: "must not be returned" };
    expect(validateKnowledgeExtensionCandidates(context, new Set(["chunk-a"]), [candidate])).toEqual([{
      chunkId: "chunk-a", score: 0.8, sourceVersion: 4, contentSha256: context.contentSha256,
      deletionGeneration: 2, indexVersion: "index-2", retrievalVersion: "search-1",
    }]);
    expect(() => validateKnowledgeExtensionCandidates(context, new Set(), [candidate])).toThrow("lineage");
    expect(() => validateKnowledgeExtensionCandidates(context, new Set(["chunk-a"]), [{ ...candidate, deletionGeneration: 1 }])).toThrow("lineage");
  });
});
