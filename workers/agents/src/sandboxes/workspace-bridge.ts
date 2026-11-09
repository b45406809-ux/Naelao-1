import { readBoundedRequestText, verifyInternalToken } from "@naelao/http";
import { readBytesWithHash } from "../script-engine/r2-cas.js";
import { workspaceCoordinatorRequest, type WorkspaceCoordinatorBindings } from "../workspace/workspace-client.js";
import type { WorkspaceEntry, WorkspaceHead, WorkspaceScope } from "../workspace/workspace-contract.js";
import type { Env as AgentsEnv } from "../env.js";
import type { WorkspaceCoordinatorDO } from "../workspace/WorkspaceCoordinatorDO.js";

// Stay below the Workers per-invocation R2 subrequest budget (head/get + staged put per file).
const MAX_FILES = 200;
const MAX_PUBLICATION_CHANGES = 100;
// ConcurrencyDO accepts at most 1 MiB of base64 payload per CAS mutation.
const MAX_FILE_BYTES = 768 * 1024;
const MAX_STAGE_REQUEST_BYTES = 6 * 1024 * 1024;
const MAX_CONTROL_REQUEST_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;

type BridgeEnv = Pick<AgentsEnv, "PLATFORM_DB" | "PLATFORM_SECRET" | "UNIFIED_WORKSPACE_ENABLED" | "DATA_JURISDICTION" | "SCRIPTS_R2"> & {
  WORKSPACE_COORDINATOR?: DurableObjectNamespace<WorkspaceCoordinatorDO> | undefined;
  CONCURRENCY_DO?: DurableObjectNamespace;
};
const coordinatorRequest = (env: BridgeEnv, scope: WorkspaceScope, path: string, options: { method?: "GET" | "POST"; body?: unknown }) =>
  workspaceCoordinatorRequest(env as unknown as WorkspaceCoordinatorBindings, scope, path, options);
interface FilesystemRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  space_id: string | null;
  project_id: string | null;
  branch: string;
  mode: string;
  consistency: string;
  status: string;
}
interface Change { path: string; expectedHash: string | null; blobId: string | null; executable?: boolean; }

const response = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store" },
});
const fail = (error_code: string, status: number) => response({ error_code }, status);
async function parseJson<T>(request: Request | Response, fallback: T, maxBytes = MAX_CONTROL_REQUEST_BYTES): Promise<T> {
  try {
    const text = request instanceof Request ? await readBoundedRequestText(request, maxBytes) : await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) return fallback;
    return JSON.parse(text) as T;
  } catch { return fallback; }
}
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes));
const portablePath = (path: unknown): path is string => typeof path === "string" && path.length > 0 && path.length <= 1024 &&
  !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
  path.split("/").every((part) => part && part !== "." && part !== ".." && new TextEncoder().encode(part).length <= 255) &&
  !path.split("/").some((part) => [".avos", ".naelao", ".git", "node_modules", ".cache", ".turbo", ".next", ".vite", "coverage", "tmp", ".tmp"].includes(part) || part === ".env" || (part.startsWith(".env.") && part !== ".env.example"));
const b64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
const unb64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

function workspacePrefix(row: FilesystemRow): string {
  if (!row.space_id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.space_id)) throw new Error("filesystem_scope_invalid");
  if (row.project_id && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.project_id)) throw new Error("filesystem_scope_invalid");
  if (row.branch !== "main" && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(row.branch) || row.branch.includes(".."))) throw new Error("filesystem_scope_invalid");
  const base = row.project_id ? `spaces/${row.space_id}/projects/${row.project_id}/workspace/` : `spaces/${row.space_id}/workspace/`;
  return `${base}branches/${row.branch}/`;
}

async function authorize(request: Request, env: BridgeEnv): Promise<{ tenantId: string; userId: string } | Response> {
  const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
  const userId = request.headers.get("x-naelao-user-id") ?? "";
  if (!tenantId || !userId || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, env.PLATFORM_SECRET)) return fail("forbidden", 403);
  return { tenantId, userId };
}

async function filesystem(env: BridgeEnv, filesystemId: unknown, tenantId: string, ownerId: string): Promise<FilesystemRow | null> {
  if (typeof filesystemId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(filesystemId)) return null;
  return env.PLATFORM_DB.prepare("SELECT id,tenant_id,owner_id,space_id,project_id,branch,mode,consistency,status FROM sandbox_filesystems WHERE id=? AND tenant_id=? AND owner_id=? AND status='active' AND mode='snapshot_diff'")
    .bind(filesystemId, tenantId, ownerId).first<FilesystemRow>();
}

