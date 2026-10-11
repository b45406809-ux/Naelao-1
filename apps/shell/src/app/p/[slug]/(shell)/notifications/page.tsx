"use client";

// Notifications — what your assistant/its agents want you to know about: an approval that opened,
// a run that couldn't finish, a connector that needs setup. Distinct from Approvals: a
// notification doesn't necessarily need a decision, it just needs to be seen — reading this page
// does not answer anything (an approval-kind notification links you to the Approvals page).

import * as React from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Badge, Card, CardTitle, CardDesc, Button } from "@naelao/ui";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { listNotifications, markNotificationRead, type AppNotification } from "@/lib/api";

function severityColor(severity: AppNotification["severity"]): "green" | "amber" | "red" {
  if (severity === "critical") return "red";
  if (severity === "warning") return "amber";
  return "green";
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function NotificationsPage() {
  const params = useParams<{ slug: string }>();
  const { session } = useProductAuth();
  const { activeSpaceId } = useActiveSpace();
  const [items, setItems] = React.useState<AppNotification[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [showRead, setShowRead] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  const refresh = React.useCallback(async () => {
    if (!creds || !activeSpaceId) return;
    setLoading(true);
    try {
      setItems(await listNotifications(activeSpaceId, creds, showRead ? {} : { status: "unread" }));
      setFailed(false);
    } catch {
      // Distinct from "nothing here" — a load failure must never read as "all clear".
      setFailed(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session, showRead]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function markRead(n: AppNotification) {
    if (!creds || !activeSpaceId) return;
    setBusyId(n.id);
    try {
      await markNotificationRead(activeSpaceId, n.id, creds);
      await refresh();
    } catch {
      /* leave it unread — the button stays visible to retry */
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Notifications</div>
        <div className="page-subtitle">
          What your assistant and its agents want you to know about. An approval waiting on you
          shows here too — click through to Approvals to actually decide it.
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <Button variant="secondary" onClick={() => setShowRead((v) => !v)}>
          {showRead ? "Show unread only" : "Show read too"}
        </Button>
      </div>

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : failed ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
          <span style={{ color: "#dc2626" }} role="alert">
            Couldn&rsquo;t load notifications — this is a loading problem, not an empty list.
          </span>
          <Button variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          {showRead ? "Nothing yet." : "Nothing unread. You're caught up."}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map((n) => (
            <Card key={n.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <CardTitle>{n.title}</CardTitle>
                  {n.body && <CardDesc>{n.body}</CardDesc>}
                  {n.source_agent_id && (
                    <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>from {n.source_agent_id}</div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  <Badge color={severityColor(n.severity)}>{timeAgo(n.created_at)}</Badge>
                  {n.status === "unread" && (
                    <Button variant="secondary" onClick={() => void markRead(n)} disabled={busyId === n.id}>
                      {busyId === n.id ? "…" : "Mark read"}
                    </Button>
                  )}
                </div>
              </div>
              {n.kind === "approval_requested" && (
                <div style={{ marginTop: 10 }}>
                  <Link href={`/p/${params.slug}/approvals`} style={{ fontSize: 12, color: "var(--accent)" }}>
                    Review in Approvals →
                  </Link>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
