import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";
import { listManagedServiceCostBudgetAlerts, listManagedServiceCostBudgets } from "./managed-service-cost-budgets.js";

type CapabilityRow = {
  provider: string;
  service_id: string;
  version: number;
  category: string;
  operations_json: string;
  regions_json: string;
  account_modes_json: string;
  isolation_model: string;
  status: string;
  valid_until: string | null;
  metering_json: string;
};

function jsonList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** A read-only, secret-free control-plane view for the authenticated workspace owner. */
export async function getManagedServiceDashboard(env: AgentsEnv, scope: CommunicationScope, now = new Date()) {
  const planTier = await env.PLATFORM_DB.prepare("SELECT plan_tier FROM orgs WHERE id=? AND status='active'")
    .bind(scope.tenantId).first<{ plan_tier: string }>();
  const tier = planTier?.plan_tier ?? "free";

  // Only the newest manifest version can be offered. A newer draft or disabled record must not
  // accidentally leave an older verified version discoverable as an active product option.
  const capabilityRows = await env.PLATFORM_DB.prepare(`SELECT v.provider,v.service_id,v.version,v.category,v.operations_json,
      v.regions_json,v.account_modes_json,v.isolation_model,v.status,v.valid_until,v.metering_json
    FROM managed_service_capability_versions v
    WHERE v.version=(SELECT MAX(latest.version) FROM managed_service_capability_versions latest
      WHERE latest.provider=v.provider AND latest.service_id=v.service_id)
    ORDER BY v.provider,v.service_id`).all<CapabilityRow>();

  const capabilities = [];
  for (const row of capabilityRows.results) {
    const entitlements = await env.PLATFORM_DB.prepare(`SELECT operation_name,region,price_version,credits_per_operation,max_credits_per_operation,
        max_operations_per_period,status,verified_at,valid_until
      FROM managed_service_plan_entitlements
      WHERE plan_tier=? AND provider=? AND service_id=? AND capability_version=?
        AND status='active' AND verified_at IS NOT NULL AND valid_until>? ORDER BY operation_name,region`)
      .bind(tier, row.provider, row.service_id, row.version, now.toISOString())
      .all<{ operation_name: string; region: string; price_version: string; credits_per_operation:number|null;max_credits_per_operation: number;
        max_operations_per_period: number | null; status: string; verified_at: string; valid_until: string }>();
    const manifestRegions = jsonList(row.regions_json);
    const configuredRegion = row.provider === "agentmail" ? env.AGENTMAIL_REGION ?? null : null;
    const active = row.status === "verified" && !!row.valid_until && Date.parse(row.valid_until) > now.getTime();
    const admittedEntitlements = entitlements.results
      .filter((entitlement) => jsonList(row.operations_json).includes(entitlement.operation_name)
        && manifestRegions.includes(entitlement.region));
    capabilities.push({
      provider: row.provider,
      serviceId: row.service_id,
      category: row.category,
      version: row.version,
      state: active ? "verified" : row.status === "verified" ? "expired" : row.status,
      validUntil: row.valid_until,
      operations: jsonList(row.operations_json),
      regions: manifestRegions,
      accountModes: jsonList(row.account_modes_json),
      isolationModel: row.isolation_model,
      metering: jsonObject(row.metering_json),
      configuredRegion,
      entitlements: admittedEntitlements.map((entitlement) => ({
        operation: entitlement.operation_name,
        region: entitlement.region,
        priceVersion: entitlement.price_version,
        creditsPerOperation: entitlement.credits_per_operation,
        maxCreditsPerOperation: entitlement.max_credits_per_operation,
        maxOperationsPerPeriod: entitlement.max_operations_per_period,
        validUntil: entitlement.valid_until,
        eligibleForConfiguredRegion: configuredRegion === entitlement.region,
      })),
      providerConfiguration: row.provider === "agentmail" ? {
        ready: !!(env.AGENTMAIL_API_KEY && env.AGENTMAIL_DEFAULT_DOMAIN && env.AGENTMAIL_WEBHOOK_URL && env.AGENTPORT_EVENT_RECEIVER_URL),
      } : { ready: false },
    });
  }

  const models = await env.PLATFORM_DB.prepare(`SELECT e.provider,e.service_id,e.operation_name,e.model_id,e.region,e.price_version,
      e.credits_per_operation,e.max_credits_per_operation,e.max_output_tokens,e.max_operations_per_period,e.valid_until
    FROM managed_service_model_entitlements e JOIN managed_service_capability_versions v
      ON v.provider=e.provider AND v.service_id=e.service_id AND v.version=e.capability_version
    WHERE e.plan_tier=? AND e.status='active' AND e.verified_by IS NOT NULL AND e.verified_at IS NOT NULL AND e.valid_until>?
      AND v.status='verified' AND v.valid_until>? AND v.version=(SELECT MAX(latest.version) FROM managed_service_capability_versions latest
        WHERE latest.provider=v.provider AND latest.service_id=v.service_id)
      AND EXISTS(SELECT 1 FROM json_each(v.operations_json) WHERE value=e.operation_name)
      AND EXISTS(SELECT 1 FROM json_each(v.regions_json) WHERE value=e.region)
      AND EXISTS(SELECT 1 FROM json_each(v.account_modes_json) WHERE value='naelao_managed')
    ORDER BY e.provider,e.service_id,e.model_id,e.region LIMIT 100`)
    .bind(tier, now.toISOString(), now.toISOString())
    .all<{ provider:string;service_id:string;operation_name:string;model_id:string;region:string;price_version:string;
      credits_per_operation:number|null;max_credits_per_operation:number;max_output_tokens:number|null;
      max_operations_per_period:number|null;valid_until:string }>();

  const accountQuery = scope.projectId
    ? `tenant_id=? AND space_id=? AND project_id=?`
    : `tenant_id=? AND space_id=?`;
  const accountBindings = scope.projectId ? [scope.tenantId, scope.spaceId, scope.projectId] : [scope.tenantId, scope.spaceId];
  const accounts = await env.PLATFORM_DB.prepare(`SELECT a.id,a.project_id,a.provider,a.service_id,a.connection_mode,a.owner_type,a.owner_link_id,a.agentport_link_status,
      a.provider_payer_type,a.agentport_fee_payer_type,a.credit_payer_type,a.region,a.lifecycle_state,a.created_at,a.updated_at,
      r.naelao_agent_id AS assistant_id,r.wake_enabled
    FROM managed_service_accounts a LEFT JOIN assistant_agentport_event_routes r ON r.account_id=a.id AND r.status='active'
    WHERE ${accountQuery.split("tenant_id").join("a.tenant_id").split("space_id").join("a.space_id").split("project_id").join("a.project_id")} ORDER BY a.updated_at DESC LIMIT 100`)
    .bind(...accountBindings)
    .all<{ id: string; project_id:string|null; provider: string; service_id: string; connection_mode: string; owner_type: string;
      owner_link_id:string|null;agentport_link_status:string|null;provider_payer_type: string; agentport_fee_payer_type: string | null; credit_payer_type: string | null;
      region: string | null; lifecycle_state: string; created_at: string; updated_at: string; assistant_id:string|null;wake_enabled:number|null }>();

  const operations = await env.PLATFORM_DB.prepare(`SELECT operation_id,account_id,provider,service_id,operation_name,
      region,model_id,status,price_version,reserved_credits,error_code,created_at,updated_at
    FROM managed_service_operations WHERE ${accountQuery} ORDER BY updated_at DESC LIMIT 50`)
    .bind(...accountBindings)
    .all<{ operation_id: string; account_id: string | null; provider: string; service_id: string; operation_name: string;
      region: string | null; model_id: string | null; status: string; price_version: string | null;
      reserved_credits: number | null; error_code: string | null; created_at: string; updated_at: string }>();

  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const usage = await env.PLATFORM_DB.prepare(`SELECT provider,service_id,
      SUM(CASE WHEN status IN ('held','uncertain') THEN credits ELSE 0 END) AS held_credits,
      SUM(CASE WHEN status='settled' THEN COALESCE(settled_credits,0) ELSE 0 END) AS settled_credits,
      COUNT(*) AS operations
    FROM managed_service_credit_reservations WHERE org_id=? AND space_id=? AND created_at>=?
      AND (? IS NULL OR project_id=?) GROUP BY provider,service_id ORDER BY provider,service_id`)
    .bind(scope.tenantId, scope.spaceId, since, scope.projectId ?? null, scope.projectId ?? null)
    .all<{ provider: string; service_id: string; held_credits: number; settled_credits: number; operations: number }>();

  const providerCosts = await env.PLATFORM_DB.prepare(`SELECT provider,service_id,usage_kind,currency,
      SUM(provider_cost_micros) AS provider_cost_micros,COUNT(*) AS receipt_count
    FROM managed_service_provider_cost_receipts WHERE tenant_id=? AND space_id=? AND period_start>=? AND period_end<=?
      AND (? IS NULL OR project_id=?) GROUP BY provider,service_id,usage_kind,currency
    ORDER BY provider,service_id,usage_kind,currency`)
    .bind(scope.tenantId,scope.spaceId,since,now.toISOString(),scope.projectId??null,scope.projectId??null)
    .all<{provider:string;service_id:string;usage_kind:string;currency:string;provider_cost_micros:number;receipt_count:number}>();

  const observedProviderCosts = await env.PLATFORM_DB.prepare(`SELECT provider,service_id,usage_kind,currency,
      SUM(provider_cost_micros) AS provider_cost_micros,COUNT(*) AS receipt_count
    FROM managed_service_provider_cost_observations WHERE tenant_id=? AND space_id=? AND period_start>=? AND period_end<=?
      AND (? IS NULL OR project_id=?) GROUP BY provider,service_id,usage_kind,currency
    ORDER BY provider,service_id,usage_kind,currency`)
    .bind(scope.tenantId,scope.spaceId,since,now.toISOString(),scope.projectId??null,scope.projectId??null)
    .all<{provider:string;service_id:string;usage_kind:string;currency:string;provider_cost_micros:number;receipt_count:number}>();

  const budgets = await listManagedServiceCostBudgets(env, scope);
  const costBudgetAlerts = await listManagedServiceCostBudgetAlerts(env, scope);
  const costBudgets = budgets.map(budget => {
    const sourceRows = budget.provenance === "operator_imported" ? providerCosts.results : observedProviderCosts.results;
    const observedProviderCostMicros = sourceRows.filter(row => row.provider === budget.provider && row.service_id === budget.serviceId
      && row.currency === budget.currency).reduce((sum, row) => sum + (row.provider_cost_micros ?? 0), 0);
    return { ...budget, observedProviderCostMicros, thresholdReached: observedProviderCostMicros >= budget.limitProviderCostMicros };
  });

  return {
    planTier: tier,
    generatedAt: now.toISOString(),
    higgsfieldByoEnabled: env.HIGGSFIELD_BYO_ENABLED === "true",
    capabilities,
    managedModels: models.results.filter((model) => Number.isSafeInteger(model.credits_per_operation)
      && (model.credits_per_operation ?? 0) > 0 && Number.isSafeInteger(model.max_output_tokens)
      && (model.max_output_tokens ?? 0) > 0).map((model) => ({
        provider:model.provider,serviceId:model.service_id,operation:model.operation_name,modelId:model.model_id,region:model.region,
        priceVersion:model.price_version,creditsPerOperation:model.credits_per_operation!,maxCreditsPerOperation:model.max_credits_per_operation,
        maxOutputTokens:model.max_output_tokens!,maxOperationsPerPeriod:model.max_operations_per_period,validUntil:model.valid_until,
      })),
    accounts: accounts.results.map((account) => ({
      id: account.id,
      projectId: account.project_id,
      provider: account.provider,
      serviceId: account.service_id,
      connectionMode: account.connection_mode,
      ownerType: account.owner_type,
      ownerLinkId: account.owner_link_id,
      agentPortLinkStatus: account.agentport_link_status,
      providerPayerType: account.provider_payer_type,
      agentPortFeePayerType: account.agentport_fee_payer_type,
      creditPayerType: account.credit_payer_type,
      region: account.region,
      assistantId: account.assistant_id,
      wakeEnabled: account.wake_enabled === 1,
      status: account.lifecycle_state,
      createdAt: account.created_at,
      updatedAt: account.updated_at,
    })),
    operations: operations.results.map((operation) => ({
      id: operation.operation_id,
      accountId: operation.account_id,
      provider: operation.provider,
      serviceId: operation.service_id,
      operation: operation.operation_name,
      region: operation.region,
      modelId: operation.model_id,
      status: operation.status,
      priceVersion: operation.price_version,
      reservedCredits: operation.reserved_credits,
      errorCode: operation.error_code,
      createdAt: operation.created_at,
      updatedAt: operation.updated_at,
    })),
    usage30d: usage.results.map((row) => ({
      provider: row.provider,
      serviceId: row.service_id,
      heldCredits: row.held_credits ?? 0,
      settledCredits: row.settled_credits ?? 0,
      operations: row.operations,
    })),
    providerCosts30d: [
      ...providerCosts.results.map((row) => ({
      provider: row.provider,
      serviceId: row.service_id,
      usageKind: row.usage_kind,
      currency: row.currency,
      providerCostMicros: row.provider_cost_micros ?? 0,
      receiptCount: row.receipt_count,
      provenance: "operator_imported" as const,
      })),
      ...observedProviderCosts.results.map((row) => ({
        provider: row.provider,
        serviceId: row.service_id,
        usageKind: row.usage_kind,
        currency: row.currency,
        providerCostMicros: row.provider_cost_micros ?? 0,
        receiptCount: row.receipt_count,
        provenance: "provider_api_observed" as const,
      })),
    ],
    providerCostBudgets30d: costBudgets,
    providerCostAlerts: costBudgetAlerts,
  };
}
