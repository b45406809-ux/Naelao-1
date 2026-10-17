"use client";

// The rich assistant side panel — status/config, memory, crons, channels, sub-agents, files,
// skills, notifications — extracted from the now-removed /dashboard/chat page so the SAME panel
// works everywhere a conversation happens: the assistant/Home session (Chat.tsx with no
// threadId) AND a project thread (Chat.tsx with threadId+projectId), which previously only ever
// showed "Coming soon" for everything but Stats and the consult-subthread Assistant tab.
//
// A project thread scopes Config, Files and Crons to the selected project. Project crons wake
// the configured project planner; the assistant/Home view shows only space-wide jobs. Channels,
// Memory, Skills and Notifications remain space-wide because their current APIs have no
// project-scoped model, and the skill library is shared within a Space. Local Machine is
// the one tab scoped the OTHER way — project-only, since local_grants.project_id already lets a
// grant be scoped to one project and the space-wide business detail page already owns the
// whole-space view.

import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { detectRuntimeAnomaly, isJobOverdue } from "@naelao/events";
import { presentAutonomyPolicy } from "@naelao/agent-sdk";
import { ChannelConnect, CHANNELS } from "./ChannelConnect";
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
  listAgentDefinitions,
  listAgentTemplates,
  instantiateAgentTemplate,
  listAssistantFiles,
  listWorkspaceFiles,
  readAssistantFile,
  readWorkspaceFile,
  listArtifacts,
  getArtifact,
  deleteArtifact,
  getAssistantCapabilities,
  getSkillsDirectory,
  inheritSkills,
  listNotifications,
  markNotificationRead,
  listLocalGrants,
  createLocalGrant,
  deleteLocalGrant,
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
  type AgentDefinitionSummary,
  type AgentTemplateSummary,
  type WorkspaceFile,
  type ArtifactSummary,
  type ArtifactContent,
  type AssistantCapabilities,
  type AppNotification,
  type BusinessAnalytics,
  type SessionSummary,
  type LocalGrant,
  type DirectorySkill,
  type WorkspaceFileContent,
} from "@/lib/api";
import { useProduct } from "@/lib/product-context";
import { canManageSpaceSettings } from "@/lib/roles";
import { FileViewer } from "@/components/FileViewer";
import { HtmlPreviewFrame } from "@/components/HtmlPreviewFrame";
import { ApprovedActionsEditor, type OperationGroup } from "./ApprovedActionsEditor";

export type SidePanelTab =
  | "config"
  | "memory"
  | "crons"
  | "channels"
  | "heartbeats"
  | "sub-agents"
  | "files"
  | "artifacts"
  | "skills"
  | "notifications"
  | "local-machine";

const ALL_SIDE_PANEL_TABS: { key: SidePanelTab; label: string; assistantOnly?: boolean; projectOnly?: boolean }[] = [
  { key: "config", label: "Config" },
  { key: "memory", label: "Memory" },
  { key: "crons", label: "Crons" },
  { key: "channels", label: "Channels" },
  // Heartbeats (the wake-up cadence: heartbeats/crons that did real work vs failed) is a
  // whole-business-oversight concept — meaningless scoped to a single project's own agent, which
  // doesn't run on its own heartbeat cycle the way the Space Assistant does. Assistant-view only.
  { key: "heartbeats", label: "Heartbeats", assistantOnly: true },
  { key: "sub-agents", label: "Workers" },
  { key: "files", label: "Files" },
  // Phase 5: agent-authored deliverables, distinct from Files (the agent's own scratch
  // workspace) — replaces Chat.tsx's old hardcoded "Coming soon." placeholder tab. Space-wide
  // only for now (the backend has no per-project artifact scoping yet, matching Memory/Skills'
  // own precedent), so this renders identically whether opened from a project thread or Home.
  { key: "artifacts", label: "Artifacts" },
  { key: "skills", label: "Skills" },
  { key: "notifications", label: "Notifications" },
  // The business detail page (spaces/[businessId]) already has a full space-wide grants CRUD UI —
  // duplicating that here would be redundant. This tab is deliberately the OPPOSITE scoping: it
  // exists ONLY inside a project thread, showing the grants that would actually apply to a run in
  // THAT project (its own scoped grants plus every space-wide one, mirroring local-machine.ts's
  // own resolution rule) with the ability to add a grant scoped to just this project.
  { key: "local-machine", label: "Local Access" },
];

/** isProjectContext = true (a project thread) hides tabs that only make sense for the
 *  space-wide Space Assistant (currently just Heartbeats); false (Home/assistant session) hides
 *  the reverse — tabs that only make sense scoped to one project (currently just Local Machine). */
export function sidePanelTabs(isProjectContext: boolean): { key: SidePanelTab; label: string }[] {
  return ALL_SIDE_PANEL_TABS
    .filter((t) => !t.assistantOnly || !isProjectContext)
    .filter((t) => !t.projectOnly || isProjectContext)
    .map((t) => ({ key: t.key, label: t.label }));
}

