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

async function snapshot(fs: RuntimeFileSystem): Promise<Map<string, string>> {
  const paths = (await fs.glob("**/*")).map(workspacePath).sort();
  const entries = await Promise.all(paths.map(async (path) => {
    try { return [path, await fs.read(path)] as const; } catch { return [path, "\0unreadable"] as const; }
  }));
  return new Map(entries);
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
  if (!taskSpec.task.trim()) return { ok: false, error: "Subagent task is required", modifiedFiles: [], receipt: ["Subagent failed", "Subagent task is required"] };
  const maxTokens = Math.min(1_999, Math.max(1, taskSpec.maxTokens ?? 1_999));
  const base = createSubagentContext(input);
  const context = createSubagentContext({
    ...base,
    ai: Object.freeze({ complete: (request: Parameters<RuntimeAi["complete"]>[0]) => base.ai.complete({ ...request, maxTokens: Math.min(maxTokens, request.maxTokens) }) }),
  });
  const before = await snapshot(context.fs);
  try {
    const output = await taskSpec.execute(taskSpec.task, context);
    const after = await snapshot(context.fs);
    const modifiedFiles = [...new Set([...before.keys(), ...after.keys()])]
      .filter((path) => before.get(path) !== after.get(path)).sort();
    return { ok: true, output, modifiedFiles, receipt: ["Subagent completed", `${modifiedFiles.length} file${modifiedFiles.length === 1 ? "" : "s"} changed`] };
  } catch (error) {
    const after = await snapshot(context.fs);
    const modifiedFiles = [...new Set([...before.keys(), ...after.keys()])]
      .filter((path) => before.get(path) !== after.get(path)).sort();
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, modifiedFiles, receipt: ["Subagent failed", message] };
  }
}
