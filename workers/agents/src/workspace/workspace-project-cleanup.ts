import { mintInternalToken, readBoundedRequestText, readBoundedResponseJson, verifyInternalToken } from "@naelao/http";
import { workspaceCoordinatorRequest, type WorkspaceCoordinatorBindings } from "./workspace-client.js";
import { validateWorkspaceScope, type WorkspaceScope } from "./workspace-contract.js";
import { advanceWorkspaceErasureCursor, beginProjectWorkspaceErasure, finalizeProjectSandboxDataErasure, restartCompletedWorkspaceErasure, workspaceErasureTombstone } from "./phase6-erasure.js";
import { exportWorkspaceErasureReceipt, type WorkspaceErasureBackupBindings } from "./erasure-backup.js";

type CleanupEnv = WorkspaceCoordinatorBindings & WorkspaceErasureBackupBindings & {
  PLATFORM_SECRET?: string;
  PLATFORM_DB?: D1Database;
  BROWSER_WORKER?: Fetcher;
  SCRIPTS_R2?: R2Bucket;
  TOOL_SANDBOX?: DurableObjectNamespace;
  DYNAMIC_SANDBOX?: DurableObjectNamespace;
  DOCUMENT_SANDBOX?: DurableObjectNamespace;
  MEDIA_SANDBOX?: DurableObjectNamespace;
};

interface RuntimeRegistryRow { runtime_kind: string; object_name: string }
interface RuntimeNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }

interface BrowserProfileScope {
  tenantId: string; spaceId: string; projectId?: string; actorId: string; agentId: string;
  runId: string; sessionId: string; expiresAt: number; authorizedOrigins: string[];
  authorizedActions: string[]; connectionId?: string; maxTier: 4 | 5 | 6;
}

