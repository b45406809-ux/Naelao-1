import { describe, expect, it } from "vitest";
import { applyMigrations, validateMigrationSequence, type Migration } from "../../packages/db/src/migrate";
import { createDOStorage } from "./helpers/sqlite-do-shim";

describe("atomic versioned DO migrations", () => {
  it("applies pending versions once and replays safely after restart", () => {
    const storage = createDOStorage();
    const migrations: Migration[] = [
      { version: 1, description: "base", up: "CREATE TABLE records(id TEXT PRIMARY KEY);" },
      { version: 2, description: "add status", up: "ALTER TABLE records ADD COLUMN status TEXT NOT NULL DEFAULT 'new';" },
    ];
    applyMigrations(storage, migrations);
    applyMigrations(storage, migrations);
    expect([...storage.sql.exec<{ version: number }>("SELECT version FROM _migrations ORDER BY version").toArray()]).toEqual([{ version: 1 }, { version: 2 }]);
    expect([...storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('records')").toArray()].map((column) => column.name)).toContain("status");
  });

  it("rolls back the whole pending batch on a failed statement and rejects duplicate versions before execution", () => {
    const storage = createDOStorage();
    const migrations: Migration[] = [
      { version: 1, description: "create", up: "CREATE TABLE records(id TEXT PRIMARY KEY);" },
      { version: 2, description: "invalid index", up: "CREATE INDEX absent_index ON missing_table(id);" },
    ];
    expect(() => applyMigrations(storage, migrations)).toThrow(/Migration 2/);
    expect(() => storage.sql.exec("SELECT version FROM _migrations").toArray()).toThrow();
    expect(() => validateMigrationSequence([migrations[0]!, migrations[0]!])).toThrow(/duplicate_migration_version/);
  });
});
