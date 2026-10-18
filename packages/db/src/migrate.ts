import type { SqlStorage } from "./sql.js";
import { execute, queryOne } from "./sql.js";

export interface Migration {
  version: number;
  description: string;
  up: string; // SQL to apply
}

export interface MigrationRestoreFixture {
  name: string;
  fromVersion: number;
  toVersion: number;
  exportMarker: string;
  importMarker: string;
}

/** Guard additive migration plans before they reach a live DO. Historical versions are
 * immutable: a duplicate or renumbered entry must fail loudly instead of silently changing
 * what an existing reader means. */
export function validateMigrationSequence(migrations: readonly Migration[]): void {
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) throw new Error("migration_version_must_be_positive_integer");
    if (versions.has(migration.version)) throw new Error(`duplicate_migration_version:${migration.version}`);
    if (!migration.description.trim() || !migration.up.trim()) throw new Error(`migration_${migration.version}_is_incomplete`);
    versions.add(migration.version);
  }
}

/** The subset of DurableObjectStorage this needs: the raw .sql handle plus the
 *  JS transaction API. Cloudflare's real SQLite-backed DO storage REJECTS raw SQL
 *  BEGIN/SAVEPOINT/COMMIT statements outright ("please use state.storage.transaction()
 *  or transactionSync() instead") — confirmed live via wrangler tail against production,
 *  where every SpaceDO/ProductUserDO call threw on first use. The node:sqlite test shim
 *  doesn't enforce this restriction, so a prior version of this function (raw "BEGIN
 *  EXCLUSIVE"/"COMMIT"/"ROLLBACK" statements) passed ~1900 unit tests while being
 *  completely broken against the real runtime — same failure mode as the PRAGMA/
 *  SQLITE_AUTH bug documented in this repo's CLAUDE.md. */
export interface MigratableStorage {
  sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

/** Split a block of ;-terminated SQL statements into individual statements, respecting
 *  SQL string/identifier quoting (e.g. DEFAULT (datetime('now'))) and both comment styles
 *  (-- line comments, /* block comments *​/) this codebase's migrations use — a semicolon
 *  inside either is never mistaken for a statement boundary (a first version of this function
 *  didn't skip "-- ...;" line-comment text, which split "ALTER TABLE ... ADD COLUMN x TEXT; --
 *  JSON string[]; NULL = unrestricted" into a bogus standalone "NULL = unrestricted" statement
 *  — caught by the full test suite, not live traffic). Confirmed live via wrangler tail against
 *  production: a multi-statement string passed to a single sql.exec() call — which works fine
 *  OUTSIDE a transaction, per Cloudflare's own docs example — throws "SQL code did not contain
 *  a statement" when that same call happens INSIDE a storage.transactionSync() closure.
 *  Executing one statement per exec() call sidesteps that, and is required either way now that
 *  migrations run inside a transaction (see applyMigrations below). */
function splitStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | "[" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let triggerBlockDepth = 0;
  let caseDepth = 0;
  let word = "";

  // Trigger bodies contain semicolons before their final END. Keep those
  // semicolons inside the same statement or SQLite reports "incomplete input".
  const flushWord = () => {
    const normalized = word.toUpperCase();
    if (normalized === "BEGIN") triggerBlockDepth++;
    if (normalized === "CASE") caseDepth++;
    if (normalized === "END") {
      if (caseDepth > 0) caseDepth--;
      else if (triggerBlockDepth > 0) triggerBlockDepth--;
    }
    word = "";
  };
  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i];
    const next = sqlText[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (quote !== null) {
      const closing = quote === "[" ? "]" : quote;
      current += ch;
      if (ch === closing && next === closing) {
        current += next;
        i++;
      } else if (ch === closing) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      flushWord();
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "-" && next === "-") {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      current += ch;
      continue;
    }
    if (ch && /[A-Za-z_]/.test(ch)) word += ch;
    else flushWord();
    if (ch === ";" && triggerBlockDepth === 0) {
      // A chunk that's comment-only (e.g. a trailing "-- note" after the last real
      // statement's semicolon) has no SQL content — pushing it would hand sql.exec() a
      // string containing nothing but a comment, which throws "SQL code did not contain
      // a statement" just like a genuinely empty string does. Drop it rather than push it;
      // comments carry no execution semantics either way.
      if (hasSqlContent(current)) statements.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (hasSqlContent(current)) statements.push(current.trim());
  return statements;
}

function hasSqlContent(text: string): boolean {
  return text.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().length > 0;
}

/** Apply pending migrations to a DO SQLite database.
 * Wraps the entire migration block in a JS-API transaction (transactionSync) rather
 * than a raw SQL BEGIN/COMMIT — the JS API automatically rolls back on a thrown
 * exception and is the only transaction mechanism Cloudflare's real DO SQLite storage
 * accepts. Prevents concurrent migration races when a DO is initialised by two
 * requests simultaneously (G-A09).
 */
export function applyMigrations(
  storage: MigratableStorage,
  migrations: Migration[]
): void {
  validateMigrationSequence(migrations);
  const sql = storage.sql;
  storage.transactionSync(() => {
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

      for (const statement of splitStatements(m.up)) {
        try {
          sql.exec(statement);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const preview = statement.replace(/\s+/g, " ").trim().slice(0, 240);
          throw new Error(`Migration ${m.version} (${m.description}) failed: ${detail}; SQL: ${preview}`, { cause: error });
        }
      }
      execute(
        sql,
        "INSERT INTO _migrations (version, description) VALUES (?, ?)",
        m.version,
        m.description
      );
    }
  });
}
