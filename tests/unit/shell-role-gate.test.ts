import { describe, it, expect } from "vitest";
import { roleAtLeast, canManageSpaceSettings } from "../../apps/shell/src/lib/roles.js";
import { resolveEndUserBusinessRole } from "../../workers/spaces/src/business-auth.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// The reported bug this locks down: the shell gated its assistant/agent settings on
// `role === "admin"` exactly. Whoever CREATES a business is inserted as 'owner', never 'admin'
// (workers/spaces/src/business-routes.ts), and the backend ranks owner(3) >= admin(2) — so the
// server would have accepted the write while the UI never offered it, and every business creator
// found their own settings read-only. An exact-match check silently drifting from a ranked one is
// the class of bug here, so what's tested is that the two agree.

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

describe("shell business-role gate", () => {
  it("lets an owner manage settings — the exact case the reported bug locked out", () => {
    expect(canManageSpaceSettings(true, "owner")).toBe(true);
  });

  it("lets an admin manage settings", () => {
    expect(canManageSpaceSettings(true, "admin")).toBe(true);
  });

  it("does not let a plain member or viewer manage settings", () => {
    expect(canManageSpaceSettings(true, "member")).toBe(false);
    expect(canManageSpaceSettings(true, "viewer")).toBe(false);
  });

  it("never grants management on a product root, whatever the role says", () => {
    // Team mode: an end user is never more than "member" of the product itself, and those
    // settings belong to the builder dashboard.
    expect(canManageSpaceSettings(false, "owner")).toBe(false);
    expect(canManageSpaceSettings(false, "admin")).toBe(false);
  });

  it("fails closed on a missing or unrecognised role", () => {
    expect(canManageSpaceSettings(true, null)).toBe(false);
    expect(canManageSpaceSettings(true, undefined)).toBe(false);
    expect(canManageSpaceSettings(true, "")).toBe(false);
    expect(canManageSpaceSettings(true, "superuser")).toBe(false);
  });

  it("ranks roles the same way the backend does", () => {
    expect(roleAtLeast("owner", "viewer")).toBe(true);
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "member")).toBe(false);
  });

  it("agrees with the real backend role for a business creator", async () => {
    // The creator's actual stored row, exactly as POST /spaces/:productSpaceId/businesses writes
    // it — 'owner', which is the role the old exact-match `=== "admin"` UI check rejected.
    const fake = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_SQL]);
    fake.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-root', 'root-tenant', 'active', 'Product')");
    fake.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz', 'biz-tenant', 'active', 'Biz', 'prod-root')");
    fake.db.exec(
      "INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz', 'prod-root', 'creator', 'owner', 'active')"
    );

    const role = await resolveEndUserBusinessRole(fake as never, "biz", "creator", "prod-root");
    expect(role).toBe("owner");
    // What the UI must conclude from that same role — the two halves of the bug, together.
    expect(canManageSpaceSettings(true, role)).toBe(true);
  });
});
