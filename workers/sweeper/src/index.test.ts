import { describe, expect, it, vi } from "vitest";
import { cleanExpiredApiKeys, cleanExpiredIdempotencyKeys } from "./index.js";

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

describe("API key expiry cleanup", () => {
  it("compares ISO timestamps as dates", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 3 } });
    const prepare = vi.fn().mockReturnValue({ run });
    await expect(cleanExpiredApiKeys({ prepare } as never)).resolves.toBe(3);
    expect(prepare).toHaveBeenCalledWith("DELETE FROM api_keys WHERE expires_at IS NOT NULL AND julianday(expires_at) < julianday('now')");
  });
});
