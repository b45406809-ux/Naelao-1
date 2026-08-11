/**
 * Agent configuration surface (spec §11). An agent in Naelao is defined ENTIRELY by four
 * files in R2 — no code changes, no DB rows. Change the files and reload the agent.
 *
 *   spaces/{spaceId}/agents/{agentId}/
 *     agents.md           ← identity, rules, behavioral + escalation constraints
 *     system-prompt.md    ← role, domain, tone, task framing
 *     scripts.json        ← which scripts load at startup
 *     skills.json         ← which SKILL.md knowledge docs are in context
 */

/** scripts.json (spec §11.2). */
export interface ScriptsConfig {
  /** Prebuilt platform scripts to enable (names from the catalogue). */
  prebuilt: string[];
  /** Space-level script names to load (installed by the builder/provisioner). */
  space_scripts?: string[];
  /** "auto" = load all of this agent's distilled scripts at startup (the default). */
  agent_scripts?: "auto" | string[];
  /** Observe script run at the start of each pass. */
  startup_observe: string;
  /** Optional: pre-boot a warm container (Code/Cowork profiles). */
  startup_container?: boolean;
}

/** skills.json (spec §11.3) — SKILL.md knowledge docs + per-skill config. */
export interface SkillsConfig {
  skills: Array<{
    name: string;
    tier: "platform" | "space" | "agent";
    config?: Record<string, unknown>;
  }>;
}

export interface AgentConfig {
  agentsMd: string;
  systemPrompt: string;
  scripts: ScriptsConfig;
  skills: SkillsConfig;
  /**
   * Structural HITL approval-gate allowlist (spec §11, appendix A1.16.1) — the action names
   * this agent must pause and request owner approval for before executing (loop.ts's
   * `gate_listed` mode). This is the enforced source of truth. `agents.md`'s
   * "# Approval Gates (HITL)" prose section is for the MODEL to read (so it knows to ask), not
   * for the runtime to parse — a prior version relied on parsing a `## requires_approval_for`
   * markdown heading that no agent-authoring path ever actually wrote, so nothing was ever
   * gated. Absent/undefined only for agents provisioned before this field existed; callers
   * MUST fall back to `parseRequiresApprovalFor(agentsMd)` in that case (see loop.ts).
   */
  requiresApprovalFor?: string[];
}

/** On-disk shape of scripts.json: ScriptsConfig plus the structural approval-gate list. Kept
 *  inside this existing JSON file rather than a fifth R2 file — an agent is still defined by
 *  exactly the four files (agents.md, system-prompt.md, scripts.json, skills.json). */
type PersistedScriptsConfig = ScriptsConfig & { requires_approval_for?: string[] };

function agentDir(spaceId: string, agentId: string): string {
  return `spaces/${spaceId}/agents/${agentId}`;
}

/** Load the four config files for an agent. Returns null when the agent is not provisioned. */
export async function loadAgentConfig(
  bucket: R2Bucket,
  spaceId: string,
  agentId: string
): Promise<AgentConfig | null> {
  const dir = agentDir(spaceId, agentId);
  const [agentsMd, systemPrompt, scriptsJson, skillsJson] = await Promise.all([
    bucket.get(`${dir}/agents.md`),
    bucket.get(`${dir}/system-prompt.md`),
    bucket.get(`${dir}/scripts.json`),
    bucket.get(`${dir}/skills.json`),
  ]);
  if (!scriptsJson || !systemPrompt) return null;

  const { requires_approval_for, ...scripts } = JSON.parse(await scriptsJson.text()) as PersistedScriptsConfig;

  return {
    agentsMd: agentsMd ? await agentsMd.text() : "",
    systemPrompt: await systemPrompt.text(),
    scripts,
    skills: skillsJson ? (JSON.parse(await skillsJson.text()) as SkillsConfig) : { skills: [] },
    ...(requires_approval_for ? { requiresApprovalFor: requires_approval_for } : {}),
  };
}

/** Write the four config files for an agent (used by the provisioner / profile install). */
export async function writeAgentConfig(
  bucket: R2Bucket,
  spaceId: string,
  agentId: string,
  config: AgentConfig
): Promise<void> {
  const dir = agentDir(spaceId, agentId);
  const persistedScripts: PersistedScriptsConfig = config.requiresApprovalFor
    ? { ...config.scripts, requires_approval_for: config.requiresApprovalFor }
    : config.scripts;
  await Promise.all([
    bucket.put(`${dir}/agents.md`, config.agentsMd),
    bucket.put(`${dir}/system-prompt.md`, config.systemPrompt),
    bucket.put(`${dir}/scripts.json`, JSON.stringify(persistedScripts, null, 2)),
    bucket.put(`${dir}/skills.json`, JSON.stringify(config.skills, null, 2)),
  ]);
}

/**
 * Live-reported bug: a business's Space Assistant claimed a real, shipped capability
 * (`thread.create`) "isn't supported" — the operation genuinely wasn't in `scripts.prebuilt` for
 * that specific agent, because `scripts.json` is written ONCE at provision time and nothing ever
 * re-syncs it when the code-level profile (profiles.ts) gains a new prebuilt script later. A
 * business provisioned before `project-coordination`/`business-diagnostics` were added to the
 * Space Assistant profile is permanently missing them — not a one-off, this affects every
 * already-provisioned business for every prebuilt added since. There is no builder-facing UI to
 * individually trim which prebuilt SCRIPTS an agent has (only per-ACTION approval policy), so a
 * script present in the current profile but absent from a persisted list is staleness, never an
 * intentional trim — safe to add, additive-only (never removes anything persisted), preserving
 * the existing order and appending only what's missing so a caller can skip a needless write when
 * nothing changed.
 */
export function mergeMissingPrebuilt(
  scripts: ScriptsConfig,
  additions: string[]
): { merged: ScriptsConfig; changed: boolean; added: string[] } {
  const existing = new Set(scripts.prebuilt);
  const added = additions.filter((name) => !existing.has(name));
  if (added.length === 0) return { merged: scripts, changed: false, added: [] };
  return { merged: { ...scripts, prebuilt: [...scripts.prebuilt, ...added] }, changed: true, added };
}

/** List the agentIds provisioned under a space. */
export async function listSpaceAgents(bucket: R2Bucket, spaceId: string): Promise<string[]> {
  const prefix = `spaces/${spaceId}/agents/`;
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const listing = await bucket.list(cursor ? { prefix, cursor } : { prefix });
    for (const o of listing.objects) {
      const id = o.key.slice(prefix.length).split("/")[0];
      if (id) ids.add(id);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return [...ids];
}
