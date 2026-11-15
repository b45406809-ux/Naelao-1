import type { AgentsEnv } from "../index.js";
import { validatePhonePolicy, type AssistantPhoneBinding } from "./phones.js";
import type { CommunicationIdentity, CommunicationScope } from "./core.js";
import { channelPreferences, scopeAccess } from "./core.js";
import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import { TelnyxTelephony } from "../voice/telnyx-telephony.js";
import { resolveTelnyxAccount } from "./telnyx-account.js";
import { observeTelnyxVoiceCallCost } from "./telnyx-voice-cost.js";
import { claimLiveCall, liveCallAllowed, liveCallTicket, liveCodeHash, type LiveCall } from "./live-calls.js";
import { phonePublicOrigin } from "./phone-provider.js";
import { validateVoiceChannelResponse, validateVoiceExtensionStreamResponse } from "@naelao/agent-sdk";
import { dispatchTelnyxExtensionStreamEvent, extensionAudioMaxCost, type ExtensionStreamEventScope } from "./telnyx-extension-voice-runtime.js";
import {
  createTelnyxExtensionStreamSession,
  denyTelnyxExtensionStreamConsent,
  grantTelnyxExtensionStreamConsent,
  revokeTelnyxExtensionStreamConsent,
  markTelnyxExtensionStreamIndeterminate,
  type ExtensionStreamSessionPin,
} from "./telnyx-extension-stream-session.js";

