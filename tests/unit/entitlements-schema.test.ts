// Regression test for the Phase E precondition (§A1.17): @naelao/entitlements previously queried
// `organizations` (real table: `orgs`), `users.tenant_id` (real column: `users.org_id`), and
// `api_keys.tenant_id` (real column: `api_keys.org_id`) — every EntitlementsChecker call would
// have thrown "no such table"/"no such column" against a real D1 database. This seeds the ACTUAL
// migrations (0001_users, 0002_orgs, 0003_spaces, 0004_billing) via node:sqlite, not a hand-rolled
// schema, so a regression back to the wrong names fails loudly here instead of silently in prod.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { EntitlementsChecker } from "../../packages/entitlements/src/index.js";

function readMigration(name: string): string {
  return readFileSync(join(__dirname, "../../infra/migrations", name), "utf8");
}

function makeDb() {
  return createFakeD1([
    readMigration("0001_users.sql"),
    readMigration("0002_orgs.sql"),
    readMigration("0003_spaces.sql"),
    readMigration("0004_billing.sql"),
  ]);
}

describe("EntitlementsChecker against the real platform schema", () => {
  it("getTenantTier reads plan_tier from `orgs`, not a nonexistent `organizations` table", async () => {
    const db = makeDb();
    db.db.exec(
      `INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES ('org-1', 'Acme', 'user-1', 'growth')`
    );
    const checker = new EntitlementsChecker(db as unknown as D1Database);
    await expect(checker.getTenantTier("org-1")).resolves.toBe("growth");
  });

  it("getTenantTier defaults to free for an unknown org id (no throw)", async () => {
    const checker = new EntitlementsChecker(makeDb() as unknown as D1Database);
    await expect(checker.getTenantTier("nonexistent")).resolves.toBe("free");
  });

  it("checkSeatLimit counts `users` by org_id, not a nonexistent tenant_id column", async () => {
    const db = makeDb();
    db.db.exec(`INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES ('org-1', 'Acme', 'u1', 'free')`);
    db.db.exec(`INSERT INTO users (id, email, org_id, status) VALUES ('u1', 'a@x.com', 'org-1', 'active')`);
    const checker = new EntitlementsChecker(db as unknown as D1Database);
    // free plan seat limit is 1 — a second active user should trip the quota check.
    db.db.exec(`INSERT INTO users (id, email, org_id, status) VALUES ('u2', 'b@x.com', 'org-1', 'active')`);
    await expect(checker.checkSeatLimit("org-1")).rejects.toThrow(/Seat limit reached/);
  });

  it("checkSpaceLimit counts `spaces` by tenant_id (a genuinely different id from org_id)", async () => {
    const db = makeDb();
    db.db.exec(`INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES ('org-1', 'Acme', 'u1', 'free')`);
    for (let i = 0; i < 3; i++) {
      db.db.exec(
        `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status) VALUES ('s${i}', 'org-1', 'launchpad', 'S${i}', 'active')`
      );
    }
    const checker = new EntitlementsChecker(db as unknown as D1Database);
    // free plan space limit is 3 — already at the ceiling.
    await expect(checker.checkSpaceLimit("org-1")).rejects.toThrow(/Space limit reached/);
  });

  it("getCurrentUsage counts api_keys by org_id and excludes revoked keys", async () => {
    const db = makeDb();
    db.db.exec(`INSERT INTO orgs (id, name, owner_id, plan_tier) VALUES ('org-1', 'Acme', 'u1', 'free')`);
    db.db.exec(`INSERT INTO users (id, email, org_id, status) VALUES ('u1', 'a@x.com', 'org-1', 'active')`);
    db.db.exec(
      `INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix) VALUES ('k1', 'org-1', 'Key 1', 'h1', 'nlk_1')`
    );
    db.db.exec(
      `INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, revoked_at) VALUES ('k2', 'org-1', 'Key 2', 'h2', 'nlk_2', datetime('now'))`
    );
    const checker = new EntitlementsChecker(db as unknown as D1Database);
    const usage = await checker.getCurrentUsage("org-1");
    expect(usage.tier).toBe("free");
    expect(usage.usage.seats).toBe(1);
    expect(usage.usage.api_keys).toBe(1); // the revoked key must not count
  });
});
