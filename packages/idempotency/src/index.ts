// Idempotency key store (D1), check-before-execute pattern

export interface IdempotencyRecord {
  key: string;
  tenant_id: string;
  status: "pending" | "completed" | "failed";
  response_body: string | null;
  response_status: number | null;
  created_at: string;
  expires_at: string;
}

export interface IdempotencyStore {
  check(key: string, tenantId: string): Promise<IdempotencyRecord | null>;
  lock(key: string, tenantId: string, ttlSeconds: number): Promise<boolean>;
  complete(key: string, tenantId: string, status: number, body: string): Promise<void>;
  fail(key: string, tenantId: string, error: string): Promise<void>;
}

export class D1IdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: D1Database) {}

  async check(key: string, tenantId: string): Promise<IdempotencyRecord | null> {
    const row = await this.db.prepare(
      "SELECT key, tenant_id, status, response_body, response_status, created_at, expires_at FROM idempotency_keys WHERE key = ? AND tenant_id = ? AND expires_at > datetime('now')"
    ).bind(key, tenantId).first<IdempotencyRecord>();
    return row ?? null;
  }

  async lock(key: string, tenantId: string, ttlSeconds: number): Promise<boolean> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    try {
      await this.db.prepare(
        "INSERT INTO idempotency_keys (key, tenant_id, status, response_body, response_status, created_at, expires_at) VALUES (?, ?, 'pending', NULL, NULL, ?, ?)"
      ).bind(key, tenantId, now, expiresAt).run();
      return true;
    } catch {
      // Unique constraint violation — key already exists
      return false;
    }
  }

  async complete(key: string, tenantId: string, status: number, body: string): Promise<void> {
    await this.db.prepare(
      "UPDATE idempotency_keys SET status = 'completed', response_status = ?, response_body = ? WHERE key = ? AND tenant_id = ?"
    ).bind(status, body, key, tenantId).run();
  }

  async fail(key: string, tenantId: string, error: string): Promise<void> {
    await this.db.prepare(
      "UPDATE idempotency_keys SET status = 'failed', response_body = ? WHERE key = ? AND tenant_id = ?"
    ).bind(error, key, tenantId).run();
  }
}

// Higher-order function: execute with idempotency check
export async function withIdempotency<T>(
  store: IdempotencyStore,
  key: string,
  tenantId: string,
  ttlSeconds: number,
  execute: () => Promise<{ status: number; body: T }>
): Promise<{ status: number; body: T; fromCache: boolean }> {
  const existing = await store.check(key, tenantId);
  if (existing) {
    if (existing.status === "completed" && existing.response_body !== null && existing.response_status !== null) {
      return {
        status: existing.response_status,
        body: JSON.parse(existing.response_body) as T,
        fromCache: true,
      };
    }
    if (existing.status === "pending") {
      throw Object.assign(new Error("Request is still being processed"), { error_code: "conflict" });
    }
  }

  const locked = await store.lock(key, tenantId, ttlSeconds);
  if (!locked) {
    throw Object.assign(new Error("Concurrent request in progress"), { error_code: "conflict" });
  }

  try {
    const result = await execute();
    await store.complete(key, tenantId, result.status, JSON.stringify(result.body));
    return { ...result, fromCache: false };
  } catch (err) {
    await store.fail(key, tenantId, String(err));
    throw err;
  }
}
