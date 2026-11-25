const ROLE_KEY = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_ROLES = 10;
const MAX_PROPOSALS = 20;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 400;

export const BLUEPRINT_SUBSPACE_MESSAGE_KINDS = [
  "finding", "artifact", "question", "blocker", "risk", "completion", "verification",
] as const;
export type BlueprintSubspaceMessageKindV1 = (typeof BLUEPRINT_SUBSPACE_MESSAGE_KINDS)[number];

/** Symbolic subspace role declared by a template. Never names or creates a real subspace. */
export interface BlueprintSubspaceRoleV1 {
  key: string;
  name: string;
  description?: string;
}

/** Template proposal for a route between two declared roles. It is never an active route. */
export interface BlueprintSubspaceRouteProposalV1 {
  source_role: string;
  target_role: string;
  allowed_kinds: BlueprintSubspaceMessageKindV1[];
  allow_reply: boolean;
}

export interface BlueprintSubspaceRolesV1 {
  roles: BlueprintSubspaceRoleV1[];
  proposals: BlueprintSubspaceRouteProposalV1[];
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function plainObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function hasControl(text: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

/**
 * Validate and canonicalize data-only symbolic subspace roles and route proposals. This never
 * creates grants or routes; an owner/admin must later map roles and approve each proposal.
 */
export function validateBlueprintSubspaceRoles(value: unknown): BlueprintSubspaceRolesV1 {
  const raw = plainObject(value, "Invalid subspace roles declaration");
  if (!onlyKeys(raw, ["roles", "proposals"])) throw new Error("Unknown subspace roles field");
  if (raw.proposals !== undefined && !Array.isArray(raw.proposals)) throw new Error("Invalid subspace route proposal list");
  const rawProposals = (raw.proposals ?? []) as unknown[];
  if (raw.roles === undefined) {
    if (rawProposals.length) throw new Error("Subspace route proposals require declared subspace roles");
    throw new Error("Invalid subspace role list");
  }
  if (!Array.isArray(raw.roles) || raw.roles.length < 1 || raw.roles.length > MAX_ROLES) throw new Error("Invalid subspace role list");
  if (rawProposals.length > MAX_PROPOSALS) throw new Error("Too many subspace route proposals");

  const keys = new Set<string>();
  const roles = (raw.roles as unknown[]).map((item) => {
    const entry = plainObject(item, "Invalid subspace role");
    if (!onlyKeys(entry, ["key", "name", "description"])) throw new Error("Unknown subspace role field");
    if (typeof entry.key !== "string" || !ROLE_KEY.test(entry.key)) throw new Error("Invalid subspace role key");
    if (keys.has(entry.key)) throw new Error("Duplicate subspace role key");
    keys.add(entry.key);
    if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > MAX_NAME || hasControl(entry.name)) {
      throw new Error("Invalid subspace role name");
    }
    if (entry.description !== undefined && (typeof entry.description !== "string" || entry.description.length > MAX_DESCRIPTION
      || hasControl(entry.description))) {
      throw new Error("Invalid subspace role description");
    }
    return {
      key: entry.key,
      name: entry.name.normalize("NFC").trim(),
      ...(entry.description !== undefined ? { description: entry.description.normalize("NFC").trim() } : {}),
    } satisfies BlueprintSubspaceRoleV1;
  });

  const pairs = new Set<string>();
  const proposals = rawProposals.map((item) => {
    const entry = plainObject(item, "Invalid subspace route proposal");
    if (!onlyKeys(entry, ["source_role", "target_role", "allowed_kinds", "allow_reply"])) throw new Error("Unknown subspace route proposal field");
    if (typeof entry.source_role !== "string" || typeof entry.target_role !== "string"
      || !keys.has(entry.source_role) || !keys.has(entry.target_role)) {
      throw new Error("Subspace route proposal names an undeclared role");
    }
    if (entry.source_role === entry.target_role) throw new Error("Subspace route proposal cannot target its own role");
    const pair = `${entry.source_role}\u0000${entry.target_role}`;
    if (pairs.has(pair)) throw new Error("Duplicate subspace route proposal");
    pairs.add(pair);
    const kinds = entry.allowed_kinds;
    if (!Array.isArray(kinds) || !kinds.length
      || kinds.some((kind) => typeof kind !== "string" || !(BLUEPRINT_SUBSPACE_MESSAGE_KINDS as readonly string[]).includes(kind))) {
      throw new Error("Invalid subspace route proposal kinds");
    }
    if (new Set(kinds).size !== kinds.length) throw new Error("Duplicate subspace route proposal kind");
    if (typeof entry.allow_reply !== "boolean") throw new Error("Invalid subspace route proposal allow_reply");
    return {
      source_role: entry.source_role,
      target_role: entry.target_role,
      allowed_kinds: [...(kinds as BlueprintSubspaceMessageKindV1[])].sort(),
      allow_reply: entry.allow_reply,
    } satisfies BlueprintSubspaceRouteProposalV1;
  });
  return { roles, proposals };
}
