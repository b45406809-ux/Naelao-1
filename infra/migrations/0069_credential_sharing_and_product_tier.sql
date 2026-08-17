-- Credential hierarchy expansion (naelao->product->business->personal), per the user's own
-- design: a space-scope credential that's shared can be shared with EVERYONE in the business
-- (existing default, unchanged) OR with a SELECTED subset of members — an admin-only choice,
-- checked by the worker (workers/credentials/src/index.ts resolveCredential), not the DB.
--
-- shared_with_user_ids: NULL (default) = shared with every member, matching today's behavior.
-- A JSON array of user ids narrows the shared fallback to just those members. Only meaningful
-- on scope='space' rows with is_override=0 (an is_override row is a FORCE, not an opt-in share,
-- and always wins regardless of this column).
ALTER TABLE space_credentials ADD COLUMN shared_with_user_ids TEXT;

-- Product-wide tier: a business (child) space with no local match (no personal, no business-
-- shared) falls through to its PRODUCT ROOT's own scope='space' credential row — the builder's
-- own product-level default, set once in the builder dashboard and used by every business under
-- that product unless a business/user overrides it. This needs no new table: the product root
-- is just another space, and its own space_credentials rows already have everything required.
-- Resolution walks spaces.parent_space_id exactly once (businesses are direct children of the
-- product root in this platform's model, never nested further) — see resolveCredential().
