import { Hono } from "hono";
import { errorResponse, requestId, notFound } from "@naelao/http";
import { getDOName, signHmac, verifyHmac } from "@naelao/crypto";
import type { SpaceDO } from "./do/SpaceDO.js";
import type { SpaceTypeRegistryDO, SpaceTypeProductConfig, NaelaoSpaceTypeManifestV2 } from "./do/SpaceTypeRegistryDO.js";
import { LAUNCHPAD_MANIFEST } from "./launchpad-manifest.js";

export { SpaceDO } from "./do/SpaceDO.js";
export { LockDO } from "./do/LockDO.js";
export { FeatureFlagDO } from "./do/FeatureFlagDO.js";
export { TransactionCoordinatorDO } from "./do/TransactionCoordinatorDO.js";
export { SpaceTypeRegistryDO } from "./do/SpaceTypeRegistryDO.js";

export interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SPACE_DO: DurableObjectNamespace<SpaceDO>;
  SPACE_TYPE_REGISTRY_DO: DurableObjectNamespace<SpaceTypeRegistryDO>;
  NAELAO_CONFIG_KV: KVNamespace;
  EXPORTS_BUCKET: R2Bucket;
  /** Producer to the provisioning queue — consumed by naelao-provisioner. */
  PROVISION_QUEUE?: Queue<ProvisionMessage>;
}

/** Message enqueued on space creation; consumed by the provisioner (installs agents etc.). */
interface ProvisionMessage {
  type: "space_provision" | "space_deprovision";
  spaceId: string;
  tenantId: string;
  spaceTypeId: string;
  spaceName: string;
  templateId?: string;
  requestedAt: string;
}

// Plan-tier space limits (G-I13: quota enforcement)
const SPACE_LIMITS: Record<string, number> = {
  free: 3,
  starter: 25,
  pro: 100,
  enterprise: 1000,
};

async function enforceSpaceQuota(db: D1Database, tenantId: string): Promise<void> {
  const org = await db.prepare(
    "SELECT plan_tier FROM organizations WHERE id = ?"
  ).bind(tenantId).first<{ plan_tier: string }>();

  const tier = org?.plan_tier ?? "free";
  const limit = SPACE_LIMITS[tier] ?? SPACE_LIMITS["free"] ?? 3;

  const row = await db.prepare(
    "SELECT COUNT(*) as count FROM spaces WHERE tenant_id = ? AND status != 'deleted'"
  ).bind(tenantId).first<{ count: number }>();

  const count = row?.count ?? 0;
  if (count >= limit) {
    const err = new Error(`Space limit reached for ${tier} plan (${limit} spaces)`);
    (err as unknown as Record<string, unknown>)["status"] = 402;
    (err as unknown as Record<string, unknown>)["error_code"] = "quota_exceeded";
    throw err;
  }
}

// G-AV02: Lightweight JSON Schema (draft-07 subset) validator for SpaceType config.
// Validates: type, required, properties (type+enum), minLength, minimum, maximum.
// Returns field-level errors without importing ajv (keeps Workers bundle small).
interface SchemaValidationError {
  field: string;
  error: string;
}

function validateConfigSchema(
  config: Record<string, unknown>,
  schema: Record<string, unknown>
): SchemaValidationError[] {
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
        if (minLen !== undefined && value.length < minLen) {
          errors.push({ field, error: `minimum length is ${minLen}` });
        }
        const maxLen = fieldSchema["maxLength"] as number | undefined;
        if (maxLen !== undefined && value.length > maxLen) {
          errors.push({ field, error: `maximum length is ${maxLen}` });
        }
      }

      if (typeof value === "number") {
        const minimum = fieldSchema["minimum"] as number | undefined;
        if (minimum !== undefined && value < minimum) {
          errors.push({ field, error: `minimum value is ${minimum}` });
        }
        const maximum = fieldSchema["maximum"] as number | undefined;
        if (maximum !== undefined && value > maximum) {
          errors.push({ field, error: `maximum value is ${maximum}` });
        }
      }
    }
  }

  return errors;
}

// G-A11: Validate required secrets at startup
function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// Extract caller identity from headers (set by router worker after JWT validation)
function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }) {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
    role: c.req.header("x-naelao-role") ?? "viewer",
  };
}

