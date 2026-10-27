import { verifyOwnerVoiceTicket, type OwnerVoiceTicket } from "./voice-ticket.js";
import type { AgentsEnv } from "../index.js";
import type { LiveCall } from "../communications/live-calls.js";
import { liveCallAllowed } from "../communications/live-calls.js";

const pcmRate = 16_000;
function decodeBase64(value: string): Uint8Array {
  if (value.length > 128_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("telnyx_media_payload_invalid");
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) binary += String.fromCharCode(...value.subarray(offset, Math.min(offset + 0x8000, value.length)));
  return btoa(binary);
}
function mulawToPcm(sample: number): number {
  const v = (~sample) & 0xff;
  const magnitude = (((v & 0x0f) << 3) + 0x84) << ((v & 0x70) >> 4);
  return (v & 0x80) ? 0x84 - magnitude : magnitude - 0x84;
}
function pcmToMulaw(sample: number): number {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  sample = Math.min(sample, CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(sample & mask); exponent--, mask >>= 1) {}
  return (~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f))) & 0xff;
}
function pcmu8ToPcm16k(bytes: Uint8Array): ArrayBuffer {
  const output = new Int16Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const sample = mulawToPcm(bytes[i]!);
    output[i * 2] = sample;
    output[i * 2 + 1] = sample;
  }
  return output.buffer;
}
function pcm16kToPcmu8(buffer: ArrayBuffer): Uint8Array {
  if (buffer.byteLength % 2 || buffer.byteLength > pcmRate * 2) throw new Error("telnyx_voice_frame_invalid");
  const input = new Int16Array(buffer), output = new Uint8Array(Math.floor(input.length / 2));
  for (let i = 0; i < output.length; i++) output[i] = pcmToMulaw(Math.round((input[i * 2]! + input[i * 2 + 1]!) / 2));
  return output;
}
function speechEnergy(pcm: ArrayBuffer): boolean {
  const samples = new Int16Array(pcm);
  if (!samples.length) return false;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return energy / samples.length > 180_000;
}

async function activeTicket(env: AgentsEnv, id: string, token: string): Promise<OwnerVoiceTicket | null> {
  const ticket = await verifyOwnerVoiceTicket(token, env.PLATFORM_SECRET, id);
  if (!ticket?.phoneBindingId || !ticket.callSid) return null;
  const row = await env.PLATFORM_DB.prepare("SELECT * FROM assistant_live_calls WHERE id=? AND binding_id=? AND call_sid=? AND tenant_id=? AND user_id=? AND session_id=? AND status='connected' AND deadline>? AND deadline<=?")
    .bind(ticket.nonce, ticket.phoneBindingId, ticket.callSid, ticket.tenantId, ticket.userId, ticket.sessionId, Math.floor(Date.now() / 1000), ticket.expiresAt).first<LiveCall>();
  if (!row || !await liveCallAllowed(env, row)) return null;
  const claim = await env.PLATFORM_DB.prepare("UPDATE assistant_telnyx_live_calls SET stream_claimed=1,updated_at=? WHERE live_call_id=? AND binding_id=? AND state='streaming' AND stream_claimed=0")
    .bind(Math.floor(Date.now() / 1000), row.id, row.binding_id).run();
  return claim.meta.changes === 1 ? ticket : null;
}

/** Bridges Telnyx's bidirectional PCMU media stream to the same scoped OwnerVoiceAgent used by
 * Twilio and browser calls. The stream ticket is call-specific, short-lived, and checked against
 * the durable call admission record before accepting the provider websocket. */
