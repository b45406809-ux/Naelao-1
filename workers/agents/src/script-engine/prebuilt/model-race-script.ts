import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

/** Planner-facing entry point for the isolated model race runtime. */
export const modelRaceScript: PrebuiltScript = {
  name: "model-race",
  description:
    "Run bounded model candidates in isolated project branches, validate each with a deterministic command, and promote the first passing winner.",
  domain: "orchestration",
  requires_tier: 1,
  paramHints: {
    "model.race": "task_id, models[], prompt, and test_command are required; escrow_credits is optional.",
  },
  operations: {
    async "model.race"(args, ctx: PrebuiltOpContext) {
      const modelRace = ctx.env.orchestration?.modelRace;
      if (!modelRace) return { ok: false, error: "model race is not available in this environment" };
      const models = Array.isArray(args["models"])
        ? (args["models"] as unknown[]).filter((model): model is string => typeof model === "string" && model.length > 0)
        : [];
      const taskId = String(args["task_id"] ?? "");
      const prompt = String(args["prompt"] ?? "");
      const testCommand = String(args["test_command"] ?? "");
      if (!taskId || models.length === 0 || !prompt || !testCommand) {
        throw new Error("model.race requires task_id, models[], prompt, and test_command");
      }
      return {
        ok: true,
        ...(await modelRace({
          taskId,
          models,
          prompt,
          testCommand,
          ...(typeof args["escrow_credits"] === "number" ? { escrowCredits: args["escrow_credits"] } : {}),
        })),
      };
    },
  },
};
