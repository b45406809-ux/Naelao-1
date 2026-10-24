import type { Hono } from "hono";
import { TwilioAdapter } from "@cloudflare/voice-twilio";
import { validateTwilioMediaStream } from "../voice/customer-telephony.js";
import { verifyOwnerVoiceTicket } from "../voice/voice-ticket.js";
import {
  claimLiveCall,
  liveCallAllowed,
  liveCallTicket,
  liveCodeHash,
  type LiveCall,
} from "./live-calls.js";
import {
  mintInternalToken,
  readBoundedResponseJson,
  readBoundedRequestText,
} from "@naelao/http";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import type { AgentsEnv } from "../index.js";
import { validateTwilioFormWebhook } from "../voice/customer-telephony.js";
import {
  channelPreferences,
  scopeAccess,
  storeBody,
  type CommunicationIdentity,
  type CommunicationScope,
} from "./core.js";
import { type AssistantPhoneBinding, validatePhonePolicy } from "./phones.js";
import {
  phonePublicOrigin,
  resolvePhoneCredentials,
  xml,
} from "./phone-provider.js";
const response = (body: string, status = 200) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
    {
      status,
      headers: {
        "content-type": "application/xml",
        "cache-control": "no-store",
      },
    }
  );
const reject = () => response("<Reject/>", 403);
const callId = /^CA[a-fA-F0-9]{32}$/;
const messageId = /^(?:SM|MM)[a-fA-F0-9]{32}$/;
async function liveStreamResponse(
  env: AgentsEnv,
  live: LiveCall
): Promise<Response> {
  const ticket = await liveCallTicket(env, live);
  const agentName =
    "phone-" +
    (await liveCodeHash(
      live.binding_id,
      JSON.stringify([live.tenant_id, live.user_id, live.session_id])
    ));
  const stream = new URL(
    `/assistant-phone/live-stream/${agentName}/${encodeURIComponent(ticket)}`,
    phonePublicOrigin(env)
  );
  stream.protocol = "wss:";
  return response(
    `<Connect><Stream url="${xml(stream.toString())}"/></Connect><Hangup/>`
  );
}
const caller = (s: string) => /^[+a-zA-Z0-9][+a-zA-Z0-9 ._-]{0,63}$/.test(s);
export function registerPhoneWebhooks(app: Hono<{ Bindings: AgentsEnv }>) {
  app.get("/assistant-phone/live-stream/:id/:ticket", async (c) => {
    const token = c.req.param("ticket"),
      id = c.req.param("id");
    const ticket = await verifyOwnerVoiceTicket(
      token,
      c.env.PLATFORM_SECRET,
      id
    );
    if (!ticket?.phoneBindingId || !ticket.callSid || new URL(c.req.url).search)
      return reject();
    const live = await c.env.PLATFORM_DB.prepare(
      "SELECT * FROM assistant_live_calls WHERE id=? AND binding_id=? AND call_sid=? AND tenant_id=? AND user_id=? AND status='connected' AND deadline>?"
    )
      .bind(
        ticket.nonce,
        ticket.phoneBindingId,
        ticket.callSid,
        ticket.tenantId,
        ticket.userId,
        Math.floor(Date.now() / 1000)
      )
      .first<LiveCall>();
    const binding = await c.env.PLATFORM_DB.prepare(
      "SELECT * FROM assistant_phone_bindings WHERE id=? AND status='active'"
    )
      .bind(ticket.phoneBindingId)
      .first<AssistantPhoneBinding>();
    const identity = binding
      ? await c.env.PLATFORM_DB.prepare(
          "SELECT * FROM assistant_communication_identities WHERE id=? AND status='active'"
        )
          .bind(binding.identity_id)
          .first<CommunicationIdentity>()
      : null;
    const credentials =
      identity && binding
        ? await resolvePhoneCredentials(c.env, identity, binding.payer)
        : null;
    const canonical = new URL(c.req.url);
    canonical.protocol = "wss:";
    canonical.host = new URL(phonePublicOrigin(c.env)).host;
    if (
      !live ||
      !identity ||
      !credentials ||
      credentials.accountSid !== binding?.provider_account_sid ||
      !(await liveCallAllowed(c.env, live)) ||
      !validateTwilioMediaStream({
        authToken: credentials.authToken,
        signature: c.req.header("x-twilio-signature") ?? null,
        canonicalUrl: canonical.toString(),
      })
    )
      return reject();
    const internal = new URL(c.req.url);
    internal.searchParams.set("ticket", token);
    return TwilioAdapter.handleRequest(
      new Request(internal, c.req.raw),
      c.env as unknown as Record<string, unknown>,
      "OWNER_VOICE_AGENT",
      { instanceName: id }
    );
  });
  app.post("/assistant-phone/twilio/:bindingId/:event", async (c) => {
    const event = c.req.param("event");
    if (
      ![
        "sms",
        "answer",
        "menu",
        "live-code",
        "voicemail",
        "transcript",
        "status",
      ].includes(event)
    )
      return reject();
    const binding = await c.env.PLATFORM_DB.prepare(
      "SELECT * FROM assistant_phone_bindings WHERE id=?"
    )
      .bind(c.req.param("bindingId"))
      .first<AssistantPhoneBinding>();
    if (!binding) return reject();
    const identity = await c.env.PLATFORM_DB.prepare(
      "SELECT * FROM assistant_communication_identities WHERE id=? AND status='active'"
    )
      .bind(binding.identity_id)
      .first<CommunicationIdentity>();
    if (!identity) return reject();
    const credentials = await resolvePhoneCredentials(
      c.env,
      identity,
      binding.payer
    );
    if (!credentials || credentials.accountSid !== binding.provider_account_sid)
      return reject();
    let raw: string;
    try {
      raw = await readBoundedRequestText(c.req.raw, 32768);
    } catch {
      return response("", 413);
    }
    const canonical = phonePublicOrigin(c.env) + new URL(c.req.url).pathname;
    if (
      new URL(c.req.url).search ||
      !validateTwilioFormWebhook({
        authToken: credentials.authToken,
        signature: c.req.header("x-twilio-signature") ?? null,
        canonicalUrl: canonical,
        rawBody: raw,
      })
    )
      return reject();
    const form = new URLSearchParams(raw);
    if (form.get("AccountSid") !== credentials.accountSid) return reject();
    // Final statuses may arrive after disable. They may only update known scoped records.
    if (event === "status") {
      const sid = form.get("MessageSid") ?? form.get("CallSid") ?? "";
      if (!callId.test(sid) && !messageId.test(sid)) return reject();
      const status = form.get("MessageStatus") ?? form.get("CallStatus") ?? "";
      if (
        ![
          "delivered",
          "undelivered",
          "failed",
          "completed",
          "busy",
          "no-answer",
          "canceled",
          "read",
        ].includes(status)
      )
        return response("");
      if (callId.test(sid))
        await c.env.PLATFORM_DB.prepare(
          "UPDATE assistant_live_calls SET status='ended' WHERE binding_id=? AND call_sid=? AND status='connected'"
        )
          .bind(binding.id, sid)
          .run();
      const row = await c.env.PLATFORM_DB.prepare(
        "SELECT id FROM assistant_phone_actions WHERE binding_id=? AND provider_sid=?"
      )
        .bind(binding.id, sid)
        .first<{ id: string }>();
      if (!row) return response("");
      // Receipts are separate from approval/send state. A late status cannot reopen a sent action.
      await c.env.PLATFORM_DB.prepare(
        "INSERT INTO assistant_phone_events(id,binding_id,kind,sender,status,action_id,duration_seconds) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING"
      )
        .bind(
          `${sid}:${status}`,
          binding.id,
          "delivery",
          binding.phone_number ?? "",
          status,
          row.id,
          /^\d{1,6}$/.test(form.get("CallDuration") ?? "")
            ? Number(form.get("CallDuration"))
            : null
        )
        .run();
      return response("");
    }
    const scope: CommunicationScope = {
      tenantId: identity.tenant_id,
      spaceId: identity.space_id,
      userId: identity.owner_user_id,
      role: "product_end_user",
      ...(identity.project_id ? { projectId: identity.project_id } : {}),
    };
    // Internal voice admission authenticates the actual member using an app-issued code.
    // A Project identity's original creator is not the principal of later members' calls.
    const privateVoice =
      binding.purpose !== "extension" &&
      ["answer", "live-code"].includes(event);
    if (
      binding.status !== "active" ||
      (!privateVoice && !(await scopeAccess(c.env, scope, true))) ||
      (!privateVoice &&
        !(await channelPreferences(c.env, scope)).enabled.phone) ||
      (await isSpaceNetworkEgressDenied(c.env.PLATFORM_DB, identity.space_id))
    )
      return reject();
    const policy = validatePhonePolicy(JSON.parse(binding.policy_json));
    const from = form.get("From") ?? "",
      to = form.get("To") ?? "",
      sid = form.get(event === "sms" ? "MessageSid" : "CallSid") ?? "";
    // Recording/transcription callbacks have fewer fields. Their CallSid must match admitted ingress.
    if (event === "voicemail" || event === "transcript") {
      if (!callId.test(sid) || !policy.voicemail) return reject();
      const admitted = await c.env.PLATFORM_DB.prepare(
        "SELECT id FROM assistant_phone_events WHERE id=? AND binding_id=? AND kind='call'"
      )
        .bind(sid, binding.id)
        .first();
      if (!admitted) return reject();
      const recording = form.get("RecordingSid") ?? "";
      if (!/^RE[a-fA-F0-9]{32}$/.test(recording)) return reject();
      const id = `${sid}:${event}`,
        existing = await c.env.PLATFORM_DB.prepare(
          "SELECT id FROM assistant_phone_events WHERE id=?"
        )
          .bind(id)
          .first();
      if (existing) return response("");
      const text =
        event === "transcript"
          ? (form.get("TranscriptionText") ?? "").slice(0, 16000)
          : "";
      const key = await storeBody(c.env, identity, id, {
        text,
        recording_sid: recording,
        untrusted: true,
      });
      await c.env.PLATFORM_DB.prepare(
        "INSERT OR IGNORE INTO assistant_phone_events(id,binding_id,kind,sender,status,body_key) VALUES(?,?,?,?,?,?)"
      )
        .bind(id, binding.id, event, "", "received", key)
        .run();
      return response(
        "<Say>Thank you. Your message has been saved.</Say><Hangup/>"
      );
    }
    if (
      to !== binding.phone_number ||
      !caller(from) ||
      !(event === "sms" ? messageId : callId).test(sid)
    )
      return reject();
    const root = `${phonePublicOrigin(c.env)}/assistant-phone/twilio/${binding.id}`;
    if (event === "answer") {
      const resumed = await c.env.PLATFORM_DB.prepare(
        "SELECT l.* FROM assistant_live_calls l JOIN assistant_phone_events e ON e.id=l.call_sid AND e.binding_id=l.binding_id WHERE l.binding_id=? AND l.call_sid=? AND e.sender=? AND l.status='connected' AND l.deadline>?"
      )
        .bind(binding.id, sid, from, Math.floor(Date.now() / 1000))
        .first<LiveCall>();
      if (resumed)
        return (await liveCallAllowed(c.env, resumed))
          ? liveStreamResponse(c.env, resumed)
          : reject();
    }
    // A short-lived, app-authorized live session takes precedence only while armed.
    // Public caller IDs never become an owner credential.
    const armed =
      event === "answer"
        ? await c.env.PLATFORM_DB.prepare(
            "SELECT id FROM assistant_live_calls WHERE binding_id=? AND status='armed' AND expires_at>?"
          )
            .bind(binding.id, Math.floor(Date.now() / 1000))
            .first()
        : null;
    if (armed || event === "live-code") {
      const admitted = await c.env.PLATFORM_DB.prepare(
        "SELECT id FROM assistant_phone_events WHERE id=? AND binding_id=? AND sender=? AND kind='call'"
      )
        .bind(sid, binding.id, from)
        .first();
      if (!admitted && event === "live-code") return reject();
      if (!admitted) {
        const quota = await c.env.PLATFORM_DB.prepare(
          "INSERT INTO assistant_phone_ingress_usage(binding_id,day,calls) VALUES(?,date('now'),1) ON CONFLICT(binding_id,day) DO UPDATE SET calls=calls+1 WHERE calls<?"
        )
          .bind(binding.id, policy.maxDailyInboundCalls)
          .run();
        if (!quota.meta.changes) return reject();
        await c.env.PLATFORM_DB.prepare(
          "INSERT OR IGNORE INTO assistant_phone_events(id,binding_id,kind,sender,status) VALUES(?,?,'call',?,'received')"
        )
          .bind(sid, binding.id, from)
          .run();
      }
      if (event === "answer")
        return response(
          `<Gather input="dtmf" numDigits="8" timeout="15" action="${xml(root + "/live-code")}" method="POST"><Say>Enter the one-time call code shown in Naelao.</Say></Gather><Hangup/>`
        );
      const live = await claimLiveCall(
        c.env,
        binding,
        sid,
        form.get("Digits") ?? "",
        policy.maxCallSeconds
      );
      if (!live || !(await liveCallAllowed(c.env, live))) return reject();
      return liveStreamResponse(c.env, live);
    }
    // Internal lines never become public customer entry points, even when no code is armed.
    if (
      (event === "answer" || event === "menu") &&
      binding.purpose !== "extension"
    )
      return reject();
    if (event === "sms" && binding.purpose === "extension") return reject();
    const configuredHandler = await c.env.PLATFORM_DB.prepare(
      "SELECT binding_id FROM assistant_phone_extension_handlers WHERE binding_id=?"
    )
      .bind(binding.id)
      .first();
    if ((event === "answer" || event === "menu") && !configuredHandler)
      return reject();
    if (event === "answer" || event === "menu") {
      const admitted = await c.env.PLATFORM_DB.prepare(
        "SELECT id FROM assistant_phone_events WHERE id=? AND binding_id=? AND sender=? AND kind='call'"
      )
        .bind(sid, binding.id, from)
        .first();
      if (event === "menu" && !admitted) return reject();
      if (event === "answer" && !admitted) {
        const quota = await c.env.PLATFORM_DB.prepare(
          "INSERT INTO assistant_phone_ingress_usage(binding_id,day,calls) VALUES(?,date('now'),1) ON CONFLICT(binding_id,day) DO UPDATE SET calls=calls+1 WHERE calls<?"
        )
          .bind(binding.id, policy.maxDailyInboundCalls)
          .run();
        if (!quota.meta.changes) return reject();
        await c.env.PLATFORM_DB.prepare(
          "INSERT OR IGNORE INTO assistant_phone_events(id,binding_id,kind,sender,status) VALUES(?,?,'call',?,'received')"
        )
          .bind(sid, binding.id, from)
          .run();
      }
      const digits = form.get("Digits") ?? "";
      if (event === "menu" && !/^[0-9]{1,8}$/.test(digits)) return reject();
      const dispatched = await c.env.AGENTS_WORKER.fetch(
        new Request("http://agents/internal/phone-extension-dispatch", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": identity.tenant_id,
            "x-naelao-internal-token": await mintInternalToken(
              c.env.PLATFORM_SECRET,
              identity.tenant_id
            ),
          },
          body: JSON.stringify({
            spaceId: identity.space_id,
            bindingId: binding.id,
            event: {
              id: sid + (digits ? ":" + digits : ""),
              type: event === "answer" ? "call.received" : "call.digits",
              payload: { caller: from, ...(digits ? { digits } : {}) },
            },
          }),
        })
      );
      if (!dispatched.ok) return reject();
      try {
        const result = await readBoundedResponseJson<{ response: unknown }>(
          dispatched,
          8192
        );
        return response(
          (await import("./voice-response.js")).renderExtensionVoiceResponse(
            result.response,
            root + "/menu"
          )
        );
      } catch {
        return reject();
      }
    }
    const existing = await c.env.PLATFORM_DB.prepare(
      "SELECT id FROM assistant_phone_events WHERE id=? AND binding_id=?"
    )
      .bind(sid, binding.id)
      .first();
    if (existing) return response("");
    const daily = event === "sms" ? "messages" : "calls",
      limit =
        event === "sms"
          ? policy.maxDailyInboundMessages
          : policy.maxDailyInboundCalls;
    const admitted = await c.env.PLATFORM_DB.prepare(
      `INSERT INTO assistant_phone_ingress_usage(binding_id,day,${daily}) VALUES(?,date('now'),1) ON CONFLICT(binding_id,day) DO UPDATE SET ${daily}=${daily}+1 WHERE ${daily}<?`
    )
      .bind(binding.id, limit)
      .run();
    if (!admitted.meta.changes) return response('<Reject reason="busy"/>', 429);
    const count = Number(form.get("NumMedia") ?? "0");
    if (!Number.isSafeInteger(count) || count < 0 || count > 10)
      return response("", 400);
    // URLs stay server side. Retrieval is restricted to this account + message + media resource.
    const media: Array<{ sid: string; content_type: string }> = [];
    for (let i = 0; i < count; i++) {
      const url = new URL(form.get(`MediaUrl${i}`) ?? "https://invalid");
      const match = url.pathname.match(
        new RegExp(
          `^/2010-04-01/Accounts/${credentials.accountSid}/Messages/${sid}/Media/(ME[a-fA-F0-9]{32})$`
        )
      );
      if (
        url.origin !== "https://api.twilio.com" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        !match
      )
        return response("", 400);
      media.push({
        sid: match[1]!,
        content_type: (
          form.get(`MediaContentType${i}`) ?? "application/octet-stream"
        ).slice(0, 120),
      });
    }
    const incomingText = (form.get("Body") ?? "").slice(0, 16000);
    const verification = policy.allowWebsiteVerification
      ? await (await import("./verification.js")).receiveSmsVerification(
          c.env,
          identity,
          binding.id,
          from,
          incomingText,
          sid
        )
      : null;
    const privateCode =
      verification !== null ||
      (/\b(?:code|pin|passcode|otp|verification)\b/i.test(incomingText) &&
        /(?<!\d)\d{4,8}(?!\d)/.test(incomingText));
    const key = await storeBody(c.env, identity, sid, {
      text: privateCode
        ? "[private account verification message]"
        : incomingText,
      ...(privateCode
        ? {
            private_text: incomingText,
            private_actor_id: verification?.actorId ?? identity.owner_user_id,
          }
        : {}),
      media,
      untrusted: true,
    });
    await c.env.PLATFORM_DB.prepare(
      "INSERT OR IGNORE INTO assistant_phone_events(id,binding_id,kind,sender,status,body_key) VALUES(?,?,'sms',?,'received',?)"
    )
      .bind(sid, binding.id, from, key)
      .run();
    // Caller ID is not authentication. Even a paired number only creates a pending task.
    const controller = await c.env.PLATFORM_DB.prepare(
      "SELECT user_id FROM assistant_communication_controllers WHERE identity_id=? AND channel='phone' AND address=? AND status='active'"
    )
      .bind(identity.id, from)
      .first<{ user_id: string }>();
    if (controller && !privateCode) {
      await c.env.PLATFORM_DB.prepare(
        "INSERT OR IGNORE INTO assistant_communication_messages(id,identity_id,provider_message_id,direction,channel,sender,recipient,status,body_key) VALUES(?,?,?,'inbound','sms',?,?,'received',?)"
      )
        .bind(sid, identity.id, sid, from, to, key)
        .run();
      await c.env.PLATFORM_DB.prepare(
        "INSERT OR IGNORE INTO assistant_communication_commands(id,identity_id,message_id,controller_user_id) VALUES(?,?,?,?)"
      )
        .bind("cmd_" + sid, identity.id, sid, controller.user_id)
        .run();
    }
    return response("");
  });
}
