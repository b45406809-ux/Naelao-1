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
  exec<T = unknown>(query: string, ...params: unknown[]): { toArray(): T[] };
}

export function createDOSqlStorage(): DOSqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: unknown[]) {
      const trimmed = query.trim();
      if (params.length === 0) {
        // Multi-statement DDL/transaction control (BEGIN/COMMIT/CREATE TABLE; ...; ALTER ...).
        // CF's DO SQLite tolerates `PRAGMA journal_mode`/`synchronous` changes inside an
        // open transaction (DOs commonly set these right after `BEGIN EXCLUSIVE` in
        // ensureInit); stock SQLite (and node:sqlite) rejects that with "Safety level may
        // not be changed inside a transaction." Both pragmas are meaningless for a
        // single-connection in-memory test database anyway — strip them.
        const stripped = trimmed.replace(/PRAGMA\s+(journal_mode|synchronous)\s*=\s*\w+\s*;?/gi, "");
        db.exec(stripped);
        return { toArray: () => [] };
      }
      const stmt = db.prepare(trimmed);
      if (/^select/i.test(trimmed)) {
        return { toArray: () => stmt.all(...(params as never[])) as never[] };
      }
      stmt.run(...(params as never[]));
      return { toArray: () => [] };
    },
  };
}
