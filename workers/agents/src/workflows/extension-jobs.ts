import { durableWorkflowRunId, serializeWorkflowCheckpoint, type DurableWorkflowIdentity } from "@naelao/agent-sdk";
import { finalizeWorkflowBudget, reserveWorkflowBudget } from "./report-infra-usage.js";
import { readWorkflowGrant, resolveApprovedJobsGrant, resolveExtensionResourceBudget, startDurableWorkflow, workflowHash, workflowRunStub,
  type DurableWorkflowHostEnv, type WorkflowInstallationGrant } from "./workflow-host.js";
import type { WorkflowJournalRecord } from "./workflow-state.js";

export interface ExtensionJobQueueMessage { kind: "extension_job"; tenantId: string; spaceId: string; jobId: string }
export interface ExtensionJobScope extends Pick<DurableWorkflowIdentity, "tenantId" | "spaceId" | "projectId" | "installationId" | "actorId" | "agentId" | "runId" | "definitionId" | "workflowClass"> {}
export interface ExtensionJobEnvironment extends DurableWorkflowHostEnv {
  PLATFORM_DB?: D1Database;
  SCRIPTS_R2?: R2Bucket;
  AGENT_TICKS?: { send(message: ExtensionJobQueueMessage): Promise<unknown> };
}
export interface ResolvedExtensionJobEnqueue { targetWorkflowId: string; params: Record<string, unknown>; deadlineSeconds?: number }
interface JobRow {
  job_id: string; tenant_id: string; space_id: string; project_id: string; installation_id: string; extension_id: string;
  release_version: string; artifact_sha256: string;
  requirement_id: string; manifest_sha256: string; resource_sha256: string; installation_generation: number; grant_revision: number;
  actor_id: string; agent_id: string; caller_workflow_id: string; parent_run_id: string; effect_key: string;
  idempotency_key_sha256: string; request_sha256: string; workflow_id: string; child_start_key: string;
  payload_key: string; payload_sha256: string; payload_bytes: number; deadline_at: number; status: string;
  dispatch_attempts: number; dispatch_lease_until: number | null; workflow_run_id: string | null; error_code: string | null;
  created_at: number; updated_at: number; started_at: number | null; completed_at: number | null;
}

const MAX_JOB_DISPATCH_ATTEMPTS = 5;
const DEFAULT_JOB_DEADLINE_SECONDS = 3600;
const JOB_DISPATCH_LEASE_MS = 60_000;

function requireJobServices(env: ExtensionJobEnvironment): { db: D1Database; bucket: R2Bucket; queue: NonNullable<ExtensionJobEnvironment["AGENT_TICKS"]> } {
  if (!env.PLATFORM_DB) throw new Error("workflow_job_ledger_unavailable");
  if (!env.SCRIPTS_R2) throw new Error("workflow_job_payload_storage_unavailable");
  if (!env.AGENT_TICKS) throw new Error("workflow_job_queue_unavailable");
  return { db: env.PLATFORM_DB, bucket: env.SCRIPTS_R2, queue: env.AGENT_TICKS };
}

function assertProjectJobScope(identity: ExtensionJobScope): asserts identity is ExtensionJobScope & { projectId: string; installationId: string; definitionId: string } {
  if (!identity.projectId || !identity.installationId || !identity.definitionId || identity.workflowClass !== "vertical_extension")
    throw new Error("workflow_job_project_install_scope_required");
}

function rowScopeMatches(row: JobRow, identity: ExtensionJobScope, requirementId: string): boolean {
  return row.tenant_id === identity.tenantId && row.space_id === identity.spaceId && row.project_id === identity.projectId
    && row.installation_id === identity.installationId && row.requirement_id === requirementId && row.actor_id === identity.actorId;
}

function publicStatus(row: JobRow): { jobId: string; status: string; attempt: number } {
  return { jobId: row.job_id, status: row.status, attempt: Math.min(MAX_JOB_DISPATCH_ATTEMPTS, Math.max(0, row.dispatch_attempts)) };
}

