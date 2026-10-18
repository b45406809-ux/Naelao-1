export interface UsageEventOutboxSql {
  exec(sql: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

export interface PendingUsageEvent {
  idempotency_key: string;
  tenant_id: string;
  event_json: string;
  attempts: number;
}

export function initUsageEventOutbox(sql: UsageEventOutboxSql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS billing_usage_event_outbox (
    idempotency_key TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    event_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    PRIMARY KEY(tenant_id,idempotency_key)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_billing_usage_outbox_retry ON billing_usage_event_outbox(status,next_attempt_at)`);
}

export function enqueueUsageEvent(
  sql: UsageEventOutboxSql,
  tenantId: string,
  event: Record<string, unknown>,
  now = Date.now(),
): string {
  const key = typeof event.idempotency_key === "string" ? event.idempotency_key : "";
  if (!key || key.length > 200) throw new Error("usage_event_idempotency_key_required");
  const eventJson = JSON.stringify(event);
  if (!eventJson || eventJson.length > 64_000) throw new Error("usage_event_payload_too_large");
  sql.exec(`INSERT OR IGNORE INTO billing_usage_event_outbox
    (idempotency_key,tenant_id,event_json,status,attempts,next_attempt_at,created_at)
    VALUES(?,?,?,'pending',0,?,?)`, key, tenantId, eventJson, now, now);
  return key;
}

function backoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(Math.max(0, attempts), 10));
}

export async function flushUsageEventOutbox(
  sql: UsageEventOutboxSql,
  send: (event: Record<string, unknown>, tenantId: string) => Promise<void>,
  now = Date.now(),
  limit = 20,
): Promise<{ delivered: number; failed: number; nextAttemptAt: number | null }> {
  sql.exec("DELETE FROM billing_usage_event_outbox WHERE status='delivered' AND delivered_at<?", now - 30 * 86_400_000);
  const rows = sql.exec(`SELECT idempotency_key,tenant_id,event_json,attempts FROM billing_usage_event_outbox
    WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT ?`, now, Math.max(1, Math.min(100, limit)))
    .toArray() as PendingUsageEvent[];
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const event = JSON.parse(row.event_json) as Record<string, unknown>;
      await send(event, row.tenant_id);
      sql.exec("UPDATE billing_usage_event_outbox SET status='delivered',attempts=attempts+1,last_error=NULL,delivered_at=? WHERE tenant_id=? AND idempotency_key=? AND status='pending'",
        now, row.tenant_id, row.idempotency_key);
      delivered++;
    } catch (error) {
      const attempts = row.attempts + 1;
      const errorCode = error instanceof Error ? error.message : "billing_usage_delivery_failed";
      sql.exec(`UPDATE billing_usage_event_outbox SET attempts=?,last_error=?,next_attempt_at=?
        WHERE tenant_id=? AND idempotency_key=? AND status='pending'`, attempts, errorCode.slice(0, 160), now + backoffMs(attempts), row.tenant_id, row.idempotency_key);
      failed++;
    }
  }
  const pending = sql.exec("SELECT MIN(next_attempt_at) AS next_at FROM billing_usage_event_outbox WHERE status='pending'")
    .toArray()[0] as { next_at?: number | null } | undefined;
  return { delivered, failed, nextAttemptAt: typeof pending?.next_at === "number" ? pending.next_at : null };
}
