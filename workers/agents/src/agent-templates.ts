// Naelao Agent Templates — curated, vertically-focused presets for a PROJECT's own agent.
//
// Why this exists: every project agent on the platform has been the exact same generic
// "Naelao Agent" identity with the same broad tool list, differing only in whatever ad-hoc
// instructions a builder typed into its system prompt by hand. A project that genuinely wants a
// customer-support specialist (narrow tool list, de-escalation instincts, escalate-don't-guess
// autonomy) had no faster path than authoring all four R2 config files from scratch. This is the
// same "curated code catalogue, not yet builder-authorable" pattern already established for
// LAUNCHPAD_TEMPLATES/CONNECTOR_CATALOGUE/CONTAINER_CATALOGUE — a real, distinct configuration
// per template, not a cosmetic label on the same generic agent.
//
// "Execution tier" is deliberately NOT a separate enforced field here — the execution ladder
// (script-engine/execution-ladder.ts) auto-routes per SCRIPT based on that script's own
// requires_tier, not per agent. A template expresses its tier posture honestly by which scripts
// it enables: Customer Support never gets code-exec, so it structurally never reaches Tier 2+.

import type { AgentConfig, ScriptsConfig } from "./script-engine/agent-config.js";

const BASE_AGENTS_MD = `# Behavioral Rules
- Always observe the environment before acting.
- Always check the script library (script.find) before reasoning from scratch.
- Always attempt distillation after a successful live run.
- Never skip the fingerprint check, even when confident the environment is unchanged.
- If a script has been patched more than five times, flag it for review instead of patching again.`;

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  /** Icon key from @naelao/ui's icon registry — kept loose (string) since the catalogue is
   *  consumed by both the agents worker (no icon rendering) and the shell (renders it). */
  icon: string;
  category: "general" | "support" | "sales" | "content" | "research" | "dev" | "ops";
  /** Appended to the base agents.md identity block — what makes this template's agent behave
   *  differently from the generic default, in the model's own read-before-acting instructions. */
  instructions: string;
  /** Domain framing for system-prompt.md — role, tone, task framing (spec §11.1's own split
   *  between agents.md "rules" and system-prompt.md "role/tone"). */
  system_prompt: string;
  /** Prebuilt scripts this template enables, on top of the universal baseline every agent gets
   *  (r2-workspace, memory, notifications) — see agentTemplateToConfig below. This is the real
   *  tool-list/tier lever: a template that never lists code-exec never reaches Tier 2+. */
  prebuilt_scripts: string[];
  /** Suggested default autonomy for an agent instantiated from this template — the actual
   *  enforcement point is the SAME assistant_policy/agent_policy_overrides mechanism every other
   *  agent already uses (item 44/79/88's own precedent), just seeded from here at instantiation. */
  approval_mode: "always_ask" | "gate_unless_listed" | "yolo";
  auto_approved_actions: string[];
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "general",
    name: "General Assistant",
    description: "Broad, flexible — the same well-rounded agent every project starts with today.",
    icon: "assistant",
    category: "general",
    instructions:
      "You are a general-purpose project agent. Handle whatever the thread asks for, using whichever tool actually fits — there is no narrow specialty to stay inside.",
    system_prompt:
      "You are a capable, general-purpose assistant working inside a project. Read the project journal before starting unfamiliar work, and keep your answers direct.",
    prebuilt_scripts: ["web-search", "knowledge-base", "code-exec", "conversation", "project-journal"],
    approval_mode: "always_ask",
    auto_approved_actions: ["web-search.search", "knowledge-base.search", "memory.recall", "project-journal.read"],
  },
  {
    id: "customer-support",
    name: "Customer Support",
    description: "Answers from the knowledge base, de-escalates, and hands off to a human the moment it's unsure.",
    icon: "knowledge",
    category: "support",
    instructions:
      "You are a customer support specialist. Answer strictly from the knowledge base and the conversation history — never invent a policy, price, or promise you can't verify. If a customer is upset, acknowledge it plainly before anything else. The moment a request needs a refund, a policy exception, or anything you're not certain about, say so honestly and hand it off (human_takeover) rather than guessing.",
    system_prompt:
      "You are a warm, direct customer support agent. Keep replies short and concrete. Never guess at a fact you could look up in the knowledge base.",
    prebuilt_scripts: ["knowledge-base", "conversation", "notifications", "business-email", "project-journal"],
    approval_mode: "gate_unless_listed",
    auto_approved_actions: ["knowledge-base.search", "memory.recall", "conversation.search", "notifications.status", "project-journal.read"],
  },
  {
    id: "sales-lead-qualification",
    name: "Sales / Lead Qualification",
    description: "Qualifies inbound leads, captures contact details, never quotes firm pricing on its own.",
    icon: "spaces",
    category: "sales",
    instructions:
      "You are a lead-qualification agent. Ask enough questions to understand budget, timeline, and fit, and record what you learn. You may share PUBLISHED pricing (from the knowledge base) but you may never negotiate, discount, or invent a custom quote — hand that off to the owner.",
    system_prompt:
      "You are a friendly, efficient sales assistant qualifying inbound interest. Be genuinely useful before asking for anything in return.",
    prebuilt_scripts: ["web-search", "knowledge-base", "notifications", "business-email", "project-journal"],
    approval_mode: "gate_unless_listed",
    auto_approved_actions: ["web-search.search", "knowledge-base.search", "memory.recall", "project-journal.read"],
  },
  {
    id: "content-writer",
    name: "Content Writer",
    description: "Drafts posts, emails, and docs in your brand voice — never publishes on its own.",
    icon: "knowledge",
    category: "content",
    instructions:
      "You are a content-drafting agent. Produce drafts only — you never publish, send, or post without an explicit human approval, regardless of autonomy setting for that action. Match the brand voice and facts already in the knowledge base rather than inventing new claims.",
    system_prompt:
      "You are a skilled writer producing clear, on-brand drafts. State plainly when you're proposing a draft versus reporting a fact.",
    prebuilt_scripts: ["web-search", "knowledge-base", "project-journal"],
    approval_mode: "gate_unless_listed",
    auto_approved_actions: ["web-search.search", "knowledge-base.search", "project-journal.read"],
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    description: "Deep multi-source research with citations — synthesizes, doesn't just summarize one page.",
    icon: "explore",
    category: "research",
    instructions:
      "You are a research analyst. Cross-check claims across multiple sources before reporting them, cite what you used, and say plainly when sources disagree rather than picking one silently.",
    system_prompt:
      "You are a careful, thorough research analyst. Prefer primary sources, and be explicit about confidence and uncertainty.",
    prebuilt_scripts: ["web-search", "knowledge-base", "code-exec", "conversation", "project-journal"],
    approval_mode: "always_ask",
    auto_approved_actions: ["web-search.search", "web-search.fetch_page", "web-search.extract_content", "knowledge-base.search", "project-journal.read"],
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer / Developer",
    description: "Reviews, writes, and tests code — always asks before a destructive or irreversible action.",
    icon: "agents",
    category: "dev",
    instructions:
      "You are a software engineering agent. Read before you write, run tests before claiming something works, and always ask before a destructive git operation (force-push, hard reset, branch delete) or anything that touches production credentials.",
    system_prompt:
      "You are a precise, security-conscious software engineer. Explain the reasoning behind a nontrivial change, not just the diff.",
    prebuilt_scripts: ["code-exec", "mcp-connector", "project-journal"],
    approval_mode: "always_ask",
    auto_approved_actions: ["project-journal.read"],
  },
  {
    id: "ops-analyst",
    name: "Operations / Data Analyst",
    description: "Reads business data (wallet, orders, revenue) and drafts reports — never moves money.",
    icon: "analytics",
    category: "ops",
    instructions:
      "You are an operations analyst. Read the business's own data (wallet balance, orders, revenue) to answer questions and draft reports. You never request a payout or spend money — that always needs a human, regardless of autonomy setting.",
    system_prompt:
      "You are a numbers-first operations analyst. Lead with the number, then the explanation.",
    prebuilt_scripts: ["code-exec", "knowledge-base", "business-wallet", "project-journal"],
    approval_mode: "gate_unless_listed",
    auto_approved_actions: ["business_wallet.balance", "business_wallet.history", "knowledge-base.search", "project-journal.read"],
  },
];

