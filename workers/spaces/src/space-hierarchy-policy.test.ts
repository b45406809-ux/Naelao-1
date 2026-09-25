import { describe, expect, it } from "vitest";
import { SpaceDO } from "./do/SpaceDO.js";

describe("Space Hierarchy & Isolation Policies", () => {
  function createTestDO() {
    const storage = new Map();
    const rows = new Map();
    const mockCtx = {
      storage: {
        sql: {
          exec(query, ...params) {
            return {
              toArray: () => {
                if (query.includes("FROM spaces WHERE id = ?")) {
                  const id = params[0];
                  return (rows.get("spaces") ?? []).filter((r) => r.id === id);
                }
                if (
                  query.includes(
                    "FROM space_members WHERE space_id = ? AND user_id = ?"
                  )
                ) {
                  const [sid, uid] = params;
                  return (rows.get("space_members") ?? []).filter(
                    (r) => r.space_id === sid && r.user_id === uid
                  );
                }
                if (query.includes("FROM cross_space_grants")) {
                  const [target, req] = params;
                  return (rows.get("cross_space_grants") ?? []).filter(
                    (r) =>
                      r.granting_space_id === target &&
                      r.receiving_space_id === req
                  );
                }
                return [];
              },
            };
          },
        },
        transactionSync: (fn) => fn(),
        get: async (k) => storage.get(k),
        put: async (k, v) => {
          storage.set(k, v);
        },
      },
    };
    return {
      spaceDO: new SpaceDO(mockCtx, { PLATFORM_SECRET: "sec" }),
      rows,
    };
  }

  it("permits downward oversight from parent admin to sub-space", async () => {
    const { spaceDO, rows } = createTestDO();
    rows.set("spaces", [
      {
        id: "company-root",
        depth: 0,
        parent_id: null,
        space_type: "launchpad",
        status: "active",
      },
      {
        id: "dept-legal",
        depth: 1,
        parent_id: "company-root",
        space_type: "launchpad",
        status: "active",
      },
    ]);
    rows.set("space_members", [
      { space_id: "company-root", user_id: "cfo", role: "admin" },
    ]);

    const res = await spaceDO.fetch(
      new Request(
        "https://space-do/hierarchy-authorize?user_id=cfo&target_space_id=dept-legal&action=manage"
      )
    );
    expect(await res.json()).toMatchObject({ permitted: true, role: "admin" });
  });

  it("denies sub-space member upward access to parent ledger", async () => {
    const { spaceDO, rows } = createTestDO();
    rows.set("spaces", [
      {
        id: "company-root",
        depth: 0,
        parent_id: null,
        space_type: "launchpad",
        status: "active",
      },
      {
        id: "dept-legal",
        depth: 1,
        parent_id: "company-root",
        space_type: "launchpad",
        status: "active",
      },
    ]);
    rows.set("space_members", [
      { space_id: "dept-legal", user_id: "junior-lawyer", role: "member" },
    ]);

    const res = await spaceDO.fetch(
      new Request(
        "https://space-do/hierarchy-authorize?user_id=junior-lawyer&target_space_id=company-root&action=manage"
      )
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ permitted: false });
  });

  it("walls sibling sub-spaces unless authorized by an explicit cross-space grant", async () => {
    const { spaceDO, rows } = createTestDO();
    rows.set("spaces", [
      {
        id: "company-root",
        depth: 0,
        parent_id: null,
        space_type: "launchpad",
        status: "active",
      },
      {
        id: "dept-dev",
        depth: 1,
        parent_id: "company-root",
        space_type: "launchpad",
        status: "active",
      },
      {
        id: "dept-legal",
        depth: 1,
        parent_id: "company-root",
        space_type: "launchpad",
        status: "active",
      },
    ]);
    rows.set("space_members", [
      { space_id: "dept-dev", user_id: "engineer", role: "member" },
    ]);

    const noGrant = await spaceDO.fetch(
      new Request(
        "https://space-do/hierarchy-authorize?user_id=engineer&target_space_id=dept-legal&requesting_space_id=dept-dev"
      )
    );
    expect((await noGrant.json()).permitted).toBe(false);

    rows.set("cross_space_grants", [
      {
        granting_space_id: "dept-legal",
        receiving_space_id: "dept-dev",
        grant_type: "read-knowledge",
        revoked_at: null,
        expires_at: null,
      },
    ]);
    const withGrant = await spaceDO.fetch(
      new Request(
        "https://space-do/hierarchy-authorize?user_id=engineer&target_space_id=dept-legal&requesting_space_id=dept-dev"
      )
    );
    expect(await withGrant.json()).toMatchObject({
      permitted: true,
      grant_type: "read-knowledge",
    });
  });
});
