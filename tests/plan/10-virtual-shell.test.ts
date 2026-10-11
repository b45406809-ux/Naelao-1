import { describe, expect, it, vi } from "vitest";
import { executeVirtualPosix } from "../../workers/agents/src/script-engine/virtual-posix.js";
import { interceptPlatformCli } from "../../workers/agents/src/script-engine/virtual-cli.js";
import { classifyExecutionRoute } from "../../workers/agents/src/script-engine/execution-ladder.js";

const filesystem = () => {
  const files = new Map<string, string>();
  return { files, read: async (path: string) => files.get(path), list: async () => [...files.keys()],
    write: async (path: string, value: string) => { files.set(path, value); },
    remove: async (path: string) => { files.delete(path); } };
};

describe("Step 10 universal shell", () => {
  it("preserves JSON quotes and apostrophes in a worker objective", () => {
    expect(interceptPlatformCli(`naelao worker run project_manager_worker --task "Create John's project"`)).toEqual({
      operation: "delegate_to_space_worker", params: { worker_id: "project_manager_worker", task: "Create John's project" },
    });
  });
  it("redirects and pipelines through the VFS", async () => {
    const fs = filesystem();
    await executeVirtualPosix(`echo 'hello world' > greeting.txt`, fs);
    expect(fs.files.get("greeting.txt")).toBe("hello world");
    expect((await executeVirtualPosix("cat greeting.txt | grep hello", fs)).stdout).toBe("hello world");
  });
  it("propagates exit status and conditional execution", async () => {
    expect((await executeVirtualPosix("false && echo bad || echo recovered", filesystem())).stdout).toBe("recovered");
  });
  it("refuses unauthorized binaries and traversal before executing", async () => {
    const resolver = vi.fn();
    const result = await executeVirtualPosix("naelao worker run x --task y", filesystem(), { authorize: async () => false, resolve: resolver });
    expect(result.exit_code).not.toBe(0); expect(resolver).not.toHaveBeenCalled();
    expect((await executeVirtualPosix("cat ../secret", filesystem())).exit_code).not.toBe(0);
  });
  it("cancels a pending stage", async () => {
    const controller = new AbortController();
    const pending = executeVirtualPosix("echo waiting", filesystem(), {
      signal: controller.signal, resolve: async () => { controller.abort(); return new Promise(() => {}); },
    });
    expect((await pending).exit_code).toBe(130);
  });
  it("keeps echo local and unknown binaries out of paid runtime routing", () => {
    expect(classifyExecutionRoute("echo hello").tier).toBe(1);
    expect(classifyExecutionRoute("unknown_unsupported_binary").reason).toBe("command_not_found");
  });
});
