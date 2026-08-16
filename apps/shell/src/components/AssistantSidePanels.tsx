"use client";

// The rich assistant side panel — status/config, memory, crons, channels, sub-agents, files,
// skills, notifications — extracted from the now-removed /dashboard/chat page so the SAME panel
// works everywhere a conversation happens: the assistant/Home session (Chat.tsx with no
// threadId) AND a project thread (Chat.tsx with threadId+projectId), which previously only ever
// showed "Coming soon" for everything but Stats and the consult-subthread Assistant tab.
//
// A project thread scopes two things differently, not everything: Config edits the SPECIFIC
// project agent's own policy override when one is selected (falls back to the space-wide
// assistant_policy otherwise, same three-tier fallback SpaceDO's own resolveAgentPolicy uses),
// and Files reads that PROJECT's own R2 workspace rather than the space-wide assistant one.
// Memory/Crons/Channels/Sub-agents/Skills/Notifications stay space-wide in both contexts —
// there's no per-project memory/cron/channel/notification concept, and the skill library
// (R2 scripts) is shared platform-wide within a space, not siloed per project.

import * as React from "react";
import Link from "next/link";
import {
  getAssistantPolicy,
  updateAssistantPolicy,
  getAgentPolicy,
  updateAgentPolicy,
  getAssistantMemory,
  listScheduledJobs,
  createScheduledJob,
  updateScheduledJob,
  toggleScheduledJob,
  deleteScheduledJob,
  listScheduledJobRuns,
  listAssistantChannels,
  listSubAgents,
  listAssistantFiles,
  listWorkspaceFiles,
  getAssistantCapabilities,
  listNotifications,
  markNotificationRead,
  listMyBusinesses,
  getBusinessAnalytics,
  listSessions,
  type SessionCredentials,
  type AssistantPolicy,
  type AgentPolicy,
  type MemoryFact,
  type ScheduledJob,
  type ScheduledJobRun,
  type ChannelLink,
  type SubAgentSummary,
  type WorkspaceFile,
  type AssistantCapabilities,
  type AppNotification,
  type BusinessAnalytics,
  type SessionSummary,
} from "@/lib/api";
import { useProduct } from "@/lib/product-context";
import { canManageSpaceSettings } from "@/lib/roles";
import { ApprovedActionsEditor, type OperationGroup } from "./ApprovedActionsEditor";

export type SidePanelTab =
  | "config"
  | "memory"
  | "crons"
  | "channels"
  | "heartbeats"
  | "sub-agents"
  | "files"
  | "skills"
  | "notifications";

const ALL_SIDE_PANEL_TABS: { key: SidePanelTab; label: string; assistantOnly?: boolean }[] = [
  { key: "config", label: "Config" },
  { key: "memory", label: "Memory" },
  { key: "crons", label: "Crons" },
  { key: "channels", label: "Channels" },
  // Heartbeats (the wake-up cadence: heartbeats/crons that did real work vs failed) is a
  // whole-business-oversight concept — meaningless scoped to a single project's own agent, which
  // doesn't run on its own heartbeat cycle the way the Space Assistant does. Assistant-view only.
  { key: "heartbeats", label: "Heartbeats", assistantOnly: true },
  { key: "sub-agents", label: "Sub-agents" },
  { key: "files", label: "Files" },
  { key: "skills", label: "Skills" },
  { key: "notifications", label: "Notifications" },
];

/** isProjectContext = true (a project thread) hides tabs that only make sense for the
 *  space-wide Space Assistant (currently just Heartbeats). */
export function sidePanelTabs(isProjectContext: boolean): { key: SidePanelTab; label: string }[] {
  return ALL_SIDE_PANEL_TABS.filter((t) => !t.assistantOnly || !isProjectContext).map((t) => ({ key: t.key, label: t.label }));
}

/** @deprecated use sidePanelTabs(isProjectContext) — kept so any stale import doesn't hard-break. */
export const SIDE_PANEL_TABS = sidePanelTabs(false);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const APPROVAL_MODE_LABEL: Record<AssistantPolicy["approval_mode"], string> = {
  always_ask: "Ask me first",
  gate_unless_listed: "Ask unless pre-approved",
  gate_listed: "Only ask for listed actions",
  yolo: "Fully autonomous",
};

