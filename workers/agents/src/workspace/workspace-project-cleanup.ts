import { readBoundedRequestText, verifyInternalToken } from "@naelao/http";
import { workspaceCoordinatorRequest, type WorkspaceCoordinatorBindings } from "./workspace-client.js";
import { validateWorkspaceScope } from "./workspace-contract.js";

type CleanupEnv = WorkspaceCoordinatorBindings & {
  PLATFORM_SECRET?: string;
  SCRIPTS_R2?: R2Bucket;
};

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
  let body: { scope?: unknown; confirm?: unknown; cursor?: unknown };
  try { body = JSON.parse(await readBoundedRequestText(request, 16 * 1024)) as typeof body; }
  catch { return Response.json({ error_code: "invalid_workspace_cleanup_request" }, { status: 400 }); }
  if (!validateWorkspaceScope(body.scope) || body.scope.tenantId !== tenantId || body.confirm !== true ||
      (body.cursor !== undefined && (typeof body.cursor !== "string" || body.cursor.length > 1024))) {
    return Response.json({ error_code: "invalid_workspace_cleanup_request" }, { status: 400 });
  }

  const scope = body.scope;
  const erased = await workspaceCoordinatorRequest(env, scope, "/v1/erase", { body: { scope, confirm: true }, ...(signal ? { signal } : {}) });
  if (!erased.ok) return new Response(erased.body, { status: erased.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  const prefix = `spaces/${scope.spaceId}/projects/${scope.projectId}/workspace/`;
  try {
    const cursor = typeof body.cursor === "string" ? body.cursor : undefined;
    const page = await env.SCRIPTS_R2.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    const keys = page.objects.map(object => object.key);
    if (keys.some(key => !key.startsWith(prefix))) return Response.json({ error_code: "workspace_cleanup_scope_mismatch" }, { status: 500 });
    if (signal?.aborted) return Response.json({ error_code: "workspace_cleanup_barrier_lost" }, { status: 503 });
    if (keys.length) await env.SCRIPTS_R2.delete(keys);
    if (page.truncated && (!page.cursor || page.cursor === cursor)) return Response.json({ error_code: "workspace_cleanup_cursor_invalid" }, { status: 503 });
    return Response.json({
      erased: true,
      scope,
      legacyObjectsDeleted: keys.length,
      hasMore: page.truncated,
      ...(page.truncated && page.cursor ? { nextCursor: page.cursor } : {}),
      providerConnectionsDeleted: false,
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    // Retrying the same scope and cursor is safe: coordinator erasure is tombstone-idempotent and
    // R2 deletion of already-removed objects is harmless.
    return Response.json({ error_code: "workspace_cleanup_retryable_failure" }, { status: 503 });
  }
}
