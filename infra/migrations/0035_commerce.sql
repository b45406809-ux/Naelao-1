-- Commerce primitive (spec §11 Launchpad: "Owner uploads products and sets prices").
--
-- Generic + manifest-gated, NOT hardcoded to Launchpad: any SpaceType whose manifest sets
-- productConfig.commerce.enabled = true gets product/order tables keyed by space_id. A
-- SpaceType that does not opt in simply never writes here. Money-in is reserved to Naelao's
-- Lemon Squeezy store (the prebuilt commerce script) so the platform fee always applies —
-- naelao_fee_bps records the basis-points fee captured per order.

-- A digital product the owner sells (course, ebook, template, subscription tier, …).
CREATE TABLE IF NOT EXISTS launchpad_products (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  -- Price in minor units (cents). 0 = free / lead magnet.
  price_cents   INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD',
  -- 'one_time' | 'subscription'. Subscriptions map to a Lemon Squeezy variant.
  kind          TEXT NOT NULL DEFAULT 'one_time'
    CHECK (kind IN ('one_time','subscription')),
  -- R2 key of the deliverable (the fulfilment agent reads this to deliver the product).
  fulfillment_r2_key TEXT,
  -- Lemon Squeezy variant id this product maps to in Naelao's store (set when published).
  ls_variant_id TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','archived')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_space ON launchpad_products(space_id, status);

-- A customer order. Written by the Lemon Squeezy webhook on payment.success, then the
-- fulfilment agent is woken to deliver. Fee + net are computed at write time.
CREATE TABLE IF NOT EXISTS launchpad_orders (
  id               TEXT PRIMARY KEY,
  space_id         TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  product_id       TEXT,
  customer_email   TEXT,
  customer_name    TEXT,
  -- Gross the customer paid (cents) and the platform fee Naelao captured.
  gross_cents      INTEGER NOT NULL DEFAULT 0,
  fee_cents        INTEGER NOT NULL DEFAULT 0,
  net_cents        INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  -- Provider order/subscription identifiers (Lemon Squeezy).
  ls_order_id      TEXT,
  ls_subscription_id TEXT,
  status           TEXT NOT NULL DEFAULT 'paid'
    CHECK (status IN ('paid','fulfilling','fulfilled','refunded','failed')),
  -- Idempotency: a provider event id we have already processed (dedupe webhook retries).
  provider_event_id TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_space ON launchpad_orders(space_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_provider_event
  ON launchpad_orders(provider_event_id) WHERE provider_event_id IS NOT NULL;

-- Provisioned business services (storefront, business email, custom domain). One row per
-- (space_id, kind). Written by the prebuilt business scripts; reflects on billing.
CREATE TABLE IF NOT EXISTS business_services (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  kind         TEXT NOT NULL
    CHECK (kind IN ('storefront','business_email','custom_domain')),
  -- Naelao-provided hostname/address (e.g. {slug}.naelao.com, hi@{slug}.naelao-mail.com).
  naelao_handle TEXT,
  -- Customer's own domain when they opt into custom_domain (Cloudflare for SaaS hostname).
  custom_domain TEXT,
  -- Cloudflare for SaaS custom_hostname id (when custom_domain is provisioned).
  cf_hostname_id TEXT,
  config_json  TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('provisioning','active','pending_dns','suspended','deleted')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bizsvc_space_kind ON business_services(space_id, kind);
