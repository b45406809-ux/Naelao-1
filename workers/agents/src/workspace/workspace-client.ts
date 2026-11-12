import { getDOName } from "@naelao/crypto";
import { mintInternalToken } from "@naelao/http";
import type { WorkspaceScope } from "./workspace-contract.js";
import { restoreWorkspaceErasureTombstone } from "./phase6-erasure.js";

export interface WorkspaceCoordinatorBindings {
  WORKSPACE_COORDINATOR?: DurableObjectNamespace;
  PLATFORM_SECRET?: string;
  PLATFORM_DB?: Pick<D1Database, "prepare">;
  SCRIPTS_R2?: R2Bucket;
  DATA_JURISDICTION?: "eu";
}

export async function workspaceScopeErased(bindings: WorkspaceCoordinatorBindings, scope: WorkspaceScope): Promise<boolean> {
  if (!bindings.PLATFORM_DB) return false;
  const row = await bindings.PLATFORM_DB.prepare(
    "SELECT 1 AS erased FROM workspace_erasure_tombstones WHERE tenant_id=? AND space_id=? AND project_id=? LIMIT 1",
  ).bind(scope.tenantId, scope.spaceId, scope.projectId).first<{ erased: number }>();
  if (row) return true;
  return restoreWorkspaceErasureTombstone(bindings.PLATFORM_DB, bindings.SCRIPTS_R2, scope);
}

function erasedResponse(): Response {
  return Response.json({ error_code: "workspace_erased" }, {
    status: 410,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Server-side client. User and project authorization must be completed before this is called. */
export async function workspaceCoordinatorRequest(
  bindings: WorkspaceCoordinatorBindings,
  scope: WorkspaceScope,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
): Promise<Response> {
  if (!bindings.WORKSPACE_COORDINATOR || !bindings.PLATFORM_SECRET) throw new Error("workspace_coordinator_unavailable");
  const isErasureControl = ["/v1/erase", "/v1/erase/admission"].includes(path.split("?", 1)[0]!);
  if (!isErasureControl && await workspaceScopeErased(bindings, scope)) return erasedResponse();
  const resource = `${scope.spaceId}:${scope.projectId}`;
  const name = await getDOName("workspace", resource, scope.tenantId, bindings.PLATFORM_SECRET);
  const stub = bindings.WORKSPACE_COORDINATOR.get(bindings.WORKSPACE_COORDINATOR.idFromName(name));
  const headers = new Headers({
    "x-naelao-tenant-id": scope.tenantId,
    "x-naelao-internal-token": await mintInternalToken(bindings.PLATFORM_SECRET, scope.tenantId),
  });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await stub.fetch(new Request(`https://workspace-coordinator${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }));
  // Close the race where erasure commits while an authorized workspace read or write is in
  // flight. The coordinator tombstone fences writes; this second check also withholds a late
  // read response after the durable erasure ledger has advanced.
  if (!isErasureControl && await workspaceScopeErased(bindings, scope)) {
    await response.body?.cancel().catch(() => undefined);
    return erasedResponse();
  }
  return response;
}
