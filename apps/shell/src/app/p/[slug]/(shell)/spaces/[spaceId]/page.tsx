"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { useProduct } from "@/lib/product-context";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProductAuth } from "@/lib/auth-provider";
import { listMySpaces } from "@/lib/api";

/** Compatibility route for links saved by older Naelao clients. Spaces are managed from the
 * generic Spaces view; this route only selects the authorized Space and returns to the shell. */
export default function SpaceCompatibilityPage() {
  const params = useParams<{ slug: string; spaceId: string }>();
  const router = useRouter();
  const product = useProduct();
  const { session } = useProductAuth();
  const { setActiveSpace } = useActiveSpace();

  React.useEffect(() => {
    let cancelled = false;
    if (!session) return;
    void listMySpaces(product.space_id, {
      sessionToken: session.session_token,
      endUserId: session.end_user_id,
    }).then((spaces) => {
      if (cancelled) return;
      const space = spaces.find((candidate) => candidate.id === params.spaceId);
      if (space) setActiveSpace(space.id, space.name);
      router.replace(`/p/${params.slug}`);
    }).catch(() => router.replace(`/p/${params.slug}/spaces`));
    return () => { cancelled = true; };
  }, [params.spaceId, params.slug, product.space_id, router, session, setActiveSpace]);

  return <main className="page-shell"><p className="muted">Opening Space…</p></main>;
}
