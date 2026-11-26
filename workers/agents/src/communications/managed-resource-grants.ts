// MS-44 (V-spec MR-OS-4/5): an owner-approved AgentPort grant on a reused Managed resource, behind MANAGED_RESOURCES_PANEL_ENABLED.
// Authorization (owner/admin, not-found shape) is the route's job. A template never reaches this module on its own: the Spaces
// approval route calls it once per approved role, with agents the approver named. No provider credential ever leaves this module.
import { mintInternalToken } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";

const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ACTION = /^[A-Za-z0-9._:-]{1,160}$/;

export class ResourceGrantError extends Error {
  constructor(readonly code: "bad_request" | "resource_not_found" | "agent_not_found" | "grant_unavailable" | "grant_failed", readonly status: number) {
    super(code); this.name = "ResourceGrantError";
  }
}

export async function grantManagedResourceToAgent(
  env: AgentsEnv,
  scope: Pick<CommunicationScope, "tenantId" | "spaceId" | "userId">,
  input: { resourceId: string; agentId: string; actions: string[] },
): Promise<{ resourceId: string; agentId: string; actions: string[] }> {
  if (!ID.test(input.resourceId) || !ID.test(input.agentId) || !Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 10
    || input.actions.some((action) => typeof action !== "string" || !ACTION.test(action))) throw new ResourceGrantError("bad_request", 400);
  const actions = [...new Set(input.actions)].sort();
  const db = env.PLATFORM_DB;
  const resource = await db.prepare(`SELECT agentport_account_id FROM managed_service_accounts
    WHERE id=? AND tenant_id=? AND space_id=? AND lifecycle_state NOT IN ('revoked','retired')`)
    .bind(input.resourceId, scope.tenantId, scope.spaceId).first<{ agentport_account_id: string | null }>();
  if (!resource) throw new ResourceGrantError("resource_not_found", 404);
  // A resource with no AgentPort account cannot be granted yet; the caller records the grant as deferred.
  if (!resource.agentport_account_id) throw new ResourceGrantError("grant_unavailable", 409);
  const agent = await db.prepare(`SELECT host_resource_id FROM agentport_agents WHERE id=? AND tenant_id=? AND status='active' AND principal_id IN
    (SELECT id FROM agentport_principals WHERE tenant_id=? AND principal_type='organization' AND external_id=?)`)
    .bind(input.agentId, scope.tenantId, scope.tenantId, scope.tenantId).first<{ host_resource_id: string | null }>();
  const host = agent?.host_resource_id ?? "";
  if (!agent || !(host === scope.spaceId || host === `space-assistant:${scope.spaceId}` || host.startsWith("project:")))
    throw new ResourceGrantError("agent_not_found", 404);
  let response: Response;
  try {
    response = await env.AGENTPORT_WORKER.fetch(new Request(
      `https://agentport.internal/internal/agentport/accounts/${encodeURIComponent(resource.agentport_account_id)}/grants`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentport-tenant-id": scope.tenantId,
          "x-agentport-actor-id": scope.userId,
          "x-agentport-actor-role": "agentport_api",
          "x-agentport-owner-id": scope.tenantId,
          "x-agentport-owner-type": "organization",
          "x-agentport-scopes": "api:access",
          "x-agentport-host-resource-id": `space-assistant:${scope.spaceId}`,
          "x-agentport-internal-token": await mintInternalToken(env.PLATFORM_SECRET, scope.tenantId),
        },
        body: JSON.stringify({ agentId: input.agentId, grantedBy: scope.userId, permissions: actions }),
      },
    ));
  } catch { throw new ResourceGrantError("grant_failed", 502); }
  if (!response.ok) throw new ResourceGrantError("grant_failed", 502);
  return { resourceId: input.resourceId, agentId: input.agentId, actions };
}
