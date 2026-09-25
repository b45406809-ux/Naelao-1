import { describe, expect, it } from "vitest";
import {
  executeVirtualShell,
  virtualFsDelete,
  virtualFsGrep,
  virtualFsList,
  virtualFsRead,
  virtualFsWrite,
} from "./r2-workspace.js";

function createMockEnv() {
  const store = new Map();
  const mockBucket = {
    get: async (key) => {
      const data = store.get(key);
      return data ? { arrayBuffer: async () => data.buffer } : null;
    },
    put: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    list: async ({ prefix }) => {
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, size: store.get(key).byteLength }));
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
  };
}

describe("R2 Virtual POSIX Workspace", () => {
  it("performs file read, write, delete, and list operations in V8", async () => {
    const env = createMockEnv();
    await virtualFsWrite(env, "docs/readme.md", "hello world");
    expect(await virtualFsRead(env, "docs/readme.md")).toBe("hello world");

    const list = await virtualFsList(env, "docs");
    expect(list).toEqual([{ path: "docs/readme.md", size: 11 }]);

    await virtualFsDelete(env, "docs/readme.md");
    expect(await virtualFsRead(env, "docs/readme.md")).toBeNull();
  });

  it("supports virtual in-isolate grepping without container execution", async () => {
    const env = createMockEnv();
    await virtualFsWrite(
      env,
      "src/api.ts",
      "const x = 1;\nexport function findMe() {}\nconst y = 2;"
    );
    await virtualFsWrite(env, "src/util.ts", "export const version = '1.0';");

    const matches = await virtualFsGrep(env, "findMe", "src");
    expect(matches).toEqual([
      { path: "src/api.ts", line: 2, match: "export function findMe() {}" },
    ]);
  });

  it("executes virtual shell commands directly", async () => {
    const env = createMockEnv();
    const writeRes = await executeVirtualShell(env, "write", {
      path: "notes.txt",
      content: "POSIX in V8",
    });
    expect(writeRes.ok).toBe(true);
    expect(writeRes.tier).toBe(1);
    const readRes = await executeVirtualShell(env, "read", {
      path: "notes.txt",
    });
    expect(readRes.output).toBe("POSIX in V8");
  });
});