// ── GET /spaces — list spaces for tenant ────────────────────────────────────
app.get("/spaces", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM spaces WHERE tenant_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 100"
  )
    .bind(tenantId)
    .all();
  return c.json({ data: results, count: results.length });
});

// ── POST /spaces — create a space ───────────────────────────────────────────
app.post("/spaces", async (c) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const body = await c.req.json<{
    name: string;
    spacetype_id: string;
    /** For Launchpad: the selected product template (e.g. "creator-store"). */
    template_id?: string;
    config_overrides?: Record<string, unknown>;
  }>();

  if (!body.name || !body.spacetype_id) {
    return c.json(
      { error_code: "bad_request", message: "name and spacetype_id are required" },
      400
    );
  }

  // G-AV02: Validate config_overrides against SpaceType's declared config_schema
  if (body.config_overrides) {
    const spaceTypeRow = await c.env.PLATFORM_DB.prepare(
      "SELECT config_schema FROM spacetypes WHERE id = ?"
    ).bind(body.spacetype_id).first<{ config_schema: string | null }>();

    if (spaceTypeRow?.config_schema) {
      try {
        const schema = JSON.parse(spaceTypeRow.config_schema) as Record<string, unknown>;
        const validationErrors = validateConfigSchema(body.config_overrides, schema);
        if (validationErrors.length > 0) {
          return c.json({
            error_code: "config_validation_failed",
            message: "SpaceType config validation failed",
            errors: validationErrors,
          }, 400);
        }
      } catch {
        // Malformed schema stored in DB — skip validation, don't block creation
      }
    }
  }

  // G-I13: Enforce per-plan space quota
  try {
    await enforceSpaceQuota(c.env.PLATFORM_DB, tenantId);
  } catch (err) {
    const e = err as Record<string, unknown>;
    if (e["error_code"] === "quota_exceeded") {
      return c.json({ error_code: "quota_exceeded", message: String(e["message"] ?? "Space limit exceeded") }, 402);
    }
    throw err;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Persist the selected template in config so the space record is self-describing.
  const configJson = JSON.stringify({
    ...(body.config_overrides ?? {}),
    ...(body.template_id ? { template_id: body.template_id } : {}),
  });

  // Create as 'provisioning'; the provisioner installs agents (4 R2 config files), then
  // flips the space to 'active'. Falls back to immediate 'active' if no queue is bound
  // (e.g. local dev without the provisioning queue).
  const initialStatus = c.env.PROVISION_QUEUE ? "provisioning" : "active";

  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenantId,
      body.spacetype_id,
      body.name,
      initialStatus,
      configJson,
      now,
      now,
      userId
    )
    .run();

  // Enqueue provisioning (installs SpaceType agents, KB, welcome message, Space Assistant).
  if (c.env.PROVISION_QUEUE) {
    await c.env.PROVISION_QUEUE.send({
      type: "space_provision",
      spaceId: id,
      tenantId,
      spaceTypeId: body.spacetype_id,
      spaceName: body.name,
      ...(body.template_id ? { templateId: body.template_id } : {}),
      requestedAt: now,
    });
  }

  return c.json({ id, name: body.name, status: initialStatus, created_at: now }, 201);
});

// ── GET /spaces/:id ─────────────────────────────────────────────────────────
app.get("/spaces/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  const spaceId = c.req.param("id");

  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM spaces WHERE id = ? AND tenant_id = ?"
  )
    .bind(spaceId, tenantId)
    .first();

  if (!space) throw notFound("Space");
  return c.json(space);
});

// ── PATCH /spaces/:id ───────────────────────────────────────────────────────
app.patch("/spaces/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  const spaceId = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    status?: string;
    config_overrides?: Record<string, unknown>;
  }>();
  const now = new Date().toISOString();

  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM spaces WHERE id = ? AND tenant_id = ?"
  )
    .bind(spaceId, tenantId)
    .first();
  if (!existing) throw notFound("Space");

  if (body.name) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE spaces SET name = ?, updated_at = ? WHERE id = ?"
    )
      .bind(body.name, now, spaceId)
      .run();
  }
  if (body.status) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE spaces SET status = ?, updated_at = ? WHERE id = ?"
    )
      .bind(body.status, now, spaceId)
      .run();
  }
  if (body.config_overrides) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE spaces SET config_json = ?, updated_at = ? WHERE id = ?"
    )
      .bind(JSON.stringify(body.config_overrides), now, spaceId)
      .run();
  }
  return c.json({ id: spaceId, updated_at: now });
});

