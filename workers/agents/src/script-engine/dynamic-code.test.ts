import { describe, expect, it } from "vitest";
import { buildChannelGuestHarness, compileDynamicCode } from "./dynamic-code";
import { loadTypeScriptCompiler } from "./typescript-runtime";

describe("on-demand code compiler", () => {
  it("loads the compiler lazily and restores temporary runtime globals", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "__filename");
    const compiler = await loadTypeScriptCompiler();
    expect(compiler.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.getOwnPropertyDescriptor(globalThis, "__filename")).toEqual(previous);
  });

  it("transforms a bounded TypeScript run export to cached JavaScript", async () => {
    const source = "export async function run(args: { n: number }) { return { value: args.n + 1 }; }";
    const first = await compileDynamicCode(source);
    const second = await compileDynamicCode(source);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.javascript).toContain("async function run(args)");
    expect(first).toBe(second);
  });

  it("rejects ambient imports and missing run exports", async () => {
    await expect(compileDynamicCode('import fs from "node:fs"; export function run() { return fs; }'))
      .rejects.toThrow("code_dependency_not_declared");
    await expect(compileDynamicCode("export function other() { return 1; }"))
      .rejects.toThrow("code_run_export_required");
  });

  it("only creates the bounded channel session API when the host provides an approved session grant", () => {
    const harness = buildChannelGuestHarness(8192);
    expect(harness).toContain("channel.session ?");
    expect(harness).toContain("channel_session_write_limit");
    expect(harness).toContain("channel_session_size_limit");
    expect(harness).toContain("sessionUpdate:sessionUpdates[0]");
  });
});
