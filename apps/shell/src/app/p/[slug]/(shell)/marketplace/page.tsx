"use client";

export const runtime = "edge";

import * as React from "react";
import { useRouter, useParams } from "next/navigation";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { MarketplaceHub } from "@/components/MarketplaceHub";

export default function MarketplacePage() {
  const product = useProduct();
  const { session } = useProductAuth();
  const { setActiveSpace } = useActiveSpace();
  const router = useRouter();
  const params = useParams<{ slug: string }>();

  if (!session) {
    return (
      <div className="flex h-64 items-center justify-center text-xs text-zinc-500">
        Please sign in to access the template marketplace.
      </div>
    );
  }

  const creds = {
    sessionToken: session.session_token,
    endUserId: session.end_user_id,
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <MarketplaceHub
        productSpaceId={product.space_id}
        session={creds}
        onLaunchSuccess={(newSpaceId) => {
          setActiveSpace(newSpaceId);
          router.push(`/p/${params.slug}/dashboard`);
        }}
      />
    </div>
  );
}
