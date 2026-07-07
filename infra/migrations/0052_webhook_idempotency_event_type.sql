-- P0-5 follow-on: fixes a real, independent bug found while building the storefront-sale wallet
-- settlement + refund clawback.
--
-- processed_webhook_events (0050_webhook_idempotency.sql) dedupes on (provider, event_id) alone.
-- Lemon Squeezy's own `data.id` is the underlying RESOURCE's id, not a per-delivery event id: an
-- `order_refunded` webhook for an order carries the SAME `data.id` as the original `order_created`
-- webhook for that same order, and every subscription lifecycle event (created / updated /
-- cancelled / paused / resumed / payment_success / payment_failed / payment_recovered) for one
-- subscription all share that subscription's own resource id too. With only (provider, event_id)
-- unique, the FIRST event ever seen for a given order/subscription "claims" that id forever — every
-- later, genuinely different event for the same resource is treated as a duplicate delivery of the
-- first one and silently no-op'd before any side effect runs. In practice this meant: a refund was
-- never actually processed once the original sale had been recorded, and a subscription's status
-- changes / repeat renewal payments after the first webhook were silently dropped too.
--
-- Fix: the uniqueness constraint must include event_type, since (provider, event_id, event_type)
-- is what's actually guaranteed unique per delivery — a genuine retry of the SAME webhook always
-- resends the SAME event_type for the SAME resource id, while a later, different lifecycle event
-- for that resource now correctly gets its own row. SQLite can't ALTER a PRIMARY KEY in place, so
-- this recreates the table.
CREATE TABLE processed_webhook_events_v2 (
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL DEFAULT '',
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, event_id, event_type)
);

INSERT INTO processed_webhook_events_v2 (provider, event_id, event_type, processed_at)
  SELECT provider, event_id, event_type, processed_at FROM processed_webhook_events;

DROP TABLE processed_webhook_events;
ALTER TABLE processed_webhook_events_v2 RENAME TO processed_webhook_events;
