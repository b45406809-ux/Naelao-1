import { describe, expect, it } from "vitest";
import {
  executeVirtualShell,
  virtualFsDelete,
  virtualFsGrep,
  virtualFsList,
  virtualFsRead,
  virtualFsWrite,
} from "./r2-workspace.js";
import { workspacePrefix } from "./types.js";
import { codeExec } from "./prebuilt/code-exec.js";

function createMockEnv() {
  const store = new Map();
  const metadata = new Map();
  const etags = new Map();
  const mockBucket = {
    get: async (key) => {
      const data = store.get(key);
      return data ? { arrayBuffer: async () => data.buffer } : null;
    },
    head: async (key) => store.has(key) ? { customMetadata: metadata.get(key), etag: etags.get(key) } : null,
    put: async (key, value, options) => {
      if (options?.onlyIf?.etagMatches && etags.get(key) !== options.onlyIf.etagMatches) return undefined;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) return undefined;
      store.set(key, value);
      metadata.set(key, options?.customMetadata ?? {});
      const etag = `etag-${store.size}-${Date.now()}`;
      etags.set(key, etag);
      return { etag };
    },
    delete: async (key) => {
      store.delete(key);
    },
    list: async ({ prefix }) => {
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, size: store.get(key).byteLength, customMetadata: metadata.get(key) }));
      return { objects, truncated: false };
    },
  };

  return {
    scriptsBucket: mockBucket,
    workspaceBucket: mockBucket,
    spaceId: "space-1",
    projectId: "proj-1",
    agentId: "agent-1",
    tenantId: "tenant-1",
    workspaceFileScope: undefined as string[] | undefined,
  };
}

describe("R2 Virtual POSIX Workspace", () => {
  it("isolates a race branch below the project workspace prefix", () => {
    expect(workspacePrefix({ spaceId: "space-1", projectId: "proj-1", workspaceBranch: "race/task/model" }))
      .toBe("spaces/space-1/projects/proj-1/workspace/branches/race/task/model/");
    expect(workspacePrefix({ spaceId: "space-1", projectId: "proj-1" }))
      .toBe("spaces/space-1/projects/proj-1/workspace/");
    expect(() => workspacePrefix({ spaceId: "space-1", projectId: "proj-1", workspaceBranch: "../escape" })).toThrow("invalid path");
  });
  async function hash(content: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  it("performs file read, write, delete, and list operations in V8", async () => {
    const env = createMockEnv();
    await virtualFsWrite(env, "docs/readme.md", "hello world", null);
    expect(await virtualFsRead(env, "docs/readme.md")).toBe("hello world");

    const list = await virtualFsList(env, "docs");
    expect(list).toEqual([{ path: "docs/readme.md", size: 11 }]);

    await expect(virtualFsWrite(env, "docs/readme.md", "clobber", null)).rejects.toThrow("Conflict Error");
    await virtualFsDelete(env, "docs/readme.md", await hash("hello world"));
    expect(await virtualFsRead(env, "docs/readme.md")).toBeNull();
  });

  it("supports virtual in-isolate grepping without container execution", async () => {
    const env = createMockEnv();
    await virtualFsWrite(
      env,
      "src/api.ts",
      "const x = 1;\nexport function findMe() {}\nconst y = 2;",
      null
    );
    await virtualFsWrite(env, "src/util.ts", "export const version = '1.0';", null);

    const matches = await virtualFsGrep(env, "findMe", "src");
    expect(matches).toEqual([
      { path: "src/api.ts", line: 2, match: "export function findMe() {}" },
    ]);
  });

  it("enforces the host-signed exact file slice for reads, writes, deletes and listings", async () => {
    const env = createMockEnv();
    await virtualFsWrite(env, "src/owned.ts", "owned", null);
    await virtualFsWrite(env, "src/other.ts", "other", null);
    env.workspaceFileScope = ["src/owned.ts"];

    expect(await virtualFsRead(env, "src/owned.ts")).toBe("owned");
    await expect(virtualFsRead(env, "src/other.ts")).rejects.toThrow("worker_file_scope_denied");
    await expect(virtualFsWrite(env, "src/other.ts", "changed", null)).rejects.toThrow("worker_file_scope_denied");
    await expect(virtualFsDelete(env, "src/other.ts", null)).rejects.toThrow("worker_file_scope_denied");
    expect(await virtualFsList(env, "src")).toEqual([{ path: "src/owned.ts", size: 5 }]);
    expect(await virtualFsGrep(env, "other", "src")).toEqual([]);
    await expect(codeExec.operations.Bash({ commands: "cat src/other.ts" }, { env, run: async () => undefined })).rejects.toThrow("worker_file_scope_denied");
    await expect(codeExec.operations["code.execute_python"]({ code: "open('src/other.ts').read()" }, { env, run: async () => undefined })).rejects.toThrow("worker_file_scope_native_execution_unavailable");
  });

  it("executes virtual shell commands directly", async () => {
    const env = createMockEnv();
    const writeRes = await executeVirtualShell(env, "write", {
      path: "notes.txt",
      content: "POSIX in V8",
      expectedHash: null,
    });
    expect(writeRes.ok).toBe(true);
    expect(writeRes.tier).toBe(1);
    const readRes = await executeVirtualShell(env, "read", {
      path: "notes.txt",
    });
    expect(readRes.output).toBe("POSIX in V8");
  });
});
