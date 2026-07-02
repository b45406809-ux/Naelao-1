import { describe, it, expect } from "vitest";
import { workspacePrefix } from "../../workers/agents/src/script-engine/types.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// Space-scoped (Space Assistant) vs project-scoped (ordinary Naelao Agent thread) R2
// workspaces. A project is workspace-scoped: every thread's agent in the SAME project
// reads/writes the SAME filesystem.

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: text.length, uploaded: new Date(), async text() { return text; }, get body() { return text; } } as unknown as R2ObjectBody;
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: store.get(k)!.length, uploaded: new Date(), etag: "x" }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
    async delete() {},
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
    await tools.run("write_file", { path: "notes.txt", content: "assistant note" });
    const raw = await bucket.get("spaces/space1/workspace/notes.txt");
    expect(await raw?.text()).toBe("assistant note");
  });

  it("a project-bound run writes under that project's own workspace prefix", async () => {
    const bucket = makeR2();
    const tools = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket, projectId: "proj1" }), ["r2-workspace"]);
    await tools.run("write_file", { path: "ledger.csv", content: "row1" });
    const raw = await bucket.get("spaces/space1/projects/proj1/workspace/ledger.csv");
    expect(await raw?.text()).toBe("row1");
  });

  it("two different threads' agents in the SAME project share the same workspace file", async () => {
    const bucket = makeR2();
    // agentId differs (thread A's agent vs thread B's agent) but spaceId+projectId match.
    const threadA = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket, agentId: "agent-thread-a", projectId: "proj1" }), ["r2-workspace"]);
    const threadB = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket, agentId: "agent-thread-b", projectId: "proj1" }), ["r2-workspace"]);

    await threadA.run("write_file", { path: "ledger.csv", content: "customer-1,complaint\n" });
    const seenByB = await threadB.run("read_file", { path: "ledger.csv" });
    expect((seenByB.output as { content: string }).content).toBe("customer-1,complaint\n");
  });

  it("two different PROJECTS in the same space do NOT share a workspace", async () => {
    const bucket = makeR2();
    const proj1 = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket, projectId: "proj1" }), ["r2-workspace"]);
    const proj2 = new ScriptToolSurface(makeEnv({ scriptsBucket: bucket, projectId: "proj2" }), ["r2-workspace"]);

    await proj1.run("write_file", { path: "ledger.csv", content: "proj1 data" });
    const seenByProj2 = await proj2.run("read_file", { path: "ledger.csv" });
    expect((seenByProj2.output as { exists: boolean }).exists).toBe(false);
  });
});
