import { afterEach, describe, expect, it, vi } from "vitest";
import { queue } from "./index.js";

describe("notification queue idempotency", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keys in-app records by the queue message id on redelivery", async () => {
    const runs: Array<unknown[]> = [];
    const run = vi.fn(async () => undefined);
    const prepare = vi.fn((sql: string) => ({
      bind: (...values: unknown[]) => {
        runs.push([sql, ...values]);
        return { run, first: async () => ({ status: "active" }) };
      },
    }));
    const firstAck = vi.fn();
    const retryAck = vi.fn();
    const first = {
      id: "message-11", body: { type: "in_app", tenantId: "tenant-a", userId: "user-a", subject: "Hello", data: { id: 7 } },
      ack: firstAck, retry: vi.fn(),
    };
    const retry = {
      id: "message-11", body: first.body, ack: retryAck, retry: vi.fn(),
    };

    await queue({ messages: [first, retry] } as never, { PLATFORM_DB: { prepare } } as never);

    expect(prepare).toHaveBeenCalledWith("SELECT status FROM orgs WHERE id = ?");
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT OR IGNORE INTO notifications"));
    expect(runs.filter(([sql]) => String(sql).includes("INSERT OR IGNORE INTO notifications")).map(([, id]) => id))
      .toEqual(["in-app:message-11", "in-app:message-11"]);
    expect(run).toHaveBeenCalledTimes(2); // D1's INSERT OR IGNORE safely absorbs the replay.
    expect(firstAck).toHaveBeenCalledOnce();
    expect(retryAck).toHaveBeenCalledOnce();
  });

  it("acks a queued external delivery for a suspended tenant without sending it", async () => {
    const first = vi.fn(async () => ({ status: "suspended" }));
    const run = vi.fn();
    const prepare = vi.fn(() => ({ bind: () => ({ first, run }) }));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const ack = vi.fn();
    const retry = vi.fn();

    await queue({ messages: [{
      id: "suspended-webhook",
      body: { type: "webhook", tenantId: "tenant-a", webhookUrl: "https://example.test/hook" },
      ack,
      retry,
    }] } as never, { PLATFORM_DB: { prepare } } as never);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries queued delivery when tenant authorization cannot be checked", async () => {
    const prepare = vi.fn(() => { throw new Error("D1 unavailable"); });
    const ack = vi.fn();
    const retry = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await queue({ messages: [{
      id: "tenant-check-outage",
      body: { type: "webhook", tenantId: "tenant-a", spaceId: "space-a", webhookUrl: "https://example.test/hook" },
      ack,
      retry,
    }] } as never, { PLATFORM_DB: { prepare } } as never);

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
