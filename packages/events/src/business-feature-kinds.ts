/**
 * @naelao/events — Business Feature Projects registry (AUDIT_TODO F-34/F-41).
 *
 * Every "auto-provisioned business infrastructure" idea — wallet, storefront, business email,
 * CRM, support inbox, etc. — is modeled as ONE mechanism: a `projects.kind` value drawn from
 * this data-driven registry (mirroring LAUNCHPAD_TEMPLATES's own pattern, NOT a new DB table per
 * feature; consistent with CLAUDE.md ground rule #4 "SpaceType differences live in config...
 * never DB tables"). Each kind gets its own R2 workspace, its own thread, an optional
 * kind-specific prebuilt script surface, and an optional dashboard/shell UI panel.
 *
 * F-41 classification test (a kind BELONGS here only if it passes at least one):
 *   1. Bulky persistent content (real files / an ongoing thread), OR
 *   2. Independent access control (grant one teammate THIS without the others), OR
 *   3. Standing "place" semantics (a destination a builder navigates TO).
 * Anything that's really just an action the assistant performs is a SKILL, not a kind — so
 * brand_kit / bookkeeping / coupons / churn_retention / compliance_risk_monitor are deliberately
 * NOT here (they're skills that write into an existing kind's workspace).
 *
 * Pure, DO-agnostic data — SpaceDO validates `kind` against this at project-creation time, the
 * agents worker surfaces creatable kinds (role-filtered) in the project-template picker, and the
 * frontends mount the natively-built panel keyed by `uiPanel`.
 */

/** The space-level role a caller needs before this kind is even OFFERED as creatable. Ordered
 *  owner > admin > editor; the caller's own role must be >= this to see/create the kind. */
export type FeatureKindRole = "owner" | "admin" | "editor";

export interface BusinessFeatureKind {
  /** The `projects.kind` value. */
  kind: string;
  label: string;
  description: string;
  /** DB-enforced: at most one active project of this kind per space (partial unique index). */
  singleton: boolean;
  /** Who even SEES this as a creatable template (role-filtered server-side, not just UI-hidden). */
  minCreationRole: FeatureKindRole;
  /** Whether a template's bootstrap may auto-provision this kind (vs. created on demand only). */
  autoProvisionable: boolean;
  /** script-engine prebuilt names gated to this kind (informational; enforced by the engine). */
  prebuiltScripts?: string[];
  /** Frontend panel key — the shell mounts the natively-built panel for this kind (F-40). A kind
   *  with no built panel yet renders the shared workspace shell alone (expected incremental path). */
  uiPanel?: string;
  /** "Cursor for X" Custom Viewport component rendered in the project workspace canvas. */
  viewportComponent?:
    | "CodeWorkspace"
    | "DesignCanvas"
    | "SpreadsheetGrid"
    | "SpreadsheetFormulaGrid"
    | "CampaignBoard"
    | "WalletLedgerPanel"
    | "DocumentRedlineCanvas"
    | "ClinicalSoapEditor"
    | "PlanSpecCanvas"
    | "ModelStudioCanvas"
    | "AppStudioCanvas"
    | "VoiceAgentCanvas";
  /** Domain-specific system prompt injected into agents operating in this project. */
  domainSystemPrompt?: string;
  /** Scoped Execution Ladder tiers permitted for this plugin kind. */
  allowedLadderTiers?: number[];
  /** Domain linting and validation rules running in V8 isolate. */
  linterRules?: string[];
  /** Finite projects release compute once their deliverable has been certified. */
  lifecycle?: "finite" | "continuous";
}

