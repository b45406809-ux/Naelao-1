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
const RESOURCE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const MAX_TOOLS = 128;
const MAX_KNOWLEDGE_BASES = 128;
const MAX_TRIGGERS = 64;
const MAX_CONFIGURATION_BYTES = 64 * 1024;

function ceiling(resource: string, granted: ReadonlySet<string>, roleRank: number, requiredRank: number): void {
  if (!granted.has(resource) || roleRank < requiredRank) {
    throw new Error(`capability_ceiling_exceeded:${resource}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneAndFreezeJson(value: unknown, seen: WeakSet<object>, budget: { nodes: number; chars: number }, depth = 0): unknown {
  budget.nodes++;
  if (budget.nodes > 4_096 || depth > 16) throw new Error("invalid_subagent_trigger:configuration_limit");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    budget.chars += value.length;
    if (value.length > MAX_CONFIGURATION_BYTES || budget.chars > MAX_CONFIGURATION_BYTES) throw new Error("invalid_subagent_trigger:configuration_limit");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid_subagent_trigger:configuration_value");
    return value;
  }
  if (typeof value !== "object") throw new Error("invalid_subagent_trigger:configuration_value");
  if (seen.has(value)) throw new Error("invalid_subagent_trigger:configuration_cycle");
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    if (value.length > 1_024) throw new Error("invalid_subagent_trigger:configuration_limit");
    result = Object.freeze(value.map(item => cloneAndFreezeJson(item, seen, budget, depth + 1)));
  } else {
    if (!isRecord(value)) throw new Error("invalid_subagent_trigger:configuration_value");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 1_024 || keys.some(key => typeof key !== "string" || key === "__proto__")) throw new Error("invalid_subagent_trigger:configuration_value");
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) throw new Error("invalid_subagent_trigger:configuration_value");
      budget.chars += key.length;
      if (key.length > 1_024 || budget.chars > MAX_CONFIGURATION_BYTES) throw new Error("invalid_subagent_trigger:configuration_limit");
      copy[key] = cloneAndFreezeJson(descriptor.value, seen, budget, depth + 1);
    }
    result = Object.freeze(copy);
  }
  seen.delete(value);
  return result;
}

function validateResources(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && Array.from(value).every(item => typeof item === "string" && RESOURCE.test(item));
}

/** Trust-boundary compiler. The returned object is cloned and frozen for durable dispatch. */
export function compileNoCodeSubagent(manifest: NoCodeSubagentManifest, creatorClaims: NoCodeCreatorClaims): Readonly<NoCodeSubagentManifest> {
  if (!manifest || typeof manifest !== "object" || typeof manifest.id !== "string" || !ID.test(manifest.id)
    || typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 128
    || typeof manifest.description !== "string" || !manifest.description.trim() || manifest.description.length > 2_048
    || !creatorClaims || typeof creatorClaims !== "object") throw new Error("invalid_subagent_manifest");
  if (!Number.isSafeInteger(creatorClaims.roleRank) || creatorClaims.roleRank < 0 || manifest.creatorRoleRank !== creatorClaims.roleRank) throw new Error("capability_ceiling_exceeded:creator_role");
  if (!validateResources(manifest.allowedTools, MAX_TOOLS) || !validateResources(manifest.knowledgeBaseIds, MAX_KNOWLEDGE_BASES)
    || !Array.isArray(manifest.triggers) || manifest.triggers.length > MAX_TRIGGERS
    || !validateResources(creatorClaims.allowedTools, MAX_TOOLS) || !validateResources(creatorClaims.knowledgeBaseIds, MAX_KNOWLEDGE_BASES)) throw new Error("invalid_subagent_manifest");
  const toolGrants = new Set(creatorClaims.allowedTools), kbGrants = new Set(creatorClaims.knowledgeBaseIds);
  for (const tool of manifest.allowedTools) {
    const requiredRank = creatorClaims.toolRoleRanks?.[tool] ?? (ADMIN_ONLY_TOOLS.has(tool) ? 3 : 0);
    if (!Number.isSafeInteger(requiredRank) || requiredRank < 0) throw new Error(`invalid_tool_role_rank:${tool}`);
    ceiling(tool, toolGrants, creatorClaims.roleRank, requiredRank);
  }
  for (const kb of manifest.knowledgeBaseIds) {
    const requiredRank = creatorClaims.knowledgeBaseRoleRanks?.[kb] ?? 0;
    if (!Number.isSafeInteger(requiredRank) || requiredRank < 0) throw new Error(`invalid_knowledge_base_role_rank:${kb}`);
    ceiling(kb, kbGrants, creatorClaims.roleRank, requiredRank);
  }
  if (new Set(manifest.allowedTools).size !== manifest.allowedTools.length || new Set(manifest.knowledgeBaseIds).size !== manifest.knowledgeBaseIds.length) throw new Error("invalid_subagent_manifest:duplicate_capability");
  const configurationBudget = { nodes: 0, chars: 0 };
  const triggers = Array.from(manifest.triggers, (trigger) => {
    if (!trigger || typeof trigger.type !== "string" || !ID.test(trigger.type)) throw new Error("invalid_subagent_trigger");
    if (trigger.configuration === undefined) return Object.freeze({ type: trigger.type });
    if (!isRecord(trigger.configuration)) throw new Error("invalid_subagent_trigger:configuration_value");
    const configuration = cloneAndFreezeJson(trigger.configuration, new WeakSet(), configurationBudget) as Readonly<Record<string, unknown>>;
    return Object.freeze({ type: trigger.type, configuration });
  });
  return Object.freeze({
    id: manifest.id,
    name: manifest.name.trim(),
    description: manifest.description.trim(),
    creatorRoleRank: manifest.creatorRoleRank,
    allowedTools: Object.freeze([...manifest.allowedTools]) as unknown as string[],
    knowledgeBaseIds: Object.freeze([...manifest.knowledgeBaseIds]) as unknown as string[],
    triggers: Object.freeze(triggers) as unknown as NoCodeSubagentTrigger[],
  });
}
