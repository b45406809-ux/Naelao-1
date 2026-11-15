import type { CommunicationIdentity } from "./core.js";

type SessionScope = Pick<CommunicationIdentity, "tenant_id" | "space_id" | "project_id">;

export interface ExtensionStreamSessionPin {
  tenantId: string;
  spaceId: string;
  projectId: string | null;
  bindingId: string;
  callControlId: string;
  installationId: string;
  handlerSha256: string;
  settingsRevision: number | null;
  expiresAt: number;
}

export interface ClaimedExtensionStreamSession extends ExtensionStreamSessionPin {
  sessionId: string;
  callRef: string;
  ticketClaimedAt: number;
}

const callControlPattern = /^(?:v\d+:)?[A-Za-z0-9_+=/-]{1,500}$/;

function hex(bytes: Uint8Array): string {
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function validPin(pin: ExtensionStreamSessionPin): boolean {
  return typeof pin.tenantId === "string" && !!pin.tenantId
    && typeof pin.spaceId === "string" && !!pin.spaceId
    && (pin.projectId === null || typeof pin.projectId === "string" && !!pin.projectId)
    && /^[A-Za-z0-9._:-]{1,160}$/.test(pin.bindingId) && callControlPattern.test(pin.callControlId)
    && typeof pin.installationId === "string" && !!pin.installationId && pin.installationId.length <= 160
    && /^[a-f0-9]{64}$/.test(pin.handlerSha256)
    && (pin.settingsRevision === null || Number.isSafeInteger(pin.settingsRevision) && pin.settingsRevision >= 0)
    && Number.isSafeInteger(pin.expiresAt) && pin.expiresAt > 0;
}

/** Persist an explicit-consent-pending session only for the already admitted, exact extension call. */
export async function createTelnyxExtensionStreamSession(db: D1Database, pin: ExtensionStreamSessionPin,
  now = Math.floor(Date.now() / 1000)): Promise<{ sessionId: string; callRef: string }> {
  if (!validPin(pin) || pin.expiresAt <= now) throw new Error("telnyx_extension_stream_pin_invalid");
  const sessionId = `txs_${crypto.randomUUID()}`;
  const callRef = `call_${crypto.randomUUID().replace(/-/g, "")}`;
  const result = await db.prepare(`INSERT OR IGNORE INTO assistant_telnyx_extension_stream_sessions(
      session_id,call_ref,tenant_id,space_id,project_id,binding_id,call_control_id,extension_installation_id,
      handler_sha256,settings_revision,consent_state,state,expires_at,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,'pending','consent_pending',?,?,?
    FROM assistant_telnyx_extension_calls c
    JOIN assistant_phone_bindings b ON b.id=c.binding_id
    JOIN assistant_communication_identities i ON i.id=b.identity_id
    WHERE c.call_control_id=? AND c.binding_id=? AND c.settings_pinned=1 AND c.state IN ('answering','processing','gathering')
      AND c.extension_installation_id=? AND c.handler_sha256=? AND c.settings_revision IS ? AND c.expires_at>=?
      AND b.provider='telnyx' AND b.payer='byo' AND b.purpose='extension' AND b.status='active'
      AND i.status='active' AND i.tenant_id=? AND i.space_id=? AND i.project_id IS ?`)
    .bind(sessionId, callRef, pin.tenantId, pin.spaceId, pin.projectId, pin.bindingId, pin.callControlId,
      pin.installationId, pin.handlerSha256, pin.settingsRevision, pin.expiresAt, now, now,
      pin.callControlId, pin.bindingId, pin.installationId, pin.handlerSha256, pin.settingsRevision, pin.expiresAt,
      pin.tenantId, pin.spaceId, pin.projectId).run();
  if (result.meta.changes !== 1) throw new Error("telnyx_extension_stream_admission_not_found");
  return { sessionId, callRef };
}

/** Store only a hash. A caller must explicitly consent before this function is called. */
export async function grantTelnyxExtensionStreamConsent(db: D1Database, pin: ExtensionStreamSessionPin,
  sessionId: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!validPin(pin) || !/^txs_[a-f0-9-]{36}$/.test(sessionId)) throw new Error("telnyx_extension_stream_consent_invalid");
  const ticket = randomToken();
  const ticketHash = await sha256(ticket);
  const ticketExpiresAt = Math.min(pin.expiresAt, now + 60);
  const result = await db.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET consent_state='granted',state='ready',
      media_ticket_sha256=?,ticket_expires_at=?,updated_at=?
    WHERE session_id=? AND tenant_id=? AND space_id=? AND project_id IS ? AND binding_id=? AND call_control_id=?
      AND extension_installation_id=? AND handler_sha256=? AND settings_revision IS ? AND expires_at=?
      AND consent_state='pending' AND state='consent_pending' AND expires_at>? AND ?<expires_at
      AND EXISTS (
        SELECT 1 FROM assistant_telnyx_extension_calls c
        JOIN assistant_phone_extension_handlers h ON h.binding_id=c.binding_id
        WHERE c.call_control_id=assistant_telnyx_extension_stream_sessions.call_control_id
          AND c.binding_id=assistant_telnyx_extension_stream_sessions.binding_id AND c.settings_pinned=1
          AND c.extension_installation_id=assistant_telnyx_extension_stream_sessions.extension_installation_id
          AND c.handler_sha256=assistant_telnyx_extension_stream_sessions.handler_sha256
          AND c.settings_revision IS assistant_telnyx_extension_stream_sessions.settings_revision
          AND c.state IN ('answering','processing','gathering') AND c.expires_at>?
          AND h.status='active' AND h.installation_id=c.extension_installation_id AND h.handler_sha256=c.handler_sha256)
      AND EXISTS (SELECT 1 FROM assistant_phone_bindings b JOIN assistant_communication_identities i ON i.id=b.identity_id
        WHERE b.id=assistant_telnyx_extension_stream_sessions.binding_id AND b.provider='telnyx' AND b.payer='byo'
          AND b.purpose='extension' AND b.status='active' AND i.status='active'
          AND i.tenant_id=assistant_telnyx_extension_stream_sessions.tenant_id
          AND i.space_id=assistant_telnyx_extension_stream_sessions.space_id
          AND i.project_id IS assistant_telnyx_extension_stream_sessions.project_id)`)
    .bind(ticketHash, ticketExpiresAt, now, sessionId, pin.tenantId, pin.spaceId, pin.projectId, pin.bindingId,
      pin.callControlId, pin.installationId, pin.handlerSha256, pin.settingsRevision, pin.expiresAt,
      now, ticketExpiresAt, now).run();
  if (result.meta.changes !== 1) throw new Error("telnyx_extension_stream_consent_rejected");
  return ticket;
}

export async function denyTelnyxExtensionStreamConsent(db: D1Database, scope: SessionScope, bindingId: string,
  callControlId: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const result = await db.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET consent_state='denied',state='ended',updated_at=?
    WHERE tenant_id=? AND space_id=? AND project_id IS ? AND binding_id=? AND call_control_id=?
      AND state='consent_pending' AND consent_state='pending' AND expires_at>?`)
    .bind(now, scope.tenant_id, scope.space_id, scope.project_id, bindingId, callControlId, now).run();
  return result.meta.changes === 1;
}

