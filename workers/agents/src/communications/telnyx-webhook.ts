import type { Context, Hono } from "hono";
import { mintInternalToken, readBoundedRequestText, readBoundedResponseJson } from "@naelao/http";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import type { AgentsEnv } from "../index.js";
import { authenticatedTelnyxEvent } from "../voice/telnyx-telephony.js";
import { isE164 } from "../voice/twilio-telephony.js";
import { channelPreferences, scopeAccess, storeBody, type CommunicationIdentity, type CommunicationScope } from "./core.js";
import { resolveTelnyxAccount } from "./telnyx-account.js";
import { claimTelnyxIngress, finishTelnyxIngress } from "./telnyx-ingress-journal.js";
import { validatePhonePolicy, type AssistantPhoneBinding } from "./phones.js";
import { dispatchTelnyxVoiceEvent } from "./telnyx-live-calls.js";
import { managedMessageReservationId, managedSmsCreditsPerSegment, managedSmsSegments, reserveManagedCarrierCredits } from "./managed-carrier-billing.js";

type TelnyxEvent = Awaited<ReturnType<typeof authenticatedTelnyxEvent>>;
type WebhookContext = Context<{ Bindings: AgentsEnv }>;
function targetNumber(event: TelnyxEvent): string | null {
  const raw = event.payload.to;
  if (typeof raw === "string") return isE164(raw) ? raw : null;
  const destinations = Array.isArray(raw) ? raw : [];
  if (destinations.length !== 1) return null;
  const value = destinations[0] as { phone_number?: unknown } | null;
  return typeof value?.phone_number === "string" && isE164(value.phone_number) ? value.phone_number : null;
}

/** Both shared managed carrier callbacks and owner-entered BYO callbacks converge here, after
 * their different webhook authentication and number-to-binding lookup paths. */