async function browserProfileId(scope: BrowserProfileScope): Promise<string> {
  const owner = JSON.stringify([scope.tenantId, scope.spaceId, scope.projectId ?? "", scope.actorId, scope.connectionId]);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function browserSessionId(scope: BrowserProfileScope): Promise<string> {
  const owner = [scope.tenantId, scope.spaceId, scope.projectId ?? "", scope.actorId, scope.agentId, scope.runId, scope.sessionId];
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(owner))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Revoke only browser profiles whose exact hashed owner and D1 scope match this project. */
async function notifyWorkspaceBrowserProfiles(env: CleanupEnv, scope: WorkspaceScope): Promise<{ notified: number; pending: number }> {
  const db = env.PLATFORM_DB;
  if (!db) throw new Error("workspace_browser_profile_registry_unavailable");
  const rows = await db.prepare(`SELECT profile_id,scope_json FROM workspace_browser_profile_registry
    WHERE tenant_id=? AND space_id=? AND project_id=? AND erasure_notified_at IS NULL
    ORDER BY last_seen_at LIMIT 100`).bind(scope.tenantId, scope.spaceId, scope.projectId).all<{ profile_id: string; scope_json: string }>();
  let notified = 0;
  for (const row of rows.results ?? []) {
    let profileScope: BrowserProfileScope | null = null;
    try {
      const parsed = JSON.parse(row.scope_json) as BrowserProfileScope;
      if (parsed.tenantId === scope.tenantId && parsed.spaceId === scope.spaceId && parsed.projectId === scope.projectId &&
          typeof parsed.actorId === "string" && typeof parsed.agentId === "string" && typeof parsed.runId === "string" &&
          typeof parsed.sessionId === "string" && typeof parsed.connectionId === "string" &&
          Array.isArray(parsed.authorizedOrigins) && Array.isArray(parsed.authorizedActions) && [4, 5, 6].includes(parsed.maxTier) &&
          await browserProfileId(parsed) === row.profile_id) profileScope = parsed;
    } catch { /* invalid stored scope is recorded below */ }

    let errorCode = "browser_profile_scope_invalid";
    if (profileScope && env.BROWSER_WORKER && env.PLATFORM_SECRET) {
      try {
        // BrowserRuntimeScope validation rejects expired sessions. The profile owner key does
        // not include expiry, so refresh only this validation field while retaining its owner.
        const revokeScope = { ...profileScope, expiresAt: Date.now() + 60_000 };
        const response = await env.BROWSER_WORKER.fetch(new Request("https://browser.internal/v1/website-profile/revoke", {
          method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId,
            "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId) },
          body: JSON.stringify(revokeScope), signal: AbortSignal.timeout(5000),
        }));
        const result = await readBoundedResponseJson<{ ok?: boolean }>(response, 8 * 1024).catch(() => null);
        if (response.ok && result?.ok === true) {
          await db.prepare(`UPDATE workspace_browser_profile_registry SET erasure_notified_at=?,erasure_attempts=erasure_attempts+1,last_erasure_error=NULL
            WHERE profile_id=? AND tenant_id=? AND space_id=? AND project_id=? AND erasure_notified_at IS NULL`)
            .bind(new Date().toISOString(), row.profile_id, scope.tenantId, scope.spaceId, scope.projectId).run();
          notified++;
          continue;
        }
        errorCode = response.status >= 500 ? "browser_profile_revoke_retry_required" : "browser_profile_revoke_receipt_unverified";
      } catch { errorCode = "browser_profile_revoke_transport_failed"; }
    } else if (!profileScope) errorCode = "browser_profile_scope_invalid";
    else errorCode = "browser_profile_worker_unavailable";

    await db.prepare(`UPDATE workspace_browser_profile_registry SET erasure_attempts=erasure_attempts+1,last_erasure_error=?
      WHERE profile_id=? AND tenant_id=? AND space_id=? AND project_id=? AND erasure_notified_at IS NULL`)
      .bind(errorCode, row.profile_id, scope.tenantId, scope.spaceId, scope.projectId).run();
  }
  const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM workspace_browser_profile_registry
    WHERE tenant_id=? AND space_id=? AND project_id=? AND erasure_notified_at IS NULL`)
    .bind(scope.tenantId, scope.spaceId, scope.projectId).first<{ count: number }>();
  return { notified, pending: Number(remaining?.count ?? 0) };
}

/** Close exact project-scoped browser sessions and remove their session-owned screenshot prefixes. */
async function notifyWorkspaceBrowserSessions(env: CleanupEnv, scope: WorkspaceScope): Promise<{ notified: number; pending: number }> {
  const db = env.PLATFORM_DB;
  if (!db) throw new Error("workspace_browser_session_registry_unavailable");
  const rows = await db.prepare(`SELECT session_id,scope_json FROM workspace_browser_session_registry
    WHERE tenant_id=? AND space_id=? AND project_id=? AND erasure_notified_at IS NULL
    ORDER BY last_seen_at LIMIT 100`).bind(scope.tenantId, scope.spaceId, scope.projectId).all<{ session_id: string; scope_json: string }>();
  let notified = 0;
  for (const row of rows.results ?? []) {
    let sessionScope: BrowserProfileScope | null = null;
    try {
      const parsed = JSON.parse(row.scope_json) as BrowserProfileScope;
      if (parsed.tenantId === scope.tenantId && parsed.spaceId === scope.spaceId && parsed.projectId === scope.projectId &&
          typeof parsed.actorId === "string" && typeof parsed.agentId === "string" && typeof parsed.runId === "string" &&
          typeof parsed.sessionId === "string" && Array.isArray(parsed.authorizedOrigins) && Array.isArray(parsed.authorizedActions) &&
          [4, 5, 6].includes(parsed.maxTier) && await browserSessionId(parsed) === row.session_id) sessionScope = parsed;
    } catch { /* invalid stored scope is recorded below */ }

    let errorCode = "browser_session_scope_invalid";
    if (sessionScope && env.BROWSER_WORKER && env.PLATFORM_SECRET) {
      try {
        const eraseScope = { ...sessionScope, expiresAt: Date.now() + 60_000 };
        const response = await env.BROWSER_WORKER.fetch(new Request("https://browser.internal/v1/workspace-erasure/browser-session", {
          method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId,
            "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId) },
          body: JSON.stringify(eraseScope), signal: AbortSignal.timeout(5000),
        }));
        const result = await readBoundedResponseJson<{ ok?: boolean; sessionClosed?: boolean }>(response, 8 * 1024).catch(() => null);
        if (response.ok && result?.ok === true && result.sessionClosed === true) {
          const at = new Date().toISOString();
          await db.prepare(`UPDATE workspace_browser_session_registry SET erasure_notified_at=?,closed_at=COALESCE(closed_at,?),last_seen_at=?,erasure_attempts=erasure_attempts+1,last_erasure_error=NULL
            WHERE session_id=? AND tenant_id=? AND space_id=? AND project_id=? AND erasure_notified_at IS NULL`)
            .bind(at, at, at, row.session_id, scope.tenantId, scope.spaceId, scope.projectId).run();
          notified++;
          continue;
        }
        errorCode = response.status >= 500 ? "browser_session_erasure_retry_required" : "browser_session_erasure_receipt_unverified";
      } catch { errorCode = "browser_session_erasure_transport_failed"; }
    } else if (!sessionScope) errorCode = "browser_session_scope_invalid";
    else errorCode = "browser_session_worker_unavailable";
    await db.prepare(`UPDATE workspace_browser_session_registry SET erasure_attempts=erasure_attempts+1,last_erasure_error=?
      WHERE session_id=? AND tenant_id=? AND space_id=? AND project_id=? AND erasure_notified_at IS NULL`)
      .bind(errorCode, row.session_id, scope.tenantId, scope.spaceId, scope.projectId).run();
  }
  const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM workspace_browser_session_registry
    WHERE tenant_id=? AND space_id=? AND project_id=? AND erasure_notified_at IS NULL`)
    .bind(scope.tenantId, scope.spaceId, scope.projectId).first<{ count: number }>();
  return { notified, pending: Number(remaining?.count ?? 0) };
}

