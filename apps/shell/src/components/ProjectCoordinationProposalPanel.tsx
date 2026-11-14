"use client";

import * as React from "react";
import type { SpaceCoordinationAudienceV2, SpaceCoordinationDraftV2, SpaceCoordinationPublicationProposal } from "@naelao/agent-sdk";
import type { SessionCredentials } from "@/lib/api";
import { ApiError } from "@/lib/request";
import { listProjectCoordinationProposals, submitProjectCoordinationProposal, withdrawProjectCoordinationProposal } from "@/lib/api";

export function ProjectCoordinationProposalPanel({ spaceId, projectId, session }: {
  spaceId: string;
  projectId: string;
  session: SessionCredentials;
}) {
  const [proposals, setProposals] = React.useState<SpaceCoordinationPublicationProposal[]>([]);
  const [capabilityKey, setCapabilityKey] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [audience, setAudience] = React.useState<SpaceCoordinationAudienceV2>("space_admins");
  const [expiresOn, setExpiresOn] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [available, setAvailable] = React.useState(true);
  const requestIdentity = React.useRef<{ fingerprint: string; requestId: string } | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const page = await listProjectCoordinationProposals(spaceId, projectId, session);
      setProposals(page.proposals);
      setAvailable(true);
      setError(null);
    } catch {
      setAvailable(false);
      setError("Publication proposals are available only to Space owners or project owners and editors.");
    }
  }, [spaceId, projectId, session]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const audienceLabel = audience === "space_members" ? "all active Space members" : "Space owners and administrators";
  const draft: SpaceCoordinationDraftV2 = {
    schema_version: 2,
    capability_key: capabilityKey,
    label,
    ...(description.trim() ? { description } : {}),
    audience,
    expires_at: expiresOn ? `${expiresOn}T23:59:59.999Z` : null,
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!confirmed || busy) return;
    setBusy(true); setError(null); setNotice(null);
    const fingerprint = JSON.stringify(draft);
    const priorRequest = requestIdentity.current;
    const requestId = priorRequest?.fingerprint === fingerprint ? priorRequest.requestId : crypto.randomUUID();
    requestIdentity.current = { fingerprint, requestId };
    try {
      await submitProjectCoordinationProposal(spaceId, projectId, session, requestId, draft);
      requestIdentity.current = null;
      setCapabilityKey(""); setLabel(""); setDescription(""); setAudience("space_admins"); setExpiresOn(""); setConfirmed(false);
      setNotice("The proposal is private to you and Space owners or administrators while pending. It does not grant access.");
      await refresh();
    } catch (submitError) {
      const code = submitError instanceof ApiError ? submitError.errorCode ?? "" : "";
      setError(code.includes("coordination_proposal_limit_reached")
        ? "This Space has reached its pending proposal limit. Ask an administrator to review existing proposals."
        : code.includes("project_manager_required") || code.includes("not_found")
          ? "Only a project owner or editor can submit a proposal for an active project."
          : "The proposal could not be saved. Review your role and the bounded fact fields, then try again.");
    } finally { setBusy(false); }
  }

  async function withdraw(proposal: SpaceCoordinationPublicationProposal) {
    if (busy || proposal.status !== "pending") return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await withdrawProjectCoordinationProposal(spaceId, projectId, session, proposal.proposal_id, proposal.revision);
      setNotice("The pending proposal was withdrawn.");
      await refresh();
    } catch {
      setError("The proposal changed or could not be withdrawn. Reload the current review state and try again.");
      await refresh();
    } finally { setBusy(false); }
  }

  function proposalAudience(proposal: SpaceCoordinationPublicationProposal) {
    return proposal.draft.audience === "space_members" ? "all active Space members" : "Space owners and administrators";
  }

  if (!available) return <section className="settings-block" aria-labelledby="project-coordination-proposal-heading" style={{ marginTop: 18, padding: 16 }}>
    <div id="project-coordination-proposal-heading" className="settings-row-label">Space fact publication</div>
    <p className="settings-row-sub" role="status" style={{ marginBottom: 0 }}>{error}</p>
  </section>;

  return <section className="settings-block" aria-labelledby="project-coordination-proposal-heading" style={{ marginTop: 18 }}>
    <div style={{ padding: 16 }}>
      <div id="project-coordination-proposal-heading" className="settings-row-label">Propose a Space coordination fact</div>
      <p className="settings-row-sub" style={{ margin: "6px 0 14px" }}>
        Write a small fact explicitly. The pending text is visible only to you and Space owners or administrators. If approved, the selected audience below will see the fact. Publication is advisory and grants no project or service access.
      </p>
      <form onSubmit={event => void submit(event)} style={{ display: "grid", gap: 10, maxWidth: 720 }}>
        <label className="settings-row-sub" htmlFor="coordination-proposal-key">Capability key</label>
        <input id="coordination-proposal-key" value={capabilityKey} onChange={event => { setCapabilityKey(event.target.value); setConfirmed(false); }} maxLength={96} placeholder="official.website" required />
        <label className="settings-row-sub" htmlFor="coordination-proposal-label">Fact label</label>
        <input id="coordination-proposal-label" value={label} onChange={event => { setLabel(event.target.value); setConfirmed(false); }} maxLength={120} placeholder="The Space has an official website" required />
        <label className="settings-row-sub" htmlFor="coordination-proposal-description">Optional explanation</label>
        <textarea id="coordination-proposal-description" value={description} onChange={event => { setDescription(event.target.value); setConfirmed(false); }} maxLength={500} rows={3} />
        <label className="settings-row-sub" htmlFor="coordination-proposal-audience">Audience if approved</label>
        <select id="coordination-proposal-audience" value={audience} onChange={event => { setAudience(event.target.value as SpaceCoordinationAudienceV2); setConfirmed(false); }}>
          <option value="space_admins">Space owners and administrators</option>
          <option value="space_members">All active Space members</option>
        </select>
        <label className="settings-row-sub" htmlFor="coordination-proposal-expiry">Optional expiry (UTC)</label>
        <input id="coordination-proposal-expiry" type="date" value={expiresOn} onChange={event => { setExpiresOn(event.target.value); setConfirmed(false); }} />
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: "var(--text2)" }}>
          <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
          <span>I wrote this fact explicitly and understand that, if approved, it will be visible to {audienceLabel}; it does not authorize anyone to access the source project or service.</span>
        </label>
        <div><button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !confirmed}>{busy ? "Saving…" : "Submit for owner review"}</button></div>
      </form>
    </div>
    {error && <p className="settings-row-sub" role="alert" style={{ padding: "0 16px 12px", color: "var(--danger, #b42318)" }}>{error}</p>}
    {notice && <p className="settings-row-sub" role="status" style={{ padding: "0 16px 12px" }}>{notice}</p>}
    <div className="settings-row-label" style={{ padding: "0 16px 10px" }}>Your proposals</div>
    {proposals.length ? proposals.map(proposal => <article key={proposal.proposal_id} style={{ borderTop: "1px solid var(--border)", padding: 16, display: "flex", justifyContent: "space-between", gap: 12 }}>
      <div>
        <div className="settings-row-label">{proposal.draft.label}</div>
        <div className="settings-row-sub" style={{ marginTop: 4 }}>{proposal.draft.capability_key}{proposal.draft.description ? ` · ${proposal.draft.description}` : ""}</div>
        <div className="settings-row-sub" style={{ marginTop: 4 }}>If approved: {proposalAudience(proposal)} · {proposal.status} · revision {proposal.revision}</div>
        {proposal.status === "approved" && <div className="settings-row-sub" style={{ marginTop: 4 }}>Published fact ID: {proposal.entry_id ?? proposal.proposal_id}. Publication did not grant access.</div>}
      </div>
      {proposal.status === "pending" && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void withdraw(proposal)}>Withdraw</button>}
    </article>) : <p className="settings-row-sub" style={{ padding: "0 16px 14px", margin: 0 }}>No proposals have been submitted from this project.</p>}
  </section>;
}
