export type ContextQueryHook = { type: "context_query"; indexer: "project_status" | "budget" | "knowledge"; query: Record<string, string | number | boolean> };
export type VerificationHook = { type: "verification"; command: "npm test" | "pnpm test" | "npm run lint" | "pnpm lint" | "npm run typecheck" | "pnpm typecheck" | "ast-lint"; timeout_ms?: number };
export interface StepPipeline { beforeStep?: ContextQueryHook[]; afterStep?: VerificationHook[] }

const EXECUTABLE_KEYS = /^(?:code|script|javascript|python|js|py|eval|source)$/i;
export function validateStepPipeline(value: unknown): asserts value is StepPipeline {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pipeline must be an object");
  const pipeline = value as Record<string, unknown>;
  for (const key of Object.keys(pipeline)) if (!/^(beforeStep|afterStep)$/.test(key)) throw new Error(`unsupported pipeline field: ${key}`);
  const walk = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) { if (EXECUTABLE_KEYS.test(key) && typeof nested === "string") throw new Error("executable hook strings are forbidden"); walk(nested); }
  };
  walk(value);
  for (const hook of (pipeline.beforeStep ?? []) as Array<Record<string, unknown>>) {
    if (hook.type !== "context_query" || !["project_status", "budget", "knowledge"].includes(String(hook.indexer)) || !hook.query || typeof hook.query !== "object") throw new Error("invalid beforeStep context query");
  }
  const allowed = new Set(["npm test", "pnpm test", "npm run lint", "pnpm lint", "npm run typecheck", "pnpm typecheck", "ast-lint"]);
  for (const hook of (pipeline.afterStep ?? []) as Array<Record<string, unknown>>) {
    if (hook.type !== "verification" || !allowed.has(String(hook.command))) throw new Error("verification command is not allowlisted");
    if (hook.timeout_ms !== undefined && (typeof hook.timeout_ms !== "number" || hook.timeout_ms < 1 || hook.timeout_ms > 300_000)) throw new Error("invalid verification timeout");
  }
}

export interface PipelineRuntime {
  query(hook: ContextQueryHook): Promise<unknown>;
  verify(hook: VerificationHook): Promise<{ ok: boolean; output?: string; error?: string }>;
}
export async function runBeforeStep(pipeline: StepPipeline | undefined, runtime: PipelineRuntime | undefined): Promise<unknown[]> {
  if (!pipeline || !runtime) return [];
  validateStepPipeline(pipeline);
  return Promise.all((pipeline.beforeStep ?? []).map((hook) => runtime.query(hook)));
}
export async function runAfterStep(pipeline: StepPipeline | undefined, runtime: PipelineRuntime | undefined): Promise<{ ok: boolean; failures: Array<{ command: string; error: string }> }> {
  if (!pipeline || !runtime) return { ok: true, failures: [] };
  validateStepPipeline(pipeline);
  const failures: Array<{ command: string; error: string }> = [];
  for (const hook of pipeline.afterStep ?? []) { const result = await runtime.verify(hook); if (!result.ok) failures.push({ command: hook.command, error: result.error ?? result.output ?? "verification failed" }); }
  return { ok: failures.length === 0, failures };
}
