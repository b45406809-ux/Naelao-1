import type { UniversalAgentRole } from "@naelao/agent-sdk";

export interface FirewallTool { name?: string; function?: { name?: string }; [key: string]: unknown }

const FILE_OR_TERMINAL = /^(?:Bash|Read|Write|Edit|Grep|Glob|execute_bash|patch_file)$|(?:^|\.)(?:bash|terminal|container|git|file|workspace)(?:\.|$)/i;
const SUPPORT_ALLOWED = /^(?:knowledge\.search|faq\.search|ticket\.(?:create|read)|tools\.(?:search|describe)|conversation\.search)$/i;
const GROWTH_DENIED = /(?:^|\.)(?:bash|terminal|container|compiler|code_exec|git)(?:\.|$)/i;

export const ROLE_MAX_TIER: Record<UniversalAgentRole, number> = {
  CUSTOMER_SUPPORT: 2, GROWTH_OPERATOR: 4, DEV_OPERATOR: 6, ARCHITECT_DELEGATE: 6, CUSTOM: 6,
};

export function toolName(tool: FirewallTool | string): string {
  return typeof tool === "string" ? tool : tool.function?.name ?? tool.name ?? "";
}

export function isToolAllowedForRole(role: UniversalAgentRole, name: string, tier = 1): boolean {
  if (!name || tier > (ROLE_MAX_TIER[role] ?? 1)) return false;
  if (role === "CUSTOMER_SUPPORT") return SUPPORT_ALLOWED.test(name) && !FILE_OR_TERMINAL.test(name);
  if (role === "GROWTH_OPERATOR") return !GROWTH_DENIED.test(name) && !FILE_OR_TERMINAL.test(name);
  return true;
}

/** Physically omit capabilities before a model can observe their definitions. */
export function sanitizeToolsForRole<T extends FirewallTool>(role: UniversalAgentRole, tools: readonly T[]): T[] {
  return tools.filter((tool) => isToolAllowedForRole(role, toolName(tool)));
}
