export interface CredentialRequirement {
  name: string;
  service: string; // "stripe" | "github" | "google" | "twilio" | "whop" | "custom"
  description: string;
  optional: boolean;
}

export interface ExportedProjectBlueprint {
  name: string;
  slug: string;
  kind: string; // "product_dev" | "doc_studio" | "voice_agent" | "customer_bot" | etc.
  viewportComponent: string;
  allowedLadderTiers: number[];
  defaultContainer?: string;
  plugins: string[];
  linterRules: string[];
  initialJournalGoals: Array<{
    id: string;
    title: string;
    dependencies?: string[];
  }>;
  starterFiles: Array<{
    path: string;
    content: string;
    sizeBytes: number;
  }>;
}

export interface ExportedBlueprintManifest {
  blueprintId: string; // e.g. "tpl_1774900000_abc12"
  title: string;
  category: "LEGAL" | "FINANCE" | "HEALTHCARE" | "CONSTRUCTION" | "AGENCY" | "COMMERCE" | "MICRO_SAAS";
  templateMode: "autonomous_venture" | "vertical_cowork";
  description: string;
  version: string;
  author: {
    userId: string;
    email: string;
    name?: string;
  };
  pricingConfig?: {
    monetizationModel: "FREEMIUM_TIERED_SAAS" | "FIXED_ONE_OFF_UNLOCKED";
    fixedPriceCents?: number;
    monthlyPriceCents?: number;
  };
  projects: ExportedProjectBlueprint[];
  requiredCredentials: CredentialRequirement[];
  knowledgeSeeds: Array<{
    title: string;
    content: string;
    category?: string;
  }>;
  agentDirectives: {
    systemPromptSupplement?: string;
    standingMethodology?: string;
  };
  exportedAt: string;
}

export interface TemplateExportRequest {
  templateTitle: string;
  description: string;
  category: "LEGAL" | "FINANCE" | "HEALTHCARE" | "CONSTRUCTION" | "AGENCY" | "COMMERCE" | "MICRO_SAAS";
  monetizationModel: "FREEMIUM_TIERED_SAAS" | "FIXED_ONE_OFF_UNLOCKED";
  priceCents: number;
  includeKnowledgeSeeds?: boolean;
}

export interface SpaceExportSnapshot {
  spaceId: string;
  templateMode: "autonomous_venture" | "vertical_cowork";
  projects: Array<any>;
  workspaceFiles: Array<{ path: string; content: string; sizeBytes: number }>;
  credentialsDeclared: Array<{ name: string; service: string }>;
  knowledgeDocs: Array<{ title: string; content: string }>;
  taskGoals: Array<{ id: string; title: string; projectId: string }>;
}