/** @deprecated use sidePanelTabs(isProjectContext) — kept so any stale import doesn't hard-break. */
export const SIDE_PANEL_TABS = sidePanelTabs(false);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

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
  projectId,
}: {
  spaceId: string;
  session: SessionCredentials;
  agentId?: string | null | undefined;
  isBusinessSpace: boolean;
  projectId?: string | null | undefined;
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
    getAssistantCapabilities(spaceId, session, projectId ?? undefined)
      .then((caps) => {
        if (cancelled) return;
        setCatalogue(caps.prebuilts.map((p) => ({ script: p.name, description: p.description, operations: p.operations })));
      })
      .catch(() => { if (!cancelled) setCatalogue([]); });
    return () => { cancelled = true; };
  }, [spaceId, session, projectId]);

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
  const currentAutonomy = scoped ? presentAutonomyPolicy(agentPolicy) : presentAutonomyPolicy(spacePolicy);

  return (
    <>
      <div className="tp-section">{scoped ? "This Agent's Autonomy" : "Assistant Autonomy"}</div>
      <div style={{ padding: "0 14px 8px" }}>
        {!currentMode && !loadError && <div style={{ fontSize: 12, color: "var(--text3)" }}>Loading…</div>}
        {currentMode && (
          <div style={{ fontSize: 11.5, color: "var(--text3)", marginBottom: 8 }}>
            {currentAutonomy.explanation}
          </div>
        )}
        {currentMode && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["always_ask", "yolo"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={mode === currentMode ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
                style={{ padding: "3px 8px", fontSize: 11 }}
                disabled={saving || !canEdit || mode === currentMode}
                onClick={() => void (scoped ? setAgentMode(mode) : setSpaceMode(mode))}
              >
                {mode === "always_ask" ? "Ask first" : "Run within limits"}
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
  // Watchdog: is the MOST RECENT run anomalously slow against this job's own recent history?
  // Only ever flags the newest row, never every slow-looking one, so it reads as "something
  // changed" rather than a permanent warning on a job that's simply always been this slow.
  const anomaly = detectRuntimeAnomaly(runs);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "6px 0 0", borderTop: "1px solid var(--border)", marginTop: 6 }}>
      {anomaly && (
        <div style={{ fontSize: 10.5, color: "#d97706", padding: "0 0 4px" }}>
          ⚠ Last run took {anomaly.latest_ms}ms — {anomaly.ratio.toFixed(1)}x its recent average ({anomaly.average_ms}ms).
        </div>
      )}
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
  const [cronError, setCronError] = React.useState<string | null>(null);
  const [canEdit, setCanEdit] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [historyId, setHistoryId] = React.useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setCronError(null);
    listScheduledJobs(spaceId, session, { projectId: projectId ?? null })
      .then(setCrons)
      .catch(error => { setCrons([]); setCronError(error instanceof Error ? error.message : "Couldn't load scheduled jobs."); });
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
    } catch (error) {
      setCronError(error instanceof Error ? error.message : "Couldn't change this schedule.");
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
    } catch (error) {
      setCronError(error instanceof Error ? error.message : "Couldn't remove this schedule.");
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
            projectId={projectId ?? null}
            onCancel={() => setCreating(false)}
            onSaved={() => { setCreating(false); load(); }}
          />
        )}
        {cronError ? <div role="alert"><p>{cronError}</p><button className="btn btn-ghost btn-sm" onClick={load}>Retry</button></div> : crons === null ? (
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
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2, gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>{job.name}</div>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    {/* Watchdog: it fired before and the fire that should have followed is well
                        past due — the sweep genuinely isn't reaching this job, not just "not yet
                        due" (next_run_at can never itself be in the past — see isJobOverdue). */}
                    {isJobOverdue(Boolean(job.enabled), job.cron_expression, job.last_run_at ? new Date(job.last_run_at).getTime() : null, Date.now()) && (
                      <span className="badge badge-red" style={{ fontSize: 9 }} title="Enabled, but the sweep hasn't reached this job in longer than expected">
                        Overdue
                      </span>
                    )}
                    <span className={`badge ${job.enabled ? "badge-green" : "badge-amber"}`} style={{ fontSize: 9 }}>
                      {job.enabled ? "Active" : "Paused"}
                    </span>
                  </div>
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

function ChannelsPanel({
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
  const [channels, setChannels] = React.useState<ChannelLink[] | null>(null);
  const [canManage, setCanManage] = React.useState(false);
  const [showConnect, setShowConnect] = React.useState(false);

  const load = React.useCallback(() => {
    listAssistantChannels(spaceId, session, { projectId: projectId ?? null }).then(setChannels).catch(() => setChannels([]));
  }, [spaceId, session, projectId]);
  React.useEffect(() => { setChannels(null); load(); }, [load]);

  // Public channels can be attached to a project; management still follows the business
  // owner/admin role rather than project membership alone.
  React.useEffect(() => {
    let cancelled = false;
    if (!isBusinessSpace) { setCanManage(false); return; }
    listMyBusinesses(product.space_id, session)
      .then((list) => list.find((b) => b.id === spaceId) ?? null)
      .then((b) => { if (!cancelled) setCanManage(canManageSpaceSettings(true, b?.role)); })
      .catch(() => { if (!cancelled) setCanManage(false); });
    return () => { cancelled = true; };
  }, [spaceId, session, isBusinessSpace, projectId, product.space_id]);

  return (
    <>
      <div className="tp-section" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>{projectId ? "This Project's Channels" : "Assistant's Channels"}</span>
        {canManage && !showConnect && (
          <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 10.5, padding: "2px 7px" }} onClick={() => setShowConnect(true)}>
            + Connect
          </button>
        )}
      </div>
      {channels === null ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>
      ) : (
        // Every channel the platform supports, not only the ones already wired up — otherwise a
        // business with none sees an empty list and no sense of what it could connect. An
        // unconnected row opens the same connect flow the "+ Connect" button does.
        CHANNELS.map((meta) => {
          const link = channels.find((c) => c.channel === meta.id);
          const state = !link ? "Not connected" : link.enabled ? "Connected" : "Off";
          const connected = Boolean(link);
          return (
            <div
              className="tp-tool-row"
              key={meta.id}
              {...(!connected && canManage
                ? {
                    role: "button" as const,
                    tabIndex: 0,
                    onClick: () => setShowConnect(true),
                    style: { cursor: "pointer" },
                    title: `Connect ${meta.name}`,
                  }
                : {})}
            >
              <div className="tp-tool-name">{meta.name}</div>
              <div className="tp-tool-badge" style={connected && link?.enabled ? undefined : { color: "var(--text3)" }}>
                {state}
              </div>
            </div>
          );
        })
      )}
      {showConnect && (
        <div style={{ padding: "8px 10px" }}>
          <ChannelConnect
            spaceId={spaceId}
            session={session}
            projectId={projectId ?? null}
            channels={channels ?? []}
            canManage={canManage}
            onChanged={load}
          />
        </div>
      )}
    </>
  );
}

