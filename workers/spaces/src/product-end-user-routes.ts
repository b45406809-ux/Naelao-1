// Three-Tier Platform Model, Phase 6 — public, UNAUTHENTICATED end-user signup/login for
// products configured with authProvider.provider === 'naelao-native' (Journey 1B: "End user
// signs up or is invited via the builder's configured auth provider"). ProductUserDO (Phase 2)
// mints and verifies SESSIONS but never verifies an identity in the first place — that's what
// this file adds: a credential (email + password) scoped entirely to one product, per the
// spec's Tier 2 definition. Registered on the router's UNAUTHENTICATED path (mirrors
// /v1/auth/*), since a visitor has no token at all before signing up.
//
// Other authProvider values (clerk/custom-oidc/saml-sso) verify identity externally — these
// routes reject with 400 if the product isn't configured for naelao-native, rather than
// pretending to support a flow that isn't built.

import type { Hono } from "hono";
import { hashPassword, verifyPassword } from "@naelao/crypto";
import type { HashedPassword } from "@naelao/crypto";
import { getDOName } from "@naelao/crypto";
import type { SpaceTypeProductConfig } from "./do/SpaceTypeRegistryDO.js";

export interface ProductEndUserRoutesEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  PRODUCT_USER_DO: DurableObjectNamespace;
  SPACE_TYPE_REGISTRY_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
}

interface ProductRow {
  id: string;
  tenant_id: string;
  spacetype_id: string;
  config_json: string | null;
}

async function loadProductAuthConfig(
  env: ProductEndUserRoutesEnv,
  productId: string
): Promise<{ product: ProductRow; authConfig: SpaceTypeProductConfig["authProvider"] } | null> {
  const product = await env.PLATFORM_DB.prepare(
    "SELECT id, tenant_id, spacetype_id, config_json FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(productId).first<ProductRow>();
  if (!product) return null;

  let authConfig: SpaceTypeProductConfig["authProvider"] | undefined;
  if (product.config_json) {
    try {
      const parsed = JSON.parse(product.config_json) as { productConfig?: SpaceTypeProductConfig };
      authConfig = parsed.productConfig?.authProvider;
    } catch { /* malformed config_json — treat as unset, fall through to default below */ }
  }
  // Default to naelao-native when unset — a product that never configured an auth provider is
  // not "no auth allowed," it's "hasn't picked one yet," and naelao-native is the fastest-to-ship
  // default the spec itself names.
  return { product, authConfig: authConfig ?? { provider: "naelao-native" } };
}

async function productUserDoStub(env: ProductEndUserRoutesEnv, productId: string, endUserId: string, tenantId: string) {
  const doId = env.PRODUCT_USER_DO.idFromName(
    await getDOName("produser", `${productId}:${endUserId}`, tenantId, env.PLATFORM_SECRET)
  );
  return env.PRODUCT_USER_DO.get(doId);
}

export function registerProductEndUserRoutes(app: Hono<any>): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  app.post("/spaces/:spaceId/end-users/signup", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const resolved = await loadProductAuthConfig(env, productId);
    if (!resolved) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    if (resolved.authConfig?.provider !== "naelao-native") {
      return c.json({ error_code: "unsupported_provider", message: `This product uses ${resolved.authConfig?.provider ?? "an external"} sign-in, not email/password` }, 400);
    }

    const body = await c.req.json<{ email: string; password: string; display_name?: string }>();
    if (!body.email || !body.password || body.password.length < 8) {
      return c.json({ error_code: "bad_request", message: "email and a password (min 8 chars) are required" }, 400);
    }
    const email = body.email.trim().toLowerCase();

    if (resolved.authConfig.allowedEmailDomains?.length) {
      const domain = email.split("@")[1] ?? "";
      if (!resolved.authConfig.allowedEmailDomains.includes(domain)) {
        return c.json({ error_code: "domain_not_allowed", message: `Sign-ups are restricted to: ${resolved.authConfig.allowedEmailDomains.join(", ")}` }, 403);
      }
    }

    const existing = await env.PLATFORM_DB.prepare(
      "SELECT end_user_id FROM product_end_users WHERE product_space_id = ? AND email = ?"
    ).bind(productId, email).first<{ end_user_id: string }>();
    if (existing) return c.json({ error_code: "conflict", message: "An account with this email already exists" }, 409);

    const endUserId = crypto.randomUUID();
    const hashed = await hashPassword(body.password);
    await env.PLATFORM_DB.prepare(
      `INSERT INTO product_end_users (product_space_id, end_user_id, email, display_name, password_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(productId, endUserId, email, body.display_name ?? null, JSON.stringify(hashed)).run();

    const stub = await productUserDoStub(env, productId, endUserId, resolved.product.tenant_id);
    const sessionRes = await stub.fetch(new Request("http://do/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth_provider: "naelao-native" }),
    }));
    const session = await sessionRes.json<{ session_token: string; expires_at: string }>();

    return c.json({ end_user_id: endUserId, session_token: session.session_token, expires_at: session.expires_at }, 201);
  });

  app.post("/spaces/:spaceId/end-users/login", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const resolved = await loadProductAuthConfig(env, productId);
    if (!resolved) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    if (resolved.authConfig?.provider !== "naelao-native") {
      return c.json({ error_code: "unsupported_provider", message: `This product uses ${resolved.authConfig?.provider ?? "an external"} sign-in, not email/password` }, 400);
    }

    const body = await c.req.json<{ email: string; password: string }>();
    if (!body.email || !body.password) {
      return c.json({ error_code: "bad_request", message: "email and password are required" }, 400);
    }
    const email = body.email.trim().toLowerCase();

    const row = await env.PLATFORM_DB.prepare(
      "SELECT end_user_id, password_hash, suspended_at FROM product_end_users WHERE product_space_id = ? AND email = ?"
    ).bind(productId, email).first<{ end_user_id: string; password_hash: string | null; suspended_at: string | null }>();
    // Constant-shape response whether the email doesn't exist or the password is wrong — never
    // reveal which one it was.
    if (!row || !row.password_hash) return c.json({ error_code: "invalid_credentials", message: "Incorrect email or password" }, 401);
    const ok = await verifyPassword(body.password, JSON.parse(row.password_hash) as HashedPassword);
    if (!ok) return c.json({ error_code: "invalid_credentials", message: "Incorrect email or password" }, 401);
    if (row.suspended_at) return c.json({ error_code: "suspended", message: "This account has been suspended" }, 403);

    await env.PLATFORM_DB.prepare(
      "UPDATE product_end_users SET last_seen_at = datetime('now') WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(productId, row.end_user_id).run();

    const stub = await productUserDoStub(env, productId, row.end_user_id, resolved.product.tenant_id);
    const sessionRes = await stub.fetch(new Request("http://do/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth_provider: "naelao-native" }),
    }));
    const session = await sessionRes.json<{ session_token: string; expires_at: string }>();

    return c.json({ end_user_id: row.end_user_id, session_token: session.session_token, expires_at: session.expires_at });
  });
}
