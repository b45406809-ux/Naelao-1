// Plan-tier feature gating, seat counting, per-tenant resource quotas

import type { PlanTier } from "@naelao/types";

export interface PlanLimits {
  spaces: number;
  seats: number;
  kb_documents_per_space: number;
  kb_storage_mb: number;
  monthly_sessions: number;
  monthly_tokens: number;
  api_keys: number;
  webhook_subscriptions: number;
  custom_tools: boolean;
  sse_streaming: boolean;
  advanced_analytics: boolean;
  sso: boolean;
  audit_log_retention_days: number;
  /** §A1.26: monthly ceiling on Cloudflare infra credits (isolate/container wall-clock time +
   *  durable Workflow steps, converted via billing-core's infraTimeToCredits) — the compute-
   *  consumption counterpart to monthly_tokens, which only meters LLM usage. Same 1:20:200:2000
   *  tier ratio as monthly_tokens. */
  monthly_infra_credits: number;
  /** Phase 4 (money): OPTIONAL daily/weekly ceilings on top of the monthly one — undefined means
   *  "no extra throttling beyond the monthly cap" (every tier below defines them; a future custom
   *  tier that omits them is not enforced on those windows). These exist to stop a single busy
   *  day/week from burning an entire month's allowance in one sitting, not to reduce the total a
   *  plan is entitled to — each is set generously relative to its own monthly figure. Initial
   *  values; tune against real usage the same way infraTimeToCredits' own rates are documented as
   *  needing tuning. Enforced by workers/billing/src/quota.ts's checkWindowedQuota, mirrored here
   *  (not imported from there) for the same reason monthly_tokens/QuotaLimits.maxMonthlyTokens are
   *  two independently-maintained copies today — see that file's own comment. */
  daily_tokens?: number;
  weekly_tokens?: number;
}

const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    spaces: 3,
    seats: 1,
    kb_documents_per_space: 10,
    kb_storage_mb: 100,
    monthly_sessions: 500,
    monthly_tokens: 100_000,
    api_keys: 2,
    webhook_subscriptions: 0,
    custom_tools: false,
    sse_streaming: false,
    advanced_analytics: false,
    sso: false,
    audit_log_retention_days: 7,
    monthly_infra_credits: 5_000,
    daily_tokens: 20_000,
    weekly_tokens: 50_000,
  },
  growth: {
    spaces: 25,
    seats: 5,
    kb_documents_per_space: 100,
    kb_storage_mb: 1_000,
    monthly_sessions: 10_000,
    monthly_tokens: 2_000_000,
    api_keys: 10,
    webhook_subscriptions: 5,
    custom_tools: true,
    sse_streaming: true,
    advanced_analytics: false,
    sso: false,
    audit_log_retention_days: 30,
    monthly_infra_credits: 100_000,
    daily_tokens: 200_000,
    weekly_tokens: 700_000,
  },
  business: {
    spaces: 100,
    seats: 25,
    kb_documents_per_space: 1_000,
    kb_storage_mb: 10_000,
    monthly_sessions: 100_000,
    monthly_tokens: 20_000_000,
    api_keys: 50,
    webhook_subscriptions: 25,
    custom_tools: true,
    sse_streaming: true,
    advanced_analytics: true,
    sso: true,
    audit_log_retention_days: 90,
    monthly_infra_credits: 1_000_000,
    daily_tokens: 2_000_000,
    weekly_tokens: 7_000_000,
  },
  enterprise: {
    spaces: 1_000,
    seats: 9_999,
    kb_documents_per_space: 10_000,
    kb_storage_mb: 100_000,
    monthly_sessions: 1_000_000,
    monthly_tokens: 200_000_000,
    api_keys: 200,
    webhook_subscriptions: 100,
    custom_tools: true,
    sse_streaming: true,
    advanced_analytics: true,
    sso: true,
    audit_log_retention_days: 365,
    monthly_infra_credits: 10_000_000,
    daily_tokens: 20_000_000,
    weekly_tokens: 70_000_000,
  },
};

export function getPlanLimits(tier: PlanTier): PlanLimits {
  return PLAN_LIMITS[tier];
}

export function isFeatureAllowed(tier: PlanTier, feature: keyof PlanLimits): boolean {
  const limits = PLAN_LIMITS[tier];
  const val = limits[feature];
  if (typeof val === "boolean") return val;
  return (val as number) > 0;
}

export class EntitlementsChecker {
  constructor(private readonly db: D1Database) {}

  async getTenantTier(tenantId: string): Promise<PlanTier> {
    // `tenantId` here is the JWT claims' `tid` — which is the org id (see
    // NaelaoJwtClaims.tid's "tenantId (orgId)" comment in @naelao/types), not a Launchpad
    // business's `spaces.tenant_id`. The real table is `orgs` (infra/migrations/0002_orgs.sql).
    const row = await this.db.prepare(
      "SELECT plan_tier FROM orgs WHERE id = ?"
    ).bind(tenantId).first<{ plan_tier: string }>();
    return (row?.plan_tier ?? "free") as PlanTier;
  }

  async checkSpaceLimit(tenantId: string): Promise<void> {
    const tier = await this.getTenantTier(tenantId);
    const limits = getPlanLimits(tier);
    const row = await this.db.prepare(
      "SELECT COUNT(*) as count FROM spaces WHERE tenant_id = ? AND status != 'deleted'"
    ).bind(tenantId).first<{ count: number }>();
    if ((row?.count ?? 0) >= limits.spaces) {
      throw Object.assign(new Error(`Space limit reached (${limits.spaces}) for ${tier} plan`), { error_code: "quota_exceeded" });
    }
  }

  async checkSeatLimit(tenantId: string): Promise<void> {
    const tier = await this.getTenantTier(tenantId);
    const limits = getPlanLimits(tier);
    const row = await this.db.prepare(
      "SELECT COUNT(*) as count FROM users WHERE org_id = ? AND status = 'active'"
    ).bind(tenantId).first<{ count: number }>();
    if ((row?.count ?? 0) >= limits.seats) {
      throw Object.assign(new Error(`Seat limit reached (${limits.seats}) for ${tier} plan`), { error_code: "quota_exceeded" });
    }
  }

  async requireFeature(tenantId: string, feature: keyof PlanLimits): Promise<void> {
    const tier = await this.getTenantTier(tenantId);
    if (!isFeatureAllowed(tier, feature)) {
      throw Object.assign(new Error(`Feature '${String(feature)}' not available on ${tier} plan`), { error_code: "feature_not_available" });
    }
  }

  async getCurrentUsage(tenantId: string): Promise<{ tier: PlanTier; limits: PlanLimits; usage: Record<string, number> }> {
    const tier = await this.getTenantTier(tenantId);
    const limits = getPlanLimits(tier);
    const [spaces, seats, apiKeys] = await Promise.all([
      this.db.prepare("SELECT COUNT(*) as count FROM spaces WHERE tenant_id = ? AND status != 'deleted'").bind(tenantId).first<{ count: number }>(),
      this.db.prepare("SELECT COUNT(*) as count FROM users WHERE org_id = ? AND status = 'active'").bind(tenantId).first<{ count: number }>(),
      this.db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE org_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))").bind(tenantId).first<{ count: number }>(),
    ]);
    return {
      tier,
      limits,
      usage: {
        spaces: spaces?.count ?? 0,
        seats: seats?.count ?? 0,
        api_keys: apiKeys?.count ?? 0,
      },
    };
  }
}
