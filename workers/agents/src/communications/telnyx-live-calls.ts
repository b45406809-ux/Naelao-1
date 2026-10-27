import type { AgentsEnv } from "../index.js";
import type { AssistantPhoneBinding } from "./phones.js";
import type { CommunicationIdentity, CommunicationScope } from "./core.js";
import { channelPreferences, scopeAccess } from "./core.js";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import { TelnyxTelephony } from "../voice/telnyx-telephony.js";
import { resolveTelnyxAccount } from "./telnyx-account.js";
import { claimLiveCall, liveCallAllowed, liveCallTicket, liveCodeHash, type LiveCall } from "./live-calls.js";
import { phonePublicOrigin } from "./phone-provider.js";

const internalCallSid = async (bindingId: string, callControlId: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${bindingId}:${callControlId}`)));
  return `CA${[...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
};
const callIdPattern = /^(?:v\d+:)?[A-Za-z0-9_+=/-]{1,500}$/;
function e164(value: unknown): string | null {
  const phone = typeof value === "string" ? value : value && typeof value === "object" ? (value as { phone_number?: unknown }).phone_number : null;
  return typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}
function commandId(eventId: string, action: string): string {
  const safe = eventId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 110);
  return `naelao_${safe}_${action}`;
}
function scopeFor(identity: CommunicationIdentity): CommunicationScope {
  return { tenantId: identity.tenant_id, spaceId: identity.space_id, userId: identity.owner_user_id, role: "product_end_user", ...(identity.project_id ? { projectId: identity.project_id } : {}) };
}

/** Dispatch only owner-armed internal assistant calls. Public callers never establish authority;
 * they must enter the one-time code shown to the authenticated owner in the dashboard. */
export async function dispatchTelnyxVoiceEvent(env: AgentsEnv, binding: AssistantPhoneBinding, identity: CommunicationIdentity,
  event: { eventId: string; eventType: string; payload: Record<string, unknown> }) {
  const payload = event.payload;
  const callControlId = payload.call_control_id;
  if (typeof callControlId !== "string" || !callIdPattern.test(callControlId)) throw new Error("telnyx_call_control_id_invalid");
  const account = await resolveTelnyxAccount(env, identity, binding);
  if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number) throw new Error("telnyx_binding_mismatch");
  const telnyx = new TelnyxTelephony(account);
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_telnyx_live_calls WHERE call_control_id=? AND binding_id=?")
    .bind(callControlId, binding.id).first<{ call_control_id: string; live_call_id: string; state: string; stream_claimed: number }>();

  if (event.eventType === "call.initiated") {
    if (payload.direction !== "incoming" && payload.direction !== "inbound") throw new Error("telnyx_inbound_call_required");
    if (e164(payload.to) !== binding.phone_number || !e164(payload.from)) throw new Error("telnyx_call_address_mismatch");
    if (binding.purpose !== "assistant") {
      // Customer call flows belong to installed extensions. The legacy Telnyx extension voice
      // dispatcher is not a streaming voice runtime, so fail closed until that extension opts in.
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "reject"));
      return { accepted: true, rejected: "extension_voice_runtime_unavailable" };
    }
    const scope = scopeFor(identity);
    if (!await scopeAccess(env, scope, true) || !(await channelPreferences(env, scope)).enabled.phone || await isSpaceNetworkEgressDenied(env.PLATFORM_DB, identity.space_id)) {
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "unavailable"));
      return { accepted: true, rejected: "phone_unavailable" };
    }
    const armed = await env.PLATFORM_DB.prepare("SELECT id FROM assistant_live_calls WHERE binding_id=? AND status='armed' AND expires_at>? ORDER BY created_at DESC LIMIT 1")
      .bind(binding.id, now).first<{ id: string }>();
    if (!armed) {
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "unarmed"));
      return { accepted: true, rejected: "no_owner_armed_call" };
    }
    const sid = await internalCallSid(binding.id, callControlId);
    await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO assistant_telnyx_live_calls(call_control_id,binding_id,live_call_id,state,created_at,updated_at) VALUES(?,?,?,'answering',?,?)")
      .bind(callControlId, binding.id, armed.id, now, now).run();
    const row = await env.PLATFORM_DB.prepare("SELECT live_call_id FROM assistant_telnyx_live_calls WHERE call_control_id=?")
      .bind(callControlId).first<{ live_call_id: string }>();
    if (!row || row.live_call_id !== armed.id) throw new Error("telnyx_call_already_bound");
    await telnyx.callAction(callControlId, "answer", commandId(event.eventId, "answer"));
    return { accepted: true, call_sid: sid };
  }

  if (!existing) {
    // Unassociated provider events cannot acquire an owner session or create a new call.
    if (event.eventType === "call.hangup") return { accepted: true, ignored: true };
    throw new Error("telnyx_call_admission_not_found");
  }
  if (event.eventType === "call.answered") {
    if (existing.state === "gathering" || existing.state === "streaming") return { accepted: true, duplicate: true };
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_live_calls SET state='gathering',updated_at=? WHERE call_control_id=? AND state='answering'")
      .bind(now, callControlId).run();
    await telnyx.callAction(callControlId, "gather_using_speak", commandId(event.eventId, "code"), {
      payload: "Enter the eight digit one time call code shown in Naelao.", voice: "female", language: "en-US",
      minimum_digits: 8, maximum_digits: 8, valid_digits: "0123456789", timeout_secs: 15,
      inter_digit_timeout_secs: 5, client_state: btoa(JSON.stringify({ bindingId: binding.id, liveCallId: existing.live_call_id })),
    });
    return { accepted: true, awaiting_code: true };
  }
  if (event.eventType === "call.gather.ended") {
    if (existing.state === "streaming") return { accepted: true, duplicate: true };
    const digits = payload.digits;
    if (typeof digits !== "string" || !/^\d{8}$/.test(digits) || payload.status === "call_hangup") {
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_live_calls SET state='ended',updated_at=? WHERE call_control_id=?")
        .bind(now, callControlId).run();
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "invalid_code"));
      return { accepted: true, rejected: "invalid_code" };
    }
    const live = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_live_calls WHERE id=? AND binding_id=? AND status='armed'")
      .bind(existing.live_call_id, binding.id).first<LiveCall>();
    if (!live) throw new Error("live_call_admission_expired");
    const sid = await internalCallSid(binding.id, callControlId);
    const claimed = await claimLiveCall(env, binding, sid, digits, validateMaxCallSeconds(binding));
    if (!claimed || claimed.id !== live.id || !await liveCallAllowed(env, claimed)) {
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_live_calls SET state='ended',updated_at=? WHERE call_control_id=?")
        .bind(now, callControlId).run();
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "denied"));
      return { accepted: true, rejected: "call_code_denied" };
    }
    const token = await liveCallTicket(env, claimed);
    const agentName = "phone-" + await liveCodeHash(claimed.binding_id, JSON.stringify([claimed.tenant_id, claimed.user_id, claimed.session_id]));
    const streamUrl = new URL(`/assistant-phone/telnyx-media/${encodeURIComponent(agentName)}/${encodeURIComponent(token)}`, phonePublicOrigin(env));
    streamUrl.protocol = "wss:";
    // Persist admission before starting the provider stream so the websocket can verify its
    // provider call-control id. If the provider action response is lost, reconciliation is manual.
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_live_calls SET state='streaming',updated_at=? WHERE call_control_id=? AND state='gathering'")
      .bind(now, callControlId).run();
    try {
      await telnyx.callAction(callControlId, "streaming_start", commandId(event.eventId, "stream"), {
        stream_url: streamUrl.toString(), stream_track: "inbound_track", stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: "PCMU", stream_bidirectional_sampling_rate: 8000,
      });
    } catch (error) {
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_live_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND state='streaming'")
        .bind(now, callControlId).run();
      throw error;
    }
    return { accepted: true, connected: true };
  }
  if (event.eventType === "streaming.stopped" || event.eventType === "streaming.failed") {
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_live_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND state='streaming'")
      .bind(now, callControlId).run();
    await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "stream_stopped"));
    return { accepted: true, ended: false, streaming_stopped: true };
  }
  if (event.eventType === "call.hangup") {
    const durationRaw = payload.call_duration_secs ?? payload.call_duration;
    const duration = typeof durationRaw === "number" ? durationRaw : typeof durationRaw === "string" && /^\d{1,5}$/.test(durationRaw) ? Number(durationRaw) : null;
    if (duration !== null && (!Number.isSafeInteger(duration) || duration < 0 || duration > 86_400)) throw new Error("telnyx_call_duration_invalid");
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_live_calls SET state='ended',duration_seconds=?,updated_at=? WHERE call_control_id=?")
      .bind(duration, now, callControlId).run();
    await env.PLATFORM_DB.prepare("UPDATE assistant_live_calls SET status='ended' WHERE id=? AND status='connected'")
      .bind(existing.live_call_id).run();
    if (duration !== null && binding.payer === "managed") {
      await (await import("./managed-carrier-billing.js")).settleManagedTelnyxCall(env, binding, existing.live_call_id, duration);
    }
    return { accepted: true, ended: true };
  }
  return { accepted: true, ignored: true };
}

function validateMaxCallSeconds(binding: AssistantPhoneBinding) {
  let policy: { maxCallSeconds?: unknown } = {};
  try { policy = JSON.parse(binding.policy_json) as typeof policy; } catch { /* checked by default */ }
  const value = policy.maxCallSeconds;
  return Number.isSafeInteger(value) && Number(value) >= 30 && Number(value) <= 900 ? Number(value) : 300;
}
