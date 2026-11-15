import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectExtensionStorageUsage, type ContainerInstallation } from "@/lib/api";
import { MicroAppStorageStatus, parseMicroAppStorageUsage, projectGadgetStorageApps } from "./MicroAppStorageStatus";

afterEach(() => vi.unstubAllGlobals());

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

  it("derives only exact current Project Gadget IDs from the matching signed installation", () => {
    const installation = {
      instance: { instance_id: "install-a", extension_id: "ext_inventory", instance_key: "shop", project_id: "project-a",
        scope: "PROJECT_BOUND", status: "active", installed_at: "2026-11-15T00:00:00.000Z", release_version: "1.0.0" },
      manifest: { id: "ext_inventory", bundle: { id: "ext_inventory", version: "1.0.0", primitives: [
        { kind: "gadget", id: "inventory", name: "Inventory", scope: "PROJECT_BOUND" },
        { kind: "canvas", id: "inventory_canvas", scope: "PROJECT_BOUND" },
        { kind: "gadget", id: "space_inventory", scope: "SPACE_SHARED" },
      ] } },
    } as ContainerInstallation;
    expect(projectGadgetStorageApps(installation, "project-a")).toEqual([{ appId: "shop_inventory", name: "Inventory" }]);
    expect(projectGadgetStorageApps(installation, "project-b")).toEqual([]);
    expect(projectGadgetStorageApps({ ...installation, manifest: { ...installation.manifest,
      bundle: { ...installation.manifest.bundle!, version: "2.0.0" } } }, "project-a")).toEqual([]);
  });

  it("calls only the encoded Project storage route with the current user session", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input); requestInit = init; return Response.json(usage);
    }));
    await callProjectExtensionStorageUsage("space-a", "project-a", "inventory", { sessionToken: "session-a", endUserId: "owner-a" });
    expect(new URL(requestUrl).pathname).toBe("/v1/spaces/space-a/projects/project-a/apps/inventory/api/storage");
    expect(requestInit?.method).toBeUndefined();
    expect(requestInit?.cache).toBe("no-store");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer session-a");
    expect(new Headers(requestInit?.headers).get("x-naelao-end-user-id")).toBe("owner-a");
  });
});