// ── DELETE /spaces/:id (soft delete) ────────────────────────────────────────
app.delete("/spaces/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  const spaceId = c.req.param("id");
  const now = new Date().toISOString();

  const result = await c.env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'deleted', updated_at = ? WHERE id = ? AND tenant_id = ?"
  )
    .bind(now, spaceId, tenantId)
    .run();

  if (result.meta.changes === 0) throw notFound("Space");
  return c.json({ deleted: true });
});

// ── G-AO30: GDPR Art. 15 — End-user conversation history export ─────────────
// GET /spaces/:spaceId/me/export?end_user_id=xxx
// Fetches all messages for the end_user_id, serializes to JSON, uploads to R2,
// returns a presigned URL valid 24 hours.
app.get("/spaces/:spaceId/me/export", async (c) => {
  const spaceId = c.req.param("spaceId");
  const endUserId = c.req.query("end_user_id") ?? c.req.header("x-naelao-end-user-id") ?? "";
  if (!endUserId) return c.json({ error_code: "bad_request", message: "end_user_id is required" }, 400);

  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, c.req.header("x-naelao-tenant-id") ?? "", c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const doRes = await stub.fetch(
    new Request(`http://space-do/me/messages?user_id=${encodeURIComponent(endUserId)}`, { method: "GET" })
  );
  if (!doRes.ok) {
    return new Response(doRes.body, { status: doRes.status, headers: { "content-type": "application/json" } });
  }

  const exportData = await doRes.json<{ messages: unknown[]; sessions: string[] }>();
  const payload = JSON.stringify({
    export_version: "1",
    space_id: spaceId,
    end_user_id: endUserId,
    exported_at: new Date().toISOString(),
    sessions: exportData.sessions,
    messages: exportData.messages,
  }, null, 2);

  // Upload to R2 with a 24h expiry path
  const exportKey = `exports/${spaceId}/${endUserId}/${crypto.randomUUID()}.json`;
  await c.env.EXPORTS_BUCKET.put(exportKey, payload, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { end_user_id: endUserId, space_id: spaceId },
  });

  // G-AO30: HMAC-signed download URL valid 24 hours (R2 Workers binding has no native presigned URL)
  // URL: /spaces/{spaceId}/me/export/download?key=...&expires=...&sig=...
  const expiresAt = Math.floor(Date.now() / 1000) + 86400;
  const sigInput = `${exportKey}:${expiresAt}`;
  const sig = await signHmac(sigInput, c.env.PLATFORM_SECRET);
  const downloadUrl = `/spaces/${spaceId}/me/export/download?key=${encodeURIComponent(exportKey)}&expires=${expiresAt}&sig=${sig}`;

  console.log(`[gdpr][export] user=${endUserId} space=${spaceId} key=${exportKey}`);
  return c.json({ export_url: downloadUrl, expires_in_seconds: 86400, message_count: exportData.messages.length }, 200);
});

