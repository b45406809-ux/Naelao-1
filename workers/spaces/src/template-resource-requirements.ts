// MS-44 (V-spec MD-11, MR-OS-4/5): template resource requirements behind TEMPLATE_RESOURCE_REQUIREMENTS_ENABLED.
// Activation only LISTS options and stores pending proposals. Nothing is provisioned, spent or granted until an owner/admin approves
// one proposal; approval goes through the agents worker's MS-43 quote and provision actions (an internal HMAC call) and, for a reused
// resource, an AgentPort grant to agents the approver names. A template can never name the agent or create spend on its own.
import { mintInternalToken } from "@naelao/http";
import type { BlueprintResourceRequirementV1, SpaceBlueprint } from "@naelao/agent-sdk";

export interface TemplateResourceEnv {
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  AGENTS_WORKER?: Fetcher;
  TEMPLATE_RESOURCE_REQUIREMENTS_ENABLED?: string;
}
export interface TemplateResourceCaller { tenantId: string; spaceId: string; userId: string; role: string }

export const templateResourceRequirementsEnabled = (env: Pick<TemplateResourceEnv, "TEMPLATE_RESOURCE_REQUIREMENTS_ENABLED">) =>
  env.TEMPLATE_RESOURCE_REQUIREMENTS_ENABLED === "true";

export type ResourceRequirementOption =
  | { kind: "reuse"; resource_id: string; display_name: string | null; region: string | null; access_mode: string | null; price: null }
  | { kind: "create_managed"; offering_id: string; display_name: string; region: string; min_monthly_credits: number; initial_credits: number;
      components: unknown[]; recommended: boolean; reason: string | null }
  | { kind: "connect_byok"; approvable: false; reason: "byok_connection_unavailable" }
  | { kind: "skip" };

export interface ResourceRequirementPreview {
  key: string; resource_type: string; required: boolean; capabilities: string[]; preferred_access_mode: "managed" | "byok" | null;
  proposed_grants: Array<{ roleKey: string; actions: string[] }>;
  options: ResourceRequirementOption[];
  create_unavailable_reason: string | null;
  /** The preview never provisions, spends or grants. */
  spend_applied: false; grants_applied: false;
}

async function agentsCall(env: TemplateResourceEnv, caller: TemplateResourceCaller, method: "GET" | "POST", body: Record<string, unknown>): Promise<Response | null> {
  if (!env.AGENTS_WORKER) return null;
  const base = `http://agents/spaces/${encodeURIComponent(caller.spaceId)}/assistant-communications`;
  const headers: Record<string, string> = {
    "x-naelao-tenant-id": caller.tenantId, "x-naelao-user-id": caller.userId, "x-naelao-role": caller.role,
    "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, caller.tenantId),
  };
  try {
    if (method === "GET") {
      const query = new URLSearchParams(Object.entries(body).flatMap(([key, value]): Array<[string, string]> => typeof value === "string" ? [[key, value]] : []));
      return await env.AGENTS_WORKER.fetch(new Request(`${base}?${query}`, { headers }));
    }
    return await env.AGENTS_WORKER.fetch(new Request(base, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }));
  } catch { return null; }
}

