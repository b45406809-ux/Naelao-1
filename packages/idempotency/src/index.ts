// Idempotency key store (D1), check-before-execute pattern

export interface IdempotencyRecord {
  key: string;
  tenant_id: string;
  status: "pending" | "completed" | "failed";
  response_body: string | null;
  response_status: number | null;
  created_at: string;
  expires_at: string;
  request_hash?: string;
}

export interface IdempotencyLockOptions {
  resourceType?: string;
  /** Hash of the canonical request body, used to reject accidental key reuse for different requests. */
  requestHash?: string;
}

export interface IdempotencyStore {
  check(key: string, tenantId: string): Promise<IdempotencyRecord | null>;
  lock(
    key: string,
    tenantId: string,
    ttlSeconds: number,
    options?: IdempotencyLockOptions
  ): Promise<boolean>;
  complete(
    key: string,
    tenantId: string,
    status: number,
    body: string
  ): Promise<void>;
  fail(key: string, tenantId: string, error: string): Promise<void>;
}

interface StoredIdempotencyRow {
  id: string;
  tenant_id: string;
  resource_type: string;
  status: "locked" | "completed" | "failed";
  request_hash: string;
  response_json: string | null;
  error_code: string | null;
  created_at: string;
  expires_at: string;
}

const MAX_TTL_SECONDS = 86_400;
const MAX_KEY_LENGTH = 256;
const MAX_TENANT_LENGTH = 256;

