import { headerValue, type NormalizedProviderEvent, type ProviderEventAdapter, type VerifyWebhookInput } from "./types.js";

function constantTimeEqual(a: Uint8Array, b: Uint8Array) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!; return diff === 0; }
function decodeBase64(value: string) { const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0)); }

/** AgentMail (svix) signature check over `${svix-id}.${svix-timestamp}.${rawBody}`. Moved here unchanged from agentmail.ts (MR-EVT-6 pattern). */
export async function verifySvix(secret: string, headers: Headers | Record<string, string | undefined>, raw: string): Promise<boolean> {
  const idHeader = headerValue(headers, "svix-id") ?? "", timestamp = headerValue(headers, "svix-timestamp") ?? "", signature = headerValue(headers, "svix-signature") ?? "";
  if (!/^msg_[A-Za-z0-9_-]{1,200}$/.test(idHeader) || !/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : ""; if (!encoded) return false;
  let key: Uint8Array; try { key = decodeBase64(encoded); } catch { return false; }
  const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = `${idHeader}.${timestamp}.${raw}`; const expected = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(signed)));
  return signature.split(" ").some(part => { const match = /^v1,([A-Za-z0-9+/=]+)$/.exec(part); if (!match) return false; try { return constantTimeEqual(expected, decodeBase64(match[1]!)); } catch { return false; } });
}

export interface AgentMailWebhookFields { eventType: unknown; eventId: string; messageId: string; threadId: string; inboxId: unknown }
/** Pure field extraction shared by the route and the adapter; the route keeps its own status codes. */
export function readAgentMailEvent(event: Record<string, unknown>): AgentMailWebhookFields {
  const message = event.message as Record<string, unknown> | undefined; const thread = event.thread as Record<string, unknown> | undefined;
  return { eventType: event.event_type, eventId: typeof event.event_id === "string" ? event.event_id : "",
    messageId: typeof message?.message_id === "string" ? message.message_id : "",
    threadId: typeof message?.thread_id === "string" ? message.thread_id : (typeof thread?.thread_id === "string" ? thread.thread_id : ""),
    inboxId: message?.inbox_id };
}

export const agentMailProviderEventAdapter: ProviderEventAdapter = {
  provider: "agentmail",
  verifyWebhook: (input: VerifyWebhookInput) => verifySvix(input.secret, input.headers, input.rawBody),
  async normalizeWebhook(rawBody): Promise<NormalizedProviderEvent | null> {
    let event: Record<string, unknown>; try { event = JSON.parse(rawBody) as Record<string, unknown>; } catch { return null; }
    if (!event || typeof event !== "object") return null;
    const fields = readAgentMailEvent(event);
    if (fields.eventType !== "message.received" || !fields.eventId || !fields.messageId || !fields.threadId) return null;
    return { eventId: fields.eventId, eventType: "message.received", occurredAt: typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : new Date().toISOString(),
      resourceRef: typeof fields.inboxId === "string" ? fields.inboxId : null, data: { message_id: fields.messageId, thread_id: fields.threadId } };
  },
};
