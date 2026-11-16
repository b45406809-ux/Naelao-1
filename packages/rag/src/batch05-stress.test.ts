import { describe, expect, it, vi } from "vitest";
import { chunkText, chunkTextWithOffsets, chunkSourceCoordinates } from "./chunk.js";
import { embedBatch } from "./embed.js";
import { googleModeSearch } from "./hybrid.js";
import { lookupSemanticCache } from "./semantic-cache.js";
import { searchPermissionedKnowledge } from "./vectorize.js";

describe("RAG stress boundaries", () => {
  it("rejects chunk settings that could make forced splitting loop forever", () => {
    expect(() => chunkText("x".repeat(2_000), { chunkSize: 0 })).toThrow(
      RangeError
    );
    expect(() =>
      chunkText("x".repeat(2_000), { chunkSize: 10, overlap: 10 })
    ).toThrow(RangeError);
    expect(() =>
      chunkText("x".repeat(2_000), { chunkSize: 10, overlap: -1 })
    ).toThrow(RangeError);
  });

  it("keeps forced chunks bounded and overlapping for a long unbroken sentence", () => {
    const chunks = chunkText("x".repeat(2_000), { chunkSize: 32, overlap: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 128)).toBe(true);
    expect(chunks[1]).toContain(chunks[0]?.slice(-32));
  });

  it("preserves exact offsets for repeated Unicode paragraphs and long sentences", () => {
    const repeated = Array.from({ length: 400 }, () => "Repeated paragraph with emoji 😀 and the same wording. ").join("\n");
    const repeatedChunks = chunkTextWithOffsets(repeated);
    expect(repeatedChunks.length).toBeGreaterThan(1);
    for (const chunk of repeatedChunks) {
      expect(chunk.charEnd).toBeGreaterThan(chunk.charOffset);
      expect(repeated.slice(chunk.charOffset, chunk.charEnd).trimEnd()).toBe(chunk.content);
      expect(chunk.content.length).toBeLessThanOrEqual(2_048);
    }
    const repeatedCoordinates = chunkSourceCoordinates(repeated, repeatedChunks);
    const encoder = new TextEncoder();
    expect(repeatedCoordinates).toEqual(repeatedChunks.map((chunk) => ({
      byteStart: encoder.encode(repeated.slice(0, chunk.charOffset)).byteLength,
      byteEnd: encoder.encode(repeated.slice(0, chunk.charEnd)).byteLength,
      lineStart: repeated.slice(0, chunk.charOffset).split("\n").length,
      lineEnd: repeated.slice(0, chunk.charEnd).split("\n").length,
    })));

    const crlf = "first 😀 line\r\nsecond line\rthird line";
    const crlfCoordinates = chunkSourceCoordinates(crlf, [{ charOffset: 0, charEnd: crlf.length }]);
    expect(crlfCoordinates).toEqual([{
      byteStart: 0,
      byteEnd: encoder.encode(crlf).byteLength,
      lineStart: 1,
      lineEnd: 3,
    }]);

    const longSentence = `${"x".repeat(2_500)}😀${"y".repeat(2_500)}`;
    const forced = chunkTextWithOffsets(longSentence);
    expect(forced.length).toBeGreaterThan(1);
    expect(forced.every((chunk) => chunk.content.length <= 2_048)).toBe(true);
    for (const chunk of forced) {
      expect(longSentence.slice(chunk.charOffset, chunk.charEnd)).toBe(chunk.content);
      for (let index = 0; index < chunk.content.length; index++) {
        const code = chunk.content.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
          expect(chunk.content.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
          expect(chunk.content.charCodeAt(index + 1)).toBeLessThanOrEqual(0xdfff);
          index++;
        } else {
          expect(code < 0xdc00 || code > 0xdfff).toBe(true);
        }
      }
    }
  });

  it("chunks punctuation-dense input without quadratic sentence-splitting work", () => {
    const text = "a. ".repeat(20_000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.length).toBeLessThan(100);
    expect(chunks.every((chunk) => chunk.length <= 512 * 4)).toBe(true);
    expect(chunks[0]?.startsWith("a. ")).toBe(true);
    expect(chunks.at(-1)?.endsWith("a.")).toBe(true);
  });

  it("batches 101 embeddings without dropping input and rejects malformed vectors", async () => {
    const run = vi.fn(
      async (_model: string, input: { text: string | string[] }) => {
        const values = Array.isArray(input.text) ? input.text : [input.text];
        return { data: values.map(() => [0.1, 0.2]) };
      }
    );
    const results = await embedBatch(
      { run } as never,
      Array.from({ length: 101 }, (_, i) => `text ${i}`)
    );
    expect(results).toHaveLength(101);
    expect(run).toHaveBeenCalledTimes(2);

    const malformed = vi.fn().mockResolvedValue({ data: [[0.1, Number.NaN]] });
    await expect(
      embedBatch({ run: malformed } as never, ["bad"])
    ).rejects.toThrow(/malformed embedding/);
  });

  it("does not reuse semantic cache hits with non-finite score or missing expiry", async () => {
    const query = vi.fn().mockResolvedValue({
      matches: [
        {
          id: "hit",
          score: Number.NaN,
          metadata: { expires_at: Date.now() + 60_000 },
        },
      ],
    });
    const get = vi.fn().mockResolvedValue("cached answer");
    const bindings = { vectors: { query }, kv: { get } };
    await expect(
      lookupSemanticCache(bindings, [1], { tenantId: "tenant", spaceId: "space" })
    ).resolves.toBeNull();
    query.mockResolvedValue({
      matches: [{ id: "hit", score: 0.99, metadata: {} }],
    });
    await expect(
      lookupSemanticCache(bindings, [1], { tenantId: "tenant", spaceId: "space" })
    ).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("scopes semantic cache lookups by tenant, space, generation, and cached text budget", async () => {
    const query = vi.fn().mockResolvedValue({ matches: [{ id: "hit", score: 0.99, metadata: { expires_at: Date.now() + 60_000 } }] });
    const get = vi.fn().mockResolvedValue("cached");
    await expect(lookupSemanticCache({ vectors: { query }, kv: { get } }, [1], {
      tenantId: "tenant-a", spaceId: "space-a", generation: "generation-2",
    })).resolves.toMatchObject({ text: "cached" });
    expect(query).toHaveBeenCalledWith([1], expect.objectContaining({ filter: {
      tenant_id: { $eq: "tenant-a" }, space_id: { $eq: "space-a" }, generation: { $eq: "generation-2" },
    } }));
    get.mockResolvedValue("x".repeat(1_048_577));
    await expect(lookupSemanticCache({ vectors: { query }, kv: { get } }, [1], {
      tenantId: "tenant-a", spaceId: "space-a", generation: "generation-2",
    })).resolves.toBeNull();
  });

  it("rejects invalid permissioned vector dimensions, roles, and pagination", async () => {
    const query = vi.fn().mockResolvedValue({ matches: [] });
    const index = { query } as never;
    const options = {
      spaceId: "s",
      userId: "u",
      role: "member" as const,
      roleMask: 1,
    };
    await expect(
      searchPermissionedKnowledge(index, [Number.NaN], options)
    ).rejects.toThrow();
    await expect(
      searchPermissionedKnowledge(index, [1], { ...options, topK: Number.NaN })
    ).rejects.toThrow();
    await expect(
      searchPermissionedKnowledge(index, [1], {
        ...options,
        role: "root" as never,
      })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("validates grounded search options before calling adapters", async () => {
    const dense = vi.fn();
    const sparse = vi.fn();
    const web = vi.fn();
    const adapters = {
      cache: { lookup: vi.fn(), store: vi.fn() },
      dense,
      sparse,
      web,
      emitTelemetry: vi.fn(),
    };
    const scope = { tenantId: "t", spaceId: "s", projectId: "p", roleRank: 1 };
    await expect(
      googleModeSearch("q", scope, adapters, { limit: 101 })
    ).rejects.toThrow(RangeError);
    await expect(
      googleModeSearch("q", scope, adapters, {
        confidenceThreshold: Number.NaN,
      })
    ).rejects.toThrow(RangeError);
    expect(dense).not.toHaveBeenCalled();
    expect(sparse).not.toHaveBeenCalled();
  });
});
