// Shared Space creation logic used by the generic Spaces API and administrative provisioning.

import { getDOName } from "@naelao/crypto";
import { scopedInstallationId, type InstallationScope } from "@naelao/agent-sdk";
import { deliverProvisioningOutboxEntry } from "./provisioning-outbox.js";

/** Stable identity used by SpaceDO-owned extension records. A project is included only for
 * project scopes; no project can become the parent of a space-owned installation. */
export function deriveSpaceInstallationId(input: {
  tenantId: string;
  spaceId: string;
  extensionId: string;
  scope: InstallationScope;
  projectId?: string;
  userId?: string;
}): string {
  return scopedInstallationId(input);
}

export interface ProvisionMessage {
  type: "space_provision" | "space_deprovision";
  spaceId: string;
  tenantId: string;
  spaceTypeId: string;
  spaceName: string;
  templateId?: string;
  /** Certified FDE marketplace blueprint to activate after this Space is provisioned. */
  blueprintId?: string;
  templateIds?: string[];
  requestedAt: string;
  userId?: string;
}

export interface CreateSpaceEnv {
  PLATFORM_SECRET?: string;
  PLATFORM_DB: D1Database;
  ENVIRONMENT?: string;
  PROVISION_QUEUE?: Queue<ProvisionMessage>;
  LOCK_DO?: DurableObjectNamespace;
}

export interface SchemaValidationError {
  field: string;
  error: string;
}

// Per-account ceilings mirror the customer subscription plans; the registry Product is shared,
// but quotas and Space counts belong to each Product user.
const SPACE_LIMITS: Record<string, number> = {
  free: 3,
  growth: 25,
  business: 100,
  // Historical aliases still appear in older billing rows.
  starter: 25,
  pro: 100,
  enterprise: 1000,
};

export class SpaceCreationError extends Error {
  constructor(public status: number, public error_code: string, message: string, public errors?: SchemaValidationError[]) {
    super(message);
  }
}

async function getSpaceLimit(db: D1Database, tenantId: string, membership?: CreateSpaceParams["initialMembership"]): Promise<{ limit: number; tier: string }> {
  // Product-user subscriptions are account-scoped. Ordinary platform Spaces continue to use
  // their owning org plan, while customer Spaces never inherit the shared Launchpad team's tier.
  const account = membership ? await db.prepare(
    "SELECT plan_tier,status,current_period_end FROM product_user_subscriptions WHERE product_id = ? AND end_user_id = ? AND status IN ('active','trialing','cancelled','past_due')"
  ).bind(membership.productSpaceId, membership.endUserId).first<{ plan_tier: string; status: string; current_period_end: string | null }>() : null;
  const org = membership ? null : await db.prepare("SELECT plan_tier FROM orgs WHERE id = ?").bind(tenantId).first<{ plan_tier: string }>();
  const cancellationEnded = account?.status === "cancelled" &&
    (!account.current_period_end || !Number.isFinite(Date.parse(account.current_period_end)) || Date.parse(account.current_period_end) <= Date.now());
  const tier = (cancellationEnded ? undefined : account?.plan_tier) ?? org?.plan_tier ?? "free";
  const limit = SPACE_LIMITS[tier] ?? SPACE_LIMITS["free"]!;
  return { limit, tier };
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

/** Subdomains that collide with Naelao infrastructure or enable phishing. */
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
  /** Optional hierarchy coordinates for legacy template-managed child Spaces. */
  parentSpaceId?: string;
  depth?: number;
  /** Optional marketplace Space Template identifier. */
  templateId?: string;
  /** Certified FDE marketplace blueprint to activate after this Space is provisioned. */
  blueprintId?: string;
  /** Three-Tier Platform Model: the platform-subdomain identity (migration 0044, unique). */
  productSlug?: string;
  configOverrides?: Record<string, unknown>;
  /** Initial owner index, committed atomically with the Space and its provisioning outbox. */
  initialMembership?: { productSpaceId: string; endUserId: string; role?: "owner" | "admin" | "member" };
}