export async function handleTelnyxMediaStream(request: Request, env: AgentsEnv, id: string, token: string): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || new URL(request.url).search) return new Response("Expected an authorized websocket", { status: 426 });
  const ticket = await activeTicket(env, id, token);
  if (!ticket) return new Response("Call is not authorized", { status: 403 });
  const pair = new WebSocketPair(), client = pair[0], server = pair[1];
  server.accept();
  let streamId: string | null = null;
  let callControlId: string | null = null;
  let agent: WebSocket | null = null;
  let queue = Promise.resolve();
  let queuedMessages = 0;
  let playbackUntil = 0;
  let loudFrames = 0;
  let gated = false;
  const agentName = ticket.agentName;
  const stop = (code = 1000, reason = "call_ended") => {
    if (agent?.readyState === WebSocket.OPEN) {
      try { agent.send(JSON.stringify({ type: "end_call" })); agent.close(code, reason); } catch { /* closed */ }
    }
    if (server.readyState === WebSocket.OPEN) server.close(code, reason);
  };
  const enqueue = (task: () => Promise<void>, reason: string) => {
    if (++queuedMessages > 64) { queuedMessages--; stop(1013, "media_bridge_overloaded"); return; }
    queue = queue.then(task).catch(() => stop(1008, reason)).finally(() => { queuedMessages--; });
  };
  const connect = async (providerCallId: string) => {
    const row = await env.PLATFORM_DB.prepare("SELECT call_control_id FROM assistant_telnyx_live_calls WHERE live_call_id=? AND binding_id=? AND state='streaming'")
      .bind(ticket.nonce, ticket.phoneBindingId).first<{ call_control_id: string }>();
    if (!row || row.call_control_id !== providerCallId) throw new Error("telnyx_media_call_mismatch");
    const namespace = env.OWNER_VOICE_AGENT;
    if (!namespace) throw new Error("voice_agent_unavailable");
    const stub = namespace.get(namespace.idFromName(agentName));
    const target = new URL(request.url);
    target.pathname = `/agents/owner_voice_agent/${encodeURIComponent(agentName)}`;
    target.search = `?ticket=${encodeURIComponent(token)}`;
    const response = await stub.fetch(new Request(target.toString(), { headers: { Upgrade: "websocket" } }));
    const socket = response.webSocket;
    if (!socket) throw new Error("voice_agent_websocket_unavailable");
    socket.accept(); socket.binaryType = "arraybuffer"; agent = socket;
    socket.addEventListener("message", event => {
      enqueue(async () => {
        if (typeof event.data === "string") {
          let message: Record<string, unknown>;
          try { message = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
          if (message.type === "playback_interrupt") {
            if (server.readyState === WebSocket.OPEN && streamId) server.send(JSON.stringify({ event: "clear", stream_id: streamId }));
            gated = false; loudFrames = 0; playbackUntil = 0; return;
          }
          if (["listening", "thinking", "speaking"].includes(String(message.status))) gated = false;
          return;
        }
        if (!(event.data instanceof ArrayBuffer) || gated || !streamId) return;
        const mulaw = pcm16kToPcmu8(event.data);
        playbackUntil = Math.max(Date.now(), playbackUntil) + event.data.byteLength / (pcmRate * 2) * 1000;
        server.send(JSON.stringify({ event: "media", stream_id: streamId, media: { payload: encodeBase64(mulaw) } }));
      }, "media_bridge_failed");
    });
    socket.addEventListener("close", () => { if (server.readyState === WebSocket.OPEN) server.close(1011, "voice_agent_closed"); });
    socket.send(JSON.stringify({ type: "start_call" }));
  };
  server.addEventListener("message", event => {
    enqueue(async () => {
      if (typeof event.data !== "string") throw new Error("telnyx_media_message_invalid");
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.event === "connected") return;
      if (message.event === "start") {
        const start = message.start as Record<string, unknown> | undefined;
        const format = start?.media_format as Record<string, unknown> | undefined;
        if (typeof start?.stream_id !== "string" || typeof start.call_control_id !== "string" || format?.encoding !== "PCMU" || format.sample_rate !== 8000 || format.channels !== 1) throw new Error("telnyx_media_format_unsupported");
        streamId = start.stream_id; callControlId = start.call_control_id;
        await connect(callControlId);
        return;
      }
      if (message.event === "media") {
        const media = message.media as Record<string, unknown> | undefined;
        if (typeof media?.payload !== "string" || !agent || agent.readyState !== WebSocket.OPEN) return;
        const pcm = pcmu8ToPcm16k(decodeBase64(media.payload));
        loudFrames = speechEnergy(pcm) ? loudFrames + 1 : 0;
        if (!gated && Date.now() < playbackUntil + 180 && loudFrames >= 3) {
          gated = true; loudFrames = 0; playbackUntil = 0;
          if (streamId) server.send(JSON.stringify({ event: "clear", stream_id: streamId }));
          agent.send(JSON.stringify({ type: "interrupt" }));
        }
        agent.send(pcm);
        return;
      }
      if (message.event === "stop") stop();
    }, "invalid_media_stream");
  });
  server.addEventListener("close", () => stop());
  server.addEventListener("error", () => stop(1011, "media_stream_error"));
  return new Response(null, { status: 101, webSocket: client });
}

export const telnyxPcmuCodec = { decodeBase64, encodeBase64, pcmu8ToPcm16k, pcm16kToPcmu8 };
