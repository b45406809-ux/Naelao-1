import type { Hono } from "hono";
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
const caller = (s: string) => /^[+a-zA-Z0-9][+a-zA-Z0-9 ._-]{0,63}$/.test(s);
export function registerPhoneWebhooks(app: Hono<{ Bindings: AgentsEnv }>) {
  app.post("/assistant-phone/twilio/:bindingId/:event", async (c) => {
    const event = c.req.param("event");
    if (
      !["sms", "answer", "menu", "voicemail", "transcript", "status"].includes(
        event
      )
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
    if (
      binding.status !== "active" ||
      !(await scopeAccess(c.env, scope, true)) ||
      !(await channelPreferences(c.env, scope)).enabled.phone ||
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
    const configuredHandler = await c.env.PLATFORM_DB.prepare(
      "SELECT binding_id FROM assistant_phone_extension_handlers WHERE binding_id=? AND status='active'"
    )
      .bind(binding.id)
      .first();
    // Compatibility during staged migration: only unbound existing numbers use their saved
    // presentation. Binding a validated extension switches this number to the restricted executor.
    if (!configuredHandler && (event === "answer" || event === "menu")) {
      const menu = () =>
        !policy.greeting.trim()
          ? response("<Reject/>")
          : response(
              `<Gather input="dtmf" numDigits="1" timeout="10" action="${xml(root + "/menu")}" method="POST"><Say>${xml(policy.greeting)}</Say></Gather><Hangup/>`
            );
      if (event === "menu") {
        const admitted = await c.env.PLATFORM_DB.prepare(
          "SELECT id FROM assistant_phone_events WHERE id=? AND binding_id=? AND kind='call' AND sender=?"
        )
          .bind(sid, binding.id, from)
          .first();
        if (!admitted) return reject();
        if (form.get("Digits") === "2" && policy.transferTo)
          return response(
            `<Dial callerId="${xml(binding.phone_number!)}" timeLimit="${policy.maxCallSeconds}" timeout="20"><Number>${xml(policy.transferTo)}</Number></Dial><Hangup/>`
          );
        if (form.get("Digits") === "1" && policy.voicemail)
          return response(
            `<Say>This message will be recorded and transcribed for the assistant owner. Please leave your message after the tone.</Say><Record maxLength="${Math.min(120, policy.maxCallSeconds)}" playBeep="true" action="${xml(root + "/voicemail")}" method="POST" recordingStatusCallback="${xml(root + "/voicemail")}" recordingStatusCallbackMethod="POST" transcribe="true" transcribeCallback="${xml(root + "/transcript")}"/><Hangup/>`
          );
        return response(
          "<Say>No destination is configured for that option.</Say><Hangup/>"
        );
      }
      const prior=await c.env.PLATFORM_DB.prepare('SELECT id FROM assistant_phone_events WHERE id=? AND binding_id=?').bind(sid,binding.id).first();
      if(!prior){const quota=await c.env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_ingress_usage(binding_id,day,calls) VALUES(?,date('now'),1) ON CONFLICT(binding_id,day) DO UPDATE SET calls=calls+1 WHERE calls<?").bind(binding.id,policy.maxDailyInboundCalls).run();if(!quota.meta.changes)return reject();await c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_phone_events(id,binding_id,kind,sender,status) VALUES(?,?,'call',?,'received')").bind(sid,binding.id,from).run();}
      return menu();
    }
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
