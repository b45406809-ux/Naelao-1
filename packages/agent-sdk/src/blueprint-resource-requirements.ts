const REQUIREMENT_KEY = /^[a-z][a-z0-9-]{0,47}$/;
const RESOURCE_TYPE = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){0,2}$/;
const CAPABILITY = /^[a-z][a-z0-9_.:-]{0,63}$/;
const ACTION = /^[a-z][a-z0-9_.:-]{0,63}$/;
const ROLE_KEY = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_REQUIREMENTS = 20;
const MAX_CAPABILITIES = 10;
const MAX_GRANTS = 10;
const MAX_ACTIONS = 10;

/** Proposed grant for a role. Never applied automatically. */
export interface BlueprintResourceGrantProposalV1 {
  roleKey: string;
  actions: string[];
}

/** Template-declared provider resource need. Never provisions, spends or grants by itself. */
export interface BlueprintResourceRequirementV1 {
  key: string;
  resourceType: string;
  required: boolean;
  capabilities?: string[];
  preferredAccessMode?: "managed" | "byok";
  grants?: BlueprintResourceGrantProposalV1[];
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function plainObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function stringList(value: unknown, pattern: RegExp, max: number, message: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max
    || value.some((item) => typeof item !== "string" || !pattern.test(item))) throw new Error(message);
  if (new Set(value).size !== value.length) throw new Error(message);
  return [...(value as string[])].sort();
}

/**
 * Validate and canonicalize data-only resource requirements. This never creates a resource,
 * spend or grant; an owner/admin must approve each line at activation.
 */
export function validateBlueprintResourceRequirements(value: unknown): BlueprintResourceRequirementV1[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("Invalid resource requirement list");
  if (value.length > MAX_REQUIREMENTS) throw new Error("Too many resource requirements");
  const keys = new Set<string>();
  return value.map((item) => {
    const entry = plainObject(item, "Invalid resource requirement");
    if (!onlyKeys(entry, ["key", "resourceType", "required", "capabilities", "preferredAccessMode", "grants"])) {
      throw new Error("Unknown resource requirement field");
    }
    if (typeof entry.key !== "string" || !REQUIREMENT_KEY.test(entry.key)) throw new Error("Invalid resource requirement key");
    if (keys.has(entry.key)) throw new Error("Duplicate resource requirement key");
    keys.add(entry.key);
    if (typeof entry.resourceType !== "string" || !RESOURCE_TYPE.test(entry.resourceType)) throw new Error("Invalid resource requirement type");
    if (typeof entry.required !== "boolean") throw new Error("Invalid resource requirement required flag");
    const capabilities = entry.capabilities === undefined ? undefined
      : stringList(entry.capabilities, CAPABILITY, MAX_CAPABILITIES, "Invalid resource requirement capabilities");
    if (entry.preferredAccessMode !== undefined && entry.preferredAccessMode !== "managed" && entry.preferredAccessMode !== "byok") {
      throw new Error("Invalid resource requirement access mode");
    }
    let grants: BlueprintResourceGrantProposalV1[] | undefined;
    if (entry.grants !== undefined) {
      if (!Array.isArray(entry.grants) || entry.grants.length > MAX_GRANTS) throw new Error("Invalid resource requirement grants");
      const roles = new Set<string>();
      grants = entry.grants.map((grantItem) => {
        const grant = plainObject(grantItem, "Invalid resource requirement grant");
        if (!onlyKeys(grant, ["roleKey", "actions"])) throw new Error("Unknown resource requirement grant field");
        if (typeof grant.roleKey !== "string" || !ROLE_KEY.test(grant.roleKey)) throw new Error("Invalid resource requirement grant role");
        if (roles.has(grant.roleKey)) throw new Error("Duplicate resource requirement grant role");
        roles.add(grant.roleKey);
        return { roleKey: grant.roleKey, actions: stringList(grant.actions, ACTION, MAX_ACTIONS, "Invalid resource requirement grant actions") };
      });
    }
    return {
      key: entry.key,
      resourceType: entry.resourceType,
      required: entry.required,
      ...(capabilities ? { capabilities } : {}),
      ...(entry.preferredAccessMode !== undefined ? { preferredAccessMode: entry.preferredAccessMode as "managed" | "byok" } : {}),
      ...(grants ? { grants } : {}),
    } satisfies BlueprintResourceRequirementV1;
  });
}