/** Revoke a granted, unused media ticket when local admission or the installed handler is not ready. */
export async function revokeTelnyxExtensionStreamConsent(db: D1Database, sessionId: string,
  now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const result = await db.prepare(`UPDATE assistant_telnyx_extension_stream_sessions
    SET consent_state='revoked',state='ended',media_ticket_sha256=NULL,ticket_expires_at=NULL,updated_at=?
    WHERE session_id=? AND state='ready' AND consent_state='granted' AND ticket_claimed_at IS NULL`)
    .bind(now, sessionId).run();
  return result.meta.changes === 1;
}

/** Atomically consumes the opaque ticket after rechecking the active line, call and published handler pin. */
export async function claimTelnyxExtensionStreamTicket(db: D1Database, bindingId: string, ticket: string,
  now = Math.floor(Date.now() / 1000)): Promise<ClaimedExtensionStreamSession | null> {
  if (!/^[A-Za-z0-9_-]{40,48}$/.test(ticket) || !/^[A-Za-z0-9._:-]{1,160}$/.test(bindingId)) return null;
  const ticketHash = await sha256(ticket);
  const claimed = await db.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET state='claimed',
      ticket_claimed_at=?,updated_at=?
    WHERE binding_id=? AND media_ticket_sha256=? AND state='ready' AND consent_state='granted'
      AND ticket_expires_at>? AND expires_at>? AND EXISTS (
        SELECT 1 FROM assistant_telnyx_extension_calls c
        JOIN assistant_phone_extension_handlers h ON h.binding_id=c.binding_id
        WHERE c.call_control_id=assistant_telnyx_extension_stream_sessions.call_control_id
          AND c.binding_id=assistant_telnyx_extension_stream_sessions.binding_id AND c.settings_pinned=1
          AND c.extension_installation_id=assistant_telnyx_extension_stream_sessions.extension_installation_id
          AND c.handler_sha256=assistant_telnyx_extension_stream_sessions.handler_sha256
          AND c.settings_revision IS assistant_telnyx_extension_stream_sessions.settings_revision
          AND c.state IN ('answering','processing','gathering') AND c.expires_at>?
          AND h.status='active' AND h.installation_id=c.extension_installation_id AND h.handler_sha256=c.handler_sha256)
      AND EXISTS (SELECT 1 FROM assistant_phone_bindings b JOIN assistant_communication_identities i ON i.id=b.identity_id
        WHERE b.id=assistant_telnyx_extension_stream_sessions.binding_id AND b.provider='telnyx' AND b.payer='byo'
          AND b.purpose='extension' AND b.status='active' AND i.status='active'
          AND i.tenant_id=assistant_telnyx_extension_stream_sessions.tenant_id
          AND i.space_id=assistant_telnyx_extension_stream_sessions.space_id
          AND i.project_id IS assistant_telnyx_extension_stream_sessions.project_id)`)
    .bind(now, now, bindingId, ticketHash, now, now, now).run();
  if (claimed.meta.changes !== 1) return null;
  const session = await db.prepare(`SELECT session_id,call_ref,tenant_id,space_id,project_id,binding_id,call_control_id,
      extension_installation_id,handler_sha256,settings_revision,expires_at,ticket_claimed_at
    FROM assistant_telnyx_extension_stream_sessions WHERE binding_id=? AND media_ticket_sha256=?
      AND state='claimed' AND ticket_claimed_at=? LIMIT 1`)
    .bind(bindingId, ticketHash, now).first<Record<string, unknown>>();
  if (!session || typeof session.session_id !== "string" || typeof session.call_ref !== "string"
    || typeof session.tenant_id !== "string" || typeof session.space_id !== "string"
    || typeof session.binding_id !== "string" || typeof session.call_control_id !== "string"
    || typeof session.extension_installation_id !== "string" || typeof session.handler_sha256 !== "string"
    || typeof session.expires_at !== "number" || typeof session.ticket_claimed_at !== "number"
    || !(session.project_id === null || typeof session.project_id === "string")
    || !(session.settings_revision === null || typeof session.settings_revision === "number")) return null;
  return { sessionId: session.session_id, callRef: session.call_ref, tenantId: session.tenant_id,
    spaceId: session.space_id, projectId: session.project_id as string | null, bindingId: session.binding_id,
    callControlId: session.call_control_id, installationId: session.extension_installation_id,
    handlerSha256: session.handler_sha256, settingsRevision: session.settings_revision as number | null,
    expiresAt: session.expires_at, ticketClaimedAt: session.ticket_claimed_at };
}

/** Recheck the complete installed-code, active-call, line and tenant pin when Telnyx sends its
 *  websocket `start` frame. Ticket admission alone may have happened before a revocation. */
export async function isTelnyxExtensionStreamSessionCurrent(db: D1Database, session: ClaimedExtensionStreamSession,
  now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS ok FROM assistant_telnyx_extension_stream_sessions s
    JOIN assistant_telnyx_extension_calls c ON c.call_control_id=s.call_control_id AND c.binding_id=s.binding_id
    JOIN assistant_phone_extension_handlers h ON h.binding_id=c.binding_id
    JOIN assistant_phone_bindings b ON b.id=s.binding_id
    JOIN assistant_communication_identities i ON i.id=b.identity_id
    WHERE s.session_id=? AND s.state IN ('claimed','active') AND s.consent_state='granted' AND s.expires_at>?
      AND c.state IN ('answering','processing','gathering') AND c.expires_at>?
      AND c.settings_pinned=1 AND c.extension_installation_id=s.extension_installation_id
      AND c.handler_sha256=s.handler_sha256 AND c.settings_revision IS s.settings_revision
      AND h.status='active' AND h.installation_id=c.extension_installation_id AND h.handler_sha256=c.handler_sha256
      AND b.provider='telnyx' AND b.payer='byo' AND b.purpose='extension' AND b.status='active'
      AND json_extract(b.policy_json,'$.allowTelnyxExtensionVoice')=1
      AND i.status='active' AND i.tenant_id=s.tenant_id AND i.space_id=s.space_id AND i.project_id IS s.project_id`)
    .bind(session.sessionId, now, now).first<{ ok: number }>();
  return row?.ok === 1;
}

