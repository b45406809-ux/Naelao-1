"use client";

import * as React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useProduct } from "@/lib/product-context";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProductAuth } from "@/lib/auth-provider";
import { listMySpaces } from "@/lib/api";

/** Compatibility route for verified Space links; the only supported continuation is Extensions. */
export default function SpaceCompatibilityPage() {
  const params = useParams<{ slug: string; spaceId: string }>();
  const searchParams = useSearchParams();
  const openExtensions = searchParams.get("next") === "extensions";
  const openSettings = searchParams.get("next") === "settings";
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
      const continuation = openExtensions ? "/extensions" : openSettings ? "/settings" : "";
      router.replace(`/p/${params.slug}${continuation}`);
    }).catch(() => router.replace(`/p/${params.slug}/spaces`));
    return () => { cancelled = true; };
  }, [openExtensions, openSettings, params.spaceId, params.slug, product.space_id, router, session, setActiveSpace]);

  return <main className="page-shell"><p className="muted">Opening Space…</p></main>;
}
