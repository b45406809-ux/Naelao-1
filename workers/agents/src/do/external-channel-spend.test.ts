import { describe, expect, it, vi } from "vitest";
import { externalAnswerCredits, releaseExternalAnswerSpend, settleExternalAnswerSpend } from "./external-channel-spend.js";

describe("direct external answer spend", () => {
  it("uses provider usage when present and the reserved estimate when usage is absent", () => {
    expect(externalAnswerCredits({ model: "local/test-model", usage: { input_tokens: 100, output_tokens: 20 }, estimatedCredits: 99 }))
      .toBeGreaterThan(0);
    expect(externalAnswerCredits({ model: "local/test-model", estimatedCredits: 7 })).toBe(7);
  });

  it("settles a successful answer once and releases a reservation after inference failure", async () => {
    const settle = vi.fn(async (_credits: number) => undefined);
    const markSettled = vi.fn();
    await settleExternalAnswerSpend({ reserved: true, credits: 4, settle, markSettled });
    await settleExternalAnswerSpend({ reserved: false, credits: 4, settle, markSettled });
    await releaseExternalAnswerSpend({ reserved: true, settle, markSettled });
    expect(settle.mock.calls).toEqual([[4], [0]]);
    expect(markSettled).toHaveBeenCalledTimes(2);
  });
});
