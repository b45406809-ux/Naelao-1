import { describe, expect, it } from "vitest";
import { buildProviderCleanupInventory } from "./extension-provider-cleanup-inventory.js";

describe("buildProviderCleanupInventory", () => {
  it("keeps only fixed provider, operation, status and bounded attempt fields", () => {
    expect(buildProviderCleanupInventory([{
      provider: "telegram", operation_kind: "setup", status: "pending", attempt_count: 8_000_000,
      last_attempt_at: "2026-11-17T10:00:00.000Z", updated_at: "2026-11-17T10:01:00.000Z",
      account_id: "must-not-leak", last_error_code: "private detail",
    } as never])).toEqual([{
      provider: "telegram", operation: "setup", status: "pending", attempts: 1_000_000,
      last_attempt_at: "2026-11-17T10:00:00.000Z", updated_at: "2026-11-17T10:01:00.000Z",
    }]);
  });

  it("normalizes unknown persisted values and caps the list", () => {
    const rows = Array.from({ length: 35 }, () => ({ provider: "unknown", operation_kind: "unexpected",
      status: "unexpected", attempt_count: -1, last_attempt_at: null, updated_at: "then" }));
    const result = buildProviderCleanupInventory(rows);
    expect(result).toHaveLength(30);
    expect(result[0]).toMatchObject({ provider: "other", operation: "cleanup", status: "pending", attempts: 0 });
  });
});
