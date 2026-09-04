/** The single declarative identity consumed by the universal NaelaoAgentDO kernel. */
export type AgentScope = "SPACE_WIDE" | "PROJECT_BOUND";
export type AgentArchetypeRole =
  | "SPACE_ORCHESTRATOR"
  | "DEV_OPERATOR"
  | "GROWTH_OPERATOR"
  | "CUSTOMER_SUPPORT"
  | "LEGAL_AUDITOR"
  | "CUSTOM";

export interface UniversalAgentManifest {
  id: string;
  name: string;
  avatar: string;
  scope: AgentScope;
  projectId?: string;
  role: AgentArchetypeRole;
  prompts: {
    systemPrompt: string;
    soulMarkdown: string;
    userCustomDirectives?: string;
  };
  runtime: {
    pinnedModelId: string;
    maxLadderTier: 1 | 2 | 3 | 4 | 5 | 6;
    allowNativeCompilation: boolean;
  };
  autonomy: {
    approvalMode: "always_ask" | "gate_unless_listed" | "yolo";
    autoApprovedActions: string[];
    requiresElicitationFor: string[];
  };
  triggers: {
    hasStandingExecutiveCron: boolean;
    reactiveToMentions: boolean;
    reactiveToWebhooks: boolean;
  };
}
