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
import { getDOName, signHmac, verifyHmac } from "@naelao/crypto";
import { requireInternalHmac } from "@naelao/http";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import { dispatchProductAuthEmailOutboxEntry, encryptProductAuthEmailPayload, type ProductAuthEmailDispatcherEnv } from "./product-auth-email-outbox.js";
import type { SpaceTypeProductConfig } from "./do/SpaceTypeRegistryDO.js";

export interface ProductEndUserRoutesEnv extends ProductAuthEmailDispatcherEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  PRODUCT_USER_DO: DurableObjectNamespace;
  SPACE_TYPE_REGISTRY_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NOTIFICATIONS_WORKER?: Fetcher;
  /** Public base URL of apps/shell (e.g. "https://app.naelao.com"), used to build a clickable
   *  verification link with the token in the URL fragment. Fragments are not sent in HTTP
   *  requests, access logs, or referrer headers; the shell removes the fragment after reading it. */
  PRODUCT_SHELL_URL?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WHATSAPP_NUMBER?: string;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour, same order of magnitude as business_invites' 7-day cap but shorter since this grants a live credential change
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — long enough that a slow inbox doesn't lock a legitimate signup out of its free credits
const WHATSAPP_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const WHATSAPP_MAX_ATTEMPTS = 5;
const OUTBOUND_MESSAGE_TIMEOUT_MS = 10_000;
const DUMMY_PASSWORD_HASH: HashedPassword = {
  algorithm: "pbkdf2-sha256-100k",
  iterations: 100_000,
  salt: "0".repeat(64),
  hash: "0".repeat(64),
};

async function createProductSession(
  env: ProductEndUserRoutesEnv,
  productId: string,
  endUserId: string,
  tenantId: string,
  authProvider: string,
  securityGeneration: number,
): Promise<{ session_id: string; session_token: string; expires_at: string } | null> {
  const stub = await productUserDoStub(env, productId, endUserId, tenantId);
  const response = await stub.fetch(new Request("http://do/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth_provider: authProvider, security_generation: securityGeneration }),
  }));
  if (!response.ok) return null;
  const session = await response.json<{ session_id: string; session_token: string; expires_at: string }>();
  const current = await env.PLATFORM_DB.prepare(
    `SELECT security_generation, suspended_at, deleted_at FROM product_end_users
      WHERE product_space_id = ? AND end_user_id = ?`
  ).bind(productId, endUserId).first<{ security_generation: number; suspended_at: string | null; deleted_at: string | null }>();
  if (!current || current.suspended_at || current.deleted_at || current.security_generation !== securityGeneration) {
    try {
      await stub.fetch("http://do/sessions/revoke", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: session.session_id }),
      });
    } catch { /* generation is authoritative even if cleanup is temporarily unavailable */ }
    return null;
  }
  return session;
}

async function recipientHash(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

async function encryptedEmailPayload(env: ProductEndUserRoutesEnv, token: string, recipient: string, verifyUrl?: string): Promise<string> {
  return encryptProductAuthEmailPayload(env.PLATFORM_SECRET, {
    token,
    recipient: recipient.trim().toLowerCase(),
    ...(verifyUrl ? { verify_url: verifyUrl } : {}),
  });
}

function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizeE164(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, "");
  const normalized = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

function whatsappChallengeDigest(env: ProductEndUserRoutesEnv, kind: "otp" | "magic", value: string): Promise<string> {
  return signHmac(`whatsapp-auth:${kind}:${value}`, env.PLATFORM_SECRET);
}

export async function sendWhatsApp(env: ProductEndUserRoutesEnv, spaceId: string, to: string, text: string): Promise<boolean> {
  if (await isSpaceNetworkEgressDenied(env.PLATFORM_DB, spaceId)) return false;
  const phone = normalizeE164(to);
  if (!phone || text.length > 4096) return false;
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_NUMBER) {
    if (!/^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID)) return false;
    const body = new URLSearchParams({
      From: `whatsapp:${normalizeE164(env.TWILIO_WHATSAPP_NUMBER) ?? `+${env.TWILIO_WHATSAPP_NUMBER.replace(/^\+/, "")}`}`,
      To: `whatsapp:${phone}`,
      Body: text,
    });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(OUTBOUND_MESSAGE_TIMEOUT_MS),
    });
    return response.ok;
  }
  if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
    if (!/^\d{5,32}$/.test(env.WHATSAPP_PHONE_NUMBER_ID)) return false;
    const response = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: phone.slice(1), type: "text", text: { body: text } }),
      signal: AbortSignal.timeout(OUTBOUND_MESSAGE_TIMEOUT_MS),
    });
    return response.ok;
  }
  return false;
}

