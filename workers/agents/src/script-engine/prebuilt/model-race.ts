import { clampPlanParallelism, DEFAULT_TASK_ESCROW_CREDITS } from "@naelao/billing-core";

export type RacePlan = "free" | "starter" | "pro" | "enterprise";
export interface ModelRaceWorkerResult { exitCode: number; commitOid?: string; linesChanged?: number; durationMs?: number }
export interface ModelRaceDependencies {
  plan: RacePlan;
  maxParallelism?: number;
  createBranch(branch: string): Promise<void>;
  runWorker(input: { taskId: string; model: string; prompt: string; branch: string; signal: AbortSignal }): Promise<void>;
  runOracle(input: { command: string; branch: string; signal: AbortSignal }): Promise<ModelRaceWorkerResult>;
  fastForwardMain(branch: string): Promise<void>;
  /** Multi-user work publishes a review card while retaining the candidate branch. */
  submitForReview?(branch: string): Promise<unknown>;
  cleanupBranch?(branch: string): Promise<void>;
  /** Atomically reserves credits before any branch or model work starts. */
  reserveCreditHold(credits: number): Promise<{ release(): Promise<void> }>;
}
export interface ModelRaceResult { model: string; branch: string; commitOid?: string; attempted: number; aborted: number; review?: unknown }
const segment = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24) || "candidate";

/** Race isolated branches and promote only the first deterministic, passing result. */
export async function runSpeculativeModelRace(taskId: string, models: readonly string[], prompt: string,
  testCommand: string, dependencies: ModelRaceDependencies, escrowCredits = DEFAULT_TASK_ESCROW_CREDITS): Promise<ModelRaceResult> {
  if (!taskId || !prompt || !testCommand || models.length === 0) throw new Error("taskId, models, prompt and testCommand are required");
  if (!Number.isFinite(escrowCredits) || escrowCredits <= 0) throw new Error("Task escrow must be positive");
  if (models.length > 12 || new Set(models).size !== models.length || models.some(model => !model.trim())) throw new Error("race_candidates_invalid");
  const hold = await dependencies.reserveCreditHold(Math.ceil(escrowCredits));
  try {
  const invocation = crypto.randomUUID();
  const branches = models.map((model, index) => `race/${segment(taskId)}/${invocation}/${index}-${segment(model)}`);
  const created = new Set<string>();
  let merged = false;
  let attempted = 0, aborted = 0;
  let winner: { model: string; branch: string; commitOid?: string; score: number } | undefined;
  const score = (oracle: ModelRaceWorkerResult) => 1 / (Math.max(1, oracle.linesChanged ?? 1) * Math.max(1, oracle.durationMs ?? 1));
  const execute = async (model: string, branch: string, signal: AbortSignal) => {
    attempted++;
    const start = Date.now();
    await dependencies.createBranch(branch);
    created.add(branch);
    await dependencies.runWorker({ taskId, model, prompt, branch, signal });
    if (signal.aborted) throw signal.reason;
    const oracle = await dependencies.runOracle({ command: testCommand, branch, signal });
    if (signal.aborted) throw signal.reason;
    if (oracle.exitCode !== 0) throw new Error(`oracle_failed:${model}:${oracle.exitCode}`);
    if (oracle.linesChanged !== undefined && (!Number.isSafeInteger(oracle.linesChanged) || oracle.linesChanged < 0)) throw new Error("invalid_oracle_metrics");
    if (oracle.durationMs !== undefined && (!Number.isFinite(oracle.durationMs) || oracle.durationMs < 0)) throw new Error("invalid_oracle_metrics");
    return { model, branch, score: score({ ...oracle, durationMs: oracle.durationMs ?? Date.now() - start }), ...(oracle.commitOid ? { commitOid: oracle.commitOid } : {}) };
  };
  const parallelism = Math.min(4, Math.max(1, Math.min(4, dependencies.maxParallelism ?? 4)), clampPlanParallelism(dependencies.plan, models.length));
  try {
    for (let offset = 0; offset < models.length && !winner; offset += parallelism) {
      const candidates = models.slice(offset, offset + parallelism);
      const controllers = candidates.map(() => new AbortController());
      const passed: Array<{ model: string; branch: string; commitOid?: string; score: number }> = [];
      let resolveWake!: () => void;
      const wake = new Promise<void>(resolve => { resolveWake = resolve; });
      const running = candidates.map((model, index) => execute(model, branches[offset + index]!, controllers[index]!.signal).then(result => {
        passed.push(result);
        resolveWake();
      }));
      // Observe all rejections immediately, including cancellation of losers.
      const settled = Promise.allSettled(running).then(() => resolveWake());
      await wake;
      // Co-settled successes use the documented score, then a stable model tie-break.
      await Promise.resolve();
      winner = passed.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model))[0];
      if (winner) controllers.forEach((controller, index) => {
        if (candidates[index] !== winner!.model && !controller.signal.aborted) { controller.abort(new DOMException("Race lost", "AbortError")); aborted++; }
      });
      // Cancellation must finish before deleting branch state or releasing the hold.
      await settled;
    }
    if (!winner) throw new Error("No model satisfied the deterministic oracle; human review required");
    const review = dependencies.submitForReview ? await dependencies.submitForReview(winner.branch) : undefined;
    if (!dependencies.submitForReview) await dependencies.fastForwardMain(winner.branch);
    merged = true; // Retain a submitted candidate as well as an accepted winner.
    return { ...(dependencies.submitForReview ? { review } : {}), model: winner.model, branch: winner.branch, ...(winner.commitOid ? { commitOid: winner.commitOid } : {}), attempted, aborted };
  } finally {
    if (dependencies.cleanupBranch) await Promise.all([...created].filter(branch => !merged || branch !== winner?.branch).map(dependencies.cleanupBranch));
  }
  } finally {
    await hold.release();
  }
}