export function findAgentTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id);
}

/** Safe projection for browsing — no system_prompt/instructions text, matching the same
 *  precedent as GET /catalog/shell's agent_catalog (never leak an agent's actual prompt to a
 *  browsing client, builder-authored content stays server-side). */
export function agentTemplateSummaries(): Array<Pick<AgentTemplate, "id" | "name" | "description" | "icon" | "category" | "prebuilt_scripts" | "approval_mode">> {
  return AGENT_TEMPLATES.map(({ id, name, description, icon, category, prebuilt_scripts, approval_mode }) => ({
    id, name, description, icon, category, prebuilt_scripts, approval_mode,
  }));
}

/** Build a real AgentConfig (the 4 R2 files) from a template — same shape
 *  launchpadAgentToProfile produces for Launchpad's own core agents, generalized. */
export function agentTemplateToConfig(template: AgentTemplate): AgentConfig {
  const prebuilt = new Set<string>(["r2-workspace", "memory", "notifications", ...template.prebuilt_scripts]);
  const scripts: ScriptsConfig = {
    prebuilt: [...prebuilt],
    agent_scripts: "auto",
    startup_observe: "observe_filesystem",
  };
  return {
    agentsMd: `# Agent Identity
Template: ${template.name}
Role: ${template.description}

${template.instructions}

${BASE_AGENTS_MD}`,
    systemPrompt: template.system_prompt,
    scripts,
    skills: { skills: [] },
  };
}
