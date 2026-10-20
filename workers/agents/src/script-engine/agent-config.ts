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

import type { StepPipeline } from "./step-pipeline.js";
import { validateStepPipeline } from "./step-pipeline.js";
import type { UniversalAgentManifest } from "@naelao/agent-sdk";
import { putTextCas, readTextWithHash } from "./r2-cas.js";
import type { LockGateway } from "./types.js";

export type { UniversalAgentManifest } from "@naelao/agent-sdk";

const MAX_AGENT_CONFIG_OBJECT_BYTES = 1024 * 1024;

async function readAgentConfigText(object: R2ObjectBody, label: string): Promise<string> {
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_AGENT_CONFIG_OBJECT_BYTES)
    throw new Error(`agent_config_${label}_too_large`);
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== object.size || bytes.byteLength > MAX_AGENT_CONFIG_OBJECT_BYTES)
    throw new Error(`agent_config_${label}_size_mismatch`);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

/**
 * Build the lock adapter used by every agent-config writer. The namespace is keyed by space,
 * while the lock key remains agent-specific, so independent agents in one space do not block
 * each other and writes from different workers still serialize through the same DO.
 */
export function createAgentConfigLockGateway(
  namespace: DurableObjectNamespace,
  spaceId: string,
): LockGateway {
  const stub = namespace.get(namespace.idFromName(`agent-config-lock:${spaceId}`));
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await stub.fetch(new Request(`http://agent-config-lock${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    }));
    if (!response.ok) throw new Error(`agent_config_lock_${response.status}`);
    return response.json<T>();
  };
  return {
    acquire: async (params) => {
      const result = await call<{ acquired?: boolean; granted?: boolean; active?: number; limit?: number; heldBy?: string; remainingMs?: number; fencingToken?: number }>(
        "/lock/acquire", { key: params.key, holderId: params.holderId, ttlMs: params.ttlMs });
      return {
        granted: result.granted ?? result.acquired ?? false,
        active: result.active ?? (result.granted || result.acquired ? 1 : 0),
        ...(result.limit === undefined ? {} : { limit: result.limit }),
        ...(result.heldBy === undefined ? {} : { heldBy: result.heldBy }),
        ...(result.remainingMs === undefined ? {} : { remainingMs: result.remainingMs }),
        ...(result.fencingToken === undefined ? {} : { fencingToken: result.fencingToken }),
      };
    },
    release: async (params) => { await call("/lock/release", { key: params.key, holderId: params.holderId, fencingToken: params.fencingToken }); },
    status: (key) => call<{ active: number }>(`/status?key=${encodeURIComponent(key)}`),
  };
}

/** Adapter for a provisioner or another worker that reaches the agents worker by service binding. */
export function createRemoteAgentConfigLockGateway(
  fetcher: Fetcher,
  headers: HeadersInit,
  spaceId: string,
): LockGateway {
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const target = new URL(`http://agents-worker/internal/agent-config-lock${path}`);
    if (body === undefined) target.searchParams.set("space_id", spaceId);
    const response = await fetcher.fetch(new Request(target, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...Object.fromEntries(new Headers(headers).entries()), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify({ space_id: spaceId, ...body as Record<string, unknown> }) }),
    }));
    if (!response.ok) throw new Error(`agent_config_lock_${response.status}`);
    return response.json<T>();
  };
  return {
    acquire: async (params) => {
      const result = await call<{ acquired?: boolean; granted?: boolean; active?: number; limit?: number; heldBy?: string; remainingMs?: number; fencingToken?: number }>(
        "/acquire", { key: params.key, holderId: params.holderId, ttlMs: params.ttlMs });
      return {
        granted: result.granted ?? result.acquired ?? false,
        active: result.active ?? (result.granted || result.acquired ? 1 : 0),
        ...(result.limit === undefined ? {} : { limit: result.limit }),
        ...(result.heldBy === undefined ? {} : { heldBy: result.heldBy }),
        ...(result.remainingMs === undefined ? {} : { remainingMs: result.remainingMs }),
        ...(result.fencingToken === undefined ? {} : { fencingToken: result.fencingToken }),
      };
    },
    release: async (params) => { await call("/release", { key: params.key, holderId: params.holderId, fencingToken: params.fencingToken }); },
    status: (key) => call<{ active: number }>(`/status?key=${encodeURIComponent(key)}`),
  };
}

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
  pipelines?: StepPipeline;
  /** Runtime-only normalized manifest. Legacy four-file agents are upgraded by the DO. */
  manifest?: UniversalAgentManifest;
}

