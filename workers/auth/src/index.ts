import { Hono } from "hono";
import { cors, requestId, errorResponse, badRequest, unauthorized } from "@naelao/http";
import { signJwt, verifyJwt, AuthError } from "@naelao/auth";

export interface AuthEnv {
  ENVIRONMENT: string;
  JWT_SECRET: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  NOTIFICATIONS_WORKER?: Fetcher;
  /** Public base URL of apps/dashboard, used to build a clickable password-reset link. Left
   *  unset rather than guessing a production domain — when unset, the email still carries a raw
   *  token the dashboard's reset page accepts pasted in by hand. */
  BUILDER_DASHBOARD_URL?: string;
}

// G-A11: Validate required secrets at startup
function validateEnv(env: AuthEnv): void {
  const required = ["JWT_SECRET", "PLATFORM_SECRET"] as const;
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing required secret: ${key}`);
    }
  }
}

// G-B02: PBKDF2 password helpers (100,000 iterations, SHA-256, 32-byte salt). Cloudflare
// Workers' WebCrypto PBKDF2 implementation caps iterations at 100,000 — a real deployment threw
// "NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported" at 600,000
// (confirmed via a live wrangler tail session on this exact worker; Node's crypto has no such
// cap, so this never surfaced in unit tests). verifyPassword reads the count from the stored
// hash, so this is backward-compatible with any hash stored under a different count.

interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

async function hashPassword(password: string): Promise<string> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(32));
  const iterations = 100_000;
  const enc = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    keyMaterial,
    256
  );

  const toHex = (buf: Uint8Array): string =>
    Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  const ph: PasswordHash = {
    hash: toHex(new Uint8Array(derived)),
    salt: toHex(saltBytes),
    iterations,
  };
  return JSON.stringify(ph);
}

async function verifyPassword(
  password: string,
  storedJson: string
): Promise<boolean> {
  let stored: PasswordHash;
  try {
    stored = JSON.parse(storedJson) as PasswordHash;
    if (!stored.hash || !stored.salt || !stored.iterations) return false;
  } catch {
    return false;
  }

  const saltBytes = new Uint8Array(
    (stored.salt.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))
  );
  const enc = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBytes,
      iterations: stored.iterations,
    },
    keyMaterial,
    256
  );

  const hashHex = Array.from(new Uint8Array(derived))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison to prevent timing attacks
  if (hashHex.length !== stored.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hashHex.length; i++) {
    diff |= (hashHex.charCodeAt(i) ^ stored.hash.charCodeAt(i));
  }
  return diff === 0;
}

// Launch-readiness audit follow-up: builders had no account-recovery path at all — a forgotten
// password permanently locked a builder out of their own business. Same hashed/single-use/
// expiring token pattern already used for product end users (password_reset_tokens, migration
// 0054) and business invites, scoped to the platform `users` table instead.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour, matching the end-user reset flow's window

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendResetEmail(env: AuthEnv, to: string, token: string): Promise<void> {
  if (!env.NOTIFICATIONS_WORKER) return;
  const link = env.BUILDER_DASHBOARD_URL
    ? `\n\nOr click this link: ${env.BUILDER_DASHBOARD_URL}/reset-password?token=${token}`
    : "";
  try {
    await env.NOTIFICATIONS_WORKER.fetch(new Request("http://notifications-worker/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "email",
        to,
        subject: "Reset your Naelao password",
        body: `Reset token: ${token}${link}\n\nThis token expires in 1 hour. If you didn't request this, ignore this email.`,
      }),
    }));
  } catch { /* best-effort — never blocks the caller's own (constant) response */ }
}

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

const app = new Hono<{ Bindings: AuthEnv }>();

app.use("*", cors(["*"]));
app.use("*", requestId);
app.use("*", async (c, next) => {
  validateEnv(c.env);
  await next();
});

app.get("/health", (c) => c.json({ ok: true, service: "auth", env: c.env.ENVIRONMENT }));

