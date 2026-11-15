import type { AgentsEnv } from "../index.js";
import { TelnyxTelephony } from "../voice/telnyx-telephony.js";
import type { CommunicationIdentity } from "./core.js";
import { resolveTelnyxAccount } from "./telnyx-account.js";
import { decodeTelnyxPcmuToPcm16k } from "./telnyx-extension-audio.js";
import {
  activateTelnyxExtensionStreamSession,
  claimTelnyxExtensionStreamTicket,
  endTelnyxExtensionStreamSession,
  isTelnyxExtensionStreamSessionCurrent,
  markTelnyxExtensionStreamIndeterminate,
  type ClaimedExtensionStreamSession,
} from "./telnyx-extension-stream-session.js";
import { createTelnyxExtensionMediaRuntime, extensionAudioMaxCost } from "./telnyx-extension-voice-runtime.js";

type TelnyxStartMessage = {
  event: "start";
  start: {
    stream_id: string;
    call_control_id: string;
    media_format: { encoding: string; sample_rate: number; channels: number };
  };
};

export function matchesTelnyxExtensionStreamStart(session: ClaimedExtensionStreamSession, value: unknown): value is TelnyxStartMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.event !== "start" || !message.start || typeof message.start !== "object" || Array.isArray(message.start)) return false;
  const start = message.start as Record<string, unknown>;
  const format = start.media_format;
  if (!format || typeof format !== "object" || Array.isArray(format)) return false;
  const mediaFormat = format as Record<string, unknown>;
  return start.call_control_id === session.callControlId
    && typeof start.stream_id === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(start.stream_id)
    && mediaFormat.encoding === "PCMU" && mediaFormat.sample_rate === 8000 && mediaFormat.channels === 1;
}

async function loadStreamCall(env: AgentsEnv, session: ClaimedExtensionStreamSession) {
  return env.PLATFORM_DB.prepare(`SELECT c.caller,c.state,c.expires_at,b.identity_id,b.provider_number_sid,b.phone_number,b.payer,
      i.id AS identity_row_id,i.tenant_id,i.space_id,i.project_id,i.owner_user_id,i.status AS identity_status
    FROM assistant_telnyx_extension_calls c
    JOIN assistant_phone_bindings b ON b.id=c.binding_id
    JOIN assistant_communication_identities i ON i.id=b.identity_id
    WHERE c.call_control_id=? AND c.binding_id=? AND c.extension_installation_id=? AND c.handler_sha256=?
      AND c.settings_revision IS ? AND b.provider='telnyx' AND b.payer='byo' AND b.purpose='extension'
      AND b.status='active' AND i.status='active' AND i.tenant_id=? AND i.space_id=? AND i.project_id IS ?`)
    .bind(session.callControlId, session.bindingId, session.installationId, session.handlerSha256,
      session.settingsRevision, session.tenantId, session.spaceId, session.projectId)
    .first<{ caller: string; state: string; expires_at: number; identity_id: string; provider_number_sid: string;
      phone_number: string; payer: string; identity_row_id: string; tenant_id: string; space_id: string;
      project_id: string | null; owner_user_id: string; identity_status: string }>();
}

/** Dedicated BYO extension stream. Telnyx streaming remains unreachable until both the feature
 * rollout and independent external-acceptance gates are explicitly enabled. */
