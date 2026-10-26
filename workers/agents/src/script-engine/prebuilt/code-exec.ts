/**
 * code-exec (spec "Platform Skills" §code-exec, byte ~676541) — execute code in Python,
 * Bash, or TypeScript. Operations: code.execute_python, code.execute_bash, code.run_js — plus
 * `Bash`, an alias for code.execute_bash matching the Claude-Code-shaped REPL primitive naming
 * r2-workspace.ts's Read/Edit/Write/Grep/Glob use (resolved via tool-surface.ts's
 * RENAMED_OPERATIONS, "bash"/"execute_bash" -> "Bash").
 *
 *   - run_js         → Tier 2 isolate — no ambient file or network access.
 *   - execute_python → Tier 2 provider Python/Wasm — bounded pure computation.
 *   - execute_bash   → virtual commands first, then authorized Tier 6 native execution.
 * Python dependencies/OS work require explicit authorized native execution; an unavailable
 * lightweight runtime never silently allocates a container.
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
import { machinePrefix, workspacePrefix, type ExecutionTier } from "../types.js";
import { assertNoReservedViolation } from "../reserved-capabilities.js";
import { canRunVirtually, executeVirtualPosix } from "../virtual-posix.js";
import { parseCliWords, interceptPlatformWords } from "../virtual-cli.js";
import { parseShell } from "../shell-parser.js";
import { virtualFsList, virtualFsWrite, virtualFsDelete } from "../r2-workspace.js";
import { readBytesWithHash, sha256Text } from "../r2-cas.js";
import { VirtualCliDispatcher } from "../virtual-cli.js";
import { createVaultProxy } from "../vault-proxy.js";
import { inspectMutation } from "@naelao/security";
import { isDeclaredNativeCommand } from "../execution-ladder.js";
import { assertWorkspaceFileAllowed } from "../workspace-paths.js";
import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { MarkdownFetchResult } from "../virtual-cli.js";

/** Validate and bound the internal Knowledge worker response before exposing it to the CLI. */
export async function readMarkdownFetchResponse(response: Response, fallbackUrl: string): Promise<MarkdownFetchResult> {
  const payload = await readBoundedResponseJson<Record<string, unknown>>(response, 1024 * 1024);
  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message.slice(0, 300) : "request rejected";
    throw new Error(`fetch-md request failed (${response.status}): ${message}`);
  }
  if (typeof payload.url !== "string" || payload.url.length > 2_048
    || !Number.isInteger(payload.status) || Number(payload.status) < 100 || Number(payload.status) > 599
    || typeof payload.content !== "string"
    || new TextEncoder().encode(payload.content).byteLength > 100_000
    || payload.content_type !== undefined && (typeof payload.content_type !== "string" || payload.content_type.length > 512)
    || payload.format !== undefined && payload.format !== "markdown" && payload.format !== "source"
    || payload.truncated !== undefined && typeof payload.truncated !== "boolean") {
    throw new Error("fetch-md response shape is invalid");
  }
  return {
    url: payload.url || fallbackUrl,
    status: Number(payload.status),
    content: payload.content,
    ...(typeof payload.content_type === "string" ? { content_type: payload.content_type } : {}),
    ...(payload.format === "markdown" || payload.format === "source" ? { format: payload.format } : {}),
    ...(payload.truncated === true ? { truncated: true } : {}),
  };
}

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

