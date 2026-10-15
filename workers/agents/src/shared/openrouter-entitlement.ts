const OPENROUTER_CHAT_COMPLETIONS = "https://openrouter.ai/api/v1/chat/completions";
const PREFLIGHT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Explicit owner-triggered entitlement check. Sends no Space content and caps generation to
 * one token. A successful response proves this key/model pair accepted this request at this time;
 * it does not promise future availability or a fixed charge. */
export async function runOpenRouterEntitlementPreflight(args: {
  apiKey: string;
  modelId: string;
  fetcher?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; reason: "provider_rejected" | "provider_unavailable" | "invalid_response" }> {
  if (!args.apiKey || args.apiKey.length > 4096 || args.modelId.includes("://") || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(args.modelId)) {
    return { ok: false, reason: "invalid_response" };
  }
  let response: Response;
  try {
    response = await (args.fetcher ?? fetch)(OPENROUTER_CHAT_COMPLETIONS, {
      method: "POST",
      headers: { authorization: `Bearer ${args.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: args.modelId, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, stream: false }),
      redirect: "error",
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }
  if (response.status === 401 || response.status === 402 || response.status === 403 || response.status === 404) {
    return { ok: false, reason: "provider_rejected" };
  }
  if (!response.ok) return { ok: false, reason: "provider_unavailable" };
  try {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) return { ok: false, reason: "invalid_response" };
    const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    if (!Array.isArray(payload.choices) || payload.choices.length !== 1 || typeof payload.choices[0]?.message?.content !== "string") {
      return { ok: false, reason: "invalid_response" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid_response" };
  }
}
