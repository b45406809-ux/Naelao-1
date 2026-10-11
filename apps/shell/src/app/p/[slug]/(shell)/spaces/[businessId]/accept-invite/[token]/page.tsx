"use client";


// Redeeming a business invite requires the visitor to already be signed in as a product end user
// (the (shell) layout above this route enforces that, redirecting to login otherwise) — a
// deliberate simplification vs. the phased plan's original "fully unauthenticated accept" sketch;
// see business-routes.ts's own comment for why authenticating the accepting identity was chosen
// over trusting an emailed link alone.

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { acceptBusinessInvite } from "@/lib/api";

export default function AcceptInvitePage() {
  const params = useParams<{ businessId: string; token: string }>();
  const product = useProduct();
  const { session } = useProductAuth();
  const router = useRouter();
  const [status, setStatus] = React.useState<"pending" | "accepting" | "done" | "error">("pending");
  const [error, setError] = React.useState<string | null>(null);

  async function handleAccept() {
    if (!session) return;
    setStatus("accepting");
    try {
      await acceptBusinessInvite(params.businessId, params.token, { sessionToken: session.session_token, endUserId: session.end_user_id });
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to accept invite");
    }
  }

  if (status === "done") {
    return (
      <div className="page-view">
        <p style={{ marginBottom: 16 }}>You&rsquo;ve joined this business.</p>
        <Button onClick={() => router.push(`/p/${product.slug}/spaces/${params.businessId}`)}>Go to business</Button>
      </div>
    );
  }

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">You&rsquo;ve been invited</div>
        <div className="page-subtitle">Accept to join this business as a collaborator.</div>
      </div>
      {error && <p style={{ color: "#dc2626", marginBottom: 12 }}>{error}</p>}
      <Button onClick={handleAccept} disabled={status === "accepting"}>
        {status === "accepting" ? "Accepting…" : "Accept Invite"}
      </Button>
    </div>
  );
}
