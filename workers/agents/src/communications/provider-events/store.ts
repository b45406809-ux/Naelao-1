import { sha256Hex } from "./types.js";

// `processed_webhook_events_v2` in the spec is the (provider, event_id, event_type) table that migration 0052 created under that name
// and renamed back to `processed_webhook_events`; that is the table the Billing webhook gate uses too.
type Db = D1Database;

/** MR-EVT-2: first claim wins, before any side effect. Returns false for a replay. */
export async function claimProviderEvent(db: Db, provider: string, eventId: string, eventType: string): Promise<boolean> {
  const result = await db.prepare("INSERT OR IGNORE INTO processed_webhook_events (provider, event_id, event_type) VALUES (?, ?, ?)")
    .bind(provider, eventId, eventType).run();
  return (result.meta?.changes ?? 0) > 0;
}

/** A failed side effect releases the claim so the provider's retry is processed, not dropped. */
export async function releaseProviderEvent(db: Db, provider: string, eventId: string, eventType: string): Promise<void> {
  await db.prepare("DELETE FROM processed_webhook_events WHERE provider = ? AND event_id = ? AND event_type = ?").bind(provider, eventId, eventType).run();
}

/** MR-EVT-3: record a verified event that cannot be tied to exactly one resource. References and a body hash only. Best effort. */
export async function deadLetterProviderEvent(db: Db, input: { provider: string; eventId: string; eventType: string; resourceRef: string | null; reason: string; rawBody: string }): Promise<void> {
  try {
    await db.prepare("INSERT OR IGNORE INTO provider_event_dead_letters(id,provider,event_id,event_type,resource_ref,reason,body_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(`pedl_${crypto.randomUUID()}`, input.provider, input.eventId.slice(0, 256), input.eventType.slice(0, 128), input.resourceRef?.slice(0, 500) ?? null,
        input.reason, await sha256Hex(input.rawBody), new Date().toISOString()).run();
  } catch { /* dead-lettering never changes the response */ }
}

export interface ResolvedResource { resourceId: string; tenantId: string }

/** MR-EVT-3: tenant comes from `managed_service_accounts.provider_resource_ref`; zero or several matches resolve to null. */
export async function resolveProviderResource(db: Db, provider: string, resourceRef: string): Promise<ResolvedResource | null> {
  const rows = await db.prepare(`SELECT id,tenant_id FROM managed_service_accounts WHERE provider=? AND provider_resource_ref=?
      AND lifecycle_state NOT IN ('revoked','retired','failed') LIMIT 2`).bind(provider, resourceRef).all<{ id: string; tenant_id: string }>();
  const found = rows.results ?? [];
  return found.length === 1 ? { resourceId: found[0]!.id, tenantId: found[0]!.tenant_id } : null;
}

/** MR-EVT-5: the agent's grant on the account is checked again at delivery time. */
export async function agentGrantIsActive(db: Db, tenantId: string, accountId: string, agentId: string, nowIso = new Date().toISOString()): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS ok FROM agentport_account_grants WHERE tenant_id=? AND account_id=? AND agent_id=? AND status='active'
      AND (expires_at IS NULL OR expires_at>?) LIMIT 1`).bind(tenantId, accountId, agentId, nowIso).first<{ ok: number }>();
  return !!row;
}
