import { describe, expect, it, vi } from "vitest";
import { executeVirtualPosix } from "./virtual-posix.js";
import { normalizeWorkspacePath } from "./workspace-paths.js";
import { codeExec } from "./prebuilt/code-exec.js";
import { VirtualCliDispatcher } from "./virtual-cli.js";

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

  it("keeps simple shell status commands in the virtual runtime", async () => {
    await expect(executeVirtualPosix("echo \"Project created successfully\"", fs)).resolves.toMatchObject({
      exit_code: 0,
      stdout: "Project created successfully",
    });
    await expect(executeVirtualPosix("pwd", fs)).resolves.toMatchObject({
      exit_code: 0,
      stdout: "/workspace",
    });
  });

  it("routes fetch-md through the virtual shell without starting a container", async () => {
    const fetchMarkdown = vi.fn(async () => ({
      url: "https://example.com/guide",
      status: 200,
      content: "# Guide",
      content_type: "text/markdown",
      format: "markdown",
    }));
    const cli = new VirtualCliDispatcher({ tenantId: "tenant", spaceId: "space", fetchMarkdown });
    await expect(executeVirtualPosix("fetch-md https://example.com/guide", fs, { cli })).resolves.toMatchObject({ exit_code: 0, stdout: "# Guide" });
    expect(fetchMarkdown).toHaveBeenCalledOnce();
  });

  it("routes generic API requests through the virtual shell and Vault proxy", async () => {
    const fetchWithAuth = vi.fn(async () => Response.json({ ok: true }));
    const cli = new VirtualCliDispatcher({ tenantId: "tenant", spaceId: "space", vault: { fetchWithAuth } });
    await expect(executeVirtualPosix('api request GET https://api.stripe.com/v1/new_endpoint --credential STRIPE_KEY', fs, { cli }))
      .resolves.toMatchObject({ exit_code: 0, stdout: '{\n  "ok": true\n}' });
    expect(fetchWithAuth).toHaveBeenCalledOnce();
    expect(fetchWithAuth.mock.calls[0]![0]).toBe("https://api.stripe.com/v1/new_endpoint");
  });

  it("rejects traversal and the machine namespace", () => {
    expect(() => normalizeWorkspacePath("/workspace/../.avos/key")).toThrow(
      "workspace_path_traversal"
    );
    expect(() => normalizeWorkspacePath("/.avos/bin/tool.ts")).toThrow(
      "agent_state_is_not_a_deliverable"
    );
    expect(() => normalizeWorkspacePath("/etc/passwd")).toThrow(
      "deliverable_must_be_in_workspace"
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
    expect(output).toMatchObject({ result: "hello" });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "avos-bin.hello",
        tier: 2,
        args: { argv: ["world"] },
      })
    );
  });
});
