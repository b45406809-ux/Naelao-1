import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { BuilderAccountDO } from "../../workers/spaces/src/do/BuilderAccountDO.js";
import { SpaceTypeRegistryDO } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { mintInternalToken } from "@naelao/http";

// Three-Tier Platform Model, Phase 6 (Journey 1B: "End user signs up or is invited via the
// builder's configured auth provider"). ProductUserDO (Phase 2) mints and verifies sessions but
// never verified an IDENTITY — these routes are the missing piece for authProvider:
// 'naelao-native' specifically: real email+password signup/login scoped to one product.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT, product_slug TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;
const CREDENTIALS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0046_product_end_user_credentials.sql"), "utf8");
const BUILDER_DASHBOARD_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0045_builder_dashboard_api.sql"), "utf8");
const PASSWORD_RESET_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0054_password_reset_tokens.sql"), "utf8");
const EMAIL_VERIFICATION_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0055_email_verification.sql"), "utf8");
const DELETED_AT_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0058_product_end_users_deleted_at.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUILDER_DASHBOARD_MIGRATION, CREDENTIALS_MIGRATION, PASSWORD_RESET_MIGRATION, EMAIL_VERIFICATION_MIGRATION, DELETED_AT_MIGRATION]);
  const notifyCalls: Array<{ to: string; subject: string; body: string }> = [];
  return {
    PLATFORM_SECRET: "test-platform-secret",
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    BUILDER_ACCOUNT_DO: makeStatefulDoNamespace(BuilderAccountDO),
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
    SPACE_TYPE_REGISTRY_DO: makeStatefulDoNamespace(SpaceTypeRegistryDO),
    NAELAO_CONFIG_KV: { get: async () => null, put: async () => {} },
    // Fake service binding standing in for the notifications worker — captures the reset email
    // instead of actually sending it, so the test can pull the token out.
    NOTIFICATIONS_WORKER: {
      fetch: async (req: Request) => {
        const body = await req.json() as { to: string; subject: string; body: string };
        notifyCalls.push(body);
        return new Response(JSON.stringify({ delivered: true }), { status: 200 });
      },
    },
    __notifyCalls: notifyCalls,
  };
}

async function seedProduct(env: ReturnType<typeof makeEnv>, id: string, tenantId: string, productConfig?: Record<string, unknown>, slug?: string) {
  const configJson = productConfig ? JSON.stringify({ productConfig }) : "{}";
  await env.PLATFORM_DB.prepare(
    "INSERT INTO spaces (id, tenant_id, status, name, config_json, product_slug) VALUES (?, ?, 'active', 'Acme Store', ?, ?)"
  ).bind(id, tenantId, configJson, slug ?? null).run();
}

/** Extracts the verification token from the most recent notify() call and redeems it. */
async function verifyEmail(env: ReturnType<typeof makeEnv>, productId: string): Promise<Response> {
  const call = env.__notifyCalls[env.__notifyCalls.length - 1]!;
  const match = /Verification token: (\S+)/.exec(call.body);
  if (!match) throw new Error("no verification token found in notify body");
  return spacesWorker.fetch(req(`/spaces/${productId}/end-users/verify-email`, { token: match[1] }), env as never, execCtx);
}

