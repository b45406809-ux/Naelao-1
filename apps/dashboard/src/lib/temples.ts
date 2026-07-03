// Three-Tier Platform Model, Phase 4 — the wizard's "Temple Gallery" step.
//
// The spec describes Temples as Naelao-curated, fully pre-configured starting points spanning
// many SpaceTypes (legal, coding, nonprofit grants, real estate, tutoring...). Today only ONE
// SpaceType is actually seeded and working (Launchpad — see CLAUDE.md's "start with Launchpad"
// direction and docs/spec-appendix A1.17). Rather than fabricate Temple entries for SpaceTypes
// that don't exist yet, this wraps the REAL, already-built, already-tested Launchpad templates
// (workers/agents/src/launchpad/spacetype.ts's LAUNCHPAD_TEMPLATES, served via the existing
// GET /templates route and getTemples() client function) as the honest Temple catalogue for now.
// When more SpaceTypes ship, their own real templates extend this the same way — no separate
// Temple registry/backend needed for what exists today.

import { getTemplates } from "./api";
import type { TemplateInfo } from "./api";

export interface Temple {
  id: string;
  name: string;
  description: string;
  spacetypeId: string;
  freeTierEligible: boolean;
}

export async function getTemplesForWizard(): Promise<Temple[]> {
  const templates = await getTemplates();
  return templates
    .filter((t: TemplateInfo) => !t.coming_soon)
    .map((t: TemplateInfo) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      spacetypeId: "launchpad",
      freeTierEligible: t.free_tier_eligible,
    }));
}
