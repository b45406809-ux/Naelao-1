// MS-47 item 4: parsers and the approval body builder for template resource proposals
// (Spaces route `GET|POST /spaces/:id/template-resource-proposals`, MS-44). The server re-checks everything: this only shapes what the
// owner chose. Nothing is provisioned, spent or granted until the owner presses approve, and a price is sent only as the amount the
// owner saw (the server refuses with `price_changed` if it moved).
export type ProposalStatus = "proposed" | "approving" | "uncertain";
export type TemplateResourceProposal = {
  id: string;
  requirementKey: string;
  resourceType: string;
  required: boolean;
  status: string;
  capabilities: string[];
  grants: Array<{ roleKey: string; actions: string[] }>;
};

const rec = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const str = (value: unknown) => (typeof value === "string" && value ? value : null);
const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];

export function parseTemplateResourceProposals(value: unknown): TemplateResourceProposal[] {
  const list = rec(value)?.proposals;
  if (!Array.isArray(list)) return [];
  const out: TemplateResourceProposal[] = [];
  for (const item of list) {
    const p = rec(item);
    const id = str(p?.id), requirementKey = str(p?.requirement_key), resourceType = str(p?.resource_type), status = str(p?.status);
    if (!p || !id || !requirementKey || !resourceType || !status) continue;
    const grants = Array.isArray(p.proposed_grants) ? p.proposed_grants.flatMap((g) => {
      const grant = rec(g), roleKey = str(grant?.roleKey);
      return grant && roleKey ? [{ roleKey, actions: strings(grant.actions) }] : [];
    }) : [];
    out.push({ id, requirementKey, resourceType, required: p.required === true, status, capabilities: strings(p.capabilities), grants });
  }
  return out;
}

export type ProposalChoice =
  | { kind: "reuse"; resourceId: string }
  | { kind: "create"; offeringId: string; region: string; minMonthlyCredits: number; initialCredits: number }
  | { kind: "skip" };

/** `agentIdsByRole` holds the raw text the owner typed per role (comma or space separated); empty roles are dropped. */
export function buildProposalDecision(proposal: Pick<TemplateResourceProposal, "id">, choice: ProposalChoice, agentIdsByRole: Record<string, string> = {}): Record<string, unknown> {
  if (choice.kind === "skip") return { id: proposal.id, decision: "skip" };
  const grant_agent_ids: Record<string, string[]> = {};
  for (const [role, text] of Object.entries(agentIdsByRole)) {
    const ids = [...new Set(text.split(/[\s,]+/).filter(Boolean))].slice(0, 10);
    if (ids.length) grant_agent_ids[role] = ids;
  }
  return {
    id: proposal.id, decision: "approve",
    choice: choice.kind === "reuse"
      ? { kind: "reuse", resource_id: choice.resourceId }
      : { kind: "create", offering_id: choice.offeringId, region: choice.region,
        acknowledged_min_monthly_credits: choice.minMonthlyCredits, acknowledged_initial_credits: choice.initialCredits },
    ...(Object.keys(grant_agent_ids).length ? { grant_agent_ids } : {}),
  };
}

export type GrantOutcomeView = { roleKey: string; agentId: string; status: "granted" | "deferred" | "failed"; reason: string | null };

export function parseDecisionResult(value: unknown): { status: string; grants: GrantOutcomeView[] } | null {
  const root = rec(value), status = str(root?.status);
  if (!root || !status) return null;
  const grants = Array.isArray(root.grants) ? root.grants.flatMap((g): GrantOutcomeView[] => {
    const grant = rec(g), roleKey = str(grant?.role_key), agentId = str(grant?.agent_id);
    const state = grant?.status === "granted" || grant?.status === "deferred" || grant?.status === "failed" ? grant.status : null;
    return grant && roleKey && agentId && state ? [{ roleKey, agentId, status: state, reason: str(grant.reason) }] : [];
  }) : [];
  return { status, grants };
}

const ERROR_TEXT: Record<string, string> = {
  price_changed: "The price changed after you saw it. Review the new price and approve again.",
  proposal_already_decided: "This was already decided.",
  required_resource_cannot_be_skipped: "This resource is required, so it cannot be skipped.",
  outcome_unknown: "The provider did not confirm. Nothing will be retried automatically; check the Resources list before trying again.",
  resource_unavailable: "That resource is no longer available.",
  plan_not_eligible: "Your plan does not include this resource.",
  invalid_grant_role: "One of the access roles is not part of this template.",
};
export function proposalErrorText(code: string | null | undefined): string {
  return (code && ERROR_TEXT[code]) || "That did not work. Try again.";
}