/**
 * AVOS plan step 6 ("Cursor for X" Plugin System) proposed FOUR new fields here —
 * `viewportComponent`, `domainSystemPrompt`, `allowedLadderTiers`, `linterRules` — turning every
 * kind into a full plugin manifest (a dynamically-loaded custom React viewport, a per-kind
 * system-prompt supplement, a per-kind execution-tier ceiling, and a linting engine). Deliberately
 * NOT added: each would need its own real infrastructure with no other consumer today —
 * `viewportComponent` needs a dynamic-import component registry, `allowedLadderTiers` needs a
 * per-KIND (not per-script) tier gate the execution ladder has no concept of, and `linterRules`
 * needs a linting engine that doesn't exist anywhere in this codebase. `domainSystemPrompt` is the
 * one genuinely close to real (kinds like `crm`/`support_inbox` already get bespoke instructions
 * — but those live in the AGENT/template that operates the kind, e.g. Launchpad's own agent
 * profiles, not on the kind itself; a kind can be operated by more than one agent archetype, so a
 * single prompt fragment attached HERE would be exactly the split-brain CLAUDE.md's own ground
 * rule #4 warns against — "SpaceType differences live in config... never DB tables", and by the
 * same logic, never a second config surface competing with the one that already exists).
 *
 * What WAS real and got built instead (see HtmlPreviewFrame.tsx / Chat.tsx): a single, kind-
 * agnostic click-to-inspect visual canvas for any HTML file/artifact preview — genuinely useful
 * for the one real "viewport" this platform's agents actually produce today (a generated web
 * page), without inventing a manifest system for viewports that don't exist yet.
 */

const ROLE_RANK: Record<FeatureKindRole, number> = { editor: 1, admin: 2, owner: 3 };

/**
 * The registry. Naelao ships every kind preconfigured; a business template pre-selects which
 * subset it bootstraps; a builder can add/remove kinds later like any other project.
 * The two structural defaults (`workspace`, `customer_bot`) are intentionally NOT here — they are
 * not "business features", they're the base project shapes, and they carry no singleton/role gate.
 */