async function snapshot(request: Request, env: BridgeEnv, actor: { tenantId: string; userId: string }): Promise<Response> {
  if (!env.SCRIPTS_R2) return fail("workspace_storage_unavailable", 503);
  const input = await parseJson(request, {} as { filesystemId?: unknown; computerId?: unknown });
  const fs = await filesystem(env, input.filesystemId, actor.tenantId, actor.userId);
  if (!fs) return fail("filesystem_not_found", 404);
  const unified = env.UNIFIED_WORKSPACE_ENABLED === "true" && !!fs.project_id;
  if (typeof input.computerId !== "string") return fail("computer_id_required", 400);
  const computer = await env.PLATFORM_DB.prepare("SELECT id FROM sandbox_computers WHERE id=? AND tenant_id=? AND owner_id=? AND filesystem_id=? AND deleted_at IS NULL")
    .bind(input.computerId, actor.tenantId, actor.userId, fs.id).first();
  if (!computer) return fail("computer_not_found", 404);
  const prefix = workspacePrefix(fs);
  const snapshotId = `sws_${crypto.randomUUID()}`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SNAPSHOT_TTL_MS).toISOString();
  const entries: Array<{ path: string; sha256: string; size: number; executable: boolean; blobId: string }> = [];
  let coordinatorRevision: number | null = null;
  const staged: string[] = [];
  let totalBytes = 0;
  try {
    if (unified && fs.project_id && fs.space_id) {
      const scope: WorkspaceScope = { tenantId: actor.tenantId, spaceId: fs.space_id, projectId: fs.project_id, jurisdiction: env.DATA_JURISDICTION === "eu" ? "eu" : "global" };
      const manifestResponse = await coordinatorRequest(env, scope, `/v1/read?branch=${encodeURIComponent(fs.branch)}`, {});
      if (!manifestResponse.ok) return new Response(manifestResponse.body, { status: manifestResponse.status, headers: { "content-type": "application/json" } });
      const manifest = await manifestResponse.json() as { head?: WorkspaceHead; entries?: WorkspaceEntry[] };
      if (!manifest.head || !Number.isSafeInteger(manifest.head.revision) || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_FILES) return fail("workspace_manifest_invalid", 503);
      coordinatorRevision = manifest.head.revision;
      const mismatches: Array<{ pathHash: string; manifestHash: string; legacyHash: string | null; mismatchClass: string }> = [];
      const manifestPaths = new Set(manifest.entries.map((entry) => entry.path));
      for (const item of manifest.entries) {
        if (!portablePath(item.path)) continue;
        if (entries.length >= MAX_FILES || item.size > MAX_FILE_BYTES || totalBytes + item.size > MAX_SNAPSHOT_BYTES) throw new Error("workspace_snapshot_limit");
        const canonical = await readBytesWithHash(env.SCRIPTS_R2, item.objectKey, MAX_FILE_BYTES);
        if (!canonical || canonical.hash !== item.sha256 || canonical.bytes.byteLength !== item.size) throw new Error("workspace_manifest_content_invalid");
        const legacy = await readBytesWithHash(env.SCRIPTS_R2, workspacePrefix(fs) + item.path, MAX_FILE_BYTES).catch(() => null);
        if ((legacy?.hash ?? null) !== item.sha256 || (legacy?.bytes.byteLength ?? null) !== item.size) {
          mismatches.push({ pathHash: await sha256(new TextEncoder().encode(item.path)), manifestHash: item.sha256, legacyHash: legacy?.hash ?? null, mismatchClass: legacy ? "hash_or_size_mismatch" : "legacy_missing" });
        }
        const blobId = `swb_${crypto.randomUUID()}`;
        const key = `sandbox-workspace-bridge/${actor.tenantId}/${fs.id}/${blobId}`;
        await env.SCRIPTS_R2.put(key, canonical.bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: canonical.hash, filesystemId: fs.id, executable: String(item.executable) } });
        staged.push(key);
        totalBytes += canonical.bytes.byteLength;
        entries.push({ path: item.path, sha256: canonical.hash, size: canonical.bytes.byteLength, executable: item.executable, blobId });
      }
      const legacyPage = await env.SCRIPTS_R2.list({ prefix: workspacePrefix(fs), limit: MAX_FILES + 1, include: ["customMetadata"] } as R2ListOptions & { include: string[] });
      if (legacyPage.objects.length > MAX_FILES || legacyPage.truncated) {
        if (staged.length) await env.SCRIPTS_R2.delete(staged).catch(() => undefined);
        return fail("workspace_dual_read_bound_exceeded", 413);
      }
      for (const object of legacyPage.objects) {
        if (object.customMetadata?.deleted === "true") continue;
        const legacyPath = object.key.slice(workspacePrefix(fs).length);
        if (!portablePath(legacyPath) || manifestPaths.has(legacyPath)) continue;
        const legacy = await readBytesWithHash(env.SCRIPTS_R2, object.key, MAX_FILE_BYTES).catch(() => null);
        mismatches.push({ pathHash: await sha256(new TextEncoder().encode(legacyPath)), manifestHash: "", legacyHash: legacy?.hash ?? null, mismatchClass: "manifest_missing" });
        if (mismatches.length >= 20) break;
      }
      if (mismatches.length) {
        console.warn("workspace_dual_read", { client: "sandbox-workspace-bridge", tenantId: actor.tenantId, spaceId: fs.space_id, projectId: fs.project_id, branch: fs.branch, revision: coordinatorRevision, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 20) });
        if (staged.length) await env.SCRIPTS_R2.delete(staged).catch(() => undefined);
        return fail("workspace_dual_read_drift", 409);
      }
    } else {
      let cursor: string | undefined;
      do {
      const page = await env.SCRIPTS_R2.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000, include: ["customMetadata"] } as R2ListOptions & { include: string[] });
      for (const object of page.objects) {
        if (object.customMetadata?.deleted === "true") continue;
        const path = object.key.slice(prefix.length);
        if (!portablePath(path)) continue;
        if (entries.length >= MAX_FILES || object.size > MAX_FILE_BYTES || totalBytes + object.size > MAX_SNAPSHOT_BYTES) throw new Error("workspace_snapshot_limit");
        const source = await readBytesWithHash(env.SCRIPTS_R2, object.key, MAX_FILE_BYTES);
        if (!source) continue;
        const blobId = `swb_${crypto.randomUUID()}`;
        const key = `sandbox-workspace-bridge/${actor.tenantId}/${fs.id}/${blobId}`;
        const executable = source.metadata.executable === "true";
        await env.SCRIPTS_R2.put(key, source.bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: source.hash, filesystemId: fs.id, executable: String(executable) } });
        staged.push(key);
        totalBytes += source.bytes.byteLength;
        entries.push({ path, sha256: source.hash, size: source.bytes.byteLength, executable, blobId });
      }
      cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    await env.PLATFORM_DB.prepare("INSERT INTO sandbox_workspace_snapshots (id,tenant_id,filesystem_id,computer_id,branch,status,created_at,expires_at,coordinator_revision) VALUES (?,?,?,?,?,'active',?,?,?)")
      .bind(snapshotId, actor.tenantId, fs.id, input.computerId, fs.branch, createdAt, expiresAt, coordinatorRevision).run();
    for (let offset = 0; offset < entries.length; offset += 50) {
      const statements: D1PreparedStatement[] = [];
      for (const entry of entries.slice(offset, offset + 50)) {
        const key = `sandbox-workspace-bridge/${actor.tenantId}/${fs.id}/${entry.blobId}`;
        statements.push(
          env.PLATFORM_DB.prepare("INSERT INTO sandbox_workspace_blobs (id,tenant_id,filesystem_id,snapshot_id,object_key,sha256,size_bytes,executable,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(entry.blobId, actor.tenantId, fs.id, snapshotId, key, entry.sha256, entry.size, entry.executable ? 1 : 0, createdAt, expiresAt),
          env.PLATFORM_DB.prepare("INSERT INTO sandbox_workspace_snapshot_entries (snapshot_id,path,blob_id,sha256,size_bytes,executable) VALUES (?,?,?,?,?,?)").bind(snapshotId, entry.path, entry.blobId, entry.sha256, entry.size, entry.executable ? 1 : 0),
        );
      }
      await env.PLATFORM_DB.batch(statements);
    }
  } catch (error) {
    if (staged.length) await env.SCRIPTS_R2.delete(staged).catch(() => undefined);
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("DELETE FROM sandbox_workspace_snapshot_entries WHERE snapshot_id=?").bind(snapshotId),
      env.PLATFORM_DB.prepare("DELETE FROM sandbox_workspace_blobs WHERE snapshot_id=?").bind(snapshotId),
      env.PLATFORM_DB.prepare("DELETE FROM sandbox_workspace_snapshots WHERE id=?").bind(snapshotId),
    ]).catch(() => undefined);
    if (error instanceof Error && error.message === "workspace_snapshot_limit") return fail("workspace_snapshot_limit", 413);
    return fail(error instanceof Error && error.message === "filesystem_scope_invalid" ? "filesystem_scope_invalid" : "workspace_snapshot_failed", 503);
  }
  return response({ snapshot: { id: snapshotId, filesystemId: fs.id, branch: fs.branch, consistency: fs.consistency, ...(coordinatorRevision === null ? {} : { revision: coordinatorRevision }), entries, expiresAt } });
}

