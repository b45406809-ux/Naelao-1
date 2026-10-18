import { describe, expect, it, vi } from "vitest";
import {
  D1IdempotencyStore,
  type IdempotencyRecord,
  type IdempotencyStore,
  withIdempotency,
} from "./index.js";

function d1Stub(options: { row?: unknown; changes?: number } = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              statements.push({ sql, values });
              return options.row ?? null;
            },
            async run() {
              statements.push({ sql, values });
              return { meta: { changes: options.changes ?? 1 } };
            },
          };
        },
      };
    },
  };
  return { db: db as never, statements };
}

describe("D1 idempotency schema contract", () => {
  it("reads the deployed migration fields and maps locked to pending", async () => {
    const { db, statements } = d1Stub({
      row: {
        id: "ik_hash",
        tenant_id: "tenant-a",
        resource_type: "api_call",
        status: "locked",
        request_hash: "request-hash",
        response_json: null,
        error_code: null,
        created_at: "2026-01-01 00:00:00",
        expires_at: "2026-01-01T00:05:00.000Z",
      },
    });
    const record = await new D1IdempotencyStore(db).check("key-1", "tenant-a");
    expect(statements[0]?.sql).toContain("id = ?");
    expect(statements[0]?.sql).toContain(
      "julianday(expires_at) > julianday('now')"
    );
    expect(statements[0]?.sql).not.toMatch(/response_body|response_status/);
    expect(record).toMatchObject({
      key: "key-1",
      tenant_id: "tenant-a",
      status: "pending",
    });
  });

  it("fails closed on unknown stored statuses", async () => {
    const { db } = d1Stub({
      row: {
        id: "id",
        tenant_id: "tenant",
        resource_type: "api_call",
        status: "unexpected",
        request_hash: "hash",
        response_json: null,
        error_code: null,
        created_at: "now",
        expires_at: "later",
      },
    });
    await expect(
      new D1IdempotencyStore(db).check("key", "tenant")
    ).rejects.toThrow("idempotency_record_corrupt");
  });

  it("atomically acquires absent keys and can replace expired records", async () => {
    const { db, statements } = d1Stub({ changes: 1 });
    const store = new D1IdempotencyStore(db);
    await expect(
      store.lock("key-1", "tenant-a", 300, {
        resourceType: "billing",
        requestHash: "request-hash",
      })
    ).resolves.toBe(true);
    expect(statements[0]?.sql).toContain("ON CONFLICT(id) DO UPDATE");
    expect(statements[0]?.sql).toContain(
      "julianday(idempotency_keys.expires_at) <= julianday('now')"
    );
    expect(statements[0]?.sql).toContain("resource_type");
    expect(statements[0]?.sql).toContain("request_hash");
    expect(statements[0]?.sql).not.toContain("response_status");
  });

  it("uses a tenant-scoped storage identifier and rejects an unexpired duplicate", async () => {
    const { db, statements } = d1Stub({ changes: 0 });
    const locked = await new D1IdempotencyStore(db).lock(
      "same-key",
      "tenant-a",
      60
    );
    expect(locked).toBe(false);
    expect(statements[0]?.values[0]).not.toBe("same-key");
    expect(statements[0]?.values[1]).toBe("tenant-a");
  });

  it("does not report database outages as ordinary duplicate keys", async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
        }),
      }),
    } as never;
    await expect(
      new D1IdempotencyStore(db).lock("key", "tenant", 30)
    ).rejects.toThrow("D1 unavailable");
  });

  it("derives different storage IDs for the same caller key in separate tenants", async () => {
    const { db, statements } = d1Stub({ changes: 1 });
    const store = new D1IdempotencyStore(db);
    await store.lock("shared", "tenant-a", 60);
    await store.lock("shared", "tenant-b", 60);
    expect(statements[0]?.values[0]).not.toBe(statements[1]?.values[0]);
  });

  it.each([0, -1, 86_401, Number.NaN])(
    "rejects invalid TTL %s",
    async (ttl) => {
      const { db, statements } = d1Stub();
      await expect(
        new D1IdempotencyStore(db).lock("key", "tenant", ttl)
      ).rejects.toThrow("invalid_idempotency_ttl");
      expect(statements).toHaveLength(0);
    }
  );

  it("stores a completed response in the deployed response_json field", async () => {
    const { db, statements } = d1Stub();
    await new D1IdempotencyStore(db).complete(
      "key",
      "tenant",
      201,
      '{"created":true}'
    );
    expect(statements[0]?.sql).toContain("response_json = ?");
    expect(statements[0]?.sql).toContain("status = 'locked'");
    expect(statements[0]?.values[0]).toBe(
      '{"status":201,"body":{"created":true}}'
    );
  });

  it("maps a cached response and rejects a changed request hash", async () => {
    const row = {
      id: "ik_hash",
      tenant_id: "tenant-a",
      resource_type: "api_call",
      status: "completed",
      request_hash: "original-hash",
      response_json: '{"status":201,"body":{"id":"created"}}',
      error_code: null,
      created_at: "2026-01-01 00:00:00",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    const { db } = d1Stub({ row });
    const store = new D1IdempotencyStore(db);
    const cached = await store.check("key", "tenant-a");
    expect(cached).toMatchObject({
      status: "completed",
      response_status: 201,
      response_body: '{"id":"created"}',
      request_hash: "original-hash",
    });
    await expect(
      withIdempotency(
        store,
        "key",
        "tenant-a",
        300,
        async () => ({ status: 200, body: {} }),
        { requestHash: "new-hash" }
      )
    ).rejects.toMatchObject({ error_code: "key_reused" });
  });
});

describe("idempotent execution races", () => {
  it("returns a result completed by the winner between check and lock", async () => {
    const cached: IdempotencyRecord = {
      key: "key",
      tenant_id: "tenant",
      status: "completed",
      response_body: '{"ok":true}',
      response_status: 200,
      created_at: "now",
      expires_at: "later",
    };
    const store: IdempotencyStore = {
      check: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(cached),
      lock: vi.fn().mockResolvedValue(false),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const execute = vi.fn();
    await expect(
      withIdempotency(store, "key", "tenant", 30, execute)
    ).resolves.toEqual({
      status: 200,
      body: { ok: true },
      fromCache: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unserializable result bodies without caching them", async () => {
    const complete = vi.fn();
    const fail = vi.fn();
    const store: IdempotencyStore = {
      check: vi.fn().mockResolvedValue(null),
      lock: vi.fn().mockResolvedValue(true),
      complete,
      fail,
    };
    await expect(
      withIdempotency(store, "key", "tenant", 30, async () => ({
        status: 200,
        body: undefined,
      }))
    ).rejects.toThrow("invalid_idempotency_response_body");
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith("key", "tenant", "execution_failed");
  });
});
