import { Hono } from "hono";
import { cors, requestId, errorResponse, badRequest, unauthorized } from "@naelao/http";
import { signJwt, verifyJwt, AuthError } from "@naelao/auth";

export interface AuthEnv {
  ENVIRONMENT: string;
  JWT_SECRET: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
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

// G-B02: PBKDF2 password helpers (600,000 iterations, SHA-256, 32-byte salt)

interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

async function hashPassword(password: string): Promise<string> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(32));
  const iterations = 600_000;
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

// ── POST /login ───────────────────────────────────────────────────────────────
app.post("/login", async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  if (!body.email || !body.password) throw badRequest("email and password required");

  const db = c.env.PLATFORM_DB;

  const user = await db
    .prepare(
      `SELECT u.id, u.email, u.password_hash, u.status, u.org_id,
              m.role, s.plan_tier
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

  await db.batch([
    db
      .prepare(
        `INSERT INTO orgs (id, name, status, created_at, updated_at)
         VALUES (?1, ?2, 'active', datetime('now'), datetime('now'))`
      )
      .bind(orgId, orgName),
    db
      .prepare(
        `INSERT INTO users (id, email, password_hash, org_id, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', datetime('now'), datetime('now'))`
      )
      .bind(userId, body.email, passwordHash, orgId),
    db
      .prepare(
        `INSERT INTO org_members (org_id, user_id, role, created_at)
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
