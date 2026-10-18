import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim.js";
import { type MigratableStorage, applyMigrations } from "./migrate.js";

describe("migration SQL statement boundaries", () => {
  it("keeps CASE expressions and internal statements inside trigger bodies", () => {
    const storage = createDOStorage();
    applyMigrations(storage as unknown as MigratableStorage, [
      {
        version: 1,
        description: "trigger with case expression",
        up: `
          CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE record_log (value TEXT NOT NULL);
          CREATE TRIGGER log_record AFTER INSERT ON records BEGIN
            INSERT INTO record_log(value)
              VALUES (CASE WHEN NEW.value = 'yes' THEN 'matched' ELSE 'other' END);
            INSERT INTO record_log(value) VALUES ('finished');
          END;
        `,
      },
    ]);
    storage.sql.exec("INSERT INTO records(value) VALUES (?)", "yes");
    expect(
      storage.sql
        .exec<{ value: string }>("SELECT value FROM record_log ORDER BY rowid")
        .toArray()
    ).toEqual([{ value: "matched" }, { value: "finished" }]);
  });

  it("does not split SQL statements on semicolons inside quoted identifiers", () => {
    const storage = createDOStorage();
    applyMigrations(storage as unknown as MigratableStorage, [
      {
        version: 1,
        description: "quoted identifier",
        up: 'CREATE TABLE "semi;colon" (id TEXT PRIMARY KEY);',
      },
    ]);
    expect(
      storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          "semi;colon"
        )
        .toArray()
    ).toEqual([{ name: "semi;colon" }]);
  });
});
