export interface TemplateCostEstimate {
  status: "partial" | "unavailable";
  currency: "USD";
  as_of: string;
  known_one_time_costs: Array<{
    component: "marketplace_template_license";
    amount_cents: number;
    basis: "recorded_purchase" | "current_zero_price_listing";
    already_paid: boolean;
    paid_at?: string;
  }>;
  not_estimated: string[];
  total_estimate_cents: null;
  reason?: "selected_listing_not_recorded" | "listing_price_unavailable";
}

type CostDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
};

const NOT_ESTIMATED = [
  "model, assistant, and tool usage based on expected volume",
  "channel and external provider charges, including phone numbers and email",
  "runtime, storage, and traffic charges beyond current plan allowances",
  "taxes, regional pricing, and account-specific provider terms",
  "optional managed services provisioned after installation",
];

export function selectedTemplateListingId(configJson: string | null):
  | { kind: "legacy" }
  | { kind: "selected"; listingId: string }
  | { kind: "invalid" } {
  if (configJson === null) return { kind: "legacy" };
  let config: unknown;
  try { config = JSON.parse(configJson); } catch { return { kind: "invalid" }; }
  if (!config || typeof config !== "object" || Array.isArray(config)) return { kind: "invalid" };
  if (!Object.prototype.hasOwnProperty.call(config, "template_listing_id")) return { kind: "legacy" };
  const listingId = (config as { template_listing_id?: unknown }).template_listing_id;
  if (typeof listingId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(listingId)) return { kind: "invalid" };
  return { kind: "selected", listingId };
}

export async function loadTemplateCostEstimate(
  db: CostDb,
  tenantId: string,
  blueprintId: string,
  listingId: string | null,
  now = new Date(),
): Promise<TemplateCostEstimate> {
  const base = {
    currency: "USD" as const,
    as_of: now.toISOString(),
    known_one_time_costs: [] as TemplateCostEstimate["known_one_time_costs"],
    not_estimated: NOT_ESTIMATED,
    total_estimate_cents: null as null,
  };
  if (!listingId) return { ...base, status: "unavailable", reason: "selected_listing_not_recorded" };

  try {
    const listing = await db.prepare(`SELECT l.pricing_model,l.price_cents,p.amount_cents,p.created_at
      FROM marketplace_forks f
      JOIN marketplace_listings l ON l.id=f.listing_id
      LEFT JOIN marketplace_license_purchases p ON p.tenant_id=f.tenant_id AND p.listing_id=f.listing_id
      WHERE f.tenant_id=? AND f.blueprint_id=? AND f.listing_id=?
        AND (l.status='published' OR p.id IS NOT NULL)
      LIMIT 1`).bind(tenantId, blueprintId, listingId).first<{
        pricing_model: string; price_cents: number; amount_cents: number | null; created_at: string | null;
      }>();
    if (!listing) return { ...base, status: "unavailable", reason: "listing_price_unavailable" };

    if (Number.isSafeInteger(listing.amount_cents) && listing.amount_cents! > 0 && listing.created_at) {
      base.known_one_time_costs.push({ component: "marketplace_template_license", amount_cents: listing.amount_cents!,
        basis: "recorded_purchase", already_paid: true, paid_at: listing.created_at });
    } else if (Number.isSafeInteger(listing.price_cents) && listing.price_cents === 0) {
      base.known_one_time_costs.push({ component: "marketplace_template_license", amount_cents: 0,
        basis: "current_zero_price_listing", already_paid: false });
    }
    return { ...base, status: "partial" };
  } catch {
    return { ...base, status: "unavailable", reason: "listing_price_unavailable" };
  }
}
