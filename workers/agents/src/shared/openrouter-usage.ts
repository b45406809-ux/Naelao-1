export interface OpenRouterGenerationExpectation {
  generationId: string;
  model: string;
  reservedAt: number;
  maxTokens: number;
  maxCredits: number;
}

export interface VerifiedOpenRouterUsage {
  generationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: number;
}

const GENERATION_ID = /^gen-[A-Za-z0-9-]{1,124}$/;
const MAX_GENERATION_RESPONSE_BYTES = 64 * 1024;

/** Parse only OpenRouter's authenticated generation metadata; never use provider prose as usage evidence. */
export function verifyOpenRouterGenerationUsage(value: unknown, expected: OpenRouterGenerationExpectation, now = Date.now()): VerifiedOpenRouterUsage | null {
  const envelope = value as { data?: unknown } | null;
  const data = envelope?.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const generationId = data.id;
  const model = data.model;
  const inputTokens = data.tokens_prompt;
  const outputTokens = data.tokens_completion;
  const costUsd = data.total_cost;
  const createdAt = typeof data.created_at === "string" ? Date.parse(data.created_at) : Number.NaN;
  if (typeof generationId !== "string" || !GENERATION_ID.test(generationId) || generationId !== expected.generationId ||
      typeof model !== "string" || model !== expected.model ||
      !Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0 ||
      !Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0 ||
      typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0 || !Number.isSafeInteger(Math.ceil(costUsd * 10_000)) ||
      !Number.isFinite(createdAt) || createdAt < expected.reservedAt - 30_000 || createdAt > now + 30_000) return null;
  const tokens = (inputTokens as number) + (outputTokens as number);
  const credits = Math.ceil((costUsd as number) * 10_000);
  if (!Number.isSafeInteger(tokens) || tokens > expected.maxTokens || credits > expected.maxCredits) return null;
  return { generationId, model, inputTokens: inputTokens as number, outputTokens: outputTokens as number, costUsd: costUsd as number, createdAt };
}

export function retryDelayMs(retryAfter: string | null, attempt: number, now = Date.now()): number {
  const fallback = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(7, Math.max(0, attempt - 1)));
  if (!retryAfter) return fallback;
  const seconds = Number(retryAfter);
  const parsed = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(retryAfter);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1_000, Math.min(60 * 60_000, parsed - now));
}

export async function readOpenRouterGenerationJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_GENERATION_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("openrouter_generation_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("openrouter_generation_response_unavailable");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_GENERATION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("openrouter_generation_response_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown; }
  catch { throw new Error("openrouter_generation_response_invalid"); }
}

export type OpenRouterGenerationLookup =
  | { state: "verified"; usage: VerifiedOpenRouterUsage }
  | { state: "retry"; reason: string; retryAfter: string | null }
  | { state: "review"; reason: string };

/** Fetch generation metadata without ever returning provider error bodies to logs or callers. */
export async function fetchOpenRouterGenerationUsage(
  fetcher: typeof fetch,
  apiKey: string,
  expected: OpenRouterGenerationExpectation,
  now = Date.now(),
): Promise<OpenRouterGenerationLookup> {
  const url = new URL("https://openrouter.ai/api/v1/generation");
  url.searchParams.set("id", expected.generationId);
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { state: "retry", reason: "generation_lookup_network_error", retryAfter: null };
  }
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    await response.body?.cancel().catch(() => undefined);
    return response.status === 401 || response.status === 403
      ? { state: "review", reason: "generation_lookup_authorization_failed" }
      : { state: "retry", reason: `generation_lookup_http_${response.status}`, retryAfter };
  }
  let body: unknown;
  try { body = await readOpenRouterGenerationJson(response); }
  catch { return { state: "retry", reason: "generation_lookup_response_invalid", retryAfter: null }; }
  const usage = verifyOpenRouterGenerationUsage(body, expected, now);
  return usage ? { state: "verified", usage } : { state: "review", reason: "generation_receipt_unverifiable" };
}
