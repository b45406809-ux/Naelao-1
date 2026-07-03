// Shared space-creation logic — extracted so `/builder/products` (Three-Tier Platform Model,
// builder-routes.ts) doesn't reimplement a second, incomplete creation path. Phase 3 originally
// did exactly that (a bare INSERT with no quota check, no config-schema validation, no
// provisioning-queue enqueue, no template_id support) — a real split-brain with the existing,
// fully-working `POST /spaces` route this file now backs too. Both routes call the SAME
// createSpaceRecord(); there is exactly one space-creation code path.

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
    const spaceTypeRow = await env.PLATFORM_DB.prepare("SELECT config_schema FROM spacetypes WHERE id = ?").bind(params.spacetypeId).first<{ config_schema: string | null }>();
    if (spaceTypeRow?.config_schema) {
      try {
        const schema = JSON.parse(spaceTypeRow.config_schema) as Record<string, unknown>;
        const validationErrors = validateConfigSchema(params.configOverrides, schema);
        if (validationErrors.length > 0) {
          throw new SpaceCreationError(400, "config_validation_failed", "SpaceType config validation failed", validationErrors);
        }
      } catch (err) {
        if (err instanceof SpaceCreationError) throw err;
        // Malformed schema stored in DB — skip validation, don't block creation.
      }
    }
  }

  await enforceSpaceQuota(env.PLATFORM_DB, params.tenantId);

  if (params.productSlug && !/^[a-z0-9-]{2,40}$/.test(params.productSlug)) {
    throw new SpaceCreationError(400, "bad_request", "product_slug must match ^[a-z0-9-]{2,40}$");
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
