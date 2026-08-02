"use client";

// The composer dock — the toolbar under the message input, and the panels that open above it.
//
// Replaces the previous flat row of three small dropdowns (model / connectors / upload). The
// shape is a labelled primary pill on the left, a row of icon buttons, and the member stack on
// the right; opening any of them expands a full-width panel ABOVE the input rather than a cramped
// popover, which is what makes room for the real content — the whole model list with its
// reasoning levels, every connected app with its connect action, the knowledge shelf.
//
// Everything here reads a real endpoint. Notably absent: per-member "online / last active 3
// minutes ago" status. `business-members` carries role/status/joined_at and nothing about
// presence, and SpaceDO's presence table has no end-user-reachable route, so a live dot would be
// invented — the same reason the builder dashboard reports `credits_consumed: null` rather than a
// plausible number.

import * as React from "react";
import { ALLOWED_MODELS, capabilityForModel } from "@naelao/billing-core";
import {
  getConnectorStatus,
  getConnectorMode,
  setConnectorMode,
  createKbDocument,
  listAssistantFiles,
  listBusinessMembers,
  type ConnectorInfo,
  type WorkspaceFile,
  type BusinessMember,
  type SessionCredentials,
} from "@/lib/api";
import { startConnectorConnect, submitManualConnectorKey } from "@/lib/connectorActions";
import { modelLabel } from "./ModelSelector";

type DockPanel = "model" | "apps" | "knowledge" | "tips" | "members";

const LEVEL_LABELS: Record<string, string> = {
  off: "Off", on: "On", low: "Low", medium: "Medium", high: "High", max: "Max",
};