/** Config tab: a run's OWN agent's policy override when one is selected in a project thread
 *  (falls back to space-wide when the agent has none of its own — same as the backend), else the
 *  space-wide assistant policy. Deliberately compact — the full page (dashboard/assistant, or
 *  /agents/:id for a single agent) is one click away for anyone who wants the fuller explanation
 *  of each of the four modes; this tab is "what is it set to, can I flip autonomy, can I edit the
 *  allowlist," not a re-implementation of that page. */
function ConfigPanel({
  spaceId,
  session,
  agentId,
  isBusinessSpace,
}: {
  spaceId: string;
  session: SessionCredentials;
  agentId?: string | null | undefined;
  isBusinessSpace: boolean;
}) {
  const product = useProduct();
  const [canEdit, setCanEdit] = React.useState(false);
  const [spacePolicy, setSpacePolicy] = React.useState<AssistantPolicy | null>(null);
  const [agentPolicy, setAgentPolicy] = React.useState<AgentPolicy | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // Every operation the agent could call, for the "browse all tools" list under the pre-approved
  // editor — same data the Skills tab reads, fetched independently here since a person configuring
  // policy shouldn't have to first visit a different tab to know what's even callable.
  const [catalogue, setCatalogue] = React.useState<OperationGroup[] | undefined>(undefined);

  const scoped = Boolean(agentId);

  React.useEffect(() => {
    let cancelled = false;
    getAssistantCapabilities(spaceId, session)
      .then((caps) => {
        if (cancelled) return;
        setCatalogue(caps.prebuilts.map((p) => ({ script: p.name, description: p.description, operations: p.operations })));
      })
      .catch(() => { if (!cancelled) setCatalogue([]); });
    return () => { cancelled = true; };
  }, [spaceId, session]);

  React.useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    const loaders: Promise<unknown>[] = [
      scoped
        ? getAgentPolicy(spaceId, agentId!, session).then((p) => { if (!cancelled) setAgentPolicy(p); })
        : getAssistantPolicy(spaceId, session).then((p) => { if (!cancelled) setSpacePolicy(p); }),
    ];
    if (isBusinessSpace) {
      loaders.push(
        listMyBusinesses(product.space_id, session)
          .then((list) => list.find((b) => b.id === spaceId) ?? null)
          .then((b) => { if (!cancelled) setCanEdit(canManageSpaceSettings(true, b?.role)); })
      );
    } else {
      setCanEdit(false);
    }
    Promise.allSettled(loaders).catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, session, agentId, isBusinessSpace, product.space_id]);

  async function setSpaceMode(mode: AssistantPolicy["approval_mode"]) {
    setSaving(true);
    try {
      setSpacePolicy(await updateAssistantPolicy(spaceId, session, { approval_mode: mode }));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setSaving(false);
    }
  }
  async function setAgentMode(mode: AgentPolicy["approval_mode"]) {
    setSaving(true);
    try {
      setAgentPolicy(await updateAgentPolicy(spaceId, agentId!, session, { approval_mode: mode }));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setSaving(false);
    }
  }

  const actions = scoped ? agentPolicy?.auto_approved_actions ?? [] : spacePolicy?.auto_approved_actions ?? [];
  const currentMode = scoped ? agentPolicy?.approval_mode : spacePolicy?.approval_mode;

  return (
    <>
      <div className="tp-section">{scoped ? "This Agent's Autonomy" : "Assistant Autonomy"}</div>
      <div style={{ padding: "0 14px 8px" }}>
        {!currentMode && !loadError && <div style={{ fontSize: 12, color: "var(--text3)" }}>Loading…</div>}
        {currentMode && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(scoped ? (["always_ask", "yolo"] as const) : (["always_ask", "gate_unless_listed", "gate_listed", "yolo"] as const)).map((mode) => (
              <button
                key={mode}
                type="button"
                className={mode === currentMode ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
                style={{ padding: "3px 8px", fontSize: 11 }}
                disabled={saving || !canEdit || mode === currentMode}
                onClick={() => void (scoped ? setAgentMode(mode as AgentPolicy["approval_mode"]) : setSpaceMode(mode))}
              >
                {APPROVAL_MODE_LABEL[mode]}
              </button>
            ))}
          </div>
        )}
        {loadError && <div style={{ fontSize: 11.5, color: "#dc2626", marginTop: 6 }}>{loadError}</div>}
      </div>
      <div className="tp-section">Pre-approved actions</div>
      <div style={{ padding: "0 14px 8px" }}>
        <ApprovedActionsEditor
          actions={actions}
          canEdit={canEdit}
          busy={saving}
          catalogue={catalogue}
          onAdd={(a) =>
            void (scoped
              ? updateAgentPolicy(spaceId, agentId!, session, { auto_approved_actions: [...actions, a] }).then(setAgentPolicy)
              : updateAssistantPolicy(spaceId, session, { auto_approved_actions: [...actions, a] }).then(setSpacePolicy))
          }
          onRemove={(a) =>
            void (scoped
              ? updateAgentPolicy(spaceId, agentId!, session, { auto_approved_actions: actions.filter((x) => x !== a) }).then(setAgentPolicy)
              : updateAssistantPolicy(spaceId, session, { auto_approved_actions: actions.filter((x) => x !== a) }).then(setSpacePolicy))
          }
        />
      </div>
      {!isBusinessSpace ? null : (
        <div style={{ padding: "4px 14px 10px" }}>
          <Link
            href={scoped ? `/p/${product.slug}/agents/${encodeURIComponent(agentId!)}` : `/p/${product.slug}/dashboard/assistant`}
            style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none" }}
          >
            Full settings →
          </Link>
        </div>
      )}
    </>
  );
}

