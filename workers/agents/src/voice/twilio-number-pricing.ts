import type { TwilioVoiceCredentials } from "./twilio-telephony.js";
import { readBoundedResponseText } from "../shared/bounded-response-text.js";

export type TwilioNumberPriceErrorCode = "twilio_number_pricing_unavailable" | "twilio_number_price_invalid" | "twilio_number_price_currency_unsupported";
export class TwilioNumberPriceError extends Error {
  constructor(readonly code: TwilioNumberPriceErrorCode) { super(code); this.name = "TwilioNumberPriceError"; }
}

export interface TwilioNumberPrice {
  numberType: string;
  monthlyCostMinor: number;
  currency: "USD";
  inboundPricePerMinuteMinor: number;
  quotedAt: string;
}

function minor(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return null;
  return Math.ceil(amount * 100);
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new TwilioNumberPriceError("twilio_number_pricing_unavailable");
  let text: string;
  try { text = await readBoundedResponseText(response, 64 * 1024); }
  catch { throw new TwilioNumberPriceError("twilio_number_pricing_unavailable"); }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch { throw new TwilioNumberPriceError("twilio_number_pricing_unavailable"); }
}

function normalizeNumberType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const type = value.trim().toLowerCase().replace(/[-_]+/g, " ");
  return ["local", "mobile", "national", "toll free"].includes(type) ? type : null;
}

async function getCountryPrice(input: {
  country: string; numberType: string;
  fetcher: typeof fetch; auth: string;
}): Promise<{ monthlyCostMinor: number; currency: "USD" }> {
  const response = await input.fetcher(`https://pricing.twilio.com/v1/PhoneNumbers/Countries/${encodeURIComponent(input.country)}`, {
    headers: { authorization: input.auth }, redirect: "error", signal: AbortSignal.timeout(8_000),
  });
  const body = await boundedJson(response);
  const prices = Array.isArray(body.phone_number_prices) ? body.phone_number_prices.slice(0, 20) : [];
  const row = prices.find((item) => item && typeof item === "object" && normalizeNumberType((item as Record<string, unknown>).number_type) === input.numberType) as Record<string, unknown> | undefined;
  if (String(body.price_unit ?? "").toUpperCase() !== "USD") throw new TwilioNumberPriceError("twilio_number_price_currency_unsupported");
  const monthlyCostMinor = minor(row?.current_price);
  if (monthlyCostMinor === null) throw new TwilioNumberPriceError("twilio_number_price_invalid");
  return { monthlyCostMinor, currency: "USD" };
}

/** Twilio's official country/type pricing resource returns account-specific current monthly prices. */
export async function fetchTwilioLocalMonthlyPrice(input: {
  credentials: TwilioVoiceCredentials; country: string; fetcher?: typeof fetch;
}): Promise<{ monthlyCostMinor: number; currency: "USD"; numberType: "local"; quotedAt: string }> {
  const fetcher = input.fetcher ?? fetch;
  const auth = `Basic ${btoa(`${input.credentials.accountSid}:${input.credentials.authToken}`)}`;
  const price = await getCountryPrice({ country: input.country.toUpperCase(), numberType: "local", fetcher, auth });
  return { ...price, numberType: "local", quotedAt: new Date().toISOString() };
}

/** Resolve both recurring rental and inbound per-minute cost for an already-owned number. */
export async function fetchTwilioNumberPrice(input: {
  credentials: TwilioVoiceCredentials; phoneNumber: string; country: string; fetcher?: typeof fetch;
}): Promise<TwilioNumberPrice> {
  if (!/^\+[1-9]\d{7,14}$/.test(input.phoneNumber) || !/^[A-Za-z]{2}$/.test(input.country)) throw new TwilioNumberPriceError("twilio_number_price_invalid");
  const fetcher = input.fetcher ?? fetch;
  const auth = `Basic ${btoa(`${input.credentials.accountSid}:${input.credentials.authToken}`)}`;
  const response = await fetcher(`https://pricing.twilio.com/v2/Voice/Numbers/${encodeURIComponent(input.phoneNumber)}`, {
    headers: { authorization: auth }, redirect: "error", signal: AbortSignal.timeout(8_000),
  });
  const voice = await boundedJson(response);
  const inbound = voice.inbound_call_price && typeof voice.inbound_call_price === "object" ? voice.inbound_call_price as Record<string, unknown> : {};
  const numberType = normalizeNumberType(inbound.number_type);
  if (!numberType) throw new TwilioNumberPriceError("twilio_number_price_invalid");
  if (voice.price_unit && String(voice.price_unit).toUpperCase() !== "USD") throw new TwilioNumberPriceError("twilio_number_price_currency_unsupported");
  const inboundPricePerMinuteMinor = minor(inbound.current_price);
  if (inboundPricePerMinuteMinor === null) throw new TwilioNumberPriceError("twilio_number_price_invalid");
  const monthly = await getCountryPrice({ country: input.country.toUpperCase(), numberType, fetcher, auth });
  return { numberType, ...monthly, inboundPricePerMinuteMinor, quotedAt: new Date().toISOString() };
}