/** On-disk shape of scripts.json: ScriptsConfig plus the structural approval-gate list. Kept
 *  inside this existing JSON file rather than a fifth R2 file — an agent is still defined by
 *  exactly the four files (agents.md, system-prompt.md, scripts.json, skills.json). */
type PersistedScriptsConfig = ScriptsConfig & { requires_approval_for?: string[]; pipelines?: StepPipeline };

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

  const { requires_approval_for, pipelines, ...scripts } = JSON.parse(await readAgentConfigText(scriptsJson, "scripts")) as PersistedScriptsConfig;
  if (pipelines) validateStepPipeline(pipelines);

  return {
    agentsMd: agentsMd ? await readAgentConfigText(agentsMd, "agents_md") : "",
    systemPrompt: await readAgentConfigText(systemPrompt, "system_prompt"),
    scripts,
    skills: skillsJson ? (JSON.parse(await readAgentConfigText(skillsJson, "skills")) as SkillsConfig) : { skills: [] },
    ...(requires_approval_for ? { requiresApprovalFor: requires_approval_for } : {}),
    ...(pipelines ? { pipelines } : {}),
  };
}

/** Write the four config files for an agent (used by the provisioner / profile install). */
export async function writeAgentConfig(
  bucket: R2Bucket,
  spaceId: string,
  agentId: string,
  config: AgentConfig,
  options: { lockGateway?: LockGateway; holderId?: string } = {},
): Promise<void> {
  const dir = agentDir(spaceId, agentId);
  if (config.pipelines) validateStepPipeline(config.pipelines);
  const persistedScripts: PersistedScriptsConfig = {
    ...config.scripts,
    ...(config.requiresApprovalFor ? { requires_approval_for: config.requiresApprovalFor } : {}),
  };
  if (config.pipelines) persistedScripts.pipelines = config.pipelines;
  const files: Array<[string, string]> = [
    [`${dir}/agents.md`, config.agentsMd],
    [`${dir}/system-prompt.md`, config.systemPrompt],
    [`${dir}/scripts.json`, JSON.stringify(persistedScripts, null, 2)],
    [`${dir}/skills.json`, JSON.stringify(config.skills, null, 2)],
  ];
  if (files.some(([, text]) => new TextEncoder().encode(text).byteLength > MAX_AGENT_CONFIG_OBJECT_BYTES))
    throw new Error("agent_config_object_too_large");
  let locked = false;
  let fencingToken = 0;
  const lockKey = `agent-config:${spaceId}:${agentId}`;
  if (options.lockGateway) {
    if (!options.holderId) throw new Error("agent_config_lock_holder_required");
    const result = await options.lockGateway.acquire({ key: lockKey, holderId: options.holderId, limit: 1, ttlMs: 30_000 });
    if (!result.granted || !Number.isSafeInteger(result.fencingToken) || !result.fencingToken) throw new Error("agent_config_lock_unavailable");
    fencingToken = result.fencingToken;
    locked = true;
  }
  try {
    // Capture every base before writing any file. Each individual object is then protected by
    // SHA-256 plus its R2 ETag, so a concurrent editor cannot silently lose a prompt/skills change.
    const observed = await Promise.all(files.map(([key]) => readTextWithHash(bucket, key)));
    await Promise.all(files.map(([key, text], index) => putTextCas(bucket, key, text, observed[index]?.hash ?? null)));
  } finally {
    if (locked && options.lockGateway && options.holderId) {
      await options.lockGateway.release({ key: lockKey, holderId: options.holderId, fencingToken });
    }
  }
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