async function blob(request: Request, env: BridgeEnv, actor: { tenantId: string; userId: string }, blobId: string): Promise<Response> {
  if (!env.SCRIPTS_R2 || !/^swb_[0-9a-f-]{36}$/.test(blobId)) return fail("blob_not_found", 404);
  const row = await env.PLATFORM_DB.prepare("SELECT b.object_key,b.sha256,b.size_bytes,f.project_id FROM sandbox_workspace_blobs b JOIN sandbox_filesystems f ON f.id=b.filesystem_id WHERE b.id=? AND b.tenant_id=? AND f.owner_id=? AND f.status='active' AND b.expires_at>? ")
    .bind(blobId, actor.tenantId, actor.userId, new Date().toISOString()).first<{ object_key: string; sha256: string; size_bytes: number; project_id: string | null }>();
  if (!row) return fail("blob_not_found", 404);
  // These blobs are immutable, short-lived transfer data, never canonical workspace files.
  if (request.method === "GET") {
    const object = await readBytesWithHash(env.SCRIPTS_R2, row.object_key, MAX_FILE_BYTES);
    if (!object || object.bytes.byteLength !== row.size_bytes || object.hash !== row.sha256) return fail("blob_unavailable", 404);
    return new Response(object.bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(row.size_bytes), "x-content-sha256": row.sha256, "cache-control": "no-store" } });
  }
  return fail("method_not_allowed", 405);
}

