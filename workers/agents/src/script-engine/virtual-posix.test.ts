import { describe, expect, it, vi } from "vitest";
import { executeVirtualPosix } from "./virtual-posix.js";
import { normalizeWorkspacePath } from "./workspace-paths.js";
import { codeExec } from "./prebuilt/code-exec.js";

describe("virtual POSIX shell", () => {
  const files = new Map([["data.txt", "alpha 1\nbeta 2\nalpha 3\n"]]);
  const fs = {
    read: async (p: string) => files.get(p),
    list: async () => [...files.keys()],
  };

  it("executes pipes in memory without a container", async () => {
    await expect(
      executeVirtualPosix(
        "cat /workspace/data.txt | grep alpha | awk '{print $2}'",
        fs
      )
    ).resolves.toMatchObject({ exit_code: 0, stdout: "1\n3" });
  });

  it("rejects traversal and the machine namespace", () => {
    expect(() => normalizeWorkspacePath("/workspace/../.avos/key")).toThrow(
      "workspace_path_traversal"
    );
    expect(() => normalizeWorkspacePath("/.avos/bin/tool.ts")).toThrow(
      "agent_state_is_not_a_deliverable"
    );
  });

  it("executes a command installed in /.avos/bin in Tier 2", async () => {
    const run = vi.fn(async () => ({
      ok: true,
      output: "hello",
      tier: 2,
      duration_ms: 1,
      tokens_used: 0,
    }));
    const bucket = {
      get: vi.fn(async (key: string) =>
        key.endsWith("/avos/bin/hello.ts")
          ? {
              text: async () =>
                "export async function run(args, ctx) { return args.argv }",
            }
          : null
      ),
    } as unknown as R2Bucket;
    const output = await codeExec.operations.Bash!(
      { commands: "hello world" },
      {
        env: {
          scriptsBucket: bucket,
          spaceId: "s",
          projectId: "p",
          tenantId: "t",
          agentId: "a",
          codeRunner: { run },
        },
        run: async () => undefined,
      }
    );
    expect(output).toBe("hello");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "avos-bin.hello",
        tier: 2,
        args: { argv: ["world"] },
      })
    );
  });
});
