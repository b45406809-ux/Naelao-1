export type RacePlan = "starter" | "pro" | "enterprise";
export interface ModelRaceWorkerResult { exitCode: number; commitOid?: string }
export interface ModelRaceDependencies {
  plan: RacePlan;
  createBranch(branch: string): Promise<void>;
  runWorker(input: { taskId: string; model: string; prompt: string; branch: string; signal: AbortSignal }): Promise<void>;
  runOracle(input: { command: string; branch: string; signal: AbortSignal }): Promise<ModelRaceWorkerResult>;
  fastForwardMain(branch: string): Promise<void>;
  cleanupBranch?(branch: string): Promise<void>;
}
export interface ModelRaceResult { model: string; branch: string; commitOid?: string; attempted: number; aborted: number }
const segment = (value: string) => encodeURIComponent(value.replaceAll("/", "-")).slice(0, 96);

/** Race isolated branches and promote only the first deterministic, passing result. */
export async function runSpeculativeModelRace(taskId: string, models: readonly string[], prompt: string,
  testCommand: string, dependencies: ModelRaceDependencies): Promise<ModelRaceResult> {
  if (!taskId || !prompt || !testCommand || models.length === 0) throw new Error("taskId, models, prompt and testCommand are required");
  const branches = models.map((model) => `race/${segment(taskId)}/${segment(model)}`);
  await Promise.all(branches.map(dependencies.createBranch));
  let attempted = 0, aborted = 0;
  const execute = async (model: string, branch: string, signal: AbortSignal) => {
    attempted++;
    await dependencies.runWorker({ taskId, model, prompt, branch, signal });
    if (signal.aborted) throw signal.reason;
    const oracle = await dependencies.runOracle({ command: testCommand, branch, signal });
    if (oracle.exitCode !== 0) throw new Error(`oracle_failed:${model}:${oracle.exitCode}`);
    return { model, branch, ...(oracle.commitOid ? { commitOid: oracle.commitOid } : {}) };
  };
  let winner: Awaited<ReturnType<typeof execute>> | undefined;
  if (dependencies.plan === "starter") {
    for (let i = 0; i < models.length; i++) {
      try { winner = await execute(models[i]!, branches[i]!, new AbortController().signal); break; } catch { /* sequential clamp */ }
    }
  } else {
    const controllers = models.map(() => new AbortController());
    winner = await new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      let failures = 0, settled = false;
      models.forEach((model, index) => void execute(model, branches[index]!, controllers[index]!.signal).then((result) => {
        if (settled) return;
        settled = true;
        controllers.forEach((controller, other) => {
          if (other !== index && !controller.signal.aborted) { controller.abort(new DOMException("Race lost", "AbortError")); aborted++; }
        });
        resolve(result);
      }).catch((error) => { if (++failures === models.length && !settled) reject(error); }));
    });
  }
  if (!winner) throw new Error("No model satisfied the deterministic oracle");
  await dependencies.fastForwardMain(winner.branch);
  if (dependencies.cleanupBranch) await Promise.all(branches.filter((branch) => branch !== winner!.branch).map(dependencies.cleanupBranch));
  return { ...winner, attempted, aborted };
}
