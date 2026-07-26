// Shared space-creation logic — extracted so `/builder/products` (Three-Tier Platform Model,
// builder-routes.ts) doesn't reimplement a second, incomplete creation path. Phase 3 originally
// did exactly that (a bare INSERT with no quota check, no config-schema validation, no
// provisioning-queue enqueue, no template_id support) — a real split-brain with the existing,
// fully-working `POST /spaces` route this file now backs too. Both routes call the SAME
// createSpaceRecord(); there is exactly one space-creation code path.

import { mintInternalToken } from "@naelao/http";
import { checkFreeTierTemplateEligibility } from "./template-catalog.js";

export interface ProvisionMessage {
  type: "space_provision" | "space_deprovision";
  spaceId: string;
  tenantId: string;
  spaceTypeId: string;
  spaceName: string;
  templateId?: string;
  requestedAt: string;
  userId?: string;
}

export interface CreateSpaceEnv {
  PLATFORM_DB: D1Database;
  PROVISION_QUEUE?: Queue<ProvisionMessage>;
  /** G-BF08: the free-tier template gate resolves the real catalogue (free_tier_eligible) from
   *  the agents worker, KV-cached. Both optional — absent (dev/test), the gate degrades open;
   *  see checkFreeTierTemplateEligibility. */
  NAELAO_CONFIG_KV?: KVNamespace;
  AGENTS_WORKER?: Fetcher;
  /** Every business auto-provisions a Whop sub-merchant wallet — no builder action, no OAuth.
   *  Both optional: absent (dev/test), provisioning is skipped and the wallet stays
   *  unprovisioned until an operator retries (see provisionBusinessWallet). */
  BILLING_WORKER?: Fetcher;
  PLATFORM_SECRET?: string;
}

/**
 * Fire off Whop sub-merchant provisioning for a freshly-created business. Best-effort and
 * non-blocking of the caller's own success path (matches seedOwnerMember's own "idempotent and
 * non-fatal on failure" precedent) — a business is usable immediately even if wallet
 * provisioning is still in flight or the billing worker is briefly unavailable; the wallet
 * balance read surfaces `status: "not_provisioned"`/`"error"` honestly rather than pretending.
 */
export async function provisionBusinessWallet(
  env: CreateSpaceEnv,
  params: { tenantId: string; spaceId: string; ownerEmail: string; businessName: string }
): Promise<void> {
  if (!env.BILLING_WORKER || !env.PLATFORM_SECRET || !params.ownerEmail) return;
  try {
    await env.BILLING_WORKER.fetch(
      new Request("http://billing-worker/billing/whop-wallet/provision", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": params.tenantId,
          "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, params.tenantId),
        },
        body: JSON.stringify({
          space_id: params.spaceId,
          owner_email: params.ownerEmail,
          business_name: params.businessName,
        }),
      })
    );
  } catch (err) {
    console.error(`[create-space] wallet provisioning request failed for space ${params.spaceId}:`, (err as Error).message);
  }
}

export interface SchemaValidationError {
  field: string;
  error: string;
}

// G-I13: quota enforcement — matches the values index.ts's /spaces route used before this
// extraction verbatim (do not "improve" these without checking billing/entitlements agree).
const SPACE_LIMITS: Record<string, number> = {
  free: 3,
  starter: 25,
  pro: 100,
  enterprise: 1000,
};

export class SpaceCreationError extends Error {
  constructor(public status: number, public error_code: string, message: string, public errors?: SchemaValidationError[]) {
    super(message);
  }
}

async function enforceSpaceQuota(db: D1Database, tenantId: string): Promise<void> {
  // BUG FOUND during Phase 4 (Three-Tier Platform Model): this queried a table called
  // "organizations", which no migration anywhere creates — the real table is `orgs`
  // (infra/migrations/0002_orgs.sql, id == tenantId, plan_tier column). Since this function is
  // called unconditionally on every space creation and its caller only special-cases the
  // `quota_exceeded` error code (rethrowing everything else), this meant POST /spaces has likely
  // been hard-500ing on every single call in any real deployment — nothing in this codebase's
  // test suite exercised POST /spaces before this phase, so nothing caught it until now.
  const org = await db.prepare("SELECT plan_tier FROM orgs WHERE id = ?").bind(tenantId).first<{ plan_tier: string }>();
  const tier = org?.plan_tier ?? "free";
  const limit = SPACE_LIMITS[tier] ?? SPACE_LIMITS["free"]!;
  const row = await db.prepare("SELECT COUNT(*) as count FROM spaces WHERE tenant_id = ? AND status != 'deleted'").bind(tenantId).first<{ count: number }>();
  const count = row?.count ?? 0;
  if (count >= limit) {
    throw new SpaceCreationError(402, "quota_exceeded", `Space limit reached for ${tier} plan (${limit} spaces)`);
  }
}

