import { validateRequest } from "twilio/lib/webhooks/webhooks.js";

export const CUSTOMER_VOICE_TICKET_TTL_MS = 60_000;
export const CUSTOMER_VOICE_DEFAULT_MAX_CALL_SECONDS = 300;
export const CUSTOMER_VOICE_DEFAULT_MAX_CONCURRENT = 2;
export const CUSTOMER_VOICE_MAX_PROMPT_CHARS = 8_000;

export const CUSTOMER_VOICE_ADMISSION_SQL = `INSERT INTO customer_voice_call_admissions(call_sid,number_binding_id,tenant_id,space_id,agent_id,caller_number,called_number,status,ticket_nonce,ticket_token,issued_at,ticket_expires_at,reserved_cost_minor,reserved_duration_seconds,updated_at)
  SELECT ?,?,?,?,?,?,?,'issued',?,?,?,?,?,?,?
  WHERE (SELECT COUNT(*) FROM customer_voice_call_admissions WHERE tenant_id=? AND space_id=? AND status IN ('issued','connected') AND ticket_expires_at>?) < ?
    AND (SELECT COUNT(*) FROM customer_voice_call_admissions WHERE number_binding_id=? AND status IN ('issued','connected') AND ticket_expires_at>?) < ?
    AND (SELECT COUNT(*) FROM customer_voice_call_admissions WHERE tenant_id=? AND space_id=? AND issued_at>=?) < ?
    AND (SELECT COUNT(*) FROM customer_voice_call_admissions WHERE tenant_id=? AND space_id=? AND caller_number=? AND issued_at>=?) < 5
    AND (SELECT COALESCE(SUM(CASE WHEN status IN ('issued','connected') THEN reserved_duration_seconds ELSE COALESCE(duration_seconds,0) END),0) FROM customer_voice_call_admissions WHERE tenant_id=? AND space_id=? AND issued_at>=?) + ? <= ? * 60
    AND (SELECT COALESCE(SUM(CASE WHEN status IN ('issued','connected') THEN reserved_cost_minor ELSE COALESCE(actual_cost_minor,0) END),0) FROM customer_voice_call_admissions WHERE tenant_id=? AND space_id=? AND issued_at>=?) + ? +
        (SELECT COALESCE(SUM(monthly_cost_minor),0) FROM customer_voice_number_bindings WHERE tenant_id=? AND space_id=? AND status='active') <= ?
  ON CONFLICT(call_sid) DO NOTHING`;

export interface CustomerVoiceAdmissionValues {
  callSid: string; bindingId: string; tenantId: string; spaceId: string; agentId: string;
  caller: string; called: string; nonce: string; token: string; now: string; expiresAt: string;
  reserveCostMinor: number; reserveDurationSeconds: number; spaceMaxConcurrent: number;
  numberMaxConcurrent: number; hourStart: string; maxCallsPerHour: number;
  dayStart: string; maxDailyMinutes: number; monthStart: string; monthlySpendLimitMinor: number;
}

export function customerVoiceAdmissionBindings(input: CustomerVoiceAdmissionValues): unknown[] {
  return [
    input.callSid, input.bindingId, input.tenantId, input.spaceId, input.agentId, input.caller, input.called,
    input.nonce, input.token, input.now, input.expiresAt, input.reserveCostMinor, input.reserveDurationSeconds, input.now,
    input.tenantId, input.spaceId, input.now, input.spaceMaxConcurrent,
    input.bindingId, input.now, input.numberMaxConcurrent,
    input.tenantId, input.spaceId, input.hourStart, input.maxCallsPerHour,
    input.tenantId, input.spaceId, input.caller, input.hourStart,
    input.tenantId, input.spaceId, input.dayStart, input.reserveDurationSeconds, input.maxDailyMinutes,
    input.tenantId, input.spaceId, input.monthStart, input.reserveCostMinor,
    input.tenantId, input.spaceId, input.monthlySpendLimitMinor,
  ];
}

export interface CustomerVoiceTicket {
  version: 1;
  tenantId: string;
  spaceId: string;
  bindingId: string;
  agentId: string;
  callSid: string;
  caller: string;
  called: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface TwilioVoiceCredentials { accountSid: string; authToken: string }

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch { return null; }
}

export function decodeCustomerVoiceTicketPayload(token: string): Partial<CustomerVoiceTicket> | null {
  if (token.length > 2_048) return null;
  const payload = token.split(".")[0] ?? "";
  const bytes = decodeBase64Url(payload);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as Partial<CustomerVoiceTicket>; }
  catch { return null; }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!;
  return different === 0;
}

