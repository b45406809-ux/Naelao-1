import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";

// §A1.17 Phase M: the Naelao Local Agent reference client (workers/agents/local-agent/
// naelao-local-agent.mjs) is what actually runs on a builder's own machine. Importing it must
// NOT open a real WebSocket connection (guarded by the `import.meta.url === process.argv[1]`
// check) — these tests verify that guard holds and exercise the pure client-side policy helpers
// (the OPTIONAL second check on top of the server's own grant enforcement).

const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../workers/agents/local-agent/naelao-local-agent.mjs");

describe("naelao-local-agent.mjs — import safety", () => {
  it("does not attempt a network connection merely by being imported", async () => {
    // If main() ran on import, this would throw trying to construct a WebSocket with no args,
    // or hang attempting a real connection. A clean import proves the CLI-entry guard works.
    const mod = await import(modulePath);
    expect(typeof mod.normalizePath).toBe("function");
  });
});

describe("naelao-local-agent.mjs — client-side path/command policy (defense in depth)", () => {
  it("normalizePath collapses .. traversal", async () => {
    const { normalizePath } = await import(modulePath);
    expect(normalizePath("/home/alice/project/../../../etc/passwd")).toBe("/etc/passwd");
    expect(normalizePath("/home/alice/project/./readme.md")).toBe("/home/alice/project/readme.md");
  });

  it("isWithinAny requires real path-segment containment, not a string prefix", async () => {
    const { isWithinAny } = await import(modulePath);
    expect(isWithinAny("/home/alice/allowed/file.txt", ["/home/alice/allowed"])).toBe(true);
    expect(isWithinAny("/home/alice/allowed-evil/file.txt", ["/home/alice/allowed"])).toBe(false);
  });

  it("isWithinAny with an empty allowlist defers to the server's own check (returns true)", async () => {
    const { isWithinAny } = await import(modulePath);
    expect(isWithinAny("/anything/at/all", [])).toBe(true);
  });

  it("isAllowedCommand requires an exact match, not a prefix", async () => {
    const { isAllowedCommand } = await import(modulePath);
    expect(isAllowedCommand("npm test", ["npm test"])).toBe(true);
    expect(isAllowedCommand("npm test && rm -rf /", ["npm test"])).toBe(false);
  });

  it("handleRequest rejects a read_file outside the configured --allow-dir list", async () => {
    const { handleRequest } = await import(modulePath);
    await expect(
      handleRequest({ allowDirs: ["/home/alice/allowed"], allowCommands: [] }, "read_file", { path: "/etc/passwd" })
    ).rejects.toThrow(/local policy/);
  });

  it("handleRequest rejects an unknown op", async () => {
    const { handleRequest } = await import(modulePath);
    await expect(handleRequest({ allowDirs: [], allowCommands: [] }, "delete_everything", {})).rejects.toThrow(/unknown op/);
  });

  it("handleRequest performs a real write+read round trip within an allowed directory", async () => {
    const { handleRequest } = await import(modulePath);
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "naelao-local-agent-test-"));
    const filePath = path.join(tmpDir, "out.txt");

    const writeResult = await handleRequest({ allowDirs: [tmpDir], allowCommands: [] }, "write_file", { path: filePath, content: "hello" });
    expect(writeResult).toEqual({ written: true });

    const readResult = await handleRequest({ allowDirs: [tmpDir], allowCommands: [] }, "read_file", { path: filePath });
    expect(readResult).toBe("hello");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("handleRequest runs an allowed exec command and captures stdout", async () => {
    const { handleRequest } = await import(modulePath);
    const result = await handleRequest({ allowDirs: [], allowCommands: ["echo naelao-local-agent-test"] }, "exec", { command: "echo naelao-local-agent-test" }) as { stdout: string };
    expect(result.stdout.trim()).toBe("naelao-local-agent-test");
  });
});
