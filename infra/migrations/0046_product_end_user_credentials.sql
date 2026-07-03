-- Three-Tier Platform Model, Phase 6: naelao-native end-user authentication (Journey 1B — "End
-- user signs up or is invited via the builder's configured auth provider"). ProductUserDO
-- (Phase 2) mints and verifies SESSIONS but never verified an identity in the first place — for
-- authProvider: 'naelao-native' specifically, Naelao itself must hold the credential (email +
-- password) an end user signs up with. This is NOT the same thing as a platform user's row (the
-- `users` table, migration 0001) — end users are scoped entirely to the product they joined, per
-- the spec's Tier 2 definition ("Their identity... are all scoped to the product... not to
-- Naelao"). Extends the existing product_end_users roster (migration 0045) rather than forking a
-- parallel table, since a credential is just another fact about the SAME roster row.
--
-- Other authProvider values (clerk / custom-oidc / saml-sso) verify identity externally and never
-- populate password_hash — this column is null for them; the signup/login routes below only ever
-- apply to the naelao-native path (see product-end-user-routes.ts).
ALTER TABLE product_end_users ADD COLUMN password_hash TEXT;

-- A product's own login is keyed by (product_space_id, email) — the same email can sign up for
-- unrelated products independently (Tier 2 identities never share across products, per spec).
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_end_users_login
  ON product_end_users(product_space_id, email) WHERE email IS NOT NULL;
