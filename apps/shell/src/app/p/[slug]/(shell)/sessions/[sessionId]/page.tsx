"use client";

export const runtime = "edge";

// One assistant conversation, opened by id. Distinct from /threads/:id, which is a STRUCTURAL
// thread inside a project — a different table with a different lifecycle. Sessions are what the
// sidebar lists and what Home starts; project work lives under /projects/:id.

import * as React from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Chat } from "@/components/Chat";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";

export default function SessionPage() {
  const params = useParams<{ sessionId: string }>();
  const searchParams = useSearchParams();
  const { activeSpaceId, supportContact } = useActiveSpace();
  const { session } = useProductAuth();

  // Home mints the session and passes the opening line through the URL, which Chat then sends on
  // mount — so the landing page never needs its own copy of the chat machinery. Stripped from the
  // address bar immediately so a reload can't re-send it.
  const initial = searchParams.get("q");
  React.useEffect(() => {
    if (!initial) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("q");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }, [initial]);

  if (!session) return null;

  return (
    <Chat
      spaceId={activeSpaceId}
      session={{ sessionToken: session.session_token, endUserId: session.end_user_id }}
      sessionId={params.sessionId}
      title="Assistant"
      supportContact={supportContact}
      {...(initial ? { initialMessage: initial } : {})}
    />
  );
}
