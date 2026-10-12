import { describe, expect, it, vi } from "vitest";
import { spawn, fork } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASH_HARNESS } from "./prebuilt/code-exec.js";
import { buildCodeRunner } from "./code-runner.js";

describe("intermediate terminal output", () => {
  it("the real child harness preserves a thrown diagnostic beyond 2000 characters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "naelao-error-test-"));
    try {
      const path = join(dir, "fixture.mjs"), diagnostic = "diagnostic\n".repeat(3000) + "LAST DIAGNOSTIC";
      await writeFile(path, `export async function run() { throw new Error(${JSON.stringify(diagnostic)}); }`);
      const child = fork(new URL("../../container/child-runner.mjs", import.meta.url), [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const message = new Promise<{ ok: boolean; error: string }>((resolve, reject) => { child.once("message", value => resolve(value as { ok: boolean; error: string })); child.once("error", reject); });
      const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); });
      child.send({ modulePath: path, mode: "run", args: {} });
      const result = await message; await closed;
      expect(result.ok).toBe(false); expect(result.error).toContain(diagnostic);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("preserves long native failure diagnostics for private offload", async () => {
    const logs = "diagnostic\n".repeat(3000) + "LAST DIAGNOSTIC";
    const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ ok: false, error: "exit 7", logs }) }) } as unknown as DurableObjectNamespace;
    const result = await buildCodeRunner({ toolSandbox: namespace, platformSecret: "test-secret", authorizeContainer: async () => true }).run({
      name: "code-exec.execute_bash", code: BASH_HARNESS, args: { commands: "test" }, tier: 6,
      tenantId: "tenant", spaceId: "space", projectId: "project", userId: "user", agentId: "worker", runId: "run",
    });
    expect(result.ok).toBe(false); expect(result.error).toContain("LAST DIAGNOSTIC"); expect(result.error).toContain(logs);
  });
  it("publishes scoped output before the execution resolves and stops polling afterward", async () => {
    let finish!: (response: Response) => void, scope: string | null = null;
    const onOutput = vi.fn(), requests: Request[] = [];
    const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      requests.push(request);
      if (new URL(request.url).pathname === "/output") {
        expect(request.headers.get("x-naelao-container-scope")).toBe(scope);
        expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
        return Response.json({ stdout: "first\n", stderr: "" });
      }
      scope = request.headers.get("x-naelao-container-scope");
      return new Promise<Response>(resolve => { finish = resolve; });
    } }) } as unknown as DurableObjectNamespace;
    const running = buildCodeRunner({ toolSandbox: namespace, platformSecret: "test-secret", authorizeContainer: async () => true }).run({
      name: "code-exec.execute_bash", code: BASH_HARNESS, args: { commands: "test" }, tier: 6,
      tenantId: "tenant", spaceId: "space", projectId: "project", userId: "user", agentId: "worker", runId: "run", onOutput,
    });
    await vi.waitFor(() => expect(onOutput).toHaveBeenCalledWith({ stdout: "first\n", stderr: "" }), { timeout: 1500 });
    finish(Response.json({ ok: true, result: { stdout: "first\nsecond\n", exit_code: 0 } }));
    expect((await running).ok).toBe(true);
    expect(requests.filter(request => new URL(request.url).pathname === "/exec")).toHaveLength(1);
  });
  it("the real Bash harness emits stdout while running and preserves a failing exit", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const chunks=[];for await(const chunk of process.stdin) chunks.push(chunk);
      const {code,command}=JSON.parse(Buffer.concat(chunks).toString());
      const module=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
      try {const result=await module.run({commands:command}, {workspaceDir:process.cwd()});console.log('RESULT:'+JSON.stringify(result));}
      catch(error) {console.log('FAILURE:'+error.message);}
    `], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(JSON.stringify({ code: BASH_HARNESS, command: "printf first; sleep 0.1; printf second; printf diagnostic >&2; exit 7" }));
    let output = "", errors = "", early = false;
    child.stdout.on("data", chunk => { output += chunk; if (output.includes("first") && !output.includes("second")) early = true; });
    child.stderr.on("data", chunk => { errors += chunk; });
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    expect(early).toBe(true); expect(errors).toContain("diagnostic");
    expect(output).toContain("FAILURE:Command failed with exit code 7");
    expect(output).toContain("firstsecond");
  });
});
