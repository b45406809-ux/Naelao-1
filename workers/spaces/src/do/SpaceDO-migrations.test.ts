import { applyMigrations, type SqlStorage } from "@naelao/db";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SPACE_DO_MIGRATIONS } from "./SpaceDO";

describe("SpaceDO migration replay", () => {
  it("creates the project demo-fixture table and replays every migration exactly once", () => {
    const storage = createDOStorage();
    applyMigrations(
      storage as unknown as {
        sql: SqlStorage;
        transactionSync<T>(closure: () => T): T;
      },
      SPACE_DO_MIGRATIONS
    );
    applyMigrations(
      storage as unknown as {
        sql: SqlStorage;
        transactionSync<T>(closure: () => T): T;
      },
      SPACE_DO_MIGRATIONS
    );
    const table = storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='project_demo_fixtures'"
      )
      .toArray();
    const applied = storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _migrations WHERE version = 65"
      )
      .toArray();
    expect(table).toHaveLength(1);
    expect(applied[0]?.count).toBe(1);
    storage.sql.exec(
      "INSERT INTO project_demo_fixtures (project_id, fixture_id, fixture_kind, data_json) VALUES (?, ?, ?, ?)",
      "project-1",
      "sample-1",
      "nda_clause",
      JSON.stringify({ synthetic: true })
    );
    expect(
      storage.sql
        .exec<{ fixture_kind: string; data_json: string }>(
          "SELECT fixture_kind, data_json FROM project_demo_fixtures WHERE project_id = ? AND fixture_id = ?",
          "project-1",
          "sample-1"
        )
        .toArray()[0]
    ).toMatchObject({
      fixture_kind: "nda_clause",
      data_json: '{"synthetic":true}',
    });
  });
});
