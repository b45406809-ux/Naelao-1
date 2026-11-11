import { readBoundedRequestText, verifyInternalToken } from "@naelao/http";
import { workspaceCoordinatorRequest, type WorkspaceCoordinatorBindings } from "./workspace-client.js";
import { validateWorkspaceScope } from "./workspace-contract.js";
import { advanceWorkspaceErasureCursor, beginProjectWorkspaceErasure, finalizeProjectSandboxDataErasure, restartCompletedWorkspaceErasure, workspaceErasureTombstone } from "./phase6-erasure.js";
import { exportWorkspaceErasureReceipt, type WorkspaceErasureBackupBindings } from "./erasure-backup.js";

type CleanupEnv = WorkspaceCoordinatorBindings & WorkspaceErasureBackupBindings & {
  PLATFORM_SECRET?: string;
  PLATFORM_DB?: D1Database;
  SCRIPTS_R2?: R2Bucket;
};

interface BridgeCleanupCursor {
  afterFilesystemId: string | null;
  filesystemId: string | null;
  objectCursor: string | null;
}

function decodeBridgeCleanupCursor(value: string | null): BridgeCleanupCursor {
  if (!value) return { afterFilesystemId: null, filesystemId: null, objectCursor: null };
  try {
    const parsed = JSON.parse(value) as Partial<BridgeCleanupCursor>;
    if ((parsed.afterFilesystemId === null || typeof parsed.afterFilesystemId === "string") &&
        (parsed.filesystemId === null || typeof parsed.filesystemId === "string") &&
        (parsed.objectCursor === null || typeof parsed.objectCursor === "string")) {
      return { afterFilesystemId: parsed.afterFilesystemId ?? null, filesystemId: parsed.filesystemId ?? null, objectCursor: parsed.objectCursor ?? null };
    }
  } catch { /* persisted cursor is validated below */ }
  throw new Error("workspace_bridge_cleanup_cursor_invalid");
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
        providerDeletion: await projectProviderDeletionSummary(env.PLATFORM_DB, scope, providerDeletions.queued),
      }, { headers: { "cache-control": "no-store" } });
    }

    if (tombstone.cleanup_phase === "bridge") {
      // Enumerate the whole filesystem-owned staging prefix, not just D1 blob rows. A worker
      // interruption between R2 PUT and metadata insert can leave an orphan object; a late
      // upload is separately fenced by the tombstone and post-write check.
      const bridgeCursor = decodeBridgeCleanupCursor(tombstone.bridge_cleanup_cursor);
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
          ? { afterFilesystemId: bridgeCursor.afterFilesystemId, filesystemId, objectCursor: page.cursor! }
          : { afterFilesystemId: filesystemId, filesystemId: null, objectCursor: null };
        await advanceWorkspaceErasureCursor(env.PLATFORM_DB, scope, {
          phase: "bridge", cursor: null, bridgeCursor: JSON.stringify(nextBridgeCursor), page: pageNumber,
        }, false);
        return Response.json({
          erased: true, scope, legacyObjectsDeleted, bridgeObjectsDeleted, hasMore: true,
          nextCursor: `workspace-cleanup:bridge:${pageNumber}`,
          providerConnectionsDeleted: false,
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
