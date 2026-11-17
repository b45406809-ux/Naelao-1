"use client";

import * as React from "react";
import Link from "next/link";
import { useProduct } from "@/lib/product-context";
import { useProductAuth, useSessionCredentials } from "@/lib/auth-provider";
import { redeemSpaceMemberInvitation } from "@/lib/api";
import { parseSpaceInvitationFragment } from "@/lib/space-invitation-link";

export default function AcceptSpaceInvitationPage() {
  const product = useProduct();
  const { isHydrated, isAuthenticated } = useProductAuth();
  const session = useSessionCredentials();
  const [invite, setInvite] = React.useState<{ spaceId: string; invitationId: string; token: string } | null>(null);
  const [accepted, setAccepted] = React.useState<{ role: string; businessRoleId: string | null } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!isHydrated) return;
    const payload = parseSpaceInvitationFragment(window.location.hash);
    if (payload) setInvite(payload);
    else setError("This invitation link is incomplete or invalid. Ask the Space owner for a current link.");
    // The fragment is never sent to the server. Remove it from history after capturing the
    // one-time token in component memory for an authenticated recipient. Keep it only in the
    // fragment while unauthenticated so signing in in another tab and reloading can resume.
    if (isAuthenticated || !payload) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [isHydrated, isAuthenticated]);

  async function accept() {
    if (!invite || !session || submitting) return;
    setSubmitting(true); setError(null);
    try {
      const result = await redeemSpaceMemberInvitation(invite.spaceId, session, invite.invitationId, invite.token);
      setAccepted({ role: result.role, businessRoleId: result.business_role_id });
      setInvite(null);
    } catch {
      setError("The invitation could not be accepted. Sign in to the same Product account with its verified matching email, or ask the owner to check whether it expired, was revoked, or has a stale template role.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ maxWidth: 620, margin: "8vh auto", padding: 24 }}>
      <div className="settings-block" style={{ padding: 24 }}>
        <h1 style={{ fontSize: 22 }}>Join {product.product_name} Space</h1>
        <p className="settings-section-sub">Accepting adds your verified Product account to the invited Space. Any selected template role remains a review proposal; it does not grant additional Project, app, Knowledge, channel, assistant, or spending access.</p>
        {!accepted && !isHydrated && <p role="status">Checking your sign-in…</p>}
        {!accepted && isHydrated && !isAuthenticated && <div>
          <p>You must sign in first, then reopen the invitation link. The invitation token is held in this link's fragment, not sent to the website server.</p>
          <Link className="btn btn-primary btn-sm" href={"/p/" + encodeURIComponent(product.slug) + "/login"} target="_blank" rel="noreferrer">Sign in to this Product</Link>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => window.location.reload()} style={{ marginLeft: 8 }}>I signed in; reload</button>
        </div>}
        {!accepted && isHydrated && isAuthenticated && <div>
          <p>Continue with the signed-in Product account. The server verifies the matching email and the inviter's current authority.</p>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => void accept()} disabled={!invite || submitting}>
            {submitting ? "Accepting…" : "Accept Space invitation"}
          </button>
        </div>}
        {accepted && <div role="status" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 17 }}>Invitation accepted</h2>
          <p>Your Space membership role is <strong>{accepted.role}</strong>. {accepted.businessRoleId
            ? "The " + accepted.businessRoleId + " template role is recorded as a proposal for the Space owner to review."
            : "No template business role was selected."}</p>
          <p>Additional resource grants applied: no.</p>
          <Link className="btn btn-primary btn-sm" href={"/p/" + encodeURIComponent(product.slug)}>Continue to {product.product_name}</Link>
        </div>}
        {error && <p role="alert" style={{ color: "#dc2626", marginTop: 14 }}>{error}</p>}
      </div>
    </main>
  );
}
