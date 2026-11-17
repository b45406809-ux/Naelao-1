"use client";

import * as React from "react";
import {
  createSpaceMemberInvitation,
  listSpaceBusinessRoleReviews,
  listSpaceBusinessRoleOptions,
  listSpaceMemberInvitations,
  revokeSpaceBusinessRoleReview,
  revokeSpaceMemberInvitation,
  type SessionCredentials,
  type SpaceBusinessRoleReview,
  type SpaceBusinessRoleOptionCatalog,
  type SpaceMemberInvitation,
} from "@/lib/api";
import { buildSpaceInvitationLink } from "@/lib/space-invitation-link";

export function SpaceMemberOnboardingPanel({ spaceId, productSlug, session, canManage, canInviteAdmin }: {
  spaceId: string;
  productSlug: string;
  session: SessionCredentials | null;
  canManage: boolean;
  canInviteAdmin: boolean;
}) {
  const [invitations, setInvitations] = React.useState<SpaceMemberInvitation[]>([]);
  const [reviews, setReviews] = React.useState<SpaceBusinessRoleReview[]>([]);
  const [roleOptions, setRoleOptions] = React.useState<SpaceBusinessRoleOptionCatalog["blueprints"]>([]);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"viewer" | "member" | "admin">("member");
  const [blueprintId, setBlueprintId] = React.useState("");
  const [businessRoleId, setBusinessRoleId] = React.useState("");
  const [created, setCreated] = React.useState<{ id: string; token: string } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!session || !canManage) return;
    setLoading(true);
    setError(null);
    try {
      const [nextInvitations, nextReviews, nextRoleOptions] = await Promise.allSettled([
        listSpaceMemberInvitations(spaceId, session),
        listSpaceBusinessRoleReviews(spaceId, session),
        listSpaceBusinessRoleOptions(spaceId, session),
      ]);
      if (nextInvitations.status === "fulfilled") setInvitations(nextInvitations.value);
      if (nextReviews.status === "fulfilled") setReviews(nextReviews.value);
      if (nextRoleOptions.status === "fulfilled") setRoleOptions(nextRoleOptions.value.blueprints);
      const failed = [nextInvitations, nextReviews, nextRoleOptions].some(result => result.status === "rejected");
      if (failed) setError("Some member or signed-role details could not be refreshed. Displayed lists may be stale; retry before taking action.");
    } catch {
      setError("Member invitations and role reviews could not be loaded. Retry to check their current status.");
    } finally {
      setLoading(false);
    }
  }, [spaceId, session, canManage]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  async function createInvitation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !canManage || saving) return;
    const hasBlueprint = blueprintId.trim().length > 0;
    const hasRole = businessRoleId.trim().length > 0;
    if (hasBlueprint !== hasRole) {
      setError("Select both an active blueprint and one of its declared roles, or leave the template-role selection blank.");
      return;
    }
    setSaving(true); setError(null); setNotice(null); setCreated(null);
    try {
      const result = await createSpaceMemberInvitation(spaceId, session, {
        email: email.trim(), role,
        ...(hasBlueprint ? { blueprint_id: blueprintId.trim(), business_role_id: businessRoleId.trim() } : {}),
      });
      setCreated({ id: result.id, token: result.token });
      setEmail("");
      setNotice("Invitation recorded. Delivery was not sent; securely hand off the invitation ID and token yourself.");
      await refresh();
    } catch {
      setError("Invitation could not be created. Check the current Space role, verified recipient status, and active template role, then retry.");
    } finally {
      setSaving(false);
    }
  }

  async function revokeInvitation(invitation: SpaceMemberInvitation) {
    if (!session || !canManage || invitation.status !== "pending") return;
    setError(null); setNotice(null);
    try {
      await revokeSpaceMemberInvitation(spaceId, session, invitation.id);
      setNotice("Invitation revoked.");
      await refresh();
    } catch {
      setError("Invitation status changed or could not be updated. Refresh before retrying.");
      await refresh();
    }
  }

  async function revokeReview(review: SpaceBusinessRoleReview) {
    if (!session || !canManage || review.status !== "proposal_only") return;
    setError(null); setNotice(null);
    try {
      await revokeSpaceBusinessRoleReview(spaceId, session, review.id);
      setNotice("Role proposal revoked. No resource grants were applied.");
      await refresh();
    } catch {
      setError("Role proposal changed or could not be revoked. Refresh to check its current status.");
      await refresh();
    }
  }

  async function copyHandoff() {
    if (!created) return;
    try {
      const url = buildSpaceInvitationLink({ origin: window.location.origin, productSlug, spaceId,
        invitationId: created.id, token: created.token });
      await navigator.clipboard.writeText(url);
      setNotice("Invitation link copied. The token is in the URL fragment, which is not sent to the server. Delivery remains your responsibility.");
    } catch {
      setNotice("Clipboard unavailable. Copy the invitation ID and token shown below; delivery was not sent.");
    }
  }

  if (!canManage) return <p className="settings-section-sub">Only Space owners and authorized administrators can manage invitations or review template-role proposals.</p>;

  return (
    <section aria-labelledby="member-onboarding-heading">
      <div className="settings-section-title" id="member-onboarding-heading">Invitations and template roles</div>
      <p className="settings-section-sub">Invitations are copy-only. A template role is a reviewed proposal and does not grant Project, app, Knowledge, channel, or spending access.</p>
      <p className="settings-row-sub">No email or SMS is sent. You must securely deliver the one-time invitation ID and token to the intended verified Product account.</p>

      <form className="settings-block" onSubmit={createInvitation} aria-label="Invite a Space member" style={{ padding: 16 }}>
        <label className="settings-row-label" htmlFor="member-invite-email">Member email</label>
        <input id="member-invite-email" className="form-input" type="email" autoComplete="email" required maxLength={320}
          value={email} onChange={event => setEmail(event.target.value)} placeholder="member@example.com" />
        <label className="settings-row-label" htmlFor="member-invite-role" style={{ marginTop: 12 }}>Space role</label>
        <select id="member-invite-role" className="form-input" value={role} onChange={event => setRole(event.target.value as typeof role)}>
          <option value="viewer">Viewer</option>
          <option value="member">Member</option>
          {canInviteAdmin && <option value="admin">Administrator</option>}
        </select>
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>Optional builder-defined role proposal</summary>
          <p className="settings-row-sub">Only active, signed blueprints and declared roles appear here. The server rechecks the exact artifact; role access remains unapplied.</p>
          <label className="settings-row-label" htmlFor="member-invite-blueprint">Template blueprint</label>
          <select id="member-invite-blueprint" className="form-input" value={blueprintId} onChange={event => {
            const selected = event.target.value;
            setBlueprintId(selected);
            setBusinessRoleId(roleOptions.find(item => item.blueprint_id === selected)?.roles[0]?.id ?? "");
          }}>
            <option value="">No template role</option>
            {roleOptions.map(option => <option key={option.blueprint_id} value={option.blueprint_id}>{option.blueprint_id}</option>)}
          </select>
          <label className="settings-row-label" htmlFor="member-invite-business-role" style={{ marginTop: 8 }}>Business role</label>
          <select id="member-invite-business-role" className="form-input" value={businessRoleId} disabled={!blueprintId}
            onChange={event => setBusinessRoleId(event.target.value)}>
            <option value="">Choose a declared role</option>
            {roleOptions.find(item => item.blueprint_id === blueprintId)?.roles.map(option => <option key={option.id} value={option.id}>
              {option.name.en ?? Object.values(option.name)[0] ?? option.id} ({option.id})
            </option>)}
          </select>
        </details>
        <button className="btn btn-primary btn-sm" type="submit" disabled={saving || !session} style={{ marginTop: 14 }}>
          {saving ? "Creating…" : "Create copy-only invitation"}
        </button>
      </form>

      {created && (
        <div className="settings-block" role="status" style={{ padding: 16 }}>
          <div className="settings-row-label">One-time handoff token</div>
          <p className="settings-row-sub">This token is shown only in this browser view. Deliver it securely with the invitation ID; the platform has not sent a message.</p>
          <div><code>Invitation ID: {created.id}</code></div>
          <div style={{ overflowWrap: "anywhere", marginTop: 6 }}><code>Token: {created.token}</code></div>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => void copyHandoff()} style={{ marginTop: 8 }}>Copy invitation link</button>
        </div>
      )}

      {error && <p role="alert" style={{ color: "#dc2626", fontSize: 13 }}>{error}</p>}
      {notice && <p role="status" style={{ color: "var(--text2)", fontSize: 13 }}>{notice}</p>}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 18 }}>
        <h3 style={{ fontSize: 14 }}>Invitation status</h3>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      <div className="settings-block">
        {invitations.length === 0 ? <p className="settings-row-sub" style={{ padding: 14 }}>No invitations recorded.</p> : invitations.map(invitation => (
          <div className="settings-row" key={invitation.id}>
            <div>
              <div className="settings-row-label">{invitation.role} · {invitation.status}</div>
              <div className="settings-row-sub">{invitation.business_role_id ? `Proposed template role: ${invitation.business_role_id} · artifact ${invitation.artifact_sha256?.slice(0, 12)}` : "No template role selected"}</div>
              <div className="settings-row-sub">Expires {new Date(invitation.expires_at).toLocaleString()} · no email or SMS sent</div>
            </div>
            {invitation.status === "pending" && <button className="btn btn-ghost btn-sm" type="button" onClick={() => void revokeInvitation(invitation)}>Revoke</button>}
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 14, marginTop: 22 }}>Reviewed role proposals</h3>
      <p className="settings-row-sub">These records are bound to the member epoch and signed blueprint version. They do not represent effective permissions.</p>
      <div className="settings-block">
        {reviews.length === 0 ? <p className="settings-row-sub" style={{ padding: 14 }}>No role proposals recorded.</p> : reviews.map(review => (
          <div className="settings-row" key={review.id}>
            <div>
              <div className="settings-row-label">{review.business_role_id} · {review.status}</div>
              <div className="settings-row-sub">Member {review.end_user_id.slice(0, 8)}… · blueprint {review.blueprint_id} · {review.artifact_sha256.slice(0, 12)}</div>
              <div className="settings-row-sub">Grants applied: no</div>
            </div>
            {review.status === "proposal_only" && <button className="btn btn-ghost btn-sm" type="button" onClick={() => void revokeReview(review)}>Revoke proposal</button>}
          </div>
        ))}
      </div>
    </section>
  );
}
