export type AgentRoleType = 
  | "SPACE_ORCHESTRATOR" 
  | "ARCHITECT_DELEGATE" 
  | "DEV_OPERATOR" 
  | "GROWTH_OPERATOR" 
  | "CUSTOMER_SUPPORT" 
  | "VOICE_OPERATOR" 
  | "MODEL_RESEARCHER"
  | "CUSTOM";

export interface FirewallPolicy {
  allowedToolNames: string[];
  blockedToolNames: string[];
  maxLadderTier: 1 | 2 | 3 | 4 | 5 | 6;
  allowCodeExecution: boolean;
}

export const ROLE_FIREWALL_POLICIES: Record<AgentRoleType, FirewallPolicy> = {
  // Master Orchestrator (Space Assistant): High-level coordination, no direct code patching
  SPACE_ORCHESTRATOR: {
    allowedToolNames: ["Read", "Delegate", "Browser"],
    blockedToolNames: ["Write", "Edit"],
    maxLadderTier: 3,
    allowCodeExecution: false
  },

  // System Architect: Generates Task DAGs and specifications, does not edit raw code
  ARCHITECT_DELEGATE: {
    allowedToolNames: ["Read", "Delegate"],
    blockedToolNames: ["Write", "Edit", "Bash"],
    maxLadderTier: 2,
    allowCodeExecution: false
  },

  // Developer Operator: Full codebase access, build tools, AST editing, and container compilation
  DEV_OPERATOR: {
    allowedToolNames: ["Bash", "Read", "Edit", "Browser", "Delegate"],
    blockedToolNames: [],
    maxLadderTier: 6,
    allowCodeExecution: true
  },

  // Growth Operator: Browsing, scraping, email outreach, analytics; no heavy containers or code patching
  GROWTH_OPERATOR: {
    allowedToolNames: ["Bash", "Read", "Browser", "Delegate"],
    blockedToolNames: ["Edit", "Write"],
    maxLadderTier: 4,
    allowCodeExecution: true // Virtual CLIs only
  },

  // Customer Support Bot: Clamped to Tier 1 in-memory RAG. ZERO bash, zero editing, zero code
  CUSTOMER_SUPPORT: {
    allowedToolNames: ["Read"],
    blockedToolNames: ["Bash", "Edit", "Write", "Browser", "Delegate"],
    maxLadderTier: 1,
    allowCodeExecution: false
  },

  // Voice Receptionist: Clamped to Tier 1 Safe RAG
  VOICE_OPERATOR: {
    allowedToolNames: ["Read"],
    blockedToolNames: ["Bash", "Edit", "Write", "Browser", "Delegate"],
    maxLadderTier: 1,
    allowCodeExecution: false
  },

  // Model Researcher: Dataset synthesis, LoRA fine-tuning, benchmark evaluation
  MODEL_RESEARCHER: {
    allowedToolNames: ["Bash", "Read", "Write", "Delegate"],
    blockedToolNames: ["Edit"],
    maxLadderTier: 6,
    allowCodeExecution: true
  },

  // Default Custom Fallback
  CUSTOM: {
    allowedToolNames: ["Read"],
    blockedToolNames: ["Bash", "Edit", "Write"],
    maxLadderTier: 2,
    allowCodeExecution: false
  }
};

/**
 * Helper to resolve an AgentRoleType from agentId, projectId, or role hints.
 */
export function resolveAgentRole(agentId?: string, projectId?: string, roleHint?: string): AgentRoleType {
  if (roleHint && roleHint in ROLE_FIREWALL_POLICIES) {
    return roleHint as AgentRoleType;
  }
  if (roleHint === "customer" || roleHint === "product_end_user") {
    return "CUSTOMER_SUPPORT";
  }

  const id = (agentId || "").toLowerCase();
  if (id.includes("dev") || id.includes("code") || id.includes("ops")) {
    return "DEV_OPERATOR";
  }
  if (id.includes("architect")) {
    return "ARCHITECT_DELEGATE";
  }
  if (id.includes("growth") || id.includes("marketing")) {
    return "GROWTH_OPERATOR";
  }
  if (id.includes("support") || id.includes("customer")) {
    return "CUSTOMER_SUPPORT";
  }
  if (id.includes("voice") || id.includes("phone") || id.includes("receptionist")) {
    return "VOICE_OPERATOR";
  }
  if (id.includes("research") || id.includes("model")) {
    return "MODEL_RESEARCHER";
  }
  if (id === "naelao-agent" && !projectId) {
    return "SPACE_ORCHESTRATOR";
  }

  return "CUSTOM";
}

/**
 * Physically strips prohibited tools from the tool declaration list
 * based on the caller's verified functional role. Case-insensitive matching.
 */
export function sanitizeToolsForRole(
  role: AgentRoleType,
  rawTools: Array<{ name: string; description: string; parameters: any }>
): Array<{ name: string; description: string; parameters: any }> {
  const policy = ROLE_FIREWALL_POLICIES[role] || ROLE_FIREWALL_POLICIES.CUSTOM;
  const blockedSet = new Set(policy.blockedToolNames.map(n => n.toLowerCase()));
  const allowedSet = new Set(policy.allowedToolNames.map(n => n.toLowerCase()));

  return rawTools.filter(tool => {
    const toolNameLower = tool.name.toLowerCase();
    // If explicitly blocked by policy, drop the tool
    if (blockedSet.has(toolNameLower)) {
      return false;
    }
    // If allowed list is configured and tool is not present, drop
    if (policy.allowedToolNames.length > 0 && !allowedSet.has(toolNameLower)) {
      return false;
    }
    return true;
  });
}