async function dispatchEvent(c: WebhookContext, binding: AssistantPhoneBinding, identity: CommunicationIdentity,
  event: TelnyxEvent, raw: string) {
  const id = binding.id;
  if (event.eventType.startsWith("call.") || event.eventType.startsWith("streaming.")) {
    let claim;
    try { claim = await claimTelnyxIngress(c.env.PLATFORM_DB, id, event.eventId, raw); }
    catch { return c.json({ error_code: "event_conflict_or_storage_unavailable" }, 409); }
    if (!claim.acquired) return claim.state === "completed" ? c.json({ accepted: true, duplicate: true }) : c.json({ error_code: "event_reconciliation_required" }, 409);
    try {
      await dispatchTelnyxVoiceEvent(c.env, binding, identity, event);
      await finishTelnyxIngress(c.env.PLATFORM_DB, id, event.eventId, "completed");
      return c.json({ accepted: true });
    } catch {
      await finishTelnyxIngress(c.env.PLATFORM_DB, id, event.eventId, "indeterminate").catch(() => undefined);
      return c.json({ error_code: "call_event_reconciliation_required" }, 503);
    }
  }
  if (event.eventType !== "message.received") return c.json({ error_code: "event_not_supported" }, 422);
  const payload = event.payload;
  const from = (payload.from as { phone_number?: unknown } | undefined)?.phone_number;
  if (payload.direction !== "inbound" || typeof from !== "string" || !isE164(from) || targetNumber(event) !== binding.phone_number
    || typeof payload.text !== "string" || payload.text.length > 16000
    || (payload.media !== undefined && (!Array.isArray(payload.media) || payload.media.length !== 0))) return c.json({ error_code: "unsupported_message" }, 422);
  const scope: CommunicationScope = { tenantId: identity.tenant_id, spaceId: identity.space_id, userId: identity.owner_user_id,
    role: "product_end_user", ...(identity.project_id ? { projectId: identity.project_id } : {}) };
  if (!await scopeAccess(c.env, scope, true) || !(await channelPreferences(c.env, scope)).enabled.phone
    || await isSpaceNetworkEgressDenied(c.env.PLATFORM_DB, identity.space_id)) return c.json({ error_code: "phone_unavailable" }, 403);
  if (binding.purpose === "extension") {
    const handler = await c.env.PLATFORM_DB.prepare("SELECT binding_id FROM assistant_phone_extension_handlers WHERE binding_id=? AND status='active'").bind(id).first();
    if (!handler) return c.json({ error_code: "handler_unavailable" }, 503);
  }
  let claim;
  try { claim = await claimTelnyxIngress(c.env.PLATFORM_DB, id, event.eventId, raw); }
  catch { return c.json({ error_code: "event_conflict_or_storage_unavailable" }, 409); }
  if (!claim.acquired) return claim.state === "completed" ? c.json({ accepted: true, duplicate: true }) : c.json({ error_code: "event_reconciliation_required" }, 409);
  try {
    const policy = validatePhonePolicy(JSON.parse(binding.policy_json));
    if (binding.payer === "managed") {
      const providerMessageId = payload.id;
      if (typeof providerMessageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(providerMessageId)) throw new Error("telnyx_message_id_invalid");
      const reservationId = await managedMessageReservationId(binding.id, providerMessageId);
      const reservedCredits = managedSmsCreditsPerSegment(c.env) * managedSmsSegments(payload.text);
      await reserveManagedCarrierCredits(c.env, scope, reservationId, reservedCredits, `managed-phone:${binding.id}`);
      const receivedAt = Math.floor(Date.now() / 1000);
      await c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_managed_telnyx_message_costs(provider_message_id,binding_id,direction,sender,carrier_reservation_id,reserved_credits,status,next_at,created_at,updated_at) VALUES(?,?,'inbound',?,?,?,'pending',?,?,?)")
        .bind(providerMessageId, binding.id, from, reservationId, reservedCredits, receivedAt, receivedAt, receivedAt).run();
      const costRow = await c.env.PLATFORM_DB.prepare("SELECT binding_id,sender,carrier_reservation_id,reserved_credits FROM assistant_managed_telnyx_message_costs WHERE provider_message_id=?")
        .bind(providerMessageId).first<{ binding_id: string; sender: string; carrier_reservation_id: string; reserved_credits: number }>();
      if (!costRow || costRow.binding_id !== binding.id || costRow.sender !== from || costRow.carrier_reservation_id !== reservationId || costRow.reserved_credits !== reservedCredits)
        throw new Error("managed_telnyx_message_receipt_conflict");
    }
    const quota = await c.env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_ingress_usage(binding_id,day,messages) VALUES(?,date('now'),1) ON CONFLICT(binding_id,day) DO UPDATE SET messages=messages+1 WHERE messages<?")
      .bind(id, policy.maxDailyInboundMessages).run();
    if (!quota.meta.changes) throw new Error("phone_daily_limit");
    const eventId = `telnyx-${event.eventId}`;
    const verification = binding.purpose === "assistant" && policy.allowWebsiteVerification
      ? await (await import("./verification.js")).receiveSmsVerification(c.env, identity, id, from, payload.text, eventId) : null;
    const privateCode = binding.purpose === "assistant" && (verification !== null ||
      (/\b(?:code|pin|passcode|otp|verification)\b/i.test(payload.text) && /(?<!\d)\d{4,8}(?!\d)/.test(payload.text)));
    const bodyKey = await storeBody(c.env, identity, eventId, { text: privateCode ? "[private account verification message]" : payload.text,
      ...(privateCode ? { private_text: payload.text, private_actor_id: verification?.actorId ?? identity.owner_user_id } : {}), untrusted: true });
    await c.env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_events(id,binding_id,kind,sender,status,body_key) VALUES(?,?,'sms',?,'received',?)")
      .bind(eventId, id, from, bodyKey).run();
    if (binding.purpose === "assistant") {
      const controller = await c.env.PLATFORM_DB.prepare("SELECT user_id FROM assistant_communication_controllers WHERE identity_id=? AND channel='phone' AND address=? AND status='active'")
        .bind(identity.id, from).first<{ user_id: string }>();
      if (controller && !privateCode) {
        await c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_communication_messages(id,identity_id,provider_message_id,direction,channel,sender,recipient,status,body_key) VALUES(?,?,?,'inbound','sms',?,?,'received',?)")
          .bind(eventId, identity.id, eventId, from, binding.phone_number, bodyKey).run();
        await c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_communication_commands(id,identity_id,message_id,controller_user_id) VALUES(?,?,?,?)")
          .bind(`cmd_${eventId}`, identity.id, eventId, controller.user_id).run();
      }
      await finishTelnyxIngress(c.env.PLATFORM_DB, id, event.eventId, "completed");
      return c.json({ accepted: true });
    }
    const dispatched = await c.env.AGENTS_WORKER.fetch(new Request("http://agents/internal/phone-extension-dispatch", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenant_id) },
      body: JSON.stringify({ spaceId: identity.space_id, bindingId: id, event: { id: eventId, type: "message.received", payload: { caller: from, text: payload.text, media: [] } } }) }));
    if (!dispatched.ok) throw new Error("extension_dispatch_unknown");
    const result = await readBoundedResponseJson<{ message?: unknown }>(dispatched, 8192);
    const reply = typeof result.message === "string" ? result.message.trim().slice(0, 1600) : "";
    if (reply) {
      const draftId = `telnyx-reply-${event.eventId}`;
      const key = await storeBody(c.env, identity, draftId, { text: reply, dtmf: "" });
      await c.env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_actions(id,binding_id,actor_id,kind,recipient,body_key,status) VALUES(?,?,?,'sms',?,?,'draft')")
        .bind(draftId, id, identity.owner_user_id, from, key).run();
    }
    await c.env.PLATFORM_DB.prepare("UPDATE assistant_phone_events SET status=? WHERE id=? AND binding_id=?")
      .bind(reply ? "reply_draft" : "extension_no_reply", eventId, id).run();
    await finishTelnyxIngress(c.env.PLATFORM_DB, id, event.eventId, "completed");
    return c.json({ accepted: true });
  } catch {
    await finishTelnyxIngress(c.env.PLATFORM_DB, id, event.eventId, "indeterminate").catch(() => undefined);
    return c.json({ error_code: "event_reconciliation_required" }, 503);
  }
}