/** Promote the one-use ticket claim only after the provider start frame and full call pin pass. */
export async function activateTelnyxExtensionStreamSession(db: D1Database, session: ClaimedExtensionStreamSession,
  now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const result = await db.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET state='active',updated_at=?
    WHERE session_id=? AND state='claimed' AND consent_state='granted' AND expires_at>?
      AND EXISTS (
        SELECT 1 FROM assistant_telnyx_extension_calls c
        JOIN assistant_phone_extension_handlers h ON h.binding_id=c.binding_id
        JOIN assistant_phone_bindings b ON b.id=c.binding_id
        JOIN assistant_communication_identities i ON i.id=b.identity_id
        WHERE c.call_control_id=assistant_telnyx_extension_stream_sessions.call_control_id
          AND c.binding_id=assistant_telnyx_extension_stream_sessions.binding_id AND c.settings_pinned=1
          AND c.extension_installation_id=assistant_telnyx_extension_stream_sessions.extension_installation_id
          AND c.handler_sha256=assistant_telnyx_extension_stream_sessions.handler_sha256
          AND c.settings_revision IS assistant_telnyx_extension_stream_sessions.settings_revision
          AND c.state IN ('processing','gathering') AND c.expires_at>?
          AND h.status='active' AND h.installation_id=c.extension_installation_id AND h.handler_sha256=c.handler_sha256
          AND b.provider='telnyx' AND b.payer='byo' AND b.purpose='extension' AND b.status='active'
          AND json_extract(b.policy_json,'$.allowTelnyxExtensionVoice')=1
          AND i.status='active' AND i.tenant_id=assistant_telnyx_extension_stream_sessions.tenant_id
          AND i.space_id=assistant_telnyx_extension_stream_sessions.space_id
          AND i.project_id IS assistant_telnyx_extension_stream_sessions.project_id)`)
    .bind(now, session.sessionId, now, now).run();
  return result.meta.changes === 1;
}

/** Accept only the next final-transcript sequence for a live, still-authorized call. */
export async function advanceTelnyxExtensionTranscriptSequence(db: D1Database,
  session: ClaimedExtensionStreamSession, sequence: number, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 1_000_000) return false;
  const result = await db.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET last_transcript_sequence=?,updated_at=?
    WHERE session_id=? AND state='active' AND consent_state='granted' AND expires_at>?
      AND last_transcript_sequence+1=?
      AND EXISTS (
        SELECT 1 FROM assistant_telnyx_extension_calls c
        JOIN assistant_phone_extension_handlers h ON h.binding_id=c.binding_id
        JOIN assistant_phone_bindings b ON b.id=c.binding_id
        JOIN assistant_communication_identities i ON i.id=b.identity_id
        WHERE c.call_control_id=assistant_telnyx_extension_stream_sessions.call_control_id
          AND c.binding_id=assistant_telnyx_extension_stream_sessions.binding_id AND c.settings_pinned=1
          AND c.extension_installation_id=assistant_telnyx_extension_stream_sessions.extension_installation_id
          AND c.handler_sha256=assistant_telnyx_extension_stream_sessions.handler_sha256
          AND c.settings_revision IS assistant_telnyx_extension_stream_sessions.settings_revision
          AND c.state IN ('processing','gathering') AND c.expires_at>?
          AND h.status='active' AND h.installation_id=c.extension_installation_id AND h.handler_sha256=c.handler_sha256
          AND b.provider='telnyx' AND b.payer='byo' AND b.purpose='extension' AND b.status='active'
          AND json_extract(b.policy_json,'$.allowTelnyxExtensionVoice')=1
          AND i.status='active' AND i.tenant_id=assistant_telnyx_extension_stream_sessions.tenant_id
          AND i.space_id=assistant_telnyx_extension_stream_sessions.space_id
          AND i.project_id IS assistant_telnyx_extension_stream_sessions.project_id)`)
    .bind(sequence, now, session.sessionId, now, sequence, now).run();
  return result.meta.changes === 1;
}

export async function endTelnyxExtensionStreamSession(db: D1Database, sessionId: string,
  now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET state='ended',updated_at=?
    WHERE session_id=? AND state IN ('claimed','active')`).bind(now, sessionId).run();
}

export async function markTelnyxExtensionStreamIndeterminate(db: D1Database, sessionId: string,
  now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET state='indeterminate',updated_at=?
    WHERE session_id=? AND state IN ('claimed','active')`).bind(now, sessionId).run();
}
