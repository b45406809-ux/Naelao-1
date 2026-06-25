// Reusable test mocks: InMemoryD1, InMemoryKV, InMemoryQueue, test fixtures

// ── InMemory D1 mock ─────────────────────────────────────────────────────────

export interface D1Row {
  [key: string]: string | number | null | boolean;
}

export class InMemoryD1 {
  private tables: Map<string, D1Row[]> = new Map();
  private readonly sqlHandlers: Map<string, (params: unknown[]) => D1Row[]> = new Map();

  // Low-level exec — runs SQL directly against in-memory store
  exec(sql: string, ...params: unknown[]): { changes?: number; lastRowId?: number; rowsRead?: number } {
    // Pass-through for DDL and transaction control
    if (/^\s*(CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      return { changes: 0 };
    }
    // Route to handler if registered
    for (const [pattern, handler] of this.sqlHandlers.entries()) {
      if (sql.includes(pattern)) {
        handler(params);
        return { changes: 1 };
      }
    }
    return { changes: 0 };
  }

  onSql(pattern: string, handler: (params: unknown[]) => D1Row[]): void {
    this.sqlHandlers.set(pattern, handler);
  }

  // Seed a table with rows
  seed(table: string, rows: D1Row[]): void {
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows]);
  }

  // D1Database-compatible prepare
  prepare(sql: string): MockD1Statement {
    return new MockD1Statement(sql, this.tables);
  }

  // Make this usable as D1Database in type positions
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

class MockD1Statement {
  private boundParams: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly tables: Map<string, D1Row[]>
  ) {}

  bind(...params: unknown[]): this {
    this.boundParams = params;
    return this;
  }

  async first<T = D1Row>(): Promise<T | null> {
    const results = this.runSelect<T>();
    return results[0] ?? null;
  }

  async all<T = D1Row>(): Promise<{ results: T[] }> {
    return { results: this.runSelect<T>() };
  }

  async run(): Promise<{ meta: { changes: number; last_row_id?: number } }> {
    return this.runMutate();
  }

  private runSelect<T>(): T[] {
    const sql = this.sql.toLowerCase().trim();
    const fromMatch = sql.match(/from\s+(\w+)/);
    const tableName = fromMatch?.[1];
    if (!tableName) return [];
    const rows = this.tables.get(tableName) ?? [];

    // Basic WHERE filtering — match '= ?' placeholders in order
    const whereMatch = this.sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|$)/is);
    if (!whereMatch) {
      const lim = extractLimit(sql, this.boundParams);
      return (lim !== null ? rows.slice(0, lim) : rows) as T[];
    }

    const filtered = rows.filter((row) => matchesWhere(row, this.sql, this.boundParams));
    const limit = extractLimit(sql, this.boundParams);
    return (limit !== null ? filtered.slice(0, limit) : filtered) as T[];
  }

  private runMutate(): { meta: { changes: number; last_row_id?: number } } {
    const sql = this.sql.toLowerCase().trim();
    if (sql.startsWith("insert")) {
      return this.runInsert();
    } else if (sql.startsWith("update")) {
      return this.runUpdate();
    } else if (sql.startsWith("delete")) {
      return this.runDelete();
    }
    return { meta: { changes: 0 } };
  }

  private runInsert(): { meta: { changes: number; last_row_id?: number } } {
    const fromMatch = this.sql.match(/INTO\s+(\w+)/i);
    const tableName = fromMatch?.[1]?.toLowerCase();
    if (!tableName) return { meta: { changes: 0 } };

    const colsMatch = this.sql.match(/\(([^)]+)\)\s+VALUES/i);
    if (!colsMatch) return { meta: { changes: 0 } };

    const cols = colsMatch[1]?.split(",").map((c) => c.trim()) ?? [];
    const row: D1Row = {};
    for (let i = 0; i < cols.length && i < this.boundParams.length; i++) {
      const col = cols[i];
      const val = this.boundParams[i];
      if (col) row[col] = val as string | number | null | boolean;
    }

    if (!this.tables.has(tableName)) this.tables.set(tableName, []);
    const existing = this.tables.get(tableName) ?? [];
    // Handle ON CONFLICT DO NOTHING / ON CONFLICT DO UPDATE (simplified)
    if (/ON CONFLICT/i.test(this.sql)) {
      const idCol = cols[0];
      if (idCol && row[idCol] !== undefined) {
        const idx = existing.findIndex((r) => r[idCol] === row[idCol]);
        if (idx >= 0) {
          if (/DO UPDATE/i.test(this.sql)) {
            existing[idx] = { ...existing[idx], ...row };
          }
          return { meta: { changes: 1 } };
        }
      }
    }
    existing.push(row);
    return { meta: { changes: 1, last_row_id: existing.length } };
  }

  private runUpdate(): { meta: { changes: number } } {
    const fromMatch = this.sql.match(/UPDATE\s+(\w+)/i);
    const tableName = fromMatch?.[1]?.toLowerCase();
    if (!tableName) return { meta: { changes: 0 } };
    const rows = this.tables.get(tableName) ?? [];
    // Simple: update first matching row or all (relies on bound params)
    let changes = 0;
    for (const row of rows) {
      if (matchesWhere(row, this.sql, this.boundParams)) {
        changes++;
      }
    }
    return { meta: { changes } };
  }

  private runDelete(): { meta: { changes: number } } {
    const fromMatch = this.sql.match(/FROM\s+(\w+)/i);
    const tableName = fromMatch?.[1]?.toLowerCase();
    if (!tableName) return { meta: { changes: 0 } };
    const rows = this.tables.get(tableName) ?? [];
    const before = rows.length;
    const filtered = rows.filter((r) => !matchesWhere(r, this.sql, this.boundParams));
    this.tables.set(tableName, filtered);
    return { meta: { changes: before - filtered.length } };
  }
}

