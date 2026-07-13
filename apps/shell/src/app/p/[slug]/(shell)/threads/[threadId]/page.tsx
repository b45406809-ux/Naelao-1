"use client";

export const runtime = "edge";

// A thread's own chat surface. Threads (structural browse, SpaceDO `threads` table) and chat
// sessions (SpaceDO `sessions` table, the message-history transport) are separate tables with no
// server-side link yet — this page's `sessionKey={threadId}` keeps each thread's chat session
// persisted independently client-side, which is an honest approximation until a real
// thread<->session link exists server-side (out of Phase B scope).

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
    />
  );
}
