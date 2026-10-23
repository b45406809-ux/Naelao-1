"use client";

// Analytics — mirrors apps/launchpad/src/index.html's #analytics-view (KPI cards, a bar chart,
// a per-agent usage table) with real data instead of the mockup's hardcoded numbers, plus the
// piece the mockup doesn't have at all: heartbeat/scheduled wake-up activity, since the assistant
// can do real work while nobody's looking and that was previously invisible anywhere in the shell.
//
// Every number here comes from GET /business-analytics, a pure-aggregate rollup safe for any
// business member to read (see that route's own header on the spaces worker) — never a raw run,
// session id, or summary text, unlike the builder-only agent-activity/agent-diagnostics views.

import * as React from "react";
import { useSessionCredentials } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { getBusinessAnalytics, type BusinessAnalytics } from "@/lib/api";
import { usePresentationProfile } from "@/lib/presentation-profile";

type Window = "7d" | "30d" | "90d";

function pct(n: number | null): string {
  if (n === null) return "";
  const sign = n > 0 ? "↑" : n < 0 ? "↓" : "→";
  return `${sign} ${Math.abs(n)}% vs prior period`;
}

export default function AnalyticsPage() {
  const creds = useSessionCredentials();
  const { activeSpaceId } = useActiveSpace();
  const presentation = usePresentationProfile();
  const [win, setWin] = React.useState<Window>("7d");
  const [data, setData] = React.useState<BusinessAnalytics | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  const load = React.useCallback(() => {
    if (!creds) return;
    setLoading(true);
    setError(false);
    getBusinessAnalytics(activeSpaceId, creds, win)
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [creds, activeSpaceId, win]);

  React.useEffect(() => { load(); }, [load]);

  const maxCredits = data ? Math.max(1, ...data.daily.map((d) => d.credits)) : 1;

  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div className="page-title">Analytics</div>
          <div className="page-subtitle">Credit usage, agent runs, and background activity.</div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["7d", "30d", "90d"] as Window[]).map((w) => (
            <button
              key={w}
              className="btn btn-ghost btn-sm"
              style={win === w ? { background: "var(--accent-dim)", color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
              onClick={() => setWin(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && <div style={{ color: "var(--text3)", fontSize: 12.5 }}>Loading…</div>}
      {error && (
        <div style={{ color: "#dc2626", fontSize: 12.5, marginBottom: 12 }}>
          Couldn't load analytics. <button className="btn btn-ghost btn-sm" onClick={load}>Retry</button>
        </div>
      )}

      {data && (
        <>
          <div className="grid-4">
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Credits used</div>
              <div className="card-value">{data.credits.used.toLocaleString()}</div>
              {data.credits.vs_prior_period !== null && (
                <div className="card-sub" style={{ color: data.credits.vs_prior_period > 0 ? "#16a34a" : "#dc2626" }}>
                  {pct(data.credits.vs_prior_period)}
                </div>
              )}
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Agent runs</div>
              <div className="card-value">{data.runs.total.toLocaleString()}</div>
              <div className="card-sub">Across {data.by_agent.length} agent{data.by_agent.length === 1 ? "" : "s"}</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Success rate</div>
              <div className="card-value">{data.runs.success_rate !== null ? `${Math.round(data.runs.success_rate * 100)}%` : "—"}</div>
              <div className="card-sub">{data.runs.failed} failed of {data.runs.total}</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Tokens used</div>
              <div className="card-value">{data.tokens_used >= 1000 ? `${(data.tokens_used / 1000).toFixed(1)}k` : data.tokens_used}</div>
              <div className="card-sub">This period</div>
            </div>
          </div>

          <div className="section-label" style={{ marginTop: 24 }}>Delegated work</div>
          <div className="grid-4">
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Completed without approval</div>
              <div className="card-value">{data.autonomy.completion_without_approval_rate === null ? "—" : `${Math.round(data.autonomy.completion_without_approval_rate * 100)}%`}</div>
              <div className="card-sub">{data.autonomy.completed_without_approval} of {data.autonomy.completed_without_approval + data.autonomy.completed_with_approval} tracked completions</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Approval-interrupted runs</div>
              <div className="card-value">{data.autonomy.approval_interrupted_runs.toLocaleString()}</div>
              <div className="card-sub">Completed or failed runs that requested an approval</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Approval requests</div>
              <div className="card-value">{data.autonomy.approval_requests.toLocaleString()}</div>
              <div className="card-sub">Human decisions requested in this period</div>
            </div>
            <div className="card" style={{ cursor: "default" }} data-technical-detail="identifiers">
              <div className="card-label">Runs with durable IDs</div>
              <div className="card-value">{data.autonomy.tracked_runs.toLocaleString()}</div>
              <div className="card-sub">Used for reliable approval-to-run attribution</div>
            </div>
          </div>
          <p className="settings-row-sub">These figures use recorded approval events as the human-intervention signal. Browser challenges and ordinary clarification questions are not counted as approvals.</p>
          <div className="section-label" style={{ marginTop: 20 }}>Recovery and safety</div>
          <div className="grid-4">
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Average completion time</div>
              <div className="card-value">{data.reliability.avg_completion_duration_ms === null ? "—" : data.reliability.avg_completion_duration_ms < 60_000 ? `${Math.max(1, Math.round(data.reliability.avg_completion_duration_ms / 1000))}s` : `${(data.reliability.avg_completion_duration_ms / 60_000).toFixed(1)}m`}</div>
              <div className="card-sub">Elapsed time for completed runs with timing data</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Recovered runs</div>
              <div className="card-value">{data.reliability.recovered_runs.toLocaleString()}</div>
              <div className="card-sub">Browser page changes recovered by re-observing</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Recovery rate</div>
              <div className="card-value">{data.reliability.recovery_rate === null ? "—" : `${Math.round(data.reliability.recovery_rate * 100)}%`}</div>
              <div className="card-sub">Recovered runs among completed runs with timing data</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Repeated mutating calls</div>
              <div className="card-value">{data.reliability.repeated_mutation_calls.toLocaleString()}</div>
              <div className="card-sub">Same tool and parameters repeated within a run</div>
            </div>
          </div>
          <p className="settings-row-sub">Repeated calls are a safety signal, not proof that an external duplicate occurred. Provider receipts and idempotency keys determine whether an effect was actually applied twice.</p>

          <div className="section-label">Credit Usage — Last {data.window_days} Days</div>
          <div className="card" style={{ cursor: "default", padding: "20px 20px 12px" }}>
            {data.daily.every((d) => d.credits === 0) ? (
              <div style={{ color: "var(--text3)", fontSize: 12.5, padding: "20px 0", textAlign: "center" }}>No activity yet in this window.</div>
            ) : (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 90 }}>
                {data.daily.map((d) => (
                  <div key={d.day} title={`${d.day}: ${d.credits} credits, ${d.runs} runs`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <div
                      style={{
                        width: "100%",
                        borderRadius: 3,
                        background: "var(--accent)",
                        opacity: d.credits > 0 ? 1 : 0.15,
                        height: Math.max(2, (d.credits / maxCredits) * 76),
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="section-label" style={{ marginTop: 24 }}>Usage by Agent</div>
          {data.by_agent.length === 0 ? (
            <div className="card" style={{ cursor: "default", padding: 16, fontSize: 12.5, color: "var(--text3)" }}>No agent runs in this window.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>Agent</th><th>Runs</th><th>Credits</th><th>Success Rate</th></tr>
              </thead>
              <tbody>
                {data.by_agent.map((a) => (
                  <tr key={a.agent_id}>
                    <td className="cell-primary" data-technical-detail="identifiers">{presentation.isDetailVisible("identifiers") ? a.agent_id : `Assistant ${data.by_agent.indexOf(a) + 1}`}</td>
                    <td>{a.runs}</td>
                    <td>{a.credits}</td>
                    <td>
                      {a.success_rate !== null ? (
                        <span className={`badge ${a.success_rate >= 0.95 ? "badge-green" : a.success_rate >= 0.8 ? "badge-amber" : "badge-red"}`}>
                          {Math.round(a.success_rate * 100)}%
                        </span>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="section-label" style={{ marginTop: 24 }}>Background Activity</div>
          <div className="settings-block">
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Heartbeat &amp; scheduled wake-ups that completed real work</div>
                <div className="settings-row-sub">A silent, work-free tick isn't logged — this only counts wake-ups that actually did something.</div>
              </div>
              <span className="badge badge-green">{data.heartbeats.completed_with_work}</span>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Failed wake-ups</div>
                <div className="settings-row-sub">A background run that hit an error before finishing.</div>
              </div>
              <span className={`badge ${data.heartbeats.failed > 0 ? "badge-amber" : "badge-green"}`}>{data.heartbeats.failed}</span>
            </div>
            {data.heartbeats.by_trigger.length > 0 && (
              <div style={{ padding: "10px 16px 14px" }}>
                {data.heartbeats.by_trigger.map((t) => (
                  <div key={t.trigger} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text2)", padding: "3px 0" }}>
                    <span>{t.trigger}</span>
                    <span>{t.failed} failed</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="section-label" style={{ marginTop: 24 }}>Structure</div>
          <div className="grid-4">
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Projects</div>
              <div className="card-value">{data.structure.projects}</div>
            </div>
            <div className="card" style={{ cursor: "default" }}>
              <div className="card-label">Threads</div>
              <div className="card-value">{data.structure.threads}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
