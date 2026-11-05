# Product, Space and subspace

Naelao's hierarchy is **Product → end-user Space → subspace**. Launchpad is the Product. A person signs in to it and creates Spaces; each Space owns its projects and can have subspaces. A subspace is a logical scope inside its parent SpaceDO, with its own membership checks and assistant identity. It is not a separate D1 tenant or an independently isolated Durable Object.

Generic Space creation does not derive a Product slug or create a Product. The internal Launchpad bootstrap explicitly provisions the platform Product; the registry preserves other historical Product records for existing-account compatibility without offering creation of new ones.

## Migration state

Migration `0156_product_registry.sql` establishes a `products` identity table and backfills existing product IDs, names, slugs and configuration. It also adds and backfills an explicit `spaces.product_id` reference; new end-user Spaces populate it at creation. Signup, public product lookup and product session validation consult the registry. Product sessions can be verified against a Product with no backing Space row; Space requests resolve through the explicit Product reference, with a compatibility fallback for legacy parent links. An ordinary Space cannot be used as a product authentication realm. Product IDs remain stable so existing account credentials, session Durable Object names and links remain valid. Normal session validation and streaming ticket issue/consumption check that the Product and account remain active.

This is a **compatibility migration**, not a completed physical separation. Existing code still reads the legacy product backing row in `spaces`, and triggers synchronize Product metadata from that row to the new registry. New end-user Spaces are root Spaces with `product_id` set and no Product in `parent_space_id`. Existing end-user Spaces retain their legacy parent link until a verified data migration; within every SpaceDO, the end-user Space is the root and its subspaces are children. Do not delete the backing row or disable the triggers yet.

Product sessions establish identity only. The Spaces Worker separately resolves active membership in the requested end-user Space; subspace routes also enforce the SpaceDO hierarchy and subspace permissions. Membership changes must not be inferred from a product account or sibling Space. The Project Bots view can request projects from subspaces the caller may read, deduplicating projects linked to more than one subspace.

## Work required to retire the backing row

1. Audit and validate every backfilled Product reference against representative existing databases, including orphaned or inconsistent legacy relationships and suspended or deleted state.
2. Migrate the remaining product bootstrap, auth and session resolution, manifest and branding, templates, billing, webhooks, user data export/erasure, custom domains and `product_space_id`, `product_slug` and parent-walk consumers to the Product registry and direct reference. Keep old API routes as validated compatibility aliases until clients have migrated.
3. Move Product creation and updates to `products` as the authoritative write path; stop using Product backing rows for provisioning, quotas and workspace authorization. Ensure user Space quotas are applied to the correct account and subscription, rather than the shared Product tenant. Legacy Product credential fallback now requires an explicit named-user grant; migrate those integrations to Space-owned connections before removing the parent link. New directly linked Spaces do not use that fallback.
4. Verify migrations against representative existing databases, including suspended memberships and duplicate or inconsistent legacy data. Test fresh and upgraded installs, rollback, concurrent creation, cross-account isolation, revocation, session continuity and provisioner recovery before retiring legacy rows and synchronization triggers.

The current change does not perform that cutover. It does not establish deployed Cloudflare behavior or production readiness.

In local development without a provisioner queue, the first authorized subspace creation initializes the SpaceDO root and synchronizes the caller's current D1 owner or admin role. Production continues to use the provisioner queue. Local acceptance covers that initialization; deployed provisioner and upgrade acceptance remain necessary.
