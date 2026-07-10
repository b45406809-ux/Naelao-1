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
}

const ROLE_RANK: Record<FeatureKindRole, number> = { editor: 1, admin: 2, owner: 3 };

/**
 * The registry. Naelao ships every kind preconfigured; a business template pre-selects which
 * subset it bootstraps; a builder can add/remove kinds later like any other project.
 * The two structural defaults (`workspace`, `customer_bot`) are intentionally NOT here — they are
 * not "business features", they're the base project shapes, and they carry no singleton/role gate.
 */
export const BUSINESS_FEATURE_KIND_REGISTRY: readonly BusinessFeatureKind[] = [
  {
    kind: "wallet",
    label: "Wallet",
    description: "The business's earned-revenue balance and ledger — the money its AI is allowed to spend. Naelao-custodied.",
    singleton: true,
    minCreationRole: "admin",
    autoProvisionable: true,
    prebuiltScripts: ["wallet"],
    uiPanel: "wallet-ledger",
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
];

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