const LOCAL_GRANT_TYPES = ["read", "write", "readwrite", "exec"] as const;

/** Project-only (see ALL_SIDE_PANEL_TABS): what would apply to a run in THIS project — its own
 *  scoped grants plus every space-wide one — with the ability to add a grant scoped to just this
 *  project. The business detail page owns the full, space-wide grants view; this is deliberately
 *  narrower, matching how Files/Config already scope down inside a project thread. */
function LocalMachinePanel({
  spaceId,
  session,
  projectId,
  isBusinessSpace,
}: {
  spaceId: string;
  session: SessionCredentials;
  projectId?: string | null;
  isBusinessSpace: boolean;
}) {
  const product = useProduct();
  const [grants, setGrants] = React.useState<LocalGrant[] | null>(null);
  const [canEdit, setCanEdit] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [grantType, setGrantType] = React.useState<(typeof LOCAL_GRANT_TYPES)[number]>("read");
  const [directory, setDirectory] = React.useState("");
  const [commandsText, setCommandsText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    listLocalGrants(spaceId, session, projectId ? { projectId } : {}).then(setGrants).catch(() => setGrants([]));
  }, [spaceId, session, projectId]);
  React.useEffect(() => { setGrants(null); load(); }, [load]);

  React.useEffect(() => {
    let cancelled = false;
    if (!isBusinessSpace) { setCanEdit(false); return; }
    listMyBusinesses(product.space_id, session)
      .then((list) => list.find((b) => b.id === spaceId) ?? null)
      .then((b) => { if (!cancelled) setCanEdit(canManageSpaceSettings(true, b?.role)); })
      .catch(() => { if (!cancelled) setCanEdit(false); });
    return () => { cancelled = true; };
  }, [spaceId, session, isBusinessSpace, product.space_id]);

  async function handleCreate() {
    setFormError(null);
    try {
      if (grantType === "exec") {
        const list = commandsText.split(",").map((s) => s.trim()).filter(Boolean);
        if (list.length === 0) throw new Error("List at least one command");
        setSaving(true);
        await createLocalGrant(spaceId, session, { grant_type: "exec", commands: list, ...(projectId ? { project_id: projectId } : {}) });
      } else {
        if (!directory.trim()) throw new Error("Enter a directory");
        setSaving(true);
        await createLocalGrant(spaceId, session, { grant_type: grantType, directory: directory.trim(), ...(projectId ? { project_id: projectId } : {}) });
      }
      setCreating(false);
      setDirectory("");
      setCommandsText("");
      setGrantType("read");
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Couldn't create grant");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(grant: LocalGrant) {
    if (confirmDeleteId !== grant.id) {
      setConfirmDeleteId(grant.id);
      setTimeout(() => setConfirmDeleteId((cur) => (cur === grant.id ? null : cur)), 4000);
      return;
    }
    setConfirmDeleteId(null);
    setBusyId(grant.id);
    try {
      await deleteLocalGrant(spaceId, grant.id, session);
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
        <span>{projectId ? "Local Access — This Project" : "Local Access — This Space"}</span>
        {canEdit && !creating && (
          <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 10.5, padding: "2px 7px" }} onClick={() => setCreating(true)}>
            + New
          </button>
        )}
      </div>
      <div style={{ padding: "0 10px 8px" }}>
        <div style={{ fontSize: 11, color: "var(--text3)", padding: "2px 4px 8px", lineHeight: 1.5 }}>
          What workers may read, write, or run on your connected local machine.
          {projectId ? " This project also inherits space-wide grants." : " These grants apply across the space."} Nothing is granted until you add it.
        </div>
        {creating && (
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8, marginBottom: 8 }}>
            <select
              value={grantType}
              onChange={(e) => setGrantType(e.target.value as (typeof LOCAL_GRANT_TYPES)[number])}
              style={{ width: "100%", marginBottom: 6, fontSize: 12 }}
            >
              {LOCAL_GRANT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            {grantType === "exec" ? (
              <input
                type="text"
                placeholder="npm test, git status (comma-separated)"
                value={commandsText}
                onChange={(e) => setCommandsText(e.target.value)}
                style={{ width: "100%", marginBottom: 6, fontSize: 12 }}
              />
            ) : (
              <input
                type="text"
                placeholder="/Users/you/projects/my-repo"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                style={{ width: "100%", marginBottom: 6, fontSize: 12 }}
              />
            )}
            {formError && <div style={{ fontSize: 11, color: "#dc2626", marginBottom: 6 }}>{formError}</div>}
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="btn btn-primary btn-sm" style={{ fontSize: 11 }} disabled={saving} onClick={() => void handleCreate()}>
                {saving ? "Adding…" : "Add grant"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => { setCreating(false); setFormError(null); }}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {grants === null ? (
          <div style={{ fontSize: 12, color: "var(--text3)", padding: "4px 4px" }}>Loading…</div>
        ) : grants.length === 0 && !creating ? (
          <div style={{ fontSize: 12, color: "var(--text3)", padding: "4px 4px" }}>No local access grants yet.</div>
        ) : (
          grants.map((g) => (
            <div className="cron-item" key={g.id}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", textTransform: "capitalize" }}>{g.grant_type}</div>
                <span className="badge badge-blue" style={{ fontSize: 9 }}>
                  {g.project_id ? "This project" : "Space-wide"}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text3)", fontFamily: "monospace", wordBreak: "break-all" }}>
                {g.grant_type === "exec" ? g.commands.join(", ") : g.directory}
              </div>
              {canEdit && (
                <div style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    style={{ fontSize: 10.5, padding: "2px 7px" }}
                    disabled={busyId === g.id}
                    onClick={() => void handleDelete(g)}
                  >
                    {confirmDeleteId === g.id ? "Confirm delete?" : "Delete"}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}

function WorkersPanel({
  spaceId, session, lastRunId, sessionId, agentId, projectId, projectAgentIds,
}: {
  spaceId: string; session: SessionCredentials; lastRunId: string;
  sessionId?: string | null | undefined; agentId?: string | null | undefined;
  projectId?: string | null | undefined;
  projectAgentIds?: string[] | null | undefined;
}) {
  const [subAgents, setSubAgents] = React.useState<SubAgentSummary[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [definitions, setDefinitions] = React.useState<AgentDefinitionSummary[] | null>(null);
  const [templates, setTemplates] = React.useState<AgentTemplateSummary[] | null>(null);
  const [directoryOpen, setDirectoryOpen] = React.useState(false);
  const [portalRoot, setPortalRoot] = React.useState<HTMLElement | null>(null);
  const [addingTemplateId, setAddingTemplateId] = React.useState<string | null>(null);
  const [directoryNotice, setDirectoryNotice] = React.useState<string | null>(null);
  const [recentlyAddedAgentIds, setRecentlyAddedAgentIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    setPortalRoot(document.body);
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    setFailed(false);
    // sessionId is what points this at the DO that actually ran the spawns — without it the
    // server answers from the space-wide assistant DO, which never saw them (the reported
    // "No sub-agents have run in this conversation" despite a real spawn). An empty
    // parent_run_id then lists this conversation's whole fan-out rather than only the latest
    // turn's, so a reload (which loses lastRunId) still shows everything.
    listSubAgents(spaceId, session, lastRunId, { sessionId, agentId })
      .then((s) => { if (!cancelled) setSubAgents(s); })
      .catch((error) => {
        console.error("Failed to load worker activity", error);
        if (!cancelled) { setSubAgents([]); setFailed(true); }
      });
    return () => { cancelled = true; };
  }, [spaceId, session, lastRunId, sessionId, agentId]);

  React.useEffect(() => {
    let cancelled = false;
    Promise.allSettled([listAgentDefinitions(spaceId, session), listAgentTemplates(spaceId, session)]).then(([defs, catalog]) => {
      if (cancelled) return;
      if (defs.status === "fulfilled") setDefinitions(defs.value);
      if (catalog.status === "fulfilled") setTemplates(catalog.value);
    });
    return () => { cancelled = true; };
  }, [spaceId, session]);

  const projectIds = React.useMemo(() => new Set([...(projectAgentIds ?? []), ...recentlyAddedAgentIds]), [projectAgentIds, recentlyAddedAgentIds]);
  const configuredWorkers = (definitions ?? []).filter((definition) => {
    if (!projectId || projectIds.size === 0) return true;
    const shortId = definition.id.includes(":") ? definition.id.slice(definition.id.indexOf(":") + 1) : definition.id;
    return projectIds.has(definition.id) || projectIds.has(shortId);
  });
  const installed = React.useMemo(() => {
    const rows = configuredWorkers.map((definition) => ({ id: definition.id, name: definition.name ?? definition.id }));
    // The projects worker is a capability-isolated platform worker rather than a user-created
    // AgentDefinition, so it never appears in listAgentDefinitions. It is still installed on the
    // Space Assistant and must be visible alongside directory-installed specialists.
    if (!projectId && !rows.some((worker) => worker.id === "project_manager_worker")) {
      rows.unshift({ id: "project_manager_worker", name: "Projects worker" });
    }
    return rows;
  }, [configuredWorkers, projectId]);
  const addTemplate = async (template: AgentTemplateSummary) => {
    if (addingTemplateId) return;
    setAddingTemplateId(template.id);
    setDirectoryNotice(null);
    try {
      const created = await instantiateAgentTemplate(spaceId, session, { template_id: template.id, ...(projectId ? { project_id: projectId } : {}) });
      setRecentlyAddedAgentIds((current) => Array.from(new Set([...current, created.agent_id, created.agent_definition_id])));
      const refreshed = await listAgentDefinitions(spaceId, session);
      setDefinitions(refreshed);
      setDirectoryNotice(`${template.name} added to ${projectId ? "this project" : "the assistant"}.`);
    } catch (err) {
      setDirectoryNotice(err instanceof Error ? err.message : `Couldn't add ${template.name}.`);
    } finally {
      setAddingTemplateId(null);
    }
  };
  return (
    <>
      <div className="tp-section" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Workers</span>
        <button type="button" className="tp-header-btn" aria-label="Add worker" title="Add worker" onClick={() => setDirectoryOpen(true)}>+</button>
      </div>
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
          No workers have run in this conversation.
        </div>
      ) : (
        <div style={{ padding: "0 10px 8px" }}>
          {subAgents.map((sa) => (
            <details className="sub-agent-item" key={sa.id}>
              <summary style={{ cursor: "pointer", listStyle: "none", display: "flex", alignItems: "center", gap: 8 }}>
              <div className="ws-dot" style={sa.status === "completed" ? { background: "#22c55e", animation: "none" } : undefined} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>{sa.goal}</div>
                <div style={{ fontSize: 11, color: "var(--text3)" }}>{sa.status}{sa.progress_note ? ` · ${sa.progress_note}` : ""}</div>
              </div>
              </summary>
              <div style={{ margin: "7px 0 0 26px", fontSize: 11, color: "var(--text3)", lineHeight: 1.5 }}>
                <div>Worker run {sa.status === "running" ? "is active" : "has finished"}.</div>
                {sa.progress_note && <div style={{ marginTop: 3 }}>{sa.progress_note}</div>}
                {sa.error && <div style={{ marginTop: 5, color: "#dc2626" }}>Error: {sa.error}</div>}
                {sa.result && <pre style={{ margin: "6px 0 0", padding: 7, maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", borderRadius: 7, background: "var(--surface2)", color: "var(--text2)", font: "10.5px/1.45 var(--font-mono, monospace)" }}>{sa.result}</pre>}
                {sa.tokens_used !== undefined && <div style={{ marginTop: 3 }}>{sa.tokens_used.toLocaleString()} tokens</div>}
                <div style={{ marginTop: 3, fontFamily: "var(--font-mono, monospace)", fontSize: 10 }}>Run {sa.id.slice(0, 8)}</div>
              </div>
            </details>
          ))}
        </div>
      )}
      <div className="tp-section" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
        <span>{projectId ? "Project workers" : "Installed workers"}</span>
        <span style={{ fontSize: 10, color: "var(--text3)" }}>{installed.length}</span>
      </div>
      <div style={{ padding: "0 14px 10px", display: "grid", gap: 6 }}>
        {installed.length === 0 ? <div style={{ fontSize: 11, color: "var(--text3)" }}>No workers installed yet.</div> : installed.map((definition) => (
          <div key={definition.id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5 }}>
            <span className="ws-dot" style={{ background: "#22c55e", animation: "none" }} />
            <span style={{ color: "var(--text2)", flex: 1 }}>{definition.name}</span>
          </div>
        ))}
      </div>
      {directoryNotice && <div style={{ padding: "0 14px 8px", fontSize: 11, color: "var(--text3)" }}>{directoryNotice}</div>}
      {directoryOpen && portalRoot && createPortal(
        <div role="dialog" aria-label="Worker directory" style={{ position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", background: "#0008", padding: 16 }} onClick={() => setDirectoryOpen(false)}>
          <div style={{ width: "min(860px, calc(100vw - 32px))", maxHeight: "min(760px, calc(100vh - 32px))", overflow: "auto", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "clamp(16px, 3vw, 28px)", boxShadow: "0 24px 80px #0008" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
              <strong style={{ color: "var(--text)" }}>Worker directory</strong>
              <button type="button" className="tp-header-btn" aria-label="Close worker directory" onClick={() => setDirectoryOpen(false)}>×</button>
            </div>
            <p style={{ margin: "0 0 12px", fontSize: 11.5, color: "var(--text3)" }}>Add a specialist worker {projectId ? "to this project" : "to the assistant"}.</p>
            {templates === null ? <div style={{ fontSize: 12, color: "var(--text3)" }}>Loading worker directory…</div> : templates.length === 0 ? <div style={{ fontSize: 12, color: "var(--text3)" }}>No installable workers are available.</div> : templates.map((template) => (
              <div key={template.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid var(--border)" }}>
                <span style={{ fontSize: 20 }}>{template.icon || "◇"}</span>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{template.name}</div><div style={{ fontSize: 11, color: "var(--text3)" }}>{template.description}</div></div>
                <button type="button" className="btn btn-primary btn-sm" disabled={addingTemplateId === template.id} onClick={() => void addTemplate(template)}>{addingTemplateId === template.id ? "Adding…" : "Add"}</button>
              </div>
            ))}
          </div>
        </div>,
        portalRoot
      )}
    </>
  );
}

// Phase 5: click-to-open/preview, reusing the exact iframe(.html)/pre(text) pattern already
// proven working in ProjectKindPanel.tsx's WorkspaceFilesPanel — same behavior, adapted to this
// panel's compact tp-* styling rather than settings-block/settings-row. Project-scoped reads go
// through readWorkspaceFile (pre-existing); the space-wide assistant workspace now has a matching
// per-file read route too (previously list-only — see the new /assistant/files/* backend route).
// Step 6: build a nested directory tree from flat workspace paths (split on "/").
type FileTreeNode = { name: string; path: string; size?: number; children?: Record<string, FileTreeNode> };
function buildFileTree(files: WorkspaceFile[]): Record<string, FileTreeNode> {
  const root: Record<string, FileTreeNode> = {};
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let level = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      acc = acc ? `${acc}/${part}` : part;
      const isFile = i === parts.length - 1;
      if (!level[part]) level[part] = { name: part, path: acc, ...(isFile ? { size: f.size } : { children: {} }) };
      if (!isFile) level = level[part]!.children!;
    }
  }
  return root;
}

function FileTreeView({
  nodes, depth, collapsed, toggleDir, openFile, opening,
}: {
  nodes: Record<string, FileTreeNode>;
  depth: number;
  collapsed: Set<string>;
  toggleDir: (path: string) => void;
  openFile: (path: string) => void;
  opening: string | null;
}) {
  // Directories first, then files, each alphabetical.
  const entries = Object.values(nodes).sort((a, b) => {
    const ad = a.children ? 0 : 1;
    const bd = b.children ? 0 : 1;
    return ad - bd || a.name.localeCompare(b.name);
  });
  return (
    <>
      {entries.map((n) => {
        const isDir = !!n.children;
        const isOpen = !collapsed.has(n.path);
        return (
          <div key={n.path}>
            <div
              onClick={() => (isDir ? toggleDir(n.path) : openFile(n.path))}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 6px", paddingLeft: 6 + depth * 12, fontSize: 11.5, cursor: "pointer", color: "var(--text2)" }}
            >
              {isDir ? (
                <span style={{ color: "var(--text3)", width: 10, display: "inline-block" }}>{isOpen ? "▾" : "▸"}</span>
              ) : (
                <span style={{ width: 10, display: "inline-block" }} />
              )}
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {isDir ? "📁 " : "📄 "}{n.name}
              </span>
              {!isDir && <span style={{ color: "var(--text3)", fontSize: 9.5 }}>{opening === n.path ? "…" : formatBytes(n.size ?? 0)}</span>}
            </div>
            {isDir && isOpen && n.children && (
              <FileTreeView nodes={n.children} depth={depth + 1} collapsed={collapsed} toggleDir={toggleDir} openFile={openFile} opening={opening} />
            )}
          </div>
        );
      })}
    </>
  );
}

function FilesPanel({ spaceId, projectId, session }: { spaceId: string; projectId?: string | null | undefined; session: SessionCredentials }) {
  const [files, setFiles] = React.useState<WorkspaceFile[] | null>(null);
  const [open, setOpen] = React.useState<WorkspaceFileContent | null>(null);
  const [opening, setOpening] = React.useState<string | null>(null);
  const [view, setView] = React.useState<"list" | "grid" | "tree">("list");
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    let cancelled = false;
    setOpen(null);
    const load = projectId ? listWorkspaceFiles(spaceId, projectId, session) : listAssistantFiles(spaceId, session);
    load.then((f) => { if (!cancelled) setFiles(f); }).catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [spaceId, projectId, session]);

  async function openFile(path: string) {
    setOpening(path);
    try {
      const result = projectId
        ? await readWorkspaceFile(spaceId, projectId, path, session)
        : await readAssistantFile(spaceId, path, session);
      setOpen(result);
    } catch {
      setOpen({ path, content: "(could not read file)" });
    } finally {
      setOpening(null);
    }
  }

  return (
    <>
      <div className="tp-section" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>{projectId ? "Project Workspace" : "Workspace"}</span>
        {/* Step 6: switch between list, grid, and collapsible tree views. */}
        <span style={{ display: "flex", gap: 2 }}>
          {(["list", "grid", "tree"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              title={`${v} view`}
              style={{
                border: "none", background: view === v ? "var(--surface3, #e8e6e0)" : "transparent",
                color: view === v ? "var(--text1)" : "var(--text3)", cursor: "pointer",
                fontSize: 12, padding: "2px 5px", borderRadius: 4, lineHeight: 1,
              }}
            >
              {v === "list" ? "☰" : v === "grid" ? "▦" : "🌲"}
            </button>
          ))}
        </span>
      </div>
      {files === null ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>
      ) : files.length === 0 ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>No files yet.</div>
      ) : view === "grid" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 6, padding: "4px 14px" }}>
          {files.map((f) => {
            const name = f.path.split("/").pop() ?? f.path;
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => openFile(f.path)}
                title={f.path}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "8px 4px", border: "1px solid var(--border)", borderRadius: 8, background: "transparent", cursor: "pointer", fontSize: 10.5, color: "var(--text2)" }}
              >
                <span style={{ fontSize: 20 }}>📄</span>
                <span style={{ width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "center" }}>{name}</span>
                <span style={{ color: "var(--text3)", fontSize: 9 }}>{opening === f.path ? "…" : formatBytes(f.size)}</span>
              </button>
            );
          })}
        </div>
      ) : view === "tree" ? (
        <div style={{ padding: "2px 8px 4px" }}>
          <FileTreeView
            nodes={buildFileTree(files)}
            depth={0}
            collapsed={collapsed}
            toggleDir={(p) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(p)) next.delete(p); else next.add(p); return next; })}
            openFile={openFile}
            opening={opening}
          />
        </div>
      ) : (
        files.map((f) => (
          <div
            key={f.path}
            onClick={() => openFile(f.path)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 14px", fontSize: 11.5, cursor: "pointer" }}
          >
            <span style={{ color: "var(--text2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
            <span style={{ color: "var(--text3)", fontSize: 10 }}>{opening === f.path ? "…" : formatBytes(f.size)}</span>
          </div>
        ))
      )}
      {open && (
        <div style={{ margin: "8px 14px", padding: 10, border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <strong style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{open.path}</strong>
            <button
              type="button"
              onClick={() => setOpen(null)}
              style={{ border: "none", background: "none", color: "var(--text3)", cursor: "pointer", fontSize: 11 }}
            >
              Close
            </button>
          </div>
          {/* Step 4: multi-format viewer (PDF, images, Word/Excel, text/html/markdown/csv).
              AVOS plan step 6: this panel is always rendered alongside Chat.tsx, so click-to-
              inspect on an HTML file is safe to turn on — see HtmlPreviewFrame's own header. */}
          <FileViewer file={open} interactive />
        </div>
      )}
    </>
  );
}

// Phase 5: agent-authored deliverables — a finished thing meant to be SHOWN (a rendered page, a
// report), distinct from FilesPanel above (the agent's own scratch workspace). Same open/preview
// pattern (iframe for .html, pre for text) plus a Delete affordance the read-only Files tab
// doesn't have, since an artifact is something the person is actively managing, not just browsing.
function ArtifactsPanel({ spaceId, session }: { spaceId: string; session: SessionCredentials }) {
  const [items, setItems] = React.useState<ArtifactSummary[] | null>(null);
  const [open, setOpen] = React.useState<ArtifactContent | null>(null);
  const [opening, setOpening] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setOpen(null);
    listArtifacts(spaceId, session).then((r) => { if (!cancelled) setItems(r); }).catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [spaceId, session]);

  function load() {
    listArtifacts(spaceId, session).then(setItems).catch(() => setItems([]));
  }

  async function openArtifact(id: string) {
    setOpening(id);
    try {
      setOpen(await getArtifact(spaceId, id, session));
    } catch {
      setOpen(null);
    } finally {
      setOpening(null);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await deleteArtifact(spaceId, id, session);
      if (open?.artifact_id === id) setOpen(null);
      load();
    } catch {
      /* stays actionable — the list just won't have shrunk */
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <div className="tp-section">Artifacts</div>
      {items === null ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>
          None yet — a finished deliverable your agent publishes (a report, a rendered page) will show up here.
        </div>
      ) : (
        items.map((a) => (
          <div key={a.artifact_id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 14px", fontSize: 11.5 }}>
            <span
              onClick={() => openArtifact(a.artifact_id)}
              style={{ color: "var(--text2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
            >
              {opening === a.artifact_id ? "…" : a.filename}
            </span>
            <span style={{ color: "var(--text3)", fontSize: 10 }}>{formatBytes(a.size)}</span>
            <button
              type="button"
              onClick={() => handleDelete(a.artifact_id)}
              disabled={deletingId === a.artifact_id}
              style={{ border: "none", background: "none", color: "var(--text3)", cursor: "pointer", fontSize: 11, padding: 0 }}
              title="Delete this artifact"
            >
              {deletingId === a.artifact_id ? "…" : "✕"}
            </button>
          </div>
        ))
      )}
      {open && (
        <div style={{ margin: "8px 14px", padding: 10, border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <strong style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{open.filename}</strong>
            <button
              type="button"
              onClick={() => setOpen(null)}
              style={{ border: "none", background: "none", color: "var(--text3)", cursor: "pointer", fontSize: 11 }}
            >
              Close
            </button>
          </div>
          {open.too_large ? (
            <p style={{ color: "var(--text3)", fontSize: 11.5, margin: 0 }}>Too large to preview inline.</p>
          ) : open.binary ? (
            <p style={{ color: "var(--text3)", fontSize: 11.5, margin: 0 }}>Binary content ({open.content_type}) — preview isn't supported here yet.</p>
          ) : open.content_type === "text/html" ? (
            // AVOS plan step 6 — this panel is always rendered alongside Chat.tsx (it's one of the
            // side-panel tabs), so its own "message" listener is guaranteed mounted; click-to-
            // inspect is safe to turn on here (see HtmlPreviewFrame's own header for the sandbox
            // reasoning).
            <HtmlPreviewFrame html={open.content ?? ""} title={open.filename} interactive />
          ) : (
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 260, overflow: "auto", margin: 0 }}>{open.content ?? ""}</pre>
          )}
        </div>
      )}
    </>
  );
}

function SkillsPanel({ spaceId, session, projectId }: { spaceId: string; session: SessionCredentials; projectId?: string | null | undefined }) {
  const [caps, setCaps] = React.useState<AssistantCapabilities | null>(null);
  const [showAllPrebuilts, setShowAllPrebuilts] = React.useState(false);
  // The shared, fleet-learned template library — what OTHER spaces on the same template have
  // already proven out, browsable and addable one skill at a time. undefined = still loading;
  // null = genuinely nothing to show (no template, or the directory itself failed to load —
  // dirFailed distinguishes those two so a load failure never silently reads as "nothing here").
  const [dir, setDir] = React.useState<{ template_id: string; skills: DirectorySkill[] } | null | undefined>(undefined);
  const [dirFailed, setDirFailed] = React.useState(false);
  const [addingName, setAddingName] = React.useState<string | null>(null);
  const [directoryOpen, setDirectoryOpen] = React.useState(false);
  const [portalRoot, setPortalRoot] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => { setPortalRoot(document.body); }, []);

  const loadDirectory = React.useCallback(() => {
    getSkillsDirectory(spaceId, session)
      .then((d) => { setDir(d); setDirFailed(false); })
      .catch(() => { setDir(null); setDirFailed(true); });
  }, [spaceId, session]);

  React.useEffect(() => {
    let cancelled = false;
    getAssistantCapabilities(spaceId, session, projectId ?? undefined).then((c) => { if (!cancelled) setCaps(c); }).catch(() => { if (!cancelled) setCaps({ prebuilts: [], skills: [], prebuilt_count: 0, skill_count: 0 }); });
    return () => { cancelled = true; };
  }, [spaceId, session, projectId]);

  React.useEffect(() => { loadDirectory(); }, [loadDirectory]);

  async function addSkill(name: string) {
    setAddingName(name);
    try {
      await inheritSkills(spaceId, session, [name]);
      loadDirectory(); // reflects the new installed:true badge
      getAssistantCapabilities(spaceId, session, projectId ?? undefined).then(setCaps).catch(() => {}); // learned-skill count too
    } catch {
      // Best-effort — the directory reload above will show the real (unchanged) installed state.
    } finally {
      setAddingName(null);
    }
  }

  if (!caps) return <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>Loading…</div>;
  const prebuilts = showAllPrebuilts ? caps.prebuilts : caps.prebuilts.slice(0, 6);
  const notInstalled = dir?.skills.filter((s) => !s.installed) ?? [];

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
      <div className="tp-section" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span>Skill Directory</span><button type="button" className="btn btn-primary btn-sm" onClick={() => setDirectoryOpen(true)}>+ Add skill</button></div>
      <div style={{ fontSize: 11, color: "var(--text3)", padding: "2px 14px 8px", lineHeight: 1.5 }}>{notInstalled.length} skill{notInstalled.length === 1 ? "" : "s"} available to add.</div>
      {directoryOpen && portalRoot && createPortal(
        <div role="dialog" aria-label="Skill directory" className="workspace-directory-overlay" onClick={() => setDirectoryOpen(false)}>
          <div className="workspace-directory-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="workspace-directory-heading"><div><strong>Skill directory</strong><p>Add proven skills to this space.</p></div><button type="button" className="tp-header-btn" aria-label="Close skill directory" onClick={() => setDirectoryOpen(false)}>×</button></div>
            {dir === undefined ? <p className="workspace-tab-empty">Loading directory…</p> : dirFailed ? <p className="workspace-tab-empty">Couldn&apos;t load the directory.</p> : dir === null ? <p className="workspace-tab-empty">No shared skill directory is available yet.</p> : notInstalled.length === 0 ? <p className="workspace-tab-empty">All available skills are installed.</p> : <div className="workspace-directory-grid">{notInstalled.map((skill) => <article key={skill.name} className="workspace-directory-card"><div><strong>{skill.name}</strong><p>{skill.description}</p></div><button type="button" className="btn btn-primary btn-sm" disabled={addingName === skill.name} onClick={() => void addSkill(skill.name)}>{addingName === skill.name ? "Adding…" : "Add"}</button></article>)}</div>}
          </div>
        </div>, portalRoot
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
  projectAgentIds,
  lastRunId,
  sessionId,
  isBusinessSpace,
}: {
  spaceId: string;
  session: SessionCredentials;
  tab: SidePanelTab;
  /** A project thread's currently-selected agent, when one is explicitly bound — scopes the
   *  Config tab to that agent's own policy instead of the space-wide one. */
  agentId?: string | null | undefined;
  projectId?: string | null | undefined;
  projectAgentIds?: string[] | null | undefined;
  /** Scopes the Sub-agents tab to the run that actually produced any — empty until a first send. */
  lastRunId?: string | null | undefined;
  /** This conversation's own chat session. Required for Sub-agents to read the right DO — see
   *  SubAgentsPanel's own note. */
  sessionId?: string | null | undefined;
  isBusinessSpace: boolean;
}) {
  switch (tab) {
    case "config":
      return <ConfigPanel spaceId={spaceId} session={session} agentId={agentId} isBusinessSpace={isBusinessSpace} projectId={projectId} />;
    case "memory":
      return <MemoryPanel spaceId={spaceId} session={session} />;
    case "crons":
      return <CronsPanel spaceId={spaceId} session={session} projectId={projectId} isBusinessSpace={isBusinessSpace} />;
    case "channels":
      return <ChannelsPanel spaceId={spaceId} session={session} projectId={projectId} isBusinessSpace={isBusinessSpace} />;
    case "heartbeats":
      return <HeartbeatsPanel spaceId={spaceId} session={session} />;
    case "sub-agents":
      return <WorkersPanel spaceId={spaceId} session={session} lastRunId={lastRunId ?? ""} sessionId={sessionId} agentId={agentId} projectId={projectId} projectAgentIds={projectAgentIds} />;
    case "files":
      return <FilesPanel spaceId={spaceId} projectId={projectId} session={session} />;
    case "artifacts":
      return <ArtifactsPanel spaceId={spaceId} session={session} />;
    case "skills":
      return <SkillsPanel spaceId={spaceId} session={session} projectId={projectId} />;
    case "notifications":
      return <NotificationsPanel spaceId={spaceId} session={session} projectId={projectId} />;
    case "local-machine":
      return <LocalMachinePanel spaceId={spaceId} session={session} projectId={projectId ?? null} isBusinessSpace={isBusinessSpace} />;
  }
}
