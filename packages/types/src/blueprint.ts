export type TemplateOperatingMode = "autonomous_venture" | "vertical_cowork";

export interface CoworkStudioConfig {
  defaultViewport: "DocumentRedlineCanvas" | "SpreadsheetFormulaGrid" | "ClinicalSoapEditor" | "PlanSpecCanvas";
  enforceCitationFootnotes: boolean;
  auditLogRetentionDays: number; // e.g. 365 for HIPAA/Legal compliance
  airGappedModeAvailable: boolean;
  collaborativeMode: "realtime_crdt" | "git_pr_mesh";
}

export interface BusinessBlueprint {
  id: string; // e.g. "tpl_lexpulse_legal_v1"
  title: string;
  category: "LEGAL" | "FINANCE" | "HEALTHCARE" | "CONSTRUCTION" | "AGENCY" | "MICRO_SAAS";

  // The Core Operating Mode Switch
  templateMode: TemplateOperatingMode;

  description: string;
  version: string;
  author: {
    userId: string;
    name: string;
    royaltyRate: number; // 0.40 for referral, 0.20 for organic
  };

  // Optional Cowork Configuration (Required when templateMode === "vertical_cowork")
  coworkConfig?: CoworkStudioConfig;

  // Pre-configured project workspaces in this space
  projects: Array<{
    name: string;
    slug: string;
    kind: "product_dev" | "doc_studio" | "voice_agent" | "customer_bot" | "model_studio" | "growth_engine" | "app_studio";
    viewportComponent: string;
    allowedLadderTiers: Array<1 | 2 | 3 | 4 | 5 | 6>;
    defaultContainer?: string;
    plugins: string[];
    linterRules: string[];
    initialJournalGoals: Array<{ id: string; title: string; dependencies?: string[] }>;
  }>;

  // Domain Knowledge Seeds (Pre-indexed into Cloudflare AI Search)
  knowledgeSeeds: Array<{
    title: string;
    content: string;
    category: string;
    sourceDocumentUrl?: string;
  }>;
}
