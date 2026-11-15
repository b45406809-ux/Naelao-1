import { describe, expect, it } from "vitest";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity } from "./core.js";
import {
  claimTelnyxExtensionStreamTicket, createTelnyxExtensionStreamSession,
  denyTelnyxExtensionStreamConsent, grantTelnyxExtensionStreamConsent,
} from "./telnyx-extension-stream-session.js";

async function admittedCall() {
  const f = fixture();
  const identity = await ensureIdentity(f.env, scope);
  await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,
      provider_number_sid,phone_number,policy_json,status)
    VALUES('stream-line',?,'extension','byo','telnyx','account','12345','+14155550100','{}','active')`)
    .bind(identity.id).run();
  await f.db.prepare(`INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status)
    VALUES('stream-line','install-1',?,'active')`).bind("a".repeat(64)).run();
  const now = Math.floor(Date.now() / 1000);
  const callControlId = "call-control-1";
  await f.db.prepare(`INSERT INTO assistant_telnyx_extension_calls(call_control_id,binding_id,caller,state,turn_count,
      started_at,expires_at,created_at,updated_at,extension_installation_id,handler_sha256,settings_revision,settings_pinned)
    VALUES(?,'stream-line','+14155550101','processing',0,?,?,?,?,?, ?,7,1)`)
    .bind(callControlId, now, now + 120, now, now, "install-1", "a".repeat(64)).run();
  const pin = { tenantId: scope.tenantId, spaceId: scope.spaceId, projectId: null, bindingId: "stream-line",
    callControlId, installationId: "install-1", handlerSha256: "a".repeat(64), settingsRevision: 7, expiresAt: now + 120 };
  return { f, pin, now };
}

describe("Telnyx extension stream session tickets", () => {
  it("requires explicit consent, stores only a ticket hash, and consumes the ticket once", async () => {
    const { f, pin, now } = await admittedCall();
    const session = await createTelnyxExtensionStreamSession(f.env.PLATFORM_DB, pin, now);
    expect(await f.db.prepare("SELECT consent_state,state,media_ticket_sha256 FROM assistant_telnyx_extension_stream_sessions WHERE session_id=?")
      .bind(session.sessionId).first()).toEqual({ consent_state: "pending", state: "consent_pending", media_ticket_sha256: null });
    expect(await claimTelnyxExtensionStreamTicket(f.env.PLATFORM_DB, pin.bindingId, "A".repeat(43), now)).toBeNull();

    const ticket = await grantTelnyxExtensionStreamConsent(f.env.PLATFORM_DB, pin, session.sessionId, now);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{40,48}$/);
    const stored = await f.db.prepare("SELECT consent_state,state,media_ticket_sha256,ticket_expires_at FROM assistant_telnyx_extension_stream_sessions WHERE session_id=?")
      .bind(session.sessionId).first<{ consent_state: string; state: string; media_ticket_sha256: string; ticket_expires_at: number }>();
    expect(stored).toMatchObject({ consent_state: "granted", state: "ready", ticket_expires_at: now + 60 });
    expect(stored?.media_ticket_sha256).not.toBe(ticket);

    expect(await claimTelnyxExtensionStreamTicket(f.env.PLATFORM_DB, "another-line", ticket, now)).toBeNull();
    await expect(claimTelnyxExtensionStreamTicket(f.env.PLATFORM_DB, pin.bindingId, ticket, now)).resolves.toMatchObject({
      tenantId: scope.tenantId, spaceId: scope.spaceId, bindingId: pin.bindingId, callControlId: pin.callControlId,
      installationId: pin.installationId, handlerSha256: pin.handlerSha256, settingsRevision: 7,
      sessionId: session.sessionId, callRef: session.callRef,
    });
    expect(await claimTelnyxExtensionStreamTicket(f.env.PLATFORM_DB, pin.bindingId, ticket, now)).toBeNull();
  });

  it("rejects a stale handler pin, expired ticket and denied consent", async () => {
    const { f, pin, now } = await admittedCall();
    const stale = await createTelnyxExtensionStreamSession(f.env.PLATFORM_DB, pin, now);
    await f.db.prepare("UPDATE assistant_phone_extension_handlers SET handler_sha256=? WHERE binding_id=?")
      .bind("b".repeat(64), pin.bindingId).run();
    await expect(grantTelnyxExtensionStreamConsent(f.env.PLATFORM_DB, pin, stale.sessionId, now))
      .rejects.toThrow("telnyx_extension_stream_consent_rejected");
    expect(await denyTelnyxExtensionStreamConsent(f.env.PLATFORM_DB, {
      tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: null,
    }, pin.bindingId, pin.callControlId, now)).toBe(true);
    expect(await f.db.prepare("SELECT consent_state,state,media_ticket_sha256 FROM assistant_telnyx_extension_stream_sessions WHERE session_id=?")
      .bind(stale.sessionId).first()).toEqual({ consent_state: "denied", state: "ended", media_ticket_sha256: null });

    await f.db.prepare(`INSERT INTO assistant_telnyx_extension_calls(call_control_id,binding_id,caller,state,turn_count,
        started_at,expires_at,created_at,updated_at,extension_installation_id,handler_sha256,settings_revision,settings_pinned)
      VALUES(?,'stream-line','+14155550101','processing',0,?,?,?,?,?, ?,7,1)`)
      .bind("call-control-2", now, now + 120, now, now, "install-1", "b".repeat(64)).run();
    const secondPin = { ...pin, callControlId: "call-control-2", handlerSha256: "b".repeat(64) };
    const second = await createTelnyxExtensionStreamSession(f.env.PLATFORM_DB, secondPin, now);
    const ticket = await grantTelnyxExtensionStreamConsent(f.env.PLATFORM_DB, secondPin, second.sessionId, now);
    expect(await claimTelnyxExtensionStreamTicket(f.env.PLATFORM_DB, pin.bindingId, ticket, now + 61)).toBeNull();
  });

  it("does not create a session for mismatched scope or an unpinned call", async () => {
    const { f, pin, now } = await admittedCall();
    await expect(createTelnyxExtensionStreamSession(f.env.PLATFORM_DB, { ...pin, tenantId: "other-tenant" }, now))
      .rejects.toThrow("telnyx_extension_stream_admission_not_found");
    await f.db.prepare("UPDATE assistant_telnyx_extension_calls SET settings_pinned=0 WHERE call_control_id=?")
      .bind(pin.callControlId).run();
    await expect(createTelnyxExtensionStreamSession(f.env.PLATFORM_DB, pin, now))
      .rejects.toThrow("telnyx_extension_stream_admission_not_found");
  });
});
