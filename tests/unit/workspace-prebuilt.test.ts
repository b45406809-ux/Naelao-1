import { describe, it, expect } from "vitest";
import { workspace } from "../../workers/agents/src/script-engine/prebuilt/workspace.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";
import type { ScriptEngineEnv, ContainerWorkspaceGateway } from "../../workers/agents/src/script-engine/types.js";

// §A1.17 Phase R: the agent explicitly moves files between the R2 workspace (always available,
// durable) and the Tier-5 container's own local disk (persists only while warm) — this
// replaces the old implicit full-sync-every-/exec-call behavior (see
// container-per-project.test.ts for the corresponding ToolSandboxDO-side change).

function makeFakeR2() {
  const store = new Map<string, string>();
  const etags = new Map<string, string>();
  const metadata = new Map<string, Record<string, string>>();
  let revision = 0;
  return {
    store,
    async get(key: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return { text: async () => value, size: bytes.byteLength, etag: etags.get(key), customMetadata: metadata.get(key), arrayBuffer: async () => bytes.buffer } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const value = store.get(key);
      return value === undefined ? null : ({ size: new TextEncoder().encode(value).byteLength, etag: etags.get(key) ?? `legacy-${key}`, customMetadata: metadata.get(key) } as unknown as R2Object);
    },
    async put(key: string, value: unknown, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; customMetadata?: Record<string, string> }) {
      const current = store.get(key);
      const currentEtag = current === undefined ? undefined : etags.get(key) ?? `legacy-${key}`;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && current !== undefined) return null;
      if (options?.onlyIf?.etagMatches !== undefined && currentEtag !== options.onlyIf.etagMatches) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer | ArrayBufferView);
      const etag = `etag-${++revision}`;
      store.set(key, new TextDecoder().decode(bytes));
      etags.set(key, etag);
      metadata.set(key, options?.customMetadata ?? {});
      return { etag };
    },
    async delete(key: string) { store.delete(key); },
    async list({ prefix }: { prefix: string }) {
      const objects = [...store.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, size: new TextEncoder().encode(store.get(key)!).byteLength, uploaded: new Date(), etag: etags.get(key), customMetadata: metadata.get(key) }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  } as unknown as R2Bucket & { store: Map<string, string> };
}

function makeContainerWorkspace(initial: Record<string, string> = {}): ContainerWorkspaceGateway & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async list() { return { files: [...store.keys()] }; },
    async read(paths) {
      const files: Record<string, string> = {};
      for (const p of paths ?? [...store.keys()]) if (store.has(p)) files[p] = store.get(p)!;
      return { files };
    },
    async write(files) {
      for (const [p, content] of Object.entries(files)) store.set(p, content);
      return { ok: true };
    },
    async remove(paths) {
      for (const p of paths) store.delete(p);
      return { ok: true };
    },
  };
}

function makeCtx(opts: { r2?: ReturnType<typeof makeFakeR2>; container?: ReturnType<typeof makeContainerWorkspace>; projectId?: string } = {}): PrebuiltOpContext {
  const env: Partial<ScriptEngineEnv> = {
    scriptsBucket: (opts.r2 ?? makeFakeR2()) as never,
    spaceId: "space-1",
    agentId: "agent-1",
    tenantId: "tenant-1",
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.container ? { containerWorkspace: opts.container } : {}),
  };
  return { env: env as ScriptEngineEnv, run: async () => ({}) };
}

const call = (ctx: PrebuiltOpContext, op: string, args: Record<string, unknown>) => workspace.operations[op]!(args, ctx);

