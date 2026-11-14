import { DurableObject } from "cloudflare:workers";
import { mintInternalToken, readBoundedRequestText, readBoundedResponseJson, verifyInternalToken } from "@naelao/http";
import { inferWorkspaceContentType } from "@naelao/types";
import type { LiveRuntimeControlDO } from "./LiveRuntimeControlDO.js";
import {
  canonicalManifest,
  sha256Hex,
  validateWorkspaceBranch,
  validateWorkspaceContentType,
  validateWorkspaceEntry,
  validateWorkspacePath,
  validateWorkspaceScope,
  type WorkspaceArchiveBranch,
  type WorkspaceArchiveObjectReference,
  type WorkspaceArchiveSnapshot,
  type WorkspaceConsistencyMode,
  type WorkspaceEntry,
  type WorkspaceHead,
  type WorkspaceScope,
  type WorkspacePublicationReceipt,
} from "./workspace-contract.js";

interface Env {
  PLATFORM_SECRET: string;
  SCRIPTS_R2?: R2Bucket;
  LIVE_WORKSPACE_ENABLED?: string;
  LIVE_CAPABILITY_VERIFIER?: Fetcher;
  /** Trusted runtime control plane. It must quiesce the process and verify the real filesystem flush. */
  LIVE_RUNTIME_CONTROL?: Fetcher;
  /** Durable runtime-control boundary. It still fails closed without a trusted runtime adapter. */
  LIVE_RUNTIME_CONTROL_DO?: DurableObjectNamespace<LiveRuntimeControlDO>;
  LIVE_RUNTIME_AGENT?: Fetcher;
  UNIFIED_WORKSPACE_ENABLED?: string;
  ANALYTICS?: AnalyticsEngineDataset;
}
interface Change { path: string; expectedHash: string | null; contentBase64: string | null; executable?: boolean; contentType?: string; }
interface StagedChange { path: string; expectedHash: string | null; sha256: string | null; size: number; executable?: boolean; contentType?: string; objectKey?: string; }
interface StageRecord { sessionId: string; stageId: string; changeSetHash: string; changes: StagedChange[]; createdAt: string; status?: "active" | "consumed"; consumedAt?: string; }
interface RevisionEvent { branch: string; revision: number; publicationId: string | null; changedPaths: string[]; updatedAt: string; }
interface ExpiryRecord { expiresAt: number; kind: "receipt" | "subscription"; targetKey: string; branch?: string; subscriberId?: string; }
interface RetainedRevision { branch: string; revision: number; manifestHash: string; createdAt: string; }
interface WorkspaceUploadIntent { createdAt: string; objectKeys: string[]; }
interface InventorySummary { inventoryHash: string; pathHash: string; contentHash: string; sizeHash: string; mimeHash: string; executableHash: string; tombstoneHash: string; fileCount: number; tombstoneCount: number; totalBytes: number; }
interface WorkspaceCutoverReceipt { migrationId: string; generation: number; verifiedAt: string; branches: Record<string, { revision: number; manifestHash: string; legacy: InventorySummary; manifest: InventorySummary }>; mismatchCount: number; readErrorCount: number; omittedPathCount: number; truncatedPages: number; }
interface WorkspaceReadPolicy { mode: "legacy" | "shadow" | "coordinator"; generation: number; migrationId: string | null; updatedAt: string; rollbackExpiresAt?: string; receipt?: WorkspaceCutoverReceipt; }
interface WorkspaceMigration { migrationId: string; status: "barrier" | "importing" | "repairing" | "cutover" | "restoring" | "failed" | "verified"; sourcePrefix: string; startedAt: string; updatedAt: string; branchNames?: string[]; sourceInventory?: Record<string, InventorySummary>; errorCode?: string; revision?: number; manifestHash?: string; }
interface WorkspaceRollbackAlias { sourcePrefix: string; migrationId: string; retainedAt: string; verificationStatus: "pending" | "verified"; revision: number; manifestHash: string; branchNames?: string[]; branchHeads?: Record<string, { revision: number; manifestHash: string }>; sourceInventory?: Record<string, InventorySummary>; rollbackExpiresAt?: string; cleanupCursor?: string; cleanupStatus?: "pending" | "cleaning" | "complete"; }
interface WorkspaceRollbackRestore { restoreId: string; status: "restoring" | "verified"; startedAt: string; completedAt?: string; expectedHeads: Record<string, { revision: number; manifestHash: string }>; restoredHeads?: Record<string, { revision: number; manifestHash: string }>; completedBranches: string[]; errorCode?: string; }
interface CanonicalRevisionRestore {
  restoreId: string;
  branch: string;
  targetRevision: number;
  targetManifestHash: string;
  expectedHead: { revision: number; manifestHash: string };
  previousMigration: WorkspaceMigration | null;
  status: "restoring" | "verified";
  startedAt: string;
  completedAt?: string;
  restoredHead?: { revision: number; manifestHash: string };
  errorCode?: string;
}
interface ContentGcState {
  epoch: string;
  phase: "backfill" | "roots" | "mark" | "sweep-manifests" | "sweep-content" | "cleanup";
  claimId: string;
  claimUntil: number;
  lockUntil: number;
  backfillCursor?: string;
  pendingLegacyManifestHash?: string;
  legacyBackfillDone?: boolean;
  storageCursor?: string;
  manifestCursor?: string;
  manifestListDone?: boolean;
  activeManifestKey?: string;
  activeManifestOffset?: number;
  sweepManifestCursor?: string;
  contentCursor?: string;
  marksCursor?: string;
  cleanupDone?: boolean;
}
interface WorkspaceRetentionPolicy {
  version: 1;
  stagingRetentionDays: number;
  legalHold: null | { expiresAt?: string; reason: string; actorId: string; createdAt: string };
  updatedAt: string;
  updatedBy: string;
}
interface WorkspaceErasureAdmission { scope: WorkspaceScope; admittedAt: string; }
interface RetentionGcLease { id: string; expiresAt: number; }
interface Session {
  id: string;
  actorId: string;
  runtimeId: string;
  branch: string;
  parentBranch: string | null;
  baseRevision: number;
  baseManifestHash: string;
  mode: WorkspaceConsistencyMode;
  requestedMode: WorkspaceConsistencyMode;
  resolvedMode: WorkspaceConsistencyMode;
  allocationGeneration: number;
  fence: number;
  capabilityBinding?: LiveCapabilityBinding;
  status: "active" | "closed" | "revoked";
  createdAt: string;
}
interface LiveCapabilityBinding {
  runtimeId: string;
  runtimeType: string;
  templateId: string;
  templateDigest: string;
  region: string;
  authorizationId: string;
  authorizationEpoch: number;
  residencyPolicyId: string;
  allocationId: string;
  allocationGeneration: number;
  billingReservationId: string;
  budgetReservationId: string;
  verifiedAt: number;
}
interface LiveHandoffReceipt {
  id: string;
  nonce: string;
  sessionId: string;
  runtimeId: string;
  allocationGeneration: number;
  fence: number;
  revision: number;
  writeAdmissionStopped: true;
  inFlightDrained: true;
  filesystemFlushed: true;
  flushMethod: string;
  flushCompletedAt: number;
}
interface LiveCheckpointJob {
  sessionId: string;
  branch: string;
  runtimeId: string;
  allocationGeneration: number;
  fence: number;
  requestedAt: number;
  dueAt: number;
  requestCount: number;
  rerun?: boolean;
  processing?: boolean;
  syncCursor?: string;
  stageId?: string;
  idempotencyKey?: string;
  baseRevision?: number;
  failure?: string;
}
const MAX_BODY = 30 * 1024 * 1024;
const MAX_CHANGES = 100;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const MAX_SANDBOX_HANDOFF_FILES = 200;
const MAX_SANDBOX_HANDOFF_BYTES = 64 * 1024 * 1024;
const MAX_MIGRATION_FILES = 10_000;
const MAX_MIGRATION_BYTES = 64 * 1024 * 1024;
const MAX_MIGRATION_BRANCHES = 200;
const MAX_MIGRATION_ALL_BRANCH_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_BRANCHES = 1000;
const MAX_ARCHIVE_OBJECT_REFERENCES = 5000;
const LIVE_CHECKPOINT_BATCH_SIZE = 20;
const MAX_LIVE_RUNTIME_CONTROL_RESPONSE_BYTES = 30 * 1024 * 1024;
const STAGING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SUBSCRIPTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CONTENT_GC_LOCK_MS = 10 * 60 * 1000;
const CONTENT_GC_CLAIM_MS = 2 * 60 * 1000;
const CONTENT_GC_ENTRY_BATCH = 100;
const RETENTION_GC_LEASE_MS = 5 * 60 * 1000;
const UPLOAD_INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_CONTENT_GC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_MAINTENANCE_RETRY_MS = 60 * 1000;
const REVISION_EVENT_RETENTION = 500;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const fail = (error_code: string, status = 400) => json({ error_code }, status);

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  let text: string;
  try { text = await readBoundedRequestText(request, MAX_BODY); } catch { return null; }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function unbase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function base64(value: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < value.length; i += 0x8000) binary += String.fromCharCode(...value.subarray(i, i + 0x8000));
  return btoa(binary);
}
function keyScope(scope: WorkspaceScope): string {
  return `${scope.tenantId}/${scope.spaceId}/${scope.projectId}/${scope.jurisdiction}`;
}

function validateLiveCapabilityEvidence(value: unknown, generation: number, runtimeId: string): { binding?: LiveCapabilityBinding; missing: string[] } {
  const evidence = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const requiredBooleans = [
    "authorized", "residencyAllowed", "liveMountReady", "fuseReady", "incrementalSyncReady",
    "flushReady", "reconnectGenerationCheck", "authenticatedTransport", "billingReserved", "budgetReserved",
    "runtimeAccountingReady",
  ];
  const missing = requiredBooleans.filter((key) => evidence[key] !== true);
  const requiredStrings = ["runtimeId", "runtimeType", "templateId", "region", "authorizationId", "residencyPolicyId", "allocationId", "billingReservationId", "budgetReservationId"];
  for (const key of requiredStrings) if (typeof evidence[key] !== "string" || !(evidence[key] as string).trim() || !ID.test(evidence[key] as string)) missing.push(key);
  if (evidence.runtimeId !== runtimeId) missing.push("runtimeIdBinding");
  const templateDigest = evidence.templateDigest;
  if (typeof templateDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(templateDigest)) missing.push("templateDigest");
  if (!Number.isSafeInteger(evidence.authorizationEpoch) || Number(evidence.authorizationEpoch) < 1) missing.push("authorizationEpoch");
  if (!Number.isSafeInteger(evidence.allocationGeneration) || Number(evidence.allocationGeneration) !== generation) missing.push("allocationGeneration");
  if (typeof evidence.verifiedAt !== "number" || !Number.isFinite(evidence.verifiedAt) || Date.now() - evidence.verifiedAt > 5 * 60_000 || evidence.verifiedAt > Date.now() + 30_000) missing.push("recentVerification");
  if (missing.length) return { missing: [...new Set(missing)] };
  return {
    missing: [],
    binding: {
      runtimeId: evidence.runtimeId as string,
      runtimeType: evidence.runtimeType as string,
      templateId: evidence.templateId as string,
      templateDigest: templateDigest as string,
      region: evidence.region as string,
      authorizationId: evidence.authorizationId as string,
      authorizationEpoch: Number(evidence.authorizationEpoch),
      residencyPolicyId: evidence.residencyPolicyId as string,
      allocationId: evidence.allocationId as string,
      allocationGeneration: generation,
      billingReservationId: evidence.billingReservationId as string,
      budgetReservationId: evidence.budgetReservationId as string,
      verifiedAt: Number(evidence.verifiedAt),
    },
  };
}
function manifestKey(scope: WorkspaceScope, hash: string): string {
  return `workspace-v1/${keyScope(scope)}/manifests/${hash}.json`;
}
function contentPrefix(scope: WorkspaceScope): string {
  return `workspace-v1/${keyScope(scope)}/content/`;
}
function nextR2Cursor(page: { truncated: boolean; cursor?: string }, operation: string, current?: string): string | undefined {
  if (!page.truncated) return undefined;
  if (!page.cursor) throw new Error(`workspace_gc_${operation}_cursor_missing`);
  if (page.cursor === current) throw new Error(`workspace_gc_${operation}_cursor_stalled`);
  return page.cursor;
}
function stagingPrefix(scope: WorkspaceScope): string {
  return `workspace-v1/${keyScope(scope)}/staging/`;
}
function headKey(branch: string): string { return `head:${branch}`; }
function sessionKey(id: string): string { return `session:${id}`; }
function receiptKey(branch: string, idempotencyKey: string): string {
  return `receipt:${branch}:${idempotencyKey}`;
}
function branchBaseKey(branch: string): string { return `branch-base:${branch}`; }
function mergeReceiptKey(branch: string, idempotencyKey: string): string { return `merge-receipt:${branch}:${idempotencyKey}`; }
function stageKey(sessionId: string, stageId: string): string { return `stage:${sessionId}:${stageId}`; }
function revisionEventKey(branch: string, revision: number): string { return `revision:${branch}:${revision}`; }
function retainedRevisionKey(branch: string, revision: number): string { return `retained-revision:${branch}:${String(revision).padStart(16, "0")}`; }
function subscriptionKey(branch: string, subscriberId: string): string { return `subscription:${branch}:${subscriberId}`; }
function expiryKey(expiresAt: number, nonce: string): string { return `expiry:${String(expiresAt).padStart(13, "0")}:${nonce}`; }
function gcMarksRoot(scope: WorkspaceScope): string { return `workspace-v1/${keyScope(scope)}/gc/marks/`; }
function gcMarksPrefix(scope: WorkspaceScope, epoch: string): string { return `${gcMarksRoot(scope)}${epoch}/`; }
function entrySignature(entry: WorkspaceEntry | undefined): string | null {
  return entry ? JSON.stringify([entry.sha256, entry.size, entry.executable, entry.contentType ?? inferWorkspaceContentType(entry.path)]) : null;
}

/**
 * Project-scoped metadata coordinator. File bytes and immutable manifests live in R2;
 * a single Durable Object transaction advances one complete branch head and receipt.
 * The Worker authenticates and authorizes users before routing requests here.
 */
