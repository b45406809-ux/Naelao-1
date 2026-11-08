import { describe, expect, it, vi } from "vitest";
import { observeFilesystem } from "./observe.js";
import type { ScriptEngineEnv } from "./types.js";

describe("observe filesystem manifest reads", () => {
  it("pins the structure fingerprint to one coordinator revision", async () => {
    const list = vi.fn();
    const env = {
      scriptsBucket: { list },
      spaceId: "space-1",
      projectId: "project-1",
      workspaceBranch: "runs/agent-1",
      workspaceManifestRead: async () => ({
        head: { branch: "runs/agent-1", revision: 19, updatedAt: new Date().toISOString() },
        entries: [
          { path: "src/main.ts", size: 12, sha256: "a".repeat(64), executable: false, objectKey: "workspace-v1/content/hash" },
          { path: "assets/logo.svg", size: 8, sha256: "b".repeat(64), executable: false, objectKey: "workspace-v1/content/hash2" },
        ],
      }),
    } as unknown as ScriptEngineEnv;

    const result = await observeFilesystem(env, "src/");
    expect(result).toMatchObject({ type: "filesystem", file_count: 1, total_size: 12, workspace_branch: "runs/agent-1", workspace_revision: 19 });
    expect(list).not.toHaveBeenCalled();
  });
});
