import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueExtensionJob, handleExtensionJobTick, readExtensionJobStatus, type ExtensionJobEnvironment, type ExtensionJobScope } from "./extension-jobs.js";
import type { WorkflowInstallationGrant } from "./workflow-host.js";

const mocks = vi.hoisted(() => ({
  installation: null as any,
  approvedGrant: null as any,
  revoked: false,
  child: null as any,
  reserve: vi.fn(async () => "reservation"),
  release: vi.fn(async () => undefined),
  start: vi.fn(),
}));

vi.mock("./report-infra-usage.js", () => ({
  reserveWorkflowBudget: (...args: unknown[]) => mocks.reserve(...args),
  finalizeWorkflowBudget: (...args: unknown[]) => mocks.release(...args),
}));
vi.mock("./workflow-host.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./workflow-host.js")>();
  return { ...actual,
    readWorkflowGrant: async () => ({ role: "owner", version: "grant-version", installation: mocks.installation }),
    resolveApprovedJobsGrant: async () => mocks.revoked ? null : mocks.approvedGrant,
    startDurableWorkflow: async (...args: unknown[]) => {
      mocks.start(...args);
      mocks.child = { status: "queued", launched: true };
      return { id: "child-run", queued: true, durable: true as const };
    },
    workflowRunStub: () => ({ existing: async () => mocks.child, status: async () => mocks.child,
      cancel: async () => { if (mocks.child) mocks.child.status = "cancelled"; } }),
  };
});

