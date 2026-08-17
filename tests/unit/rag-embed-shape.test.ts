// The shape Cloudflare's embedding model ACTUALLY returns.
//
// This had no test coverage of any kind, and the code was written against a shape CF does not
// send: `data` was declared `Array<{embedding: number[]}>` when it is really `number[][]`. So
// `item.embedding` was `undefined` for every chunk, and the failure only surfaced three layers
// later as Vectorize throwing "undefined is not iterable (cannot read property
// Symbol(Symbol.iterator))" — which is what a user saw when they tried to attach a file.
// Knowledge-base ingestion had never once worked against a real deployment.
//
// The fixtures below are the real response, captured from
// POST /accounts/{id}/ai/run/@cf/baai/bge-large-en-v1.5 with {"text": ["hello world", "second
// string"]}: {data: [[...1024 floats], [...]], shape: [2, 1024], pooling, usage}.

import { describe, it, expect } from "vitest";
import { embedText, embedBatch } from "../../packages/rag/src/embed.js";

/** A 1024-float vector, the real dimension of bge-large-en-v1.5. */
function vec(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => (seed + i) / 10000);
}

/** CF's real response: a flat array of vectors. */
function realAi(vectors: number[][]): Ai {
  return {
    async run(_model: string, opts: { text: string | string[] }) {
      const n = Array.isArray(opts.text) ? opts.text.length : 1;
      return { data: vectors.slice(0, n), shape: [n, 1024], pooling: "cls" };
    },
  } as unknown as Ai;
}

/** The object form some other embedding model may return — accepted, but not what CF sends. */
function objectFormAi(vectors: number[][]): Ai {
  return {
    async run(_model: string, opts: { text: string | string[] }) {
      const n = Array.isArray(opts.text) ? opts.text.length : 1;
      return { data: vectors.slice(0, n).map((embedding) => ({ embedding })) };
    },
  } as unknown as Ai;
}

describe("embedding against the response CF really sends", () => {
  it("reads a flat number[][] — the shape that used to yield undefined", async () => {
    const res = await embedText(realAi([vec(1)]), "hello world");
    expect(Array.isArray(res.embedding)).toBe(true);
    expect(res.embedding).toHaveLength(1024);
    expect(res.embedding[0]).toBeCloseTo(0.0001);
  });

  it("batches without losing or mangling any vector", async () => {
    const results = await embedBatch(realAi([vec(1), vec(2), vec(3)]), ["a", "b", "c"]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.embedding).toHaveLength(1024);
      // The exact failure mode: a vector that is not an array reaches Vectorize and throws
      // "undefined is not iterable" far from where it went wrong.
      expect(Array.isArray(r.embedding)).toBe(true);
      expect(r.embedding.every((n) => typeof n === "number")).toBe(true);
    }
  });

  it("still accepts the object form, since being liberal here costs nothing", async () => {
    const results = await embedBatch(objectFormAi([vec(4), vec(5)]), ["a", "b"]);
    expect(results).toHaveLength(2);
    expect(results[0]!.embedding).toHaveLength(1024);
  });

  it("throws where the problem is, rather than passing an undefined vector downstream", async () => {
    const brokenAi = {
      async run() { return { data: [{ notAnEmbedding: true }] }; },
    } as unknown as Ai;
    await expect(embedBatch(brokenAi, ["a"])).rejects.toThrow(/malformed embedding/);
  });

  it("reports a short response as a count mismatch, not a silent partial result", async () => {
    const shortAi = {
      async run() { return { data: [vec(1)] }; },
    } as unknown as Ai;
    await expect(embedBatch(shortAi, ["a", "b"])).rejects.toThrow(/returned 1 embeddings for 2/);
  });

  it("returns nothing for no input rather than calling the model", async () => {
    let called = false;
    const ai = { async run() { called = true; return { data: [] }; } } as unknown as Ai;
    expect(await embedBatch(ai, [])).toEqual([]);
    expect(called).toBe(false);
  });
});
