"use client";


import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Badge, useToast, Toast } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { listThreads, createThread, startSession, type ThreadSummary } from "@/lib/api";

export default function ThreadsPage() {
  const product = useProduct();
  const { activeSpaceId } = useActiveSpace();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const router = useRouter();
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  React.useEffect(() => {
    if (!creds) return;
    void listThreads(activeSpaceId, creds)
      .then(setThreads)
      .catch(() => show("Couldn't load threads"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, session]);

  async function handleNewThread() {
    if (!creds) return;
    setCreating(true);
    try {
      const created = await createThread(activeSpaceId, creds, { title: "New thread" });
      // Link a real chat session immediately — the same pattern the assistant's own thread.create
      // op now uses (see project-coordination.ts) — otherwise this thread has no session_id and
      // reading it back reports "Session not found" until Chat's own lazy-mint fallback runs,
      // which never links back to this thread row at all.
      const started = await startSession(activeSpaceId, creds, "New thread", created.id).catch(() => null);
      window.dispatchEvent(new CustomEvent("naelao:session-created", { detail: { spaceId: activeSpaceId, sessionId: started?.id ?? null, threadId: created.id } }));
      router.push(`/p/${product.slug}/threads/${created.id}`);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to create thread");
      setCreating(false);
    }
  }

  return (
    <div className="page-view">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="page-title">Sessions</div>
          <div className="page-subtitle">Every conversation across this space.</div>
        </div>
        <Button onClick={handleNewThread} disabled={creating}>
          {creating ? "Creating…" : "New Session"}
        </Button>
      </div>

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</p>
      ) : threads.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>No threads yet.</p>
      ) : (
        threads.map((t) => (
          <Link key={t.id} href={`/p/${product.slug}/threads/${t.id}`} style={{ textDecoration: "none" }}>
            <div className="workflow-item">
              <div className="workflow-icon">
                <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="var(--accent)">
                  <path d="M4 2H10L13 5V14H4V2Z" />
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <div className="workflow-name">{t.title ?? "Untitled thread"}</div>
                <div className="workflow-meta">{new Date(t.created_at).toLocaleString()}</div>
              </div>
              <Badge color={t.status === "active" ? "green" : "blue"}>{t.status}</Badge>
            </div>
          </Link>
        ))
      )}
      <Toast toast={toast} />
    </div>
  );
}
