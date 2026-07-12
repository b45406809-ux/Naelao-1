-- Wallet Connect: a space's OWN payment account (Stripe Connect Express sub-account, or the
-- builder's own dedicated Lemon Squeezy store) so product revenue settles into an account the
-- builder owns — never Naelao's store, never the builder's personal account. This is the
-- "Stripe-Connect-style split-payment primitive" migration 0053's own header named as the
-- missing piece behind manual payout fulfillment.
--
-- Custody model:
--   stripe        → provider_account_id is a FRESH Express connected account (acct_...) created
--                   by the platform key; onboarding/KYC/bank details are Stripe-hosted (Naelao
--                   never sees them); checkouts are direct charges ON that account with
--                   application_fee_amount as the platform cut. Naelao never holds funds and has
--                   no debit capability.
--   lemon_squeezy → provider_account_id is the builder's own LS store id; their API key +
--                   the per-connection webhook signing secret live ENCRYPTED in the credentials
--                   vault (space_credentials) — this table stores only the credential NAMES,
--                   never secret material.
CREATE TABLE IF NOT EXISTS payment_connections (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  space_id                  TEXT NOT NULL,
  provider                  TEXT NOT NULL CHECK (provider IN ('stripe', 'lemon_squeezy')),
  -- pending: created, awaiting Stripe hosted onboarding (charges_enabled=false)
  -- active:  usable for checkouts
  -- error:   provider reported a hard problem (e.g. account rejected)
  -- disabled: disconnected — kept as an audit row; a new connection may be created
  status                    TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disabled', 'error')),
  provider_account_id       TEXT,
  -- Vault pointers (space_credentials.name), never secrets:
  credential_name           TEXT,   -- LS API key credential (lemon_squeezy only)
  webhook_secret_credential TEXT,   -- LS per-connection webhook signing secret (lemon_squeezy only)
  details_json              TEXT NOT NULL DEFAULT '{}',
  created_by                TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One live (non-disabled) connection per space — same partial-unique-index technique as
-- 0040_space_credentials.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_connections_live_space
  ON payment_connections(space_id) WHERE status != 'disabled';
CREATE INDEX IF NOT EXISTS idx_payment_connections_tenant
  ON payment_connections(tenant_id);
-- Webhook dispatch resolves a Connect event by which provider account it happened on.
CREATE INDEX IF NOT EXISTS idx_payment_connections_provider_account
  ON payment_connections(provider, provider_account_id);
