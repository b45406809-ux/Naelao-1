import { Hono } from "hono";
import { errorResponse, requestId, notFound } from "@naelao/http";
import { getDOName, signHmac, verifyHmac } from "@naelao/crypto";
import type { SpaceDO } from "./do/SpaceDO.js";

export { SpaceDO } from "./do/SpaceDO.js";
export { LockDO } from "./do/LockDO.js";
export { FeatureFlagDO } from "./do/FeatureFlagDO.js";
export { TransactionCoordinatorDO } from "./do/TransactionCoordinatorDO.js";

export interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SPACE_DO: DurableObjectNamespace<SpaceDO>;
  EXPORTS_BUCKET: R2Bucket;
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

  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenantId,
      body.spacetype_id,
      body.name,
      JSON.stringify(body.config_overrides ?? {}),
      now,
      now,
      userId
    )
    .run();

  return c.json({ id, name: body.name, status: "active", created_at: now }, 201);
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

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
