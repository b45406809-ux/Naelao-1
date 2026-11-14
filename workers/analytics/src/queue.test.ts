import { describe, expect, it, vi } from "vitest";
import { queue } from "./index.js";

describe("analytics queue erasure markers", () => {
  it("writes a user-erased marker without retaining a user id", async () => {
    const writeDataPoint = vi.fn();
    const message = {
      body: {
        eventType: "user_erased",
        tenantId: "org-a",
        metadata: { erasedAt: "2026-10-21T00:00:00.000Z", reason: "requested" },
      },
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await queue({ messages: [message] } as never, { ANALYTICS: { writeDataPoint } } as never);

    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      indexes: ["user_erased", "org-a", "", "", ""],
      blobs: ["", "", "", "", JSON.stringify({ erasedAt: "2026-10-21T00:00:00.000Z", reason: "requested" })],
    }));
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries an invalid event to the configured DLQ instead of silently acknowledging it", async () => {
    const writeDataPoint = vi.fn();
    const message = { body: { eventType: "invalid" }, ack: vi.fn(), retry: vi.fn() };
    await queue({ messages: [message] } as never, { ANALYTICS: { writeDataPoint } } as never);
    expect(writeDataPoint).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});
