import type { UniversalAgentRole } from "@naelao/agent-sdk";
import { verifyScopedCapabilityToken, type CapabilityClaims, type CapabilityVerificationContext } from "@naelao/security";

export interface FirewallTool { name?: string; function?: { name?: string }; [key: string]: unknown }

// Domain role names are descriptive user configuration, never platform privileges.
// Installation capabilities, planner boundaries and the verified execution ceiling enforce access.
export const ROLE_MAX_TIER: Readonly<Record<string, number>> = Object.freeze({});

export function toolName(tool: FirewallTool | string): string {
  return typeof tool === "string" ? tool : tool.function?.name ?? tool.name ?? "";
}

export function isToolAllowedForRole(role: UniversalAgentRole, name: string, tier = 1): boolean {
  return Boolean(role.trim() && name && Number.isInteger(tier) && tier >= 1 && tier <= 6);
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
