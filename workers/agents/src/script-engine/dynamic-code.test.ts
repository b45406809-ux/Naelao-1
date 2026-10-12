import { describe, expect, it } from "vitest";
import { compileDynamicCode } from "./dynamic-code";

describe("on-demand code compiler", () => {
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
});
