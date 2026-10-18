import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { enqueueUsageEvent, flushUsageEventOutbox, initUsageEventOutbox } from "./usage-event-outbox";

describe("billing usage event outbox", () => {
  it("retries failed delivery and marks an idempotent event delivered once accepted", async () => {
    const storage = createDOStorage();
    initUsageEventOutbox(storage.sql as never);
    const event = { event_type: "llm_tokens", schema_version: 2, idempotency_key: "run:one", quantity: 4 };
    enqueueUsageEvent(storage.sql as never, "tenant-a", event, 1_000);
    enqueueUsageEvent(storage.sql as never, "tenant-a", event, 1_000);
    let calls = 0;
    const failed = await flushUsageEventOutbox(storage.sql as never, async () => { calls++; throw new Error("billing_unavailable"); }, 1_000);
    expect(failed).toMatchObject({ delivered: 0, failed: 1, nextAttemptAt: 11_000 });
    const early = await flushUsageEventOutbox(storage.sql as never, async () => { calls++; }, 10_999);
    expect(early).toMatchObject({ delivered: 0, failed: 0, nextAttemptAt: 11_000 });
    const retried = await flushUsageEventOutbox(storage.sql as never, async (payload, tenant) => {
      calls++;
      expect(tenant).toBe("tenant-a");
      expect(payload).toEqual(event);
    }, 11_000);
    expect(retried).toMatchObject({ delivered: 1, failed: 0, nextAttemptAt: null });
    expect(calls).toBe(2);
    expect(storage.sql.exec("SELECT status,attempts FROM billing_usage_event_outbox").toArray()).toEqual([{ status: "delivered", attempts: 2 }]);
  });

  it("rejects missing idempotency keys and oversized payloads before enqueue", () => {
    const storage = createDOStorage();
    initUsageEventOutbox(storage.sql as never);
    expect(() => enqueueUsageEvent(storage.sql as never, "tenant-a", { event_type: "x" })).toThrow("idempotency_key_required");
    expect(() => enqueueUsageEvent(storage.sql as never, "tenant-a", { idempotency_key: "key", data: "x".repeat(70_000) })).toThrow("payload_too_large");
  });
});
