import { readBoundedResponseJson } from "@naelao/http";
import { PhoneProviderError } from "../communications/phone-provider.js";
import { isE164 } from "./twilio-telephony.js";

export interface TelnyxCredentials { apiKey: string; publicKey: string }
export interface TelnyxAvailablePhoneNumber {
  phoneNumber: string;
  countryCode: string;
  numberType: string | null;
  features: string[];
  locality: string | null;
  region: string | null;
  upfrontCostMinor: number;
  monthlyCostMinor: number;
  currency: string;
}
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
    || typeof data.event_type !== "string" || !/^(call|message|streaming)\.[a-z0-9_.]{1,100}$/.test(data.event_type)
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
  private async requestData(path: string, method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>, allowNotFound = false): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telnyx.com/v2${path}`, { method, redirect: "error", signal: AbortSignal.timeout(12000),
        headers: { authorization: `Bearer ${this.credentials.apiKey}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new PhoneProviderError(method !== "GET", "telnyx_provider_outcome_unknown"); }
    if (method === "DELETE" && (response.status === 204 || response.status === 404)) return {};
    if (method === "GET" && allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new PhoneProviderError(method !== "GET" && (response.status >= 500 || response.status === 408), "telnyx_provider_rejected");
    try {
      const value = await readBoundedResponseJson<{ data?: unknown }>(response, 256 * 1024);
      if (!value || !Object.prototype.hasOwnProperty.call(value, "data") || !value.data || typeof value.data !== "object") throw new Error();
      return value.data;
    } catch { throw new PhoneProviderError(method !== "GET", "telnyx_provider_receipt_invalid"); }
  }
  private async request(path: string, method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const value = await this.requestData(path, method, body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PhoneProviderError(method !== "GET", "telnyx_provider_receipt_invalid");
    return value as Record<string, unknown>;
  }
  async searchAvailablePhoneNumbers(input: { countryCode: string; numberType?: "local" | "toll_free" | "mobile" | "national" | "shared_cost"; contains?: string; startsWith?: string; limit?: number }): Promise<TelnyxAvailablePhoneNumber[]> {
    const countryCode = input.countryCode.toUpperCase();
    const limit = input.limit ?? 20;
    if (!/^[A-Z]{2}$/.test(countryCode) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20
      || (input.numberType !== undefined && !["local", "toll_free", "mobile", "national", "shared_cost"].includes(input.numberType))
      || (input.contains !== undefined && (!/^\d{2,8}$/.test(input.contains) || input.contains.length > 8))
      || (input.startsWith !== undefined && !/^\d{2,15}$/.test(input.startsWith))) throw new Error("telnyx_number_search_invalid");
    const query = new URLSearchParams();
    query.set("filter[country_code]", countryCode);
    query.set("filter[limit]", String(limit));
    query.set("filter[exclude_held_numbers]", "true");
    query.append("filter[features]", "voice");
    query.append("filter[features]", "sms");
    if (input.numberType) query.set("filter[phone_number_type]", input.numberType);
    if (input.contains) query.set("filter[phone_number][contains]", input.contains);
    if (input.startsWith) query.set("filter[phone_number][starts_with]", input.startsWith);
    const data = await this.requestData(`/available_phone_numbers?${query.toString()}`, "GET");
    if (!Array.isArray(data)) throw new PhoneProviderError(false, "telnyx_number_search_receipt_invalid");
    return data.slice(0, limit).flatMap((candidate): TelnyxAvailablePhoneNumber[] => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const row = candidate as Record<string, unknown>;
      if (typeof row.phone_number !== "string" || !isE164(row.phone_number)) return [];
      const features = Array.isArray(row.features) ? row.features.slice(0, 32).flatMap(feature =>
        feature && typeof feature === "object" && !Array.isArray(feature) && typeof (feature as Record<string, unknown>).name === "string"
          ? [(feature as Record<string, unknown>).name as string] : []) : [];
      const cost = row.cost_information && typeof row.cost_information === "object" && !Array.isArray(row.cost_information)
        ? row.cost_information as Record<string, unknown> : {};
      const currency = typeof cost.currency === "string" ? cost.currency.toUpperCase() : "";
      const upfrontCostMinor = parseProviderUsdMinor(cost.upfront_cost);
      const monthlyCostMinor = parseProviderUsdMinor(cost.monthly_cost);
      if (!features.includes("voice") || !features.includes("sms") || !/^[A-Z]{3}$/.test(currency)
        || upfrontCostMinor === null || monthlyCostMinor === null) return [];
      const regions = Array.isArray(row.region_information) ? row.region_information : [];
      const locality = regions.find(item => item && typeof item === "object" && (item as Record<string, unknown>).region_type === "location") as Record<string, unknown> | undefined;
      const region = regions.find(item => item && typeof item === "object" && ["state", "administrative_area"].includes(String((item as Record<string, unknown>).region_type))) as Record<string, unknown> | undefined;
      return [{ phoneNumber: row.phone_number, countryCode,
        numberType: typeof row.phone_number_type === "string" ? row.phone_number_type : null,
        features, locality: typeof locality?.region_name === "string" ? locality.region_name.slice(0, 80) : null,
        region: typeof region?.region_name === "string" ? region.region_name.slice(0, 80) : null,
        upfrontCostMinor, monthlyCostMinor, currency }];
    });
  }
  async listNumberOrders(customerReference: string): Promise<Record<string, unknown>[]> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(customerReference)) throw new Error("telnyx_number_order_reference_invalid");
    const query = new URLSearchParams({ "filter[customer_reference]": customerReference });
    const data = await this.requestData(`/number_orders?${query.toString()}`, "GET");
    if (!Array.isArray(data)) throw new PhoneProviderError(false, "telnyx_number_order_list_invalid");
    return data.slice(0, 20).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  }
  async createNumberOrder(input: { phoneNumber: string; customerReference: string; connectionId?: string | null; messagingProfileId?: string | null }): Promise<Record<string, unknown>> {
    if (!isE164(input.phoneNumber) || !/^[A-Za-z0-9_-]{1,80}$/.test(input.customerReference)
      || (input.connectionId != null && !/^[A-Za-z0-9_-]{1,128}$/.test(input.connectionId))
      || (input.messagingProfileId != null && !/^[A-Za-z0-9_-]{1,128}$/.test(input.messagingProfileId))) throw new Error("telnyx_number_order_invalid");
    return this.request("/number_orders", "POST", { phone_numbers: [{ phone_number: input.phoneNumber }],
      customer_reference: input.customerReference, ...(input.connectionId ? { connection_id: input.connectionId } : {}),
      ...(input.messagingProfileId ? { messaging_profile_id: input.messagingProfileId } : {}) });
  }
  async inspectNumberOrder(id: string): Promise<Record<string, unknown>> {
    if (!/^[A-Fa-f0-9-]{36}$/.test(id)) throw new Error("telnyx_number_order_id_invalid");
    return this.request(`/number_orders/${encodeURIComponent(id)}`, "GET");
  }
  callAction(callControlId: string, action: "answer" | "hangup" | "gather_using_speak" | "streaming_start", commandId: string, options: Record<string, unknown> = {}) {
    if (!/^(?:v\d+:)?[A-Za-z0-9_+=/-]{1,500}$/.test(callControlId) || !/^[A-Za-z0-9_-]{1,128}$/.test(commandId)
      || !["answer", "hangup", "gather_using_speak", "streaming_start"].includes(action)) throw new Error("telnyx_call_action_invalid");
    return this.request(`/calls/${encodeURIComponent(callControlId)}/actions/${action}`, "POST", { ...options, command_id: commandId });
  }
  sendSms(from: string, to: string, text: string, messagingProfileId?: string) {
    if (!isE164(from) || !isE164(to) || typeof text !== "string" || !text.trim() || text.length > 1600
      || (messagingProfileId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(messagingProfileId))) throw new Error("telnyx_sms_invalid");
    return this.request("/messages", "POST", { from, to, text, ...(messagingProfileId ? { messaging_profile_id: messagingProfileId } : {}) });
  }
  inspectMessage(id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("telnyx_message_id_invalid");
    return this.request(`/messages/${encodeURIComponent(id)}`, "GET");
  }
  async inspectPhoneNumber(id: string) {
    if (!/^\d{1,32}$/.test(id)) throw new Error("telnyx_number_id_invalid");
    const number = await this.request(`/phone_numbers/${id}`, "GET");
    if (number.id !== id || typeof number.phone_number !== "string" || !isE164(number.phone_number))
      throw new PhoneProviderError(false, "telnyx_number_receipt_invalid");
    return { id, phoneNumber: number.phone_number,
      messagingProfileId: typeof number.messaging_profile_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(number.messaging_profile_id) && number.messaging_profile_id !== "UNAVAILABLE" ? number.messaging_profile_id : null,
      callControlId: typeof number.connection_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(number.connection_id) ? number.connection_id : null };
  }
  async inspectPhoneNumberForRelease(id: string) {
    if (!/^\d{1,32}$/.test(id)) throw new Error("telnyx_number_id_invalid");
    const value = await this.requestData(`/phone_numbers/${id}`, "GET", undefined, true);
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PhoneProviderError(false, "telnyx_number_receipt_invalid");
    const number = value as Record<string, unknown>;
    if (number.id !== id || typeof number.phone_number !== "string" || !isE164(number.phone_number))
      throw new PhoneProviderError(false, "telnyx_number_receipt_invalid");
    return { id, phoneNumber: number.phone_number };
  }
  releasePhoneNumber(id: string) {
    if (!/^\d{1,32}$/.test(id)) throw new Error("telnyx_number_id_invalid");
    return this.request(`/phone_numbers/${id}`, "DELETE");
  }
  async inspectMessagingProfile(id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("telnyx_profile_id_invalid");
    const profile = await this.request(`/messaging_profiles/${encodeURIComponent(id)}`, "GET");
    if (profile.id !== id || profile.enabled !== true || typeof profile.webhook_url !== "string" || profile.webhook_api_version !== "2") throw new Error("telnyx_messaging_profile_invalid");
    return { webhookUrl: profile.webhook_url };
  }
  async inspectCallControlApplication(id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("telnyx_call_control_id_invalid");
    const app = await this.request(`/call_control_applications/${encodeURIComponent(id)}`, "GET");
    if (app.id !== id || app.active !== true || typeof app.webhook_event_url !== "string" || app.webhook_api_version !== "2")
      throw new Error("telnyx_call_control_application_invalid");
    return { webhookUrl: app.webhook_event_url, callCostInWebhooks: app.call_cost_in_webhooks === true };
  }
}

function parseProviderUsdMinor(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole!) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) return null;
  return cents <= 100_000_000n ? Number(cents) : null;
}
