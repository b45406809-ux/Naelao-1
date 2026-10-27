import type { PrebuiltScript } from "./index.js";

export const taskBlackboard: PrebuiltScript = {
  name: "task-blackboard", domain: "orchestration", requires_tier: 1,
  description: "Exchange untrusted messages with explicitly authorized workers in this task.",
  paramHints: {
    "task_blackboard.read": "Read messages addressed to this worker or sent by it.",
    "task_blackboard.recipients": "List worker IDs this task is allowed to message.",
    "task_blackboard.publish": "id (stable retry key), recipients (authorized worker IDs), kind (finding|artifact|question|blocker|risk|completion|verification), text (up to 4000 characters).",
  },
  operations: {
    async "task_blackboard.read"(_args, ctx) {
      if (!ctx.env.orchestration?.taskBlackboard) throw new Error("task_blackboard_unavailable");
      return ctx.env.orchestration.taskBlackboard("read", {});
    },
    async "task_blackboard.recipients"(_args, ctx) {
      if (!ctx.env.orchestration?.taskBlackboard) throw new Error("task_blackboard_unavailable");
      return ctx.env.orchestration.taskBlackboard("recipients", {});
    },
    async "task_blackboard.publish"(args, ctx) {
      if (!ctx.env.orchestration?.taskBlackboard) throw new Error("task_blackboard_unavailable");
      return ctx.env.orchestration.taskBlackboard("publish", args);
    },
  },
};
