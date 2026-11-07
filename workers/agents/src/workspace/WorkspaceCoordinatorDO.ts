import { DurableObject } from "cloudflare:workers";
import { readBoundedRequestText, verifyInternalToken } from "@naelao/http";
import {
  canonicalManifest,
  sha256Hex,
  validateWorkspaceBranch,
  validateWorkspaceEntry,
  validateWorkspacePath,
  validateWorkspaceScope,
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
}
interface Change { path: string; expectedHash: string | null; contentBase64: string | null; executable?: boolean; }
interface StagedChange { path: string; expectedHash: string | null; sha256: string | null; size: number; executable?: boolean; objectKey?: string; }
interface StageRecord { sessionId: string; stageId: string; changeSetHash: string; changes: StagedChange[]; createdAt: string; status?: "active" | "consumed"; consumedAt?: string; }
interface RevisionEvent { branch: string; revision: number; publicationId: string | null; changedPaths: string[]; updatedAt: string; }
interface Session {
  id: string;
  actorId: string;
  runtimeId: string;
  branch: string;
  parentBranch: string | null;
  baseRevision: number;
  baseManifestHash: string;
  mode: WorkspaceConsistencyMode;
  allocationGeneration: number;
  fence: number;
  status: "active" | "closed";
  createdAt: string;
}
const MAX_BODY = 8 * 1024 * 1024;
const MAX_CHANGES = 100;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 768 * 1024;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const STAGING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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
function manifestKey(scope: WorkspaceScope, hash: string): string {
  return `workspace-v1/${keyScope(scope)}/manifests/${hash}.json`;
}
function contentPrefix(scope: WorkspaceScope): string {
  return `workspace-v1/${keyScope(scope)}/content/`;
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
function subscriptionKey(branch: string, subscriberId: string): string { return `subscription:${branch}:${subscriberId}`; }
function entrySignature(entry: WorkspaceEntry | undefined): string | null {
  return entry ? JSON.stringify([entry.sha256, entry.size, entry.executable]) : null;
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

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
    if (!tenantId || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, this.env.PLATFORM_SECRET)) return fail("forbidden", 403);
    if (!this.env.SCRIPTS_R2) return fail("workspace_storage_unavailable", 503);
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJson(request) : null;
    if (request.method === "POST" && !body) return fail("invalid_request", 413);
    if (request.method !== "POST" && await this.ctx.storage.get<boolean>("erased")) return fail("workspace_erased", 410);
    if (request.method === "POST" && url.pathname !== "/v1/erase" && await this.ctx.storage.get<boolean>("erased")) return fail("workspace_erased", 410);
    if (request.method === "POST" && url.pathname === "/v1/erase") return this.erase(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/initialize") return this.initialize(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/open") return this.open(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/renew") return this.renew(body!);
    if (request.method === "POST" && url.pathname === "/v1/branch") return this.createBranch(body!, tenantId);
    if (request.method === "POST" && url.pathname === "/v1/merge") return this.merge(body!);
    if (request.method === "GET" && url.pathname === "/v1/head") return this.head(url);
    if (request.method === "GET" && url.pathname === "/v1/read") return this.read(url);
    if (request.method === "GET" && url.pathname === "/v1/changes") return this.changes(url);
    if (request.method === "POST" && url.pathname === "/v1/subscriptions/ack") return this.acknowledge(body!);
    if (request.method === "POST" && url.pathname === "/v1/checkpoint") return this.checkpoint(body!);
    if (request.method === "POST" && url.pathname === "/v1/stage") return this.stage(body!);
    if (request.method === "POST" && url.pathname === "/v1/gc/staging") return this.collectStaging(body!);
    if (request.method === "POST" && url.pathname === "/v1/handoff") return this.handoff(body!);
    if (request.method === "POST" && url.pathname === "/v1/close") return this.close(body!);
    return fail("not_found", 404);
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

  private async initialize(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    const validated = await this.validateScope(body.scope, body.branch, tenantId);
    if (validated instanceof Response) return validated;
    const { scope, branch } = validated;
    if (!Array.isArray(body.entries) || body.entries.length > MAX_ENTRIES || !body.entries.every(validateWorkspaceEntry)) return fail("invalid_manifest");
    if (new Set(body.entries.map((entry) => (entry as WorkspaceEntry).path)).size !== body.entries.length) return fail("duplicate_workspace_path");
    const entries = body.entries as WorkspaceEntry[];
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total > MAX_WORKSPACE_BYTES) return fail("workspace_limit_exceeded", 413);
    const verified = await this.verifyEntries(scope, entries);
    if (verified) return verified;
    const encoded = canonicalManifest(entries);
    const manifestHash = await sha256Hex(new TextEncoder().encode(encoded));
    const put = await this.env.SCRIPTS_R2!.put(manifestKey(scope, manifestHash), encoded, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: manifestHash } });
    const createdManifestKey = put ? manifestKey(scope, manifestHash) : null;
    if (!put) {
      const existing = await this.env.SCRIPTS_R2!.get(manifestKey(scope, manifestHash));
      if (!existing || await sha256Hex(new Uint8Array(await existing.arrayBuffer())) !== manifestHash) return fail("manifest_persist_failed", 503);
    }
    const head: WorkspaceHead = { version: 1, scope, branch, revision: 1, manifestHash, parentRevision: null, publicationId: null, updatedAt: new Date().toISOString() };
    const result = await this.ctx.storage.transaction(async (tx) => {
      const known = await tx.get<WorkspaceScope>("scope");
      if (await tx.get<boolean>("erased")) return "erased";
      if (known && JSON.stringify(known) !== JSON.stringify(scope)) return "scope_conflict";
      const current = await tx.get<WorkspaceHead>(headKey(branch));
      if (current) return current.manifestHash === manifestHash ? "exists" : "head_exists";
      await tx.put("scope", scope);
      await tx.put(headKey(branch), head);
      await tx.put(revisionEventKey(branch, 1), { branch, revision: 1, publicationId: null, changedPaths: [], updatedAt: head.updatedAt } satisfies RevisionEvent);
      return "created";
    });
    if (result === "scope_conflict") return fail("workspace_scope_mismatch", 403);
    if (result === "erased" || result === "head_exists") {
      if (createdManifestKey) await this.env.SCRIPTS_R2!.delete(createdManifestKey);
      return result === "erased" ? fail("workspace_erased", 410) : fail("workspace_head_exists", 409);
    }
    return json({ head: result === "created" ? head : await this.ctx.storage.get<WorkspaceHead>(headKey(branch)), created: result === "created" });
  }

  private async open(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    const validated = await this.validateScope(body.scope, body.branch, tenantId);
    if (validated instanceof Response) return validated;
    if (typeof body.actorId !== "string" || !ID.test(body.actorId) || typeof body.runtimeId !== "string" || !ID.test(body.runtimeId) ||
        !Number.isSafeInteger(body.allocationGeneration) || Number(body.allocationGeneration) < 1 ||
        (body.mode !== undefined && body.mode !== "checked_handoff" && body.mode !== "live_single_writer")) return fail("invalid_workspace_session");
    const { branch } = validated;
    const mode = (body.mode ?? "checked_handoff") as WorkspaceConsistencyMode;
    if (mode === "live_single_writer") {
      const evidence = body.capabilityEvidence as Record<string, unknown> | undefined;
      if (this.env.LIVE_WORKSPACE_ENABLED !== "true" || !evidence || evidence.liveMountReady !== true || evidence.authenticatedTransport !== true ||
          typeof evidence.allocationId !== "string" || !ID.test(evidence.allocationId) || evidence.allocationGeneration !== body.allocationGeneration ||
          typeof evidence.templateDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(evidence.templateDigest) ||
          typeof evidence.verifiedAt !== "number" || !Number.isFinite(evidence.verifiedAt) || Date.now() - evidence.verifiedAt > 5 * 60_000 || evidence.verifiedAt > Date.now() + 30_000) {
        return fail("capability_unavailable", 409);
      }
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
    const session: Session = { id, actorId: body.actorId, runtimeId: body.runtimeId, branch, parentBranch, baseRevision, baseManifestHash, mode, allocationGeneration: Number(body.allocationGeneration), fence: 0, status: "active", createdAt: new Date().toISOString() };
    const result = await this.ctx.storage.transaction(async (tx) => {
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
    if ("error" in result) return fail(result.error, result.error === "writer_lease_held" ? 409 : 409);
    return json({ session: result.session, head: current });
  }

  private async renew(body: Record<string, unknown>): Promise<Response> {
    if (typeof body.sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(body.sessionId) || !Number.isSafeInteger(body.allocationGeneration) || !Number.isSafeInteger(body.fence)) return fail("invalid_session");
    const session = await this.ctx.storage.get<Session>(sessionKey(body.sessionId));
    if (!session || session.status !== "active" || session.mode !== "live_single_writer") return fail("workspace_session_not_found", 404);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
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

  private async createBranch(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    const validated = await this.validateScope(body.scope, body.sourceBranch, tenantId);
    if (validated instanceof Response) return validated;
    if (!validateWorkspaceBranch(body.branch)) return fail("invalid_branch");
    const source = await this.ctx.storage.get<WorkspaceHead>(headKey(validated.branch));
    if (!source) return fail("workspace_not_found", 404);
    const branch = body.branch;
    const created: WorkspaceHead = { ...source, branch, updatedAt: new Date().toISOString() };
    const result = await this.ctx.storage.transaction(async (tx) => {
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
      await tx.put(revisionEventKey(branch, created.revision), { branch, revision: created.revision, publicationId: created.publicationId, changedPaths: [], updatedAt: created.updatedAt } satisfies RevisionEvent);
      return "created";
    });
    if (result === "branch_exists") return fail("branch_exists", 409);
    if (result === "erased") return fail("workspace_erased", 410);
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
    let status: WorkspacePublicationReceipt["status"] = conflicts.length ? "conflicted" : "published";
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
        const put = await this.env.SCRIPTS_R2!.put(manifestKey(targetHead.scope, nextHash), encoded, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: nextHash } });
        if (!put) {
          const found = await this.env.SCRIPTS_R2!.get(manifestKey(targetHead.scope, nextHash));
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
      if (replay) return replay.changeSetHash === changeSetHash ? { receipt: replay } : { error: "idempotency_conflict" };
      const activeSession = await tx.get<Session>(sessionKey(sessionId));
      if (await tx.get<boolean>("erased")) return { error: "workspace_erased" };
      const parent = await tx.get<WorkspaceHead>(headKey(targetBranch));
      const branch = await tx.get<WorkspaceHead>(headKey(session.branch));
      if (!activeSession || activeSession.status !== "active" || activeSession.allocationGeneration !== body.allocationGeneration || activeSession.fence !== body.fence) return { error: "stale_fence" };
      if (!parent || parent.revision !== targetHead.revision || parent.manifestHash !== targetHead.manifestHash || !branch || branch.revision !== workingHead.revision || branch.manifestHash !== workingHead.manifestHash) return { error: "workspace_head_raced" };
      await tx.put(mergeReceiptKey(targetBranch, idempotencyKey), receipt);
      if (status === "published") {
        await tx.put(headKey(targetBranch), nextHead);
        await tx.put(revisionEventKey(targetBranch, revision), { branch: targetBranch, revision, publicationId: id, changedPaths, updatedAt: nextHead.updatedAt } satisfies RevisionEvent);
      }
      if (status === "published" || status === "noop") {
        activeSession.status = "closed";
        await tx.put(sessionKey(sessionId), activeSession);
      }
      return { receipt };
    });
    if ("error" in committed) return fail(committed.error, 409);
    return json({ publication: committed.receipt }, status === "conflicted" ? 409 : 200);
  }

  private async head(url: URL): Promise<Response> {
    const branch = url.searchParams.get("branch");
    if (!validateWorkspaceBranch(branch)) return fail("invalid_branch");
    const value = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    return value ? json({ head: value }) : fail("workspace_not_found", 404);
  }

  private async read(url: URL): Promise<Response> {
    const branch = url.searchParams.get("branch");
    if (!validateWorkspaceBranch(branch)) return fail("invalid_branch");
    const head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!head) return fail("workspace_not_found", 404);
    const object = await this.env.SCRIPTS_R2!.get(manifestKey(head.scope, head.manifestHash));
    if (!object) return fail("workspace_manifest_unavailable", 503);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (await sha256Hex(bytes) !== head.manifestHash) return fail("workspace_manifest_corrupt", 503);
    const entries = JSON.parse(new TextDecoder().decode(bytes)) as WorkspaceEntry[];
    const paths = url.searchParams.getAll("path");
    return json({ head, entries: paths.length ? entries.filter((entry) => paths.includes(entry.path)) : entries });
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
      if (!event) return json({ head, revisions, resetRequired: true, cursor: revisions.at(-1)?.revision ?? afterRevision });
      revisions.push(event);
    }
    return json({ head, revisions, resetRequired: false, cursor: revisions.at(-1)?.revision ?? afterRevision, hasMore: through < head.revision });
  }

  private async acknowledge(body: Record<string, unknown>): Promise<Response> {
    if (!validateWorkspaceBranch(body.branch) || typeof body.subscriberId !== "string" || !ID.test(body.subscriberId) || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) return fail("invalid_subscription_cursor");
    const branch = body.branch;
    const head = await this.ctx.storage.get<WorkspaceHead>(headKey(branch));
    if (!head) return fail("workspace_not_found", 404);
    const revision = Number(body.revision);
    if (revision > head.revision) return fail("change_cursor_ahead", 409);
    const next = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<{ revision: number; updatedAt: string }>(subscriptionKey(branch, String(body.subscriberId)));
      if (current && current.revision > revision) return current;
      const value = { revision: Math.max(current?.revision ?? 0, revision), updatedAt: new Date().toISOString() };
      await tx.put(subscriptionKey(branch, String(body.subscriberId)), value);
      return value;
    });
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
    if (session.status !== "active") return fail("stale_fence", 409);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
    if (session.fence !== body.fence) return fail("stale_fence", 409);
    let changes: Change[];
    if (body.stageId !== undefined) {
      const staged = await this.ctx.storage.get<StageRecord>(stageKey(sessionId, String(body.stageId)));
      if (!staged) return fail("workspace_stage_not_found", 409);
      const stageScope = await this.ctx.storage.get<WorkspaceScope>("scope");
      if (!stageScope) return fail("workspace_scope_missing", 503);
      changes = [];
      for (const item of staged.changes) {
        if (item.sha256 === null) changes.push({ path: item.path, expectedHash: item.expectedHash, contentBase64: null, ...(item.executable === undefined ? {} : { executable: item.executable }) });
        else {
          if (!item.objectKey?.startsWith(stagingPrefix(stageScope))) return fail("workspace_stage_scope_mismatch", 403);
          const object = await this.env.SCRIPTS_R2!.get(item.objectKey);
          if (!object || object.size !== item.size) return fail("workspace_stage_unavailable", 503);
          const bytes = new Uint8Array(await object.arrayBuffer());
          if (await sha256Hex(bytes) !== item.sha256) return fail("workspace_stage_corrupt", 503);
          changes.push({ path: item.path, expectedHash: item.expectedHash, contentBase64: base64(bytes), ...(item.executable === undefined ? {} : { executable: item.executable }) });
        }
      }
    } else changes = body.changes as Change[];
    const paths = new Set<string>();
    for (const change of changes) {
      if (!change || !validateWorkspacePath(change.path) || paths.has(change.path) || !(change.expectedHash === null || (typeof change.expectedHash === "string" && HASH.test(change.expectedHash))) ||
          !(change.contentBase64 === null || typeof change.contentBase64 === "string") || (change.executable !== undefined && typeof change.executable !== "boolean")) return fail("invalid_checkpoint");
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
          const uploaded = await this.env.SCRIPTS_R2!.put(objectKey, bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: hash, size: String(bytes.byteLength) } });
          if (uploaded) newlyStoredContentKeys.push(objectKey);
          if (!uploaded) {
            const found = await this.env.SCRIPTS_R2!.get(objectKey);
            if (!found || await sha256Hex(new Uint8Array(await found.arrayBuffer())) !== hash) return fail("workspace_content_persist_failed", 503);
          }
          if (old) totalBytes -= old.size;
          totalBytes += bytes.byteLength;
          next.set(change.path, { path: change.path, sha256: hash, size: bytes.byteLength, executable: change.executable ?? old?.executable ?? false, objectKey });
        }
        appliedPaths.push(change.path);
      }
      if (next.size > MAX_ENTRIES) return fail("workspace_entry_limit_exceeded", 413);
      if (totalBytes > MAX_WORKSPACE_BYTES) return fail("workspace_limit_exceeded", 413);
      const encoded = canonicalManifest([...next.values()]);
      nextHash = await sha256Hex(new TextEncoder().encode(encoded));
      if (nextHash !== current.manifestHash) {
        const put = await this.env.SCRIPTS_R2!.put(manifestKey(current.scope, nextHash), encoded, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: nextHash } });
        if (put) newlyStoredManifestKey = manifestKey(current.scope, nextHash);
        if (!put) {
          const found = await this.env.SCRIPTS_R2!.get(manifestKey(current.scope, nextHash));
          if (!found || await sha256Hex(new Uint8Array(await found.arrayBuffer())) !== nextHash) return fail("manifest_persist_failed", 503);
        }
      } else status = "noop";
    }
    const revision = status === "published" ? current.revision + 1 : current.revision;
    const receipt: WorkspacePublicationReceipt = { id: publicationId, idempotencyKey, status, branch: session.branch, baseRevision: current.revision, revision, appliedPaths: status === "conflicted" ? [] : appliedPaths, conflicts, changeSetHash, fence: session.fence, allocationGeneration: session.allocationGeneration };
    const newHead: WorkspaceHead = { ...current, revision, manifestHash: nextHash, parentRevision: current.revision, publicationId, updatedAt: new Date().toISOString() };
    const committed = await this.ctx.storage.transaction(async (tx) => {
      const replay = await tx.get<WorkspacePublicationReceipt>(receiptKey(session.branch, idempotencyKey));
      if (replay) return replay.changeSetHash === changeSetHash ? { receipt: replay } : { error: "idempotency_conflict" };
      const head = await tx.get<WorkspaceHead>(headKey(session.branch));
      if (await tx.get<boolean>("erased")) return { error: "workspace_erased" };
      if (!head || head.revision !== current.revision || head.manifestHash !== current.manifestHash) return { error: "head_raced" };
      const activeSession = await tx.get<Session>(sessionKey(sessionId));
      if (!activeSession || activeSession.status !== "active" || activeSession.allocationGeneration !== body.allocationGeneration || activeSession.fence !== body.fence) return { error: "stale_fence" };
      if (activeSession.mode === "live_single_writer") {
        const lease = await tx.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${session.branch}`);
        if (!lease || lease.sessionId !== sessionId || lease.fence !== activeSession.fence || lease.expiresAt <= Date.now()) return { error: "writer_lease_expired" };
      }
      await tx.put(receiptKey(session.branch, idempotencyKey), receipt);
      if (status === "published") {
        await tx.put(headKey(session.branch), newHead);
        await tx.put(revisionEventKey(session.branch, revision), { branch: session.branch, revision, publicationId, changedPaths: appliedPaths, updatedAt: newHead.updatedAt } satisfies RevisionEvent);
      }
      if (body.stageId !== undefined && (status === "published" || status === "noop")) {
        const stageId = String(body.stageId);
        const staged = await tx.get<StageRecord>(stageKey(sessionId, stageId));
        if (staged) await tx.put(stageKey(sessionId, stageId), { ...staged, status: "consumed", consumedAt: new Date().toISOString() } satisfies StageRecord);
      }
      return { receipt };
    });
    if ("error" in committed) {
      if (committed.error === "workspace_erased") {
        if (newlyStoredManifestKey) await this.env.SCRIPTS_R2!.delete(newlyStoredManifestKey);
        if (newlyStoredContentKeys.length) await this.env.SCRIPTS_R2!.delete(newlyStoredContentKeys);
        return fail("workspace_erased", 410);
      }
      return fail(committed.error, 409);
    }
    return json({ publication: committed.receipt }, status === "conflicted" ? 409 : 200);
  }

  private async stage(body: Record<string, unknown>): Promise<Response> {
    const { sessionId, stageId } = body;
    if (typeof sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(sessionId) || typeof stageId !== "string" || !ID.test(stageId) ||
        !Number.isSafeInteger(body.allocationGeneration) || !Number.isSafeInteger(body.fence) || !Array.isArray(body.changes) || body.changes.length > MAX_CHANGES) return fail("invalid_stage");
    const session = await this.ctx.storage.get<Session>(sessionKey(sessionId));
    if (!session || session.status !== "active") return fail("workspace_session_not_found", 404);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
    if (session.fence !== body.fence) return fail("stale_fence", 409);
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
          !(change.contentBase64 === null || typeof change.contentBase64 === "string") || (change.executable !== undefined && typeof change.executable !== "boolean")) return fail("invalid_stage");
      paths.add(change.path);
      if (change.contentBase64 === null) {
        stagedChanges.push({ path: change.path, expectedHash: change.expectedHash, sha256: null, size: 0, ...(change.executable === undefined ? {} : { executable: change.executable }) });
        continue;
      }
      let bytes: Uint8Array;
      try { bytes = unbase64(change.contentBase64); } catch { return fail("invalid_file_content"); }
      if (bytes.byteLength > MAX_FILE_BYTES) return fail("workspace_file_limit_exceeded", 413);
      if ((totalBytes += bytes.byteLength) > MAX_WORKSPACE_BYTES) return fail("workspace_limit_exceeded", 413);
      const hash = await sha256Hex(bytes);
      const pathHash = await sha256Hex(new TextEncoder().encode(change.path));
      const objectKey = `${stagingPrefix(branchHead.scope)}${sessionId}/${stageId}/${pathHash}`;
      const put = await this.env.SCRIPTS_R2!.put(objectKey, bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: hash, size: String(bytes.byteLength) } });
      if (put) newlyStoredStageKeys.push(objectKey);
      if (!put) {
        const existing = await this.env.SCRIPTS_R2!.get(objectKey);
        if (!existing || existing.size !== bytes.byteLength || await sha256Hex(new Uint8Array(await existing.arrayBuffer())) !== hash) return fail("workspace_stage_content_conflict", 409);
      }
      stagedChanges.push({ path: change.path, expectedHash: change.expectedHash, sha256: hash, size: bytes.byteLength, ...(change.executable === undefined ? {} : { executable: change.executable }), objectKey });
    }
    const changeSetHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(changes)));
    const prior = await this.ctx.storage.get<StageRecord>(stageKey(sessionId, stageId));
    if (prior) return prior.changeSetHash === changeSetHash ? json({ stageId, status: "staged", changeSetHash }) : fail("idempotency_conflict", 409);
    const result = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<Session>(sessionKey(sessionId));
      if (await tx.get<boolean>("erased")) return "workspace_erased";
      if (!current || current.status !== "active" || current.allocationGeneration !== body.allocationGeneration || current.fence !== body.fence) return "stale_fence";
      const existing = await tx.get<StageRecord>(stageKey(sessionId, stageId));
      if (existing) return existing.changeSetHash === changeSetHash ? "staged" : "idempotency_conflict";
      await tx.put(stageKey(sessionId, stageId), { sessionId, stageId, changeSetHash, changes: stagedChanges, createdAt: new Date().toISOString() } satisfies StageRecord);
      return "staged";
    });
    if (result !== "staged" && newlyStoredStageKeys.length) await this.env.SCRIPTS_R2!.delete(newlyStoredStageKeys);
    return result === "staged" ? json({ stageId, status: "staged", changeSetHash }) : fail(result, result === "workspace_erased" ? 410 : 409);
  }

  private async erase(body: Record<string, unknown>, tenantId: string): Promise<Response> {
    if (body.confirm !== true || !validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId) return fail("invalid_erasure_scope", 403);
    const requestedScope = body.scope;
    const existingScope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (existingScope && JSON.stringify(existingScope) !== JSON.stringify(requestedScope)) return fail("workspace_scope_mismatch", 403);
    await this.ctx.storage.transaction(async (tx) => { await tx.put("erased", true); });
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
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("erased", true);
    return json({ erased: true, scope: requestedScope, objectsDeleted: deleted });
  }

  private async collectStaging(body: Record<string, unknown>): Promise<Response> {
    const scope = await this.ctx.storage.get<WorkspaceScope>("scope");
    if (!scope) return fail("workspace_scope_missing", 503);
    const requestedCutoff = typeof body.before === "number" ? body.before : Date.now() - STAGING_RETENTION_MS;
    if (!Number.isFinite(requestedCutoff) || requestedCutoff > Date.now() - STAGING_RETENTION_MS) return fail("staging_retention_too_short");
    const cursor = typeof body.cursor === "string" && body.cursor.length <= 1024 ? body.cursor : undefined;
    const prefix = stagingPrefix(scope);
    const page = await this.env.SCRIPTS_R2!.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
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
    const stageRecords = await this.ctx.storage.list<StageRecord>({ prefix: "stage:", limit: 1000 });
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
    return json({ scanned: page.objects.length, deleted: deleteKeys.length, recordsDeleted, cursor: page.truncated ? page.cursor ?? null : null, hasMore: page.truncated });
  }

  private async handoff(body: Record<string, unknown>): Promise<Response> {
    if (typeof body.sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(body.sessionId) || typeof body.targetRuntimeId !== "string" || !ID.test(body.targetRuntimeId) || !Number.isSafeInteger(body.allocationGeneration) || !Number.isSafeInteger(body.targetAllocationGeneration) || !Number.isSafeInteger(body.checkpointRevision)) return fail("invalid_handoff");
    const session = await this.ctx.storage.get<Session>(sessionKey(body.sessionId));
    if (!session || session.status !== "active" || session.mode !== "live_single_writer") return fail("workspace_session_not_found", 404);
    if (session.allocationGeneration !== body.allocationGeneration) return fail("allocation_generation_mismatch", 409);
    const result = await this.ctx.storage.transaction(async (tx) => {
      const lease = await tx.get<{ sessionId: string; fence: number; expiresAt: number }>(`writer:${session.branch}`);
      if (!lease || lease.sessionId !== session.id || lease.fence !== session.fence || lease.expiresAt <= Date.now()) return { error: "stale_fence" };
      const head = await tx.get<WorkspaceHead>(headKey(session.branch));
      if (!head) return { error: "workspace_not_found" };
      if (head.revision !== body.checkpointRevision) return { error: "handoff_checkpoint_required" };
      if (Number(body.targetAllocationGeneration) <= session.allocationGeneration) return { error: "allocation_generation_must_advance" };
      session.status = "closed";
      await tx.put(sessionKey(session.id), session);
      const fence = (await tx.get<number>(`fence:${session.branch}`) ?? lease.fence) + 1;
      await tx.put(`fence:${session.branch}`, fence);
      const newSession: Session = { ...session, id: `ws_${crypto.randomUUID()}`, runtimeId: body.targetRuntimeId as string, baseRevision: head.revision, allocationGeneration: Number(body.targetAllocationGeneration), fence, status: "active", createdAt: new Date().toISOString() };
      await tx.put(sessionKey(newSession.id), newSession);
      await tx.put(`writer:${session.branch}`, { sessionId: newSession.id, fence, expiresAt: Date.now() + 60_000 });
      return { session: newSession, head };
    });
    return "error" in result ? fail(result.error, 409) : json({ session: result.session, head: result.head });
  }

  private async close(body: Record<string, unknown>): Promise<Response> {
    if (typeof body.sessionId !== "string" || !/^ws_[0-9a-f-]{36}$/.test(body.sessionId)) return fail("invalid_session");
    const session = await this.ctx.storage.get<Session>(sessionKey(body.sessionId));
    if (!session) return fail("workspace_session_not_found", 404);
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
