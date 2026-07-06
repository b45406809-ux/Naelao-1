"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// WS-5.3 (audit plan): this used to be a second, competing Space list+create surface (raw
// `createSpace()` straight against POST /spaces, bypassing the Builder Dashboard API entirely) —
// a real split-brain against /dashboard/products, which IS the same underlying `spaces` table
// (builder-routes.ts's GET /builder/products/:id reads it directly) but through the canonical,
// tested product-creation path. The per-space admin tool pages this section used to link to
// (KB, commerce, connectors, credentials, eval, onboarding, sessions, webhooks) are real and kept
// at their existing /dashboard/spaces/:id/* routes — surfaced now from the one Product Overview
// tab instead of from here. This route stays only so old links/bookmarks land somewhere useful.
export default function LegacySpacesRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/products");
  }, [router]);
  return null;
}
