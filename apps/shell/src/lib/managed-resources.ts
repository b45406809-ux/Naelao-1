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

// MS-43: parsers for the add-resource flow (`resource-options`, `resource-quote`, `resource-provision`).
export type QuoteComponentView =
  | { kind: "setup"; credits: number }
  | { kind: "rental"; interval: "month" | "year"; credits: number }
  | { kind: "usage" | "storage"; meter: string; included: number; unitQty: number; unitCredits: number };

export type ResourceOptionView = {
  offeringId: string; displayName: string; region: string; recurring: boolean;
  components: QuoteComponentView[]; minMonthlyCredits: number; initialCredits: number;
};
export type ResourceOptionsView = { options: ResourceOptionView[]; selectedOfferingId: string | null; reason: string };
export type ResourceQuoteView = {
  quoteId: string; offeringId: string; region: string; credits: number; minMonthlyCredits: number;
  components: QuoteComponentView[]; expiresAt: string; reason: string;
};

function parseComponents(value: unknown): QuoteComponentView[] {
  if (!Array.isArray(value)) return [];
  const out: QuoteComponentView[] = [];
  for (const item of value) {
    const c = rec(item);
    if (!c) continue;
    if (c.kind === "setup") out.push({ kind: "setup", credits: count(c.credits) });
    else if (c.kind === "rental") out.push({ kind: "rental", interval: c.interval === "year" ? "year" : "month", credits: count(c.credits) });
    else if ((c.kind === "usage" || c.kind === "storage") && str(c.meter)) {
      out.push({ kind: c.kind, meter: str(c.meter)!, included: count(c.included), unitQty: Math.max(1, count(c.unitQty)), unitCredits: count(c.unitCredits) });
    }
  }
  return out;
}

export function parseResourceOptions(value: unknown): ResourceOptionsView {
  const root = rec(value);
  const list = Array.isArray(root?.options) ? root.options : [];
  const options: ResourceOptionView[] = [];
  for (const item of list) {
    const o = rec(item);
    const offeringId = str(o?.offeringId), displayName = str(o?.displayName), region = str(o?.region);
    if (!o || !offeringId || !displayName || !region) continue;
    options.push({ offeringId, displayName, region, recurring: o.recurring === true, components: parseComponents(o.components),
      minMonthlyCredits: count(o.minMonthlyCredits), initialCredits: count(o.initialCredits) });
  }
  return { options, selectedOfferingId: str(root?.selectedOfferingId), reason: str(root?.reason) ?? "" };
}

export function parseResourceQuote(value: unknown): ResourceQuoteView | null {
  const root = rec(value), quote = rec(root?.quote);
  const quoteId = str(quote?.quoteId), offeringId = str(quote?.offeringId), region = str(quote?.region), expiresAt = str(quote?.expiresAt);
  if (!quote || !quoteId || !offeringId || !region || !expiresAt) return null;
  return { quoteId, offeringId, region, credits: count(quote.credits), minMonthlyCredits: count(quote.minMonthlyCredits),
    components: parseComponents(quote.components), expiresAt, reason: str(root?.reason) ?? "" };
}

export function describeComponent(component: QuoteComponentView): string {
  switch (component.kind) {
    case "setup": return `Setup: ${component.credits} credits, once`;
    case "rental": return `Rental: ${component.credits} credits per ${component.interval}`;
    default: return `${component.kind === "usage" ? "Usage" : "Storage"} (${component.meter}): first ${component.included} included, then ${component.unitCredits} credits per ${component.unitQty}`;
  }
}

// MS-47: lifecycle actions the Resources panel offers for one resource. Only a Managed resource with a subscription can be paused
// (the server answers 501 for anything else); the server decides again on every call, so this only hides buttons that cannot work.
export type ResourceLifecycleAction = "suspend" | "resume" | "reactivate";
export function resourceLifecycleActions(resource: Pick<ManagedResource, "mode" | "status" | "renewal">): ResourceLifecycleAction[] {
  if (resource.mode !== "managed" || !resource.renewal) return [];
  if (resource.renewal.state === "suspended") return ["reactivate"];
  if (resource.status === "suspended") return ["resume"];
  return resource.status === "active" ? ["suspend"] : [];
}

// MS-47 item 5: the add flow's resource types come from the offerings (agents `resource-types`), not a hard-coded list.
export type ResourceTypeView = { value: string; label: string; planRequired: boolean };

export function resourceTypeLabel(resourceType: string): string {
  const words = resourceType.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : resourceType;
}

export function parseResourceTypes(value: unknown): ResourceTypeView[] {
  const list = rec(value)?.types;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ResourceTypeView[] = [];
  for (const item of list) {
    const t = rec(item), resourceType = str(t?.resourceType);
    if (!t || !resourceType || seen.has(resourceType) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(resourceType)) continue;
    seen.add(resourceType);
    out.push({ value: resourceType, label: resourceTypeLabel(resourceType), planRequired: t.planRequired === true });
  }
  return out;
}
