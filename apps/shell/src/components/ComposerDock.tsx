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
import { ALLOWED_MODELS, capabilityForModel, effortOptionsForModel, nativeReasoningForEffort, type EffortLevel, type VerticalModelPolicy } from "@naelao/billing-core";
import {
  getConnectorStatus,
  getConnectorMode,
  setConnectorMode,
  uploadChatFiles,
  listChatUploads,
  deleteChatUpload,
  listBusinessMembers,
  getConnectorDirectory,
  listProjectRoster,
  type ConnectorInfo,
  type DirectoryApp,
  type ChatUpload,
  type BusinessMember,
  type SessionCredentials,
  type AgentTemplateSummary,
  type ProjectRosterBot,
} from "@/lib/api";
import { startConnectorConnect, startDirectoryConnect, submitManualConnectorKey } from "@/lib/connectorActions";
import type { InspectedElement } from "./ProjectKindPanel";
import { modelLabel } from "./ModelSelector";

type DockPanel = "compose" | "model" | "effort" | "agent" | "apps" | "uploads" | "tips" | "members";

/** Matches the server's own cap (workers/agents/src/index.ts's MAX_UPLOAD_FILES) — enforced
 *  again here so the UI refuses before spending a round trip on a request the server would
 *  reject anyway. */
const MAX_UPLOAD_FILES = 6;

const LEVEL_LABELS: Record<string, string> = {
  off: "Off", on: "On", low: "Low", medium: "Medium", high: "High", max: "Max",
};

const EFFORT_LABELS: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", ultra: "Ultra" };

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
  compose: "M3.5 15.5V17h1.5l8.6-8.6-1.5-1.5L3.5 15.5zM15.6 6.4a.8.8 0 000-1.1l-1-1a.8.8 0 00-1.1 0l-1 1 2.1 2.1 1-1z",
  upload: "M10 13.5V3.5M6.5 7L10 3.5 13.5 7M3.5 13v2.5A1.5 1.5 0 005 17h10a1.5 1.5 0 001.5-1.5V13",
  cube: "M10 2.5l6.5 3.7v7.6L10 17.5l-6.5-3.7V6.2zM10 2.5v15M3.5 6.2l6.5 3.8 6.5-3.8",
  agent: "M10 4V2M6 4h8a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2zM7.5 8.5v1M12.5 8.5v1M8 13.5h4M3 8h1M16 8h1",
  gauge: "M10 11l3-4M3.5 15a6.5 6.5 0 1113 0M6 15a4 4 0 018 0",
  back: "M12.5 4.5L6 10l6.5 5.5",
};

