import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import authWorker from "../../workers/auth/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Launch-readiness audit follow-up: workers/auth (login/register/password-reset — the builder's
// OWN account, not an end user's) had ZERO test coverage of any kind before this file. Loading
// the REAL migration files (not a hand-rolled schema string) is what actually caught three real,
// previously-undetected bugs in /register: `orgs` INSERT referenced a nonexistent `updated_at`
// column and omitted the required NOT NULL `owner_id`; `users` INSERT also referenced a
// nonexistent `updated_at`; `org_members` INSERT referenced a nonexistent `created_at` column
// (its real columns are `invited_at`/`joined_at`). None of this was catchable before because the
// shared fake-D1 stub didn't even implement `.batch()` (which /register uses) — every existing
// test in the whole suite avoided exercising batch()-based code entirely. Fixed both the stub
// (real .batch() now runs in an actual transaction) and the three column-name bugs themselves.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const USERS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0001_users.sql"), "utf8");
const ORGS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0002_orgs.sql"), "utf8");
const BILLING_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0004_billing.sql"), "utf8");
const TOKEN_VERSION_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0030_token_version.sql"), "utf8");
const RESET_TOKENS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0057_builder_password_reset_tokens.sql"), "utf8");
const RESET_TOKEN_EXPIRY_INDEX_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0123_builder_reset_token_expiry_index.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([USERS_MIGRATION, ORGS_MIGRATION, BILLING_MIGRATION, TOKEN_VERSION_MIGRATION, RESET_TOKENS_MIGRATION, RESET_TOKEN_EXPIRY_INDEX_MIGRATION]);
  const notifyCalls: Array<{ to: string; subject: string; body: string; tenantId: string | null }> = [];
  return {
    ENVIRONMENT: "test",
    JWT_SECRET: "test-jwt-secret",
    PLATFORM_SECRET: "test-platform-secret",
    PLATFORM_DB: fakeDb,
    NOTIFICATIONS_WORKER: {
      fetch: async (req: Request) => {
        const body = await req.json() as { to: string; subject: string; body: string };
        notifyCalls.push({ ...body, tenantId: req.headers.get("x-naelao-tenant-id") });
        return new Response(JSON.stringify({ delivered: true }), { status: 200 });
      },
    },
    __notifyCalls: notifyCalls,
    __db: fakeDb,
  };
}

