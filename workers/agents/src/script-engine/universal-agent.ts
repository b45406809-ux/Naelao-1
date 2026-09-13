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
  // Layer 4: Founder Custom Directives (manifest.prompts.userCustomDirectives)
  const systemPrompt = composeSystemPrompt(
    `${manifest.prompts.systemPrompt}

# AGENT SOUL
${manifest.prompts.soulMarkdown}`,
    businessContext,
    manifest.prompts.userCustomDirectives
  );

  // 2. Physical Capability Firewall (Tool Stripping)
  // The role firewall is enforced before the model sees tools. Native compilation is never
  // granted by a prompt: Tier 6 requires both a CUSTOM role and the explicit runtime flag.
  const requestedTools = manifest.runtime.allowNativeCompilation ? ["code-exec"] : [];
  const sanitizedTools = sanitizePrebuiltListForRole(manifest.role, requestedTools);

  // 3. Filesystem Scoping Boundary
  const workspacePath =
    manifest.scope === "SPACE_WIDE"
      ? `spaces/${spaceId ?? "default"}/workspace/`
      : `spaces/${spaceId ?? "default"}/projects/${manifest.projectId ?? "p1"}/workspace/`;

  // 4. Execution Ceiling Clamp
  const maxRoleTier = MAX_TIER_BY_ROLE[manifest.role] ?? 1;
  const requestedTier = manifest.runtime.allowNativeCompilation
    ? manifest.runtime.maxLadderTier
    : Math.min(manifest.runtime.maxLadderTier, 5);
  const effectiveMaxTier = Math.min(requestedTier, maxRoleTier) as 1 | 2 | 3 | 4 | 5 | 6;

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
    const stored = config.manifest as UniversalAgentManifest & { capabilities?: { maxTier?: number }; prompts: UniversalAgentManifest["prompts"] & { instructions?: string; userCustomInstructions?: string }; triggers?: { proactiveHeartbeat?: boolean; reactiveToThreads?: boolean } };
    // R2 manifests written before the unified contract are upgraded at read time, so every
    // NaelaoAgentDO turn receives one canonical manifest shape.
    if (stored.runtime) return { ...stored, prompts: { ...stored.prompts, userCustomDirectives: config.userCustomInstructions ?? stored.prompts.userCustomDirectives } };
    return {
      ...stored,
      avatar: "assistant",
      role: (stored.role as string) === "ARCHITECT_DELEGATE" ? "SPACE_ORCHESTRATOR" : stored.role,
      prompts: { systemPrompt: stored.prompts.systemPrompt, soulMarkdown: stored.prompts.instructions ?? "", userCustomDirectives: config.userCustomInstructions ?? stored.prompts.userCustomInstructions },
      runtime: { pinnedModelId: "default", maxLadderTier: (stored.capabilities?.maxTier ?? 5) as 1 | 2 | 3 | 4 | 5 | 6, allowNativeCompilation: false },
      autonomy: { ...stored.autonomy, requiresElicitationFor: (stored.autonomy as unknown as { requiresApprovalFor?: string[] }).requiresApprovalFor ?? [] },
      triggers: { hasStandingExecutiveCron: stored.triggers?.proactiveHeartbeat ?? false, reactiveToMentions: stored.triggers?.reactiveToThreads ?? true, reactiveToWebhooks: false },
    };
  }

  let role: AgentArchetypeRole = options?.role ?? "DEV_OPERATOR";
  if (!options?.role) {
    if (agentId.includes("support") || agentId.includes("customer")) role = "CUSTOMER_SUPPORT";
    else if (agentId.includes("growth") || agentId.includes("marketing") || agentId.includes("sales"))
      role = "GROWTH_OPERATOR";
    else if (agentId.includes("architect") || agentId === "naelao-agent") role = "SPACE_ORCHESTRATOR";
    else if (agentId.includes("dev") || agentId.includes("code")) role = "DEV_OPERATOR";
    else role = "CUSTOM";
  }

  const scope: AgentScope =
    options?.scope ?? (options?.projectId ? "PROJECT_BOUND" : "SPACE_WIDE");
  const maxTier = (MAX_TIER_BY_ROLE[role] ?? 5) as 1 | 2 | 3 | 4 | 5 | 6;

  return {
    id: agentId,
    name: name || (agentId === "naelao-agent" ? "Space Assistant" : agentId),
    avatar: "assistant",
    scope,
    projectId: options?.projectId,
    role,
    prompts: {
      systemPrompt: config.systemPrompt,
      soulMarkdown: config.agentsMd,
      userCustomDirectives: config.userCustomInstructions,
    },
    runtime: {
      pinnedModelId: "default",
      maxLadderTier: maxTier,
      allowNativeCompilation: false,
    },
    autonomy: {
      approvalMode:
        options?.approvalMode ??
        (scope === "SPACE_WIDE" ? "always_ask" : "gate_unless_listed"),
      autoApprovedActions: options?.autoApprovedActions ?? [],
      requiresElicitationFor: config.requiresApprovalFor ?? [],
    },
    triggers: {
      hasStandingExecutiveCron: scope === "SPACE_WIDE",
      reactiveToMentions: true,
      reactiveToWebhooks: scope === "SPACE_WIDE",
    },
  };
}
