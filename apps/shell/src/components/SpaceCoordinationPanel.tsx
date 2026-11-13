"use client";

import * as React from "react";
import type { SpaceCoordinationDraftV1, SpaceCoordinationEntryV1 } from "@naelao/agent-sdk";
import type { SessionCredentials } from "@/lib/api";
import { listSpaceCoordination, previewSpaceCoordination, publishSpaceCoordination, revokeSpaceCoordination } from "@/lib/api";

export function SpaceCoordinationPanel({ spaceId, session, canManage }: {
  spaceId: string;
  session: SessionCredentials;
  canManage: boolean;
}) {
  const [entries, setEntries] = React.useState<SpaceCoordinationEntryV1[]>([]);
  const [nextAfter, setNextAfter] = React.useState<string | null>(null);
  const [capabilityKey, setCapabilityKey] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [preview, setPreview] = React.useState<{ draft: SpaceCoordinationDraftV1; disclosure: { audience: string; effect: string } } | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const page = await listSpaceCoordination(spaceId, { sessionToken: session.sessionToken, endUserId: session.endUserId });
      setEntries(page.entries.filter(entry => entry.status === "active"));
      setNextAfter(page.next_after);
      setError(null);
    } catch {
      setError("Coordination facts could not be loaded. Try again.");
    }
  }, [spaceId, session.sessionToken, session.endUserId]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  async function loadMore() {
    if (!nextAfter || busy) return;
    setBusy(true); setError(null);
    try {
      const page = await listSpaceCoordination(spaceId, { sessionToken: session.sessionToken, endUserId: session.endUserId }, nextAfter);
      setEntries(current => [...current, ...page.entries.filter(entry => entry.status === "active")]);
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

  const draft = (): SpaceCoordinationDraftV1 => ({ capability_key: capabilityKey, label, ...(description.trim() ? { description } : {}) });

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
      await publishSpaceCoordination(spaceId, session, preview.draft, true);
      setCapabilityKey(""); setLabel(""); setDescription(""); setPreview(null); setConfirmed(false);
      setNotice("The approved advisory fact is visible to Space members.");
      await refresh();
    } catch {
      setError("The fact was not published. Review your role and try again.");
    } finally { setBusy(false); }
  }

  async function revoke(entry: SpaceCoordinationEntryV1) {
    if (!window.confirm(`Unpublish “${entry.label}”? This removes it from the Space member registry.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await revokeSpaceCoordination(spaceId, session, entry.entry_id, entry.version);
      setNotice("The fact was unpublished.");
      await refresh();
    } catch {
      setError("The fact changed or could not be unpublished. Refresh the list and try again.");
    } finally { setBusy(false); }
  }

  return <section className="settings-block" aria-labelledby="space-coordination-heading" style={{ marginBottom: 24 }}>
    <div style={{ padding: "16px 16px 10px" }}>
      <div id="space-coordination-heading" className="settings-row-label">Space coordination facts</div>
      <p className="settings-row-sub" style={{ margin: "6px 0 0" }}>
        These are explicit notices for every active Space member. They can describe an official capability, but do not grant access to a project or service. Private project details are never read to create them.
      </p>
    </div>
    {entries.length ? <div style={{ display: "grid", gap: 0 }}>
      {entries.map(entry => <article key={entry.entry_id} style={{ borderTop: "1px solid var(--border)", padding: "12px 16px", display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <div className="settings-row-label">{entry.label}</div>
          <div className="settings-row-sub" style={{ marginTop: 3 }}>{entry.capability_key}{entry.description ? ` · ${entry.description}` : ""}</div>
          <div className="settings-row-sub" style={{ marginTop: 4 }}>Visible to all active Space members · advisory only · version {entry.version}</div>
        </div>
        {canManage && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revoke(entry)}>Unpublish</button>}
      </article>)}
      {nextAfter && <div style={{ borderTop: "1px solid var(--border)", padding: "10px 16px" }}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadMore()}>Load more facts</button>
      </div>}
    </div> : <p className="settings-row-sub" style={{ padding: "0 16px 14px", margin: 0 }}>No coordination facts have been published.</p>}

    {canManage && <div style={{ borderTop: "1px solid var(--border)", padding: 16, display: "grid", gap: 10 }}>
      <div className="settings-row-label">Publish an approved fact</div>
      <p className="settings-row-sub" style={{ margin: 0 }}>Publishing reveals the label and description to every active member. Duplicate capability keys are allowed; this registry does not reserve or enforce a singleton resource.</p>
      <label className="settings-row-sub">Capability key
        <input className="form-input" maxLength={96} value={capabilityKey} disabled={busy} placeholder="official.website" onChange={event => { setCapabilityKey(event.target.value); changed(); }} />
      </label>
      <label className="settings-row-sub">Fact label
        <input className="form-input" maxLength={120} value={label} disabled={busy} placeholder="The Space has an official company website" onChange={event => { setLabel(event.target.value); changed(); }} />
      </label>
      <label className="settings-row-sub">Description (optional)
        <textarea className="form-input" maxLength={500} rows={3} value={description} disabled={busy} onChange={event => { setDescription(event.target.value); changed(); }} />
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !capabilityKey.trim() || !label.trim()} onClick={() => void makePreview()}>Preview disclosure</button>
      </div>
      {preview && <div role="group" aria-label="Disclosure preview" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
        <div className="settings-row-label">Disclosure preview</div>
        <div className="settings-row-sub"><strong>{preview.draft.label}</strong>{preview.draft.description ? ` — ${preview.draft.description}` : ""}</div>
        <div className="settings-row-sub">Audience: {preview.disclosure.audience}.</div>
        <div className="settings-row-sub">Effect: {preview.disclosure.effect}.</div>
        <label className="settings-row-sub" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
          I approve publishing this exact fact to the audience shown above.
        </label>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !confirmed} onClick={() => void publish()}>Publish fact</button>
      </div>}
    </div>}
    {error && <p role="alert" className="settings-row-sub" style={{ color: "#dc2626", padding: "0 16px 12px" }}>{error}</p>}
    {notice && <p role="status" className="settings-row-sub" style={{ padding: "0 16px 12px" }}>{notice}</p>}
  </section>;
}
