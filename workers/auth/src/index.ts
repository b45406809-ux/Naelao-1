import { Hono } from "hono";
import { cors, requestId, errorResponse, badRequest, unauthorized, notFound } from "@naelao/http";
import { signJwt, verifyJwt, AuthError } from "@naelao/auth";

export interface AuthEnv {
  ENVIRONMENT: string;
  JWT_SECRET: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
}

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

const app = new Hono<{ Bindings: AuthEnv }>();

app.use("*", cors(["*"]));
app.use("*", requestId);

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

  // Verify SHA-256 password hash (hex)
  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", enc.encode(body.password));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (hashHex !== user.password_hash) throw unauthorized("Invalid email or password");

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

  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", enc.encode(body.password));
  const passwordHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

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