async function issueVerificationToken(env: ProductEndUserRoutesEnv, productId: string, endUserId: string, tenantId: string, email: string, slug: string | null): Promise<void> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString();
  const tokenId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const verifyUrl = env.PRODUCT_SHELL_URL && slug
    ? `${env.PRODUCT_SHELL_URL.replace(/\/$/, "")}/p/${encodeURIComponent(slug)}/verify-email#token=${encodeURIComponent(token)}`
    : undefined;
  const encryptedPayload = await encryptedEmailPayload(env, token, email, verifyUrl);
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `UPDATE email_verification_tokens SET used_at = datetime('now')
        WHERE product_space_id = ? AND end_user_id = ? AND used_at IS NULL`
    ).bind(productId, endUserId),
    env.PLATFORM_DB.prepare(
      `UPDATE product_auth_email_outbox SET status = 'cancelled', updated_at = datetime('now'),
         lease_token = NULL, lease_until = NULL, last_error_code = NULL
        WHERE product_space_id = ? AND end_user_id = ? AND message_kind = 'email_verification'
          AND status IN ('pending', 'sending')`
    ).bind(productId, endUserId),
    env.PLATFORM_DB.prepare(
      `INSERT INTO email_verification_tokens (id, product_space_id, end_user_id, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(tokenId, productId, endUserId, tokenHash, expiresAt),
    env.PLATFORM_DB.prepare(
      `INSERT INTO product_auth_email_outbox
        (operation_id, tenant_id, product_space_id, end_user_id, token_id, message_kind, recipient_hash, encrypted_payload)
       VALUES (?, ?, ?, ?, ?, 'email_verification', ?, ?)`
    ).bind(operationId, tenantId, productId, endUserId, tokenId, await recipientHash(email), encryptedPayload),
  ]);
  // The durable dispatcher composes the message at send time. The token stays encrypted in D1;
  // when present, its URL fragment is never sent to the web server or included in request logs.
  try { await dispatchProductAuthEmailOutboxEntry(env.PLATFORM_DB, env, operationId); }
  catch { /* the durable scheduled dispatcher will retry */ }
}

interface ProductRow {
  id: string;
  tenant_id: string;
  spacetype_id: string;
  config_json: string | null;
  product_slug: string | null;
}

async function loadProductAuthConfig(
  env: ProductEndUserRoutesEnv,
  productId: string
): Promise<{ product: ProductRow; authConfig: SpaceTypeProductConfig["authProvider"] } | null> {
  const product = await env.PLATFORM_DB.prepare(
    "SELECT id, tenant_id, spacetype_id, config_json, product_slug FROM products WHERE id = ? AND status = 'active'"
  ).bind(productId).first<ProductRow>();
  if (!product) return null;

  let authConfig: SpaceTypeProductConfig["authProvider"] | undefined;
  if (product.config_json) {
    try {
      const parsed = JSON.parse(product.config_json) as { productConfig?: SpaceTypeProductConfig };
      authConfig = parsed.productConfig?.authProvider;
    } catch { /* malformed config_json — use the generic default */ }
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
    if (typeof body.email !== "string" || typeof body.password !== "string" || body.password.length < 8 || new TextEncoder().encode(body.password).byteLength > 4096) {
      return c.json({ error_code: "bad_request", message: "email and a password (min 8 chars) are required" }, 400);
    }
    const email = body.email.trim().toLowerCase();
    if (!isValidEmail(email)) return c.json({ error_code: "bad_request", message: "Enter a valid email address" }, 400);
    if (body.display_name !== undefined && (typeof body.display_name !== "string" || body.display_name.length > 100)) {
      return c.json({ error_code: "bad_request", message: "display_name must be at most 100 characters" }, 400);
    }

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
    try {
      await env.PLATFORM_DB.prepare(
        `INSERT INTO product_end_users (product_space_id, end_user_id, email, display_name, password_hash, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).bind(productId, endUserId, email, body.display_name?.trim() || null, JSON.stringify(hashed)).run();
    } catch (err) {
      if ((err as Error).message?.includes("UNIQUE")) return c.json({ error_code: "conflict", message: "An account with this email already exists" }, 409);
      throw err;
    }

    // Product behavior remains explicit: signup returns a product session before email
    // verification; verification gates the configured signup-credit grant, not all product use.
    // This is the existing migration 0055 contract and avoids silently changing signup policy.
    const session = await createProductSession(env, productId, endUserId, resolved.product.tenant_id, "naelao-native", 0);
    if (!session) return c.json({ error_code: "session_unavailable", message: "Sign-up could not finish. Please try again." }, 503);

    try {
      await issueVerificationToken(env, productId, endUserId, resolved.product.tenant_id, email, resolved.product.product_slug);
    } catch { /* account/session creation remains usable if mail delivery is temporarily unavailable */ }

    return c.json({ end_user_id: endUserId, session_token: session.session_token, expires_at: session.expires_at, email_verification_required: true }, 201);
  });

  app.post("/spaces/:spaceId/end-users/login", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const resolved = await loadProductAuthConfig(env, productId);
    if (!resolved) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    if (resolved.authConfig?.provider !== "naelao-native") {
      return c.json({ error_code: "unsupported_provider", message: `This product uses ${resolved.authConfig?.provider ?? "an external"} sign-in, not email/password` }, 400);
    }

    const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({} as { email?: string; password?: string }));
    if (typeof body.email !== "string" || typeof body.password !== "string" || new TextEncoder().encode(body.password).byteLength > 4096) {
      return c.json({ error_code: "bad_request", message: "email and password are required" }, 400);
    }
    const email = body.email.trim().toLowerCase();
    if (!isValidEmail(email)) return c.json({ error_code: "bad_request", message: "Incorrect email or password" }, 401);

    const row = await env.PLATFORM_DB.prepare(
      "SELECT end_user_id, password_hash, suspended_at, deleted_at, security_generation FROM product_end_users WHERE product_space_id = ? AND email = ?"
    ).bind(productId, email).first<{ end_user_id: string; password_hash: string | null; suspended_at: string | null; deleted_at: string | null; security_generation: number }>();
    // Constant-shape response whether the email doesn't exist or the password is wrong — never
    // reveal which one it was.
    let storedPassword = DUMMY_PASSWORD_HASH;
    if (row?.password_hash) {
      try {
        const parsed = JSON.parse(row.password_hash) as HashedPassword;
        if (parsed?.algorithm === "pbkdf2-sha256-100k" && parsed.iterations === 100_000 &&
            /^[0-9a-f]{64}$/i.test(parsed.salt) && /^[0-9a-f]{64}$/i.test(parsed.hash)) storedPassword = parsed;
      } catch { /* use the same-cost dummy verification for corrupt records */ }
    }
    // Do one PBKDF2 verification for missing, malformed, suspended, and normal accounts so the
    // public login endpoint does not reveal roster membership through a cheap timing branch.
    const ok = await verifyPassword(body.password, storedPassword);
    if (!row || !row.password_hash || !ok || row.suspended_at || row.deleted_at) {
      return c.json({ error_code: "invalid_credentials", message: "Incorrect email or password" }, 401);
    }

    await env.PLATFORM_DB.prepare(
      "UPDATE product_end_users SET last_seen_at = datetime('now') WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(productId, row.end_user_id).run();

    const session = await createProductSession(env, productId, row.end_user_id, resolved.product.tenant_id, "naelao-native", row.security_generation);
    if (!session) return c.json({ error_code: "invalid_credentials", message: "Incorrect email or password" }, 401);

    return c.json({ end_user_id: row.end_user_id, session_token: session.session_token, expires_at: session.expires_at });
  });

  // Product logout is global for the account: advancing the authoritative generation makes
  // every copied token fail immediately, while the outbox retries physical DO cleanup.
  app.post("/spaces/:spaceId/end-users/logout", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const body = await c.req.json<{ end_user_id?: string; session_token?: string }>().catch(() => ({} as { end_user_id?: string; session_token?: string }));
    if (!body.end_user_id || body.end_user_id.length > 256 || typeof body.session_token !== "string" || body.session_token.length < 32 || body.session_token.length > 256) {
      return c.body(null, 204);
    }
    const resolved = await loadProductAuthConfig(env, productId);
    if (!resolved) return c.body(null, 204);
    const account = await env.PLATFORM_DB.prepare(
      `SELECT security_generation FROM product_end_users
        WHERE product_space_id = ? AND end_user_id = ? AND suspended_at IS NULL AND deleted_at IS NULL`
    ).bind(productId, body.end_user_id).first<{ security_generation: number }>();
    if (!account) return c.body(null, 204);
    const stub = await productUserDoStub(env, productId, body.end_user_id, resolved.product.tenant_id);
    const verifiedResponse = await stub.fetch(new Request("http://do/sessions/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_token: body.session_token, security_generation: account.security_generation }),
    }));
    if (!verifiedResponse.ok || !(await verifiedResponse.json<{ valid?: boolean }>()).valid) return c.body(null, 204);

    await env.PLATFORM_DB.prepare(
      `UPDATE product_end_users SET security_generation = security_generation + 1
        WHERE product_space_id = ? AND end_user_id = ? AND security_generation = ?
          AND suspended_at IS NULL AND deleted_at IS NULL`
    ).bind(productId, body.end_user_id, account.security_generation).run();
    // Migration 0227's generation trigger journals cleanup atomically with this update.
    return c.body(null, 204);
  });

  // Passwordless WhatsApp login. The request response is deliberately constant so it cannot be
  // used to enumerate existing phone numbers. A new phone gets a prospective product-user id and
  // is only inserted into the roster after possession is proven by the OTP or magic token.
  app.post("/spaces/:spaceId/end-users/request-whatsapp-login", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const resolved = await loadProductAuthConfig(env, productId);
    if (!resolved) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    if (resolved.authConfig?.provider !== "naelao-native") {
      return c.json({ error_code: "unsupported_provider", message: `This product uses ${resolved.authConfig?.provider ?? "an external"} sign-in` }, 400);
    }
    const body = await c.req.json<{ phone?: string }>().catch(() => ({} as { phone?: string }));
    const phone = normalizeE164(body.phone ?? "");
    if (!phone) return c.json({ error_code: "bad_request", message: "Enter a valid international phone number, including + and country code" }, 400);
    const generic = { ok: true, message: "If WhatsApp delivery is available, a sign-in code and link are on the way." };

    const existing = await env.PLATFORM_DB.prepare(
      `SELECT end_user_id, suspended_at FROM product_end_users
       WHERE product_space_id = ? AND phone_e164 = ? AND deleted_at IS NULL`
    ).bind(productId, phone).first<{ end_user_id: string; suspended_at: string | null }>();
    if (existing?.suspended_at) return c.json(generic);

    const challengeId = crypto.randomUUID();
    const endUserId = existing?.end_user_id ?? crypto.randomUUID();
    const otp = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
    const magicToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const [otpHash, magicHash] = await Promise.all([
      whatsappChallengeDigest(env, "otp", `${challengeId}:${otp}`),
      whatsappChallengeDigest(env, "magic", magicToken),
    ]);
    const expiresAt = new Date(Date.now() + WHATSAPP_CHALLENGE_TTL_MS).toISOString();
    const magicUrl = env.PRODUCT_SHELL_URL && resolved.product.product_slug
      ? `${env.PRODUCT_SHELL_URL}/p/${resolved.product.product_slug}/login?wa_token=${encodeURIComponent(magicToken)}`
      : null;
    const text = `Your ${resolved.product.product_slug ?? "Naelao"} sign-in code is ${otp}. It expires in 10 minutes.${magicUrl ? `\n\nSign in: ${magicUrl}` : ""}`;

    const challengeInsert = await env.PLATFORM_DB.prepare(
      `INSERT INTO whatsapp_auth_challenges
       (id, product_space_id, end_user_id, phone_e164, otp_hash, magic_hash, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM whatsapp_auth_challenges
              WHERE product_space_id = ? AND phone_e164 = ? AND created_at > datetime('now', '-10 minutes')) < 3`
    ).bind(challengeId, productId, endUserId, phone, otpHash, magicHash, expiresAt, productId, phone).run();
    // Keep the request cap in the same atomic SQLite statement as the insert. A prior separate
    // COUNT then INSERT allowed many simultaneous requests to all observe the same count < 3.
    if ((challengeInsert.meta.changes ?? 0) !== 1) return c.json(generic);
    try {
      if (!(await sendWhatsApp(env, productId, phone, text))) {
        await env.PLATFORM_DB.prepare("DELETE FROM whatsapp_auth_challenges WHERE id = ?").bind(challengeId).run();
      }
    } catch {
      await env.PLATFORM_DB.prepare("DELETE FROM whatsapp_auth_challenges WHERE id = ?").bind(challengeId).run();
    }
    return c.json(generic);
  });

  app.post("/spaces/:spaceId/end-users/verify-whatsapp-login", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const resolved = await loadProductAuthConfig(env, productId);
    if (!resolved) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
    const body = await c.req.json<{ phone?: string; code?: string; token?: string }>().catch(() => ({} as { phone?: string; code?: string; token?: string }));
    const phone = body.phone ? normalizeE164(body.phone) : null;
    let row: { id: string; end_user_id: string; phone_e164: string; otp_hash: string; attempts: number } | null = null;
    if (body.token) {
      row = await env.PLATFORM_DB.prepare(
        `SELECT id, end_user_id, phone_e164, otp_hash, attempts FROM whatsapp_auth_challenges
         WHERE product_space_id = ? AND magic_hash = ? AND used_at IS NULL AND julianday(expires_at) > julianday('now')`
      ).bind(productId, await whatsappChallengeDigest(env, "magic", body.token)).first<{ id: string; end_user_id: string; phone_e164: string; otp_hash: string; attempts: number }>();
    } else if (phone && /^\d{6}$/.test(body.code ?? "")) {
      row = await env.PLATFORM_DB.prepare(
        `SELECT id, end_user_id, phone_e164, otp_hash, attempts FROM whatsapp_auth_challenges
         WHERE product_space_id = ? AND phone_e164 = ? AND used_at IS NULL AND julianday(expires_at) > julianday('now')
         ORDER BY created_at DESC LIMIT 1`
      ).bind(productId, phone).first<{ id: string; end_user_id: string; phone_e164: string; otp_hash: string; attempts: number }>();
      if (row && !(await verifyHmac(`whatsapp-auth:otp:${row.id}:${body.code}`, row.otp_hash, env.PLATFORM_SECRET))) {
        await env.PLATFORM_DB.prepare(
          "UPDATE whatsapp_auth_challenges SET attempts = attempts + 1 WHERE id = ? AND attempts < ?"
        ).bind(row.id, WHATSAPP_MAX_ATTEMPTS).run();
        row = null;
      }
    }
    if (!row || row.attempts >= WHATSAPP_MAX_ATTEMPTS) {
      return c.json({ error_code: "invalid_challenge", message: "That code or link is invalid or has expired" }, 400);
    }

    const consumed = await env.PLATFORM_DB.prepare(
      "UPDATE whatsapp_auth_challenges SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL AND julianday(expires_at) > julianday('now')"
    ).bind(row.id).run();
    if ((consumed.meta.changes ?? 0) !== 1) {
      return c.json({ error_code: "invalid_challenge", message: "That code or link is invalid or has expired" }, 400);
    }
    await env.PLATFORM_DB.prepare(
      `INSERT INTO product_end_users
       (product_space_id, end_user_id, phone_e164, phone_verified_at, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
       ON CONFLICT(product_space_id, end_user_id) DO UPDATE SET
         phone_e164 = excluded.phone_e164,
         phone_verified_at = COALESCE(product_end_users.phone_verified_at, datetime('now')),
         last_seen_at = datetime('now')`
    ).bind(productId, row.end_user_id, row.phone_e164).run();

    const account = await env.PLATFORM_DB.prepare(
      "SELECT security_generation FROM product_end_users WHERE product_space_id = ? AND end_user_id = ? AND suspended_at IS NULL AND deleted_at IS NULL"
    ).bind(productId, row.end_user_id).first<{ security_generation: number }>();
    if (!account) return c.json({ error_code: "invalid_challenge", message: "That code or link is invalid or has expired" }, 400);
    const session = await createProductSession(env, productId, row.end_user_id, resolved.product.tenant_id, "whatsapp", account.security_generation);
    if (!session) return c.json({ error_code: "session_unavailable", message: "Sign-in could not finish. Please try again." }, 503);
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

    const body = await c.req.json<{ email?: string }>().catch(() => ({} as { email?: string }));
    const email = (typeof body.email === "string" ? body.email : "").trim().toLowerCase();
    const ALWAYS_OK = c.json({ ok: true, message: "If an account with that email exists, a reset link has been sent." });
    if (!email) return ALWAYS_OK;

    const row = await env.PLATFORM_DB.prepare(
      "SELECT end_user_id FROM product_end_users WHERE product_space_id = ? AND email = ? AND password_hash IS NOT NULL AND deleted_at IS NULL"
    ).bind(productId, email).first<{ end_user_id: string }>();
    if (!row) return ALWAYS_OK; // never reveal whether the email exists

    const token = crypto.randomUUID() + crypto.randomUUID();
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    const tokenId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    try {
      const encryptedPayload = await encryptedEmailPayload(env, token, email);
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare(
          `UPDATE password_reset_tokens SET used_at = datetime('now')
            WHERE product_space_id = ? AND end_user_id = ? AND used_at IS NULL`
        ).bind(productId, row.end_user_id),
        env.PLATFORM_DB.prepare(
          `UPDATE product_auth_email_outbox SET status = 'cancelled', updated_at = datetime('now'),
             lease_token = NULL, lease_until = NULL, last_error_code = NULL
            WHERE product_space_id = ? AND end_user_id = ? AND message_kind = 'password_reset'
              AND status IN ('pending', 'sending')`
        ).bind(productId, row.end_user_id),
        env.PLATFORM_DB.prepare(
          `INSERT INTO password_reset_tokens (id, product_space_id, end_user_id, token_hash, expires_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(tokenId, productId, row.end_user_id, tokenHash, expiresAt),
        env.PLATFORM_DB.prepare(
          `INSERT INTO product_auth_email_outbox
            (operation_id, tenant_id, product_space_id, end_user_id, token_id, message_kind, recipient_hash, encrypted_payload)
           VALUES (?, ?, ?, ?, ?, 'password_reset', ?, ?)`
        ).bind(operationId, resolved.product.tenant_id, productId, row.end_user_id, tokenId, await recipientHash(email), encryptedPayload),
      ]);
      try { await dispatchProductAuthEmailOutboxEntry(env.PLATFORM_DB, env, operationId); }
      catch { /* a durable scheduled retry preserves the neutral public response */ }
    } catch { /* account-specific storage failures must not change the neutral public response */ }

    return ALWAYS_OK;
  });

  app.post("/spaces/:spaceId/end-users/reset-password", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const body = await c.req.json<{ token?: string; new_password?: string }>().catch(() => ({} as { token?: string; new_password?: string }));
    if (typeof body.token !== "string" || body.token.length < 32 || body.token.length > 128 ||
        typeof body.new_password !== "string" || body.new_password.length < 8 || new TextEncoder().encode(body.new_password).byteLength > 4096) {
      return c.json({ error_code: "bad_request", message: "token and a new_password (min 8 chars) are required" }, 400);
    }

    const tokenHash = await sha256Hex(body.token);
    const row = await env.PLATFORM_DB.prepare(
      `SELECT id, end_user_id, expires_at, used_at FROM password_reset_tokens
       WHERE product_space_id = ? AND token_hash = ? AND used_at IS NULL AND julianday(expires_at) > julianday('now')`
    ).bind(productId, tokenHash).first<{ id: string; end_user_id: string; expires_at: string; used_at: string | null }>();
    const expiresMs = row ? Date.parse(row.expires_at) : NaN;
    if (!row || row.used_at || !Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      return c.json({ error_code: "invalid_token", message: "This reset link is invalid or has expired" }, 400);
    }

    const hashed = await hashPassword(body.new_password);
    const consumed = await env.PLATFORM_DB.prepare(
      `UPDATE password_reset_tokens
          SET used_at = datetime('now'), pending_password_hash = ?
        WHERE id = ? AND used_at IS NULL AND julianday(expires_at) > julianday('now')
          AND EXISTS (SELECT 1 FROM product_end_users u WHERE u.product_space_id = password_reset_tokens.product_space_id
            AND u.end_user_id = password_reset_tokens.end_user_id AND u.deleted_at IS NULL)`
    ).bind(JSON.stringify(hashed), row.id).run();
    if ((consumed.meta.changes ?? 0) !== 1) {
      return c.json({ error_code: "invalid_token", message: "This reset link is invalid or has expired" }, 400);
    }
    // Migration 0227's SQLite trigger updates the password, advances security_generation and
    // inserts the durable DO cleanup operation inside this same token-consumption statement.
    // Every protected request compares the session's generation against D1, so a failed DO revoke
    // cannot preserve the old session's access.

    return c.json({ ok: true, message: "Password updated. Sign in with your new password." });
  });

  // Verify ownership of the email address with a short-lived, single-use token.
  app.post("/spaces/:spaceId/end-users/verify-email", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
    if (typeof body.token !== "string" || body.token.length < 32 || body.token.length > 128) return c.json({ error_code: "bad_request", message: "token is required" }, 400);

    const tokenHash = await sha256Hex(body.token);
    const row = await env.PLATFORM_DB.prepare(
      `SELECT id, end_user_id, expires_at, used_at FROM email_verification_tokens
       WHERE product_space_id = ? AND token_hash = ? AND used_at IS NULL AND julianday(expires_at) > julianday('now')`
    ).bind(productId, tokenHash).first<{ id: string; end_user_id: string; expires_at: string; used_at: string | null }>();
    const expiresMs = row ? Date.parse(row.expires_at) : NaN;
    if (!row || row.used_at || !Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      return c.json({ error_code: "invalid_token", message: "This verification link is invalid or has expired" }, 400);
    }

    const consumed = await env.PLATFORM_DB.prepare(
      "UPDATE email_verification_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL AND julianday(expires_at) > julianday('now')"
    ).bind(row.id).run();
    if ((consumed.meta.changes ?? 0) !== 1) {
      return c.json({ error_code: "invalid_token", message: "This verification link is invalid or has expired" }, 400);
    }
    // Migration 0227's trigger applies verified state inside the same token-consumption statement.
    return c.json({ ok: true, message: "Email verified." });
  });

  app.post("/spaces/:spaceId/end-users/resend-verification", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const productId = c.req.param("spaceId");
    const resolved = await loadProductAuthConfig(env, productId);
    if (!resolved) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

    // Live-reported bug: an empty or malformed body (no email field at all, a truncated request,
    // a bare probe with no `-d`) threw an unhandled SyntaxError here and surfaced as a raw 500 —
    // exactly the kind of response this route's own ALWAYS_OK constant-response design exists to
    // avoid leaking anything from. Defensive parse, same convention as every other body-parsing
    // route in this codebase.
    const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
    const email = (body.email ?? "").trim().toLowerCase();
    const ALWAYS_OK = c.json({ ok: true, message: "If that account exists and isn't yet verified, a new verification link has been sent." });
    if (!email) return ALWAYS_OK;

    const row = await env.PLATFORM_DB.prepare(
      "SELECT end_user_id, email_verified_at FROM product_end_users WHERE product_space_id = ? AND email = ?"
    ).bind(productId, email).first<{ end_user_id: string; email_verified_at: string | null }>();
    // Never reveal whether the account exists or is already verified — constant response.
    if (!row || row.email_verified_at) return ALWAYS_OK;

    try {
      await issueVerificationToken(env, productId, row.end_user_id, resolved.product.tenant_id, email, resolved.product.product_slug);
    } catch { /* preserve the non-enumerating public response; durable rows retry independently */ }
    return ALWAYS_OK;
  });

  app.use("/internal/product-auth-email-operations", requireInternalHmac((c) => (c as unknown as { env: ProductEndUserRoutesEnv }).env.PLATFORM_SECRET));
  app.get("/internal/product-auth-email-operations", async (c) => {
    const env = c.env as ProductEndUserRoutesEnv;
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const rawLimit = Number(c.req.query("limit") ?? 25);
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 25;
    const status = c.req.query("status");
    if (status && !["pending", "sending", "accepted", "failed", "cancelled"].includes(status)) {
      return c.json({ error_code: "invalid_status" }, 400);
    }
    const rows = await env.PLATFORM_DB.prepare(
      `SELECT operation_id, message_kind, status, attempt_count, next_attempt_at, provider_receipt_id,
              last_error_code, created_at, updated_at, accepted_at
         FROM product_auth_email_outbox
        WHERE tenant_id = ? AND (? IS NULL OR status = ?)
        ORDER BY created_at DESC, operation_id LIMIT ?`
    ).bind(tenantId, status ?? null, status ?? null, limit).all<{
      operation_id: string;
      message_kind: string;
      status: string;
      attempt_count: number;
      next_attempt_at: string;
      provider_receipt_id: string | null;
      last_error_code: string | null;
      created_at: string;
      updated_at: string;
      accepted_at: string | null;
    }>();
    return c.json({ operations: rows.results ?? [] });
  });
}
