import { describe, it, expect } from "vitest";
import { resolveEndUserBusinessRole } from "../../workers/spaces/src/business-auth.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Three-Tier Platform Model, Phase C (§A1.17): closes a cross-business access hole the phased
// plan flagged in advance. resolveProductEndUserClaims only proves a caller holds a valid
// ProductUserDO session scoped to the PRODUCT (one instance per productId×endUserId, not
// per-business) — so without a real per-business check, a session verified for the product root
// would ALSO satisfy the identity check for any business under it, letting a caller reach another
// end user's business by changing :spaceId in the URL. This is the security-critical function
// requireBusinessMembership and the agent-definitions inline gate both depend on.

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;
const BUSINESS_MEMBERSHIPS_SQL = `
  CREATE TABLE business_memberships (
    business_space_id TEXT NOT NULL, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT, joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_space_id, end_user_id)
  );
`;

function makeDb() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_SQL]);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-root', 'root-tenant', 'active', 'Product')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-alice', 'alice-tenant', 'active', 'Alice Biz', 'prod-root')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-bob', 'bob-tenant', 'active', 'Bob Biz', 'prod-root')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'alice', 'owner', 'active')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-bob', 'prod-root', 'bob', 'owner', 'active')");
  return fakeDb;
}

describe("resolveEndUserBusinessRole", () => {
  it("treats the product root as implicit member for any caller (Phase B behavior preserved)", async () => {
    const db = makeDb();
    expect(await resolveEndUserBusinessRole(db as never, "prod-root", "alice")).toBe("member");
    expect(await resolveEndUserBusinessRole(db as never, "prod-root", "bob")).toBe("member");
    expect(await resolveEndUserBusinessRole(db as never, "prod-root", "total-stranger")).toBe("member");
  });

  it("a business owner resolves their own real role", async () => {
    const db = makeDb();
    expect(await resolveEndUserBusinessRole(db as never, "biz-alice", "alice")).toBe("owner");
    expect(await resolveEndUserBusinessRole(db as never, "biz-bob", "bob")).toBe("owner");
  });

  it("CRITICAL: a different end user cannot reach another end user's business", async () => {
    const db = makeDb();
    expect(await resolveEndUserBusinessRole(db as never, "biz-alice", "bob")).toBeNull();
    expect(await resolveEndUserBusinessRole(db as never, "biz-bob", "alice")).toBeNull();
  });

  it("a suspended membership no longer grants access", async () => {
    const db = makeDb();
    db.db.exec("UPDATE business_memberships SET status = 'suspended' WHERE business_space_id = 'biz-alice' AND end_user_id = 'alice'");
    expect(await resolveEndUserBusinessRole(db as never, "biz-alice", "alice")).toBeNull();
  });

  it("returns null for a nonexistent space, and fails closed on missing ids", async () => {
    const db = makeDb();
    expect(await resolveEndUserBusinessRole(db as never, "no-such-space", "alice")).toBeNull();
    expect(await resolveEndUserBusinessRole(db as never, "", "alice")).toBeNull();
    expect(await resolveEndUserBusinessRole(db as never, "biz-alice", "")).toBeNull();
  });
});
