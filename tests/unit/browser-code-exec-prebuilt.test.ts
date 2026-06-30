import { describe, it, expect, vi } from "vitest";
import { browserUse } from "../../workers/agents/src/script-engine/prebuilt/browser-use.js";
import { codeExec } from "../../workers/agents/src/script-engine/prebuilt/code-exec.js";
import type { ScriptEngineEnv, TieredCodeRunner } from "../../workers/agents/src/script-engine/types.js";

function ctxWith(codeRunner?: TieredCodeRunner) {
  const env = { spaceId: "space1", agentId: "agent1", tenantId: "tenant1", scriptsBucket: {} as R2Bucket, ...(codeRunner ? { codeRunner } : {}) } as ScriptEngineEnv;
  return { env, run: vi.fn() };
}

describe("browser-use prebuilt — Tier 4 routing", () => {
  it("browser.navigate calls codeRunner at tier 4 and returns its output", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, output: { text: "hi" }, tier: 4, duration_ms: 1, tokens_used: 0 });
    const ctx = ctxWith({ run });
    const result = await browserUse.operations["browser.navigate"]!({ url: "https://example.com" }, ctx);
    expect(result).toEqual({ text: "hi" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tier: 4, args: { url: "https://example.com" } }));
  });

  it("throws when the navigation result is not ok", async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, error: "blocked", tier: 4, duration_ms: 1, tokens_used: 0 });
    const ctx = ctxWith({ run });
    await expect(browserUse.operations["browser.navigate"]!({ url: "https://example.com" }, ctx)).rejects.toThrow("blocked");
  });

  it("degrades honestly with no codeRunner configured", async () => {
    const ctx = ctxWith(undefined);
    const result = await browserUse.operations["browser.navigate"]!({ url: "https://example.com" }, ctx);
    expect(result).toMatchObject({ ok: false });
  });
});

describe("code-exec prebuilt — Tier 5 (python/bash) and Tier 2 (run_js) routing", () => {
  it("execute_python routes to tier 5 with the python harness", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, output: { stdout: "42\n" }, tier: 5, duration_ms: 1, tokens_used: 0 });
    const ctx = ctxWith({ run });
    const result = await codeExec.operations["code.execute_python"]!({ code: "print(42)" }, ctx);
    expect(result).toEqual({ stdout: "42\n" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tier: 5, name: "code-exec.execute_python" }));
  });

  it("execute_bash routes to tier 5 with the bash harness", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, output: { stdout: "hi\n" }, tier: 5, duration_ms: 1, tokens_used: 0 });
    const ctx = ctxWith({ run });
    await codeExec.operations["code.execute_bash"]!({ commands: "echo hi" }, ctx);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tier: 5, name: "code-exec.execute_bash" }));
  });

  it("run_js routes to tier 2 using the agent-supplied code directly", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, output: 4, tier: 2, duration_ms: 1, tokens_used: 0 });
    const ctx = ctxWith({ run });
    const userCode = "export async function run(args){ return args.a + args.b; }";
    await codeExec.operations["code.run_js"]!({ code: userCode, args: { a: 2, b: 2 } }, ctx);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tier: 2, code: userCode, args: { a: 2, b: 2 } }));
  });

  it("run_js rejects ad hoc code that contacts a reserved payment processor (guard parity with script.create)", async () => {
    const run = vi.fn();
    const ctx = ctxWith({ run });
    const maliciousCode = `export async function run(){ return fetch("https://api.stripe.com/v1/charges"); }`;
    await expect(codeExec.operations["code.run_js"]!({ code: maliciousCode }, ctx)).rejects.toThrow(/[Rr]eserved/);
    expect(run).not.toHaveBeenCalled();
  });

  it("degrades honestly with no codeRunner configured", async () => {
    const ctx = ctxWith(undefined);
    const result = await codeExec.operations["code.execute_python"]!({ code: "print(1)" }, ctx);
    expect(result).toMatchObject({ ok: false });
  });
});
