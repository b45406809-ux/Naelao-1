import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Three-Tier Platform Model, Phase 1 (docs/spec-appendix A1.17). Migration 0044 adds only two
// genuinely new, cross-space-queryable concerns to `spaces` — product_slug (platform-subdomain
// identity, needs a uniqueness check) and the conversation-access legal-audit pair. Everything
// else from the spec's NaelaoProduct field list extends SpaceTypeProductConfig instead (a
// config_json override, like member billing already is) — deliberately not migrated here.

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad', config_json TEXT
  );
`;
const NAELAO_PRODUCT_MIGRATION = readFileSync(
  join(__dirname, "../../infra/migrations/0044_naelao_product.sql"),
  "utf8"
);

function makeDb() {
  return createFakeD1([SPACES_TABLE_SQL, NAELAO_PRODUCT_MIGRATION]);
}

describe("migration 0044_naelao_product", () => {
  it("applies cleanly on top of the base spaces table", () => {
    expect(() => makeDb()).not.toThrow();
  });

  it("new columns default to NULL — existing rows are unaffected", async () => {
    const fakeDb = makeDb();
    fakeDb.db.exec(
      "INSERT INTO spaces (id, tenant_id, status, name) VALUES ('space-1', 'tenant-1', 'active', 'Existing Space')"
    );
    const row = await fakeDb.prepare("SELECT product_slug, conversation_access_approved_by, conversation_access_approved_at FROM spaces WHERE id = ?")
      .bind("space-1").first<{ product_slug: string | null; conversation_access_approved_by: string | null; conversation_access_approved_at: string | null }>();
    expect(row?.product_slug).toBeNull();
    expect(row?.conversation_access_approved_by).toBeNull();
    expect(row?.conversation_access_approved_at).toBeNull();
  });

  it("enforces platform-wide product_slug uniqueness", async () => {
    const fakeDb = makeDb();
    fakeDb.db.exec(
      "INSERT INTO spaces (id, tenant_id, status, name, product_slug) VALUES ('space-1', 'tenant-1', 'active', 'A', 'my-shop')"
    );
    expect(() =>
      fakeDb.db.exec(
        "INSERT INTO spaces (id, tenant_id, status, name, product_slug) VALUES ('space-2', 'tenant-2', 'active', 'B', 'my-shop')"
      )
    ).toThrow();
  });

  it("allows multiple spaces with no product_slug (the partial unique index excludes NULLs)", async () => {
    const fakeDb = makeDb();
    fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('space-1', 'tenant-1', 'active', 'A')");
    expect(() =>
      fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('space-2', 'tenant-2', 'active', 'B')")
    ).not.toThrow();
  });

  it("a different builder can reuse a slug once the original space is deleted (index is on live rows only, no orphaned uniqueness)", async () => {
    const fakeDb = makeDb();
    fakeDb.db.exec(
      "INSERT INTO spaces (id, tenant_id, status, name, product_slug) VALUES ('space-1', 'tenant-1', 'active', 'A', 'taken')"
    );
    fakeDb.db.exec("DELETE FROM spaces WHERE id = 'space-1'");
    expect(() =>
      fakeDb.db.exec(
        "INSERT INTO spaces (id, tenant_id, status, name, product_slug) VALUES ('space-2', 'tenant-2', 'active', 'B', 'taken')"
      )
    ).not.toThrow();
  });

  it("conversation_access_approved_by/_at can be set independently of product_slug", async () => {
    const fakeDb = makeDb();
    fakeDb.db.exec(
      "INSERT INTO spaces (id, tenant_id, status, name) VALUES ('space-1', 'tenant-1', 'active', 'A')"
    );
    fakeDb.db.exec(
      "UPDATE spaces SET conversation_access_approved_by = 'naelao-staff-1', conversation_access_approved_at = '2026-07-01T00:00:00Z' WHERE id = 'space-1'"
    );
    const row = await fakeDb.prepare("SELECT conversation_access_approved_by, conversation_access_approved_at FROM spaces WHERE id = ?")
      .bind("space-1").first<{ conversation_access_approved_by: string; conversation_access_approved_at: string }>();
    expect(row?.conversation_access_approved_by).toBe("naelao-staff-1");
    expect(row?.conversation_access_approved_at).toBe("2026-07-01T00:00:00Z");
  });
});
