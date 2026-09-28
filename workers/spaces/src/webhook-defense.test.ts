import { describe, expect, it } from "vitest";
import { claimProcessedWebhookEvent } from "./do/SpaceDO.js";

describe("webhook idempotency", () => {
  it("acknowledges an identical event hash only once within the retention window", async () => {
    const hashes = new Set<string>();
    const sql = { exec(query: string, ...bindings: unknown[]) {
      if (!query.includes("INSERT OR IGNORE")) return { rowsWritten: 0 };
      const hash = String(bindings[0]);
      if (hashes.has(hash)) return { rowsWritten: 0 };
      hashes.add(hash); return { rowsWritten: 1 };
    } };
    const event = { spaceId: "space-1", provider: "shopify", eventType: "orders/create", eventId: "evt-1" };
    expect((await claimProcessedWebhookEvent(sql, event)).claimed).toBe(true);
    expect((await claimProcessedWebhookEvent(sql, event)).claimed).toBe(false);
  });
});