function MemoryPanel({ spaceId, session }: { spaceId: string; session: SessionCredentials }) {
  const [memory, setMemory] = React.useState<MemoryFact[] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    getAssistantMemory(spaceId, session).then((m) => { if (!cancelled) setMemory(m); }).catch(() => { if (!cancelled) setMemory([]); });
    return () => { cancelled = true; };
  }, [spaceId, session]);
  return (
    <>
      <div className="tp-section">Facts</div>
      {memory === null ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>
      ) : memory.length === 0 ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>No memory recorded yet.</div>
      ) : (
        memory.map((m) => (
          <div className="memory-item" style={{ padding: "4px 14px" }} key={`${m.category}:${m.key}`}>
            <span className="memory-key">{m.key}</span>
            <span className="memory-val">{typeof m.value === "string" ? m.value : JSON.stringify(m.value)}</span>
          </div>
        ))
      )}
    </>
  );
}

// Phase 3 item 27/28 — a REAL editing UI, not just a read-only list: create/edit/pause-resume/
// delete, next-run display, and per-job recent-fire history. Deliberately goal-only for creation
// (no script_name field) — a script-direct-fire job is what the assistant itself sets up via the
// dynamic-workflow prebuilt (script.find/distill first), not something a person hand-types a raw
// script name for in a narrow side panel; goal-based dispatch (the same shape the default
// revenue-review/leadgen crons already use) is the one a human writes in plain language.
function CronForm({
  spaceId,
  session,
  projectId,
  initial,
  onSaved,
  onCancel,
}: {
  spaceId: string;
  session: SessionCredentials;
  projectId?: string | null | undefined;
  initial?: ScheduledJob;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isEdit = Boolean(initial);
  const [name, setName] = React.useState(initial?.name ?? "");
  const [cronExpr, setCronExpr] = React.useState(initial?.cron_expression ?? "0 9 * * 1");
  const [goal, setGoal] = React.useState(initial?.goal ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    if (!name.trim() || !cronExpr.trim() || !goal.trim()) {
      setError("Name, schedule, and goal are all required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit && initial) {
        await updateScheduledJob(spaceId, initial.id, session, { name, cron_expression: cronExpr, goal });
      } else {
        await createScheduledJob(spaceId, session, { name, cron_expression: cronExpr, goal, ...(projectId ? { project_id: projectId } : {}) });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cron-item" style={{ borderStyle: "dashed" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <input
          className="form-input"
          placeholder="Name (e.g. Weekly revenue review)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ fontSize: 12, padding: "5px 8px" }}
        />
        <input
          className="form-input"
          placeholder="Cron expression (e.g. 0 9 * * 1)"
          value={cronExpr}
          onChange={(e) => setCronExpr(e.target.value)}
          style={{ fontSize: 12, padding: "5px 8px", fontFamily: "monospace" }}
        />
        <textarea
          className="form-input"
          placeholder="What should the assistant do when this fires?"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          style={{ fontSize: 12, padding: "5px 8px", resize: "vertical" }}
        />
        {error && <div style={{ fontSize: 11, color: "#dc2626" }}>{error}</div>}
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving}
            onClick={() => void submit()}
            style={{ fontSize: 11 }}
          >
            {saving ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={onCancel} style={{ fontSize: 11 }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function CronRunHistory({ spaceId, jobId, session }: { spaceId: string; jobId: string; session: SessionCredentials }) {
  const [runs, setRuns] = React.useState<ScheduledJobRun[] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    listScheduledJobRuns(spaceId, jobId, session, 10)
      .then((r) => { if (!cancelled) setRuns(r); })
      .catch(() => { if (!cancelled) setRuns([]); });
    return () => { cancelled = true; };
  }, [spaceId, jobId, session]);
  if (runs === null) return <div style={{ fontSize: 11, color: "var(--text3)", padding: "4px 0" }}>Loading…</div>;
  if (runs.length === 0) return <div style={{ fontSize: 11, color: "var(--text3)", padding: "4px 0" }}>No fires recorded yet.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "6px 0 0", borderTop: "1px solid var(--border)", marginTop: 6 }}>
      {runs.map((r) => (
        <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5 }}>
          <span style={{ color: r.skipped_busy ? "var(--text3)" : r.ok ? "#16a34a" : "#dc2626", fontWeight: 500, flexShrink: 0 }}>
            {r.skipped_busy ? "Skipped (busy)" : r.ok ? "OK" : "Failed"}
          </span>
          <span style={{ color: "var(--text3)", flexShrink: 0 }}>{new Date(r.fired_at).toLocaleString()}</span>
          {r.duration_ms != null && <span style={{ color: "var(--text3)", flexShrink: 0 }}>{r.duration_ms}ms</span>}
          {r.error && (
            <span
              style={{ color: "#dc2626", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={r.error}
            >
              {r.error}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function CronsPanel({
  spaceId,
  session,
  projectId,
  isBusinessSpace,
}: {
  spaceId: string;
  session: SessionCredentials;
  projectId?: string | null | undefined;
  isBusinessSpace: boolean;
}) {
  const product = useProduct();
  const [crons, setCrons] = React.useState<ScheduledJob[] | null>(null);
  const [canEdit, setCanEdit] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [historyId, setHistoryId] = React.useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    listScheduledJobs(spaceId, session, { projectId: projectId ?? null })
      .then(setCrons)
      .catch(() => setCrons([]));
  }, [spaceId, session, projectId]);
  React.useEffect(() => {
    setCrons(null);
    load();
  }, [load]);

  React.useEffect(() => {
    let cancelled = false;
    if (!isBusinessSpace) {
      setCanEdit(false);
      return;
    }
    listMyBusinesses(product.space_id, session)
      .then((list) => list.find((b) => b.id === spaceId) ?? null)
      .then((b) => { if (!cancelled) setCanEdit(canManageSpaceSettings(true, b?.role)); })
      .catch(() => { if (!cancelled) setCanEdit(false); });
    return () => { cancelled = true; };
  }, [spaceId, session, isBusinessSpace, product.space_id]);

  async function toggle(job: ScheduledJob) {
    setBusyId(job.id);
    try {
      await toggleScheduledJob(spaceId, job.id, session, !job.enabled);
      load();
    } catch {
      // Best-effort — the list reload below will show the real (unchanged) state either way.
    } finally {
      setBusyId(null);
    }
  }

  async function doDelete(job: ScheduledJob) {
    if (confirmDeleteId !== job.id) {
      setConfirmDeleteId(job.id);
      setTimeout(() => setConfirmDeleteId((cur) => (cur === job.id ? null : cur)), 4000);
      return;
    }
    setConfirmDeleteId(null);
    setBusyId(job.id);
    try {
      await deleteScheduledJob(spaceId, job.id, session);
      load();
    } catch {
      // Best-effort — a failed delete just leaves the row in place.
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="tp-section" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>{projectId ? "This Project's Scheduled Jobs" : "Assistant's Scheduled Jobs"}</span>
        {canEdit && !creating && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 10.5, padding: "2px 7px" }}
            onClick={() => setCreating(true)}
          >
            + New
          </button>
        )}
      </div>
      <div style={{ padding: "0 10px 8px" }}>
        {creating && (
          <CronForm
            spaceId={spaceId}
            session={session}
            projectId={projectId}
            onCancel={() => setCreating(false)}
            onSaved={() => { setCreating(false); load(); }}
          />
        )}
        {crons === null ? (
          <div style={{ fontSize: 12, color: "var(--text3)", padding: "4px 4px" }}>Loading…</div>
        ) : crons.length === 0 && !creating ? (
          <div style={{ fontSize: 12, color: "var(--text3)", padding: "4px 4px" }}>No scheduled jobs.</div>
        ) : (
          crons.map((job) =>
            editingId === job.id ? (
              <CronForm
                key={job.id}
                spaceId={spaceId}
                session={session}
                projectId={projectId}
                initial={job}
                onCancel={() => setEditingId(null)}
                onSaved={() => { setEditingId(null); load(); }}
              />
            ) : (
              <div className="cron-item" key={job.id}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>{job.name}</div>
                  <span className={`badge ${job.enabled ? "badge-green" : "badge-amber"}`} style={{ fontSize: 9 }}>
                    {job.enabled ? "Active" : "Paused"}
                  </span>
                </div>
                <div className="cron-expr">{job.cron_expression}</div>
                {job.enabled && job.next_run_at != null && (
                  <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
                    Next: {new Date(job.next_run_at).toLocaleString()}
                  </div>
                )}
                {job.last_run_at && (
                  <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
                    Last run: {new Date(job.last_run_at).toLocaleString()}
                  </div>
                )}
                {job.consecutive_failures > 0 && (
                  <div style={{ fontSize: 11, color: "#d97706", marginTop: 2 }}>{job.consecutive_failures} consecutive failure(s)</div>
                )}
                <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 10.5, padding: "2px 7px" }}
                    onClick={() => setHistoryId((cur) => (cur === job.id ? null : job.id))}
                  >
                    {historyId === job.id ? "Hide history" : "History"}
                  </button>
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 10.5, padding: "2px 7px" }}
                        disabled={busyId === job.id}
                        onClick={() => void toggle(job)}
                      >
                        {job.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 10.5, padding: "2px 7px" }}
                        onClick={() => setEditingId(job.id)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        style={{ fontSize: 10.5, padding: "2px 7px" }}
                        disabled={busyId === job.id}
                        onClick={() => void doDelete(job)}
                      >
                        {confirmDeleteId === job.id ? "Confirm delete?" : "Delete"}
                      </button>
                    </>
                  )}
                </div>
                {historyId === job.id && <CronRunHistory spaceId={spaceId} jobId={job.id} session={session} />}
              </div>
            )
          )
        )}
      </div>
    </>
  );
}

