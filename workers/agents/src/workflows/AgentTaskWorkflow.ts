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
import { reportWorkflowStepInfraUsage } from "./report-infra-usage.js";

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
  // §A1 Harness Excellence Phase HX2: threaded through the same path as the fields above so the
  // async dispatch path's session-budget gate matches the sync path's exactly.
  sessionCreditCeiling?: number;
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
    // No `timeout` and no `retries`, both deliberate, and both changes from a version that made
    // "long-running background agent" untrue in practice:
    //
    // The step used to cap at 29 seconds. A Workflow step has NO wall-time limit (only a CPU-time
    // limit, which excludes the time spent waiting on an LLM or a tool), so that ceiling was
    // entirely self-imposed: any real multi-step task — look something up, think, act, verify —
    // blew through it and was reported as a failure.
    //
    // Retries are off because an agent run is NOT idempotent. Retrying it re-executes every tool
    // call already made: the same email sent twice, the same charge taken twice. That is exactly
    // the "no duplicate work" guarantee a durable execution layer is supposed to provide, and
    // retrying a non-idempotent step is the opposite of providing it. The ledger check below is
    // what makes a REPLAY (a Workflow restart, where step results are memoized) safe; a fresh
    // attempt at a run that already half-happened is not something we can make safe by hoping.
    const runResult = await step.do("run-agent", { retries: { limit: 0, delay: 0 } }, async () => {
      const stepStarted = Date.now();

      // Ledger check — the Orchestrator pattern, using the TaskDO row we already write as the
      // ledger rather than inventing a second store. If this task already reached a terminal
      // state, the run happened; return what was recorded instead of doing it again.
      const already = await this.recordedResult(p);
      if (already) return already;
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
            sessionCreditCeiling: p.sessionCreditCeiling,
          }),
        }
      );

      // §A1.26: this step's own async-dispatch orchestration overhead (distinct from the run's
      // own isolate/container/LLM billing, which settleRunBilling handles inside the agent DO).
      await reportWorkflowStepInfraUsage(this.env, p.tenantId, p.spaceId, Date.now() - stepStarted, `workflow:${event.instanceId}:run-agent`);

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
      const body = await resp.json<{
        finalAnswer?: string;
        final_answer?: string;
        error?: string;
        status?: string;
      }>();
      return {
        final_answer: body.finalAnswer ?? body.final_answer,
        error: body.error,
        status: body.status,
      };
    });

    // ── Step 3: Update task with result ───────────────────────────────────────
    await step.do("update-result", retry, async () => {
      const doId = this.env.TASK_DO.idFromName(p.taskDoName);
      const stub = this.env.TASK_DO.get(doId);

      const hasError = !!runResult.error;
      // A run waiting on a human is neither done nor failed. Recording it as 'complete' would
      // tell the caller their work finished when it is in fact sitting waiting for them, and
      // would fire the completion callback for something that hasn't happened.
      const status = runResult.status === "awaiting_approval"
        ? "awaiting_approval"
        : hasError ? "failed" : "complete";
      const resp = await stub.fetch(`http://task-do/tasks/${p.taskId}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          result: hasError ? null : JSON.stringify({ final_answer: runResult.final_answer }),
          error: runResult.error ?? null,
        }),
      });
      if (!resp.ok) throw new Error(`Failed to update task result: ${resp.status}`);
      return { ok: true };
    });
  }

  /**
   * What the ledger already knows about this task, or null if the run hasn't happened.
   *
   * Best-effort by design: a ledger read that fails must not block the run, since a task that has
   * genuinely never run would otherwise be stuck forever. The cost of being wrong in this
   * direction is a repeated run on a rare restart; the cost of the other direction is a task that
   * never executes at all.
   */
  private async recordedResult(
    p: AgentTaskParams
  ): Promise<{ final_answer: string | undefined; error: string | undefined; status: string | undefined } | null> {
    try {
      const stub = this.env.TASK_DO.get(this.env.TASK_DO.idFromName(p.taskDoName));
      const resp = await stub.fetch(`http://task-do/tasks/${p.taskId}`);
      if (!resp.ok) return null;
      const task = await resp.json<{ status?: string; result?: string | null; error?: string | null }>();
      if (task.status !== "complete" && task.status !== "failed") return null;
      let answer: string | undefined;
      if (task.result) {
        try {
          answer = (JSON.parse(task.result) as { final_answer?: string }).final_answer;
        } catch { /* a result we can't parse is still proof the run happened */ }
      }
      return { final_answer: answer, error: task.error ?? undefined, status: task.status };
    } catch {
      return null;
    }
  }
}