async function childWorkflowId(identity: ExtensionJobScope, extensionId: string, targetWorkflowId: string, startKey: string): Promise<string> {
  return durableWorkflowRunId({ tenantId: identity.tenantId, spaceId: identity.spaceId, projectId: identity.projectId!,
    actorId: identity.actorId, installationId: identity.installationId!, extensionId, definitionId: targetWorkflowId }, startKey);
}

function payloadKey(scopeHash: string, jobId: string): string { return `extension-resource-jobs/${scopeHash}/${jobId}/input.json`; }

async function readJob(db: D1Database, jobId: string, tenantId: string, spaceId: string): Promise<JobRow | null> {
  return db.prepare(`SELECT * FROM extension_resource_jobs WHERE job_id=? AND tenant_id=? AND space_id=?`)
    .bind(jobId, tenantId, spaceId).first<JobRow>();
}

async function queueJob(queue: NonNullable<ExtensionJobEnvironment["AGENT_TICKS"]>, row: Pick<JobRow, "tenant_id" | "space_id" | "job_id">): Promise<void> {
  await queue.send({ kind: "extension_job", tenantId: row.tenant_id, spaceId: row.space_id, jobId: row.job_id });
}

export async function enqueueExtensionJob(env: ExtensionJobEnvironment, input: {
  identity: ExtensionJobScope; requirementId: string; effectKey: string; idempotencyKey: string;
  resolved: ResolvedExtensionJobEnqueue; installation: WorkflowInstallationGrant; grant: NonNullable<NonNullable<WorkflowInstallationGrant["resource_grants"]>[number]>;
}): Promise<{ jobId: string; status: string }> {
  assertProjectJobScope(input.identity);
  const { db, bucket, queue } = requireJobServices(env);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.idempotencyKey) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.effectKey))
    throw new Error("workflow_job_idempotency_key_invalid");
  const requestJson = serializeWorkflowCheckpoint(input.resolved.params, 65_536);
  const requestBytes = new TextEncoder().encode(requestJson).byteLength;
  if (requestBytes < 2 || requestBytes > 65_536) throw new Error("workflow_job_payload_limit");
  const payloadSha256 = await workflowHash(requestJson);
  const requestSha256 = await workflowHash(JSON.stringify([input.resolved.targetWorkflowId, requestJson,
    input.resolved.deadlineSeconds ?? DEFAULT_JOB_DEADLINE_SECONDS]));
  const idempotencySha256 = await workflowHash(input.idempotencyKey);
  const identityKey = await workflowHash(JSON.stringify([input.identity.tenantId, input.identity.spaceId, input.identity.projectId,
    input.identity.installationId, input.requirementId, input.identity.actorId, idempotencySha256]));
  const jobId = `job-${identityKey}`;
  const existing = await db.prepare(`SELECT * FROM extension_resource_jobs WHERE tenant_id=? AND space_id=? AND project_id=?
    AND installation_id=? AND requirement_id=? AND actor_id=? AND idempotency_key_sha256=? LIMIT 1`)
    .bind(input.identity.tenantId, input.identity.spaceId, input.identity.projectId, input.identity.installationId,
      input.requirementId, input.identity.actorId, idempotencySha256).first<JobRow>();
  if (existing) {
    if (existing.request_sha256 !== requestSha256) throw new Error("workflow_job_idempotency_conflict");
    if (["queued", "unknown", "dispatching"].includes(existing.status)) await queueJob(queue, existing);
    // The enqueue receipt is stable across concurrent replay; the separate status operation
    // reports whether dispatch later advanced or terminated the row.
    return { jobId: existing.job_id, status: "queued" };
  }

  const requirement = input.installation.manifest.resourceRequirements?.find(item => item.id === input.requirementId && item.kind === "jobs");
  const budget = resolveExtensionResourceBudget(input.installation, undefined);
  if (!requirement || !budget) throw new Error("workflow_job_budget_or_requirement_unavailable");
  const release = input.installation.release;
  if (release?.signatureValid !== true || !release.version || !/^[a-f0-9]{64}$/.test(release.artifactSha256 ?? ""))
    throw new Error("workflow_job_signed_release_required");
  const maxConcurrent = requirement.limits.maxConcurrent;
  const requestsPerMinute = requirement.limits.requestsPerMinute;
  const deadlineSeconds = input.resolved.deadlineSeconds ?? DEFAULT_JOB_DEADLINE_SECONDS;
  const deadlineAt = Date.now() + deadlineSeconds * 1000;
  const extensionId = input.installation.manifest.id;
  const childStartKey = `extension-job:${jobId}`;
  const workflowRunId = await childWorkflowId(input.identity, extensionId, input.resolved.targetWorkflowId, childStartKey);
  const scopeHash = await workflowHash(JSON.stringify([input.identity.tenantId, input.identity.spaceId, input.identity.projectId, input.identity.installationId]));
  const inputPayloadKey = payloadKey(scopeHash, jobId);
  await bucket.put(inputPayloadKey, requestJson, { httpMetadata: { contentType: "application/json" } });
  let reserved = false;
  try {
    // Attempt release even if Billing accepted the reservation but its reply was lost.
    reserved = true;
    await reserveWorkflowBudget(env as never, input.identity.tenantId, input.identity.spaceId, workflowRunId, undefined,
      budget.runCredits, deadlineAt, { projectId: input.identity.projectId, installationId: input.identity.installationId,
        installationBudgetCredits: budget.monthlyCredits, installationBudgetRevision: budget.revision });
    const now = Date.now();
    const manifestSha256 = input.grant.manifest_sha256;
    const resourceSha256 = input.grant.resource_sha256;
    const result = await db.prepare(`INSERT OR IGNORE INTO extension_resource_jobs (
      job_id,tenant_id,space_id,project_id,installation_id,extension_id,release_version,artifact_sha256,requirement_id,manifest_sha256,resource_sha256,
      installation_generation,grant_revision,actor_id,agent_id,caller_workflow_id,parent_run_id,effect_key,
      idempotency_key_sha256,request_sha256,workflow_id,child_start_key,payload_key,payload_sha256,payload_bytes,
      deadline_at,status,dispatch_attempts,workflow_run_id,created_at,updated_at
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',0,?,?,? WHERE
      (SELECT COUNT(*) FROM extension_resource_jobs WHERE tenant_id=? AND space_id=? AND project_id=? AND installation_id=?
        AND requirement_id=? AND status IN ('queued','dispatching','running','unknown') AND deadline_at>?) < ?
      AND (SELECT COUNT(*) FROM extension_resource_jobs WHERE tenant_id=? AND space_id=? AND project_id=? AND installation_id=?
        AND requirement_id=? AND created_at>=?) < ?`)
      .bind(jobId, input.identity.tenantId, input.identity.spaceId, input.identity.projectId, input.identity.installationId,
        extensionId, release.version, release.artifactSha256, input.requirementId, manifestSha256, resourceSha256, input.grant.installation_generation, input.grant.revision,
        input.identity.actorId, input.identity.agentId, input.identity.definitionId, input.identity.runId, input.effectKey,
        idempotencySha256, requestSha256, input.resolved.targetWorkflowId, childStartKey, inputPayloadKey, payloadSha256, requestBytes,
        deadlineAt, workflowRunId, now, now,
        input.identity.tenantId, input.identity.spaceId, input.identity.projectId, input.identity.installationId, input.requirementId, now,
        maxConcurrent, input.identity.tenantId, input.identity.spaceId, input.identity.projectId, input.identity.installationId,
        input.requirementId, now - 60_000, requestsPerMinute).run();
    const inserted = Number(result.meta?.changes ?? 0) > 0;
    const current = inserted ? await readJob(db, jobId, input.identity.tenantId, input.identity.spaceId)
      : await db.prepare(`SELECT * FROM extension_resource_jobs WHERE tenant_id=? AND space_id=? AND project_id=? AND installation_id=?
        AND requirement_id=? AND actor_id=? AND idempotency_key_sha256=? LIMIT 1`)
        .bind(input.identity.tenantId, input.identity.spaceId, input.identity.projectId, input.identity.installationId,
          input.requirementId, input.identity.actorId, idempotencySha256).first<JobRow>();
    if (!current) {
      await finalizeWorkflowBudget(env as never, input.identity.tenantId, workflowRunId, "release");
      await bucket.delete(inputPayloadKey);
      throw new Error("workflow_job_admission_limit");
    }
    if (current.request_sha256 !== requestSha256) throw new Error("workflow_job_idempotency_conflict");
    await queueJob(queue, current);
    return { jobId: current.job_id, status: "queued" };
  } catch (error) {
    if (reserved) {
      const persisted = await readJob(db, jobId, input.identity.tenantId, input.identity.spaceId).catch(() => null);
      if (!persisted) await finalizeWorkflowBudget(env as never, input.identity.tenantId, workflowRunId, "release").catch(() => undefined);
    }
    const persisted = await readJob(db, jobId, input.identity.tenantId, input.identity.spaceId).catch(() => null);
    if (!persisted) await bucket.delete(inputPayloadKey).catch(() => undefined);
    throw error;
  }
}

