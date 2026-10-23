import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import { validateContainerScope, type ContainerInvocationScope } from "./container-policy.js";
import { sandboxInstanceName } from "./sandbox-routing.js";
import type { ContainerWorkspaceGateway } from "./types.js";

interface WorkspaceActor {
  tenantId: string; spaceId: string; projectId?: string | undefined; actorId: string;
  agentId: string; runId: string; branch?: string | undefined; signal?: AbortSignal | undefined;
}
export function createContainerWorkspaceGateway(options: {
  namespace: DurableObjectNamespace; secret: string;
  actor(): WorkspaceActor; authorize(actor: WorkspaceActor): Promise<boolean>;
}): ContainerWorkspaceGateway {
  async function request<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
    const actor = options.actor();
    if (!options.secret || actor.signal?.aborted || !await options.authorize(actor)) throw new Error("container_workspace_not_authorized");
    const scope: ContainerInvocationScope = { tenantId: actor.tenantId, spaceId: actor.spaceId, projectId: actor.projectId,
      actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, executionId: crypto.randomUUID(), workspaceBranch: actor.branch, timeoutMs: 55000, deadline: Date.now() + 55000 };
    validateContainerScope(scope);
    const stub = options.namespace.get(options.namespace.idFromName(sandboxInstanceName(actor.spaceId, actor.projectId, actor.branch)));
    const response = await stub.fetch(new Request("http://sandbox/workspace/" + operation, { method: "POST", headers: {
      "content-type": "application/json", "x-naelao-container-scope": JSON.stringify(scope),
      "x-naelao-internal-token": await mintInternalToken(options.secret, actor.tenantId),
    }, body: JSON.stringify({ ...payload, spaceId: actor.spaceId, projectId: actor.projectId, workspaceBranch: actor.branch }),
      signal: actor.signal ? AbortSignal.any([actor.signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000) }));
    const body = await readBoundedResponseJson<T & { ok?: boolean; error?: string }>(response, 2 * 1024 * 1024);
    if (!response.ok || body.ok === false) throw new Error(body.error ?? `container_workspace_failed_${response.status}`);
    return body;
  }
  return {
    list: () => request("list", {}), read: paths => request("read", { paths }),
    write: (files, expectedHashes) => request("write", { files, expected_hashes: expectedHashes }),
    remove: (paths, expectedHashes) => request("delete", { paths, expected_hashes: expectedHashes }),
  };
}
