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
  managed_model_catalog_status: "available" | "unavailable";
  available_managed_models: Array<{
    provider: "cloudflare";
    service_id: "workers-ai";
    operation_name: "generate-text";
    model_id: string;
    region: "global";
    price_version: string;
    credits_per_operation: number;
    max_credits_per_operation: number;
    max_output_tokens: number;
    max_operations_per_period: number | null;
    valid_until: string;
  }>;
  managed_model_scenario: null | {
    status: "estimated" | "unavailable";
    basis: "customer_entered_operation_assumption";
    model_id: string;
    provider: "cloudflare";
    service_id: "workers-ai";
    operation_name: "generate-text";
    region: "global";
    price_version?: string;
    credit_unit: "naelao_credit";
    credits_per_operation?: number;
    max_credits_per_operation?: number;
    operations_per_month: number;
    projected_credits?: number;
    max_output_tokens?: number;
    max_operations_per_period?: number | null;
    within_plan_operation_limit?: boolean | null;
    rate_valid_until?: string;
    reason?: "active_model_entitlement_unavailable" | "model_rate_catalog_unavailable" | "projection_out_of_range";
  };
  expected_monthly_usage: {
    basis: "customer_entered_assumption";
    conversations: number;
    interactions_per_conversation: number;
    projected_interactions: number;
    estimated_cost_cents: null;
  } | null;
  reason?: "selected_listing_not_recorded" | "listing_price_unavailable";
}

export interface TemplateExpectedUsageV1 {
  conversations_per_month: number;
  interactions_per_conversation: number;
  managed_model_id?: string;
  model_calls_per_interaction?: number;
}

export function validateTemplateExpectedUsage(raw: unknown): TemplateExpectedUsageV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected_usage_invalid");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !["conversations_per_month", "interactions_per_conversation", "managed_model_id", "model_calls_per_interaction"].includes(key))
    || !Number.isSafeInteger(value.conversations_per_month) || Number(value.conversations_per_month) < 1 || Number(value.conversations_per_month) > 1_000_000
    || !Number.isSafeInteger(value.interactions_per_conversation) || Number(value.interactions_per_conversation) < 1 || Number(value.interactions_per_conversation) > 500)
    throw new Error("expected_usage_invalid");
  const modelId = value.managed_model_id;
  const callsPerInteraction = value.model_calls_per_interaction;
  if (modelId === undefined && callsPerInteraction !== undefined
    || modelId !== undefined && (typeof modelId !== "string" || modelId.length > 200 || !/^(?:[A-Za-z0-9]|@[A-Za-z0-9])[A-Za-z0-9._:/-]{0,199}$/.test(modelId)
      || !Number.isSafeInteger(callsPerInteraction) || Number(callsPerInteraction) < 1 || Number(callsPerInteraction) > 10)) {
    throw new Error("expected_usage_invalid");
  }
  return { conversations_per_month: Number(value.conversations_per_month), interactions_per_conversation: Number(value.interactions_per_conversation),
    ...(typeof modelId === "string" ? { managed_model_id: modelId, model_calls_per_interaction: Number(callsPerInteraction) } : {}) };
}

type CostDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      all?<T>(): Promise<{ results?: T[] }>;
    };
  };
};

type ManagedModelCostRate = NonNullable<TemplateCostEstimate["available_managed_models"][number]>;

