"use client";

import * as React from "react";
import {
  beginAssistantChannelMemberContactVerification,
  listAssistantChannelMemberAccess,
  listProjectMembers,
  listSpaceMembers,
  revokeAssistantChannelMemberContact,
  setAssistantChannelMemberAccess,
  setAssistantChannelMemberRoutingMode,
  type AssistantChannelMemberAccess,
  type SessionCredentials,
} from "@/lib/api";

type RoutingMode = "customer_service_only" | "staff_and_customers";
type RosterMember = { user_id: string; label: string; role?: string; active: boolean };

export function WhatsAppMemberAccessPanel({
  spaceId,
  projectId,
  session,
  canManage,
  connected,
  enabled,
  routingMode,
  onChanged,
}: {
  spaceId: string;
  projectId?: string | null;
  session: SessionCredentials;
  canManage: boolean;
  connected: boolean;
  enabled: boolean;
  routingMode?: RoutingMode;
  onChanged: () => void;
}) {
  const [ownGrants, setOwnGrants] = React.useState<AssistantChannelMemberAccess[]>([]);
  const [scopeGrants, setScopeGrants] = React.useState<AssistantChannelMemberAccess[]>([]);
  const [roster, setRoster] = React.useState<RosterMember[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [savingUser, setSavingUser] = React.useState<string | null>(null);
  const [challengeBusy, setChallengeBusy] = React.useState(false);
  const [challenge, setChallenge] = React.useState<{ code: string; instructions: string; expiresAt: string } | null>(null);
  const [challengeError, setChallengeError] = React.useState<string | null>(null);
  const [revokeConfirm, setRevokeConfirm] = React.useState(false);
  const [revokeBusy, setRevokeBusy] = React.useState(false);
  const [revokeNotice, setRevokeNotice] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<RoutingMode>(routingMode ?? "staff_and_customers");
  const [modeBusy, setModeBusy] = React.useState(false);
  const [modeError, setModeError] = React.useState<string | null>(null);
  const activeScope = projectId ?? null;

  const refresh = React.useCallback(async () => {
    setLoadError(null);
    try {
      const [mine, managed] = await Promise.all([
        listAssistantChannelMemberAccess(spaceId, session, { mine: true }),
        canManage ? listAssistantChannelMemberAccess(spaceId, session) : Promise.resolve([]),
      ]);
      setOwnGrants(mine);
      setScopeGrants(managed.filter(grant => grant.project_id === activeScope));
      if (canManage) {
        if (projectId) {
          const members = await listProjectMembers(spaceId, projectId, session);
          setRoster(members.map(member => ({ user_id: member.user_id, label: member.user_id, role: member.role, active: true })));
        } else {
          const members = await listSpaceMembers(spaceId, session);
          setRoster(members.map(member => ({
            user_id: member.end_user_id,
            label: member.display_name || member.end_user_id,
            role: member.role,
            active: member.status === "active",
          })).filter(member => member.active));
        }
      } else {
        setRoster([]);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "WhatsApp member access is unavailable.");
    }
  }, [spaceId, projectId, session, canManage, activeScope]);

  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => { setMode(routingMode ?? "staff_and_customers"); }, [routingMode]);

  const currentScopeGrants = ownGrants.filter(grant => grant.project_id === activeScope);
  const currentScopeGrantByUser = new Map(scopeGrants.map(grant => [grant.user_id, grant]));
  const hasOwnEnabledGrant = ownGrants.some(grant => grant.status === "enabled");
  const ownContactVerified = ownGrants.some(grant => Boolean(grant.contact_verified));
  const scopeLabel = activeScope ? `Project ${activeScope}` : "Space assistant";

  async function saveGrant(userId: string, status: AssistantChannelMemberAccess["status"]) {
    setSavingUser(userId);
    setLoadError(null);
    try {
      await setAssistantChannelMemberAccess(spaceId, session, { user_id: userId, project_id: activeScope, status });
      await refresh();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The WhatsApp member grant could not be saved.");
    } finally {
      setSavingUser(null);
    }
  }

  async function changeMode(next: RoutingMode) {
    setModeBusy(true);
    setModeError(null);
    try {
      const result = await setAssistantChannelMemberRoutingMode(spaceId, session, next);
      setMode(result.member_routing_mode);
      onChanged();
    } catch (error) {
      setModeError(error instanceof Error ? error.message : "The WhatsApp routing mode could not be saved.");
    } finally {
      setModeBusy(false);
    }
  }

  async function beginVerification() {
    setChallengeBusy(true);
    setChallengeError(null);
    setChallenge(null);
    try {
      const result = await beginAssistantChannelMemberContactVerification(spaceId, session);
      setChallenge({ code: result.challenge, instructions: result.instructions, expiresAt: result.expires_at });
    } catch (error) {
      setChallengeError(error instanceof Error ? error.message : "A verification code could not be created.");
    } finally {
      setChallengeBusy(false);
    }
  }

  async function revokeContact() {
    setRevokeBusy(true);
    setChallenge(null);
    setChallengeError(null);
    setRevokeNotice(null);
    try {
      const result = await revokeAssistantChannelMemberContact(spaceId, session);
      setRevokeNotice(result.contacts_revoked > 0
        ? "Your active WhatsApp contact was revoked. Existing route selections and pending verification codes were cleared."
        : "No active WhatsApp contact remained to revoke.");
      setRevokeConfirm(false);
      await refresh();
    } catch (error) {
      setChallengeError(error instanceof Error ? error.message : "Your WhatsApp contact could not be revoked.");
    } finally {
      setRevokeBusy(false);
    }
  }

  return (
    <details style={{ marginTop: 10, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
      <summary style={{ cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>
        WhatsApp member access · {scopeLabel}
      </summary>

      {canManage && <section style={{ marginTop: 10 }} aria-label="WhatsApp connection routing mode">
        <strong style={{ fontSize: 11.5 }}>Connection routing mode</strong>
        <p style={{ margin: "4px 0 7px", color: "var(--text3)", fontSize: 10.5, lineHeight: 1.45 }}>
          This Space-wide setting controls all WhatsApp member grants and paired customer messages.
        </p>
        <select aria-label="WhatsApp connection routing mode" disabled={!connected || modeBusy} value={mode}
          onChange={event => void changeMode(event.target.value as RoutingMode)}
          style={{ maxWidth: 340, background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, padding: "6px 8px", fontSize: 12 }}>
          <option value="customer_service_only">Customer service only</option>
          <option value="staff_and_customers">Staff and customers</option>
        </select>
        {!connected && <p style={{ margin: "5px 0 0", color: "var(--text3)", fontSize: 10.5 }}>Connect WhatsApp before choosing its routing mode.</p>}
        {modeError && <p role="alert" style={{ color: "var(--danger, #d33)", fontSize: 10.5 }}>{modeError}</p>}
      </section>}

      {canManage && <section style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }} aria-label="Manage WhatsApp member grants">
        <strong style={{ fontSize: 11.5 }}>Member grants for {scopeLabel}</strong>
        <p style={{ margin: "4px 0 7px", color: "var(--text3)", fontSize: 10.5, lineHeight: 1.45 }}>
          Access is off until granted. Members must verify their own WhatsApp contact before routing is available.
        </p>
        {roster.length === 0 && !loadError && <p style={{ fontSize: 10.5, color: "var(--text3)" }}>No active members are available in this scope.</p>}
        {roster.map(member => {
          const grant = currentScopeGrantByUser.get(member.user_id);
          const isSaving = savingUser === member.user_id;
          return <div key={member.user_id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 0", borderTop: "1px solid var(--border)" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ overflowWrap: "anywhere", fontSize: 10.5, color: "var(--text)" }}>{member.label}</div>
              {member.label !== member.user_id && <div style={{ overflowWrap: "anywhere", fontSize: 9.5, color: "var(--text3)" }}>{member.user_id}</div>}
              <div style={{ fontSize: 10, color: "var(--text3)" }}>
                {member.role ? `${member.role} · ` : ""}{grant ? `${grant.status} · ${grant.contact_verified ? "contact verified" : "contact not verified"} · ${grant.last_used_at ? `last used ${new Date(grant.last_used_at).toLocaleString()}` : "not used yet"}${grant.selected_until ? ` · selected until ${new Date(grant.selected_until).toLocaleString()}` : ""}` : "not granted"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
              {grant?.status === "enabled" ? <>
                <button type="button" className="btn-ghost" disabled={isSaving} onClick={() => void saveGrant(member.user_id, "suspended")}>{isSaving ? "Saving…" : "Suspend"}</button>
                <button type="button" className="btn-ghost" disabled={isSaving} onClick={() => void saveGrant(member.user_id, "revoked")}>Revoke</button>
              </> : <>
                <button type="button" className="btn-ghost" disabled={isSaving} onClick={() => void saveGrant(member.user_id, "enabled")}>
                  {isSaving ? "Saving…" : grant?.status === "suspended" ? "Restore" : "Grant access"}
                </button>
                {grant?.status === "suspended" && <button type="button" className="btn-ghost" disabled={isSaving} onClick={() => void saveGrant(member.user_id, "revoked")}>Revoke</button>}
              </>}
            </div>
          </div>;
        })}
      </section>}

      {!canManage && currentScopeGrants.length === 0 && <p style={{ margin: "10px 0 0", fontSize: 10.5, color: "var(--text3)" }}>
        You do not have a WhatsApp member grant for {scopeLabel}. Ask a Space admin to review access.
      </p>}

      <section style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }} aria-label="Your WhatsApp member route">
        <strong style={{ fontSize: 11.5 }}>Your member route</strong>
        {ownGrants.length > 0 ? <div style={{ marginTop: 5, fontSize: 10.5, color: "var(--text2)" }}>
          {ownGrants.map(grant => <div key={`${grant.project_id ?? "space"}:${grant.revision}`}>
            {grant.project_id ? `Project ${grant.project_id}` : "Space assistant"}: {grant.status}{grant.contact_verified ? " · contact verified" : " · contact not verified"}{grant.last_used_at ? ` · last used ${new Date(grant.last_used_at).toLocaleString()}` : " · not used yet"}{grant.selected_until ? ` · selected until ${new Date(grant.selected_until).toLocaleString()}` : ""}
          </div>)}
          <p style={{ margin: "5px 0 0", fontSize: 10, color: "var(--text3)" }}>Project routes also require your current Project membership. Grant, contact and membership checks run again for each message.</p>
        </div> : <p style={{ margin: "4px 0 0", fontSize: 10.5, color: "var(--text3)" }}>No WhatsApp member grant is recorded in this Space.</p>}
        {mode === "customer_service_only" && <p style={{ margin: "5px 0 0", fontSize: 10.5, color: "var(--text3)" }}>Member assistant routing is paused while this connection is in Customer service only mode.</p>}
        {!enabled && <p style={{ margin: "5px 0 0", fontSize: 10.5, color: "var(--text3)" }}>WhatsApp is turned off for this connection.</p>}
        {mode === "staff_and_customers" && enabled && hasOwnEnabledGrant && <div style={{ marginTop: 7 }}>
          <button type="button" className="btn-ghost" disabled={challengeBusy} onClick={() => void beginVerification()}>
            {challengeBusy ? "Preparing code…" : ownContactVerified ? "Replace verified WhatsApp contact" : "Verify your WhatsApp contact"}
          </button>
          <p style={{ margin: "4px 0", fontSize: 10, color: "var(--text3)" }}>{ownContactVerified ? "Verifying a new contact replaces the binding for this configured provider destination. Only you can verify it; the number itself is not shown in Naelao." : "Only you can verify your contact. The number itself is not shown in Naelao."}</p>
        </div>}
        {ownContactVerified && <div style={{ marginTop: 7 }}>
          {!revokeConfirm ? <button type="button" className="btn-ghost" disabled={revokeBusy} onClick={() => setRevokeConfirm(true)}>Revoke your verified contact</button> : <div role="group" aria-label="Confirm WhatsApp contact revocation">
            <span style={{ fontSize: 10.5, color: "var(--text2)" }}>Member routing will stop using your verified contact.</span>
            <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
              <button type="button" className="btn-ghost" disabled={revokeBusy} onClick={() => void revokeContact()}>{revokeBusy ? "Revoking…" : "Confirm revoke"}</button>
              <button type="button" className="btn-ghost" disabled={revokeBusy} onClick={() => setRevokeConfirm(false)}>Cancel</button>
            </div>
          </div>}
        </div>}
        {challenge && <div role="status" style={{ marginTop: 7, padding: 8, background: "var(--surface2)", borderRadius: 6, fontSize: 10.5 }}>
          <div>{challenge.instructions}</div>
          <code style={{ display: "inline-block", margin: "6px 0", fontSize: 13, userSelect: "all" }}>{challenge.code}</code>
          <div>Expires {new Date(challenge.expiresAt).toLocaleString()}.</div>
        </div>}
        {challengeError && <p role="alert" style={{ color: "var(--danger, #d33)", fontSize: 10.5 }}>{challengeError}</p>}
        {revokeNotice && <p role="status" style={{ fontSize: 10.5, color: "var(--text2)" }}>{revokeNotice}</p>}
        {mode === "staff_and_customers" && enabled && ownContactVerified && <p style={{ margin: "5px 0 0", fontSize: 10.5, color: "var(--text3)", lineHeight: 1.45 }}>
          Message the connected WhatsApp number. If you have multiple routes, send <code>USE &lt;space-id&gt; [project-id]</code>; the selection lasts 30 minutes. Send <code>USE RESET</code> to clear it.
        </p>}
      </section>

      {loadError && <p role="alert" style={{ margin: "7px 0 0", color: "var(--danger, #d33)", fontSize: 10.5 }}>{loadError}</p>}
    </details>
  );
}