const LSP_SOURCE = /\.(?:[cm]?[jt]sx?|py)$/i;
async function runLspCommand(argv: string[], ctx: PrebuiltOpContext): Promise<{ exit_code: number; stdout: string; stderr?: string }> {
  if (!ctx.env.projectId) throw new Error("lsp_requires_project_workspace");
  if (!ctx.env.agentsWorker || !ctx.env.platformSecret) throw new Error("lsp_project_daemon_unavailable");
  const [action, ...args] = argv;
  let tool: string, toolArgs: Record<string, unknown>;
  if (action === "index") {
    const listed = await virtualFsList(ctx.env);
    const selected = args.length ? args.map(path => {
      const normalized = assertWorkspaceFileAllowed(ctx.env.workspaceFileScope, path);
      const entry = listed.find(item => item.path === normalized);
      if (!entry) throw new Error(`lsp_file_not_found:${normalized}`);
      return entry;
    }) : listed.filter(item => LSP_SOURCE.test(item.path) && !/(?:^|\/)(?:node_modules|\.git|dist|build)(?:\/|$)/.test(item.path));
    const sourceFiles = selected.filter(item => LSP_SOURCE.test(item.path));
    if (args.length && sourceFiles.length !== selected.length) throw new Error("lsp_unsupported_source_path: index only TypeScript, JavaScript, or Python files");
    if (sourceFiles.length > 200) throw new Error("lsp_index_limit: choose explicit source paths (200 files maximum)");
    const sources: Array<{ path: string; content: string }> = [];
    let totalBytes = 0;
    for (const entry of sourceFiles) {
      const path = assertWorkspaceFileAllowed(ctx.env.workspaceFileScope, entry.path);
      if (entry.size > 512_000) {
        if (args.length) throw new Error(`lsp_file_too_large:${entry.path}:maximum 512KB`);
        continue;
      }
      const file = await readBytesWithHash(ctx.env.workspaceBucket ?? ctx.env.scriptsBucket, `${workspacePrefix(ctx.env)}${path}`);
      if (!file) continue;
      totalBytes += file.bytes.byteLength;
      if (totalBytes > 2_000_000) throw new Error("lsp_index_limit: select fewer files (2MB total per index request)");
      sources.push({ path, content: new TextDecoder().decode(file.bytes) });
    }
    tool = "index"; toolArgs = { files: sources, replace: args.length === 0 };
  } else if (action === "find-refs" && args.length === 1) { tool = "references"; toolArgs = { term: args[0] }; }
  else if (action === "find-symbol" && args.length === 1) { tool = "query"; toolArgs = { term: args[0] }; }
  else if (action === "get-signatures" && args.length === 1) { tool = "symbols"; toolArgs = { path: assertWorkspaceFileAllowed(ctx.env.workspaceFileScope, args[0]!) }; }
  else if (action === "status" && args.length === 0) { tool = "status"; toolArgs = {}; }
  else throw new Error("usage: lsp index [path ...] | find-refs <name> | find-symbol <name> | get-signatures <path> | status");

  const token = await mintInternalToken(ctx.env.platformSecret, ctx.env.tenantId);
  const path = `/spaces/${encodeURIComponent(ctx.env.spaceId)}/projects/${encodeURIComponent(ctx.env.projectId)}/daemons/tree-sitter/mcp`;
  const response = await ctx.env.agentsWorker.fetch(new Request(`http://agents-worker${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": ctx.env.tenantId, "x-naelao-internal-token": token },
    body: JSON.stringify({ jsonrpc: "2.0", id: "lsp", method: tool === "index" ? "tools/call" : "tools/call", params: { name: `daemon_tree-sitter_${tool}`, arguments: toolArgs } }),
  }));
  const payload = await response.json() as { error?: { message?: string }; result?: { structuredContent?: unknown; content?: Array<{ text?: string }> } };
  if (!response.ok || payload.error) throw new Error(`lsp_${tool}_failed:${payload.error?.message ?? response.status}`);
  const data = payload.result?.structuredContent ?? payload.result?.content?.[0]?.text ?? null;
  return { exit_code: 0, stdout: typeof data === "string" ? data : JSON.stringify(data, null, 2) };
}

export const BASH_HARNESS = `
import { exec } from "node:child_process";

export async function run(args, ctx) {
  const commands = args.commands || args.command || args.cmd;
  if (!commands || typeof commands !== "string") throw new Error("commands is required");
  const timeoutMs = (Number(args.timeout) || 30) * 1000;
  const cwd = args.working_dir || (ctx && ctx.workspaceDir) || "/workspace";

  try {
    const child = exec(commands, {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      shell: "/bin/bash",
      maxBuffer: 2 * 1024 * 1024,
    });
    child.stdout?.on("data", chunk => process.stdout.write(chunk));
    child.stderr?.on("data", chunk => process.stderr.write(chunk));
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      // Observe streams live and retain the complete bounded terminal result.
      let stdout = "", stderr = "";
      child.stdout?.on("data", chunk => { stdout += chunk; });
      child.stderr?.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error("Command failed"), { code, stdout, stderr })));
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
    const fullLog = String(err && err.stdout || "") + "\\n" + stderrText;
    const exitCode = (err && err.code) || 1;
    throw new Error(\`Command failed with exit code \${exitCode}:\\n\${fullLog}\`);
  }
}
`;

async function runTier(
  ctx: PrebuiltOpContext,
  name: string,
  harness: string,
  tier: ExecutionTier,
  args: Record<string, unknown>,
  sidecar?: import("../container-policy.js").InstalledContainer,
  capabilities?: string[]
): Promise<unknown> {
  if (ctx.env.workspaceFileScope !== undefined && (tier >= 5 || name === "code-exec.execute_python"))
    throw new Error("worker_file_scope_native_execution_unavailable");
  if (!ctx.env.codeRunner) {
    throw new Error(`Tier ${tier} unavailable: no code runner configured in this environment`);
  }
  const result = await ctx.env.codeRunner.run({
    name,
    code: harness,
    tier,
    args,
    spaceId: ctx.env.spaceId,
    agentId: ctx.env.agentId,
    tenantId: ctx.env.tenantId,
    ...(ctx.env.maxTier !== undefined ? { maxTier: ctx.env.maxTier } : {}),
    ...(ctx.env.workspaceBranch ? { workspaceBranch: ctx.env.workspaceBranch } : {}),
    ...(ctx.env.humanInvokerId ? { userId: ctx.env.humanInvokerId } : {}),
    ...(capabilities ? { capabilities } : Array.isArray(args["capabilities"]) ? { capabilities: args["capabilities"].filter((value): value is string => typeof value === "string") } : {}),
    ...(ctx.env.runId ? { runId: ctx.env.runId } : {}),
    ...(ctx.env.taskId ? { taskId: ctx.env.taskId } : {}),
    ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
    ...(ctx.env.onToolOutput ? { onOutput: ctx.env.onToolOutput } : {}),
    ...(ctx.env.executionSignal ? { signal: ctx.env.executionSignal } : {}),
    ...(name === "code-exec.execute_python" ? { language: "python" as const, limits: { wallMs: Number(args["timeout"] ?? 30) * 1000 } } : {}),
    ...(sidecar ? { containerImage: sidecar.contract.image, installationId: sidecar.installationId } : {}),
  });
  if (!result.ok) throw Object.assign(new Error(result.error ?? `${name} failed`), { capability_error: result.capability_error, runtime_receipt: result.runtime_receipt });
  return result.output && typeof result.output === "object" && !Array.isArray(result.output)
    ? { ...(result.output as Record<string, unknown>), actual_tier: result.actual_tier, engine: result.engine, runtime_receipt: result.runtime_receipt }
    : { result: result.output, actual_tier: result.actual_tier, engine: result.engine, runtime_receipt: result.runtime_receipt };
}

async function runBash(
  args: Record<string, unknown>,
  ctx: PrebuiltOpContext
): Promise<unknown> {
  const command = String(
    args["commands"] ?? args["command"] ?? args["cmd"] ?? ""
  ).trim();
  if (!command) throw new Error("commands is required");
  await inspectMutation(command, {
    kind: "shell",
    ...(ctx.env.mutationGrant ? { token: ctx.env.mutationGrant } : {}),
    secret: ctx.env.platformSecret ?? "",
    resourceId: ctx.env.projectId ?? ctx.env.spaceId,
  });
  const bucket = ctx.env.workspaceBucket ?? ctx.env.scriptsBucket;
  const prefix = workspacePrefix(ctx.env);
  const observed = new Map<string, string | null>();
  let actualTier: ExecutionTier = 1;
  if (canRunVirtually(command, (name) => ctx.commands?.has(name) ?? false)) {
    const cli = (ctx.env.credentialsWorker || ctx.env.knowledgeWorker) && ctx.env.platformSecret
      ? new VirtualCliDispatcher({
          ...(ctx.env.credentialsWorker ? { vault: createVaultProxy({ credentialsWorker: ctx.env.credentialsWorker, platformSecret: ctx.env.platformSecret, tenantId: ctx.env.tenantId, spaceId: ctx.env.spaceId, agentId: ctx.env.agentId, ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}), ...(ctx.env.userId ? { userId: ctx.env.userId } : {}), ...(ctx.env.runId ? { runId: ctx.env.runId } : {}), ...(ctx.env.taskId ? { taskId: ctx.env.taskId } : {}) }) } : {}),
          tenantId: ctx.env.tenantId,
          spaceId: ctx.env.spaceId,
          ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
          fetchMarkdown: async (url) => {
            if (!ctx.env.knowledgeWorker) throw new Error("fetch-md unavailable: knowledge worker is not configured");
            const token = await mintInternalToken(ctx.env.platformSecret!, ctx.env.tenantId);
            const response = await ctx.env.knowledgeWorker.fetch(new Request("http://knowledge-worker/internal/web-search/fetch", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-naelao-tenant-id": ctx.env.tenantId,
                "x-naelao-space-id": ctx.env.spaceId,
                "x-naelao-internal-token": token,
              },
              body: JSON.stringify({ url, format: "markdown" }),
            }));
            return readMarkdownFetchResponse(response, url);
          },
        })
      : undefined;
    const result = await executeVirtualPosix(command, {
      read: async (path) => {
        const scopedPath = assertWorkspaceFileAllowed(ctx.env.workspaceFileScope, path);
        const value = await readBytesWithHash(bucket, `${prefix}${scopedPath}`);
        observed.set(scopedPath, value?.hash ?? null);
        return value ? new TextDecoder().decode(value.bytes) : undefined;
      },
      list: async () => (await virtualFsList(ctx.env)).map((entry) => entry.path),
      write: async (path, contents) => {
        const scopedPath = assertWorkspaceFileAllowed(ctx.env.workspaceFileScope, path);
        if (!observed.has(scopedPath)) observed.set(scopedPath, (await readBytesWithHash(bucket, `${prefix}${scopedPath}`))?.hash ?? null);
        await virtualFsWrite(ctx.env, scopedPath, contents, observed.get(scopedPath)!);
        observed.set(scopedPath, await sha256Text(contents));
      },
      remove: async (path) => {
        const scopedPath = assertWorkspaceFileAllowed(ctx.env.workspaceFileScope, path);
        if (!observed.has(scopedPath)) observed.set(scopedPath, (await readBytesWithHash(bucket, `${prefix}${scopedPath}`))?.hash ?? null);
        await virtualFsDelete(ctx.env, scopedPath, observed.get(scopedPath)!);
        observed.set(scopedPath, null);
      },
    }, {
      ...(cli ? { cli } : {}),
      ...(ctx.authorizeShell ? { authorize: ctx.authorizeShell } : {}),
      deadline: Date.now() + Math.max(1, Math.min(120, Number(args["timeout"]) || 30)) * 1000,
      maxOutputBytes: 65_536,
      resolve: async (words, stdin, execution) => {
        if (execution.signal.aborted) throw new Error("shell_cancelled");
        const dispatch = interceptPlatformWords(words);
        if (dispatch?.operation === "lsp.command") return await runLspCommand(dispatch.params.argv as string[], ctx);
        const registered = ctx.commands?.get(words[0] ?? "");
        if (!dispatch && !registered) return null;
        if (registered && words.includes("--help")) return { exit_code: 0, stdout: registered.usage };
        const operation = dispatch?.operation ?? registered!.operation;
        const declaredTier = ctx.commands?.get(operation)?.requiresTier ?? registered?.requiresTier ?? 1;
        actualTier = Math.max(actualTier, declaredTier) as ExecutionTier;
        if (operation === "Bash" || operation === "code.execute_bash") throw new Error("recursive_shell_command");
        let parameters: Record<string, unknown> = { argv: words.slice(1), stdin };
        const paramsAt = words.indexOf("--params");
        if (paramsAt >= 0) {
          const parsed = JSON.parse(words[paramsAt + 1] ?? "null") as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--params requires a JSON object");
          parameters = parsed as Record<string, unknown>;
        }
        const value = await ctx.run(operation, dispatch?.params ?? parameters);
        return { exit_code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value),
          ...(operation === "delegate_to_space_worker" || operation === "thread.delegate" ? { events: [{ type: "worker" as const, name: operation, data: value }] } : {}),
        };
      },
    });
    if (result.exit_code !== 0)
      throw new Error(result.stderr ?? "virtual command failed");
    return { ...result, virtual: true, actual_tier: actualTier, engine: actualTier === 1 ? "sqlite_fs" : undefined };
  }

  // /.avos is deliberately a sibling namespace in R2, never under the deliverable prefix.
  const parsedShell = parseShell(command);
  const first = parsedShell[0]?.commands[0]?.argv[0];
  if (parsedShell.length === 1 && parsedShell[0]!.commands.length === 1 && !parsedShell[0]!.commands[0]!.redirects.length && first && /^[a-zA-Z][\w-]*$/.test(first)) {
    if (ctx.authorizeShell && !await ctx.authorizeShell({ kind: "command", name: first })) throw new Error(`shell_permission_denied:${first}`);
    const avosPrefix = machinePrefix(ctx.env);
    const module = await bucket.get(`${avosPrefix}bin/${first}.ts`);
    if (module) {
      if (!ctx.env.codeRunner)
        throw new Error("Tier 2 unavailable: no code runner configured");
      const source = await module.text();
      // Revalidate durable source on every load so restarts and out-of-band writes cannot bypass
      // the JIT compiler's safety contract.
      VirtualCliDispatcher.validateSynthesized(first, source);
      assertNoReservedViolation({ name: `avos-bin.${first}`, code: source });
      return runTier(ctx, `avos-bin.${first}`, source, 2, {
        argv: parseCliWords(command).slice(1),
      }, undefined, VirtualCliDispatcher.synthesizedCapabilities(source));
    }
  }
  const stages = parseShell(command).flatMap((pipeline) => pipeline.commands);
  if (stages.length === 1 && first && !stages[0]!.redirects.length && ctx.env.resolveContainerCommand) {
    const sidecar = await ctx.env.resolveContainerCommand(first);
    if (sidecar) {
      if (ctx.env.maxTier !== undefined && ctx.env.maxTier < 6) throw new Error("container_execution_ceiling_exceeded");
      if (ctx.authorizeShell && !await ctx.authorizeShell({ kind: "command", name: first })) throw new Error("shell_permission_denied:" + first);
      const binary = first.includes("/") ? first.split("/").at(-1)! : first;
      const words = [binary, ...stages[0]!.argv.slice(1)];
      const resolvedCommand = words.map(word => "'" + word.replaceAll("'", "'\\''") + "'").join(" ");
      return runTier(ctx, "container.extension_binary", BASH_HARNESS, 6, { ...args, commands: resolvedCommand }, sidecar);
    }
  }
  if (!stages.length || stages.some(({ argv }) => !isDeclaredNativeCommand(argv[0] ?? "")))
    throw new Error(`command_not_found: ${first ?? "unknown"}. Run runtime find ${first ?? "<binary>"} to discover an approved runtime, or tools.search for an existing capability. Installation requires explicit human approval.`);
  for (const stage of stages) if (ctx.authorizeShell && !await ctx.authorizeShell({ kind: "command", name: stage.argv[0]! })) throw new Error(`shell_permission_denied:${stage.argv[0]}`);
  if (ctx.env.maxTier !== undefined && ctx.env.maxTier < 6) {
    throw new Error(
      `command requires the Tier 6 container, above this project's execution ceiling (${ctx.env.maxTier})`
    );
  }
  return runTier(ctx, "code-exec.execute_bash", BASH_HARNESS, 6, args);
}

