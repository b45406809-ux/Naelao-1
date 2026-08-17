"use client";

export const runtime = "edge";

// A project thread's chat surface, addressed under the project it belongs to
// (/projects/:projectId/threads/:threadId) rather than at the flat /threads/:id — a thread is not
// a free-floating object, it lives in a project, and the URL should say so. The flat route stays
// for now since the standalone Threads browse still links to it.
//
// Threads (SpaceDO `threads`, structural) and chat sessions (SpaceDO `sessions`, the message
// transport) are now linked server-side via threads.session_id (see thread.create in
// project-coordination.ts and startSession's thread_id param) — thread.session_id is passed
// straight to Chat below rather than relying on sessionKey's client-side cache.
//
// A left rail lists this project's OTHER threads (collapsible) so a person can move between
// conversations in the same project without going back to the project page first — reuses the
// same .spaces-layout/.spaces-sidebar shell the project page's own tree already uses, but does
// NOT use .spaces-content for the chat side: that class adds its own padding + overflow-y:auto,
// which would fight Chat's own internal .chat-layout/.chat-area scroll and sticky-composer
// layout. Chat is mounted as a direct flex sibling instead so its own flex:1 sizing still works.

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useProduct } from "@/lib/product-context";
import { Chat } from "@/components/Chat";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { getThread, listThreads, type ThreadSummary } from "@/lib/api";

export default function ProjectThreadPage() {
  const params = useParams<{ projectId: string; threadId: string }>();
  const product = useProduct();
  const { activeSpaceId, supportContact } = useActiveSpace();
  const { session } = useProductAuth();
  const [thread, setThread] = React.useState<ThreadSummary | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [siblingThreads, setSiblingThreads] = React.useState<ThreadSummary[]>([]);
  const [railOpen, setRailOpen] = React.useState(true);

  // Closed by default on a phone. Below 900px `.spaces-sidebar` becomes a full-width horizontal
  // strip above the content — fine on Discover, wrong here: it steals vertical space from a chat
  // surface that needs the full height for its message area and sticky composer, which is what
  // made this page unusable on mobile once the rail was added. Reopening it is one tap.
  //
  // Done in an effect rather than a lazy useState initialiser on purpose: reading `window` during
  // the first render would mismatch the server-rendered markup. Same pattern as the right-hand
  // thread panel's own mobile default.
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches) {
      setRailOpen(false);
    }
  }, []);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  React.useEffect(() => {
    if (!creds) return;
    let cancelled = false;
    setThread(null);
    setLoadFailed(false);
    void getThread(activeSpaceId, params.threadId, creds)
      .then((t) => {
        if (!cancelled) setThread(t);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.threadId, session]);

  // The rail's own thread list — a separate fetch from the single-thread lookup above, and
  // deliberately not blocking on it: a slow/failed list fetch shouldn't hold up opening the
  // thread itself, it just means the rail renders with nothing (or stays as it was) that tick.
  React.useEffect(() => {
    if (!creds) return;
    let cancelled = false;
    void listThreads(activeSpaceId, creds, { projectId: params.projectId })
      .then((list) => {
        if (!cancelled) setSiblingThreads(list);
      })
      .catch(() => {
        /* the rail just shows nothing this render; the thread itself still opens */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.projectId, params.threadId, session]);

  if (!creds) return null;
  if (loadFailed) {
    return (
      <div className="page-view">
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Couldn't load this thread. Try again from the project.</p>
      </div>
    );
  }
  // Wait for the thread to load before mounting Chat, rather than rendering it immediately with
  // no session_id known yet: Chat's `sessionId` prop is read once, on mount, to decide whether to
  // reuse an existing linked session or fall back to client-side caching. Rendering Chat before
  // the thread loads would always take the fallback path — for a thread that already HAS a
  // session (opened again, or from a different browser/tab), that meant minting a brand new,
  // unlinked session every time instead of reusing the real one.
  if (!thread) return <div className="page-view">Loading…</div>;

  return (
    <div className="spaces-layout">
      {railOpen && (
        <div className="spaces-sidebar">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px 6px" }}>
            <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--text3)", letterSpacing: "0.07em", textTransform: "uppercase" }}>
              Threads in this project
            </span>
            <button
              type="button"
              onClick={() => setRailOpen(false)}
              title="Hide thread list"
              style={{ background: "transparent", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 2 }}
            >
              ‹
            </button>
          </div>
          <Link
            href={`/p/${product.slug}/projects/${params.projectId}`}
            className="space-tree-item"
            style={{ textDecoration: "none" }}
          >
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><path d="M2 4H6L7 5H14V13H2V4Z" /></svg>
            Back to project
          </Link>
          <div style={{ padding: "4px 10px", margin: "4px 0" }}>
            <div style={{ height: 1, background: "var(--border)" }} />
          </div>
          {siblingThreads.length === 0 ? (
            <p style={{ fontSize: 11.5, color: "var(--text3)", padding: "4px 10px" }}>No other threads yet.</p>
          ) : (
            siblingThreads.map((t) => (
              <Link
                key={t.id}
                href={`/p/${product.slug}/projects/${params.projectId}/threads/${t.id}`}
                className={`space-tree-item${t.id === params.threadId ? " active" : ""}`}
                style={{ textDecoration: "none" }}
              >
                <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.5} stroke="currentColor"><path d="M4 2H10L13 5V14H4V2Z" /></svg>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title ?? "Untitled thread"}</span>
              </Link>
            ))
          )}
        </div>
      )}
      {!railOpen && (
        <button type="button" className="rail-expander" onClick={() => setRailOpen(true)} title="Show thread list">
          ›<span className="rail-expander-label">Threads in this project</span>
        </button>
      )}
      <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
        <Chat
          spaceId={activeSpaceId}
          session={creds}
          sessionKey={params.threadId}
          title={thread.title ?? "Thread"}
          supportContact={supportContact}
          threadId={params.threadId}
          projectId={params.projectId}
          {...(thread.session_id ? { sessionId: thread.session_id } : {})}
        />
      </div>
    </div>
  );
}
