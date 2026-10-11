import type { UniversalAgentRole } from "@naelao/agent-sdk";
import { verifyScopedCapabilityToken, type CapabilityClaims, type CapabilityVerificationContext } from "@naelao/security";

export interface FirewallTool { name?: string; function?: { name?: string }; [key: string]: unknown }

const SUPPORT_ALLOWED = /^(?:knowledge\.search|faq\.search|ticket\.(?:create|read)|tools\.(?:search|describe)|conversation\.search)$/i;
const GROWTH_DENIED = /(?:^|\.)(?:bash|terminal|container|compiler|code_exec|git)(?:\.|$)/i;
const UNIVERSAL_SHELL_SURFACE = /^(?:Bash|Read|Edit)$/;

export const ROLE_MAX_TIER: Record<UniversalAgentRole, number> = {
  CUSTOMER_SUPPORT: 2, GROWTH_OPERATOR: 4, DEV_OPERATOR: 6, ARCHITECT_DELEGATE: 6, CUSTOM: 6,
};

export function toolName(tool: FirewallTool | string): string {
  return typeof tool === "string" ? tool : tool.function?.name ?? tool.name ?? "";
}

export function isToolAllowedForRole(role: UniversalAgentRole, name: string, tier = 1): boolean {
  if (!name || tier > (ROLE_MAX_TIER[role] ?? 1)) return false;
  // Every Naelao runtime, including a leaf worker, uses the same Bash/Read/Edit action surface.
  // The execution ladder and the role's tier ceiling decide what the command may reach; role
  // policies still constrain every named platform capability behind that shell surface.
  if (UNIVERSAL_SHELL_SURFACE.test(name)) return true;
  if (role === "CUSTOMER_SUPPORT") return SUPPORT_ALLOWED.test(name);
  if (role === "GROWTH_OPERATOR") return !GROWTH_DENIED.test(name);
  return true;
}

/** Physically omit capabilities before a model can observe their definitions. */
export function sanitizeToolsForRole<T extends FirewallTool>(role: UniversalAgentRole, tools: readonly T[]): T[] {
  return tools.filter((tool) => isToolAllowedForRole(role, toolName(tool)));
}

/** Capability verification is performed before role filtering or tool execution. A model's role
 * label is never a substitute for an issuer-attested, scope-bound capability token. */
export async function authorizeToolCapability(token: string, secret: string, context: CapabilityVerificationContext, claims?: { operation?: string; resource?: string }): Promise<CapabilityClaims> {
  const verified = await verifyScopedCapabilityToken(token, secret, context);
  if (claims?.operation && verified.operation !== claims.operation) throw new Error("capability_denied:operation_mismatch");
  if (claims?.resource && verified.resource !== claims.resource) throw new Error("capability_denied:resource_mismatch");
  return verified;
}