// G-AV02: Lightweight JSON Schema (draft-07 subset) validator for SpaceType config. Validates:
// type, required, properties (type+enum), minLength/maxLength, minimum/maximum. No ajv import —
// keeps the Workers bundle small.
export function validateConfigSchema(config: Record<string, unknown>, schema: Record<string, unknown>): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
  const required = schema["required"] as string[] | undefined;

  if (required) {
    for (const field of required) {
      if (config[field] === undefined || config[field] === null || config[field] === "") {
        errors.push({ field, error: "required field missing" });
      }
    }
  }
  if (properties) {
    for (const [field, fieldSchema] of Object.entries(properties)) {
      const value = config[field];
      if (value === undefined || value === null) continue;
      const expectedType = fieldSchema["type"] as string | undefined;
      if (expectedType) {
        const actualType = Array.isArray(value) ? "array" : typeof value;
        if (actualType !== expectedType) {
          errors.push({ field, error: `expected type ${expectedType}, got ${actualType}` });
          continue;
        }
      }
      const enumValues = fieldSchema["enum"] as unknown[] | undefined;
      if (enumValues && !enumValues.includes(value)) {
        errors.push({ field, error: `value must be one of: ${enumValues.join(", ")}` });
      }
      if (typeof value === "string") {
        const minLen = fieldSchema["minLength"] as number | undefined;
        if (minLen !== undefined && value.length < minLen) errors.push({ field, error: `minimum length is ${minLen}` });
        const maxLen = fieldSchema["maxLength"] as number | undefined;
        if (maxLen !== undefined && value.length > maxLen) errors.push({ field, error: `maximum length is ${maxLen}` });
      }
      if (typeof value === "number") {
        const minimum = fieldSchema["minimum"] as number | undefined;
        if (minimum !== undefined && value < minimum) errors.push({ field, error: `minimum value is ${minimum}` });
        const maximum = fieldSchema["maximum"] as number | undefined;
        if (maximum !== undefined && value > maximum) errors.push({ field, error: `maximum value is ${maximum}` });
      }
    }
  }
  return errors;
}

/** Subdomains that collide with Naelao infrastructure or enable phishing. Module-scoped so the
 *  explicit-slug validator and the name-derived fallback below can never disagree about what is
 *  allowed — a derived slug reaching the insert unchecked would bypass this entirely. */
const RESERVED_SLUGS = new Set([
  "www", "api", "api2", "app", "mail", "email", "smtp", "imap", "pop",
  "admin", "superadmin", "root", "naelao", "naelao-admin", "dashboard",
  "login", "signin", "signup", "register", "auth", "oauth", "sso",
  "billing", "payments", "pay", "checkout", "subscribe", "pricing",
  "status", "uptime", "health", "monitor", "metrics", "telemetry",
  "support", "help", "docs", "documentation", "legal", "terms", "privacy",
  "blog", "news", "press", "media", "marketing", "careers", "jobs",
  "cdn", "static", "assets", "files", "upload", "downloads",
  "dev", "staging", "preview", "prod", "production", "sandbox", "test",
  "internal", "intranet", "corp", "enterprise", "security",
  "webhooks", "webhook", "events", "queue", "pubsub",
  "socket", "ws", "wss", "stream", "sse",
]);

export interface CreateSpaceParams {
  tenantId: string;
  userId?: string;
  name: string;
  spacetypeId: string;
  /** For Launchpad: the selected product template (e.g. "creator-store"). */
  templateId?: string;
  /** Three-Tier Platform Model: the platform-subdomain identity (migration 0044, unique). */
  productSlug?: string;
  configOverrides?: Record<string, unknown>;
}

export interface CreateSpaceResult {
  id: string;
  status: string;
  created_at: string;
}


/**
 * Turn a product name into a usable, free platform slug.
 *
 * Collisions are resolved by suffixing rather than by rejecting: a builder naming their product
 * "Launchpad" when someone else already has that slug should still end up with a working product,
 * not a 409 on a field they never filled in. Returns undefined only if nothing usable can be
 * derived at all (a name of pure punctuation), in which case the product is created slugless
 * exactly as before — degrading, never blocking creation over a derived convenience value.
 */
export async function deriveAvailableSlug(db: D1Database, name: string): Promise<string | undefined> {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (base.length < 2) return undefined;

  for (let attempt = 0; attempt < 6; attempt++) {
    // First try the clean slug, then progressively-random suffixes. Random rather than an
    // incrementing counter so two products created at once can't race onto the same candidate.
    const candidate = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (RESERVED_SLUGS.has(candidate)) continue;
    try {
      const taken = await db
        .prepare("SELECT 1 AS x FROM spaces WHERE product_slug = ?")
        .bind(candidate)
        .first<{ x: number }>();
      if (!taken) return candidate;
    } catch {
      // Can't check: fall through to slugless rather than risk a UNIQUE failure that would turn
      // a valid creation into an error.
      return undefined;
    }
  }
  return undefined;
}