async function updateJob(db: D1Database, row: JobRow, status: string, now: number, errorCode?: string): Promise<void> {
  await db.prepare(`UPDATE extension_resource_jobs SET status=?,updated_at=?,error_code=?,
    completed_at=CASE WHEN ? IN ('succeeded','failed','dead_lettered','cancelled','expired') THEN COALESCE(completed_at,?) ELSE completed_at END,
    dispatch_lease_until=NULL WHERE job_id=? AND tenant_id=? AND space_id=?`)
    .bind(status, now, errorCode ?? null, status, now, row.job_id, row.tenant_id, row.space_id).run();
}

async function deleteJobPayload(env: ExtensionJobEnvironment, row: JobRow): Promise<void> {
  if (env.SCRIPTS_R2) await env.SCRIPTS_R2.delete(row.payload_key).catch(() => undefined);
}

async function readChildStatus(env: ExtensionJobEnvironment, row: JobRow): Promise<WorkflowJournalRecord | null> {
  if (!row.workflow_run_id) return null;
  return workflowRunStub(env, { tenantId: row.tenant_id, spaceId: row.space_id, runId: row.workflow_run_id }).existing();
}
async function pollChildStatus(env: ExtensionJobEnvironment, row: JobRow, existing?: WorkflowJournalRecord | null): Promise<WorkflowJournalRecord | null> {
  if (!row.workflow_run_id) return null;
  const stub = workflowRunStub(env, { tenantId: row.tenant_id, spaceId: row.space_id, runId: row.workflow_run_id });
  const record = existing === undefined ? await stub.existing() : existing;
  if (!record || !record.launched || ["succeeded", "failed", "cancelled", "expired"].includes(record.status)) return record;
  return stub.status(row.actor_id);
}