/** Caller ID is data and never grants access to an internal assistant. Owner assistant
 * calls have their own admission path. */
export function registerTelnyxWebhook(app: Hono<{ Bindings: AgentsEnv }>) {
  app.post("/assistant-phone/telnyx/:bindingId", async c => {
    const id = c.req.param("bindingId");
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) return c.json({ error_code: "not_found" }, 404);
    const binding = await c.env.PLATFORM_DB.prepare("SELECT * FROM assistant_phone_bindings WHERE id=? AND provider='telnyx' AND payer='byo' AND purpose IN ('assistant','extension') AND status='active'")
      .bind(id).first<AssistantPhoneBinding>();
    if (!binding) return c.json({ error_code: "not_found" }, 404);
    const identity = await c.env.PLATFORM_DB.prepare("SELECT * FROM assistant_communication_identities WHERE id=? AND status='active'")
      .bind(binding.identity_id).first<CommunicationIdentity>();
    if (!identity) return c.json({ error_code: "not_found" }, 404);
    let account;
    try { account = await resolveTelnyxAccount(c.env, identity, binding); } catch { return c.json({ error_code: "carrier_credentials_unavailable" }, 503); }
    if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number)
      return c.json({ error_code: "carrier_binding_mismatch" }, 403);
    let raw: string;
    try { raw = await readBoundedRequestText(c.req.raw, 256 * 1024); } catch { return c.json({ error_code: "payload_too_large" }, 413); }
    let event: TelnyxEvent;
    try { event = await authenticatedTelnyxEvent({ rawBody: raw, publicKey: account.publicKey, signature: c.req.header("telnyx-signature-ed25519") ?? null,
      timestamp: c.req.header("telnyx-timestamp") ?? null }); }
    catch { return c.json({ error_code: "invalid_webhook" }, 401); }
    return dispatchEvent(c, binding, identity, event, raw);
  });

  // Managed numbers share Naelao-owned callback profiles. Resolve the line only after validating
  // the platform account's signature, then scope every event back to its managed binding.
  app.post("/assistant-phone/telnyx-managed", async c => {
    if (!c.env.TELNYX_MANAGED_API_KEY || !c.env.TELNYX_MANAGED_PUBLIC_KEY) return c.json({ error_code: "carrier_unavailable" }, 503);
    let raw: string;
    try { raw = await readBoundedRequestText(c.req.raw, 256 * 1024); } catch { return c.json({ error_code: "payload_too_large" }, 413); }
    let event: TelnyxEvent;
    try { event = await authenticatedTelnyxEvent({ rawBody: raw, publicKey: c.env.TELNYX_MANAGED_PUBLIC_KEY,
      signature: c.req.header("telnyx-signature-ed25519") ?? null, timestamp: c.req.header("telnyx-timestamp") ?? null }); }
    catch { return c.json({ error_code: "invalid_webhook" }, 401); }
    const isCallEvent = event.eventType.startsWith("call.") || event.eventType.startsWith("streaming.");
    const callControlId = event.payload.call_control_id;
    const number = targetNumber(event);
    let binding: AssistantPhoneBinding | null = null;
    if (isCallEvent && typeof callControlId === "string" && /^[A-Za-z0-9_+=/-]{1,500}$/.test(callControlId)) {
      binding = await c.env.PLATFORM_DB.prepare(`SELECT b.* FROM assistant_telnyx_live_calls tc
        JOIN assistant_phone_bindings b ON b.id=tc.binding_id
        WHERE tc.call_control_id=? AND b.provider='telnyx' AND b.payer='managed'
          AND b.status IN ('active','billing_hold','indeterminate') LIMIT 1`)
        .bind(callControlId).first<AssistantPhoneBinding>();
    }
    if (!binding && number) binding = await c.env.PLATFORM_DB.prepare("SELECT * FROM assistant_phone_bindings WHERE provider='telnyx' AND payer='managed' AND phone_number=? AND status='active'")
      .bind(number).first<AssistantPhoneBinding>();
    if (!binding) return c.json({ error_code: isCallEvent ? "call_binding_not_found" : "unsupported_message" }, 404);
    if (!binding) return c.json({ error_code: "not_found" }, 404);
    const identity = await c.env.PLATFORM_DB.prepare("SELECT * FROM assistant_communication_identities WHERE id=? AND status='active'")
      .bind(binding.identity_id).first<CommunicationIdentity>();
    if (!identity) return c.json({ error_code: "not_found" }, 404);
    const account = await resolveTelnyxAccount(c.env, identity, binding);
    if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number)
      return c.json({ error_code: "carrier_binding_mismatch" }, 403);
    return dispatchEvent(c, binding, identity, event, raw);
  });
}