export const codeExec: PrebuiltScript = {
  name: "code-exec",
  description:
    "Run bounded Python/Wasm or JavaScript without a container; execute virtual Bash commands and authorized native workloads when needed.",
  domain: "container",
  requires_tier: 1,
  paramHints: {
    "code.execute_bash":
      "commands (string, REQUIRED — a bash command line). timeout (number, " +
      "optional seconds, default 30). working_dir (string, optional, default the synced project " +
      "workspace).",
    Bash:
      "Same as code.execute_bash — commands (string, REQUIRED). timeout (number, optional " +
      "seconds). working_dir (string, optional).",
    "code.execute_python":
      "code (string, REQUIRED — a Python script body). input (object, optional — " +
      "available as args in Python). timeout (number, optional seconds, greater than 0 " +
      "and at most 30, default 30). Pure computation in a fresh Python/Wasm isolate; " +
      "no project filesystem, network or pip installs. For native dependencies/files use " +
      "an explicitly authorized container or local-machine command.",
    "code.run_js":
      "code (string, REQUIRED — an exported async run(args, ctx) module). args (object, optional). " +
      "capabilities (string array, max 64; explicit tool:<operation> names). Naelao agents use the virtual CLI. " +
      "Inside a composed module use ctx.cli.search(query), ctx.cli.help(name), and ctx.cli.run([name, '--params', JSON.stringify(params)]). " +
      "This accepts one registered command, not shell syntax; the host rechecks its capability and authorization. " +
      "Calls pass through the normal host approval, scope, tier, and budget checks. No ambient network or imports.",
  },
  operations: {
    "code.execute_python": (a, c) => {
      if (typeof a["code"] !== "string" || !a["code"].trim()) throw new Error("code is required: provide a non-empty Python script");
      if (a["timeout"] !== undefined && (typeof a["timeout"] !== "number" || !Number.isFinite(a["timeout"]) || a["timeout"] <= 0 || a["timeout"] > 30))
        throw new Error("python_timeout_invalid: timeout must be greater than 0 and at most 30 seconds");
      return runTier(c, "code-exec.execute_python", PYTHON_HARNESS, 2, a);
    },
    "code.execute_bash": runBash,
    // Same op as code.execute_bash — see RENAMED_OPERATIONS in tool-surface.ts ("bash"/
    // "execute_bash" -> "Bash") and this file's own header.
    Bash: runBash,
    // codemode (spec): JS/TS with no file I/O runs at Tier 2 — the agent supplies its own
    // `run(args, ctx)` module body directly (no fixed harness; this *is* the Tier-2 contract).
    // Same reserved-capability gate as script.create/update applies here too — ad hoc code
    // bypasses the library, so it must not bypass the money-in guard as well.
    async "code.run_js"(a, c) {
      if (a.capabilities !== undefined && (!Array.isArray(a.capabilities) || a.capabilities.length > 64
        || a.capabilities.some(value => typeof value !== "string" || value.length > 200))) throw new Error("code_capabilities_invalid");
      const adHocCode = String(a["code"] ?? "");
      assertNoReservedViolation({ name: "code-exec.run_js", code: adHocCode });
      await inspectMutation(adHocCode, {
        // JavaScript semicolons are not SQL statements. Actual RPC mutations still
        // enter their own host guards; retain catastrophic shell-pattern screening here.
        kind: "shell",
        ...(c.env.mutationGrant ? { token: c.env.mutationGrant } : {}),
        secret: c.env.platformSecret ?? "",
        resourceId: c.env.projectId ?? c.env.spaceId,
      });
      return runTier(
        c,
        "code-exec.run_js",
        adHocCode,
        2,
        (a["args"] as Record<string, unknown>) ?? {},
        undefined,
        a.capabilities as string[] | undefined
      );
    },
  },
};

