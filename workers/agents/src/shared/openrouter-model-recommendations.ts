import type { OpenRouterModelCandidate } from "./openrouter-model-catalog.js";

export type ModelRecommendationCategory = "general_text" | "vision_input" | "long_context" | "lower_published_cost";
export interface OpenRouterModelRecommendation {
  category: ModelRecommendationCategory;
  label: string;
  candidates: OpenRouterModelCandidate[];
  evidence: string;
}

/** Build an advisory shortlist from fields OpenRouter publishes. This is not a capability,
 * entitlement, benchmark, or activation check; missing metadata never receives an invented value. */
export function recommendOpenRouterModels(models: readonly OpenRouterModelCandidate[]): OpenRouterModelRecommendation[] {
  const byId = new Map<string, OpenRouterModelCandidate>();
  for (const model of models) if (model.id && !byId.has(model.id)) byId.set(model.id, model);
  const rows = [...byId.values()];
  const top = (items: OpenRouterModelCandidate[], compare: (a: OpenRouterModelCandidate, b: OpenRouterModelCandidate) => number) =>
    items.sort(compare).slice(0, 3);
  const contextDesc = (a: OpenRouterModelCandidate, b: OpenRouterModelCandidate) =>
    (b.contextLength ?? 0) - (a.contextLength ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const nameAsc = (a: OpenRouterModelCandidate, b: OpenRouterModelCandidate) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const costAsc = (a: OpenRouterModelCandidate, b: OpenRouterModelCandidate) =>
    ((a.promptPriceUsdPerToken ?? Number.POSITIVE_INFINITY) + (a.completionPriceUsdPerToken ?? Number.POSITIVE_INFINITY)) -
    ((b.promptPriceUsdPerToken ?? Number.POSITIVE_INFINITY) + (b.completionPriceUsdPerToken ?? Number.POSITIVE_INFINITY)) || contextDesc(a, b);
  const recommendations: OpenRouterModelRecommendation[] = [];
  const add = (category: ModelRecommendationCategory, label: string, candidates: OpenRouterModelCandidate[], evidence: string) => {
    const selected = top(candidates, category === "long_context" ? contextDesc : category === "lower_published_cost" ? costAsc : nameAsc);
    if (selected.length) recommendations.push({ category, label, candidates: selected, evidence });
  };
  add("general_text", "General text candidates", rows.filter(m => m.inputModalities?.includes("text") && m.outputModalities?.includes("text")), "Listed text input and text output modalities.");
  add("vision_input", "Image-input candidates", rows.filter(m => m.inputModalities?.includes("image") && m.outputModalities?.includes("text")), "Listed image input and text output modalities.");
  add("long_context", "Largest declared context", rows.filter(m => m.contextLength !== undefined), "Sorted by the catalog's declared context length.");
  add("lower_published_cost", "Lower published token prices", rows.filter(m => m.promptPriceUsdPerToken !== undefined && m.completionPriceUsdPerToken !== undefined), "Sorted by the sum of published per-token input and output prices; this is not an estimate of total request cost.");
  return recommendations;
}
