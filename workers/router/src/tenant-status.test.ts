import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTenantStatusCacheForTests,
  isTenantActive,
} from "./tenant-status";

function database(status: string | null, resellerStatus = "active") {
  const first = vi.fn().mockResolvedValue(status ? { status, reseller_status: resellerStatus } : null);
  const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first })) }));
  return { db: { prepare } as unknown as D1Database, prepare, first };
}

afterEach(() => {
  clearTenantStatusCacheForTests();
  vi.useRealTimers();
});

describe("tenant suspension gate", () => {
  it("allows active organizations and denies suspended or missing organizations", async () => {
    expect(await isTenantActive(database("active").db, "tenant-active")).toBe(
      true
    );
    expect(
      await isTenantActive(database("suspended").db, "tenant-suspended")
    ).toBe(false);
    expect(await isTenantActive(database(null).db, "tenant-missing")).toBe(
      false
    );
  });

  it("denies tenants suspended or terminated by their reseller", async () => {
    expect(await isTenantActive(database("active", "active").db, "tenant-reseller-active"))
      .toBe(true);
    expect(await isTenantActive(database("active", "suspended").db, "tenant-reseller-suspended"))
      .toBe(false);
    expect(await isTenantActive(database("active", "terminated").db, "tenant-reseller-terminated"))
      .toBe(false);
  });

  it("bounds status lookups with a short cache and observes the next status after expiry", async () => {
    vi.useFakeTimers();
    const first = vi
      .fn()
      .mockResolvedValueOnce({ status: "active", reseller_status: "active" })
      .mockResolvedValueOnce({ status: "suspended", reseller_status: "active" });
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
    } as unknown as D1Database;

    expect(await isTenantActive(db, "tenant-cache")).toBe(true);
    expect(await isTenantActive(db, "tenant-cache")).toBe(true);
    expect(first).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(2_001);
    expect(await isTenantActive(db, "tenant-cache")).toBe(false);
    expect(first).toHaveBeenCalledTimes(2);
  });

  it("does not turn a database outage into an allow decision", async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockRejectedValue(new Error("D1 down")),
        })),
      })),
    } as unknown as D1Database;
    await expect(isTenantActive(db, "tenant-outage")).rejects.toThrow(
      "D1 down"
    );
  });
});
