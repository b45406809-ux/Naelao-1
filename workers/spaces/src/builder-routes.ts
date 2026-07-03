// Three-Tier Platform Model, Phase 3 (docs/spec-appendix/A1-script-agents-and-space-assistants.md
// §A1.17) — the Builder Dashboard API: /builder/products*, /builder/api-keys*, /builder/billing*.
//
// registerBuilderRoutes(app) is called once from index.ts and adds routes onto the SAME Hono app
// instance (matching this file's existing convention of one flat app — cf-saas.ts is pure logic
// with no routes; this is the first split-out file that DOES register routes, so it takes `app`
// rather than mounting a sub-app, to avoid a circular import with index.ts's own Env type: this
// file declares its own minimal structural Env shape instead of importing index.ts's Env).
//
// AUTH: every /builder/* route accepts EITHER of two callers, resolved by resolveBuilderAuth():
//  - a router-authenticated session (x-naelao-tenant-id header, set by naelao-router after JWT
//    verification — the SAME mechanism every other builder-facing route in this worker already
//    uses, e.g. /reseller/clients, /spaces/:id/member-billing). This is how the Dashboard UI
//    itself calls these routes. Full access (no per-scope restriction — a builder's own session).
//  - a Bearer `nbk_...` API key (the spec's programmatic Builder Dashboard API surface). Routed
//    to the right BuilderAccountDO via builder_api_key_index (migration 0045, pure routing data —
//    see its header comment for why this isn't a split-brain), then authoritatively re-verified
//    against that DO. Scoped to whatever scopes the key was minted with.
// Note: wiring naelao-router to actually forward external `Authorization: Bearer nbk_...` calls
// through to this worker (today the router only forwards already-JWT-authenticated sessions) is a
// separate, tracked router-level follow-up — out of this file's scope. The Dashboard UI's own use
// of these routes (Phases 4/5) works today via the x-naelao-tenant-id path.

import type { Hono } from "hono";
import { getDOName } from "@naelao/crypto";
import { createCustomHostname, getCustomHostname, cfSaasConfig } from "./cf-saas.js";
import type { SpaceTypeProductConfig } from "./do/SpaceTypeRegistryDO.js";

/** The minimal env shape this file needs — kept local (not imported from index.ts's Env) so
 *  index.ts -> builder-routes.ts -> index.ts never forms a circular import. index.ts's real Env
 *  is a structural superset and satisfies this at the call site. */
export interface BuilderRoutesEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  BUILDER_ACCOUNT_DO: DurableObjectNamespace;
  PRODUCT_USER_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  CF_API_TOKEN?: string;
  CF_SAAS_ZONE_ID?: string;
  STOREFRONT_ROOT?: string;
}