function ChannelsPanel({ spaceId, session, projectId }: { spaceId: string; session: SessionCredentials; projectId?: string | null | undefined }) {
  const [channels, setChannels] = React.useState<ChannelLink[] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setChannels(null);
    listAssistantChannels(spaceId, session, { projectId: projectId ?? null }).then((c) => { if (!cancelled) setChannels(c); }).catch(() => { if (!cancelled) setChannels([]); });
    return () => { cancelled = true; };
  }, [spaceId, session, projectId]);
  return (
    <>
      <div className="tp-section">{projectId ? "This Project's Channels" : "Assistant's Channels"}</div>
      {channels === null ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>
      ) : channels.length === 0 ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>No channels configured.</div>
      ) : (
        channels.map((c) => (
          <div className="tp-tool-row" key={c.channel}>
            <div className="tp-tool-name" style={{ textTransform: "capitalize" }}>{c.channel}</div>
            <div className="tp-tool-badge" style={!c.enabled ? { color: "var(--text3)" } : undefined}>{c.enabled ? "Connected" : "Off"}</div>
          </div>
        ))
      )}
    </>
  );
}

function SubAgentsPanel({ spaceId, session, lastRunId }: { spaceId: string; session: SessionCredentials; lastRunId: string }) {
  const [subAgents, setSubAgents] = React.useState<SubAgentSummary[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    setFailed(false);
    // No run id is no longer a dead end: the agent DO is addressed per conversation, so an empty
    // parent_run_id lists this conversation's whole fan-out rather than nothing. Previously a
    // reload (which loses lastRunId) or a latest turn that spawned nothing reported "no sub-agent
    // activity" no matter how much had really run.
    listSubAgents(spaceId, session, lastRunId)
      .then((s) => { if (!cancelled) setSubAgents(s); })
      .catch(() => { if (!cancelled) { setSubAgents([]); setFailed(true); } });
    return () => { cancelled = true; };
  }, [spaceId, session, lastRunId]);
  return (
    <>
      <div className="tp-section">Sub-agents</div>
      {subAgents === null ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>
      ) : failed ? (
        // Never report "none" for a request that failed — telling someone no agent ran when the
        // list merely didn't load is the kind of wrong answer that gets acted on.
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>
          Couldn&apos;t load sub-agent activity.
        </div>
      ) : subAgents.length === 0 ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>
          No sub-agents have run in this conversation.
        </div>
      ) : (
        <div style={{ padding: "0 10px 8px" }}>
          {subAgents.map((sa) => (
            <div className="sub-agent-item" key={sa.id}>
              <div className="ws-dot" style={sa.status === "completed" ? { background: "#22c55e", animation: "none" } : undefined} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>{sa.goal}</div>
                <div style={{ fontSize: 11, color: "var(--text3)" }}>{sa.status}{sa.progress_note ? ` · ${sa.progress_note}` : ""}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function FilesPanel({ spaceId, projectId, session }: { spaceId: string; projectId?: string | null | undefined; session: SessionCredentials }) {
  const [files, setFiles] = React.useState<WorkspaceFile[] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const load = projectId ? listWorkspaceFiles(spaceId, projectId, session) : listAssistantFiles(spaceId, session);
    load.then((f) => { if (!cancelled) setFiles(f); }).catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [spaceId, projectId, session]);
  return (
    <>
      <div className="tp-section">{projectId ? "Project Workspace" : "Workspace"}</div>
      {files === null ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>
      ) : files.length === 0 ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>No files yet.</div>
      ) : (
        files.map((f) => (
          <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 14px", fontSize: 11.5 }}>
            <span style={{ color: "var(--text2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
            <span style={{ color: "var(--text3)", fontSize: 10 }}>{formatBytes(f.size)}</span>
          </div>
        ))
      )}
    </>
  );
}

function SkillsPanel({ spaceId, session }: { spaceId: string; session: SessionCredentials }) {
  const [caps, setCaps] = React.useState<AssistantCapabilities | null>(null);
  const [showAllPrebuilts, setShowAllPrebuilts] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    getAssistantCapabilities(spaceId, session).then((c) => { if (!cancelled) setCaps(c); }).catch(() => { if (!cancelled) setCaps({ prebuilts: [], skills: [], prebuilt_count: 0, skill_count: 0 }); });
    return () => { cancelled = true; };
  }, [spaceId, session]);
  if (!caps) return <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>;
  const prebuilts = showAllPrebuilts ? caps.prebuilts : caps.prebuilts.slice(0, 6);
  return (
    <>
      <div className="tp-section">Learned Skills ({caps.skill_count})</div>
      {caps.skills.length === 0 ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>
          None yet — these are written by the assistant itself as it works and build up with use.
        </div>
      ) : (
        caps.skills.map((s) => (
          <div className="tp-tool-row" key={s.name} style={{ cursor: "default" }}>
            <div className="tp-tool-name" style={{ fontFamily: "monospace", fontSize: 11.5 }}>{s.name}</div>
          </div>
        ))
      )}
      <div className="tp-section">Built-in Scripts ({caps.prebuilt_count})</div>
      {prebuilts.map((p) => (
        <div key={p.name} style={{ padding: "5px 14px" }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>{p.name}</div>
          <div style={{ fontSize: 11, color: "var(--text3)", lineHeight: 1.5 }}>{p.description}</div>
        </div>
      ))}
      {!showAllPrebuilts && caps.prebuilts.length > 6 && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ margin: "4px 14px", fontSize: 11 }}
          onClick={() => setShowAllPrebuilts(true)}
        >
          Show all {caps.prebuilts.length}
        </button>
      )}
    </>
  );
}

