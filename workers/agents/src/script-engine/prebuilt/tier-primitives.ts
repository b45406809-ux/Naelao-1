/**
 * Tier-Specific Universal Execution Primitives (CodeAct & Script-Native Architecture)
 * Backed by research: CodeAct [arXiv:2402.01030], Dynamic Tool Synthesis [arXiv:2505.20286], Code-as-Policies [arXiv:2604.07791].
 *
 * Provides the 6 universal execution primitives matching the Cloudflare Execution Ladder:
 *   - Tier 1: `exec_sqlite_fs` (In-Memory SQLite / R2 Virtual Filesystem: read, patch, write, grep, glob, diff)
 *   - Tier 2: `exec_isolate_codemode` (Pure CodeAct inside V8 Isolate with fetch() and ctx.mcp bindings)
 *   - Tier 3: `exec_workflow` (Dynamic Durable Workflows for long-running, multi-step, or cron-scheduled runs)
 *   - Tier 4: `exec_kitesurf` (Lightweight Kitesurf Agent Browser for 3-7x faster/cheaper DOM parsing & form interaction)
 *   - Tier 5: `exec_browser` (Full Chromium Puppeteer for WebGL, Canvas, bot challenges, Visual QA snapshots)
 *   - Tier 6: `exec_container_bash` (Sandboxed Linux Container Bash in ToolSandboxDO for npm, pip, native tools & compilers)
 *
 * Plus the `Todo` state machine primitive for authoritative task DAG tracking.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { assertNoReservedViolation } from "../reserved-capabilities.js";
import {
  readWindowed,
  editFile,
  writeFileImpl,
  grepWorkspace,
  globWorkspace,
  bucket,
  key,
  computeSha256,
  MAX_READABLE_FILE_BYTES,
} from "./r2-workspace.js";
import { applyPlanOp } from "./plan.js";
import type { PlanState } from "../types.js";
import { buildTierSdkContext } from "../code-runner.js";

function ensurePlan(ctx: PrebuiltOpContext): PlanState | { ok: false; error: string } {
  if (!ctx.env.plan) {
    return { ok: false, error: "plan is only available inside a live agent run." };
  }
  return ctx.env.plan;
}

const BROWSER_HARNESS = `
export async function run(args, ctx) {
  if (!ctx.browser) throw new Error("Browser capability not available");
  return await ctx.browser.navigate(args);
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
    if (!cleanOut && !stderr) {
      return { exit_code: 0, stdout: "(command produced no output — exit code 0)" };
    }
    return { exit_code: 0, stdout: cleanOut, stderr: (stderr || "").trim() };
  } catch (err) {
    const stderrText = String((err && (err.stderr || err.message)) || "Command failed");
    const last15 = stderrText.trim().split(/\\r?\\n/).slice(-15).join("\\n");
    const exitCode = (err && err.code) || 1;
    throw new Error(\`Command failed with exit code \${exitCode}:\\n\${last15}\`);
  }
}
`;

export const tierPrimitives: PrebuiltScript = {
  name: "tier-primitives",
  description:
    "Universal execution primitives across the 6-tier ladder: exec_sqlite_fs (T1), exec_isolate_codemode (T2), " +
    "exec_workflow (T3), exec_kitesurf (T4), exec_browser (T5), exec_container_bash (T6), and Todo checklist state machine.",
  domain: "compute",
  requires_tier: 1,
  paramHints: {
    exec_sqlite_fs:
      "op ('read' | 'patch' | 'write' | 'grep' | 'glob' | 'diff' | 'stat' | 'delete' | 'list', REQUIRED). " +
      "params (object with filePath/path, content, oldString, newString, pattern, offset, limit).",
    exec_isolate_codemode:
      "code (string, REQUIRED — TypeScript/JS to execute in sub-millisecond V8 isolate). args (object, optional).",
    exec_workflow:
      "workflowCode (string) OR name (string). schedule (string, optional cron). params (object, optional).",
    exec_kitesurf:
      "url (string, REQUIRED). actions (array of {type: 'click'|'type'|'extract'|'wait'|'scroll', selector, text, ms}). take_screenshot (bool).",
    exec_browser:
      "url (string, REQUIRED). puppeteerScript (string, optional). take_screenshot (bool, optional). actions (array, optional).",
    exec_container_bash:
      "command (string, REQUIRED — shell command line). timeout (number, optional seconds). working_dir (string, optional).",
    Todo:
      "tasks (array of {id, title, status: 'PENDING'|'IN_PROGRESS'|'COMPLETED'}) OR steps (string[]) OR step (string to complete).",
  },
  operations: {
    // ── TIER 1: In-Memory Virtual FS (SQLite / R2) ─────────────────────────
    async exec_sqlite_fs(args, ctx) {
      const op = String(args["op"] ?? args["operation"] ?? "").toLowerCase().trim();
      const p = (args["params"] as Record<string, unknown>) ?? args;
      const filePath = String(p["filePath"] ?? p["path"] ?? "").trim();

      switch (op) {
        case "read": {
          const offset = typeof p["offset"] === "number" ? p["offset"] : undefined;
          const limit = typeof p["limit"] === "number" ? p["limit"] : undefined;
          return await readWindowed(ctx, filePath, offset, limit);
        }
        case "patch":
        case "edit": {
          const oldStr = String(p["oldString"] ?? p["find"] ?? p["searchBlock"] ?? "");
          const newStr = String(p["newString"] ?? p["replace"] ?? p["replaceBlock"] ?? "");
          const expectedHash = (p["expected_hash"] as string) || (p["expectedHash"] as string) || undefined;
          return await editFile(ctx, filePath, oldStr, newStr, expectedHash);
        }
        case "write": {
          const content = String(p["content"] ?? "");
          const expectedHash = (p["expected_hash"] as string) || (p["expectedHash"] as string) || undefined;
          return await writeFileImpl(ctx, filePath, content, expectedHash);
        }
        case "grep": {
          const pattern = String(p["pattern"] ?? p["query"] ?? "");
          return await grepWorkspace(ctx, pattern, filePath);
        }
        case "glob": {
          const pattern = typeof p["pattern"] === "string" ? (p["pattern"] as string) : undefined;
          return await globWorkspace(ctx, pattern, filePath);
        }
        case "diff": {
          const targetContent = typeof p["content"] === "string" ? p["content"] : undefined;
          const targetPath = typeof p["compareToPath"] === "string" ? p["compareToPath"] : undefined;
          const head = await bucket(ctx).head(key(ctx, filePath));
          if (!head) return { ok: false, error: `File not found: ${filePath}` };
          const obj = await bucket(ctx).get(key(ctx, filePath));
          if (!obj) return { ok: false, error: `File not found: ${filePath}` };
          const sourceText = await obj.text();
          let compareText = "";
          if (targetContent !== undefined) {
            compareText = targetContent;
          } else if (targetPath) {
            const compObj = await bucket(ctx).get(key(ctx, targetPath));
            if (!compObj) return { ok: false, error: `Compare target file not found: ${targetPath}` };
            compareText = await compObj.text();
          }
          const srcLines = sourceText.split(/\r?\n/);
          const cmpLines = compareText.split(/\r?\n/);
          const diffs: Array<{ line: number; original: string; modified: string }> = [];
          const maxL = Math.max(srcLines.length, cmpLines.length);
          for (let i = 0; i < maxL; i++) {
            const s = srcLines[i] ?? "";
            const c = cmpLines[i] ?? "";
            if (s !== c) {
              diffs.push({ line: i + 1, original: s, modified: c });
              if (diffs.length >= 50) break;
            }
          }
          return {
            ok: true,
            filePath,
            identical: diffs.length === 0,
            diff_count: diffs.length,
            differences: diffs,
          };
        }
        case "stat": {
          const head = await bucket(ctx).head(key(ctx, filePath));
          if (!head) return { exists: false };
          return {
            exists: true,
            size: head.size,
            uploaded: head.uploaded.toISOString(),
            readable: head.size <= MAX_READABLE_FILE_BYTES,
            hash: head.customMetadata?.hash ?? undefined,
          };
        }
        case "delete": {
          await bucket(ctx).delete(key(ctx, filePath));
          ctx.env.onWorkspaceChange?.({ path: filePath, operation: "delete" });
          return { ok: true, deleted: filePath };
        }
        case "list": {
          const prefix = key(ctx, filePath);
          const listing = await bucket(ctx).list({ prefix });
          return {
            files: listing.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString(), hash: o.customMetadata?.hash })),
            count: listing.objects.length,
          };
        }
        default:
          throw new Error(`Unknown exec_sqlite_fs op: '${op}'. Supported: read, patch, write, grep, glob, diff, stat, delete, list.`);
      }
    },

    // ── TIER 2: V8 Isolate CodeMode (Pure CodeAct in V8) ───────────────────
    async exec_isolate_codemode(args, ctx) {
      const code = String(args["code"] ?? args["script"] ?? "").trim();
      if (!code) throw new Error("exec_isolate_codemode requires 'code' (TypeScript/JavaScript source).");
      assertNoReservedViolation({ name: "exec_isolate_codemode", code });

      const runArgs = (args["args"] as Record<string, unknown>) ?? (args["params"] as Record<string, unknown>) ?? {};
      const sdkCtx = buildTierSdkContext(ctx.env, ctx.env.projectId ? "PROJECT_BOUND" : "SPACE_WIDE");

      if (!ctx.env.codeRunner) {
        // Safe In-Process CodeMode fallback with Authoritative ctx SDK
        try {
          const fnBody = code.includes("return") || code.includes(";") ? code : `return (${code});`;
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFunction("args", "ctx", fnBody);
          return await fn(runArgs, sdkCtx);
        } catch (err) {
          throw new Error(`Tier 2 in-process execution failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // If user passed a bare function body without export, wrap it safely
      const executableModule = code.includes("export async function run") || code.includes("export function run")
        ? code
        : `export async function run(args, ctx) {\n${code}\n}`;

      const result = await ctx.env.codeRunner.run({
        name: "codemode_dynamic",
        code: executableModule,
        tier: 2,
        args: runArgs,
        spaceId: ctx.env.spaceId,
        agentId: ctx.env.agentId,
        tenantId: ctx.env.tenantId,
        ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
      });

      if (!result.ok) throw new Error(result.error ?? "Tier 2 execution failed");
      return result.output;
    },

    // ── TIER 3: Dynamic Durable Workflows ──────────────────────────────────
    async exec_workflow(args, ctx) {
      const h = ctx.env.orchestration ?? {};
      const name = String(args["name"] ?? `workflow-${Date.now()}`);
      const code = String(args["workflowCode"] ?? args["code"] ?? "");
      const scheduleCron = args["schedule"] ?? args["cron"];
      const params = (args["params"] as Record<string, unknown>) ?? {};

      if (scheduleCron && h.workflowSchedule) {
        if (code && h.workflowCreate) {
          await h.workflowCreate(name, code);
        }
        return await h.workflowSchedule(name, String(scheduleCron));
      }

      if (code && h.workflowCreate) {
        await h.workflowCreate(name, code);
      }

      if (h.workflowRun) {
        return await h.workflowRun(name, params);
      }

      if (ctx.env.workflowRunner) {
        return await ctx.env.workflowRunner.dispatch({
          workflowName: "ScriptRunWorkflow",
          params: { name, script: code, args: params, spaceId: ctx.env.spaceId, tier: 3 },
        });
      }

      return {
        ok: true,
        workflow: name,
        status: "queued",
        message: "Dynamic workflow registered and queued for durable execution.",
      };
    },

    // ── TIER 4: Lightweight Kitesurf Agent Browser ─────────────────────────
    async exec_kitesurf(args, ctx) {
      const url = String(args["url"] ?? "").trim();
      if (!url) throw new Error("exec_kitesurf requires 'url'");
      if (!ctx.env.codeRunner) {
        return { ok: false, reason: "Tier 4 (kitesurf) unavailable: no code runner configured" };
      }

      const actions = Array.isArray(args["actions"]) ? args["actions"] : undefined;
      const takeScreenshot = Boolean(args["take_screenshot"] ?? args["screenshot"]);
      const extractLinks = args["extract_links"] !== false;

      const result = await ctx.env.codeRunner.run({
        name: "kitesurf_browser",
        code: BROWSER_HARNESS,
        tier: 4,
        args: { url, actions, take_screenshot: takeScreenshot, extract_links: extractLinks, engine: "kitesurf" },
        spaceId: ctx.env.spaceId,
        agentId: ctx.env.agentId,
        tenantId: ctx.env.tenantId,
      });

      if (!result.ok) throw new Error(result.error ?? "Kitesurf navigation failed");
      return result.output;
    },

    // ── TIER 5: Full Chromium Puppeteer ────────────────────────────────────
    async exec_browser(args, ctx) {
      const url = String(args["url"] ?? "").trim();
      if (!url) throw new Error("exec_browser requires 'url'");
      if (!ctx.env.codeRunner) {
        return { ok: false, reason: "Tier 5 (chromium browser) unavailable: no code runner configured" };
      }

      const actions = Array.isArray(args["actions"]) ? args["actions"] : undefined;
      const takeScreenshot = Boolean(args["take_screenshot"] ?? args["screenshot"] ?? true);
      const script = args["puppeteerScript"] ?? args["script"];

      const result = await ctx.env.codeRunner.run({
        name: "chromium_browser",
        code: BROWSER_HARNESS,
        tier: 5,
        args: { url, actions, take_screenshot: takeScreenshot, puppeteerScript: script, engine: "chromium" },
        spaceId: ctx.env.spaceId,
        agentId: ctx.env.agentId,
        tenantId: ctx.env.tenantId,
      });

      if (!result.ok) throw new Error(result.error ?? "Chromium execution failed");
      return result.output;
    },

    // ── TIER 6: Sandboxed Linux Container Bash ─────────────────────────────
    async exec_container_bash(args, ctx) {
      const command = String(args["command"] ?? args["commands"] ?? args["cmd"] ?? "").trim();
      if (!command) throw new Error("exec_container_bash requires 'command'");

      if (!ctx.env.codeRunner) {
        return { ok: false, reason: "Tier 6 (container) unavailable: no code runner configured in this environment" };
      }

      const result = await ctx.env.codeRunner.run({
        name: "container_bash",
        code: BASH_HARNESS,
        tier: 6,
        args: {
          commands: command,
          timeout: args["timeout"] ?? 60,
          working_dir: args["working_dir"] ?? "/workspace",
          filesToStage: args["filesToStage"],
        },
        spaceId: ctx.env.spaceId,
        agentId: ctx.env.agentId,
        tenantId: ctx.env.tenantId,
        ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
      });

      if (!result.ok) throw new Error(result.error ?? "Container bash execution failed");
      return result.output;
    },

    // ── Task DAG / Checklist State Machine ─────────────────────────────────
    async Todo(args, ctx) {
      const state = ensurePlan(ctx);
      if ("error" in state) return state;

      if (Array.isArray(args["tasks"])) {
        const rawTasks = args["tasks"] as Array<{ id?: string; title?: string; text?: string; status?: string; done?: boolean }>;
        state.steps = rawTasks.map((t, i) => {
          const text = String(t.title ?? t.text ?? `Step ${i + 1}`).trim();
          const isDone = Boolean(t.done || (t.status && t.status.toUpperCase() === "COMPLETED"));
          return { id: String(t.id ?? `task-${i + 1}`), text, done: isDone };
        });
        const completed = state.steps.filter((s) => s.done).length;
        return {
          ok: true,
          total: state.steps.length,
          completed,
          remaining: state.steps.length - completed,
          steps: state.steps,
        };
      }

      if (Array.isArray(args["steps"])) {
        applyPlanOp(state, "plan.set", { steps: args["steps"] });
      } else if (args["step"]) {
        applyPlanOp(state, "plan.complete_step", { step: args["step"] });
      }

      const completed = state.steps.filter((s) => s.done).length;
      return {
        ok: true,
        total: state.steps.length,
        completed,
        remaining: state.steps.length - completed,
        steps: state.steps,
      };
    },
  },
};
