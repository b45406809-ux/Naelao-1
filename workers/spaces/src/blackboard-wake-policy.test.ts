import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { persistBlackboardWakePolicy } from "./blackboard-wake-policy.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE space_blackboard_policies(
      tenant_id TEXT, space_id TEXT, project_id TEXT, wake_enabled INTEGER,
      authorized_user_id TEXT, updated_at TEXT,
      PRIMARY KEY(tenant_id,space_id,project_id));
    CREATE TABLE space_blackboard_wakes(
      tenant_id TEXT, space_id TEXT, project_id TEXT, event_id TEXT,
      status TEXT, lease_until INTEGER, dispatch_accepted INTEGER,
      updated_at INTEGER,
      PRIMARY KEY(tenant_id,space_id,project_id,event_id));
  `);
  const platform = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) { values = bound; return statement; },
        async run() {
          const result = db.prepare(sql).run(...values as never[]);
          return { meta: { changes: Number(result.changes ?? 0) } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, platform };
}

describe("blackboard wake policy revocation", () => {
  it("atomically disables future wakes and holds pending or unaccepted claims", async () => {
    const { db, platform } = sqliteD1();
    db.prepare("INSERT INTO space_blackboard_policies VALUES(?,?,?,?,?,?)")
      .run("t", "s", "p", 1, "old-owner", "before");
    const insertWake = db.prepare(`INSERT INTO space_blackboard_wakes
      VALUES(?,?,?,?,?,?,?,?)`);
    insertWake.run("t", "s", "p", "pending", "pending", null, 0, 1);
    insertWake.run("t", "s", "p", "claimed", "running", 900, 0, 1);
    insertWake.run("t", "s", "p", "accepted", "running", 900, 1, 1);
    insertWake.run("t", "s", "p", "done", "completed", null, 1, 1);

    await persistBlackboardWakePolicy(platform, {
      tenantId: "t", spaceId: "s", projectId: "p", userId: "new-owner",
      wakeEnabled: false, updatedAt: "after", nowSeconds: 200,
    });

    expect(db.prepare("SELECT wake_enabled, authorized_user_id, updated_at FROM space_blackboard_policies").get())
      .toEqual({ wake_enabled: 0, authorized_user_id: "new-owner", updated_at: "after" });
    expect(db.prepare("SELECT event_id, status, lease_until, dispatch_accepted FROM space_blackboard_wakes ORDER BY event_id").all())
      .toEqual([
        { event_id: "accepted", status: "running", lease_until: 900, dispatch_accepted: 1 },
        { event_id: "claimed", status: "held", lease_until: null, dispatch_accepted: 0 },
        { event_id: "done", status: "completed", lease_until: null, dispatch_accepted: 1 },
        { event_id: "pending", status: "held", lease_until: null, dispatch_accepted: 0 },
      ]);
    db.close();
  });
});
