import { Hono } from "hono";
import { cors, requestId, errorResponse, badRequest, unauthorized, HttpError, readBoundedRequestText, RequestBodyTooLargeError } from "@naelao/http";
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

const DUMMY_PASSWORD_HASH = JSON.stringify({
  hash: "0".repeat(64),
  salt: "00".repeat(32),
  iterations: 100_000,
} satisfies PasswordHash);
const MAX_PASSWORD_BYTES = 1024;
const MAX_RESET_TOKEN_BYTES = 128;
const MAX_AUTH_REQUEST_BYTES = 16 * 1024;

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readBoundedRequestText(request, MAX_AUTH_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw new HttpError(413, "payload_too_large", "Request body exceeds the 16 KiB limit");
    throw badRequest("Request body must be valid JSON");
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not_object");
    return value as Record<string, unknown>;
  } catch {
    throw badRequest("Request body must be a JSON object");
  }
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
    if (
      !stored ||
      typeof stored.hash !== "string" || !/^[0-9a-f]{64}$/i.test(stored.hash) ||
      typeof stored.salt !== "string" || !/^[0-9a-f]{64}$/i.test(stored.salt) ||
      !Number.isSafeInteger(stored.iterations) || stored.iterations < 1 || stored.iterations > 100_000
    ) return false;
  } catch {
    return false;
  }

  const saltBytes = new Uint8Array(
    (stored.salt.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))
  );
  const enc = new TextEncoder();

  let derived: ArrayBuffer;
  try {
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
    );
    derived = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: stored.iterations },
      keyMaterial,
      256
    );
  } catch {
    return false;
  }

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

async function sendResetEmail(env: AuthEnv, tenantId: string, to: string, token: string): Promise<void> {
  if (!env.NOTIFICATIONS_WORKER) return;
  const link = env.BUILDER_DASHBOARD_URL
    ? `\n\nOr click this link: ${env.BUILDER_DASHBOARD_URL}/reset-password?token=${token}`
    : "";
  try {
    await env.NOTIFICATIONS_WORKER.fetch(new Request("http://notifications-worker/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId },
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
  const body = await readJsonObject(c.req.raw);
  if (typeof body.email !== "string" || typeof body.password !== "string" || !body.email.trim() || !body.password) throw badRequest("email and password required");
  const submittedEmail = body.email.trim();
  const normalizedEmail = submittedEmail.toLowerCase();
  if (new TextEncoder().encode(body.password).byteLength > MAX_PASSWORD_BYTES) throw badRequest("password exceeds the 1 KiB limit");

  const db = c.env.PLATFORM_DB;

  const matchingUsers = await db
    .prepare(
      `SELECT u.id, u.email, u.password_hash, u.status, u.org_id,
              u.token_version, m.role, s.plan_tier
       FROM users u
       JOIN org_members m ON m.user_id = u.id AND m.org_id = u.org_id
       JOIN subscriptions s ON s.org_id = u.org_id AND s.status = 'active'
       WHERE lower(u.email) = ?1
       ORDER BY CASE WHEN u.email = ?2 THEN 0 ELSE 1 END LIMIT 2`
    )
    .bind(normalizedEmail, submittedEmail)
    .all<{
      id: string;
      email: string;
      password_hash: string;
      status: string;
      org_id: string;
      token_version: number;
      role: string;
      plan_tier: string;
    }>();
  const user = matchingUsers.results.find((candidate) => candidate.email === submittedEmail)
    ?? (matchingUsers.results.length === 1 ? matchingUsers.results[0] : undefined);

  // Keep unknown, inactive, and wrong-password paths at the same expensive verification and
  // response shape so login cannot be used to enumerate account status by text or timing.
  const passwordMatch = await verifyPassword(body.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || user.status !== "active" || !passwordMatch) throw unauthorized("Invalid email or password");

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
  const body = await readJsonObject(c.req.raw);
  if (typeof body.email !== "string" || typeof body.password !== "string" || !body.email.trim() || !body.password) throw badRequest("email and password required");
  const email = body.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("email address is invalid");
  if (body.org_name !== undefined && (typeof body.org_name !== "string" || body.org_name.trim().length > 120)) throw badRequest("org_name must be a string of at most 120 characters");
  if (body.password.length < 8) throw badRequest("password must be at least 8 characters");
  if (new TextEncoder().encode(body.password).byteLength > MAX_PASSWORD_BYTES) throw badRequest("password exceeds the 1 KiB limit");

  const db = c.env.PLATFORM_DB;

  // Check existing
  const existing = await db
    .prepare(`SELECT id FROM users WHERE lower(email) = ?1 LIMIT 1`)
    .bind(email)
    .first();
  if (existing) throw badRequest("Email already registered");

  // G-B02: PBKDF2 password hashing
  const passwordHash = await hashPassword(body.password);

  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const orgName = typeof body.org_name === "string" && body.org_name.trim() ? body.org_name.trim() : email.split("@")[0] ?? "My Org";
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
      .bind(userId, email, passwordHash, orgId),
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
      email,
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
        user: { id: userId, email, role: "owner", plan_tier: "free" },
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
  let body: Record<string, unknown>;
  try { body = await readJsonObject(c.req.raw); } catch { body = {}; }
  const submittedEmail = (typeof body.email === "string" ? body.email : "").trim();
  const email = submittedEmail.toLowerCase();
  const ALWAYS_OK = c.json({ ok: true, message: "If an account with that email exists, a reset link has been sent." });
  if (!email) return ALWAYS_OK;

  const matches = await c.env.PLATFORM_DB.prepare(
    `SELECT id, org_id, email FROM users WHERE lower(email) = ?1 AND status = 'active'
     ORDER BY CASE WHEN email = ?2 THEN 0 ELSE 1 END LIMIT 2`
  ).bind(email, submittedEmail).all<{ id: string; org_id: string; email: string }>();
  const user = matches.results.find((candidate) => candidate.email === submittedEmail)
    ?? (matches.results.length === 1 ? matches.results[0] : undefined);
  if (!user) return ALWAYS_OK;

  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare(
      "DELETE FROM builder_password_reset_tokens WHERE user_id = ?1 AND used_at IS NULL"
    ).bind(user.id),
    c.env.PLATFORM_DB.prepare(
      `INSERT INTO builder_password_reset_tokens (id, user_id, token_hash, expires_at)
       VALUES (?1, ?2, ?3, ?4)`
    ).bind(crypto.randomUUID(), user.id, tokenHash, expiresAt),
  ]);

  await sendResetEmail(c.env, user.org_id, user.email, token);
  return ALWAYS_OK;
});

