/** Bounded OpenRouter key validation and public catalog adapter. Catalog membership is a
 * candidate list only: it does not prove that a particular key can invoke every listed model. */
export interface OpenRouterModelCandidate {
  id: string;
  model: string;
  name: string;
  /** Provider/OpenRouter model-card summary; informational only and never used as policy. */
  description?: string;
  /** Model-card publication timestamp when supplied by OpenRouter. */
  createdAt?: number;
  contextLength?: number;
  promptPriceUsdPerToken?: number;
  completionPriceUsdPerToken?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  /** Provider-declared request features. This is catalog evidence, not proof of key entitlement. */
  supportedParameters?: string[];
  /** Timestamp when the public catalog snapshot was retrieved; emitted only by the live adapter. */
  catalogObservedAt?: string;
}

export type ModelModality = "text" | "image" | "audio" | "video";
export interface NormalizedModelCapabilities {
  source: "openrouter_public_catalog";
  observedAt: string | null;
  fresh: boolean;
  input: ReadonlySet<ModelModality>;
  output: ReadonlySet<ModelModality>;
  tools: boolean | null;
  contextTokens: number | null;
  inputUsdPerToken: number | null;
  outputUsdPerToken: number | null;
}

/** Convert sparse provider metadata into one explicit capability view. Missing fields stay
 * unknown; this adapter never infers media/tool support from the model name. */
export function normalizeOpenRouterCapabilities(candidate: OpenRouterModelCandidate, now = Date.now()): NormalizedModelCapabilities {
  const observed = candidate.catalogObservedAt ? Date.parse(candidate.catalogObservedAt) : Number.NaN;
  const allowed = new Set<ModelModality>(["text", "image", "audio", "video"]);
  const normalized = (items: string[] | undefined) => new Set((items ?? []).filter((item): item is ModelModality => allowed.has(item as ModelModality)));
  return {
    source: "openrouter_public_catalog",
    observedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : null,
    fresh: Number.isFinite(observed) && observed <= now && now - observed <= 15 * 60_000,
    input: normalized(candidate.inputModalities),
    output: normalized(candidate.outputModalities),
    tools: candidate.supportedParameters ? candidate.supportedParameters.includes("tools") : null,
    contextTokens: candidate.contextLength ?? null,
    inputUsdPerToken: candidate.promptPriceUsdPerToken ?? null,
    outputUsdPerToken: candidate.completionPriceUsdPerToken ?? null,
  };
}

const API = "https://openrouter.ai/api/v1";
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_MODELS = 2_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
let catalogCache: { expiresAt: number; observedAt: number; models: OpenRouterModelCandidate[] } | undefined;
let catalogPending: Promise<OpenRouterModelCandidate[]> | undefined;

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error("openrouter_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("openrouter_invalid_json");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) {
        void reader.cancel().catch(() => {});
        throw new Error("openrouter_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new Error("openrouter_invalid_json");
  }
  try { return JSON.parse(text); } catch { throw new Error("openrouter_invalid_json"); }
}

function optionalPrice(value: unknown): number | undefined {
  const price = typeof value === "string" && value.length <= 32 ? Number(value) : Number.NaN;
  return Number.isFinite(price) && price >= 0 && price <= 1 ? price : undefined;
}

function modalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string" && /^[a-z0-9_-]{1,32}$/i.test(item)).slice(0, 16);
  return result.length ? result : undefined;
}

function supportedParameters(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string" && /^[a-z0-9_-]{1,48}$/i.test(item)).slice(0, 64);
  return result.length ? result : undefined;
}

