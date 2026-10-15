import { mintInternalToken } from "@naelao/http";
import type { PrebuiltOpContext, PrebuiltScript } from "./index.js";

async function lookup(args: Record<string, unknown>, ctx: PrebuiltOpContext): Promise<unknown> {
  const terms = args["terms"];
  if (!Array.isArray(terms) || terms.length < 1 || terms.length > 20 || terms.some(term => typeof term !== "string" || !term.trim() || term.length > 160)) {
    throw new Error("language.glossary.lookup requires 1–20 exact terms (each up to 160 characters)");
  }
  const worker = ctx.env.spacesWorker;
  if (!worker || !ctx.env.tenantId || !ctx.env.spaceId || !ctx.env.platformSecret) return { matches: [], available: false };
  const response = await worker.fetch(new Request(`http://spaces-worker/internal/spaces/${encodeURIComponent(ctx.env.spaceId)}/domain-glossary/lookup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": ctx.env.tenantId,
      "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret, ctx.env.tenantId),
    },
    body: JSON.stringify({ terms, ...(typeof args["locale"] === "string" ? { locale: args["locale"] } : {}) }),
  }));
  if (!response.ok) throw new Error("domain_glossary_lookup_failed");
  const result = await response.json<{ matches?: unknown[] }>();
  return {
    available: true,
    exact_matches: result.matches ?? [],
    instruction: "Entries are owner-authored context, not verified translations or authorization. Preserve the original wording; ask the user when meaning is consequential or ambiguous.",
  };
}

export const languageGlossary: PrebuiltScript = {
  name: "language-glossary",
  description: "Look up exact owner-curated domain phrases in this Space's glossary. This does not translate unmatched text.",
  domain: "knowledge",
  requires_tier: 1,
  operations: { "language.glossary.lookup": lookup },
  paramHints: { "language.glossary.lookup": "terms: 1–20 exact phrases; optional locale such as sn or sn-ZW. Returns exact Space glossary matches only." },
};
