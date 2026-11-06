/** Shared AgentPort contracts. Provider execution remains with the provider or an existing connector. */
export const ACCOUNT_MODELS = ["agent_native", "user_parent", "agentport_parent", "delegated"] as const;
export type AccountModel = typeof ACCOUNT_MODELS[number];
export type ConnectionPurpose = "user_delegation" | "agent_resource" | "parent_provisioning";
export type DependencyType = "provisioning" | "authentication" | "billing" | "recovery" | "runtime";

export interface AgentPrincipal {
  id: string;
  type: "individual" | "organization" | "platform";
  verificationLevel: string;
  verificationIssuer?: string;
  verificationRef?: string;
}

export interface RegisteredService {
  id: string;
  name: string;
  type: "api" | "mcp" | "a2a" | "channel" | "managed";
  endpoint?: string;
  accountModels: AccountModel[];
  capabilities: string[];
  events: string[];
  connectionPurpose: ConnectionPurpose;
  partnershipStatus: "unaffiliated" | "approved" | "restricted" | "unavailable";
  auth?: { type?: "oauth2" | "api_key" | "mtls" | "provider_managed" | "none"; authorizationUrl?: string; scopes?: string[] };
  billing?: Record<string, unknown>;
  provisioning?: Record<string, unknown>;
  capabilitySchemas?: Record<string, unknown>;
}

export interface AccountDependency {
  accountId: string;
  dependsOnAccountId: string;
  type: DependencyType;
}

export interface ActivityLease {
  id: string;
  subscriptionId: string;
  consumerId: string;
  expiresAt: number;
}

export function validateServiceRegistration(value: unknown): RegisteredService | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const types = ["api", "mcp", "a2a", "channel", "managed"];
  const purposes: ConnectionPurpose[] = ["user_delegation", "agent_resource", "parent_provisioning"];
  const models = Array.isArray(row.accountModels) ? row.accountModels : [];
  const strings = (v: unknown) => Array.isArray(v) && v.every((item) => typeof item === "string" && item.length > 0 && item.length <= 160);
  if (typeof row.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(row.id) ||
      typeof row.name !== "string" || !row.name.trim() || row.name.length > 120 ||
      typeof row.type !== "string" || !types.includes(row.type) ||
      !models.length || models.some((m) => !(ACCOUNT_MODELS as readonly unknown[]).includes(m)) ||
      !strings(row.capabilities) || !strings(row.events) ||
      typeof row.connectionPurpose !== "string" || !purposes.includes(row.connectionPurpose as ConnectionPurpose)) return null;
  if (row.endpoint !== undefined && (typeof row.endpoint !== "string" || row.endpoint.length > 2048)) return null;
  // Provider submissions cannot approve themselves. A future AgentPort platform review flow
  // may set `approved` after independent verification; public manifest input never can.
  const partnershipStatus = ["restricted", "unavailable"].includes(String(row.partnershipStatus))
    ? row.partnershipStatus as RegisteredService["partnershipStatus"] : "unaffiliated";
  const authInput = row.auth && typeof row.auth === "object" && !Array.isArray(row.auth) ? row.auth as Record<string, unknown> : {};
  const authKeys = new Set(["type", "authorizationUrl", "scopes"]);
  if (Object.keys(authInput).some(key => !authKeys.has(key))) return null;
  const authType = authInput.type;
  if (authType !== undefined && !["oauth2", "api_key", "mtls", "provider_managed", "none"].includes(String(authType))) return null;
  if (authInput.authorizationUrl !== undefined) {
    if (typeof authInput.authorizationUrl !== "string") return null;
    try {
      const authUrl = new URL(authInput.authorizationUrl);
      if (authUrl.protocol !== "https:" || authUrl.username || authUrl.password || authUrl.hash) return null;
    } catch { return null; }
  }
  if (authInput.scopes !== undefined && (!Array.isArray(authInput.scopes) || authInput.scopes.some(scope => typeof scope !== "string" || !scope || scope.length > 160))) return null;
  const plainObject = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const auth = {
    ...(authType ? { type: authType as "oauth2" | "api_key" | "mtls" | "provider_managed" | "none" } : {}),
    ...(typeof authInput.authorizationUrl === "string" ? { authorizationUrl: authInput.authorizationUrl } : {}),
    ...(Array.isArray(authInput.scopes) ? { scopes: [...new Set(authInput.scopes as string[])] } : {}),
  };
  return {
    id: row.id, name: row.name.trim(), type: row.type as RegisteredService["type"],
    ...(typeof row.endpoint === "string" ? { endpoint: row.endpoint } : {}),
    accountModels: [...new Set(models as AccountModel[])], capabilities: [...new Set(row.capabilities as string[])],
    events: [...new Set(row.events as string[])], connectionPurpose: row.connectionPurpose as ConnectionPurpose,
    partnershipStatus,
    auth, billing: plainObject(row.billing),
    provisioning: plainObject(row.provisioning), capabilitySchemas: plainObject(row.capabilitySchemas),
  };
}

/** Provisioning cycles are blockers. Other relationship cycles are returned as warnings. */
export function inspectDependencyGraph(edges: AccountDependency[]): { provisioningCycles: string[][]; warnings: DependencyType[] } {
  const graph = new Map<string, string[]>();
  const warnings = new Set<DependencyType>();
  for (const edge of edges) {
    if (edge.accountId === edge.dependsOnAccountId) {
      if (edge.type === "provisioning") graph.set(edge.accountId, [...(graph.get(edge.accountId) ?? []), edge.accountId]);
      else warnings.add(edge.type);
      continue;
    }
    if (edge.type !== "provisioning") { warnings.add(edge.type); continue; }
    graph.set(edge.accountId, [...(graph.get(edge.accountId) ?? []), edge.dependsOnAccountId]);
  }
  const done = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (node: string) => {
    if (active.has(node)) {
      const cycle = stack.slice(stack.indexOf(node)).concat(node);
      const key = [...cycle].sort().join("\0");
      if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
      return;
    }
    if (done.has(node)) return;
    active.add(node); stack.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    stack.pop(); active.delete(node); done.add(node);
  };
  for (const node of graph.keys()) visit(node);
  return { provisioningCycles: cycles, warnings: [...warnings] };
}

export function leaseExpiry(now: number, requestedTtlSeconds: number, limits = { min: 10, max: 900 }): number {
  if (!Number.isFinite(now) || !Number.isFinite(requestedTtlSeconds)) throw new Error("invalid_lease_ttl");
  const ttl = Math.max(limits.min, Math.min(limits.max, Math.floor(requestedTtlSeconds)));
  return now + ttl * 1000;
}

export function isLeaseActive(lease: ActivityLease, now = Date.now()): boolean {
  return Number.isFinite(lease.expiresAt) && lease.expiresAt > now;
}

export function accountModelRequiresParent(model: AccountModel): boolean {
  return model === "user_parent" || model === "agentport_parent" || model === "delegated";
}

export function assertAgentGrant(input: { accountStatus: string; agentStatus: string; grantStatus: string; expiresAt?: string | null; permission: string; permissions: string[]; now?: number }): void {
  const now = input.now ?? Date.now();
  if (input.accountStatus !== "active" || input.agentStatus !== "active" || input.grantStatus !== "active") throw new Error("agentport_access_revoked");
  if (input.expiresAt && Date.parse(input.expiresAt) <= now) throw new Error("agentport_grant_expired");
  if (!input.permissions.includes(input.permission)) throw new Error("agentport_permission_denied");
}
