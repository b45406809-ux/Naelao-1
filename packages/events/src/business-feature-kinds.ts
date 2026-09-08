export interface BusinessFeatureKind {
  kind: string;
  label: string;
  description: string;
  viewportComponent: string;     // Refers to an installed Gadget/Viewport
  allowedLadderTiers: number[];
  defaultContainer?: string;
  lifecycle: "finite" | "continuous";
  domainSystemPrompt: string;
  linterRules: string[];
}

export const AVOS_PROJECT_KINDS: Record<string, BusinessFeatureKind> = {
  product_dev: {
    kind: "product_dev",
    label: "Product Engineering Studio",
    description: "Full-stack edge development.",
    viewportComponent: "CodeWorkspaceCanvas",
    allowedLadderTiers: [1, 2, 6],
    defaultContainer: "standard_node_linux",
    lifecycle: "finite",
    domainSystemPrompt: "You are a Senior Edge Engineer...",
    linterRules: ["typescript-strict", "no-secrets"]
  },
  doc_studio: {
    kind: "doc_studio",
    label: "Document Redline Studio",
    description: "Legal/Finance contract redlining.",
    viewportComponent: "DocumentRedlineCanvas",
    allowedLadderTiers: [1, 2],
    lifecycle: "finite",
    domainSystemPrompt: "You are a Legal Counsel...",
    linterRules: ["pii-scrubber"]
  },
  voice_agent: {
    kind: "voice_agent",
    label: "Voice Phone Desk",
    description: "24/7 AI Receptionist.",
    viewportComponent: "VoiceAgentCanvas",
    allowedLadderTiers: [1, 2],
    lifecycle: "continuous",
    domainSystemPrompt: "You are a Voice Receptionist...",
    linterRules: []
  },
  model_studio: {
    kind: "model_studio",
    label: "Model Customization Studio",
    description: "Fine-tuning and instruction alignment.",
    viewportComponent: "ModelStudioCanvas",
    allowedLadderTiers: [2, 6],
    lifecycle: "finite",
    domainSystemPrompt: "You are an AI Alignment Scientist...",
    linterRules: ["bias-checker"]
  },
  customer_bot: {
    kind: "customer_bot",
    label: "Customer Support Desk",
    description: "Automated support resolution.",
    viewportComponent: "CustomerBotCanvas",
    allowedLadderTiers: [1, 2],
    lifecycle: "continuous",
    domainSystemPrompt: "You are a customer satisfaction expert...",
    linterRules: ["toxicity-filter"]
  },
  growth_engine: {
    kind: "growth_engine",
    label: "Growth & Marketing Engine",
    description: "Campaign optimization and leads tracking.",
    viewportComponent: "GrowthEngineCanvas",
    allowedLadderTiers: [1, 2],
    lifecycle: "continuous",
    domainSystemPrompt: "You are a Growth Marketing Director...",
    linterRules: []
  },
  app_studio: {
    kind: "app_studio",
    label: "No-Code Application Studio",
    description: "Rapid internal tooling and dashboards.",
    viewportComponent: "AppStudioCanvas",
    allowedLadderTiers: [1, 2, 6],
    lifecycle: "continuous",
    domainSystemPrompt: "You are a UI Architect...",
    linterRules: []
  }
};
