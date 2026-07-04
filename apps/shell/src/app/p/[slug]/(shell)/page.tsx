"use client";

import { Chat } from "@/components/Chat";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";

export default function HomePage() {
  const product = useProduct();
  const { session } = useProductAuth();

  if (!session) return null;

  return (
    <Chat
      spaceId={product.space_id}
      session={{ sessionToken: session.session_token, endUserId: session.end_user_id }}
      sessionKey="home"
      title="Home"
    />
  );
}