// ── G-AO30: Signed export download ──────────────────────────────────────────
// GET /spaces/:spaceId/me/export/download?key=...&expires=...&sig=...
app.get("/spaces/:spaceId/me/export/download", async (c) => {
  const key = c.req.query("key") ?? "";
  const expiresStr = c.req.query("expires") ?? "0";
  const sig = c.req.query("sig") ?? "";

  const expiresAt = parseInt(expiresStr, 10);
  if (!key || !sig || Date.now() / 1000 > expiresAt) {
    return c.json({ error_code: "forbidden", message: "Export link has expired or is invalid" }, 403);
  }

  const sigInput = `${key}:${expiresAt}`;
  const valid = await verifyHmac(sigInput, sig, c.env.PLATFORM_SECRET);
  if (!valid) {
    return c.json({ error_code: "forbidden", message: "Invalid export link signature" }, 403);
  }

  const obj = await c.env.EXPORTS_BUCKET.get(key);
  if (!obj) return c.json({ error_code: "not_found", message: "Export not found" }, 404);

  return new Response(obj.body, {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="naelao-export.json"`,
    },
  });
});

// ── G-AO31: GDPR Art. 17 — End-user erasure within a Space ──────────────────
// DELETE /spaces/:spaceId/me/data?end_user_id=xxx
app.delete("/spaces/:spaceId/me/data", async (c) => {
  const spaceId = c.req.param("spaceId");
  const endUserId = c.req.query("end_user_id") ?? c.req.header("x-naelao-end-user-id") ?? "";
  if (!endUserId) return c.json({ error_code: "bad_request", message: "end_user_id is required" }, 400);

  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, c.req.header("x-naelao-tenant-id") ?? "", c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const doRes = await stub.fetch(
    new Request(`http://space-do/me/data?user_id=${encodeURIComponent(endUserId)}`, { method: "DELETE" })
  );

  const result = await doRes.json<{ sessions_deleted: number; messages_deleted: number; erased_at: string }>();
  console.log(`[gdpr][erasure] user=${endUserId} space=${spaceId} result=${JSON.stringify(result)}`);

  return c.json({ erased: true, space_id: spaceId, sessions_deleted: result.sessions_deleted, messages_deleted: result.messages_deleted, erased_at: result.erased_at }, 200);
});

// ── G-AO17: Runtime injection attempt recording ──────────────────────────────
// POST /spaces/:spaceId/me/injection { end_user_id, space_id }
// Records attempt in SpaceDO and returns rate-limited status.
app.post("/spaces/:spaceId/me/injection", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";

  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const doRes = await stub.fetch(
    new Request("http://space-do/me/injection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: c.req.raw.body,
    })
  );
  const result = await doRes.json<unknown>();
  return c.json(result, doRes.status as 200 | 400);
});

// ── SpaceDO agent_definitions proxy ─────────────────────────────────────────
// Forward /spaces/:spaceId/agent-definitions* to the SpaceDO.
// Per spec §11 and CLAUDE.md: SpaceDO owns agent_definitions.
app.all("/spaces/:spaceId/agent-definitions*", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const url = new URL(c.req.url);
  const doPath = url.pathname.replace(`/spaces/${spaceId}`, "");
  const doUrl = new URL(doPath + url.search, "http://space-do");

  return stub.fetch(
    new Request(doUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    })
  );
});

// ── SpaceDO members proxy ────────────────────────────────────────────────────
app.all("/spaces/:spaceId/members*", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const url = new URL(c.req.url);
  const doPath = url.pathname.replace(`/spaces/${spaceId}`, "");
  const doUrl = new URL(`${doPath}?space_id=${spaceId}${url.search ? "&" + url.search.slice(1) : ""}`, "http://space-do");

  return stub.fetch(
    new Request(doUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    })
  );
});

// ── SpaceDO session proxy ────────────────────────────────────────────────────
// Forward /spaces/:spaceId/sessions/* to the SpaceDO for that space
app.all("/spaces/:spaceId/sessions*", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  // G-BA01: HMAC-derived DO name prevents enumeration by compromised workers
  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const url = new URL(c.req.url);
  // Strip the /spaces/:spaceId prefix, keep /sessions/*
  const doPath = url.pathname.replace(`/spaces/${spaceId}`, "");
  const doUrl = new URL(doPath + url.search, "http://space-do");

  return stub.fetch(
    new Request(doUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    })
  );
});

// ── Internal: SpaceType manifest registry (spec §62) ────────────────────────
// These routes are called by the provisioner via SPACES_WORKER service binding.
// They are NOT exposed to end-users — caller identity is validated by the internal header.

function getRegistryDO(env: Env): ReturnType<typeof env.SPACE_TYPE_REGISTRY_DO.get> {
  return env.SPACE_TYPE_REGISTRY_DO.get(
    env.SPACE_TYPE_REGISTRY_DO.idFromName("global-space-type-registry")
  );
}

// GET /internal/space-types/:id — load manifest (KV-cached 1h for fast provisioning)
app.get("/internal/space-types/:id", async (c) => {
  if (c.req.header("x-naelao-internal") !== "provisioner") {
    return c.json({ error: "forbidden" }, 403);
  }
  const typeId = c.req.param("id");
  const cacheKey = `space-type-manifest:${typeId}`;

  const cached = await c.env.NAELAO_CONFIG_KV.get(cacheKey, "json");
  if (cached) return c.json(cached);

  const registry = getRegistryDO(c.env);
  const resp = await registry.fetch(new Request(`http://registry/type/${typeId}`));
  if (!resp.ok) return c.json({ error: "not_found" }, 404);

  const manifest = await resp.json<unknown>();
  await c.env.NAELAO_CONFIG_KV.put(cacheKey, JSON.stringify(manifest), { expirationTtl: 3600 });
  return c.json(manifest);
});