function parseCatalog(payload: unknown): OpenRouterModelCandidate[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) throw new Error("openrouter_catalog_shape_invalid");
  const seen = new Set<string>();
  const models: OpenRouterModelCandidate[] = [];
  for (const raw of rows.slice(0, MAX_CATALOG_MODELS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !MODEL_ID.test(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    const model: OpenRouterModelCandidate = {
      id: item.id,
      model: `openrouter/${item.id}`,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 240) : item.id,
      ...(typeof item.description === "string" && item.description.trim()
        ? { description: item.description.trim().slice(0, 2_000) } : {}),
      ...(Number.isSafeInteger(item.created) && Number(item.created) > 0
        ? { createdAt: Number(item.created) } : {}),
      ...(Number.isSafeInteger(item.context_length) && Number(item.context_length) > 0 && Number(item.context_length) <= 10_000_000
        ? { contextLength: Number(item.context_length) } : {}),
    };
    const pricing = item.pricing && typeof item.pricing === "object" ? item.pricing as Record<string, unknown> : {};
    const prompt = optionalPrice(pricing.prompt), completion = optionalPrice(pricing.completion);
    if (prompt !== undefined) model.promptPriceUsdPerToken = prompt;
    if (completion !== undefined) model.completionPriceUsdPerToken = completion;
    const architecture = item.architecture && typeof item.architecture === "object" ? item.architecture as Record<string, unknown> : {};
    const input = modalities(architecture.input_modalities), output = modalities(architecture.output_modalities);
    if (input) model.inputModalities = input;
    if (output) model.outputModalities = output;
    const params = supportedParameters(item.supported_parameters);
    if (params) model.supportedParameters = params;
    models.push(model);
  }
  return models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Auth/key validates the supplied key. `/models` is the public catalog; OpenRouter does not
 * expose key-specific per-model entitlements through this adapter, so callers must still handle
 * provider 401/402/404 responses at inference time. */
export async function fetchOpenRouterCatalog(
  apiKey: string,
  options: { fetch?: typeof globalThis.fetch; now?: number; cacheMs?: number } = {},
): Promise<OpenRouterModelCandidate[]> {
  if (!apiKey.trim() || apiKey.length > 4096) throw new Error("openrouter_key_invalid");
  const now = options.now ?? Date.now();
  const fetcher = options.fetch ?? globalThis.fetch;
  const validated = await fetcher(`${API}/auth/key`, {
    method: "GET", headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: AbortSignal.timeout(8_000),
  });
  if (!validated.ok) throw new Error(validated.status === 401 ? "openrouter_key_rejected" : `openrouter_key_validation_failed_${validated.status}`);
  const keyInfo = await boundedJson(validated, 64 * 1024) as { data?: unknown };
  if (!keyInfo || typeof keyInfo !== "object" || !keyInfo.data || typeof keyInfo.data !== "object") throw new Error("openrouter_key_response_invalid");

  if (catalogCache && catalogCache.expiresAt > now) return catalogCache.models.map(model => ({ ...model,
    catalogObservedAt: new Date(catalogCache!.observedAt).toISOString(),
    ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}),
    ...(model.outputModalities ? { outputModalities: [...model.outputModalities] } : {}),
  }));
  if (!catalogPending) {
    catalogPending = (async () => {
      const response = await fetcher(`${API}/models`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`openrouter_catalog_unavailable_${response.status}`);
      return parseCatalog(await boundedJson(response, MAX_CATALOG_BYTES));
    })();
  }
  try {
    const models = await catalogPending;
    catalogCache = { expiresAt: now + (options.cacheMs ?? 15 * 60_000), observedAt: now, models };
    return models.map(model => ({ ...model,
      catalogObservedAt: new Date(catalogCache!.observedAt).toISOString(),
      ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}),
      ...(model.outputModalities ? { outputModalities: [...model.outputModalities] } : {}),
    }));
  } finally {
    catalogPending = undefined;
  }
}

/** Isolated catalog parser test hook; not exported from the public Agents worker API. */
export const openRouterCatalogForTest = {
  parse: parseCatalog,
  reset: () => { catalogCache = undefined; catalogPending = undefined; },
};

/** A dynamic BYOK model is eligible for Naelao's tool-using planner only when the public
 * provider catalog explicitly declares text input/output and tool support. Key entitlement is
 * still tested by the real inference call, which never falls back to platform billing. */
export function isOpenRouterPlannerCandidate(candidate: OpenRouterModelCandidate | undefined, now = Date.now()): boolean {
  if (!candidate) return false;
  const capability = normalizeOpenRouterCapabilities(candidate, now);
  return Boolean(candidate
    && capability.fresh
    && candidate.model.startsWith("openrouter/")
    // The generic planner defaults unknown catalog models to a 200k context. Refuse a dynamic
    // model with a smaller or undisclosed window until the runtime carries an explicit limit.
    && capability.contextTokens !== null
    && capability.contextTokens >= 200_000
    && capability.input.has("text")
    && capability.output.has("text")
    && capability.tools === true
    && capability.inputUsdPerToken !== null
    && capability.outputUsdPerToken !== null);
}
