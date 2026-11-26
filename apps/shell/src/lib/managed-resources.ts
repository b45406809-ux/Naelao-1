// MS-42: parser for the provider-agnostic Resources list (agents route `action=managed-resources`).
// The server never sends internal strategy names or provider/credential refs, and this parser keeps only the fields below,
// so an unexpected extra field from a newer or misbehaving server is dropped rather than rendered.
export type ManagedResource = {
  id: string;
  providerName: string;
  category: string | null;
  resourceType: string | null;
  mode: "managed" | "byok";
  status: string;
  region: string | null;
  projectId: string | null;
  displayName: string | null;
  assignedAgents: string[];
  usage: { periodStart: string; periodEnd: string; operations: number; settledCredits: number; heldCredits: number };
  price: { credits: number; interval: "month" } | null;
  renewal: { state: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean } | null;
};

function rec(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const str = (value: unknown) => (typeof value === "string" && value ? value : null);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

export function parseManagedResources(value: unknown): ManagedResource[] {
  const list = rec(value)?.resources;
  if (!Array.isArray(list)) return [];
  const out: ManagedResource[] = [];
  for (const item of list) {
    const r = rec(item);
    const id = str(r?.id), providerName = str(r?.providerName), status = str(r?.status);
    if (!r || !id || !providerName || !status) continue;
    const usage = rec(r.usage), price = rec(r.price), renewal = rec(r.renewal);
    const renewalEnd = str(renewal?.currentPeriodEnd);
    out.push({
      id, providerName, status,
      category: str(r.category), resourceType: str(r.resourceType), region: str(r.region), projectId: str(r.projectId), displayName: str(r.displayName),
      mode: r.mode === "byok" ? "byok" : "managed",
      assignedAgents: Array.isArray(r.assignedAgents)
        ? r.assignedAgents.map((agent) => str(rec(agent)?.agentId)).filter((agent): agent is string => agent !== null) : [],
      usage: { periodStart: str(usage?.periodStart) ?? "", periodEnd: str(usage?.periodEnd) ?? "", operations: count(usage?.operations),
        settledCredits: count(usage?.settledCredits), heldCredits: count(usage?.heldCredits) },
      price: price && count(price.credits) > 0 ? { credits: count(price.credits), interval: "month" } : null,
      renewal: renewal && renewalEnd ? { state: str(renewal.state) ?? "active", currentPeriodEnd: renewalEnd, cancelAtPeriodEnd: renewal.cancelAtPeriodEnd === true } : null,
    });
  }
  return out;
}

export function resourceModeLabel(mode: ManagedResource["mode"]) {
  return mode === "byok" ? "Bring your own" : "Managed";
}

export function resourceTitle(resource: Pick<ManagedResource, "displayName" | "providerName">) {
  return resource.displayName ? `${resource.displayName} (${resource.providerName})` : resource.providerName;
}
