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
}

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

  return {
    agentsMd: agentsMd ? await agentsMd.text() : "",
    systemPrompt: await systemPrompt.text(),
    scripts: JSON.parse(await scriptsJson.text()) as ScriptsConfig,
    skills: skillsJson ? (JSON.parse(await skillsJson.text()) as SkillsConfig) : { skills: [] },
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
  await Promise.all([
    bucket.put(`${dir}/agents.md`, config.agentsMd),
    bucket.put(`${dir}/system-prompt.md`, config.systemPrompt),
    bucket.put(`${dir}/scripts.json`, JSON.stringify(config.scripts, null, 2)),
    bucket.put(`${dir}/skills.json`, JSON.stringify(config.skills, null, 2)),
  ]);
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
