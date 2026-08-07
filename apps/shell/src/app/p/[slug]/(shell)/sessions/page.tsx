"use client";

export const runtime = "edge";

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

  const refresh = React.useCallback(() => {
    if (!session) return;
    listSessions(activeSpaceId, { sessionToken: session.session_token, endUserId: session.end_user_id }, 100)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [activeSpaceId, session]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Regaining focus (tab switch, browser back) re-fetches — a session started elsewhere while
  // this tab was in the background should show up without a manual reload.
  React.useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="page-title">Sessions</div>
          <div className="page-subtitle">Your conversations with the assistant.</div>
        </div>
        <Button onClick={() => router.push(`/p/${product.slug}`)}>New session</Button>
      </div>

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : sessions.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          No conversations yet — start one from Home.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {sessions.map((s) => (
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
