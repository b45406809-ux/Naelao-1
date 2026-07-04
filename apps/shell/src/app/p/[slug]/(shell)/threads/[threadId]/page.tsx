"use client";

// A thread's own chat surface. Threads (structural browse, SpaceDO `threads` table) and chat
// sessions (SpaceDO `sessions` table, the message-history transport) are separate tables with no
// server-side link yet — this page's `sessionKey={threadId}` keeps each thread's chat session
// persisted independently client-side, which is an honest approximation until a real
// thread<->session link exists server-side (out of Phase B scope).

import * as React from "react";
import { useParams } from "next/navigation";
import { Chat } from "@/components/Chat";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { getThread, type ThreadSummary } from "@/lib/api";

export default function ThreadChatPage() {
  const params = useParams<{ threadId: string }>();
  const product = useProduct();
  const { session } = useProductAuth();
  const [thread, setThread] = React.useState<ThreadSummary | null>(null);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  React.useEffect(() => {
    if (!creds) return;
    void getThread(product.space_id, params.threadId, creds)
      .then(setThread)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.space_id, params.threadId, session]);

  if (!creds) return null;

  return (
    <Chat
      spaceId={product.space_id}
      session={creds}
      sessionKey={params.threadId}
      title={thread?.title ?? "Thread"}
    />
  );
}
