import { DurableObject } from "cloudflare:workers";
import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
import { WORKFLOW_CLASS_POLICIES, isTerminalWorkflow, validateDurableWorkflowIdentity, validateWorkflowPointer, type DurableWorkflowIdentity, type WorkflowCheckpointPointer, type DurableWorkflowStatus } from "@naelao/agent-sdk";
import { WorkflowJournal, type WorkflowJournalStorage, type WorkflowJournalRecord } from "../workflows/workflow-state.js";
import { putWorkflowArtifact, readWorkflowArtifact, readWorkflowGrant, workflowHash, workflowHeaders, type DurableWorkflowHostEnv } from "../workflows/workflow-host.js";
import { finalizeWorkflowBudget, reserveWorkflowBudget, reportWorkflowStepInfraUsage } from "../workflows/report-infra-usage.js";
import type { Env } from "../env.js";
import { readBoundedResponseText } from "../shared/bounded-response-text.js";

/** One persisted journal per scoped run. The core SpaceDO never executes developer code. */
export class WorkflowRunDO extends DurableObject<DurableWorkflowHostEnv> {
  private journal: WorkflowJournal;
  constructor(ctx: DurableObjectState, env: DurableWorkflowHostEnv) {
    super(ctx, env);
    this.journal = new WorkflowJournal(ctx.storage as unknown as WorkflowJournalStorage);
  }
  async existing(): Promise<WorkflowJournalRecord | null> {
    try { return await this.journal.read(); } catch (error) { if (error instanceof Error && error.message === "workflow_not_found") return null; throw error; }
  }
  async initialize(identity: DurableWorkflowIdentity, input: WorkflowCheckpointPointer, budget: { budgetKey?: string; budgetCredits?: number }): Promise<void> {
    validateDurableWorkflowIdentity(identity);
    validateWorkflowPointer(identity, input);
    const grant = await readWorkflowGrant(this.env, identity);
    if (grant.version !== identity.grantVersion) throw new Error("workflow_grant_revoked");
    await this.journal.initialize(identity, input, budget);
    await this.ctx.storage.setAlarm(identity.expiresAt);
  }
  async authorize(runId: string): Promise<DurableWorkflowIdentity> {
    const record = await this.journal.read();
    if (record.identity.runId !== runId) throw new Error("workflow_run_scope_mismatch");
    if (record.identity.expiresAt <= Date.now() && !isTerminalWorkflow(record.status)) {
      await this.journal.transition("expired");
      await this.cleanup();
      throw new Error("workflow_expired");
    }
    if (["cancelled", "expired"].includes(record.status)) throw new Error("workflow_" + record.status);
    const grant = await readWorkflowGrant(this.env, record.identity);
    if (grant.version !== record.identity.grantVersion) throw new Error("workflow_grant_revoked");
    return record.identity;
  }
  async launch(): Promise<void> {
    const record = await this.journal.read();
    if (isTerminalWorkflow(record.status) || record.launched) return;
    await this.authorize(record.identity.runId);
    if (!this.env.AGENT_SCRIPT_WORKFLOW) throw new Error("workflow_provider_unavailable");
    await reserveWorkflowBudget(this.env as Env, record.identity.tenantId, record.identity.spaceId, record.identity.runId, record.budgetKey, record.budgetCredits, record.identity.expiresAt,
      { ...(record.identity.projectId ? { projectId: record.identity.projectId } : {}), ...(record.identity.installationId ? { installationId: record.identity.installationId } : {}) });
    const binding = wrapWorkflowBinding({ tenantId: record.identity.tenantId, spaceId: record.identity.spaceId, runId: record.identity.runId }, { bindingName: "AGENT_SCRIPT_WORKFLOW" });
    try {
      await binding.create({ id: record.identity.runId, params: { runId: record.identity.runId } });
    } catch (error) {
      // Reconcile a lost create reply using the provider's stable instance ID.
      try { await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).status(); }
      catch { await this.journal.transition("failed", undefined, "workflow_start_failed"); await this.cleanup(); throw error; }
    }
    await this.journal.patch({ launched: true });
    const latest = await this.journal.read();
    if (["cancelled", "expired"].includes(latest.status)) await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).terminate();
  }
  async state(runId: string, status: "running" | "sleeping" | "waiting"): Promise<void> {
    await this.authorize(runId);
    await this.journal.transition(status);
  }
  async input(runId: string): Promise<unknown> { const identity = await this.authorize(runId); return readWorkflowArtifact(this.env, identity, (await this.journal.read()).input); }
  async claimAgentRun(runId: string, taskId: string): Promise<boolean> {
    await this.authorize(runId);
    const prepared = await this.journal.prepareEffect("agent-run", "agent.run", await workflowHash(taskId));
    return prepared.created;
  }
  async putArtifact(runId: string, value: unknown): Promise<WorkflowCheckpointPointer> { return putWorkflowArtifact(this.env, await this.authorize(runId), value); }
  async readArtifact(runId: string, pointer: WorkflowCheckpointPointer): Promise<unknown> { return readWorkflowArtifact(this.env, await this.authorize(runId), pointer); }
  async effect(runId: string, key: string, operation: string, params: Record<string, unknown>): Promise<unknown> {
    const identity = await this.authorize(runId);
    if (isTerminalWorkflow((await this.journal.read()).status)) throw new Error("workflow_already_terminal");
    if (!identity.capabilities.includes(operation) || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(operation)) throw new Error("workflow_capability_denied");
    const json = JSON.stringify(params);
    if (!json || new TextEncoder().encode(json).byteLength > 262144) throw new Error("workflow_effect_input_limit");
    const { effect, created } = await this.journal.prepareEffect(key, operation, await workflowHash(json));
    if (effect.status === "committed" && effect.result) return readWorkflowArtifact(this.env, identity, effect.result);
    if (!created) {
      // A prepared receipt after a crash proves neither failure nor success. Never repeat it.
      throw new Error("workflow_effect_reconciliation_required:" + key);
    }
    const started = Date.now();
    try {
      if (!this.env.AGENTS_WORKER) throw new Error("workflow_effect_host_unavailable");
      const response = await this.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workflows/effect", {
        method: "POST", headers: await workflowHeaders(this.env, identity.tenantId, identity.actorId),
        body: JSON.stringify({ identity, key, operation, params, idempotencyKey: runId + ":" + key }),
      }));
      if (!response.ok) throw new Error("workflow_effect_failed:" + response.status);
      let result: unknown;
      try { result = JSON.parse(await readBoundedResponseText(response, 4 * 1024 * 1024)); }
      catch { throw new Error("workflow_effect_result_invalid_or_too_large"); }
      const pointer = await putWorkflowArtifact(this.env, identity, result);
      await this.journal.commitEffect(effect, pointer);
      const credits = await reportWorkflowStepInfraUsage(this.env as Env, identity.tenantId, identity.spaceId, Date.now() - started, runId + ":" + key, false,
        { ...(identity.projectId ? { projectId: identity.projectId } : {}), ...(identity.installationId ? { installationId: identity.installationId } : {}), runId });
      await this.journal.addUsedCredits(credits);
      await this.authorize(runId);
      return result;
    } catch (error) {
      // Keep any already committed receipt intact even if a later grant check fails.
      const checkpoint = await this.ctx.storage.get<{ status: string }>("effect:" + key);
      if (checkpoint?.status !== "committed") await this.journal.markIndeterminate(effect);
      throw error;
    }
  }
  async finish(runId: string, status: "succeeded" | "failed", value: WorkflowCheckpointPointer | string): Promise<void> {
    const record = await this.journal.read();
    if (record.identity.runId !== runId) throw new Error("workflow_run_scope_mismatch");
    if (status === "succeeded") { await this.authorize(runId); if (typeof value === "string") throw new Error("workflow_result_pointer_required"); validateWorkflowPointer(record.identity, value); }
    if (!isTerminalWorkflow(record.status)) await this.journal.transition(status, typeof value === "string" ? undefined : value, typeof value === "string" ? value.slice(0, 2000) : undefined);
    await this.cleanup();
  }
  async status(actorId: string): Promise<WorkflowJournalRecord> {
    const record = await this.assertOwner(actorId);
    // Reconcile provider-side terminal failures (including loader/compilation failures).
    if (record.launched && !isTerminalWorkflow(record.status) && this.env.AGENT_SCRIPT_WORKFLOW) {
      const provider = await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).status();
      if (["errored", "terminated"].includes(provider.status)) { await this.journal.transition(provider.status === "terminated" ? "cancelled" : "failed", undefined, "workflow_provider_" + provider.status); await this.cleanup(); }
    }
    return this.journal.read();
  }
  async signal(actorId: string, type: string, payload: unknown): Promise<void> {
    const record = await this.assertOwner(actorId);
    await this.authorize(record.identity.runId);
    if (isTerminalWorkflow(record.status) || !/^[A-Za-z0-9._:-]{1,100}$/.test(type)) throw new Error("workflow_signal_invalid");
    if (!this.env.AGENT_SCRIPT_WORKFLOW) throw new Error("workflow_provider_unavailable");
    const pointer = await this.putArtifact(record.identity.runId, payload);
    await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).sendEvent({ type, payload: pointer });
  }
  async cancel(actorId: string): Promise<void> {
    const record = await this.assertOwner(actorId);
    if (!isTerminalWorkflow(record.status)) await this.journal.transition("cancelled");
    await this.cleanup();
  }
  async retry(actorId: string): Promise<void> {
    const record = await this.assertOwner(actorId);
    await this.authorize(record.identity.runId);
    if (!this.env.AGENT_SCRIPT_WORKFLOW) throw new Error("workflow_provider_unavailable");
    // Reserve before changing failed -> queued. A billing outage must leave the run
    // retryable instead of stranding it in a queued state with no provider restart.
    await reserveWorkflowBudget(this.env as Env, record.identity.tenantId, record.identity.spaceId, record.identity.runId, record.budgetKey, record.budgetCredits, record.identity.expiresAt,
      { ...(record.identity.projectId ? { projectId: record.identity.projectId } : {}), ...(record.identity.installationId ? { installationId: record.identity.installationId } : {}) });
    await this.journal.retry(WORKFLOW_CLASS_POLICIES[record.identity.workflowClass].maxAttempts);
    await this.journal.patch({ launched: true });
    await this.ctx.storage.setAlarm(record.identity.expiresAt);
    try {
      await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).restart();
    } catch (error) {
      // A restart reply can be lost after the provider accepted it. Reconcile before
      // marking the run failed so a successfully restarted workflow is not duplicated.
      try {
        const provider = await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).status();
        if (["queued", "running", "waiting", "sleeping"].includes(provider.status)) return;
      } catch { /* retain the original restart error */ }
      await this.journal.transition("failed", undefined, "workflow_retry_start_failed");
      await this.cleanup();
      throw error;
    }
  }
  private async assertOwner(actorId: string): Promise<WorkflowJournalRecord> {
    const record = await this.journal.read();
    const grant = await readWorkflowGrant(this.env, { ...record.identity, actorId });
    if (actorId !== record.identity.actorId && !["owner", "admin"].includes(grant.role)) throw new Error("workflow_owner_required");
    return record;
  }
  private async cleanup(): Promise<void> {
    const record = await this.journal.read();
    if (!record.cleanupPending) return;
    // Terminal state is already persisted. Alarms retry cleanup even during provider outages.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    if (["cancelled", "expired"].includes(record.status) && record.launched) {
      if (!this.env.AGENT_SCRIPT_WORKFLOW) throw new Error("workflow_provider_unavailable");
      await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).terminate();
    }
    await finalizeWorkflowBudget(this.env as Env, record.identity.tenantId, record.identity.reservationId, record.status === "succeeded" ? "settle" : "release", record.usedCredits);
    await this.journal.patch({ cleanupPending: false });
    await this.ctx.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    const record = await this.journal.read();
    if (!isTerminalWorkflow(record.status) && record.identity.expiresAt <= Date.now()) await this.journal.transition("expired");
    await this.cleanup();
  }
}
