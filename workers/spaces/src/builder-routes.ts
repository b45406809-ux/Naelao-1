// Three-Tier Platform Model, Phase 3 (docs/spec-appendix/A1-script-agents-and-space-assistants.md
// §A1.17) — the Builder Dashboard API: /builder/products*, /builder/api-keys*, /builder/billing*.
//
// registerBuilderRoutes(app) is called once from index.ts and adds routes onto the SAME Hono app
// instance (matching this file's existing convention of one flat app — cf-saas.ts is pure logic
// with no routes; this is the first split-out file that DOES register routes, so it takes `app`
// rather than mounting a sub-app, to avoid a circular import with index.ts's own Env type: this
import { ALLOWED_MODELS, isAllowedModel, isValidEffortLevel, DEFAULT_WORKING_MODEL } from "@naelao/billing-core";
// file declares its own minimal structural Env shape instead of importing index.ts's Env).
//
// AUTH: every /builder/* route accepts a router-authenticated Naelao team session or a scoped
// Builder API key created by that team. The signed router tenant assertion is verified here;
// then all builder routes are restricted to NAELAO_DASHBOARD_TENANT_ID. FDEs use Foundry inside
// their Space in the shell; this API is the internal Launchpad administration surface.
// Note: wiring naelao-router to actually forward external `Authorization: Bearer nbk_...` calls
// through to this worker (today the router only forwards already-JWT-authenticated sessions) is a
// separate, tracked router-level follow-up — out of this file's scope. The Dashboard UI's own use
// of these routes (Phases 4/5) works today via the x-naelao-tenant-id path.

import type { Context, Hono } from "hono";
import { getDOName } from "@naelao/crypto";
import { mintInternalToken, verifyInternalToken, readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { createCustomHostname, getCustomHostname, cfSaasConfig, normalizeCustomHostname } from "./cf-saas.js";
import type { SpaceTypeProductConfig } from "./do/SpaceTypeRegistryDO.js";
import { createSpaceRecord, SpaceCreationError } from "./create-space.js";
import type { CreateSpaceEnv } from "./create-space.js";
import { FOUNDRY_SPACE_TEMPLATE } from "@naelao/agent-sdk";

/** The minimal env shape this file needs — kept local (not imported from index.ts's Env) so
 *  index.ts -> builder-routes.ts -> index.ts never forms a circular import. index.ts's real Env
 *  is a structural superset and satisfies this at the call site. */
export interface BuilderRoutesEnv extends CreateSpaceEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  BUILDER_ACCOUNT_DO: DurableObjectNamespace;
  PRODUCT_USER_DO: DurableObjectNamespace;
  SPACE_TYPE_REGISTRY_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  CF_API_TOKEN?: string;
  CF_SAAS_ZONE_ID?: string;
  STOREFRONT_ROOT?: string;
  BILLING_WORKER?: Fetcher;
  /** Tenant allowed to operate Naelao's internal Launchpad dashboard. Empty means fail closed. */
  NAELAO_DASHBOARD_TENANT_ID?: string;
}

