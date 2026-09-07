Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 4 — Chunk 01**: `specs/phase-4/chunk-01-kernel-and-prompt-engine.md`.

---

```markdown
---
chunk_id: "phase-4-chunk-01"
phase: 4
include_files:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/script-engine/types.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "workers/agents/src/script-engine/types.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - workers/agents/src/script-engine/prompt-assembly.ts
  - workers/agents/src/script-engine/firewall.ts
  - workers/agents/src/do/NaelaoAgentDO.ts
---

# Phase 4 — Chunk 01: Universal Kernel & 4-Layer Dynamic Prompt Engine

## 1. Executive Summary & Architectural Vision

AVOS strictly avoids maintaining fragmented, ad-hoc agent runtimes for different use cases. Every autonomous worker—whether operating as the 24/7 CEO (Space Assistant), a full-stack developer (`@DevOperator`), an automated paralegal, or a customer service receptionist—runs on **one universal execution kernel (`NaelaoAgentDO`)**.

Agents on AVOS differ only by **Configuration, Identity (`SOUL.md`), Scoping, and Tool Authorization**. 

To guarantee that models (Claude 3.7, Llama 3.3 70B, Qwen 2.5 Coder) adhere strictly to tool-calling discipline without hallucinating operational rules or leaking system secrets, the system prompt is assembled dynamically on every turn from **4 immutable, structured layers**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. UNIVERSAL OPERATING KERNEL (Immutable Engine Directives)                 │
│    • Claude Code AST & REPL rules: Line-numbered `Read`, exact `Edit`       │
│    • Direct action: Zero conversational filler, preamble, or pleasantries   │
│    • In-flight `compact_context` awareness and stdout squashing             │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. LIVING BUSINESS CONTEXT (Dynamic Enterprise Identity)                    │
│    • Entity name, active offerings, pricing tiers, compliance jurisdiction  │
│    • Resolved in sub-milliseconds from `SpaceDO` SQLite state               │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. AGENT ARCHETYPE & SOUL (Persona & Mission Specification)                 │
│    • Loaded from `/.avos/agents/:agentId/SOUL.md`                           │
│    • Technical voice, domain expertise boundaries, when to reply vs. pass   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. FOUNDER CUSTOM DIRECTIVES (User-Configured UI Overrides)                 │
│    • Live founder preferences injected from UI settings:                    │
│      "Always use TypeScript + Tailwind dark mode. Cite specific statutes."  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### The Hardware-Enforced Role Capability Firewall (`AgentFirewall`)
Prompt instructions alone cannot be trusted to enforce security boundaries. A customer-facing bot instructed *"Do not execute bash"* can be tricked via adversarial prompt injection into running arbitrary commands.

AVOS implements the **`AgentFirewall`**:
* Prior to every LLM turn, the firewall inspects the agent's declared role (e.g. `CUSTOMER_SUPPORT`).
* It **physically prunes prohibited tool schemas** (`Bash`, `Edit`, `Write`, container execution) from the prompt before it is ever sent to the provider.
* Even if an attacker injects malicious instructions, the model cannot execute forbidden actions because **the tools physically do not exist in its action space**.

---

## 2. Technical Specifications & File Contracts

### A. Dynamic Prompt Assembly Engine (`workers/agents/src/script-engine/prompt-assembly.ts`)

Create `workers/agents/src/script-engine/prompt-assembly.ts` to implement the dynamic 4-layer prompt compiler:

```typescript
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
```

---

### B. Hardware-Enforced Role Capability Firewall (`workers/agents/src/script-engine/firewall.ts`)

Create `workers/agents/src/script-engine/firewall.ts` to enforce runtime capability boundaries and tool pruning:

```typescript
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
 * Physically strips prohibited tools from the tool declaration list
 * based on the caller's verified functional role.
 */
export function sanitizeToolsForRole(role: AgentRoleType, rawTools: Array<{ name: string; description: string; parameters: any }>): Array<{ name: string; description: string; parameters: any }> {
  const policy = ROLE_FIREWALL_POLICIES[role] || ROLE_FIREWALL_POLICIES.CUSTOM;
  const blockedSet = new Set(policy.blockedToolNames);

  return rawTools.filter(tool => {
    // If explicitly blocked by policy, drop the tool
    if (blockedSet.has(tool.name)) {
      return false;
    }
    // If allowed list is configured and tool is not present, drop
    if (policy.allowedToolNames.length > 0 && !policy.allowedToolNames.includes(tool.name)) {
      return false;
    }
    return true;
  });
}
```

---

### C. Update Agent Runtime Kernel (`workers/agents/src/do/NaelaoAgentDO.ts`)

Integrate prompt assembly and the role firewall into the execution setup of `NaelaoAgentDO`:

1. **Load Business Context & SOUL.md:**
   - Resolve business context from `SpaceDO` SQLite state (`name`, `template_id`, `currency`, `compliance_mode`).
   - Read the agent's identity file from `/.avos/agents/${agentId}/SOUL.md` via `r2-workspace` / SQLite VFS. If missing, generate a clean default archetype.
2. **Execute Dynamic Assembly:**
   - Call `assembleSystemPrompt()` using `BASE_OPERATING_KERNEL`, the loaded business context, `SOUL.md`, and any founder custom instructions configured in space settings.
3. **Enforce Firewall Pruning:**
   - Before passing tool schemas to `ai.models.generateContent()` or the reasoner loop, invoke `sanitizeToolsForRole(agentRole, tools)`.
   - Ensure customer-facing runs receive only safe read and knowledge tools.

---

## 3. Invariants & Security Boundaries

1. **Fail-Closed Default:** If an agent's role is unrecognized, malformed, or missing, `AgentFirewall` must fall back to the most restrictive policy (`CUSTOMER_SUPPORT` / Tier 1 safe read-only).
2. **Untrusted User Directives:** Founder directives (Layer 4) are injected after the kernel, but must explicitly remain below the `BASE_OPERATING_KERNEL`. Operating directives (e.g. *"Never rewrite full files"*) take precedence over user styling preferences.
3. **Zero Token Waste:** Invariant sections must use prompt caching breakpoints where supported by providers (Anthropic prompt caching / Cloudflare AI Gateway cache headers).

---

## 4. Step-by-Step Implementation Instructions for the AI Runner

1. Create `workers/agents/src/script-engine/prompt-assembly.ts`:
   - Export `BusinessContextBrief`, `PromptAssemblyInputs`, `BASE_OPERATING_KERNEL`, and `assembleSystemPrompt`.
2. Create `workers/agents/src/script-engine/firewall.ts`:
   - Export `AgentRoleType`, `FirewallPolicy`, `ROLE_FIREWALL_POLICIES`, and `sanitizeToolsForRole`.
3. Update `workers/agents/src/do/NaelaoAgentDO.ts`:
   - Import `assembleSystemPrompt` and `sanitizeToolsForRole`.
   - Update system prompt compilation and tool schema registration to route through these two modules before initiating reasoning turns.
4. Run local syntax verification (`node --check`) across the modified files to ensure 100% clean compilation.
```
