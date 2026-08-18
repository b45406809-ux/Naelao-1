"use client";

// §A1.27: Claude-Code-web-style context-window usage meter — current session size vs. the
// selected model's context window, plus daily/weekly/monthly usage against the org's plan limit.
// Triggers a pre-send compaction pass (Memory OS maintenance, run early) once percent_full
// crosses COMPACT_THRESHOLD, client-driven rather than a hidden per-message server check (see
// the /compact route's own comment for why).

import * as React from "react";
import { getContextUsage, compactSession, type ContextUsage } from "@/lib/api";
import type { SessionCredentials } from "@/lib/api";

const COMPACT_THRESHOLD = 85;

function formatCount(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function barColor(percent: number): string {
  if (percent >= COMPACT_THRESHOLD) return "var(--danger, #e5484d)";
  if (percent >= 60) return "var(--warning, #f5a623)";
  return "var(--brand, #5b52f0)";
}

export function ContextUsageMeter({
  spaceId,
  sessionId,
  session,
  model = "claude-haiku-4-5-20251001",
  /** Increment this after every completed run to force a refresh. */
  refreshKey,
  /** A single-line strip (bar + percentage + Compact button, no daily/weekly/monthly rows) meant
   *  to sit right above the composer, always visible — not buried in a side-panel tab a person
   *  has to open to notice their context is filling up. */
  compact = false,
}: {
  spaceId: string;
  sessionId: string | null;
  session: SessionCredentials;
  model?: string;
  refreshKey?: number;
  compact?: boolean;
}) {
  const [usage, setUsage] = React.useState<ContextUsage | null>(null);
  const [compacting, setCompacting] = React.useState(false);
  const [justCompacted, setJustCompacted] = React.useState(false);
  const compactedForKeyRef = React.useRef<number | undefined>(undefined);
  const fetchKeyRef = React.useRef(0);

  const refetch = React.useCallback(async () => {
    if (!sessionId) return;
    const myKey = ++fetchKeyRef.current;
    try {
      const result = await getContextUsage(spaceId, sessionId, session, model);
      if (fetchKeyRef.current !== myKey) return;
      setUsage(result);
      return result;
    } catch {
      // Usage endpoint unreachable — the chat itself still works, just no meter this render.
      return undefined;
    }
  }, [spaceId, sessionId, session, model]);

  React.useEffect(() => {
    if (!sessionId) return;
    void (async () => {
      const result = await refetch();
      if (!result) return;
      // Auto-compact once per crossing, not on every poll — compactedForKeyRef gates it to
      // fire at most once per refreshKey (i.e. once per completed run that crossed the line).
      // Only the compact variant does this: it's the one guaranteed to be mounted whenever a
      // session exists (the full variant lives inside the Stats tab, only mounted when the side
      // panel is open) — letting both fire would risk two overlapping compaction calls for the
      // same crossing.
      if (compact && result.percent_full >= COMPACT_THRESHOLD && compactedForKeyRef.current !== refreshKey) {
        compactedForKeyRef.current = refreshKey;
        void compactSession(spaceId, sessionId, session).catch(() => {
          /* best-effort — the meter still shows the real percentage either way */
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, sessionId, session, model, refreshKey, compact]);

  async function handleManualCompact() {
    if (!sessionId || compacting) return;
    setCompacting(true);
    try {
      await compactSession(spaceId, sessionId, session);
      await refetch();
      setJustCompacted(true);
      window.setTimeout(() => setJustCompacted(false), 3000);
    } catch {
      // The endpoint failing to reach a real Memory OS maintenance pass shouldn't read as a
      // silent no-op — but this is a convenience action, so the meter just stops spinning and
      // the person can try again rather than being shown a hard error.
    } finally {
      setCompacting(false);
    }
  }

  if (!usage) return null;

  if (compact) {
    // Only worth a person's attention once it's actually filling up — below that this is just
    // clutter above every composer on every page, which is the opposite of "more prominent".
    if (usage.percent_full < 40) return null;
    return (
      <div
        className="context-usage-meter-compact"
        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text3)", padding: "0 2px 4px" }}
      >
        <div style={{ flex: 1, height: 3, borderRadius: 2, background: "var(--surface2, #23232b)", overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${Math.min(100, usage.percent_full)}%`,
              background: barColor(usage.percent_full),
              transition: "width 200ms ease",
            }}
          />
        </div>
        <span>{usage.percent_full}% context</span>
        {sessionId && (
          <button
            type="button"
            onClick={() => void handleManualCompact()}
            disabled={compacting}
            title="Run memory maintenance now, ahead of the automatic 85% threshold"
            style={{
              fontSize: 10.5,
              padding: "1px 7px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "transparent",
              color: justCompacted ? "var(--success, #2ecc71)" : "var(--text3)",
              cursor: compacting ? "default" : "pointer",
              opacity: compacting ? 0.6 : 1,
            }}
          >
            {compacting ? "Compacting…" : justCompacted ? "Compacted" : "Compact"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="context-usage-meter" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--text3)" }}>
        <span>Context window</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {formatCount(usage.current_tokens)} / {formatCount(usage.model_window)} ({usage.percent_full}%)
          {sessionId && (
            <button
              type="button"
              onClick={() => void handleManualCompact()}
              disabled={compacting}
              title="Run memory maintenance now, ahead of the automatic 85% threshold"
              style={{
                fontSize: 10.5,
                padding: "1px 7px",
                borderRadius: 999,
                border: "1px solid var(--border)",
                background: "transparent",
                color: justCompacted ? "var(--success, #2ecc71)" : "var(--text3)",
                cursor: compacting ? "default" : "pointer",
                opacity: compacting ? 0.6 : 1,
              }}
            >
              {compacting ? "Compacting…" : justCompacted ? "Compacted" : "Compact"}
            </button>
          )}
        </span>
      </div>
      {/* Segmented bar — one coloured segment per breakdown category (Claude Code style). Falls
          back to the single conversation bar when the backend didn't send a breakdown. */}
      {usage.breakdown && usage.breakdown.length > 0 ? (
        <div style={{ display: "flex", height: 8, borderRadius: 3, overflow: "hidden", background: "var(--surface2, #23232b)" }}>
          {usage.breakdown.map((seg) => {
            const pct = usage.model_window > 0 ? (seg.tokens / usage.model_window) * 100 : 0;
            if (pct <= 0) return null;
            return (
              <div
                key={seg.key}
                title={`${seg.label}: ${formatCount(seg.tokens)} tokens`}
                style={{ width: `${pct}%`, background: SEGMENT_COLORS[seg.key] ?? "var(--text3)", transition: "width 200ms ease" }}
              />
            );
          })}
        </div>
      ) : (
        <div style={{ height: 8, borderRadius: 3, background: "var(--surface2, #23232b)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.min(100, usage.percent_full)}%`, background: barColor(usage.percent_full), transition: "width 200ms ease" }} />
        </div>
      )}

      {/* Labeled category rows: coloured dot + label + token count + %. */}
      {usage.breakdown && usage.breakdown.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
          {usage.breakdown.map((seg) => {
            const pct = usage.model_window > 0 ? Math.round((seg.tokens / usage.model_window) * 100) : 0;
            return (
              <div key={seg.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: SEGMENT_COLORS[seg.key] ?? "var(--text3)", flexShrink: 0 }} />
                <span style={{ flex: 1, color: "var(--text1)" }}>
                  {seg.label}
                  {seg.estimated && <span style={{ color: "var(--text3)", fontSize: 10 }}> (est.)</span>}
                </span>
                <span style={{ color: "var(--text3)", fontVariantNumeric: "tabular-nums" }}>{formatCount(seg.tokens)}</span>
                <span style={{ color: "var(--text3)", width: 34, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Plan usage — day/week/month against the org's token limit, as progress bars. */}
      {(usage.daily_limit !== null || usage.weekly_limit !== null || usage.monthly_limit !== null) && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>Plan usage</div>
          {([
            { label: "Today", used: usage.daily_used, limit: usage.daily_limit },
            { label: "This week", used: usage.weekly_used, limit: usage.weekly_limit },
            { label: "This month", used: usage.monthly_used, limit: usage.monthly_limit },
          ] as const)
            .filter((r) => r.limit !== null)
            .map((r) => {
              const used = r.used ?? 0;
              const limit = r.limit ?? 1;
              const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
              return (
                <div key={r.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text3)" }}>
                    <span>{r.label}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatCount(used)} / {formatCount(limit)} ({pct}%)</span>
                  </div>
                  <div style={{ height: 3, borderRadius: 2, background: "var(--surface2, #23232b)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: barColor(pct), transition: "width 200ms ease" }} />
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

/** Distinct colours per context-breakdown category (Claude Code style: each segment a different
 *  hue). Free space stays a muted grey so the "used" segments read as the filled portion. */
const SEGMENT_COLORS: Record<string, string> = {
  conversation: "#5b52f0",
  overhead: "#f5a623",
  free: "var(--surface3, #34343e)",
};