interface SpaceRow {
  id: string;
  tenant_id: string;
  name: string;
  status: string;
  suspension_reason?: string | null;
  spacetype_id: string;
  config_json: string | null;
  product_slug: string | null;
  conversation_access_approved_by: string | null;
  conversation_access_approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const ALLOWED_STATUSES = ["draft", "active", "paused"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ResolvedBuilder { tenantId: string; scopes: string[] }

function builderScopeFor(path: string, method: string): string {
  if (path === "/builder/api-keys" || /^\/builder\/api-keys\//.test(path)) return "spaces:write";
  if (path === "/builder/templates" || /^\/builder\/templates\//.test(path)) return "templates:read";
  if (/\/analytics(?:\/|$)/.test(path)) return "analytics:read";
  if (/\/users\/[^/]+\/conversations$/.test(path)) return "sessions:read";
  if (path === "/builder/billing" || path.startsWith("/builder/billing/")) return "billing:read";
  return method === "GET" ? "spaces:read" : "spaces:write";
}

function hasBuilderScope(auth: ResolvedBuilder, required: string): boolean {
  if (auth.scopes.includes("*")) return true;
  if (auth.scopes.includes(required)) return true;
  return required === "spaces:read" && auth.scopes.includes("spaces:write")
    || required === "sessions:read" && auth.scopes.includes("sessions:write");
}

async function builderAuthFor(env: BuilderRoutesEnv, context: Context<any>): Promise<ResolvedBuilder | null> {
  return (context.get("builderAuth") as ResolvedBuilder | undefined) ?? resolveBuilderAuth(env, context.req.raw.headers);
}

async function builderAccountDoStubFor(env: BuilderRoutesEnv, tenantId: string) {
  const doId = env.BUILDER_ACCOUNT_DO.idFromName(
    await getDOName("builder", tenantId, tenantId, env.PLATFORM_SECRET)
  );
  return env.BUILDER_ACCOUNT_DO.get(doId);
}

async function productUserDoStubFor(env: BuilderRoutesEnv, productId: string, endUserId: string, tenantId: string) {
  const doId = env.PRODUCT_USER_DO.idFromName(
    await getDOName("produser", `${productId}:${endUserId}`, tenantId, env.PLATFORM_SECRET)
  );
  return env.PRODUCT_USER_DO.get(doId);
}

/** Resolve the calling builder's tenant + scopes from either auth path. Null = unauthenticated. */
async function resolveBuilderAuth(
  env: BuilderRoutesEnv,
  headers: { get(name: string): string | null }
): Promise<ResolvedBuilder | null> {
  const headerTenant = headers.get("x-naelao-tenant-id");
  if (headerTenant) {
    // The tenant header is a router assertion, not an identity credential by itself.
    // Verify the router's signature so direct Worker access cannot choose another tenant.
    if (!await verifyInternalToken(headers.get("x-naelao-internal-token") ?? undefined, headerTenant, env.PLATFORM_SECRET)) return null;
    if (headers.get("x-naelao-role") === "team_api_key") {
      const scopes = (headers.get("x-naelao-scopes") ?? "").split(",").filter(Boolean);
      if (scopes.some(scope => !/^[a-z][a-z0-9:_-]{0,63}$/.test(scope))) return null;
      return { tenantId: headerTenant, scopes };
    }
    return { tenantId: headerTenant, scopes: ["*"] };
  }

  const authHeader = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(nbk_\S+)$/.exec(authHeader);
  if (!match) return null;
  const rawKey = match[1]!;
  const keyHash = await sha256Hex(rawKey);

  const indexRow = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id FROM builder_api_key_index WHERE key_hash = ?"
  ).bind(keyHash).first<{ tenant_id: string }>();
  if (!indexRow) return null;

  const stub = await builderAccountDoStubFor(env, indexRow.tenant_id);
  const verifyRes = await stub.fetch(
    new Request("http://do/api-keys/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: rawKey }),
    })
  );
  const verified = await verifyRes.json<{ valid: boolean; scopes?: string[] }>();
  if (!verified.valid) return null;
  return { tenantId: indexRow.tenant_id, scopes: verified.scopes ?? [] };
}

/** Load a product (space) this builder owns. Never leaks existence to a non-owner — 404 either way. */
async function loadOwnedProduct(env: BuilderRoutesEnv, productId: string, tenantId: string): Promise<SpaceRow | null> {
  const row = await env.PLATFORM_DB.prepare(
    `SELECT id, tenant_id, name, status, suspension_reason, spacetype_id, config_json, product_slug,
            conversation_access_approved_by, conversation_access_approved_at, created_at, updated_at
       FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'`
  ).bind(productId, tenantId).first<SpaceRow>();
  return row ?? null;
}

function parseProductConfig(configJson: string | null): { productConfig?: Partial<SpaceTypeProductConfig> } & Record<string, unknown> {
  if (!configJson) return {};
  try { return JSON.parse(configJson) as { productConfig?: Partial<SpaceTypeProductConfig> }; }
  catch { return {}; }
}

// Hono's Context typing is invariant on Bindings (not just structural), so a narrower
// BuilderRoutesEnv can't be accepted where the caller's Hono<{Bindings: Env}> is expected without
// either importing index.ts's Env here (circular) or widening this parameter. `any` is the
// pragmatic choice for a route-registration split like this; each handler still recovers a
// properly-typed `env` via the `c.env as BuilderRoutesEnv` cast below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerBuilderRoutes(app: Hono<any>): void {
  app.use("/builder/*", async (c, next) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    // Naelao is the only platform builder. Fail closed when the internal team tenant is not
    // configured; otherwise any authenticated tenant or legacy builder API key could use this
    // administration API as a product-building surface.
    if (!env.NAELAO_DASHBOARD_TENANT_ID || auth.tenantId !== env.NAELAO_DASHBOARD_TENANT_ID) {
      return c.json({ error_code: "forbidden", message: "Naelao team access required" }, 403);
    }
    // Router sessions carry a role derived from the verified JWT (client-supplied role headers
    // are stripped by the router). Keep dashboard administration to team owners/admins; scoped
    // API keys remain usable for automation after an authorized admin creates them.
    if (c.req.header("x-naelao-tenant-id") && !["owner", "admin", "team_api_key"].includes(c.req.header("x-naelao-role") ?? "")) {
      return c.json({ error_code: "forbidden", message: "Naelao team administrator access required" }, 403);
    }
    const required = builderScopeFor(c.req.path, c.req.method);
    if (!hasBuilderScope(auth, required)) return c.json({ error_code: "insufficient_scope", required_scope: required }, 403);
    c.set("builderAuth", auth);
    return next();
  });
  // Foundry is distributed only inside the Naelao team tenant. Returning the portable blueprint
  // through this route keeps it out of the public marketplace/catalogue while allowing the team
  // dashboard and team-scoped API keys to inspect the exact dogfood artifact.
  app.get("/builder/templates", async (c) => {
    const auth = await builderAuthFor(c.env as BuilderRoutesEnv, c);
    if (!auth || auth.tenantId !== (c.env as BuilderRoutesEnv).NAELAO_DASHBOARD_TENANT_ID) return c.json({ error_code: "forbidden" }, 403);
    return c.json({ data: [{ visibility: "team_private", template: FOUNDRY_SPACE_TEMPLATE }] });
  });
  // ── /builder/api-keys — consolidates onto Phase 1's BuilderAccountDO ─────────────────────────
  app.post("/builder/api-keys", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);