export class WorkspaceCoordinatorDO extends DurableObject<Env> {
  private ready: Promise<void>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.ctx.storage.get<WorkspaceScope>("scope").then(() => undefined);
  }

  async alarm(): Promise<void> {
    if (await this.ctx.storage.get<boolean>("erased")) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.processLiveCheckpoint();
    const startedAt = Date.now();
    const previous = await this.ctx.storage.get<{ failures: number }>("workspace_gc_status") ?? { failures: 0 };
    try {
      const gc = await this.ctx.storage.get<ContentGcState>("content_gc");
      const lastContentSweep = await this.ctx.storage.get<number>("content_gc_last_completed_at") ?? 0;
      let contentResult: Response | undefined;
      // Resume an interrupted sweep, or start initial backfill / weekly bounded mark-sweep.
      if (gc && gc.lockUntil > Date.now()) contentResult = await this.collectContent(true);
      else if (!await this.ctx.storage.get<boolean>("content_gc_backfill_complete") || lastContentSweep + WORKSPACE_CONTENT_GC_INTERVAL_MS <= Date.now()) contentResult = await this.collectContent(false);
      if (contentResult && !contentResult.ok) throw new Error(`content:${contentResult.status}:${(await contentResult.clone().text()).slice(0, 200)}`);

      const cursor = await this.ctx.storage.get<string>("staging_gc_cursor");
      const recordCursor = await this.ctx.storage.get<string>("staging_gc_record_cursor");
      const stageResult = await this.collectStaging({ cursor, recordCursor });
      if (!stageResult.ok) throw new Error(`staging:${stageResult.status}:${(await stageResult.clone().text()).slice(0, 200)}`);
      const stageBody = await stageResult.json<{ cursor?: string | null; recordCursor?: string | null; hasMore?: boolean }>();
      if (stageBody.hasMore && typeof stageBody.cursor === "string") await this.ctx.storage.put("staging_gc_cursor", stageBody.cursor);
      else await this.ctx.storage.delete("staging_gc_cursor");
      if (stageBody.hasMore && typeof stageBody.recordCursor === "string") await this.ctx.storage.put("staging_gc_record_cursor", stageBody.recordCursor);
      else await this.ctx.storage.delete("staging_gc_record_cursor");

      const metadataResult = await this.collectMetadata();
      if (!metadataResult.ok) throw new Error(`metadata:${metadataResult.status}`);
      const hasMore = stageBody.hasMore || Boolean(await this.ctx.storage.get("content_gc"));
      await this.ctx.storage.put("workspace_gc_status", {
        status: hasMore ? "running" : "complete", startedAt: new Date(startedAt).toISOString(),
        ...(hasMore ? {} : { completedAt: new Date().toISOString() }), failures: 0,
        ...(stageBody.hasMore ? { stagingHasMore: true } : {}),
      });
      await this.scheduleAlarmAt(Date.now() + (hasMore ? 1_000 : WORKSPACE_MAINTENANCE_INTERVAL_MS));
      await this.scheduleMetadataExpiry();
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "workspace_gc_failed";
      await this.ctx.storage.put("workspace_gc_status", {
        status: "failed", failedAt: new Date().toISOString(), startedAt: new Date(startedAt).toISOString(),
        failures: previous.failures + 1, error: message,
      });
      console.error("workspace_gc_maintenance_failed", { retry: Math.min(previous.failures + 1, 100) });
      await this.scheduleAlarmAt(Date.now() + WORKSPACE_MAINTENANCE_RETRY_MS);
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
    if (!tenantId || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, this.env.PLATFORM_SECRET)) return fail("forbidden", 403);
    if (!this.env.SCRIPTS_R2) return fail("workspace_storage_unavailable", 503);
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJson(request) : null;
    if (request.method === "POST" && !body) return fail("invalid_request", 413);
    const erasureControl = request.method === "POST" && ["/v1/erase", "/v1/erase/admission"].includes(url.pathname);
    if (request.method !== "POST" && await this.ctx.storage.get<boolean>("erased")) return fail("workspace_erased", 410);
    if (request.method === "POST" && !erasureControl && await this.ctx.storage.get<boolean>("erased")) return fail("workspace_erased", 410);
    const admission = await this.ctx.storage.get<WorkspaceErasureAdmission>("workspace_erasure_admission");
    if (admission && !erasureControl && url.pathname !== "/v1/retention/policy") return fail("workspace_erasure_in_progress", 423);
    if (request.method === "POST" && url.pathname === "/v1/erase/admission") return this.admitErase(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/erase") return this.erase(body!, tenantId);
    if (request.method === "GET" && url.pathname === "/v1/migration/status") {
      const migration = await this.ctx.storage.get<WorkspaceMigration>("project_migration") ?? null;
      const rollbackAlias = await this.ctx.storage.get<WorkspaceRollbackAlias>("legacy_rollback_alias") ?? null;
      const restore = await this.ctx.storage.get<WorkspaceRollbackRestore>("migration_restore") ?? null;
      const readPolicy = await this.getReadPolicy();
      const branches = ["main", ...(migration?.branchNames ?? rollbackAlias?.branchNames ?? [])];
      const currentHeads: Record<string, { revision: number; manifestHash: string }> = {};
      for (const branch of branches) {
        const head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
        if (head) currentHeads[branch] = { revision: head.revision, manifestHash: head.manifestHash };
      }
      return json({ migration, rollbackAlias, restore, canonicalRevisionRestore: await this.ctx.storage.get("canonical_revision_restore") ?? null,
        readPolicy, currentHeads, aliasCleanup: await this.ctx.storage.get("legacy_alias_cleanup_receipt") ?? null });
    }
    if (request.method === "GET" && url.pathname === "/v1/retention/policy") {
      return json({ policy: await this.ctx.storage.get<WorkspaceRetentionPolicy>("workspace_retention_policy") ?? {
        version: 1, stagingRetentionDays: 7, legalHold: null, updatedAt: null, updatedBy: null,
      } });
    }
    if (request.method === "POST" && url.pathname === "/v1/retention/policy") return this.setRetentionPolicy(body!, tenantId);
    if (request.method === "GET" && url.pathname === "/v1/read-policy") return json(await this.getReadPolicy());
    if (request.method === "GET" && url.pathname === "/v1/sessions") return this.sessions(url);
    if (request.method === "GET" && url.pathname === "/v1/live-checkpoint/status") return this.liveCheckpointStatus(url);
    if (request.method === "POST" && url.pathname === "/v1/migration/import") return this.migrateLegacyProject(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/migration/repair") return this.repairMigratedProject(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/migration/restore") return this.restoreMigratedProject(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/revision-restore") return this.restoreCanonicalRevision(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/migration/cutover") return this.cutoverMigratedProject(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/migration/retire-alias") return this.retireLegacyAlias(body!, tenantId);
    // Every known workspace gets a durable maintenance alarm. This turns the authenticated
    // coordinator access path into the bounded scheduler roster without a second, stale D1
    // registry of project identities.
    if (await this.ctx.storage.get<WorkspaceScope>("scope")) await this.scheduleAlarmAt(Date.now() + WORKSPACE_MAINTENANCE_INTERVAL_MS);
    const migration = await this.ctx.storage.get<WorkspaceMigration>("project_migration");
    if (migration && migration.status !== "verified" && url.pathname !== "/v1/migration/status" && url.pathname !== "/v1/migration/import") return fail("workspace_migration_barrier_active", 423);
    if (request.method === "POST" && url.pathname === "/v1/archive/export") return this.exportArchiveSnapshot(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/archive/restore") return this.restoreArchiveSnapshot(body!, tenantId);
    if (request.method === "POST" && ["/v1/initialize", "/v1/open", "/v1/renew", "/v1/branch", "/v1/merge", "/v1/checkpoint", "/v1/stage", "/v1/handoff", "/v1/close", "/v1/revoke", "/v1/subscriptions/ack", "/v1/live-checkpoint/request"].includes(url.pathname)) {
      const policy = await this.getReadPolicy();
      const canInitialize = url.pathname === "/v1/initialize" && policy.mode === "legacy" &&
        !(await this.ctx.storage.get<WorkspaceMigration>("project_migration")) &&
        !(await this.ctx.storage.get<WorkspaceRollbackAlias>("legacy_rollback_alias")) &&
        !(await this.ctx.storage.get<WorkspaceHead>(headKey("main")));
      if (policy.mode !== "coordinator" && !canInitialize) return fail("workspace_project_policy_blocks_coordinator_write", 423);
    }
    if (request.method === "POST" && url.pathname === "/v1/initialize") return this.initialize(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/open") return this.open(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/renew") return this.renew(body!);
    if (request.method === "POST" && url.pathname === "/v1/branch") return this.createBranch(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/merge") return this.merge(body!);
    if (request.method === "GET" && url.pathname === "/v1/head") return this.head(url);
    if (request.method === "GET" && url.pathname === "/v1/read") return this.read(url);
    if (request.method === "GET" && url.pathname === "/v1/history") return this.history(url);
    if (request.method === "GET" && url.pathname === "/v1/changes") return this.changes(url);
    if (request.method === "POST" && url.pathname === "/v1/subscriptions/ack") return this.acknowledge(body!);
    if (request.method === "POST" && url.pathname === "/v1/checkpoint") {
      const startedAt = Date.now();
      const result = await this.checkpoint(body!);
      this.writeOpsMetric("checkpoint_lag_ms", Date.now() - startedAt, result.ok ? "all" : "warning");
      return result;
    }
    if (request.method === "POST" && url.pathname === "/v1/stage") return this.stage(body!);
    if (request.method === "GET" && url.pathname === "/v1/session-snapshot") return this.sessionSnapshot(url);
    if (request.method === "GET" && url.pathname === "/v1/session-content") return this.sessionContent(url);
    if (request.method === "GET" && url.pathname === "/v1/receipt") return this.receipt(url);
    if (request.method === "POST" && url.pathname === "/v1/gc/staging") return this.collectStaging(body!);
    if (request.method === "POST" && url.pathname === "/v1/gc/metadata") return this.collectMetadata();
    if (request.method === "POST" && url.pathname === "/v1/gc/content") return this.collectContent(false);
    if (request.method === "GET" && url.pathname === "/v1/gc/status") return json(await this.ctx.storage.get("workspace_gc_status") ?? { status: "not_scheduled" });
    if (request.method === "POST" && url.pathname === "/v1/handoff") return this.handoff(body!);
    if (request.method === "POST" && url.pathname === "/v1/close") return this.close(body!);
    if (request.method === "POST" && url.pathname === "/v1/revoke") return this.revoke(body!);
    if (request.method === "POST" && url.pathname === "/v1/live-checkpoint/request") return this.requestLiveCheckpoint(body!);
    return fail("not_found", 404);
  }

  private async exportArchiveSnapshot(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId) return fail("invalid_workspace_scope", 403);
    const scope = body.scope;
    const knownScope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (!knownScope) return json({ present: false });
    if (knownScope.tenantId !== scope.tenantId || knownScope.spaceId !== scope.spaceId || knownScope.projectId !== scope.projectId || knownScope.jurisdiction !== scope.jurisdiction) return fail("workspace_scope_mismatch", 403);
    const policy = await this.getReadPolicy();
    if (policy.mode !== "coordinator") return fail("workspace_archive_policy_not_canonical", 423);
    if (await this.contentGcLocked()) return fail("workspace_gc_in_progress", 423);
    const headsBefore = await this.ctx.storage.list<WorkspaceHead>({ prefix: "head:", limit: MAX_ARCHIVE_BRANCHES + 1 });
    if (headsBefore.size > MAX_ARCHIVE_BRANCHES) return fail("workspace_archive_branch_limit_exceeded", 413);
    const branches: WorkspaceArchiveBranch[] = [];
    const references = new Map<string, WorkspaceArchiveObjectReference>();
    const addReference = async (key: string, expectedSize?: number): Promise<Response | null> => {
      const object = await this.env.SCRIPTS_R2!.head(key);
      if (!object || typeof object.etag !== "string" || !object.etag || !Number.isSafeInteger(object.size) || object.size < 0 ||
          (expectedSize !== undefined && object.size !== expectedSize)) return fail("workspace_archive_object_unavailable", 503);
      references.set(key, { key, etag: object.etag, size: object.size });
      return references.size > MAX_ARCHIVE_OBJECT_REFERENCES ? fail("workspace_archive_object_limit_exceeded", 413) : null;
    };
    const addManifest = async (head: WorkspaceHead): Promise<Response | null> => {
      let entries: WorkspaceEntry[];
      try { entries = await this.readManifestEntries(head); }
      catch { return fail("workspace_archive_manifest_unavailable", 503); }
      if (!Array.isArray(entries) || !entries.every(validateWorkspaceEntry) || new Set(entries.map(entry => entry.path)).size !== entries.length ||
          await sha256Hex(new TextEncoder().encode(canonicalManifest(entries))) !== head.manifestHash) return fail("workspace_archive_manifest_invalid", 503);
      const invalidContent = await this.verifyEntries(scope, entries);
      if (invalidContent) return fail("workspace_archive_content_unavailable", 503);
      const manifestRef = await addReference(manifestKey(scope, head.manifestHash));
      if (manifestRef) return manifestRef;
      for (const entry of entries) {
        const contentRef = await addReference(entry.objectKey, entry.size);
        if (contentRef) return contentRef;
      }
      return null;
    };

    for (const [key, head] of headsBefore) {
      const branch = key.slice("head:".length);
      if (!validateWorkspaceBranch(branch) || head.branch !== branch || head.version !== 1 || JSON.stringify(head.scope) !== JSON.stringify(scope)) return fail("workspace_archive_head_invalid", 503);
      const failedManifest = await addManifest(head);
      if (failedManifest) return failedManifest;
      const storedBase = branch === "main" ? undefined : await this.ctx.storage.get<{ parentBranch: string; revision: number; manifestHash: string }>(branchBaseKey(branch));
      let base: WorkspaceArchiveBranch["base"] = null;
      if (storedBase) {
        if (!validateWorkspaceBranch(storedBase.parentBranch) || storedBase.parentBranch === branch || !Number.isSafeInteger(storedBase.revision) || storedBase.revision < 1 || !HASH.test(storedBase.manifestHash)) return fail("workspace_archive_branch_base_invalid", 503);
        base = { ...storedBase };
        const baseHead: WorkspaceHead = { ...head, branch: storedBase.parentBranch, revision: storedBase.revision, manifestHash: storedBase.manifestHash };
        const failedBase = await addManifest(baseHead);
        if (failedBase) return failedBase;
      }
      branches.push({ head, base });
    }
    if (!headsBefore.size) return json({ present: false });
    if (!branches.some(branch => branch.head.branch === "main")) return fail("workspace_archive_main_head_missing", 503);
    const headsAfter = await this.ctx.storage.list<WorkspaceHead>({ prefix: "head:", limit: MAX_ARCHIVE_BRANCHES + 1 });
    if (policy.generation !== (await this.getReadPolicy()).generation || JSON.stringify([...headsBefore]) !== JSON.stringify([...headsAfter])) return fail("workspace_archive_changed_during_export", 409);
    const snapshot: WorkspaceArchiveSnapshot = { version: 1, scope, policyGeneration: policy.generation, branches };
    return json({ present: true, snapshot, objectReferences: [...references.values()] });
  }

  private async restoreArchiveSnapshot(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    const candidate = body.snapshot as Partial<WorkspaceArchiveSnapshot> | undefined;
    const restoreId = body.restoreId;
    if (typeof restoreId !== "string" || !ID.test(restoreId) || !candidate || candidate.version !== 1 ||
        !validateWorkspaceScope(candidate.scope) || candidate.scope.tenantId !== tenantId || !Number.isSafeInteger(candidate.policyGeneration) ||
        Number(candidate.policyGeneration) < 0 || !Array.isArray(candidate.branches) || candidate.branches.length < 1 || candidate.branches.length > MAX_ARCHIVE_BRANCHES) {
      return fail("workspace_archive_snapshot_invalid");
    }
    const snapshot = candidate as WorkspaceArchiveSnapshot;
    const scope = snapshot.scope;
    const priorScope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (priorScope && (priorScope.tenantId !== scope.tenantId || priorScope.spaceId !== scope.spaceId || priorScope.projectId !== scope.projectId || priorScope.jurisdiction !== scope.jurisdiction)) return fail("workspace_scope_mismatch", 403);
    if (snapshot.branches.some(item => !item || typeof item !== "object" || !item.head || typeof item.head !== "object" || typeof item.head.branch !== "string")) return fail("workspace_archive_head_invalid");
    const branches = [...snapshot.branches].sort((left, right) => left.head.branch.localeCompare(right.head.branch));
    const branchNames = new Set<string>();
    for (const item of branches) {
      const head = item?.head;
      if (!head || !validateWorkspaceBranch(head.branch) || branchNames.has(head.branch) || head.version !== 1 ||
          head.scope?.tenantId !== scope.tenantId || head.scope.spaceId !== scope.spaceId || head.scope.projectId !== scope.projectId || head.scope.jurisdiction !== scope.jurisdiction || !Number.isSafeInteger(head.revision) || head.revision < 1 ||
          !HASH.test(head.manifestHash) || (head.parentRevision !== null && (!Number.isSafeInteger(head.parentRevision) || head.parentRevision < 1)) ||
          (head.publicationId !== null && (typeof head.publicationId !== "string" || head.publicationId.length > 160)) ||
          typeof head.updatedAt !== "string" || !Number.isFinite(Date.parse(head.updatedAt))) return fail("workspace_archive_head_invalid");
      branchNames.add(head.branch);
      if (item.base !== null) {
        const base = item.base;
        if (!base || !validateWorkspaceBranch(base.parentBranch) || base.parentBranch === head.branch || !Number.isSafeInteger(base.revision) ||
            base.revision < 1 || !HASH.test(base.manifestHash)) return fail("workspace_archive_branch_base_invalid");
      }
    }
    if (!branchNames.has("main") || branches.some(item => item.base && !branchNames.has(item.base.parentBranch))) return fail("workspace_archive_branch_inventory_invalid");
    const main = branches.find(item => item.head.branch === "main")!.head;
    for (const item of branches) {
      const manifests = [item.head, ...(item.base ? [{ ...item.head, branch: item.base.parentBranch, revision: item.base.revision, manifestHash: item.base.manifestHash }] : [])];
      for (const head of manifests) {
        let entries: WorkspaceEntry[];
        try { entries = await this.readManifestEntries(head); }
        catch { return fail("workspace_archive_manifest_unavailable", 409); }
        if (!Array.isArray(entries) || !entries.every(validateWorkspaceEntry) || new Set(entries.map(entry => entry.path)).size !== entries.length ||
            await sha256Hex(new TextEncoder().encode(canonicalManifest(entries))) !== head.manifestHash) return fail("workspace_archive_manifest_invalid", 422);
        const invalidContent = await this.verifyEntries(scope, entries);
        if (invalidContent) return fail("workspace_archive_content_unavailable", 409);
      }
    }
    const snapshotHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(snapshot)));
    const priorReceipt = await this.ctx.storage.get<{ snapshotHash: string }>(`workspace_archive_restore:${restoreId}`);
    if (priorReceipt) return priorReceipt.snapshotHash === snapshotHash
      ? json({ restored: true, replay: true, branchCount: branches.length }) : fail("workspace_archive_restore_id_conflict", 409);

    const migration = await this.ctx.storage.get<WorkspaceMigration>("project_migration");
    const policy = await this.getReadPolicy();
    const alias = await this.ctx.storage.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
    if ((migration && migration.status !== "verified") || policy.mode === "shadow" || (alias && policy.mode !== "coordinator")) return fail("workspace_archive_restore_policy_blocked", 423);
    if (await this.contentGcLocked()) return fail("workspace_gc_in_progress", 423);
    const sessionRecords = await this.ctx.storage.list<Session>({ prefix: "session:", limit: 1001 });
    if (sessionRecords.size > 1000) return fail("workspace_archive_session_scan_limit_exceeded", 413);
    if ([...sessionRecords.values()].some(session => session.status === "active")) return fail("workspace_archive_active_sessions", 423);

    const result = await this.ctx.storage.transaction(async tx => {
      if (await tx.get<boolean>("erased") || await tx.get<WorkspaceErasureAdmission>("workspace_erasure_admission")) return { error: "workspace_erased" as const };
      const gc = await tx.get<ContentGcState>("content_gc");
      if (gc && gc.lockUntil > Date.now()) return { error: "workspace_gc_in_progress" as const };
      const currentMigration = await tx.get<WorkspaceMigration>("project_migration");
      if (currentMigration && currentMigration.status !== "verified") return { error: "workspace_migration_barrier_active" as const };
      const currentPolicy = await tx.get<WorkspaceReadPolicy>("workspace_read_policy");
      if (currentPolicy?.mode === "shadow" || (currentPolicy && currentPolicy.generation !== policy.generation)) return { error: "workspace_archive_restore_policy_changed" as const };
      const currentSessions = await tx.list<Session>({ prefix: "session:", limit: 1001 });
      if (currentSessions.size > 1000 || [...currentSessions.values()].some(session => session.status === "active")) return { error: "workspace_archive_active_sessions" as const };
      const currentAlias = await tx.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
      if (currentAlias && (await tx.get<WorkspaceReadPolicy>("workspace_read_policy"))?.mode !== "coordinator") return { error: "workspace_archive_restore_policy_blocked" as const };
      const currentScope = await tx.get<WorkspaceScope>("scope");
      if (currentScope && (currentScope.tenantId !== scope.tenantId || currentScope.spaceId !== scope.spaceId || currentScope.projectId !== scope.projectId || currentScope.jurisdiction !== scope.jurisdiction)) return { error: "workspace_scope_mismatch" as const };
      const currentMain = await tx.get<WorkspaceHead>(headKey("main"));
      const currentHeads = await tx.list<WorkspaceHead>({ prefix: "head:", limit: MAX_ARCHIVE_BRANCHES + 1 });
      if (currentHeads.size > MAX_ARCHIVE_BRANCHES || (!currentMain && currentHeads.size > 0)) return { error: "workspace_archive_head_conflict" as const };
      if (currentMain && (currentMain.revision !== main.revision || currentMain.manifestHash !== main.manifestHash)) return { error: "workspace_archive_head_conflict" as const };
      for (const item of branches) {
        const current = await tx.get<WorkspaceHead>(headKey(item.head.branch));
        if (current && (current.revision !== item.head.revision || current.manifestHash !== item.head.manifestHash)) return { error: "workspace_archive_head_conflict" as const };
        const currentBase = await tx.get<{ parentBranch: string; revision: number; manifestHash: string }>(branchBaseKey(item.head.branch));
        if (currentBase && JSON.stringify(currentBase) !== JSON.stringify(item.base)) return { error: "workspace_archive_branch_base_conflict" as const };
      }
      await tx.put("scope", scope);
      for (const item of branches) {
        const current = await tx.get<WorkspaceHead>(headKey(item.head.branch));
        if (!current) await tx.put(headKey(item.head.branch), item.head);
        if (item.base && !(await tx.get(branchBaseKey(item.head.branch)))) await tx.put(branchBaseKey(item.head.branch), item.base);
        const retainedKey = retainedRevisionKey(item.head.branch, item.head.revision);
        if (!(await tx.get(retainedKey))) await tx.put(retainedKey, { branch: item.head.branch, revision: item.head.revision, manifestHash: item.head.manifestHash, createdAt: item.head.updatedAt } satisfies RetainedRevision);
        const eventKey = revisionEventKey(item.head.branch, item.head.revision);
        if (!(await tx.get(eventKey))) await tx.put(eventKey, { branch: item.head.branch, revision: item.head.revision, publicationId: item.head.publicationId, changedPaths: [], updatedAt: item.head.updatedAt } satisfies RevisionEvent);
      }
      if (!currentPolicy || currentPolicy.mode === "legacy") {
        const at = new Date().toISOString();
        await tx.put("workspace_read_policy", { mode: "coordinator", generation: Math.max((currentPolicy?.generation ?? 0) + 1, snapshot.policyGeneration + 1), migrationId: null, updatedAt: at } satisfies WorkspaceReadPolicy);
      }
      await tx.put(`workspace_archive_restore:${restoreId}`, { snapshotHash, archiveGeneration: snapshot.policyGeneration, restoredAt: new Date().toISOString() });
      return { restored: true as const, replay: false as const };
    });
    if ("error" in result) return fail(result.error, result.error === "workspace_scope_mismatch" ? 403 : result.error.includes("conflict") ? 409 : 423);
    await this.ctx.storage.setAlarm(Date.now() + WORKSPACE_MAINTENANCE_INTERVAL_MS);
    return json({ restored: true, replay: false, branchCount: branches.length });
  }

  private async validateScope(scopeValue: unknown, branchValue: unknown, tenantId: string): Promise<{ scope: WorkspaceScope; branch: string } | Response> {
    if (!validateWorkspaceScope(scopeValue) || !validateWorkspaceBranch(branchValue)) return fail("invalid_workspace_scope");
    const scope = scopeValue;
    const branch = branchValue;
    if (scope.tenantId !== tenantId) return fail("workspace_scope_mismatch", 403);
    const known = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (known && JSON.stringify(known) !== JSON.stringify(scope)) return fail("workspace_scope_mismatch", 403);
    return { scope, branch };
  }

  private async getReadPolicy(): Promise<WorkspaceReadPolicy> {
    const stored = await this.ctx.storage.get<WorkspaceReadPolicy>("workspace_read_policy");
    if (stored) return stored;
    const migration = await this.ctx.storage.get<WorkspaceMigration>("project_migration");
    const alias = await this.ctx.storage.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
    const main = await this.ctx.storage.get<WorkspaceHead>(headKey("main"));
    const mode: WorkspaceReadPolicy["mode"] = migration || alias?.verificationStatus === "verified" ? "shadow" : main ? "coordinator" : "legacy";
    return { mode, generation: 0, migrationId: migration?.migrationId ?? alias?.migrationId ?? null, updatedAt: new Date(0).toISOString() };
  }

  private async initialize(body: Record<string, unknown>, tenantId: string, allowMigration = false): Promise<Response> {
    const migration = await this.ctx.storage.get<WorkspaceMigration>("project_migration");
    if (migration && migration.status !== "verified" && !allowMigration) return fail("workspace_migration_barrier_active", 423);
    const validated = await this.validateScope(body.scope, body.branch, tenantId);
    if (validated instanceof Response) return validated;
    if (await this.contentGcLocked()) return fail("workspace_gc_in_progress", 423);
    const { scope, branch } = validated;
    if (!Array.isArray(body.entries) || body.entries.length > MAX_ENTRIES || !body.entries.every(validateWorkspaceEntry)) return fail("invalid_manifest");
    if (new Set(body.entries.map((entry) => (entry as WorkspaceEntry).path)).size !== body.entries.length) return fail("duplicate_workspace_path");
    // Keep supplied metadata, and infer the shared known-extension map for older callers.
    const entries = (body.entries as WorkspaceEntry[]).map(entry => ({ ...entry, contentType: entry.contentType ?? inferWorkspaceContentType(entry.path) }));
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total > MAX_WORKSPACE_BYTES) return fail("workspace_limit_exceeded", 413);
    const verified = await this.verifyEntries(scope, entries);
    if (verified) return verified;
    const encoded = canonicalManifest(entries);
    const manifestHash = await sha256Hex(new TextEncoder().encode(encoded));
    const objectKey = manifestKey(scope, manifestHash);
    const uploadIntentId = crypto.randomUUID();
    const uploadIntentKey = `upload-intent:${uploadIntentId}`;
    const protectedUpload = await this.protectUpload(scope, uploadIntentId, objectKey);
    if (protectedUpload !== "ready") return protectedUpload === "erased" ? fail("workspace_erased", 410)
      : protectedUpload === "gc_busy" ? fail("workspace_gc_in_progress", 423)
        : protectedUpload === "intent_limit" ? fail("workspace_upload_intent_limit", 413) : fail("workspace_scope_mismatch", 403);
    const put = await this.env.SCRIPTS_R2!.put(objectKey, encoded, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: manifestHash } });
    const createdManifestKey = put ? objectKey : null;
    if (!put) {
      const existing = await this.env.SCRIPTS_R2!.get(objectKey);
      if (!existing || await sha256Hex(new Uint8Array(await existing.arrayBuffer())) !== manifestHash) return fail("manifest_persist_failed", 503);
    }
    const head: WorkspaceHead = { version: 1, scope, branch, revision: 1, manifestHash, parentRevision: null, publicationId: null, updatedAt: new Date().toISOString() };
    const result = await this.ctx.storage.transaction(async (tx) => {
      const gc = await tx.get<ContentGcState>("content_gc");
      if (gc && gc.lockUntil > Date.now()) return "gc_busy";
      const activeMigration = await tx.get<WorkspaceMigration>("project_migration");
      if (activeMigration && activeMigration.status !== "verified" && !allowMigration) return "migration_barrier";
      if (allowMigration && (!activeMigration || (activeMigration.status !== "importing" && activeMigration.status !== "restoring"))) return "migration_barrier";
      const known = await tx.get<WorkspaceScope>("scope");
      if (await tx.get<boolean>("erased")) return "erased";
      if (known && JSON.stringify(known) !== JSON.stringify(scope)) return "scope_conflict";
      const current = await tx.get<WorkspaceHead>(headKey(branch));
      if (current) return current.manifestHash === manifestHash ? "exists" : "head_exists";
      await tx.put("scope", scope);
      await tx.put(headKey(branch), head);
      await tx.put(retainedRevisionKey(branch, head.revision), { branch, revision: head.revision, manifestHash: head.manifestHash, createdAt: head.updatedAt } satisfies RetainedRevision);
      await tx.put(revisionEventKey(branch, 1), { branch, revision: 1, publicationId: null, changedPaths: [], updatedAt: head.updatedAt } satisfies RevisionEvent);
      if (!allowMigration) await tx.put("workspace_read_policy", { mode: "coordinator", generation: 1, migrationId: null, updatedAt: head.updatedAt } satisfies WorkspaceReadPolicy);
      await tx.delete(uploadIntentKey);
      return "created";
    });
    if (result === "scope_conflict") { await this.ctx.storage.delete(uploadIntentKey); return fail("workspace_scope_mismatch", 403); }
    if (result === "erased" || result === "head_exists" || result === "gc_busy" || result === "migration_barrier") {
      if (createdManifestKey) await this.env.SCRIPTS_R2!.delete(createdManifestKey);
      await this.ctx.storage.delete(uploadIntentKey);
      return result === "erased" ? fail("workspace_erased", 410) : result === "gc_busy" || result === "migration_barrier" ? fail(result === "gc_busy" ? "workspace_gc_in_progress" : "workspace_migration_barrier_active", 423) : fail("workspace_head_exists", 409);
    }
    if (result !== "created") await this.ctx.storage.delete(uploadIntentKey);
    if (result === "created") await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return json({ head: result === "created" ? head : await this.ctx.storage.get<WorkspaceHead>(headKey(branch)), created: result === "created" });
  }

  private async validateLegacyBranchInventory(prefix: string, branchNames: string[]): Promise<void> {
    if (branchNames.length > MAX_MIGRATION_BRANCHES || branchNames.some(name => !validateWorkspaceBranch(name) || name === "main") || new Set(branchNames).size !== branchNames.length) {
      throw new Error("workspace_migration_branch_inventory_invalid");
    }
    const sorted = [...branchNames].sort();
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index]!.startsWith(`${sorted[index - 1]}/`)) throw new Error("workspace_migration_branch_inventory_ambiguous");
    }
    const branchPrefix = `${prefix}branches/`;
    let cursor: string | undefined;
    do {
      const page = await this.env.SCRIPTS_R2!.list({ prefix: branchPrefix, ...(cursor ? { cursor } : {}), limit: 1000, include: ["customMetadata"] });
      for (const object of page.objects) {
        const relative = object.key.slice(branchPrefix.length);
        const matches = branchNames.filter(name => relative.startsWith(`${name}/`));
        if (matches.length !== 1) throw new Error(matches.length ? "workspace_migration_branch_inventory_ambiguous" : "workspace_migration_branch_inventory_required");
        const path = relative.slice(matches[0]!.length + 1);
        if (!validateWorkspacePath(path)) throw new Error("workspace_migration_invalid_legacy_path");
      }
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && !cursor) throw new Error("workspace_migration_cursor_missing");
    } while (cursor);
  }

  private async scanLegacyProject(scope: WorkspaceScope, prefix: string, storeContentObjects = false, branchTree = false): Promise<{ entries: WorkspaceEntry[]; tombstones: string[]; totalBytes: number }> {
    const entries: WorkspaceEntry[] = [];
    const tombstones: string[] = [];
    let totalBytes = 0;
    let cursor: string | undefined;
    do {
      const page = await this.env.SCRIPTS_R2!.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000, include: ["customMetadata", "httpMetadata"] });
      for (const object of page.objects) {
        const path = object.key.slice(prefix.length);
        if (!path || path === ".keep") continue;
        if (!branchTree && path.startsWith("branches/")) continue;
        if (object.customMetadata?.deleted === "true") {
          tombstones.push(path);
          continue;
        }
        if (!validateWorkspacePath(path)) throw new Error("workspace_migration_invalid_legacy_path");
        const source = await this.env.SCRIPTS_R2!.get(object.key);
        if (!source) throw new Error("workspace_migration_source_changed");
        const bytes = new Uint8Array(await source.arrayBuffer());
        if (bytes.byteLength > MAX_FILE_BYTES || (totalBytes += bytes.byteLength) > MAX_MIGRATION_BYTES || entries.length >= MAX_MIGRATION_FILES) throw new Error("workspace_migration_limit_exceeded");
        const hash = await sha256Hex(bytes);
        if (object.customMetadata?.sha256 && object.customMetadata.sha256 !== hash) throw new Error("workspace_migration_legacy_hash_mismatch");
        const objectKey = `${contentPrefix(scope)}${hash}`;
        const contentType = object.httpMetadata?.contentType ?? inferWorkspaceContentType(path);
        if (storeContentObjects) {
          const stored = await this.env.SCRIPTS_R2!.put(objectKey, bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: hash, size: String(bytes.byteLength) }, ...(contentType ? { httpMetadata: { contentType } } : {}) });
          if (!stored) {
            const existing = await this.env.SCRIPTS_R2!.get(objectKey);
            if (!existing || await sha256Hex(new Uint8Array(await existing.arrayBuffer())) !== hash) throw new Error("workspace_migration_content_integrity_failed");
          }
        }
        const executable = object.customMetadata?.executable === "true";
        entries.push({ path, sha256: hash, size: bytes.byteLength, executable, objectKey, ...(contentType ? { contentType } : {}) });
      }
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && !cursor) throw new Error("workspace_migration_cursor_missing");
    } while (cursor);
    if (entries.length > MAX_MIGRATION_FILES || totalBytes > MAX_MIGRATION_BYTES) throw new Error("workspace_migration_limit_exceeded");
    entries.sort((a, b) => a.path.localeCompare(b.path));
    tombstones.sort();
    return { entries, tombstones, totalBytes };
  }

  private async inventorySummary(entries: WorkspaceEntry[], tombstones: string[]): Promise<InventorySummary> {
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
    const normalized = sorted.map(entry => [entry.path, entry.sha256, entry.size, entry.contentType ?? inferWorkspaceContentType(entry.path), entry.executable === true]);
    const hashRows = async (rows: unknown[]) => sha256Hex(new TextEncoder().encode(JSON.stringify(rows)));
    const normalizedTombstones = [...tombstones].sort();
    return {
      inventoryHash: await hashRows(normalized),
      pathHash: await hashRows(sorted.map(entry => entry.path)),
      contentHash: await hashRows(sorted.map(entry => [entry.path, entry.sha256])),
      sizeHash: await hashRows(sorted.map(entry => [entry.path, entry.size])),
      mimeHash: await hashRows(sorted.map(entry => [entry.path, entry.contentType ?? inferWorkspaceContentType(entry.path)])),
      executableHash: await hashRows(sorted.map(entry => [entry.path, entry.executable === true])),
      tombstoneHash: await hashRows(normalizedTombstones),
      fileCount: entries.length,
      tombstoneCount: tombstones.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    };
  }

  private async importLegacyBranch(scope: WorkspaceScope, branch: string, desiredEntries: WorkspaceEntry[], tenantId: string, options: { seedFromMain?: boolean; expectedRevision?: number; stageNamespace?: string } = {}): Promise<WorkspaceHead> {
    if (options.seedFromMain !== false) {
      const created = await this.createBranch({ scope, sourceBranch: "main", branch }, tenantId, true);
      if (!created.ok) throw new Error(`workspace_migration_branch_create_failed:${created.status}`);
      const parent = await this.ctx.storage.get<{ parentBranch: string; revision: number; manifestHash: string }>(branchBaseKey(branch));
      if (parent?.parentBranch !== "main") throw new Error("workspace_migration_branch_parent_mismatch");
    }
    let head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!head) throw new Error("workspace_migration_branch_head_missing");
    if (options.expectedRevision !== undefined && head.revision !== options.expectedRevision) throw new Error("workspace_migration_restore_head_changed");
    let currentEntries = await this.readManifestEntries(head);
    const target = new Map(desiredEntries.map(entry => [entry.path, entry]));
    const current = new Map(currentEntries.map(entry => [entry.path, entry]));
    const paths = [...new Set([...target.keys(), ...current.keys()])].sort();
    const changedPaths = paths.filter(path => entrySignature(target.get(path)) !== entrySignature(current.get(path)));
    if (changedPaths.length) {
      const opened = await this.open({ scope, branch, actorId: "workspace-migration", runtimeId: "workspace-migration", allocationGeneration: 1 }, tenantId);
      if (!opened.ok) throw new Error(`workspace_migration_branch_session_failed:${opened.status}`);
      const openedBody = await opened.json() as { session?: Session };
      const session = openedBody.session;
      if (!session) throw new Error("workspace_migration_branch_session_missing");
      try {
        const branchDigest = (await sha256Hex(new TextEncoder().encode(branch))).slice(0, 20);
        let batchPaths: string[] = [];
        let batchBytes = 0;
        const publishBatch = async (): Promise<void> => {
          if (!batchPaths.length) return;
          const changes: Change[] = [];
          for (const path of batchPaths) {
            const next = target.get(path);
            const previous = current.get(path);
            if (!next) {
              changes.push({ path, expectedHash: previous?.sha256 ?? null, contentBase64: null });
              continue;
            }
            const object = await this.env.SCRIPTS_R2!.get(next.objectKey);
            if (!object || object.size !== next.size) throw new Error("workspace_migration_branch_content_unavailable");
            const bytes = new Uint8Array(await object.arrayBuffer());
            if (await sha256Hex(bytes) !== next.sha256) throw new Error("workspace_migration_branch_content_integrity_failed");
            changes.push({ path, expectedHash: previous?.sha256 ?? null, contentBase64: base64(bytes), executable: next.executable, ...(next.contentType ? { contentType: next.contentType } : {}) });
          }
          const changeDigest = (await sha256Hex(new TextEncoder().encode(JSON.stringify(changes)))).slice(0, 20);
          const stageId = `${options.stageNamespace ?? "migration"}-${branchDigest}-${head!.revision}-${changeDigest}`;
          const staged = await this.stage({ sessionId: session.id, stageId, allocationGeneration: session.allocationGeneration, fence: session.fence, runtimeId: session.runtimeId, changes });
          if (!staged.ok) throw new Error(`workspace_migration_branch_stage_failed:${staged.status}`);
          const checkpoint = await this.checkpoint({ sessionId: session.id, stageId, idempotencyKey: stageId, baseRevision: head!.revision,
            allocationGeneration: session.allocationGeneration, fence: session.fence, runtimeId: session.runtimeId });
          if (!checkpoint.ok) throw new Error(`workspace_migration_branch_checkpoint_failed:${checkpoint.status}`);
          const body = await checkpoint.json() as { publication?: WorkspacePublicationReceipt };
          if (!body.publication || body.publication.status === "conflicted") throw new Error("workspace_migration_branch_checkpoint_conflicted");
          for (const path of batchPaths) {
            const entry = target.get(path);
            if (entry) current.set(path, entry); else current.delete(path);
          }
          batchPaths = [];
          batchBytes = 0;
          head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
          if (!head) throw new Error("workspace_migration_branch_head_missing");
        };
        for (const path of changedPaths) {
          const size = target.get(path)?.size ?? 0;
          if (batchPaths.length && (batchPaths.length >= MAX_CHANGES || batchBytes + size > MAX_FILE_BYTES)) await publishBatch();
          batchPaths.push(path);
          batchBytes += size;
        }
        await publishBatch();
      } finally {
        const closed = await this.close({ sessionId: session.id, runtimeId: session.runtimeId });
        if (!closed.ok) throw new Error(`workspace_migration_branch_session_close_failed:${closed.status}`);
      }
    }
    head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!head) throw new Error("workspace_migration_branch_head_missing");
    currentEntries = await this.readManifestEntries(head);
    const signature = (entries: WorkspaceEntry[]) => JSON.stringify(entries.map(entry => [entry.path, entry.sha256, entry.size, entry.executable, entry.contentType ?? inferWorkspaceContentType(entry.path)]));
    if (signature(currentEntries) !== signature(desiredEntries)) throw new Error("workspace_migration_branch_manifest_mismatch");
    const invalid = await this.verifyEntries(scope, currentEntries);
    if (invalid) throw new Error("workspace_migration_branch_content_integrity_failed");
    return head;
  }

  private async migrateLegacyProject(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId || typeof body.migrationId !== "string" || !ID.test(body.migrationId)) return fail("invalid_workspace_migration_request");
    const branchNames = body.branchNames === undefined ? [] : body.branchNames;
    if (!Array.isArray(branchNames) || branchNames.length > MAX_MIGRATION_BRANCHES || branchNames.some(name => typeof name !== "string" || !validateWorkspaceBranch(name) || name === "main") || new Set(branchNames).size !== branchNames.length) return fail("workspace_migration_branch_inventory_invalid");
    const normalizedBranches = [...branchNames].sort() as string[];
    const scope = body.scope;
    const knownScope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (knownScope && JSON.stringify(knownScope) !== JSON.stringify(scope)) return fail("workspace_scope_mismatch", 403);
    const prefix = `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`;
    const prior = await this.ctx.storage.get<WorkspaceMigration>("project_migration");
    if (prior?.migrationId !== undefined && prior.migrationId !== body.migrationId) return fail("workspace_migration_id_conflict", 409);
    if (prior?.status === "restoring") return fail("workspace_migration_restore_in_progress", 423);
    const head = await this.ctx.storage.get<WorkspaceHead>(headKey("main"));
    if (prior?.branchNames && JSON.stringify(prior.branchNames) !== JSON.stringify(normalizedBranches) && (head || prior.status === "verified")) return fail("workspace_migration_branch_inventory_changed", 409);
    if (prior?.status === "verified") return json({ migration: prior, rollbackAlias: await this.ctx.storage.get<WorkspaceRollbackAlias>("legacy_rollback_alias") ?? null, replay: true });
    if (head && !prior) return fail("workspace_already_initialized", 409);
    const migration: WorkspaceMigration = { migrationId: body.migrationId, status: "barrier", sourcePrefix: prefix, startedAt: prior?.startedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), branchNames: normalizedBranches };
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<WorkspaceMigration>("project_migration");
      if (current?.migrationId && current.migrationId !== migration.migrationId) throw new Error("workspace_migration_id_conflict");
      await tx.put("scope", scope);
      await tx.put("project_migration", migration);
      const policy = await tx.get<WorkspaceReadPolicy>("workspace_read_policy");
      await tx.put("workspace_read_policy", { mode: "shadow", generation: policy?.generation ?? 0, migrationId: migration.migrationId, updatedAt: new Date().toISOString() } satisfies WorkspaceReadPolicy);
      await tx.put("legacy_rollback_alias", { sourcePrefix: prefix, migrationId: migration.migrationId, retainedAt: migration.startedAt, verificationStatus: "pending", revision: 0, manifestHash: "", branchNames: normalizedBranches } satisfies WorkspaceRollbackAlias);
    });
    try {
      migration.status = "importing";
      migration.updatedAt = new Date().toISOString();
      await this.ctx.storage.put("project_migration", migration);
      const scan = async (storeContentObjects: boolean) => {
        await this.validateLegacyBranchInventory(prefix, normalizedBranches);
        const main = await this.scanLegacyProject(scope, prefix, storeContentObjects);
        const branches: Array<{ name: string; tree: Awaited<ReturnType<WorkspaceCoordinatorDO["scanLegacyProject"]>> }> = [];
        let totalBytes = main.totalBytes;
        for (const branch of normalizedBranches) {
          const tree = await this.scanLegacyProject(scope, `${prefix}branches/${branch}/`, storeContentObjects, true);
          if ((totalBytes += tree.totalBytes) > MAX_MIGRATION_ALL_BRANCH_BYTES) throw new Error("workspace_migration_all_branches_limit_exceeded");
          branches.push({ name: branch, tree });
        }
        return { main, branches, totalBytes };
      };
      const signature = (entries: WorkspaceEntry[]) => JSON.stringify(entries.map(({ path, sha256, size, contentType, executable }) => [path, sha256, size, contentType ?? inferWorkspaceContentType(path), executable === true]));
      const snapshotSignature = (snapshot: Awaited<ReturnType<typeof scan>>) => JSON.stringify({
        main: signature(snapshot.main.entries), mainTombstones: snapshot.main.tombstones,
        branches: snapshot.branches.map(({ name, tree }) => [name, signature(tree.entries), tree.tombstones]),
      });
      const first = await scan(true);
      const second = await scan(false);
      if (snapshotSignature(first) !== snapshotSignature(second) || first.totalBytes !== second.totalBytes) throw new Error("workspace_migration_source_changed");
      const sourceInventory: Record<string, InventorySummary> = { main: await this.inventorySummary(first.main.entries, first.main.tombstones) };
      for (const branch of first.branches) sourceInventory[branch.name] = await this.inventorySummary(branch.tree.entries, branch.tree.tombstones);
      migration.sourceInventory = sourceInventory;
      migration.updatedAt = new Date().toISOString();
      await this.ctx.storage.put("project_migration", migration);
      let currentHead = await this.ctx.storage.get<WorkspaceHead>(headKey("main"));
      if (currentHead) {
        const currentEntries = await this.readManifestEntries(currentHead);
        if (currentHead.revision !== 1 || signature(currentEntries) !== signature(first.main.entries)) throw new Error("workspace_migration_existing_head_mismatch");
      } else {
        const initialized = await this.initialize({ scope, branch: "main", entries: first.main.entries }, tenantId, true);
        if (!initialized.ok) {
          const result = await initialized.json() as { error_code?: string };
          throw new Error(result.error_code ?? `workspace_migration_initialize_failed:${initialized.status}`);
        }
        currentHead = await this.ctx.storage.get<WorkspaceHead>(headKey("main"));
      }
      if (!currentHead || currentHead.revision !== 1) throw new Error("workspace_migration_initial_revision_unverified");
      const mainEntries = await this.readManifestEntries(currentHead);
      if (signature(mainEntries) !== signature(first.main.entries)) throw new Error("workspace_migration_manifest_hash_mismatch");
      const branchHeads: Record<string, { revision: number; manifestHash: string }> = {};
      for (const { name, tree } of first.branches) {
        const effective = new Map(first.main.entries.map(entry => [entry.path, entry]));
        for (const path of tree.tombstones) effective.delete(path);
        for (const entry of tree.entries) effective.set(entry.path, entry);
        const importedHead = await this.importLegacyBranch(scope, name, [...effective.values()].sort((a, b) => a.path.localeCompare(b.path)), tenantId);
        branchHeads[name] = { revision: importedHead.revision, manifestHash: importedHead.manifestHash };
      }
      const currentLegacy = await scan(false);
      if (snapshotSignature(currentLegacy) !== snapshotSignature(first)) throw new Error("workspace_migration_source_changed");
      const finalSnapshot = await this.readManifestEntries(currentHead);
      if (signature(finalSnapshot) !== signature(first.main.entries)) throw new Error("workspace_migration_manifest_hash_mismatch");
      migration.status = "verified";
      migration.revision = currentHead.revision;
      migration.manifestHash = currentHead.manifestHash;
      migration.updatedAt = new Date().toISOString();
      await this.ctx.storage.transaction(async tx => {
        await tx.put("project_migration", migration);
        const alias = await tx.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
        await tx.put("legacy_rollback_alias", { ...alias, sourcePrefix: prefix, migrationId: migration.migrationId, retainedAt: migration.startedAt, verificationStatus: "verified", revision: currentHead.revision, manifestHash: currentHead.manifestHash, branchNames: normalizedBranches, branchHeads, sourceInventory } satisfies WorkspaceRollbackAlias);
      });
      return json({ migration, rollbackAlias: await this.ctx.storage.get<WorkspaceRollbackAlias>("legacy_rollback_alias"), fileCount: first.main.entries.length, branchCount: first.branches.length, branchHeads, totalBytes: first.totalBytes }, head ? 200 : 201);
    } catch (error) {
      migration.status = "failed";
      migration.errorCode = error instanceof Error ? error.message.slice(0, 128) : "workspace_migration_failed";
      migration.updatedAt = new Date().toISOString();
      await this.ctx.storage.put("project_migration", migration);
      const errorCode = migration.errorCode.startsWith("workspace_migration_branch_") ? migration.errorCode : "workspace_migration_failed";
      return json({ error_code: errorCode, migration }, 503);
    }
  }

  private async repairMigratedProject(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId || typeof body.migrationId !== "string" || !ID.test(body.migrationId)) return fail("invalid_workspace_migration_repair_request");
    const scope = body.scope;
    const migration = await this.ctx.storage.get<WorkspaceMigration>("project_migration");
    const alias = await this.ctx.storage.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
    const policy = await this.getReadPolicy();
    if (!migration || migration.migrationId !== body.migrationId || !alias || alias.migrationId !== migration.migrationId || alias.verificationStatus !== "verified" ||
        policy.mode !== "shadow" || !["verified", "failed"].includes(migration.status)) return fail("workspace_migration_repair_unavailable", 409);
    const started = await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<WorkspaceMigration>("project_migration");
      const currentPolicy = await tx.get<WorkspaceReadPolicy>("workspace_read_policy");
      if (!current || current.migrationId !== migration.migrationId || !["verified", "failed"].includes(current.status) || currentPolicy?.mode !== "shadow") return false;
      await tx.put("project_migration", { ...current, status: "repairing", updatedAt: new Date().toISOString() });
      return true;
    });
    if (!started) return fail("workspace_migration_repair_busy", 423);
    try {
      const scan = async (storeContentObjects: boolean) => {
        await this.validateLegacyBranchInventory(alias.sourcePrefix, migration.branchNames ?? []);
        const main = await this.scanLegacyProject(scope, alias.sourcePrefix, storeContentObjects);
        const branches: Array<{ name: string; tree: Awaited<ReturnType<WorkspaceCoordinatorDO["scanLegacyProject"]>> }> = [];
        let totalBytes = main.totalBytes;
        for (const branch of migration.branchNames ?? []) {
          const tree = await this.scanLegacyProject(scope, `${alias.sourcePrefix}branches/${branch}/`, storeContentObjects, true);
          if ((totalBytes += tree.totalBytes) > MAX_MIGRATION_ALL_BRANCH_BYTES) throw new Error("workspace_migration_all_branches_limit_exceeded");
          branches.push({ name: branch, tree });
        }
        return { main, branches, totalBytes };
      };
      const signature = (entries: WorkspaceEntry[]) => JSON.stringify(entries.map(({ path, sha256, size, contentType, executable }) => [path, sha256, size, contentType ?? inferWorkspaceContentType(path), executable === true]));
      const snapshotSignature = (snapshot: Awaited<ReturnType<typeof scan>>) => JSON.stringify({
        main: signature(snapshot.main.entries), mainTombstones: snapshot.main.tombstones,
        branches: snapshot.branches.map(({ name, tree }) => [name, signature(tree.entries), tree.tombstones]),
      });
      const first = await scan(true);
      const second = await scan(false);
      if (snapshotSignature(first) !== snapshotSignature(second) || first.totalBytes !== second.totalBytes) throw new Error("workspace_migration_source_changed");
      const sourceInventory: Record<string, InventorySummary> = { main: await this.inventorySummary(first.main.entries, first.main.tombstones) };
      for (const branch of first.branches) sourceInventory[branch.name] = await this.inventorySummary(branch.tree.entries, branch.tree.tombstones);

      const mainBefore = await this.ctx.storage.get<WorkspaceHead>(headKey("main"));
      if (!mainBefore) throw new Error("workspace_migration_head_missing");
      const mainHead = await this.importLegacyBranch(scope, "main", first.main.entries, tenantId, { seedFromMain: false, expectedRevision: mainBefore.revision });
      const branchHeads: Record<string, { revision: number; manifestHash: string }> = {};
      for (const { name, tree } of first.branches) {
        const currentBranch = await this.ctx.storage.get<WorkspaceHead>(headKey(name));
        if (!currentBranch) throw new Error("workspace_migration_branch_head_missing");
        const effective = new Map(first.main.entries.map(entry => [entry.path, entry]));
        for (const path of tree.tombstones) effective.delete(path);
        for (const entry of tree.entries) effective.set(entry.path, entry);
        await this.ctx.storage.transaction(async tx => {
          const branchHead = await tx.get<WorkspaceHead>(headKey(name));
          const parentHead = await tx.get<WorkspaceHead>(headKey("main"));
          if (!branchHead || branchHead.revision !== currentBranch.revision || branchHead.manifestHash !== currentBranch.manifestHash || !parentHead || parentHead.revision !== mainHead.revision || parentHead.manifestHash !== mainHead.manifestHash) throw new Error("workspace_migration_branch_head_changed");
          await tx.put(branchBaseKey(name), { parentBranch: "main", revision: parentHead.revision, manifestHash: parentHead.manifestHash });
        });
        const repaired = await this.importLegacyBranch(scope, name, [...effective.values()].sort((a, b) => a.path.localeCompare(b.path)), tenantId, { seedFromMain: false, expectedRevision: currentBranch.revision });
        branchHeads[name] = { revision: repaired.revision, manifestHash: repaired.manifestHash };
      }
      const finalSource = await scan(false);
      if (snapshotSignature(first) !== snapshotSignature(finalSource) || first.totalBytes !== finalSource.totalBytes) throw new Error("workspace_migration_source_changed");
      const verifiedMain = await this.readManifestEntries(mainHead);
      if (signature(first.main.entries) !== signature(verifiedMain)) throw new Error("workspace_migration_repair_verification_failed");
      for (const { name, tree } of first.branches) {
        const head = await this.ctx.storage.get<WorkspaceHead>(headKey(name));
        if (!head) throw new Error("workspace_migration_branch_head_missing");
        const expected = new Map(first.main.entries.map(entry => [entry.path, entry]));
        for (const path of tree.tombstones) expected.delete(path);
        for (const entry of tree.entries) expected.set(entry.path, entry);
        if (signature([...expected.values()].sort((a, b) => a.path.localeCompare(b.path))) !== signature(await this.readManifestEntries(head))) throw new Error("workspace_migration_repair_verification_failed");
        branchHeads[name] = { revision: head.revision, manifestHash: head.manifestHash };
      }
      const completedAt = new Date().toISOString();
      const repairedReceipt = { migrationId: migration.migrationId, completedAt, sourceInventory, repairedBranchCount: (migration.branchNames?.length ?? 0) + 1, status: "verified" as const };
      await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<WorkspaceMigration>("project_migration");
        const currentAlias = await tx.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
        const currentPolicy = await tx.get<WorkspaceReadPolicy>("workspace_read_policy");
        if (!current || current.status !== "repairing" || current.migrationId !== migration.migrationId || !currentAlias || currentAlias.migrationId !== migration.migrationId || currentPolicy?.mode !== "shadow") throw new Error("workspace_migration_repair_state_changed");
        await tx.put("project_migration", { ...current, status: "verified", revision: mainHead.revision, manifestHash: mainHead.manifestHash, sourceInventory, updatedAt: completedAt });
        await tx.put("legacy_rollback_alias", { ...currentAlias, revision: mainHead.revision, manifestHash: mainHead.manifestHash, branchHeads, sourceInventory });
        await tx.put("workspace_migration_repair_receipt", repairedReceipt);
        await tx.delete("migration_cutover_attempt");
      });
      return json({ migration: await this.ctx.storage.get("project_migration"), repair: repairedReceipt, branchHeads });
    } catch {
      const current = await this.ctx.storage.get<WorkspaceMigration>("project_migration");
      if (current?.migrationId === migration.migrationId && current.status === "repairing") await this.ctx.storage.put("project_migration", { ...current, status: "failed", errorCode: "workspace_migration_repair_failed", updatedAt: new Date().toISOString() });
      return fail("workspace_migration_repair_failed", 503);
    }
  }

  private async cutoverMigratedProject(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    if (this.env.UNIFIED_WORKSPACE_ENABLED !== "true") return fail("workspace_global_kill_switch_active", 423);
    if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId || typeof body.migrationId !== "string" || !ID.test(body.migrationId) ||
        !Number.isSafeInteger(body.rollbackWindowMs) || Number(body.rollbackWindowMs) < 60 * 60_000 || Number(body.rollbackWindowMs) > 90 * 24 * 60 * 60_000) return fail("invalid_workspace_cutover_request");
    const scope = body.scope;
    const migration = await this.ctx.storage.get<WorkspaceMigration>("project_migration");
    const alias = await this.ctx.storage.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
    const policy = await this.getReadPolicy();
    if (!migration || migration.migrationId !== body.migrationId || !alias || alias.migrationId !== migration.migrationId || alias.verificationStatus !== "verified") return fail("workspace_migration_cutover_unavailable", 409);
    if (policy.mode === "coordinator" && policy.receipt?.migrationId === migration.migrationId) return json({ readPolicy: policy, replay: true });
    if (policy.mode !== "shadow" || (migration.status !== "verified" && migration.status !== "cutover")) return fail("workspace_migration_cutover_unavailable", 409);

    const start = await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<WorkspaceMigration>("project_migration");
      const currentPolicy = await tx.get<WorkspaceReadPolicy>("workspace_read_policy");
      const currentAlias = await tx.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
      if (!current || current.migrationId !== migration.migrationId || (current.status !== "verified" && current.status !== "cutover") ||
          currentAlias?.verificationStatus !== "verified" || currentPolicy?.mode !== "shadow") return false;
      await tx.put("project_migration", { ...current, status: "cutover", updatedAt: new Date().toISOString() });
      return true;
    });
    if (!start) return fail("workspace_migration_cutover_busy", 423);

    const branches = ["main", ...(migration.branchNames ?? [])];
    const beforeHeads: Record<string, WorkspaceHead> = {};
    const receipt: WorkspaceCutoverReceipt = {
      migrationId: migration.migrationId,
      generation: policy.generation + 1,
      verifiedAt: new Date().toISOString(),
      branches: {}, mismatchCount: 0, readErrorCount: 0, omittedPathCount: 0, truncatedPages: 0,
    };
    let mismatchClass: "inventory_mismatch" | "path_omission" | "read_error" | "truncated_inventory" | undefined;
    try {
      const prefix = alias.sourcePrefix;
      if (prefix !== `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`) throw new Error("scope");
      await this.validateLegacyBranchInventory(prefix, migration.branchNames ?? []);
      const mainLegacy = await this.scanLegacyProject(scope, prefix, false);
      const effectiveTrees = new Map<string, { entries: WorkspaceEntry[]; tombstones: string[] }>();
      effectiveTrees.set("main", { entries: mainLegacy.entries, tombstones: mainLegacy.tombstones });
      for (const branch of migration.branchNames ?? []) {
        const overlay = await this.scanLegacyProject(scope, `${prefix}branches/${branch}/`, false, true);
        const effective = new Map(mainLegacy.entries.map(entry => [entry.path, entry]));
        for (const path of overlay.tombstones) effective.delete(path);
        for (const entry of overlay.entries) effective.set(entry.path, entry);
        effectiveTrees.set(branch, { entries: [...effective.values()].sort((a, b) => a.path.localeCompare(b.path)), tombstones: [...mainLegacy.tombstones, ...overlay.tombstones].sort() });
      }
      for (const branch of branches) {
        const head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
        if (!head || head.branch !== branch || JSON.stringify(head.scope) !== JSON.stringify(scope)) throw new Error("head");
        beforeHeads[branch] = head;
        const manifestEntries = await this.readManifestEntries(head);
        const legacyTree = effectiveTrees.get(branch);
        if (!legacyTree) throw new Error("inventory");
        const legacySummary = await this.inventorySummary(legacyTree.entries, legacyTree.tombstones);
        const manifestSummary = await this.inventorySummary(manifestEntries, []);
        const sameInventory = legacySummary.inventoryHash === manifestSummary.inventoryHash &&
          legacySummary.pathHash === manifestSummary.pathHash && legacySummary.contentHash === manifestSummary.contentHash &&
          legacySummary.sizeHash === manifestSummary.sizeHash && legacySummary.mimeHash === manifestSummary.mimeHash &&
          legacySummary.executableHash === manifestSummary.executableHash && legacySummary.fileCount === manifestSummary.fileCount &&
          legacySummary.totalBytes === manifestSummary.totalBytes;
        if (!sameInventory) {
          receipt.mismatchCount++;
          const legacyPaths = new Set(legacyTree.entries.map(entry => entry.path));
          const manifestPaths = new Set(manifestEntries.map(entry => entry.path));
          for (const path of legacyPaths) if (!manifestPaths.has(path)) receipt.omittedPathCount++;
          for (const path of manifestPaths) if (!legacyPaths.has(path)) receipt.omittedPathCount++;
          mismatchClass = receipt.omittedPathCount ? "path_omission" : "inventory_mismatch";
        }
        receipt.branches[branch] = { revision: head.revision, manifestHash: head.manifestHash, legacy: legacySummary, manifest: manifestSummary };
      }
    } catch (error) {
      receipt.readErrorCount = 1;
      mismatchClass = error instanceof Error && error.message.includes("cursor") ? "truncated_inventory" : "read_error";
      if (mismatchClass === "truncated_inventory") receipt.truncatedPages = 1;
    }

    if (receipt.mismatchCount || receipt.readErrorCount || receipt.omittedPathCount || receipt.truncatedPages) {
      await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<WorkspaceMigration>("project_migration");
        if (current?.migrationId === migration.migrationId && current.status === "cutover") await tx.put("project_migration", { ...current, status: "verified", updatedAt: new Date().toISOString() });
        await tx.put("migration_cutover_attempt", { migrationId: migration.migrationId, attemptedAt: receipt.verifiedAt,
          mismatchClass: mismatchClass ?? "inventory_mismatch", mismatchCount: receipt.mismatchCount,
          readErrorCount: receipt.readErrorCount, omittedPathCount: receipt.omittedPathCount, truncatedPages: receipt.truncatedPages });
      });
      return json({ error_code: "workspace_migration_dual_read_mismatch", attempt: await this.ctx.storage.get("migration_cutover_attempt") }, 409);
    }

    const rollbackExpiresAt = new Date(Date.now() + Number(body.rollbackWindowMs)).toISOString();
    const applied = await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<WorkspaceMigration>("project_migration");
      const currentPolicy = await tx.get<WorkspaceReadPolicy>("workspace_read_policy");
      const currentAlias = await tx.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
      if (!current || current.migrationId !== migration.migrationId || current.status !== "cutover" || currentPolicy?.mode !== "shadow" || currentPolicy.generation !== policy.generation || !currentAlias || currentAlias.migrationId !== migration.migrationId) return false;
      for (const branch of branches) {
        const head = await tx.get<WorkspaceHead>(headKey(branch));
        const before = beforeHeads[branch];
        if (!head || !before || head.revision !== before.revision || head.manifestHash !== before.manifestHash) return false;
      }
      const verifiedAt = new Date().toISOString();
      receipt.verifiedAt = verifiedAt;
      await tx.put("workspace_read_policy", { mode: "coordinator", generation: policy.generation + 1, migrationId: migration.migrationId,
        updatedAt: verifiedAt, rollbackExpiresAt, receipt } satisfies WorkspaceReadPolicy);
      await tx.put("project_migration", { ...current, status: "verified", updatedAt: verifiedAt });
      await tx.put("legacy_rollback_alias", { ...currentAlias, rollbackExpiresAt, cleanupStatus: "pending" } satisfies WorkspaceRollbackAlias);
      await tx.delete("migration_cutover_attempt");
      return true;
    });
    if (!applied) {
      await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<WorkspaceMigration>("project_migration");
        if (current?.migrationId === migration.migrationId && current.status === "cutover") await tx.put("project_migration", { ...current, status: "verified", updatedAt: new Date().toISOString() });
      });
      return fail("workspace_migration_cutover_raced", 409);
    }
    return json({ readPolicy: await this.getReadPolicy(), rollbackAlias: await this.ctx.storage.get("legacy_rollback_alias"), receipt });
  }

  private async retireLegacyAlias(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId || typeof body.migrationId !== "string" || !ID.test(body.migrationId)) return fail("invalid_workspace_alias_cleanup_request");
    const scope = body.scope;
    const alias = await this.ctx.storage.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
    const policy = await this.getReadPolicy();
    const migration = await this.ctx.storage.get<WorkspaceMigration>("project_migration");
    const priorReceipt = await this.ctx.storage.get<{ migrationId: string; completedAt: string }>("legacy_alias_cleanup_receipt");
    if (!alias && priorReceipt?.migrationId === body.migrationId) return json({ cleanup: priorReceipt, replay: true });
    const receipt = policy.receipt;
    const rollbackExpiry = policy.rollbackExpiresAt ? Date.parse(policy.rollbackExpiresAt) : Number.NaN;
    if (!alias || alias.migrationId !== body.migrationId || alias.verificationStatus !== "verified" || migration?.status !== "verified" || migration.migrationId !== body.migrationId || policy.mode !== "coordinator" ||
        !receipt || receipt.migrationId !== body.migrationId || !Number.isFinite(rollbackExpiry) || rollbackExpiry > Date.now() ||
        alias.rollbackExpiresAt !== policy.rollbackExpiresAt || receipt.mismatchCount !== 0 || receipt.readErrorCount !== 0 || receipt.omittedPathCount !== 0 || receipt.truncatedPages !== 0 ||
        !Number.isFinite(Date.parse(receipt.verifiedAt)) || Date.parse(receipt.verifiedAt) > rollbackExpiry) return fail("workspace_rollback_window_active", 423);
    if (!this.env.SCRIPTS_R2 || alias.sourcePrefix !== `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`) return fail("workspace_alias_cleanup_scope_mismatch", 403);
    const expectedBranches = ["main", ...(alias.branchNames ?? [])].sort();
    const receiptBranches = Object.keys(receipt.branches).sort();
    if (JSON.stringify(expectedBranches) !== JSON.stringify(receiptBranches)) return fail("workspace_alias_cleanup_inventory_mismatch", 409);
    for (const branch of expectedBranches) {
      const head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
      const verified = receipt.branches[branch];
      const aliasHead = branch === "main"
        ? { revision: alias.revision, manifestHash: alias.manifestHash }
        : alias.branchHeads?.[branch];
      if (!head || head.branch !== branch || JSON.stringify(head.scope) !== JSON.stringify(scope) || !verified || !aliasHead ||
          verified.revision !== aliasHead.revision || verified.manifestHash !== aliasHead.manifestHash || !Number.isSafeInteger(verified.revision) || !HASH.test(verified.manifestHash)) {
        return fail("workspace_alias_cleanup_head_unavailable", 409);
      }
    }
    let cursor = alias.cleanupCursor;
    try {
      const page = await this.env.SCRIPTS_R2.list({ prefix: alias.sourcePrefix, ...(cursor ? { cursor } : {}), limit: 1000 });
      const keys = page.objects.map(object => object.key);
      if (keys.some(key => !key.startsWith(alias.sourcePrefix))) return fail("workspace_alias_cleanup_scope_mismatch", 403);
      if (keys.length) await this.env.SCRIPTS_R2.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && (!cursor || cursor === alias.cleanupCursor)) throw new Error("cleanup_cursor_missing_or_stalled");
      if (page.truncated) {
        await this.ctx.storage.put("legacy_rollback_alias", { ...alias, cleanupCursor: cursor, cleanupStatus: "cleaning" });
        return json({ cleanup: { migrationId: alias.migrationId, status: "cleaning", hasMore: true } }, 202);
      }
      const completedAt = new Date().toISOString();
      const cleanup = { migrationId: alias.migrationId, completedAt };
      await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
        const currentPolicy = await tx.get<WorkspaceReadPolicy>("workspace_read_policy");
        const currentMigration = await tx.get<WorkspaceMigration>("project_migration");
        if (!current || current.migrationId !== alias.migrationId || currentPolicy?.mode !== "coordinator" || currentPolicy.receipt?.migrationId !== alias.migrationId ||
            currentPolicy.rollbackExpiresAt !== alias.rollbackExpiresAt || !currentMigration || currentMigration.status !== "verified" || currentMigration.migrationId !== alias.migrationId) throw new Error("cleanup_state_changed");
        await tx.put("legacy_alias_cleanup_receipt", cleanup);
        await tx.delete("legacy_rollback_alias");
      });
      return json({ cleanup });
    } catch {
      const retryAlias: WorkspaceRollbackAlias = { ...alias, cleanupStatus: "pending" };
      if (cursor && cursor !== alias.cleanupCursor) retryAlias.cleanupCursor = cursor;
      else delete retryAlias.cleanupCursor;
      await this.ctx.storage.put("legacy_rollback_alias", retryAlias);
      return fail("workspace_alias_cleanup_retry_required", 503);
    }
  }

  /** Restore the immutable snapshots retained by a verified project migration. The operation
   * first compares every current branch head and installs a durable publication barrier. Each
   * branch is then restored through checked sessions/checkpoints; partial work is resumable and
   * never releases the barrier until every resulting manifest is verified. */
  private async restoreMigratedProject(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId || body.confirm !== true ||
        typeof body.restoreId !== "string" || !ID.test(body.restoreId)) return fail("invalid_workspace_restore_request");
    const scope = body.scope;
    const alias = await this.ctx.storage.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
    if (!alias || alias.verificationStatus !== "verified" || !HASH.test(alias.manifestHash) || !Number.isSafeInteger(alias.revision) || alias.revision < 1) return fail("workspace_migration_rollback_alias_unavailable", 409);
    const branchNames = alias.branchNames ?? [];
    if (branchNames.length > MAX_MIGRATION_BRANCHES || branchNames.some(branch => !validateWorkspaceBranch(branch) || branch === "main") || new Set(branchNames).size !== branchNames.length) return fail("workspace_migration_rollback_alias_invalid", 409);
    const branches = ["main", ...branchNames];
    const aliasHeads: Record<string, { revision: number; manifestHash: string }> = {
      main: { revision: alias.revision, manifestHash: alias.manifestHash },
      ...(alias.branchHeads ?? {}),
    };
    if (branches.some(branch => !aliasHeads[branch] || !Number.isSafeInteger(aliasHeads[branch]!.revision) || aliasHeads[branch]!.revision < 1 || !HASH.test(aliasHeads[branch]!.manifestHash)) ||
        Object.keys(aliasHeads).some(branch => !branches.includes(branch))) return fail("workspace_migration_rollback_alias_invalid", 409);

    let restore = await this.ctx.storage.get<WorkspaceRollbackRestore>("migration_restore");
    if (restore) {
      if (restore.restoreId !== body.restoreId) return fail("workspace_migration_restore_id_conflict", 409);
      if (restore.status === "verified") return json({ restore, replay: true });
    } else {
      const expectedRaw = body.expectedHeads;
      if (!expectedRaw || typeof expectedRaw !== "object" || Array.isArray(expectedRaw)) return fail("workspace_migration_restore_heads_required", 400);
      const expectedHeads = expectedRaw as Record<string, { revision?: unknown; manifestHash?: unknown }>;
      const expectedNames = Object.keys(expectedHeads).sort();
      if (JSON.stringify(expectedNames) !== JSON.stringify([...branches].sort()) || branches.some(branch => {
        const value = expectedHeads[branch];
        return !value || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.manifestHash !== "string" || !HASH.test(value.manifestHash);
      })) return fail("workspace_migration_restore_heads_invalid", 400);
      const normalizedExpected = Object.fromEntries(branches.map(branch => {
        const value = expectedHeads[branch]!;
        return [branch, { revision: Number(value.revision), manifestHash: value.manifestHash as string }];
      }));
      const nextRestore: WorkspaceRollbackRestore = { restoreId: body.restoreId, status: "restoring", startedAt: new Date().toISOString(), expectedHeads: normalizedExpected, completedBranches: [] };
      const started = await this.ctx.storage.transaction(async tx => {
        const migration = await tx.get<WorkspaceMigration>("project_migration");
        const currentAlias = await tx.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
        const currentScope = await tx.get<WorkspaceScope>("scope");
        const currentRestore = await tx.get<WorkspaceRollbackRestore>("migration_restore");
        if (currentRestore) return { error: "workspace_migration_restore_in_progress" };
        if (!migration || migration.status !== "verified" || migration.migrationId !== alias.migrationId || !currentAlias || currentAlias.verificationStatus !== "verified") return { error: "workspace_migration_not_verified" };
        if (currentScope && JSON.stringify(currentScope) !== JSON.stringify(scope)) return { error: "workspace_scope_mismatch" };
        for (const branch of branches) {
          const head = await tx.get<WorkspaceHead>(headKey(branch));
          const expected = normalizedExpected[branch]!;
          if (!head || head.revision !== expected.revision || head.manifestHash !== expected.manifestHash) return { error: "workspace_migration_restore_head_changed" };
        }
        migration.status = "restoring";
        migration.updatedAt = new Date().toISOString();
        await tx.put("project_migration", migration);
        await tx.put("migration_restore", nextRestore);
        return { restore: nextRestore };
      });
      if ("error" in started) return fail(started.error, started.error === "workspace_scope_mismatch" ? 403 : 409);
      restore = started.restore;
    }

    const restoreDigest = (await sha256Hex(new TextEncoder().encode(restore.restoreId))).slice(0, 16);
    const restoredHeads = { ...(restore.restoredHeads ?? {}) };
    try {
      for (const branch of branches) {
        const target = aliasHeads[branch]!;
        const retained = await this.ctx.storage.get<RetainedRevision>(retainedRevisionKey(branch, target.revision));
        if (!retained || retained.manifestHash !== target.manifestHash) throw new Error("workspace_migration_restore_snapshot_unavailable");
        const snapshotHead: WorkspaceHead = { version: 1, scope, branch, revision: target.revision, manifestHash: target.manifestHash, parentRevision: null, publicationId: null, updatedAt: retained.createdAt };
        const desiredEntries = await this.readManifestEntries(snapshotHead);
        if (await this.verifyEntries(scope, desiredEntries)) throw new Error("workspace_migration_restore_snapshot_integrity_failed");

        const currentHead = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
        if (!currentHead) throw new Error("workspace_migration_restore_head_missing");
        const finished = restoredHeads[branch];
        if (restore.completedBranches.includes(branch)) {
          if (!finished || currentHead.revision !== finished.revision || currentHead.manifestHash !== finished.manifestHash) throw new Error("workspace_migration_restore_head_changed");
          continue;
        }
        const starting = restore.expectedHeads[branch];
        if (!starting || currentHead.revision < starting.revision || (currentHead.revision === starting.revision && currentHead.manifestHash !== starting.manifestHash)) throw new Error("workspace_migration_restore_head_changed");
        if (currentHead.revision > starting.revision) {
          // A restart may happen after one of our checked batches published but before progress
          // metadata was saved. Accept only a contiguous chain of rollback-scoped receipts.
          const receipts = await this.ctx.storage.list<WorkspacePublicationReceipt>({ prefix: `receipt:${branch}:`, limit: 1000 });
          for (let revision = starting.revision + 1; revision <= currentHead.revision; revision++) {
            const event = await this.ctx.storage.get<RevisionEvent>(revisionEventKey(branch, revision));
            const receipt = [...receipts.values()].find(item => item.revision === revision && item.idempotencyKey.startsWith(`rollback-${restoreDigest}-`) && item.status === "published");
            if (!event || !receipt || event.publicationId !== receipt.id) throw new Error("workspace_migration_restore_progress_unverified");
          }
        }
        const head = await this.importLegacyBranch(scope, branch, desiredEntries, tenantId, {
          seedFromMain: false, expectedRevision: currentHead.revision, stageNamespace: `rollback-${restoreDigest}`,
        });
        const verifiedEntries = await this.readManifestEntries(head);
        if (JSON.stringify(verifiedEntries.map(entry => [entry.path, entry.sha256, entry.size, entry.executable, entry.contentType ?? inferWorkspaceContentType(entry.path)])) !==
            JSON.stringify(desiredEntries.map(entry => [entry.path, entry.sha256, entry.size, entry.executable, entry.contentType ?? inferWorkspaceContentType(entry.path)]))) throw new Error("workspace_migration_restore_manifest_mismatch");
        const savedHead = { revision: head.revision, manifestHash: head.manifestHash };
        const saved = await this.ctx.storage.transaction(async tx => {
          const currentRestore = await tx.get<WorkspaceRollbackRestore>("migration_restore");
          const migration = await tx.get<WorkspaceMigration>("project_migration");
          const latest = await tx.get<WorkspaceHead>(headKey(branch));
          if (!currentRestore || currentRestore.restoreId !== restore!.restoreId || currentRestore.status !== "restoring" || migration?.status !== "restoring" || !latest || latest.revision !== head.revision || latest.manifestHash !== head.manifestHash) return false;
          currentRestore.completedBranches = [...new Set([...currentRestore.completedBranches, branch])];
          currentRestore.restoredHeads = { ...(currentRestore.restoredHeads ?? {}), [branch]: savedHead };
          delete currentRestore.errorCode;
          await tx.put("migration_restore", currentRestore);
          return true;
        });
        if (!saved) throw new Error("workspace_migration_restore_head_changed");
        restore.completedBranches = [...new Set([...restore.completedBranches, branch])];
        restore.restoredHeads = { ...restoredHeads, [branch]: savedHead };
        restoredHeads[branch] = savedHead;
      }

      const completed = await this.ctx.storage.transaction(async tx => {
        const migration = await tx.get<WorkspaceMigration>("project_migration");
        const currentRestore = await tx.get<WorkspaceRollbackRestore>("migration_restore");
        const currentAlias = await tx.get<WorkspaceRollbackAlias>("legacy_rollback_alias");
        const currentPolicy = await tx.get<WorkspaceReadPolicy>("workspace_read_policy");
        if (!migration || migration.status !== "restoring" || !currentRestore || currentRestore.restoreId !== restore!.restoreId) return false;
        for (const branch of branches) {
          const current = await tx.get<WorkspaceHead>(headKey(branch));
          const expected = currentRestore.restoredHeads?.[branch];
          if (!current || !expected || current.revision !== expected.revision || current.manifestHash !== expected.manifestHash) return false;
        }
        currentRestore.status = "verified";
        currentRestore.completedAt = new Date().toISOString();
        delete currentRestore.errorCode;
        migration.status = "verified";
        migration.updatedAt = currentRestore.completedAt;
        if (currentAlias?.migrationId === migration.migrationId) {
          const restored = currentRestore.restoredHeads ?? {};
          const main = restored.main;
          if (!main) return false;
          await tx.put("legacy_rollback_alias", { ...currentAlias, revision: main.revision, manifestHash: main.manifestHash,
            branchHeads: Object.fromEntries(Object.entries(restored).filter(([branch]) => branch !== "main")) });
        }
        if (currentPolicy?.mode === "coordinator" && currentPolicy.receipt?.migrationId === migration.migrationId) {
          const branches = { ...currentPolicy.receipt.branches };
          for (const [branch, head] of Object.entries(currentRestore.restoredHeads ?? {})) {
            const prior = branches[branch];
            if (!prior) return false;
            branches[branch] = { ...prior, revision: head.revision, manifestHash: head.manifestHash };
          }
          const receipt = { ...currentPolicy.receipt, branches, verifiedAt: currentRestore.completedAt };
          await tx.put("workspace_read_policy", { ...currentPolicy, generation: currentPolicy.generation + 1, updatedAt: currentRestore.completedAt, receipt });
        }
        await tx.put("migration_restore", currentRestore);
        await tx.put("project_migration", migration);
        return true;
      });
      if (!completed) throw new Error("workspace_migration_restore_head_changed");
      const finalRestore = await this.ctx.storage.get<WorkspaceRollbackRestore>("migration_restore");
      return json({ restore: finalRestore, replay: false });
    } catch (error) {
      const safeError = error instanceof Error && error.message.startsWith("workspace_migration_restore_") ? error.message : "workspace_migration_restore_retry_required";
      const currentRestore = await this.ctx.storage.get<WorkspaceRollbackRestore>("migration_restore");
      if (currentRestore?.restoreId === restore.restoreId) await this.ctx.storage.put("migration_restore", { ...currentRestore, errorCode: safeError });
      // Leave project_migration.status=restoring so the publication barrier stays active.
      return json({ error_code: "workspace_migration_restore_retry_required", restore: await this.ctx.storage.get<WorkspaceRollbackRestore>("migration_restore") }, 503);
    }
  }

  /** Restore one retained canonical revision after the legacy alias has been retired. The
   * operation is fenced by the same project migration barrier used for cutover and is replayable
   * by restoreId. All bytes are integrity checked and republished through checked checkpoints. */
  private async restoreCanonicalRevision(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId || !validateWorkspaceBranch(body.branch) ||
        body.confirm !== true || typeof body.restoreId !== "string" || !ID.test(body.restoreId) ||
        !Number.isSafeInteger(body.targetRevision) || Number(body.targetRevision) < 1) return fail("invalid_workspace_revision_restore_request");
    const scope = body.scope;
    const branch = body.branch;
    const targetRevision = Number(body.targetRevision);
    const knownScope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (knownScope && JSON.stringify(knownScope) !== JSON.stringify(scope)) return fail("workspace_scope_mismatch", 403);
    const suppliedExpected = body.expectedHead && typeof body.expectedHead === "object" && !Array.isArray(body.expectedHead)
      ? body.expectedHead as Record<string, unknown> : null;
    if (suppliedExpected && (!Number.isSafeInteger(suppliedExpected.revision) || Number(suppliedExpected.revision) < 1 ||
        typeof suppliedExpected.manifestHash !== "string" || !HASH.test(suppliedExpected.manifestHash))) return fail("workspace_revision_restore_head_invalid");

    let restore = await this.ctx.storage.get<CanonicalRevisionRestore>("canonical_revision_restore");
    if (restore?.status === "verified" && restore.restoreId === body.restoreId) {
      if (restore.branch !== branch || restore.targetRevision !== targetRevision) return fail("workspace_revision_restore_id_conflict", 409);
      return json({ restore, replay: true });
    }
    const target = await this.ctx.storage.get<RetainedRevision>(retainedRevisionKey(branch, targetRevision));
    if (!target || target.branch !== branch) return fail("workspace_revision_not_found", 404);
    const snapshotHead: WorkspaceHead = { version: 1, scope, branch, revision: target.revision, manifestHash: target.manifestHash,
      parentRevision: null, publicationId: null, updatedAt: target.createdAt };
    const desiredEntries = await this.readManifestEntries(snapshotHead).catch(() => null);
    if (!desiredEntries) return fail("workspace_manifest_unavailable", 503);
    if (await this.verifyEntries(scope, desiredEntries)) return fail("workspace_revision_restore_snapshot_integrity_failed", 503);
    if (desiredEntries.length > MAX_ENTRIES || desiredEntries.reduce((sum, entry) => sum + entry.size, 0) > MAX_WORKSPACE_BYTES) {
      return fail("workspace_revision_restore_snapshot_limit_exceeded", 413);
    }
    if (restore?.status === "restoring") {
      if (restore.restoreId !== body.restoreId || restore.branch !== branch || restore.targetRevision !== targetRevision ||
          restore.targetManifestHash !== target.manifestHash ||
          (suppliedExpected && (Number(suppliedExpected.revision) !== restore.expectedHead.revision || suppliedExpected.manifestHash !== restore.expectedHead.manifestHash))) {
        return fail("workspace_revision_restore_in_progress", 423);
      }
    } else {
      if (!suppliedExpected) return fail("workspace_revision_restore_head_required", 400);
      const migration = await this.ctx.storage.get<WorkspaceMigration>("project_migration");
      if (migration && migration.status !== "verified") return fail("workspace_migration_barrier_active", 423);
      if ((await this.ctx.storage.get<WorkspaceRollbackRestore>("migration_restore"))?.status === "restoring") return fail("workspace_migration_restore_in_progress", 423);
      if ((await this.getReadPolicy()).mode !== "coordinator") return fail("workspace_project_policy_blocks_coordinator_write", 423);
      const now = new Date().toISOString();
      const nextRestore: CanonicalRevisionRestore = {
        restoreId: body.restoreId, branch, targetRevision, targetManifestHash: target.manifestHash,
        expectedHead: { revision: Number(suppliedExpected.revision), manifestHash: String(suppliedExpected.manifestHash) },
        previousMigration: migration ?? null, status: "restoring", startedAt: now,
      };
      const started = await this.ctx.storage.transaction(async tx => {
        const currentScope = await tx.get<WorkspaceScope>("scope");
        const currentMigration = await tx.get<WorkspaceMigration>("project_migration");
        const currentRestore = await tx.get<CanonicalRevisionRestore>("canonical_revision_restore");
        const currentHead = await tx.get<WorkspaceHead>(headKey(branch));
        const policy = await tx.get<WorkspaceReadPolicy>("workspace_read_policy");
        if (await tx.get<boolean>("erased")) return "workspace_erased";
        if (currentScope && JSON.stringify(currentScope) !== JSON.stringify(scope)) return "workspace_scope_mismatch";
        if (currentRestore?.status === "restoring") return "workspace_revision_restore_in_progress";
        if (currentMigration && currentMigration.status !== "verified") return "workspace_migration_barrier_active";
        if (policy?.mode !== "coordinator") return "workspace_project_policy_blocks_coordinator_write";
        if (!currentHead || currentHead.revision !== nextRestore.expectedHead.revision || currentHead.manifestHash !== nextRestore.expectedHead.manifestHash) return "workspace_revision_restore_head_changed";
        if (currentMigration) await tx.put("project_migration", { ...currentMigration, status: "restoring", updatedAt: now });
        else await tx.put("project_migration", { migrationId: `revision-restore-${body.restoreId}`,
          status: "restoring", sourcePrefix: "", startedAt: now, updatedAt: now } satisfies WorkspaceMigration);
        await tx.put("canonical_revision_restore", nextRestore);
        return "started";
      });
      if (started !== "started") return fail(started, started === "workspace_scope_mismatch" ? 403 : started === "workspace_erased" ? 410 : 423);
      restore = nextRestore;
    }

    const restoreDigest = (await sha256Hex(new TextEncoder().encode(restore.restoreId))).slice(0, 16);
    try {
      const currentHead = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
      if (!currentHead) throw new Error("workspace_revision_restore_head_missing");
      if (currentHead.revision < restore.expectedHead.revision ||
          (currentHead.revision === restore.expectedHead.revision && currentHead.manifestHash !== restore.expectedHead.manifestHash)) {
        throw new Error("workspace_revision_restore_head_changed");
      }
      if (currentHead.revision > restore.expectedHead.revision) {
        const receipts = await this.ctx.storage.list<WorkspacePublicationReceipt>({ prefix: `receipt:${branch}:`, limit: 1000 });
        for (let revision = restore.expectedHead.revision + 1; revision <= currentHead.revision; revision++) {
          const event = await this.ctx.storage.get<RevisionEvent>(revisionEventKey(branch, revision));
          const receipt = [...receipts.values()].find(item => item.revision === revision &&
            item.idempotencyKey.startsWith(`revision-restore-${restoreDigest}-`) && item.status === "published");
          if (!event || !receipt || event.publicationId !== receipt.id) throw new Error("workspace_revision_restore_progress_unverified");
        }
      }
      const restored = await this.importLegacyBranch(scope, branch, desiredEntries, tenantId, {
        seedFromMain: false, expectedRevision: currentHead.revision, stageNamespace: `revision-restore-${restoreDigest}`,
      });
      const verifiedEntries = await this.readManifestEntries(restored);
      if (JSON.stringify(verifiedEntries.map(entry => [entry.path, entry.sha256, entry.size, entry.executable, entry.contentType ?? inferWorkspaceContentType(entry.path)])) !==
          JSON.stringify(desiredEntries.map(entry => [entry.path, entry.sha256, entry.size, entry.executable, entry.contentType ?? inferWorkspaceContentType(entry.path)]))) {
        throw new Error("workspace_revision_restore_manifest_mismatch");
      }
      const savedHead = { revision: restored.revision, manifestHash: restored.manifestHash };
      const completedAt = new Date().toISOString();
      const saved = await this.ctx.storage.transaction(async tx => {
        const currentRestore = await tx.get<CanonicalRevisionRestore>("canonical_revision_restore");
        const migration = await tx.get<WorkspaceMigration>("project_migration");
        const latest = await tx.get<WorkspaceHead>(headKey(branch));
        if (!currentRestore || currentRestore.restoreId !== restore!.restoreId || currentRestore.status !== "restoring" ||
            migration?.status !== "restoring" || !latest || latest.revision !== restored.revision || latest.manifestHash !== restored.manifestHash) return false;
        currentRestore.status = "verified";
        currentRestore.completedAt = completedAt;
        currentRestore.restoredHead = savedHead;
        delete currentRestore.errorCode;
        if (currentRestore.previousMigration) await tx.put("project_migration", { ...currentRestore.previousMigration, updatedAt: completedAt });
        else await tx.delete("project_migration");
        await tx.put("canonical_revision_restore", currentRestore);
        return true;
      });
      if (!saved) throw new Error("workspace_revision_restore_head_changed");
      return json({ restore: await this.ctx.storage.get<CanonicalRevisionRestore>("canonical_revision_restore"), replay: false });
    } catch (error) {
      return this.failCanonicalRevisionRestore(restore, error instanceof Error && error.message.startsWith("workspace_revision_restore_")
        ? error.message : "workspace_revision_restore_retry_required");
    }
  }

  private async failCanonicalRevisionRestore(restore: CanonicalRevisionRestore, errorCode: string): Promise<Response> {
    const current = await this.ctx.storage.get<CanonicalRevisionRestore>("canonical_revision_restore");
    if (current?.restoreId === restore.restoreId && current.status === "restoring") {
      await this.ctx.storage.put("canonical_revision_restore", { ...current, errorCode });
    }
    return json({ error_code: "workspace_revision_restore_retry_required",
      restore: await this.ctx.storage.get<CanonicalRevisionRestore>("canonical_revision_restore") }, 503);
  }

  private async readManifestEntries(head: WorkspaceHead): Promise<WorkspaceEntry[]> {
    const manifest = await this.env.SCRIPTS_R2!.get(manifestKey(head.scope, head.manifestHash));
    if (!manifest) throw new Error("workspace_manifest_unavailable");
    const bytes = new Uint8Array(await manifest.arrayBuffer());
    if (await sha256Hex(bytes) !== head.manifestHash) throw new Error("workspace_manifest_corrupt");
    return JSON.parse(new TextDecoder().decode(bytes)) as WorkspaceEntry[];
  }

  private async hasCurrentSessionAuthority(session: Session): Promise<boolean> {
    const current = await this.ctx.storage.get<Session>(sessionKey(session.id));
    if (!current || current.status !== "active" || current.runtimeId !== session.runtimeId ||
        current.allocationGeneration !== session.allocationGeneration || current.fence !== session.fence) {
      this.writeOpsMetric("stale_lease_fence", 1, "warning");
      return false;
    }
    if (current.mode !== "live_single_writer") return true;
    if (this.env.LIVE_WORKSPACE_ENABLED !== "true") {
      this.writeOpsMetric("stale_lease_fence", 1, "warning");
      return false;
    }
    const lease = await this.ctx.storage.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${current.branch}`);
    if (!lease || lease.sessionId !== current.id || lease.fence !== current.fence || lease.expiresAt <= Date.now()) {
      this.writeOpsMetric("stale_lease_fence", 1, "warning");
      return false;
    }
    return await this.verifyBoundLiveCapability(current);
  }

  private writeOpsMetric(signal: "checkpoint_lag_ms" | "stale_lease_fence", value: number, className: "all" | "warning"): void {
    try {
      this.env.ANALYTICS?.writeDataPoint({
        blobs: [`workspace.ops.${signal}`, className, "phase6", "", "", "", "", "", "workspace-ops-v1"],
        doubles: [Math.max(0, Math.min(value, 9_000_000_000_000))],
      });
    } catch { /* telemetry must not change coordinator behavior */ }
    if (className === "warning") console.warn("workspace_ops_alert", { signal });
  }

  private async verifyLiveCapability(scope: WorkspaceScope, actorId: string, runtimeId: string, generation: number, _callerEvidence: unknown, requireExact = false): Promise<{ binding?: LiveCapabilityBinding; missing: string[] }> {
    if (!this.env.LIVE_CAPABILITY_VERIFIER) return { missing: ["authorityBackedVerification"] };
    let response: Response;
    try {
      response = await this.env.LIVE_CAPABILITY_VERIFIER.fetch(new Request("https://live-capability-verifier/internal/search-and-verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId,
          "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, scope.tenantId) },
        // Capability claims from the caller are deliberately not forwarded. The verifier
        // searches current D1 authority and returns only operator-observed, reservation-backed evidence.
        body: JSON.stringify({ scope, actorId, preferredRuntimeId: runtimeId, preferredAllocationGeneration: generation,
          requireExact,
          requiredCapabilities: ["live_mount", "fuse", "incremental_sync", "real_flush", "authenticated_transport", "reconnect_generation_check", "runtime_accounting"] }),
      }));
    } catch {
      return { missing: ["authorityBackedVerification"] };
    }
    if (!response.ok) return { missing: ["authorityBackedVerification"] };
    let verified: Record<string, unknown>;
    try { verified = await response.json() as Record<string, unknown>; } catch { return { missing: ["authorityBackedVerification"] }; }
    if (verified.verified !== true) {
      const reported = Array.isArray(verified.missing) ? verified.missing.filter((item): item is string => typeof item === "string") : [];
      return { missing: reported.length ? reported : ["authorityBackedVerification"] };
    }
    const selected = verified.evidence && typeof verified.evidence === "object" && !Array.isArray(verified.evidence)
      ? verified.evidence as Record<string, unknown> : {};
    const selectedRuntimeId = typeof selected.runtimeId === "string" ? selected.runtimeId : runtimeId;
    const selectedGeneration = Number.isSafeInteger(selected.allocationGeneration) ? Number(selected.allocationGeneration) : generation;
    if ((selectedRuntimeId !== runtimeId || selectedGeneration !== generation) && verified.candidateSearchPerformed !== true) return { missing: ["candidateSearchAuthority"] };
    return validateLiveCapabilityEvidence(selected, selectedGeneration, selectedRuntimeId);
  }

  private async verifyBoundLiveCapability(session: Session): Promise<boolean> {
    if (session.mode !== "live_single_writer") return true;
    if (!session.capabilityBinding) return false;
    const scope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (!scope) return false;
    const binding = session.capabilityBinding;
    const current = await this.verifyLiveCapability(scope, session.actorId, session.runtimeId, session.allocationGeneration, binding, true);
    if (!current.binding) return false;
    const verified = current.binding;
    return verified.runtimeId === binding.runtimeId && verified.runtimeType === binding.runtimeType &&
      verified.templateId === binding.templateId && verified.templateDigest === binding.templateDigest && verified.region === binding.region &&
      verified.authorizationId === binding.authorizationId && verified.authorizationEpoch === binding.authorizationEpoch &&
      verified.residencyPolicyId === binding.residencyPolicyId && verified.allocationId === binding.allocationId &&
      verified.allocationGeneration === binding.allocationGeneration && verified.billingReservationId === binding.billingReservationId &&
      verified.budgetReservationId === binding.budgetReservationId;
  }

  private async open(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    const validated = await this.validateScope(body.scope, body.branch, tenantId);
    if (validated instanceof Response) return validated;
    if (typeof body.actorId !== "string" || !ID.test(body.actorId) || typeof body.runtimeId !== "string" || !ID.test(body.runtimeId) ||
        !Number.isSafeInteger(body.allocationGeneration) || Number(body.allocationGeneration) < 1 ||
        (body.mode !== undefined && body.mode !== "checked_handoff" && body.mode !== "live_single_writer")) return fail("invalid_workspace_session");
    const { branch } = validated;
    const mode = (body.mode ?? "checked_handoff") as WorkspaceConsistencyMode;
    let capabilityBinding: LiveCapabilityBinding | undefined;
    if (mode === "live_single_writer") {
      const capability = await this.verifyLiveCapability(validated.scope, String(body.actorId), String(body.runtimeId), Number(body.allocationGeneration), body.capabilityEvidence);
      if (this.env.LIVE_WORKSPACE_ENABLED !== "true" || !capability.binding) {
        return json({ error_code: "capability_unavailable", mode, requiredRuntimeCapabilities: [
          "live_mount", "fuse", "incremental_sync", "real_flush", "authenticated_transport", "reconnect_generation_check", "authorization", "residency", "billing", "budget", "runtime_accounting",
        ], missing: capability.missing, candidateSearch: this.env.LIVE_CAPABILITY_VERIFIER ? "authority_verifier_required" : "verifier_not_configured" }, 409);
      }
      capabilityBinding = capability.binding;
    }
    const current = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!current) return fail("workspace_not_initialized", 404);
    const branchBase = await this.ctx.storage.get<{ parentBranch: string; revision: number; manifestHash: string }>(branchBaseKey(branch));
    const requestedParent = body.parentBranch;
    if (requestedParent !== undefined && (!validateWorkspaceBranch(requestedParent) || !branchBase || branchBase.parentBranch !== requestedParent)) return fail("branch_parent_mismatch", 409);
    const parentBranch = typeof requestedParent === "string" ? requestedParent : branchBase?.parentBranch ?? null;
    const baseRevision = branchBase?.revision ?? current.revision;
    const baseManifestHash = branchBase?.manifestHash ?? current.manifestHash;
    const id = `ws_${crypto.randomUUID()}`;
    const session: Session = { id, actorId: body.actorId,
      runtimeId: capabilityBinding?.runtimeId ?? body.runtimeId, branch, parentBranch, baseRevision, baseManifestHash,
      mode, requestedMode: mode, resolvedMode: mode, allocationGeneration: capabilityBinding?.allocationGeneration ?? Number(body.allocationGeneration), fence: 0,
      ...(capabilityBinding ? { capabilityBinding } : {}), status: "active", createdAt: new Date().toISOString() };
    const result = await this.ctx.storage.transaction(async (tx) => {
      const migration = await tx.get<WorkspaceMigration>("project_migration");
      if (migration && migration.status !== "verified" && body.actorId !== "workspace-migration") return { error: "workspace_migration_barrier_active" };
      if (await tx.get<boolean>("erased")) return { error: "workspace_erased" };
      const head = await tx.get<WorkspaceHead>(headKey(branch));
      if (!head || head.revision !== current.revision || head.manifestHash !== current.manifestHash) return { error: "workspace_head_changed" };
      if (mode === "live_single_writer") {
        const lease = await tx.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${branch}`);
        if (lease && lease.expiresAt > Date.now()) return { error: "writer_lease_held" };
        const fence = (await tx.get<number>(`fence:${branch}`) ?? 0) + 1;
        session.fence = fence;
        await tx.put(`fence:${branch}`, fence);
        await tx.put(`writer:${branch}`, { sessionId: id, fence, expiresAt: Date.now() + 60_000 });
      }
      await tx.put(sessionKey(id), session);
      return { session };
    });
    if ("error" in result) return fail(result.error, result.error === "workspace_migration_barrier_active" ? 423 : 409);
    return json({ session: result.session, head: current });
  }

  private async renew(body: Record<string, unknown>): Promise<Response> {
    if (typeof body.sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(body.sessionId) || !Number.isSafeInteger(body.allocationGeneration) || !Number.isSafeInteger(body.fence)) return fail("invalid_session");
    const session = await this.ctx.storage.get<Session>(sessionKey(body.sessionId));
    if (!session || session.status !== "active" || session.mode !== "live_single_writer") return fail("workspace_session_not_found", 404);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
    if (!await this.hasCurrentSessionAuthority(session)) return fail("writer_lease_expired", 409);
    const result = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<Session>(sessionKey(session.id));
      const lease = await tx.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${session.branch}`);
      if (!current || current.status !== "active" || current.fence !== body.fence || !lease || lease.sessionId !== current.id || lease.fence !== current.fence || lease.expiresAt <= Date.now()) return false;
      const expiresAt = Date.now() + 60_000;
      lease.expiresAt = expiresAt;
      await tx.put(`writer:${session.branch}`, lease);
      return expiresAt;
    });
    return result ? json({ sessionId: session.id, fence: session.fence, expiresAt: result }) : fail("stale_fence", 409);
  }

  private async createBranch(body: Record<string, unknown>, tenantId: string, allowMigration = false): Promise<Response> {
    const validated = await this.validateScope(body.scope, body.sourceBranch, tenantId);
    if (validated instanceof Response) return validated;
    if (!validateWorkspaceBranch(body.branch)) return fail("invalid_branch");
    const source = await this.ctx.storage.get<WorkspaceHead>(headKey(validated.branch));
    if (!source) return fail("workspace_not_found", 404);
    const branch = body.branch;
    const created: WorkspaceHead = { ...source, branch, updatedAt: new Date().toISOString() };
    const result = await this.ctx.storage.transaction(async (tx) => {
      const migration = await tx.get<WorkspaceMigration>("project_migration");
      if (migration && migration.status !== "verified" && !allowMigration) return "migration_barrier";
      if (allowMigration && (!migration || (migration.status !== "importing" && migration.status !== "restoring"))) return "migration_barrier";
      if (await tx.get<boolean>("erased")) return "erased";
      const existing = await tx.get<WorkspaceHead>(headKey(branch));
      if (existing) {
        const base = await tx.get<{ parentBranch: string; revision: number; manifestHash: string }>(branchBaseKey(branch));
        return base?.parentBranch === validated.branch ? "exists" : "branch_exists";
      }
      const latest = await tx.get<WorkspaceHead>(headKey(validated.branch));
      if (!latest || latest.revision !== source.revision || latest.manifestHash !== source.manifestHash) return "source_changed";
      await tx.put(headKey(branch), created);
      await tx.put(branchBaseKey(branch), { parentBranch: validated.branch, revision: source.revision, manifestHash: source.manifestHash });
      await tx.put(retainedRevisionKey(branch, created.revision), { branch, revision: created.revision, manifestHash: created.manifestHash, createdAt: created.updatedAt } satisfies RetainedRevision);
      await tx.put(revisionEventKey(branch, created.revision), { branch, revision: created.revision, publicationId: created.publicationId, changedPaths: [], updatedAt: created.updatedAt } satisfies RevisionEvent);
      return "created";
    });
    if (result === "branch_exists") return fail("branch_exists", 409);
    if (result === "erased") return fail("workspace_erased", 410);
    if (result === "migration_barrier") return fail("workspace_migration_barrier_active", 423);
    if (result === "source_changed") return fail("base_revision_mismatch", 409);
    return json({ branch: result === "created" ? created : await this.ctx.storage.get<WorkspaceHead>(headKey(branch)), created: result === "created" });
  }

  private async merge(body: Record<string, unknown>): Promise<Response> {
    const sessionId = body.sessionId;
    const targetBranch = body.targetBranch;
    const idempotencyKey = body.idempotencyKey;
    if (typeof sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(sessionId) || !validateWorkspaceBranch(targetBranch) || typeof idempotencyKey !== "string" || !ID.test(idempotencyKey) ||
        !Number.isSafeInteger(body.allocationGeneration) || !Number.isSafeInteger(body.fence)) return fail("invalid_merge");
    const session = await this.ctx.storage.get<Session>(sessionKey(sessionId));
    if (!session) return fail("workspace_session_not_found", 404);
    if (await this.contentGcLocked()) return fail("workspace_gc_in_progress", 423);
    if (session.mode !== "checked_handoff" || session.parentBranch !== targetBranch) return fail("branch_parent_mismatch", 409);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
    if (session.fence !== body.fence) return fail("stale_fence", 409);
    const workingHead = await this.ctx.storage.get<WorkspaceHead>(headKey(session.branch));
    if (!workingHead) return fail("workspace_branch_not_found", 404);
    const changeSetHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({ sessionId, targetBranch, sourceManifestHash: workingHead.manifestHash, baseManifestHash: session.baseManifestHash, allocationGeneration: session.allocationGeneration, fence: session.fence })));
    const prior = await this.ctx.storage.get<WorkspacePublicationReceipt>(mergeReceiptKey(targetBranch, idempotencyKey));
    if (prior) return prior.changeSetHash === changeSetHash ? json({ publication: prior }) : fail("idempotency_conflict", 409);
    if (session.status !== "active") return fail("stale_fence", 409);
    const targetHead = await this.ctx.storage.get<WorkspaceHead>(headKey(targetBranch));
    if (!targetHead) return fail("workspace_branch_not_found", 404);
    const baseObject = await this.env.SCRIPTS_R2!.get(manifestKey(targetHead.scope, session.baseManifestHash));
    const parentObject = await this.env.SCRIPTS_R2!.get(manifestKey(targetHead.scope, targetHead.manifestHash));
    const workingObject = await this.env.SCRIPTS_R2!.get(manifestKey(targetHead.scope, workingHead.manifestHash));
    if (!baseObject || !parentObject || !workingObject) return fail("workspace_manifest_unavailable", 503);
    const [baseBuffer, parentBuffer, workingBuffer] = await Promise.all([baseObject.arrayBuffer(), parentObject.arrayBuffer(), workingObject.arrayBuffer()]);
    const baseBytes = new Uint8Array(baseBuffer);
    const parentBytes = new Uint8Array(parentBuffer);
    const workingBytes = new Uint8Array(workingBuffer);
    if (await sha256Hex(baseBytes) !== session.baseManifestHash || await sha256Hex(parentBytes) !== targetHead.manifestHash || await sha256Hex(workingBytes) !== workingHead.manifestHash) return fail("workspace_manifest_corrupt", 503);
    const baseEntries = JSON.parse(new TextDecoder().decode(baseBytes)) as WorkspaceEntry[];
    const parentEntries = JSON.parse(new TextDecoder().decode(parentBytes)) as WorkspaceEntry[];
    const workingEntries = JSON.parse(new TextDecoder().decode(workingBytes)) as WorkspaceEntry[];
    const base = new Map(baseEntries.map((entry) => [entry.path, entry]));
    const parent = new Map(parentEntries.map((entry) => [entry.path, entry]));
    const working = new Map(workingEntries.map((entry) => [entry.path, entry]));
    const paths = [...new Set([...base.keys(), ...working.keys()])].sort();
    const changedPaths = paths.filter((path) => entrySignature(base.get(path)) !== entrySignature(working.get(path)));
    const conflicts = changedPaths.flatMap((path) => {
      const baseHash = base.get(path)?.sha256 ?? null;
      const parentEntry = parent.get(path);
      const parentHash = parentEntry?.sha256 ?? null;
      const workingHash = working.get(path)?.sha256 ?? null;
      return entrySignature(parentEntry) !== entrySignature(base.get(path)) && entrySignature(parentEntry) !== entrySignature(working.get(path)) ? [{ path, expectedHash: baseHash, actualHash: parentHash }] : [];
    });
    const id = `merge_${crypto.randomUUID()}`;
    const uploadIntentId = crypto.randomUUID();
    const uploadIntentKey = `upload-intent:${uploadIntentId}`;
    let status: WorkspacePublicationReceipt["status"] = conflicts.length ? "conflicted" : "published";
    let newlyStoredManifestKey: string | null = null;
    const nextEntries = new Map(parent);
    if (!conflicts.length) {
      for (const path of changedPaths) {
        const entry = working.get(path);
        if (entry) nextEntries.set(path, entry);
        else nextEntries.delete(path);
      }
    }
    let nextHash = targetHead.manifestHash;
    if (!conflicts.length && changedPaths.length) {
      const encoded = canonicalManifest([...nextEntries.values()]);
      if (nextEntries.size > 10_000) return fail("workspace_entry_limit_exceeded", 413);
      const totalBytes = [...nextEntries.values()].reduce((total, entry) => total + entry.size, 0);
      if (totalBytes > MAX_WORKSPACE_BYTES) return fail("workspace_size_limit_exceeded", 413);
      nextHash = await sha256Hex(new TextEncoder().encode(encoded));
      const verified = await this.verifyEntries(targetHead.scope, [...nextEntries.values()]);
      if (verified) return verified;
      if (nextHash !== targetHead.manifestHash) {
        const objectKey = manifestKey(targetHead.scope, nextHash);
        const protectedUpload = await this.protectUpload(targetHead.scope, uploadIntentId, objectKey);
        if (protectedUpload !== "ready") return protectedUpload === "erased" ? fail("workspace_erased", 410)
          : protectedUpload === "gc_busy" ? fail("workspace_gc_in_progress", 423)
            : protectedUpload === "intent_limit" ? fail("workspace_upload_intent_limit", 413) : fail("workspace_scope_mismatch", 403);
        const put = await this.env.SCRIPTS_R2!.put(objectKey, encoded, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: nextHash } });
        if (put) newlyStoredManifestKey = objectKey;
        if (!put) {
          const found = await this.env.SCRIPTS_R2!.get(objectKey);
          if (!found || await sha256Hex(new Uint8Array(await found.arrayBuffer())) !== nextHash) return fail("manifest_persist_failed", 503);
        }
      } else status = "noop";
    } else if (!conflicts.length) status = "noop";
    const revision = status === "published" ? targetHead.revision + 1 : targetHead.revision;
    const receipt: WorkspacePublicationReceipt = { id, idempotencyKey, status, branch: targetBranch, baseRevision: targetHead.revision, revision,
      appliedPaths: conflicts.length ? [] : changedPaths, conflicts, changeSetHash, fence: session.fence, allocationGeneration: session.allocationGeneration };
    const nextHead: WorkspaceHead = { ...targetHead, revision, manifestHash: nextHash, parentRevision: targetHead.revision, publicationId: id, updatedAt: new Date().toISOString() };
    const committed = await this.ctx.storage.transaction(async (tx) => {
      const replay = await tx.get<WorkspacePublicationReceipt>(mergeReceiptKey(targetBranch, idempotencyKey));
      if (replay) {
        await tx.delete(uploadIntentKey);
        return replay.changeSetHash === changeSetHash ? { receipt: replay } : { error: "idempotency_conflict" };
      }
      const activeSession = await tx.get<Session>(sessionKey(sessionId));
      const migration = await tx.get<WorkspaceMigration>("project_migration");
      if (migration && migration.status !== "verified") return { error: "workspace_migration_barrier_active" };
      const gc = await tx.get<ContentGcState>("content_gc");
      if (gc && gc.lockUntil > Date.now()) return { error: "workspace_gc_in_progress" };
      if (await tx.get<boolean>("erased")) return { error: "workspace_erased" };
      const parent = await tx.get<WorkspaceHead>(headKey(targetBranch));
      const branch = await tx.get<WorkspaceHead>(headKey(session.branch));
      if (!activeSession || activeSession.status !== "active" || activeSession.allocationGeneration !== body.allocationGeneration || activeSession.fence !== body.fence) return { error: "stale_fence" };
      if (!parent || parent.revision !== targetHead.revision || parent.manifestHash !== targetHead.manifestHash || !branch || branch.revision !== workingHead.revision || branch.manifestHash !== workingHead.manifestHash) return { error: "workspace_head_raced" };
      await tx.put(mergeReceiptKey(targetBranch, idempotencyKey), receipt);
      const expiry = expiryKey(Date.now() + RECEIPT_RETENTION_MS, crypto.randomUUID());
      await tx.put(expiry, { expiresAt: Date.now() + RECEIPT_RETENTION_MS, kind: "receipt", targetKey: mergeReceiptKey(targetBranch, idempotencyKey) } satisfies ExpiryRecord);
      if (status === "published") {
        await tx.put(headKey(targetBranch), nextHead);
        await tx.put(retainedRevisionKey(targetBranch, revision), { branch: targetBranch, revision, manifestHash: nextHash, createdAt: nextHead.updatedAt } satisfies RetainedRevision);
        await tx.put(revisionEventKey(targetBranch, revision), { branch: targetBranch, revision, publicationId: id, changedPaths, updatedAt: nextHead.updatedAt } satisfies RevisionEvent);
        if (revision > REVISION_EVENT_RETENTION) await tx.delete(revisionEventKey(targetBranch, revision - REVISION_EVENT_RETENTION));
      }
      if (status === "published" || status === "noop") {
        activeSession.status = "closed";
        await tx.put(sessionKey(sessionId), activeSession);
      }
      await tx.delete(uploadIntentKey);
      return { receipt };
    });
    if ("error" in committed) {
      if (committed.error === "workspace_gc_in_progress" || committed.error === "workspace_erased") {
        if (newlyStoredManifestKey) await this.env.SCRIPTS_R2!.delete(newlyStoredManifestKey);
      }
      await this.ctx.storage.delete(uploadIntentKey);
      return fail(committed.error, committed.error === "workspace_gc_in_progress" || committed.error === "workspace_migration_barrier_active" ? 423 : committed.error === "workspace_erased" ? 410 : 409);
    }
    await this.scheduleMetadataExpiry();
    return json({ publication: committed.receipt }, status === "conflicted" ? 409 : 200);
  }

  private async head(url: URL): Promise<Response> {
    const branch = url.searchParams.get("branch");
    if (!validateWorkspaceBranch(branch)) return fail("invalid_branch");
    const value = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!value) return fail("workspace_not_found", 404);
    const branchBase = await this.ctx.storage.get<{ parentBranch: string; revision: number; manifestHash: string }>(branchBaseKey(branch));
    return json({ head: value, ...(branchBase ? { branchBase } : {}) });
  }

  private async read(url: URL): Promise<Response> {
    const branch = url.searchParams.get("branch");
    if (!validateWorkspaceBranch(branch)) return fail("invalid_branch");
    const prefix = url.searchParams.get("prefix");
    if (prefix !== null && !validateWorkspacePath(prefix)) return fail("invalid_workspace_prefix");
    const currentHead = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!currentHead) return fail("workspace_not_found", 404);
    const requestedRevision = url.searchParams.get("revision");
    let head = currentHead;
    if (requestedRevision !== null) {
      const revision = Number(requestedRevision);
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > currentHead.revision) return fail("invalid_workspace_revision");
      const retained = await this.ctx.storage.get<RetainedRevision>(retainedRevisionKey(branch, revision));
      if (!retained) return fail("workspace_revision_not_found", 404);
      head = { ...currentHead, revision: retained.revision, manifestHash: retained.manifestHash, updatedAt: retained.createdAt };
    }
    const entries = await this.readManifestEntries(head).catch(() => null);
    if (!entries) return fail("workspace_manifest_unavailable", 503);
    const paths = url.searchParams.getAll("path");
    if (paths.length && prefix !== null) return fail("invalid_read_filter");
    const selected = paths.length ? entries.filter((entry) => paths.includes(entry.path))
      : prefix !== null ? entries.filter(entry => entry.path === prefix || entry.path.startsWith(`${prefix}/`)) : entries;
    return json({ head, entries: selected });
  }

  private async history(url: URL): Promise<Response> {
    const branch = url.searchParams.get("branch");
    const path = url.searchParams.get("path");
    if (!validateWorkspaceBranch(branch) || !validateWorkspacePath(path)) return fail("invalid_history_query");
    const head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!head) return fail("workspace_not_found", 404);
    const requestedAfter = url.searchParams.get("afterRevision");
    const afterRevision = requestedAfter === null ? Math.max(0, head.revision - 100) : Number(requestedAfter);
    const rawLimit = Number(url.searchParams.get("limit") ?? "100");
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || afterRevision > head.revision || !Number.isSafeInteger(rawLimit) || rawLimit < 1) return fail("invalid_history_cursor");
    const through = Math.min(head.revision, afterRevision + Math.min(rawLimit, 100));
    let previous: WorkspaceEntry | undefined;
    if (afterRevision > 0) {
      const priorRevision = await this.ctx.storage.get<RetainedRevision>(retainedRevisionKey(branch, afterRevision));
      if (!priorRevision) return fail("workspace_revision_not_found", 404);
      const priorHead = { ...head, revision: priorRevision.revision, manifestHash: priorRevision.manifestHash, updatedAt: priorRevision.createdAt };
      const priorEntries = await this.readManifestEntries(priorHead).catch(() => null);
      if (!priorEntries) return fail("workspace_manifest_unavailable", 503);
      previous = priorEntries.find(entry => entry.path === path);
    }
    const versions: Array<{ revision: number; updatedAt: string; sha256?: string; size?: number; contentType?: string; deleted: boolean }> = [];
    for (let revision = afterRevision + 1; revision <= through; revision++) {
      const event = await this.ctx.storage.get<RevisionEvent>(revisionEventKey(branch, revision));
      if (!event) return json({ branch, path, headRevision: head.revision, versions, cursor: revision - 1, hasMore: true, resetRequired: true });
      if (revision !== 1 && !event.changedPaths.includes(path)) continue;
      const retained = await this.ctx.storage.get<RetainedRevision>(retainedRevisionKey(branch, revision));
      if (!retained) return json({ branch, path, headRevision: head.revision, versions, cursor: revision - 1, hasMore: true, resetRequired: true });
      const revisionHead = { ...head, revision, manifestHash: retained.manifestHash, updatedAt: retained.createdAt };
      const entries = await this.readManifestEntries(revisionHead).catch(() => null);
      if (!entries) return fail("workspace_manifest_unavailable", 503);
      const current = entries.find(entry => entry.path === path);
      if (entrySignature(current) !== entrySignature(previous)) {
        versions.push({ revision, updatedAt: retained.createdAt, ...(current ? { sha256: current.sha256, size: current.size, contentType: current.contentType ?? inferWorkspaceContentType(current.path) } : {}), deleted: !current });
      }
      previous = current;
    }
    return json({ branch, path, headRevision: head.revision, versions, cursor: through, hasMore: through < head.revision, resetRequired: false });
  }

  private async sessionSnapshot(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const runtimeId = url.searchParams.get("runtimeId") ?? "";
    const generation = Number(url.searchParams.get("allocationGeneration"));
    const fence = Number(url.searchParams.get("fence"));
    if (!/^ws_[0-9a-f-]{36}$/.test(sessionId) || !ID.test(runtimeId) || !Number.isSafeInteger(generation) || !Number.isSafeInteger(fence)) return fail("invalid_session");
    const session = await this.ctx.storage.get<Session>(sessionKey(sessionId));
    if (!session || session.status !== "active") return fail("workspace_session_not_found", 404);
    if (session.runtimeId !== runtimeId) return fail("workspace_session_scope_mismatch", 403);
    if (session.allocationGeneration !== generation) return fail("allocation_generation_mismatch", 409);
    if (session.fence !== fence) return fail("stale_fence", 409);
    if (session.mode === "live_single_writer") {
      const lease = await this.ctx.storage.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${session.branch}`);
      if (!lease || lease.sessionId !== session.id || lease.fence !== session.fence || lease.expiresAt <= Date.now()) return fail("writer_lease_expired", 409);
    }
    const scope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (!scope) return fail("workspace_scope_missing", 503);
    const object = await this.env.SCRIPTS_R2!.get(manifestKey(scope, session.baseManifestHash));
    if (!object) return fail("workspace_manifest_unavailable", 503);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (await sha256Hex(bytes) !== session.baseManifestHash) return fail("workspace_manifest_corrupt", 503);
    const entries = JSON.parse(new TextDecoder().decode(bytes)) as WorkspaceEntry[];
    if (entries.length > MAX_SANDBOX_HANDOFF_FILES || entries.reduce((total, entry) => total + entry.size, 0) > MAX_SANDBOX_HANDOFF_BYTES) return fail("workspace_handoff_limit_exceeded", 413);
    if (!await this.hasCurrentSessionAuthority(session)) return fail("stale_fence", 409);
    return json({ session: { id: session.id, branch: session.branch, baseRevision: session.baseRevision, baseManifestHash: session.baseManifestHash, fence: session.fence, allocationGeneration: session.allocationGeneration }, entries });
  }

  private async sessionContent(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const runtimeId = url.searchParams.get("runtimeId") ?? "";
    const path = url.searchParams.get("path");
    const generation = Number(url.searchParams.get("allocationGeneration"));
    const fence = Number(url.searchParams.get("fence"));
    if (!/^ws_[0-9a-f-]{36}$/.test(sessionId) || !ID.test(runtimeId) || !validateWorkspacePath(path) || !Number.isSafeInteger(generation) || !Number.isSafeInteger(fence)) return fail("invalid_session_content");
    const session = await this.ctx.storage.get<Session>(sessionKey(sessionId));
    if (!session || session.status !== "active") return fail("workspace_session_not_found", 404);
    if (session.runtimeId !== runtimeId) return fail("workspace_session_scope_mismatch", 403);
    if (session.allocationGeneration !== generation) return fail("allocation_generation_mismatch", 409);
    if (session.fence !== fence) return fail("stale_fence", 409);
    if (session.mode === "live_single_writer") {
      const lease = await this.ctx.storage.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${session.branch}`);
      if (!lease || lease.sessionId !== session.id || lease.fence !== session.fence || lease.expiresAt <= Date.now()) return fail("writer_lease_expired", 409);
    }
    const scope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (!scope) return fail("workspace_scope_missing", 503);
    const manifest = await this.env.SCRIPTS_R2!.get(manifestKey(scope, session.baseManifestHash));
    if (!manifest) return fail("workspace_manifest_unavailable", 503);
    const manifestBytes = new Uint8Array(await manifest.arrayBuffer());
    if (await sha256Hex(manifestBytes) !== session.baseManifestHash) return fail("workspace_manifest_corrupt", 503);
    const entries = JSON.parse(new TextDecoder().decode(manifestBytes)) as WorkspaceEntry[];
    const entry = entries.find((candidate) => candidate.path === path);
    if (!entry) return fail("workspace_file_not_found", 404);
    if (!entry.objectKey.startsWith(contentPrefix(scope))) return fail("workspace_object_scope_mismatch", 403);
    const content = await this.env.SCRIPTS_R2!.get(entry.objectKey);
    if (!content || content.size !== entry.size) return fail("workspace_content_unavailable", 503);
    const bytes = new Uint8Array(await content.arrayBuffer());
    if (await sha256Hex(bytes) !== entry.sha256) return fail("workspace_content_corrupt", 503);
    if (!await this.hasCurrentSessionAuthority(session)) return fail("stale_fence", 409);
    return new Response(bytes, { headers: { "content-type": entry.contentType ?? inferWorkspaceContentType(entry.path), "content-length": String(bytes.byteLength), "x-content-sha256": entry.sha256, "x-executable": String(entry.executable), "cache-control": "no-store" } });
  }

  private async receipt(url: URL): Promise<Response> {
    const idempotencyKey = url.searchParams.get("idempotencyKey");
    const sessionId = url.searchParams.get("sessionId");
    const runtimeId = url.searchParams.get("runtimeId");
    if (!idempotencyKey || !ID.test(idempotencyKey)) return fail("invalid_receipt_query");
    const branch = sessionId && /^ws_[0-9a-f-]{36}$/.test(sessionId)
      ? (await this.ctx.storage.get<Session>(sessionKey(sessionId)))?.branch
      : url.searchParams.get("branch");
    if (sessionId && runtimeId !== (await this.ctx.storage.get<Session>(sessionKey(sessionId)))?.runtimeId) return fail("workspace_session_scope_mismatch", 403);
    if (!validateWorkspaceBranch(branch)) return fail("invalid_receipt_query");
    const receipt = await this.ctx.storage.get<WorkspacePublicationReceipt>(receiptKey(branch, idempotencyKey));
    return receipt ? json({ publication: receipt }) : fail("publication_not_found", 404);
  }

  private async changes(url: URL): Promise<Response> {
    const branch = url.searchParams.get("branch");
    const afterRevision = Number(url.searchParams.get("afterRevision") ?? "0");
    if (!validateWorkspaceBranch(branch) || !Number.isSafeInteger(afterRevision) || afterRevision < 0) return fail("invalid_change_cursor");
    const head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!head) return fail("workspace_not_found", 404);
    if (afterRevision > head.revision) return fail("change_cursor_ahead", 409);
    const through = Math.min(head.revision, afterRevision + 100);
    const revisions: RevisionEvent[] = [];
    for (let revision = afterRevision + 1; revision <= through; revision++) {
      const event = await this.ctx.storage.get<RevisionEvent>(revisionEventKey(branch, revision));
      if (!event) {
        const cursor = revisions.at(-1)?.revision ?? afterRevision;
        return json({ head, revisions, resetRequired: true, cursor, freshness: { observedRevision: head.revision, cursorRevision: cursor, stale: cursor < head.revision, source: "authoritative_workspace_head" } });
      }
      revisions.push(event);
    }
    const cursor = revisions.at(-1)?.revision ?? afterRevision;
    return json({ head, revisions, resetRequired: false, cursor, hasMore: through < head.revision,
      freshness: { observedRevision: head.revision, cursorRevision: cursor, stale: cursor < head.revision, source: "authoritative_workspace_head" } });
  }

  private async acknowledge(body: Record<string, unknown>): Promise<Response> {
    if (!validateWorkspaceBranch(body.branch) || typeof body.subscriberId !== "string" || !ID.test(body.subscriberId) || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) return fail("invalid_subscription_cursor");
    const branch = body.branch;
    const head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!head) return fail("workspace_not_found", 404);
    const revision = Number(body.revision);
    if (revision > head.revision) return fail("change_cursor_ahead", 409);
    const next = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<{ revision: number; updatedAt: string; expiryKey?: string }>(subscriptionKey(branch, String(body.subscriberId)));
      if (current && current.revision > revision) return current;
      const updatedAt = new Date().toISOString();
      const expiresAt = Date.now() + SUBSCRIPTION_RETENTION_MS;
      const nextExpiryKey = expiryKey(expiresAt, crypto.randomUUID());
      const value = { revision: Math.max(current?.revision ?? 0, revision), updatedAt, expiryKey: nextExpiryKey };
      if (current?.expiryKey) await tx.delete(current.expiryKey);
      await tx.put(subscriptionKey(branch, String(body.subscriberId)), value);
      await tx.put(nextExpiryKey, { expiresAt, kind: "subscription", targetKey: subscriptionKey(branch, String(body.subscriberId)), branch, subscriberId: String(body.subscriberId) } satisfies ExpiryRecord);
      return value;
    });
    await this.scheduleMetadataExpiry();
    return json({ branch, subscriberId: body.subscriberId, ...next });
  }

  private async checkpoint(body: Record<string, unknown>): Promise<Response> {
    const sessionId = body.sessionId;
    const idempotencyKey = body.idempotencyKey;
    if (typeof sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(sessionId) || typeof idempotencyKey !== "string" || !ID.test(idempotencyKey) ||
        !Number.isSafeInteger(body.baseRevision) || !Number.isSafeInteger(body.allocationGeneration) || !Number.isSafeInteger(body.fence) ||
        (body.changes !== undefined && (!Array.isArray(body.changes) || body.changes.length > MAX_CHANGES)) ||
        (body.stageId !== undefined && (typeof body.stageId !== "string" || !ID.test(body.stageId))) ||
        (body.changes === undefined && body.stageId === undefined) || (body.changes !== undefined && body.stageId !== undefined)) return fail("invalid_checkpoint");
    const session = await this.ctx.storage.get<Session>(sessionKey(sessionId));
    if (!session) return fail("workspace_session_not_found", 404);
    if (typeof body.runtimeId === "string" && session.runtimeId !== body.runtimeId) return fail("workspace_session_scope_mismatch", 403);
    if (await this.contentGcLocked()) return fail("workspace_gc_in_progress", 423);
    if (session.status !== "active") return fail("stale_fence", 409);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
    if (session.fence !== body.fence) return fail("stale_fence", 409);
    if (!await this.hasCurrentSessionAuthority(session)) return fail("writer_lease_expired", 409);
    let changes: Change[];
    if (body.stageId !== undefined) {
      const staged = await this.ctx.storage.get<StageRecord>(stageKey(sessionId, String(body.stageId)));
      if (!staged) return fail("workspace_stage_not_found", 409);
      const stageScope = await this.ctx.storage.get<WorkspaceScope>("scope");
      if (!stageScope) return fail("workspace_scope_missing", 503);
      changes = [];
      for (const item of staged.changes) {
        if (item.sha256 === null) changes.push({ path: item.path, expectedHash: item.expectedHash, contentBase64: null, ...(item.executable === undefined ? {} : { executable: item.executable }), ...(item.contentType ? { contentType: item.contentType } : {}) });
        else {
          if (!item.objectKey?.startsWith(stagingPrefix(stageScope))) return fail("workspace_stage_scope_mismatch", 403);
          const object = await this.env.SCRIPTS_R2!.get(item.objectKey);
          if (!object || object.size !== item.size) return fail("workspace_stage_unavailable", 503);
          const bytes = new Uint8Array(await object.arrayBuffer());
          if (await sha256Hex(bytes) !== item.sha256) return fail("workspace_stage_corrupt", 503);
          changes.push({ path: item.path, expectedHash: item.expectedHash, contentBase64: base64(bytes), ...(item.executable === undefined ? {} : { executable: item.executable }), ...(item.contentType ? { contentType: item.contentType } : {}) });
        }
      }
    } else changes = body.changes as Change[];
    const paths = new Set<string>();
    for (const change of changes) {
        if (!change || !validateWorkspacePath(change.path) || paths.has(change.path) || !(change.expectedHash === null || (typeof change.expectedHash === "string" && HASH.test(change.expectedHash))) ||
          !(change.contentBase64 === null || typeof change.contentBase64 === "string") || (change.executable !== undefined && typeof change.executable !== "boolean") ||
          (change.contentType !== undefined && !validateWorkspaceContentType(change.contentType))) return fail("invalid_checkpoint");
      paths.add(change.path);
    }
    const encodedChanges = JSON.stringify(changes);
    const changeSetHash = await sha256Hex(new TextEncoder().encode(encodedChanges));
    const oldReceipt = await this.ctx.storage.get<WorkspacePublicationReceipt>(receiptKey(session.branch, idempotencyKey));
    if (oldReceipt) return oldReceipt.changeSetHash === changeSetHash ? json({ publication: oldReceipt }) : fail("idempotency_conflict", 409);
    const current = await this.ctx.storage.get<WorkspaceHead>(headKey(session.branch));
    if (!current) return fail("workspace_not_found", 404);
    if (current.revision !== body.baseRevision) return json({ error_code: "base_revision_mismatch", currentRevision: current.revision }, 409);
    if (session.mode === "live_single_writer") {
      const lease = await this.ctx.storage.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${session.branch}`);
      if (!lease || lease.sessionId !== sessionId || lease.fence !== session.fence || lease.expiresAt <= Date.now()) return fail("writer_lease_expired", 409);
    }
    const manifestObject = await this.env.SCRIPTS_R2!.get(manifestKey(current.scope, current.manifestHash));
    if (!manifestObject) return fail("workspace_manifest_unavailable", 503);
    const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
    if (await sha256Hex(manifestBytes) !== current.manifestHash) return fail("workspace_manifest_corrupt", 503);
    const previous = JSON.parse(new TextDecoder().decode(manifestBytes)) as WorkspaceEntry[];
    const next = new Map(previous.map((entry) => [entry.path, entry]));
    const conflicts = changes.flatMap((change) => {
      const actualHash = next.get(change.path)?.sha256 ?? null;
      return actualHash === change.expectedHash ? [] : [{ path: change.path, expectedHash: change.expectedHash, actualHash }];
    });
    const publicationId = `pub_${crypto.randomUUID()}`;
    const uploadIntentId = crypto.randomUUID();
    const uploadIntentKey = `upload-intent:${uploadIntentId}`;
    let appliedPaths: string[] = [];
    const newlyStoredContentKeys: string[] = [];
    let newlyStoredManifestKey: string | null = null;
    let nextHash = current.manifestHash;
    let status: WorkspacePublicationReceipt["status"] = "published";
    if (conflicts.length) status = "conflicted";
    else {
      let totalBytes = previous.reduce((sum, entry) => sum + entry.size, 0);
      for (const change of changes) {
        const old = next.get(change.path);
        if (change.contentBase64 === null) {
          if (old) { next.delete(change.path); totalBytes -= old.size; }
        } else {
          let bytes: Uint8Array;
          try { bytes = unbase64(change.contentBase64); } catch { return fail("invalid_file_content"); }
          if (bytes.byteLength > MAX_FILE_BYTES) return fail("workspace_file_limit_exceeded", 413);
          const hash = await sha256Hex(bytes);
          const objectKey = `${contentPrefix(current.scope)}${hash}`;
          const protectedUpload = await this.protectUpload(current.scope, uploadIntentId, objectKey);
          if (protectedUpload !== "ready") {
            if (newlyStoredContentKeys.length) await this.env.SCRIPTS_R2!.delete(newlyStoredContentKeys);
            await this.ctx.storage.delete(uploadIntentKey);
            return protectedUpload === "erased" ? fail("workspace_erased", 410)
              : protectedUpload === "gc_busy" ? fail("workspace_gc_in_progress", 423)
                : protectedUpload === "intent_limit" ? fail("workspace_upload_intent_limit", 413) : fail("workspace_scope_mismatch", 403);
          }
          const contentType = change.contentType ?? old?.contentType ?? inferWorkspaceContentType(change.path);
          const uploaded = await this.env.SCRIPTS_R2!.put(objectKey, bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: hash, size: String(bytes.byteLength) }, ...(contentType ? { httpMetadata: { contentType } } : {}) });
          if (uploaded) newlyStoredContentKeys.push(objectKey);
          if (!uploaded) {
            const found = await this.env.SCRIPTS_R2!.get(objectKey);
            if (!found || await sha256Hex(new Uint8Array(await found.arrayBuffer())) !== hash) return fail("workspace_content_persist_failed", 503);
          }
          if (old) totalBytes -= old.size;
          totalBytes += bytes.byteLength;
          next.set(change.path, { path: change.path, sha256: hash, size: bytes.byteLength, executable: change.executable ?? old?.executable ?? false, objectKey, ...(contentType ? { contentType } : {}) });
        }
        appliedPaths.push(change.path);
      }
      if (next.size > MAX_ENTRIES) return fail("workspace_entry_limit_exceeded", 413);
      if (totalBytes > MAX_WORKSPACE_BYTES) return fail("workspace_limit_exceeded", 413);
      const encoded = canonicalManifest([...next.values()]);
      nextHash = await sha256Hex(new TextEncoder().encode(encoded));
      if (nextHash !== current.manifestHash) {
        const objectKey = manifestKey(current.scope, nextHash);
        const protectedUpload = await this.protectUpload(current.scope, uploadIntentId, objectKey);
        if (protectedUpload !== "ready") {
          if (newlyStoredContentKeys.length) await this.env.SCRIPTS_R2!.delete(newlyStoredContentKeys);
          await this.ctx.storage.delete(uploadIntentKey);
          return protectedUpload === "erased" ? fail("workspace_erased", 410)
            : protectedUpload === "gc_busy" ? fail("workspace_gc_in_progress", 423)
              : protectedUpload === "intent_limit" ? fail("workspace_upload_intent_limit", 413) : fail("workspace_scope_mismatch", 403);
        }
        const put = await this.env.SCRIPTS_R2!.put(objectKey, encoded, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: nextHash } });
        if (put) newlyStoredManifestKey = objectKey;
        if (!put) {
          const found = await this.env.SCRIPTS_R2!.get(objectKey);
          if (!found || await sha256Hex(new Uint8Array(await found.arrayBuffer())) !== nextHash) return fail("manifest_persist_failed", 503);
        }
      } else status = "noop";
    }
    const revision = status === "published" ? current.revision + 1 : current.revision;
    const receipt: WorkspacePublicationReceipt = { id: publicationId, idempotencyKey, status, branch: session.branch, baseRevision: current.revision, revision, appliedPaths: status === "conflicted" ? [] : appliedPaths, conflicts, changeSetHash, fence: session.fence, allocationGeneration: session.allocationGeneration };
    const newHead: WorkspaceHead = { ...current, revision, manifestHash: nextHash, parentRevision: current.revision, publicationId, updatedAt: new Date().toISOString() };
    const committed = await this.ctx.storage.transaction(async (tx) => {
      const replay = await tx.get<WorkspacePublicationReceipt>(receiptKey(session.branch, idempotencyKey));
      if (replay) {
        await tx.delete(uploadIntentKey);
        return replay.changeSetHash === changeSetHash ? { receipt: replay } : { error: "idempotency_conflict" };
      }
      const head = await tx.get<WorkspaceHead>(headKey(session.branch));
      const gc = await tx.get<ContentGcState>("content_gc");
      const activeSession = await tx.get<Session>(sessionKey(sessionId));
      const migration = await tx.get<WorkspaceMigration>("project_migration");
      if (migration && migration.status !== "verified" && !(activeSession?.actorId === "workspace-migration" && (migration.status === "importing" || migration.status === "repairing" || migration.status === "restoring"))) return { error: "workspace_migration_barrier_active" };
      if (gc && gc.lockUntil > Date.now()) return { error: "workspace_gc_in_progress" };
      if (await tx.get<boolean>("erased")) return { error: "workspace_erased" };
      if (!head || head.revision !== current.revision || head.manifestHash !== current.manifestHash) return { error: "head_raced" };
      if (!activeSession || activeSession.status !== "active" || activeSession.allocationGeneration !== body.allocationGeneration || activeSession.fence !== body.fence) return { error: "stale_fence" };
      if (activeSession.mode === "live_single_writer") {
        const lease = await tx.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${session.branch}`);
        if (!lease || lease.sessionId !== sessionId || lease.fence !== activeSession.fence || lease.expiresAt <= Date.now()) return { error: "writer_lease_expired" };
      }
      await tx.put(receiptKey(session.branch, idempotencyKey), receipt);
      const expiresAt = Date.now() + RECEIPT_RETENTION_MS;
      await tx.put(expiryKey(expiresAt, crypto.randomUUID()), { expiresAt, kind: "receipt", targetKey: receiptKey(session.branch, idempotencyKey) } satisfies ExpiryRecord);
      if (status === "published") {
        await tx.put(headKey(session.branch), newHead);
        await tx.put(retainedRevisionKey(session.branch, revision), { branch: session.branch, revision, manifestHash: nextHash, createdAt: newHead.updatedAt } satisfies RetainedRevision);
        await tx.put(revisionEventKey(session.branch, revision), { branch: session.branch, revision, publicationId, changedPaths: appliedPaths, updatedAt: newHead.updatedAt } satisfies RevisionEvent);
        if (revision > REVISION_EVENT_RETENTION) await tx.delete(revisionEventKey(session.branch, revision - REVISION_EVENT_RETENTION));
      }
      await tx.delete(uploadIntentKey);
      if (body.stageId !== undefined && (status === "published" || status === "noop")) {
        const stageId = String(body.stageId);
        const staged = await tx.get<StageRecord>(stageKey(sessionId, stageId));
        if (staged) await tx.put(stageKey(sessionId, stageId), { ...staged, status: "consumed", consumedAt: new Date().toISOString() } satisfies StageRecord);
      }
      return { receipt };
    });
    if ("error" in committed) {
      if (committed.error === "workspace_erased" || committed.error === "workspace_gc_in_progress") {
        if (newlyStoredManifestKey) await this.env.SCRIPTS_R2!.delete(newlyStoredManifestKey);
        if (newlyStoredContentKeys.length) await this.env.SCRIPTS_R2!.delete(newlyStoredContentKeys);
        await this.ctx.storage.delete(uploadIntentKey);
        return committed.error === "workspace_erased" ? fail("workspace_erased", 410) : fail("workspace_gc_in_progress", 423);
      }
      await this.ctx.storage.delete(uploadIntentKey);
      return fail(committed.error, committed.error === "workspace_migration_barrier_active" ? 423 : 409);
    }
    await this.scheduleMetadataExpiry();
    return json({ publication: committed.receipt }, status === "conflicted" ? 409 : 200);
  }

  private async stage(body: Record<string, unknown>): Promise<Response> {
    const { sessionId, stageId } = body;
    if (typeof sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(sessionId) || typeof stageId !== "string" || !ID.test(stageId) ||
        !Number.isSafeInteger(body.allocationGeneration) || !Number.isSafeInteger(body.fence) || !Array.isArray(body.changes) || body.changes.length > MAX_CHANGES) return fail("invalid_stage");
    const session = await this.ctx.storage.get<Session>(sessionKey(sessionId));
    if (!session || session.status !== "active") return fail("workspace_session_not_found", 404);
    if (typeof body.runtimeId === "string" && session.runtimeId !== body.runtimeId) return fail("workspace_session_scope_mismatch", 403);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
    if (session.fence !== body.fence) return fail("stale_fence", 409);
    if (!await this.hasCurrentSessionAuthority(session)) return fail("writer_lease_expired", 409);
    if (session.mode === "live_single_writer") {
      const lease = await this.ctx.storage.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${session.branch}`);
      if (!lease || lease.sessionId !== sessionId || lease.fence !== session.fence || lease.expiresAt <= Date.now()) return fail("writer_lease_expired", 409);
    }
    const branchHead = await this.ctx.storage.get<WorkspaceHead>(headKey(session.branch));
    if (!branchHead) return fail("workspace_branch_not_found", 404);
    const changes = body.changes as Change[];
    const paths = new Set<string>();
    const stagedChanges: StagedChange[] = [];
    const newlyStoredStageKeys: string[] = [];
    let totalBytes = 0;
    for (const change of changes) {
      if (!change || !validateWorkspacePath(change.path) || paths.has(change.path) || !(change.expectedHash === null || typeof change.expectedHash === "string" && HASH.test(change.expectedHash)) ||
          !(change.contentBase64 === null || typeof change.contentBase64 === "string") || (change.executable !== undefined && typeof change.executable !== "boolean") ||
          (change.contentType !== undefined && !validateWorkspaceContentType(change.contentType))) return fail("invalid_stage");
      paths.add(change.path);
      if (change.contentBase64 === null) {
        stagedChanges.push({ path: change.path, expectedHash: change.expectedHash, sha256: null, size: 0, ...(change.executable === undefined ? {} : { executable: change.executable }), contentType: change.contentType ?? inferWorkspaceContentType(change.path) });
        continue;
      }
      let bytes: Uint8Array;
      try { bytes = unbase64(change.contentBase64); } catch { return fail("invalid_file_content"); }
      if (bytes.byteLength > MAX_FILE_BYTES) return fail("workspace_file_limit_exceeded", 413);
      if ((totalBytes += bytes.byteLength) > MAX_WORKSPACE_BYTES) return fail("workspace_limit_exceeded", 413);
      const hash = await sha256Hex(bytes);
      const pathHash = await sha256Hex(new TextEncoder().encode(change.path));
      const objectKey = `${stagingPrefix(branchHead.scope)}${sessionId}/${stageId}/${pathHash}`;
      const contentType = change.contentType ?? inferWorkspaceContentType(change.path);
      const put = await this.env.SCRIPTS_R2!.put(objectKey, bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: hash, size: String(bytes.byteLength) }, httpMetadata: { contentType } });
      if (put) newlyStoredStageKeys.push(objectKey);
      if (!put) {
        const existing = await this.env.SCRIPTS_R2!.get(objectKey);
        if (!existing || existing.size !== bytes.byteLength || await sha256Hex(new Uint8Array(await existing.arrayBuffer())) !== hash) return fail("workspace_stage_content_conflict", 409);
      }
      stagedChanges.push({ path: change.path, expectedHash: change.expectedHash, sha256: hash, size: bytes.byteLength, ...(change.executable === undefined ? {} : { executable: change.executable }), contentType, objectKey });
    }
    const changeSetHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(changes)));
    const prior = await this.ctx.storage.get<StageRecord>(stageKey(sessionId, stageId));
    if (prior) return prior.changeSetHash === changeSetHash ? json({ stageId, status: "staged", changeSetHash }) : fail("idempotency_conflict", 409);
    const result = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<Session>(sessionKey(sessionId));
      if (await tx.get<boolean>("erased")) return "workspace_erased";
      if (!current || current.status !== "active" || current.allocationGeneration !== body.allocationGeneration || current.fence !== body.fence) return "stale_fence";
      if (current.mode === "live_single_writer") {
        const lease = await tx.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${current.branch}`);
        if (!lease || lease.sessionId !== current.id || lease.fence !== current.fence || lease.expiresAt <= Date.now()) return "writer_lease_expired";
      }
      const migration = await tx.get<WorkspaceMigration>("project_migration");
      if (migration && migration.status !== "verified" && !(current.actorId === "workspace-migration" && (migration.status === "importing" || migration.status === "repairing" || migration.status === "restoring"))) return "workspace_migration_barrier_active";
      const existing = await tx.get<StageRecord>(stageKey(sessionId, stageId));
      if (existing) return existing.changeSetHash === changeSetHash ? "staged" : "idempotency_conflict";
      await tx.put(stageKey(sessionId, stageId), { sessionId, stageId, changeSetHash, changes: stagedChanges, createdAt: new Date().toISOString() } satisfies StageRecord);
      return "staged";
    });
    if (result !== "staged" && newlyStoredStageKeys.length) await this.env.SCRIPTS_R2!.delete(newlyStoredStageKeys);
    return result === "staged" ? json({ stageId, status: "staged", changeSetHash }) : fail(result, result === "workspace_erased" ? 410 : result === "workspace_migration_barrier_active" ? 423 : 409);
  }

  private async erase(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    if (body.confirm !== true || !validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId) return fail("invalid_erasure_scope", 403);
    const requestedScope = body.scope;
    const existingScope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (existingScope && JSON.stringify(existingScope) !== JSON.stringify(requestedScope)) return fail("workspace_scope_mismatch", 403);
    const started = await this.ctx.storage.transaction(async tx => {
      if (await tx.get<boolean>("erased")) return "already_erased" as const;
      const admission = await tx.get<WorkspaceErasureAdmission>("workspace_erasure_admission");
      if (!admission || JSON.stringify(admission.scope) !== JSON.stringify(requestedScope)) return "erasure_admission_required" as const;
      const policy = await tx.get<WorkspaceRetentionPolicy>("workspace_retention_policy");
      const hold = policy?.legalHold;
      if (hold && (!hold.expiresAt || Date.parse(hold.expiresAt) > Date.now())) return "legal_hold_active" as const;
      await tx.put("erased", true);
      return "started" as const;
    });
    if (started === "erasure_admission_required") return fail(started, 409);
    if (started === "legal_hold_active") return fail(started, 423);
    const hasRuntimeControl = Boolean(this.env.LIVE_RUNTIME_CONTROL || this.env.LIVE_RUNTIME_CONTROL_DO);
    if (hasRuntimeControl) {
      const controlTombstone = await this.callLiveRuntimeControl("/internal/v1/project/erase", requestedScope, { confirm: true });
      if (controlTombstone?.erased !== true) return fail("runtime_control_erasure_pending", 503);
    }
    const prefix = `workspace-v1/${keyScope(requestedScope)}/`;
    let cursor: string | undefined;
    const seen = new Set<string>();
    let deleted = 0;
    do {
      const page = await this.env.SCRIPTS_R2!.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
      if (page.objects.length) {
        await this.env.SCRIPTS_R2!.delete(page.objects.map((object) => object.key));
        deleted += page.objects.length;
      }
      if (!page.truncated) break;
      const next = page.cursor;
      if (!next || seen.has(next)) return fail("erasure_cursor_invalid", 503);
      seen.add(next);
      cursor = next;
    } while (cursor);
    // Keep the tombstone present while metadata is removed. `deleteAll()` followed by a
    // tombstone write creates an await gap in which an already-running request could commit new
    // metadata after the erasure sweep.
    let after: string | undefined;
    for (;;) {
      const page = await this.ctx.storage.list({ ...(after ? { startAfter: after } : {}), limit: 1000 });
      const keys = [...page.keys()];
      if (!keys.length) break;
      const next = keys[keys.length - 1]!;
      if (after && next <= after) return fail("erasure_metadata_cursor_invalid", 503);
      const remove = keys.filter((key) => key !== "erased");
      if (remove.length) await this.ctx.storage.delete(remove);
      after = next;
      if (keys.length < 1000) break;
    }
    await this.ctx.storage.put("erased", true);
    return json({ erased: true, scope: requestedScope, objectsDeleted: deleted,
      ...(hasRuntimeControl ? { runtimeControlTombstoneRecorded: true, providerRuntimeDeletion: "tracked_separately" } : {}) });
  }

  private async admitErase(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    if (body.confirm !== true || !validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId) return fail("invalid_erasure_scope", 403);
    const requestedScope = body.scope;
    const existingScope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (existingScope && JSON.stringify(existingScope) !== JSON.stringify(requestedScope)) return fail("workspace_scope_mismatch", 403);
    const at = new Date().toISOString();
    const result = await this.ctx.storage.transaction(async tx => {
      if (await tx.get<boolean>("erased")) return { status: "already_erased" as const };
      const policy = await tx.get<WorkspaceRetentionPolicy>("workspace_retention_policy");
      const hold = policy?.legalHold;
      if (hold && (!hold.expiresAt || Date.parse(hold.expiresAt) > Date.now())) return { status: "legal_hold_active" as const, expiresAt: hold.expiresAt ?? null };
      const prior = await tx.get<WorkspaceErasureAdmission>("workspace_erasure_admission");
      if (prior) return JSON.stringify(prior.scope) === JSON.stringify(requestedScope)
        ? { status: "admitted" as const, admittedAt: prior.admittedAt, deduplicated: true }
        : { status: "scope_mismatch" as const };
      await tx.put("workspace_erasure_admission", { scope: requestedScope, admittedAt: at } satisfies WorkspaceErasureAdmission);
      return { status: "admitted" as const, admittedAt: at, deduplicated: false };
    });
    if (result.status === "scope_mismatch") return fail("workspace_scope_mismatch", 403);
    if (result.status === "legal_hold_active") return json({ error_code: "legal_hold_active", holdExpiresAt: result.expiresAt }, 423);
    return json({ admitted: true, alreadyErased: result.status === "already_erased", ...("admittedAt" in result ? { admittedAt: result.admittedAt, deduplicated: result.deduplicated } : {}) });
  }

  private async collectStaging(body: Record<string, unknown>): Promise<Response> {
    const scope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (!scope) return fail("workspace_scope_missing", 503);
    const leaseId = crypto.randomUUID();
    const claim = await this.ctx.storage.transaction(async tx => {
      if (await tx.get<boolean>("erased")) return { error: "workspace_erased" as const };
      const policy = await tx.get<WorkspaceRetentionPolicy>("workspace_retention_policy");
      const hold = policy?.legalHold;
      if (hold && (!hold.expiresAt || Date.parse(hold.expiresAt) > Date.now())) return { hold };
      const current = await tx.get<RetentionGcLease>("workspace_retention_gc_lease");
      if (current && current.expiresAt > Date.now()) return { error: "workspace_gc_in_progress" as const };
      await tx.put("workspace_retention_gc_lease", { id: leaseId, expiresAt: Date.now() + RETENTION_GC_LEASE_MS });
      return { policy };
    });
    if ("hold" in claim) return json({ skipped: true, reason: "legal_hold_active", holdExpiresAt: claim.hold.expiresAt ?? null });
    if ("error" in claim) return fail(claim.error, claim.error === "workspace_erased" ? 410 : 423);
    const policy = claim.policy;
    try {
    const retentionMs = Math.max(STAGING_RETENTION_MS, (policy?.stagingRetentionDays ?? 7) * 24 * 60 * 60 * 1000);
    const minimumCutoff = Date.now() - retentionMs;
    const requestedCutoff = typeof body.before === "number" ? body.before : minimumCutoff;
    if (!Number.isFinite(requestedCutoff) || requestedCutoff > minimumCutoff) return fail("staging_retention_too_short");
    const cursor = typeof body.cursor === "string" && body.cursor.length <= 1024 ? body.cursor : undefined;
    const prefix = stagingPrefix(scope);
    const page = await this.env.SCRIPTS_R2!.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    let nextStageCursor: string | undefined;
    try { nextStageCursor = nextR2Cursor(page, "staging", cursor); }
    catch { return fail("workspace_gc_staging_cursor_invalid", 503); }
    const deleteKeys: string[] = [];
    const deleteRecords = new Set<string>();
    for (const object of page.objects) {
      const relative = object.key.slice(prefix.length).split("/");
      const sessionId = relative[0];
      const stageId = relative[1];
      if (!sessionId || !stageId || !/^ws_[0-9a-f-]{36}$/.test(sessionId) || !ID.test(stageId)) continue;
      const recordKey = stageKey(sessionId, stageId);
      const stage = await this.ctx.storage.get<StageRecord>(recordKey);
      let eligible = false;
      if (!stage) eligible = object.uploaded.getTime() <= requestedCutoff;
      else if (stage.status === "consumed" && Date.parse(stage.consumedAt ?? "") <= requestedCutoff) eligible = true;
      else if (Date.parse(stage.createdAt) <= requestedCutoff) {
        const session = await this.ctx.storage.get<Session>(sessionKey(sessionId));
        eligible = session?.status === "closed";
      }
      if (eligible) { deleteKeys.push(object.key); deleteRecords.add(recordKey); }
    }
    if (deleteKeys.length) await this.env.SCRIPTS_R2!.delete(deleteKeys);
    for (const key of deleteRecords) await this.ctx.storage.delete(key);
    // Stages containing only deletes (or an empty change set) have metadata but no R2 object to
    // discover above. Sweep their records independently so retries and long-lived workspaces do
    // not accumulate coordinator keys forever.
    const recordCursor = typeof body.recordCursor === "string" && body.recordCursor.length <= 1024 ? body.recordCursor : undefined;
    const stageRecords = await this.ctx.storage.list<StageRecord>({ prefix: "stage:", ...(recordCursor ? { startAfter: recordCursor } : {}), limit: 1000 });
    let recordsDeleted = 0;
    for (const [key, stage] of stageRecords) {
      const createdAt = Date.parse(stage.createdAt);
      const consumedAt = Date.parse(stage.consumedAt ?? "");
      let eligible = stage.status === "consumed" && consumedAt <= requestedCutoff;
      if (!eligible && createdAt <= requestedCutoff) {
        const session = await this.ctx.storage.get<Session>(sessionKey(stage.sessionId));
        eligible = session?.status === "closed";
      }
      if (eligible) {
        await this.ctx.storage.delete(key);
        recordsDeleted++;
      }
    }
    const nextRecordCursor = stageRecords.size === 1000 ? [...stageRecords.keys()].at(-1) ?? null : null;
    return json({ scanned: page.objects.length, deleted: deleteKeys.length, recordsDeleted, cursor: nextStageCursor ?? null, recordCursor: nextRecordCursor, hasMore: nextStageCursor !== undefined || nextRecordCursor !== null });
    } finally {
      await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<RetentionGcLease>("workspace_retention_gc_lease");
        if (current?.id === leaseId) await tx.delete("workspace_retention_gc_lease");
      });
    }
  }

  private async setRetentionPolicy(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    const scope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (!scope || scope.tenantId !== tenantId || !validateWorkspaceScope(body.scope) ||
        body.scope.tenantId !== scope.tenantId || body.scope.spaceId !== scope.spaceId ||
        body.scope.projectId !== scope.projectId || body.scope.jurisdiction !== scope.jurisdiction)
      return fail("workspace_scope_mismatch", 403);
    const actorId = body.actorId, reason = body.reason;
    const days = body.stagingRetentionDays;
    const holdEnabled = body.legalHold === true;
    const expiresAt = body.legalHoldExpiresAt;
    if (typeof actorId !== "string" || !ID.test(actorId) || typeof reason !== "string" || reason.trim().length < 10 || reason.length > 500 ||
        !Number.isSafeInteger(days) || Number(days) < 7 || Number(days) > 3650 ||
        (holdEnabled && expiresAt !== undefined && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 3650 * 24 * 60 * 60 * 1000)))
      return fail("workspace_retention_policy_invalid", 400);
    const at = new Date().toISOString();
    const policy = await this.ctx.storage.transaction(async tx => {
      const now = Date.now();
      if (await tx.get<WorkspaceErasureAdmission>("workspace_erasure_admission")) return { error: "workspace_erasure_in_progress" as const };
      const stagingLease = await tx.get<RetentionGcLease>("workspace_retention_gc_lease");
      const contentLease = await tx.get<ContentGcState>("content_gc");
      if ((stagingLease && stagingLease.expiresAt > now) || (contentLease && contentLease.lockUntil > now)) return { error: "workspace_gc_in_progress" as const };
      const prior = await tx.get<WorkspaceRetentionPolicy>("workspace_retention_policy") ?? {
        version: 1 as const, stagingRetentionDays: 7, legalHold: null, updatedAt: at, updatedBy: actorId,
      };
      const next: WorkspaceRetentionPolicy = { version: 1, stagingRetentionDays: Number(days),
        legalHold: holdEnabled ? { ...(typeof expiresAt === "string" ? { expiresAt: new Date(expiresAt).toISOString() } : {}), reason: reason.trim(), actorId, createdAt: at } : null,
        updatedAt: at, updatedBy: actorId };
      const audit = await tx.get<Array<Record<string, unknown>>>("workspace_retention_policy_audit") ?? [];
      audit.push({ actorId, reason: reason.trim(), at, prior, next });
      await tx.put("workspace_retention_policy", next);
      await tx.put("workspace_retention_policy_audit", audit.slice(-100));
      return next;
    });
    if ("error" in policy) return fail(policy.error, 423);
    return json({ policy });
  }

  /** Expiry indexes are ordered by deadline so each invocation performs a bounded sweep. */
  private async collectMetadata(): Promise<Response> {
    const page = await this.ctx.storage.list<ExpiryRecord>({ prefix: "expiry:", limit: 100 });
    let deleted = 0;
    for (const [key, expiry] of page) {
      if (!Number.isSafeInteger(expiry.expiresAt)) {
        await this.ctx.storage.delete(key);
        deleted++;
        continue;
      }
      if (expiry.expiresAt > Date.now()) break;
      if (expiry.kind === "receipt" && (expiry.targetKey.startsWith("receipt:") || expiry.targetKey.startsWith("merge-receipt:"))) {
        await this.ctx.storage.transaction(async (tx) => {
          await tx.delete(expiry.targetKey);
          await tx.delete(key);
        });
        deleted++;
      } else if (expiry.kind === "subscription" && expiry.targetKey.startsWith("subscription:") && expiry.branch && expiry.subscriberId) {
        await this.ctx.storage.transaction(async (tx) => {
          const current = await tx.get<{ expiryKey?: string }>(expiry.targetKey);
          if (current?.expiryKey === key) await tx.delete(expiry.targetKey);
          await tx.delete(key);
        });
        deleted++;
      } else {
        // Malformed indexes were generated only by internal metadata paths; drop them rather
        // than allowing a corrupt key to block every later expiry record.
        await this.ctx.storage.delete(key);
      }
    }
    const result = { scanned: page.size, deleted, hasMore: page.size === 100 };
    await this.scheduleMetadataExpiry();
    return json(result);
  }

  private async scheduleMetadataExpiry(): Promise<void> {
    const page = await this.ctx.storage.list<ExpiryRecord>({ prefix: "expiry:", limit: 100 });
    for (const [, expiry] of page) {
      if (Number.isSafeInteger(expiry.expiresAt)) {
        await this.scheduleAlarmAt(expiry.expiresAt);
        return;
      }
    }
  }

  private async scheduleAlarmAt(scheduledTime: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > scheduledTime) await this.ctx.storage.setAlarm(scheduledTime);
  }

  private async protectUpload(scope: WorkspaceScope, intentId: string, objectKey: string): Promise<"ready" | "erased" | "gc_busy" | "scope_mismatch" | "intent_limit"> {
    return this.ctx.storage.transaction(async (tx) => {
      if (await tx.get<boolean>("erased")) return "erased";
      const gc = await tx.get<ContentGcState>("content_gc");
      if (gc && gc.lockUntil > Date.now()) return "gc_busy";
      const known = await tx.get<WorkspaceScope>("scope");
      if (known && JSON.stringify(known) !== JSON.stringify(scope)) return "scope_mismatch";
      const key = `upload-intent:${intentId}`;
      const current = await tx.get<WorkspaceUploadIntent>(key);
      const objectKeys = current?.objectKeys ?? [];
      if (!objectKeys.includes(objectKey)) objectKeys.push(objectKey);
      if (objectKeys.length > MAX_CHANGES + 1) return "intent_limit";
      await tx.put(key, { createdAt: new Date().toISOString(), objectKeys } satisfies WorkspaceUploadIntent);
      return "ready";
    });
  }

  /**
   * Mark/sweep manifests and content from retained revision roots. A one-time manifest backfill
   * preserves history created before revision metadata existed. A durable maintenance lease
   * prevents new canonical manifests from appearing during collection; each call advances one
   * bounded, restartable batch.
   */
  private async collectContent(resumeOnly: boolean): Promise<Response> {
    const scope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (!scope) return fail("workspace_scope_missing", 503);
    const claimed = await this.ctx.storage.transaction(async (tx) => {
      if (await tx.get<boolean>("erased")) return { error: "workspace_erased" as const };
      const now = Date.now();
      const policy = await tx.get<WorkspaceRetentionPolicy>("workspace_retention_policy");
      const hold = policy?.legalHold;
      if (hold && (!hold.expiresAt || Date.parse(hold.expiresAt) > now)) return { hold };
      const current = await tx.get<ContentGcState>("content_gc");
      if (!current && resumeOnly) return { error: "workspace_gc_not_running" as const };
      if (current && current.lockUntil > now && current.claimUntil > now) return { error: "workspace_gc_step_in_progress" as const };
      const state: ContentGcState = current && current.lockUntil > now
        ? { ...current, claimId: crypto.randomUUID(), claimUntil: now + CONTENT_GC_CLAIM_MS, lockUntil: now + CONTENT_GC_LOCK_MS }
        : { epoch: crypto.randomUUID(), phase: await tx.get<boolean>("content_gc_backfill_complete") ? "roots" : "backfill", claimId: crypto.randomUUID(), claimUntil: now + CONTENT_GC_CLAIM_MS, lockUntil: now + CONTENT_GC_LOCK_MS };
      await tx.put("content_gc", state);
      return { state };
    });
    if ("hold" in claimed) return json({ skipped: true, reason: "legal_hold_active", holdExpiresAt: claimed.hold.expiresAt ?? null });
    if ("error" in claimed) return fail(claimed.error, claimed.error === "workspace_erased" ? 410 : 409);
    const state = claimed.state;
    let processed = 0;
    const createdMarks: string[] = [];
    try {
      if (state.phase === "backfill") {
        const page = await this.env.SCRIPTS_R2!.list({ prefix: `workspace-v1/${keyScope(scope)}/manifests/`, ...(state.backfillCursor ? { cursor: state.backfillCursor } : {}), limit: 1 });
        const nextCursor = nextR2Cursor(page, "backfill", state.backfillCursor);
        const item = page.objects[0];
        if (!item) {
          if (nextCursor) state.backfillCursor = nextCursor;
          else {
            state.phase = "roots";
            state.legacyBackfillDone = true;
            delete state.backfillCursor;
          }
        } else {
          const match = item.key.match(/\/manifests\/([a-f0-9]{64})\.json$/);
          const manifestHash = match?.[1];
          if (!manifestHash) throw new Error("workspace_gc_invalid_manifest_key");
          state.pendingLegacyManifestHash = manifestHash;
          if (nextCursor) state.backfillCursor = nextCursor;
          else {
            delete state.backfillCursor;
            state.legacyBackfillDone = true;
            state.phase = "roots";
          }
        }
        processed = page.objects.length;
      } else if (state.phase === "roots") {
        const page = await this.ctx.storage.list({ ...(state.storageCursor ? { startAfter: state.storageCursor } : {}), limit: 100 });
        for (const [key, value] of page) {
          let manifestHash: unknown;
          if (key.startsWith("head:")) manifestHash = (value as WorkspaceHead).manifestHash;
          else if (key.startsWith("retained-revision:")) manifestHash = (value as RetainedRevision).manifestHash;
          else if (key.startsWith("branch-base:")) manifestHash = (value as { manifestHash?: unknown }).manifestHash;
          else if (key.startsWith("session:")) {
            const session = value as Session;
            if (session.status === "active") manifestHash = session.baseManifestHash;
          } else if (key.startsWith("legacy-manifest:")) manifestHash = key.slice("legacy-manifest:".length);
          if (typeof manifestHash === "string" && HASH.test(manifestHash)) {
            const marker = `${gcMarksPrefix(scope, state.epoch)}manifests/${manifestHash}`;
            if (!await this.env.SCRIPTS_R2!.head(marker)) {
              await this.env.SCRIPTS_R2!.put(marker, "1");
              createdMarks.push(marker);
            }
          }
          if (key.startsWith("upload-intent:")) {
            const intent = value as WorkspaceUploadIntent;
            const createdAt = Date.parse(intent.createdAt);
            if (!Number.isFinite(createdAt) || !Array.isArray(intent.objectKeys) || intent.objectKeys.length < 1 || intent.objectKeys.length > MAX_CHANGES + 1 || !intent.objectKeys.every((item) => typeof item === "string")) {
              throw new Error("workspace_gc_upload_intent_invalid");
            }
            if (createdAt + UPLOAD_INTENT_MAX_AGE_MS <= Date.now()) {
              await this.ctx.storage.delete(key);
            } else {
              for (const objectKey of intent.objectKeys) {
                const contentObjectPrefix = contentPrefix(scope);
                const manifestObjectPrefix = `workspace-v1/${keyScope(scope)}/manifests/`;
                const contentHash = objectKey.startsWith(contentObjectPrefix) ? objectKey.slice(contentObjectPrefix.length) : "";
                const manifestName = objectKey.startsWith(manifestObjectPrefix) ? objectKey.slice(manifestObjectPrefix.length) : "";
                const manifestHash = manifestName.endsWith(".json") ? manifestName.slice(0, -5) : "";
                if (!HASH.test(contentHash) && !HASH.test(manifestHash)) throw new Error("workspace_gc_upload_intent_key_invalid");
                const markerKey = HASH.test(contentHash)
                  ? `${gcMarksPrefix(scope, state.epoch)}content/${contentHash}`
                  : HASH.test(manifestHash) ? `${gcMarksPrefix(scope, state.epoch)}manifests/${manifestHash}` : null;
                if (markerKey && !await this.env.SCRIPTS_R2!.head(markerKey)) {
                  await this.env.SCRIPTS_R2!.put(markerKey, "1");
                  createdMarks.push(markerKey);
                }
              }
            }
          }
        }
        const lastKey = [...page.keys()].at(-1);
        if (lastKey) state.storageCursor = lastKey;
        if (page.size < 100) { delete state.storageCursor; state.phase = "mark"; }
        processed = page.size;
      } else if (state.phase === "mark") {
        if (state.activeManifestKey) {
          const match = state.activeManifestKey.match(/\/manifests\/([a-f0-9]{64})\.json$/);
          if (!match) throw new Error("workspace_gc_invalid_manifest_key");
          if (!await this.env.SCRIPTS_R2!.head(`${gcMarksPrefix(scope, state.epoch)}manifests/${match[1]}`)) {
            delete state.activeManifestKey;
            delete state.activeManifestOffset;
            if (state.manifestListDone) state.phase = "sweep-manifests";
            processed = 1;
          } else {
          const object = await this.env.SCRIPTS_R2!.get(state.activeManifestKey);
          if (!object) throw new Error("workspace_gc_manifest_missing");
          const bytes = new Uint8Array(await object.arrayBuffer());
          if (await sha256Hex(bytes) !== match[1]) throw new Error("workspace_gc_manifest_corrupt");
          const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
          if (!Array.isArray(parsed) || !parsed.every(validateWorkspaceEntry)) throw new Error("workspace_gc_manifest_invalid");
          const entries = parsed as WorkspaceEntry[];
          const offset = state.activeManifestOffset ?? 0;
          const batch = entries.slice(offset, offset + CONTENT_GC_ENTRY_BATCH);
          for (const entry of batch) {
            const expectedKey = `${contentPrefix(scope)}${entry.sha256}`;
            if (entry.objectKey !== expectedKey) throw new Error("workspace_gc_content_scope_mismatch");
            const marker = `${gcMarksPrefix(scope, state.epoch)}content/${entry.sha256}`;
            if (!await this.env.SCRIPTS_R2!.head(marker)) {
              await this.env.SCRIPTS_R2!.put(marker, "1");
              createdMarks.push(marker);
            }
          }
          processed = batch.length;
          const nextOffset = offset + batch.length;
          if (nextOffset < entries.length) state.activeManifestOffset = nextOffset;
          else {
            delete state.activeManifestKey;
            delete state.activeManifestOffset;
            if (state.manifestListDone) state.phase = "sweep-manifests";
          }
          }
        } else {
          const page = await this.env.SCRIPTS_R2!.list({ prefix: `workspace-v1/${keyScope(scope)}/manifests/`, ...(state.manifestCursor ? { cursor: state.manifestCursor } : {}), limit: 1 });
          const nextCursor = nextR2Cursor(page, "manifest_mark", state.manifestCursor);
          const item = page.objects[0];
          if (!item) {
            if (nextCursor) state.manifestCursor = nextCursor;
            else state.phase = "sweep-manifests";
            state.manifestListDone = !nextCursor;
          }
          else {
            state.activeManifestKey = item.key;
            state.activeManifestOffset = 0;
            if (nextCursor) state.manifestCursor = nextCursor;
            else delete state.manifestCursor;
            state.manifestListDone = !page.truncated;
          }
          processed = page.objects.length;
        }
      } else if (state.phase === "sweep-manifests") {
        const prefix = `workspace-v1/${keyScope(scope)}/manifests/`;
        const page = await this.env.SCRIPTS_R2!.list({ prefix, ...(state.sweepManifestCursor ? { cursor: state.sweepManifestCursor } : {}), limit: 100 });
        const deletions: string[] = [];
        const markerPrefix = `${gcMarksPrefix(scope, state.epoch)}manifests/`;
        for (const item of page.objects) {
          const match = item.key.match(/\/manifests\/([a-f0-9]{64})\.json$/);
          if (!match) throw new Error("workspace_gc_invalid_manifest_key");
          if (!await this.env.SCRIPTS_R2!.head(`${markerPrefix}${match[1]}`)) deletions.push(item.key);
        }
        if (deletions.length) await this.env.SCRIPTS_R2!.delete(deletions);
        processed = page.objects.length;
        const nextCursor = nextR2Cursor(page, "manifest_sweep", state.sweepManifestCursor);
        if (nextCursor) state.sweepManifestCursor = nextCursor;
        else { delete state.sweepManifestCursor; state.phase = "sweep-content"; }
      } else if (state.phase === "sweep-content") {
        const prefix = contentPrefix(scope);
        const page = await this.env.SCRIPTS_R2!.list({ prefix, ...(state.contentCursor ? { cursor: state.contentCursor } : {}), limit: 100 });
        const deletions: string[] = [];
        const markerPrefix = `${gcMarksPrefix(scope, state.epoch)}content/`;
        for (const item of page.objects) {
          const hash = item.key.slice(prefix.length);
          if (!HASH.test(hash)) throw new Error("workspace_gc_invalid_content_key");
          if (!await this.env.SCRIPTS_R2!.head(`${markerPrefix}${hash}`)) deletions.push(item.key);
        }
        if (deletions.length) await this.env.SCRIPTS_R2!.delete(deletions);
        processed = page.objects.length;
        const nextCursor = nextR2Cursor(page, "content_sweep", state.contentCursor);
        if (nextCursor) state.contentCursor = nextCursor;
        else { delete state.contentCursor; state.phase = "cleanup"; }
      } else {
        const page = await this.env.SCRIPTS_R2!.list({ prefix: gcMarksRoot(scope), ...(state.marksCursor ? { cursor: state.marksCursor } : {}), limit: 1000 });
        if (page.objects.length) await this.env.SCRIPTS_R2!.delete(page.objects.map((item) => item.key));
        processed = page.objects.length;
        const nextCursor = nextR2Cursor(page, "marker_cleanup", state.marksCursor);
        if (nextCursor) state.marksCursor = nextCursor;
        else { delete state.marksCursor; state.cleanupDone = true; }
      }
    } catch (error) {
      if (createdMarks.length) await this.env.SCRIPTS_R2!.delete(createdMarks);
      await this.ctx.storage.transaction(async (tx) => {
        const current = await tx.get<ContentGcState>("content_gc");
        if (current?.claimId === state.claimId) await tx.delete("content_gc");
      });
      const message = error instanceof Error ? error.message : "workspace_gc_failed";
      return fail(message.startsWith("workspace_gc_") ? message : "workspace_gc_failed", 503);
    }
    const saved = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<ContentGcState>("content_gc");
      if (await tx.get<boolean>("erased")) return "workspace_erased";
      if (!current || current.claimId !== state.claimId) return "workspace_gc_claim_lost";
      if (state.pendingLegacyManifestHash) {
        await tx.put(`legacy-manifest:${state.pendingLegacyManifestHash}`, { manifestHash: state.pendingLegacyManifestHash });
        delete state.pendingLegacyManifestHash;
      }
      if (state.legacyBackfillDone) await tx.put("content_gc_backfill_complete", true);
      if (state.phase === "cleanup" && state.cleanupDone) {
        await tx.delete("content_gc");
        await tx.put("content_gc_last_completed_at", Date.now());
        return "complete";
      }
      state.claimUntil = 0;
      state.lockUntil = Date.now() + CONTENT_GC_LOCK_MS;
      await tx.put("content_gc", state);
      return "running";
    });
    if (saved === "workspace_erased") {
      if (createdMarks.length) await this.env.SCRIPTS_R2!.delete(createdMarks);
      return fail("workspace_erased", 410);
    }
    if (saved === "workspace_gc_claim_lost") return fail(saved, 409);
    if (saved === "running") await this.scheduleAlarmAt(Date.now() + 1_000);
    return json({ phase: saved === "complete" ? "complete" : state.phase, processed, hasMore: saved !== "complete" });
  }

  private async contentGcLocked(): Promise<boolean> {
    const state = await this.ctx.storage.get<ContentGcState>("content_gc");
    if (!state) return false;
    if (state.lockUntil > Date.now()) return true;
    return this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<ContentGcState>("content_gc");
      if (!current) return false;
      if (current.epoch === state.epoch && current.lockUntil <= Date.now()) {
        await tx.delete("content_gc");
        return false;
      }
      return current.lockUntil > Date.now();
    });
  }

  private async callLiveRuntimeControl(path: string, scope: WorkspaceScope, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (!this.env.LIVE_RUNTIME_CONTROL && !this.env.LIVE_RUNTIME_CONTROL_DO) return null;
    let response: Response;
    try {
      const request = new Request(`https://live-runtime-control${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": scope.tenantId,
          "x-naelao-internal-token": await mintInternalToken(this.env.PLATFORM_SECRET, scope.tenantId),
        },
        body: JSON.stringify({ ...body, scope }),
      });
      const control = this.env.LIVE_RUNTIME_CONTROL ?? this.env.LIVE_RUNTIME_CONTROL_DO?.get(
        this.env.LIVE_RUNTIME_CONTROL_DO.idFromName(await sha256Hex(new TextEncoder().encode(keyScope(scope)))),
      );
      if (!control) return null;
      response = await control.fetch(request);
    } catch {
      return null;
    }
    if (!response.ok) return null;
    try {
      // The direct service binding is a trusted control-plane route, but its output still crosses
      // a Worker boundary and must not be buffered without a hard ceiling. Keep it aligned with
      // LiveRuntimeControlDO's bounded adapter response limit.
      const value: unknown = await readBoundedResponseJson<unknown>(response, MAX_LIVE_RUNTIME_CONTROL_RESPONSE_BYTES);
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private hasLiveRuntimeAdapter(): boolean {
    return Boolean(this.env.LIVE_RUNTIME_CONTROL || (this.env.LIVE_RUNTIME_CONTROL_DO && this.env.LIVE_RUNTIME_AGENT));
  }

  private async requestLiveCheckpoint(body: Record<string, unknown>): Promise<Response> {
    if (!this.hasLiveRuntimeAdapter()) return fail("runtime_adapter_unavailable", 503);
    if (typeof body.sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(body.sessionId) ||
        !Number.isSafeInteger(body.allocationGeneration) || !Number.isSafeInteger(body.fence)) return fail("invalid_live_checkpoint_request");
    const session = await this.ctx.storage.get<Session>(sessionKey(body.sessionId));
    if (!session || session.status !== "active" || session.mode !== "live_single_writer") return fail("workspace_session_not_found", 404);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
    if (session.fence !== body.fence) return fail("stale_fence", 409);
    if (!await this.hasCurrentSessionAuthority(session)) return fail("writer_lease_expired", 409);
    const now = Date.now();
    const result = await this.ctx.storage.transaction(async (tx) => {
      const key = `live-checkpoint:${session.branch}`;
      const current = await tx.get<LiveCheckpointJob>(key);
      if (current && (current.sessionId !== session.id || current.fence !== session.fence || current.allocationGeneration !== session.allocationGeneration)) return { error: "live_checkpoint_recovery_required" };
      if (current?.failure) return { error: "live_checkpoint_recovery_required" };
      const job: LiveCheckpointJob = current
        ? { ...current, requestCount: current.requestCount + 1, ...((current.processing || current.stageId || current.rerun) ? { rerun: true } : {}) }
        : { sessionId: session.id, branch: session.branch, runtimeId: session.runtimeId, allocationGeneration: session.allocationGeneration,
            fence: session.fence, requestedAt: now, dueAt: now + 2_000, requestCount: 1, idempotencyKey: `live-${crypto.randomUUID()}` };
      await tx.put(key, job);
      return { job };
    });
    if ("error" in result) return fail(result.error, 409);
    await this.scheduleAlarmAt(result.job.dueAt);
    return json({ scheduled: true, branch: session.branch, dueAt: result.job.dueAt,
      coalescedRequests: result.job.requestCount, targetLatencyMs: 2_000 });
  }

  private async liveCheckpointStatus(url: URL): Promise<Response> {
    const branch = url.searchParams.get("branch");
    if (!validateWorkspaceBranch(branch)) return fail("invalid_live_checkpoint_branch");
    const head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!head) return fail("workspace_not_found", 404);
    const job = await this.ctx.storage.get<LiveCheckpointJob>(`live-checkpoint:${branch}`);
    return json({ branch, job: job ? { sessionId: job.sessionId, runtimeId: job.runtimeId, allocationGeneration: job.allocationGeneration,
      fence: job.fence, requestedAt: job.requestedAt, dueAt: job.dueAt, requestCount: job.requestCount,
      processing: job.processing === true, staged: Boolean(job.stageId), failure: job.failure ?? null } : null,
      freshness: { observedRevision: head.revision, source: "authoritative_workspace_head" } });
  }

  private async updateLiveCheckpointJob(key: string, patch: Partial<LiveCheckpointJob>, clear: Array<"stageId" | "failure"> = []): Promise<LiveCheckpointJob | null> {
    return this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<LiveCheckpointJob>(key);
      if (!current) return null;
      const next: LiveCheckpointJob = { ...current, ...patch, requestCount: Math.max(current.requestCount, patch.requestCount ?? 0),
        ...(current.rerun && patch.rerun === undefined ? { rerun: true } : {}) };
      for (const field of clear) delete (next as Partial<LiveCheckpointJob>)[field];
      await tx.put(key, next);
      return next;
    });
  }

  private async processLiveCheckpoint(): Promise<void> {
    const jobs = await this.ctx.storage.list<LiveCheckpointJob>({ prefix: "live-checkpoint:", limit: LIVE_CHECKPOINT_BATCH_SIZE });
    // Keep draining a large branch roster promptly. The coordinator has one durable alarm, so
    // schedule the next page before any provider call can time out or the isolate can exit.
    if (jobs.size >= LIVE_CHECKPOINT_BATCH_SIZE) await this.scheduleAlarmAt(Date.now() + 1_000);
    for (const [key, storedJob] of jobs) {
      let job = storedJob;
      if (job.dueAt > Date.now()) {
        await this.scheduleAlarmAt(job.dueAt);
        continue;
      }
      const session = await this.ctx.storage.get<Session>(sessionKey(job.sessionId));
      if (!session || session.status !== "active" || session.mode !== "live_single_writer" || session.runtimeId !== job.runtimeId ||
          session.allocationGeneration !== job.allocationGeneration || session.fence !== job.fence || !await this.hasCurrentSessionAuthority(session)) {
        await this.ctx.storage.delete(key);
        continue;
      }
      const scope = await this.ctx.storage.get<WorkspaceScope>("scope");
      if (!scope || !this.hasLiveRuntimeAdapter()) {
        await this.ctx.storage.put(key, { ...job, failure: scope ? "runtime_adapter_unavailable" : "workspace_scope_missing", dueAt: Date.now() + 60_000 });
        await this.scheduleAlarmAt(Date.now() + 60_000);
        continue;
      }
      job = await this.updateLiveCheckpointJob(key, { processing: true }) ?? job;
      const startedAt = Date.now();
      let checkpointResult: Record<string, unknown> | undefined;
      if (job.stageId && job.idempotencyKey && Number.isSafeInteger(job.baseRevision)) {
        const response = await this.checkpoint({ sessionId: job.sessionId, runtimeId: job.runtimeId, allocationGeneration: job.allocationGeneration,
          fence: job.fence, baseRevision: job.baseRevision, idempotencyKey: job.idempotencyKey, stageId: job.stageId });
        checkpointResult = await response.json<Record<string, unknown>>().catch(() => undefined);
        if (!response.ok || !checkpointResult?.publication) {
          const transient = response.status >= 500;
          const failedJob = { ...job, processing: false, failure: String(checkpointResult?.error_code ?? `checkpoint_http_${response.status}`), dueAt: transient ? Date.now() + 2_000 : job.dueAt };
          await this.updateLiveCheckpointJob(key, failedJob);
          if (transient) await this.scheduleAlarmAt(failedJob.dueAt);
          continue;
        }
      } else {
        const nonce = crypto.randomUUID();
        const synchronized = await this.callLiveRuntimeControl("/internal/v1/checkpoint/sync", scope, {
          nonce, requestId: job.idempotencyKey, sessionId: job.sessionId, runtimeId: job.runtimeId,
          allocationGeneration: job.allocationGeneration, fence: job.fence, branch: job.branch, afterCursor: job.syncCursor ?? null,
        });
        if (synchronized?.synced !== true || synchronized.nonce !== nonce || synchronized.requestId !== job.idempotencyKey ||
            synchronized.sessionId !== job.sessionId || synchronized.runtimeId !== job.runtimeId ||
            synchronized.allocationGeneration !== job.allocationGeneration || synchronized.fence !== job.fence ||
            !Array.isArray(synchronized.changes) || typeof synchronized.cursor !== "string") {
          await this.updateLiveCheckpointJob(key, { failure: "runtime_sync_unverified", processing: false, dueAt: Date.now() + 2_000 });
          await this.scheduleAlarmAt(Date.now() + 2_000);
          continue;
        }
        const head = await this.ctx.storage.get<WorkspaceHead>(headKey(job.branch));
        if (!head) {
          await this.updateLiveCheckpointJob(key, { failure: "workspace_not_found", processing: false, dueAt: Date.now() + 2_000 });
          await this.scheduleAlarmAt(Date.now() + 2_000);
          continue;
        }
        const stageId = `live-stage-${crypto.randomUUID()}`;
        const baseRevision = head.revision;
        const hasChanges = synchronized.changes.length > 0;
        const durablePatch: Partial<LiveCheckpointJob> = { baseRevision, syncCursor: synchronized.cursor, dueAt: Date.now(), idempotencyKey: job.idempotencyKey! };
        if (hasChanges) durablePatch.stageId = stageId;
        const durableJob = await this.updateLiveCheckpointJob(key, durablePatch, [...(hasChanges ? [] : ["stageId" as const]), "failure"]) ?? job;
        if (hasChanges) {
          const staged = await this.stage({ sessionId: job.sessionId, runtimeId: job.runtimeId, allocationGeneration: job.allocationGeneration,
            fence: job.fence, stageId, changes: synchronized.changes });
          const stageBody: Record<string, unknown> = await staged.json<Record<string, unknown>>().catch(() => ({}));
          if (!staged.ok || stageBody.status !== "staged") {
            const transient = staged.status >= 500;
            const failedJob = { ...durableJob, processing: false, failure: String(stageBody.error_code ?? `stage_http_${staged.status}`), dueAt: transient ? Date.now() + 2_000 : durableJob.dueAt };
            await this.updateLiveCheckpointJob(key, failedJob);
            if (transient) await this.scheduleAlarmAt(failedJob.dueAt);
            continue;
          }
          const stagedJob = await this.updateLiveCheckpointJob(key, { dueAt: Date.now(), processing: true }) ?? durableJob;
          const published = await this.checkpoint({ sessionId: job.sessionId, runtimeId: job.runtimeId, allocationGeneration: job.allocationGeneration,
            fence: job.fence, baseRevision, idempotencyKey: job.idempotencyKey, stageId: stagedJob.stageId ?? stageId });
          checkpointResult = await published.json<Record<string, unknown>>().catch(() => undefined);
          if (!published.ok || !checkpointResult?.publication) {
            const transient = published.status >= 500;
            const failedJob = { ...durableJob, processing: false, failure: String(checkpointResult?.error_code ?? `checkpoint_http_${published.status}`), dueAt: transient ? Date.now() + 2_000 : durableJob.dueAt };
            await this.updateLiveCheckpointJob(key, failedJob);
            if (transient) await this.scheduleAlarmAt(failedJob.dueAt);
            continue;
          }
        } else {
          checkpointResult = { publication: { status: "noop", revision: head.revision } };
        }
      }
      const completion = await this.ctx.storage.transaction(async (tx) => {
        const latest = await tx.get<LiveCheckpointJob>(key);
        if (!latest?.rerun) { await tx.delete(key); return { nextJob: null, requestCount: latest?.requestCount ?? job.requestCount }; }
        const next: LiveCheckpointJob = { sessionId: job.sessionId, branch: job.branch, runtimeId: job.runtimeId,
          allocationGeneration: job.allocationGeneration, fence: job.fence, requestedAt: Date.now(), dueAt: Date.now() + 2_000,
          requestCount: 1, ...(latest.syncCursor ? { syncCursor: latest.syncCursor } : {}), idempotencyKey: `live-${crypto.randomUUID()}` };
        await tx.put(key, next);
        return { nextJob: next, requestCount: latest.requestCount };
      });
      if (completion.nextJob) {
        await this.scheduleAlarmAt(Date.now() + 2_000);
      }
      const head = await this.ctx.storage.get<WorkspaceHead>(headKey(job.branch));
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      this.writeOpsMetric("checkpoint_lag_ms", Date.now() - job.requestedAt, Date.now() - job.requestedAt > 2_000 ? "warning" : "all");
      await this.callLiveRuntimeControl("/internal/v1/checkpoint/ack", scope, {
        requestId: job.idempotencyKey, sessionId: job.sessionId, runtimeId: job.runtimeId,
        allocationGeneration: job.allocationGeneration, fence: job.fence, revision: head?.revision ?? null,
        elapsedMs, scheduledLatencyMs: Math.max(0, startedAt - job.requestedAt), checkpointLatencyMs: Math.max(0, Date.now() - job.requestedAt),
        latencyTargetMs: 2_000, withinLatencyTarget: Date.now() - job.requestedAt <= 2_000,
        coalescedRequests: completion.requestCount,
        publication: checkpointResult?.publication ?? null,
      });
    }
  }

  private async handoff(body: Record<string, unknown>): Promise<Response> {
    if (typeof body.sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(body.sessionId) || typeof body.targetRuntimeId !== "string" || !ID.test(body.targetRuntimeId) || !Number.isSafeInteger(body.allocationGeneration) || !Number.isSafeInteger(body.targetAllocationGeneration) || !Number.isSafeInteger(body.checkpointRevision)) return fail("invalid_handoff");
    const session = await this.ctx.storage.get<Session>(sessionKey(body.sessionId));
    if (!session || session.status !== "active" || session.mode !== "live_single_writer") return fail("workspace_session_not_found", 404);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
    if (!await this.hasCurrentSessionAuthority(session)) return fail("writer_lease_expired", 409);
    const scope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (!scope) return fail("workspace_scope_missing", 503);
    const targetCapability = await this.verifyLiveCapability(scope, session.actorId, String(body.targetRuntimeId), Number(body.targetAllocationGeneration), body.targetCapabilityEvidence);
    if (this.env.LIVE_WORKSPACE_ENABLED !== "true" || !targetCapability.binding) {
      return json({ error_code: "capability_unavailable", mode: "live_single_writer", requiredRuntimeCapabilities: [
        "live_mount", "fuse", "incremental_sync", "real_flush", "authenticated_transport", "reconnect_generation_check", "authorization", "residency", "billing", "budget", "runtime_accounting",
      ], missing: targetCapability.missing, candidateSearch: this.env.LIVE_CAPABILITY_VERIFIER ? "authority_verifier_required" : "verifier_not_configured" }, 409);
    }
    const targetRuntimeId = targetCapability.binding.runtimeId;
    const targetAllocationGeneration = targetCapability.binding.allocationGeneration;
    const stagedRecords = await this.ctx.storage.list<StageRecord>({ prefix: `stage:${session.id}:`, limit: 500 });
    if (stagedRecords.size >= 500 || [...stagedRecords.values()].some((stage) => stage.status !== "consumed")) {
      return fail("handoff_staging_unpublished", 409);
    }
    if (!this.hasLiveRuntimeAdapter()) return json({ error_code: "runtime_control_unavailable", missing: ["runtime_adapter"], required: ["write_quiescence", "in_flight_drain", "filesystem_flush", "target_activation"] }, 503);
    const handoffNonce = crypto.randomUUID();
    const flushResult = await this.callLiveRuntimeControl("/internal/v1/handoff/prepare", scope, {
      nonce: handoffNonce, scope, branch: session.branch, sessionId: session.id, runtimeId: session.runtimeId,
      allocationGeneration: session.allocationGeneration, fence: session.fence, targetRuntimeId,
      targetAllocationGeneration,
    });
    const flushReceipt = flushResult?.receipt as LiveHandoffReceipt | undefined;
    if (flushResult?.prepared !== true || !flushReceipt || flushReceipt.nonce !== handoffNonce ||
        flushReceipt.sessionId !== session.id || flushReceipt.runtimeId !== session.runtimeId ||
        flushReceipt.fence !== session.fence || flushReceipt.allocationGeneration !== session.allocationGeneration ||
        !Number.isSafeInteger(flushReceipt.revision) || typeof flushReceipt.id !== "string" || !ID.test(flushReceipt.id) ||
        flushReceipt.writeAdmissionStopped !== true || flushReceipt.inFlightDrained !== true || flushReceipt.filesystemFlushed !== true ||
        typeof flushReceipt.flushMethod !== "string" || !flushReceipt.flushMethod ||
        typeof flushReceipt.flushCompletedAt !== "number" || !Number.isFinite(flushReceipt.flushCompletedAt) ||
        flushReceipt.flushCompletedAt > Date.now() + 30_000 || Date.now() - flushReceipt.flushCompletedAt > 30_000) {
      await this.callLiveRuntimeControl("/internal/v1/handoff/abort", scope, {
        nonce: handoffNonce, sessionId: session.id, runtimeId: session.runtimeId,
        allocationGeneration: session.allocationGeneration, fence: session.fence,
      });
      return json({ error_code: "handoff_flush_unverified", recoverable: true }, 409);
    }
    const result = await this.ctx.storage.transaction(async (tx) => {
      const lease = await tx.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${session.branch}`);
      if (!lease || lease.sessionId !== session.id || lease.fence !== session.fence || lease.expiresAt <= Date.now()) return { error: "stale_fence" };
      const head = await tx.get<WorkspaceHead>(headKey(session.branch));
      if (!head) return { error: "workspace_not_found" };
      if (head.revision !== body.checkpointRevision || head.revision !== flushReceipt.revision) return { error: "handoff_checkpoint_required" };
      if (targetAllocationGeneration <= session.allocationGeneration) return { error: "allocation_generation_must_advance" };
      session.status = "closed";
      await tx.put(sessionKey(session.id), session);
      const fence = (await tx.get<number>(`fence:${session.branch}`) ?? lease.fence) + 1;
      await tx.put(`fence:${session.branch}`, fence);
      const newSession: Session = { ...session, id: `ws_${crypto.randomUUID()}`, runtimeId: targetRuntimeId, baseRevision: head.revision,
        baseManifestHash: head.manifestHash, allocationGeneration: targetAllocationGeneration, fence,
        ...(targetCapability.binding ? { capabilityBinding: targetCapability.binding } : {}), status: "active", createdAt: new Date().toISOString() };
      await tx.put(sessionKey(newSession.id), newSession);
      await tx.put(`writer:${session.branch}`, { sessionId: newSession.id, fence, expiresAt: Date.now() + 60_000 });
      return { session: newSession, head };
    });
    if ("error" in result) {
      await this.callLiveRuntimeControl("/internal/v1/handoff/abort", scope, {
        nonce: handoffNonce, sessionId: session.id, runtimeId: session.runtimeId,
        allocationGeneration: session.allocationGeneration, fence: session.fence,
      });
      return fail(result.error, 409);
    }
    const activationNonce = crypto.randomUUID();
    const activated = await this.callLiveRuntimeControl("/internal/v1/handoff/activate", scope, {
      nonce: activationNonce, sessionId: result.session.id, runtimeId: result.session.runtimeId,
      allocationGeneration: result.session.allocationGeneration, fence: result.session.fence,
      revision: result.head.revision, manifestHash: result.head.manifestHash, capabilityBinding: result.session.capabilityBinding,
    });
    if (activated?.activated !== true || activated.nonce !== activationNonce || activated.sessionId !== result.session.id ||
        activated.runtimeId !== result.session.runtimeId || activated.allocationGeneration !== result.session.allocationGeneration ||
        activated.fence !== result.session.fence || activated.revision !== result.head.revision) {
      await this.ctx.storage.transaction(async (tx) => {
        const current = await tx.get<Session>(sessionKey(result.session.id));
        const lease = await tx.get<{ sessionId: string; fence: number }>(`writer:${session.branch}`);
        if (!current || current.status !== "active" || current.fence !== result.session.fence || lease?.sessionId !== current.id || lease.fence !== current.fence) return;
        current.status = "revoked";
        await tx.put(sessionKey(current.id), current);
        await tx.put(`fence:${session.branch}`, current.fence + 1);
        await tx.delete(`writer:${session.branch}`);
      });
      return json({ error_code: "handoff_target_activation_failed", recoverable: true, committedRevision: result.head.revision }, 503);
    }
    return json({ session: result.session, head: result.head });
  }

  private async close(body: Record<string, unknown>): Promise<Response> {
    if (typeof body.sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(body.sessionId)) return fail("invalid_session");
    const session = await this.ctx.storage.get<Session>(sessionKey(body.sessionId));
    if (!session) return fail("workspace_session_not_found", 404);
    if (typeof body.runtimeId === "string" && session.runtimeId !== body.runtimeId) return fail("workspace_session_scope_mismatch", 403);
    const result = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<Session>(sessionKey(session.id));
      if (!current || current.status === "closed") return "closed";
      current.status = "closed";
      await tx.put(sessionKey(current.id), current);
      if (current.mode === "live_single_writer") {
        const lease = await tx.get<{ sessionId: string; fence: number }>(`writer:${current.branch}`);
        if (lease?.sessionId === current.id && lease.fence === current.fence) await tx.delete(`writer:${current.branch}`);
      }
      return "closed";
    });
    return json({ sessionId: session.id, status: result });
  }

  private async sessions(url: URL): Promise<Response> {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const after = url.searchParams.get("after");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (after !== null && !/^session:ws_[0-9a-f-]{36}$/.test(after))) return fail("invalid_session_cursor");
    const page = await this.ctx.storage.list<Session>({ prefix: "session:", ...(after ? { startAfter: after } : {}), limit: limit + 1 });
    const selected = [...page.entries()].slice(0, limit);
    const sessions = selected.map(([, session]) => ({
      id: session.id, status: session.status, branch: session.branch, mode: session.mode,
      allocationGeneration: session.allocationGeneration, fence: session.fence, createdAt: session.createdAt,
    }));
    const hasMore = page.size > limit;
    return json({ sessions, hasMore, ...(hasMore && selected.length ? { nextCursor: selected[selected.length - 1]![0] } : {}) });
  }

  private async revoke(body: Record<string, unknown>): Promise<Response> {
    if (typeof body.sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(body.sessionId) ||
        !Number.isSafeInteger(body.allocationGeneration) || !Number.isSafeInteger(body.fence)) return fail("invalid_session");
    const session = await this.ctx.storage.get<Session>(sessionKey(body.sessionId));
    if (!session) return fail("workspace_session_not_found", 404);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
    if (session.fence !== body.fence) return fail("stale_fence", 409);
    const revoked = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<Session>(sessionKey(session.id));
      if (!current || current.status !== "active" || current.fence !== body.fence || current.allocationGeneration !== body.allocationGeneration) return false;
      current.status = "revoked";
      await tx.put(sessionKey(current.id), current);
      if (current.mode === "live_single_writer") {
        const lease = await tx.get<{ sessionId: string; fence: number }>(`writer:${current.branch}`);
        if (lease?.sessionId === current.id && lease.fence === current.fence) {
          await tx.put(`fence:${current.branch}`, Math.max(await tx.get<number>(`fence:${current.branch}`) ?? 0, current.fence) + 1);
          await tx.delete(`writer:${current.branch}`);
        }
      }
      return true;
    });
    return revoked ? json({ sessionId: session.id, status: "revoked" }) : fail("stale_fence", 409);
  }

  private async verifyEntries(scope: WorkspaceScope, entries: WorkspaceEntry[]): Promise<Response | null> {
    if (entries.length > MAX_ENTRIES) return fail("workspace_entry_limit_exceeded", 413);
    const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
    if (totalBytes > MAX_WORKSPACE_BYTES) return fail("workspace_limit_exceeded", 413);
    for (const entry of entries) {
      if (entry.size > MAX_FILE_BYTES) return fail("workspace_file_limit_exceeded", 413);
      if (!entry.objectKey.startsWith(contentPrefix(scope))) return fail("workspace_object_scope_mismatch", 403);
      const object = await this.env.SCRIPTS_R2!.get(entry.objectKey);
      if (!object || object.size !== entry.size) return fail("workspace_content_unavailable", 409);
      const hash = await sha256Hex(new Uint8Array(await object.arrayBuffer()));
      if (hash !== entry.sha256) return fail("workspace_content_integrity_failed", 409);
    }
    return null;
  }
}
