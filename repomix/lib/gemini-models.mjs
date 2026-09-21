const NON_TEXT_MODEL = /(?:image|live|tts|transcrib|translate)/i;

export const DEFAULT_GEMINI_3_MODELS = [
  "gemini-3.1-pro-preview",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
];

export function parseModelList(value) {
  return [...new Set(String(value ?? "").split(",").map((model) => model.trim().replace(/^models\//, "")).filter((model) => /^gemini-3(?:[.-]|$)/.test(model) && !NON_TEXT_MODEL.test(model)))];
}

export function availableTextModels(catalog) {
  return (catalog?.models ?? []).filter((model) => {
    const name = String(model.name ?? "").replace(/^models\//, "");
    return /^gemini-3(?:[.-]|$)/.test(name) && !NON_TEXT_MODEL.test(name) && (model.supportedGenerationMethods ?? []).includes("generateContent");
  }).map((model) => String(model.name).replace(/^models\//, ""));
}

function capabilityScore(model) {
  const version = [...model.matchAll(/(?:^|[.-])(\d+)(?:\.(\d+))?/g)].at(-1);
  const numeric = version ? Number(version[1]) * 100 + Number(version[2] ?? 0) : 0;
  return (model.includes("pro") ? 10_000 : model.includes("flash-lite") ? 0 : 5_000) + numeric + (model.includes("preview") ? -1 : 0);
}

export function rankModels(configured, discovered = []) {
  const candidates = [...new Set([...configured, ...discovered])].filter((model) => /^gemini-3(?:[.-]|$)/.test(model) && !NON_TEXT_MODEL.test(model));
  return candidates.sort((a, b) => capabilityScore(b) - capabilityScore(a) || a.localeCompare(b));
}

export function retryDelayMs(status, retryAfter, attempt) {
  if (![408, 429, 500, 502, 503, 504].includes(status)) return 0;
  return Math.max(Number(retryAfter || 0) * 1000, Math.min(30_000, 2 ** attempt * 1000));
}