async function stage(request: Request, env: BridgeEnv, actor: { tenantId: string; userId: string }): Promise<Response> {
  if (!env.SCRIPTS_R2) return fail("workspace_storage_unavailable", 503);
  const input = await parseJson(request, {} as { filesystemId?: unknown; snapshotId?: unknown; sha256?: unknown; contentBase64?: unknown; executable?: unknown }, MAX_STAGE_REQUEST_BYTES);
  const fs = await filesystem(env, input.filesystemId, actor.tenantId, actor.userId);
  if (!fs) return fail("filesystem_not_found", 404);
  // Staging remains outside the canonical workspace namespace.
  if (typeof input.snapshotId !== "string" || typeof input.sha256 !== "string" || !HASH.test(input.sha256) || typeof input.contentBase64 !== "string" || (input.executable !== undefined && typeof input.executable !== "boolean")) return fail("invalid_blob", 400);
  const snap = await env.PLATFORM_DB.prepare("SELECT id FROM sandbox_workspace_snapshots WHERE id=? AND filesystem_id=? AND tenant_id=? AND status IN ('active','published') AND expires_at>?")
    .bind(input.snapshotId, fs.id, actor.tenantId, new Date().toISOString()).first();
  if (!snap) return fail("snapshot_not_found", 404);
  let bytes: Uint8Array;
  try { bytes = unb64(input.contentBase64); } catch { return fail("invalid_blob", 400); }
  if (bytes.byteLength > MAX_FILE_BYTES || await sha256(bytes) !== input.sha256) return fail("blob_integrity_failed", 400);
  const usage = await env.PLATFORM_DB.prepare("SELECT COUNT(*) AS blobs,SUM(size_bytes) AS bytes FROM sandbox_workspace_blobs WHERE snapshot_id=?").bind(input.snapshotId)
    .first<{ blobs: number; bytes: number | null }>();
  if ((usage?.blobs ?? 0) >= MAX_FILES * 2 || (usage?.bytes ?? 0) + bytes.byteLength > MAX_SNAPSHOT_BYTES) return fail("workspace_snapshot_limit", 413);
  const blobId = `swb_${crypto.randomUUID()}`;
  const now = new Date(); const createdAt = now.toISOString(); const expiresAt = new Date(now.getTime() + SNAPSHOT_TTL_MS).toISOString();
  const objectKey = `sandbox-workspace-bridge/${actor.tenantId}/${fs.id}/${blobId}`;
  const executable = input.executable === true;
  await env.SCRIPTS_R2.put(objectKey, bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha256: input.sha256, filesystemId: fs.id, executable: String(executable) } });
  try {
    await env.PLATFORM_DB.prepare("INSERT INTO sandbox_workspace_blobs (id,tenant_id,filesystem_id,snapshot_id,object_key,sha256,size_bytes,executable,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(blobId, actor.tenantId, fs.id, input.snapshotId, objectKey, input.sha256, bytes.byteLength, executable ? 1 : 0, createdAt, expiresAt).run();
  } catch {
    await env.SCRIPTS_R2.delete(objectKey).catch(() => undefined);
    return fail("workspace_blob_persistence_failed", 503);
  }
  return response({ blobId, sha256: input.sha256, size: bytes.byteLength });
}