// ── POST /reset-password ─────────────────────────────────────────────────────
// Bumps token_version alongside the password change — same "a password change invalidates every
// existing session, not just future logins" precedent as /revoke, since a lost/compromised
// password is exactly the scenario an attacker may already hold a live token for.
app.post("/reset-password", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (typeof body.token !== "string" || typeof body.new_password !== "string" || !body.token || !body.new_password || body.new_password.length < 8) {
    throw badRequest("token and a new_password (min 8 characters) are required");
  }
  if (new TextEncoder().encode(body.new_password).byteLength > MAX_PASSWORD_BYTES) throw badRequest("password exceeds the 1 KiB limit");
  if (new TextEncoder().encode(body.token).byteLength > MAX_RESET_TOKEN_BYTES) throw badRequest("reset token is invalid or too large");

  const tokenHash = await sha256Hex(body.token);
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT id, user_id, expires_at, used_at FROM builder_password_reset_tokens WHERE token_hash = ?1`
  ).bind(tokenHash).first<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    throw badRequest("This reset link is invalid or has expired");
  }

  const passwordHash = await hashPassword(body.new_password);
  // Hashing is asynchronous, so two requests can both observe the token as unused above. Claim
  // it and update the password in one serialized D1 batch; a per-attempt marker makes the user
  // update conditional on THIS request winning the claim.
  const claimMarker = `${new Date().toISOString()}:${crypto.randomUUID()}`;
  const results = await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare(
      `UPDATE builder_password_reset_tokens SET used_at = ?1
       WHERE id = ?2 AND used_at IS NULL AND expires_at > ?3`
    ).bind(claimMarker, row.id, new Date().toISOString()),
    c.env.PLATFORM_DB.prepare(
      `UPDATE users SET password_hash = ?1, token_version = token_version + 1
       WHERE id = ?2 AND EXISTS (
         SELECT 1 FROM builder_password_reset_tokens WHERE id = ?3 AND used_at = ?4
       )`
    ).bind(passwordHash, row.user_id, row.id, claimMarker),
    c.env.PLATFORM_DB.prepare(
      `UPDATE builder_password_reset_tokens SET used_at = ?1
       WHERE user_id = ?2 AND id != ?3 AND used_at IS NULL AND EXISTS (
         SELECT 1 FROM builder_password_reset_tokens WHERE id = ?3 AND used_at = ?1
       )`
    ).bind(claimMarker, row.user_id, row.id),
  ]);
  if (!results[0] || results[0].meta.changes === 0 || !results[1] || results[1].meta.changes === 0) {
    throw badRequest("This reset link is invalid or has expired");
  }

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
    const user = await c.env.PLATFORM_DB.prepare(
      "SELECT token_version FROM users WHERE id = ?1"
    ).bind(claims.sub).first<{ token_version: number }>();
    if (!user || (claims.tv ?? 0) !== user.token_version) {
      throw new AuthError("invalid_token", "JWT has been revoked");
    }
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
