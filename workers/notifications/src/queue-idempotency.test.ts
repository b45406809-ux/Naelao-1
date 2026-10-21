import { describe, expect, it, vi } from "vitest";
import { queue } from "./index.js";

describe("notification queue idempotency", () => {
  it("keys in-app records by the queue message id on redelivery", async () => {
    const runs: Array<unknown[]> = [];
    const run = vi.fn(async () => undefined);
    const prepare = vi.fn((sql: string) => ({
      bind: (...values: unknown[]) => {
        runs.push([sql, ...values]);
        return { run };
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

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT OR IGNORE INTO notifications"));
    expect(runs.map(([, id]) => id)).toEqual(["in-app:message-11", "in-app:message-11"]);
    expect(run).toHaveBeenCalledTimes(2); // D1's INSERT OR IGNORE safely absorbs the replay.
    expect(firstAck).toHaveBeenCalledOnce();
    expect(retryAck).toHaveBeenCalledOnce();
  });
});
