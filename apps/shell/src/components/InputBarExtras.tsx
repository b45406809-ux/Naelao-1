"use client";

// Chat input bar additions beyond the model selector: a Connectors popover (what's connected,
// quick-connect what isn't) and an Upload button (attach a text file into this space/project's
// knowledge base so the assistant can read it). Both are self-contained popovers so Chat.tsx only
// needs to render them, not own their state.

import * as React from "react";
import { getConnectorStatus, createKbDocument, getConnectorMode, setConnectorMode, type ConnectorInfo } from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";
import { startConnectorConnect, submitManualConnectorKey } from "@/lib/connectorActions";

function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, onClose]);
  return ref;
}

/** A small icon button matching the existing input-bar icon-btn styling used elsewhere in the
 *  shell (topbar toggle, etc.) — kept local since it's this file's own two callers only. */
function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="icon-btn" title={title} onClick={onClick}>
      {children}
    </button>
  );
}

export function ConnectorsButton({
  spaceId,
  sessionId,
  session,
}: {
  spaceId: string;
  /** Which chat session's connector-mode preference to show/edit — absent on surfaces with no
   *  session yet (e.g. before the first message mints one), where the toggle just doesn't render. */
  sessionId?: string;
  session: SessionCredentials;
}) {
  const [open, setOpen] = React.useState(false);
  const [connectors, setConnectors] = React.useState<ConnectorInfo[]>([]);
  const [modes, setModes] = React.useState<Record<string, "business" | "personal">>({});
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [manualKeyFor, setManualKeyFor] = React.useState<string | null>(null);
  const [manualKeyValue, setManualKeyValue] = React.useState("");
  const ref = useOutsideClose(open, () => setOpen(false));

  React.useEffect(() => {
    if (!open) return;
    getConnectorStatus(spaceId, session).then(setConnectors).catch(() => {});
    if (sessionId) getConnectorMode(spaceId, sessionId, session).then(setModes).catch(() => {});
  }, [open, spaceId, sessionId, session]);

  async function toggleMode(connectorId: string) {
    if (!sessionId) return;
    const next = modes[connectorId] === "personal" ? "business" : "personal";
    setModes((m) => ({ ...m, [connectorId]: next }));
    try {
      await setConnectorMode(spaceId, sessionId, connectorId, next, session);
    } catch {
      setModes((m) => ({ ...m, [connectorId]: next === "personal" ? "business" : "personal" })); // revert
    }
  }

  async function handleConnect(c: ConnectorInfo) {
    setBusyId(c.id);
    try {
      const { needsManualKey } = await startConnectorConnect(spaceId, session, c, window.location.href);
      if (needsManualKey) {
        setManualKeyFor(c.id);
        setManualKeyValue("");
        setBusyId(null);
      }
    } catch {
      setBusyId(null);
    }
  }

  async function handleManualSubmit(id: string) {
    if (!manualKeyValue.trim()) return;
    setBusyId(id);
    try {
      await submitManualConnectorKey(spaceId, session, id, manualKeyValue.trim());
      setManualKeyFor(null);
      setManualKeyValue("");
      setConnectors(await getConnectorStatus(spaceId, session));
    } catch {
      /* stays actionable */
    } finally {
      setBusyId(null);
    }
  }

  const available = connectors.filter((c) => c.status === "available");
  const connectedCount = available.filter((c) => c.connected).length;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <IconButton title="Connectors" onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor" width={15} height={15}>
          <path d="M6 6L10 10M4.5 9.5L2.5 11.5C1.7 12.3 1.7 13.6 2.5 14.4C3.3 15.2 4.6 15.2 5.4 14.4L7.4 12.4M11.5 6.5L13.5 4.5C14.3 3.7 14.3 2.4 13.5 1.6C12.7 0.8 11.4 0.8 10.6 1.6L8.6 3.6" />
        </svg>
        {connectedCount > 0 && (
          <span style={{ position: "absolute", top: 2, right: 2, width: 6, height: 6, borderRadius: 999, background: "var(--accent)" }} />
        )}
      </IconButton>
      {open && (
        <div
          style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: 0, width: 280, maxHeight: 320, overflowY: "auto",
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-md)", zIndex: 40, padding: 8,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4, padding: "4px 6px" }}>
            Connectors
          </div>
          {available.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text3)", padding: "6px 6px 4px" }}>Loading…</div>
          ) : (
            available.map((c) => (
              <div key={c.id} style={{ padding: "6px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: "var(--text)" }}>{c.name}</span>
                  {c.connected ? (
                    <span className="badge badge-green" style={{ fontSize: 9.5 }}><span className="badge-dot" />Connected</span>
                  ) : manualKeyFor !== c.id ? (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => handleConnect(c)} disabled={busyId === c.id}>
                      {busyId === c.id ? "…" : "Connect"}
                    </button>
                  ) : null}
                </div>
                {c.connected && sessionId && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                    <span style={{ fontSize: 10.5, color: "var(--text3)" }}>Using:</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: 10.5, padding: "1px 6px" }}
                      onClick={() => toggleMode(c.id)}
                      title="Switch which account this chat's tool calls use for this connector"
                    >
                      {(modes[c.id] ?? "business") === "personal" ? "My personal account" : "Business account (default)"} — switch
                    </button>
                  </div>
                )}
                {manualKeyFor === c.id && (
                  <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                    <input
                      className="form-input"
                      type="password"
                      placeholder="API key"
                      value={manualKeyValue}
                      onChange={(e) => setManualKeyValue(e.target.value)}
                      style={{ flex: 1, fontSize: 11.5 }}
                    />
                    <button type="button" className="btn btn-primary btn-sm" style={{ fontSize: 11 }} onClick={() => handleManualSubmit(c.id)} disabled={busyId === c.id}>
                      Save
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
          <a href="./connectors" style={{ display: "block", fontSize: 11.5, color: "var(--accent)", padding: "6px", textDecoration: "none" }}>
            View all connectors →
          </a>
        </div>
      )}
    </div>
  );
}