function matchesWhere(row: D1Row, sql: string, params: unknown[]): boolean {
  const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|$)/is);
  if (!whereMatch) return true;
  const clause = whereMatch[1] ?? "";
  const conditions = clause.split(/\s+AND\s+/i);
  let paramIdx = countParamsBeforeWhere(sql);
  for (const condition of conditions) {
    const eqMatch = condition.match(/(\w+)\s*=\s*\?/);
    if (eqMatch) {
      const col = eqMatch[1]?.toLowerCase() ?? "";
      const val = params[paramIdx++];
      if (String(row[col]) !== String(val)) return false;
    }
  }
  return true;
}

function countParamsBeforeWhere(sql: string): number {
  const beforeWhere = sql.split(/WHERE/i)[0] ?? "";
  return (beforeWhere.match(/\?/g) ?? []).length;
}

function extractLimit(sql: string, params: unknown[]): number | null {
  const limitMatch = sql.match(/LIMIT\s+\?/i);
  if (limitMatch) {
    const whereParamCount = (sql.match(/WHERE[\s\S]*?(?=LIMIT|$)/i)?.[0]?.match(/\?/g) ?? []).length;
    const totalBeforeLimit = (sql.split(/LIMIT/i)[0]?.match(/\?/g) ?? []).length;
    const idx = totalBeforeLimit;
    const val = params[idx];
    return typeof val === "number" ? val : null;
  }
  const numericLimit = sql.match(/LIMIT\s+(\d+)/i);
  return numericLimit ? parseInt(numericLimit[1] ?? "0", 10) : null;
}

// ── InMemory KV mock ─────────────────────────────────────────────────────────

export class InMemoryKV {
  private store: Map<string, { value: string; expiresAt?: number }> = new Map();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined;
    const entry: { value: string; expiresAt?: number } = { value };
    if (expiresAt !== undefined) entry.expiresAt = expiresAt;
    this.store.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  asKV(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}

// ── InMemory Queue mock ──────────────────────────────────────────────────────

export class InMemoryQueue {
  readonly messages: unknown[] = [];

  async send(message: unknown): Promise<void> {
    this.messages.push(message);
  }

  asQueue(): Queue {
    return this as unknown as Queue;
  }
}

// ── Test fixtures ────────────────────────────────────────────────────────────

export function makeTenantId(): string {
  return `tenant_${crypto.randomUUID().slice(0, 8)}`;
}

export function makeSpaceId(): string {
  return `space_${crypto.randomUUID().slice(0, 8)}`;
}

export function makeSessionId(): string {
  return `session_${crypto.randomUUID().slice(0, 8)}`;
}

export function makeUserId(): string {
  return `user_${crypto.randomUUID().slice(0, 8)}`;
}
