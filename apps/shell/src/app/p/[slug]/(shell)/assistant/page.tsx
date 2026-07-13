"use client";

export const runtime = "edge";

// The always-on Space Assistant surface (spec A1.3/A1.16.7, launchpad-6 mockup). Every panel
// below is a READ-ONLY consumer of an already-built backend — no write routes are added to the
// end-user allowlist. Multi-assistant switching (the mockup's tab bar) is deliberately NOT built
// this pass: there is no data model distinguishing "an assistant" from any other agent
// definition, so faking tabs would be worse than a single well-wired "Main Assistant" — a
// documented, not silently dropped, gap.

import * as React from "react";
import { Chat } from "@/components/Chat";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  getAssistantPolicy,
  getAssistantMemory,
  listScheduledJobs,
  listAssistantChannels,
  listSubAgents,
  listAssistantFiles,
  type AssistantPolicy,
  type MemoryFact,
  type ScheduledJob,
  type ChannelLink,
  type SubAgentSummary,
  type WorkspaceFile,
} from "@/lib/api";

type PanelTab = "status" | "memory" | "crons" | "channels" | "sub-agents" | "files";

const PANEL_TABS: { key: PanelTab; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "memory", label: "Memory" },
  { key: "crons", label: "Crons" },
  { key: "channels", label: "Channels" },
  { key: "sub-agents", label: "Sub-agents" },
  { key: "files", label: "Files" },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AssistantPage() {
  const { activeSpaceId, activeSpaceName } = useActiveSpace();
  const { session } = useProductAuth();
  const [tab, setTab] = React.useState<PanelTab>("status");

  const [policy, setPolicy] = React.useState<AssistantPolicy | null>(null);
  const [memory, setMemory] = React.useState<MemoryFact[]>([]);
  const [crons, setCrons] = React.useState<ScheduledJob[]>([]);
  const [channels, setChannels] = React.useState<ChannelLink[]>([]);
  const [subAgents, setSubAgents] = React.useState<SubAgentSummary[]>([]);
  const [files, setFiles] = React.useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  React.useEffect(() => {
    if (!creds) return;
    setLoading(true);
    setLoadError(null);
    const load = (async () => {
      switch (tab) {
        case "status":
          return Promise.all([getAssistantPolicy(activeSpaceId, creds), listAssistantChannels(activeSpaceId, creds)]).then(
            ([p, ch]) => {
              setPolicy(p);
              setChannels(ch);
            }
          );
        case "memory":
          return getAssistantMemory(activeSpaceId, creds).then(setMemory);
        case "crons":
          return listScheduledJobs(activeSpaceId, creds).then(setCrons);
        case "channels":
          return listAssistantChannels(activeSpaceId, creds).then(setChannels);
        case "sub-agents":
          // No specific run is selected on this surface yet — an empty parent_run_id returns no
          // rows (honest empty state), not fabricated data. Becomes populated once a caller can
          // pass a real run id (e.g. from a just-started chat run).
          return listSubAgents(activeSpaceId, creds, "").then(setSubAgents);
        case "files":
          return listAssistantFiles(activeSpaceId, creds).then(setFiles);
      }
    })();
    load.catch(() => setLoadError("Couldn't load this panel")).finally(() => setLoading(false));
  }, [tab, activeSpaceId, session]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) return null;

  return (
    <div className="assistant-layout" style={{ flex: 1, overflow: "hidden", display: "flex" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Chat
          spaceId={activeSpaceId}
          session={creds!}
          sessionKey="assistant"
          title={activeSpaceName ? `${activeSpaceName} Assistant` : "Space Assistant"}
        />
      </div>

      <div className="assistant-panel" style={{ width: 240, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "10px 10px 4px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
            {PANEL_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={["tp-tab", tab === t.key ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="tp-body">
          {loading && <div style={{ padding: 14, fontSize: 12, color: "var(--text3)" }}>Loading…</div>}
          {loadError && <div style={{ padding: 14, fontSize: 12, color: "var(--text3)" }}>{loadError}</div>}

          {!loading && !loadError && tab === "status" && (
            <>
              <div className="assistant-panel-section">
                <div className="assistant-panel-label">Channel Status</div>
                {channels.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text3)" }}>No channels configured.</div>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.7 }}>
                    {channels.map((c) => (
                      <div key={c.channel}>
                        {c.channel}: {c.enabled ? "Enabled" : "Disabled"}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="tp-section">Permissions</div>
              <div className="tp-stat">
                <span className="tp-stat-label">Approval mode</span>
                <span className="tp-stat-val">{policy?.approval_mode ?? "—"}</span>
              </div>
              <div className="tp-stat">
                <span className="tp-stat-label">Auto-approved actions</span>
                <span className="tp-stat-val">{policy?.auto_approved_actions.length ?? 0}</span>
              </div>
            </>
          )}

          {!loading && !loadError && tab === "memory" && (
            <>
              <div className="tp-section">Facts</div>
              {memory.length === 0 ? (
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
          )}

          {!loading && !loadError && tab === "crons" && (
            <>
              <div className="tp-section">Scheduled Jobs</div>
              <div style={{ padding: "0 10px 8px" }}>
                {crons.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text3)", padding: "4px 4px" }}>No scheduled jobs.</div>
                ) : (
                  crons.map((job) => (
                    <div className="cron-item" key={job.id}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>{job.name}</div>
                        <span className={`badge ${job.enabled ? "badge-green" : "badge-amber"}`} style={{ fontSize: 9 }}>
                          {job.enabled ? "Active" : "Paused"}
                        </span>
                      </div>
                      <div className="cron-expr">{job.cron_expression}</div>
                      {job.last_run_at && (
                        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
                          Last run: {new Date(job.last_run_at).toLocaleString()}
                        </div>
                      )}
                      {job.consecutive_failures > 0 && (
                        <div style={{ fontSize: 11, color: "#d97706", marginTop: 2 }}>
                          {job.consecutive_failures} consecutive failure(s)
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {!loading && !loadError && tab === "channels" && (
            <>
              <div className="tp-section">Integrations</div>
              {channels.length === 0 ? (
                <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>No channels configured.</div>
              ) : (
                channels.map((c) => (
                  <div className="tp-tool-row" key={c.channel}>
                    <div className="tp-tool-name" style={{ textTransform: "capitalize" }}>{c.channel}</div>
                    <div className="tp-tool-badge" style={!c.enabled ? { color: "var(--text3)" } : undefined}>
                      {c.enabled ? "Connected" : "Off"}
                    </div>
                  </div>
                ))
              )}
            </>
          )}

          {!loading && !loadError && tab === "sub-agents" && (
            <>
              <div className="tp-section">Sub-agents</div>
              {subAgents.length === 0 ? (
                <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>
                  No sub-agent activity for the current run.
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
          )}

          {!loading && !loadError && tab === "files" && (
            <>
              <div className="tp-section">Workspace</div>
              {files.length === 0 ? (
                <div style={{ padding: "4px 14px", fontSize: 12, color: "var(--text3)" }}>No files yet.</div>
              ) : (
                files.map((f) => (
                  <div
                    key={f.path}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 14px", fontSize: 11.5 }}
                  >
                    <span style={{ color: "var(--text2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.path}
                    </span>
                    <span style={{ color: "var(--text3)", fontSize: 10 }}>{formatBytes(f.size)}</span>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