async function sign(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export async function mintCustomerVoiceTicket(input: Omit<CustomerVoiceTicket, "version" | "issuedAt" | "expiresAt" | "nonce">, secret: string, now = Date.now()): Promise<{ token: string; ticket: CustomerVoiceTicket }> {
  const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  const ticket: CustomerVoiceTicket = {
    version: 1,
    ...input,
    nonce,
    issuedAt: now,
    expiresAt: now + CUSTOMER_VOICE_TICKET_TTL_MS,
  };
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(ticket)));
  return { ticket, token: `${payload}.${encodeBase64Url(await sign(secret, payload))}` };
}

export async function verifyCustomerVoiceTicket(token: string, secret: string, expectedCallSid: string, now = Date.now()): Promise<CustomerVoiceTicket | null> {
  if (!secret || token.length > 2_048) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const actual = decodeBase64Url(signature);
  if (!actual || !equalBytes(actual, await sign(secret, payload))) return null;
  const payloadBytes = decodeBase64Url(payload);
  if (!payloadBytes) return null;
  let ticket: Partial<CustomerVoiceTicket>;
  try { ticket = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payloadBytes)) as Partial<CustomerVoiceTicket>; }
  catch { return null; }
  if (ticket.version !== 1 || !ticket.tenantId || !ticket.spaceId || !ticket.bindingId || !ticket.agentId ||
    !ticket.callSid || ticket.callSid !== expectedCallSid || !ticket.caller || !ticket.called || !ticket.nonce ||
    !Number.isSafeInteger(ticket.issuedAt) || !Number.isSafeInteger(ticket.expiresAt) ||
    ticket.issuedAt! > now + 5_000 || ticket.expiresAt! <= now || ticket.expiresAt! - ticket.issuedAt! > CUSTOMER_VOICE_TICKET_TTL_MS) return null;
  return ticket as CustomerVoiceTicket;
}

export function parseTwilioVoiceCredentials(value: string | null | undefined): TwilioVoiceCredentials | null {
  if (!value || value.length > 4_096) return null;
  try {
    const data = JSON.parse(value) as { accountSid?: unknown; authToken?: unknown };
    if (typeof data.accountSid !== "string" || !/^AC[a-fA-F0-9]{32}$/.test(data.accountSid) ||
      typeof data.authToken !== "string" || data.authToken.length < 16 || data.authToken.length > 256) return null;
    return { accountSid: data.accountSid, authToken: data.authToken };
  } catch { return null; }
}

export async function generateCustomerVoiceCredentialToken(platformSecret: string, tenantId: string, spaceId: string): Promise<string> {
  const agentId = "naelao-agent";
  const timestamp = Math.floor(Date.now() / 1000);
  if (![tenantId, spaceId, agentId].every((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new Error("invalid_credential_token_scope");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(platformSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${tenantId}:${spaceId}:${agentId}::${timestamp}`));
  const hex = Array.from(new Uint8Array(sig)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},aid=${agentId},tid=${tenantId},v3=${hex}`;
}

export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

export function twilioFormParameters(rawBody: string): Record<string, string | string[]> {
  const parameters: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(rawBody)) {
    const existing = parameters[key];
    if (existing === undefined) parameters[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else parameters[key] = [existing, value];
  }
  return parameters;
}

export function validateTwilioFormWebhook(input: {
  authToken: string;
  signature: string | null;
  canonicalUrl: string;
  rawBody: string;
}): boolean {
  if (!input.signature || !input.authToken || !input.canonicalUrl.startsWith("https://")) return false;
  try { return validateRequest(input.authToken, input.signature, input.canonicalUrl, twilioFormParameters(input.rawBody)); }
  catch { return false; }
}

export function validateTwilioMediaStream(input: { authToken: string; signature: string | null; canonicalUrl: string }): boolean {
  if (!input.signature || !input.authToken || !input.canonicalUrl.startsWith("wss://")) return false;
  try { return validateRequest(input.authToken, input.signature, input.canonicalUrl, {}); }
  catch { return false; }
}

export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function twimlStreamResponse(streamUrl: string): string {
  const url = new URL(streamUrl);
  if (url.protocol !== "wss:" || url.search || url.hash || url.username || url.password) throw new Error("invalid_customer_voice_stream_url");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(url.toString())}" /></Connect></Response>`;
}

export function twimlRejectResponse(reason: "busy" | "rejected"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="${reason}" /></Response>`;
}

export function twimlConsentResponse(consentUrl: string): string {
  const url = new URL(consentUrl);
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) throw new Error("invalid_customer_voice_consent_url");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather action="${xmlEscape(url.toString())}" method="POST" numDigits="1" timeout="8" actionOnEmptyResult="true"><Say>This call uses an AI voice assistant. Audio is processed to provide responses. Calls are not recorded. Press 1 to continue.</Say></Gather><Say>Consent was not received. Goodbye.</Say><Hangup /></Response>`;
}
