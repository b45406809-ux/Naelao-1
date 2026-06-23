import type { SqlStorage } from "./sql.js";
import { execute, queryOne } from "./sql.js";

export interface Migration {
  version: number;
  description: string;
  up: string; // SQL to apply
}

/** Apply pending migrations to a DO SQLite database */
export function applyMigrations(
  sql: SqlStorage,
  migrations: Migration[]
): void {
  // Create migration tracking table if absent
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  for (const m of sorted) {
    const existing = queryOne<{ version: number }>(
      sql,
      "SELECT version FROM _migrations WHERE version = ?",
      m.version
    );
    if (existing) continue;

    // Apply migration
    sql.exec(m.up);
    execute(
      sql,
      "INSERT INTO _migrations (version, description) VALUES (?, ?)",
      m.version,
      m.description
    );
  }
}
