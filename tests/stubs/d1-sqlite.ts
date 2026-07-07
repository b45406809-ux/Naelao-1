// A real-SQLite-backed D1Database stand-in for unit tests that want to exercise actual SQL
// (migrations, partial-unique-index upserts, WHERE clauses) rather than hand-rolled regex mocks.
// Backed by node:sqlite (Node 22+, experimental) — in-memory, one instance per test.
//
// Loaded via createRequire rather than a static `import` because Vite's dev-time ESM resolver
// doesn't yet recognise node:sqlite as a built-in and fails to resolve it at transform time.
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

interface FakeD1Statement {
  bind(...args: unknown[]): FakeD1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface FakeD1 {
  db: DatabaseSync;
  prepare(sql: string): FakeD1Statement;
  batch(statements: FakeD1Statement[]): Promise<{ meta: { changes: number } }[]>;
}

/** Create an in-memory SQLite database and a D1-shaped facade over it. */
export function createFakeD1(schemaSql: string[]): FakeD1 {
  const db = new DatabaseSync(":memory:");
  for (const stmt of schemaSql) db.exec(stmt);
  return {
    db,
    prepare(sql: string) {
      // Real D1's PreparedStatement exposes first()/all()/run() directly (no bind() required
      // for parameterless queries) AND after bind() — mirror both so callers that skip bind()
      // for a param-free query (workers/admin's /admin/feature-flags GET, /admin/stats) work
      // exactly like they do against a real D1Database.
      const makeStatement = (args: unknown[]): FakeD1Statement => ({
        bind: (...nextArgs: unknown[]) => makeStatement(nextArgs),
        async first<T>(): Promise<T | null> {
          const row = db.prepare(sql).get(...(args as never[]));
          return (row ?? null) as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const rows = db.prepare(sql).all(...(args as never[]));
          return { results: rows as T[] };
        },
        async run(): Promise<{ meta: { changes: number } }> {
          const result = db.prepare(sql).run(...(args as never[]));
          return { meta: { changes: Number(result.changes) } };
        },
      });
      return makeStatement([]);
    },
    // Real D1's batch() runs an array of prepared statements sequentially, atomically (all
    // committed together or none at all) — mirror that with an explicit transaction rather than
    // just looping .run() calls, so a test exercising partial-failure rollback behavior would
    // see the same semantics as production. Added because NO existing test in this codebase
    // exercised `.batch()` at all, which is exactly how workers/auth's /register route shipped
    // with three real column-name bugs (see that file's own comment) undetected — schema
    // mismatches inside a batch() call were structurally untestable until now.
    async batch(statements: FakeD1Statement[]): Promise<{ meta: { changes: number } }[]> {
      db.exec("BEGIN");
      try {
        const results: { meta: { changes: number } }[] = [];
        for (const stmt of statements) {
          results.push(await stmt.run());
        }
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
