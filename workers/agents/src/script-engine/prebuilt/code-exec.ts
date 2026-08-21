/**
 * code-exec (spec "Platform Skills" §code-exec, byte ~676541) — execute code in Python,
 * Bash, or TypeScript. Operations: code.execute_python, code.execute_bash, code.run_js — plus
 * `Bash`, an alias for code.execute_bash matching the Claude-Code-shaped REPL primitive naming
 * r2-workspace.ts's Read/Edit/Write/Grep/Glob use (resolved via tool-surface.ts's
 * RENAMED_OPERATIONS, "bash"/"execute_bash" -> "Bash").
 *
 * Per the spec's own routing rule ("DO NOT use execute_python for simple JS calculations"):
 *   - run_js     → Tier 2 isolate (codemode) — fast, no container, no file I/O.
 *   - execute_python / execute_bash → Tier 5 container (SandboxDO) — real OS, files, pip/apt.
 *
 * The Tier-5 harnesses below are platform-authored (not agent-authored), so they carry the
 * same trust level as every other prebuilt op; the agent only ever supplies `args`, never code
 * that runs outside this fixed wrapper.
 *
 * BASH_HARNESS's failure path deliberately still THROWS (never returns a normal
 * `{exit_code, ...}` object on a non-zero exit) — runTier()'s outer wrapper below treats a
 * non-throwing harness result as `ok:true`, and this op's caller (ScriptToolSurface.run, the
 * loop's repeat-guard, the action ledger, distill-a-fix-for-a-failure guidance) all depend on a
 * genuinely failed command coming back as `ok:false`. What changed from the plain `execSync`
 * version: async `exec` (a blocking `execSync` call inside a long-lived, potentially warm
 * container harness process is a real concurrency hazard for any OTHER request that process is
 * serving concurrently — see NaelaoAgentDO/Phase-K's own note on this), stdout squashed to a
 * short confirmation on a genuinely-silent success (nothing for the model to parse), and a
 * failure's stderr trimmed to its last 15 lines (Node's raw exec error can otherwise be enormous).
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
  // §A1.17 Phase K: run with cwd = the project's synced /workspace (ctx.workspaceDir) so a
  // Python script's relative file I/O reads/writes the same persistent, project-shared
  // filesystem BASH_HARNESS below already assumed — matches its existing cwd convention.
  const stdout = execFileSync("python3", [file], { timeout: timeoutMs, encoding: "utf8", cwd: (ctx && ctx.workspaceDir) || "/workspace" });
  return { stdout };
}
`;

const BASH_HARNESS = `
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);

export async function run(args, ctx) {
  const commands = args.commands || args.command || args.cmd;
  if (!commands || typeof commands !== "string") throw new Error("commands is required");
  const timeoutMs = (Number(args.timeout) || 30) * 1000;
  const cwd = args.working_dir || (ctx && ctx.workspaceDir) || "/workspace";

  try {
    const { stdout, stderr } = await execAsync(commands, {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      shell: "/bin/bash",
      maxBuffer: 4 * 1024 * 1024,
    });
    const cleanOut = (stdout || "").trim();
    // A genuinely silent success (no stdout, no stderr) — give the model something to read
    // rather than an empty string that reads as "did this even run?".
    if (!cleanOut && !stderr) {
      return { exit_code: 0, stdout: "(command produced no output — exit code 0)" };
    }
    return { exit_code: 0, stdout: cleanOut, stderr: (stderr || "").trim() };
  } catch (err) {
    // Deliberately still THROWS (never returns normally) — see this file's own header on why a
    // failed command must resolve to ok:false at the ScriptToolSurface level, not a normally-
    // returned "failure-shaped" object the outer wrapper would read as a success.
    const stderrText = String((err && (err.stderr || err.message)) || "Command failed");
    const last15 = stderrText.trim().split(/\\r?\\n/).slice(-15).join("\\n");
    const exitCode = (err && err.code) || 1;
    throw new Error(\`Command failed with exit code \${exitCode}:\\n\${last15}\`);
  }
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
    tenantId: ctx.env.tenantId,
    ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
  });
  if (!result.ok) throw new Error(result.error ?? `${name} failed`);
  return result.output;
}

export const codeExec: PrebuiltScript = {
  name: "code-exec",
  description: "Execute Python or Bash in a real sandbox container, or fast JS in a V8 isolate.",
  domain: "container",
  requires_tier: 5,
  paramHints: {
    "code.execute_bash": "commands (string, REQUIRED — a bash command line). timeout (number, " +
      "optional seconds, default 30). working_dir (string, optional, default the synced project " +
      "workspace).",
    "Bash": "Same as code.execute_bash — commands (string, REQUIRED). timeout (number, optional " +
      "seconds). working_dir (string, optional).",
    "code.execute_python": "code (string, REQUIRED — a Python script body). timeout (number, " +
      "optional seconds, default 30). install_deps (string[], optional — pip packages to install " +
      "first).",
    "code.run_js": "code (string, REQUIRED — a `run(args, ctx)` module body, no file I/O). args " +
      "(object, optional — passed through to the module's own args param).",
  },
  operations: {
    "code.execute_python": (a, c) => runTier(c, "code-exec.execute_python", PYTHON_HARNESS, 5, a),
    "code.execute_bash": (a, c) => runTier(c, "code-exec.execute_bash", BASH_HARNESS, 5, a),
    // Same op as code.execute_bash — see RENAMED_OPERATIONS in tool-surface.ts ("bash"/
    // "execute_bash" -> "Bash") and this file's own header.
    "Bash": (a, c) => runTier(c, "code-exec.execute_bash", BASH_HARNESS, 5, a),
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