// ── POST /login ───────────────────────────────────────────────────────────────
app.post("/login", async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  if (!body.email || !body.password) throw badRequest("email and password required");

  const db = c.env.PLATFORM_DB;

  const user = await db
    .prepare(
      `SELECT u.id, u.email, u.password_hash, u.status, u.org_id,
              u.token_version, m.role, s.plan_tier
       FROM users u
       JOIN org_members m ON m.user_id = u.id AND m.org_id = u.org_id
       JOIN subscriptions s ON s.org_id = u.org_id AND s.status = 'active'
       WHERE u.email = ?1 LIMIT 1`
    )
    .bind(body.email)
    .first<{
      id: string;
      email: string;
      password_hash: string;
      status: string;
      org_id: string;
      token_version: number;
      role: string;
      plan_tier: string;
    }>();

  if (!user) throw unauthorized("Invalid email or password");
  if (user.status !== "active") throw unauthorized("Account is not active");

  // G-B02: Verify PBKDF2 password hash
  const passwordMatch = await verifyPassword(body.password, user.password_hash);
  if (!passwordMatch) throw unauthorized("Invalid email or password");

  // Update last_login_at
  await db
    .prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?1`)
    .bind(user.id)
    .run();

  const token = await signJwt(
    {
      sub: user.id,
      tid: user.org_id,
      email: user.email,
      role: user.role as "owner" | "admin" | "editor" | "viewer",
      scopes: ["api:access"],
      // G-AD02: Embed token version so router can verify against D1 on each request
      tv: user.token_version ?? 0,
    },
    c.env.JWT_SECRET,
    86400 // 24 hours
  );

  return c.json(
    {
      data: {
        token,
        user: { id: user.id, email: user.email, role: user.role, plan_tier: user.plan_tier },
      },
      request_id: c.get("requestId"),
    },
    200
  );
});

// ── POST /register ────────────────────────────────────────────────────────────
app.post("/register", async (c) => {
  const body = await c.req.json<{ email: string; password: string; org_name?: string }>();
  if (!body.email || !body.password) throw badRequest("email and password required");
  if (body.password.length < 8) throw badRequest("password must be at least 8 characters");

  const db = c.env.PLATFORM_DB;

  // Check existing
  const existing = await db
    .prepare(`SELECT id FROM users WHERE email = ?1 LIMIT 1`)
    .bind(body.email)
    .first();
  if (existing) throw badRequest("Email already registered");

  // G-B02: PBKDF2 password hashing
  const passwordHash = await hashPassword(body.password);

  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const orgName = body.org_name ?? body.email.split("@")[0] ?? "My Org";
  const subId = crypto.randomUUID();

  // Launch-readiness audit follow-up: this batch had THREE real, previously-undetected bugs
  // (workers/auth had zero test coverage of its own before this pass) that would have made
  // builder signup fail against a real D1 instance on every call: `orgs` has no `updated_at`
  // column and requires a NOT-NULL `owner_id` neither of which this insert supplied
  // (infra/migrations/0002_orgs.sql); `users` also has no `updated_at` column
  // (infra/migrations/0001_users.sql); `org_members` has no `created_at` column at all — its
  // columns are `invited_at`/`joined_at` (same migration 0002). Fixed to match the real schema.
  await db.batch([
    db
      .prepare(
        `INSERT INTO orgs (id, name, owner_id, status, created_at)
         VALUES (?1, ?2, ?3, 'active', datetime('now'))`
      )
      .bind(orgId, orgName, userId),
    db
      .prepare(
        `INSERT INTO users (id, email, password_hash, org_id, status, created_at)
         VALUES (?1, ?2, ?3, ?4, 'active', datetime('now'))`
      )
      .bind(userId, body.email, passwordHash, orgId),
    db
      .prepare(
        `INSERT INTO org_members (org_id, user_id, role, joined_at)
         VALUES (?1, ?2, 'owner', datetime('now'))`
      )
      .bind(orgId, userId),
    db
      .prepare(
        `INSERT INTO subscriptions (id, org_id, plan_tier, status, created_at, updated_at)
         VALUES (?1, ?2, 'free', 'active', datetime('now'), datetime('now'))`
      )
      .bind(subId, orgId),
  ]);

  const token = await signJwt(
    {
      sub: userId,
      tid: orgId,
      email: body.email,
      role: "owner",
      scopes: ["api:access"],
    },
    c.env.JWT_SECRET,
    86400
  );

  return c.json(
    {
      data: {
        token,
        user: { id: userId, email: body.email, role: "owner", plan_tier: "free" },
      },
      request_id: c.get("requestId"),
    },
    201
  );
});

// ── POST /request-password-reset ────────────────────────────────────────────
// Launch-readiness audit follow-up: never reveals whether the email exists — constant response
// either way, same contract as the product-end-user reset flow.
app.post("/request-password-reset", async (c) => {
  const body = await c.req.json<{ email: string }>().catch(() => ({}) as { email?: string });
  const email = (body.email ?? "").trim().toLowerCase();
  const ALWAYS_OK = c.json({ ok: true, message: "If an account with that email exists, a reset link has been sent." });
  if (!email) return ALWAYS_OK;

  const user = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM users WHERE email = ?1 AND status = 'active' LIMIT 1"
  ).bind(email).first<{ id: string }>();
  if (!user) return ALWAYS_OK;

  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO builder_password_reset_tokens (id, user_id, token_hash, expires_at)
     VALUES (?1, ?2, ?3, ?4)`
  ).bind(crypto.randomUUID(), user.id, tokenHash, expiresAt).run();

  await sendResetEmail(c.env, email, token);
  return ALWAYS_OK;
});