export const BUSINESS_FEATURE_KIND_REGISTRY: readonly BusinessFeatureKind[] = [
  {
    kind: "product_dev",
    label: "Product Development & Edge IDE",
    description: "Full-stack edge application development with live visual canvas and Astro/Tailwind hot-reloading.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: true,
    prebuiltScripts: ["r2-workspace", "file-manager", "code-exec", "workspace", "browser-use"],
    viewportComponent: "DesignCanvas",
    domainSystemPrompt: "You are an Edge Development Specialist. Use surgical search-and-replace patching with Edit and verify builds with Bash.",
    allowedLadderTiers: [1, 2, 3, 4, 5],
    linterRules: ["tailwind-syntax", "astro-typecheck", "html-structure"],
  },
  {
    kind: "wallet",
    label: "Wallet",
    description: "The business's earned-revenue balance and ledger — the money its AI is allowed to spend. Naelao-custodied.",
    singleton: true,
    minCreationRole: "admin",
    autoProvisionable: true,
    prebuiltScripts: ["wallet"],
    uiPanel: "wallet-ledger",
    viewportComponent: "WalletLedgerPanel",
    allowedLadderTiers: [1, 2],
  },
  {
    kind: "business_wallet",
    label: "Business Wallet",
    description: "The business's OWN bank account — a Whop sub-merchant wallet auto-provisioned at business creation. Real revenue in from Whop's storefront/checkout and connected 3rd-party platforms, real payouts out to the owner. A different concept from 'wallet' above (which pays for Naelao's own metered costs) — see business-wallet.ts's header.",
    singleton: true,
    minCreationRole: "admin",
    autoProvisionable: true,
    prebuiltScripts: ["business-wallet"],
    uiPanel: "business-wallet",
  },
  {
    kind: "storefront",
    label: "Storefront",
    description: "A product catalog + orders selling direct through Naelao's own checkout. For a business with no existing commerce platform (a whop-seller operates Whop's storefront via connector instead).",
    singleton: true,
    minCreationRole: "admin",
    autoProvisionable: true,
    uiPanel: "storefront-catalog",
  },
  {
    kind: "business_email",
    label: "Business Email",
    description: "A Naelao-provisioned mailbox with an AI-triaged shared inbox as the project's thread surface.",
    singleton: true,
    minCreationRole: "admin",
    autoProvisionable: true,
    prebuiltScripts: ["business-email"],
    uiPanel: "email-inbox",
  },
  {
    kind: "business_phone",
    label: "Business Phone",
    description: "A provisioned phone number wired into the channel gateway (SMS/voice), same pattern as WhatsApp/Discord ingress.",
    singleton: true,
    minCreationRole: "admin",
    autoProvisionable: false,
    uiPanel: "phone-inbox",
  },
  {
    kind: "crm",
    label: "CRM",
    description: "Contacts, notes, and a deal pipeline. Native default; a business already running HubSpot/etc should operate that via connector instead (a config choice, not hardcoded).",
    singleton: true,
    minCreationRole: "editor",
    autoProvisionable: true,
    uiPanel: "crm-pipeline",
  },
  {
    kind: "support_inbox",
    label: "Support Inbox",
    description: "A ticket queue with SLAs. Same native-default/connector caveat as CRM.",
    singleton: true,
    minCreationRole: "editor",
    autoProvisionable: true,
    uiPanel: "support-tickets",
  },
  {
    kind: "affiliate_program",
    label: "Affiliate Program",
    description: "Referral links + payouts settled through the business's own wallet/reseller_ledger — no 3rd-party equivalent to defer to.",
    singleton: true,
    minCreationRole: "admin",
    autoProvisionable: false,
    uiPanel: "affiliate-links",
  },
  {
    kind: "legal_compliance",
    label: "Legal & Compliance",
    description: "Auto-generated ToS/Privacy/Refund policies + an e-sign document vault. Plausibly wants tighter access than general operating notes.",
    singleton: true,
    minCreationRole: "admin",
    autoProvisionable: false,
    uiPanel: "legal-vault",
  },
  {
    kind: "analytics_dashboard",
    label: "Analytics",
    description: "Deliberately cross-cutting: reads ACROSS wallet (ledger), storefront (orders), and CRM (deals) rather than owning its own data. Each widget re-verifies access to its source kind on every refresh.",
    singleton: true,
    minCreationRole: "editor",
    autoProvisionable: false,
    uiPanel: "analytics-widgets",
  },
  {
    kind: "integrations_hub",
    label: "Integrations",
    description: "The OAuth connection grants for external platforms (the connector-operated pattern's own credential surface). Also absorbs social-media connections — publishing itself stays a skill.",
    singleton: true,
    minCreationRole: "admin",
    autoProvisionable: false,
    uiPanel: "integrations-list",
  },
  // Non-singleton, on-demand only — created when a specific effort is bulky enough (real
  // documents / a real ongoing thread) to justify standing infra; never auto-provisioned.
  {
    kind: "market_research",
    label: "Market Research",
    description: "A place for a bulky, ongoing research effort (real documents, a standing thread). Created on demand; multiple allowed.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: false,
  },
  {
    kind: "hiring_freelance",
    label: "Hiring & Freelance",
    description: "A place for a specific hiring/freelance-sourcing effort. Created on demand; multiple allowed.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: false,
  },
  // Vertical AI Cowork Studios ("Harvey AI for X", "Hebbia for X", "Clinica", "AcuBuild")
  {
    kind: "contract_redline",
    label: "Contract Analysis & Redline Studio",
    description: "AI-assisted contract redlining, indemnity clause risk detection, and side-by-side legal diffs.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: true,
    prebuiltScripts: ["knowledge-base", "file-manager", "artifacts"],
    viewportComponent: "DocumentRedlineCanvas",
    domainSystemPrompt: "You are a Legal Specialist and Contract Redliner. Detect indemnification risks, ambiguous warranties, and liability caps with exact clause citations.",
    allowedLadderTiers: [1, 2],
    linterRules: ["gdpr-check", "delaware-corp-statute", "indemnity-risk-scan"],
  },
  {
    kind: "litigation_discovery",
    label: "Litigation Discovery & Briefs",
    description: "Cross-references discovery documents, deposition transcripts, and case filings with semantic grounding.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: true,
    prebuiltScripts: ["knowledge-base", "file-manager", "web-search"],
    viewportComponent: "DocumentRedlineCanvas",
    domainSystemPrompt: "You are a Litigation Discovery Specialist. Cross-reference depositions and filings, citing exact exhibit and transcript line numbers.",
    allowedLadderTiers: [1, 2],
  },
  {
    kind: "sec_rag",
    label: "SEC 10-K & Financial RAG Studio",
    description: "EDGAR filing deep-RAG, footnote extraction, EBITDA adjustment reconciliation, and financial model formula grids.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: true,
    prebuiltScripts: ["web-search", "knowledge-base", "artifacts", "file-manager"],
    viewportComponent: "SpreadsheetFormulaGrid",
    domainSystemPrompt: "You are a Private Equity & Financial Analyst. Reconcile EBITDA, analyze SEC 10-K filings, and construct valuation comp models.",
    allowedLadderTiers: [1, 2, 3],
  },
  {
    kind: "memo_studio",
    label: "Investment Memo & Comps Studio",
    description: "Automated investment committee memos, valuation multiples, and deal thesis modeling.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: true,
    prebuiltScripts: ["knowledge-base", "artifacts", "file-manager"],
    viewportComponent: "SpreadsheetFormulaGrid",
    domainSystemPrompt: "You are an Investment Banking Analyst. Draft structured memos and compute trading multiples with real-time calculations.",
    allowedLadderTiers: [1, 2, 3],
  },
  {
    kind: "soap_notes",
    label: "Clinical SOAP Notes & EHR Studio",
    description: "Voice/transcript to structured SOAP clinical documentation with HIPAA PII sanitization.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: true,
    prebuiltScripts: ["knowledge-base", "file-manager", "artifacts"],
    viewportComponent: "ClinicalSoapEditor",
    domainSystemPrompt: "You are a Clinical Documentation Specialist. Convert patient encounters into structured SOAP notes with ICD-10 diagnostic suggestions.",
    allowedLadderTiers: [1, 2],
    linterRules: ["hipaa-pii-scrubber", "icd10-code-validator"],
  },
  {
    kind: "billing_icd10",
    label: "Medical Billing & Pre-Authorization",
    description: "Chart-to-code ICD-10/CPT suggestion engine and insurer pre-authorization appeal drafts.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: true,
    prebuiltScripts: ["knowledge-base", "artifacts"],
    viewportComponent: "ClinicalSoapEditor",
    domainSystemPrompt: "You are a Medical Coding & Pre-Authorization Specialist. Cross-reference CPT and ICD-10 codes against clinical guidelines.",
    allowedLadderTiers: [1, 2],
  },
  {
    kind: "building_code_rag",
    label: "Building Code & Plan Compliance",
    description: "IBC, ADA, and local municipal zoning code verification for architectural drawings and specifications.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: true,
    prebuiltScripts: ["knowledge-base", "file-manager", "artifacts"],
    viewportComponent: "PlanSpecCanvas",
    domainSystemPrompt: "You are a Building Code & Architectural Plan Specialist. Inspect specifications against IBC and local municipal codes.",
    allowedLadderTiers: [1, 2],
    linterRules: ["ibc-compliance-check", "ada-accessibility-scan"],
  },
  {
    kind: "subcontractor_rfp",
    label: "Subcontractor RFP & Change Orders",
    description: "Bid leveling comparison matrices, subcontractor scope tracking, and change order impact audits.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: true,
    prebuiltScripts: ["file-manager", "artifacts", "knowledge-base"],
    viewportComponent: "PlanSpecCanvas",
    domainSystemPrompt: "You are a General Contractor RFP & Estimating Specialist. Level subcontractor bids and calculate change order variances.",
    allowedLadderTiers: [1, 2],
  },
  {
    kind: "model_studio",
    label: "Model Training & Auto-Researcher Studio",
    description: "Convert company documentation into synthetic training data, fine-tune custom LoRA models, and deploy to your team's model picker.",
    singleton: false,
    minCreationRole: "admin",
    autoProvisionable: false,
    prebuiltScripts: ["file-manager", "artifacts", "knowledge-base", "code-exec"],
    viewportComponent: "ModelStudioCanvas",
    domainSystemPrompt: `You are an Auto-Researcher Machine Learning Engineer.
Your mission is to audit company documents, synthesize high-quality JSONL instruction datasets,
validate test splits, run LoRA fine-tuning benchmarks, and deploy certified custom models.`,
    allowedLadderTiers: [1, 2, 6],
    linterRules: ["jsonl-format-check", "dataset-leakage-guard", "pii-scrubber"],
    lifecycle: "finite",
  },
  {
    kind: "app_studio",
    label: "Micro-App & Tool Studio",
    description: "Prompt-to-application engine: generates sandboxed full-stack apps with private SQLite databases and Gatekeeper security.",
    singleton: false,
    minCreationRole: "editor",
    autoProvisionable: false,
    prebuiltScripts: ["micro-app", "code-exec", "artifacts", "file-manager"],
    viewportComponent: "AppStudioCanvas", // Live app runner + SQLite table viewer
    allowedLadderTiers: [1, 2],           // Isolate execution only
    domainSystemPrompt: `You are a Micro-App Synthesis Specialist. 
Generate clean HTML/Preact frontends and Hono backend routes using private in-DO SQLite tables. 
Always declare explicit Gatekeeper permission grants for required resources.`,
    linterRules: ["sql-injection-check", "gatekeeper-schema-validator"],
  },
  {
    kind: "voice_agent",
    label: "Voice Telephony & Call Desk",
    description: "24/7 AI voice phone receptionist powered by Cloudflare Calls and WebRTC with shared calendar booking.",
    singleton: false,
    minCreationRole: "admin",
    autoProvisionable: true,
    prebuiltScripts: ["knowledge-base", "file-manager", "notifications"],
    viewportComponent: "VoiceAgentCanvas", // Call dashboard + real-time waveform & live transcript
    allowedLadderTiers: [1, 2],           // Safe RAG + Calendar tools only
    domainSystemPrompt: `You are a professional Voice Receptionist speaking over a live phone call.
Rules:
1. Speak in short, conversational sentences (1-2 sentences max per turn).
2. Do not use markdown, emojis, or bullet points in your speech output.
3. Check company-wide calendar availability and confirm bookings atomically.`,
  },
];