async function notifyWorkspaceRuntimes(env: CleanupEnv, scope: WorkspaceScope): Promise<{ notified: number; pending: number }> {
  const db = env.PLATFORM_DB;
  if (!db || !env.PLATFORM_SECRET) throw new Error("workspace_runtime_registry_unavailable");
  // Before registry-backed receipts existed, the stable project-main objects were named by
  // convention and were not enumerable from D1. Seed those exact legacy names into the same
  // retryable inventory before cleanup so old snapshots/private caches receive the tombstone.
  // A candidate is added only for a namespace that is actually bound in this deployment.
  const legacyNames: Array<{ kind: RuntimeRegistryRow["runtime_kind"]; objectName: string; bound: boolean }> = [
    { kind: "tool_sandbox", objectName: `sandbox:${scope.spaceId}:${scope.projectId}`, bound: Boolean(env.TOOL_SANDBOX) },
    { kind: "dynamic_sandbox", objectName: `sandbox:${scope.spaceId}:${scope.projectId}`, bound: Boolean(env.DYNAMIC_SANDBOX) },
    { kind: "document_sandbox", objectName: `sandbox:${scope.spaceId}:${scope.projectId}`, bound: Boolean(env.DOCUMENT_SANDBOX) },
    { kind: "media_sandbox", objectName: `attachment-media:${scope.spaceId}:${scope.projectId}`, bound: Boolean(env.MEDIA_SANDBOX) },
  ];
  const discoveredAt = new Date().toISOString();
  for (const candidate of legacyNames) {
    if (!candidate.bound) continue;
    await db.prepare(`INSERT OR IGNORE INTO workspace_runtime_registry(
      tenant_id,space_id,project_id,runtime_kind,object_name,branch,installation_id,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,'',NULL,?,?)`)
      .bind(scope.tenantId,scope.spaceId,scope.projectId,candidate.kind,candidate.objectName,discoveredAt,discoveredAt).run();
  }
  const page = await db.prepare(`SELECT runtime_kind,object_name FROM workspace_runtime_registry
    WHERE tenant_id=? AND space_id=? AND project_id=? AND erasure_notified_at IS NULL
    ORDER BY last_seen_at LIMIT 100`).bind(scope.tenantId, scope.spaceId, scope.projectId).all<RuntimeRegistryRow>();
  let notified = 0;
  for (const row of page.results ?? []) {
    const namespace = (row.runtime_kind === "tool_sandbox" ? env.TOOL_SANDBOX
      : row.runtime_kind === "dynamic_sandbox" ? env.DYNAMIC_SANDBOX
        : row.runtime_kind === "document_sandbox" ? env.DOCUMENT_SANDBOX
          : row.runtime_kind === "media_sandbox" ? env.MEDIA_SANDBOX : undefined) as RuntimeNamespace | undefined;
    let errorCode = "runtime_namespace_unavailable";
    if (namespace) {
      try {
        const response = await namespace.get(namespace.idFromName(row.object_name)).fetch(new Request("http://runtime/_internal/workspace/erase", {
          method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId) },
          body: JSON.stringify({ scope, confirm: true }), signal: AbortSignal.timeout(5000),
        }));
        const result = await readBoundedResponseJson<{ erased?: boolean; localStatePurged?: boolean }>(response, 8 * 1024).catch(() => null);
        if (response.ok && result?.erased === true && result.localStatePurged === true) {
          const statements = [db.prepare(`UPDATE workspace_runtime_registry SET erasure_notified_at=?,erasure_attempts=erasure_attempts+1,last_erasure_error=NULL
            WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_kind=? AND object_name=? AND erasure_notified_at IS NULL`)
            .bind(new Date().toISOString(), scope.tenantId, scope.spaceId, scope.projectId, row.runtime_kind, row.object_name)];
          if (row.runtime_kind === "dynamic_sandbox" && row.object_name === `sandbox:${scope.spaceId}:${scope.projectId}`) {
            statements.push(db.prepare(`UPDATE project_main_runtime_registry SET state='erased',last_seen_at=?
              WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_kind='dynamic_sandbox' AND runtime_object_name=?`)
              .bind(new Date().toISOString(), scope.tenantId, scope.spaceId, scope.projectId, row.object_name));
          }
          await db.batch(statements);
          notified++;
          continue;
        }
        errorCode = response.status >= 500 ? "runtime_erasure_retry_required" : "runtime_erasure_receipt_unverified";
      } catch { errorCode = "runtime_erasure_transport_failed"; }
    }
    await db.prepare(`UPDATE workspace_runtime_registry SET erasure_attempts=erasure_attempts+1,last_erasure_error=?
      WHERE tenant_id=? AND space_id=? AND project_id=? AND runtime_kind=? AND object_name=? AND erasure_notified_at IS NULL`)
      .bind(errorCode, scope.tenantId, scope.spaceId, scope.projectId, row.runtime_kind, row.object_name).run();
  }
  const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM workspace_runtime_registry
    WHERE tenant_id=? AND space_id=? AND project_id=? AND erasure_notified_at IS NULL`)
    .bind(scope.tenantId, scope.spaceId, scope.projectId).first<{ count: number }>();
  return { notified, pending: Number(remaining?.count ?? 0) };
}

interface BridgeCleanupCursor {
  sidecarCursor: string | null;
  sidecarComplete: boolean;
  projectArtifactsCursor: string | null;
  projectArtifactsComplete: boolean;
  afterFilesystemId: string | null;
  filesystemId: string | null;
  objectCursor: string | null;
}

function decodeBridgeCleanupCursor(value: string | null): BridgeCleanupCursor {
  if (!value) return { sidecarCursor: null, sidecarComplete: false, projectArtifactsCursor: null, projectArtifactsComplete: false,
    afterFilesystemId: null, filesystemId: null, objectCursor: null };
  try {
    const parsed = JSON.parse(value) as Partial<BridgeCleanupCursor>;
    if ((parsed.sidecarCursor === undefined || parsed.sidecarCursor === null || typeof parsed.sidecarCursor === "string") &&
        (parsed.sidecarComplete === undefined || typeof parsed.sidecarComplete === "boolean") &&
        (parsed.projectArtifactsCursor === undefined || parsed.projectArtifactsCursor === null || typeof parsed.projectArtifactsCursor === "string") &&
        (parsed.projectArtifactsComplete === undefined || typeof parsed.projectArtifactsComplete === "boolean") &&
        (parsed.afterFilesystemId === null || parsed.afterFilesystemId === undefined || typeof parsed.afterFilesystemId === "string") &&
        (parsed.filesystemId === null || typeof parsed.filesystemId === "string") &&
        (parsed.objectCursor === null || typeof parsed.objectCursor === "string")) {
      return { sidecarCursor: parsed.sidecarCursor ?? null, sidecarComplete: parsed.sidecarComplete ?? false,
        projectArtifactsCursor: parsed.projectArtifactsCursor ?? null, projectArtifactsComplete: parsed.projectArtifactsComplete ?? false,
        afterFilesystemId: parsed.afterFilesystemId ?? null, filesystemId: parsed.filesystemId ?? null, objectCursor: parsed.objectCursor ?? null };
    }
  } catch { /* persisted cursor is validated below */ }
  throw new Error("workspace_bridge_cleanup_cursor_invalid");
}

function isProjectSidecarWorkspaceObject(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) return false;
  const remainder = key.slice(prefix.length);
  const slash = remainder.indexOf("/");
  if (slash < 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(remainder.slice(0, slash))) return false;
  return remainder.slice(slash) === "/workspace/" || remainder.slice(slash).startsWith("/workspace/");
}

/**
 * Retryable last step for a project deletion workflow. Coordinator erasure first tombstones the
 * scope and revokes its sessions/subscriptions, then this route removes legacy workspace files
 * (including branch overlays). The prefix is project-owned; tenant provider connections live
 * elsewhere and are intentionally outside this operation.
 */
export async function handleWorkspaceProjectCleanup(request: Request, env: CleanupEnv, signal?: AbortSignal): Promise<Response> {
  const tenantId = request.headers.get("x-naelao-tenant-id") ?? "";
  if (!tenantId || !env.PLATFORM_SECRET || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined, tenantId, env.PLATFORM_SECRET)) {
    return Response.json({ error_code: "forbidden" }, { status: 403 });
  }
  if (!env.SCRIPTS_R2) return Response.json({ error_code: "workspace_storage_unavailable" }, { status: 503 });
  if (!env.PLATFORM_DB) return Response.json({ error_code: "workspace_erasure_ledger_unavailable" }, { status: 503 });
  let body: { scope?: unknown; confirm?: unknown; cursor?: unknown };
  try { body = JSON.parse(await readBoundedRequestText(request, 16 * 1024)) as typeof body; }
  catch { return Response.json({ error_code: "invalid_workspace_cleanup_request" }, { status: 400 }); }
  if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId || body.confirm !== true ||
      (body.cursor !== undefined && (typeof body.cursor !== "string" || body.cursor.length > 1024))) {
    return Response.json({ error_code: "invalid_workspace_cleanup_request" }, { status: 400 });
  }

  const scope = body.scope;
  try {
    const admission = await workspaceCoordinatorRequest(env, scope, "/v1/erase/admission", {
      body: { scope, confirm: true }, ...(signal ? { signal } : {}),
    });
    if (!admission.ok) return new Response(admission.body, { status: admission.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const receipt = await readBoundedResponseJson<{ admitted?: boolean }>(admission, 8 * 1024).catch(() => null);
    if (receipt?.admitted !== true) return Response.json({ error_code: "workspace_erasure_admission_unverified" }, { status: 503 });
  } catch {
    return Response.json({ error_code: "workspace_erasure_admission_retry_required" }, { status: 503 });
  }
  let tombstone: Awaited<ReturnType<typeof workspaceErasureTombstone>>;
  let providerDeletions: { queued: number; pending: number; unresolved: number };
  try {
    const started = await beginProjectWorkspaceErasure(env.PLATFORM_DB, env.SCRIPTS_R2, scope);
    tombstone = started.tombstone;
    providerDeletions = started.providerDeletions;
    if (!tombstone) throw new Error("workspace_erasure_tombstone_missing");
  } catch {
    return Response.json({ error_code: "workspace_erasure_ledger_retry_required" }, { status: 503 });
  }

  try {
    const receiptBackedUp = await exportWorkspaceErasureReceipt(env.PLATFORM_DB, env, scope);
    if (!receiptBackedUp) return Response.json({ error_code: "workspace_erasure_backup_unavailable" }, { status: 503 });
  } catch {
    // Keep the tombstone in place and aliases recoverable until an independent receipt copy
    // has been verified. A retry can finish the same immutable backup write.
    return Response.json({ error_code: "workspace_erasure_backup_retry_required" }, { status: 503 });
  }
  if (!tombstone) return Response.json({ error_code: "workspace_erasure_tombstone_missing" }, { status: 503 });
  if (tombstone.status === "complete") {
    try {
      await restartCompletedWorkspaceErasure(env.PLATFORM_DB, scope);
      tombstone = await workspaceErasureTombstone(env.PLATFORM_DB, scope);
    } catch {
      return Response.json({ error_code: "workspace_erasure_ledger_retry_required" }, { status: 503 });
    }
  }
  if (!tombstone) return Response.json({ error_code: "workspace_erasure_tombstone_missing" }, { status: 503 });

  let runtimeErasure: { notified: number; pending: number };
  try { runtimeErasure = await notifyWorkspaceRuntimes(env, scope); }
  catch { return Response.json({ error_code: "workspace_runtime_erasure_retry_required" }, { status: 503 }); }
  if (runtimeErasure.pending > 0) return Response.json({ error_code: "workspace_runtime_erasure_pending", ...runtimeErasure }, { status: 503 });

  let browserProfileErasure: { notified: number; pending: number };
  try { browserProfileErasure = await notifyWorkspaceBrowserProfiles(env, scope); }
  catch { return Response.json({ error_code: "workspace_browser_profile_erasure_retry_required" }, { status: 503 }); }
  if (browserProfileErasure.pending > 0) return Response.json({ error_code: "workspace_browser_profile_erasure_pending", ...browserProfileErasure }, { status: 503 });

  let browserSessionErasure: { notified: number; pending: number };
  try { browserSessionErasure = await notifyWorkspaceBrowserSessions(env, scope); }
  catch { return Response.json({ error_code: "workspace_browser_session_erasure_retry_required" }, { status: 503 }); }
  if (browserSessionErasure.pending > 0) return Response.json({ error_code: "workspace_browser_session_erasure_pending", ...browserSessionErasure }, { status: 503 });

  let erased: Response;
  try {
    erased = await workspaceCoordinatorRequest(env, scope, "/v1/erase", { body: { scope, confirm: true }, ...(signal ? { signal } : {}) });
  } catch {
    // The tombstone may have committed even when the response was lost. Return a retryable
    // result and replay the idempotent erase on the next cleanup attempt before deleting R2 pages.
    return Response.json({ error_code: "workspace_cleanup_retryable_failure" }, { status: 503 });
  }
  if (!erased.ok) return new Response(erased.body, { status: erased.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  const prefix = `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`;
  try {
    if (signal?.aborted) return Response.json({ error_code: "workspace_cleanup_barrier_lost" }, { status: 503 });
    let legacyObjectsDeleted = 0;
    let bridgeObjectsDeleted = 0;
    const pageNumber = tombstone.cleanup_page + 1;
    if (tombstone.cleanup_phase === "legacy") {
      // D1 is authoritative if the caller lost the previous response after a page advanced.
      // Replaying its older cursor could skip objects; replaying this persisted cursor cannot.
      const cursor = tombstone.cleanup_cursor ?? undefined;
      const page = await env.SCRIPTS_R2.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
      const keys = page.objects.map(object => object.key);
      if (keys.some(key => !key.startsWith(prefix))) return Response.json({ error_code: "workspace_cleanup_scope_mismatch" }, { status: 500 });
      if (keys.length) await env.SCRIPTS_R2.delete(keys);
      if (page.truncated && (!page.cursor || page.cursor === cursor)) return Response.json({ error_code: "workspace_cleanup_cursor_invalid" }, { status: 503 });
      legacyObjectsDeleted = keys.length;
      await advanceWorkspaceErasureCursor(env.PLATFORM_DB, scope, {
        phase: page.truncated ? "legacy" : "bridge",
        cursor: page.truncated ? page.cursor! : null,
        bridgeCursor: null,
        page: pageNumber,
      }, false);
      return Response.json({
        erased: true,
        scope,
        legacyObjectsDeleted,
        bridgeObjectsDeleted,
        hasMore: true,
        nextCursor: `workspace-cleanup:bridge:${pageNumber}`,
        providerConnectionsDeleted: false,
        runtimeErasure,
        browserProfileErasure,
        browserSessionErasure,
        providerDeletion: await projectProviderDeletionSummary(env.PLATFORM_DB, scope, providerDeletions.queued),
      }, { headers: { "cache-control": "no-store" } });
    }

    if (tombstone.cleanup_phase === "bridge") {
      const bridgeCursor = decodeBridgeCleanupCursor(tombstone.bridge_cleanup_cursor);
      // Project-bound sidecar files use installation-owned prefixes outside the canonical
      // project workspace. Erase only each installation's workspace subtree; extension bundles,
      // Space-owned sidecars, and tenant provider connections have separate ownership.
      const sidecarPrefix = `spaces/${scope.spaceId}/projects/${scope.projectId}/extensions/`;
      if (!bridgeCursor.sidecarComplete) {
        const page = await env.SCRIPTS_R2.list({ prefix: sidecarPrefix,
          ...(bridgeCursor.sidecarCursor ? { cursor: bridgeCursor.sidecarCursor } : {}), limit: 1000 });
        if (page.truncated && (!page.cursor || page.cursor === bridgeCursor.sidecarCursor))
          return Response.json({ error_code: "workspace_cleanup_cursor_invalid" }, { status: 503 });
        const keys = page.objects.map(object => object.key).filter(key => isProjectSidecarWorkspaceObject(key, sidecarPrefix));
        if (keys.length) await env.SCRIPTS_R2.delete(keys);
        const nextBridgeCursor: BridgeCleanupCursor = { ...bridgeCursor,
          sidecarCursor: page.truncated ? page.cursor! : null, sidecarComplete: !page.truncated };
        await advanceWorkspaceErasureCursor(env.PLATFORM_DB, scope, {
          phase: "bridge", cursor: null, bridgeCursor: JSON.stringify(nextBridgeCursor), page: pageNumber,
        }, false);
        return Response.json({ erased: true, scope, legacyObjectsDeleted, bridgeObjectsDeleted: 0,
          sidecarWorkspaceObjectsDeleted: keys.length, hasMore: true,
          nextCursor: `workspace-cleanup:bridge:${pageNumber}`, providerConnectionsDeleted: false,
          runtimeErasure, browserProfileErasure, browserSessionErasure, providerDeletion: await projectProviderDeletionSummary(env.PLATFORM_DB, scope, providerDeletions.queued),
        }, { headers: { "cache-control": "no-store" } });
      }

      // Immutable handoff artifacts are scoped to one project and can include data exported
      // from a sidecar. Remove only this project's environment artifact namespace.
      const projectArtifactPrefix = `workspace-artifacts/${scope.tenantId}/${scope.spaceId}/${scope.projectId}/environment/`;
      if (!bridgeCursor.projectArtifactsComplete) {
        const page = await env.SCRIPTS_R2.list({ prefix: projectArtifactPrefix,
          ...(bridgeCursor.projectArtifactsCursor ? { cursor: bridgeCursor.projectArtifactsCursor } : {}), limit: 1000 });
        if (page.truncated && (!page.cursor || page.cursor === bridgeCursor.projectArtifactsCursor))
          return Response.json({ error_code: "workspace_cleanup_cursor_invalid" }, { status: 503 });
        const keys = page.objects.map(object => object.key);
        if (keys.some(key => !key.startsWith(projectArtifactPrefix)))
          return Response.json({ error_code: "workspace_cleanup_scope_mismatch" }, { status: 500 });
        if (keys.length) await env.SCRIPTS_R2.delete(keys);
        const nextBridgeCursor: BridgeCleanupCursor = { ...bridgeCursor,
          projectArtifactsCursor: page.truncated ? page.cursor! : null, projectArtifactsComplete: !page.truncated };
        await advanceWorkspaceErasureCursor(env.PLATFORM_DB, scope, {
          phase: "bridge", cursor: null, bridgeCursor: JSON.stringify(nextBridgeCursor), page: pageNumber,
        }, false);
        return Response.json({ erased: true, scope, legacyObjectsDeleted, bridgeObjectsDeleted: 0,
          projectArtifactsDeleted: keys.length, hasMore: true,
          nextCursor: `workspace-cleanup:bridge:${pageNumber}`, providerConnectionsDeleted: false,
          runtimeErasure, browserProfileErasure, browserSessionErasure, providerDeletion: await projectProviderDeletionSummary(env.PLATFORM_DB, scope, providerDeletions.queued),
        }, { headers: { "cache-control": "no-store" } });
      }

      // Enumerate the whole filesystem-owned staging prefix, not just D1 blob rows. A worker
      // interruption between R2 PUT and metadata insert can leave an orphan object; a late
      // upload is separately fenced by the tombstone and post-write check.
      let filesystemId = bridgeCursor.filesystemId;
      if (!filesystemId) {
        const nextFilesystem = await env.PLATFORM_DB.prepare(
          `SELECT id FROM sandbox_filesystems WHERE tenant_id=? AND space_id=? AND project_id=? AND id>?
           ORDER BY id LIMIT 1`,
        ).bind(scope.tenantId, scope.spaceId, scope.projectId, bridgeCursor.afterFilesystemId ?? "")
          .first<{ id: string }>();
        filesystemId = nextFilesystem?.id ?? null;
      }
      if (filesystemId) {
        const prefix = `sandbox-workspace-bridge/${scope.tenantId}/${filesystemId}/`;
        const page = await env.SCRIPTS_R2.list({ prefix, ...(bridgeCursor.filesystemId === filesystemId && bridgeCursor.objectCursor ? { cursor: bridgeCursor.objectCursor } : {}), limit: 1000 });
        const keys = page.objects.map(object => object.key);
        if (keys.some(key => !key.startsWith(prefix))) return Response.json({ error_code: "workspace_cleanup_scope_mismatch" }, { status: 500 });
        if (keys.length) await env.SCRIPTS_R2.delete(keys);
        if (page.truncated && (!page.cursor || page.cursor === bridgeCursor.objectCursor)) return Response.json({ error_code: "workspace_cleanup_cursor_invalid" }, { status: 503 });
        bridgeObjectsDeleted = keys.length;
        const nextBridgeCursor: BridgeCleanupCursor = page.truncated
          ? { ...bridgeCursor, afterFilesystemId: bridgeCursor.afterFilesystemId, filesystemId, objectCursor: page.cursor! }
          : { ...bridgeCursor, afterFilesystemId: filesystemId, filesystemId: null, objectCursor: null };
        await advanceWorkspaceErasureCursor(env.PLATFORM_DB, scope, {
          phase: "bridge", cursor: null, bridgeCursor: JSON.stringify(nextBridgeCursor), page: pageNumber,
        }, false);
        return Response.json({
          erased: true, scope, legacyObjectsDeleted, bridgeObjectsDeleted, hasMore: true,
          nextCursor: `workspace-cleanup:bridge:${pageNumber}`,
          providerConnectionsDeleted: false,
          runtimeErasure,
          browserProfileErasure,
          browserSessionErasure,
          providerDeletion: await projectProviderDeletionSummary(env.PLATFORM_DB, scope, providerDeletions.queued),
        }, { headers: { "cache-control": "no-store" } });
      }
      await finalizeProjectSandboxDataErasure(env.PLATFORM_DB, scope);
      await advanceWorkspaceErasureCursor(env.PLATFORM_DB, scope, {
        phase: "complete", cursor: null, bridgeCursor: null, page: pageNumber,
      }, true);
    } else if (tombstone.cleanup_phase !== "complete") {
      return Response.json({ error_code: "workspace_cleanup_phase_invalid" }, { status: 503 });
    }
    const pending = await env.PLATFORM_DB.prepare(
      `SELECT
        SUM(CASE WHEN status IN ('pending','dispatching','deletion_requested','indeterminate') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='retained' THEN 1 ELSE 0 END) AS unresolved
       FROM sandbox_provider_deletion_operations WHERE tenant_id=? AND space_id=? AND project_id=?`,
    ).bind(scope.tenantId, scope.spaceId, scope.projectId).first<{ pending: number | null; unresolved: number | null }>();
    return Response.json({
      erased: true,
      scope,
      legacyObjectsDeleted,
      bridgeObjectsDeleted,
      hasMore: false,
      providerConnectionsDeleted: false,
      runtimeErasure,
      browserProfileErasure,
      browserSessionErasure,
      providerDeletion: {
        queued: providerDeletions.queued,
        pending: Number(pending?.pending ?? 0),
        unresolved: Number(pending?.unresolved ?? 0),
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    // Retrying the same scope and cursor is safe: coordinator erasure is tombstone-idempotent and
    // R2 deletion of already-removed objects is harmless.
    return Response.json({ error_code: "workspace_cleanup_retryable_failure" }, { status: 503 });
  }
}

async function projectProviderDeletionSummary(
  db: Pick<D1Database, "prepare">,
  scope: { tenantId: string; spaceId: string; projectId: string },
  queued: number,
) {
  const pending = await db.prepare(
    `SELECT
      SUM(CASE WHEN status IN ('pending','dispatching','deletion_requested','indeterminate') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='retained' THEN 1 ELSE 0 END) AS unresolved
     FROM sandbox_provider_deletion_operations WHERE tenant_id=? AND space_id=? AND project_id=?`,
  ).bind(scope.tenantId, scope.spaceId, scope.projectId).first<{ pending: number | null; unresolved: number | null }>();
  return { queued, pending: Number(pending?.pending ?? 0), unresolved: Number(pending?.unresolved ?? 0) };
}
