import { describe, it, expect } from "vitest";
import { workspacePrefix } from "../../workers/agents/src/script-engine/types.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// Space-scoped (Space Assistant) vs project-scoped (ordinary Naelao Agent thread) R2
// workspaces. A project is workspace-scoped: every thread's agent in the SAME project
// reads/writes the SAME filesystem.

function makeR2(): R2Bucket {
  const store = new Map<string, { bytes: Uint8Array; etag: string; customMetadata?: Record<string, string> }>();
  let sequence = 0;
  const bucket = {
    async put(key: string, value: string | Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; customMetadata?: Record<string, string> }) {
      const current = store.get(key);
      if (options?.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
      const etag = `e${++sequence}`;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
      store.set(key, { bytes, etag, customMetadata: options?.customMetadata });
      return { etag } as R2Object;
    },
    async get(key: string) {
      const object = store.get(key);
      if (!object) return null;
      const bytes = object.bytes.slice();
      return {
        size: bytes.byteLength, etag: object.etag, uploaded: new Date(), customMetadata: object.customMetadata,
        async arrayBuffer() { return bytes.slice().buffer; },
        async text() { return new TextDecoder().decode(bytes); },
        get body() { return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }); },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const object = store.get(key);
      return object ? { size: object.bytes.byteLength, etag: object.etag, uploaded: new Date(), customMetadata: object.customMetadata } as R2Object : null;
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, object]) => ({
        key, size: object.bytes.byteLength, uploaded: new Date(), etag: object.etag, customMetadata: object.customMetadata,
      }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
    async delete(key: string | string[]) {
      for (const item of Array.isArray(key) ? key : [key]) store.delete(item);
    },
  };
  return bucket as unknown as R2Bucket;
}

describe("workspacePrefix — space vs project scoping", () => {
  it("is space-scoped when projectId is absent (the Space Assistant)", () => {
    expect(workspacePrefix({ spaceId: "space1" })).toBe("spaces/space1/workspace/");
  });

  it("is project-scoped when projectId is present (an ordinary Naelao Agent thread)", () => {
    expect(workspacePrefix({ spaceId: "space1", projectId: "proj1" })).toBe("spaces/space1/projects/proj1/workspace/");
  });
});

describe("r2-workspace prebuilt honors the run's workspace scope", () => {
  function makeEnv(overrides: Partial<ScriptEngineEnv> = {}): ScriptEngineEnv {
    return { scriptsBucket: makeR2(), spaceId: "space1", agentId: "agent-1", tenantId: "tenant-1", ...overrides };
  }

  it("a Space Assistant run (no projectId) writes under the space-wide workspace", async () => {
    const bucket = makeR2();
    const tools = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket }), ["r2-workspace"]);
    await tools.run("write_file", { path: "notes.txt", content: "assistant note", expectedHash: null });
    const raw = await bucket.get("spaces/space1/workspace/notes.txt");
    expect(await raw?.text()).toBe("assistant note");
  });

  it("a project-bound run writes under that project's own workspace prefix", async () => {
    const bucket = makeR2();
    const tools = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket, projectId: "proj1" }), ["r2-workspace"]);
    await tools.run("write_file", { path: "ledger.csv", content: "row1", expectedHash: null });
    const raw = await bucket.get("spaces/space1/projects/proj1/workspace/ledger.csv");
    expect(await raw?.text()).toBe("row1");
  });

  it("two different threads' agents in the SAME project share the same workspace file", async () => {
    const bucket = makeR2();
    // agentId differs (thread A's agent vs thread B's agent) but spaceId+projectId match.
    const threadA = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket, agentId: "agent-thread-a", projectId: "proj1" }), ["r2-workspace"]);
    const threadB = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket, agentId: "agent-thread-b", projectId: "proj1" }), ["r2-workspace"]);

    await threadA.run("write_file", { path: "ledger.csv", content: "customer-1,complaint\n", expectedHash: null });
    const seenByB = await threadB.run("read_file", { path: "ledger.csv" });
    expect((seenByB.output as { content: string }).content).toBe("customer-1,complaint\n");
  });

  it("two different PROJECTS in the same space do NOT share a workspace", async () => {
    const bucket = makeR2();
    const proj1 = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket, projectId: "proj1" }), ["r2-workspace"]);
    const proj2 = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket, projectId: "proj2" }), ["r2-workspace"]);

    await proj1.run("write_file", { path: "ledger.csv", content: "proj1 data", expectedHash: null });
    const seenByProj2 = await proj2.run("read_file", { path: "ledger.csv" });
    expect((seenByProj2.output as { exists: boolean }).exists).toBe(false);
  });
});