export function ComposerDock({
  spaceId,
  projectId,
  sessionId,
  session,
  model,
  reasoningLevel,
  onModelChange,
  effort,
  onEffortChange,
  modelPolicy,
  /** Shown as the primary pill's label. The business/space name, not the product — this dock is
   *  always scoped to whatever space the conversation belongs to. */
  spaceName,
  isBusinessSpace,
  onNotice,
  onUseTip,
  ensureSessionId,
  pendingUploads,
  onUploadsChange,
  agentOptions,
  selectedAgentId,
  onAgentChange,
  availableTemplates,
  addingTemplateId,
  onAddTemplate,
  inspectedElement,
  onClearInspectedElement,
  children,
}: {
  spaceId: string;
  projectId?: string;
  sessionId?: string;
  session: SessionCredentials;
  model: string;
  reasoningLevel: string | null;
  /** Switching model no longer carries a reasoning level — Effort (below) is the sole source of
   *  truth for the active model's reasoning depth, re-derived automatically by the caller
   *  whenever the model changes. */
  onModelChange: (model: string) => void;
  /** Effort — the escalation-budget dial, always present (every model has at least low/medium),
   *  independent of whether the active model has any native reasoning mode of its own. Defaults
   *  to "low" upstream (Chat.tsx / modelPreference.ts), never left undefined here. */
  effort: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  /** Vertical Model Policy restricting or curating allowed models */
  modelPolicy?: VerticalModelPolicy | null;
  spaceName?: string | undefined;
  isBusinessSpace: boolean;
  onNotice?: (message: string) => void;
  /** A tip card is clickable: it drops its example straight into the composer. */
  onUseTip?: (text: string) => void;
  /** Mints (or reuses) the real session id an upload needs to know where in the workspace it
   *  landed — a fresh thread/Home has no session yet (lazy creation), so attaching a file before
   *  the first message still needs somewhere real to put it. */
  ensureSessionId?: () => Promise<string>;
  /** Files attached for the message not yet sent — owned by the parent (Chat.tsx) so a chip can
   *  render above the composer too, not just inside this panel. */
  pendingUploads?: ChatUpload[];
  onUploadsChange?: (uploads: ChatUpload[]) => void;
  /** Naelao Agent Templates switcher — the project thread's own bound agents, when there's more
   *  than one to pick between (Chat.tsx resolves this; empty in an assistant session or a project
   *  with only its default agent, which is when no pill/button renders at all). */
  agentOptions?: Array<{ id: string; name: string }>;
  selectedAgentId?: string | null;
  onAgentChange?: (agentId: string) => void;
  /** The full Naelao Agent Templates catalogue, offered to ADD to this project directly from the
   *  panel — without this, a project with nothing bound yet had no path from "the switcher" to
   *  actually having something to switch to except a separate trip to the Agents/Projects pages. */
  availableTemplates?: AgentTemplateSummary[];
  /** The template currently being instantiated, if any — disables its own row's button and shows
   *  "Adding…" rather than letting a slow request look like a dead click. */
  addingTemplateId?: string | null;
  onAddTemplate?: (templateId: string) => void;
  inspectedElement?: InspectedElement | null;
  onClearInspectedElement?: () => void;
  /** Dual-Tier Architecture Mode (Frontier-Planner + Open-Worker Context Isolation) toggle */
  dualTierMode?: boolean;
  onToggleDualTierMode?: (enabled: boolean) => void;
  /** Live Voice Call Mode (@cloudflare/voice ChatGPT-style) */
  onStartVoiceCall?: () => void;
  /** The message input itself. The dock owns the whole stack — panel above, input in the middle,
   *  toolbar below — so an open panel pushes the input down as one unit instead of overlaying it. */
  children?: React.ReactNode;
}) {
  // "compose" (the plain text input) is the resting state, never a fully-closed one — a dock with
  // every panel toggled off used to render nothing but the icon row, with no visible way to type
  // at all. Toggling a panel off now always lands back on "compose" instead of null.
  const [panel, setPanel] = React.useState<DockPanel>("compose");
  const [connectors, setConnectors] = React.useState<ConnectorInfo[]>([]);
  const [modes, setModes] = React.useState<Record<string, "business" | "personal">>({});
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [manualKeyFor, setManualKeyFor] = React.useState<string | null>(null);
  const [manualKeyValue, setManualKeyValue] = React.useState("");
  // Uploaded-before files for the CURRENT session — distinct from `pendingUploads` (this turn's
  // not-yet-sent attachments), fetched once a real session id exists.
  const [priorUploads, setPriorUploads] = React.useState<ChatUpload[]>([]);
  const [members, setMembers] = React.useState<BusinessMember[]>([]);
  const [rosterBots, setRosterBots] = React.useState<ProjectRosterBot[]>([]);
  const [uploading, setUploading] = React.useState(false);
  // Searching the full provider directory from here, not just the dozen curated recommendations.
  // This panel used to render `connectors` alone, so an app we hadn't hand-added to the catalogue
  // simply did not exist as far as this UI was concerned — the same gap the Connectors page had.
  // Server-side search rather than a filter, because there are several thousand of them.
  const [appQuery, setAppQuery] = React.useState("");
  const [directory, setDirectory] = React.useState<DirectoryApp[] | null>(null);
  const [directorySearching, setDirectorySearching] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const toggle = (next: DockPanel) => setPanel((cur) => (cur === next ? "compose" : next));

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
    if (!projectId) { setRosterBots([]); return; }
    let cancelled = false;
    listProjectRoster(spaceId, projectId, session)
      .then((bots) => { if (!cancelled) setRosterBots(bots); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [spaceId, projectId, session, panel]);

  React.useEffect(() => {
    if (panel !== "uploads" || !sessionId) { setPriorUploads([]); return; }
    listChatUploads(spaceId, sessionId, session, projectId).then(setPriorUploads).catch(() => {});
  }, [panel, spaceId, sessionId, projectId, session]);

  React.useEffect(() => {
    if (panel !== "apps" || !sessionId) return;
    getConnectorMode(spaceId, sessionId, session).then(setModes).catch(() => {});
  }, [panel, spaceId, sessionId, session]);

  // Debounced directory search. Fires only while the panel is open and only past two characters —
  // one letter would match most of three thousand apps, which is a slower way of showing nothing
  // useful. Anything already curated above is filtered out so the same app isn't offered twice
  // with the better path listed second.
  React.useEffect(() => {
    if (panel !== "apps") return;
    const q = appQuery.trim();
    if (q.length < 2) { setDirectory(null); return; }
    let cancelled = false;
    setDirectorySearching(true);
    const timer = setTimeout(() => {
      getConnectorDirectory(spaceId, session, { q, limit: 40 })
        .then((page) => { if (!cancelled) setDirectory(page.apps.filter((a) => !a.curated_as)); })
        .catch(() => { if (!cancelled) setDirectory([]); })
        .finally(() => { if (!cancelled) setDirectorySearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [panel, appQuery, spaceId, session]);

  async function handleDirectoryConnect(app: DirectoryApp) {
    setBusyId(app.id);
    try {
      await startDirectoryConnect(spaceId, session, app.id, window.location.href);
      // The browser is navigating away to the provider's own consent page; leave it busy.
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : `Failed to start connecting ${app.name}`);
      setBusyId(null);
    }
  }

  // Escape returns to the text tab; a click outside the dock does the same. Neither ever leaves
  // the dock with nothing open — see the `panel` state's own comment.
  React.useEffect(() => {
    if (panel === "compose") return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setPanel("compose"); }
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPanel("compose");
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

  /** Attach files for THIS turn — read directly by the agent from the workspace, never knowledge-
   *  base ingestion (that's a separate, curated, cross-session store — see the Knowledge page).
   *  Any format, up to 6 at once; the server enforces the same limit and a per-file size cap. */
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (chosen.length === 0) return;
    const alreadyPending = pendingUploads?.length ?? 0;
    if (alreadyPending + chosen.length > MAX_UPLOAD_FILES) {
      onNotice?.(`Attach at most ${MAX_UPLOAD_FILES} files to one message.`);
      return;
    }
    if (!ensureSessionId || !onUploadsChange) return;
    setUploading(true);
    try {
      const sid = await ensureSessionId();
      const uploaded = await uploadChatFiles(spaceId, sid, chosen, session, projectId);
      onUploadsChange([...(pendingUploads ?? []), ...uploaded]);
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleDeletePriorUpload(name: string) {
    if (!sessionId) return;
    try {
      await deleteChatUpload(spaceId, sessionId, name, session, projectId);
      setPriorUploads((prev) => prev.filter((f) => f.name !== name));
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : `Couldn't remove "${name}"`);
    }
  }

  const availableApps = connectors.filter((c) => c.status === "available");
  const connectedCount = availableApps.filter((c) => c.connected).length;
  const capability = capabilityForModel(model);
  const shownMembers = members.slice(0, 3);
  const extraMembers = members.length - shownMembers.length;

  return (
    <div className="composer-dock" ref={rootRef}>
      <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFile} />

      {panel === "model" && (
        <div className="dock-panel">
          <div className="dock-panel-head">
            <span className="dock-panel-title">
              {modelPolicy?.pickerHeaderLabel ? modelPolicy.pickerHeaderLabel : "Change model"}
            </span>
            <span className="dock-panel-note">
              {modelPolicy?.lockedByCompliancePolicy ? "🔒 Compliance Locked" : modelLabel(model)}
            </span>
          </div>
          <div className="dock-panel-body">
            {(modelPolicy?.mode === "whitelist_only" && modelPolicy.allowedModelIds
              ? ALLOWED_MODELS.filter((m) => modelPolicy.allowedModelIds.includes(m))
              : ALLOWED_MODELS
            ).map((m) => {
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
                        onClick={() => onModelChange(m)}
                      >
                        Select
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              <button
                type="button"
                className="dock-row"
                style={{ width: "100%", cursor: "pointer", background: "none", border: "none", font: "inherit", textAlign: "left" }}
                onClick={() => setPanel("effort")}
              >
                <div className="dock-row-icon"><Icon path={ICONS.gauge} size={15} /></div>
                <div className="dock-row-main">
                  <div className="dock-row-title">Effort</div>
                  <div className="dock-row-desc">How far this model is allowed to reach for help</div>
                </div>
                <div className="dock-row-action">
                  <span className="dock-pill">{EFFORT_LABELS[effort] ?? effort} →</span>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {panel === "effort" && (
        <div className="dock-panel">
          <div className="dock-panel-head">
            <button
              type="button"
              onClick={() => setPanel("model")}
              title="Back to models"
              style={{ background: "none", border: "none", cursor: "pointer", padding: 4, marginRight: 2, color: "var(--text2)", display: "inline-flex" }}
            >
              <Icon path={ICONS.back} size={15} />
            </button>
            <span className="dock-panel-title">{modelLabel(model)} Effort</span>
            <span className="dock-panel-note">how far it can reach for help</span>
          </div>
          <div className="dock-panel-body" style={{ padding: "4px 12px 12px" }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
              {effortOptionsForModel(model).map((opt) => (
                <button
                  key={opt.level}
                  type="button"
                  className={`dock-pill${opt.level === effort ? " on" : ""}`}
                  style={{ flex: 1, justifyContent: "center", padding: "8px 0" }}
                  onClick={() => onEffortChange(opt.level)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p style={{ fontSize: 12, color: "var(--text3)", lineHeight: 1.5, margin: 0 }}>
              {effortOptionsForModel(model).find((o) => o.level === effort)?.description}
            </p>
            {/* Effort does two jobs at once (see effort.ts): it sets the delegation ceiling for
                EVERY model, and — only on a model that has one — it also sets that model's own
                thinking depth. Showing which of the two is in play stops "Ultra" reading as a
                promise of deeper thinking on a model that simply cannot think harder. */}
            {(() => {
              const thinking = nativeReasoningForEffort(model, effort);
              return (
                <div
                  style={{
                    marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)",
                    display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text3)",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                      background: thinking ? "var(--accent)" : "var(--border)",
                    }}
                  />
                  <span>
                    {thinking
                      ? <>Thinking: <strong style={{ color: "var(--text2)" }}>{thinking}</strong></>
                      : "This model has no thinking mode — Effort only changes what it may delegate to."}
                  </span>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {panel === "agent" && (
        <div className="dock-panel">
          <div className="dock-panel-head">
            <span className="dock-panel-title">Naelao Agent Templates — this project</span>
            <span className="dock-panel-note">who answers your next message</span>
          </div>
          <div className="dock-panel-body">
            {(!agentOptions || agentOptions.length === 0) && (!availableTemplates || availableTemplates.length === 0) ? (
              <p style={{ padding: "8px 12px", fontSize: 12.5, color: "var(--text3)" }}>Loading…</p>
            ) : (
              <>
                {agentOptions?.map((a) => {
                  const isActive = a.id === selectedAgentId;
                  return (
                    <div key={a.id} className={`dock-row${isActive ? " active" : ""}`}>
                      <div className="dock-row-icon"><Icon path={ICONS.agent} size={15} /></div>
                      <div className="dock-row-main">
                        <div className="dock-row-title">{a.name}</div>
                      </div>
                      <div className="dock-row-action">
                        {isActive ? (
                          <span className="dock-pill on"><Icon path={ICONS.check} size={11} />Active</span>
                        ) : (
                          <button type="button" className="dock-pill" onClick={() => { onAgentChange?.(a.id); setPanel("compose"); }}>
                            Use this agent
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}

                {rosterBots.length > 0 && (
                  <>
                    <div className="dock-panel-head" style={{ marginTop: 8 }}>
                      <span className="dock-panel-title" style={{ fontSize: 11.5 }}>Autonomous Coworker Bots</span>
                      <span className="dock-panel-note">type @handle in message to direct tasks</span>
                    </div>
                    {rosterBots.map((bot) => (
                      <div key={bot.id} className="dock-row">
                        <div className="dock-row-icon" style={{ fontSize: 16 }}>{bot.avatar || "🤖"}</div>
                        <div className="dock-row-main">
                          <div className="dock-row-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span>{bot.name}</span>
                            <span style={{ fontSize: 11, color: "var(--accent)" }}>{bot.handle}</span>
                            <span className="badge" style={{ fontSize: 9, padding: "1px 4px", textTransform: "capitalize" }}>
                              {bot.status}
                            </span>
                          </div>
                          <div className="dock-row-desc">{bot.role}</div>
                        </div>
                        <div className="dock-row-action">
                          <button
                            type="button"
                            className="dock-pill"
                            onClick={() => {
                              onUseTip?.(`${bot.handle} `);
                              setPanel("compose");
                            }}
                          >
                            @Mention
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {availableTemplates && availableTemplates.length > 0 && (
                  <>
                    <div className="dock-panel-head" style={{ marginTop: agentOptions && agentOptions.length > 0 ? 6 : 0 }}>
                      <span className="dock-panel-title" style={{ fontSize: 11.5 }}>Add a template to this project</span>
                      <span className="dock-panel-note">its own tools, autonomy, and instructions</span>
                    </div>
                    {availableTemplates.map((t) => {
                      const isAdding = addingTemplateId === t.id;
                      return (
                        <div key={t.id} className="dock-row">
                          <div className="dock-row-icon"><Icon path={ICONS.agent} size={15} /></div>
                          <div className="dock-row-main">
                            <div className="dock-row-title">{t.name}</div>
                            <div className="dock-row-desc">{t.description}</div>
                          </div>
                          <div className="dock-row-action">
                            <button
                              type="button"
                              className="dock-pill"
                              disabled={!!addingTemplateId}
                              onClick={() => onAddTemplate?.(t.id)}
                            >
                              {isAdding ? "Adding…" : "Add & use"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </>
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
            <div style={{ padding: "0 12px 8px" }}>
              <input
                className="form-input"
                type="text"
                placeholder="Search all apps — Airtable, Jira, Shopify…"
                value={appQuery}
                onChange={(e) => setAppQuery(e.target.value)}
                style={{ width: "100%", fontSize: 12.5 }}
              />
            </div>

            {appQuery.trim().length >= 2 && (
              <>
                {directorySearching && (
                  <div style={{ fontSize: 12.5, color: "var(--text3)", padding: "6px 12px" }}>Searching…</div>
                )}
                {!directorySearching && directory?.length === 0 && (
                  <div style={{ fontSize: 12.5, color: "var(--text3)", padding: "6px 12px" }}>
                    Nothing matching “{appQuery.trim()}”.
                  </div>
                )}
                {directory?.map((a) => (
                  <div key={a.id} className="dock-row">
                    <div className="dock-row-icon">
                      {a.logo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.logo} alt="" loading="lazy" style={{ width: 15, height: 15, objectFit: "contain", borderRadius: 3 }} />
                      ) : (
                        <Icon path={ICONS.plug} size={15} />
                      )}
                    </div>
                    <div className="dock-row-main">
                      <div className="dock-row-title">{a.name}</div>
                      <div className="dock-row-desc">
                        {a.description?.slice(0, 90) || `Connect through ${a.provider} — sign in, no API key`}
                      </div>
                    </div>
                    <div className="dock-row-action">
                      <button type="button" className="dock-pill" disabled={busyId === a.id} onClick={() => void handleDirectoryConnect(a)}>
                        {busyId === a.id ? "…" : "Connect"}
                      </button>
                    </div>
                  </div>
                ))}
                <div className="dock-panel-note" style={{ padding: "8px 12px 2px" }}>Recommended</div>
              </>
            )}

            {availableApps.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--text3)", padding: "6px 12px" }}>Loading…</div>
            ) : (
              availableApps.map((c) => (
                <div key={c.id} className={`dock-row${c.connected ? " active" : ""}`} style={{ flexWrap: "wrap" }}>
                  <div className="dock-row-icon">
                    {c.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.logo} alt="" loading="lazy" style={{ width: 15, height: 15, objectFit: "contain", borderRadius: 3 }} />
                    ) : (
                      <Icon path={ICONS.plug} size={15} />
                    )}
                  </div>
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
                  // Straight into the composer — dropping text into an input the user cannot
                  // see would look like the click did nothing.
                  setPanel("compose");
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

      {/* Uploads — add something new, or point the assistant at something already uploaded.
          The list is the same knowledge shelf the Knowledge panel reads; this view is about
          getting things IN, which is why the upload control leads. */}
      {/* Chat uploads — files for THIS conversation, read directly by the agent from the
          workspace. Not knowledge-base ingestion (that's a separate, curated, cross-session
          store — see the Knowledge page): a screenshot to build a UI from, a spreadsheet to
          summarise, any format, up to 6 at once. */}
      {panel === "uploads" && (
        <div className="dock-panel">
          <div className="dock-panel-head">
            <span className="dock-panel-title">Uploads</span>
            <span className="dock-panel-note">Any file, up to {MAX_UPLOAD_FILES} at once</span>
          </div>
          <div className="dock-panel-body">
            <div className="dock-row">
              <div className="dock-row-icon"><Icon path={ICONS.upload} /></div>
              <div className="dock-row-main">
                <div className="dock-row-title">Attach files to this message</div>
                <div className="dock-row-desc">The agent reads them directly — any format, up to 20MB each.</div>
              </div>
              <div className="dock-row-action">
                <button type="button" className="dock-pill" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                  {uploading ? "Uploading…" : "Choose files"}
                </button>
              </div>
            </div>
            {(pendingUploads?.length ?? 0) > 0 && (
              <>
                <div className="dock-panel-sub">Attached to this message</div>
                {pendingUploads!.map((f) => (
                  <div key={f.key} className="dock-row">
                    <div className="dock-row-icon"><Icon path={ICONS.upload} size={15} /></div>
                    <div className="dock-row-main">
                      <div className="dock-row-title">{f.name}</div>
                      <div className="dock-row-desc">{Math.max(1, Math.round(f.size / 1024))} KB</div>
                    </div>
                    <div className="dock-row-action">
                      <button
                        type="button"
                        className="dock-pill"
                        onClick={() => onUploadsChange?.(pendingUploads!.filter((p) => p.key !== f.key))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
            {priorUploads.length > 0 && (
              <>
                <div className="dock-panel-sub">Uploaded earlier in this conversation</div>
                {priorUploads.map((f) => (
                  <div key={f.key} className="dock-row">
                    <div className="dock-row-icon"><Icon path={ICONS.upload} size={15} /></div>
                    <div className="dock-row-main">
                      <div className="dock-row-title">{f.name}</div>
                      <div className="dock-row-desc">{Math.max(1, Math.round(f.size / 1024))} KB — still readable by the agent</div>
                    </div>
                    <div className="dock-row-action">
                      <button type="button" className="dock-pill" onClick={() => void handleDeletePriorUpload(f.name)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
            {(pendingUploads?.length ?? 0) === 0 && priorUploads.length === 0 && !uploading && (
              <p className="dock-empty">Nothing attached yet.</p>
            )}
          </div>
        </div>
      )}

      {/* The message input is a panel like any other — the dock is only a toolbar until you
          open it. It grows with what you type, up to the dock's own ceiling, then scrolls. */}
      {panel === "compose" && (
        <div className="dock-compose">
          {/* Visual Canvas Inspector Pin Chip */}
          {inspectedElement && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 14px", background: "var(--surface3)", borderBottom: "1px solid var(--border)", fontSize: "12px", color: "var(--text)" }}>
              <span style={{ color: "var(--accent)" }}>🎯 Inspecting:</span>
              <code style={{ fontFamily: "monospace", color: "var(--accent-cyan, #00F0FF)" }}>
                {inspectedElement.filePath}{inspectedElement.line ? `:${inspectedElement.line}` : ""}
              </code>
              {inspectedElement.text && <span style={{ color: "var(--text3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "250px" }}>&ldquo;{inspectedElement.text}&rdquo;</span>}
              <button type="button" onClick={onClearInspectedElement} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: "14px" }}>
                ✕
              </button>
            </div>
          )}
          {children}
        </div>
      )}

      <div className="dock-bar">
        {/* Item 107 removed this as "redundant" (every other panel's own button already returns
           to compose on a second click, plus Escape/outside-click) — reinstated on request: on a
           phone there's no Escape key, and a tap outside the dock is an easy miss on a small
           screen, so an explicit, always-visible way back to the message input earns its place
           even though it duplicates existing affordances on desktop. */}
        <button
          type="button"
          className={`dock-primary${panel === "compose" ? " open" : ""}`}
          onClick={() => setPanel("compose")}
          title="Write a message"
        >
          <Icon path={ICONS.compose} />
          <span>Message</span>
        </button>

        <div className="dock-sep" />

        <button type="button" className={`dock-btn${panel === "model" ? " open" : ""}`} onClick={() => toggle("model")} title={`Model: ${modelLabel(model)}`}>
          <Icon path={ICONS.cube} />
          {capability.reasoningLevels.length > 0 && reasoningLevel && <span className="dock-btn-dot" />}
        </button>
        {/* Effort — shown as its OWN visible text ("Low" by default), not the word "Effort" —
            it's the control's live value, the same way the Model button shows the model's own
            name rather than the word "Model." Always present: even a model with no native
            reasoning mode still has a real low/medium escalation-budget distinction. */}
        <button
          type="button"
          className={`dock-btn dock-btn-labeled${panel === "effort" ? " open" : ""}`}
          onClick={() => toggle("effort")}
          title={`Effort: ${EFFORT_LABELS[effort] ?? effort} — ${effortOptionsForModel(model).find((o) => o.level === effort)?.description ?? ""}`}
        >
          <Icon path={ICONS.gauge} size={14} />
          <span>{EFFORT_LABELS[effort] ?? effort}</span>
        </button>
        {projectId && (
          <button
            type="button"
            className={`dock-btn${panel === "agent" ? " open" : ""}`}
            onClick={() => toggle("agent")}
            title={`Agent: ${agentOptions?.find((a) => a.id === selectedAgentId)?.name ?? "default"}`}
          >
            <Icon path={ICONS.agent} />
          </button>
        )}
        <button type="button" className={`dock-btn${panel === "apps" ? " open" : ""}`} onClick={() => toggle("apps")} title="Connected apps">
          <Icon path={ICONS.plug} />
          {connectedCount > 0 && <span className="dock-btn-dot" />}
        </button>

        <button
          type="button"
          className={`dock-btn dock-btn-labeled${dualTierMode ? " active" : ""}`}
          onClick={() => onToggleDualTierMode?.(!dualTierMode)}
          style={dualTierMode ? { background: "var(--accent-glow, rgba(0, 240, 255, 0.15))", borderColor: "var(--accent-cyan, #00F0FF)", color: "var(--accent-cyan, #00F0FF)" } : {}}
          title={dualTierMode ? "Dual-Tier Mode: ON (Frontier Planner + Open Workers for isolated context & ~96% cost savings)" : "Toggle Dual-Tier Mode (Frontier Planner + Edge Open Workers)"}
        >
          <span style={{ fontSize: "12px", fontWeight: "bold" }}>⚡</span>
          <span>{dualTierMode ? "Dual-Tier" : "/goal"}</span>
        </button>

        <div className="dock-sep" />

        <button type="button" className={`dock-btn${panel === "uploads" ? " open" : ""}`} onClick={() => toggle("uploads")} title="Uploads">
          <Icon path={ICONS.upload} />
        </button>
        <button type="button" className={`dock-btn${panel === "tips" ? " open" : ""}`} onClick={() => toggle("tips")} title="Tips for a better answer">
          <Icon path={ICONS.bulb} />
        </button>
        {onStartVoiceCall && (
          <button
            type="button"
            className="dock-btn dock-btn-labeled"
            onClick={onStartVoiceCall}
            style={{ color: "var(--green, #22c55e)", borderColor: "rgba(34, 197, 94, 0.3)" }}
            title="Start Live Duplex Voice Call with Agent (@cloudflare/voice sub-300ms)"
          >
            <span style={{ fontSize: "12px" }}>📞</span>
            <span>Call</span>
          </button>
        )}

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
