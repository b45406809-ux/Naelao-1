import { readBoundedResponseJson } from "@naelao/http";
import { PhoneProviderError } from "../communications/phone-provider.js";
import { isE164 } from "./twilio-telephony.js";

export interface TelnyxCredentials { apiKey: string; publicKey: string }
function decode(value: string, size: number): Uint8Array {
  if (value.length !== Math.ceil(size / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("invalid_base64");
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (bytes.length !== size) throw new Error("invalid_base64");
  return bytes;
}

/** Authenticate exact bytes before parsing. Timestamp validation limits replay age;
 * callers must also durably deduplicate event IDs before dispatching any side effect. */
export async function verifyTelnyxWebhook(input: {
  rawBody: string; publicKey: string; signature: string | null; timestamp: string | null; nowSeconds?: number;
}): Promise<boolean> {
  try {
    if (!input.signature || !input.timestamp || !/^\d{1,16}$/.test(input.timestamp)
      || new TextEncoder().encode(input.rawBody).byteLength > 256 * 1024) return false;
    const timestamp = Number(input.timestamp), now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(now) || Math.abs(now - timestamp) > 300) return false;
    const key = await crypto.subtle.importKey("raw", decode(input.publicKey, 32), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, decode(input.signature, 64), new TextEncoder().encode(`${input.timestamp}|${input.rawBody}`));
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
    || typeof data.event_type !== "string" || !/^(call|message)\.[a-z0-9_.]{1,100}$/.test(data.event_type)
    || typeof data.occurred_at !== "string" || data.occurred_at.length > 64 || !Number.isFinite(Date.parse(data.occurred_at))
    || !data.payload || typeof data.payload !== "object" || Array.isArray(data.payload)) throw new Error("telnyx_webhook_invalid");
  return { provider: "telnyx", eventId: data.id, eventType: data.event_type, occurredAt: data.occurred_at, payload: data.payload as Record<string, unknown> };
}

/** Fixed Telnyx v2 resources. No automatic mutation retries or provider failover:
 * a lost response can mean a real call/message already exists. */
export class TelnyxTelephony {
  constructor(private credentials: TelnyxCredentials, private fetcher: typeof fetch = fetch) {
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(credentials.apiKey)) throw new Error("telnyx_credentials_invalid");
    decode(credentials.publicKey, 32);
  }
  private async request(path: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telnyx.com/v2${path}`, { method, redirect: "error", signal: AbortSignal.timeout(12000),
        headers: { authorization: `Bearer ${this.credentials.apiKey}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new PhoneProviderError(method !== "GET", "telnyx_provider_outcome_unknown"); }
    if (!response.ok) throw new PhoneProviderError(method !== "GET" && (response.status >= 500 || response.status === 408), "telnyx_provider_rejected");
    try {
      const value = await readBoundedResponseJson<{ data?: unknown }>(response, 64 * 1024);
      if (!value?.data || typeof value.data !== "object" || Array.isArray(value.data)) throw new Error();
      return value.data as Record<string, unknown>;
    } catch { throw new PhoneProviderError(method !== "GET", "telnyx_provider_receipt_invalid"); }
  }
  callAction(callControlId: string, action: "answer" | "hangup", commandId: string) {
    if (!/^(?:v\d+:)?[A-Za-z0-9_+=/-]{1,500}$/.test(callControlId) || !/^[A-Za-z0-9_-]{1,128}$/.test(commandId)
      || !["answer", "hangup"].includes(action)) throw new Error("telnyx_call_action_invalid");
    return this.request(`/calls/${encodeURIComponent(callControlId)}/actions/${action}`, "POST", { command_id: commandId });
  }
  sendSms(from: string, to: string, text: string, messagingProfileId: string) {
    if (!isE164(from) || !isE164(to) || typeof text !== "string" || !text.trim() || text.length > 1600
      || !/^[A-Za-z0-9_-]{1,128}$/.test(messagingProfileId)) throw new Error("telnyx_sms_invalid");
    return this.request("/messages", "POST", { from, to, text, messaging_profile_id: messagingProfileId });
  }
  inspectMessage(id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("telnyx_message_id_invalid");
    return this.request(`/messages/${encodeURIComponent(id)}`, "GET");
  }
}
