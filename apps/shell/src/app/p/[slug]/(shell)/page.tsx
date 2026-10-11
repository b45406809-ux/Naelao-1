"use client";

// The shell root is not a page of its own — starting a conversation lives at /new (the same
// split claude.com uses). Landing here redirects there so an existing bookmark, the post-login
// landing, and the sidebar's "new session" button all end up in one place instead of two
// near-identical surfaces that can drift apart.

import * as React from "react";
import { useRouter } from "next/navigation";
import { useProduct } from "@/lib/product-context";

export default function ShellRootRedirect() {
  const product = useProduct();
  const router = useRouter();

  React.useEffect(() => {
    router.replace(`/p/${product.slug}/new`);
  }, [router, product.slug]);

  return (
    <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</span>
    </div>
  );
}
