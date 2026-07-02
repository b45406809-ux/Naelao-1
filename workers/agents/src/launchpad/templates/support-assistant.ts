import type { AgentManifest } from "../manifest.js";

/**
 * A Space Assistant — the spec's "glorified agent." Same script-first engine, but the
 * manifest grants channel capabilities (the OpenClaw-style integrations) and a
 * heartbeat skill, so it behaves like a continuously-running assistant rather than a
 * nightly business loop. `kind: "assistant"` is the only structural difference; the
 * "glorification" is entirely in the bundle (channels + skills + instructions).
 *
 * Included to prove the abstraction: an assistant is not a new system, it's a manifest.
 */
export const SUPPORT_ASSISTANT_MANIFEST: AgentManifest = {
  id: "support-assistant",
  kind: "assistant",
  name: "Support Assistant",
  description: "A continuously-running assistant that fields member questions across channels.",
  cost_multiplier: 1,
  free_tier_eligible: true,
  channels: ["email", "slack", "discord"],
  skills: ["observe-first", "verify-landed"],
  capabilities: [
    "read_channel", "reply_in_channel", "search_knowledge", "escalate_to_human",
    "create_project", "create_thread_in_project", "read_project_threads",
    "configure_agent", "configure_llm_provider",
  ],
  instructions:
    "You are a continuously-running Space Assistant. You monitor connected channels " +
    "(email/Slack/Discord) on a heartbeat, answer member questions grounded in the Space's " +
    "knowledge, and escalate anything you're unsure about to a human rather than guessing. " +
    "Never fabricate an answer; an honest escalation beats a confident wrong reply. " +
    "You can also create and manage projects for deliverables — use create_project_for_goal " +
    "to organise work, and read_project_threads to check status before creating duplicate work.",
  seed_scripts: [
    {
      name: "heartbeat_check_channels",
      description: "Heartbeat: poll connected channels for unanswered member messages",
      tier: 2,
      preconditions: ["at least one channel connected"],
      code: `
// Heartbeat: gather unanswered messages across connected channels for triage.
const pending = await channels.listUnanswered(state.channels ?? []);
return { pending_count: pending.length, pending };`.trim(),
    },
    {
      name: "create_project_for_goal",
      description: "Create a project under a sub-space for a specific deliverable, avoiding duplicates",
      tier: 1,
      preconditions: ["subspace_id param provided", "project_name param provided"],
      code: `
// Check for an existing project with the same name before creating.
const existing = await api.get(\`/subspaces/\${params.subspace_id}/projects\`);
const dup = existing.projects?.find(p => p.name.toLowerCase() === params.project_name.toLowerCase());
if (dup) return { created: false, project: dup, reason: 'already_exists' };
const project = await api.post(\`/subspaces/\${params.subspace_id}/projects\`, {
  name: params.project_name,
  description: params.description ?? null,
});
return { created: true, project };`.trim(),
    },
    {
      name: "create_thread_in_project",
      description: "Create a new thread within a project, optionally with a title",
      tier: 1,
      preconditions: ["project_id param provided"],
      code: `
const thread = await api.post(\`/projects/\${params.project_id}/threads\`, {
  title: params.title ?? 'New thread',
});
return { thread };`.trim(),
    },
    {
      name: "read_project_threads",
      description: "List threads in a project to check existing work before starting new tasks",
      tier: 1,
      preconditions: ["project_id param provided"],
      code: `
const result = await api.get(\`/projects/\${params.project_id}/threads\`);
return { threads: result.threads ?? [], count: result.count ?? 0 };`.trim(),
    },
    {
      name: "configure_agent_skill",
      description: "Patch a peer agent's config (autonomy_tier, llm_provider, etc.) via the business API",
      tier: 1,
      preconditions: ["target_user_id param provided", "config_key and config_value params provided"],
      code: `
const patch = { [params.config_key]: params.config_value };
const res = await api.patch(\`/business/\${params.target_user_id}/config\`, patch);
return { patched: true, result: res };`.trim(),
    },
  ],
};