// ── POST /reset-password ─────────────────────────────────────────────────────
// Bumps token_version alongside the password change — same "a password change invalidates every
// existing session, not just future logins" precedent as /revoke, since a lost/compromised
// password is exactly the scenario an attacker may already hold a live token for.
app.post("/reset-password", async (c) => {
  const body = await c.req.json<{ token: string; new_password: string }>();
  if (!body.token || !body.new_password || body.new_password.length < 8) {
    throw badRequest("token and a new_password (min 8 characters) are required");
  }

  const tokenHash = await sha256Hex(body.token);
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT id, user_id, expires_at, used_at FROM builder_password_reset_tokens WHERE token_hash = ?1`
  ).bind(tokenHash).first<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    throw badRequest("This reset link is invalid or has expired");
  }

  const passwordHash = await hashPassword(body.new_password);
  await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare(
      "UPDATE users SET password_hash = ?1, token_version = token_version + 1 WHERE id = ?2"
    ).bind(passwordHash, row.user_id),
    c.env.PLATFORM_DB.prepare(
      "UPDATE builder_password_reset_tokens SET used_at = datetime('now') WHERE id = ?1"
    ).bind(row.id),
  ]);

  return c.json({ ok: true, message: "Password updated. Sign in with your new password." });
});

// ── POST /revoke — G-AD02: Increment token_version to revoke ALL user tokens ──
app.post("/revoke", async (c) => {
  const authHeader = c.req.header("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) throw unauthorized("Missing Authorization header");
  const token = authHeader.slice(7);
  let claims;
  try {
    claims = await verifyJwt(token, c.env.JWT_SECRET);
  } catch (err) {
    if (err instanceof AuthError) throw unauthorized(err.message);
    throw err;
  }
  await c.env.PLATFORM_DB.prepare(
    `UPDATE users SET token_version = token_version + 1 WHERE id = ?1`
  ).bind(claims.sub).run();
  return c.json({ revoked: true, request_id: c.get("requestId") });
});

// ── POST /verify ──────────────────────────────────────────────────────────────
app.post("/verify", async (c) => {
  const authHeader = c.req.header("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) throw unauthorized("Missing Authorization header");
  const token = authHeader.slice(7);
  try {
    const claims = await verifyJwt(token, c.env.JWT_SECRET);
    return c.json({ data: { valid: true, claims }, request_id: c.get("requestId") });
  } catch (err) {
    if (err instanceof AuthError) throw unauthorized(err.message);
    throw err;
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<AuthEnv>;
