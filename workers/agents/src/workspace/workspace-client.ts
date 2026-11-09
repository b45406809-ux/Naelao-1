import { getDOName } from "@naelao/crypto";
import { mintInternalToken } from "@naelao/http";
import type { WorkspaceScope } from "./workspace-contract.js";

export interface WorkspaceCoordinatorBindings {
  WORKSPACE_COORDINATOR?: DurableObjectNamespace;
  PLATFORM_SECRET?: string;
  DATA_JURISDICTION?: "eu";
}

/** Server-side client. User and project authorization must be completed before this is called. */
export async function workspaceCoordinatorRequest(
  bindings: WorkspaceCoordinatorBindings,
  scope: WorkspaceScope,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
): Promise<Response> {
  if (!bindings.WORKSPACE_COORDINATOR || !bindings.PLATFORM_SECRET) throw new Error("workspace_coordinator_unavailable");
  const resource = `${scope.spaceId}:${scope.projectId}`;
  const name = await getDOName("workspace", resource, scope.tenantId, bindings.PLATFORM_SECRET);
  const stub = bindings.WORKSPACE_COORDINATOR.get(bindings.WORKSPACE_COORDINATOR.idFromName(name));
  const headers = new Headers({
    "x-naelao-tenant-id": scope.tenantId,
    "x-naelao-internal-token": await mintInternalToken(bindings.PLATFORM_SECRET, scope.tenantId),
  });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return stub.fetch(new Request(`https://workspace-coordinator${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }));
}
