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
import { checkFreeTierTemplateEligibility, loadTemplateCatalogOrNull } from "./template-catalog.js";
import { provisionBusinessWallet } from "./create-space.js";
import { resolveEffectiveBusinessLimit, isPersonalPlanTier, type PersonalPlanTier } from "@naelao/billing-core";
import { getDOName } from "@naelao/crypto";

/** Product businesses are linked to their reseller for portfolio visibility, but receive a
 * separate child tenant. Data access still requires an explicit grant; this helper makes that
 * boundary testable without inheriting the reseller's records. */
export interface LinkedBusinessTenantBoundary { parentTenantId: string; childTenantId: string; linkedBySpaceId: string; dataInheritance: "none"; }
export function linkedBusinessTenantBoundary(input: { parentTenantId: string; childTenantId: string; linkedBySpaceId: string }): LinkedBusinessTenantBoundary {
  if (!input.parentTenantId || !input.childTenantId || !input.linkedBySpaceId || input.parentTenantId === input.childTenantId) throw new Error("invalid_linked_business_tenant_boundary");
  return Object.freeze({ ...input, dataInheritance: "none" as const });
}

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
  ENVIRONMENT?: string;
  PROVISION_QUEUE?: Queue<ProvisionMessage>;
  SPACE_TYPE_REGISTRY_DO: DurableObjectNamespace<SpaceTypeRegistryDO>;
  NAELAO_CONFIG_KV: KVNamespace;
  /** G-BF08: the free-tier template gate resolves the real catalogue (free_tier_eligible) from
   *  the agents worker. Optional — absent (dev/test), the gate degrades open; see
   *  checkFreeTierTemplateEligibility. */
  AGENTS_WORKER?: Fetcher;
  /** Customer-created businesses use the same best-effort Whop business-wallet provisioning
   *  path as builder-created spaces. */
  BILLING_WORKER?: Fetcher;
  /** Phase 4 (money): resolves the CALLING end user's own personal-plan tier
   *  (ProductUserDO's /plan-tier), which narrows or widens their slice of
   *  productConfig.maxBusinessesPerEndUser — see resolveEffectiveBusinessLimit. Optional so
   *  dev/test environments without this binding degrade to the pre-existing flat-ceiling-only
   *  behavior (every existing caller/test that doesn't set this is unaffected). */
  PRODUCT_USER_DO?: DurableObjectNamespace;
  /** Serializes per-product/per-user business creation so concurrent requests cannot bypass the quota. */
  LOCK_DO?: DurableObjectNamespace;
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
  status: 400 | 403 | 404 | 429 | 503;
}

export type CreateBusinessResult = CreateBusinessOk | CreateBusinessErr;

function getRegistryDO(env: BusinessCreateEnv): DurableObjectStub<SpaceTypeRegistryDO> {
  return env.SPACE_TYPE_REGISTRY_DO.get(env.SPACE_TYPE_REGISTRY_DO.idFromName("global-space-type-registry"));
}

/** Phase 4 (money): resolve the calling end user's own personal-plan tier from their
 *  ProductUserDO (one instance per productId×endUserId — productId here is the PRODUCT ROOT,
 *  which resellerProductSpaceId already is by this file's own established invariant, matching
 *  productUserDoStub's addressing in workers/spaces/src/index.ts exactly, without importing that
 *  file — this stays intentionally self-contained per this file's own "no circular import" rule).
 *  Never throws; degrades to 'free' (the more restrictive tier, matching every other billing gate
 *  in this codebase's fail-closed posture) on any binding/network/shape error. */
export async function resolvePersonalPlanTier(
  env: BusinessCreateEnv,
  productRootSpaceId: string,
  endUserId: string,
  tenantId: string
): Promise<PersonalPlanTier> {
  if (!env.PRODUCT_USER_DO) return "free";
  try {
    const doName = await getDOName("produser", `${productRootSpaceId}:${endUserId}`, tenantId, env.PLATFORM_SECRET);
    const stub = env.PRODUCT_USER_DO.get(env.PRODUCT_USER_DO.idFromName(doName));
    const resp = await stub.fetch(new Request("http://produser/plan-tier"));
    if (!resp.ok) return "free";
    const body = await resp.json<{ plan_tier?: string }>();
    return isPersonalPlanTier(body.plan_tier) ? body.plan_tier : "free";
  } catch {
    return "free";
  }
}