function statusFromChild(child: WorkflowJournalRecord | null): string | null {
  if (!child) return null;
  if (["succeeded", "failed", "cancelled", "expired"].includes(child.status)) return child.status;
  if (child.status === "queued" && !child.launched) return "dispatching";
  return "running";
}

export async function readExtensionJobStatus(env: ExtensionJobEnvironment, input: { identity: ExtensionJobScope; requirementId: string; jobId: string }): Promise<{ jobId: string; status: string; attempt: number } | null> {
  assertProjectJobScope(input.identity);
  if (!/^job-[a-f0-9]{64}$/.test(input.jobId) || !env.PLATFORM_DB) return null;
  const row = await readJob(env.PLATFORM_DB, input.jobId, input.identity.tenantId, input.identity.spaceId);
  if (!row || !rowScopeMatches(row, input.identity, input.requirementId)) return null;
  if (["succeeded", "failed", "dead_lettered", "cancelled", "expired"].includes(row.status)) {
    await deleteJobPayload(env, row);
    return publicStatus(row);
  }
  if (["queued", "dispatching", "running", "unknown"].includes(row.status)) {
    if (row.deadline_at <= Date.now()) {
      await cancelJob(env, row, "expired", "job_deadline_expired");
      return publicStatus({ ...row, status: "expired" });
    }
    if (!await validateCurrentJobGrant(env, row)) {
      await cancelJob(env, row, "cancelled", "job_grant_revoked_or_changed");
      return publicStatus({ ...row, status: "cancelled" });
    }
  }
  const child = await pollChildStatus(env, row);
  const childStatus = statusFromChild(child);
  if (childStatus && childStatus !== row.status && !["dead_lettered", "cancelled", "expired"].includes(row.status)) {
    await updateJob(env.PLATFORM_DB, row, childStatus, Date.now());
    if (["succeeded", "failed", "cancelled", "expired"].includes(childStatus)) await deleteJobPayload(env, row);
    return publicStatus({ ...row, status: childStatus, updated_at: Date.now() });
  }
  return publicStatus(row);
}

