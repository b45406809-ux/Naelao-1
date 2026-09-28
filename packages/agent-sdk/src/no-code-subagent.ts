export interface NoCodeSubagentTrigger {
  type: string;
  configuration?: Readonly<Record<string, unknown>>;
}

export interface NoCodeSubagentManifest {
  id: string;
  name: string;
  description: string;
  creatorRoleRank: number;
  allowedTools: string[];
  knowledgeBaseIds: string[];
  triggers: NoCodeSubagentTrigger[];
}

export interface NoCodeCreatorClaims {
  roleRank: number;
  allowedTools: readonly string[];
  knowledgeBaseIds: readonly string[];
  /** Optional resource ceilings supplied by the Gatekeeper catalogue. */
  toolRoleRanks?: Readonly<Record<string, number>>;
  knowledgeBaseRoleRanks?: Readonly<Record<string, number>>;
}

const ID = /^[a-z][a-z0-9_-]{1,63}$/;
const ADMIN_ONLY_TOOLS = new Set(["payout", "member_invite", "wallet.request_payout", "member.invite"]);

function ceiling(resource: string, granted: ReadonlySet<string>, roleRank: number, requiredRank: number): void {
  if (!granted.has(resource) || roleRank < requiredRank) {
    throw new Error(`capability_ceiling_exceeded:${resource}`);
  }
}

/** Trust-boundary compiler. The returned object is cloned and frozen for durable dispatch. */
export function compileNoCodeSubagent(manifest: NoCodeSubagentManifest, creatorClaims: NoCodeCreatorClaims): Readonly<NoCodeSubagentManifest> {
  if (!manifest || !ID.test(manifest.id) || !manifest.name.trim() || !manifest.description.trim()) throw new Error("invalid_subagent_manifest");
  if (!Number.isInteger(creatorClaims.roleRank) || creatorClaims.roleRank < 0 || manifest.creatorRoleRank !== creatorClaims.roleRank) throw new Error("capability_ceiling_exceeded:creator_role");
  if (!Array.isArray(manifest.allowedTools) || !Array.isArray(manifest.knowledgeBaseIds) || !Array.isArray(manifest.triggers)) throw new Error("invalid_subagent_manifest");
  const toolGrants = new Set(creatorClaims.allowedTools), kbGrants = new Set(creatorClaims.knowledgeBaseIds);
  for (const tool of manifest.allowedTools) ceiling(tool, toolGrants, creatorClaims.roleRank, creatorClaims.toolRoleRanks?.[tool] ?? (ADMIN_ONLY_TOOLS.has(tool) ? 3 : 0));
  for (const kb of manifest.knowledgeBaseIds) ceiling(kb, kbGrants, creatorClaims.roleRank, creatorClaims.knowledgeBaseRoleRanks?.[kb] ?? 0);
  if (new Set(manifest.allowedTools).size !== manifest.allowedTools.length || new Set(manifest.knowledgeBaseIds).size !== manifest.knowledgeBaseIds.length) throw new Error("invalid_subagent_manifest:duplicate_capability");
  const triggers = manifest.triggers.map((trigger) => {
    if (!trigger || typeof trigger.type !== "string" || !ID.test(trigger.type)) throw new Error("invalid_subagent_trigger");
    return Object.freeze({ type: trigger.type, ...(trigger.configuration ? { configuration: Object.freeze({ ...trigger.configuration }) } : {}) });
  });
  return Object.freeze({ ...manifest, allowedTools: Object.freeze([...manifest.allowedTools]) as unknown as string[], knowledgeBaseIds: Object.freeze([...manifest.knowledgeBaseIds]) as unknown as string[], triggers: Object.freeze(triggers) as unknown as NoCodeSubagentTrigger[] });
}