const internalCallSid = async (bindingId: string, callControlId: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${bindingId}:${callControlId}`)));
  return `CA${[...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
};
const callIdPattern = /^(?:v\d+:)?[A-Za-z0-9_+=/-]{1,500}$/;
// Public extension calls share an external number and speech/runtime budget. Keep a host-wide
// per-binding ceiling until the published extension settings contract exposes an owner limit.
const maxConcurrentTelnyxExtensionCalls = 5;
function e164(value: unknown): string | null {
  const phone = typeof value === "string" ? value : value && typeof value === "object" ? (value as { phone_number?: unknown }).phone_number : null;
  return typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}
function commandId(eventId: string, action: string): string {
  const safe = eventId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return `naelao_${safe}_${action}`;
}
function extensionVoiceRuntimeReady(env: AgentsEnv): boolean {
  return env.TELNYX_EXTENSION_STREAMING_ENABLED === "true" && env.TELNYX_EXTENSION_STREAMING_ACCEPTED === "true"
    && !!env.CREDENTIALS_WORKER && !!env.BILLING_WORKER && extensionAudioMaxCost(env) !== null;
}
function scopeFor(identity: CommunicationIdentity): CommunicationScope {
  return { tenantId: identity.tenant_id, spaceId: identity.space_id, userId: identity.owner_user_id, role: "product_end_user", ...(identity.project_id ? { projectId: identity.project_id } : {}) };
}

/** Dispatch only owner-armed internal assistant calls. Public callers never establish authority;
 * they must enter the one-time code shown to the authenticated owner in the dashboard. */
export async function dispatchTelnyxVoiceEvent(env: AgentsEnv, binding: AssistantPhoneBinding, identity: CommunicationIdentity,
  event: { eventId: string; eventType: string; occurredAt: string; payload: Record<string, unknown> }) {
  const payload = event.payload;
  const callControlId = payload.call_control_id;
  if (typeof callControlId !== "string" || !callIdPattern.test(callControlId)) throw new Error("telnyx_call_control_id_invalid");
  const account = await resolveTelnyxAccount(env, identity, binding);
  if (!account || account.verifiedNumberId !== binding.provider_number_sid || account.verifiedPhoneNumber !== binding.phone_number) throw new Error("telnyx_binding_mismatch");
  if (event.eventType === "call.cost") return observeTelnyxVoiceCallCost(env, binding, identity, account.callControlId, event);
  const telnyx = new TelnyxTelephony(account);
  if (binding.purpose === "extension") return dispatchTelnyxExtensionVoiceEvent(env, binding, identity, event, telnyx);
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_telnyx_live_calls WHERE call_control_id=? AND binding_id=?")
    .bind(callControlId, binding.id).first<{ call_control_id: string; live_call_id: string; state: string; stream_claimed: number }>();

  if (event.eventType === "call.initiated") {
    if (payload.direction !== "incoming" && payload.direction !== "inbound") throw new Error("telnyx_inbound_call_required");
    if (e164(payload.to) !== binding.phone_number || !e164(payload.from)) throw new Error("telnyx_call_address_mismatch");
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
      payload: "Enter the eight digit one time call code shown in Naelao.", voice: "AWS.Polly.Joanna", language: "en-US",
      minimum_digits: 8, maximum_digits: 8, valid_digits: "0123456789", timeout_millis: 15_000,
      inter_digit_timeout_millis: 5_000, client_state: btoa(JSON.stringify({ bindingId: binding.id, liveCallId: existing.live_call_id })),
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

type ExtensionVoiceEvent = { eventId: string; eventType: string; payload: Record<string, unknown> };
type ExtensionCall = { call_control_id: string; binding_id: string; caller: string; state: string; turn_count: number; expires_at: number;
  extension_installation_id: string | null; handler_sha256: string | null; settings_revision: number | null; settings_pinned: number;
  extension_voice_profile_id: string };

function extensionStreamPin(identity: CommunicationIdentity, binding: AssistantPhoneBinding, call: ExtensionCall): ExtensionStreamSessionPin {
  if (!call.extension_installation_id || !call.handler_sha256 || call.settings_pinned !== 1)
    throw new Error("telnyx_extension_stream_pin_unavailable");
  return { tenantId: identity.tenant_id, spaceId: identity.space_id, projectId: identity.project_id,
    bindingId: binding.id, callControlId: call.call_control_id, installationId: call.extension_installation_id,
    handlerSha256: call.handler_sha256, settingsRevision: call.settings_revision, voiceProfileId: call.extension_voice_profile_id,
    expiresAt: call.expires_at };
}

async function pendingExtensionStreamSession(env: AgentsEnv, bindingId: string, callControlId: string) {
  return env.PLATFORM_DB.prepare(`SELECT session_id FROM assistant_telnyx_extension_stream_sessions
    WHERE binding_id=? AND call_control_id=? AND consent_state='pending' AND state='consent_pending'`)
    .bind(bindingId, callControlId).first<{ session_id: string }>();
}

async function extensionEventId(bindingId: string, callControlId: string, providerEventId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${bindingId}:${callControlId}:${providerEventId}`)));
  return `telnyx-call-${[...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function callExtension(env: AgentsEnv, binding: AssistantPhoneBinding, identity: CommunicationIdentity,
  caller: string, callControlId: string, type: "call.received" | "call.digits", providerEventId: string, payload: Record<string, unknown>,
  pin: { installationId: string; handlerSha256: string; settingsRevision: number | null }) {
  if (!env.AGENTS_WORKER) throw new Error("phone_extension_dispatch_unavailable");
  const response = await env.AGENTS_WORKER.fetch(new Request("http://agents/internal/phone-extension-dispatch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenant_id,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, identity.tenant_id) },
    body: JSON.stringify({ spaceId: identity.space_id, bindingId: binding.id,
      expectedInstallationId: pin.installationId, expectedHandlerSha256: pin.handlerSha256,
      settingsRevision: pin.settingsRevision, event: {
      id: await extensionEventId(binding.id, callControlId, providerEventId), type,
      payload: { caller, voice_event: type, ...payload },
    } }),
  }));
  const result = await readBoundedResponseJson<{ response?: unknown }>(response, 8192);
  if (!response.ok) throw new Error("phone_extension_dispatch_rejected");
  return result.response;
}

async function pinExtensionCall(env: AgentsEnv, binding: AssistantPhoneBinding, identity: CommunicationIdentity,
  installationId: string, handlerSha256: string): Promise<number | null> {
  if (!env.AGENTS_WORKER) throw new Error("phone_extension_dispatch_unavailable");
  const response = await env.AGENTS_WORKER.fetch(new Request("http://agents/internal/phone-extension-dispatch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenant_id,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, identity.tenant_id) },
    body: JSON.stringify({ spaceId: identity.space_id, bindingId: binding.id, pinCall: true,
      expectedInstallationId: installationId, expectedHandlerSha256: handlerSha256 }),
  }));
  const result = await readBoundedResponseJson<{ settings_revision?: unknown }>(response, 8_192).catch(() => null);
  if (!response.ok || !result || !(result.settings_revision === null
    || Number.isSafeInteger(result.settings_revision) && Number(result.settings_revision) >= 0))
    throw new Error("phone_extension_settings_pin_unavailable");
  return result.settings_revision as number | null;
}

/** Execute a deliberately small carrier language. Public extension code returns data only; the
 * host validates it and owns every Telnyx command. Telnyx gather is currently DTMF-only here. */
function extensionGatherPlan(value: unknown): { kind: "hangup" } | { kind: "say"; prompt: string } | { kind: "gather"; prompt: string; digits: number } | null {
  const response = validateVoiceChannelResponse(value);
  if (!response) return null;
  const actions = response.actions;
  let prompt = "";
  let gather: { text: string; digits: number } | null = null;
  for (const raw of actions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const action = raw as Record<string, unknown>;
    if (action.type === "say" && Object.keys(action).every(key => ["type", "text"].includes(key))
      && typeof action.text === "string" && action.text.length <= 2_000 && !gather) {
      prompt += `${prompt ? " " : ""}${action.text}`;
      if (prompt.length > 2_500) return null;
    } else if (action.type === "gather" && Object.keys(action).every(key => ["type", "text", "digits", "input"].includes(key))
      && typeof action.text === "string" && action.text.length <= 1_000
      && (action.input === undefined || action.input === "dtmf")
      && (action.digits === undefined || (Number.isInteger(action.digits) && Number(action.digits) >= 1 && Number(action.digits) <= 8))
      && !gather) {
      gather = { text: action.text, digits: action.digits === undefined ? 1 : Number(action.digits) };
    } else if (action.type === "hangup" && Object.keys(action).length === 1 && !gather) {
      return prompt ? { kind: "say", prompt } : actions.length === 1 ? { kind: "hangup" } : null;
    } else return null;
  }
  if (!gather) return prompt ? { kind: "say", prompt } : null;
  return { kind: "gather", prompt: `${prompt}${prompt ? " " : ""}${gather.text}`.slice(0, 2500), digits: gather.digits };
}

async function dispatchTelnyxExtensionVoiceEvent(env: AgentsEnv, binding: AssistantPhoneBinding, identity: CommunicationIdentity,
  event: ExtensionVoiceEvent, telnyx: TelnyxTelephony) {
  const payload = event.payload;
  const callControlId = payload.call_control_id;
  if (typeof callControlId !== "string" || !callIdPattern.test(callControlId)) throw new Error("telnyx_call_control_id_invalid");
  const now = Math.floor(Date.now() / 1000);
  if (event.eventType === "call.initiated") {
    if (binding.payer !== "byo") {
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_billing_unavailable"));
      return { accepted: true, rejected: "extension_managed_voice_billing_unavailable" };
    }
    if (payload.direction !== "incoming" && payload.direction !== "inbound") throw new Error("telnyx_inbound_call_required");
    const caller = e164(payload.from);
    if (e164(payload.to) !== binding.phone_number || !caller) throw new Error("telnyx_call_address_mismatch");
    const handler = await env.PLATFORM_DB.prepare("SELECT binding_id,installation_id,handler_sha256 FROM assistant_phone_extension_handlers WHERE binding_id=? AND status='active'")
      .bind(binding.id).first<{ binding_id: string; installation_id: string; handler_sha256: string }>();
    const scope = scopeFor(identity);
    const policy = validatePhonePolicy(JSON.parse(binding.policy_json));
    const voiceProfileId = policy.extensionVoiceProfileId ?? "economy-eve";
    if (!Number.isSafeInteger(now + policy.maxCallSeconds)) throw new Error("telnyx_extension_duration_invalid");
    if (!handler || !handler.installation_id || !/^[a-f0-9]{64}$/.test(handler.handler_sha256)
      || !await scopeAccess(env, scope, true) || !(await channelPreferences(env, scope)).enabled.phone
      || await isSpaceNetworkEgressDenied(env.PLATFORM_DB, identity.space_id)) {
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_unavailable"));
      return { accepted: true, rejected: "extension_unavailable" };
    }
    const existingAdmission = await env.PLATFORM_DB.prepare("SELECT binding_id,caller,state FROM assistant_telnyx_extension_calls WHERE call_control_id=?")
      .bind(callControlId).first<{ binding_id: string; caller: string; state: string }>();
    if (existingAdmission) {
      if (existingAdmission.binding_id !== binding.id || existingAdmission.caller !== caller) throw new Error("telnyx_extension_call_binding_conflict");
      return { accepted: true, duplicate: true };
    }
    let settingsRevision: number | null;
    try {
      settingsRevision = await pinExtensionCall(env, binding, identity, handler.installation_id, handler.handler_sha256);
    } catch {
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_settings_pin_unavailable"));
      return { accepted: true, rejected: "extension_settings_pin_unavailable" };
    }
    await env.PLATFORM_DB.prepare("DELETE FROM assistant_telnyx_extension_calls WHERE updated_at<? AND state IN ('ended','indeterminate')")
      .bind(now - 7 * 86_400).run();
    await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET state='ended',consent_state='revoked',updated_at=?
      WHERE binding_id=? AND state IN ('consent_pending','ready','claimed') AND expires_at<=?`)
      .bind(now, binding.id, now).run();
    const inserted = await env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO assistant_telnyx_extension_calls(
        call_control_id,binding_id,caller,state,turn_count,started_at,expires_at,created_at,updated_at,extension_installation_id,handler_sha256,settings_revision,settings_pinned,extension_voice_profile_id)
      SELECT ?,?,?,'answering',0,?,?,?,?,?,?,?,1,?
      FROM assistant_phone_extension_handlers h
      WHERE h.binding_id=? AND h.status='active' AND h.installation_id=? AND h.handler_sha256=?
        AND (SELECT COUNT(*) FROM assistant_telnyx_extension_calls c
          WHERE c.binding_id=? AND c.state!='ended') < ?`)
      .bind(callControlId, binding.id, caller, now, now + policy.maxCallSeconds, now, now, handler.installation_id,
        handler.handler_sha256, settingsRevision, voiceProfileId, binding.id, handler.installation_id, handler.handler_sha256,
        binding.id, maxConcurrentTelnyxExtensionCalls).run();
    const row = await env.PLATFORM_DB.prepare("SELECT binding_id,caller,state,extension_installation_id,handler_sha256,settings_revision,settings_pinned,extension_voice_profile_id FROM assistant_telnyx_extension_calls WHERE call_control_id=?")
      .bind(callControlId).first<{ binding_id: string; caller: string; state: string; extension_installation_id: string | null; handler_sha256: string | null; settings_revision: number | null; settings_pinned: number; extension_voice_profile_id: string }>();
    if (!inserted.meta.changes) {
      if (row?.binding_id === binding.id && row.caller === caller) return { accepted: true, duplicate: true };
      if (!row) {
        await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_concurrency_limit"));
        return { accepted: true, rejected: "extension_concurrency_limit" };
      }
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_handler_changed"));
      return { accepted: true, rejected: "extension_handler_changed_during_admission" };
    }
    if (!row || row.binding_id !== binding.id || row.caller !== caller || row.extension_installation_id !== handler.installation_id
      || row.handler_sha256 !== handler.handler_sha256 || row.settings_pinned !== 1 || row.settings_revision !== settingsRevision
      || row.extension_voice_profile_id !== voiceProfileId)
      throw new Error("telnyx_extension_call_binding_conflict");
    const quota = await env.PLATFORM_DB.prepare("INSERT INTO assistant_phone_ingress_usage(binding_id,day,calls) VALUES(?,date('now'),1) ON CONFLICT(binding_id,day) DO UPDATE SET calls=calls+1 WHERE calls<?")
      .bind(binding.id, policy.maxDailyInboundCalls).run();
    if (!quota.meta.changes) {
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='ended',updated_at=? WHERE call_control_id=? AND state='answering'")
        .bind(now, callControlId).run();
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_quota"));
      return { accepted: true, rejected: "daily_call_limit" };
    }
    const admittedCall: ExtensionCall = { call_control_id: callControlId, binding_id: binding.id, caller, state: row.state,
      turn_count: 0, expires_at: now + policy.maxCallSeconds, extension_installation_id: row.extension_installation_id,
      handler_sha256: row.handler_sha256, settings_revision: row.settings_revision, settings_pinned: row.settings_pinned,
      extension_voice_profile_id: row.extension_voice_profile_id };
    if (extensionVoiceRuntimeReady(env) && policy.allowTelnyxExtensionVoice === true) {
      try { await createTelnyxExtensionStreamSession(env.PLATFORM_DB, extensionStreamPin(identity, binding, admittedCall), now); }
      catch {
        await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='answering'")
          .bind(now, callControlId, binding.id).run();
        await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_consent_session_unavailable"));
        return { accepted: true, ended: true, reason: "extension_consent_session_unavailable" };
      }
    }
    try {
      await telnyx.callAction(callControlId, "answer", commandId(event.eventId, "extension_answer"));
      return { accepted: true, extension_call: true };
    } catch (error) {
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND state='answering'")
        .bind(now, callControlId).run();
      await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET state='ended',consent_state='revoked',updated_at=?
        WHERE binding_id=? AND call_control_id=? AND state='consent_pending'`)
        .bind(now, binding.id, callControlId).run();
      throw error;
    }
  }

  const existing = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_telnyx_extension_calls WHERE call_control_id=? AND binding_id=?")
    .bind(callControlId, binding.id).first<ExtensionCall>();
  if (!existing) {
    if (event.eventType === "call.hangup") return { accepted: true, ignored: true };
    throw new Error("telnyx_extension_call_not_admitted");
  }
  if (event.eventType === "call.hangup") {
    const durationRaw = payload.call_duration_secs ?? payload.call_duration;
    const duration = typeof durationRaw === "number" ? durationRaw : typeof durationRaw === "string" && /^\d{1,5}$/.test(durationRaw) ? Number(durationRaw) : null;
    if (duration !== null && (!Number.isSafeInteger(duration) || duration < 0 || duration > 86_400)) throw new Error("telnyx_call_duration_invalid");
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='ended',duration_seconds=?,updated_at=? WHERE call_control_id=? AND binding_id=?")
      .bind(duration, now, callControlId, binding.id).run();
    await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET state='ended',consent_state='revoked',updated_at=?
      WHERE binding_id=? AND call_control_id=? AND state IN ('consent_pending','ready','claimed')`)
      .bind(now, binding.id, callControlId).run();
    return { accepted: true, ended: true };
  }
  if (existing.settings_pinned !== 1 || !existing.extension_installation_id || !existing.handler_sha256) {
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND binding_id=? AND state!='ended'")
      .bind(now, callControlId, binding.id).run();
    await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_call_pin_unavailable"));
    return { accepted: true, ended: true, reason: "extension_call_pin_unavailable" };
  }
  if (event.eventType === "call.answered") {
    if (existing.state !== "answering") return { accepted: true, duplicate: true };
    const consentSession = await pendingExtensionStreamSession(env, binding.id, callControlId);
    if (consentSession && extensionVoiceRuntimeReady(env)
      && validatePhonePolicy(JSON.parse(binding.policy_json)).allowTelnyxExtensionVoice === true) {
      const claimed = await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='gathering',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='answering' AND expires_at>?")
        .bind(now, callControlId, binding.id, now).run();
      if (!claimed.meta.changes) return { accepted: true, rejected: "extension_call_expired" };
      try {
        await telnyx.callAction(callControlId, "gather_using_speak", commandId(event.eventId, "extension_voice_consent"), {
          payload: "This extension can accept live voice transcription. Press 1 to consent for this call, or press 2 to continue with keypad only. If voice processing is unavailable, the keypad menu will continue.",
          voice: "AWS.Polly.Joanna", language: "en-US", minimum_digits: 1, maximum_digits: 1, valid_digits: "12",
          timeout_millis: Math.min(12_000, Math.max(1_000, (existing.expires_at - now) * 1000)),
          inter_digit_timeout_millis: 2_000,
        });
        return { accepted: true, awaiting_voice_consent: true };
      } catch (error) {
        await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='gathering'")
          .bind(now, callControlId, binding.id).run();
        await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET state='ended',consent_state='revoked',updated_at=?
          WHERE binding_id=? AND call_control_id=? AND state='consent_pending'`).bind(now, binding.id, callControlId).run();
        throw error;
      }
    }
    if (consentSession) {
      await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_extension_stream_sessions SET state='ended',consent_state='revoked',updated_at=?
        WHERE binding_id=? AND call_control_id=? AND state='consent_pending'`).bind(now, binding.id, callControlId).run();
    }
    const claimed = await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='processing',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='answering' AND expires_at>? ")
      .bind(now, callControlId, binding.id, now).run();
    if (!claimed.meta.changes) return { accepted: true, rejected: "extension_call_expired" };
    let result: unknown;
    try {
      result = await callExtension(env, binding, identity, existing.caller, callControlId, "call.received", event.eventId, {}, {
        installationId: existing.extension_installation_id, handlerSha256: existing.handler_sha256, settingsRevision: existing.settings_revision,
      });
    } catch {
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='processing'")
        .bind(now, callControlId, binding.id).run();
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_dispatch_unavailable"));
      return { accepted: true, ended: true, reason: "extension_dispatch_unavailable" };
    }
    return applyExtensionVoicePlan(env, binding, telnyx, callControlId, event.eventId, result, now);
  }
  if (event.eventType === "call.gather.ended") {
    const consentSession = await pendingExtensionStreamSession(env, binding.id, callControlId);
    if (consentSession && existing.state === "gathering") {
      const digits = payload.digits;
      const explicitAccept = digits === "1" && payload.status !== "call_hangup"
        && extensionVoiceRuntimeReady(env)
        && validatePhonePolicy(JSON.parse(binding.policy_json)).allowTelnyxExtensionVoice === true;
      let mediaTicket: string | null = null;
      if (explicitAccept) {
        mediaTicket = await grantTelnyxExtensionStreamConsent(env.PLATFORM_DB, extensionStreamPin(identity, binding, existing), consentSession.session_id, now);
      } else {
        await denyTelnyxExtensionStreamConsent(env.PLATFORM_DB, identity, binding.id, callControlId, now);
      }
      if (payload.status === "call_hangup") {
        await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='ended',updated_at=? WHERE call_control_id=? AND binding_id=?")
          .bind(now, callControlId, binding.id).run();
        return { accepted: true, ended: true, voice_consent: "not_granted" };
      }
      if (explicitAccept && mediaTicket && extensionVoiceRuntimeReady(env)) {
        const sessionRow = await env.PLATFORM_DB.prepare(`SELECT session_id,call_ref FROM assistant_telnyx_extension_stream_sessions
          WHERE session_id=? AND binding_id=? AND call_control_id=? AND state='ready' AND consent_state='granted'
            AND ticket_expires_at>? AND expires_at>?`)
          .bind(consentSession.session_id, binding.id, callControlId, now, now)
          .first<{ session_id: string; call_ref: string }>();
        if (sessionRow) {
          const eventScope: ExtensionStreamEventScope = { tenantId: identity.tenant_id, spaceId: identity.space_id,
            projectId: identity.project_id, bindingId: binding.id, callControlId, callRef: sessionRow.call_ref,
            installationId: existing.extension_installation_id!, handlerSha256: existing.handler_sha256!,
            settingsRevision: existing.settings_revision };
          let rawInitial: unknown;
          try {
            rawInitial = await dispatchTelnyxExtensionStreamEvent(env, eventScope, "call.started");
          } catch {
            await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='gathering'")
              .bind(now, callControlId, binding.id).run();
            await markTelnyxExtensionStreamIndeterminate(env.PLATFORM_DB, consentSession.session_id, now);
            await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_voice_dispatch_unknown")).catch(() => {});
            return { accepted: true, ended: false, reason: "extension_voice_dispatch_unknown" };
          }
          const initial = validateVoiceExtensionStreamResponse(rawInitial);
          const supported = initial?.actions.every(action => action.type === "speak" || action.type === "end"
            || action.type === "listen" && action.input === "speech");
          if (supported) {
            const claimed = await env.PLATFORM_DB.prepare(`UPDATE assistant_telnyx_extension_calls SET state='processing',updated_at=?
              WHERE call_control_id=? AND binding_id=? AND state='gathering' AND expires_at>?`)
              .bind(now, callControlId, binding.id, now).run();
            if (claimed.meta.changes !== 1) {
              await revokeTelnyxExtensionStreamConsent(env.PLATFORM_DB, consentSession.session_id, now).catch(() => false);
              return { accepted: true, rejected: "extension_call_not_active" };
            }
            let streamUrl: URL | null = null;
            try {
              streamUrl = new URL(`/assistant-phone/telnyx-extension-media/${encodeURIComponent(binding.id)}/${encodeURIComponent(mediaTicket)}`, phonePublicOrigin(env));
              streamUrl.protocol = "wss:";
            } catch {
              await revokeTelnyxExtensionStreamConsent(env.PLATFORM_DB, consentSession.session_id, now).catch(() => false);
              await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='gathering',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='processing'")
                .bind(now, callControlId, binding.id).run();
            }
            if (streamUrl) {
              try {
                await telnyx.callAction(callControlId, "streaming_start", commandId(event.eventId, "extension_voice_stream"), {
                  stream_url: streamUrl.toString(), stream_track: "inbound_track", stream_bidirectional_mode: "rtp",
                  stream_bidirectional_codec: "PCMU", stream_bidirectional_sampling_rate: 8000,
                });
                return { accepted: true, connected: true, voice_consent: "granted" };
              } catch {
                await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='processing'")
                  .bind(now, callControlId, binding.id).run();
                await markTelnyxExtensionStreamIndeterminate(env.PLATFORM_DB, consentSession.session_id, now);
                await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_voice_start_unknown")).catch(() => {});
                return { accepted: true, ended: false, reason: "extension_voice_start_unknown" };
              }
            }
          } else {
            await revokeTelnyxExtensionStreamConsent(env.PLATFORM_DB, consentSession.session_id, now).catch(() => false);
          }
        } else {
          await revokeTelnyxExtensionStreamConsent(env.PLATFORM_DB, consentSession.session_id, now).catch(() => false);
        }
      }
      const claimed = await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='processing',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='gathering' AND expires_at>? ")
        .bind(now, callControlId, binding.id, now).run();
      if (!claimed.meta.changes) return { accepted: true, rejected: "extension_call_not_active" };
      let result: unknown;
      try {
        result = await callExtension(env, binding, identity, existing.caller, callControlId, "call.received", event.eventId, {}, {
          installationId: existing.extension_installation_id!, handlerSha256: existing.handler_sha256!, settingsRevision: existing.settings_revision,
        });
      } catch {
        await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='processing'")
          .bind(now, callControlId, binding.id).run();
        await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_dispatch_unavailable"));
        return { accepted: true, ended: true, reason: "extension_dispatch_unavailable" };
      }
      return applyExtensionVoicePlan(env, binding, telnyx, callControlId, event.eventId, result, now);
    }
    if (existing.state === "finishing") {
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='ended',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='finishing'")
        .bind(now, callControlId, binding.id).run();
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_final_hangup"));
      return { accepted: true, ended: true };
    }
    if (existing.state !== "gathering") return { accepted: true, duplicate: true };
    if (now >= existing.expires_at || existing.turn_count >= 20) {
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='ended',updated_at=? WHERE call_control_id=? AND state='gathering'")
        .bind(now, callControlId).run();
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_limit"));
      return { accepted: true, ended: true, reason: "call_limit" };
    }
    const digits = payload.digits;
    if (typeof digits !== "string" || !/^[0-9]{1,8}$/.test(digits) || payload.status === "call_hangup") {
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='ended',updated_at=? WHERE call_control_id=? AND state='gathering'")
        .bind(now, callControlId).run();
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_no_input"));
      return { accepted: true, ended: true, reason: "no_input" };
    }
    const claimed = await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='processing',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='gathering' AND expires_at>? AND turn_count<20")
      .bind(now, callControlId, binding.id, now).run();
    if (!claimed.meta.changes) return { accepted: true, rejected: "extension_call_not_active" };
    let result: unknown;
    try {
      result = await callExtension(env, binding, identity, existing.caller, callControlId, "call.digits", event.eventId, { digits }, {
        installationId: existing.extension_installation_id, handlerSha256: existing.handler_sha256, settingsRevision: existing.settings_revision,
      });
    } catch {
      await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='processing'")
        .bind(now, callControlId, binding.id).run();
      await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_dispatch_unavailable"));
      return { accepted: true, ended: true, reason: "extension_dispatch_unavailable" };
    }
    return applyExtensionVoicePlan(env, binding, telnyx, callControlId, event.eventId, result, now);
  }
  if (event.eventType.startsWith("streaming.")) {
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND binding_id=? AND state!='ended'")
      .bind(now, callControlId, binding.id).run();
    await telnyx.callAction(callControlId, "hangup", commandId(event.eventId, "extension_stream_unsupported"));
    return { accepted: true, ended: true, reason: "public_streaming_not_enabled" };
  }
  return { accepted: true, ignored: true };
}

async function applyExtensionVoicePlan(env: AgentsEnv, binding: AssistantPhoneBinding, telnyx: TelnyxTelephony,
  callControlId: string, eventId: string, response: unknown, now: number) {
  const plan = extensionGatherPlan(response);
  if (!plan || plan.kind === "hangup") {
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='ended',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='processing'")
      .bind(now, callControlId, binding.id).run();
    await telnyx.callAction(callControlId, "hangup", commandId(eventId, "extension_hangup"));
    return { accepted: true, ended: true, ...(plan ? {} : { rejected: "unsupported_extension_voice_response" }) };
  }
  const call = await env.PLATFORM_DB.prepare("SELECT expires_at FROM assistant_telnyx_extension_calls WHERE call_control_id=? AND binding_id=?")
    .bind(callControlId, binding.id).first<{ expires_at: number }>();
  const remainingMs = call ? Math.min(15_000, Math.max(0, call.expires_at - now) * 1000) : 0;
  if (remainingMs < 1_000) {
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='ended',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='processing'")
      .bind(now, callControlId, binding.id).run();
    await telnyx.callAction(callControlId, "hangup", commandId(eventId, "extension_expired"));
    return { accepted: true, ended: true, reason: "call_limit" };
  }
  try {
    const terminal = plan.kind === "say";
    await telnyx.callAction(callControlId, "gather_using_speak", commandId(eventId, "extension_gather"), {
      payload: plan.prompt, voice: "AWS.Polly.Joanna", language: "en-US", minimum_digits: terminal ? 1 : plan.digits, maximum_digits: terminal ? 1 : plan.digits,
      valid_digits: "0123456789", timeout_millis: terminal ? Math.min(2_000, remainingMs) : remainingMs,
      inter_digit_timeout_millis: terminal ? Math.min(1_000, remainingMs) : Math.min(5_000, remainingMs),
    });
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state=?,turn_count=turn_count+1,updated_at=? WHERE call_control_id=? AND binding_id=? AND state='processing' AND turn_count<20")
      .bind(terminal ? "finishing" : "gathering", now, callControlId, binding.id)
      .run();
    return { accepted: true, gathering: !terminal, finishing: terminal, turn_limit: 20 };
  } catch (error) {
    await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_extension_calls SET state='indeterminate',updated_at=? WHERE call_control_id=? AND binding_id=? AND state='processing'")
      .bind(now, callControlId, binding.id).run();
    throw error;
  }
}

function validateMaxCallSeconds(binding: AssistantPhoneBinding) {
  let policy: { maxCallSeconds?: unknown } = {};
  try { policy = JSON.parse(binding.policy_json) as typeof policy; } catch { /* checked by default */ }
  const value = policy.maxCallSeconds;
  return Number.isSafeInteger(value) && Number(value) >= 30 && Number(value) <= 900 ? Number(value) : 300;
}
