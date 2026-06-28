// DO SQLite helper — enforces ? placeholder-only pattern
// this.ctx.storage.sql.exec() is the CF DO SQLite API

export interface SqlStorage {
  exec(query: string, ...params: unknown[]): SqlStorageCursor;
}

export interface SqlStorageCursor {
  toArray<T = Record<string, unknown>>(): T[];
  one<T = Record<string, unknown>>(): T;
  raw<T extends unknown[]>(): IterableIterator<T>;
}

/** Run a query and return all rows as typed objects */
export function queryAll<T>(
  sql: SqlStorage,
  query: string,
  ...params: unknown[]
): T[] {
  return sql.exec(query, ...params).toArray<T>();
}

/** Run a query and return the first row or null */
export function queryOne<T>(
  sql: SqlStorage,
  query: string,
  ...params: unknown[]
): T | null {
  const rows = sql.exec(query, ...params).toArray<T>();
  return rows[0] ?? null;
}

/** Run a query that expects exactly one row */
export function queryOneOrThrow<T>(
  sql: SqlStorage,
  query: string,
  ...params: unknown[]
): T {
  const row = queryOne<T>(sql, query, ...params);
  if (row === null) throw new Error("Expected one row, got zero");
  return row;
}

/** Execute a statement (INSERT/UPDATE/DELETE) */
export function execute(
  sql: SqlStorage,
  query: string,
  ...params: unknown[]
): void {
  sql.exec(query, ...params);
}

/** Run multiple statements in order (no params — use for schema/pragmas) */
export function execScript(sql: SqlStorage, ...statements: string[]): void {
  for (const stmt of statements) {
    sql.exec(stmt);
  }
}
