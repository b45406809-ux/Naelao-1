import type { AgentsEnv } from "../index.js";
import {
  claimTelnyxExtensionStreamTicket,
  isTelnyxExtensionStreamSessionCurrent,
  markTelnyxExtensionStreamIndeterminate,
  type ClaimedExtensionStreamSession,
} from "./telnyx-extension-stream-session.js";

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

/** Separate extension media boundary. It consumes only a caller-consented, one-use ticket and
 *  checks Telnyx's exact call and installed-code pin. It deliberately does not bridge audio:
 *  public extension STT/TTS, admission and interruption controls are still gated work. */
export async function handleTelnyxExtensionMediaStream(request: Request, env: AgentsEnv,
  bindingId: string, ticket: string): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || new URL(request.url).search)
    return new Response("Expected an authorized extension websocket", { status: 426 });
  if (env.TELNYX_EXTENSION_STREAMING_ENABLED !== "true") return new Response("Extension voice streaming is disabled", { status: 503 });
  const session = await claimTelnyxExtensionStreamTicket(env.PLATFORM_DB, bindingId, ticket).catch(() => null);
  if (!session) return new Response("Extension call is not authorized", { status: 403 });

  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  server.accept();
  let connected = false;
  let terminal = false;
  const close = (code: number, reason: string) => {
    if (terminal) return;
    terminal = true;
    clearTimeout(timer);
    void markTelnyxExtensionStreamIndeterminate(env.PLATFORM_DB, session.sessionId).finally(() => {
      if (server.readyState === WebSocket.OPEN) server.close(code, reason);
    });
  };
  const timer = setTimeout(() => close(1008, "provider_start_timeout"), 10_000);
  server.addEventListener("message", event => {
    if (terminal) return;
    void (async () => {
      if (typeof event.data !== "string" || new TextEncoder().encode(event.data).byteLength > 16_384)
        throw new Error("media_message_invalid");
      const message = JSON.parse(event.data) as unknown;
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("media_message_invalid");
      const record = message as Record<string, unknown>;
      if (record.event === "connected" && !connected) { connected = true; return; }
      if (!connected || !matchesTelnyxExtensionStreamStart(session, message)
        || !await isTelnyxExtensionStreamSessionCurrent(env.PLATFORM_DB, session)) throw new Error("provider_call_pin_mismatch");

      // The request is authenticated and pinned, but no media is read until the host STT/TTS,
      // budget, interruption, timeout and cleanup path has passed its own acceptance gates.
      close(1013, "voice_stream_runtime_unavailable");
    })().catch(() => close(1008, "provider_call_pin_mismatch"));
  });
  server.addEventListener("close", () => close(1000, "provider_closed"));
  server.addEventListener("error", () => close(1011, "provider_socket_error"));
  return new Response(null, { status: 101, webSocket: client });
}
