import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { dispatchPendingProductAccountSecurityOutbox } from "./product-account-security-outbox.js";

const BASE_SCHEMA = [
  `CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);`,
  `CREATE TABLE product_end_users (product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, email TEXT, password_hash TEXT, email_verified_at TEXT, suspended_at TEXT, deleted_at TEXT, PRIMARY KEY (product_space_id, end_user_id));`,
  `CREATE TABLE password_reset_tokens (id TEXT PRIMARY KEY, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);`,
  `CREATE TABLE email_verification_tokens (id TEXT PRIMARY KEY, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);`,
];

function securityHarness() {
  const fakeDb = createFakeD1(BASE_SCHEMA);
  fakeDb.db.exec(readFileSync(new URL("../../../infra/migrations/0227_product_account_recovery_generation_and_email_outbox.sql", import.meta.url), "utf8"));
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id) VALUES ('product', 'tenant')");
  fakeDb.db.exec("INSERT INTO product_end_users (product_space_id, end_user_id, password_hash) VALUES ('product', 'user', 'old-hash')");
  fakeDb.db.exec(`INSERT INTO password_reset_tokens (id, product_space_id, end_user_id, token_hash, expires_at)
    VALUES ('token', 'product', 'user', 'hash', datetime('now', '+1 hour'))`);
  fakeDb.db.exec(`UPDATE password_reset_tokens SET used_at = datetime('now'), pending_password_hash = 'new-hash' WHERE id = 'token'`);
  return fakeDb;
}

describe("product account security cleanup outbox", () => {
  it("advances generation when suspension is applied so reactivation cannot revive old tokens", () => {
    const fakeDb = createFakeD1(BASE_SCHEMA);
    fakeDb.db.exec(readFileSync(new URL("../../../infra/migrations/0227_product_account_recovery_generation_and_email_outbox.sql", import.meta.url), "utf8"));
    fakeDb.db.exec("INSERT INTO spaces (id, tenant_id) VALUES ('product', 'tenant')");
    fakeDb.db.exec("INSERT INTO product_end_users (product_space_id, end_user_id) VALUES ('product', 'user')");
    fakeDb.db.exec("UPDATE product_end_users SET suspended_at = datetime('now') WHERE product_space_id = 'product' AND end_user_id = 'user'");
    expect(fakeDb.db.prepare("SELECT security_generation FROM product_end_users").get()).toEqual({ security_generation: 1 });
    expect(fakeDb.db.prepare("SELECT security_generation, status FROM product_account_security_outbox").get()).toEqual({ security_generation: 1, status: "pending" });
  });

  it("retries session-store revocation while generation already denies the old session", async () => {
    const fakeDb = securityHarness();
    const responses = [new Response("unavailable", { status: 503 }), new Response(null, { status: 204 })];
    const fetch = vi.fn(async () => responses.shift()!);
    const env = {
      PLATFORM_SECRET: "test-secret",
      PRODUCT_USER_DO: { idFromName: (name: string) => name, get: () => ({ fetch }) },
    } as never;

    expect(await dispatchPendingProductAccountSecurityOutbox(fakeDb, env)).toEqual({ completed: 0, deferred: 1 });
    expect(fakeDb.db.prepare("SELECT status, last_error_code FROM product_account_security_outbox").get()).toEqual({ status: "pending", last_error_code: "session_store_http_503" });
    fakeDb.db.exec("UPDATE product_account_security_outbox SET next_attempt_at = datetime('now', '-1 second')");
    expect(await dispatchPendingProductAccountSecurityOutbox(fakeDb, env)).toEqual({ completed: 1, deferred: 0 });
    expect(fakeDb.db.prepare("SELECT status, last_error_code FROM product_account_security_outbox").get()).toEqual({ status: "completed", last_error_code: null });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fakeDb.db.prepare("SELECT security_generation FROM product_end_users").get()).toEqual({ security_generation: 1 });
  });
});
