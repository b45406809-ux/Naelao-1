// MS-42 (V-spec MR-OS-1, MR-OS-3, MR-SEC-1/2): read-only, provider-agnostic Resources list for the Shell panel.
// Behind MANAGED_RESOURCES_PANEL_ENABLED. It reads the `managed_resources` view (never a parallel table), is scoped by the caller's
// tenant and Space from request context, and returns display fields only: no provisioning strategy, provider resource ref,
// credential ref, offering id or AgentPort account id ever leaves this module. There is no suspend or export action yet: the
// only suspension code today is the automatic subscription flow (MS-36) and provider-specific holds, so owners get a list only.
import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";
import { parseChargeComponents } from "./managed-quotes.js";

const LIMIT = 100;
const PROVIDER_NAMES: Record<string, string> = {
  agentmail: "AgentMail", telnyx: "Telnyx", higgsfield: "Higgsfield", openrouter: "OpenRouter", "workers-ai": "Workers AI",
  naelao: "Naelao",
};

export function managedResourcesPanelEnabled(env: Pick<AgentsEnv, "MANAGED_RESOURCES_PANEL_ENABLED">) {
  return env.MANAGED_RESOURCES_PANEL_ENABLED === "true";
}

export type ManagedResourceView = {
  id: string;
  providerName: string;
  category: string | null;
  resourceType: string | null;
  mode: "managed" | "byok";
  status: string;
  region: string | null;
  projectId: string | null;
  displayName: string | null;
  assignedAgents: Array<{ agentId: string }>;
  usage: { periodStart: string; periodEnd: string; operations: number; settledCredits: number; heldCredits: number };
  price: { credits: number; interval: "month" } | null;
  renewal: { state: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean } | null;
};

type Row = {
  id: string; provider: string; category: string | null; resource_type: string | null; access_mode: string | null; connection_mode: string;
  display_name: string | null; region: string | null; lifecycle_state: string; project_id: string | null; subscription_id: string | null;
  agentport_account_id: string | null; offering_name: string | null;
};
type SubRow = { offering_id: string; current_period_start: number; current_period_end: number; renewal_state: string; cancel_at_period_end: number };

function titleCase(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function monthlyPrice(db: AgentsEnv["PLATFORM_DB"], offeringId: string) {
  try {
    const offering = await db.prepare("SELECT charge_components_json FROM managed_service_offerings WHERE id=?").bind(offeringId).first<{ charge_components_json: string }>();
    if (!offering) return null;
    const rental = parseChargeComponents(JSON.parse(offering.charge_components_json) as unknown)
      .find((component) => component.kind === "rental" && component.interval === "month");
    return rental && rental.kind === "rental" ? { credits: rental.credits, interval: "month" as const } : null;
  } catch { return null; }
}

/** Resources of the caller's tenant and Space (and Project when given). Authorization is the caller's job (owner/admin only). */
export async function listManagedResources(env: AgentsEnv, scope: CommunicationScope, now = new Date()): Promise<{ generatedAt: string; resources: ManagedResourceView[] }> {
  const db = env.PLATFORM_DB;
  const rows = await db.prepare(`SELECT r.id,r.provider,r.category,r.resource_type,r.access_mode,r.connection_mode,r.display_name,r.region,
      r.lifecycle_state,r.project_id,r.subscription_id,a.agentport_account_id,o.display_name AS offering_name
    FROM managed_resources r JOIN managed_service_accounts a ON a.id=r.id AND a.tenant_id=r.tenant_id
      LEFT JOIN managed_service_offerings o ON o.id=r.offering_id
    WHERE r.tenant_id=? AND r.space_id=? AND (? IS NULL OR r.project_id=?) AND r.lifecycle_state NOT IN ('revoked','retired')
    ORDER BY r.created_at DESC,r.id LIMIT ?`)
    .bind(scope.tenantId, scope.spaceId, scope.projectId ?? null, scope.projectId ?? null, LIMIT).all<Row>();
  const nowIso = now.toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const resources: ManagedResourceView[] = [];
  for (const row of rows.results) {
    // Subscriptions are looked up by the resource id too, so a stale or foreign subscription_id never leaks another tenant's row.
    const sub = await db.prepare(`SELECT offering_id,current_period_start,current_period_end,renewal_state,cancel_at_period_end
      FROM managed_service_subscriptions WHERE tenant_id=? AND resource_id=?`).bind(scope.tenantId, row.id).first<SubRow>();
    const periodStart = sub ? new Date(sub.current_period_start).toISOString() : monthStart.toISOString();
    const periodEnd = sub ? new Date(sub.current_period_end).toISOString() : monthEnd.toISOString();
    const usage = await db.prepare(`SELECT COUNT(*) AS operations,
        SUM(CASE WHEN r.status IN ('held','uncertain') THEN r.credits ELSE 0 END) AS held,
        SUM(CASE WHEN r.status='settled' THEN COALESCE(r.settled_credits,0) ELSE 0 END) AS settled
      FROM managed_service_operations o JOIN managed_service_credit_reservations r ON r.operation_id=o.operation_id AND r.org_id=o.tenant_id
      WHERE o.tenant_id=? AND o.account_id=? AND r.created_at>=? AND r.created_at<?`)
      .bind(scope.tenantId, row.id, periodStart, periodEnd).first<{ operations: number; held: number | null; settled: number | null }>();
    const agents = row.agentport_account_id
      ? await db.prepare(`SELECT agent_id FROM agentport_account_grants WHERE tenant_id=? AND account_id=? AND status='active'
          AND (expires_at IS NULL OR expires_at>?) ORDER BY agent_id LIMIT 50`).bind(scope.tenantId, row.agentport_account_id, nowIso).all<{ agent_id: string }>()
      : { results: [] as Array<{ agent_id: string }> };
    const mode = row.access_mode ?? (row.connection_mode === "user_connected" ? "byok" : "managed");
    resources.push({
      id: row.id,
      providerName: row.offering_name ?? PROVIDER_NAMES[row.provider] ?? titleCase(row.provider),
      category: row.category,
      resourceType: row.resource_type,
      mode: mode === "byok" ? "byok" : "managed",
      status: row.lifecycle_state,
      region: row.region,
      projectId: row.project_id,
      displayName: row.display_name,
      assignedAgents: agents.results.map((agent) => ({ agentId: agent.agent_id })),
      usage: { periodStart, periodEnd, operations: usage?.operations ?? 0, settledCredits: usage?.settled ?? 0, heldCredits: usage?.held ?? 0 },
      price: sub && mode !== "byok" ? await monthlyPrice(db, sub.offering_id) : null,
      renewal: sub ? { state: sub.renewal_state, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: sub.cancel_at_period_end === 1 } : null,
    });
  }
  return { generatedAt: nowIso, resources };
}
