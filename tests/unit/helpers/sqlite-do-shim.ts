/**
 * A real in-memory SQLite engine (Node's built-in `node:sqlite`, Node 22+) wrapped to look
 * like a Durable Object's `ctx.storage.sql` (the `SqlStorage` interface from @naelao/db /
 * @cloudflare/workers-types: `.exec(query, ...params)` returning `{ toArray() }`).
 *
 * This lets DO classes (SpaceDO, NaelaoAgentDO, ...) be unit-tested by running their REAL
 * `applyMigrations`/SQL against a real engine, instead of hand-rolling a regex-matching fake
 * per test file (fragile — see memory-os.test.ts's fakeSql, kept as-is since it predates this
 * helper, but new DO tests should prefer this).
 */
import { createRequire } from "node:module";

// Vite's builtin-module allowlist predates node:sqlite (still experimental as of Node 22),
// so a static `import ... from "node:sqlite"` gets mis-resolved as a bare package by Vite's
// dev-transform pipeline. Routing through Node's own `require` sidesteps Vite entirely.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface DOSqlStorage {
  exec<T = unknown>(query: string, ...params: unknown[]): { toArray(): T[]; rowsWritten: number };
}

/** ctx.storage's JS transaction API — real Cloudflare DO SQLite storage requires
 *  transactionSync()/transaction() instead of raw SQL BEGIN/COMMIT (see @naelao/db's
 *  applyMigrations). node:sqlite has no such restriction, so this wraps the closure in a
 *  real transaction against the same in-memory engine, which is a true test double —
 *  a thrown exception rolls back exactly like the real API's own guarantee. */
export interface DOStorage {
  sql: DOSqlStorage;
  transactionSync<T>(closure: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

function buildStorage(db: InstanceType<typeof DatabaseSync>): DOStorage {
  let alarm: number | null = null;
  const sql: DOSqlStorage = {
    exec(query: string, ...params: unknown[]) {
      const trimmed = query.trim();
      // A SELECT always goes through a prepared statement, REGARDLESS of param count — a
      // param-less "SELECT * FROM t" (no WHERE-clause placeholders) is a legitimate query real
      // DO SqlStorage.exec() returns rows for (see SpaceTypeRegistryDO's `GET /types`, which
      // does exactly this). The old `params.length === 0` branch below used to swallow this
      // case into the DDL path (db.exec() executes but discards results), silently returning
      // empty rows for any param-less SELECT.
      if (/^select/i.test(trimmed)) {
        return { toArray: () => db.prepare(trimmed).all(...(params as never[])) as never[], rowsWritten: 0 };
      }
      if (params.length === 0) {
        // Multi-statement DDL (CREATE TABLE; ...; ALTER ...), or a single non-SELECT statement
        // with no placeholders (e.g. "DELETE FROM buckets"). Real CF DO SQLite storage rejects
        // PRAGMA journal_mode/synchronous changes and raw BEGIN/SAVEPOINT/COMMIT transaction
        // control outright — production code must never send these (see CLAUDE.md's "DO SQLite
        // Pattern" and @naelao/db's applyMigrations, which now uses transactionSync() below
        // instead of raw SQL). Stripped here defensively in case a stray one shows up anyway.
        const stripped = trimmed.replace(/PRAGMA\s+(journal_mode|synchronous)\s*=\s*\w+\s*;?/gi, "");
        db.exec(stripped);
        return { toArray: () => [], rowsWritten: 0 };
      }
      const stmt = db.prepare(trimmed);
      const result = stmt.run(...(params as never[]));
      return { toArray: () => [], rowsWritten: Number(result.changes ?? 0) };
    },
  };
  return {
    sql,
    transactionSync<T>(closure: () => T): T {
      db.exec("BEGIN");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async getAlarm() { return alarm; },
    async setAlarm(scheduledTime: number | Date) { alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime; },
    async deleteAlarm() { alarm = null; },
  };
}

/** Back-compat: most call sites only ever needed `.sql` (ctx.storage.sql). Prefer
 *  createDOStorage() for any DO whose ensureInit() calls applyMigrations (SpaceDO,
 *  ProductUserDO) — it needs ctx.storage.transactionSync, not just ctx.storage.sql. */
export function createDOSqlStorage(): DOSqlStorage {
  return buildStorage(new DatabaseSync(":memory:")).sql;
}

/** Full ctx.storage double: { sql, transactionSync }, backed by one shared in-memory engine. */
export function createDOStorage(): DOStorage {
  return buildStorage(new DatabaseSync(":memory:"));
}
