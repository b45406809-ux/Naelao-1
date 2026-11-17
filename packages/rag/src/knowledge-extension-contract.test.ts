import { describe, expect, it } from "vitest";
import { searchKnowledgeExtension, validateKnowledgeExtensionCandidates, validateKnowledgeExtensionChunks, type KnowledgeExtensionContext } from "./knowledge-extension-contract.js";

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

  it("authorizes before ranking and removes results revoked during the adapter call", async () => {
    let authorityReads = 0;
    let adapterInput: unknown;
    const candidates = await searchKnowledgeExtension({
      context, query: "approved query", readAuthority: async () => ({ sourceVersion: 4, contentSha256: context.contentSha256,
        deletionGeneration: 2, indexVersion: "index-2", retrievalVersion: "search-1",
        authorizedChunkIds: ++authorityReads === 1 ? ["allowed-a", "revoked-after-search"] : ["allowed-a"] }),
      authorizeQueryEgress: async () => true,
      adapter: { search: async input => {
        adapterInput = input;
        return ["allowed-a", "revoked-after-search"].map(chunkId => ({ chunkId, score: 0.7, sourceVersion: 4,
          contentSha256: context.contentSha256, deletionGeneration: 2, indexVersion: "index-2", retrievalVersion: "search-1" }));
      } },
    });
    expect(adapterInput).toEqual({ query: "approved query", chunkIds: ["allowed-a", "revoked-after-search"],
      indexVersion: "index-2", retrievalVersion: "search-1" });
    expect(candidates.map(item => item.chunkId)).toEqual(["allowed-a"]);
  });

  it("refuses retrieval when source or deletion generation changed before ranking", async () => {
    const search = searchKnowledgeExtension({ context, query: "query", adapter: { search: async () => [] }, authorizeQueryEgress: async () => true,
      readAuthority: async () => ({ sourceVersion: 4, contentSha256: context.contentSha256, deletionGeneration: 3,
        indexVersion: "index-2", retrievalVersion: "search-1", authorizedChunkIds: ["chunk-a"] }) });
    await expect(search).rejects.toThrow("source_stale");
  });

  it("does not send a query to an extension without host egress admission", async () => {
    let dispatched = false;
    await expect(searchKnowledgeExtension({ context, query: "sensitive query",
      readAuthority: async () => ({ sourceVersion: 4, contentSha256: context.contentSha256, deletionGeneration: 2,
        indexVersion: "index-2", retrievalVersion: "search-1", authorizedChunkIds: ["chunk-a"] }),
      authorizeQueryEgress: async () => false,
      adapter: { search: async () => { dispatched = true; return []; } },
    })).rejects.toThrow("query_egress_denied");
    expect(dispatched).toBe(false);
  });

  it("keeps synthetic extension search behind owner grant, publication, revoke and deletion state", async () => {
    const lifecycle = { ownerApproved: false, published: false, revoked: false, deleted: false, deletionGeneration: 2 };
    let adapterCalls = 0;
    const search = () => searchKnowledgeExtension({
      context: { ...context, deletionGeneration: lifecycle.deletionGeneration }, query: "synthetic public FAQ",
      readAuthority: async current => ({ sourceVersion: current.sourceVersion, contentSha256: current.contentSha256,
        deletionGeneration: current.deletionGeneration, indexVersion: current.indexVersion, retrievalVersion: current.retrievalVersion,
        authorizedChunkIds: lifecycle.ownerApproved && lifecycle.published && !lifecycle.revoked && !lifecycle.deleted ? ["faq-1"] : [] }),
      authorizeQueryEgress: async () => lifecycle.ownerApproved && lifecycle.published && !lifecycle.revoked && !lifecycle.deleted,
      adapter: { search: async input => {
        adapterCalls++;
        return input.chunkIds.map(chunkId => ({ chunkId, score: 0.9, sourceVersion: 4, contentSha256: context.contentSha256,
          deletionGeneration: lifecycle.deletionGeneration, indexVersion: "index-2", retrievalVersion: "search-1" }));
      } },
    });

    await expect(search()).resolves.toEqual([]);
    expect(adapterCalls).toBe(0);
    lifecycle.ownerApproved = true;
    lifecycle.published = true;
    await expect(search()).resolves.toMatchObject([{ chunkId: "faq-1" }]);
    lifecycle.revoked = true;
    await expect(search()).resolves.toEqual([]);
    expect(adapterCalls).toBe(1);
    lifecycle.deleted = true;
    lifecycle.deletionGeneration++;
    await expect(search()).resolves.toEqual([]);
    await expect(searchKnowledgeExtension({ context, query: "stale source", readAuthority: async () => ({
      sourceVersion: 4, contentSha256: context.contentSha256, deletionGeneration: lifecycle.deletionGeneration,
      indexVersion: "index-2", retrievalVersion: "search-1", authorizedChunkIds: ["faq-1"],
    }), authorizeQueryEgress: async () => true, adapter: { search: async () => [] } })).rejects.toThrow("source_stale");
  });
});
