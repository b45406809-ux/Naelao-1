/**
 * code-exec (spec "Platform Skills" §code-exec, byte ~676541) — execute code in Python,
 * Bash, or TypeScript. Operations: code.execute_python, code.execute_bash, code.run_js.
 *
 * Per the spec's own routing rule ("DO NOT use execute_python for simple JS calculations"):
 *   - run_js     → Tier 2 isolate (codemode) — fast, no container, no file I/O.
 *   - execute_python / execute_bash → Tier 5 container (SandboxDO) — real OS, files, pip/apt.
 *
 * The Tier-5 harnesses below are platform-authored (not agent-authored), so they carry the
 * same trust level as every other prebuilt op; the agent only ever supplies `args`, never code
 * that runs outside this fixed wrapper.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import type { ExecutionTier } from "../types.js";
import { assertNoReservedViolation } from "../reserved-capabilities.js";

const PYTHON_HARNESS = `
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function run(args, ctx) {
  const code = args.code;
  if (!code || typeof code !== "string") throw new Error("code is required");
  const timeoutMs = (Number(args.timeout) || 30) * 1000;
  const deps = Array.isArray(args.install_deps) ? args.install_deps.map(String) : [];
  if (deps.length > 0) {
    execFileSync("pip3", ["install", "--quiet", ...deps], { timeout: timeoutMs, encoding: "utf8" });
  }
  const dir = mkdtempSync(join(tmpdir(), "py-"));
  const file = join(dir, "script.py");
  writeFileSync(file, code, "utf8");
  const stdout = execFileSync("python3", [file], { timeout: timeoutMs, encoding: "utf8" });
  return { stdout };
}
`;

const BASH_HARNESS = `
import { execSync } from "node:child_process";

export async function run(args, ctx) {
  const commands = args.commands;
  if (!commands || typeof commands !== "string") throw new Error("commands is required");
  const timeoutMs = (Number(args.timeout) || 30) * 1000;
  const stdout = execSync(commands, {
    cwd: args.working_dir || "/workspace",
    timeout: timeoutMs,
    encoding: "utf8",
    shell: "/bin/bash",
  });
  return { stdout };
}
`;

async function runTier(
  ctx: PrebuiltOpContext,
  name: string,
  harness: string,
  tier: ExecutionTier,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!ctx.env.codeRunner) {
    return { ok: false, reason: `Tier ${tier} unavailable: no code runner configured in this environment` };
  }
  const result = await ctx.env.codeRunner.run({
    name,
    code: harness,
    tier,
    args,
    spaceId: ctx.env.spaceId,
    agentId: ctx.env.agentId,
  });
  if (!result.ok) throw new Error(result.error ?? `${name} failed`);
  return result.output;
}

export const codeExec: PrebuiltScript = {
  name: "code-exec",
  description: "Execute Python or Bash in a real sandbox container, or fast JS in a V8 isolate.",
  domain: "container",
  requires_tier: 5,
  operations: {
    "code.execute_python": (a, c) => runTier(c, "code-exec.execute_python", PYTHON_HARNESS, 5, a),
    "code.execute_bash": (a, c) => runTier(c, "code-exec.execute_bash", BASH_HARNESS, 5, a),
    // codemode (spec): JS/TS with no file I/O runs at Tier 2 — the agent supplies its own
    // `run(args, ctx)` module body directly (no fixed harness; this *is* the Tier-2 contract).
    // Same reserved-capability gate as script.create/update applies here too — ad hoc code
    // bypasses the library, so it must not bypass the money-in guard as well.
    async "code.run_js"(a, c) {
      const adHocCode = String(a["code"] ?? "");
      assertNoReservedViolation({ name: "code-exec.run_js", code: adHocCode });
      return runTier(c, "code-exec.run_js", adHocCode, 2, (a["args"] as Record<string, unknown>) ?? {});
    },
  },
};