async function cancelJob(env: ExtensionJobEnvironment, row: JobRow, status: "cancelled" | "expired", reason: string): Promise<void> {
  const child = await readChildStatus(env, row);
  if (child && !["succeeded", "failed", "cancelled", "expired"].includes(child.status) && row.workflow_run_id) {
    await workflowRunStub(env, { tenantId: row.tenant_id, spaceId: row.space_id, runId: row.workflow_run_id }).cancel(row.actor_id).catch(() => undefined);
  } else if (!child && row.workflow_run_id) {
    await finalizeWorkflowBudget(env as never, row.tenant_id, row.workflow_run_id, "release").catch(() => undefined);
  }
  await updateJob(env.PLATFORM_DB!, row, status, Date.now(), reason);
  await deleteJobPayload(env, row);
}

function installationMatchesRow(installation: WorkflowInstallationGrant | undefined, row: JobRow): boolean {
  return Boolean(installation && installation.instance.status === "active" && installation.instance.scope === "PROJECT_BOUND"
    && installation.instance.tenant_id === row.tenant_id && installation.instance.space_id === row.space_id
    && installation.instance.project_id === row.project_id && installation.instance.instance_id === row.installation_id
    && installation.instance.generation === row.installation_generation && installation.manifest.id === row.extension_id
    && installation.release?.signatureValid === true && installation.release.version === row.release_version
    && installation.release.artifactSha256 === row.artifact_sha256);
}

async function validateCurrentJobGrant(env: ExtensionJobEnvironment, row: JobRow): Promise<{ installation: WorkflowInstallationGrant; grant: NonNullable<NonNullable<WorkflowInstallationGrant["resource_grants"]>[number]> } | null> {
  const scope: DurableWorkflowIdentity = {
    schema: 1, runId: row.parent_run_id, tenantId: row.tenant_id, spaceId: row.space_id, projectId: row.project_id,
    actorId: row.actor_id, agentId: row.agent_id, installationId: row.installation_id, definitionId: row.caller_workflow_id,
    startKey: row.parent_run_id, expiresAt: row.deadline_at, workflowClass: "vertical_extension", capabilities: [],
    codeDigest: "0".repeat(64), codeKey: "unused", grantVersion: "unused",
  };
  const current = await readWorkflowGrant(env, scope).catch(error => {
    const code = error instanceof Error ? error.message : "";
    if (code.includes("suspended") || code.includes("unavailable")) throw error;
    return null;
  });
  const installation = current?.installation;
  if (!installation || !installationMatchesRow(installation, row)) return null;
  const requirement = installation.manifest.resourceRequirements?.find(item => item.id === row.requirement_id && item.kind === "jobs");
  if (!requirement) return null;
  const grant = await resolveApprovedJobsGrant(installation, row.requirement_id, "enqueue", row.workflow_id);
  if (!grant || grant.manifest_sha256 !== row.manifest_sha256 || grant.resource_sha256 !== row.resource_sha256
    || grant.installation_generation !== row.installation_generation || grant.revision !== row.grant_revision) return null;
  if (!requirement.binding || !("workflowIds" in requirement.binding) || !requirement.binding.workflowIds.includes(row.workflow_id)) return null;
  return { installation, grant };
}

