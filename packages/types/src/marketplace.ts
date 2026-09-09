export type SecurityViolationSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface SecurityViolation {
  id: string;
  severity: SecurityViolationSeverity;
  category: "CAPABILITY_ESCALATION" | "PROMPT_INJECTION" | "EXFILTRATION_RISK" | "SANDBOX_CRASH";
  targetResource: string;
  description: string;
  recommendation: string;
}

export interface SecurityAuditReport {
  score: number;
  passed: boolean;
  auditedAt: string;
  violations: SecurityViolation[];
  sandboxExecutionTimeMs?: number;
  memoryPeakMb?: number;
}

export interface TemplatePublishSubmission {
  blueprintId: string;
  spaceId: string;
  submittedByUserId: string;
  requestedPricingModel: "FREEMIUM_TIERED_SAAS" | "FIXED_ONE_OFF_UNLOCKED";
  priceCents: number;
}

export interface ExportedBlueprintManifest {
  blueprintId: string;
  spaceId: string;
  projects: Array<{
    slug: string;
    name?: string;
    kind: string;
    allowedLadderTiers: number[];
    linterRules: string[];
  }>;
  knowledgeSeeds: Array<{
    title: string;
    content: string;
  }>;
}
