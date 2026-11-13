"use client";

import * as React from "react";
import type { SpaceCoordinationAuditEventV2, SpaceCoordinationAudienceV2, SpaceCoordinationDraftV2, SpaceCoordinationEntryV2 } from "@naelao/agent-sdk";
import type { SessionCredentials } from "@/lib/api";
import { amendSpaceCoordination, listSpaceCoordination, listSpaceCoordinationAuditHistory, previewSpaceCoordination, publishSpaceCoordination, revokeSpaceCoordination } from "@/lib/api";

export function SpaceCoordinationPanel({ spaceId, session, canManage }: {
  spaceId: string;
  session: SessionCredentials;
  canManage: boolean;
}) {
  const [entries, setEntries] = React.useState<SpaceCoordinationEntryV2[]>([]);
  const [nextAfter, setNextAfter] = React.useState<string | null>(null);
  const [capabilityKey, setCapabilityKey] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [audience, setAudience] = React.useState<SpaceCoordinationAudienceV2>("space_members");
  const [expiresOn, setExpiresOn] = React.useState("");
  const [editingEntry, setEditingEntry] = React.useState<SpaceCoordinationEntryV2 | null>(null);
  const [preview, setPreview] = React.useState<{ draft: SpaceCoordinationDraftV2; disclosure: { audience: string; effect: string } } | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const [auditHistory, setAuditHistory] = React.useState<Record<string, { events: SpaceCoordinationAuditEventV2[]; nextAfter: string | null; open: boolean }>>({});

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
    setCapabilityKey(""); setLabel(""); setDescription(""); setAudience("space_members"); setExpiresOn("");
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
      setEditingEntry(null); setCapabilityKey(""); setLabel(""); setDescription(""); setAudience("space_members"); setExpiresOn(""); setPreview(null); setConfirmed(false);
      if (!updatedEntry) await refresh();
    } catch {
      setError(editingEntry ? "The fact changed or could not be updated. Refresh the list and review it again." : "The fact was not published. Review your role and try again.");
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
    } catch {
      setError("The fact changed or could not be unpublished. Refresh the list and try again.");
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

    {canManage && <div style={{ borderTop: "1px solid var(--border)", padding: 16, display: "grid", gap: 10 }}>
      <div className="settings-row-label">{editingEntry ? "Edit an approved fact" : "Publish an approved fact"}</div>
      <p className="settings-row-sub" style={{ margin: 0 }}>Publishing reveals the label and description to the selected audience. Duplicate capability keys are allowed; this registry does not reserve or enforce a singleton resource.</p>
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
          <option value="space_members">All active Space members</option>
          <option value="space_admins">Space owners and administrators</option>
        </select>
      </label>
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