/** The one space-creation code path: quota check, config-schema validation, insert (as
 *  'provisioning' when a queue is bound, else immediately 'active' — matches local-dev behavior
 *  when PROVISION_QUEUE isn't configured), and provisioning-queue enqueue with template_id.
 *  Throws SpaceCreationError on any validation/quota failure; callers translate to their own
 *  response shape (the plain /spaces route and /builder/products use different JSON shapes). */
export async function createSpaceRecord(env: CreateSpaceEnv, params: CreateSpaceParams): Promise<CreateSpaceResult> {
  if (!params.name || !params.spacetypeId) {
    throw new SpaceCreationError(400, "bad_request", "name and spacetype_id are required");
  }

  if (params.configOverrides) {
    try {
      // NOTE: the real migration (infra/migrations/0003_spaces.sql) names this column
      // schema_json, never config_schema — a prior version of this query used the wrong
      // name and threw a D1 "no such column" error on every call that reached here
      // (i.e. every product-wizard launch, since the wizard always sets configOverrides),
      // surfacing as a generic "An unexpected error occurred" 500 with no other symptom.
      const spaceTypeRow = await env.PLATFORM_DB.prepare("SELECT schema_json FROM spacetypes WHERE id = ?").bind(params.spacetypeId).first<{ schema_json: string | null }>();
      if (spaceTypeRow?.schema_json) {
        const schema = JSON.parse(spaceTypeRow.schema_json) as Record<string, unknown>;
        const validationErrors = validateConfigSchema(params.configOverrides, schema);
        if (validationErrors.length > 0) {
          throw new SpaceCreationError(400, "config_validation_failed", "SpaceType config validation failed", validationErrors);
        }
      }
    } catch (err) {
      if (err instanceof SpaceCreationError) throw err;
      // Missing/malformed schema, or a lookup failure — skip validation, don't block creation.
    }
  }

  await enforceSpaceQuota(env.PLATFORM_DB, params.tenantId);

  // G-GRW08 (Appendix AJ): on the free plan only free_tier_eligible templates may be
  // instantiated — the flag existed since Phase F but no creation path ever checked it.
  if (params.templateId) {
    const gate = await checkFreeTierTemplateEligibility(env.PLATFORM_DB, env, params.tenantId, [params.templateId]);
    if (!gate.ok) {
      throw new SpaceCreationError(gate.status, gate.error_code, gate.message);
    }
  }

  // A product with no slug is not "a product without a subdomain yet" — it is a product nobody
  // can reach. The Product Shell resolves every end-user URL as /p/{product_slug}, and nothing
  // anywhere lets a builder set the slug after creation, so a blank one produced a product that
  // provisioned successfully, reported `active`, and could never be opened by its owner or by a
  // single customer. Derived from the name instead, which is always present.
  // Both callers of this function (POST /spaces and POST /builder/products) create top-level
  // products; a child business goes through createBusinessForEndUser and has no slug of its own.
  if (!params.productSlug) {
    const derived = await deriveAvailableSlug(env.PLATFORM_DB, params.name);
    if (derived) params = { ...params, productSlug: derived };
  }

  if (params.productSlug) {
    if (!/^[a-z0-9-]{2,40}$/.test(params.productSlug)) {
      throw new SpaceCreationError(400, "bad_request", "product_slug must match ^[a-z0-9-]{2,40}$");
    }
    if (RESERVED_SLUGS.has(params.productSlug)) {
      throw new SpaceCreationError(400, "bad_request", `product_slug '${params.productSlug}' is reserved`);
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const configJson = JSON.stringify({
    ...(params.configOverrides ?? {}),
    ...(params.templateId ? { template_id: params.templateId } : {}),
  });
  const initialStatus = env.PROVISION_QUEUE ? "provisioning" : "active";

  try {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json, product_slug, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, params.tenantId, params.spacetypeId, params.name, initialStatus, configJson, params.productSlug ?? null, now, now, params.userId ?? null).run();
  } catch (err) {
    if ((err as Error).message?.includes("UNIQUE")) {
      throw new SpaceCreationError(409, "conflict", "product_slug is already taken");
    }
    throw err;
  }

  if (env.PROVISION_QUEUE) {
    await env.PROVISION_QUEUE.send({
      type: "space_provision",
      spaceId: id,
      tenantId: params.tenantId,
      spaceTypeId: params.spacetypeId,
      spaceName: params.name,
      ...(params.templateId ? { templateId: params.templateId } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      requestedAt: now,
    });
  }

  return { id, status: initialStatus, created_at: now };
}
