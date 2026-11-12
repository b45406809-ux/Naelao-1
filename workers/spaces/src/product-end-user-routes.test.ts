import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { errorResponse } from "@naelao/http";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { hashPassword } from "@naelao/crypto";
import { normalizeE164, registerProductEndUserRoutes, type ProductEndUserRoutesEnv } from "./product-end-user-routes.js";
import { dispatchPendingProductAuthEmails } from "./product-auth-email-outbox.js";

const AUTH_SCHEMA = [
  `CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, spacetype_id TEXT NOT NULL DEFAULT 'launchpad', status TEXT NOT NULL DEFAULT 'active', config_json TEXT, product_slug TEXT);`,
  `CREATE TABLE products (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, spacetype_id TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT, product_slug TEXT);`,
  `CREATE TABLE product_end_users (product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, email TEXT, display_name TEXT, password_hash TEXT, email_verified_at TEXT, phone_e164 TEXT, phone_verified_at TEXT, suspended_at TEXT, deleted_at TEXT, first_seen_at TEXT, last_seen_at TEXT, PRIMARY KEY (product_space_id, end_user_id));`,
  `CREATE TABLE password_reset_tokens (id TEXT PRIMARY KEY, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);`,
  `CREATE TABLE email_verification_tokens (id TEXT PRIMARY KEY, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);`,
  `CREATE TABLE whatsapp_auth_challenges (id TEXT PRIMARY KEY, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, phone_e164 TEXT NOT NULL, otp_hash TEXT NOT NULL, magic_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));`,
];

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function authHarness(config = '{"productConfig":{"authProvider":{"provider":"naelao-native"},"pricingConfig":{"model":"subscription"}}}') {
  const fakeDb = createFakeD1(AUTH_SCHEMA);
  fakeDb.db.exec(readFileSync(new URL("../../../infra/migrations/0227_product_account_recovery_generation_and_email_outbox.sql", import.meta.url), "utf8"));
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, config_json) VALUES ('product', 'tenant', '${config}')`);
  fakeDb.db.exec(`INSERT INTO products (id, tenant_id, spacetype_id, status, config_json, product_slug) VALUES ('product', 'tenant', 'launchpad', 'active', '${config}', 'launchpad')`);
  fakeDb.db.exec("INSERT INTO product_end_users (product_space_id, end_user_id, email) VALUES ('product', 'user', 'user@example.com')");
  const doFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname === "/sessions") {
      return Response.json({ session_id: "session-test", session_token: "nps_test", expires_at: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
    }
    if (new URL(url).pathname === "/sessions/verify") return Response.json({ valid: true, session_id: "session-test" });
    return new Response(null, { status: 204 });
  });
  const env = {
    PLATFORM_DB: fakeDb,
    PLATFORM_SECRET: "secret",
    PRODUCT_USER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: doFetch }) },
    SPACE_TYPE_REGISTRY_DO: {},
    NAELAO_CONFIG_KV: {},
    WHATSAPP_ACCESS_TOKEN: "test-token",
    WHATSAPP_PHONE_NUMBER_ID: "123456789",
  } as unknown as ProductEndUserRoutesEnv;
  const app = new Hono();
  registerProductEndUserRoutes(app);
  app.onError((error) => errorResponse(error, "test"));
  return { fakeDb, env, app, doFetch };
}

afterEach(() => vi.unstubAllGlobals());

describe("WhatsApp passwordless identity", () => {
  it.each([
    ["+27821234567", "+27821234567"],
    ["00 27 82 123 4567", "+27821234567"],
    ["+1 (415) 555-0100", "+14155550100"],
  ])("normalizes %s to E.164", (input, expected) => {
    expect(normalizeE164(input)).toBe(expected);
  });

  it.each(["27821234567", "+012345678", "+12", "hello", "+1234567890123456"])(
    "rejects invalid phone %s",
    (input) => expect(normalizeE164(input)).toBeNull(),
  );
});

describe("product end-user recovery token replay boundary", () => {
  it("does not permit signup against an ordinary end-user Space", async () => {
    const { fakeDb, env, app, doFetch } = authHarness();
    fakeDb.db.exec("INSERT INTO spaces (id, tenant_id) VALUES ('workspace', 'tenant')");
    const response = await app.request("/spaces/workspace/end-users/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", password: "a secure test password" }),
    }, env);
    expect(response.status).toBe(404);
    expect(doFetch).not.toHaveBeenCalled();
    expect(fakeDb.db.prepare("SELECT COUNT(*) AS count FROM product_end_users WHERE product_space_id = 'workspace'").get()).toEqual({ count: 0 });
  });
  it("allows only one concurrent password reset for a single-use token", async () => {
    const { fakeDb, env, app } = authHarness();
    const token = "a".repeat(72);
    fakeDb.db.exec(`INSERT INTO password_reset_tokens (id, product_space_id, end_user_id, token_hash, expires_at) VALUES ('reset-1', 'product', 'user', '${await sha256Hex(token)}', '${new Date(Date.now() + 60_000).toISOString()}')`);
    const request = () => app.request("/spaces/product/end-users/reset-password", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, new_password: "new password long enough" }),
    }, env);
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const user = fakeDb.db.prepare("SELECT password_hash FROM product_end_users WHERE product_space_id = 'product' AND end_user_id = 'user'").get() as { password_hash: string | null };
    expect(user.password_hash).toBeTruthy();
    expect(fakeDb.db.prepare("SELECT security_generation FROM product_end_users WHERE product_space_id = 'product' AND end_user_id = 'user'").get()).toEqual({ security_generation: 1 });
    const reset = fakeDb.db.prepare("SELECT used_at FROM password_reset_tokens WHERE id = 'reset-1'").get() as { used_at: string | null };
    expect(reset.used_at).toBeTruthy();
    expect(fakeDb.db.prepare("SELECT pending_password_hash FROM password_reset_tokens WHERE id = 'reset-1'").get()).toEqual({ pending_password_hash: null });
    expect(fakeDb.db.prepare("SELECT security_generation, status FROM product_account_security_outbox").get()).toEqual({ security_generation: 1, status: "pending" });
  });

  it("uses one login failure response for unknown, wrong-password, and suspended accounts", async () => {
    const { fakeDb, env, app } = authHarness();
    const stored = await hashPassword("correct password");
    fakeDb.db.prepare("UPDATE product_end_users SET password_hash = ? WHERE end_user_id = 'user'").run(JSON.stringify(stored));
    const request = (body: string) => app.request("/spaces/product/end-users/login", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }, env);
    const unknown = await request(JSON.stringify({ email: "missing@example.com", password: "wrong password" }));
    const wrong = await request(JSON.stringify({ email: "user@example.com", password: "wrong password" }));
    fakeDb.db.exec("UPDATE product_end_users SET suspended_at = datetime('now') WHERE end_user_id = 'user'");
    const suspended = await request(JSON.stringify({ email: "user@example.com", password: "correct password" }));
    const bodies = await Promise.all([unknown, wrong, suspended].map((response) => response.json()));
    expect([unknown.status, wrong.status, suspended.status]).toEqual([401, 401, 401]);
    expect(bodies).toEqual(Array(3).fill({ error_code: "invalid_credentials", message: "Incorrect email or password" }));
    const malformed = await request("{");
    expect(malformed.status).toBe(400);
  });

  it("keeps the WhatsApp challenge cap atomic under concurrent requests", async () => {
    const { fakeDb, env, app } = authHarness();
    const fetch = vi.fn(async () => Response.json({ messages: [{ id: "sent" }] }));
    vi.stubGlobal("fetch", fetch);
    const request = () => app.request("/spaces/product/end-users/request-whatsapp-login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+14155550100" }),
    }, env);
    const responses = await Promise.all(Array.from({ length: 10 }, () => request()));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const challenges = fakeDb.db.prepare("SELECT COUNT(*) AS count FROM whatsapp_auth_challenges WHERE product_space_id = 'product' AND phone_e164 = '+14155550100'").get() as { count: number };
    expect(challenges.count).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("allows only one concurrent email verification for a single-use token", async () => {
    const { fakeDb, env, app } = authHarness();
    const token = "b".repeat(72);
    fakeDb.db.exec(`INSERT INTO email_verification_tokens (id, product_space_id, end_user_id, token_hash, expires_at) VALUES ('verify-1', 'product', 'user', '${await sha256Hex(token)}', '${new Date(Date.now() + 60_000).toISOString()}')`);
    const request = () => app.request("/spaces/product/end-users/verify-email", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
    }, env);
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const user = fakeDb.db.prepare("SELECT email_verified_at FROM product_end_users WHERE product_space_id = 'product' AND end_user_id = 'user'").get() as { email_verified_at: string | null };
    expect(user.email_verified_at).toBeTruthy();
  });

  it("keeps reset mail responses neutral and replaces the only outstanding token", async () => {
    const { fakeDb, env, app } = authHarness();
    const stored = await hashPassword("correct password");
    fakeDb.db.prepare("UPDATE product_end_users SET password_hash = ? WHERE end_user_id = 'user'").run(JSON.stringify(stored));
    const request = () => app.request("/spaces/product/end-users/request-password-reset", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "user@example.com" }),
    }, env);
    const first = await request();
    const firstBody = await first.json();
    const firstOperation = fakeDb.db.prepare("SELECT operation_id, encrypted_payload, status, last_error_code FROM product_auth_email_outbox WHERE message_kind = 'password_reset'").get() as { operation_id: string; encrypted_payload: string; status: string; last_error_code: string };
    expect(first.status).toBe(200);
    expect(firstBody).toEqual({ ok: true, message: "If an account with that email exists, a reset link has been sent." });
    expect(firstOperation.encrypted_payload).not.toContain("user@example.com");
    expect(firstOperation.status).toBe("pending");
    expect(firstOperation.last_error_code).toBe("notification_binding_unavailable");

    const second = await request();
    expect(await second.json()).toEqual(firstBody);
    expect(fakeDb.db.prepare("SELECT COUNT(*) AS count FROM password_reset_tokens WHERE used_at IS NULL").get()).toEqual({ count: 1 });
    expect(fakeDb.db.prepare("SELECT status FROM product_auth_email_outbox WHERE operation_id = ?").get(firstOperation.operation_id)).toEqual({ status: "cancelled" });
  });

  it("reuses one provider idempotency key after an ambiguous mail response", async () => {
    const { fakeDb, env, app } = authHarness();
    const stored = await hashPassword("correct password");
    fakeDb.db.prepare("UPDATE product_end_users SET password_hash = ? WHERE end_user_id = 'user'").run(JSON.stringify(stored));
    const attempts: Array<{ notification_id: string; body: string }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const payload = await (input as Request).json() as { notification_id: string; body: string };
      attempts.push(payload);
      if (attempts.length === 1) throw new Error("connection_timeout");
      return Response.json({ delivered: true });
    });
    env.NOTIFICATIONS_WORKER = { fetch } as unknown as Fetcher;
    const response = await app.request("/spaces/product/end-users/request-password-reset", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "user@example.com" }),
    }, env);
    expect(response.status).toBe(200);
    const operationId = fakeDb.db.prepare("SELECT operation_id FROM product_auth_email_outbox WHERE message_kind = 'password_reset'").get() as { operation_id: string };
    expect(fakeDb.db.prepare("SELECT status, attempt_count, last_error_code FROM product_auth_email_outbox WHERE operation_id = ?").get(operationId.operation_id)).toEqual({ status: "pending", attempt_count: 1, last_error_code: "connection_timeout" });
    fakeDb.db.exec("UPDATE product_auth_email_outbox SET next_attempt_at = datetime('now', '-1 second')");
    expect(await dispatchPendingProductAuthEmails(fakeDb, env)).toEqual({ accepted: 1, deferred: 0 });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.notification_id).toBe(`product-auth:${operationId.operation_id}`);
    expect(attempts[1]?.notification_id).toBe(attempts[0]?.notification_id);
    expect(fakeDb.db.prepare("SELECT status, attempt_count, last_error_code FROM product_auth_email_outbox WHERE operation_id = ?").get(operationId.operation_id)).toEqual({ status: "accepted", attempt_count: 2, last_error_code: null });
  });

  it("does not expose email-operation diagnostics without an internal HMAC", async () => {
    const { env, app } = authHarness();
    const response = await app.request("/internal/product-auth-email-operations", {}, env);
    expect(response.status).toBe(403);
  });

  it("rejects an expired ISO timestamp on the same calendar day", async () => {
    const { fakeDb, env, app } = authHarness();
    const token = "c".repeat(72);
    fakeDb.db.exec(`INSERT INTO password_reset_tokens (id, product_space_id, end_user_id, token_hash, expires_at) VALUES ('reset-expired', 'product', 'user', '${await sha256Hex(token)}', '${new Date(Date.now() - 60_000).toISOString()}')`);
    const response = await app.request("/spaces/product/end-users/reset-password", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, new_password: "new password long enough" }),
    }, env);
    expect(response.status).toBe(400);
  });
});
