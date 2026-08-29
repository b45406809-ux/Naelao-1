/**
 * Universal Agent Engine Architecture
 *
 * One universal execution kernel (NaelaoAgentDO) differentiates agents through
 * a Declarative Configuration Hierarchy. Whether an agent is the Autonomous 24/7 CEO
 * (Space Assistant), a Focused Coding Specialist (Project Agent), or a Custom User-Built
 * Agent (e.g. Tax Law Auditor), they all share the exact same REPL loop, token compressor,
 * and memory engine. They only differ in Scope, Instructions, Tool Surface, and Trigger Cadence.
 */

import type {
  UniversalAgentManifest,
  AgentArchetypeRole,
  AgentScope,
} from "@naelao/types";
import type { BusinessContext } from "../launchpad/business-context.js";
import {
  sanitizePrebuiltListForRole,
  MAX_TIER_BY_ROLE,
} from "./assistant-access.js";
import {
  composeSystemPrompt,
  UNIVERSAL_OPERATING_KERNEL,
} from "./reasoner.js";
import type { AgentConfig } from "./agent-config.js";

export { UNIVERSAL_OPERATING_KERNEL };

/**
 * Assembles the full runtime parameters for an agent from its UniversalAgentManifest
 * and optional runtime business context.
 */
export function assembleUniversalAgent(
  manifest: UniversalAgentManifest,
  businessContext?: BusinessContext,
  spaceId?: string
) {
  // 1. 4-Layer Dynamic Universal Prompt Assembly
  // Layer 1: Immutable Kernel (Claude Code REPL discipline, Edit AST, compaction, exit-0)
  // Layer 2: Live Enterprise Identity (BusinessContext)
  // Layer 3: Archetype Role & Mission (manifest.prompts.systemPrompt)
  // Layer 4: Founder Custom Directives (manifest.prompts.userCustomInstructions)
  const systemPrompt = composeSystemPrompt(
    manifest.prompts.systemPrompt,
    businessContext,
    manifest.prompts.userCustomInstructions
  );

  // 2. Physical Capability Firewall (Tool Stripping)
  const sanitizedTools = sanitizePrebuiltListForRole(
    manifest.role,
    manifest.capabilities.enabledPrebuilts
  );

  // 3. Filesystem Scoping Boundary
  const workspacePath =
    manifest.scope === "SPACE_WIDE"
      ? `spaces/${spaceId ?? "default"}/workspace/`
      : `spaces/${spaceId ?? "default"}/projects/${manifest.projectId ?? "p1"}/workspace/`;

  // 4. Execution Ceiling Clamp
  const maxRoleTier = manifest.role ? (MAX_TIER_BY_ROLE[manifest.role] ?? 5) : 5;
  const effectiveMaxTier = Math.min(
    manifest.capabilities.maxTier || 5,
    maxRoleTier
  ) as 1 | 2 | 3 | 4 | 5;

  return {
    systemPrompt,
    sanitizedTools,
    workspacePath,
    maxTier: effectiveMaxTier,
    autonomy: manifest.autonomy,
    triggers: manifest.triggers,
  };
}

/**
 * Convert an existing legacy AgentConfig + policy into a UniversalAgentManifest.
 */
export function agentConfigToManifest(
  agentId: string,
  name: string,
  config: AgentConfig,
  options?: {
    scope?: AgentScope;
    projectId?: string;
    role?: AgentArchetypeRole;
    approvalMode?: "always_ask" | "gate_unless_listed" | "yolo";
    autoApprovedActions?: string[];
  }
): UniversalAgentManifest {
  if (config.manifest) {
    return {
      ...config.manifest,
      prompts: {
        ...config.manifest.prompts,
        userCustomInstructions:
          config.userCustomInstructions ?? config.manifest.prompts.userCustomInstructions,
      },
    };
  }

  let role: AgentArchetypeRole = options?.role ?? "DEV_OPERATOR";
  if (!options?.role) {
    if (agentId.includes("support") || agentId.includes("customer")) role = "CUSTOMER_SUPPORT";
    else if (agentId.includes("growth") || agentId.includes("marketing") || agentId.includes("sales"))
      role = "GROWTH_OPERATOR";
    else if (agentId.includes("architect")) role = "ARCHITECT_DELEGATE";
    else if (agentId.includes("dev") || agentId.includes("code")) role = "DEV_OPERATOR";
    else role = "CUSTOM";
  }

  const scope: AgentScope =
    options?.scope ?? (options?.projectId ? "PROJECT_BOUND" : "SPACE_WIDE");
  const maxTier = (MAX_TIER_BY_ROLE[role] ?? 5) as 1 | 2 | 3 | 4 | 5;

  return {
    id: agentId,
    name: name || (agentId === "naelao-agent" ? "Space Assistant" : agentId),
    scope,
    projectId: options?.projectId,
    role,
    prompts: {
      systemPrompt: config.systemPrompt,
      instructions: config.agentsMd,
      userCustomInstructions: config.userCustomInstructions,
    },
    capabilities: {
      enabledPrebuilts: config.scripts.prebuilt,
      installedPlugins: [],
      maxTier,
    },
    autonomy: {
      approvalMode:
        options?.approvalMode ??
        (scope === "SPACE_WIDE" ? "always_ask" : "gate_unless_listed"),
      autoApprovedActions: options?.autoApprovedActions ?? [],
      requiresApprovalFor: config.requiresApprovalFor ?? [],
    },
    triggers: {
      proactiveHeartbeat: scope === "SPACE_WIDE",
      reactiveToThreads: true,
    },
  };
}
