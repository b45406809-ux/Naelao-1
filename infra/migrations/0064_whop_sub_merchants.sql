-- Whop sub-merchant wallets — the business-bank-account rail (replaces the removed
-- payment_connections / Wallet Connect subsystem, migration 0063). Every business auto-
-- provisions an isolated Whop sub-merchant "company" the moment it's created (no builder
-- enrollment, no OAuth consent) — the wallet IS the business's bank account: revenue in from
-- Whop's own storefront/checkout and connected 3rd-party platforms, expenses out for the
-- business's own operating costs, owner payouts on request. Naelao never custodies these funds;
-- Whop is the regulated payment facilitator (KYC, custody, payout rails). payment_connections
-- (migration 0063) is left in place, unused — D1 has no cheap DROP TABLE-and-forget-it story and
-- nothing writes to it anymore.

CREATE TABLE IF NOT EXISTS whop_sub_merchants (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  space_id       TEXT NOT NULL,
  company_id     TEXT NOT NULL,  -- Whop's own sub-merchant company id
  owner_email    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'error')),
  balance_cents  INTEGER NOT NULL DEFAULT 0,  -- last-synced cache; source of truth is Whop itself
  currency       TEXT NOT NULL DEFAULT 'USD',
  last_synced_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One sub-merchant per business, ever (a business's wallet is provisioned once and never
-- re-provisioned by a retry — see workers/billing/src/whop-wallet.ts's provisionSubMerchant).
CREATE UNIQUE INDEX IF NOT EXISTS idx_whop_sub_merchants_space ON whop_sub_merchants(space_id);
CREATE INDEX IF NOT EXISTS idx_whop_sub_merchants_tenant ON whop_sub_merchants(tenant_id);
CREATE INDEX IF NOT EXISTS idx_whop_sub_merchants_company ON whop_sub_merchants(company_id);

-- Ledger of every wallet-affecting event: 3rd-party/Whop-storefront revenue in, the business's
-- own operating expenses out, executed owner payouts, and Naelao's own platform-fee debits.
-- Append-only audit trail; the AUTHORITATIVE balance is always Whop's own (whop_sub_merchants
-- .balance_cents is a synced cache) — this table is for history/analytics, not the ledger of
-- record.
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                TEXT PRIMARY KEY,
  space_id          TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('revenue', 'expense', 'payout', 'fee_debit')),
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  description       TEXT,
  external_ref      TEXT,  -- 3rd-party/Whop transaction id
  provider_event_id TEXT,  -- webhook idempotency key (unique per space)
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_space ON wallet_transactions(space_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_idem
  ON wallet_transactions(space_id, provider_event_id) WHERE provider_event_id IS NOT NULL;

-- Where an owner wants their payouts sent (bank/crypto/Venmo/CashApp). The actual account/
-- routing details are vault-encrypted (space_credentials via credentials worker) — this row
-- stores only a non-secret label + a pointer to the vault credential name, same pattern
-- payment_connections used for LS API keys.
CREATE TABLE IF NOT EXISTS payout_destinations (
  id                   TEXT PRIMARY KEY,
  space_id             TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('bank', 'crypto', 'venmo', 'cashapp')),
  label                TEXT NOT NULL,  -- e.g. a masked account descriptor, never the secret itself
  credential_name      TEXT NOT NULL,  -- vault pointer (space_credentials.name)
  whop_destination_id  TEXT,           -- Whop's own destination id, set once Whop verifies it
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'error')),
  is_default           INTEGER NOT NULL DEFAULT 0,
  created_by           TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payout_destinations_space ON payout_destinations(space_id);

-- A payout only ever executes after an explicit owner approval (safety invariant #5 — first
-- payout per destination requires the owner to click an emailed approval link; subsequent
-- payouts to an already-verified destination are assistant-driven but still logged here).
CREATE TABLE IF NOT EXISTS payout_requests (
  id                  TEXT PRIMARY KEY,
  space_id            TEXT NOT NULL,
  destination_id      TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL,
  note                TEXT,
  status              TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'approved', 'executed', 'denied', 'failed')),
  approval_token_hash TEXT,   -- SHA-256 of the single-use emailed approval token
  requested_by        TEXT,   -- 'assistant' or a user id
  whop_withdrawal_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payout_requests_space ON payout_requests(space_id, created_at DESC);
