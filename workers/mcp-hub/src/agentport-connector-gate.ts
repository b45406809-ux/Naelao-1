import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";

export type AgentPortConnectorGateEnv = {
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  AGENTPORT_WORKER?: Fetcher;
};
type BindingRow = {
  alias_id: string;
  current_alias_id: string | null;
  alias_server_id: string | null;
  scope: "space" | "project" | "user";
  project_id: string | null;
  user_id: string | null;
  provider: string;
  provider_connection_id: string | null;
  enabled: number;
  status: "pending" | "active" | "revoked" | "sync_required";
  owner_link_status: string | null;
  account_id: string;
  agent_id: string;
  tool_actions_json: string;
  provider_connection_sha256: string;
};

async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * AgentPort authorization for a UserPort-synchronized MCP alias. An unmapped server retains its
 * existing route. Once any alias for a server is linked, direct server calls are denied and the
 * alias route must provide the exact live alias identity. Provider payloads are never sent to
 * AgentPort; only the selected operation name, account reference and an opaque request digest are.
 */
export async function authorizeUserPortConnectorTool(input: {
  env: AgentPortConnectorGateEnv;
  tenantId: string;
  spaceId: string;
  serverId: string;
  provider: string;
  aliasId: string | null;
  toolName: string;
  userId: string;
  projectId: string;
  runId: string;
  requestBody: unknown;
}): Promise<{ required: boolean; allowed: boolean; status?: number; errorCode?: string }> {
  const { env } = input;
  // A first-time sync has no binding row until the AgentPort account and grant are confirmed.
  // Its durable operation is the fail-closed marker during that window, including after an
  // uncertain response. Do this before the empty-binding fast path below.
  if (input.aliasId) {
    const pendingSync = await env.PLATFORM_DB.prepare(`SELECT operation_id FROM managed_service_operations
      WHERE tenant_id=? AND space_id=? AND operation_name='agentport_connector_sync'
        AND status IN ('pending','running','uncertain','held')
        AND json_extract(request_json,'$.aliasId')=? LIMIT 1`)
      .bind(input.tenantId, input.spaceId, input.aliasId).first<{operation_id:string}>();
    if (pendingSync) return { required: true, allowed: false, status: 409, errorCode: "agentport_connector_sync_pending" };
  }
  if (input.aliasId) {
    const byAlias = await env.PLATFORM_DB.prepare(`SELECT server_id,status FROM agentport_userport_connector_bindings
      WHERE tenant_id=? AND space_id=? AND alias_id=? LIMIT 1`)
      .bind(input.tenantId, input.spaceId, input.aliasId).first<{server_id:string;status:string}>();
    if (byAlias && byAlias.server_id !== input.serverId) {
      await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='sync_required',updated_at=?
        WHERE tenant_id=? AND space_id=? AND alias_id=? AND status='active'`)
        .bind(new Date().toISOString(), input.tenantId, input.spaceId, input.aliasId).run();
      return { required: true, allowed: false, status: 409, errorCode: "agentport_connector_resync_required" };
    }
  }
  const serverBindings = await env.PLATFORM_DB.prepare(`SELECT b.alias_id,b.account_id,b.agent_id,b.tool_actions_json,
      b.provider_connection_sha256,b.status,a.id AS current_alias_id,a.server_id AS alias_server_id,
      a.scope,a.project_id,a.user_id,s.connector_provider AS provider,
      s.provider_connection_id,s.enabled,l.status AS owner_link_status
    FROM agentport_userport_connector_bindings b
    LEFT JOIN connector_aliases a ON a.id=b.alias_id AND a.tenant_id=b.tenant_id AND a.space_id=b.space_id
    LEFT JOIN managed_service_owner_links l ON l.id=b.owner_link_id AND l.tenant_id=b.tenant_id
    JOIN mcp_servers s ON s.id=b.server_id AND s.tenant_id=b.tenant_id AND s.space_id=b.space_id
    WHERE b.tenant_id=? AND b.space_id=? AND b.server_id=?
    ORDER BY b.updated_at DESC LIMIT 100`)
    .bind(input.tenantId, input.spaceId, input.serverId).all<BindingRow>();
  const bindings = serverBindings.results ?? [];
  if (!bindings.length) return { required: false, allowed: true };
  if (!input.aliasId) return { required: true, allowed: false, status: 403, errorCode: "agentport_connector_alias_required" };
  const binding = bindings.find((row) => row.alias_id === input.aliasId);
  if (!binding || binding.status !== "active" || binding.enabled !== 1 || binding.owner_link_status !== "active")
    return { required: true, allowed: false, status: binding?.status === "sync_required" ? 409 : 403,
      errorCode: binding?.status === "sync_required" ? "agentport_connector_resync_required" : "agentport_connector_sync_required" };
  if (binding.current_alias_id !== binding.alias_id || binding.alias_server_id !== input.serverId
    || !["space", "project", "user"].includes(binding.scope)) {
    return { required: true, allowed: false, status: 409, errorCode: "agentport_connector_resync_required" };
  }
  if ((binding.scope === "project" && (!input.projectId || binding.project_id !== input.projectId))
    || (binding.scope === "user" && (!input.userId || binding.user_id !== input.userId))) {
    return { required: true, allowed: false, status: 403, errorCode: "agentport_connector_alias_scope_denied" };
  }
  const providerRefHash = await sha256(binding.provider_connection_id ?? `direct:${input.serverId}`);
  if (providerRefHash !== binding.provider_connection_sha256 || input.provider !== binding.provider) {
    await env.PLATFORM_DB.prepare(`UPDATE agentport_userport_connector_bindings SET status='sync_required',updated_at=?
      WHERE tenant_id=? AND space_id=? AND alias_id=? AND status='active'`)
      .bind(new Date().toISOString(), input.tenantId, input.spaceId, input.aliasId).run();
    return { required: true, allowed: false, status: 409, errorCode: "agentport_connector_resync_required" };
  }
  let actions: Array<{ toolName: string; action: string }>;
  try {
    const parsed: unknown = JSON.parse(binding.tool_actions_json);
    if (!Array.isArray(parsed)) throw new Error("invalid");
    actions = parsed as Array<{ toolName: string; action: string }>;
    if (actions.some((entry) => !entry || typeof entry.toolName !== "string" || typeof entry.action !== "string")) throw new Error("invalid");
  } catch { return { required: true, allowed: false, status: 503, errorCode: "agentport_connector_manifest_invalid" }; }
  const selected = actions.find((entry) => entry.toolName === input.toolName);
  if (!selected) return { required: true, allowed: false, status: 403, errorCode: "agentport_connector_operation_not_selected" };
  if (!env.AGENTPORT_WORKER) return { required: true, allowed: false, status: 503, errorCode: "agentport_authorization_unavailable" };
  const requestHash = await sha256(JSON.stringify(input.requestBody));
  const authorizationRef = await sha256(JSON.stringify([input.tenantId, input.spaceId, binding.account_id,
    input.runId || crypto.randomUUID(), selected.action, requestHash]));
  let response: Response;
  try {
    response = await env.AGENTPORT_WORKER.fetch(new Request(
      `https://agentport.internal/internal/agentport/accounts/${encodeURIComponent(binding.account_id)}/actions/authorize`,
      { method: "POST", headers: { "content-type": "application/json", "x-agentport-tenant-id": input.tenantId,
        "x-agentport-actor-role": "client_system", "x-agentport-actor-id": input.tenantId,
        "x-agentport-internal-token": await mintInternalToken(env.PLATFORM_SECRET, input.tenantId) },
        body: JSON.stringify({ agentId: binding.agent_id, action: selected.action, resourceRef: binding.alias_id,
          idempotencyKey: `upc_${authorizationRef.slice(0, 48)}` }) },
    ));
  } catch { return { required: true, allowed: false, status: 503, errorCode: "agentport_authorization_unavailable" }; }
  const result = await readBoundedResponseJson<{ decision?: unknown; error_code?: unknown }>(response, 64 * 1024)
    .catch(() => ({} as { decision?: unknown; error_code?: unknown }));
  if (!response.ok || result.decision !== "allow") {
    const denied = response.status === 403 || response.status === 404 || response.status === 422;
    return { required: true, allowed: false, status: denied ? 403 : 503,
      errorCode: denied ? "agentport_connector_action_denied" : "agentport_authorization_unavailable" };
  }
  return { required: true, allowed: true };
}
