import { describe, it, expect } from "vitest";
import { resolveEndUserSpaceRole } from "../../workers/spaces/src/space-auth.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const SPACES = `CREATE TABLE spaces (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active');`;
const MEMBERS = `CREATE TABLE space_members (space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, role TEXT NOT NULL, suspended_at TEXT, PRIMARY KEY (space_id, end_user_id));`;

function makeDb() {
  const db = createFakeD1([SPACES, MEMBERS]);
  db.db.exec("INSERT INTO spaces (id) VALUES ('space-a'), ('space-b')");
  db.db.exec("INSERT INTO space_members (space_id, end_user_id, role) VALUES ('space-a', 'alice', 'owner'), ('space-a', 'bob', 'member'), ('space-b', 'alice', 'admin')");
  return db;
}

describe("resolveEndUserSpaceRole", () => {
  it("resolves only explicit membership on the requested Space", async () => {
    const db = makeDb();
    expect(await resolveEndUserSpaceRole(db as never, "space-a", "alice")).toBe("owner");
    expect(await resolveEndUserSpaceRole(db as never, "space-a", "bob")).toBe("member");
    expect(await resolveEndUserSpaceRole(db as never, "space-a", "stranger")).toBeNull();
    expect(await resolveEndUserSpaceRole(db as never, "missing-space", "alice")).toBeNull();
  });

  it("does not reuse another Space's role and denies suspended or corrupt membership", async () => {
    const db = makeDb();
    expect(await resolveEndUserSpaceRole(db as never, "space-b", "alice")).toBe("admin");
    expect(await resolveEndUserSpaceRole(db as never, "space-a", "alice")).toBe("owner");
    db.db.exec("UPDATE space_members SET suspended_at = 'now' WHERE space_id = 'space-a' AND end_user_id = 'alice'");
    expect(await resolveEndUserSpaceRole(db as never, "space-a", "alice")).toBeNull();
    db.db.exec("UPDATE space_members SET suspended_at = NULL, role = 'superuser' WHERE space_id = 'space-a' AND end_user_id = 'alice'");
    expect(await resolveEndUserSpaceRole(db as never, "space-a", "alice")).toBeNull();
  });
});