/** Per requirement: reuse an existing compatible resource first, then create Managed with prices, then connect, then skip if optional. */
export async function buildResourceRequirementPreview(env: TemplateResourceEnv, caller: TemplateResourceCaller, blueprint: SpaceBlueprint): Promise<ResourceRequirementPreview[]> {
  const requirements = blueprint.resourceRequirements ?? [];
  const previews: ResourceRequirementPreview[] = [];
  for (const requirement of requirements) {
    // Compatibility is the resource type in this Space; the managed_resources view carries no capability list yet.
    const existing = (await env.PLATFORM_DB.prepare(`SELECT id,display_name,region,access_mode FROM managed_resources
      WHERE tenant_id=? AND space_id=? AND resource_type=? AND lifecycle_state='active' ORDER BY created_at DESC,id LIMIT 20`)
      .bind(caller.tenantId, caller.spaceId, requirement.resourceType).all<{ id: string; display_name: string | null; region: string | null; access_mode: string | null }>()).results ?? [];
    const reuse: ResourceRequirementOption[] = existing.map((row) => ({ kind: "reuse", resource_id: row.id, display_name: row.display_name, region: row.region, access_mode: row.access_mode, price: null }));
    let create: ResourceRequirementOption[] = [];
    let createUnavailable: string | null = null;
    const response = await agentsCall(env, caller, "GET", { action: "resource-options", resource_type: requirement.resourceType, access_mode: "managed" });
    if (response?.ok) {
      const result = await response.json<{ options?: Array<Record<string, unknown>>; selectedOfferingId?: string | null; reason?: string }>().catch(() => null);
      create = (result?.options ?? []).flatMap((option) => typeof option.offeringId === "string" && typeof option.displayName === "string" && typeof option.region === "string"
        && Number.isSafeInteger(option.minMonthlyCredits) && Number.isSafeInteger(option.initialCredits)
        ? [{ kind: "create_managed" as const, offering_id: option.offeringId, display_name: option.displayName, region: option.region,
          min_monthly_credits: option.minMonthlyCredits as number, initial_credits: option.initialCredits as number,
          components: Array.isArray(option.components) ? option.components : [], recommended: option.offeringId === result?.selectedOfferingId,
          reason: option.offeringId === result?.selectedOfferingId && typeof result?.reason === "string" ? result.reason : null }] : []);
      if (!create.length) createUnavailable = "no_eligible_offering";
    } else createUnavailable = "managed_options_unavailable";
    const byok: ResourceRequirementOption = { kind: "connect_byok", approvable: false, reason: "byok_connection_unavailable" };
    const acquire = requirement.preferredAccessMode === "byok" ? [byok, ...create] : [...create, byok];
    previews.push({
      key: requirement.key, resource_type: requirement.resourceType, required: requirement.required, capabilities: requirement.capabilities ?? [],
      preferred_access_mode: requirement.preferredAccessMode ?? null, proposed_grants: requirement.grants ?? [],
      options: [...reuse, ...acquire, ...(requirement.required ? [] : [{ kind: "skip" as const }])],
      create_unavailable_reason: createUnavailable, spend_applied: false, grants_applied: false,
    });
  }
  return previews;
}

export function proposalsFromRequirements(requirements: BlueprintResourceRequirementV1[]) {
  return requirements.map((requirement) => ({
    requirement_key: requirement.key, resource_type: requirement.resourceType, required: requirement.required, capabilities: requirement.capabilities ?? [],
    preferred_access_mode: requirement.preferredAccessMode ?? null, grants: requirement.grants ?? [],
  }));
}

type Choice =
  | { kind: "reuse"; resource_id: string }
  | { kind: "create"; offering_id: string; region: string; local_part?: string; display_name?: string; acknowledged_min_monthly_credits: number; acknowledged_initial_credits: number };
export type ResourceProposalDecision =
  | { id: string; decision: "skip" }
  | { id: string; decision: "approve"; choice: Choice; grant_agent_ids: Record<string, string[]> };

const ID = /^[A-Za-z0-9._:-]{1,200}$/;
export function parseResourceProposalDecision(raw: unknown): ResourceProposalDecision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.id !== "string" || !ID.test(body.id)) return null;
  if (body.decision === "skip") return Object.keys(body).every((k) => k === "id" || k === "decision") ? { id: body.id, decision: "skip" } : null;
  if (body.decision !== "approve" || !body.choice || typeof body.choice !== "object" || Array.isArray(body.choice)) return null;
  const choice = body.choice as Record<string, unknown>;
  let parsed: Choice;
  if (choice.kind === "reuse") {
    if (typeof choice.resource_id !== "string" || !ID.test(choice.resource_id)) return null;
    parsed = { kind: "reuse", resource_id: choice.resource_id };
  } else if (choice.kind === "create") {
    if (typeof choice.offering_id !== "string" || !ID.test(choice.offering_id) || typeof choice.region !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(choice.region)
      || !Number.isSafeInteger(choice.acknowledged_min_monthly_credits) || !Number.isSafeInteger(choice.acknowledged_initial_credits)
      || (choice.local_part !== undefined && typeof choice.local_part !== "string") || (choice.display_name !== undefined && typeof choice.display_name !== "string")) return null;
    parsed = { kind: "create", offering_id: choice.offering_id, region: choice.region,
      ...(choice.local_part !== undefined ? { local_part: choice.local_part as string } : {}), ...(choice.display_name !== undefined ? { display_name: choice.display_name as string } : {}),
      acknowledged_min_monthly_credits: choice.acknowledged_min_monthly_credits as number, acknowledged_initial_credits: choice.acknowledged_initial_credits as number };
  } else return null;
  const grantAgentIds: Record<string, string[]> = {};
  if (body.grant_agent_ids !== undefined) {
    if (!body.grant_agent_ids || typeof body.grant_agent_ids !== "object" || Array.isArray(body.grant_agent_ids)) return null;
    for (const [role, agents] of Object.entries(body.grant_agent_ids as Record<string, unknown>)) {
      if (!Array.isArray(agents) || agents.length > 10 || agents.some((a) => typeof a !== "string" || !ID.test(a))) return null;
      grantAgentIds[role] = [...new Set(agents as string[])];
    }
  }
  return { id: body.id, decision: "approve", choice: parsed, grant_agent_ids: grantAgentIds };
}

