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
  NOTIFICATIONS_WORKER?: Fetcher;
  /** Public base URL of apps/shell (e.g. "https://app.naelao.com"), used to build a clickable
   *  verification link ("${base}/p/{slug}/verify-email?token=..."). Deliberately left unset by
   *  default rather than guessing a production domain — when unset, the email still carries the
   *  raw token, and the shell's verify-email page accepts a manually pasted token, so signup
   *  verification works either way, not just when this happens to be configured correctly. */
  PRODUCT_SHELL_URL?: string;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour, same order of magnitude as business_invites' 7-day cap but shorter since this grants a live credential change
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — long enough that a slow inbox doesn't lock a legitimate signup out of its free credits

async function sendEmail(env: ProductEndUserRoutesEnv, tenantId: string, spaceId: string, to: string, subject: string, body: string): Promise<void> {
  if (!env.NOTIFICATIONS_WORKER) return;
  try {
    await env.NOTIFICATIONS_WORKER.fetch(new Request("http://notifications-worker/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId },
      body: JSON.stringify({ channel: "email", space_id: spaceId, to, subject, body }),
    }));
  } catch { /* best-effort — never blocks the caller's own response */ }
}

async function issueVerificationToken(env: ProductEndUserRoutesEnv, productId: string, endUserId: string, tenantId: string, email: string, slug: string | null): Promise<void> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString();
  await env.PLATFORM_DB.prepare(
    `INSERT INTO email_verification_tokens (id, product_space_id, end_user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), productId, endUserId, tokenHash, expiresAt).run();
  const link = env.PRODUCT_SHELL_URL && slug
    ? `\n\nOr click this link: ${env.PRODUCT_SHELL_URL}/p/${slug}/verify-email?token=${token}`
    : "";
  await sendEmail(env, tenantId, productId, email, "Verify your email",
    `Verification token: ${token}${link}\n\nThis token expires in 24 hours. Verifying unlocks your free starting credits.`);
}

interface ProductRow {
  id: string;
  tenant_id: string;
  spacetype_id: string;
  config_json: string | null;
  product_slug: string | null;
}

// Metering enforcement pass, follow-up: a product with pricingConfig.model === "free" (or no
// pricingConfig at all — a product that never configured pricing is closer to "free" than to any
// paid model) is an explicit builder signal that end users shouldn't need to pay to use it. Before
// the pre-run credit gate existed, that "just worked" by accident (every run was unmetered). Now
// that runs are actually gated on a positive balance, "free" and "0 credits granted" would mean
// the same thing — instant lockout on message one — unless a builder happens to also fill in
// creditsIncludedPerMonth (a field the wizard only shows for the "credits" pricing model in the
// first place). This platform default keeps a "Free" product usable out of the box without
// reintroducing unmetered/unlimited runs. Deliberately NOT applied to "credits"/"subscription"/
// "seats" models with an unset or explicit 0 allowance — those models are the builder's own
// explicit monetization choice ("pay first"), which this default must not override.
const FREE_TIER_DEFAULT_SIGNUP_CREDITS = 100;

async function loadProductAuthConfig(
  env: ProductEndUserRoutesEnv,
  productId: string
): Promise<{ product: ProductRow; authConfig: SpaceTypeProductConfig["authProvider"]; signupCredits: number } | null> {
  const product = await env.PLATFORM_DB.prepare(
    "SELECT id, tenant_id, spacetype_id, config_json, product_slug FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(productId).first<ProductRow>();
  if (!product) return null;

  let authConfig: SpaceTypeProductConfig["authProvider"] | undefined;
  let signupCredits = 0;
  if (product.config_json) {
    try {
      const parsed = JSON.parse(product.config_json) as { productConfig?: SpaceTypeProductConfig };
      authConfig = parsed.productConfig?.authProvider;
      // Metering enforcement pass: `creditsIncludedPerMonth` was builder-configurable through the
      // product creation wizard but nothing ever read it — every new end user started at a
      // permanent 0 balance, which (now that agent runs are gated on a positive balance — see
      // NaelaoAgentDO's pre-run credit check) would otherwise make the free tier unusable from
      // message one. Granted ONCE at signup, not actually monthly-recurring — a real recurring
      // top-up would need its own scheduled sweep per end user, which is a separate, larger
      // feature this fix does not attempt to build.
      const pricingConfig = parsed.productConfig?.pricingConfig;
      const isFreeOrUnconfigured = !pricingConfig || pricingConfig.model === "free";
      signupCredits = pricingConfig?.creditsIncludedPerMonth
        ?? (isFreeOrUnconfigured ? FREE_TIER_DEFAULT_SIGNUP_CREDITS : 0);
    } catch { /* malformed config_json — treat as unset, fall through to default below */ }
  } else {
    // No config_json at all — same "hasn't configured pricing yet" case as above.
    signupCredits = FREE_TIER_DEFAULT_SIGNUP_CREDITS;
  }
  // Default to naelao-native when unset — a product that never configured an auth provider is
  // not "no auth allowed," it's "hasn't picked one yet," and naelao-native is the fastest-to-ship
  // default the spec itself names.
  return { product, authConfig: authConfig ?? { provider: "naelao-native" }, signupCredits };
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

    // Security audit follow-up: the free-credit grant used to fire immediately at signup, which
    // is exactly what makes farming free compute as cheap as generating throwaway email
    // addresses — the pre-auth IP rate limiter (router) bounds that but doesn't eliminate a
    // slow/distributed farmer. The account and session are usable immediately either way (a
    // legitimate user isn't blocked from signing in), but the credit grant itself now only
    // fires from verify-email below — see issueVerificationToken. A product with nothing to
    // grant (paid pricing model, no allowance) skips sending a verification email entirely,
    // since there's no farming incentive to close for it.
    //
    // Best-effort, same posture as every other post-account-creation side effect in this file
    // (the credit grant itself, the notify() call): a failure here (e.g. transient D1 issue)
    // must never fail the signup response — the account and session already exist and are
    // valid. Worst case, the end user starts unverified and can retry via resend-verification.
    if (resolved.signupCredits > 0) {
      try {
        await issueVerificationToken(env, productId, endUserId, resolved.product.tenant_id, email, resolved.product.product_slug);
      } catch { /* best-effort */ }
    }

    return c.json({ end_user_id: endUserId, session_token: session.session_token, expires_at: session.expires_at, email_verification_required: resolved.signupCredits > 0 }, 201);
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

  // Security audit follow-up: naelao-native end users had a login with no recovery path at all —
  // a lost password meant a lost account. Same shape as business_invites (business-routes.ts):
  // hashed, single-use, expiring token; never reveal whether the email exists (constant response
  // either way — mirrors the login route's own "don't reveal which part was wrong" precedent).
  app.post("/spaces/:spaceId/end-users/request-password-reset", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const resolved = await loadProductAuthConfig(env, productId);
    if (!resolved) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    if (resolved.authConfig?.provider !== "naelao-native") {
      return c.json({ error_code: "unsupported_provider", message: `This product uses ${resolved.authConfig?.provider ?? "an external"} sign-in, not email/password` }, 400);
    }

    const body = await c.req.json<{ email: string }>();
    const email = (body.email ?? "").trim().toLowerCase();
    const ALWAYS_OK = c.json({ ok: true, message: "If an account with that email exists, a reset link has been sent." });
    if (!email) return ALWAYS_OK;

    const row = await env.PLATFORM_DB.prepare(
      "SELECT end_user_id FROM product_end_users WHERE product_space_id = ? AND email = ? AND password_hash IS NOT NULL"
    ).bind(productId, email).first<{ end_user_id: string }>();
    if (!row) return ALWAYS_OK; // never reveal whether the email exists

    const token = crypto.randomUUID() + crypto.randomUUID();
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO password_reset_tokens (id, product_space_id, end_user_id, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), productId, row.end_user_id, tokenHash, expiresAt).run();

    // Best-effort — same precedent as every other notify() call in this codebase: a delivery
    // failure must never leak whether the account exists via a different response shape, so
    // this can't be allowed to change ALWAYS_OK's response.
    await sendEmail(env, resolved.product.tenant_id, productId, email, "Reset your password",
      `Reset token: ${token}\n\nThis token expires in 1 hour. If you didn't request this, ignore this email.`);

    return ALWAYS_OK;
  });

  app.post("/spaces/:spaceId/end-users/reset-password", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const body = await c.req.json<{ token: string; new_password: string }>();
    if (!body.token || !body.new_password || body.new_password.length < 8) {
      return c.json({ error_code: "bad_request", message: "token and a new_password (min 8 chars) are required" }, 400);
    }

    const tokenHash = await sha256Hex(body.token);
    const row = await env.PLATFORM_DB.prepare(
      `SELECT id, end_user_id, expires_at, used_at FROM password_reset_tokens
       WHERE product_space_id = ? AND token_hash = ?`
    ).bind(productId, tokenHash).first<{ id: string; end_user_id: string; expires_at: string; used_at: string | null }>();
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      return c.json({ error_code: "invalid_token", message: "This reset link is invalid or has expired" }, 400);
    }

    const hashed = await hashPassword(body.new_password);
    await env.PLATFORM_DB.prepare(
      "UPDATE product_end_users SET password_hash = ? WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(JSON.stringify(hashed), productId, row.end_user_id).run();
    // Single-use: mark consumed so this exact token can never be replayed.
    await env.PLATFORM_DB.prepare(
      "UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?"
    ).bind(row.id).run();

    return c.json({ ok: true, message: "Password updated. Sign in with your new password." });
  });

  // Security audit follow-up: closes the free-credit-farming hole at its source — the signup
  // allowance now only grants once a real inbox is proven reachable. Idempotency_key is the SAME
  // deterministic `signup:${endUserId}` key the old immediate-grant used, so this can never
  // double-grant even if verify-email is called twice (e.g. a double-clicked email link).
  app.post("/spaces/:spaceId/end-users/verify-email", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const body = await c.req.json<{ token: string }>();
    if (!body.token) return c.json({ error_code: "bad_request", message: "token is required" }, 400);

    const tokenHash = await sha256Hex(body.token);
    const row = await env.PLATFORM_DB.prepare(
      `SELECT id, end_user_id, expires_at, used_at FROM email_verification_tokens
       WHERE product_space_id = ? AND token_hash = ?`
    ).bind(productId, tokenHash).first<{ id: string; end_user_id: string; expires_at: string; used_at: string | null }>();
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      return c.json({ error_code: "invalid_token", message: "This verification link is invalid or has expired" }, 400);
    }

    await env.PLATFORM_DB.prepare(
      "UPDATE product_end_users SET email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(productId, row.end_user_id).run();
    await env.PLATFORM_DB.prepare(
      "UPDATE email_verification_tokens SET used_at = datetime('now') WHERE id = ?"
    ).bind(row.id).run();

    // Grant whatever the product's CURRENT pricing config says a signup should receive — reads
    // fresh rather than storing the amount at signup time, same "current config wins" posture
    // loadProductAuthConfig already uses everywhere else. Best-effort: a grant failure must
    // never fail email verification itself.
    const resolved = await loadProductAuthConfig(env, productId);
    if (resolved && resolved.signupCredits > 0) {
      try {
        const stub = await productUserDoStub(env, productId, row.end_user_id, resolved.product.tenant_id);
        await stub.fetch(new Request("http://do/credits/grant", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ credits: resolved.signupCredits, reason: "signup_allowance", idempotency_key: `signup:${row.end_user_id}` }),
        }));
      } catch { /* best-effort */ }
    }

    return c.json({ ok: true, message: "Email verified." });
  });

  app.post("/spaces/:spaceId/end-users/resend-verification", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const resolved = await loadProductAuthConfig(env, productId);
    if (!resolved) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    const body = await c.req.json<{ email: string }>();
    const email = (body.email ?? "").trim().toLowerCase();
    const ALWAYS_OK = c.json({ ok: true, message: "If that account exists and isn't yet verified, a new verification link has been sent." });
    if (!email) return ALWAYS_OK;

    const row = await env.PLATFORM_DB.prepare(
      "SELECT end_user_id, email_verified_at FROM product_end_users WHERE product_space_id = ? AND email = ?"
    ).bind(productId, email).first<{ end_user_id: string; email_verified_at: string | null }>();
    // Never reveal whether the account exists or is already verified — constant response.
    if (!row || row.email_verified_at) return ALWAYS_OK;

    await issueVerificationToken(env, productId, row.end_user_id, resolved.product.tenant_id, email, resolved.product.product_slug);
    return ALWAYS_OK;
  });
}
