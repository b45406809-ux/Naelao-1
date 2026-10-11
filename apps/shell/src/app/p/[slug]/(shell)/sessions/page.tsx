"use client";

// Every conversation with the assistant, newest first. The sidebar shows the most recent few and
// links here for the rest.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { listSessions, type SessionSummary } from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";

export default function SessionsPage() {
  const product = useProduct();
  const router = useRouter();
  const { session } = useProductAuth();
  const { activeSpaceId } = useActiveSpace();
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  // Ordinary vs heartbeat/cron-wake sessions — the only two places heartbeat sessions are meant
  // to surface are this filter tab and the Heartbeats sidebar tab in an open conversation.
  const [tab, setTab] = React.useState<"sessions" | "heartbeats">("sessions");
  // Instant client-side title filter over whatever the current tab already loaded. Real content
  // search (matching a keyword inside a session's own messages, not just its title) needs a
  // backend route this pass didn't add — deliberately scoped down; documented as a real, separate
  // follow-up rather than silently dropped.
  const [query, setQuery] = React.useState("");

  const refresh = React.useCallback(() => {
    if (!session) return;
    setLoading(true);
    listSessions(activeSpaceId, { sessionToken: session.session_token, endUserId: session.end_user_id }, 100, tab === "heartbeats" ? "heartbeat" : undefined)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [activeSpaceId, session, tab]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Regaining focus (tab switch, browser back) re-fetches — a session started elsewhere while
  // this tab was in the background should show up without a manual reload.
  React.useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const filtered = query.trim()
    ? sessions.filter((s) => (s.title ?? "Untitled conversation").toLowerCase().includes(query.trim().toLowerCase()))
    : sessions;

  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="page-title">Sessions</div>
          <div className="page-subtitle">Your conversations with the assistant.</div>
        </div>
        <Button onClick={() => router.push(`/p/${product.slug}`)}>New session</Button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={() => setTab("sessions")}
            className={tab === "sessions" ? "btn-primary" : "btn-ghost"}
            style={{ fontSize: 12.5, padding: "5px 10px" }}
          >
            Sessions
          </button>
          <button
            type="button"
            onClick={() => setTab("heartbeats")}
            className={tab === "heartbeats" ? "btn-primary" : "btn-ghost"}
            style={{ fontSize: 12.5, padding: "5px 10px" }}
          >
            Heartbeat sessions
          </button>
        </div>
        <input
          type="text"
          placeholder="Search by title…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: "1 1 200px", minWidth: 160, fontSize: 13, padding: "6px 10px",
            border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface1)", color: "var(--text1)",
          }}
        />
      </div>

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          {query.trim()
            ? "No sessions match that search."
            : tab === "heartbeats"
              ? "No heartbeat sessions yet — these appear once the assistant's own scheduled/cron wake-ups start running."
              : "No conversations yet — start one from Home."}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {filtered.map((s) => (
            <Link
              key={s.id}
              href={`/p/${product.slug}/sessions/${s.id}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                padding: "11px 12px",
                borderRadius: 8,
                textDecoration: "none",
                color: "var(--text1)",
                fontSize: 13.5,
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.title ?? "Untitled conversation"}
              </span>
              <span style={{ color: "var(--text3)", fontSize: 12, whiteSpace: "nowrap" }}>{relativeTime(s.updated_at)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
