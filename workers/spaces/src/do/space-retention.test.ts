import { describe, expect, it } from "vitest";
import { fingerprintRetainedMessages, forecastSpaceStorage, retainedMessageBytes, type RetainedMessageRow } from "./space-retention.js";

const rows: RetainedMessageRow[] = [{ id: "m1", session_id: "s1", role: "user", content: "hello", created_at: "2026-01-01T00:00:00Z", tool_call_id: null, tool_name: null, token_count: 1 }];

describe("Space retention accounting", () => {
  it("fingerprints exact selected rows and measures UTF-8 bytes", async () => {
    expect(await fingerprintRetainedMessages(rows)).toBe(await fingerprintRetainedMessages([...rows]));
    expect(await fingerprintRetainedMessages(rows)).not.toBe(await fingerprintRetainedMessages([{ ...rows[0]!, content: "changed" }]));
    expect(retainedMessageBytes(rows)).toBeGreaterThan(new TextEncoder().encode("hello").byteLength);
  });
  it("forecasts only from actual measurements and an explicit owner target", () => {
    expect(forecastSpaceStorage([], 1_000, 80)).toMatchObject({ warning: null, estimate: "insufficient_history" });
    expect(forecastSpaceStorage([
      { allocatedBytes: 400, measuredAt: "2026-01-01T00:00:00Z" },
      { allocatedBytes: 500, measuredAt: "2026-01-11T00:00:00Z" },
    ], 1_000, 80)).toMatchObject({ currentBytes: 500, projected30DayBytes: 800, warning: true, estimate: "measured_linear_trend" });
  });
});
