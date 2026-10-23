import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killProcessesForUid } from "./process-supervisor.mjs";

let root;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function addProcess(pid, uids) {
  const dir = join(root, String(pid));
  await mkdir(dir);
  await writeFile(join(dir, "status"), `Name:\ttest\nState:\tS (sleeping)\nUid:\t${uids.join("\t")}\n`);
}

describe("guest process cleanup", () => {
  it("kills every process with the dedicated guest uid, including detached sessions", async () => {
    root = await mkdtemp(join(tmpdir(), "guest-proc-"));
    await addProcess(101, [10001, 10001, 10001, 10001]);
    await addProcess(202, [10002, 10002, 10002, 10002]);
    const killed = [];
    await killProcessesForUid(10001, { procRoot: root, pause: async () => undefined,
      kill: async (pid, signal) => { killed.push([pid, signal]); await rm(join(root, String(pid)), { recursive: true, force: true }); } });
    expect(killed).toEqual([[101, "SIGKILL"]]);
    await expect(killProcessesForUid(10001, { procRoot: root, pause: async () => undefined, kill: vi.fn() })).resolves.toBeUndefined();
  });

  it("fails closed when a guest process remains after bounded cleanup attempts", async () => {
    root = await mkdtemp(join(tmpdir(), "guest-proc-stuck-"));
    await addProcess(101, [10001, 10001, 10001, 10001]);
    const kill = vi.fn();
    await expect(killProcessesForUid(10001, { procRoot: root, pause: async () => undefined, kill }))
      .rejects.toThrow("guest_process_cleanup_unverified");
    expect(kill).toHaveBeenCalledTimes(5);
  });
});
