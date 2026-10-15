"use client";

import * as React from "react";
import { Button, FormInput } from "@naelao/ui";
import { deleteDomainGlossary, getDomainGlossary, putDomainGlossary, type DomainGlossaryEntry, type SessionCredentials } from "@/lib/api";

export function DomainGlossaryPanel({ spaceId, creds, canEdit }: { spaceId: string; creds: SessionCredentials; canEdit: boolean }) {
  const [entries, setEntries] = React.useState<DomainGlossaryEntry[]>([]);
  const [term, setTerm] = React.useState("");
  const [meaning, setMeaning] = React.useState("");
  const [locale, setLocale] = React.useState("und");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const refresh = React.useCallback(() => getDomainGlossary(spaceId, creds).then(setEntries).catch(() => setError("Couldn't load this Space's glossary.")), [spaceId, creds]);
  React.useEffect(() => { void refresh(); }, [refresh]);

  async function save() {
    setBusy(true); setError("");
    try {
      await putDomainGlossary(spaceId, creds, { term, meaning, locale: locale.trim() || "und", ...(notes.trim() ? { notes: notes.trim() } : {}) });
      setTerm(""); setMeaning(""); setNotes(""); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't save the glossary entry."); }
    finally { setBusy(false); }
  }

  async function remove(entry: DomainGlossaryEntry) {
    setBusy(true); setError("");
    try { await deleteDomainGlossary(spaceId, creds, entry.term, entry.locale); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't remove the glossary entry."); }
    finally { setBusy(false); }
  }

  return <section className="settings-block" style={{ display: "grid", gap: 8 }}>
    <div className="settings-row-label">Domain glossary</div>
    <p className="settings-row-sub">Add exact terms, phrases and their meaning for this Space. The assistant can look up exact entries; it will not treat them as verified translations or automatically replace unmatched text.</p>
    {canEdit && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8 }}>
      <FormInput aria-label="Glossary term" placeholder="Term or phrase" value={term} onChange={event => setTerm(event.target.value)} maxLength={160} />
      <FormInput aria-label="Glossary meaning" placeholder="Meaning" value={meaning} onChange={event => setMeaning(event.target.value)} maxLength={1000} />
      <FormInput aria-label="Glossary locale" placeholder="Locale (e.g. sn)" value={locale} onChange={event => setLocale(event.target.value)} maxLength={32} />
      <FormInput aria-label="Glossary notes" placeholder="Usage notes (optional)" value={notes} onChange={event => setNotes(event.target.value)} maxLength={500} />
      <Button size="sm" disabled={busy || !term.trim() || !meaning.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save term"}</Button>
    </div>}
    {error && <p role="alert" className="settings-row-sub">{error}</p>}
    {entries.length ? entries.map(entry => <div key={`${entry.locale}:${entry.term}`} className="settings-row-sub"><strong>{entry.term}</strong> ({entry.locale}) — {entry.meaning}{entry.notes ? ` · ${entry.notes}` : ""}{canEdit ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void remove(entry)}>Remove</Button> : null}</div>) : <p className="settings-row-sub">No glossary entries yet.</p>}
  </section>;
}
