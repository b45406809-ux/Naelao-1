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
import type { BusinessContext } from "../launchpad/business-context.js";

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
  /**
   * The caller's role in THIS business, resolved server-side from business_memberships by
   * /agent/run.
   *
   * It was already being passed into this Workflow's params and then silently dropped — declared
   * nowhere here and forwarded nowhere below. The consequence was not subtle: this async path is
   * the DEFAULT for every real chat message, and without businessRole the F-36 clamp downgrades
   * `yolo` for every product_end_user, including a business's own OWNER. So an owner who set
   * their business to autonomous still had every single action gated, with nobody but themself to
   * approve it — the exact bug item 93 fixed on the synchronous path and missed here, which is
   * the path that actually runs in production.
   */
  businessRole?: string;
  // §A1 Harness Excellence Phase HX2: threaded through the same path as the fields above so the
  // async dispatch path's session-budget gate matches the sync path's exactly.
  sessionCreditCeiling?: number;
  /** WHICH business this task is for (name, what it sells, setup state) — resolved by the
   *  /agent/run route from the space row. Carried so a durable/async run is told exactly as much
   *  about the business as a synchronous one; without it the default dispatch path would be the
   *  one that stayed generic. See launchpad/business-context.ts. */
  businessContext?: BusinessContext;
  /** Model switcher capability config (a chosen reasoning-effort/thinking level) — already
   *  validated by the /agent/run route against whichever model this task actually runs. */
  reasoningEffort?: string;
  /** The escalation-budget dial (billing-core's EffortLevel) — already validated/defaulted by
   *  the /agent/run route before this Workflow was created. */
  effort?: string;
}