// POST /internal/space-types/:id/record-install — called at end of provisioning (step 10)
app.post("/internal/space-types/:id/record-install", async (c) => {
  if (c.req.header("x-naelao-internal") !== "provisioner") {
    return c.json({ error: "forbidden" }, 403);
  }
  const typeId = c.req.param("id");
  const body = await c.req.json<{ spaceId: string; version: string }>();
  const registry = getRegistryDO(c.env);
  await registry.fetch(new Request("http://registry/record-install", {
    method: "POST",
    body: JSON.stringify({ typeId, spaceId: body.spaceId, version: body.version }),
  }));
  return c.json({ ok: true });
});

// POST /internal/space-types/seed — Naelao platform use only: seed built-in manifests
// Called once at deploy/bootstrap time to seed the Launchpad manifest.
app.post("/internal/space-types/seed", async (c) => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) {
    return c.json({ error: "forbidden" }, 403);
  }
  const registry = getRegistryDO(c.env);
  const results = [];
  for (const manifest of [LAUNCHPAD_MANIFEST]) {
    const resp = await registry.fetch(new Request("http://registry/register", {
      method: "POST",
      body: JSON.stringify({ manifest, authorId: "naelao" }),
    }));
    results.push({ id: manifest.id, ...(await resp.json<object>()) });
    // Bust KV cache so next provisioner call sees the new manifest
    await c.env.NAELAO_CONFIG_KV.delete(`space-type-manifest:${manifest.id}`);
  }
  return c.json({ seeded: results });
});

// ── Reseller / tenant membership (spec G-AS34/G-AS35; productConfig.membershipModel) ──
// When a builder's product has membershipModel "tenant"|"hybrid", a customer who signs up
// through that product creates their OWN business (a space under their own child tenant,
// parented to the reseller). See docs/spec-appendix A1.8.

/**
 * Resolve the effective productConfig for a product space: the SpaceType manifest's
 * productConfig, overlaid with any per-space override in spaces.config_json.productConfig.
 */