export async function handleTelnyxExtensionMediaStream(request: Request, env: AgentsEnv,
  bindingId: string, ticket: string): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || new URL(request.url).search)
    return new Response("Expected an authorized extension websocket", { status: 426 });
  if (env.TELNYX_EXTENSION_STREAMING_ENABLED !== "true" || env.TELNYX_EXTENSION_STREAMING_ACCEPTED !== "true"
    || !env.BILLING_WORKER || !env.CREDENTIALS_WORKER || extensionAudioMaxCost(env) === null)
    return new Response("Extension voice streaming is unavailable", { status: 503 });
  const session = await claimTelnyxExtensionStreamTicket(env.PLATFORM_DB, bindingId, ticket).catch(() => null);
  if (!session) return new Response("Extension call is not authorized", { status: 403 });
  const current = await isTelnyxExtensionStreamSessionCurrent(env.PLATFORM_DB, session).catch(() => false);
  const call = current ? await loadStreamCall(env, session).catch(() => null) : null;
  if (!current || !call || !["processing", "gathering"].includes(call.state)) {
    await markTelnyxExtensionStreamIndeterminate(env.PLATFORM_DB, session.sessionId).catch(() => {});
    return new Response("Extension call is no longer active", { status: 403 });
  }
  const identity: CommunicationIdentity = { id: call.identity_row_id, tenant_id: call.tenant_id, space_id: call.space_id,
    project_id: call.project_id, owner_user_id: call.owner_user_id, status: call.identity_status } as CommunicationIdentity;
  const account = await resolveTelnyxAccount(env, identity, { payer: "byo",
    provider_number_sid: call.provider_number_sid, phone_number: call.phone_number }).catch(() => null);
  if (!account || account.verifiedNumberId !== call.provider_number_sid || account.verifiedPhoneNumber !== call.phone_number) {
    await markTelnyxExtensionStreamIndeterminate(env.PLATFORM_DB, session.sessionId).catch(() => {});
    return new Response("Telnyx extension account is unavailable", { status: 503 });
  }
  if (!await activateTelnyxExtensionStreamSession(env.PLATFORM_DB, session).catch(() => false)) {
    await markTelnyxExtensionStreamIndeterminate(env.PLATFORM_DB, session.sessionId).catch(() => {});
    return new Response("Extension call authorization changed", { status: 403 });
  }

  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  server.accept();
  const telnyx = new TelnyxTelephony(account);
  let started = false;
  let terminal = false;
  let streamId = "";
  let runtime: ReturnType<typeof createTelnyxExtensionMediaRuntime> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let messageTail: Promise<void> = Promise.resolve();
  let endActionStarted = false;

  const finish = (code: number, reason: string, endedByHost = false) => {
    if (terminal) return;
    terminal = true;
    clearTimeout(startTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (server.readyState === WebSocket.OPEN) server.close(code, reason);
    void (async () => {
      await runtime?.close().catch(() => {});
      const latest = await env.PLATFORM_DB.prepare("SELECT state FROM assistant_telnyx_extension_calls WHERE call_control_id=? AND binding_id=?")
        .bind(session.callControlId, session.bindingId).first<{ state: string }>().catch(() => null);
      if (endedByHost || latest?.state === "ended") await endTelnyxExtensionStreamSession(env.PLATFORM_DB, session.sessionId).catch(() => {});
      else await markTelnyxExtensionStreamIndeterminate(env.PLATFORM_DB, session.sessionId).catch(() => {});
    })().catch(() => {});
  };

  const endCall = async (reason: "runtime_error" | "timeout" | "completed") => {
    if (endActionStarted || terminal) return;
    endActionStarted = true;
    const command = `naelao_${session.callRef}_${reason}`.slice(0, 120);
    try {
      await telnyx.callAction(session.callControlId, "hangup", command);
      finish(1000, reason, true);
    } catch {
      finish(1011, "provider_hangup_unknown");
    }
  };

  const startTimer = setTimeout(() => { void endCall("timeout"); }, 10_000);
  const fail = (_code: number, reason: string) => { void endCall(reason === "provider_timeout" ? "timeout" : "runtime_error"); };

  const startRuntime = async (message: unknown) => {
    if (started || !matchesTelnyxExtensionStreamStart(session, message)
      || !await isTelnyxExtensionStreamSessionCurrent(env.PLATFORM_DB, session))
      throw new Error("provider_call_pin_mismatch");
    started = true;
    streamId = message.start.stream_id;
    clearTimeout(startTimer);
    const remainingMs = Math.max(1, session.expiresAt * 1000 - Date.now());
    deadlineTimer = setTimeout(() => { void endCall("timeout"); }, remainingMs);
    runtime = createTelnyxExtensionMediaRuntime({ env, session, streamId,
      bufferedAmount: () => Number((server as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0),
      send: value => server.send(JSON.stringify(value)),
      stillAllowed: async () => env.TELNYX_EXTENSION_STREAMING_ENABLED === "true"
        && env.TELNYX_EXTENSION_STREAMING_ACCEPTED === "true"
        && await isTelnyxExtensionStreamSessionCurrent(env.PLATFORM_DB, session),
      endCall,
    });
    await runtime.start();
  };

  const handleMessage = async (event: MessageEvent) => {
    if (terminal) return;
    if (typeof event.data !== "string" || new TextEncoder().encode(event.data).byteLength > 16_384)
      throw new Error("media_message_invalid");
    const message: unknown = JSON.parse(event.data);
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("media_message_invalid");
    const record = message as Record<string, unknown>;
    if (record.event === "connected" && !started) return;
    if (record.event === "start") { await startRuntime(message); return; }
    if (record.event === "stop" && started) {
      const row = await env.PLATFORM_DB.prepare("SELECT state FROM assistant_telnyx_extension_calls WHERE call_control_id=? AND binding_id=?")
        .bind(session.callControlId, session.bindingId).first<{ state: string }>();
      if (row?.state === "ended") finish(1000, "provider_stopped", true);
      else void endCall("runtime_error");
      return;
    }
    if (record.event !== "media" || !started || !runtime || !record.media || typeof record.media !== "object" || Array.isArray(record.media))
      throw new Error("provider_media_event_invalid");
    if (record.stream_id !== undefined && record.stream_id !== streamId) throw new Error("provider_stream_id_mismatch");
    const media = record.media as Record<string, unknown>;
    if (media.track !== undefined && media.track !== "inbound" && media.track !== "inbound_track") throw new Error("provider_media_track_unsupported");
    if (typeof media.payload !== "string") throw new Error("provider_media_payload_invalid");
    runtime.feedPcm16k(decodeTelnyxPcmuToPcm16k(media.payload));
  };

  server.addEventListener("message", event => {
    messageTail = messageTail.then(() => handleMessage(event)).catch(error => {
      const reason = error instanceof Error ? error.message : "provider_media_runtime_failed";
      fail(1008, reason.slice(0, 120));
    });
  });
  server.addEventListener("close", () => {
    if (!terminal) void endCall("runtime_error");
  });
  server.addEventListener("error", () => fail(1011, "provider_socket_error"));
  return new Response(null, { status: 101, webSocket: client });
}