/** Deterministic avatar colour from an id, so the same person is the same colour every render
 *  (and across sessions) without storing anything. */
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 52% 45%)`;
}

function initials(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9]/g, " ").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

function Icon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" strokeWidth={1.5} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  spark: "M10 2.5l1.9 4.4 4.6.5-3.4 3.1.9 4.6L10 12.9l-4 2.2.9-4.6L3.5 7.4l4.6-.5z",
  plug: "M7.5 7.5l5 5M5.5 11.5l-2.2 2.2a2.3 2.3 0 103.3 3.3l2.2-2.2M14.5 8.5l2.2-2.2a2.3 2.3 0 10-3.3-3.3l-2.2 2.2",
  book: "M3.5 4.5A1.5 1.5 0 015 3h4v13H5a1.5 1.5 0 00-1.5 1.5zM16.5 4.5A1.5 1.5 0 0015 3h-4v13h4a1.5 1.5 0 011.5 1.5z",
  bulb: "M8 16h4M8.5 18h3M10 2.5a5 5 0 013 9v1.5H7V11.5a5 5 0 013-9z",
  close: "M5 5l10 10M15 5L5 15",
  check: "M4 10.5l4 4 8-9",
  chevron: "M6 8l4 4 4-4",
};

export function ComposerDock({
  spaceId,
  projectId,
  sessionId,
  session,
  model,
  reasoningLevel,
  onModelChange,
  /** Shown as the primary pill's label. The business/space name, not the product — this dock is
   *  always scoped to whatever space the conversation belongs to. */
  spaceName,
  isBusinessSpace,
  onNotice,
  onUseTip,
  children,
}: {
  spaceId: string;
  projectId?: string;
  sessionId?: string;
  session: SessionCredentials;
  model: string;
  reasoningLevel: string | null;
  onModelChange: (model: string, reasoningLevel: string | null) => void;
  spaceName?: string | undefined;
  isBusinessSpace: boolean;
  onNotice?: (message: string) => void;
  /** A tip card is clickable: it drops its example straight into the composer. */
  onUseTip?: (text: string) => void;
  /** The message input itself. The dock owns the whole stack — panel above, input in the middle,
   *  toolbar below — so an open panel pushes the input down as one unit instead of overlaying it. */
  children?: React.ReactNode;
}) {
  const [panel, setPanel] = React.useState<DockPanel | null>(null);
  const [connectors, setConnectors] = React.useState<ConnectorInfo[]>([]);
  const [modes, setModes] = React.useState<Record<string, "business" | "personal">>({});
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [manualKeyFor, setManualKeyFor] = React.useState<string | null>(null);
  const [manualKeyValue, setManualKeyValue] = React.useState("");
  const [files, setFiles] = React.useState<WorkspaceFile[]>([]);
  const [members, setMembers] = React.useState<BusinessMember[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const toggle = (next: DockPanel) => setPanel((cur) => (cur === next ? null : next));

  // Connectors and members feed the bar itself (the connected dot, the avatar stack), so they load
  // once on mount rather than only when their panel opens.
  React.useEffect(() => {
    let cancelled = false;
    getConnectorStatus(spaceId, session).then((c) => { if (!cancelled) setConnectors(c); }).catch(() => {});
    if (isBusinessSpace) {
      listBusinessMembers(spaceId, session).then((m) => { if (!cancelled) setMembers(m); }).catch(() => {});
    } else {
      setMembers([]);
    }
    return () => { cancelled = true; };
  }, [spaceId, session, isBusinessSpace]);

  React.useEffect(() => {
    if (panel !== "knowledge") return;
    listAssistantFiles(spaceId, session).then(setFiles).catch(() => {});
  }, [panel, spaceId, session]);

  React.useEffect(() => {
    if (panel !== "apps" || !sessionId) return;
    getConnectorMode(spaceId, sessionId, session).then(setModes).catch(() => {});
  }, [panel, spaceId, sessionId, session]);

  // Escape closes whatever is open; a click outside the dock does the same.
  React.useEffect(() => {
    if (!panel) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setPanel(null); }
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPanel(null);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDocClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDocClick);
    };
  }, [panel]);

  async function toggleConnectorMode(connectorId: string) {
    if (!sessionId) return;
    const next = modes[connectorId] === "personal" ? "business" : "personal";
    setModes((m) => ({ ...m, [connectorId]: next }));
    try {
      await setConnectorMode(spaceId, sessionId, connectorId, next, session);
    } catch {
      setModes((m) => ({ ...m, [connectorId]: next === "personal" ? "business" : "personal" }));
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
      /* leave the form up so it stays retryable */
    } finally {
      setBusyId(null);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const looksText = /^text\//.test(file.type) || file.type === "" || /\.(md|txt|csv|json|ts|tsx|js|jsx|py|yaml|yml|log)$/i.test(file.name);
    if (!looksText || file.size > 2_000_000) {
      onNotice?.(`Can't attach "${file.name}" — only text files up to 2MB are supported here.`);
      return;
    }
    setUploading(true);
    try {
      const content = await file.text();
      await createKbDocument(spaceId, session, {
        title: file.name,
        content,
        content_type: "text",
        ...(projectId ? { project_id: projectId } : {}),
      });
      onNotice?.(`Added "${file.name}" to the knowledge base.`);
      setFiles(await listAssistantFiles(spaceId, session).catch(() => files));
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : `Failed to attach "${file.name}"`);
    } finally {
      setUploading(false);
    }
  }

  const availableApps = connectors.filter((c) => c.status === "available");
  const connectedCount = availableApps.filter((c) => c.connected).length;
  const capability = capabilityForModel(model);
  const shownMembers = members.slice(0, 3);
  const extraMembers = members.length - shownMembers.length;

  return (
    <div className="composer-dock" ref={rootRef}>
      <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFile} />

      {panel === "model" && (
        <div className="dock-panel">
          <div className="dock-panel-head">
            <span className="dock-panel-title">Change model</span>
            <span className="dock-panel-note">{modelLabel(model)}</span>
          </div>
          <div className="dock-panel-body">
            {ALLOWED_MODELS.map((m) => {
              const cap = capabilityForModel(m);
              const isActive = m === model;
              return (
                <div key={m} className={`dock-row${isActive ? " active" : ""}`}>
                  <div className="dock-row-icon"><Icon path={ICONS.spark} size={15} /></div>
                  <div className="dock-row-main">
                    <div className="dock-row-title">{modelLabel(m)}</div>
                    <div className="dock-row-desc">
                      {cap.reasoningLevels.length > 0
                        ? `Adjustable reasoning effort — ${cap.reasoningLevels.map((l) => LEVEL_LABELS[l] ?? l).join(", ")}`
                        : "No configurable reasoning mode"}
                    </div>
                  </div>
                  <div className="dock-row-action">
                    {isActive ? (
                      <span className="dock-pill on"><Icon path={ICONS.check} size={11} />Active mode</span>
                    ) : (
                      <button
                        type="button"
                        className="dock-pill"
                        onClick={() => onModelChange(m, cap.reasoningLevels.length > 0 ? (cap.reasoningLevels[0] ?? null) : null)}
                      >
                        Select
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {capability.reasoningLevels.length > 0 && (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                <div className="dock-panel-note" style={{ marginBottom: 8 }}>Reasoning effort</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {capability.reasoningLevels.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={`dock-pill${level === reasoningLevel ? " on" : ""}`}
                      style={{ flex: 1, justifyContent: "center" }}
                      onClick={() => onModelChange(model, level)}
                    >
                      {LEVEL_LABELS[level] ?? level}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {panel === "apps" && (
        <div className="dock-panel">
          <div className="dock-panel-head">
            <span className="dock-panel-title">Connected apps</span>
            <span className="dock-panel-note">{connectedCount} of {availableApps.length} connected</span>
          </div>
          <div className="dock-panel-body">
            {availableApps.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--text3)", padding: "6px 12px" }}>Loading…</div>
            ) : (
              availableApps.map((c) => (
                <div key={c.id} className={`dock-row${c.connected ? " active" : ""}`} style={{ flexWrap: "wrap" }}>
                  <div className="dock-row-icon"><Icon path={ICONS.plug} size={15} /></div>
                  <div className="dock-row-main">
                    <div className="dock-row-title">{c.name}</div>
                    <div className="dock-row-desc">
                      {c.connected && sessionId
                        ? `Using the ${(modes[c.id] ?? "business") === "personal" ? "personal" : "business"} account`
                        : c.summary || "Reachable by the assistant once connected"}
                    </div>
                  </div>
                  <div className="dock-row-action" style={{ display: "flex", gap: 6 }}>
                    {c.connected ? (
                      <>
                        {sessionId && (
                          <button
                            type="button"
                            className="dock-pill"
                            onClick={() => void toggleConnectorMode(c.id)}
                            title="Switch which account this conversation's tool calls use"
                          >
                            Switch account
                          </button>
                        )}
                        <span className="dock-pill on"><Icon path={ICONS.check} size={11} />Connected</span>
                      </>
                    ) : manualKeyFor !== c.id ? (
                      <button type="button" className="dock-pill" disabled={busyId === c.id} onClick={() => void handleConnect(c)}>
                        {busyId === c.id ? "…" : "Connect"}
                      </button>
                    ) : null}
                  </div>
                  {manualKeyFor === c.id && (
                    <div style={{ display: "flex", gap: 6, width: "100%", marginTop: 8 }}>
                      <input
                        className="form-input"
                        type="password"
                        placeholder={`${c.name} API key`}
                        value={manualKeyValue}
                        onChange={(e) => setManualKeyValue(e.target.value)}
                        style={{ flex: 1, fontSize: 12 }}
                      />
                      <button type="button" className="dock-pill" disabled={busyId === c.id} onClick={() => void handleManualSubmit(c.id)}>
                        Save
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {panel === "knowledge" && (
        <div className="dock-panel">
          <div className="dock-panel-head">
            <span className="dock-panel-title">Knowledge</span>
            <button type="button" className="dock-pill" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
              {uploading ? "Adding…" : "Attach a file"}
            </button>
          </div>
          <div className="dock-panel-body">
            {files.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--text3)", padding: "6px 12px", lineHeight: 1.6 }}>
                Nothing attached yet. Add a text file — notes, a price list, a policy — and the assistant can read
                it while it works. Text files up to 2MB.
              </div>
            ) : (
              files.slice(0, 30).map((f) => (
                <div key={f.path} className="dock-row">
                  <div className="dock-row-icon"><Icon path={ICONS.book} size={15} /></div>
                  <div className="dock-row-main">
                    <div className="dock-row-title">{f.path}</div>
                    <div className="dock-row-desc">{Math.max(1, Math.round(f.size / 1024))} KB</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {panel === "tips" && (
        <div className="dock-panel">
          <div className="dock-panel-head">
            <span className="dock-panel-title">Getting a better answer</span>
            <span className="dock-panel-note">Tap one to try it</span>
          </div>
          <div className="dock-tips">
            {[
              {
                title: "Say what you want done",
                desc: "A goal beats a question — the assistant can act, not just answer.",
                example: "Set up a weekly revenue review and email me the summary.",
              },
              {
                title: "Name the specifics",
                desc: "Amounts, dates, product names and channels all narrow it down.",
                example: "Draft a launch post for the £29 starter plan, going out Friday.",
              },
              {
                title: "Say how far to go",
                desc: "Tell it whether to check with you first or just get it done.",
                example: "Draft it and show me before anything is sent.",
              },
            ].map((tip) => (
              <button
                key={tip.title}
                type="button"
                className="dock-tip"
                style={{ textAlign: "left", cursor: onUseTip ? "pointer" : "default", fontFamily: "inherit" }}
                onClick={() => {
                  onUseTip?.(tip.example);
                  setPanel(null);
                }}
              >
                <div className="dock-tip-dot" />
                <div className="dock-tip-title">{tip.title}</div>
                <div className="dock-tip-desc">{tip.desc}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {panel === "members" && (
        <div className="dock-panel">
          <div className="dock-panel-head">
            <span className="dock-panel-title">Who&apos;s in this space</span>
            <span className="dock-panel-note">{members.length} member{members.length === 1 ? "" : "s"}</span>
          </div>
          <div className="dock-panel-body">
            {members.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--text3)", padding: "6px 12px" }}>
                Just you so far. Invite someone from the business page to work in here together.
              </div>
            ) : (
              members.map((m) => (
                <div key={m.end_user_id} className="dock-row">
                  <div className="dock-row-icon" style={{ background: avatarColor(m.end_user_id), color: "#fff" }}>
                    {initials(m.end_user_id)}
                  </div>
                  <div className="dock-row-main">
                    <div className="dock-row-title">{m.end_user_id}</div>
                    <div className="dock-row-desc">Joined {new Date(m.joined_at).toLocaleDateString()}</div>
                  </div>
                  <div className="dock-row-action">
                    <span className="dock-pill" style={{ cursor: "default" }}>{m.role}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {children}

      <div className="dock-bar">
        <button
          type="button"
          className={`dock-primary${panel === "model" ? " open" : ""}`}
          onClick={() => toggle("model")}
          title="Change the model this conversation uses"
        >
          <Icon path={ICONS.spark} />
          <span>{modelLabel(model)}</span>
          {capability.reasoningLevels.length > 0 && reasoningLevel && (
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)", background: "var(--accent-dim)", borderRadius: 5, padding: "1px 5px" }}>
              {LEVEL_LABELS[reasoningLevel] ?? reasoningLevel}
            </span>
          )}
        </button>

        <div className="dock-sep" />

        <button type="button" className={`dock-btn${panel === "apps" ? " open" : ""}`} onClick={() => toggle("apps")} title="Connected apps">
          <Icon path={ICONS.plug} />
          {connectedCount > 0 && <span className="dock-btn-dot" />}
        </button>
        <button type="button" className={`dock-btn${panel === "knowledge" ? " open" : ""}`} onClick={() => toggle("knowledge")} title="Knowledge and files">
          <Icon path={ICONS.book} />
        </button>
        <button type="button" className={`dock-btn${panel === "tips" ? " open" : ""}`} onClick={() => toggle("tips")} title="Tips for a better answer">
          <Icon path={ICONS.bulb} />
        </button>

        <div className="dock-spacer" />

        {isBusinessSpace && members.length > 0 && (
          <>
            <div className="dock-sep" />
            <button
              type="button"
              className={`dock-stack${panel === "members" ? " open" : ""}`}
              onClick={() => toggle("members")}
              title={`${members.length} member${members.length === 1 ? "" : "s"} in ${spaceName ?? "this space"}`}
            >
              {shownMembers.map((m) => (
                <span key={m.end_user_id} className="dock-avatar" style={{ background: avatarColor(m.end_user_id) }}>
                  {initials(m.end_user_id)}
                </span>
              ))}
              {extraMembers > 0 && <span className="dock-stack-count">+{extraMembers}</span>}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
