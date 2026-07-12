// Shared business-creation logic — a customer creates their own business under a reseller-mode
// product (spec G-AS34/G-AS35, §49 Scenario C). Extracted from the original POST /reseller/spaces
// handler (index.ts) so the Three-Tier Platform Model's Phase C product-scoped wrapper
// (POST /spaces/:productSpaceId/businesses, business-routes.ts) can reuse the exact same
// security-sensitive gating/tenant-hierarchy logic instead of re-implementing it — "reuse, don't
// reinvent." Both callers now share this one path; there is no second copy of this logic anywhere.
//
// Kept dependency-free of index.ts's own Env/types (declares its own minimal structural Env), so
// index.ts -> business-create.ts and business-routes.ts -> business-create.ts both stay one-way —
// no circular import.

import type { SpaceTypeProductConfig, NaelaoSpaceTypeManifestV2, SpaceTypeRegistryDO } from "./do/SpaceTypeRegistryDO.js";
import { checkFreeTierTemplateEligibility } from "./template-catalog.js";

export interface ProvisionMessage {
  type: "space_provision" | "space_deprovision";
  spaceId: string;
  tenantId: string;
  spaceTypeId: string;
  spaceName: string;
  templateId?: string;
  templateIds?: string[];
  requestedAt: string;
  userId?: string;
}

export interface BusinessCreateEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  PROVISION_QUEUE?: Queue<ProvisionMessage>;
  SPACE_TYPE_REGISTRY_DO: DurableObjectNamespace<SpaceTypeRegistryDO>;
  NAELAO_CONFIG_KV: KVNamespace;
  /** G-BF08: the free-tier template gate resolves the real catalogue (free_tier_eligible) from
   *  the agents worker. Optional — absent (dev/test), the gate degrades open; see
   *  checkFreeTierTemplateEligibility. */
  AGENTS_WORKER?: Fetcher;
}

export interface CreateBusinessOptions {
  resellerProductSpaceId: string;
  userId: string;
  name: string;
  spacetypeId: string;
  /** Back-compat single template. Ignored when templateIds is non-empty. */
  templateId?: string;
  /** Phase C: a business built from more than one template. */
  templateIds?: string[];
  configOverrides?: Record<string, unknown>;
}

export interface CreateBusinessOk {
  ok: true;
  tenantId: string;
  spaceId: string;
  status: string;
  parentTenantId: string;
}

export interface CreateBusinessErr {
  ok: false;
  error_code: string;
  message: string;
  status: 400 | 403 | 404 | 429;
}

export type CreateBusinessResult = CreateBusinessOk | CreateBusinessErr;

function getRegistryDO(env: BusinessCreateEnv): DurableObjectStub<SpaceTypeRegistryDO> {
  return env.SPACE_TYPE_REGISTRY_DO.get(env.SPACE_TYPE_REGISTRY_DO.idFromName("global-space-type-registry"));
}

async function loadManifest(env: BusinessCreateEnv, spaceTypeId: string): Promise<NaelaoSpaceTypeManifestV2 | null> {
  const cacheKey = `space-type-manifest:${spaceTypeId}`;
  const cached = (await env.NAELAO_CONFIG_KV.get(cacheKey, "json")) as NaelaoSpaceTypeManifestV2 | null;
  if (cached) return cached;
  const registry = getRegistryDO(env);
  const resp = await registry.fetch(new Request(`http://registry/type/${spaceTypeId}`));
  if (!resp.ok) return null;
  const manifest = await resp.json<NaelaoSpaceTypeManifestV2>();
  await env.NAELAO_CONFIG_KV.put(cacheKey, JSON.stringify(manifest), { expirationTtl: 3600 });
  return manifest;
}

async function loadEffectiveProductConfig(
  env: BusinessCreateEnv,
  spaceTypeId: string,
  spaceConfigJson: string | null
): Promise<SpaceTypeProductConfig | null> {
  const manifest = await loadManifest(env, spaceTypeId);
  const base = manifest?.productConfig ?? null;
  let override: Partial<SpaceTypeProductConfig> | undefined;
  if (spaceConfigJson) {
    try {
      const cfg = JSON.parse(spaceConfigJson) as { productConfig?: Partial<SpaceTypeProductConfig> };
      override = cfg.productConfig;
    } catch { /* ignore malformed */ }
  }
  if (!base && !override) return null;
  return { ...(base ?? {}), ...(override ?? {}) } as SpaceTypeProductConfig;
}

