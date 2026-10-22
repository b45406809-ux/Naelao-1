import { readBoundedResponseJson } from "@naelao/http";

interface Env { PLATFORM_DB: D1Database; STRIPE_CONNECT_SECRET_KEY?: string }
interface Payout { id: string; amount_cents: number; destination_snapshot: string | null; attempt_started_at: number | null; status: string }
const MAX_STRIPE_PAYOUT_RESPONSE_BYTES = 64 * 1024;

/** Capture the exact earning rows atomically before computing the payout amount. */
export async function reserveDeveloperPayout(db: D1Database, developerId: string): Promise<{ id: string; amount_cents: number } | null> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("UPDATE developer_earnings_ledger SET payout_id = ? WHERE developer_user_id = ? AND payout_id IS NULL AND developer_cents > 0").bind(id, developerId),
    db.prepare("UPDATE developer_license_earnings SET payout_id = ? WHERE developer_user_id = ? AND payout_id IS NULL AND amount_cents > 0").bind(id, developerId),
    db.prepare(`INSERT INTO developer_payouts (id, developer_user_id, amount_cents, status)
      SELECT ?, ?, SUM(amount_cents), 'queued' FROM (
        SELECT developer_cents AS amount_cents FROM developer_earnings_ledger WHERE payout_id = ?
        UNION ALL SELECT amount_cents FROM developer_license_earnings WHERE payout_id = ?
      ) HAVING SUM(amount_cents) > 0`).bind(id, developerId, id, id),
  ]);
  return db.prepare("SELECT id, amount_cents FROM developer_payouts WHERE id = ?").bind(id).first<{ id: string; amount_cents: number }>();
}

/** Only opted-in profiles are swept; explicit withdrawal requests also enter the same queue. */
export async function reconcileDeveloperPayouts(env: Env, now = Date.now(), sweep = true): Promise<{ queued: number; paid: number; deferred: number }> {
  const report = { queued: 0, paid: 0, deferred: 0 };
  const profiles = sweep ? await env.PLATFORM_DB.prepare("SELECT user_id FROM developer_partner_profiles WHERE status = 'active' AND auto_payout_enabled = 1 AND payout_destination IS NOT NULL LIMIT 100").all<{ user_id: string }>() : { results: [] };
  for (const profile of profiles.results) if (await reserveDeveloperPayout(env.PLATFORM_DB, profile.user_id)) report.queued++;
  const payouts = await env.PLATFORM_DB.prepare("SELECT id FROM developer_payouts WHERE status IN ('queued','processing') ORDER BY created_at LIMIT 100").all<{ id: string }>();
  for (const { id } of payouts.results) {
    if (!env.STRIPE_CONNECT_SECRET_KEY) { report.deferred++; continue; }
    // Pin destination before first dispatch. Later profile changes cannot change a retry's payload.
    const payout = await env.PLATFORM_DB.prepare(`UPDATE developer_payouts SET status = 'processing',
      destination_snapshot = COALESCE(destination_snapshot, (SELECT payout_destination FROM developer_partner_profiles WHERE user_id = developer_user_id AND status = 'active')),
      attempt_started_at = COALESCE(attempt_started_at, ?), updated_at = datetime('now')
      WHERE id = ? AND status IN ('queued','processing') RETURNING id, amount_cents, destination_snapshot, attempt_started_at, status`).bind(now, id).first<Payout>();
    if (!payout) continue;
    if (!payout.destination_snapshot || !/^acct_[a-zA-Z0-9]+$/.test(payout.destination_snapshot)) {
      await env.PLATFORM_DB.prepare("UPDATE developer_payouts SET last_error = 'verified_connect_destination_required' WHERE id = ?").bind(id).run(); report.deferred++; continue;
    }
    // Stripe may evict idempotency keys after 24h. Never redispatch an uncertain old transfer.
    if (now - payout.attempt_started_at! >= 23 * 3600_000) {
      await env.PLATFORM_DB.prepare("UPDATE developer_payouts SET last_error = 'manual_provider_reconciliation_required' WHERE id = ?").bind(id).run(); report.deferred++; continue;
    }
    try {
      const account = await fetch(`https://api.stripe.com/v1/accounts/${payout.destination_snapshot}`, { headers: { authorization: `Bearer ${env.STRIPE_CONNECT_SECRET_KEY}` }, redirect: "error", signal: AbortSignal.timeout(8000) });
      const readiness = account.ok ? await readBoundedResponseJson<{ capabilities?: { transfers?: string } }>(account, MAX_STRIPE_PAYOUT_RESPONSE_BYTES) : null;
      if (readiness?.capabilities?.transfers !== "active") throw new Error("connect_transfers_not_enabled");
      const response = await fetch("https://api.stripe.com/v1/transfers", {
        method: "POST", headers: { authorization: `Bearer ${env.STRIPE_CONNECT_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded", "Idempotency-Key": `naelao-developer-payout:${id}` },
        body: new URLSearchParams({ amount: String(payout.amount_cents), currency: "usd", destination: payout.destination_snapshot, "metadata[naelao_payout_id]": id }), redirect: "error", signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`connect_transfer_http_${response.status}`);
      const transfer = await readBoundedResponseJson<{ id?: string; amount?: number; currency?: string; destination?: string }>(response, MAX_STRIPE_PAYOUT_RESPONSE_BYTES);
      if (!transfer.id?.startsWith("tr_") || transfer.amount !== payout.amount_cents || transfer.currency !== "usd" || transfer.destination !== payout.destination_snapshot) throw new Error("connect_transfer_response_mismatch");
      await env.PLATFORM_DB.prepare("UPDATE developer_payouts SET status = 'paid', provider_reference = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'processing'").bind(transfer.id, id).run(); report.paid++;
    } catch (err) {
      // Keep captured earnings reserved after unknown outcomes. Retries reuse the same key.
      await env.PLATFORM_DB.prepare("UPDATE developer_payouts SET last_error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'processing'").bind((err as Error).message.slice(0, 160), id).run(); report.deferred++;
    }
  }
  return report;
}