export const VOICE_AGENT_KIND: BusinessFeatureKind = BUSINESS_FEATURE_KIND_REGISTRY.find(
  (k) => k.kind === "voice_agent"
)!;

/** The concrete Model Studio manifest for project provisioners and the shell. */
export const MODEL_STUDIO_KIND: BusinessFeatureKind = BUSINESS_FEATURE_KIND_REGISTRY.find(
  (k) => k.kind === "model_studio"
)!;

export const APP_STUDIO_KIND: BusinessFeatureKind = BUSINESS_FEATURE_KIND_REGISTRY.find(
  (k) => k.kind === "app_studio"
)!;

const KIND_MAP: Map<string, BusinessFeatureKind> = new Map(
  BUSINESS_FEATURE_KIND_REGISTRY.map((k) => [k.kind, k])
);

/** The two non-registry structural project shapes — always creatable, no singleton/role gate. */
export const STRUCTURAL_PROJECT_KINDS = ["workspace", "customer_bot"] as const;

/** Look up a registry entry (undefined for structural kinds or an unknown kind). */
export function getBusinessFeatureKind(kind: string): BusinessFeatureKind | undefined {
  return KIND_MAP.get(kind);
}

/** Is this a kind a project may be created with at all (structural OR a known feature kind)? */
export function isKnownProjectKind(kind: string): boolean {
  return (STRUCTURAL_PROJECT_KINDS as readonly string[]).includes(kind) || KIND_MAP.has(kind);
}

/** Does the given space-level role meet a kind's minimum creation role? */
export function roleMeetsMinimum(callerRole: string, minRole: FeatureKindRole): boolean {
  const caller = ROLE_RANK[callerRole as FeatureKindRole];
  return caller !== undefined && caller >= ROLE_RANK[minRole];
}

/**
 * The registry entries a caller with `callerRole` may create, for the project-template picker.
 * Role-filtered server-side (F-35) so a non-admin never even sees "Create Wallet" as an option.
 */
export function creatableFeatureKindsForRole(callerRole: string): BusinessFeatureKind[] {
  return BUSINESS_FEATURE_KIND_REGISTRY.filter((k) => roleMeetsMinimum(callerRole, k.minCreationRole));
}
