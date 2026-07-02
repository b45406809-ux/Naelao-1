import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Regression: removeMember used to run `DELETE FROM space_members WHERE user_id = ?` with no
// space_id scoping. One SpaceDO can host more than one space row (a sub-space/department
// registry) — an unscoped delete removed a member from EVERY space hosted by that DO, not
// just the one the caller meant to remove them from.

function makeSpaceDO(): SpaceDO {
  const ctx = { storage: { sql: createDOSqlStorage() } };
  return new SpaceDO(ctx as never, { PLATFORM_SECRET: "test-secret" } as never);
}

async function call(doInstance: SpaceDO, path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await doInstance.fetch(
    new Request(`http://space-do${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

describe("space_members — removeMember is scoped to (space_id, user_id)", () => {
  it("removing a member from one space does not remove them from another space in the same DO", async () => {
    const doInstance = makeSpaceDO();

    // One SpaceDO hosting two space rows (root + a department), same user a member of both.
    await call(doInstance, "/members", "POST", { space_id: "space-root", user_id: "user-1", role: "owner" });
    await call(doInstance, "/members", "POST", { space_id: "space-dept", user_id: "user-1", role: "member" });

    const before = await call(doInstance, "/members?space_id=space-root", "GET");
    expect(before.json.data).toHaveLength(1);
    const beforeDept = await call(doInstance, "/members?space_id=space-dept", "GET");
    expect(beforeDept.json.data).toHaveLength(1);

    // Remove the user from space-dept only.
    const del = await call(doInstance, "/members/user-1?space_id=space-dept", "DELETE");
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ deleted: true, space_id: "space-dept", user_id: "user-1" });

    // space-dept membership is gone...
    const afterDept = await call(doInstance, "/members?space_id=space-dept", "GET");
    expect(afterDept.json.data).toHaveLength(0);

    // ...but space-root membership SURVIVES (the bug: this used to also be wiped out).
    const afterRoot = await call(doInstance, "/members?space_id=space-root", "GET");
    expect(afterRoot.json.data).toHaveLength(1);
    expect(afterRoot.json.data[0].user_id).toBe("user-1");
  });

  it("rejects a delete with no space_id (would otherwise fall back to an unscoped delete)", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/members", "POST", { space_id: "space-1", user_id: "user-1", role: "owner" });

    const del = await call(doInstance, "/members/user-1", "DELETE");
    expect(del.status).toBe(400);

    // Membership must be untouched.
    const after = await call(doInstance, "/members?space_id=space-1", "GET");
    expect(after.json.data).toHaveLength(1);
  });

  it("removing a user from a space they are not a member of is a harmless no-op", async () => {
    const doInstance = makeSpaceDO();
    await call(doInstance, "/members", "POST", { space_id: "space-1", user_id: "user-1", role: "owner" });

    const del = await call(doInstance, "/members/user-2?space_id=space-1", "DELETE");
    expect(del.status).toBe(200);

    const after = await call(doInstance, "/members?space_id=space-1", "GET");
    expect(after.json.data).toHaveLength(1);
    expect(after.json.data[0].user_id).toBe("user-1");
  });
});