    const body = await c.req.json<{ name?: unknown; scopes?: unknown; expires_in_days?: unknown }>().catch(() => null);
    if (!body || !Array.isArray(body.scopes)) return c.json({ error_code: "invalid_api_key_configuration" }, 400);
    if (!auth.scopes.includes("*") && body.scopes.some(scope => typeof scope !== "string" || !hasBuilderScope(auth, scope))) {
      return c.json({ error_code: "api_key_scope_escalation_denied" }, 403);
    }
    const stub = await builderAccountDoStubFor(env, auth.tenantId);
    const doRes = await stub.fetch(new Request("http://do/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    if (!doRes.ok) return new Response(doRes.body, { status: doRes.status, headers: { "content-type": "application/json" } });

    const created = await doRes.json<{ id: string; key: string; key_hash: string; name: string; key_prefix: string; scopes: string[]; last_used_at: string | null; expires_at: string | null; created_at: string }>();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO builder_api_key_index (key_hash, tenant_id, key_id) VALUES (?, ?, ?)"
    ).bind(created.key_hash, auth.tenantId, created.id).run();

    // key_hash is worker-internal only (see BuilderAccountDO.ts's comment) — never forward it.
    const { key_hash: _keyHash, ...clientSafe } = created;
    return c.json(clientSafe, 201);
  });

  app.get("/builder/api-keys", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const stub = await builderAccountDoStubFor(env, auth.tenantId);
    const doRes = await stub.fetch(new Request("http://do/api-keys"));
    return new Response(doRes.body, { status: doRes.status, headers: { "content-type": "application/json" } });
  });

  app.delete("/builder/api-keys/:id", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const stub = await builderAccountDoStubFor(env, auth.tenantId);
    const doRes = await stub.fetch(new Request(`http://do/api-keys/${encodeURIComponent(c.req.param("id"))}`, { method: "DELETE" }));
    return new Response(doRes.body, { status: doRes.status });
  });

  // ── /builder/products — CRUD ─────────────────────────────────────────────────────────────────
  // POST delegates to createSpaceRecord (create-space.js) — the SAME code path /spaces POST uses
  // (quota check, config-schema validation, provisioning-queue enqueue, template_id support).
  // Phase 3's first draft of this route reimplemented a bare INSERT with none of that — a real
  // split-brain, fixed in Phase 4 once the wizard needed template_id/provisioning to actually
  // work. There is no separate "draft" DB status: the wizard collects everything client-side
  // across its steps and calls this route exactly once, at "Review & Launch" — the product is
  // real (provisioning/active) from the moment it exists, same as any other Space.
  app.post("/builder/products", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    if (!env.NAELAO_DASHBOARD_TENANT_ID || auth.tenantId !== env.NAELAO_DASHBOARD_TENANT_ID) {
      return c.json({ error_code: "forbidden", message: "Only the Naelao team can create the Launchpad product" }, 403);
    }

    // Naelao operates one Launchpad root product from this dashboard. Businesses and
    // departments are created through their own flows; never allow a second root here.
    const existingLaunchpad = await env.PLATFORM_DB.prepare(
      `SELECT id FROM spaces WHERE tenant_id = ? AND spacetype_id = 'launchpad'
         AND COALESCE(depth, 0) = 0 AND status != 'deleted' LIMIT 1`
    ).bind(auth.tenantId).first<{ id: string }>();
    if (existingLaunchpad) {
      return c.json({ error_code: "launchpad_already_exists", product_id: existingLaunchpad.id }, 409);
    }

    let bodyBytes: Uint8Array;
    try {
      bodyBytes = await readBoundedRequestBytes(c.req.raw, 64 * 1024);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) return c.json({ error_code: "payload_too_large" }, 413);
      return c.json({ error_code: "invalid_request_body" }, 400);
    }
    let bodyValue: unknown;
    try {
      bodyValue = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return c.json({ error_code: "invalid_request_body" }, 400);
    }
    if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) {
      return c.json({ error_code: "invalid_request_body" }, 400);
    }
    const body = bodyValue as {
      name: string;
      spacetype_id: string;
    };
    const extraFields = Object.keys(bodyValue as Record<string, unknown>).some(
      (key) => key !== "name" && key !== "spacetype_id"
    );
    if (extraFields || body.name !== "Launchpad" || body.spacetype_id !== "launchpad") {
      return c.json({ error_code: "unsupported_product", message: "The Naelao dashboard creates one centrally configured Launchpad product" }, 400);
    }

    let result;
    try {
      result = await createSpaceRecord(env, {
        tenantId: auth.tenantId,
        name: "Launchpad",
        spacetypeId: "launchpad",
      });
    } catch (err) {
      if (err instanceof SpaceCreationError) {
        return c.json({ error_code: err.error_code, message: err.message, ...(err.errors ? { errors: err.errors } : {}) }, err.status as 400 | 402 | 404 | 409 | 429 | 503);
      }
      throw err;
    }

    return c.json({ id: result.id, name: body.name, spacetype_id: body.spacetype_id, status: result.status, product_slug: result.product_slug, created_at: result.created_at }, 201);
  });

  // The internal dashboard has a single default product surface. This endpoint deliberately
  // returns only the Launchpad root and is unavailable to other tenants, even if they use the
  // broader builder API for their own products.
  app.get("/builder/launchpad", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    if (!env.NAELAO_DASHBOARD_TENANT_ID || auth.tenantId !== env.NAELAO_DASHBOARD_TENANT_ID) {
      return c.json({ error_code: "forbidden", message: "Naelao team access required" }, 403);
    }
    const product = await env.PLATFORM_DB.prepare(
      `SELECT id, name, status, spacetype_id, product_slug, created_at, updated_at
         FROM spaces WHERE tenant_id = ? AND spacetype_id = 'launchpad'
           AND COALESCE(depth, 0) = 0 AND status != 'deleted'
         ORDER BY created_at ASC, id ASC LIMIT 1`
    ).bind(auth.tenantId).first();
    return c.json({ product: product ?? null, can_initialize: product == null });
  });

  app.get("/builder/products", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const pageValue = c.req.query("page") ?? "1";
    if (!/^\d+$/.test(pageValue)) return c.json({ error_code: "bad_request", message: "page must be a positive integer" }, 400);
    const page = Number(pageValue);
    const pageSize = 200;
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
      return c.json({ error_code: "bad_request", message: "page must be between 1 and 1000000" }, 400);
    }
    const count = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS count FROM spaces WHERE tenant_id = ? AND status != 'deleted'"
    ).bind(auth.tenantId).first<{ count: number }>();
    const productCount = count?.count ?? 0;
    const pageCount = Math.ceil(productCount / pageSize);
    if (page > Math.max(1, pageCount)) {
      return c.json({ error_code: "bad_request", message: "page is outside the product list" }, 400);
    }
    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT id, name, status, spacetype_id, product_slug, created_at, updated_at
         FROM spaces WHERE tenant_id = ? AND status != 'deleted'
         ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`
    ).bind(auth.tenantId, pageSize, (page - 1) * pageSize).all();
    return c.json({ data: results, product_count: productCount, page, page_size: pageSize, page_count: pageCount });
  });

  app.get("/builder/products/:id", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    const { productConfig } = parseProductConfig(product.config_json);
    return c.json({ ...product, config_json: undefined, product_config: productConfig ?? {} });
  });

  app.patch("/builder/products/:id", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    let bodyValue: unknown;
    try {
      const bytes = await readBoundedRequestBytes(c.req.raw, 64 * 1024);
      bodyValue = JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) return c.json({ error_code: "request_too_large" }, 413);
      return c.json({ error_code: "invalid_request_body" }, 400);
    }
    if (!isRecord(bodyValue)) return c.json({ error_code: "invalid_request_body" }, 400);
    const body = bodyValue as {
      name?: string;
      status?: string;
      product_config?: Partial<SpaceTypeProductConfig>;
      legal?: SpaceTypeProductConfig["legal"];
    };

    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120)) {
      return c.json({ error_code: "bad_request", message: "name must be a non-empty string of at most 120 characters" }, 400);
    }

    if (body.product_config !== undefined && !isRecord(body.product_config)) {
      return c.json({ error_code: "bad_request", message: "product_config must be an object" }, 400);
    }
    if (body.legal !== undefined && !isRecord(body.legal)) {
      return c.json({ error_code: "bad_request", message: "legal must be an object" }, 400);
    }

    if (body.status !== undefined && !ALLOWED_STATUSES.includes(body.status as (typeof ALLOWED_STATUSES)[number])) {
      return c.json({ error_code: "bad_request", message: `status must be one of ${ALLOWED_STATUSES.join(", ")}` }, 400);
    }
    if (body.status !== undefined && (product.suspension_reason != null || product.status === "suspended")) {
      return c.json({ error_code: "suspension_reason_mismatch", message: "A platform suspension can only be released by its owner control" }, 409);
    }
    // Validate legal URLs are HTTPS (required — never allow http: ToS/Privacy links).
    if (body.legal) {
      for (const field of ["tosUrl", "privacyPolicyUrl", "dpaUrl", "supportContact"] as const) {
        const val = body.legal[field];
        if (val !== undefined && (typeof val !== "string" || val.length > 2048)) {
          return c.json({ error_code: "bad_request", message: `legal.${field} must be a string of at most 2048 characters` }, 400);
        }
        if (val && !val.startsWith("https://") && !val.startsWith("mailto:")) {
          return c.json({ error_code: "bad_request", message: `legal.${field} must start with https:// or mailto:` }, 400);
        }
      }
      const validCookiePolicies = ["none", "analytics", "third_party"] as const;
      if (body.legal.cookiePolicy && !validCookiePolicies.includes(body.legal.cookiePolicy)) {
        return c.json({ error_code: "bad_request", message: `legal.cookiePolicy must be one of ${validCookiePolicies.join(", ")}` }, 400);
      }
    }
    // §A1.28 (model switcher): a curated allowlist, not an arbitrary caller-supplied string — cost
    // predictability, and it keeps this in sync with what contextWindowForModel/tokensToCredits
    // actually know how to price. The list itself now lives in packages/billing-core alongside
    // those tables, so this and the agents worker's own run-time model override can never drift.
    const model = body.product_config?.modelConfig?.model;
    const policy = body.product_config?.modelPolicy;
    const workerPool = body.product_config?.workerModelPool;
    const modelConfig = body.product_config?.modelConfig;
    if (modelConfig !== undefined && (!isRecord(modelConfig)
      || (modelConfig.model !== undefined && (typeof modelConfig.model !== "string" || modelConfig.model.length === 0 || modelConfig.model.length > 256))
      || (modelConfig.effort !== undefined && (typeof modelConfig.effort !== "string" || modelConfig.effort.length > 32)))) {
      return c.json({ error_code: "bad_request", message: "modelConfig must contain a bounded model ID and effort" }, 400);
    }
    if (policy !== undefined && (!isRecord(policy)
      || (policy.mode !== "open" && policy.mode !== "whitelist_only")
      || !Array.isArray(policy.allowedModelIds)
      || policy.allowedModelIds.length > 100
      || policy.allowedModelIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256))) {
      return c.json({ error_code: "bad_request", message: "modelPolicy must contain a valid mode and at most 100 bounded model IDs" }, 400);
    }
    const compliance = body.product_config?.compliance;
    if (compliance !== undefined && (!isRecord(compliance)
      || (compliance.airGappedOnly !== undefined && typeof compliance.airGappedOnly !== "boolean"))) {
      return c.json({ error_code: "bad_request", message: "compliance.airGappedOnly must be a boolean" }, 400);
    }
    if (workerPool) {
      if (!Array.isArray(workerPool.modelIds) || workerPool.modelIds.length > 100
        || workerPool.modelIds.some(id => typeof id !== "string" || !/^openrouter\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id))) {
        return c.json({ error_code: "bad_request", message: "workerModelPool.modelIds must contain at most 100 OpenRouter model IDs" }, 400);
      }
      if (workerPool.modelsByPlan !== undefined && (!workerPool.modelsByPlan || typeof workerPool.modelsByPlan !== "object" || Array.isArray(workerPool.modelsByPlan)
        || Object.entries(workerPool.modelsByPlan).length > 50
        || Object.entries(workerPool.modelsByPlan).some(([planId, ids]) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(planId)
          || !Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== "string" || !workerPool.modelIds.includes(id))))) {
        return c.json({ error_code: "bad_request", message: "workerModelPool.modelsByPlan must map product plan IDs to models from the worker pool" }, 400);
      }
      if (workerPool.selectionMode !== undefined && workerPool.selectionMode !== "automatic" && workerPool.selectionMode !== "planner") {
        return c.json({ error_code: "bad_request", message: "workerModelPool.selectionMode must be automatic or planner" }, 400);
      }
      for (const key of ["inputUsdPerMillion", "outputUsdPerMillion"] as const) {
        const value = workerPool[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000)) {
          return c.json({ error_code: "bad_request", message: `workerModelPool.${key} must be between 0 and 1000` }, 400);
        }
      }
    }
    if (model && !model.startsWith("custom/") && !model.startsWith("local/") && !isAllowedModel(model)) {
      return c.json({ error_code: "bad_request", message: `modelConfig.model must be one of ${ALLOWED_MODELS.join(", ")}` }, 400);
    }
    if (model && policy?.mode === "whitelist_only" && !policy.allowedModelIds.includes(model)) {
      return c.json({ error_code: "compliance_violation", message: `Model '${model}' is not certified by this product policy` }, 400);
    }
    if (body.product_config?.compliance?.airGappedOnly === true && model && !model.startsWith("local/")) {
      return c.json({ error_code: "compliance_violation", message: "Air-gapped products require a local/* model" }, 400);
    }
    const effort = body.product_config?.modelConfig?.effort;
    if (effort && !isValidEffortLevel(model ?? DEFAULT_WORKING_MODEL, effort)) {
      return c.json({ error_code: "bad_request", message: `modelConfig.effort '${effort}' is not offered by model '${model ?? DEFAULT_WORKING_MODEL}'` }, 400);
    }

    const config = parseProductConfig(product.config_json);
    if (body.product_config?.pricingConfig !== undefined
      && canonicalJson(body.product_config.pricingConfig) !== canonicalJson(config.productConfig?.pricingConfig)) {
      return c.json({ error_code: "bad_request", message: "native business billing configuration is disabled" }, 400);
    }
    if (body.product_config) {
      config.productConfig = { ...(config.productConfig ?? {}), ...body.product_config };
    }
    if (body.legal !== undefined) {
      config.productConfig = { ...(config.productConfig ?? {}), legal: body.legal };
    }
    const now = new Date().toISOString();
    const update = body.status === undefined
      ? await env.PLATFORM_DB.prepare(
        "UPDATE spaces SET name = COALESCE(?, name), config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      ).bind(body.name ?? null, JSON.stringify(config), now, product.id, auth.tenantId).run()
      : await env.PLATFORM_DB.prepare(
        "UPDATE spaces SET name = COALESCE(?, name), status = ?, config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND suspension_reason IS NULL AND status != 'suspended'",
      ).bind(body.name ?? null, body.status, JSON.stringify(config), now, product.id, auth.tenantId).run();
    if (update.meta.changes === 0) return c.json({ error_code: "suspension_reason_mismatch", message: "Product status changed while the request was being applied" }, 409);

    return c.json({ ok: true });
  });

  // Business product pricing, wallet top-ups, and revenue-cut configuration were removed.

  // Reseller billing configuration has been removed; FDE marketplace royalties use their own ledger.

  app.delete("/builder/products/:id", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    if (auth.tenantId === env.NAELAO_DASHBOARD_TENANT_ID && product.spacetype_id === "launchpad") {
      return c.json({ error_code: "protected_platform_product", message: "The Naelao Launchpad root cannot be deleted" }, 409);
    }
    // Release the slug. The unique index on product_slug doesn't exclude deleted rows, so a
    // soft delete used to burn the name permanently — a builder who deleted "Launchpad" and
    // rebuilt it could never call it that again, and (since nothing lets a slug be set after
    // creation) the replacement had no working URL at all. The old slug is preserved inside
    // config_json so the row remains identifiable for audit/recovery; only the live, uniqueness-
    // bearing column is cleared.
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(product.config_json ?? "{}") as Record<string, unknown>;
    } catch { /* malformed config — proceed; releasing the slug matters more than preserving it */ }
    if (product.product_slug) config["deleted_product_slug"] = product.product_slug;

    await env.PLATFORM_DB.prepare(
      "UPDATE spaces SET status = 'deleted', product_slug = NULL, config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).bind(JSON.stringify(config), new Date().toISOString(), product.id, auth.tenantId).run();
    return new Response(null, { status: 204 });
  });

  // ── /builder/space-types — the wizard's "Space-Type Selection" step needs a real listing
  // source. The legacy /spacetypes REST CRUD (dashboard/spacetypes/*) calls a route that was
  // NEVER implemented in any worker — dead code, same class of bug Phase 0 fixed for API keys.
  // Rather than resurrecting that dead system, this wraps the REAL, currently-authoritative
  // registry (SpaceTypeRegistryDO's already-working GET /types, spec §62 / CLAUDE.md #7-8) with
  // a thin builder-facing route — exactly the same "add the missing wrapper, don't rebuild the
  // backend" pattern as the domain endpoint below. Flagged, not fixed: the legacy /spacetypes
  // dead CRUD is a separate, out-of-scope gap (same treatment as /v1/team, /v1/usage in Phase 0).
  app.get("/builder/space-types", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const registryId = env.SPACE_TYPE_REGISTRY_DO.idFromName("global-space-type-registry");
    const registry = env.SPACE_TYPE_REGISTRY_DO.get(registryId);
    const resp = await registry.fetch(new Request("http://registry/types"));
    return new Response(resp.body, { status: resp.status, headers: { "content-type": "application/json" } });
  });

  // Legacy builder wallet aggregates were removed; marketplace royalties are separate.

  // ── /builder/products/:id/domain — the missing builder-facing wrapper the CF-for-SaaS custom
  // domain flow never had (only reachable via /internal/business-services, HMAC-gated) ──────────
  app.post("/builder/products/:id/domain", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const body = await c.req.json<{ custom_domain: string }>();
    if (!body.custom_domain) return c.json({ error_code: "bad_request", message: "custom_domain is required" }, 400);
    try { body.custom_domain = normalizeCustomHostname(body.custom_domain); }
    catch (err) { return c.json({ error_code: "bad_request", message: (err as Error).message }, 400); }

    const cf = cfSaasConfig(env);
    let cfHostnameId: string | null = null;
    let validationRecords: unknown[] = [];
    if (cf) {
      try {
        const result = await createCustomHostname(cf, body.custom_domain);
        cfHostnameId = result.id;
        validationRecords = result.validation_records;
      } catch (err) {
        return c.json({ error_code: "cf_saas_failed", message: (err as Error).message }, 502);
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO business_services (id, space_id, tenant_id, kind, custom_domain, cf_hostname_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'custom_domain', ?, ?, 'pending_dns', ?, ?)
       ON CONFLICT(space_id, kind) DO UPDATE SET custom_domain = excluded.custom_domain, cf_hostname_id = excluded.cf_hostname_id, status = 'pending_dns', updated_at = excluded.updated_at`
    ).bind(id, product.id, auth.tenantId, body.custom_domain, cfHostnameId, now, now).run();

    return c.json({
      custom_domain: body.custom_domain,
      status: "pending_dns",
      cf_hostname_id: cfHostnameId,
      dns: { type: "CNAME", name: body.custom_domain, value: `fallback.${env.STOREFRONT_ROOT ?? "naelao.com"}` },
      validation_records: validationRecords,
    }, 202);
  });

  app.get("/builder/products/:id/domain", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const row = await env.PLATFORM_DB.prepare(
      "SELECT cf_hostname_id, custom_domain, status FROM business_services WHERE space_id = ? AND kind = 'custom_domain'"
    ).bind(product.id).first<{ cf_hostname_id: string | null; custom_domain: string | null; status: string }>();
    if (!row) return c.json({ custom_domain: null, status: "not_configured" });

    const cf = cfSaasConfig(env);
    if (!cf || !row.cf_hostname_id) return c.json({ custom_domain: row.custom_domain, status: row.status, ssl_status: "unknown" });

    let result;
    try { result = await getCustomHostname(cf, row.cf_hostname_id); }
    catch (err) { return c.json({ error_code: "cf_saas_failed", message: (err as Error).message }, 502); }
    const active = result.status === "active" && result.ssl_status === "active";
    if (active && row.status !== "active") {
      await env.PLATFORM_DB.prepare(
        "UPDATE business_services SET status = 'active', updated_at = ? WHERE space_id = ? AND kind = 'custom_domain'"
      ).bind(new Date().toISOString(), product.id).run();
    }
    return c.json({ custom_domain: row.custom_domain, status: active ? "active" : row.status, ssl_status: result.ssl_status });
  });

  // ── /builder/products/:id/users — the product_end_users roster (Phase 6 populates rows) ──────
  app.get("/builder/products/:id/users", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT end_user_id, email, display_name, first_seen_at, last_seen_at, suspended_at
         FROM product_end_users WHERE product_space_id = ? ORDER BY first_seen_at DESC LIMIT 500`
    ).bind(product.id).all();
    return c.json({ data: results });
  });

  app.post("/builder/products/:id/users/:userId/suspend", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const userId = c.req.param("userId");
    await env.PLATFORM_DB.prepare(
      "UPDATE product_end_users SET suspended_at = ? WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(new Date().toISOString(), product.id, userId).run();
    const stub = await productUserDoStubFor(env, product.id, userId, auth.tenantId);
    await stub.fetch(new Request("http://do/sessions/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    return c.json({ ok: true });
  });

  app.delete("/builder/products/:id/users/:userId", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const userId = c.req.param("userId");
    await env.PLATFORM_DB.prepare(
      "UPDATE product_end_users SET suspended_at = ? WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(new Date().toISOString(), product.id, userId).run();
    const stub = await productUserDoStubFor(env, product.id, userId, auth.tenantId);
    await stub.fetch(new Request("http://do/sessions/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    return new Response(null, { status: 204 });
  });

  // ── /builder/products/:id/users/:userId/conversations — THE gated endpoint ───────────────────
  // Three independent gates, ALL required, checked in this order (cheapest/least-sensitive
  // first): (1) the builder has the feature enabled for this product, (2) Naelao platform staff
  // has manually approved conversation access for this SPACE (spec Surface 1 approval queue —
  // conversation_access_approved_by/_at, migration 0044), (3) the END USER has logged consent
  // (product_end_users.consented_at). Any failing gate returns 403 with a specific reason so the
  // builder's dashboard can show the right next step, but discloses NOTHING about the
  // conversation itself. On success: returns METADATA ONLY (thread_id, title, created_at — never
  // message content, sourced from ProductUserDO's conversation_refs) and writes an immutable
  // audit row. A denied attempt writes NOTHING (nothing was disclosed).
  app.get("/builder/products/:id/users/:userId/conversations", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const userId = c.req.param("userId");

    // Gate 1: builder's own feature flag.
    const { productConfig } = parseProductConfig(product.config_json);
    if (!productConfig?.adminFeatures?.conversationLogAccess) {
      return c.json({ error_code: "forbidden", message: "conversationLogAccess is not enabled for this product", gate: "feature_flag" }, 403);
    }

    // Gate 2: Naelao platform-staff manual approval (per-space, legally required).
    if (!product.conversation_access_approved_by || !product.conversation_access_approved_at) {
      return c.json({ error_code: "forbidden", message: "Conversation access is pending Naelao platform approval", gate: "staff_approval" }, 403);
    }

    // Gate 3: the end user's own logged consent.
    const endUserRow = await env.PLATFORM_DB.prepare(
      "SELECT consented_at FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(product.id, userId).first<{ consented_at: string | null }>();
    if (!endUserRow?.consented_at) {
      return c.json({ error_code: "forbidden", message: "This end user has not consented to conversation access", gate: "user_consent" }, 403);
    }

    // All three gates passed — fetch METADATA ONLY from ProductUserDO, never message content.
    const stub = await productUserDoStubFor(env, product.id, userId, auth.tenantId);
    const query = new URLSearchParams();
    const limit = c.req.query("limit");
    const cursor = c.req.query("cursor");
    if (limit !== undefined) query.set("limit", limit);
    if (cursor !== undefined) query.set("cursor", cursor);
    const doRes = await stub.fetch(new Request(`http://do/conversation-refs${query.size ? `?${query}` : ""}`));
    if (!doRes.ok) return new Response(doRes.body, { status: doRes.status, headers: { "content-type": "application/json" } });
    const refs = await doRes.json<{ data: unknown[]; next_cursor?: string }>();

    // Audit AFTER a successful disclosure only — a denied attempt discloses nothing to audit.
    await env.PLATFORM_DB.prepare(
      "INSERT INTO conversation_access_audit (id, product_space_id, end_user_id, accessed_by, purpose) VALUES (?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), product.id, userId, auth.tenantId, c.req.query("purpose") ?? null).run();

    return c.json({ data: refs.data, ...(refs.next_cursor ? { next_cursor: refs.next_cursor } : {}) });
  });

  // ── /builder/products/:id/analytics — honest, not fabricated: only what's really aggregatable
  // today. credits_consumed is intentionally null (per-end-user ProductUserDO ledgers aren't
  // bulk-queryable from D1 without an Analytics Engine wiring this phase doesn't add — a real,
  // flagged follow-up, not a fabricated number). ──────────────────────────────────────────────
  app.get("/builder/products/:id/analytics", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const dau = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS n FROM product_end_users WHERE product_space_id = ? AND last_seen_at >= ?"
    ).bind(product.id, dayAgo).first<{ n: number }>();
    const mau = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS n FROM product_end_users WHERE product_space_id = ? AND last_seen_at >= ?"
    ).bind(product.id, monthAgo).first<{ n: number }>();
    const total = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS n FROM product_end_users WHERE product_space_id = ?"
    ).bind(product.id).first<{ n: number }>();

    return c.json({
      dau: dau?.n ?? 0,
      mau: mau?.n ?? 0,
      total_users: total?.n ?? 0,
      // Not yet aggregatable platform-wide without Analytics Engine wiring — flagged, not faked.
      credits_consumed: null,
    });
  });

  // Business revenue and order analytics were removed with Launchpad commerce.

  // ── /builder/products/:id/feature-flags — no KV to invalidate: config_json overrides are read
  // live on every call (loadEffectiveProductConfig), never cached per-space. This just merges
  // into config_json.productConfig.featureFlags, same pattern as member billing (Phase 1). ──────
  app.put("/builder/products/:id/feature-flags", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const body = await c.req.json<{ flags: Record<string, boolean> }>();
    if (!body.flags || typeof body.flags !== "object") {
      return c.json({ error_code: "bad_request", message: "flags object is required" }, 400);
    }
    const config = parseProductConfig(product.config_json);
    config.productConfig = { ...(config.productConfig ?? {}), featureFlags: body.flags };
    await env.PLATFORM_DB.prepare(
      "UPDATE spaces SET config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).bind(JSON.stringify(config), new Date().toISOString(), product.id, auth.tenantId).run();
    return c.json({ feature_flags: body.flags });
  });

  // ── /builder/products/:id/webhooks ────────────────────────────────────────────────────────────
  app.post("/builder/products/:id/webhooks", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const body = await c.req.json<{ url: string; event_types?: string[] }>();
    if (!body.url) return c.json({ error_code: "bad_request", message: "url is required" }, 400);
    const id = crypto.randomUUID();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO product_webhooks (id, product_space_id, url, event_types_json) VALUES (?, ?, ?, ?)"
    ).bind(id, product.id, body.url, JSON.stringify(body.event_types ?? [])).run();
    return c.json({ id, url: body.url, event_types: body.event_types ?? [] }, 201);
  });

  app.get("/builder/products/:id/webhooks", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await builderAuthFor(env, c);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    const { results } = await env.PLATFORM_DB.prepare(
      "SELECT id, url, event_types_json, created_at FROM product_webhooks WHERE product_space_id = ? ORDER BY created_at DESC"
    ).bind(product.id).all<{ id: string; url: string; event_types_json: string; created_at: string }>();
    return c.json({ data: results.map((r) => ({ id: r.id, url: r.url, event_types: JSON.parse(r.event_types_json) as string[], created_at: r.created_at })) });
  });

  // Builder reseller billing and manual payout requests were removed. FDE marketplace
  // royalties are calculated and settled by the marketplace billing subsystem.

}
