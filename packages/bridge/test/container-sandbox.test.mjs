import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createContainerSandboxExecutor } from "../src/container-sandbox.mjs";

const image = `registry.example/naelao/sandbox@sha256:${"a".repeat(64)}`;

test("Docker Desktop executor uses a pinned, networkless, unprivileged container and scoped mounts", async () => {
  let invocation;
  const spawn = (binary, args) => {
    invocation = { binary, args };
    const child = new EventEmitter(); child.pid = 42;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  const executor = createContainerSandboxExecutor({ spawn, realpathFn: async path => path, os: "darwin" });
  const result = await executor({ command: "touch result.txt", cwd: "/Users/alice/project", sandboxImage: image }, {
    signal: new AbortController().signal, roots: [{ path: "/Users/alice/project", access: "readwrite" }, { path: "/Users/alice/reference", access: "read" }], output() {},
  });
  assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
  assert.equal(invocation.binary, "docker");
  assert.ok(invocation.args.includes("--pull=never"));
  assert.ok(invocation.args.includes("--network=none"));
  assert.ok(invocation.args.includes("--read-only"));
  assert.ok(invocation.args.includes("--cap-drop=ALL"));
  assert.ok(invocation.args.includes("--user=65534:65534"));
  assert.ok(invocation.args.includes(image));
  assert.ok(invocation.args.some(arg => arg.includes("target=/mnt/naelao/0,")));
  assert.ok(invocation.args.some(arg => arg.includes("target=/mnt/naelao/1,")));
  assert.ok(invocation.args.some(arg => arg.includes("target=/mnt/naelao/1,readonly")));
  assert.equal(invocation.args.includes("/Users/alice/.ssh"), false);
});

test("Docker executor rejects unpinned images, non-consented working folders, and Linux hosts", async () => {
  const executor = createContainerSandboxExecutor({ spawn() { throw new Error("must_not_spawn"); }, realpathFn: async path => path, os: "win32" });
  await assert.rejects(executor({ command: "whoami", sandboxImage: "alpine:latest" }, { signal: new AbortController().signal, roots: [], output() {} }), /request_invalid/);
  await assert.rejects(executor({ command: "whoami", cwd: "/Users/bob/private", sandboxImage: image }, { signal: new AbortController().signal, roots: ["/Users/bob/project"], output() {} }), /working_directory_denied/);
  const linux = createContainerSandboxExecutor({ os: "linux" });
  await assert.rejects(linux({ command: "true", sandboxImage: image }, { signal: new AbortController().signal, roots: [], output() {} }), /platform_unsupported/);
});
