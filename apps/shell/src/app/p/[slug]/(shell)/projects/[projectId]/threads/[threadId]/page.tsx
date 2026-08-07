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

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  React.useEffect(() => {
    if (!creds) return;
    void getThread(activeSpaceId, params.threadId, creds)
      .then(setThread)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId, params.threadId, session]);

  if (!creds) return null;

  return (
    <Chat
      spaceId={activeSpaceId}
      session={creds}
      sessionKey={params.threadId}
      title={thread?.title ?? "Thread"}
      supportContact={supportContact}
      threadId={params.threadId}
      projectId={params.projectId}
    />
  );
}
