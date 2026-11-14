"use client";

import * as React from "react";
import type { SpaceCoordinationAuditEventV2, SpaceCoordinationAudienceV2, SpaceCoordinationDraftV2, SpaceCoordinationEntryV2, SpaceCoordinationPolicyEventV2, SpaceCoordinationPublicationProposal, SpaceCoordinationSingletonPolicyEvent, SpaceCoordinationUseRequest, SpaceCoordinationUseRequestResolution } from "@naelao/agent-sdk";
import type { SessionCredentials } from "@/lib/api";
import { ApiError } from "@/lib/request";
import { amendSpaceCoordination, getSpaceCoordinationPolicy, getSpaceCoordinationSingletonPolicy, listSpaceCoordination, listSpaceCoordinationAuditHistory, listSpaceCoordinationPolicyHistory, listSpaceCoordinationSingletonPolicyHistory, listSpaceCoordinationProposalQueue, listSpaceCoordinationUseRequests, previewSpaceCoordination, publishSpaceCoordination, requestSpaceCoordinationCollaboration, resolveSpaceCoordinationRequest, reviewSpaceCoordinationProposal, revokeSpaceCoordination, updateSpaceCoordinationPolicy, updateSpaceCoordinationSingletonPolicy } from "@/lib/api";

export function SpaceCoordinationPanel({ spaceId, session, canManage }: {
  spaceId: string;
  session: SessionCredentials;
  canManage: boolean;
}) {
  const [entries, setEntries] = React.useState<SpaceCoordinationEntryV2[]>([]);
  const [nextAfter, setNextAfter] = React.useState<string | null>(null);
  const [useRequests, setUseRequests] = React.useState<SpaceCoordinationUseRequest[]>([]);
  const [requestsNextAfter, setRequestsNextAfter] = React.useState<string | null>(null);
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const [proposals, setProposals] = React.useState<SpaceCoordinationPublicationProposal[]>([]);
  const [proposalsNextAfter, setProposalsNextAfter] = React.useState<string | null>(null);
  const [proposalError, setProposalError] = React.useState<string | null>(null);
  const [capabilityKey, setCapabilityKey] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [audience, setAudience] = React.useState<SpaceCoordinationAudienceV2>("space_admins");
  const [expiresOn, setExpiresOn] = React.useState("");
  const [editingEntry, setEditingEntry] = React.useState<SpaceCoordinationEntryV2 | null>(null);
  const [preview, setPreview] = React.useState<{ draft: SpaceCoordinationDraftV2; disclosure: { audience: string; effect: string } } | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const [auditHistory, setAuditHistory] = React.useState<Record<string, { events: SpaceCoordinationAuditEventV2[]; nextAfter: string | null; open: boolean }>>({});
  const [policy, setPolicy] = React.useState<Awaited<ReturnType<typeof getSpaceCoordinationPolicy>> | null>(null);
  const [policyEnabledDraft, setPolicyEnabledDraft] = React.useState(false);
  const [policyConfirmed, setPolicyConfirmed] = React.useState(false);
  const [policyError, setPolicyError] = React.useState<string | null>(null);
  const [policyHistory, setPolicyHistory] = React.useState<{ events: SpaceCoordinationPolicyEventV2[]; nextAfter: string | null; open: boolean } | null>(null);
  const [singletonPolicy, setSingletonPolicy] = React.useState<Awaited<ReturnType<typeof getSpaceCoordinationSingletonPolicy>> | null>(null);
  const [singletonKeysDraft, setSingletonKeysDraft] = React.useState("");
  const [singletonConfirmed, setSingletonConfirmed] = React.useState(false);
  const [singletonError, setSingletonError] = React.useState<string | null>(null);
  const [singletonHistory, setSingletonHistory] = React.useState<{ events: SpaceCoordinationSingletonPolicyEvent[]; nextAfter: string | null; open: boolean } | null>(null);

  React.useEffect(() => {
    const updateClock = () => setNowMs(Date.now());
    const interval = window.setInterval(updateClock, 30_000);
    window.addEventListener("focus", updateClock);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", updateClock); };
  }, []);

  const visibleEntries = entries.map(entry => entry.status === "active" && entry.expires_at && Date.parse(entry.expires_at) <= nowMs
    ? { ...entry, status: "expired" as const } : entry).filter(entry => canManage || entry.status === "active");

  const refresh = React.useCallback(async () => {
    try {
      const page = await listSpaceCoordination(spaceId, { sessionToken: session.sessionToken, endUserId: session.endUserId });
      setEntries(page.entries.filter(entry => canManage || entry.status === "active"));
      setNextAfter(page.next_after);
      setError(null);
    } catch {
      setError("Coordination facts could not be loaded. Try again.");
    }
  }, [spaceId, session.sessionToken, session.endUserId, canManage]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const refreshUseRequests = React.useCallback(async () => {
    try {
      const page = await listSpaceCoordinationUseRequests(spaceId, session);
      setUseRequests(page.requests);
      setRequestsNextAfter(page.next_after);
      setRequestError(null);
    } catch {
      setRequestError("Collaboration requests could not be loaded. Try again.");
    }
  }, [spaceId, session.sessionToken, session.endUserId]);
  React.useEffect(() => { void refreshUseRequests(); }, [refreshUseRequests]);

  const refreshProposalQueue = React.useCallback(async () => {
    if (!canManage) return;
    try {
      const page = await listSpaceCoordinationProposalQueue(spaceId, session);
      setProposals(page.proposals);
      setProposalsNextAfter(page.next_after);
      setProposalError(null);
    } catch {
      setProposalError("Private project publication proposals could not be loaded. Try again.");
    }
  }, [canManage, spaceId, session]);
  React.useEffect(() => { void refreshProposalQueue(); }, [refreshProposalQueue]);

  const refreshPolicy = React.useCallback(async () => {
    if (!canManage) return;
    try {
      const current = await getSpaceCoordinationPolicy(spaceId, session);
      setPolicy(current);
      setPolicyEnabledDraft(current.member_facts_enabled);
      setPolicyError(null);
    } catch {
      setPolicyError("The Space disclosure policy could not be loaded. Try again.");
    }
  }, [canManage, spaceId, session]);

  React.useEffect(() => { void refreshPolicy(); }, [refreshPolicy]);

  const refreshSingletonPolicy = React.useCallback(async () => {
    if (!canManage) return;
    try {
      const current = await getSpaceCoordinationSingletonPolicy(spaceId, session);
      setSingletonPolicy(current);
      setSingletonKeysDraft(current.singleton_capability_keys.join("\n"));
      setSingletonError(null);
    } catch {
      setSingletonError("The Space singleton policy could not be loaded. Try again.");
    }
  }, [canManage, spaceId, session]);

  React.useEffect(() => { void refreshSingletonPolicy(); }, [refreshSingletonPolicy]);

  async function loadMore() {
    if (!nextAfter || busy) return;
    setBusy(true); setError(null);
    try {
      const page = await listSpaceCoordination(spaceId, { sessionToken: session.sessionToken, endUserId: session.endUserId }, nextAfter);
      setEntries(current => [...current, ...page.entries.filter(entry => canManage || entry.status === "active")]);
      setNextAfter(page.next_after);
    } catch {
      setError("More coordination facts could not be loaded. Try again.");
    } finally { setBusy(false); }
  }

  function changed() {
    setPreview(null);
    setConfirmed(false);
    setNotice(null);
  }

  const draft = (): SpaceCoordinationDraftV2 => ({ schema_version: 2, capability_key: capabilityKey, label,
    ...(description.trim() ? { description } : {}), audience,
    expires_at: expiresOn ? `${expiresOn}T23:59:59.999Z` : null });

  function beginEdit(entry: SpaceCoordinationEntryV2) {
    setEditingEntry(entry);
    setCapabilityKey(entry.capability_key);
    setLabel(entry.label);
    setDescription(entry.description ?? "");
    setAudience(entry.audience);
    setExpiresOn(entry.expires_at?.slice(0, 10) ?? "");
    changed();
  }

  function cancelEdit() {
    setEditingEntry(null);
    setCapabilityKey(""); setLabel(""); setDescription(""); setAudience("space_admins"); setExpiresOn("");
    changed();
  }

  function formatConfirmationTime(value: string) {
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime()) ? timestamp.toLocaleString() : value;
  }

  function formatExpiry(value: string | null) {
    if (!value) return "No expiry selected";
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime())
      ? `Expires ${timestamp.toLocaleString(undefined, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`
      : `Expiry: ${value}`;
  }

  async function makePreview() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await previewSpaceCoordination(spaceId, session, draft());
      setPreview({ draft: result.draft, disclosure: result.disclosure });
      setConfirmed(false);
    } catch {
      setError("The fact is invalid or could not be previewed. Check the fields and try again.");
    } finally { setBusy(false); }
  }

  async function publish() {
    if (!preview || !confirmed) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      let updatedEntry: SpaceCoordinationEntryV2 | null = null;
      if (editingEntry) {
        const result = await amendSpaceCoordination(spaceId, session, editingEntry.entry_id, editingEntry.version, preview.draft, true);
        updatedEntry = result.entry;
        setNotice(preview.draft.audience === "space_admins" ? "The approved fact was updated for Space owners and administrators." : "The approved fact was updated for Space members.");
      } else {
        await publishSpaceCoordination(spaceId, session, preview.draft, true);
        setNotice(preview.draft.audience === "space_admins" ? "The approved advisory fact is visible to Space owners and administrators." : "The approved advisory fact is visible to Space members.");
      }
      if (updatedEntry) setEntries(current => current.map(entry => entry.entry_id === updatedEntry!.entry_id ? updatedEntry! : entry));
      setEditingEntry(null); setCapabilityKey(""); setLabel(""); setDescription(""); setAudience("space_admins"); setExpiresOn(""); setPreview(null); setConfirmed(false);
      if (!updatedEntry) await refresh();
      await refreshPolicy();
    } catch (error) {
      setError(error instanceof ApiError && error.errorCode === "coordination_member_facts_disabled"
        ? "Space-member visibility is disabled. Ask an owner or administrator to enable it before publishing this fact."
        : editingEntry ? "The fact changed or could not be updated. Refresh the list and review it again." : "The fact was not published. Review your role and try again.");
    } finally { setBusy(false); }
  }

  async function revoke(entry: SpaceCoordinationEntryV2) {
    const audienceLabel = entry.audience === "space_admins" ? "Space owner and administrator registry" : "Space member registry";
    if (!window.confirm(`Unpublish “${entry.label}”? This removes it from the ${audienceLabel}.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await revokeSpaceCoordination(spaceId, session, entry.entry_id, entry.version);
      setNotice("The fact was unpublished.");
      await refresh();
      await refreshPolicy();
    } catch {
      setError("The fact changed or could not be unpublished. Refresh the list and try again.");
    } finally { setBusy(false); }
  }

  async function requestCollaboration(entry: SpaceCoordinationEntryV2) {
    if (!window.confirm(`Send a collaboration request for “${entry.label}”? Space owners and administrators will see your account identifier. This request does not grant access to any project or service.`)) return;
    setBusy(true); setRequestError(null);
    try {
      await requestSpaceCoordinationCollaboration(spaceId, session, entry.entry_id, true);
      await refreshUseRequests();
    } catch (error) {
      setRequestError(error instanceof ApiError && error.errorCode === "coordination_request_limit_reached"
        ? "This Space has reached its open collaboration request limit. Ask an administrator to review existing requests."
        : "The collaboration request could not be saved. The fact may have changed; refresh and try again.");
    } finally { setBusy(false); }
  }

  async function resolveUseRequest(request: SpaceCoordinationUseRequest, resolution: SpaceCoordinationUseRequestResolution) {
    setBusy(true); setRequestError(null);
    try {
      await resolveSpaceCoordinationRequest(spaceId, session, request.request_id, request.revision, resolution);
      await refreshUseRequests();
    } catch {
      setRequestError("The request changed or could not be updated. Reload the request list and try again.");
    } finally { setBusy(false); }
  }

  async function reviewProposal(proposal: SpaceCoordinationPublicationProposal, action: "approve" | "reject") {
    const audienceName = proposal.draft.audience === "space_members" ? "all active Space members" : "Space owners and administrators";
    const disclosure = action === "approve"
      ? `Publish this exact advisory fact to ${audienceName}?\n\n${proposal.draft.capability_key}\n${proposal.draft.label}${proposal.draft.description ? `\n${proposal.draft.description}` : ""}\n\nThis grants no project or service access.`
      : `Reject the private proposal “${proposal.draft.label}”?`;
    if (!window.confirm(disclosure)) return;
    setBusy(true); setProposalError(null); setNotice(null);
    try {
      await reviewSpaceCoordinationProposal(spaceId, session, proposal.proposal_id, proposal.revision, action, action === "approve" ? proposal.draft : undefined);
      setNotice(action === "approve" ? `The fact was published to ${audienceName}. No project or service access was granted.` : "The proposal was rejected and remains private to its requester and reviewers.");
      await Promise.all([refreshProposalQueue(), refresh(), refreshPolicy()]);
    } catch (error) {
      const code = error instanceof ApiError ? error.errorCode ?? "" : "";
      setProposalError(code.includes("coordination_member_facts_disabled")
        ? "Space-member visibility is disabled. Keep the proposal pending or reject it; an owner must enable member visibility before this audience can be approved."
        : code.includes("coordination_proposal_revision_conflict")
          ? "This proposal changed in another review session. Reload the queue before deciding."
          : "The proposal could not be reviewed. Its current state was preserved.");
      await refreshProposalQueue();
    } finally { setBusy(false); }
  }

  async function loadMoreProposals() {
    if (!canManage || !proposalsNextAfter || busy) return;
    setBusy(true); setProposalError(null);
    try {
      const page = await listSpaceCoordinationProposalQueue(spaceId, session, proposalsNextAfter);
      setProposals(current => [...current, ...page.proposals]);
      setProposalsNextAfter(page.next_after);
    } catch { setProposalError("More publication proposals could not be loaded. Try again."); }
    finally { setBusy(false); }
  }

  async function loadMoreUseRequests() {
    if (!requestsNextAfter || busy) return;
    setBusy(true); setRequestError(null);
    try {
      const page = await listSpaceCoordinationUseRequests(spaceId, session, requestsNextAfter);
      setUseRequests(current => [...current, ...page.requests]);
      setRequestsNextAfter(page.next_after);
    } catch {
      setRequestError("More collaboration requests could not be loaded. Try again.");
    } finally { setBusy(false); }
  }

  async function savePolicy() {
    if (!policy || !policyConfirmed || policyEnabledDraft === policy.member_facts_enabled) return;
    setBusy(true); setPolicyError(null);
    try {
      const updated = await updateSpaceCoordinationPolicy(spaceId, session, policyEnabledDraft, policy.revision, true);
      setPolicy(updated);
      setPolicyEnabledDraft(updated.member_facts_enabled);
      setPolicyConfirmed(false);
      setPolicyHistory(null);
      setNotice(updated.member_facts_enabled
        ? "Space-member visibility is enabled for new coordination facts."
        : "Space-member visibility is disabled for new coordination facts.");
    } catch (error) {
      const code = error instanceof ApiError ? error.errorCode ?? "" : "";
      setPolicyError(code.includes("coordination_member_facts_must_be_unpublished_first")
        ? "Unpublish each active Space-member fact before disabling this policy. Existing facts are never silently hidden."
        : code.includes("coordination_policy_revision_conflict")
          ? "The policy changed in another session. Reload it and review the current setting."
          : "The Space disclosure policy could not be saved. Try again.");
      await refreshPolicy();
    } finally { setBusy(false); }
  }

  async function loadPolicyHistory(after?: string) {
    if (!after && policyHistory?.open) {
      setPolicyHistory({ ...policyHistory, open: false });
      return;
    }
    setBusy(true); setPolicyError(null);
    try {
      const page = await listSpaceCoordinationPolicyHistory(spaceId, session, after);
      setPolicyHistory(current => ({ events: after ? [...(current?.events ?? []), ...page.events] : page.events,
        nextAfter: page.next_after, open: true }));
    } catch {
      setPolicyError("Disclosure policy history could not be loaded. Check your Space role and try again.");
    } finally { setBusy(false); }
  }

  async function saveSingletonPolicy() {
    if (!singletonPolicy || !singletonConfirmed) return;
    const keys = singletonKeysDraft.split(/[\n,]/).map(key => key.trim()).filter(Boolean);
    setBusy(true); setSingletonError(null);
    try {
      const updated = await updateSpaceCoordinationSingletonPolicy(spaceId, session, keys, singletonPolicy.revision, true);
      setSingletonPolicy(updated);
      setSingletonKeysDraft(updated.singleton_capability_keys.join("\n"));
      setSingletonConfirmed(false);
      setSingletonHistory(null);
      setNotice("The Space singleton policy was saved. It applies only to approved coordination facts.");
    } catch (error) {
      const code = error instanceof ApiError ? error.errorCode ?? "" : "";
      setSingletonError(code.includes("coordination_singleton_active_duplicates")
        ? "This key already has multiple active facts. Unpublish or expire duplicates before enabling its singleton rule."
        : code.includes("coordination_singleton_policy_revision_conflict")
          ? "The singleton policy changed in another session. Reload it and review the current setting."
          : "The singleton policy could not be saved. Check that keys are unique, lowercase, and no more than 32.");
      await refreshSingletonPolicy();
    } finally { setBusy(false); }
  }

  async function loadSingletonHistory(after?: string) {
    if (!after && singletonHistory?.open) {
      setSingletonHistory({ ...singletonHistory, open: false });
      return;
    }
    setBusy(true); setSingletonError(null);
    try {
      const page = await listSpaceCoordinationSingletonPolicyHistory(spaceId, session, after);
      setSingletonHistory(current => ({ events: after ? [...(current?.events ?? []), ...page.events] : page.events,
        nextAfter: page.next_after, open: true }));
    } catch {
      setSingletonError("Singleton policy history could not be loaded. Check your Space role and try again.");
    } finally { setBusy(false); }
  }

  async function loadAuditHistory(entryId: string, after?: string) {
    const current = auditHistory[entryId];
    if (!after && current?.open) {
      setAuditHistory(values => ({ ...values, [entryId]: { ...current, open: false } }));
      return;
    }
    setBusy(true); setError(null);
    try {
      const page = await listSpaceCoordinationAuditHistory(spaceId, session, entryId, after);
      setAuditHistory(values => ({ ...values, [entryId]: {
        events: after ? [...(values[entryId]?.events ?? []), ...page.events] : page.events,
        nextAfter: page.next_after, open: true,
      } }));
    } catch {
      setError("Coordination audit history could not be loaded. Check your Space role and try again.");
    } finally { setBusy(false); }
  }

  return <section className="settings-block" aria-labelledby="space-coordination-heading" style={{ marginBottom: 24 }}>
    <div style={{ padding: "16px 16px 10px" }}>
      <div id="space-coordination-heading" className="settings-row-label">Space coordination facts</div>
      <p className="settings-row-sub" style={{ margin: "6px 0 0" }}>
        These are explicitly approved advisory notices. Each fact shows whether it is visible to all active Space members or only Space owners and administrators. A notice does not grant access to a project or service; private project details are never read to create one.
      </p>
    </div>
    {canManage && <div style={{ borderTop: "1px solid var(--border)", padding: "14px 16px" }}>
      <div className="settings-row-label">Private project proposals for review</div>
      <p className="settings-row-sub" style={{ margin: "4px 0 10px" }}>Only Space owners and administrators and each proposal's requester can see pending text. Review the exact fact and audience before approval.</p>
      {proposalError && <div className="settings-row-sub" role="alert" style={{ marginBottom: 8, color: "var(--danger, #b42318)" }}>{proposalError}</div>}
      {proposals.length ? <div style={{ display: "grid", gap: 8 }}>
        {proposals.map(proposal => <article key={proposal.proposal_id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
          <div className="settings-row-label">{proposal.draft.label}</div>
          <div className="settings-row-sub" style={{ marginTop: 4 }}>{proposal.draft.capability_key}{proposal.draft.description ? ` · ${proposal.draft.description}` : ""}</div>
          <div className="settings-row-sub" style={{ marginTop: 4 }}>Source project {proposal.project_id} · requester {proposal.requester_id} · revision {proposal.revision}</div>
          <div className="settings-row-sub" style={{ marginTop: 4 }}>If approved: {proposal.draft.audience === "space_members" ? "all active Space members" : "Space owners and administrators"} · advisory only · no access granted</div>
          {proposal.draft.expires_at && <div className="settings-row-sub" style={{ marginTop: 4 }}>Expires {formatConfirmationTime(proposal.draft.expires_at)}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || proposal.status !== "pending"} onClick={() => void reviewProposal(proposal, "approve")}>Review and approve exact disclosure</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy || proposal.status !== "pending"} onClick={() => void reviewProposal(proposal, "reject")}>Reject</button>
          </div>
        </article>)}
        {proposalsNextAfter && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadMoreProposals()}>Load more proposals</button>}
      </div> : !proposalError ? <div className="settings-row-sub">No pending project proposals.</div> : null}
    </div>}
    {visibleEntries.length ? <div style={{ display: "grid", gap: 0 }}>
      {visibleEntries.map(entry => <article key={entry.entry_id} style={{ borderTop: "1px solid var(--border)", padding: "12px 16px", display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <div className="settings-row-label">{entry.label}</div>
          <div className="settings-row-sub" style={{ marginTop: 3 }}>{entry.capability_key}{entry.description ? ` · ${entry.description}` : ""}</div>
          <div className="settings-row-sub" style={{ marginTop: 4 }}>{entry.audience === "space_admins" ? "Visible to Space owners and administrators" : "Visible to all active Space members"} · advisory only · version {entry.version} · {entry.status}</div>
          <div className="settings-row-sub" style={{ marginTop: 3 }}>{formatExpiry(entry.expires_at)}</div>
          <div className="settings-row-sub" style={{ marginTop: 3 }}>Last confirmed {formatConfirmationTime(entry.last_confirmed_at)}</div>
          {entry.created_by && <div className="settings-row-sub" style={{ marginTop: 3 }}>Created by actor {entry.created_by}</div>}
          {entry.approved_by && <div className="settings-row-sub" style={{ marginTop: 3 }}>Last approved by actor {entry.approved_by} ({entry.approved_role ?? "owner/admin"})</div>}
          {entry.provenance && <div className="settings-row-sub" style={{ marginTop: 3 }}>Provenance: {entry.provenance}</div>}
          {entry.status === "revoked" && entry.revoked_by && <div className="settings-row-sub" style={{ marginTop: 3 }}>Revoked by actor {entry.revoked_by}{entry.revoked_at ? ` · ${formatConfirmationTime(entry.revoked_at)}` : ""}</div>}
          {!canManage && entry.audience === "space_members" && entry.status === "active" && (() => {
            const existingRequest = useRequests.find(request => request.entry_id === entry.entry_id);
            return <div style={{ marginTop: 8 }}>
              {existingRequest?.status === "pending"
                ? <span className="settings-row-sub" role="status">Collaboration request pending.</span>
                : existingRequest?.status === "resolved"
                  ? <span className="settings-row-sub" role="status">Request reviewed: {existingRequest.resolution === "contacted" ? "the owner marked that they contacted you" : "the owner marked the service unavailable"}. This did not change your access. </span>
                  : null}
              {existingRequest?.status !== "pending" && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void requestCollaboration(entry)}>
                {existingRequest ? "Request collaboration again" : "Request collaboration"}
              </button>}
            </div>;
          })()}
          {canManage && <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadAuditHistory(entry.entry_id)}>
              {auditHistory[entry.entry_id]?.open ? "Hide audit history" : "View audit history"}
            </button>
            {auditHistory[entry.entry_id]?.open && <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {auditHistory[entry.entry_id]!.events.map(event => <div key={event.event_id} className="settings-row-sub" style={{ borderLeft: "2px solid var(--border)", paddingLeft: 8 }}>
                <div>{event.action} · version {event.prior_version ?? "new"} → {event.version} · {formatConfirmationTime(event.created_at)}</div>
                <div>{event.actor_role} actor {event.actor_id} · {event.audience_before ?? "not previously published"} → {event.audience_after} · {event.status_after}</div>
                <div>Expiry {formatExpiry(event.expires_at_before)} → {formatExpiry(event.expires_at_after)}</div>
              </div>)}
              {!auditHistory[entry.entry_id]!.events.length && <div className="settings-row-sub">No audit events are available for this fact.</div>}
              {auditHistory[entry.entry_id]!.nextAfter && <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
                onClick={() => void loadAuditHistory(entry.entry_id, auditHistory[entry.entry_id]!.nextAfter ?? undefined)}>Load older audit events</button>}
            </div>}
          </div>}
        </div>
        {canManage && entry.status !== "revoked" && <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => beginEdit(entry)}>{entry.status === "expired" ? "Renew or edit" : "Edit"}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revoke(entry)}>Unpublish</button>
        </div>}
      </article>)}
      {nextAfter && <div style={{ borderTop: "1px solid var(--border)", padding: "10px 16px" }}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadMore()}>Load more facts</button>
      </div>}
    </div> : <p className="settings-row-sub" style={{ padding: "0 16px 14px", margin: 0 }}>No coordination facts have been published.</p>}

    {requestError && <p role="alert" style={{ padding: "0 16px" }}>{requestError}</p>}
    {canManage && <section style={{ borderTop: "1px solid var(--border)", padding: 16 }} aria-label="Collaboration requests">
      <div className="settings-row-label">Requests to collaborate</div>
      <p className="settings-row-sub" style={{ margin: "6px 0 10px" }}>Reviewing a request only records that it was reviewed or that you contacted the requester. It does not grant access to a project or service.</p>
      {useRequests.length ? <div style={{ display: "grid", gap: 8 }}>
        {useRequests.map(request => <article key={request.request_id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
          <div className="settings-row-label">{request.entry_label ?? request.entry_id}</div>
          <div className="settings-row-sub" style={{ marginTop: 3 }}>Requester actor {request.requester_id} · {formatConfirmationTime(request.created_at)} · {request.status}{request.resolution ? ` (${request.resolution})` : ""}</div>
          {request.status === "pending" && <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resolveUseRequest(request, "contacted")}>Mark contacted</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resolveUseRequest(request, "unavailable")}>Mark unavailable</button>
          </div>}
        </article>)}
        {requestsNextAfter && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadMoreUseRequests()}>Load older requests</button>}
      </div> : <p className="settings-row-sub">No collaboration requests have been made.</p>}
    </section>}

    {canManage && <div style={{ borderTop: "1px solid var(--border)", padding: 16, display: "grid", gap: 10 }}>
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
        <div className="settings-row-label">Space-member disclosure policy</div>
        <p className="settings-row-sub" style={{ margin: 0 }}>
          New facts default to Space owners and administrators. Enabling this allows an owner or administrator to explicitly publish individual facts to active Space members; it never grants access to their source projects or services.
        </p>
        {policy && <>
          <label className="settings-row-sub" style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <input type="checkbox" checked={policyEnabledDraft} disabled={busy} onChange={event => { setPolicyEnabledDraft(event.target.checked); setPolicyConfirmed(false); setPolicyError(null); }} />
            Allow new or amended facts to be visible to all active Space members
          </label>
          <div className="settings-row-sub">{policy.active_member_facts} active member-visible fact{policy.active_member_facts === 1 ? "" : "s"} · policy revision {policy.revision}{policy.updated_at ? ` · last changed ${formatConfirmationTime(policy.updated_at)}` : " · not configured; disabled by default"}</div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadPolicyHistory()}>
            {policyHistory?.open ? "Hide policy history" : "View policy history"}
          </button>
          {policyHistory?.open && <div style={{ display: "grid", gap: 6 }}>
            {policyHistory.events.map(event => <div key={event.event_id} className="settings-row-sub" style={{ borderLeft: "2px solid var(--border)", paddingLeft: 8 }}>
              <div>Revision {event.prior_revision ?? "new"} → {event.revision} · {formatConfirmationTime(event.created_at)}</div>
              <div>{event.actor_role} actor {event.actor_id} · member visibility {event.prior_member_facts_enabled === null ? "unconfigured" : event.prior_member_facts_enabled ? "enabled" : "disabled"} → {event.member_facts_enabled ? "enabled" : "disabled"}</div>
            </div>)}
            {!policyHistory.events.length && <div className="settings-row-sub">No policy changes are recorded.</div>}
            {policyHistory.nextAfter && <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
              onClick={() => void loadPolicyHistory(policyHistory.nextAfter ?? undefined)}>Load older policy changes</button>}
          </div>}
          {!policyEnabledDraft && policy.active_member_facts > 0 && <div className="settings-row-sub">Unpublish the active member-visible facts above before disabling this setting. They remain visible until individually unpublished or expired.</div>}
          {policyEnabledDraft !== policy.member_facts_enabled && <>
            <label className="settings-row-sub" style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <input type="checkbox" checked={policyConfirmed} disabled={busy} onChange={event => setPolicyConfirmed(event.target.checked)} />
              I approve this Space-wide disclosure policy change.
            </label>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !policyConfirmed || (!policyEnabledDraft && policy.active_member_facts > 0)} onClick={() => void savePolicy()}>
              Save disclosure policy
            </button>
          </>}
        </>}
        {!policy && !policyError && <div className="settings-row-sub">Loading the current disclosure policy…</div>}
        {policyError && <p role="alert" className="settings-row-sub" style={{ color: "#dc2626", margin: 0 }}>{policyError}</p>}
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
        <div className="settings-row-label">Optional singleton rules for coordination facts</div>
        <p className="settings-row-sub" style={{ margin: 0 }}>
          By default, duplicate capability keys are allowed. Owners and administrators can reserve one active approved fact per exact key. This host-side rule applies to this registry only; it does not reserve provider resources or grant access.
        </p>
        {singletonPolicy && <>
          <label className="settings-row-sub">Singleton capability keys (one lowercase key per line; commas also work)
            <textarea className="form-input" rows={4} maxLength={3200} value={singletonKeysDraft} disabled={busy}
              placeholder={"official.website\ncustomer_service.public_channel"}
              onChange={event => { setSingletonKeysDraft(event.target.value); setSingletonConfirmed(false); setSingletonError(null); }} />
          </label>
          <div className="settings-row-sub">Policy revision {singletonPolicy.revision}{singletonPolicy.updated_at ? ` · last changed ${formatConfirmationTime(singletonPolicy.updated_at)}` : " · off by default"} · {singletonPolicy.singleton_capability_keys.length} key{singletonPolicy.singleton_capability_keys.length === 1 ? "" : "s"} enforced</div>
          {singletonPolicy.reservations.length > 0 && <div className="settings-row-sub" aria-label="Active singleton reservations">
            <strong>Current active reservations</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>{singletonPolicy.reservations.map(reservation =>
              <li key={reservation.capability_key}>{reservation.capability_key} · fact {reservation.entry_id} · {formatConfirmationTime(reservation.reserved_at)}</li>)}</ul>
          </div>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadSingletonHistory()}>
            {singletonHistory?.open ? "Hide singleton policy history" : "View singleton policy history"}
          </button>
          {singletonHistory?.open && <div style={{ display: "grid", gap: 6 }}>
            {singletonHistory.events.map(event => <div key={event.event_id} className="settings-row-sub" style={{ borderLeft: "2px solid var(--border)", paddingLeft: 8 }}>
              <div>Revision {event.prior_revision ?? "new"} → {event.revision} · {formatConfirmationTime(event.created_at)}</div>
              <div>{event.actor_role} actor {event.actor_id} · [{event.prior_capability_keys.join(", ")}] → [{event.capability_keys.join(", ")}]</div>
            </div>)}
            {!singletonHistory.events.length && <div className="settings-row-sub">No singleton policy changes are recorded.</div>}
            {singletonHistory.nextAfter && <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
              onClick={() => void loadSingletonHistory(singletonHistory.nextAfter ?? undefined)}>Load older singleton policy changes</button>}
          </div>}
          {singletonKeysDraft.trim() !== singletonPolicy.singleton_capability_keys.join("\n") && <>
            <label className="settings-row-sub" style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <input type="checkbox" checked={singletonConfirmed} disabled={busy} onChange={event => setSingletonConfirmed(event.target.checked)} />
              I approve enforcing these exact singleton capability keys for approved coordination facts.
            </label>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !singletonConfirmed} onClick={() => void saveSingletonPolicy()}>
              Save singleton policy
            </button>
          </>}
        </>}
        {!singletonPolicy && !singletonError && <div className="settings-row-sub">Loading the current singleton policy…</div>}
        {singletonError && <p role="alert" className="settings-row-sub" style={{ color: "#dc2626", margin: 0 }}>{singletonError}</p>}
      </div>
      <div className="settings-row-label">{editingEntry ? "Edit an approved fact" : "Publish an approved fact"}</div>
      <p className="settings-row-sub" style={{ margin: 0 }}>Publishing reveals the label and description to the selected audience. Exact-key singleton rules, when configured above, prevent more than one active approved fact under that key.</p>
      <label className="settings-row-sub">Capability key
        <input className="form-input" maxLength={96} value={capabilityKey} disabled={busy} placeholder="official.website" onChange={event => { setCapabilityKey(event.target.value); changed(); }} />
      </label>
      <label className="settings-row-sub">Fact label
        <input className="form-input" maxLength={120} value={label} disabled={busy} placeholder="The Space has an official company website" onChange={event => { setLabel(event.target.value); changed(); }} />
      </label>
      <label className="settings-row-sub">Description (optional)
        <textarea className="form-input" maxLength={500} rows={3} value={description} disabled={busy} onChange={event => { setDescription(event.target.value); changed(); }} />
      </label>
      <label className="settings-row-sub">Who can see this fact
        <select className="form-input" value={audience} disabled={busy} onChange={event => { setAudience(event.target.value as SpaceCoordinationAudienceV2); changed(); }}>
          <option value="space_members" disabled={!policy?.member_facts_enabled}>All active Space members</option>
          <option value="space_admins">Space owners and administrators</option>
        </select>
      </label>
      {!policy?.member_facts_enabled && <div className="settings-row-sub">Space-member publication is disabled until an owner or administrator enables it above. Previously published member facts remain visible and retain their individual approval.</div>}
      <label className="settings-row-sub">Expiry day (UTC, optional)
        <input className="form-input" type="date" min={new Date().toISOString().slice(0, 10)} value={expiresOn} disabled={busy}
          onChange={event => { setExpiresOn(event.target.value); changed(); }} />
      </label>
      <div className="settings-row-sub">Without an expiry, the fact stays available to its selected audience until an owner or administrator unpublishes it. Expiry hides it from that audience; it does not grant or remove access to the underlying project or service.</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !capabilityKey.trim() || !label.trim()} onClick={() => void makePreview()}>Preview disclosure</button>
        {editingEntry && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={cancelEdit}>Cancel edit</button>}
      </div>
      {preview && <div role="group" aria-label="Disclosure preview" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
        <div className="settings-row-label">Disclosure preview</div>
        <div className="settings-row-sub"><strong>{preview.draft.label}</strong>{preview.draft.description ? ` — ${preview.draft.description}` : ""}</div>
        <div className="settings-row-sub">Audience: {preview.disclosure.audience}.</div>
        <div className="settings-row-sub">{preview.draft.expires_at ? formatExpiry(preview.draft.expires_at) : "No expiry selected; the fact remains until unpublished."}</div>
        <div className="settings-row-sub">Effect: {preview.disclosure.effect}.</div>
        <label className="settings-row-sub" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
          {editingEntry ? "I approve this exact update and its disclosure to the audience shown above." : "I approve publishing this exact fact to the audience shown above."}
        </label>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !confirmed} onClick={() => void publish()}>{editingEntry ? "Update fact" : "Publish fact"}</button>
      </div>}
    </div>}
    {error && <p role="alert" className="settings-row-sub" style={{ color: "#dc2626", padding: "0 16px 12px" }}>{error}</p>}
    {notice && <p role="status" className="settings-row-sub" style={{ padding: "0 16px 12px" }}>{notice}</p>}
  </section>;
}
