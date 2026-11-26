"use client";

import * as React from "react";
import { ApiError, apiFetch, assistantMailApi, type SessionCredentials } from "@/lib/api";
import { describeComponent, parseManagedResources, parseResourceOptions, resourceTitle, type ManagedResource, type ResourceOptionsView } from "@/lib/managed-resources";
import {
  buildProposalDecision, parseDecisionResult, parseTemplateResourceProposals, proposalErrorText,
  type ProposalChoice, type TemplateResourceProposal,
} from "@/lib/template-resource-proposals";

type Pick = "reuse" | "create" | "skip";

/** One pending proposal: the owner picks reuse, create (with the price shown) or skip, optionally names agents, then approves. */
function ProposalCard({ proposal, spaceId, session, resources, onDone }: {
  proposal: TemplateResourceProposal; spaceId: string; session: SessionCredentials; resources: ManagedResource[]; onDone: () => void;
}) {
  const reusable = resources.filter((r) => r.resourceType === proposal.resourceType && r.status === "active");
  const [options, setOptions] = React.useState<ResourceOptionsView | null>(null);
  const [pick, setPick] = React.useState<Pick>(reusable.length ? "reuse" : "create");
  const [resourceId, setResourceId] = React.useState(reusable[0]?.id ?? "");
  const [offeringId, setOfferingId] = React.useState("");
  const [agents, setAgents] = React.useState<Record<string, string>>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let current = true;
    assistantMailApi<unknown>(spaceId, session, { action: "resource-options", resource_type: proposal.resourceType, access_mode: "managed" })
      .then((result) => { if (!current) return; const parsed = parseResourceOptions(result); setOptions(parsed); setOfferingId(parsed.selectedOfferingId ?? parsed.options[0]?.offeringId ?? ""); })
      .catch(() => { if (current) setOptions({ options: [], selectedOfferingId: null, reason: "" }); });
    return () => { current = false; };
  }, [spaceId, session, proposal.resourceType]);

  const offering = options?.options.find((o) => o.offeringId === offeringId);
  const choice: ProposalChoice | null = pick === "skip" ? { kind: "skip" }
    : pick === "reuse" ? (resourceId ? { kind: "reuse", resourceId } : null)
      : offering ? { kind: "create", offeringId: offering.offeringId, region: offering.region, minMonthlyCredits: offering.minMonthlyCredits, initialCredits: offering.initialCredits } : null;

  const decide = async () => {
    if (!choice) return;
    setBusy(true); setMessage(null);
    try {
      const result = parseDecisionResult(await apiFetch<unknown>(`/v1/spaces/${encodeURIComponent(spaceId)}/template-resource-proposals`,
        { session, method: "POST", body: JSON.stringify(buildProposalDecision(proposal, choice, agents)) }));
      const deferred = result?.grants.filter((g) => g.status !== "granted").length ?? 0;
      setMessage(deferred ? `Done. ${deferred} access grant${deferred === 1 ? " was" : "s were"} not applied.` : "Done.");
      onDone();
    } catch (error) { setMessage(proposalErrorText(error instanceof ApiError ? error.errorCode : null)); } finally { setBusy(false); }
  };

  return (
    <li className="settings-row-sub" data-testid="template-resource-proposal">
      <strong>{proposal.requirementKey}</strong> — {proposal.resourceType.replaceAll("_", " ")}, {proposal.required ? "required" : "optional"}
      {proposal.status !== "proposed" && <div>Status: {proposal.status.replaceAll("_", " ")}</div>}
      {proposal.status === "proposed" && (
        <div style={{ display: "grid", gap: 6 }}>
          <label>What to do{" "}
            <select value={pick} onChange={(event) => setPick(event.target.value as Pick)}>
              {reusable.length > 0 && <option value="reuse">Use one you already have</option>}
              <option value="create">Add a new Managed resource</option>
              {!proposal.required && <option value="skip">Skip</option>}
            </select>
          </label>
          {pick === "reuse" && (
            <label>Resource{" "}
              <select value={resourceId} onChange={(event) => setResourceId(event.target.value)}>
                {reusable.map((r) => <option key={r.id} value={r.id}>{resourceTitle(r)}</option>)}
              </select>
            </label>
          )}
          {pick === "create" && options && (options.options.length === 0 ? <p>No provider is available for this right now.</p> : (
            <>
              <label>Provider{" "}
                <select value={offeringId} onChange={(event) => setOfferingId(event.target.value)}>
                  {options.options.map((o) => <option key={o.offeringId} value={o.offeringId}>{o.displayName}</option>)}
                </select>
              </label>
              {offering && (
                <div data-testid="proposal-price">
                  <ul>{offering.components.map((component, index) => <li key={index}>{describeComponent(component)}</li>)}</ul>
                  <div>You will pay {offering.initialCredits} credits now and at least {offering.minMonthlyCredits} credits per month.</div>
                </div>
              )}
            </>
          ))}
          {pick !== "skip" && proposal.grants.map((grant) => (
            <label key={grant.roleKey}>Agents that get {grant.roleKey} access ({grant.actions.join(", ") || "no actions"}){" "}
              <input value={agents[grant.roleKey] ?? ""} placeholder="Agent ids, optional" onChange={(event) => setAgents((value) => ({ ...value, [grant.roleKey]: event.target.value }))} />
            </label>
          ))}
          <div><button type="button" disabled={busy || !choice} onClick={() => void decide()}>{pick === "skip" ? "Skip this resource" : "Approve"}</button></div>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </li>
  );
}

/** MS-47: owner/admin review of the resources a template asks for. Renders nothing while the server flag is off (404), for non-admins, or when none are pending. */
export function TemplateResourceProposals({ spaceId, session }: { spaceId: string; session: SessionCredentials }) {
  const [proposals, setProposals] = React.useState<TemplateResourceProposal[] | null>(null);
  const [resources, setResources] = React.useState<ManagedResource[]>([]);
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    let current = true;
    apiFetch<unknown>(`/v1/spaces/${encodeURIComponent(spaceId)}/template-resource-proposals`, { session })
      .then(async (result) => {
        const parsed = parseTemplateResourceProposals(result);
        const listed = parsed.length ? await assistantMailApi<unknown>(spaceId, session, { action: "managed-resources" }).then(parseManagedResources).catch(() => []) : [];
        if (current) { setProposals(parsed); setResources(listed); }
      })
      .catch(() => { if (current) setProposals(null); });
    return () => { current = false; };
  }, [spaceId, session, reload]);
  if (!proposals || proposals.length === 0) return null;
  return (
    <div className="settings-block" data-testid="template-resource-proposals">
      <div className="settings-row-label">Resources this template needs</div>
      <p className="settings-row-sub">Nothing is added, charged or shared with an agent until you approve it here.</p>
      <ul style={{ display: "grid", gap: 12, listStyle: "none", padding: 0 }}>
        {proposals.map((proposal) => (
          <ProposalCard key={proposal.id} proposal={proposal} spaceId={spaceId} session={session} resources={resources} onDone={() => setReload((value) => value + 1)} />
        ))}
      </ul>
    </div>
  );
}