type TestRow = Record<string, any>;
function database(maxConcurrent = 1) {
  const rows = new Map<string, TestRow>();
  const db = {
    prepare(sql: string) {
      let values: any[] = [];
      const statement = {
        bind(...args: any[]) { values = args; return statement; },
        async first() {
          if (sql.includes("WHERE job_id=?")) return rows.get(values[0]) ?? null;
          if (sql.includes("idempotency_key_sha256=?")) return [...rows.values()].find(row => row.tenant_id === values[0]
            && row.space_id === values[1] && row.project_id === values[2] && row.installation_id === values[3]
            && row.requirement_id === values[4] && row.actor_id === values[5] && row.idempotency_key_sha256 === values[6]) ?? null;
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (sql.startsWith("INSERT OR IGNORE INTO extension_resource_jobs")) {
            const scope = values.slice(29, 34);
            const now = values[34], concurrency = values[35];
            const active = [...rows.values()].filter(row => row.tenant_id === scope[0] && row.space_id === scope[1]
              && row.project_id === scope[2] && row.installation_id === scope[3] && row.requirement_id === scope[4]
              && ["queued", "dispatching", "running", "unknown"].includes(row.status) && row.deadline_at > now).length;
            const rateScope = values.slice(36, 41);
            const since = values[41], rate = values[42];
            const recent = [...rows.values()].filter(row => row.tenant_id === rateScope[0] && row.space_id === rateScope[1]
              && row.project_id === rateScope[2] && row.installation_id === rateScope[3] && row.requirement_id === rateScope[4]
              && row.created_at >= since).length;
            if (active >= Math.min(concurrency, maxConcurrent) || recent >= rate) return { meta: { changes: 0 } };
            const row: TestRow = { job_id: values[0], tenant_id: values[1], space_id: values[2], project_id: values[3],
              installation_id: values[4], extension_id: values[5], release_version: values[6], artifact_sha256: values[7],
              requirement_id: values[8], manifest_sha256: values[9], resource_sha256: values[10], installation_generation: values[11],
              grant_revision: values[12], actor_id: values[13], agent_id: values[14], caller_workflow_id: values[15], parent_run_id: values[16],
              effect_key: values[17], idempotency_key_sha256: values[18], request_sha256: values[19], workflow_id: values[20],
              child_start_key: values[21], payload_key: values[22], payload_sha256: values[23], payload_bytes: values[24], deadline_at: values[25], status: "queued",
              dispatch_attempts: 0, dispatch_lease_until: null, workflow_run_id: values[26], created_at: values[27], updated_at: values[28],
              started_at: null, completed_at: null, error_code: null };
            rows.set(row.job_id, row);
            return { meta: { changes: 1 } };
          }
          const id = values.find((value, index) => index === values.length - 3 && typeof value === "string" && rows.has(value))
            ?? values.find(value => typeof value === "string" && rows.has(value));
          const row = id ? rows.get(id) : undefined;
          if (!row) return { meta: { changes: 0 } };
          if (sql.includes("SET status='dispatching'")) {
            const now = values[1];
            if (!["queued", "unknown", "dispatching"].includes(row.status) || row.dispatch_lease_until && row.dispatch_lease_until > now
              || row.dispatch_attempts >= 5) return { meta: { changes: 0 } };
            row.status = "dispatching"; row.dispatch_attempts++; row.dispatch_lease_until = values[0]; row.updated_at = now;
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET status='running'")) {
            row.status = "running"; row.started_at ??= values[0]; row.updated_at = values[1]; row.dispatch_lease_until = null;
          } else if (sql.includes("SET status='unknown'")) { row.status = "unknown"; row.updated_at = values[0]; }
          else if (sql.startsWith("UPDATE extension_resource_jobs SET status=?")) {
            row.status = values[0]; row.updated_at = values[1]; row.error_code = values[2];
            if (["succeeded", "failed", "dead_lettered", "cancelled", "expired"].includes(row.status)) row.completed_at ??= values[4];
            row.dispatch_lease_until = null;
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, rows };
}

function fixture(maxConcurrent = 1) {
  const { db, rows } = database(maxConcurrent);
  const objects = new Map<string, string>();
  const sent: unknown[] = [];
  const requirement = { id: "background", kind: "jobs", apiVersion: "1.0", scope: "project", binding: { workflowIds: ["process_job"] },
    operations: [{ id: "enqueue" }, { id: "status" }], limits: { requestsPerMinute: 10, maxConcurrent, maxBytesPerOperation: 65_536 } };
  const installation: WorkflowInstallationGrant = { instance: { instance_id: "install-a", tenant_id: "tenant-a", space_id: "space-a",
    project_id: "project-a", generation: 4, status: "active", scope: "PROJECT_BOUND" },
    manifest: { id: "ext_jobs", resourceRequirements: [requirement] } as unknown as WorkflowInstallationGrant["manifest"],
    budget: { max_run_credits: 20, monthly_credits: 200, revision: 3, installation_generation: 4 },
    release: { version: "1.0.0", artifactSha256: "c".repeat(64), signatureValid: true } };
  const approvedGrant = { requirement_id: "background", manifest_sha256: "a".repeat(64), resource_sha256: "b".repeat(64),
    installation_generation: 4, operations: ["enqueue", "status"], tables: [], status: "approved" as const, revision: 7 };
  mocks.installation = installation; mocks.approvedGrant = approvedGrant; mocks.revoked = false; mocks.child = null;
  mocks.reserve.mockClear(); mocks.release.mockClear(); mocks.start.mockClear();
  const env = { PLATFORM_SECRET: "test", PLATFORM_DB: db, SCRIPTS_R2: {
    async put(key: string, value: string) { objects.set(key, value); },
    async get(key: string) { const value = objects.get(key); return value === undefined ? null : { size: new TextEncoder().encode(value).byteLength, text: async () => value }; },
    async delete(key: string) { objects.delete(key); },
  }, AGENT_TICKS: { async send(message: unknown) { sent.push(message); } } } as unknown as ExtensionJobEnvironment;
  const identity: ExtensionJobScope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", installationId: "install-a",
    actorId: "actor-a", agentId: "agent-a", runId: "parent-run", definitionId: "request_job", workflowClass: "vertical_extension" };
  const grant = { ...approvedGrant };
  const enqueue = (effectKey = "step-a", params: Record<string, unknown> = { itemId: "item-1" }, deadlineSeconds = 3600) => enqueueExtensionJob(env, {
    identity, requirementId: "background", effectKey, idempotencyKey: `${identity.runId}:${effectKey}`,
    resolved: { targetWorkflowId: "process_job", params, deadlineSeconds }, installation, grant,
  });
  return { env, identity, rows, objects, sent, enqueue };
}

describe("durable extension job broker", () => {
  beforeEach(() => { vi.useRealTimers(); });

  it("persists a bounded payload and deduplicates replay by exact effect idempotency", async () => {
    const h = fixture();
    const first = await h.enqueue();
    const replay = await h.enqueue();
    expect(replay).toEqual(first);
    expect(h.rows.size).toBe(1);
    expect(h.objects.size).toBe(1);
    expect(h.sent).toHaveLength(2);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.reserve.mock.calls[0]?.[7]).toMatchObject({ installationBudgetCredits: 200, installationBudgetRevision: 3 });
  });

  it("rejects changed idempotency input and releases a reservation when active concurrency is exhausted", async () => {
    const h = fixture(1);
    await h.enqueue();
    await expect(h.enqueue("step-a", { itemId: "changed" })).rejects.toThrow("workflow_job_idempotency_conflict");
    await expect(h.enqueue("step-b")).rejects.toThrow("workflow_job_admission_limit");
    expect(h.rows.size).toBe(1);
    expect(mocks.release).toHaveBeenCalled();
    expect(h.objects.size).toBe(1);
  });

  it("dispatches only after a current owner grant check and pins that revision into child start", async () => {
    const h = fixture();
    const accepted = await h.enqueue();
    await handleExtensionJobTick(h.env, { kind: "extension_job", tenantId: "tenant-a", spaceId: "space-a", jobId: accepted.jobId });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start.mock.calls[0]![1]).toMatchObject({ jobAuthorization: {
      requirementId: "background", targetWorkflowId: "process_job", installationGeneration: 4, grantRevision: 7,
      releaseVersion: "1.0.0", artifactSha256: "c".repeat(64),
    } });
    expect([...h.rows.values()][0]).toMatchObject({ status: "running", dispatch_attempts: 1 });
    expect(h.objects.size).toBe(0);
    mocks.child.status = "succeeded";
    await expect(readExtensionJobStatus(h.env, { identity: h.identity, requirementId: "background", jobId: accepted.jobId }))
      .resolves.toMatchObject({ jobId: accepted.jobId, status: "succeeded", attempt: 1 });
  });

  it("reconciles a lost workflow-start reply by its stable child ID without replaying the job", async () => {
    const h = fixture();
    const accepted = await h.enqueue();
    mocks.start.mockImplementationOnce(() => {
      mocks.child = { status: "queued", launched: true };
      throw new Error("start reply lost");
    });
    const tick = { kind: "extension_job" as const, tenantId: "tenant-a", spaceId: "space-a", jobId: accepted.jobId };
    await handleExtensionJobTick(h.env, tick);
    await handleExtensionJobTick(h.env, tick);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect([...h.rows.values()][0]).toMatchObject({ status: "running", dispatch_attempts: 1 });
    expect(h.objects.size).toBe(0);
  });

  it("moves exhausted delivery attempts to a terminal dead-letter receipt and clears its payload", async () => {
    const h = fixture();
    const accepted = await h.enqueue();
    const row = h.rows.get(accepted.jobId)!;
    row.status = "unknown";
    row.dispatch_attempts = 5;
    await handleExtensionJobTick(h.env, { kind: "extension_job", tenantId: "tenant-a", spaceId: "space-a", jobId: accepted.jobId });
    expect(row).toMatchObject({ status: "dead_lettered", error_code: "job_dispatch_attempts_exhausted" });
    expect(h.objects.size).toBe(0);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not dead-letter the last permitted dispatch while its start lease is still active", async () => {
    const h = fixture();
    const accepted = await h.enqueue();
    const row = h.rows.get(accepted.jobId)!;
    row.status = "dispatching";
    row.dispatch_attempts = 5;
    row.dispatch_lease_until = Date.now() + 60_000;
    await handleExtensionJobTick(h.env, { kind: "extension_job", tenantId: "tenant-a", spaceId: "space-a", jobId: accepted.jobId });
    expect(row).toMatchObject({ status: "dispatching", dispatch_attempts: 5 });
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("cancels and cleans queued work after owner revocation or its deadline", async () => {
    const revoked = fixture();
    const revokedJob = await revoked.enqueue();
    mocks.revoked = true;
    await handleExtensionJobTick(revoked.env, { kind: "extension_job", tenantId: "tenant-a", spaceId: "space-a", jobId: revokedJob.jobId });
    expect([...revoked.rows.values()][0]).toMatchObject({ status: "cancelled", error_code: "job_grant_revoked_or_changed" });
    expect(revoked.objects.size).toBe(0);

    const expired = fixture();
    const expiredJob = await expired.enqueue("step-deadline", { itemId: "late" }, 1);
    const row = expired.rows.get(expiredJob.jobId)!;
    row.deadline_at = Date.now() - 1;
    await handleExtensionJobTick(expired.env, { kind: "extension_job", tenantId: "tenant-a", spaceId: "space-a", jobId: expiredJob.jobId });
    expect(row).toMatchObject({ status: "expired", error_code: "job_deadline_expired" });
    expect(expired.objects.size).toBe(0);
    expect(mocks.release).toHaveBeenCalled();
  });
});
