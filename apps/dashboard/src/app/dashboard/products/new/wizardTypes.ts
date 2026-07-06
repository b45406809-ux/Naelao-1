// Three-Tier Platform Model, Phase 4 — the Product Creation Wizard's shared client-side state.
// There is no server-side "draft" concept: the wizard collects everything here across its steps
// and calls createBuilderProduct() exactly once, at "Review & Launch" (see
// docs/spec-appendix/A1-script-agents-and-space-assistants.md §A1.17, Phase 4).

export interface WizardState {
  // Step 1 — Identity
  name: string;
  productSlug: string;

  // Step 2 — Space-Type Selection (a Temple pre-fills spacetypeId + templateId)
  spacetypeId: string;
  templateId: string | null;
  templateName: string | null;

  // Step 3 — Auth Config
  authProvider: "naelao-native" | "clerk" | "custom-oidc" | "saml-sso";
  requireAdminApproval: boolean;
  allowedEmailDomains: string; // comma-separated input, split on submit

  // Step 4 — Pricing
  pricingModel: "free" | "credits" | "subscription" | "seats";
  creditsIncludedPerMonth: string;
  overageCreditsPriceCents: string;
  pricePerSeatCents: string;
  includedSeats: string;
  trialDays: string;

  // Step 5 — Domain (optional — can be configured later from Product Detail). Builders never
  // configure product UI/branding here — that's a Naelao-authored shell, never a per-builder
  // reskin (CLAUDE.md decision: "builders configure limits/templates/agents/monetization only,
  // never UI").
  customDomain: string;
}

export const INITIAL_WIZARD_STATE: WizardState = {
  name: "",
  productSlug: "",
  spacetypeId: "",
  templateId: null,
  templateName: null,
  authProvider: "naelao-native",
  requireAdminApproval: false,
  allowedEmailDomains: "",
  pricingModel: "free",
  creditsIncludedPerMonth: "",
  overageCreditsPriceCents: "",
  pricePerSeatCents: "",
  includedSeats: "",
  trialDays: "",
  customDomain: "",
};

export const SLUG_PATTERN = /^[a-z0-9-]{2,40}$/;

export interface StepProps {
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
}
