import { describe, expect, it, vi } from "vitest";
import { dispatchDunningOutbox } from "./dunning-outbox.js";

const workflowId = `dunning-${"a".repeat(64)}`;
const row = {
  workflow_id: workflowId,
  tenant_id: "org-1",
  payload_json: JSON.stringify({
    type: "dunning", workflow_id: workflowId, scope: "platform_subscription", orgId: "org-1",
    provider: "lemon_squeezy", subscriptionId: "sub-1", providerEventId: "evt-1", providerUpdatedAt: null,
  }),
  attempt_count: 1,
};

function env(send = vi.fn(async () => undefined), payloadJson = row.payload_json) {
  const updates: Array<{ query: string; values: unknown[] }> = [];
  const db = {
    prepare(query: string) {
      return { bind: (...values: unknown[]) => ({
        async all() { return { results: [{ ...row, payload_json: payloadJson }] }; },
        async run() { updates.push({ query, values }); return { meta: { changes: 1 } }; },
      }) };
    },
  } as unknown as D1Database;
  return { PLATFORM_DB: db, DUNNING_EVENTS: { send }, send, updates };
}

describe("durable dunning outbox", () => {
  it("leases, dispatches and marks a stable workflow intent sent", async () => {
    const context = env();
    const result = await dispatchDunningOutbox(context, new Date("2026-11-12T15:00:00.000Z"));
    expect(result).toEqual({ claimed: 1, sent: 1, deferred: 0 });
    expect(context.send).toHaveBeenCalledWith(JSON.parse(row.payload_json));
    expect(context.updates).toHaveLength(1);
    expect(context.updates[0]?.query).toContain("status='sent'");
    expect(context.updates[0]?.values[2]).toBe(workflowId);
  });

  it("releases failed queue sends with bounded retry timing", async () => {
    const context = env(vi.fn(async () => { throw new Error("queue unavailable"); }));
    const result = await dispatchDunningOutbox(context, new Date("2026-11-12T15:00:00.000Z"));
    expect(result).toEqual({ claimed: 1, sent: 0, deferred: 1 });
    expect(context.updates[0]?.query).toContain("status='pending'");
    expect(context.updates[0]?.values[0]).toBe("2026-11-12T15:00:30.000Z");
    expect(context.updates[0]?.values[1]).toBe("dispatch_failed");
  });

  it("keeps legacy version-one payloads readable but defers malformed versioned events", async () => {
    const legacy = env();
    expect(await dispatchDunningOutbox(legacy, new Date("2026-11-12T15:00:00.000Z")))
      .toEqual({ claimed: 1, sent: 1, deferred: 0 });

    const invalidPayload = JSON.stringify({
      ...JSON.parse(row.payload_json), version: 2, providerUpdatedAt: "not-a-timestamp",
    });
    const invalid = env(vi.fn(async () => undefined), invalidPayload);
    expect(await dispatchDunningOutbox(invalid, new Date("2026-11-12T15:00:00.000Z")))
      .toEqual({ claimed: 1, sent: 0, deferred: 1 });
    expect(invalid.send).not.toHaveBeenCalled();
    expect(invalid.updates[0]?.query).toContain("status='pending'");
  });

  it("rejects invalid batch bounds before touching storage", async () => {
    const context = env();
    await expect(dispatchDunningOutbox(context, new Date(), 101)).rejects.toThrow("billing_dunning_outbox_limit_invalid");
    expect(context.send).not.toHaveBeenCalled();
  });
});
