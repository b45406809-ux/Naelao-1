import { validateRequest } from "twilio/lib/webhooks/webhooks.js";

export interface TwilioVoiceCredentials { accountSid: string; authToken: string }

export function parseTwilioVoiceCredentials(value: string | null | undefined): TwilioVoiceCredentials | null {
  if (!value || value.length > 4_096) return null;
  try {
    const data = JSON.parse(value) as { accountSid?: unknown; authToken?: unknown };
    if (typeof data.accountSid !== "string" || !/^AC[a-fA-F0-9]{32}$/.test(data.accountSid) ||
      typeof data.authToken !== "string" || data.authToken.length < 16 || data.authToken.length > 256) return null;
    return { accountSid: data.accountSid, authToken: data.authToken };
  } catch { return null; }
}

/** Short-lived credential-vault capability scoped to the phone transport. */
export async function generatePhoneCredentialToken(platformSecret: string, tenantId: string, spaceId: string): Promise<string> {
  const agentId = "naelao-agent";
  const timestamp = Math.floor(Date.now() / 1000);
  if (![tenantId, spaceId, agentId].every(value => /^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new Error("invalid_credential_token_scope");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(platformSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${tenantId}:${spaceId}:${agentId}::${timestamp}`));
  const hex = Array.from(new Uint8Array(sig)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},aid=${agentId},tid=${tenantId},v3=${hex}`;
}

export function isE164(value: string): boolean { return /^\+[1-9]\d{7,14}$/.test(value); }

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

export function validateTwilioFormWebhook(input: { authToken: string; signature: string | null; canonicalUrl: string; rawBody: string }): boolean {
  if (!input.signature || !input.authToken || !input.canonicalUrl.startsWith("https://")) return false;
  try { return validateRequest(input.authToken, input.signature, input.canonicalUrl, twilioFormParameters(input.rawBody)); }
  catch { return false; }
}

export function validateTwilioMediaStream(input: { authToken: string; signature: string | null; canonicalUrl: string }): boolean {
  if (!input.signature || !input.authToken || !input.canonicalUrl.startsWith("wss://")) return false;
  try { return validateRequest(input.authToken, input.signature, input.canonicalUrl, {}); }
  catch { return false; }
}
