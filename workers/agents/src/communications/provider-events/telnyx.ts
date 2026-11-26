import { headerValue, type NormalizedProviderEvent, type ProviderEventAdapter, type VerifyWebhookInput } from "./types.js";

export function decodeFixedBase64(value: string, size: number): Uint8Array {
  if (value.length !== Math.ceil(size / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("invalid_base64");
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (bytes.length !== size) throw new Error("invalid_base64");
  return bytes;
}

/** Authenticate exact bytes before parsing. Timestamp validation limits replay age;
 * callers must also durably deduplicate event IDs before dispatching any side effect.
 * Moved here unchanged from voice/telnyx-telephony.ts (MR-EVT-6). */
export async function verifyTelnyxWebhook(input: {
  rawBody: string; publicKey: string; signature: string | null; timestamp: string | null; nowSeconds?: number;
}): Promise<boolean> {
  try {
    if (!input.signature || !input.timestamp || !/^\d{1,16}$/.test(input.timestamp)
      || new TextEncoder().encode(input.rawBody).byteLength > 256 * 1024) return false;
    const timestamp = Number(input.timestamp), now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(now) || Math.abs(now - timestamp) > 300) return false;
    const key = await crypto.subtle.importKey("raw", decodeFixedBase64(input.publicKey, 32), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, decodeFixedBase64(input.signature, 64), new TextEncoder().encode(`${input.timestamp}|${input.rawBody}`));
  } catch { return false; }
}

export interface TelnyxEvent {
  provider: "telnyx"; eventId: string; eventType: string; occurredAt: string; payload: Record<string, unknown>;
}
/** Verification is deliberately part of parsing, so callers cannot accidentally use unsigned JSON. */
export async function authenticatedTelnyxEvent(input: Parameters<typeof verifyTelnyxWebhook>[0]): Promise<TelnyxEvent> {
  if (!await verifyTelnyxWebhook(input)) throw new Error("telnyx_webhook_unauthorized");
  let body: { data?: { id?: unknown; event_type?: unknown; occurred_at?: unknown; payload?: unknown } };
  try { body = JSON.parse(input.rawBody); } catch { throw new Error("telnyx_webhook_invalid"); }
  const data = body?.data;
  if (!data || typeof data.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)
    || typeof data.event_type !== "string" || !/^(call|message|streaming)\.[a-z0-9_.]{1,100}$/.test(data.event_type)
    || typeof data.occurred_at !== "string" || data.occurred_at.length > 64 || !Number.isFinite(Date.parse(data.occurred_at))
    || !data.payload || typeof data.payload !== "object" || Array.isArray(data.payload)) throw new Error("telnyx_webhook_invalid");
  return { provider: "telnyx", eventId: data.id, eventType: data.event_type, occurredAt: data.occurred_at, payload: data.payload as Record<string, unknown> };
}

const REF = /^[A-Za-z0-9_+=/.:-]{1,500}$/;
function destination(payload: Record<string, unknown>): string | null {
  const raw = payload.to;
  if (typeof raw === "string") return REF.test(raw) ? raw : null;
  if (!Array.isArray(raw) || raw.length !== 1) return null;
  const value = (raw[0] as { phone_number?: unknown } | null)?.phone_number;
  return typeof value === "string" && REF.test(value) ? value : null;
}

export const telnyxProviderEventAdapter: ProviderEventAdapter = {
  provider: "telnyx",
  verifyWebhook: (input: VerifyWebhookInput) => verifyTelnyxWebhook({ rawBody: input.rawBody, publicKey: input.secret,
    signature: headerValue(input.headers, "telnyx-signature-ed25519"), timestamp: headerValue(input.headers, "telnyx-timestamp"),
    ...(input.nowSeconds !== undefined ? { nowSeconds: input.nowSeconds } : {}) }),
  async normalizeWebhook(rawBody): Promise<NormalizedProviderEvent | null> {
    let body: { data?: { id?: unknown; event_type?: unknown; occurred_at?: unknown; payload?: unknown } };
    try { body = JSON.parse(rawBody); } catch { return null; }
    const data = body?.data;
    if (!data || typeof data.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)
      || typeof data.event_type !== "string" || !/^(call|message|streaming)\.[a-z0-9_.]{1,100}$/.test(data.event_type)
      || typeof data.occurred_at !== "string" || data.occurred_at.length > 64 || !Number.isFinite(Date.parse(data.occurred_at))
      || !data.payload || typeof data.payload !== "object" || Array.isArray(data.payload)) return null;
    const payload = data.payload as Record<string, unknown>;
    const refs: Record<string, string> = {};
    if (typeof payload.id === "string" && REF.test(payload.id)) refs.message_id = payload.id;
    if (typeof payload.call_control_id === "string" && REF.test(payload.call_control_id)) refs.call_control_id = payload.call_control_id;
    return { eventId: data.id, eventType: data.event_type, occurredAt: data.occurred_at, resourceRef: destination(payload), data: refs };
  },
};
