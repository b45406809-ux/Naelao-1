import { describe, expect, it, vi } from "vitest";
import { queue } from "./index.js";

describe("DLQ persistence queue redelivery", () => {
  it("uses the stable queue message id so an ack-loss retry cannot duplicate the failure row", async () => {
    const run = vi.fn(async () => undefined);
    const bind = vi.fn((..._params: unknown[]) => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const firstAck = vi.fn();
    const redeliveryAck = vi.fn();
    const first = { id: "message-42", body: { type: "kb.ingest", docId: "doc-a" }, ack: firstAck, retry: vi.fn() };
    const redelivery = { id: "message-42", body: { type: "kb.ingest", docId: "doc-a" }, ack: redeliveryAck, retry: vi.fn() };

    await queue({ messages: [first, redelivery] } as never, { PLATFORM_DB: { prepare } } as never);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT OR IGNORE INTO platform_failures"));
    expect(bind.mock.calls.map(([id]) => id)).toEqual(["dlq:message-42", "dlq:message-42"]);
    expect(firstAck).toHaveBeenCalledOnce();
    expect(redeliveryAck).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(redelivery.retry).not.toHaveBeenCalled();
  });
});