function NotificationsPanel({ spaceId, session, projectId }: { spaceId: string; session: SessionCredentials; projectId?: string | null | undefined }) {
  const [items, setItems] = React.useState<AppNotification[] | null>(null);
  const [loadError, setLoadError] = React.useState(false);

  // The assistant/Home view wants ALL notifications (it oversees the whole business); a project
  // thread wants only its own agent's — that's what omitting vs. passing projectId does here.
  const load = React.useCallback(() => {
    listNotifications(spaceId, session, { limit: 30, projectId })
      .then(setItems)
      .catch(() => setLoadError(true));
  }, [spaceId, session, projectId]);
  React.useEffect(() => { load(); }, [load]);

  async function markRead(id: string) {
    setItems((prev) => (prev ? prev.map((n) => (n.id === id ? { ...n, status: "read" as const } : n)) : prev));
    try {
      await markNotificationRead(spaceId, id, session);
    } catch {
      load(); // reconcile with the real state on failure — a mis-shown "read" must not stick
    }
  }

  return (
    <>
      <div className="tp-section">{projectId ? "This Project's Notifications" : "All Notifications"}</div>
      {loadError ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Couldn't load notifications.</div>
      ) : items === null ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Nothing to see.</div>
      ) : (
        <div style={{ padding: "0 10px 8px" }}>
          {items.map((n) => (
            <div
              key={n.id}
              className="cron-item"
              style={{ opacity: n.status === "read" ? 0.55 : 1, cursor: n.status === "unread" ? "pointer" : "default" }}
              onClick={() => n.status === "unread" && void markRead(n.id)}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2, gap: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>{n.title}</div>
                <span
                  className={`badge ${n.severity === "critical" ? "badge-red" : n.severity === "warning" ? "badge-amber" : "badge-blue"}`}
                  style={{ fontSize: 9, flexShrink: 0 }}
                >
                  {n.severity}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text3)", lineHeight: 1.5 }}>{n.body}</div>
              <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{new Date(n.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Assistant-view-only: the wake-up cadence — heartbeats/crons that actually did work vs failed,
 *  broken down by trigger. Reuses the already-built business-analytics rollup (same data the
 *  Dashboard's own Analytics section renders) rather than a new endpoint. */
function HeartbeatsPanel({ spaceId, session }: { spaceId: string; session: SessionCredentials }) {
  const product = useProduct();
  const [data, setData] = React.useState<BusinessAnalytics | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  // Actual heartbeat/cron-wake sessions — one of the ONLY two places these are meant to surface
  // (the Sessions page's own filter tab is the other). Deliberately a SEPARATE fetch/failure state
  // from the analytics rollup above: a session-list failure shouldn't blank the stats, and vice
  // versa.
  const [sessions, setSessions] = React.useState<SessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    getBusinessAnalytics(spaceId, session, "7d")
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    listSessions(spaceId, session, 20, "heartbeat")
      .then((s) => { if (!cancelled) setSessions(s); })
      .catch(() => { if (!cancelled) setSessionsError(true); });
    return () => { cancelled = true; };
  }, [spaceId, session]);

  if (loadError) return <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Couldn&apos;t load heartbeat activity.</div>;
  if (!data) return <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>;

  const { completed_with_work, failed } = data.heartbeats;
  const total = completed_with_work + failed;
  return (
    <>
      <div className="tp-section">Last 7 Days</div>
      <div style={{ display: "flex", gap: 8, padding: "0 14px 10px" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)" }}>{completed_with_work}</div>
          <div style={{ fontSize: 10.5, color: "var(--text3)" }}>did real work</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: failed > 0 ? "#dc2626" : "var(--text)" }}>{failed}</div>
          <div style={{ fontSize: 10.5, color: "var(--text3)" }}>failed</div>
        </div>
      </div>
      {total === 0 ? (
        <div style={{ padding: "0 14px 8px", fontSize: 12, color: "var(--text3)" }}>
          No wake-ups yet — heartbeats, connector polls, and scheduled jobs will show up here once they run.
        </div>
      ) : data.heartbeats.by_trigger.length > 0 ? (
        <>
          <div className="tp-section">Failures by Trigger</div>
          <div style={{ padding: "0 10px 8px" }}>
            {data.heartbeats.by_trigger.map((t) => (
              <div className="tp-tool-row" key={t.trigger}>
                <div className="tp-tool-name" style={{ textTransform: "capitalize" }}>{t.trigger.replace(/_/g, " ")}</div>
                <div className="tp-tool-badge" style={{ color: "#dc2626" }}>{t.failed} failed</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ padding: "0 14px 8px", fontSize: 12, color: "var(--text3)" }}>No failures this week.</div>
      )}
      <div className="tp-section">Heartbeat Sessions</div>
      {sessionsError ? (
        <div style={{ padding: "0 14px 8px", fontSize: 12, color: "var(--text3)" }}>Couldn&apos;t load heartbeat sessions.</div>
      ) : sessions === null ? (
        <div style={{ padding: "0 14px 8px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>
      ) : sessions.length === 0 ? (
        <div style={{ padding: "0 14px 8px", fontSize: 12, color: "var(--text3)" }}>
          Nothing yet — a wake-up's own conversation shows up here once one runs.
        </div>
      ) : (
        <div style={{ padding: "0 10px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
          {sessions.map((s) => (
            <Link
              key={s.id}
              href={`/p/${product.slug}/sessions/${s.id}`}
              className="tp-tool-row"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div className="tp-tool-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.title ?? "Untitled wake-up"}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function AssistantSidePanelBody({
  spaceId,
  session,
  tab,
  agentId,
  projectId,
  lastRunId,
  isBusinessSpace,
}: {
  spaceId: string;
  session: SessionCredentials;
  tab: SidePanelTab;
  /** A project thread's currently-selected agent, when one is explicitly bound — scopes the
   *  Config tab to that agent's own policy instead of the space-wide one. */
  agentId?: string | null | undefined;
  projectId?: string | null | undefined;
  /** Scopes the Sub-agents tab to the run that actually produced any — empty until a first send. */
  lastRunId?: string | null | undefined;
  isBusinessSpace: boolean;
}) {
  switch (tab) {
    case "config":
      return <ConfigPanel spaceId={spaceId} session={session} agentId={agentId} isBusinessSpace={isBusinessSpace} />;
    case "memory":
      return <MemoryPanel spaceId={spaceId} session={session} />;
    case "crons":
      return <CronsPanel spaceId={spaceId} session={session} projectId={projectId} isBusinessSpace={isBusinessSpace} />;
    case "channels":
      return <ChannelsPanel spaceId={spaceId} session={session} projectId={projectId} />;
    case "heartbeats":
      return <HeartbeatsPanel spaceId={spaceId} session={session} />;
    case "sub-agents":
      return <SubAgentsPanel spaceId={spaceId} session={session} lastRunId={lastRunId ?? ""} />;
    case "files":
      return <FilesPanel spaceId={spaceId} projectId={projectId} session={session} />;
    case "skills":
      return <SkillsPanel spaceId={spaceId} session={session} />;
    case "notifications":
      return <NotificationsPanel spaceId={spaceId} session={session} projectId={projectId} />;
  }
}
