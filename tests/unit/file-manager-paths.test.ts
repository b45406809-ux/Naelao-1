import { describe, expect, it } from "vitest";
import { fileManager } from "../../workers/agents/src/script-engine/prebuilt/file-manager.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

const context = {
  env: {
    spaceId: "space-1",
    agentId: "agent-1",
    tenantId: "tenant-1",
  } as unknown as ScriptEngineEnv,
  run: async () => ({}),
} as PrebuiltOpContext;

const diff = fileManager.operations["file.diff"];
if (!diff) throw new Error("file.diff operation is missing");

describe("file-manager workspace path boundary", () => {
  it.each([
    ["parent traversal", "../secret"],
    ["backslash traversal", "..\\secret"],
    ["machine state", ".avos/config.json"],
    ["reserved branch storage", "branches/worker-1/file.ts"],
    ["workspace root", "/workspace"],
  ])("rejects %s before accessing R2", async (_case, path) => {
    await expect(
      diff({ path_a: path, path_b: "safe.txt" }, context)
    ).rejects.toThrow();
  });

  it("accepts ordinary filenames containing consecutive dots", async () => {
    const bucket = {
      async get() {
        return null;
      },
    };
    const ctx = {
      ...context,
      env: {
        ...context.env,
        workspaceBucket: bucket,
      } as unknown as ScriptEngineEnv,
    } as PrebuiltOpContext;

    await expect(
      diff({ path_a: "reports/quarter..final.csv", path_b: "safe.txt" }, ctx)
    ).resolves.toEqual({ added: [], removed: [] });
  });
});