type DoStub = { fetch(request: Request): Promise<Response> };
type ProposalView = { id: string; resource_type: string; required: boolean; status: string; proposed_grants: Array<{ roleKey: string; actions: string[] }> };
interface GrantOutcome { role_key: string; agent_id: string; status: "granted" | "deferred" | "failed"; reason?: string }
export interface DecisionResult { status: number; body: Record<string, unknown> }

const notFound = (): DecisionResult => ({ status: 404, body: { error_code: "not_found" } });

/** Approval of ONE proposal. The SpaceDO claim makes concurrent or repeated approvals provision at most once. */
export async function decideTemplateResourceProposal(env: TemplateResourceEnv, caller: TemplateResourceCaller, stub: DoStub, decision: ResourceProposalDecision): Promise<DecisionResult> {
  const actor = new URLSearchParams({ actor_id: caller.userId });
  const doCall = (path: string, body: unknown) => stub.fetch(new Request(`http://space-do/template-resource-proposals/${path}?${actor}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const listed = await stub.fetch(new Request(`http://space-do/template-resource-proposals?${new URLSearchParams({ id: decision.id })}`));
  const pending = listed.ok ? (await listed.json<{ proposals?: ProposalView[] }>().catch(() => ({} as { proposals?: ProposalView[] }))).proposals ?? [] : [];
  const proposal = pending.find((p) => p.id === decision.id);
  if (!proposal) return notFound();
  if (proposal.status !== "proposed") return { status: 409, body: { error_code: "proposal_already_decided", status: proposal.status } };

  if (decision.decision === "skip") {
    if (proposal.required) return { status: 409, body: { error_code: "required_resource_cannot_be_skipped" } };
    const done = await doCall("finish", { id: proposal.id, outcome: "skipped", result: { choice: "skip" } });
    return done.ok ? { status: 200, body: { id: proposal.id, status: "skipped" } } : { status: done.status === 409 ? 409 : 404, body: { error_code: done.status === 409 ? "proposal_already_decided" : "not_found" } };
  }

  const grantedRoles = new Set(proposal.proposed_grants.map((g) => g.roleKey));
  if (Object.keys(decision.grant_agent_ids).some((role) => !grantedRoles.has(role))) return { status: 400, body: { error_code: "invalid_grant_role" } };

  const claimed = await doCall("claim", { id: proposal.id });
  if (!claimed.ok) return claimed.status === 409 ? { status: 409, body: { error_code: "proposal_already_decided" } } : notFound();
  const release = async () => { await doCall("finish", { id: proposal.id, outcome: "released" }).catch(() => undefined); };

  const choice = decision.choice;
  let resourceId: string | null = null, operationId: string | null = null;
  if (choice.kind === "reuse") {
    const row = await env.PLATFORM_DB.prepare(`SELECT id FROM managed_resources WHERE id=? AND tenant_id=? AND space_id=? AND resource_type=? AND lifecycle_state='active'`)
      .bind(choice.resource_id, caller.tenantId, caller.spaceId, proposal.resource_type).first<{ id: string }>();
    if (!row) { await release(); return { status: 409, body: { error_code: "resource_unavailable" } }; }
    resourceId = row.id;
  } else {
    // Quote first (no spend), compare with the price the owner saw, then provision through the MS-43 path.
    const quoted = await agentsCall(env, caller, "POST", { action: "resource-quote", resource_type: proposal.resource_type, access_mode: "managed", offering_id: choice.offering_id,
      region: choice.region, ...(choice.local_part ? { local_part: choice.local_part } : {}), ...(choice.display_name ? { display_name: choice.display_name } : {}) });
    if (!quoted?.ok) {
      await release();
      const code = quoted ? (await quoted.json<{ error_code?: string }>().catch(() => ({} as { error_code?: string }))).error_code ?? "quote_failed" : "agents_unavailable";
      return { status: quoted && quoted.status < 500 ? quoted.status : 503, body: { error_code: code } };
    }
    const quote = (await quoted.json<{ quote?: { quoteId?: string; minMonthlyCredits?: number; credits?: number } }>().catch(() => ({} as { quote?: { quoteId?: string; minMonthlyCredits?: number; credits?: number } }))).quote;
    if (!quote?.quoteId) { await release(); return { status: 503, body: { error_code: "quote_failed" } }; }
    if (quote.minMonthlyCredits !== choice.acknowledged_min_monthly_credits || quote.credits !== choice.acknowledged_initial_credits) {
      await release();
      return { status: 409, body: { error_code: "price_changed", min_monthly_credits: quote.minMonthlyCredits, initial_credits: quote.credits } };
    }
    const provisioned = await agentsCall(env, caller, "POST", { action: "resource-provision", quote_id: quote.quoteId, offering_id: choice.offering_id, region: choice.region,
      ...(choice.local_part ? { local_part: choice.local_part } : {}), ...(choice.display_name ? { display_name: choice.display_name } : {}) });
    // A lost response after the provision call was sent is ambiguous: never retry blindly.
    if (!provisioned) {
      await doCall("finish", { id: proposal.id, outcome: "uncertain", result: { choice: "create", error_code: "outcome_unknown", quote_id: quote.quoteId } });
      return { status: 502, body: { error_code: "outcome_unknown" } };
    }
    if (!provisioned.ok) {
      const code = (await provisioned.json<{ error_code?: string }>().catch(() => ({} as { error_code?: string }))).error_code ?? "provision_failed";
      if (code === "outcome_unknown") {
        await doCall("finish", { id: proposal.id, outcome: "uncertain", result: { choice: "create", error_code: code, quote_id: quote.quoteId } });
        return { status: 502, body: { error_code: code } };
      }
      await release();
      return { status: provisioned.status >= 500 ? 502 : provisioned.status, body: { error_code: code } };
    }
    operationId = (await provisioned.json<{ operationId?: string }>().catch(() => ({} as { operationId?: string }))).operationId ?? null;
  }

  // Grants only after approval, only for agents the approver named, only on a resource that already has an AgentPort account.
  const grants: GrantOutcome[] = [];
  for (const proposed of proposal.proposed_grants) {
    for (const agentId of decision.grant_agent_ids[proposed.roleKey] ?? []) {
      if (!resourceId) { grants.push({ role_key: proposed.roleKey, agent_id: agentId, status: "deferred", reason: "resource_not_connected_to_agentport" }); continue; }
      const granted = await agentsCall(env, caller, "POST", { action: "resource-grant", resource_id: resourceId, agent_id: agentId, actions: proposed.actions });
      if (granted?.ok) grants.push({ role_key: proposed.roleKey, agent_id: agentId, status: "granted" });
      else {
        const code = granted ? (await granted.json<{ error_code?: string }>().catch(() => ({} as { error_code?: string }))).error_code : undefined;
        grants.push({ role_key: proposed.roleKey, agent_id: agentId, status: code === "grant_unavailable" ? "deferred" : "failed", reason: code ?? "grant_failed" });
      }
    }
  }
  const result = { choice: choice.kind, ...(resourceId ? { resource_id: resourceId } : {}), ...(operationId ? { operation_id: operationId } : {}), grants };
  await doCall("finish", { id: proposal.id, outcome: "approved", result });
  return { status: 201, body: { id: proposal.id, status: "approved", ...result } };
}