/** Attaches a TEXT file into this space's (or, when projectId is given, this project's) knowledge
 *  base so the assistant can read it — real, working ingestion via the existing KB pipeline.
 *  Scoped to text-readable files (source code, markdown, plain text, CSV, JSON, …); a binary file
 *  (image/PDF) is rejected client-side rather than silently ingesting garbage — real document
 *  parsing (PDF/image) is a separate, larger KB-pipeline feature this pass doesn't add. */
export function UploadButton({
  spaceId,
  projectId,
  session,
  onUploaded,
}: {
  spaceId: string;
  projectId?: string;
  session: SessionCredentials;
  onUploaded?: (title: string) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file) return;
    const looksText = /^text\//.test(file.type) || file.type === "" || /\.(md|txt|csv|json|ts|tsx|js|jsx|py|yaml|yml|log)$/i.test(file.name);
    if (!looksText || file.size > 2_000_000) {
      onUploaded?.(`Can't attach "${file.name}" — only text files up to 2MB are supported here.`);
      return;
    }
    setBusy(true);
    try {
      const content = await file.text();
      await createKbDocument(spaceId, session, {
        title: file.name,
        content,
        content_type: "text",
        ...(projectId ? { project_id: projectId } : {}),
      });
      onUploaded?.(`Added "${file.name}" to the knowledge base.`);
    } catch (err) {
      onUploaded?.(err instanceof Error ? err.message : `Failed to attach "${file.name}"`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input ref={inputRef} type="file" style={{ display: "none" }} onChange={handleFile} />
      <IconButton title="Attach a file to the knowledge base" onClick={() => inputRef.current?.click()}>
        {busy ? (
          <span style={{ fontSize: 11 }}>…</span>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor" width={15} height={15}>
            <path d="M11 5.5L6.5 10C5.7 10.8 5.7 12.1 6.5 12.9C7.3 13.7 8.6 13.7 9.4 12.9L13.4 8.9C14.6 7.7 14.6 5.7 13.4 4.5C12.2 3.3 10.2 3.3 9 4.5L4.5 9C2.6 10.9 2.6 13.9 4.5 15.8" />
          </svg>
        )}
      </IconButton>
    </>
  );
}
