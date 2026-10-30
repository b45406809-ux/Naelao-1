import { describe, it, expect } from "vitest";
import { roleAtLeast, canManageSpaceSettings } from "../../apps/shell/src/lib/roles.js";
import { resolveEndUserSpaceRole } from "../../workers/spaces/src/space-auth.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Space settings use the same ranked owner/admin role semantics as the spaces worker.

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;
const SPACE_MEMBERS_SQL = `
  CREATE TABLE space_members (
    space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    suspended_at TEXT, PRIMARY KEY (space_id, end_user_id)
  );
`;

describe("shell Space-role gate", () => {
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

  it("agrees with the backend role stored for a Space owner", async () => {
    const fake = createFakeD1([SPACES_TABLE_SQL, SPACE_MEMBERS_SQL]);
    fake.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('space-1', 'tenant-1', 'active', 'Personal')");
    fake.db.exec("INSERT INTO space_members (space_id, end_user_id, role) VALUES ('space-1', 'owner-1', 'owner')");

    const role = await resolveEndUserSpaceRole(fake as never, "space-1", "owner-1");
    expect(role).toBe("owner");
    // The UI accepts the same owner authority as the Space API.
    expect(canManageSpaceSettings(true, role)).toBe(true);
  });
});