describe("workspace prebuilt", () => {
  describe("workspace.list", () => {
    it("lists R2 files relative to the run's workspace prefix", async () => {
      const r2 = makeFakeR2();
      r2.store.set("spaces/space-1/projects/proj-1/workspace/a.txt", "1");
      r2.store.set("spaces/space-1/projects/proj-1/workspace/b.txt", "2");
      const ctx = makeCtx({ r2, projectId: "proj-1" });
      const result = await call(ctx, "workspace.list", { name: "r2" });
      expect(result).toEqual({ workspace: "r2", files: ["a.txt", "b.txt"] });
    });

    it("lists container files via the gateway", async () => {
      const container = makeContainerWorkspace({ "out.csv": "x" });
      const ctx = makeCtx({ container });
      const result = await call(ctx, "workspace.list", { name: "container" });
      expect(result).toEqual({ workspace: "container", files: ["out.csv"] });
    });

    it("fails closed when asked to list the container but TOOL_SANDBOX isn't configured", async () => {
      const ctx = makeCtx({});
      await expect(call(ctx, "workspace.list", { name: "container" })).rejects.toThrow(/container workspace unavailable/);
    });

    it("rejects an unknown workspace name", async () => {
      const ctx = makeCtx({});
      await expect(call(ctx, "workspace.list", { name: "s3" })).rejects.toThrow(/must be 'r2' or 'container'/);
    });
  });

  describe("workspace.copy", () => {
    it("copies r2 -> container, leaving the R2 source intact", async () => {
      const r2 = makeFakeR2();
      r2.store.set("spaces/space-1/projects/proj-1/workspace/data.csv", "a,b\n1,2");
      const container = makeContainerWorkspace();
      const ctx = makeCtx({ r2, container, projectId: "proj-1" });

      const result = await call(ctx, "workspace.copy", { from: "r2", to: "container", path: "data.csv" });

      expect(result).toEqual({ ok: true, from: "r2", to: "container", path: "data.csv", to_path: "data.csv" });
      expect(container.store.get("data.csv")).toBe("a,b\n1,2");
      expect(r2.store.get("spaces/space-1/projects/proj-1/workspace/data.csv")).toBe("a,b\n1,2");
    });

    it("copies container -> r2 under a renamed to_path", async () => {
      const r2 = makeFakeR2();
      const container = makeContainerWorkspace({ "result.json": '{"ok":true}' });
      const ctx = makeCtx({ r2, container, projectId: "proj-1" });

      await call(ctx, "workspace.copy", { from: "container", to: "r2", path: "result.json", to_path: "archive/result.json" });

      expect(r2.store.get("spaces/space-1/projects/proj-1/workspace/archive/result.json")).toBe('{"ok":true}');
    });

    it("throws when the source file doesn't exist", async () => {
      const ctx = makeCtx({ container: makeContainerWorkspace() });
      await expect(call(ctx, "workspace.copy", { from: "container", to: "r2", path: "missing.txt" })).rejects.toThrow(/source file not found/);
    });

    it("rejects copying a workspace to itself", async () => {
      const ctx = makeCtx({});
      await expect(call(ctx, "workspace.copy", { from: "r2", to: "r2", path: "a.txt" })).rejects.toThrow(/must be different workspaces/);
    });

    it("rejects path traversal on the R2 side", async () => {
      const ctx = makeCtx({ container: makeContainerWorkspace({ "x.txt": "1" }) });
      await expect(call(ctx, "workspace.copy", { from: "container", to: "r2", path: "x.txt", to_path: "../escape.txt" })).rejects.toThrow(/Path traversal rejected/);
    });
  });

  describe("workspace.move", () => {
    it("moves a file r2 -> container, deleting the R2 source", async () => {
      const r2 = makeFakeR2();
      r2.store.set("spaces/space-1/workspace/notes.txt", "draft");
      const container = makeContainerWorkspace();
      const ctx = makeCtx({ r2, container });

      await call(ctx, "workspace.move", { from: "r2", to: "container", path: "notes.txt" });

      expect(container.store.get("notes.txt")).toBe("draft");
      expect(r2.store.has("spaces/space-1/workspace/notes.txt")).toBe(true);
      expect((await r2.head("spaces/space-1/workspace/notes.txt"))?.customMetadata?.deleted).toBe("true");
    });

    it("moves a file container -> r2, deleting the container source", async () => {
      const r2 = makeFakeR2();
      const container = makeContainerWorkspace({ "big.log": "line1\nline2" });
      const ctx = makeCtx({ r2, container });

      await call(ctx, "workspace.move", { from: "container", to: "r2", path: "big.log" });

      expect(r2.store.get("spaces/space-1/workspace/big.log")).toBe("line1\nline2");
      expect(container.store.has("big.log")).toBe(false);
    });
  });

  // AVOS plan, step 3 — bulk copy every file under a prefix in ONE call, instead of one
  // workspace.copy per file.
  describe("workspace.sync_to_container", () => {
    it("copies every R2 file under the run's prefix into the container in one call", async () => {
      const r2 = makeFakeR2();
      r2.store.set("spaces/space-1/workspace/a.ts", "1");
      r2.store.set("spaces/space-1/workspace/src/b.ts", "2");
      const container = makeContainerWorkspace();
      const ctx = makeCtx({ r2, container });

      const result = await call(ctx, "workspace.sync_to_container", {});

      expect(result).toEqual({ ok: true, synced_files_count: 2, target: "container:/workspace" });
      expect(container.store.get("a.ts")).toBe("1");
      expect(container.store.get("src/b.ts")).toBe("2");
      // R2 source is untouched — this is a copy, not a move.
      expect(r2.store.get("spaces/space-1/workspace/a.ts")).toBe("1");
    });

    it("scopes to a path prefix when given one", async () => {
      const r2 = makeFakeR2();
      r2.store.set("spaces/space-1/workspace/src/a.ts", "1");
      r2.store.set("spaces/space-1/workspace/docs/readme.md", "2");
      const container = makeContainerWorkspace();
      const ctx = makeCtx({ r2, container });

      const result = await call(ctx, "workspace.sync_to_container", { path: "src" });

      expect(result.synced_files_count).toBe(1);
      expect(container.store.has("src/a.ts")).toBe(true);
      expect(container.store.has("docs/readme.md")).toBe(false);
    });

    it("fails closed when TOOL_SANDBOX isn't configured", async () => {
      const ctx = makeCtx({});
      await expect(call(ctx, "workspace.sync_to_container", {})).rejects.toThrow(/container workspace unavailable/);
    });
  });

  describe("workspace.sync_from_container", () => {
    it("copies every container file back into R2 at the same relative paths", async () => {
      const r2 = makeFakeR2();
      const container = makeContainerWorkspace({ "out.csv": "a,b", "nested/report.json": "{}" });
      const ctx = makeCtx({ r2, container });

      const result = await call(ctx, "workspace.sync_from_container", {});

      expect(result).toEqual({ ok: true, synced_files_count: 2, target: "r2" });
      expect(r2.store.get("spaces/space-1/workspace/out.csv")).toBe("a,b");
      expect(r2.store.get("spaces/space-1/workspace/nested/report.json")).toBe("{}");
    });

    it("fails closed when TOOL_SANDBOX isn't configured", async () => {
      const ctx = makeCtx({});
      await expect(call(ctx, "workspace.sync_from_container", {})).rejects.toThrow(/container workspace unavailable/);
    });
  });
});
