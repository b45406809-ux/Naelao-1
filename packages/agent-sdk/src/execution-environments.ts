/** Host-filtered metadata. Observations may rank candidates but never grant authority. */
export interface EnvironmentCard {
  id: string;
  /** User-visible host label; identity/authority remain the separate stable id. */
  name?: string;
  kind: "managed" | "external";
  provider: string;
  scope: "SPACE_SHARED" | "ASSISTANT_PRIVATE" | "PROJECT_BOUND";
  tenantId: string;
  spaceId: string;
  projectId?: string;
  workspaceId?: string;
  capabilities: readonly string[];
  observedAt: number;
  available: boolean;
  persistence: "ephemeral" | "filesystem" | "snapshot";
  /** Where commands see files. Machine-local storage is never a workspace mount. */
  filesystemModel: "workspace-backed" | "machine-local";
  apps: readonly { id: string; version?: string; connectionId?: string; authenticatedAt?: number }[];
  /** Supplied by the host after current grants and plan admission checks. */
  authorized: boolean;
  externalUse: readonly ("capability" | "fallback")[];
}
export interface EnvironmentRequirement {
  capabilities: readonly string[];
  /** Pin routing to a fresh, owner-reported authenticated app observation. */
  appId?: string;
  connectionId?: string;
  mode: "managed" | "capability" | "fallback";
  /** Only the host may set this when no compatible managed target is eligible or its provider is unavailable. */
  managedUnavailable?: boolean;
}
export interface EnvironmentOwner {
  tenantId: string; spaceId: string; projectId?: string;
  /** Distinguishes a space extension's workspace from the Space Assistant workspace. */
  workspaceId?: string;
  scope: EnvironmentCard["scope"];
}
export function sameEnvironmentOwner(a: EnvironmentOwner, b: EnvironmentOwner): boolean {
  return a.tenantId === b.tenantId && a.spaceId === b.spaceId && a.projectId === b.projectId && a.workspaceId === b.workspaceId && a.scope === b.scope;
}
export function eligibleEnvironments(cards: readonly EnvironmentCard[], owner: EnvironmentOwner, requirement: EnvironmentRequirement, now = Date.now()): EnvironmentCard[] {
  if (cards.length > 512 || requirement.capabilities.length > 64 || requirement.appId !== undefined && !/^[a-z][a-z0-9_.:-]{0,127}$/.test(requirement.appId)
    || requirement.connectionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requirement.connectionId)
    || !["managed", "capability", "fallback"].includes(requirement.mode)) throw new Error("environment_requirements_invalid");
  if (new Set(cards.map(card => card.id)).size !== cards.length) throw new Error("environment_registry_identity_collision");
  return cards.filter(card => sameEnvironmentOwner(card, owner) && card.authorized && card.available
    && Number.isSafeInteger(card.observedAt) && card.observedAt <= now && now - card.observedAt <= 60_000
    && requirement.capabilities.every(capability => card.capabilities.includes(capability))
    && (!(requirement.appId || requirement.connectionId) || card.apps.some(app => (!requirement.appId || app.id === requirement.appId)
      && (!requirement.connectionId || app.connectionId === requirement.connectionId) && Boolean(app.connectionId)
      && Number.isSafeInteger(app.authenticatedAt) && app.authenticatedAt! <= now && now - app.authenticatedAt! <= 60_000))
    && (card.kind === "managed" || requirement.mode === "capability" && card.externalUse.includes("capability")
      || requirement.mode === "fallback" && requirement.managedUnavailable === true && card.externalUse.includes("fallback")))
    .sort((a, b) => Number(a.kind === "external") - Number(b.kind === "external") || a.id.localeCompare(b.id));
}
/** An AI recommendation may only select from the host's eligible set. */
export function selectEnvironment(cards: readonly EnvironmentCard[], owner: EnvironmentOwner, requirement: EnvironmentRequirement, recommendedId?: string, pinnedId?: string, now = Date.now()): EnvironmentCard {
  const eligible = eligibleEnvironments(cards, owner, requirement, now);
  if (pinnedId) {
    const pinned = eligible.find(card => card.id === pinnedId);
    if (!pinned) throw new Error("environment_session_target_unavailable");
    return pinned;
  }
  const selected = eligible.find(card => card.id === recommendedId) ?? eligible[0];
  if (!selected) throw new Error("environment_no_eligible_target");
  return selected;
}

export interface TemplateRuntimeRequirement {
  id: string;
  capabilities: readonly string[];
  required: boolean;
  priority: number;
  dependencies: readonly string[];
}
export function validateTemplateRuntimes(items: readonly TemplateRuntimeRequirement[]): void {
  if (!Array.isArray(items) || items.length > 64) throw new Error("template_runtimes_invalid");
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || Object.keys(item).some(key => !["id", "capabilities", "required", "priority", "dependencies"].includes(key)) || !/^[a-z][a-z0-9_-]{1,63}$/.test(item.id) || seen.has(item.id) || typeof item.required !== "boolean"
      || !Number.isSafeInteger(item.priority) || item.priority < 0 || !Array.isArray(item.capabilities) || !item.capabilities.length || item.capabilities.length > 32
      || item.capabilities.some((cap: unknown) => typeof cap !== "string" || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(cap))
      || !Array.isArray(item.dependencies) || item.dependencies.length > 64) throw new Error("template_runtime_invalid");
    seen.add(item.id);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("template_runtime_dependency_cycle");
    const item = items.find(item => item.id === id);
    if (!item) throw new Error("template_runtime_dependency_missing");
    visiting.add(id);
    for (const dependency of item.dependencies) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const item of items) visit(item.id);
}
/** Pure preview: grants no runtime installation, credentials, compute or plan upgrades. */
export function previewTemplateRuntimes(items: readonly TemplateRuntimeRequirement[], slots: number, availableCapabilities: readonly string[]) {
  validateTemplateRuntimes(items);
  if (!Number.isSafeInteger(slots) || slots < 0) throw new Error("template_runtime_slots_invalid");
  const ordered: TemplateRuntimeRequirement[] = [], visited = new Set<string>();
  const add = (item: TemplateRuntimeRequirement) => {
    if (visited.has(item.id)) return;
    visited.add(item.id);
    for (const id of item.dependencies) add(items.find(value => value.id === id)!);
    ordered.push(item);
  };
  for (const item of [...items].sort((a, b) => Number(b.required) - Number(a.required) || a.priority - b.priority || a.id.localeCompare(b.id))) add(item);
  const included = new Set<string>();
  const components = ordered.map(item => {
    const reason = !item.capabilities.every(cap => availableCapabilities.includes(cap)) ? "capability_unavailable"
      : item.dependencies.some(id => !included.has(id)) ? "dependency_unavailable"
      : included.size >= slots ? "plan_slot_limit" : undefined;
    if (!reason) included.add(item.id);
    return { id: item.id, required: item.required, status: reason ? "deferred" as const : "included" as const, ...(reason ? { reason } : {}) };
  });
  return { installable: components.every(item => !item.required || item.status === "included"), components };
}
