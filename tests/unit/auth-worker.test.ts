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

function makeEnv() {
  const fakeDb = createFakeD1([USERS_MIGRATION, ORGS_MIGRATION, BILLING_MIGRATION, TOKEN_VERSION_MIGRATION, RESET_TOKENS_MIGRATION]);
  const notifyCalls: Array<{ to: string; subject: string; body: string }> = [];
  return {
    ENVIRONMENT: "test",
    JWT_SECRET: "test-jwt-secret",
    PLATFORM_SECRET: "test-platform-secret",
    PLATFORM_DB: fakeDb,
    NOTIFICATIONS_WORKER: {
      fetch: async (req: Request) => {
        const body = await req.json() as { to: string; subject: string; body: string };
        notifyCalls.push(body);
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
});

describe("password reset (launch-readiness audit follow-up: builders had no account-recovery path at all)", () => {
  function extractResetToken(calls: Array<{ body: string }>): string {
    const match = /Reset token: (\S+)/.exec(calls[calls.length - 1]!.body);
    if (!match) throw new Error("no reset token found in notify body");
    return match[1]!;
  }

  it("issues a token by email and the token resets the password", async () => {
    const env = makeEnv();
    await authWorker.fetch(req("/register", { email: "jane@acme.com", password: "hunter2222" }), env as never, execCtx);

    const reqRes = await authWorker.fetch(req("/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    expect(reqRes.status).toBe(200);
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
