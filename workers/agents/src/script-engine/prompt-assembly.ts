export interface BusinessContextBrief {
  businessName: string;
  templateType: string;
  currency: string;
  activeOfferings: Array<{ name: string; priceCents: number }>;
  complianceMode: "standard" | "hipaa" | "air_gapped";
  operatingJurisdiction?: string;
}

export interface PromptAssemblyInputs {
  businessContext: BusinessContextBrief;
  soulMarkdown: string;
  founderDirectives?: string;
  agentRole: string;
  activeWorkspacePath: string;
}

/**
 * Layer 1: Immutable Engine Directives (Claude Code Style)
 * Enforces rigorous tool execution, zero conversational filler, and surgical edits.
 */
export const BASE_OPERATING_KERNEL = `
# UNIVERSAL AGENT EXECUTION RULES
1. Identity: You are an autonomous functional engineer and operations specialist.
2. Direct Action: Never output conversational filler, polite preamble, or descriptive apologies. Execute tools immediately.
3. Code Editing: Always use 'Edit' for exact AST search-and-replace block patches. Never rewrite full files.
4. Inspection: Always use 'Read' with windowed line numbers (offset and limit) to inspect files before editing.
5. Verification: Always run tests or build checks via 'Bash' before declaring work complete.
6. Execution Discipline: If a command fails, inspect stderr, fix the specific error, and retry. Do not repeat failed commands identically.
7. Namespace Isolation: User application code lives under '/workspace/'. Internal state lives under '/.avos/'. Never write internal scripts into '/workspace/'.
`.trim();

/**
 * Assembles the full 4-layer dynamic system prompt.
 */
export function assembleSystemPrompt(inputs: PromptAssemblyInputs): string {
  const sections: string[] = [];

  // Layer 1: Universal Operating Kernel
  sections.push(BASE_OPERATING_KERNEL);

  // Layer 2: Living Business Identity
  const offeringsList = inputs.businessContext.activeOfferings.length > 0
    ? inputs.businessContext.activeOfferings.map(o => `  - ${o.name}: $${(o.priceCents / 100).toFixed(2)}`).join("\n")
    : "  - Standard Service Offerings";

  const businessContextBlock = `
# BUSINESS CONTEXT
- Entity Name: ${inputs.businessContext.businessName}
- Workspace Archetype: ${inputs.businessContext.templateType}
- Currency: ${inputs.businessContext.currency.toUpperCase()}
- Compliance Posture: ${inputs.businessContext.complianceMode.toUpperCase()}
- Active Offerings & Pricing:
${offeringsList}
- Active Working Directory: ${inputs.activeWorkspacePath}
`.trim();
  sections.push(businessContextBlock);

  // Layer 3: Agent Archetype & SOUL.md Directives
  const soulContent = inputs.soulMarkdown && inputs.soulMarkdown.trim().length > 0
    ? inputs.soulMarkdown.trim()
    : `# ROLE DIRECTIVES\nYou are operating as ${inputs.agentRole}. Focus strictly on your assigned domain objectives.`;
  sections.push(soulContent);

  // Layer 4: Founder Custom Directives (UI Overrides)
  if (inputs.founderDirectives && inputs.founderDirectives.trim().length > 0) {
    sections.push(`# FOUNDER OPERATING OVERRIDES\n${inputs.founderDirectives.trim()}`);
  }

  return sections.join("\n\n");
}
