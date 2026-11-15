import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MicroAppStorageStatus, parseMicroAppStorageUsage } from "./MicroAppStorageStatus";

const usage = {
  appId: "inventory", tier: 3, allocatedBytes: 1024 * 1024, allocatedMiB: 1, limitBytes: 250 * 1024 * 1024,
  utilizationPercent: 0.4, measurement: "sqlite_page_count_times_page_size", measuredAt: "2026-11-15T00:00:00.000Z",
  monthlyCostEstimateUsd: null, costEstimateReason: "Durable Object billing is not attributable to this gadget from SQLite page usage alone.",
};

describe("MicroApp storage status", () => {
  it("accepts only the current app, tier cap and usage measurement contract", () => {
    expect(parseMicroAppStorageUsage(usage, "inventory")).toMatchObject({ appId: "inventory", tier: 3,
      allocatedBytes: 1024 * 1024, limitBytes: 250 * 1024 * 1024, utilizationPercent: 0.4 });
    expect(() => parseMicroAppStorageUsage({ ...usage, appId: "another-app" }, "inventory")).toThrow("storage_response_invalid");
    expect(() => parseMicroAppStorageUsage({ ...usage, limitBytes: 25 * 1024 * 1024 }, "inventory")).toThrow("storage_response_invalid");
    expect(() => parseMicroAppStorageUsage({ ...usage, monthlyCostEstimateUsd: 0.02 }, "inventory")).toThrow("storage_response_invalid");
  });

  it("keeps the usage report's non-billing boundary visible", () => {
    const markup = renderToStaticMarkup(<MicroAppStorageStatus spaceId="space" appId="inventory"
      session={{ sessionToken: "cookie", endUserId: "owner" }} />);
    expect(markup).toContain("App storage");
    expect(markup).toContain("Loading storage usage");
  });
});
