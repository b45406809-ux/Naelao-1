-- S0.3: webhook exactly-once processing (P0 money-integrity fix).
--
-- Before this migration, handleLemonSqueezyWebhook had no top-level idempotency gate: a Lemon
-- Squeezy retry (any non-2xx response or timeout triggers one) would re-run the ENTIRE handler,
-- including reseller_ledger writes (no unique constraint at all — a plain INSERT with a random
-- id, so every retry inserted a second row and double-counted the wholesale invoice) and
-- wakeAgent (re-running "fulfil + send confirmation + provision access" → duplicate welcome
-- emails / entitlement grants). launchpad_orders already had its own provider_event_id unique
-- index, but the KEY fed into it was a synthetic ${type}:${customerId}:${gross}:${productId}
-- string (packages/billing-core's LS provider discarded the real event.data.id), so two genuinely
-- distinct same-price purchases collided and the second was silently dropped.
--
-- This migration adds ONE processed-events table that gates the WHOLE handler (checked first,
-- before reseller attribution / order recording / wakeAgent), plus a real unique constraint on
-- reseller_ledger keyed on the actual provider event id (now correctly threaded through from
-- event.data.id instead of the discarded/synthetic key).

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL DEFAULT '',
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, event_id)
);

ALTER TABLE reseller_ledger ADD COLUMN provider_event_id TEXT;

-- Partial (nullable-safe) unique index — every real event carries a provider_event_id after this
-- pass; NULL is only possible for rows written before this migration, which must remain distinct.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_ledger_provider_event
  ON reseller_ledger(provider_event_id) WHERE provider_event_id IS NOT NULL;
