type RuntimeUsageDatabase = Pick<D1Database, "prepare">;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ALLOWED_DAYS = new Set([1, 7, 30, 90]);

export interface SandboxRuntimeUsageInput {
  tenantId: string;
  days: number;
  spaceId?: string;
  projectId?: string;
}

/** Read settled Tier 5 runtime credits from Billing's authoritative usage ledger. These are
 * Naelao credits, not Cloudflare/Agent37 costs or provider invoices. */
export async function summarizeSandboxRuntimeUsage(db: RuntimeUsageDatabase, input: SandboxRuntimeUsageInput) {
  if (!ID.test(input.tenantId) || !ALLOWED_DAYS.has(input.days)
    || (input.spaceId !== undefined && !ID.test(input.spaceId))
    || (input.projectId !== undefined && (!ID.test(input.projectId) || !input.spaceId))) {
    throw new Error("sandbox_runtime_usage_invalid");
  }

  const predicates = [
    "org_id=?",
    "event_type='infra_credits'",
    "schema_version=2",
    "unit='credits'",
    "runtime_tier=5",
    "decision='charged'",
    "recorded_at>=datetime('now',?)",
  ];
  const values: unknown[] = [input.tenantId, `-${input.days} days`];
  if (input.spaceId) {
    predicates.push("space_id=?");
    values.push(input.spaceId);
  }
  if (input.projectId) {
    predicates.push("project_id=?");
    values.push(input.projectId);
  }
  const where = predicates.join(" AND ");
  const totals = await db.prepare(`SELECT COUNT(*) AS event_count,
      COALESCE(SUM(quantity),0) AS credits,
      COALESCE(SUM(cost_credits),0) AS cost_credits,
      COALESCE(SUM(CASE WHEN cost_credits IS NULL THEN 1 ELSE 0 END),0) AS unpriced_event_count
    FROM usage_events WHERE ${where}`)
    .bind(...values).first<{ event_count: number; credits: number; cost_credits: number; unpriced_event_count: number }>();
  const rows = await db.prepare(`SELECT space_id,project_id,installation_id,rate_card_version,payer_kind,
      COUNT(*) AS event_count,COALESCE(SUM(quantity),0) AS credits,COALESCE(SUM(cost_credits),0) AS cost_credits,
      COALESCE(SUM(CASE WHEN cost_credits IS NULL THEN 1 ELSE 0 END),0) AS unpriced_event_count
    FROM usage_events WHERE ${where}
    GROUP BY space_id,project_id,installation_id,rate_card_version,payer_kind
    ORDER BY COALESCE(SUM(cost_credits),0) DESC,event_count DESC LIMIT 200`)
    .bind(...values).all<{
      space_id: string | null;
      project_id: string | null;
      installation_id: string | null;
      rate_card_version: string | null;
      payer_kind: string | null;
      event_count: number;
      credits: number;
      cost_credits: number;
      unpriced_event_count: number;
    }>();

  return {
    days: input.days,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    provenance: "naelao_credit_ledger" as const,
    unit: "credits" as const,
    credits: Number(totals?.cost_credits ?? 0),
    eventCount: Number(totals?.event_count ?? 0),
    unpricedEventCount: Number(totals?.unpriced_event_count ?? 0),
    breakdown: (rows.results ?? []).map(row => ({
      spaceId: row.space_id,
      projectId: row.project_id,
      installationId: row.installation_id,
      rateCardVersion: row.rate_card_version,
      payerKind: row.payer_kind ?? "legacy",
      eventCount: Number(row.event_count),
      credits: Number(row.cost_credits ?? row.credits),
      unpricedEventCount: Number(row.unpriced_event_count),
    })),
    note: "Settled Naelao runtime credits from Billing. This is not provider cost, billed idle usage, or an invoice.",
  };
}