async function loadManifest(env: BusinessCreateEnv, spaceTypeId: string): Promise<NaelaoSpaceTypeManifestV2 | null> {
  const cacheKey = `space-type-manifest:v2:${spaceTypeId}`;
  const cached = (await env.NAELAO_CONFIG_KV.get(cacheKey, "json")) as NaelaoSpaceTypeManifestV2 | null;
  if (cached) return cached;
  const registry = getRegistryDO(env);
  const resp = await registry.fetch(new Request(`http://registry/type/${spaceTypeId}`));
  if (!resp.ok) return null;
  const manifest = await resp.json<NaelaoSpaceTypeManifestV2>();
  await env.NAELAO_CONFIG_KV.put(cacheKey, JSON.stringify(manifest), { expirationTtl: 3600 });
  return manifest;
}

export async function loadEffectiveProductConfig(
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
export function validateCreateOptions(opts: CreateBusinessOptions): string | null {
  if (typeof opts.resellerProductSpaceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(opts.resellerProductSpaceId) ||
      typeof opts.userId !== "string" || !/^[A-Za-z0-9._:@-]{1,256}$/.test(opts.userId) ||
      typeof opts.spacetypeId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(opts.spacetypeId)) return "Invalid product, user, or SpaceType identifier.";
  if (typeof opts.name !== "string" || opts.name.length > 256 || !opts.name.trim() || opts.name.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(opts.name)) return "Business name must contain 1–100 printable characters.";
  const templateIds = opts.templateIds && opts.templateIds.length > 0 ? opts.templateIds : opts.templateId ? [opts.templateId] : [];
  if (templateIds.length > 10 || templateIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) || new Set(templateIds).size !== templateIds.length) return "Template selection is invalid or exceeds the 10-template limit.";
  if (opts.configOverrides !== undefined) {
    if (!opts.configOverrides || typeof opts.configOverrides !== "object" || Array.isArray(opts.configOverrides)) return "config_overrides must be a JSON object.";
    try { if (JSON.stringify(opts.configOverrides).length > 64 * 1024) return "config_overrides exceeds the 64 KiB limit."; }
    catch { return "config_overrides must be JSON serializable."; }
  }
  return null;
}

export interface BusinessCreationLease { acquired: boolean; release(): Promise<void>; }

/** Per-(product,user) lease shared by both business-create routes. */
export async function acquireBusinessCreationLease(
  env: BusinessCreateEnv,
  productSpaceId: string,
  userId: string,
): Promise<BusinessCreationLease> {
  if (!env.LOCK_DO) throw new Error("business_creation_lock_unavailable");
  const lockName = await getDOName("business-create", `${productSpaceId}:${userId}`, productSpaceId, env.PLATFORM_SECRET);
  const lock = env.LOCK_DO.get(env.LOCK_DO.idFromName(lockName));
  const callerId = `business-create:${crypto.randomUUID()}`;
  const acquire = await lock.fetch(new Request("http://lock/acquire", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ caller_id: callerId, ttl_ms: 10 * 60_000 }),
  }));
  if (!acquire.ok) throw new Error("business_creation_lock_unavailable");
  const state = await acquire.json<{ acquired: boolean }>();
  return {
    acquired: state.acquired,
    async release() {
      if (state.acquired) {
        const response = await lock.fetch(new Request("http://lock/release", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caller_id: callerId }),
        }));
        if (!response.ok) throw new Error("business_creation_lock_release_failed");
      }
    },
  };
}

export async function createBusinessForEndUser(
  env: BusinessCreateEnv,
  opts: CreateBusinessOptions
): Promise<CreateBusinessResult> {
  const validationError = validateCreateOptions(opts);
  if (validationError) return { ok: false, error_code: "bad_request", message: validationError, status: 400 };
  let lease: BusinessCreationLease | undefined;
  try {
    lease = await acquireBusinessCreationLease(env, opts.resellerProductSpaceId, opts.userId);
    if (!lease.acquired) return { ok: false, error_code: "business_creation_busy", message: "Another business creation is already in progress. Retry shortly.", status: 429 };
    return await createBusinessForEndUserUnlocked(env, { ...opts, name: opts.name.trim() });
  } catch {
    return { ok: false, error_code: "business_creation_unavailable", message: "Business creation is temporarily unavailable.", status: 503 };
  } finally {
    try { await lease?.release(); } catch { /* lease expires automatically if release delivery fails */ }
  }
}

