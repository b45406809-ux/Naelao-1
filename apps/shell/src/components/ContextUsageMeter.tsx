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
}: {
  spaceId: string;
  sessionId: string | null;
  session: SessionCredentials;
  model?: string;
  refreshKey?: number;
}) {
  const [usage, setUsage] = React.useState<ContextUsage | null>(null);
  const compactedForKeyRef = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getContextUsage(spaceId, sessionId, session, model);
        if (cancelled) return;
        setUsage(result);
        // Auto-compact once per crossing, not on every poll — compactedForKeyRef gates it to
        // fire at most once per refreshKey (i.e. once per completed run that crossed the line).
        if (result.percent_full >= COMPACT_THRESHOLD && compactedForKeyRef.current !== refreshKey) {
          compactedForKeyRef.current = refreshKey;
          void compactSession(spaceId, sessionId, session).catch(() => {
            /* best-effort — the meter still shows the real percentage either way */
          });
        }
      } catch {
        // Usage endpoint unreachable — the chat itself still works, just no meter this render.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spaceId, sessionId, session, model, refreshKey]);

  if (!usage) return null;

  return (
    <div className="context-usage-meter" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text3)" }}>
        <span>Context window</span>
        <span>
          {formatCount(usage.current_tokens)} / {formatCount(usage.model_window)} ({usage.percent_full}%)
        </span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: "var(--surface2, #23232b)", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, usage.percent_full)}%`,
            background: barColor(usage.percent_full),
            transition: "width 200ms ease",
          }}
        />
      </div>
      {(usage.daily_limit !== null || usage.weekly_limit !== null || usage.monthly_limit !== null) && (
        <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--text3)" }}>
          {usage.daily_limit !== null && (
            <span>Today: {formatCount(usage.daily_used)}/{formatCount(usage.daily_limit)}</span>
          )}
          {usage.weekly_limit !== null && (
            <span>This week: {formatCount(usage.weekly_used)}/{formatCount(usage.weekly_limit)}</span>
          )}
          {usage.monthly_limit !== null && (
            <span>This month: {formatCount(usage.monthly_used)}/{formatCount(usage.monthly_limit)}</span>
          )}
        </div>
      )}
    </div>
  );
}
