import { describe, expect, it } from "vitest";
import { checkpointAgentTask } from "./agent-task-checkpoints.js";
import type { AgentTaskParams } from "./AgentTaskWorkflow.js";

const params = {
  taskId: "task-a", spaceId: "space-a", sessionId: "session-a", tenantId: "tenant-a", goal: "run",
  model: "model-a", taskDoName: "tasks:space-a", userId: "actor-a",
} as AgentTaskParams;

describe("agent task workflow checkpoint scope", () => {
  it("rejects an instance ID that does not match the task ID before touching bindings", async () => {
    await expect(checkpointAgentTask({} as never, "another-task", params, {} as never))
      .rejects.toThrow("agent_task_workflow_run_scope_mismatch");
  });

  it("rejects a TaskDO name outside the task Space", async () => {
    await expect(checkpointAgentTask({} as never, params.taskId, { ...params, taskDoName: "tasks:space-b" }, {} as never))
      .rejects.toThrow("agent_task_workflow_task_do_scope_mismatch");
  });
});
