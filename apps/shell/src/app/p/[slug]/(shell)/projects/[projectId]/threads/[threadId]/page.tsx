"use client";

export const runtime = "edge";

// A project thread's chat surface, addressed under the project it belongs to
// (/projects/:projectId/threads/:threadId) rather than at the flat /threads/:id — a thread is not
// a free-floating object, it lives in a project, and the URL should say so. The flat route stays
// for now since the standalone Threads browse still links to it.
//
// Threads (SpaceDO `threads`, structural) and chat sessions (SpaceDO `sessions`, the message
// transport) remain separate tables with no server-side link. `sessionKey={threadId}` keeps each
// thread's chat session persisted independently client-side — an honest approximation, unchanged
// by this route move, until a real thread<->session link exists server-side.

import * as React from "react";
import { useParams } from "next/navigation";
import { Chat } from "@/components/Chat";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { getThread, type ThreadSummary } from "@/lib/api";

export default function ProjectThreadPage() {
  const params = useParams<{ projectId: string; threadId: string }>();
  const { activeSpaceId, supportContact } = useActiveSpace();
  const { session } = useProductAuth();
  const [thread, setThread] = React.useState<ThreadSummary | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);

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
  );
}