async function publish(request: Request, env: BridgeEnv, actor: { tenantId: string; userId: string }): Promise<Response> {
  if (!env.SCRIPTS_R2 || (!env.CONCURRENCY_DO && !(env.UNIFIED_WORKSPACE_ENABLED === "true" && env.WORKSPACE_COORDINATOR))) return fail("workspace_publication_unavailable", 503);
  const input = await parseJson(request, {} as { filesystemId?: unknown; computerId?: unknown; snapshotId?: unknown; idempotencyKey?: unknown; changes?: unknown });
  const fs = await filesystem(env, input.filesystemId, actor.tenantId, actor.userId);
  if (!fs) return fail("filesystem_not_found", 404);
  const unified = env.UNIFIED_WORKSPACE_ENABLED === "true" && !!fs.project_id;
  if (typeof input.computerId !== "string" || typeof input.snapshotId !== "string" || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200 || !Array.isArray(input.changes) || input.changes.length > MAX_PUBLICATION_CHANGES) return fail("invalid_publication", 400);
  const changes = input.changes as Change[];
  const seen = new Set<string>();
  for (const change of changes) if (!change || !portablePath(change.path) || seen.has(change.path) || (change.executable !== undefined && typeof change.executable !== "boolean") || !(change.expectedHash === null || (typeof change.expectedHash === "string" && HASH.test(change.expectedHash))) || !(change.blobId === null || (typeof change.blobId === "string" && /^swb_[0-9a-f-]{36}$/.test(change.blobId)))) return fail("invalid_publication", 400); else seen.add(change.path);
  const encodedChanges = JSON.stringify({ snapshotId: input.snapshotId, changes });
  const replay = await env.PLATFORM_DB.prepare("SELECT id,status,changes_json,applied_paths_json,conflicts_json FROM sandbox_publications WHERE tenant_id=? AND filesystem_id=? AND idempotency_key=?")
    .bind(actor.tenantId, fs.id, input.idempotencyKey).first<{ id: string; status: string; changes_json: string; applied_paths_json: string; conflicts_json: string }>();
  if (replay && replay.changes_json !== encodedChanges) return fail("idempotency_conflict", 409);
  if (replay && replay.status !== "pending") return response({ publication: { id: replay.id, status: replay.status, appliedPaths: JSON.parse(replay.applied_paths_json), conflicts: JSON.parse(replay.conflicts_json) } }, replay.status === "published" ? 200 : 409);
  const snapshot = await env.PLATFORM_DB.prepare(replay
    ? "SELECT id,coordinator_revision FROM sandbox_workspace_snapshots WHERE id=? AND tenant_id=? AND filesystem_id=? AND computer_id=? AND status IN ('active','published')"
    : "SELECT id,coordinator_revision FROM sandbox_workspace_snapshots WHERE id=? AND tenant_id=? AND filesystem_id=? AND computer_id=? AND status IN ('active','published') AND expires_at>?")
    .bind(...(replay ? [input.snapshotId, actor.tenantId, fs.id, input.computerId] : [input.snapshotId, actor.tenantId, fs.id, input.computerId, new Date().toISOString()])).first();
  if (!snapshot) return fail("snapshot_not_found", 404);
  const pinnedRevision = (snapshot as { coordinator_revision?: number | null }).coordinator_revision ?? null;
  if (unified && !Number.isSafeInteger(pinnedRevision)) return fail("snapshot_revision_missing", 409);
  // Validate the snapshot baseline and all staged blobs before reserving the idempotency key.
  const baseline = await env.PLATFORM_DB.prepare("SELECT path,sha256,executable FROM sandbox_workspace_snapshot_entries WHERE snapshot_id=?").bind(input.snapshotId).all<{ path: string; sha256: string; executable: number }>();
  const hashes = new Map((baseline.results ?? []).map((entry) => [entry.path, entry.sha256]));
  const modes = new Map((baseline.results ?? []).map((entry) => [entry.path, entry.executable === 1]));
  for (const change of changes) {
    if ((hashes.get(change.path) ?? null) !== change.expectedHash) return fail("snapshot_baseline_mismatch", 409);
    if (change.blobId) {
      const blob = await env.PLATFORM_DB.prepare(replay
        ? "SELECT object_key,sha256,executable FROM sandbox_workspace_blobs WHERE id=? AND tenant_id=? AND filesystem_id=? AND snapshot_id=?"
        : "SELECT object_key,sha256,executable FROM sandbox_workspace_blobs WHERE id=? AND tenant_id=? AND filesystem_id=? AND snapshot_id=? AND expires_at>?")
        .bind(...(replay ? [change.blobId, actor.tenantId, fs.id, input.snapshotId] : [change.blobId, actor.tenantId, fs.id, input.snapshotId, new Date().toISOString()])).first<{ object_key: string; sha256: string; executable: number }>();
      if (!blob) return fail("blob_not_found", 404);
    }
  }
  const id = replay?.id ?? `pub_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  if (!replay) {
    try {
      await env.PLATFORM_DB.prepare("INSERT INTO sandbox_publications (id,tenant_id,filesystem_id,computer_id,branch,status,changes_json,applied_paths_json,conflicts_json,created_at,updated_at,idempotency_key,snapshot_id) VALUES (?,?,?,?,?,'pending',?,'[]','[]',?,?,?,?)")
        .bind(id, actor.tenantId, fs.id, input.computerId, fs.branch, encodedChanges, now, now, input.idempotencyKey, input.snapshotId).run();
    } catch {
      const raced = await env.PLATFORM_DB.prepare("SELECT id,status,changes_json,applied_paths_json,conflicts_json FROM sandbox_publications WHERE tenant_id=? AND filesystem_id=? AND idempotency_key=?")
        .bind(actor.tenantId, fs.id, input.idempotencyKey).first<{ id: string; status: string; changes_json: string; applied_paths_json: string; conflicts_json: string }>();
      if (!raced) return fail("publication_journal_unavailable", 503);
      if (raced.changes_json !== encodedChanges) return fail("idempotency_conflict", 409);
      return response({ publication: { id: raced.id, status: raced.status, appliedPaths: JSON.parse(raced.applied_paths_json), conflicts: JSON.parse(raced.conflicts_json) } }, raced.status === "published" ? 200 : 409);
    }
  }
  try {
    for (const change of changes) if (change.blobId) await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO sandbox_workspace_publication_blobs (publication_id,blob_id) VALUES (?,?)").bind(id, change.blobId).run();
  } catch { return fail("publication_journal_unavailable", 503); }
  if (unified) {
    if (!fs.project_id || !fs.space_id || !env.WORKSPACE_COORDINATOR) return fail("workspace_publication_unavailable", 503);
    const scope: WorkspaceScope = { tenantId: actor.tenantId, spaceId: fs.space_id, projectId: fs.project_id, jurisdiction: env.DATA_JURISDICTION === "eu" ? "eu" : "global" };
    const coordinatorChanges: Array<{ path: string; expectedHash: string | null; contentBase64: string | null; executable?: boolean }> = [];
    let encodedBytes = 0;
    for (const change of changes) {
      if (!change.blobId) { coordinatorChanges.push({ path: change.path, expectedHash: change.expectedHash, contentBase64: null }); continue; }
      const staged = await env.PLATFORM_DB.prepare("SELECT object_key,sha256,executable FROM sandbox_workspace_blobs WHERE id=? AND tenant_id=? AND filesystem_id=? AND snapshot_id=?")
        .bind(change.blobId, actor.tenantId, fs.id, input.snapshotId).first<{ object_key: string; sha256: string; executable: number }>();
      if (!staged) return fail("blob_not_found", 404);
      const content = await readBytesWithHash(env.SCRIPTS_R2, staged.object_key, MAX_FILE_BYTES);
      if (!content || content.hash !== staged.sha256) return fail("blob_integrity_failed", 409);
      encodedBytes += Math.ceil(content.bytes.byteLength * 4 / 3);
      if (encodedBytes > MAX_STAGE_REQUEST_BYTES) return fail("workspace_publication_limit", 413);
      coordinatorChanges.push({ path: change.path, expectedHash: change.expectedHash, contentBase64: b64(content.bytes), executable: change.executable ?? modes.get(change.path) ?? staged.executable === 1 });
    }
    const opened = await coordinatorRequest(env, scope, "/v1/open", { body: { scope, branch: fs.branch, actorId: actor.userId, runtimeId: "sandbox-workspace-bridge", allocationGeneration: 1, mode: "checked_handoff" } });
    if (!opened.ok) return new Response(opened.body, { status: opened.status, headers: { "content-type": "application/json" } });
    const session = await opened.json() as { session?: { id?: string; fence?: number }; head?: WorkspaceHead };
    const sessionId = session.session?.id;
    const fence = session.session?.fence;
    try {
      if (!sessionId || !Number.isSafeInteger(fence) || session.head?.revision !== pinnedRevision) return fail("workspace_head_changed", 409);
      const committed = await coordinatorRequest(env, scope, "/v1/checkpoint", { body: { sessionId, runtimeId: "sandbox-workspace-bridge", baseRevision: pinnedRevision, allocationGeneration: 1, fence, idempotencyKey: `sandbox-${id.replace(/[^A-Za-z0-9._:-]/g, "-")}`, changes: coordinatorChanges } });
      const payload = await parseJson(committed, {} as { publication?: { status?: string; revision?: number; appliedPaths?: string[]; conflicts?: Array<{ path: string; expectedHash: string | null; actualHash: string | null }> } });
      if (!committed.ok && committed.status !== 409) return new Response(JSON.stringify(payload), { status: committed.status, headers: { "content-type": "application/json" } });
      const conflicts = payload.publication?.conflicts ?? [];
      const status = payload.publication?.status === "published" || payload.publication?.status === "noop" ? "published" : "conflicted";
      const applied = payload.publication?.appliedPaths ?? [];
      await env.PLATFORM_DB.prepare("UPDATE sandbox_publications SET status=?,applied_paths_json=?,conflicts_json=?,updated_at=? WHERE id=?")
        .bind(status, JSON.stringify(applied), JSON.stringify(conflicts), new Date().toISOString(), id).run();
      if (status === "published") await env.PLATFORM_DB.prepare("UPDATE sandbox_workspace_snapshots SET status='published' WHERE id=?").bind(input.snapshotId).run();
      return response({ publication: { id, status, appliedPaths: applied, conflicts, ...(payload.publication?.revision === undefined ? {} : { revision: payload.publication.revision }) } }, status === "published" ? 200 : 409);
    } finally {
      if (sessionId) await coordinatorRequest(env, scope, "/v1/close", { body: { sessionId, runtimeId: "sandbox-workspace-bridge" } }).catch(() => undefined);
    }
  }
  const concurrency = env.CONCURRENCY_DO;
  if (!concurrency) return fail("workspace_publication_unavailable", 503);
  const publishLegacy = async (): Promise<Response> => {
  const applied: string[] = [];
  const conflicts: Array<{ path: string; expectedHash: string | null; actualHash: string | null }> = [];
  const prefix = workspacePrefix(fs);
  for (const change of changes) {
    const path = change.path;
    const key = prefix + path;
    const lockKey = `lock:${fs.space_id}:${fs.project_id ?? "_"}:workspace-file:${key}`;
    const holderId = `sandbox-publication:${id}`;
    const stub = concurrency.get(concurrency.idFromName(lockKey));
    const acquired = await stub.fetch(new Request("http://concurrency-do/lock/acquire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: lockKey, holderId, ttlMs: 30_000 }) }));
    const lease = await parseJson(acquired, {} as { acquired?: boolean; fencingToken?: number });
    if (!acquired.ok || !lease.acquired || !lease.fencingToken) return fail("workspace_lock_unavailable", 503);
    try {
      let contentBase64: string | undefined;
      let newHash: string | null = null;
      if (change.blobId) {
        const staged = await env.PLATFORM_DB.prepare("SELECT object_key,sha256,executable FROM sandbox_workspace_blobs WHERE id=? AND tenant_id=? AND filesystem_id=? AND snapshot_id=?")
          .bind(change.blobId, actor.tenantId, fs.id, input.snapshotId).first<{ object_key: string; sha256: string; executable: number }>();
        if (!staged) return fail("blob_not_found", 404);
        const stagedObject = await readBytesWithHash(env.SCRIPTS_R2!, staged.object_key, MAX_FILE_BYTES);
        if (!stagedObject || stagedObject.hash !== staged.sha256) return fail("blob_integrity_failed", 409);
        contentBase64 = b64(stagedObject.bytes);
        newHash = stagedObject.hash;
        const executable = change.executable ?? modes.get(path) ?? staged.executable === 1;
        // Operator precedence is explicit here: the staged blob's mode is the default only
        // for a newly created file with no mode in the snapshot.
        change.executable = executable;
      }
      const current = await readBytesWithHash(env.SCRIPTS_R2!, key, MAX_FILE_BYTES);
      if ((current?.hash ?? null) === newHash) { applied.push(path); continue; }
      const result = await stub.fetch(new Request("http://concurrency-do/workspace/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: lockKey, holderId, fencingToken: lease.fencingToken, path: key, operation: change.blobId ? "write" : "delete", expectedHash: change.expectedHash, ...(contentBase64 ? { contentBase64 } : {}), metadata: { source: "sandbox-workspace-bridge", workspaceBranch: fs.branch, ...(change.blobId ? { executable: String(change.executable === true) } : {}) } }) }));
      if (result.status === 409) {
        const actual = await readBytesWithHash(env.SCRIPTS_R2!, key, MAX_FILE_BYTES);
        conflicts.push({ path, expectedHash: change.expectedHash, actualHash: actual?.hash ?? null });
        continue;
      }
      if (!result.ok) return fail("workspace_publication_recovery_required", 503);
      applied.push(path);
    } finally {
      await stub.fetch(new Request("http://concurrency-do/lock/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: lockKey, holderId, fencingToken: lease.fencingToken }) })).catch(() => undefined);
    }
  }
  const status = conflicts.length ? "conflicted" : "published";
  await env.PLATFORM_DB.prepare("UPDATE sandbox_publications SET status=?,applied_paths_json=?,conflicts_json=?,updated_at=? WHERE id=?")
    .bind(status, JSON.stringify(applied), JSON.stringify(conflicts), new Date().toISOString(), id).run();
  if (!conflicts.length) await env.PLATFORM_DB.prepare("UPDATE sandbox_workspace_snapshots SET status='published' WHERE id=?").bind(input.snapshotId).run();
  return response({ publication: { id, status, appliedPaths: applied, conflicts } }, conflicts.length ? 409 : 200);
  };
  if (!fs.project_id || !fs.space_id) return publishLegacy();
  const gateKey = `lock:${fs.space_id}:${fs.project_id}:workspace-migration-barrier`;
  const gate = concurrency.get(concurrency.idFromName(gateKey));
  const holderId = `sandbox-bridge:${id}:${crypto.randomUUID()}`.slice(0, 128);
  const acquired = await gate.fetch(new Request("http://concurrency-do/locks/acquire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: gateKey, holderId, ttlMs: 10 * 60_000 }) }));
  const lease = await parseJson(acquired, {} as { acquired?: boolean; fencingToken?: number });
  if (!acquired.ok || !lease.acquired || !lease.fencingToken) return fail("workspace_migration_barrier_busy", 423);
  try {
    const scope: WorkspaceScope = { tenantId: actor.tenantId, spaceId: fs.space_id, projectId: fs.project_id, jurisdiction: env.DATA_JURISDICTION === "eu" ? "eu" : "global" };
    const migrationStatus = await coordinatorRequest(env, scope, "/v1/migration/status", {});
    if (!migrationStatus.ok) return fail("workspace_migration_status_unavailable", 503);
    const statusBody = await migrationStatus.json() as { migration?: unknown };
    if (statusBody.migration) return fail("workspace_legacy_migration_barrier_active", 423);
    return await publishLegacy();
  } finally {
    await gate.fetch(new Request("http://concurrency-do/locks/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: gateKey, holderId, fencingToken: lease.fencingToken }) })).catch(() => undefined);
  }
}

export async function handleSandboxWorkspaceBridge(request: Request, env: BridgeEnv): Promise<Response> {
  const actor = await authorize(request, env);
  if (actor instanceof Response) return actor;
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/internal/sandbox-workspaces/snapshot") return snapshot(request, env, actor);
  if (request.method === "POST" && path === "/internal/sandbox-workspaces/blobs") return stage(request, env, actor);
  const match = path.match(/^\/internal\/sandbox-workspaces\/blobs\/(swb_[0-9a-f-]{36})$/);
  if (request.method === "GET" && match) return blob(request, env, actor, match[1] ?? "");
  if (request.method === "POST" && path === "/internal/sandbox-workspaces/publish") return publish(request, env, actor);
  return fail("not_found", 404);
}

export async function sweepExpiredWorkspaceBlobs(env: BridgeEnv): Promise<number> {
  if (!env.SCRIPTS_R2) return 0;
  const now = new Date().toISOString();
  await env.PLATFORM_DB.prepare("DELETE FROM sandbox_workspace_publication_blobs WHERE publication_id IN (SELECT id FROM sandbox_publications WHERE status!='pending')").run();
  const expired = await env.PLATFORM_DB.prepare("SELECT b.id,b.object_key FROM sandbox_workspace_blobs b WHERE b.expires_at<=? AND NOT EXISTS (SELECT 1 FROM sandbox_workspace_publication_blobs p WHERE p.blob_id=b.id) ORDER BY b.expires_at LIMIT 100").bind(now).all<{ id: string; object_key: string }>();
  if (expired.results?.length) {
    await env.SCRIPTS_R2.delete(expired.results.map((row) => row.object_key));
    for (const row of expired.results) {
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare("DELETE FROM sandbox_workspace_snapshot_entries WHERE blob_id=?").bind(row.id),
        env.PLATFORM_DB.prepare("DELETE FROM sandbox_workspace_blobs WHERE id=?").bind(row.id),
      ]);
    }
  }
  await env.PLATFORM_DB.prepare("DELETE FROM sandbox_workspace_snapshots WHERE expires_at<=? AND NOT EXISTS (SELECT 1 FROM sandbox_publications p WHERE p.snapshot_id=sandbox_workspace_snapshots.id AND p.status='pending') AND NOT EXISTS (SELECT 1 FROM sandbox_workspace_blobs b WHERE b.snapshot_id=sandbox_workspace_snapshots.id)").bind(now).run();
  return expired.results?.length ?? 0;
}