export class AgentTaskWorkflow extends WorkflowEntrypoint<Env, AgentTaskParams> {
  async run(
    event: WorkflowEvent<AgentTaskParams>,
    step: WorkflowStep,
  ): Promise<void> {
    // Outer safety net for the SAME bug class the run-agent step's own try/catch fixes below: if
    // step 1 ("mark-processing") or step 3 ("update-result") exhausts ITS retries and rethrows —
    // a TaskDO genuinely being unreachable, say — that exception would otherwise also propagate
    // out of `run()` uncaught, leaving the task stuck exactly like the run-agent case did. This is
    // a last-resort, non-step (plain fetch, no Serializable<T> constraint, no retry policy of its
    // own) direct write, so it can still run even when the step machinery itself is what failed.
    try {
      await this.runSteps(event, step);
    } catch (err) {
      try {
        const stub = this.env.TASK_DO.get(this.env.TASK_DO.idFromName(event.payload.taskDoName));
        await stub.fetch(`http://task-do/tasks/${event.payload.taskId}/status`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "failed",
            result: null,
            error: err instanceof Error ? err.message : String(err),
          }),
        });
      } catch {
        // Genuinely nothing more can be done — TaskDO itself is unreachable. The task stays
        // "processing"; this is the one failure mode this file cannot self-heal.
      }
    }
  }

  private async runSteps(
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
    // Live-reported bug (2026-08-07): "Timed out waiting for a response" on EVERY message,
    // reproduced directly against production — a task that failed (in this case the account's
    // Workers AI daily neuron allocation being exhausted, but genuinely ANY failure here has the
    // same effect) stayed in TaskDO status "processing" forever. Root cause: `step.do` rethrows
    // once its own retries are exhausted, and that exception was never caught — it propagated
    // straight out of `run()`, so step 3 ("update-result") never executed and the task's status
    // was never written as "failed". The client polls, never observes a terminal status, and
    // times out after MAX_POLL_DURATION_MS; a page refresh reattaches to the same forever-
    // "processing" run and hangs again identically. Wrapping the step call itself is the fix:
    // whatever the failure, it becomes a normal `runResult.error` value and step 3 always runs.
    let runResult: {
      final_answer: string | undefined; error: string | undefined; error_code: string | undefined; status: string | undefined;
      pending_approval_json: string | undefined; deferred_approvals_json: string | undefined;
    };
    try {
      runResult = await step.do("run-agent", { retries: { limit: 0, delay: 0 } }, async () => {
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
              businessRole: p.businessRole,
              sessionCreditCeiling: p.sessionCreditCeiling,
              businessContext: p.businessContext,
              reasoningEffort: p.reasoningEffort,
              effort: p.effort,
            }),
          }
        );

        // §A1.26: this step's own async-dispatch orchestration overhead (distinct from the run's
        // own isolate/container/LLM billing, which settleRunBilling handles inside the agent DO).
        await reportWorkflowStepInfraUsage(this.env, p.tenantId, p.spaceId, Date.now() - stepStarted, `workflow:${event.instanceId}:run-agent`);

        if (!resp.ok) {
          // Return an error RESULT rather than throwing here — /internal/tasks/:taskId/run passes
          // a non-2xx DO response through verbatim (unnormalized), and that raw body can still
          // legitimately carry deferred_approvals if the run parked one before hitting whatever
          // then made the overall call non-ok (e.g. a second-turn reasoning failure). Throwing
          // immediately discarded that unconditionally — the exact class of loss the comment on
          // deferred_approvals below already exists to prevent for the 200-with-error-status case.
          // Falls back to the raw response text as the error when the body isn't the JSON shape
          // this expects (e.g. a plain-text 500 from an upstream outage).
          const text = await resp.text();
          let parsedError: string | undefined;
          let errorCode: string | undefined;
          let pendingApprovalJson: string | undefined;
          let deferredApprovalsJson: string | undefined;
          try {
            const errBody = JSON.parse(text) as {
              error?: string;
              message?: string;
              // Live-reported bug: a caller hitting a billing gate (insufficient_credits,
              // subscription_inactive, quota_exceeded, ...) saw only the raw human-readable
              // `error` string — this machine-readable code was parsed here and then silently
              // dropped, so the client had no reliable way to distinguish "you need to pay" from
              // any other failure and render an upgrade path instead of a bare error banner.
              error_code?: string;
              pending_approval?: { approval_id: string; action_name: string; params?: Record<string, unknown>; expires_at?: number };
              deferred_approvals?: Array<{ approval_id: string; action_name: string; params?: Record<string, unknown>; expires_at?: number }>;
            };
            parsedError = errBody.error ?? errBody.message;
            errorCode = errBody.error_code;
            pendingApprovalJson = errBody.pending_approval ? JSON.stringify(errBody.pending_approval) : undefined;
            deferredApprovalsJson = errBody.deferred_approvals?.length ? JSON.stringify(errBody.deferred_approvals) : undefined;
          } catch {
            // Not JSON, or not the shape above — the raw text below is still a real error message.
          }
          return {
            final_answer: undefined,
            error: parsedError ?? `Agent run failed (${resp.status}): ${text}`,
            error_code: errorCode,
            status: undefined,
            pending_approval_json: pendingApprovalJson,
            deferred_approvals_json: deferredApprovalsJson,
          };
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
          pending_approval?: { approval_id: string; action_name: string; params?: Record<string, unknown>; expires_at?: number };
          // Live-reported bug (2026-07-29): a run that parked a real approval and continued (rather
          // than fully suspending) carried this array in the direct-DO response, but this step never
          // read it at all — every async-dispatched (the DEFAULT) run silently dropped it, so the
          // approval genuinely existed (visible in HITLApprovalDO/the /approvals page) while the chat
          // UI showed nothing about it whatsoever.
          deferred_approvals?: Array<{ approval_id: string; action_name: string; params?: Record<string, unknown>; expires_at?: number }>;
        }>();
        return {
          final_answer: body.finalAnswer ?? body.final_answer,
          error: body.error,
          // A 2xx response never carries error_code (that's exclusively the shape of the !resp.ok
          // branch above) — declared here only so both branches return the same object shape.
          error_code: undefined,
          status: body.status,
          // CF Workflow step results must be Serializable<T>, which a bare Record<string, unknown>
          // (the params object's own type) doesn't satisfy — pre-stringified here, parsed back only
          // inside the plain (non-step) "update-result" callback below where that constraint
          // doesn't apply.
          pending_approval_json: body.pending_approval ? JSON.stringify(body.pending_approval) : undefined,
          deferred_approvals_json: body.deferred_approvals?.length ? JSON.stringify(body.deferred_approvals) : undefined,
        };
      });
    } catch (err) {
      runResult = {
        final_answer: undefined,
        error: err instanceof Error ? err.message : String(err),
        error_code: undefined,
        status: undefined,
        pending_approval_json: undefined,
        deferred_approvals_json: undefined,
      };
    }

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
          // §A1 chat UI parity: an awaiting_approval task previously stored only the friendly
          // placeholder text (see normalizeScriptRunResult), with no way for a polling client to
          // learn WHICH approval opened, its action name, or its parameters — so an inline
          // in-chat approval card had nothing to render. Carried through unconditionally (a
          // completed/failed run simply has none).
          // Live-reported bug: this used to be `hasError ? null : JSON.stringify(...)` — a run
          // that opened a real, still-open approval and only THEN hit an unrelated second-turn
          // reasoning failure had that approval silently discarded along with the error, even
          // though it genuinely exists and is still waiting on a human. deferred_approvals is now
          // carried through unconditionally; final_answer/pending_approval stay null on a genuine
          // error (there is no real answer to show), matching every other error's behavior.
          // Live-reported bug (2026-08-11): a caller hitting a billing gate (insufficient_credits/
          // subscription_inactive/quota_exceeded) got only the raw error TEXT, with no reliable
          // way to render an "upgrade" path instead of a bare error banner — error_code carries
          // through even on a hard error now, for exactly the same reason deferred_approvals does.
          result: (hasError && !runResult.deferred_approvals_json && !runResult.error_code) ? null : JSON.stringify({
            ...(hasError ? {} : { final_answer: runResult.final_answer }),
            // Re-parsed here (a plain step-3 callback, not the run-agent step itself, so the
            // Serializable<T> constraint that made the pre-stringify necessary doesn't apply).
            ...(runResult.error_code ? { error_code: runResult.error_code } : {}),
            ...(runResult.pending_approval_json ? { pending_approval: JSON.parse(runResult.pending_approval_json) } : {}),
            ...(runResult.deferred_approvals_json ? { deferred_approvals: JSON.parse(runResult.deferred_approvals_json) } : {}),
          }),
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
  ): Promise<{
    final_answer: string | undefined; error: string | undefined; error_code: string | undefined; status: string | undefined;
    pending_approval_json: string | undefined; deferred_approvals_json: string | undefined;
  } | null> {
    try {
      const stub = this.env.TASK_DO.get(this.env.TASK_DO.idFromName(p.taskDoName));
      const resp = await stub.fetch(`http://task-do/tasks/${p.taskId}`);
      if (!resp.ok) return null;
      const task = await resp.json<{ status?: string; result?: string | null; error?: string | null }>();
      // "awaiting_approval" is deliberately NOT recorded-and-short-circuited here — unlike
      // complete/failed, it isn't a terminal outcome the ledger should ever treat as "the run
      // happened, don't redo it": the whole point of a suspended run is that it resumes later
      // (via handleResumeRun, a separate flow this Workflow instance never re-enters), so there's
      // nothing this method needs to protect against re-running.
      if (task.status !== "complete" && task.status !== "failed") return null;
      let answer: string | undefined;
      let errorCode: string | undefined;
      if (task.result) {
        try {
          const parsed = JSON.parse(task.result) as { final_answer?: string; error_code?: string };
          answer = parsed.final_answer;
          errorCode = parsed.error_code;
        } catch { /* a result we can't parse is still proof the run happened */ }
      }
      return { final_answer: answer, error: task.error ?? undefined, error_code: errorCode, status: task.status, pending_approval_json: undefined, deferred_approvals_json: undefined };
    } catch {
      return null;
    }
  }
}