/** Create a customer's own business (space) under a reseller-mode product. Shared by
 *  POST /reseller/spaces (index.ts, no path spaceId — legacy) and
 *  POST /spaces/:productSpaceId/businesses (business-routes.ts, Phase C's product-scoped,
 *  router-allowlistable wrapper). Identical gating + tenant-hierarchy + provisioning-queue logic
 *  either way; callers differ only in how they resolve `resellerProductSpaceId` and what they do
 *  with the result (the wrapper additionally dual-writes business_memberships for the owner). */
export async function createBusinessForEndUser(
  env: BusinessCreateEnv,
  opts: CreateBusinessOptions
): Promise<CreateBusinessResult> {
  if (!opts.resellerProductSpaceId || !opts.name || !opts.spacetypeId) {
    return { ok: false, error_code: "bad_request", message: "reseller_product_space_id, name, spacetype_id are required", status: 400 };
  }

  // 1. Resolve the reseller (parent tenant) from the product space.
  const product = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id, spacetype_id, config_json FROM spaces WHERE id = ? AND status = 'active'"
  ).bind(opts.resellerProductSpaceId).first<{ tenant_id: string; spacetype_id: string; config_json: string | null }>();
  if (!product) return { ok: false, error_code: "not_found", message: "Reseller product not found", status: 404 };
  const parentTenantId = product.tenant_id;

  // 2. Load effective productConfig and gate the request.
  const pc = await loadEffectiveProductConfig(env, product.spacetype_id, product.config_json);
  if (!pc || (pc.membershipModel !== "tenant" && pc.membershipModel !== "hybrid")) {
    return { ok: false, error_code: "not_allowed", message: "This product does not allow customers to create their own businesses", status: 403 };
  }
  if (!pc.allowPublicSignup) {
    return { ok: false, error_code: "signup_closed", message: "Public signup is disabled for this product", status: 403 };
  }
  const allowed = pc.allowedChildSpaceTypes ?? [];
  if (!allowed.includes(opts.spacetypeId)) {
    return { ok: false, error_code: "spacetype_not_allowed", message: `SpaceType '${opts.spacetypeId}' is not offered by this product`, status: 403 };
  }

  // 2b. G-GRW08 (Appendix AJ): on the free plan only free_tier_eligible templates may be
  // instantiated. The plan that matters is the OWNING builder org's (parentTenantId) — end-user
  // claims already resolve to it, and the child tenant minted below has no org/plan of its own.
  // Checked BEFORE any side effect (reseller_accounts upsert, tenant mint) so a rejected create
  // leaves nothing behind.
  const requestedTemplates = opts.templateIds && opts.templateIds.length > 0
    ? opts.templateIds
    : opts.templateId ? [opts.templateId] : [];
  const gate = await checkFreeTierTemplateEligibility(env.PLATFORM_DB, env, parentTenantId, requestedTemplates);
  if (!gate.ok) {
    return { ok: false, error_code: gate.error_code, message: gate.message, status: gate.status };
  }

  // 3. Find or mint the customer's child tenant (one per customer per reseller).
  const existing = await env.PLATFORM_DB.prepare(
    "SELECT child_tenant_id FROM tenant_hierarchy WHERE parent_tenant_id = ? AND child_owner_user_id = ? LIMIT 1"
  ).bind(parentTenantId, opts.userId).first<{ child_tenant_id: string }>();
  const childTenantId = existing?.child_tenant_id ?? `ten_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();

  // Ensure a reseller_accounts row exists for the parent (lazily, from productConfig). WS-3:
  // previously hardcoded wholesale_cents=NULL/referral_share_pct=0.0 literals with no rate
  // fields anywhere in productConfig to seed from — now reads pc.resellerRates (set via PATCH
  // /builder/products/:id/reseller). The ON CONFLICT branch only refreshes product_space_id, not
  // the rates: a builder's rate change is applied directly to this row by that same PATCH
  // endpoint (immediate effect on the existing row), not deferred until the next business is
  // created under this reseller — re-seeding rates here on every conflict would silently
  // overwrite a rate the builder set AFTER this tenant's account row already existed.
  await env.PLATFORM_DB.prepare(
    `INSERT INTO reseller_accounts (tenant_id, product_space_id, billing_relationship, wholesale_cents, referral_share_pct, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET product_space_id = excluded.product_space_id, updated_at = excluded.updated_at`
  ).bind(
    parentTenantId,
    opts.resellerProductSpaceId,
    pc.billingRelationship ?? "platform",
    pc.resellerRates?.wholesaleCents ?? null,
    pc.resellerRates?.referralSharePct ?? 0.0,
    now
  ).run();

  // F-19 (abuse/DoS): bound how many businesses a single end user can create under this reseller
  // product. Without this, one verified free-tier email could loop POST /businesses and provision
  // unlimited spaces (SpaceDO init, agent installs, R2 writes, wallet seed each) — the rate limiter
  // only slows it, never caps it. Counts this user's OWN existing non-deleted businesses under this
  // product; a builder can tune the ceiling via productConfig.maxBusinessesPerEndUser (default 10).
  const maxBusinesses = (pc as { maxBusinessesPerEndUser?: number }).maxBusinessesPerEndUser ?? 10;
  const existingCount = await env.PLATFORM_DB.prepare(
    "SELECT COUNT(*) AS cnt FROM spaces WHERE parent_space_id = ? AND created_by = ? AND status != 'deleted'"
  ).bind(opts.resellerProductSpaceId, opts.userId).first<{ cnt: number }>();
  if ((existingCount?.cnt ?? 0) >= maxBusinesses) {
    return { ok: false, error_code: "business_limit_reached", message: `You have reached the maximum of ${maxBusinesses} businesses for this product`, status: 429 };
  }

  // 4. Create the child business (space) under the child tenant.
  const spaceId = crypto.randomUUID();
  const initialStatus = env.PROVISION_QUEUE ? "provisioning" : "active";
  const templateIds = opts.templateIds && opts.templateIds.length > 0 ? opts.templateIds : opts.templateId ? [opts.templateId] : [];
  const configJson = JSON.stringify({
    ...(opts.configOverrides ?? {}),
    ...(templateIds.length > 0 ? { template_id: templateIds[0], template_ids: templateIds } : {}),
  });
  // The child business is its OWN top-level space under its OWN tenant (saas per-end-user
  // isolation, G-Y16): own SpaceDO, own SQLite. parent_space_id links it to the reseller's
  // product for portfolio/promotion queries; scenario_type marks it a user-created business.
  await env.PLATFORM_DB.prepare(
    `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json, parent_space_id, depth, tenancy_mode, scenario_type, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'saas', 'user-workspace', ?, ?, ?)`
  ).bind(spaceId, childTenantId, opts.spacetypeId, opts.name, initialStatus, configJson, opts.resellerProductSpaceId, now, now, opts.userId).run();

  // 5. Record the hierarchy on first business for this child tenant.
  if (!existing) {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hierarchy (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id, child_owner_user_id)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(childTenantId, parentTenantId, opts.resellerProductSpaceId, spaceId, opts.userId).run();
  }

  // 6. Provision under the CHILD tenant (reuses the 10-step provisioner unchanged).
  if (env.PROVISION_QUEUE) {
    await env.PROVISION_QUEUE.send({
      type: "space_provision",
      spaceId,
      tenantId: childTenantId,
      spaceTypeId: opts.spacetypeId,
      spaceName: opts.name,
      ...(templateIds.length > 0 ? { templateId: templateIds[0]!, templateIds } : {}),
      userId: opts.userId,
      requestedAt: now,
    });
  }

  // Every business auto-provisions a Whop sub-merchant wallet. Deliberately NOT wired here yet:
  // unlike the builder-created paths (createSpaceRecord's callers, which resolve a real email
  // from the platform `users` table), this business's owner is a ProductUserDO end user — there
  // is no D1 row with their email, and resolving it needs a ProductUserDO round trip this file
  // doesn't have wired (business-create.ts is deliberately kept dependency-free of index.ts's own
  // DO-stub helpers). Documented gap, not silently dropped — tracked as a real follow-up rather
  // than fabricating a placeholder email Whop would send real payout-approval mail to.

  return { ok: true, tenantId: childTenantId, spaceId, status: initialStatus, parentTenantId };
}
