import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { normalizeE164, registerProductEndUserRoutes, type ProductEndUserRoutesEnv } from "./product-end-user-routes.js";

const AUTH_SCHEMA = [
  `CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, spacetype_id TEXT NOT NULL DEFAULT 'launchpad', status TEXT NOT NULL DEFAULT 'active', config_json TEXT, product_slug TEXT);`,
  `CREATE TABLE product_end_users (product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, email TEXT, display_name TEXT, password_hash TEXT, email_verified_at TEXT, phone_e164 TEXT, phone_verified_at TEXT, suspended_at TEXT, deleted_at TEXT, first_seen_at TEXT, last_seen_at TEXT, PRIMARY KEY (product_space_id, end_user_id));`,
  `CREATE TABLE password_reset_tokens (id TEXT PRIMARY KEY, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);`,
  `CREATE TABLE email_verification_tokens (id TEXT PRIMARY KEY, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);`,
];

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function authHarness(config = '{"productConfig":{"authProvider":{"provider":"naelao-native"},"pricingConfig":{"model":"subscription"}}}') {
  const fakeDb = createFakeD1(AUTH_SCHEMA);
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, config_json) VALUES ('product', 'tenant', '${config}')`);
  fakeDb.db.exec("INSERT INTO product_end_users (product_space_id, end_user_id, email) VALUES ('product', 'user', 'user@example.com')");
  const doFetch = vi.fn(async () => Response.json({ ok: true }));
  const env = {
    PLATFORM_DB: fakeDb,
    PLATFORM_SECRET: "secret",
    PRODUCT_USER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: doFetch }) },
    SPACE_TYPE_REGISTRY_DO: {},
    NAELAO_CONFIG_KV: {},
  } as unknown as ProductEndUserRoutesEnv;
  const app = new Hono();
  registerProductEndUserRoutes(app);
  return { fakeDb, env, app, doFetch };
}

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
    const reset = fakeDb.db.prepare("SELECT used_at FROM password_reset_tokens WHERE id = 'reset-1'").get() as { used_at: string | null };
    expect(reset.used_at).toBeTruthy();
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
