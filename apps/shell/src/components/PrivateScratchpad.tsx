"use client";
import React from "react";
import { createScratchpadKey, sealScratchpad, openScratchpad } from "@naelao/agent-sdk";
import { apiFetch, getMessages, type SessionCredentials } from "../lib/api";
// Keys remain in browser memory. Refreshing the page intentionally discards them.
const keys = new Map<string, Promise<CryptoKey>>();
export function PrivateScratchpad({ spaceId, sessionId, session }: { spaceId: string; sessionId: string; session: SessionCredentials }) {
  const scope = `${session.endUserId}:${spaceId}:${sessionId}`;
  const activeScope = React.useRef(scope);
  activeScope.current = scope;
  const [notes, setNotes] = React.useState<string[]>([]), [draft, setDraft] = React.useState(""), [error, setError] = React.useState(""), [saving, setSaving] = React.useState(false);
  const getKey = () => { if (!keys.has(scope)) keys.set(scope, createScratchpadKey()); return keys.get(scope)!; };
  React.useEffect(() => {
    let current = true;
    setNotes([]); setDraft(""); setError(""); setSaving(false);
    void getMessages(spaceId, sessionId, session).then(async messages => {
      const key = keys.get(scope);
      const values = await Promise.all(messages.map(async message => {
        if (!key) return "Encrypted note — its temporary browser key is no longer available.";
        try { return await openScratchpad(message.content, await key, sessionId); } catch { return "Encrypted note — unavailable with this browser key."; }
      }));
      if (current) setNotes(values);
    }).catch(() => { if (current) setError("Could not load this scratchpad."); });
    return () => { current = false; };
  }, [spaceId, sessionId, session, scope]);
  async function save() {
    if (!draft.trim() || saving) return;
    setSaving(true); setError("");
    try {
      const plaintext = draft, content = await sealScratchpad(plaintext, await getKey(), sessionId);
      await apiFetch(`/v1/spaces/${spaceId}/sessions/${sessionId}/messages`, { method: "POST", session, body: JSON.stringify({ role: "user", content, client_message_id: crypto.randomUUID() }) });
      if (activeScope.current === scope) { setNotes(values => [...values, plaintext]); setDraft(""); }
    } catch { if (activeScope.current === scope) setError("Could not save the encrypted note."); }
    finally { if (activeScope.current === scope) setSaving(false); }
  }
  return <main style={{ padding: 24, maxWidth: 900 }}><h2>Private scratchpad</h2><p>Notes are encrypted in this browser before saving. The temporary key disappears when you refresh or close the page.</p>
    {notes.map((note, i) => <p key={i} style={{ whiteSpace: "pre-wrap" }}>{note}</p>)}
    <textarea aria-label="Private note" value={draft} onChange={event => setDraft(event.target.value)} rows={6} style={{ width: "100%" }} />
    <button onClick={() => void save()} disabled={saving || !draft.trim()}>{saving ? "Saving…" : "Save note"}</button>{error && <p role="alert">{error}</p>}</main>;
}
