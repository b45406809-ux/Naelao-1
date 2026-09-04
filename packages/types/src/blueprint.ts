/**
 * Portable declaration for a Launchpad business template.  `template_mode` is deliberately
 * required: the shell and agent runtime must never infer autonomy from a template name.
 */
export interface BusinessBlueprint {
  id: string;
  title: string;
  category: "LEGAL" | "FINANCE" | "HEALTHCARE" | "CONSTRUCTION" | "AGENCY" | "MICRO_SAAS";
  template_mode: "autonomous_venture" | "vertical_cowork";
  description: string;
  version: string;
  author: { userId: string; name: string; royaltyRate: number };
  cowork_config?: {
    defaultViewport: "DocumentRedlineCanvas" | "SpreadsheetFormulaGrid" | "ClinicalSoapEditor" | "PlanSpecCanvas";
    enforceCitationFootnotes: boolean;
    auditLogRetentionDays: number;
    airGappedModeAvailable: boolean;
  };
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
  knowledge_seeds: Array<{ title: string; content: string; category: string; sourceDocumentUrl?: string }>;
}
