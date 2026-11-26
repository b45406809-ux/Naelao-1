import { headerValue, type NormalizedProviderEvent, type ProviderEventAdapter, type VerifyWebhookInput } from "./types.js";

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function firstMessage(rawBody: string): { message: Record<string, unknown> | undefined; value: Record<string, unknown> | undefined } {
  const parsed = JSON.parse(rawBody) as Record<string, unknown>;
  const entry = (parsed["entry"] as Array<Record<string, unknown>> | undefined)?.[0];
  const change = (entry?.["changes"] as Array<Record<string, unknown>> | undefined)?.[0];
  const value = change?.["value"] as Record<string, unknown> | undefined;
  const message = (value?.["messages"] as Array<Record<string, unknown>> | undefined)?.[0];
  return { message, value };
}

const str = (o: Record<string, unknown>, k: string): string | undefined => typeof o[k] === "string" ? o[k] as string : undefined;

// WhatsApp's Cloud API has no request-level timestamp header: the only timestamp is inside the message payload itself
// (entry[0].changes[0].value.messages[0].timestamp, epoch seconds), covered by the X-Hub-Signature-256 HMAC.
// Returns undefined for a status-callback payload (no `messages` array), which stays valid on signature alone.
export function extractWhatsAppMessageTimestamp(rawBody: string): number | undefined {
  try {
    const { message } = firstMessage(rawBody);
    const ts = message ? str(message, "timestamp") : undefined;
    return ts ? Number(ts) : undefined;
  } catch {
    return undefined;
  }
}

/** Meta Cloud API signing: HMAC-SHA256(rawBody, app_secret) vs X-Hub-Signature-256 (prefixed "sha256="). Moved here unchanged
 * from launchpad/channels.ts (MR-EVT-6); that adapter now delegates. Fail closed. */
export async function verifyMetaSignature(input: { rawBody: string; headers: Record<string, string | undefined> | Headers; secret: string }): Promise<boolean> {
  const header = headerValue(input.headers, "x-hub-signature-256") ?? undefined;
  if (!header?.startsWith("sha256=") || !input.secret) return false;
  const msgTimestamp = extractWhatsAppMessageTimestamp(input.rawBody);
  if (msgTimestamp !== undefined && Math.abs(Date.now() / 1000 - msgTimestamp) > 300) return false;
  try {
    const expected = `sha256=${await hmacSha256Hex(input.secret, input.rawBody)}`;
    return timingSafeEqual(expected, header);
  } catch {
    return false;
  }
}

export const metaProviderEventAdapter: ProviderEventAdapter = {
  provider: "meta",
  verifyWebhook: (input: VerifyWebhookInput) => verifyMetaSignature({ rawBody: input.rawBody, headers: input.headers, secret: input.secret }),
  async normalizeWebhook(rawBody): Promise<NormalizedProviderEvent | null> {
    let found: ReturnType<typeof firstMessage>;
    try { found = firstMessage(rawBody); } catch { return null; }
    const { message, value } = found;
    if (!message) return null; // status callback or malformed: not actionable
    const id = str(message, "id"), ts = str(message, "timestamp");
    if (!id || !/^[A-Za-z0-9_=.:-]{1,256}$/.test(id)) return null;
    const metadata = value?.["metadata"] as Record<string, unknown> | undefined;
    const phoneNumberId = metadata ? str(metadata, "phone_number_id") : undefined;
    const occurred = ts && Number.isFinite(Number(ts)) ? new Date(Number(ts) * 1000).toISOString() : new Date().toISOString();
    const type = str(message, "type");
    return { eventId: id, eventType: "message.received", occurredAt: occurred, resourceRef: phoneNumberId ?? null,
      data: { message_id: id, ...(type && /^[a-z_]{1,32}$/.test(type) ? { message_type: type } : {}) } };
  },
};
