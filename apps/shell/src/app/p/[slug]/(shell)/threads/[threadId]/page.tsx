"use client";

export const runtime = "edge";

// A thread's own chat surface (the flat /threads/:id route, reached from the Sessions browse
// list). threads.session_id (added for exactly this) links it to the real chat session — passed
// through to Chat below the same way the project-scoped page at
// projects/[projectId]/threads/[threadId]/page.tsx already does, so a thread the assistant (or
// the "New Session" button) created reuses its real linked session instead of Chat's own
// lazy-mint fallback minting a second, unlinked one.

import * as React from "react";
import { useParams } from "next/navigation";
import { Chat } from "@/components/Chat";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { getThread, type ThreadSummary } from "@/lib/api";

export default function ThreadChatPage() {
  const params = useParams<{ threadId: string }>();
  const { activeSpaceId } = useActiveSpace();
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
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Couldn't load this thread. Try again from Sessions.</p>
      </div>
    );
  }
  // Wait for the thread to load, same reasoning as the project-scoped page: rendering Chat before
  // we know thread.session_id always takes the lazy-mint fallback, which would mint an unlinked
  // session even for a thread that already HAS one.
  if (!thread) return <div className="page-view">Loading…</div>;

  return (
    <Chat
      spaceId={activeSpaceId}
      session={creds}
      sessionKey={params.threadId}
      title={thread.title ?? "Thread"}
      threadId={params.threadId}
      {...(thread.session_id ? { sessionId: thread.session_id } : {})}
    />
  );
}
