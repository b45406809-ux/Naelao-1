// r2-workspace's read_file/stat_file — the size guard that stops a single oversized read from
// blowing a turn's own reasoner payload before step-context.ts ever gets a chance to window it
// down (that windowing only applies to OLDER steps, not the one just returned this turn).

import { describe, it, expect } from "vitest";
import { r2Workspace } from "../../workers/agents/src/script-engine/prebuilt/r2-workspace.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

function makeR2(initial: Record<string, string> = {}): R2Bucket {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async put(key: string, value: unknown) {
      store.set(key, String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: text.length, uploaded: new Date("2026-01-01T00:00:00Z"), async text() { return text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: text.length, uploaded: new Date("2026-01-01T00:00:00Z") } as unknown as R2Object;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

function makeCtx(bucket: R2Bucket): PrebuiltOpContext {
  const env = {
    spaceId: "space-1",
    agentId: "agent-1",
    tenantId: "tenant-1",
    scriptsBucket: bucket,
  } as unknown as ScriptEngineEnv;
  return { env, run: async () => ({}) };
}

const readFile = r2Workspace.operations["read_file"]!;
const statFile = r2Workspace.operations["stat_file"]!;

describe("read_file — size guard", () => {
  it("reads a normal-sized file in full", async () => {
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/small.txt": "hello world" }));
    const result = (await readFile({ path: "small.txt" }, ctx)) as { exists: boolean; content: string | null; too_large?: boolean };
    expect(result.exists).toBe(true);
    expect(result.content).toBe("hello world");
    expect(result.too_large).toBeUndefined();
  });

  it("refuses a file over the size limit instead of returning it in full", async () => {
    const huge = "x".repeat(200_001);
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/huge.csv": huge }));
    const result = (await readFile({ path: "huge.csv" }, ctx)) as {
      exists: boolean;
      content: string | null;
      too_large: boolean;
      size: number;
      message: string;
    };
    expect(result.exists).toBe(true);
    expect(result.content).toBeNull();
    expect(result.too_large).toBe(true);
    expect(result.size).toBe(200_001);
    // Step 3: the too_large message now points at the chunked-read / search_file escape hatches
    // (a full read still refuses, but there IS a way to read it now).
    expect(result.message).toMatch(/offset|search_file/);
  });

  it("reports exists:false for a missing file, unaffected by the size guard", async () => {
    const ctx = makeCtx(makeR2({}));
    const result = (await readFile({ path: "nope.txt" }, ctx)) as { exists: boolean };
    expect(result.exists).toBe(false);
  });
});

describe("stat_file — a content-free size check", () => {
  it("reports size and readability without ever reading content", async () => {
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/report.txt": "a".repeat(500) }));
    const result = (await statFile({ path: "report.txt" }, ctx)) as {
      exists: boolean;
      size: number;
      readable: boolean;
    };
    expect(result).toEqual({ exists: true, size: 500, readable: true, uploaded: "2026-01-01T00:00:00.000Z" });
  });

  it("flags readable:false for a file over read_file's own limit", async () => {
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/huge.csv": "x".repeat(200_001) }));
    const result = (await statFile({ path: "huge.csv" }, ctx)) as { readable: boolean };
    expect(result.readable).toBe(false);
  });

  it("reports exists:false for a missing file", async () => {
    const ctx = makeCtx(makeR2({}));
    const result = (await statFile({ path: "nope.txt" }, ctx)) as { exists: boolean };
    expect(result).toEqual({ exists: false });
  });
});