async function loadAvailableManagedModelRates(db: CostDb, tenantId: string, now: Date): Promise<{
  status: "available" | "unavailable";
  models: ManagedModelCostRate[];
}> {
  try {
    const org = await db.prepare("SELECT plan_tier FROM orgs WHERE id=? AND status='active'")
      .bind(tenantId).first<{ plan_tier: string }>();
    if (!org?.plan_tier) return { status: "unavailable", models: [] };
    const query = db.prepare(`SELECT e.provider,e.service_id,e.operation_name,e.model_id,e.region,e.price_version,
        e.credits_per_operation,e.max_credits_per_operation,e.max_output_tokens,e.max_operations_per_period,e.valid_until,
        v.valid_until AS capability_valid_until
      FROM managed_service_model_entitlements e JOIN managed_service_capability_versions v
        ON v.provider=e.provider AND v.service_id=e.service_id AND v.version=e.capability_version
      WHERE e.plan_tier=? AND e.provider='cloudflare' AND e.service_id='workers-ai' AND e.operation_name='generate-text' AND e.region='global'
        AND e.status='active' AND e.verified_by IS NOT NULL AND e.verified_at IS NOT NULL
        AND e.credits_per_operation IS NOT NULL AND e.credits_per_operation>0 AND e.credits_per_operation<=e.max_credits_per_operation
        AND e.max_output_tokens IS NOT NULL AND e.max_output_tokens>0
        AND e.valid_until>? AND v.status='verified' AND v.valid_until>?
        AND v.version=(SELECT MAX(latest.version) FROM managed_service_capability_versions latest
          WHERE latest.provider=e.provider AND latest.service_id=e.service_id)
        AND EXISTS(SELECT 1 FROM json_each(v.operations_json) WHERE value=e.operation_name)
        AND EXISTS(SELECT 1 FROM json_each(v.regions_json) WHERE value=e.region)
        AND EXISTS(SELECT 1 FROM json_each(v.account_modes_json) WHERE value='naelao_managed')
      ORDER BY e.model_id LIMIT 100`);
    const statement = query.bind(org.plan_tier, now.toISOString(), now.toISOString());
    if (!statement.all) return { status: "unavailable", models: [] };
    const rows = await statement.all<{
      provider: string; service_id: string; operation_name: string; model_id: string; region: string; price_version: string;
      credits_per_operation: number; max_credits_per_operation: number; max_output_tokens: number;
      max_operations_per_period: number | null; valid_until: string; capability_valid_until: string;
    }>();
    const models: ManagedModelCostRate[] = [];
    for (const row of rows.results ?? []) {
      if (row.provider !== "cloudflare" || row.service_id !== "workers-ai" || row.operation_name !== "generate-text" || row.region !== "global"
        || typeof row.model_id !== "string" || !row.model_id || typeof row.price_version !== "string" || !row.price_version
        || !Number.isSafeInteger(row.credits_per_operation) || row.credits_per_operation <= 0
        || !Number.isSafeInteger(row.max_credits_per_operation) || row.credits_per_operation > row.max_credits_per_operation
        || !Number.isSafeInteger(row.max_output_tokens) || row.max_output_tokens <= 0
        || row.max_operations_per_period !== null && (!Number.isSafeInteger(row.max_operations_per_period) || row.max_operations_per_period <= 0)
        || typeof row.valid_until !== "string" || !Number.isFinite(Date.parse(row.valid_until)) || Date.parse(row.valid_until) <= now.getTime()
        || typeof row.capability_valid_until !== "string" || !Number.isFinite(Date.parse(row.capability_valid_until))
        || Date.parse(row.capability_valid_until) <= now.getTime()) continue;
      models.push({ provider: "cloudflare", service_id: "workers-ai", operation_name: "generate-text", model_id: row.model_id,
        region: "global", price_version: row.price_version, credits_per_operation: row.credits_per_operation,
        max_credits_per_operation: row.max_credits_per_operation, max_output_tokens: row.max_output_tokens,
        max_operations_per_period: row.max_operations_per_period, valid_until: row.valid_until });
    }
    return { status: "available", models };
  } catch {
    return { status: "unavailable", models: [] };
  }
}

const NOT_ESTIMATED = [
  "assistant and tool usage outside the selected managed-model scenario",
  "direct provider costs for managed-model inference and other services",
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
  rawExpectedUsage?: unknown,
): Promise<TemplateCostEstimate> {
  const expectedUsage = rawExpectedUsage === undefined ? null : validateTemplateExpectedUsage(rawExpectedUsage);
  const modelRates = await loadAvailableManagedModelRates(db, tenantId, now);
  const base = {
    currency: "USD" as const,
    as_of: now.toISOString(),
    known_one_time_costs: [] as TemplateCostEstimate["known_one_time_costs"],
    not_estimated: NOT_ESTIMATED,
    total_estimate_cents: null as null,
    managed_model_catalog_status: modelRates.status,
    available_managed_models: modelRates.models,
    managed_model_scenario: null as TemplateCostEstimate["managed_model_scenario"],
    expected_monthly_usage: expectedUsage ? {
      basis: "customer_entered_assumption" as const,
      conversations: expectedUsage.conversations_per_month,
      interactions_per_conversation: expectedUsage.interactions_per_conversation,
      projected_interactions: expectedUsage.conversations_per_month * expectedUsage.interactions_per_conversation,
      estimated_cost_cents: null as null,
      ...(expectedUsage.managed_model_id ? { model_id: expectedUsage.managed_model_id,
        model_calls_per_interaction: expectedUsage.model_calls_per_interaction } : {}),
    } : null,
  };
  if (expectedUsage?.managed_model_id) {
    const model = modelRates.models.find(item => item.model_id === expectedUsage.managed_model_id);
    const operationsPerMonth = expectedUsage.conversations_per_month * expectedUsage.interactions_per_conversation
      * expectedUsage.model_calls_per_interaction!;
    const projectedCredits = model ? operationsPerMonth * model.credits_per_operation : undefined;
    base.managed_model_scenario = model && Number.isSafeInteger(projectedCredits) ? {
      status: "estimated", basis: "customer_entered_operation_assumption", model_id: model.model_id,
      provider: model.provider, service_id: model.service_id, operation_name: model.operation_name, region: model.region,
      price_version: model.price_version, credit_unit: "naelao_credit", credits_per_operation: model.credits_per_operation,
      max_credits_per_operation: model.max_credits_per_operation,
      operations_per_month: operationsPerMonth, projected_credits: projectedCredits!, max_output_tokens: model.max_output_tokens,
      max_operations_per_period: model.max_operations_per_period,
      within_plan_operation_limit: model.max_operations_per_period === null ? null : operationsPerMonth <= model.max_operations_per_period,
      rate_valid_until: model.valid_until,
    } : {
      status: "unavailable", basis: "customer_entered_operation_assumption", model_id: expectedUsage.managed_model_id,
      provider: "cloudflare", service_id: "workers-ai", operation_name: "generate-text", region: "global",
      credit_unit: "naelao_credit", operations_per_month: operationsPerMonth,
      reason: !model ? modelRates.status === "available" ? "active_model_entitlement_unavailable" : "model_rate_catalog_unavailable" : "projection_out_of_range",
    };
  }
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