export async function handleExtensionJobTick(env: ExtensionJobEnvironment, message: ExtensionJobQueueMessage): Promise<void> {
  const { db, bucket } = requireJobServices(env);
  let row = await readJob(db, message.jobId, message.tenantId, message.spaceId);
  if (!row || row.status === "succeeded" || row.status === "failed" || row.status === "cancelled" || row.status === "expired" || row.status === "dead_lettered") {
    if (row) await deleteJobPayload(env, row);
    return;
  }
  const now = Date.now();
  const childBefore = await readChildStatus(env, row);
  const childBeforeStatus = statusFromChild(childBefore);
  if (childBeforeStatus && childBeforeStatus !== "running" && childBeforeStatus !== row.status) {
    await updateJob(db, row, childBeforeStatus, now);
    if (["succeeded", "failed", "cancelled", "expired"].includes(childBeforeStatus)) await deleteJobPayload(env, row);
    return;
  }
  if (row.deadline_at <= now) {
    await cancelJob(env, row, "expired", "job_deadline_expired");
    return;
  }
  const current = await validateCurrentJobGrant(env, row);
  if (!current) {
    await cancelJob(env, row, "cancelled", "job_grant_revoked_or_changed");
    return;
  }
  if (row.status === "running") {
    const child = await pollChildStatus(env, row, childBefore);
    const polledStatus = statusFromChild(child);
    if (polledStatus) {
      await updateJob(db, row, polledStatus, now);
      if (["succeeded", "failed", "cancelled", "expired"].includes(polledStatus)) await deleteJobPayload(env, row);
    } else {
      await db.prepare(`UPDATE extension_resource_jobs SET status='unknown',updated_at=? WHERE job_id=? AND status='running'`)
        .bind(now, row.job_id).run();
    }
    return;
  }
  const changed = await db.prepare(`UPDATE extension_resource_jobs SET status='dispatching',dispatch_attempts=dispatch_attempts+1,
      dispatch_lease_until=?,updated_at=? WHERE job_id=? AND tenant_id=? AND space_id=?
      AND status IN ('queued','unknown','dispatching') AND (dispatch_lease_until IS NULL OR dispatch_lease_until<=?) AND dispatch_attempts<?`)
    .bind(now + JOB_DISPATCH_LEASE_MS, now, row.job_id, row.tenant_id, row.space_id, now, MAX_JOB_DISPATCH_ATTEMPTS).run();
  if (Number(changed.meta?.changes ?? 0) < 1) {
    row = await readJob(db, row.job_id, row.tenant_id, row.space_id) ?? row;
    // A duplicate queue delivery can arrive while the final permitted dispatch is
    // still starting the stable child workflow. Exhaustion is terminal only after
    // that attempt's lease expires; otherwise we could dead-letter a live start.
    if (row.dispatch_attempts >= MAX_JOB_DISPATCH_ATTEMPTS
      && (row.dispatch_lease_until === null || row.dispatch_lease_until <= now)) {
      const child = await readChildStatus(env, row);
      if (!child) {
        await finalizeWorkflowBudget(env as never, row.tenant_id, row.workflow_run_id, "release").catch(() => undefined);
        await updateJob(db, row, "dead_lettered", now, "job_dispatch_attempts_exhausted");
        await deleteJobPayload(env, row);
      }
    }
    return;
  }
  row = await readJob(db, row.job_id, row.tenant_id, row.space_id) ?? row;
  const object = await bucket.get(row.payload_key);
  if (!object || object.size !== row.payload_bytes) {
    await updateJob(db, row, "failed", Date.now(), "job_payload_unavailable");
    await finalizeWorkflowBudget(env as never, row.tenant_id, row.workflow_run_id, "release").catch(() => undefined);
    return;
  }
  const source = await object.text();
  if (await workflowHash(source) !== row.payload_sha256) {
    await updateJob(db, row, "failed", Date.now(), "job_payload_digest_mismatch");
    await finalizeWorkflowBudget(env as never, row.tenant_id, row.workflow_run_id, "release").catch(() => undefined);
    await deleteJobPayload(env, row);
    return;
  }
  let params: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("params object required");
    params = parsed as Record<string, unknown>;
  } catch {
    await updateJob(db, row, "failed", Date.now(), "job_payload_invalid");
    await finalizeWorkflowBudget(env as never, row.tenant_id, row.workflow_run_id, "release").catch(() => undefined);
    await deleteJobPayload(env, row);
    return;
  }
  try {
    await startDurableWorkflow(env, { tenantId: row.tenant_id, spaceId: row.space_id, projectId: row.project_id,
      actorId: row.actor_id, agentId: row.agent_id, name: row.workflow_id, params, startKey: row.child_start_key,
      workflowClass: "vertical_extension", installationId: row.installation_id, extensionId: row.extension_id, expiresAt: row.deadline_at,
      jobAuthorization: { requirementId: row.requirement_id, targetWorkflowId: row.workflow_id, manifestSha256: row.manifest_sha256,
        resourceSha256: row.resource_sha256, installationGeneration: row.installation_generation, grantRevision: row.grant_revision,
        releaseVersion: row.release_version, artifactSha256: row.artifact_sha256 } });
    await db.prepare(`UPDATE extension_resource_jobs SET status='running',started_at=COALESCE(started_at,?),updated_at=?,
        dispatch_lease_until=NULL,error_code=NULL WHERE job_id=? AND tenant_id=? AND space_id=?`)
      .bind(Date.now(), Date.now(), row.job_id, row.tenant_id, row.space_id).run();
    await deleteJobPayload(env, row);
  } catch (error) {
    const child = await readChildStatus(env, row);
    if (child) {
      const childStatus = statusFromChild(child) ?? "unknown";
      await updateJob(db, row, childStatus, Date.now());
      if (child.launched || ["succeeded", "failed", "cancelled", "expired"].includes(childStatus)) await deleteJobPayload(env, row);
      return;
    }
    const code = error instanceof Error ? error.message.slice(0, 96) : "job_start_unknown";
    if (["workflow_script_not_declared_by_installation", "workflow_extension_identity_mismatch", "workflow_extension_release_integrity_failed",
      "workflow_script_not_found", "workflow_declaration_invalid", "workflow_extension_budget_not_approved", "workflow_extension_budget_exceeds_approval"].includes(code)) {
      await updateJob(db, row, "failed", Date.now(), code);
      await finalizeWorkflowBudget(env as never, row.tenant_id, row.workflow_run_id, "release").catch(() => undefined);
      await deleteJobPayload(env, row);
      return;
    }
    await db.prepare(`UPDATE extension_resource_jobs SET status='unknown',updated_at=?,error_code=?,dispatch_lease_until=NULL WHERE job_id=?`)
      .bind(Date.now(), code, row.job_id).run();
    throw error;
  }
}

/** Bounded outbox scan. Queue delivery is at-least-once; the row lease and stable child run ID fence duplicate work. */
export async function enqueueExtensionJobOutbox(env: ExtensionJobEnvironment, limit = 100): Promise<number> {
  if (!env.PLATFORM_DB || !env.AGENT_TICKS) return 0;
  const now = Date.now();
  const { results } = await env.PLATFORM_DB.prepare(`SELECT job_id,tenant_id,space_id FROM extension_resource_jobs
    WHERE status IN ('queued','unknown','dispatching','running') AND
      (status!='dispatching' OR dispatch_lease_until IS NULL OR dispatch_lease_until<=?) ORDER BY updated_at,job_id LIMIT ?`)
    .bind(now, Math.max(1, Math.min(100, limit))).all<Pick<JobRow, "job_id" | "tenant_id" | "space_id">>();
  let queued = 0;
  for (const row of results) {
    try { await queueJob(env.AGENT_TICKS, row); queued++; }
    catch { /* durable row remains pending and is eligible in the next bounded outbox sweep */ }
  }
  return queued;
}