async function createBusinessForEndUserUnlocked(
  env: BusinessCreateEnv,
  opts: CreateBusinessOptions
): Promise<CreateBusinessResult> {

  // 1. Resolve the reseller (parent tenant) from the product space.
  const product = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id, spacetype_id, config_json FROM spaces WHERE id = ? AND status = 'active'"
  ).bind(opts.resellerProductSpaceId).first<{ tenant_id: string; spacetype_id: string; config_json: string | null }>();
  if (!product) return { ok: false, error_code: "not_found", message: "Reseller product not found", status: 404 };
  const parentTenantId = product.tenant_id;
  const endUser = await env.PLATFORM_DB.prepare(
    "SELECT 1 AS active FROM product_end_users WHERE product_space_id = ? AND end_user_id = ? AND suspended_at IS NULL AND deleted_at IS NULL"
  ).bind(opts.resellerProductSpaceId, opts.userId).first();
  if (!endUser) return { ok: false, error_code: "not_allowed", message: "An active end-user account for this product is required.", status: 403 };

  // 2. Load effective productConfig and gate the request.
  const pc = await loadEffectiveProductConfig(env, product.spacetype_id, product.config_json);
  if (!pc || (pc.membershipModel !== "tenant" && pc.membershipModel !== "hybrid")) {
    return { ok: false, error_code: "not_allowed", message: "This product does not allow customers to create their own businesses", status: 403 };
  }
  if (!pc.allowPublicSignup) {
    // Says what this flag ACTUALLY gates. It was "Public signup is disabled for this product",
    // which is wrong in the most confusing way: end-user signup is a different route entirely
    // (product-end-user-routes.ts) and never consults this flag — so a builder hitting this saw
    // "signup is disabled" moments after watching a customer sign up successfully, and would go
    // looking for a signup setting that does not exist. This flag only decides whether a signed-in
    // customer may create their OWN business, which is exactly how the dashboard already labels it
    // ("Allow end users to sign up and create their own business").
    return {
      ok: false,
      error_code: "business_creation_disabled",
      message: "This product does not let customers create their own businesses yet. A builder can enable it under Configuration → Product Mode.",
      status: 403,
    };
  }
  const allowed = Array.isArray(pc.allowedChildSpaceTypes) ? pc.allowedChildSpaceTypes : [];
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

  // F-19 (abuse/DoS): bound how many businesses a single end user can create under this reseller
  // product. Without this, one verified free-tier email could loop POST /businesses and provision
  // unlimited spaces (SpaceDO init, agent installs, R2 writes, wallet seed each) — the rate limiter
  // only slows it, never caps it. Counts this user's OWN existing non-deleted businesses under this
  // product; a builder can tune the ceiling via productConfig.maxBusinessesPerEndUser (default 10).
  //
  // Phase 4 (money): combined with the caller's OWN personal-plan tier
  // (resolveEffectiveBusinessLimit) — a free-tier user gets only a SLICE of the builder's own
  // ceiling (never more than PERSONAL_PLAN_LIMITS.free.maxBusinessesOwned) unless they upgrade to
  // 'plus', which then unlocks the full builder-configured ceiling. The builder's own ceiling is
  // always the outer bound either way — a personal plan can never let a user exceed what the
  // builder allowed. Fails open to the flat ceiling (tier "free") on any resolution error or a
  // missing PRODUCT_USER_DO binding (dev/test) — never blocks MORE than the pre-existing behavior
  // already did, only ever the same or less restrictive.
  const configuredCeiling = (pc as { maxBusinessesPerEndUser?: number }).maxBusinessesPerEndUser;
  if (configuredCeiling !== undefined && (!Number.isSafeInteger(configuredCeiling) || configuredCeiling < 1 || configuredCeiling > 100)) {
    return { ok: false, error_code: "product_business_limit_invalid", message: "The product business limit must be an integer between 1 and 100.", status: 400 };
  }
  const productCeiling = configuredCeiling ?? 10;
  const personalTier = await resolvePersonalPlanTier(env, opts.resellerProductSpaceId, opts.userId, parentTenantId);
  const maxBusinesses = resolveEffectiveBusinessLimit(personalTier, productCeiling);
  const existingCount = await env.PLATFORM_DB.prepare(
    "SELECT COUNT(*) AS cnt FROM spaces WHERE parent_space_id = ? AND created_by = ? AND status != 'deleted'"
  ).bind(opts.resellerProductSpaceId, opts.userId).first<{ cnt: number }>();
  if ((existingCount?.cnt ?? 0) >= maxBusinesses) {
    const upgradeHint = personalTier === "free" && maxBusinesses < productCeiling
      ? ` Upgrade your personal plan to own up to ${productCeiling}.`
      : "";
    return {
      ok: false,
      error_code: "business_limit_reached",
      message: `You have reached the maximum of ${maxBusinesses} businesses for this product.${upgradeHint}`,
      status: 429,
    };
  }

  // Ensure a reseller_accounts row exists only after all no-side-effect eligibility and quota
  // checks have passed. Do not mutate reseller state for a rejected create request.
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

  // 4. Create the child business (space) under the child tenant.
  const spaceId = crypto.randomUUID();
  const useProvisioningQueue = Boolean(env.PROVISION_QUEUE) && env.ENVIRONMENT !== "development";
  const initialStatus = useProvisioningQueue ? "provisioning" : "active";
  const templateIds = opts.templateIds && opts.templateIds.length > 0 ? opts.templateIds : opts.templateId ? [opts.templateId] : [];
  const templateCatalog = await loadTemplateCatalogOrNull(env);
  const primaryTemplate = templateIds.length > 0
    ? templateCatalog?.find((template) => template.id === templateIds[0])
    : undefined;
  const configJson = JSON.stringify({
    ...(opts.configOverrides ?? {}),
    ...(templateIds.length > 0 ? { template_id: templateIds[0], template_ids: templateIds } : {}),
    ...(primaryTemplate ? {
      template_mode: primaryTemplate.template_mode,
      wallet_mode: primaryTemplate.wallet_mode,
      vertical: primaryTemplate.vertical,
      presentation_profile: primaryTemplate.presentation_profile,
    } : {}),
  });
  // The child business is its OWN top-level space under its OWN tenant (saas per-end-user
  // isolation, G-Y16): own SpaceDO, own SQLite. parent_space_id links it to the reseller's
  // product for portfolio/promotion queries; scenario_type marks it a user-created business.
  const rollbackUnprovisioned = async (includeActive = false) => {
    const cleanup = [
      env.PLATFORM_DB.prepare("DELETE FROM business_memberships WHERE business_space_id = ? AND end_user_id = ?").bind(spaceId, opts.userId).run(),
      env.PLATFORM_DB.prepare("DELETE FROM spaces WHERE id = ? AND (status = 'provisioning' OR (? = 1 AND status = 'active'))").bind(spaceId, includeActive ? 1 : 0).run(),
    ];
    if (!existing) cleanup.push(env.PLATFORM_DB.prepare("DELETE FROM tenant_hierarchy WHERE child_tenant_id = ? AND child_space_id = ?").bind(childTenantId, spaceId).run());
    await Promise.allSettled(cleanup);
  };
  try {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json, parent_space_id, depth, tenancy_mode, scenario_type, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'saas', 'user-workspace', ?, ?, ?)`
    ).bind(spaceId, childTenantId, opts.spacetypeId, opts.name, initialStatus, configJson, opts.resellerProductSpaceId, now, now, opts.userId).run();

    // 5. Record the hierarchy on first business for this child tenant, and index owner membership
    // before the queue can provision asynchronously. If any D1 write fails, remove the incomplete
    // provisioning state so a client retry does not consume quota or create a phantom business.
    if (!existing) {
      await env.PLATFORM_DB.prepare(
        `INSERT INTO tenant_hierarchy (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id, child_owner_user_id)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(childTenantId, parentTenantId, opts.resellerProductSpaceId, spaceId, opts.userId).run();
    }
    await env.PLATFORM_DB.prepare(
      `INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'owner', 'active', datetime('now'))
       ON CONFLICT(business_space_id, end_user_id) DO NOTHING`
    ).bind(spaceId, opts.resellerProductSpaceId, opts.userId).run();
  } catch (error) {
    await rollbackUnprovisioned(true);
    console.error(`[business-create] failed to persist business ${spaceId}:`, (error as Error).message);
    return { ok: false, error_code: "business_creation_unavailable", message: "Business creation is temporarily unavailable.", status: 503 };
  }

  // 6. Provision under the CHILD tenant (reuses the 10-step provisioner unchanged).
  if (useProvisioningQueue && env.PROVISION_QUEUE) {
    try {
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
    } catch (error) {
      await rollbackUnprovisioned();
      console.error(`[business-create] provision queue rejected business ${spaceId}:`, (error as Error).message);
      return { ok: false, error_code: "provision_queue_unavailable", message: "Business provisioning could not be queued. Retry shortly.", status: 503 };
    }
  }

  // Every customer-created business gets the same isolated Whop business-wallet attempt as a
  // builder-created space. Product users are already stored in D1, so the owner email is
  // available without reaching through ProductUserDO. This remains best-effort: a billing outage
  // must not turn a successfully-created business into a 500; the wallet status is surfaced by
  // the wallet routes and can be retried.
  try {
    const owner = await env.PLATFORM_DB.prepare(
      "SELECT email FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(opts.resellerProductSpaceId, opts.userId).first<{ email: string | null }>();
    if (owner?.email) {
      await provisionBusinessWallet(env, {
        tenantId: childTenantId,
        spaceId,
        ownerEmail: owner.email,
        businessName: opts.name,
      });
    }
  } catch (err) {
    console.error(`[business-create] wallet provisioning lookup failed for space ${spaceId}:`, (err as Error).message);
  }

  return { ok: true, tenantId: childTenantId, spaceId, status: initialStatus, parentTenantId };
}