function validateIdentity(key: string, tenantId: string): void {
  if (!key || key.length > MAX_KEY_LENGTH || key.includes("\u0000"))
    throw new Error("invalid_idempotency_key");
  if (
    !tenantId ||
    tenantId.length > MAX_TENANT_LENGTH ||
    tenantId.includes("\u0000")
  )
    throw new Error("invalid_idempotency_tenant");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

async function storageId(key: string, tenantId: string): Promise<string> {
  const input = new TextEncoder().encode(`${tenantId}\u0000${key}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return `ik_${toHex(new Uint8Array(digest))}`;
}

async function hashValue(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return toHex(new Uint8Array(digest));
}

function mapStoredRow(
  key: string,
  row: StoredIdempotencyRow
): IdempotencyRecord {
  if (
    row.status !== "locked" &&
    row.status !== "completed" &&
    row.status !== "failed"
  ) {
    throw new Error("idempotency_record_corrupt");
  }
  let responseBody: string | null = null;
  let responseStatus: number | null = null;
  if (row.status === "completed" && row.response_json !== null) {
    const saved = JSON.parse(row.response_json) as {
      status?: unknown;
      body?: unknown;
    };
    if (
      !Number.isInteger(saved.status) ||
      typeof saved.status !== "number" ||
      saved.status < 100 ||
      saved.status > 599 ||
      !("body" in saved)
    ) {
      throw new Error("idempotency_record_corrupt");
    }
    responseStatus = saved.status;
    const serializedBody = JSON.stringify(saved.body);
    if (serializedBody === undefined)
      throw new Error("idempotency_record_corrupt");
    responseBody = serializedBody;
  } else if (row.status === "failed") {
    responseBody = row.error_code;
  }
  return {
    key,
    tenant_id: row.tenant_id,
    status: row.status === "locked" ? "pending" : row.status,
    response_body: responseBody,
    response_status: responseStatus,
    created_at: row.created_at,
    expires_at: row.expires_at,
    request_hash: row.request_hash,
  };
}

export class D1IdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: D1Database) {}

  async check(
    key: string,
    tenantId: string
  ): Promise<IdempotencyRecord | null> {
    validateIdentity(key, tenantId);
    const id = await storageId(key, tenantId);
    const row = await this.db
      .prepare(
        `SELECT id, tenant_id, resource_type, status, request_hash, response_json, error_code, created_at, expires_at
         FROM idempotency_keys
         WHERE id = ? AND tenant_id = ? AND julianday(expires_at) > julianday('now')`
      )
      .bind(id, tenantId)
      .first<StoredIdempotencyRow>();
    return row ? mapStoredRow(key, row) : null;
  }

  async lock(
    key: string,
    tenantId: string,
    ttlSeconds: number,
    options: IdempotencyLockOptions = {}
  ): Promise<boolean> {
    validateIdentity(key, tenantId);
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new Error("invalid_idempotency_ttl");
    }
    const resourceType = options.resourceType ?? "api_call";
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(resourceType))
      throw new Error("invalid_idempotency_resource_type");
    const id = await storageId(key, tenantId);
    const requestHash = options.requestHash ?? (await hashValue(key));
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestHash))
      throw new Error("invalid_idempotency_request_hash");
    const now = Date.now();
    const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
    const result = await this.db
      .prepare(
        `INSERT INTO idempotency_keys (id, tenant_id, resource_type, status, request_hash, expires_at)
         VALUES (?, ?, ?, 'locked', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           resource_type = excluded.resource_type,
           status = 'locked',
           request_hash = excluded.request_hash,
           response_json = NULL,
           error_code = NULL,
           expires_at = excluded.expires_at,
           created_at = datetime('now'),
           completed_at = NULL
         WHERE julianday(idempotency_keys.expires_at) <= julianday('now')`
      )
      .bind(id, tenantId, resourceType, requestHash, expiresAt)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async complete(
    key: string,
    tenantId: string,
    status: number,
    body: string
  ): Promise<void> {
    validateIdentity(key, tenantId);
    if (!Number.isInteger(status) || status < 100 || status > 599)
      throw new Error("invalid_idempotency_response_status");
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body) as unknown;
    } catch {
      throw new Error("invalid_idempotency_response_body");
    }
    const id = await storageId(key, tenantId);
    const result = await this.db
      .prepare(
        `UPDATE idempotency_keys
         SET status = 'completed', response_json = ?, completed_at = datetime('now'), error_code = NULL
         WHERE id = ? AND tenant_id = ? AND status = 'locked' AND julianday(expires_at) > julianday('now')`
      )
      .bind(JSON.stringify({ status, body: parsedBody }), id, tenantId)
      .run();
    if ((result.meta.changes ?? 0) === 0)
      throw new Error("idempotency_lock_lost");
  }

  async fail(key: string, tenantId: string, error: string): Promise<void> {
    validateIdentity(key, tenantId);
    const id = await storageId(key, tenantId);
    const result = await this.db
      .prepare(
        `UPDATE idempotency_keys SET status = 'failed', error_code = ?, response_json = NULL
         WHERE id = ? AND tenant_id = ? AND status = 'locked'`
      )
      .bind(error.slice(0, 128), id, tenantId)
      .run();
    if ((result.meta.changes ?? 0) === 0)
      throw new Error("idempotency_lock_lost");
  }
}

// Higher-order function: execute with idempotency check
export async function withIdempotency<T>(
  store: IdempotencyStore,
  key: string,
  tenantId: string,
  ttlSeconds: number,
  execute: () => Promise<{ status: number; body: T }>,
  options: IdempotencyLockOptions = {}
): Promise<{ status: number; body: T; fromCache: boolean }> {
  validateIdentity(key, tenantId);
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > MAX_TTL_SECONDS
  ) {
    throw new Error("invalid_idempotency_ttl");
  }
  const existing = await store.check(key, tenantId);
  if (existing) {
    if (
      options.requestHash &&
      existing.request_hash &&
      options.requestHash !== existing.request_hash
    ) {
      throw Object.assign(
        new Error("Idempotency key was already used for a different request"),
        { error_code: "key_reused" }
      );
    }
    if (
      existing.status === "completed" &&
      existing.response_body !== null &&
      existing.response_status !== null
    ) {
      return {
        status: existing.response_status,
        body: JSON.parse(existing.response_body) as T,
        fromCache: true,
      };
    }
    if (existing.status === "pending") {
      throw Object.assign(new Error("Request is still being processed"), {
        error_code: "conflict",
      });
    }
    if (existing.status === "failed") {
      throw Object.assign(
        new Error("A request with this idempotency key has failed"),
        { error_code: "failed" }
      );
    }
  }

  const locked = await store.lock(key, tenantId, ttlSeconds, options);
  if (!locked) {
    const raced = await store.check(key, tenantId);
    if (
      options.requestHash &&
      raced?.request_hash &&
      options.requestHash !== raced.request_hash
    ) {
      throw Object.assign(
        new Error("Idempotency key was already used for a different request"),
        { error_code: "key_reused" }
      );
    }
    if (
      raced?.status === "completed" &&
      raced.response_body !== null &&
      raced.response_status !== null
    ) {
      return {
        status: raced.response_status,
        body: JSON.parse(raced.response_body) as T,
        fromCache: true,
      };
    }
    throw Object.assign(new Error("Concurrent request in progress"), {
      error_code: "conflict",
    });
  }

  try {
    const result = await execute();
    if (
      !Number.isInteger(result.status) ||
      result.status < 100 ||
      result.status > 599
    ) {
      throw new Error("invalid_idempotency_response_status");
    }
    const serializedBody = JSON.stringify(result.body);
    if (serializedBody === undefined)
      throw new Error("invalid_idempotency_response_body");
    await store.complete(key, tenantId, result.status, serializedBody);
    return { ...result, fromCache: false };
  } catch (err) {
    try {
      await store.fail(key, tenantId, "execution_failed");
    } catch {
      // Preserve the execution or persistence error; an expired lock cannot safely be overwritten.
    }
    throw err;
  }
}
