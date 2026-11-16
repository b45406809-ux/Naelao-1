import { DurableObject } from "cloudflare:workers";
import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
import { WORKFLOW_CLASS_POLICIES, isTerminalWorkflow, validateDurableWorkflowIdentity, validateWorkflowPointer,
  resolveExtensionJobResourceRequest, resolveExtensionObjectResourceRequest, resolveExtensionStructuredDataRequest, type DurableJobOperationReceipt, type DurableObjectOperationReceipt,
  type DurableResourceOperationReceipt, type DurableStructuredDataOperationReceipt, type DurableWorkflowIdentity,
  type WorkflowCheckpointPointer, type DurableWorkflowStatus } from "@naelao/agent-sdk";
import { WorkflowJournal, type WorkflowJournalStorage, type WorkflowJournalRecord } from "../workflows/workflow-state.js";
import { putWorkflowArtifact, readWorkflowArtifact, readWorkflowGrant, resolveApprovedObjectGrant, resolveApprovedStructuredDataGrant,
  resolveApprovedJobsGrant, workflowHash, workflowHeaders, type DurableWorkflowHostEnv } from "../workflows/workflow-host.js";
import { finalizeWorkflowBudget, reserveWorkflowBudget, reportWorkflowResourceUsage, reportWorkflowStepInfraUsage } from "../workflows/report-infra-usage.js";
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
  async initialize(identity: DurableWorkflowIdentity, input: WorkflowCheckpointPointer, budget: { budgetKey?: string; budgetCredits?: number;
    installationBudgetCredits?: number; installationBudgetRevision?: number }): Promise<void> {
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
    if (record.identity.expiresAt <= Date.now()) {
      if (!isTerminalWorkflow(record.status)) {
        await this.journal.transition("expired");
        await this.cleanup();
      }
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
      { ...(record.identity.projectId ? { projectId: record.identity.projectId } : {}), ...(record.identity.installationId ? { installationId: record.identity.installationId } : {}),
        ...(record.installationBudgetCredits !== undefined ? { installationBudgetCredits: record.installationBudgetCredits } : {}),
        ...(record.installationBudgetRevision !== undefined ? { installationBudgetRevision: record.installationBudgetRevision } : {}) });
    try { await this.authorize(record.identity.runId); }
    catch (error) {
      await finalizeWorkflowBudget(this.env as Env, record.identity.tenantId, record.identity.runId, "release");
      throw error;
    }
    const binding = wrapWorkflowBinding({ tenantId: record.identity.tenantId, spaceId: record.identity.spaceId, runId: record.identity.runId }, { bindingName: "AGENT_SCRIPT_WORKFLOW" });
    try {
      await binding.create({ id: record.identity.runId, params: { runId: record.identity.runId } });
    } catch (error) {
      // Reconcile a lost create reply using the provider's stable instance ID.
      try { await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).status(); }
      catch { await this.journal.transition("failed", undefined, "workflow_start_failed"); await this.cleanup(); throw error; }
    }
    await this.journal.patch({ launched: true });
    try { await this.authorize(record.identity.runId); }
    catch (error) {
      await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).terminate().catch(() => undefined);
      const current = await this.journal.read();
      if (!isTerminalWorkflow(current.status)) await this.journal.transition("failed", undefined, "workflow_launch_authorization_revoked");
      await this.cleanup();
      throw error;
    }
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
  async putArtifact(runId: string, value: unknown): Promise<WorkflowCheckpointPointer> {
    const identity = await this.authorize(runId);
    return putWorkflowArtifact(this.env, identity, value, async (pointer) => {
      validateWorkflowPointer(identity, pointer);
      await this.journal.reserveArtifact(pointer);
    });
  }
  async readArtifact(runId: string, pointer: WorkflowCheckpointPointer): Promise<unknown> { return readWorkflowArtifact(this.env, await this.authorize(runId), pointer); }
  async effect(runId: string, key: string, operation: string, params: Record<string, unknown>): Promise<unknown> {
    const identity = await this.authorize(runId);
    if (isTerminalWorkflow((await this.journal.read()).status)) throw new Error("workflow_already_terminal");
    if (!identity.capabilities.includes(operation) || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(operation)) throw new Error("workflow_capability_denied");
    const json = JSON.stringify(params);
    if (!json || new TextEncoder().encode(json).byteLength > 262144) throw new Error("workflow_effect_input_limit");
    const inputDigest = await workflowHash(json);
    let gadgetOperation = operation.match(/^extension\.gadget\.(list|get|insert|update|delete)$/)?.[1];
    let gadgetId = typeof params.gadget_id === "string" ? params.gadget_id : "";
    let table = typeof params.table === "string" ? params.table : "";
    let approvedResourceGrant: Awaited<ReturnType<typeof resolveApprovedStructuredDataGrant>> = null;
    let approvedObjectGrant: Awaited<ReturnType<typeof resolveApprovedObjectGrant>> = null;
    let approvedJobsGrant: Awaited<ReturnType<typeof resolveApprovedJobsGrant>> = null;
    let resolvedObject: ReturnType<typeof resolveExtensionObjectResourceRequest> = null;
    let resolvedJob: ReturnType<typeof resolveExtensionJobResourceRequest> = null;
    let resourceMetering: { unit: "request" | "byte" | "job"; units: number } | null = null;
    if (operation === "extension.resource.structured_data" && identity.workflowClass === "vertical_extension" && identity.definitionId) {
      const grant = await readWorkflowGrant(this.env, identity);
      const requirementId = typeof params.requirement_id === "string" ? params.requirement_id : "";
      const operationId = typeof params.operation === "string" ? params.operation : "";
      const resolved = resolveExtensionStructuredDataRequest({ manifest: grant.installation?.manifest ?? {}, workflowId: identity.definitionId,
        requirementId, operationId, input: params.input });
      if (!resolved) throw new Error("workflow_structured_data_grant_invalid");
      approvedResourceGrant = await resolveApprovedStructuredDataGrant(grant.installation, requirementId, operationId, resolved.table);
      if (!approvedResourceGrant) throw new Error("workflow_structured_data_owner_grant_required");
      const declaration = grant.installation?.manifest.resourceRequirements?.find(item => item.id === requirementId && item.kind === "structured_data")
        ?.operations.find(item => item.id === operationId);
      if (!declaration) throw new Error("workflow_structured_data_operation_not_declared");
      const inputBytes = new TextEncoder().encode(JSON.stringify(params.input)).byteLength;
      resourceMetering = { unit: declaration.meteringUnit, units: declaration.meteringUnit === "byte" ? inputBytes : 1 };
      gadgetOperation = resolved.gadgetOperation.slice("extension.gadget.".length);
      gadgetId = resolved.gadgetId;
      table = resolved.table;
    }
    if (operation === "extension.resource.objects" && identity.workflowClass === "vertical_extension" && identity.definitionId) {
      const grant = await readWorkflowGrant(this.env, identity);
      const requirementId = typeof params.requirement_id === "string" ? params.requirement_id : "";
      const operationId = typeof params.operation === "string" ? params.operation : "";
      resolvedObject = resolveExtensionObjectResourceRequest({ manifest: grant.installation?.manifest ?? {}, workflowId: identity.definitionId,
        requirementId, operationId, input: params.input });
      if (!resolvedObject) throw new Error("workflow_object_resource_request_invalid");
      approvedObjectGrant = await resolveApprovedObjectGrant(grant.installation, requirementId, operationId);
      if (!approvedObjectGrant) throw new Error("workflow_object_resource_owner_grant_required");
      resourceMetering = { unit: resolvedObject.operation.meteringUnit,
        units: new TextEncoder().encode(JSON.stringify(params.input)).byteLength };
    }
    if (operation === "extension.resource.jobs" && identity.workflowClass === "vertical_extension" && identity.definitionId) {
      const grant = await readWorkflowGrant(this.env, identity);
      const requirementId = typeof params.requirement_id === "string" ? params.requirement_id : "";
      const operationId = typeof params.operation === "string" ? params.operation : "";
      resolvedJob = resolveExtensionJobResourceRequest({ manifest: grant.installation?.manifest ?? {}, workflowId: identity.definitionId,
        requirementId, operationId, input: params.input });
      if (!resolvedJob) throw new Error("workflow_job_resource_request_invalid");
      approvedJobsGrant = await resolveApprovedJobsGrant(grant.installation, requirementId, operationId, resolvedJob.targetWorkflowId);
      if (!approvedJobsGrant) throw new Error("workflow_job_resource_owner_grant_required");
      const declaration = grant.installation?.manifest.resourceRequirements?.find(item => item.id === requirementId && item.kind === "jobs")
        ?.operations.find(item => item.id === operationId);
      if (!declaration) throw new Error("workflow_job_resource_operation_not_declared");
      const inputBytes = new TextEncoder().encode(JSON.stringify(params.input)).byteLength;
      resourceMetering = { unit: declaration.meteringUnit, units: declaration.meteringUnit === "job" ? 1 : inputBytes };
    }
    let resourceReceipt: DurableResourceOperationReceipt | undefined;
    if (gadgetOperation
      && identity.workflowClass === "vertical_extension" && identity.projectId && identity.installationId
      && /^[a-z][a-z0-9_-]{1,63}$/.test(gadgetId) && /^[a-z][a-z0-9_-]{0,62}$/.test(table)) {
      resourceReceipt = { kind: "structured_data", installationId: identity.installationId, projectId: identity.projectId, principalId: identity.actorId,
        gadgetId, table, operation: gadgetOperation as DurableStructuredDataOperationReceipt["operation"], requestSha256: inputDigest,
        requestBytes: new TextEncoder().encode(json).byteLength, status: "prepared", preparedAt: Date.now(),
        ...(approvedResourceGrant ? { manifestSha256: approvedResourceGrant.manifest_sha256,
          resourceSha256: approvedResourceGrant.resource_sha256, installationGeneration: approvedResourceGrant.installation_generation,
          grantRevision: approvedResourceGrant.revision } : {}),
        ...(resourceMetering ? { meteringUnit: resourceMetering.unit, meteredUnits: resourceMetering.units } : {}) };
    } else if (resolvedObject && approvedObjectGrant && identity.workflowClass === "vertical_extension" && identity.projectId && identity.installationId) {
      resourceReceipt = { kind: "objects", installationId: identity.installationId, projectId: identity.projectId, principalId: identity.actorId,
        requirementId: String(params.requirement_id), objectKeySha256: await workflowHash(resolvedObject.key), operation: resolvedObject.operation.id as DurableObjectOperationReceipt["operation"],
        requestSha256: inputDigest, requestBytes: new TextEncoder().encode(json).byteLength, status: "prepared", preparedAt: Date.now(),
        manifestSha256: approvedObjectGrant.manifest_sha256, resourceSha256: approvedObjectGrant.resource_sha256,
        installationGeneration: approvedObjectGrant.installation_generation, grantRevision: approvedObjectGrant.revision,
        ...(resourceMetering ? { meteringUnit: resourceMetering.unit, meteredUnits: resourceMetering.units } : {}) };
    } else if (resolvedJob && approvedJobsGrant && identity.workflowClass === "vertical_extension" && identity.projectId && identity.installationId) {
      const operationId = String(params.operation) as DurableJobOperationReceipt["operation"];
      resourceReceipt = { kind: "jobs", installationId: identity.installationId, projectId: identity.projectId, principalId: identity.actorId,
        requirementId: String(params.requirement_id), operation: operationId,
        ...(resolvedJob.targetWorkflowId ? { targetWorkflowId: resolvedJob.targetWorkflowId } : {}),
        ...(resolvedJob.jobId ? { jobIdSha256: await workflowHash(resolvedJob.jobId) } : {}),
        requestSha256: inputDigest, requestBytes: new TextEncoder().encode(json).byteLength, status: "prepared", preparedAt: Date.now(),
        manifestSha256: approvedJobsGrant.manifest_sha256, resourceSha256: approvedJobsGrant.resource_sha256,
        installationGeneration: approvedJobsGrant.installation_generation, grantRevision: approvedJobsGrant.revision,
        ...(resourceMetering ? { meteringUnit: resourceMetering.unit as "request" | "job", meteredUnits: resourceMetering.units } : {}) };
    }
    const { effect, created } = await this.journal.prepareExternalEffect(key, operation, inputDigest, resourceReceipt);
    if (effect.status === "committed" && effect.result) return readWorkflowArtifact(this.env, identity, effect.result);
    let activeEffect = effect;
    if (!created && operation === "extension.resource.jobs" && effect.resourceReceipt?.kind === "jobs") {
      activeEffect = await this.journal.reopenIdempotentJobEffect(effect);
    } else if (!created) {
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
      const pointer = await this.putArtifact(runId, result);
      const credits = await reportWorkflowStepInfraUsage(this.env as Env, identity.tenantId, identity.spaceId, Date.now() - started, runId + ":" + key, false,
        { ...(identity.projectId ? { projectId: identity.projectId } : {}), ...(identity.installationId ? { installationId: identity.installationId } : {}), runId });
      if (resourceReceipt && identity.projectId && identity.installationId) {
        const responseBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
        const requestBytes = resourceReceipt.requestBytes;
        const meteredUnits = resourceReceipt.meteringUnit === "request" ? 1
          : resourceReceipt.meteringUnit === "job" ? 1 : requestBytes + responseBytes;
        await reportWorkflowResourceUsage(this.env as Env, identity.tenantId, identity.spaceId, runId + ":" + key + ":resource-units",
          resourceReceipt.meteringUnit ?? "request", meteredUnits,
          { projectId: identity.projectId, installationId: identity.installationId, runId });
        resourceReceipt.meteredUnits = meteredUnits;
        if (effect.resourceReceipt) effect.resourceReceipt.meteredUnits = meteredUnits;
      }
      // Receipt and measured usage must commit together. If the worker dies after the
      // external effect, replay must neither repeat it nor lose its credits at settlement.
      await this.journal.commitEffect(activeEffect, pointer, credits);
      await this.authorize(runId);
      return result;
    } catch (error) {
      // Keep any already committed receipt intact even if a later grant check fails.
      const checkpoint = await this.ctx.storage.get<{ status: string }>("effect:" + key);
      if (checkpoint?.status !== "committed") await this.journal.markIndeterminate(activeEffect);
      if ((await this.journal.read()).cleanupPending) await this.cleanup();
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
      { ...(record.identity.projectId ? { projectId: record.identity.projectId } : {}), ...(record.identity.installationId ? { installationId: record.identity.installationId } : {}),
        ...(record.installationBudgetCredits !== undefined ? { installationBudgetCredits: record.installationBudgetCredits } : {}),
        ...(record.installationBudgetRevision !== undefined ? { installationBudgetRevision: record.installationBudgetRevision } : {}) });
    try { await this.authorize(record.identity.runId); }
    catch (error) {
      await finalizeWorkflowBudget(this.env as Env, record.identity.tenantId, record.identity.runId, "release");
      throw error;
    }
    await this.journal.retry(WORKFLOW_CLASS_POLICIES[record.identity.workflowClass].maxAttempts);
    await this.journal.patch({ launched: true });
    await this.ctx.storage.setAlarm(record.identity.expiresAt);
    try {
      await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).restart();
    } catch (error) {
      // A restart reply can be lost after the provider accepted it. Reconcile before
      // marking the run failed so a successfully restarted workflow is not duplicated.
      let providerActive = false;
      try {
        const provider = await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).status();
        providerActive = ["queued", "running", "waiting", "sleeping"].includes(provider.status);
      } catch { /* retain the original restart error */ }
      if (!providerActive) {
        await this.journal.transition("failed", undefined, "workflow_retry_start_failed");
        await this.cleanup();
        throw error;
      }
    }
    try { await this.authorize(record.identity.runId); }
    catch (error) {
      await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).terminate().catch(() => undefined);
      const current = await this.journal.read();
      if (!isTerminalWorkflow(current.status)) await this.journal.transition("failed", undefined, "workflow_retry_authorization_revoked");
      await this.cleanup();
      throw error;
    }
  }
  private async assertOwner(actorId: string): Promise<WorkflowJournalRecord> {
    const record = await this.journal.read();
    // Status/cancel remain available to an authorized owner while suspended so work can be
    // inspected or stopped. All execution, resume, retry and effect paths still call authorize().
    const grant = await readWorkflowGrant(this.env, { ...record.identity, actorId }, { allowSuspended: true });
    if (actorId !== record.identity.actorId && !["owner", "admin"].includes(grant.role)) throw new Error("workflow_owner_required");
    return record;
  }
  private async cleanup(): Promise<void> {
    let record = await this.journal.read();
    if (!record.cleanupPending) return;
    // Terminal state is already persisted. Alarms retry cleanup even during provider outages.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    if (["cancelled", "expired"].includes(record.status) && record.launched) {
      if (!this.env.AGENT_SCRIPT_WORKFLOW) throw new Error("workflow_provider_unavailable");
      await (await this.env.AGENT_SCRIPT_WORKFLOW.get(record.identity.runId)).terminate();
    }
    if (record.activeEffects?.length) {
      await this.journal.expireStaleEffects(Date.now() - 60_000);
      record = await this.journal.read();
      if (record.activeEffects?.length) return;
    }
    // Failed/cancelled work may still have completed billable effects. Settle measured use
    // for every terminal state; use the reserved ceiling only when an effect is indeterminate.
    const settlement = record.usageUncertain ? record.budgetCredits : record.usedCredits;
    await finalizeWorkflowBudget(this.env as Env, record.identity.tenantId, record.identity.reservationId, "settle", settlement);
    await this.journal.patch({ cleanupPending: false });
    if (record.identity.expiresAt > Date.now()) await this.ctx.storage.setAlarm(record.identity.expiresAt);
    else {
      await this.deleteExpiredArtifacts(record.identity);
      await this.ctx.storage.deleteAlarm();
    }
  }
  async alarm(): Promise<void> {
    const record = await this.journal.read();
    if (!isTerminalWorkflow(record.status) && record.identity.expiresAt <= Date.now()) await this.journal.transition("expired");
    await this.cleanup();
    const latest = await this.journal.read();
    if (isTerminalWorkflow(latest.status) && latest.identity.expiresAt <= Date.now() && !latest.cleanupPending) {
      await this.deleteExpiredArtifacts(latest.identity);
      await this.ctx.storage.deleteAlarm();
    }
  }
  private async deleteExpiredArtifacts(identity: DurableWorkflowIdentity): Promise<void> {
    const bucket = this.env.SCRIPTS_R2;
    if (!bucket) throw new Error("workflow_artifacts_unavailable");
    const prefix = "workflow-artifacts/" + identity.tenantId + "/" + identity.spaceId + "/" + identity.runId + "/";
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 256 });
      if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
      if (page.truncated && !page.cursor) throw new Error("workflow_artifact_cleanup_cursor_missing");
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    // The run record remains as a replay tombstone, but effect receipts are no longer
    // needed once all artifact reads and retries have expired.
    while (true) {
      const effects = await this.ctx.storage.list({ prefix: "effect:", limit: 1_000 });
      if (effects.size === 0) break;
      await this.ctx.storage.delete([...effects.keys()]);
    }
  }
}