export interface CreateSpaceResult {
  id: string;
  status: string;
  created_at: string;
  product_slug: string | null;
}


/** The one space-creation code path: quota check, config-schema validation, insert (as
 *  'provisioning' when a queue is bound, else immediately 'active' — matches local-dev behavior
 *  when PROVISION_QUEUE isn't configured), and provisioning-queue enqueue with template_id.
 *  Throws SpaceCreationError on any validation/quota failure; callers translate to their own
 *  response shape (the plain /spaces route and /builder/products use different JSON shapes). */
export async function createSpaceRecord(env: CreateSpaceEnv, params: CreateSpaceParams): Promise<CreateSpaceResult> {
  if (typeof params.tenantId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(params.tenantId) ||
      (params.userId !== undefined && (typeof params.userId !== "string" || !/^[A-Za-z0-9._:@-]{1,256}$/.test(params.userId)))) {
    throw new SpaceCreationError(400, "bad_request", "Invalid tenant or user identifier");
  }
  if (typeof params.name !== "string" || !params.name.trim() || params.name.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(params.name)) {
    throw new SpaceCreationError(400, "bad_request", "Space name must contain 1–100 printable characters");
  }
  if (!params.spacetypeId) {
    throw new SpaceCreationError(400, "bad_request", "name and spacetype_id are required");
  }
  if (params.productSlug !== undefined && typeof params.productSlug !== "string") {
    throw new SpaceCreationError(400, "bad_request", "product_slug must be a string");
  }
  if (params.templateId !== undefined && (typeof params.templateId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(params.templateId))) {
    throw new SpaceCreationError(400, "bad_request", "Invalid template_id");
  }
  if (params.configOverrides !== undefined) {
    if (!params.configOverrides || typeof params.configOverrides !== "object" || Array.isArray(params.configOverrides)) {
      throw new SpaceCreationError(400, "bad_request", "config_overrides must be a JSON object");
    }
    try {
      if (JSON.stringify(params.configOverrides).length > 64 * 1024) throw new SpaceCreationError(400, "bad_request", "config_overrides exceeds 64 KiB");
    } catch (err) {
      if (err instanceof SpaceCreationError) throw err;
      throw new SpaceCreationError(400, "bad_request", "config_overrides must be JSON serializable");
    }
  }

  // A Space is generic: its type comes from the requested template/runtime configuration. Keep
  // ancestry authoritative and bounded for legacy template-managed child Spaces, but do not
  // require every root Space to be a Launchpad product.
  const requestedDepth = params.depth ?? (params.parentSpaceId ? 1 : 0);
  if (requestedDepth === 0 && params.parentSpaceId) {
    throw new SpaceCreationError(400, "invalid_hierarchy", "A root space cannot have a parent");
  }
  if (requestedDepth === 1 && !params.parentSpaceId) {
    throw new SpaceCreationError(400, "invalid_hierarchy", "A department must have a parent");
  }
  if (requestedDepth !== 0 && requestedDepth !== 1) {
    throw new SpaceCreationError(400, "invalid_hierarchy", "Spaces may only be roots or direct departments");
  }
  if (params.initialMembership) {
    if ((params.parentSpaceId && params.parentSpaceId !== params.initialMembership.productSpaceId) || params.userId !== params.initialMembership.endUserId) {
      throw new SpaceCreationError(400, "invalid_product_membership", "The Space owner and Product must match the authenticated creation scope");
    }
    const product = await env.PLATFORM_DB.prepare(
      "SELECT 1 FROM products WHERE id = ? AND tenant_id = ? AND status = 'active'"
    ).bind(params.initialMembership.productSpaceId, params.tenantId).first();
    if (!product) throw new SpaceCreationError(404, "product_not_found", "Product not found");
  }
  let derivedDepth = 0;
  if (params.parentSpaceId) {
    const parent = await env.PLATFORM_DB.prepare(
      "SELECT tenant_id, spacetype_id, depth, parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'"
    ).bind(params.parentSpaceId).first<{ tenant_id: string; spacetype_id: string; depth: number; parent_space_id: string | null }>();
    if (!parent || parent.tenant_id !== params.tenantId) {
      // Deliberately do not disclose whether a parent in another tenant exists.
      throw new SpaceCreationError(404, "parent_not_found", "Parent space not found");
    }
    if (parent.depth !== 0 || parent.parent_space_id) {
      throw new SpaceCreationError(400, "invalid_hierarchy", "A child Space must have a root Space as its parent");
    }
    derivedDepth = parent.depth + 1;
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

  if (params.productSlug) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(params.productSlug)) {
      throw new SpaceCreationError(400, "bad_request", "product_slug must match ^[a-z0-9-]{2,40}$");
    }
    if (RESERVED_SLUGS.has(params.productSlug)) {
      throw new SpaceCreationError(400, "bad_request", `product_slug '${params.productSlug}' is reserved`);
    }
    throw new SpaceCreationError(400, "product_creation_retired", "Products are provisioned through the Product registry");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const mergedConfigOverrides = params.configOverrides ?? {};
  const configJson = JSON.stringify({
    ...mergedConfigOverrides,
    ...(params.templateId ? { template_id: params.templateId } : {}),
    ...(params.blueprintId ? { pending_blueprint_id: params.blueprintId } : {}),
  });
  // Independent Wrangler dev processes do not share the local queue persistence directory,
  // so a local producer would leave products permanently stuck in `provisioning`. The local
  // shell can use the persisted product config immediately; deployed environments retain the
  // asynchronous provisioning workflow.
  const useProvisioningQueue = Boolean(env.PROVISION_QUEUE) && env.ENVIRONMENT !== "development";
  const initialStatus = useProvisioningQueue ? "provisioning" : "active";

  const provisionMessage: ProvisionMessage = {
    type: "space_provision",
    spaceId: id,
    tenantId: params.tenantId,
    spaceTypeId: params.spacetypeId,
    spaceName: params.name,
    ...(params.templateId ? { templateId: params.templateId } : {}),
    ...(params.userId ? { userId: params.userId } : {}),
    requestedAt: now,
  };
  const insertSpace = async (limit: number): Promise<boolean> => {
    const columns = `(id, tenant_id, spacetype_id, name, status, config_json, product_slug, parent_space_id, depth, created_at, updated_at, created_by, product_id)`;
    const baseValues = [id, params.tenantId, params.spacetypeId, params.name.trim(), initialStatus, configJson, params.productSlug ?? null,
      params.parentSpaceId ?? null, derivedDepth, now, now, params.userId ?? null, params.initialMembership?.productSpaceId ?? null];
    const quotaPredicate = params.initialMembership
      ? `SELECT COUNT(*) FROM spaces s WHERE s.tenant_id = ? AND s.product_id = ? AND s.status != 'deleted'
         AND (s.created_by = ? OR EXISTS (SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.end_user_id=? AND m.suspended_at IS NULL))`
      : `SELECT COUNT(*) FROM spaces s WHERE s.tenant_id = ? AND s.status != 'deleted'`;
    const accountLimit = `COALESCE((SELECT CASE
      WHEN status='cancelled' AND (current_period_end IS NULL OR julianday(current_period_end) <= julianday('now')) THEN 3
      WHEN status IN ('active','trialing','cancelled','past_due') THEN CASE plan_tier
        WHEN 'growth' THEN 25 WHEN 'starter' THEN 25 WHEN 'business' THEN 100 WHEN 'pro' THEN 100 WHEN 'enterprise' THEN 1000 ELSE 3 END
      ELSE 3 END FROM product_user_subscriptions WHERE product_id=? AND end_user_id=? LIMIT 1), 3)`;
    const quotaThreshold = params.initialMembership ? accountLimit : "?";
    const quotaParams = params.initialMembership
      ? [params.tenantId, params.initialMembership.productSpaceId, params.initialMembership.endUserId, params.initialMembership.endUserId,
         params.initialMembership.productSpaceId, params.initialMembership.endUserId]
      : [params.tenantId, limit];
    const spaceInsert = env.PLATFORM_DB.prepare(
      `INSERT INTO spaces ${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (${quotaPredicate}) < ${quotaThreshold}`
    ).bind(...baseValues, ...quotaParams);
    const writes = [spaceInsert];
    if (params.initialMembership) {
      writes.push(env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO space_members (id, space_id, tenant_id, end_user_id, role)
         SELECT ?, ?, ?, ?, ? WHERE changes() = 1`
      ).bind(crypto.randomUUID(), id, params.tenantId, params.initialMembership.endUserId, params.initialMembership.role ?? "owner"));
    }
    if (useProvisioningQueue) {
      writes.push(env.PLATFORM_DB.prepare(
          `INSERT INTO space_provisioning_outbox (space_id, tenant_id, payload_json)
           SELECT ?, ?, ? WHERE changes() = 1`,
        ).bind(id, params.tenantId, JSON.stringify(provisionMessage)));
    }
    if (useProvisioningQueue || params.initialMembership) {
      const results = await env.PLATFORM_DB.batch(writes);
      if (!results[0]?.meta.changes) return false;
    } else {
      const result = await spaceInsert.run();
      if (!result.meta.changes) return false;
    }
    return true;
  };
  const checkQuotaAndInsert = async (): Promise<void> => {
    const { limit, tier } = await getSpaceLimit(env.PLATFORM_DB, params.tenantId, params.initialMembership);
    try {
      if (!await insertSpace(limit)) {
        const current = await getSpaceLimit(env.PLATFORM_DB, params.tenantId, params.initialMembership);
        throw new SpaceCreationError(402, "quota_exceeded", `Space limit reached for ${current.tier} plan (${current.limit} spaces)`);
      }
    } catch (err) {
      if ((err as Error).message?.includes("UNIQUE")) {
        throw new SpaceCreationError(409, "conflict", "product_slug is already taken");
      }
      throw err;
    }
  };

  if (env.LOCK_DO) {
    if (!env.PLATFORM_SECRET) throw new SpaceCreationError(503, "creation_lock_unavailable", "Space creation is temporarily unavailable");
    const scope = params.initialMembership ? `${params.initialMembership.productSpaceId}:${params.initialMembership.endUserId}` : params.tenantId;
    const lockName = await getDOName("space-create", scope, params.tenantId, env.PLATFORM_SECRET);
    const lock = env.LOCK_DO.get(env.LOCK_DO.idFromName(lockName));
    const callerId = `space-create:${crypto.randomUUID()}`;
    let acquired = false;
    try {
      const response = await lock.fetch(new Request("http://lock/acquire", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ caller_id: callerId, ttl_ms: 30_000 }),
      }));
      if (!response.ok) throw new Error("lock unavailable");
      acquired = (await response.json<{ acquired: boolean }>()).acquired;
      if (!acquired) throw new SpaceCreationError(429, "creation_busy", "Another space is being created for this tenant. Retry shortly.");
      await checkQuotaAndInsert();
    } catch (err) {
      if (err instanceof SpaceCreationError) throw err;
      throw new SpaceCreationError(503, "creation_lock_unavailable", "Space creation is temporarily unavailable");
    } finally {
      if (acquired) {
        try {
          await lock.fetch(new Request("http://lock/release", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caller_id: callerId }),
          }));
        } catch { /* lock expires automatically if release delivery fails */ }
      }
    }
  } else {
    await checkQuotaAndInsert();
  }

  if (useProvisioningQueue && env.PROVISION_QUEUE) {
    // The durable outbox was committed atomically with the space row. A failed or ambiguous
    // queue send is retried by the scheduled dispatcher; do not delete a valid product here.
    await deliverProvisioningOutboxEntry(env.PLATFORM_DB, env.PROVISION_QUEUE, id);
  }

  return { id, status: initialStatus, created_at: now, product_slug: params.productSlug ?? null };
}