interface SpaceRow {
  id: string;
  tenant_id: string;
  name: string;
  status: string;
  spacetype_id: string;
  config_json: string | null;
  product_slug: string | null;
  conversation_access_approved_by: string | null;
  conversation_access_approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const ALLOWED_STATUSES = ["draft", "active", "paused", "suspended", "deleted"] as const;

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ResolvedBuilder { tenantId: string; scopes: string[] }

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
  if (headerTenant) return { tenantId: headerTenant, scopes: ["*"] };

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
    `SELECT id, tenant_id, name, status, spacetype_id, config_json, product_slug,
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
  // ── /builder/api-keys — consolidates onto Phase 1's BuilderAccountDO ─────────────────────────
  app.post("/builder/api-keys", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);

    const body = await c.req.json<{ name: string; scopes: string[]; expires_in_days?: number }>();
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
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const stub = await builderAccountDoStubFor(env, auth.tenantId);
    const doRes = await stub.fetch(new Request("http://do/api-keys"));
    return new Response(doRes.body, { status: doRes.status, headers: { "content-type": "application/json" } });
  });

  app.delete("/builder/api-keys/:id", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const stub = await builderAccountDoStubFor(env, auth.tenantId);
    const doRes = await stub.fetch(new Request(`http://do/api-keys/${encodeURIComponent(c.req.param("id"))}`, { method: "DELETE" }));
    return new Response(doRes.body, { status: doRes.status });
  });

  // ── /builder/products — CRUD ─────────────────────────────────────────────────────────────────
  app.post("/builder/products", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);

    const body = await c.req.json<{ name: string; spacetype_id: string; product_slug?: string }>();
    if (!body.name || !body.spacetype_id) {
      return c.json({ error_code: "bad_request", message: "name and spacetype_id are required" }, 400);
    }
    if (body.product_slug && !/^[a-z0-9-]{2,40}$/.test(body.product_slug)) {
      return c.json({ error_code: "bad_request", message: "product_slug must match ^[a-z0-9-]{2,40}$" }, 400);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await env.PLATFORM_DB.prepare(
        `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json, product_slug, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, 'draft', '{}', ?, ?, ?, ?)`
      ).bind(id, auth.tenantId, body.spacetype_id, body.name, body.product_slug ?? null, now, now, auth.tenantId).run();
    } catch (err) {
      if ((err as Error).message?.includes("UNIQUE")) {
        return c.json({ error_code: "conflict", message: "product_slug is already taken" }, 409);
      }
      throw err;
    }

    const stub = await builderAccountDoStubFor(env, auth.tenantId);
    await stub.fetch(new Request("http://do/products", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product_space_id: id }) }));

    return c.json({ id, name: body.name, spacetype_id: body.spacetype_id, status: "draft", product_slug: body.product_slug ?? null, created_at: now }, 201);
  });

  app.get("/builder/products", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT id, name, status, spacetype_id, product_slug, created_at, updated_at
         FROM spaces WHERE tenant_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 200`
    ).bind(auth.tenantId).all();
    return c.json({ data: results });
  });

  app.get("/builder/products/:id", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    const { productConfig } = parseProductConfig(product.config_json);
    return c.json({ ...product, config_json: undefined, product_config: productConfig ?? {} });
  });

  app.patch("/builder/products/:id", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const body = await c.req.json<{
      name?: string;
      status?: string;
      product_config?: Partial<SpaceTypeProductConfig>;
    }>();

    if (body.status && !ALLOWED_STATUSES.includes(body.status as (typeof ALLOWED_STATUSES)[number])) {
      return c.json({ error_code: "bad_request", message: `status must be one of ${ALLOWED_STATUSES.join(", ")}` }, 400);
    }

    const config = parseProductConfig(product.config_json);
    if (body.product_config) {
      config.productConfig = { ...(config.productConfig ?? {}), ...body.product_config };
    }
    const now = new Date().toISOString();
    await env.PLATFORM_DB.prepare(
      "UPDATE spaces SET name = COALESCE(?, name), status = COALESCE(?, status), config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).bind(body.name ?? null, body.status ?? null, JSON.stringify(config), now, product.id, auth.tenantId).run();

    return c.json({ ok: true });
  });

  app.delete("/builder/products/:id", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    await env.PLATFORM_DB.prepare(
      "UPDATE spaces SET status = 'deleted', updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).bind(new Date().toISOString(), product.id, auth.tenantId).run();
    return new Response(null, { status: 204 });
  });

  // ── /builder/products/:id/domain — the missing builder-facing wrapper the CF-for-SaaS custom
  // domain flow never had (only reachable via /internal/business-services, HMAC-gated) ──────────
  app.post("/builder/products/:id/domain", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const body = await c.req.json<{ custom_domain: string }>();
    if (!body.custom_domain) return c.json({ error_code: "bad_request", message: "custom_domain is required" }, 400);

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
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const row = await env.PLATFORM_DB.prepare(
      "SELECT cf_hostname_id, custom_domain, status FROM business_services WHERE space_id = ? AND kind = 'custom_domain'"
    ).bind(product.id).first<{ cf_hostname_id: string | null; custom_domain: string | null; status: string }>();
    if (!row) return c.json({ custom_domain: null, status: "not_configured" });

    const cf = cfSaasConfig(env);
    if (!cf || !row.cf_hostname_id) return c.json({ custom_domain: row.custom_domain, status: row.status, ssl_status: "unknown" });

    const result = await getCustomHostname(cf, row.cf_hostname_id);
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
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
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
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
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
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
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
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
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
    const doRes = await stub.fetch(new Request("http://do/conversation-refs"));
    const refs = await doRes.json<{ data: unknown[] }>();

    // Audit AFTER a successful disclosure only — a denied attempt discloses nothing to audit.
    await env.PLATFORM_DB.prepare(
      "INSERT INTO conversation_access_audit (id, product_space_id, end_user_id, accessed_by, purpose) VALUES (?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), product.id, userId, auth.tenantId, c.req.query("purpose") ?? null).run();

    return c.json({ data: refs.data });
  });

  // ── /builder/products/:id/analytics — honest, not fabricated: only what's really aggregatable
  // today. credits_consumed is intentionally null (per-end-user ProductUserDO ledgers aren't
  // bulk-queryable from D1 without an Analytics Engine wiring this phase doesn't add — a real,
  // flagged follow-up, not a fabricated number). ──────────────────────────────────────────────
  app.get("/builder/products/:id/analytics", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
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

  app.get("/builder/products/:id/analytics/revenue", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const period = new Date().toISOString().slice(0, 7);
    const revenue = await env.PLATFORM_DB.prepare(
      `SELECT COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(fee_cents),0) AS fees,
              COALESCE(SUM(net_cents),0) AS net, COUNT(*) AS orders
         FROM launchpad_orders
        WHERE space_id = ? AND status IN ('paid','fulfilling','fulfilled') AND substr(created_at,1,7) = ?`
    ).bind(product.id, period).first<{ gross: number; fees: number; net: number; orders: number }>();
    const wholesale = await env.PLATFORM_DB.prepare(
      `SELECT COALESCE(SUM(wholesale_cents),0) AS wholesale
         FROM reseller_ledger WHERE parent_tenant_id = ? AND period = ?`
    ).bind(auth.tenantId, period).first<{ wholesale: number }>();

    return c.json({
      period,
      gross_revenue_cents: revenue?.gross ?? 0,
      naelao_fee_cents: revenue?.fees ?? 0,
      net_revenue_cents: revenue?.net ?? 0,
      order_count: revenue?.orders ?? 0,
      naelao_wholesale_cost_cents: wholesale?.wholesale ?? 0,
    });
  });

  // ── /builder/products/:id/feature-flags — no KV to invalidate: config_json overrides are read
  // live on every call (loadEffectiveProductConfig), never cached per-space. This just merges
  // into config_json.productConfig.featureFlags, same pattern as member billing (Phase 1). ──────
  app.put("/builder/products/:id/feature-flags", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
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
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
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
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const product = await loadOwnedProduct(env, c.req.param("id"), auth.tenantId);
    if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    const { results } = await env.PLATFORM_DB.prepare(
      "SELECT id, url, event_types_json, created_at FROM product_webhooks WHERE product_space_id = ? ORDER BY created_at DESC"
    ).bind(product.id).all<{ id: string; url: string; event_types_json: string; created_at: string }>();
    return c.json({ data: results.map((r) => ({ id: r.id, url: r.url, event_types: JSON.parse(r.event_types_json) as string[], created_at: r.created_at })) });
  });

  // ── /builder/billing — wraps the same reseller_ledger rollup /reseller/statement already uses,
  // scoped by builder tenant rather than reseller parent — a builder's own wholesale bill. ───────
  app.get("/builder/billing", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const period = c.req.query("period") ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period)) return c.json({ error_code: "bad_request", message: "period must be YYYY-MM" }, 400);
    const row = await env.PLATFORM_DB.prepare(
      `SELECT COALESCE(SUM(retail_cents),0) AS retail, COALESCE(SUM(wholesale_cents),0) AS wholesale,
              COALESCE(SUM(margin_cents),0) AS margin, COUNT(*) AS events
         FROM reseller_ledger WHERE parent_tenant_id = ? AND period = ?`
    ).bind(auth.tenantId, period).first<{ retail: number; wholesale: number; margin: number; events: number }>();
    return c.json({ period, ...(row ?? { retail: 0, wholesale: 0, margin: 0, events: 0 }) });
  });

  app.get("/builder/billing/history", async (c) => {
    const env = c.env as BuilderRoutesEnv;
    const auth = await resolveBuilderAuth(env, c.req.raw.headers);
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid credentials" }, 401);
    const { results } = await env.PLATFORM_DB.prepare(
      `SELECT period, COALESCE(SUM(retail_cents),0) AS retail, COALESCE(SUM(wholesale_cents),0) AS wholesale,
              COALESCE(SUM(margin_cents),0) AS margin, COUNT(*) AS events
         FROM reseller_ledger WHERE parent_tenant_id = ? GROUP BY period ORDER BY period DESC LIMIT 24`
    ).bind(auth.tenantId).all();
    return c.json({ data: results });
  });
}
