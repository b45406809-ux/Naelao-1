import type { TwilioVoiceCredentials } from "./customer-telephony.js";

export interface AvailableTwilioLocalNumber {
  phone_number: string;
  country_code: string;
  region: string;
  locality: string;
  capabilities: { voice: true; sms: boolean; mms: boolean };
}

export async function searchTwilioLocalNumbers(input: {
  credentials: TwilioVoiceCredentials;
  country: string;
  areaCode?: string;
  fetcher?: typeof fetch;
}): Promise<{ ok: true; numbers: AvailableTwilioLocalNumber[] } | { ok: false; status: 409 | 502 | 503; error: string }> {
  const country = input.country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || (input.areaCode && !/^\d{2,6}$/.test(input.areaCode))) {
    return { ok: false, status: 502, error: "invalid_search_parameters" };
  }
  const query = new URLSearchParams({ VoiceEnabled: "true", PageSize: "20" });
  if (input.areaCode) query.set("AreaCode", input.areaCode);
  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(`https://api.twilio.com/2010-04-01/Accounts/${input.credentials.accountSid}/AvailablePhoneNumbers/${country}/Local.json?${query}`, {
      headers: { authorization: `Basic ${btoa(`${input.credentials.accountSid}:${input.credentials.authToken}`)}` },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 503, error: "twilio_number_search_unavailable" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, status: 409, error: "twilio_voice_credentials_rejected" };
  if (!response.ok) return { ok: false, status: 503, error: "twilio_number_search_unavailable" };
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 256 * 1024) return { ok: false, status: 502, error: "twilio_number_search_response_too_large" };
  let payload: { available_phone_numbers?: Array<Record<string, unknown>> };
  try { payload = JSON.parse(text) as typeof payload; } catch { return { ok: false, status: 502, error: "twilio_number_search_invalid_response" }; }
  if (!Array.isArray(payload.available_phone_numbers)) return { ok: false, status: 502, error: "twilio_number_search_invalid_response" };
  const numbers = payload.available_phone_numbers.slice(0, 20).flatMap((item): AvailableTwilioLocalNumber[] => {
    const capabilities = item.capabilities && typeof item.capabilities === "object" ? item.capabilities as Record<string, unknown> : {};
    if (typeof item.phone_number !== "string" || !/^\+[1-9]\d{7,14}$/.test(item.phone_number) || capabilities.voice !== true) return [];
    return [{ phone_number: item.phone_number, country_code: country, region: typeof item.region === "string" ? item.region.slice(0, 80) : "", locality: typeof item.locality === "string" ? item.locality.slice(0, 80) : "", capabilities: { voice: true, sms: capabilities.sms === true, mms: capabilities.mms === true } }];
  });
  return { ok: true, numbers };
}
