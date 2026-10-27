import type { Hono } from "hono";
import { mintInternalToken, readBoundedRequestText, readBoundedResponseJson } from "@naelao/http";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import type { AgentsEnv } from "../index.js";
import { authenticatedTelnyxEvent } from "../voice/telnyx-telephony.js";
import { isE164 } from "../voice/twilio-telephony.js";
import { channelPreferences, scopeAccess, storeBody, type CommunicationIdentity, type CommunicationScope } from "./core.js";
import { resolveTelnyxAccount } from "./telnyx-account.js";
import { claimTelnyxIngress, finishTelnyxIngress } from "./telnyx-ingress-journal.js";
import { validatePhonePolicy, type AssistantPhoneBinding } from "./phones.js";

/** Caller ID is data and never grants access to an internal assistant. Owner assistant
 * calls have their own admission path. */
export function registerTelnyxWebhook(app: Hono<{ Bindings: AgentsEnv }>) {
  app.post("/assistant-phone/telnyx/:bindingId", async c => {
    const id = c.req.param("bindingId");
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) return c.json({ error_code: "not_found" }, 404);
    const binding = await c.env.PLATFORM_DB.prepare("SELECT * FROM assistant_phone_bindings WHERE id=? AND provider='telnyx' AND purpose IN ('assistant','extension') AND status='active'")
      .bind(id).first<AssistantPhoneBinding>();
    if (!binding) return c.json({ error_code: "not_found" }, 404);
    const identity = await c.env.PLATFORM_DB.prepare("SELECT * FROM assistant_communication_identities WHERE id=? AND status='active'")
      .bind(binding.identity_id).first<CommunicationIdentity>();
    if (!identity) return c.json({ error_code: "not_found" }, 404);
    let account;
    try { account = await resolveTelnyxAccount(c.env, identity); } catch { return c.json({ error_code: "carrier_credentials_unavailable" }, 503); }
    if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number)
      return c.json({ error_code: "carrier_binding_mismatch" }, 403);
    let raw: string;
    try { raw = await readBoundedRequestText(c.req.raw, 256 * 1024); } catch { return c.json({ error_code: "payload_too_large" }, 413); }
    let event;
    try { event = await authenticatedTelnyxEvent({ rawBody: raw, publicKey: account.publicKey,
      signature: c.req.header("telnyx-signature-ed25519") ?? null, timestamp: c.req.header("telnyx-timestamp") ?? null }); }
    catch { return c.json({ error_code: "invalid_webhook" }, 401); }
    if (event.eventType !== "message.received") return c.json({ error_code: "event_not_supported" }, 422);
    const payload = event.payload, from = (payload.from as { phone_number?: unknown } | undefined)?.phone_number;
    const destinations = Array.isArray(payload.to) ? payload.to as Array<{ phone_number?: unknown }> : [];
    if (payload.direction !== "inbound" || typeof from !== "string" || !isE164(from)
      || destinations.length !== 1 || destinations[0]?.phone_number !== binding.phone_number
      || typeof payload.text !== "string" || payload.text.length > 16000
      || (payload.media !== undefined && (!Array.isArray(payload.media) || payload.media.length !== 0)))
      return c.json({ error_code: "unsupported_message" }, 422);
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
      const quota = await c.env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_ingress_usage(binding_id,day,messages) VALUES(?,date('now'),1) ON CONFLICT(binding_id,day) DO UPDATE SET messages=messages+1 WHERE messages<?")
        .bind(id, policy.maxDailyInboundMessages).run();
      if (!quota.meta.changes) throw new Error("phone_daily_limit");
      const eventId = `telnyx-${event.eventId}`;
      const verification = binding.purpose === "assistant" && policy.allowWebsiteVerification
        ? await (await import("./verification.js")).receiveSmsVerification(c.env, identity, id, from, payload.text, eventId)
        : null;
      const privateCode = binding.purpose === "assistant" && (verification !== null ||
        (/\b(?:code|pin|passcode|otp|verification)\b/i.test(payload.text) && /(?<!\d)\d{4,8}(?!\d)/.test(payload.text)));
      const bodyKey = await storeBody(c.env, identity, eventId, { text: privateCode ? "[private account verification message]" : payload.text,
        ...(privateCode ? { private_text: payload.text, private_actor_id: verification?.actorId ?? identity.owner_user_id } : {}), untrusted: true });
      await c.env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_events(id,binding_id,kind,sender,status,body_key) VALUES(?,?,'sms',?,'received',?)")
        .bind(eventId, id, from, bodyKey).run();
      if (binding.purpose === "assistant") {
        // A paired number creates a pending command. It never authenticates a command by itself.
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
        // A reply is held as an explicit draft until Telnyx send/billing reconciliation is wired.
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
  });
}