function req(path: string, body: unknown, method = "POST"): Request {
  return new Request(`https://auth.naelao.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /register — builder signup", () => {
  it("creates a real account against the ACTUAL migration schema (regression: this used to fail with 'no such column')", async () => {
    const env = makeEnv();
    const res = await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { token: string; user: { id: string; email: string; role: string } } };
    expect(body.data.user.email).toBe("jane@acme.com");
    expect(body.data.user.role).toBe("owner");
    expect(body.data.token).toBeTruthy();
  });

  it("sets the org's owner_id to the new user (was previously omitted, which violates a NOT NULL constraint against the real schema)", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    const org = await env.__db.prepare("SELECT owner_id FROM orgs LIMIT 1").first<{ owner_id: string }>();
    const user = await env.__db.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
    expect(org?.owner_id).toBe(user?.id);
  });

  it("registers the creator as an org_members row with joined_at set (not the nonexistent created_at column)", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    const member = await env.__db.prepare("SELECT role, joined_at FROM org_members LIMIT 1").first<{ role: string; joined_at: string | null }>();
    expect(member?.role).toBe("owner");
    expect(member?.joined_at).toBeTruthy();
  });

  it("rejects a duplicate email", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    const res = await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("rejects a short password", async () => {
    const env = makeEnv();
    const res = await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "short" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("rejects passwords over the byte ceiling before password hashing or storage", async () => {
    const env = makeEnv();
    const response = await authWorker.fetch(req("/register", { email: "large@acme.com", password: "x".repeat(1025) }), env as never, execCtx);
    expect(response.status).toBe(400);
    expect(await env.__db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("rejects malformed and oversized JSON before touching D1", async () => {
    const env = makeEnv();
    const malformed = await authWorker.fetch(new Request("https://auth.naelao.com/register", { method: "POST", headers: { "content-type": "application/json" }, body: "null" }), env as never, execCtx);
    const oversized = await authWorker.fetch(req("/register", { email: "large@acme.com", password: "hunter2222", org_name: "x".repeat(17_000) }), env as never, execCtx);
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(await env.__db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("normalizes email casing at registration so sign-in and recovery agree", async () => {
    const env = makeEnv();
    const response = await authWorker.fetch(req("/register", { email: "Jane@Acme.com", password: "hunter2222" }), env as never, execCtx);
    expect(response.status).toBe(201);
    const stored = await env.__db.prepare("SELECT email FROM users LIMIT 1").first<{ email: string }>();
    expect(stored?.email).toBe("jane@acme.com");
    const login = await authWorker.fetch(req("/login", { email: "JANE@ACME.COM", password: "hunter2222" }), env as never, execCtx);
    expect(login.status).toBe(200);
  });
});

describe("POST /login — builder sign-in", () => {
  async function registerAndLogin(env: ReturnType<typeof makeEnv>, email: string, password: string) {
    await authWorker.fetch(req("/register", { email, password }), env as never, execCtx);
    return authWorker.fetch(req("/login", { email, password }), env as never, execCtx);
  }

  it("logs in with the correct password", async () => {
    const env = makeEnv();
    const res = await registerAndLogin(env, "jane@acme.com", "hunter2222");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { token: string; user: { email: string } } };
    expect(body.data.user.email).toBe("jane@acme.com");
  });

  it("rejects a wrong password", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    const res = await authWorker.fetch(req("/login", { email: "jane@acme.com", password: "wrong-password" }), env as never, execCtx);
    expect(res.status).toBe(401);
  });

  it("rejects a nonexistent email", async () => {
    const env = makeEnv();
    const res = await authWorker.fetch(req("/login", { email: "nobody@acme.com", password: "whatever1" }), env as never, execCtx);
    expect(res.status).toBe(401);
  });

  it("does not reveal whether an email belongs to an inactive account", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "inactive@acme.com", password: "hunter2222" }), env as never, execCtx);
    await env.__db.prepare("UPDATE users SET status = 'suspended' WHERE email = ?").bind("inactive@acme.com").run();

    const inactive = await authWorker.fetch(req("/login", { email: "inactive@acme.com", password: "wrong-password" }), env as never, execCtx);
    const unknown = await authWorker.fetch(req("/login", { email: "unknown@acme.com", password: "wrong-password" }), env as never, execCtx);
    expect(inactive.status).toBe(401);
    const inactiveError = await inactive.json() as { error_code: string; message: string };
    const unknownError = await unknown.json() as { error_code: string; message: string };
    expect(inactiveError).toMatchObject({ error_code: "unauthorized", message: "Invalid email or password" });
    expect(unknownError).toMatchObject({ error_code: inactiveError.error_code, message: inactiveError.message });
  });

  it("rejects oversized login passwords before querying the database", async () => {
    const env = makeEnv();
    const response = await authWorker.fetch(req("/login", { email: "x@example.com", password: "x".repeat(1025) }), env as never, execCtx);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: "password exceeds the 1 KiB limit" });
  });

  it("treats malformed stored password hashes as invalid credentials instead of throwing", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "bad-hash@acme.com", password: "hunter2222" }), env as never, execCtx);
    await env.__db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").bind('{"hash":"x","salt":"x","iterations":999999999999}', "bad-hash@acme.com").run();
    const response = await authWorker.fetch(req("/login", { email: "bad-hash@acme.com", password: "hunter2222" }), env as never, execCtx);
    expect(response.status).toBe(401);
  });
});

describe("password reset (launch-readiness audit follow-up: builders had no account-recovery path at all)", () => {
  function extractResetToken(calls: Array<{ body: string }>): string {
    const match = /Reset token: (\S+)/.exec(calls[calls.length - 1]!.body);
    if (!match) throw new Error("no reset token found in notify body");
    return match[1]!;
  }

  it("installs the indexed expiry path used by the daily token-retention sweep", async () => {
    const env = makeEnv();
    const index = await env.__db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_builder_password_reset_tokens_expiry'"
    ).first<{ name: string }>();
    expect(index?.name).toBe("idx_builder_password_reset_tokens_expiry");
  });

  it("issues a token by email and the token resets the password", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);

    const reqRes = await authWorker.fetch(req("/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    expect(reqRes.status).toBe(200);
    const user = await env.__db.prepare("SELECT org_id FROM users WHERE email = 'jane@acme.com'").first<{ org_id: string }>();
    expect(env.__notifyCalls[0]?.tenantId).toBe(user?.org_id);
    const token = extractResetToken(env.__notifyCalls);

    const resetRes = await authWorker.fetch(req("/reset-password", { token, new_password: "newpassword1" }), env as never, execCtx);
    expect(resetRes.status).toBe(200);

    // Old password no longer works; new one does.
    const oldLogin = await authWorker.fetch(req("/login", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    expect(oldLogin.status).toBe(401);
    const newLogin = await authWorker.fetch(req("/login", { email: "jane@acme.com", password: "newpassword1" }), env as never, execCtx);
    expect(newLogin.status).toBe(200);
  });

  it("bumps token_version on reset — invalidating any existing session, not just future logins", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    const before = await env.__db.prepare("SELECT token_version FROM users WHERE email = 'jane@acme.com'").first<{ token_version: number }>();

    await authWorker.fetch(req("/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    const token = extractResetToken(env.__notifyCalls);
    await authWorker.fetch(req("/reset-password", { token, new_password: "newpassword1" }), env as never, execCtx);

    const after = await env.__db.prepare("SELECT token_version FROM users WHERE email = 'jane@acme.com'").first<{ token_version: number }>();
    expect(after!.token_version).toBe((before?.token_version ?? 0) + 1);
  });

  it("never reveals whether the email exists — same response either way", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    const realRes = await authWorker.fetch(req("/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    const fakeRes = await authWorker.fetch(req("/request-password-reset", { email: "nobody@acme.com" }), env as never, execCtx);
    expect(realRes.status).toBe(fakeRes.status);
    expect(await realRes.json()).toEqual(await fakeRes.json());
    // Only the real account actually got an email.
    expect(env.__notifyCalls).toHaveLength(1);
  });

  it("a token can only be used once", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    await authWorker.fetch(req("/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    const token = extractResetToken(env.__notifyCalls);

    const first = await authWorker.fetch(req("/reset-password", { token, new_password: "newpassword1" }), env as never, execCtx);
    expect(first.status).toBe(200);
    const second = await authWorker.fetch(req("/reset-password", { token, new_password: "anotherpass1" }), env as never, execCtx);
    expect(second.status).toBe(400);
  });

  it("allows only one concurrent reset request to claim and apply a reset token", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    await authWorker.fetch(req("/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    const token = extractResetToken(env.__notifyCalls);

    // D1 serializes batches. Both requests can pass the initial read and perform PBKDF2 before
    // either batch starts, so queue the actual SQLite transactions as the deployed service does.
    const database = env.__db;
    const realBatch = database.batch.bind(database);
    let pending = Promise.resolve();
    database.batch = (statements) => {
      const result = pending.then(() => realBatch(statements));
      pending = result.then(() => undefined, () => undefined);
      return result;
    };

    const [first, second] = await Promise.all([
      authWorker.fetch(req("/reset-password", { token, new_password: "newpassword1" }), env as never, execCtx),
      authWorker.fetch(req("/reset-password", { token, new_password: "anotherpass1" }), env as never, execCtx),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    const version = await database.prepare("SELECT token_version FROM users WHERE email = 'jane@acme.com'").first<{ token_version: number }>();
    expect(version?.token_version).toBe(1);
  });

  it("rejects a garbage token", async () => {
    const env = makeEnv();
    const res = await authWorker.fetch(req("/reset-password", { token: "not-a-real-token", new_password: "newpassword1" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("rejects a short new_password", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    await authWorker.fetch(req("/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    const token = extractResetToken(env.__notifyCalls);
    const res = await authWorker.fetch(req("/reset-password", { token, new_password: "short" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("rejects oversized reset passwords and tokens", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    await authWorker.fetch(req("/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    const token = extractResetToken(env.__notifyCalls);
    const largePassword = await authWorker.fetch(req("/reset-password", { token, new_password: "x".repeat(1025) }), env as never, execCtx);
    const largeToken = await authWorker.fetch(req("/reset-password", { token: "x".repeat(129), new_password: "newpassword1" }), env as never, execCtx);
    expect(largePassword.status).toBe(400);
    expect(largeToken.status).toBe(400);
  });

  it("includes a clickable reset link when BUILDER_DASHBOARD_URL is configured, and falls back to token-only text otherwise", async () => {
    const envWithUrl = { ...makeEnv(), BUILDER_DASHBOARD_URL: "https://app.naelao.com" };
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), envWithUrl as never, execCtx);
    await authWorker.fetch(req("/request-password-reset", { email: "jane@acme.com" }), envWithUrl as never, execCtx);
    expect(envWithUrl.__notifyCalls[0]!.body).toContain("https://app.naelao.com/reset-password?token=");

    const envNoUrl = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), envNoUrl as never, execCtx);
    await authWorker.fetch(req("/request-password-reset", { email: "jane@acme.com" }), envNoUrl as never, execCtx);
    expect(envNoUrl.__notifyCalls[0]!.body).not.toContain("http");
    expect(envNoUrl.__notifyCalls[0]!.body).toContain("Reset token:");
  });
});

describe("token revocation verification", () => {
  it("rejects a still-unexpired JWT after /revoke increments its token version", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    const login = await authWorker.fetch(req("/login", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);
    const { data } = await login.json() as { data: { token: string } };
    const authRequest = (path: string) => new Request(`https://auth.naelao.com${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${data.token}` },
    });

    expect((await authWorker.fetch(authRequest("/verify"), env as never, execCtx)).status).toBe(200);
    expect((await authWorker.fetch(authRequest("/revoke"), env as never, execCtx)).status).toBe(200);
    expect((await authWorker.fetch(authRequest("/verify"), env as never, execCtx)).status).toBe(401);
  });
});
