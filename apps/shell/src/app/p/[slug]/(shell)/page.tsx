"use client";

import { Chat } from "@/components/Chat";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";

export default function HomePage() {
  const { activeSpaceId, activeSpaceName, isBusinessSpace, supportContact } = useActiveSpace();
  const { session } = useProductAuth();

  if (!session) return null;

  return (
    <Chat
      spaceId={activeSpaceId}
      session={{ sessionToken: session.session_token, endUserId: session.end_user_id }}
      sessionKey="home"
      title={isBusinessSpace ? (activeSpaceName ?? "Home") : "Home"}
      supportContact={supportContact}
    />
  );
}
