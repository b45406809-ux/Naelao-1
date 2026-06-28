/**
 * AgentTaskWorkflow — CF Workflow for async agent task execution.
 *
 * G-AX04: Runs a NaelaoAgentDO agent run for a queued task, then updates
 * the TaskDO with the result.
 *
 * Steps:
 *   1. mark-processing   — set task status = processing in TaskDO
 *   2. run-agent         — call agents worker internal endpoint to run the agent
 *   3. update-result     — set task status = complete | failed with result
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../env.js";

export interface AgentTaskParams {
  taskId: string;
  spaceId: string;
  sessionId: string;
  tenantId: string;
  goal: string;
  systemPrompt: string;
  tools: unknown[];
  kbContext: string;
  model: string;
  taskDoName: string;  // DO name for TaskDO stub
}

export class AgentTaskWorkflow extends WorkflowEntrypoint<Env, AgentTaskParams> {
  async run(
    event: WorkflowEvent<AgentTaskParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const p = event.payload;

    const retry = {
      retries: { limit: 3, delay: 1000, backoff: "exponential" as const },
      timeout: 30_000,
    };

    // ── Step 1: Mark task as processing ───────────────────────────────────────
    await step.do("mark-processing", retry, async () => {
      const doId = this.env.TASK_DO.idFromName(p.taskDoName);
      const stub = this.env.TASK_DO.get(doId);
      const resp = await stub.fetch(`http://task-do/tasks/${p.taskId}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "processing" }),
      });
      if (!resp.ok) throw new Error(`Failed to mark task processing: ${resp.status}`);
      return { ok: true };
    });

    // ── Step 2: Run agent via agents-worker internal endpoint ─────────────────
    const runResult = await step.do("run-agent", { ...retry, timeout: 29_000 }, async () => {
      const resp = await this.env.AGENTS_WORKER.fetch(
        `https://agents-worker/internal/tasks/${p.taskId}/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: p.taskId,
            spaceId: p.spaceId,
            sessionId: p.sessionId,
            tenantId: p.tenantId,
            goal: p.goal,
            systemPrompt: p.systemPrompt,
            tools: p.tools,
            kbContext: p.kbContext,
            model: p.model,
          }),
        }
      );

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Agent run failed (${resp.status}): ${text}`);
      }

      const body = await resp.json<{ final_answer?: string; error?: string }>();
      return body;
    });

    // ── Step 3: Update task with result ───────────────────────────────────────
    await step.do("update-result", retry, async () => {
      const doId = this.env.TASK_DO.idFromName(p.taskDoName);
      const stub = this.env.TASK_DO.get(doId);

      const hasError = !!runResult.error;
      const resp = await stub.fetch(`http://task-do/tasks/${p.taskId}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: hasError ? "failed" : "complete",
          result: hasError ? null : JSON.stringify({ final_answer: runResult.final_answer }),
          error: runResult.error ?? null,
        }),
      });
      if (!resp.ok) throw new Error(`Failed to update task result: ${resp.status}`);
      return { ok: true };
    });
  }
}
