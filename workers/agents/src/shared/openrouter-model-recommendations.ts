import type { OpenRouterModelCandidate } from "./openrouter-model-catalog.js";

export type ModelRecommendationCategory = "general_text" | "vision_input" | "long_context" | "lower_published_cost" | "tool_workers" | "long_context_workers" | "free_tool_workers";
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
    const selected = top(candidates, category === "long_context" || category === "long_context_workers"
      ? contextDesc : category === "lower_published_cost" || category === "free_tool_workers" ? costAsc : nameAsc);
    if (selected.length) recommendations.push({ category, label, candidates: selected, evidence });
  };
  add("general_text", "General text candidates", rows.filter(m => m.inputModalities?.includes("text") && m.outputModalities?.includes("text")), "Listed text input and text output modalities.");
  add("vision_input", "Image-input candidates", rows.filter(m => m.inputModalities?.includes("image") && m.outputModalities?.includes("text")), "Listed image input and text output modalities.");
  add("long_context", "Largest declared context", rows.filter(m => m.contextLength !== undefined), "Sorted by the catalog's declared context length.");
  add("lower_published_cost", "Lower published token prices", rows.filter(m => m.promptPriceUsdPerToken !== undefined && m.completionPriceUsdPerToken !== undefined), "Sorted by the sum of published per-token input and output prices; this is not an estimate of total request cost.");
  // These are discovery shortlists for planner/worker model selection, not activation grants.
  // Require explicit provider declarations for text, tool calls, context and price. OpenRouter's
  // own catalog remains the source of truth because this inventory changes frequently.
  const workerCandidates = rows.filter(m => m.inputModalities?.includes("text")
    && m.outputModalities?.includes("text") && m.supportedParameters?.includes("tools")
    && (m.contextLength ?? 0) >= 200_000
    && m.promptPriceUsdPerToken !== undefined && m.completionPriceUsdPerToken !== undefined);
  add("tool_workers", "Tool capable worker candidates", workerCandidates,
    "OpenRouter declares text input/output, tool support, at least 200k context and both token prices. Key entitlement and runtime compatibility still require activation/preflight.");
  add("long_context_workers", "Long-context tool workers", workerCandidates,
    "Same provider-declared worker requirements, ranked by declared context length.");
  add("free_tool_workers", "Free tool-capable workers", workerCandidates.filter(m =>
    m.promptPriceUsdPerToken === 0 && m.completionPriceUsdPerToken === 0),
  "OpenRouter currently lists both token prices as zero and declares tool support. Free endpoints may be rate-limited, unavailable, or change price; recheck the live card before dispatch.");
  return recommendations;
}