function req(path: string, body: unknown): Request {
  return new Request(`https://spaces.naelao.com${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /spaces/:spaceId/end-users/signup", () => {
  it("creates a real account and returns a usable session token", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(201);
    const body = await res.json() as { end_user_id: string; session_token: string };
    expect(body.session_token).toMatch(/^nps_/);
    expect(body.end_user_id).toBeTruthy();
  });

  it("rejects a duplicate signup for the same email on the same product", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "different1" }), env as never, execCtx);
    expect(res.status).toBe(409);
  });

  it("the SAME email can sign up independently on a DIFFERENT product", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await seedProduct(env, "prod-2", "tenant-2");
    const a = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    const b = await spacesWorker.fetch(req("/spaces/prod-2/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("rejects a short password", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "short" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("enforces allowedEmailDomains when configured", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1", { authProvider: { provider: "naelao-native", allowedEmailDomains: ["acme.com"] } });
    const denied = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@other.com", password: "hunter22" }), env as never, execCtx);
    expect(denied.status).toBe(403);
    const allowed = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(allowed.status).toBe(201);
  });

  it("rejects signup for a product configured with a non-native auth provider", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1", { authProvider: { provider: "clerk" } });
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("404s for a nonexistent product", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/spaces/no-such-product/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("defers creditsIncludedPerMonth until email verification (security audit: closes the free-credit-farming hole)", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1", { pricingConfig: { model: "credits", creditsIncludedPerMonth: 500 } });
    const signupRes = await spacesWorker.fetch(
      req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx
    );
    const signup = await signupRes.json() as { end_user_id: string; email_verification_required: boolean };
    expect(signup.email_verification_required).toBe(true);

    const token = await mintInternalToken("test-platform-secret", "tenant-1");
    const balanceOf = () => spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/internal/product-users/prod-1/${signup.end_user_id}/credits/balance`, {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    ).then((r) => r.json() as Promise<{ balance_credits: number }>);

    // Not granted yet — the signup credit sat behind an unverified email.
    expect((await balanceOf()).balance_credits).toBe(0);

    const verifyRes = await verifyEmail(env, "prod-1");
    expect(verifyRes.status).toBe(200);
    expect((await balanceOf()).balance_credits).toBe(500);
  });

  it("grants the platform free-tier default when pricing is unconfigured (a product with no pricingConfig at all), after verification", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const signup = await (await spacesWorker.fetch(
      req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx
    )).json() as { end_user_id: string };
    await verifyEmail(env, "prod-1");

    const token = await mintInternalToken("test-platform-secret", "tenant-1");
    const balRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/internal/product-users/prod-1/${signup.end_user_id}/credits/balance`, {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect((await balRes.json() as { balance_credits: number }).balance_credits).toBe(100);
  });

  it("grants the platform free-tier default for pricingConfig.model === 'free' too, after verification", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1", { pricingConfig: { model: "free" } });
    const signup = await (await spacesWorker.fetch(
      req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx
    )).json() as { end_user_id: string };
    await verifyEmail(env, "prod-1");

    const token = await mintInternalToken("test-platform-secret", "tenant-1");
    const balRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/internal/product-users/prod-1/${signup.end_user_id}/credits/balance`, {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect((await balRes.json() as { balance_credits: number }).balance_credits).toBe(100);
  });

  it("does NOT apply the free-tier default for an explicit paid model (credits) with no allowance configured", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1", { pricingConfig: { model: "credits" } });
    const signup = await (await spacesWorker.fetch(
      req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx
    )).json() as { end_user_id: string };

    const token = await mintInternalToken("test-platform-secret", "tenant-1");
    const balRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/internal/product-users/prod-1/${signup.end_user_id}/credits/balance`, {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect((await balRes.json() as { balance_credits: number }).balance_credits).toBe(0);
  });
});

describe("POST /spaces/:spaceId/end-users/login", () => {
  it("logs in with the correct password and returns a fresh session token", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/login", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { session_token: string };
    expect(body.session_token).toMatch(/^nps_/);
  });

  it("rejects a wrong password without revealing whether the email exists", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    const wrongPw = await spacesWorker.fetch(req("/spaces/prod-1/end-users/login", { email: "jane@acme.com", password: "wrongpass" }), env as never, execCtx);
    const noSuchEmail = await spacesWorker.fetch(req("/spaces/prod-1/end-users/login", { email: "nobody@acme.com", password: "wrongpass" }), env as never, execCtx);
    expect(wrongPw.status).toBe(401);
    expect(noSuchEmail.status).toBe(401);
    expect((await wrongPw.json() as { error_code: string }).error_code).toBe((await noSuchEmail.json() as { error_code: string }).error_code);
  });

  it("rejects login for a suspended account", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const signup = await (await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx)).json() as { end_user_id: string };
    await env.PLATFORM_DB.prepare(
      "UPDATE product_end_users SET suspended_at = datetime('now') WHERE product_space_id = ? AND end_user_id = ?"
    ).bind("prod-1", signup.end_user_id).run();
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/login", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("a session minted at login verifies against the product's internal verify endpoint", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const signup = await (await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx)).json() as { end_user_id: string; session_token: string };

    const verifyRes = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/internal/product-sessions/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-platform-secret": "test-platform-secret" },
        body: JSON.stringify({ productId: "prod-1", endUserId: signup.end_user_id, sessionToken: signup.session_token }),
      }),
      env as never, execCtx
    );
    const verified = await verifyRes.json() as { valid: boolean; tenant_id: string };
    expect(verified.valid).toBe(true);
    expect(verified.tenant_id).toBe("tenant-1");
  });
});

describe("password reset (security audit follow-up: end users had no recovery path at all)", () => {
  // Signup itself now also sends a verification-token email (email verification pass, below) for
  // any product with a signup credit allowance — prod-1's default unconfigured pricing means
  // signup produces ONE notify call before request-password-reset produces a second. Pull the
  // reset token specifically by matching "Reset token:", not by call index/count.
  function extractResetToken(calls: Array<{ body: string }>): string {
    for (const call of calls) {
      const match = /Reset token: (\S+)/.exec(call.body);
      if (match) return match[1]!;
    }
    throw new Error("no reset token found in any notify body");
  }

  it("issues a token by email and the token resets the password", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);

    const reqRes = await spacesWorker.fetch(req("/spaces/prod-1/end-users/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    expect(reqRes.status).toBe(200);
    // One verification email (signup) + one reset email (this request).
    expect(env.__notifyCalls).toHaveLength(2);
    const token = extractResetToken(env.__notifyCalls);

    const resetRes = await spacesWorker.fetch(req("/spaces/prod-1/end-users/reset-password", { token, new_password: "newhunter99" }), env as never, execCtx);
    expect(resetRes.status).toBe(200);

    const oldLogin = await spacesWorker.fetch(req("/spaces/prod-1/end-users/login", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(oldLogin.status).toBe(401);
    const newLogin = await spacesWorker.fetch(req("/spaces/prod-1/end-users/login", { email: "jane@acme.com", password: "newhunter99" }), env as never, execCtx);
    expect(newLogin.status).toBe(200);
  });

  it("never reveals whether the email exists — same response either way", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);

    const notifyCountBefore = env.__notifyCalls.length; // 1 (the verification email from signup)
    const exists = await spacesWorker.fetch(req("/spaces/prod-1/end-users/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    const doesNotExist = await spacesWorker.fetch(req("/spaces/prod-1/end-users/request-password-reset", { email: "nobody@acme.com" }), env as never, execCtx);
    expect(exists.status).toBe(doesNotExist.status);
    expect(await exists.json()).toEqual(await doesNotExist.json());
    // Only the real account's reset request actually sent a notify call.
    expect(env.__notifyCalls).toHaveLength(notifyCountBefore + 1);
  });

  it("a token can only be used once", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    const token = extractResetToken(env.__notifyCalls);

    const first = await spacesWorker.fetch(req("/spaces/prod-1/end-users/reset-password", { token, new_password: "newhunter99" }), env as never, execCtx);
    expect(first.status).toBe(200);
    const second = await spacesWorker.fetch(req("/spaces/prod-1/end-users/reset-password", { token, new_password: "anotherpass1" }), env as never, execCtx);
    expect(second.status).toBe(400);
  });

  it("rejects a garbage token", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/reset-password", { token: "not-a-real-token", new_password: "newhunter99" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("rejects a short new password", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/request-password-reset", { email: "jane@acme.com" }), env as never, execCtx);
    const token = extractResetToken(env.__notifyCalls);
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/reset-password", { token, new_password: "short" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });
});

describe("email verification (security audit follow-up: closes the free-credit-farming hole)", () => {
  function extractVerifyToken(calls: Array<{ body: string }>): string {
    for (const call of calls) {
      const match = /Verification token: (\S+)/.exec(call.body);
      if (match) return match[1]!;
    }
    throw new Error("no verification token found in any notify body");
  }

  it("signup sends a verification email when there's a signup credit allowance", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(env.__notifyCalls).toHaveLength(1);
    expect(env.__notifyCalls[0]!.subject).toBe("Verify your email");
  });

  it("does NOT send a verification email when the product has no signup allowance to protect (paid model, no allowance)", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1", { pricingConfig: { model: "credits" } });
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(env.__notifyCalls).toHaveLength(0);
  });

  it("shell UX follow-up: includes a clickable verify-email link when PRODUCT_SHELL_URL and the product's slug are both known", async () => {
    const env = { ...makeEnv(), PRODUCT_SHELL_URL: "https://app.naelao.com" };
    await seedProduct(env, "prod-1", "tenant-1", undefined, "acme-store");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(env.__notifyCalls[0]!.body).toContain("https://app.naelao.com/p/acme-store/verify-email?token=");
    // Raw token is still present too — the shell's verify-email page accepts manual entry as a
    // fallback, so a broken/misconfigured link never fully strands a legitimate user.
    expect(env.__notifyCalls[0]!.body).toContain("Verification token:");
  });

  it("falls back to token-only text (no broken link) when PRODUCT_SHELL_URL isn't configured", async () => {
    const env = makeEnv(); // no PRODUCT_SHELL_URL set
    await seedProduct(env, "prod-1", "tenant-1", undefined, "acme-store");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(env.__notifyCalls[0]!.body).not.toContain("http");
    expect(env.__notifyCalls[0]!.body).toContain("Verification token:");
  });

  it("a verification token can only be used once", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    const token = extractVerifyToken(env.__notifyCalls);

    const first = await spacesWorker.fetch(req("/spaces/prod-1/end-users/verify-email", { token }), env as never, execCtx);
    expect(first.status).toBe(200);
    const second = await spacesWorker.fetch(req("/spaces/prod-1/end-users/verify-email", { token }), env as never, execCtx);
    expect(second.status).toBe(400);
  });

  it("rejects a garbage verification token", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/verify-email", { token: "not-a-real-token" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("resend-verification issues a fresh token and never reveals account existence", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);

    const realAccount = await spacesWorker.fetch(req("/spaces/prod-1/end-users/resend-verification", { email: "jane@acme.com" }), env as never, execCtx);
    const noSuchAccount = await spacesWorker.fetch(req("/spaces/prod-1/end-users/resend-verification", { email: "nobody@acme.com" }), env as never, execCtx);
    expect(realAccount.status).toBe(noSuchAccount.status);
    expect(await realAccount.json()).toEqual(await noSuchAccount.json());
    // signup's verification email + this resend's fresh one = 2; the nonexistent account sent none.
    expect(env.__notifyCalls).toHaveLength(2);
  });

  it("resend-verification is a no-op (but still returns the same response) for an already-verified account", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    const token = extractVerifyToken(env.__notifyCalls);
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/verify-email", { token }), env as never, execCtx);

    const callsBefore = env.__notifyCalls.length;
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/resend-verification", { email: "jane@acme.com" }), env as never, execCtx);
    expect(res.status).toBe(200);
    expect(env.__notifyCalls).toHaveLength(callsBefore); // no new email sent
  });

  // Live-reported bug: a real request with an empty/malformed body (no `-d` at all) threw an
  // unhandled `SyntaxError: Unexpected end of JSON input` inside `c.req.json()`, surfacing as a
  // raw 500 "An unexpected error occurred" — exactly the kind of leak this route's own
  // constant-response (ALWAYS_OK) design exists to prevent. Reproduced against production before
  // fixing (naelao-spaces' own live tail), fixed with the same defensive `.catch(() => ({}))`
  // parse convention every other body-parsing route in this codebase already uses.
  it("never 500s on an empty or malformed body — degrades to the same constant response", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);

    const emptyBodyReq = new Request("https://spaces.naelao.com/spaces/prod-1/end-users/resend-verification", {
      method: "POST", headers: { "content-type": "application/json" }, // no body at all
    });
    const res = await spacesWorker.fetch(emptyBodyReq, env as never, execCtx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "If that account exists and isn't yet verified, a new verification link has been sent." });
  });

  it("signup still succeeds even if the verification email step fails (e.g. a transient notify failure)", async () => {
    const env = makeEnv();
    env.NOTIFICATIONS_WORKER.fetch = async () => { throw new Error("network down"); };
    await seedProduct(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/prod-1/end-users/signup", { email: "jane@acme.com", password: "hunter22" }), env as never, execCtx);
    expect(res.status).toBe(201);
    const body = await res.json() as { session_token: string };
    expect(body.session_token).toMatch(/^nps_/);
  });
});

describe("DELETE /spaces/:spaceId/product-users/me (Tier 2/3 follow-up: GDPR erasure — export existed, deletion didn't)", () => {
  async function signup(env: ReturnType<typeof makeEnv>, productId: string, email = "jane@acme.com") {
    const res = await spacesWorker.fetch(req(`/spaces/${productId}/end-users/signup`, { email, password: "hunter22" }), env as never, execCtx);
    return res.json() as Promise<{ end_user_id: string; session_token: string }>;
  }

  function eraseReq(productId: string, endUserId: string, tenantId: string): Request {
    return new Request(`https://spaces.naelao.com/spaces/${productId}/product-users/me`, {
      method: "DELETE",
      headers: { "x-naelao-role": "product_end_user", "x-naelao-user-id": endUserId, "x-naelao-tenant-id": tenantId },
    });
  }

  it("anonymizes the D1 roster row's PII (email/display_name/password_hash) and marks deleted_at", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const { end_user_id } = await signup(env, "prod-1");
    const res = await spacesWorker.fetch(eraseReq("prod-1", end_user_id, "tenant-1"), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { erased: boolean };
    expect(body.erased).toBe(true);

    const row = await env.PLATFORM_DB.prepare(
      "SELECT email, display_name, password_hash, deleted_at FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
    ).bind("prod-1", end_user_id).first<{ email: string | null; display_name: string | null; password_hash: string | null; deleted_at: string | null }>();
    expect(row?.email).toBeNull();
    expect(row?.password_hash).toBeNull();
    expect(row?.deleted_at).toBeTruthy();
  });

  it("GET /product-users/me reflects the anonymized state after erasure (row kept, not gone)", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const { end_user_id } = await signup(env, "prod-1");
    await spacesWorker.fetch(eraseReq("prod-1", end_user_id, "tenant-1"), env as never, execCtx);

    const meRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/product-users/me`, {
        headers: { "x-naelao-role": "product_end_user", "x-naelao-user-id": end_user_id, "x-naelao-tenant-id": "tenant-1" },
      }),
      env as never, execCtx
    );
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json() as { email: string | null };
    expect(meBody.email).toBeNull();
  });

  it("is idempotent — erasing twice does not error", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const { end_user_id } = await signup(env, "prod-1");
    const first = await spacesWorker.fetch(eraseReq("prod-1", end_user_id, "tenant-1"), env as never, execCtx);
    const second = await spacesWorker.fetch(eraseReq("prod-1", end_user_id, "tenant-1"), env as never, execCtx);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("404s for a caller who isn't a product_end_user", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/product-users/me`, {
        method: "DELETE",
        headers: { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1", "x-naelao-tenant-id": "tenant-1" },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });

  it("404s for a nonexistent end user", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(eraseReq("prod-1", "no-such-user", "tenant-1"), env as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("erasing one end user does not affect a different end user on the same product", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const alice = await signup(env, "prod-1", "alice@acme.com");
    const bob = await signup(env, "prod-1", "bob@acme.com");
    await spacesWorker.fetch(eraseReq("prod-1", alice.end_user_id, "tenant-1"), env as never, execCtx);

    const bobRow = await env.PLATFORM_DB.prepare(
      "SELECT email, deleted_at FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
    ).bind("prod-1", bob.end_user_id).first<{ email: string | null; deleted_at: string | null }>();
    expect(bobRow?.email).toBe("bob@acme.com");
    expect(bobRow?.deleted_at).toBeNull();
  });
});
