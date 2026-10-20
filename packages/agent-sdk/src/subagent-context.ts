import type { RuntimeAi, RuntimeFileSystem, SubagentContext } from "./types.js";
import { workspacePath } from "./runtime-context.js";

export interface SubagentTaskSpec<T = unknown> {
  task: string;
  execute(task: string, context: SubagentContext): Promise<T>;
  maxTokens?: number;
}

export interface SubagentVerbResult<T = unknown> {
  ok: boolean;
  output?: T;
  error?: string;
  modifiedFiles: string[];
  /** Exactly two UI-safe lines rendered by the persistent parent; never a child thread. */
  receipt: readonly [string, string];
}

const FORBIDDEN = ["threads", "sessions", "presence", "channels", "delegate"] as const;
const MAX_SNAPSHOT_FILES = 10_000;
const MAX_SNAPSHOT_CHARS = 16 * 1024 * 1024;
const SNAPSHOT_READ_CONCURRENCY = 8;
const MAX_TASK_CHARS = 64 * 1024;
const MAX_SUBAGENT_TOKENS = 1_999;

async function snapshot(fs: RuntimeFileSystem): Promise<Map<string, string>> {
  const paths = [...new Set((await fs.glob("**/*")).map(workspacePath))].sort();
  if (paths.length > MAX_SNAPSHOT_FILES) throw new Error("subagent_workspace_snapshot_file_limit");
  const entries: Array<readonly [string, string]> = new Array(paths.length);
  let cursor = 0, totalChars = 0, tooLarge = false;
  const readBatch = async () => {
    while (!tooLarge) {
      const index = cursor++;
      if (index >= paths.length) return;
      const path = paths[index]!;
      let contents: string;
      try { contents = await fs.read(path); } catch { contents = "\0unreadable"; }
      totalChars += contents.length;
      if (totalChars > MAX_SNAPSHOT_CHARS) {
        tooLarge = true;
        return;
      }
      entries[index] = [path, contents];
    }
  };
  await Promise.all(Array.from({ length: Math.min(SNAPSHOT_READ_CONCURRENCY, paths.length) }, readBatch));
  if (tooLarge) throw new Error("subagent_workspace_snapshot_size_limit");
  return new Map(entries);
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(path => before.get(path) !== after.get(path)).sort();
}

function failure(message: string, modifiedFiles: string[] = []): SubagentVerbResult<never> {
  const safeMessage = message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500) || "Subagent failed";
  return { ok: false, error: safeMessage, modifiedFiles, receipt: ["Subagent failed", safeMessage] };
}

/** Build a frozen, serialization-safe context whose five properties are an allowlist. */
export function createSubagentContext(input: SubagentContext): SubagentContext {
  const context = Object.freeze({ ai: input.ai, fs: input.fs, cli: input.cli, vault: input.vault, step: input.step });
  for (const key of FORBIDDEN) {
    if (Object.prototype.hasOwnProperty.call(context, key)) throw new Error(`Forbidden subagent capability: ${key}`);
  }
  return context;
}

/** Execute an ephemeral subagent to completion and report its workspace delta to its parent. */
export async function spawnSubagentVerb<T>(taskSpec: SubagentTaskSpec<T>, input: SubagentContext): Promise<SubagentVerbResult<T>> {
  if (typeof taskSpec.task !== "string" || !taskSpec.task.trim() || taskSpec.task.length > MAX_TASK_CHARS) return failure("Subagent task is missing or exceeds the 64 KiB limit");
  const requestedMaxTokens = taskSpec.maxTokens ?? MAX_SUBAGENT_TOKENS;
  if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens < 1) return failure("Subagent token budget must be a positive safe integer");
  const maxTokens = Math.min(MAX_SUBAGENT_TOKENS, requestedMaxTokens);
  const base = createSubagentContext(input);
  const context = createSubagentContext({
    ...base,
    ai: Object.freeze({ complete: (request: Parameters<RuntimeAi["complete"]>[0]) => {
      if (!request || typeof request.prompt !== "string" || !Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1)
        throw new Error("subagent_model_request_invalid");
      return base.ai.complete({ ...request, maxTokens: Math.min(maxTokens, request.maxTokens) });
    } }),
  });
  let before: Map<string, string>;
  try { before = await snapshot(context.fs); }
  catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
  try {
    const output = await taskSpec.execute(taskSpec.task, context);
    const after = await snapshot(context.fs);
    const modified = changedFiles(before, after);
    return { ok: true, output, modifiedFiles: modified, receipt: ["Subagent completed", `${modified.length} file${modified.length === 1 ? "" : "s"} changed`] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { return failure(message, changedFiles(before, await snapshot(context.fs))); }
    catch { return failure(message); }
  }
}
