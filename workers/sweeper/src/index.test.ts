import { describe, expect, it, vi } from "vitest";
import { cleanExpiredIdempotencyKeys } from "./index.js";

describe("idempotency expiry cleanup", () => {
  it("compares ISO timestamps as dates and reports deleted rows", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 12 } });
    const prepare = vi.fn().mockReturnValue({ run });
    const deleted = await cleanExpiredIdempotencyKeys({ prepare } as never);
    expect(prepare).toHaveBeenCalledWith(
      "DELETE FROM idempotency_keys WHERE julianday(expires_at) < julianday('now') LIMIT 1000"
    );
    expect(deleted).toBe(12);
  });
});
