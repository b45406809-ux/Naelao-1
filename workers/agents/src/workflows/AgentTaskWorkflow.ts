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
import { mintInternalToken } from "@naelao/http";
import type { Env } from "../env.js";

export interface AgentTaskParams {
  taskId: string;
  spaceId: string;
  sessionId: string;
  tenantId: string;
  goal: string;
  // A-2 cutover: /agent/run now dispatches to the script-native engine, which resolves its own
  // system prompt/tools/skills from the agent's R2 config by agentId — systemPrompt/tools/
  // kbContext (the SpaceType/D1-driven ReAct config) are gone.
  agentId?: string;
  model: string;
  taskDoName: string;  // DO name for TaskDO stub
  // Go-live audit A-1/A-2: carried through to /internal/tasks/:taskId/run so enforceRunGates can
  // resolve the F-36 clamp / project wallet gate / product_end_user credit gate — previously
  // dropped entirely, leaving the async chat path completely unmetered.
  userId?: string;
  projectId?: string;
  callerRole?: string;
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
      // Go-live audit F1: /internal/tasks/:taskId/run is HMAC-gated (verified tenant must match
      // the body's tenantId) — mint the same signed internal token naelao-router's proxyTo and
      // every other internal caller uses. Without this the workflow's own run would now 403.
      const internalToken = await mintInternalToken(this.env.PLATFORM_SECRET, p.tenantId);
      const resp = await this.env.AGENTS_WORKER.fetch(
        `https://agents-worker/internal/tasks/${p.taskId}/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-naelao-tenant-id": p.tenantId,
            "x-naelao-internal-token": internalToken,
          },
          body: JSON.stringify({
            taskId: p.taskId,
            spaceId: p.spaceId,
            sessionId: p.sessionId,
            tenantId: p.tenantId,
            goal: p.goal,
            agentId: p.agentId,
            model: p.model,
            userId: p.userId,
            projectId: p.projectId,
            callerRole: p.callerRole,
          }),
        }
      );

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Agent run failed (${resp.status}): ${text}`);
      }

      // A-2 cutover bugfix: /internal/tasks/:taskId/run's response is normalized by
      // normalizeScriptRunResult (agents worker index.ts), which carries BOTH finalAnswer
      // (camelCase) and final_answer (snake_case) precisely because this call site used to read
      // only `final_answer` off a response that actually carried `finalAnswer` — a real,
      // previously-undetected bug (the key was always undefined at runtime, so every
      // TaskDO-completed async run silently stored an empty result). Read both defensively.
      const body = await resp.json<{ finalAnswer?: string; final_answer?: string; error?: string }>();
      return { final_answer: body.finalAnswer ?? body.final_answer, error: body.error };
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
