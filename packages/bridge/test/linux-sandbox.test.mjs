import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createLinuxSandboxExecutor } from "../src/linux-sandbox.mjs";

test("Linux executor mounts only owner-consented roots and disables network access", async () => {
  let invocation;
  const spawn = (binary, args) => {
    invocation = { binary, args };
    const child = new EventEmitter(); child.pid = 123;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  const executor = createLinuxSandboxExecutor({ spawn, exists: () => true, realpathFn: async path => path, os: "linux" });
  const result = await executor({ command: "touch output.txt", cwd: "/home/owner/project" }, {
    signal: new AbortController().signal, roots: ["/home/owner/project"], output() {},
  });
  assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
  assert.equal(invocation.binary, "/usr/bin/bwrap");
  assert.ok(invocation.args.includes("--unshare-all"));
  assert.ok(invocation.args.includes("--bind"));
  assert.ok(invocation.args.includes("/home/owner/project"));
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--bind") + 1, invocation.args.indexOf("--bind") + 3), ["/home/owner/project", "/home/owner/project"]);
});

test("real bubblewrap process can change files inside its selected local folder", { skip: !existsSync("/usr/bin/bwrap") }, async () => {
  const root = await mkdtemp(join(tmpdir(), "naelao-bridge-sandbox-"));
  try {
    const executor = createLinuxSandboxExecutor();
    const result = await executor({ command: "printf changed > note.txt && pwd", cwd: root }, { signal: new AbortController().signal, roots: [{ path: root, access: "readwrite" }], output() {} });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), root);
    assert.equal(await readFile(join(root, "note.txt"), "utf8"), "changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-only host roots reject writes and empty grants expose only ephemeral scratch space", { skip: !existsSync("/usr/bin/bwrap") }, async () => {
  const root = await mkdtemp(join(tmpdir(), "naelao-bridge-readonly-"));
  try {
    const executor = createLinuxSandboxExecutor();
    const denied = await executor({ command: "touch forbidden.txt", cwd: root }, { signal: new AbortController().signal, roots: [{ path: root, access: "read" }], output() {} });
    assert.notEqual(denied.exitCode, 0);
    const scratch = await executor({ command: "printf scratch > item && pwd" }, { signal: new AbortController().signal, roots: [], output() {} });
    assert.equal(scratch.exitCode, 0);
    assert.equal(scratch.stdout.trim(), "/tmp");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("executor rejects a cwd outside local grants and refuses unsupported operating systems", async () => {
  const executor = createLinuxSandboxExecutor({ exists: () => true, realpathFn: async path => path, os: "linux" });
  await assert.rejects(executor({ command: "pwd", cwd: "/etc" }, { signal: new AbortController().signal, roots: ["/home/owner/project"], output() {} }), /working_directory_denied/);
  const unsupported = createLinuxSandboxExecutor({ os: "darwin" });
  await assert.rejects(unsupported({ command: "pwd" }, { signal: new AbortController().signal, roots: ["/tmp/project"], output() {} }), /os_sandbox_unavailable/);
});