async function loadEffectiveProductConfig(
  env: Env,
  spaceTypeId: string,
  spaceConfigJson: string | null
): Promise<SpaceTypeProductConfig | null> {
  let base: SpaceTypeProductConfig | null = null;
  const cacheKey = `space-type-manifest:${spaceTypeId}`;
  const cached = await env.NAELAO_CONFIG_KV.get(cacheKey, "json") as NaelaoSpaceTypeManifestV2 | null;
  if (cached?.productConfig) {
    base = cached.productConfig;
  } else {
    const registry = getRegistryDO(env);
    const resp = await registry.fetch(new Request(`http://registry/type/${spaceTypeId}`));
    if (resp.ok) {
      const manifest = await resp.json<NaelaoSpaceTypeManifestV2>();
      await env.NAELAO_CONFIG_KV.put(cacheKey, JSON.stringify(manifest), { expirationTtl: 3600 });
      base = manifest.productConfig ?? null;
    }
  }
  // Per-space override (builders tune membership per product without forking the manifest).
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

// POST /reseller/spaces — a customer creates their own business under a reseller's product.
app.post("/reseller/spaces", async (c) => {
  const { userId } = getCallerIdentity(c);
  if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);

  const body = await c.req.json<{
    reseller_product_space_id: string;
    name: string;
    spacetype_id: string;
    template_id?: string;
    config_overrides?: Record<string, unknown>;
  }>();
  if (!body.reseller_product_space_id || !body.name || !body.spacetype_id) {
    return c.json(
      { error_code: "bad_request", message: "reseller_product_space_id, name, spacetype_id are required" },
      400
    );
  }

  // 1. Resolve the reseller (parent tenant) from the product space.
  const product = await c.env.PLATFORM_DB.prepare(
    "SELECT tenant_id, spacetype_id, config_json FROM spaces WHERE id = ? AND status = 'active'"
  ).bind(body.reseller_product_space_id).first<{ tenant_id: string; spacetype_id: string; config_json: string | null }>();
  if (!product) return c.json({ error_code: "not_found", message: "Reseller product not found" }, 404);
  const parentTenantId = product.tenant_id;

  // 2. Load effective productConfig and gate the request.
  const pc = await loadEffectiveProductConfig(c.env, product.spacetype_id, product.config_json);
  if (!pc || (pc.membershipModel !== "tenant" && pc.membershipModel !== "hybrid")) {
    return c.json({ error_code: "not_allowed", message: "This product does not allow customers to create their own businesses" }, 403);
  }
  if (!pc.allowPublicSignup) {
    return c.json({ error_code: "signup_closed", message: "Public signup is disabled for this product" }, 403);
  }
  const allowed = pc.allowedChildSpaceTypes ?? [];
  if (!allowed.includes(body.spacetype_id)) {
    return c.json({ error_code: "spacetype_not_allowed", message: `SpaceType '${body.spacetype_id}' is not offered by this product` }, 403);
  }

  // 3. Find or mint the customer's child tenant (one per customer per reseller).
  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT child_tenant_id FROM tenant_hierarchy WHERE parent_tenant_id = ? AND child_owner_user_id = ? LIMIT 1"
  ).bind(parentTenantId, userId).first<{ child_tenant_id: string }>();
  const childTenantId = existing?.child_tenant_id ?? `ten_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();

  // Ensure a reseller_accounts row exists for the parent (lazily, from productConfig).
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO reseller_accounts (tenant_id, product_space_id, billing_relationship, wholesale_cents, referral_share_pct, updated_at)
     VALUES (?, ?, ?, NULL, 0.0, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET product_space_id = excluded.product_space_id, updated_at = excluded.updated_at`
  ).bind(parentTenantId, body.reseller_product_space_id, pc.billingRelationship ?? "platform", now).run();

  // 4. Create the child business (space) under the child tenant.
  const spaceId = crypto.randomUUID();
  const initialStatus = c.env.PROVISION_QUEUE ? "provisioning" : "active";
  const configJson = JSON.stringify({
    ...(body.config_overrides ?? {}),
    ...(body.template_id ? { template_id: body.template_id } : {}),
  });
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(spaceId, childTenantId, body.spacetype_id, body.name, initialStatus, configJson, now, now, userId).run();

  // 5. Record the hierarchy on first business for this child tenant.
  if (!existing) {
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hierarchy (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id, child_owner_user_id)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(childTenantId, parentTenantId, body.reseller_product_space_id, spaceId, userId).run();
  }

  // 6. Provision under the CHILD tenant (reuses the 10-step provisioner unchanged).
  if (c.env.PROVISION_QUEUE) {
    await c.env.PROVISION_QUEUE.send({
      type: "space_provision",
      spaceId,
      tenantId: childTenantId,
      spaceTypeId: body.spacetype_id,
      spaceName: body.name,
      ...(body.template_id ? { templateId: body.template_id } : {}),
      requestedAt: now,
    });
  }

  return c.json({ tenant_id: childTenantId, space_id: spaceId, status: initialStatus, parent_tenant_id: parentTenantId }, 201);
});

// GET /reseller/clients — the calling reseller's client portfolio (G-AS34 dashboard data).
app.get("/reseller/clients", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const { results: clients } = await c.env.PLATFORM_DB.prepare(
    `SELECT h.child_tenant_id, h.child_owner_user_id, h.status, h.created_at,
            COUNT(s.id) AS space_count
       FROM tenant_hierarchy h
       LEFT JOIN spaces s ON s.tenant_id = h.child_tenant_id AND s.status != 'deleted'
      WHERE h.parent_tenant_id = ?
      GROUP BY h.child_tenant_id
      ORDER BY h.created_at DESC
      LIMIT 200`
  ).bind(tenantId).all();

  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
  const rollup = await c.env.PLATFORM_DB.prepare(
    `SELECT COALESCE(SUM(retail_cents),0) AS retail, COALESCE(SUM(wholesale_cents),0) AS wholesale,
            COALESCE(SUM(margin_cents),0) AS margin, COUNT(*) AS events
       FROM reseller_ledger WHERE parent_tenant_id = ? AND period = ?`
  ).bind(tenantId, period).first<{ retail: number; wholesale: number; margin: number; events: number }>();

  return c.json({
    clients,
    client_count: clients.length,
    current_period: period,
    billing: rollup ?? { retail: 0, wholesale: 0, margin: 0, events: 0 },
  });
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
