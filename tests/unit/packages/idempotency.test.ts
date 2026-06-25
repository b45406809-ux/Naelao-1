// Unit tests for @naelao/idempotency (G-I-IDEM01..IDEM05)
import { describe, it, expect } from "vitest";
import { withIdempotency } from "../../../packages/idempotency/src/index.js";
import type { IdempotencyStore, IdempotencyRecord } from "../../../packages/idempotency/src/index.js";

// In-memory mock store for testing
class MockIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  async check(key: string, tenantId: string): Promise<IdempotencyRecord | null> {
    return this.records.get(`${tenantId}:${key}`) ?? null;
  }

  async lock(key: string, tenantId: string, ttlSeconds: number): Promise<boolean> {
    const storeKey = `${tenantId}:${key}`;
    if (this.records.has(storeKey)) return false;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.records.set(storeKey, {
      key, tenant_id: tenantId, status: "pending",
      response_body: null, response_status: null,
      created_at: now, expires_at: expiresAt,
    });
    return true;
  }

  async complete(key: string, tenantId: string, status: number, body: string): Promise<void> {
    const storeKey = `${tenantId}:${key}`;
    const record = this.records.get(storeKey);
    if (record) {
      record.status = "completed";
      record.response_status = status;
      record.response_body = body;
    }
  }

  async fail(key: string, tenantId: string, error: string): Promise<void> {
    const storeKey = `${tenantId}:${key}`;
    const record = this.records.get(storeKey);
    if (record) {
      record.status = "failed";
      record.response_body = error;
    }
  }
}

describe("withIdempotency (G-I-IDEM01)", () => {
  it("executes the action and returns the result", async () => {
    const store = new MockIdempotencyStore();
    const result = await withIdempotency(store, "key-1", "tenant-1", 300, async () => ({
      status: 200,
      body: { id: "res-1" },
    }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: "res-1" });
    expect(result.fromCache).toBe(false);
  });

  it("returns cached result on second call with same key", async () => {
    const store = new MockIdempotencyStore();
    let callCount = 0;
    const execute = async () => {
      callCount++;
      return { status: 201, body: { created: true } };
    };

    await withIdempotency(store, "key-dup", "tenant-1", 300, execute);
    const second = await withIdempotency(store, "key-dup", "tenant-1", 300, execute);

    expect(callCount).toBe(1); // execute only ran once
    expect(second.fromCache).toBe(true);
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ created: true });
  });

  it("throws conflict error when key is pending", async () => {
    const store = new MockIdempotencyStore();
    // Lock the key without completing
    await store.lock("key-pending", "tenant-1", 300);

    await expect(
      withIdempotency(store, "key-pending", "tenant-1", 300, async () => ({
        status: 200,
        body: {},
      }))
    ).rejects.toThrow("Request is still being processed");
  });

  it("propagates errors from execute and marks key as failed", async () => {
    const store = new MockIdempotencyStore();
    const err = new Error("downstream failure");

    await expect(
      withIdempotency(store, "key-fail", "tenant-1", 300, async () => {
        throw err;
      })
    ).rejects.toThrow("downstream failure");

    const record = await store.check("key-fail", "tenant-1");
    expect(record?.status).toBe("failed");
  });

  it("tenant isolation: same key different tenants are independent", async () => {
    const store = new MockIdempotencyStore();
    let t1Calls = 0;
    let t2Calls = 0;

    await withIdempotency(store, "shared-key", "tenant-A", 300, async () => {
      t1Calls++;
      return { status: 200, body: { tenant: "A" } };
    });

    await withIdempotency(store, "shared-key", "tenant-B", 300, async () => {
      t2Calls++;
      return { status: 200, body: { tenant: "B" } };
    });

    expect(t1Calls).toBe(1);
    expect(t2Calls).toBe(1);

    // Cached results are tenant-specific
    const cacheA = await withIdempotency(store, "shared-key", "tenant-A", 300, async () => {
      t1Calls++;
      return { status: 200, body: { tenant: "A" } };
    });
    const cacheB = await withIdempotency(store, "shared-key", "tenant-B", 300, async () => {
      t2Calls++;
      return { status: 200, body: { tenant: "B" } };
    });

    expect(cacheA.fromCache).toBe(true);
    expect(cacheB.fromCache).toBe(true);
    expect((cacheA.body as { tenant: string }).tenant).toBe("A");
    expect((cacheB.body as { tenant: string }).tenant).toBe("B");
    expect(t1Calls).toBe(1);
    expect(t2Calls).toBe(1);
  });
});

describe("MockIdempotencyStore (G-I-IDEM02)", () => {
  it("lock returns false for duplicate key", async () => {
    const store = new MockIdempotencyStore();
    const first = await store.lock("key", "tenant", 300);
    const second = await store.lock("key", "tenant", 300);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("check returns null for non-existent key", async () => {
    const store = new MockIdempotencyStore();
    const result = await store.check("no-such-key", "tenant");
    expect(result).toBeNull();
  });

  it("complete updates record status to completed", async () => {
    const store = new MockIdempotencyStore();
    await store.lock("key", "t1", 300);
    await store.complete("key", "t1", 200, '{"ok":true}');
    const record = await store.check("key", "t1");
    expect(record?.status).toBe("completed");
    expect(record?.response_status).toBe(200);
    expect(record?.response_body).toBe('{"ok":true}');
  });

  it("fail updates record status to failed", async () => {
    const store = new MockIdempotencyStore();
    await store.lock("key", "t1", 300);
    await store.fail("key", "t1", "Error: timeout");
    const record = await store.check("key", "t1");
    expect(record?.status).toBe("failed");
    expect(record?.response_body).toBe("Error: timeout");
  });
});
