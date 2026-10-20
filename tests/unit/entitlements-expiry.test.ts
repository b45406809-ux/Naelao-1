import { describe, expect, it } from "vitest";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { EntitlementsChecker } from "../../packages/entitlements/src/index.js";

describe("entitlement API key usage expiry", () => {
  it("does not count ISO-expired API keys from earlier today", async () => {
    const db = createFakeD1([
      "CREATE TABLE orgs (id TEXT PRIMARY KEY, plan_tier TEXT NOT NULL DEFAULT 'free');",
      "CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');",
      "CREATE TABLE users (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');",
      "CREATE TABLE api_keys (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, revoked_at TEXT, expires_at TEXT);",
    ]);
    db.db.exec("INSERT INTO orgs (id, plan_tier) VALUES ('tenant', 'free')");
    db.db.prepare("INSERT INTO api_keys (id, org_id, expires_at) VALUES ('expired', 'tenant', ?)").run(new Date(Date.now() - 60_000).toISOString());
    db.db.prepare("INSERT INTO api_keys (id, org_id, expires_at) VALUES ('active', 'tenant', ?)").run(new Date(Date.now() + 60_000).toISOString());
    const usage = await new EntitlementsChecker(db).getCurrentUsage("tenant");
    expect(usage.usage.api_keys).toBe(1);
  });
});