/** Environment selection is host-filtered; the normal native runner still checks live grants,
 * deployed images, workspace scope, concurrency, execution ceiling and billing admission. */
export async function runEnvironmentBash(command: string, installation: import("../container-policy.js").InstalledContainer, ctx: PrebuiltOpContext): Promise<unknown> {
  await authorizeEnvironmentCommand(command, ctx);
  return runTier(ctx, "container.extension_binary", BASH_HARNESS, 6, { commands: command, timeout: 30 }, installation);
}
export async function authorizeEnvironmentCommand(command: string, ctx: PrebuiltOpContext): Promise<void> {
  if (!ctx.env.nativeExecutionAllowed || (ctx.env.maxTier ?? 0) < 6) throw new Error("environment_native_execution_denied");
  await inspectMutation(command, { kind: "shell", ...(ctx.env.mutationGrant ? { token: ctx.env.mutationGrant } : {}), secret: ctx.env.platformSecret ?? "", resourceId: ctx.env.projectId ?? ctx.env.spaceId });
  for (const stage of parseShell(command).flatMap(pipeline => pipeline.commands)) {
    if (!ctx.authorizeShell || !await ctx.authorizeShell({ kind: "command", name: stage.argv[0] ?? "" })) throw new Error("environment_shell_permission_denied");
  }
}
