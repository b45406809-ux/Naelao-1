import { describe, expect, it, vi } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

describe("scheduled memory maintenance route", () => {
  it("runs the space maintenance pass with tenant identity and no user session", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO(
      { storage, id: { toString: () => "agent" } } as never,
      {
        PLATFORM_SECRET: "memory-maintenance-test-secret",
        PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-a" }) }) }) },
      } as never,
    );
    const maintenance = vi.fn(async () => ({ decayed: 3, pruned: 2, promoted: 1 }));
    (agent as unknown as { runMemoryMaintenanceForSpace: typeof maintenance }).runMemoryMaintenanceForSpace = maintenance;

    const response = await agent.fetch(new Request("http://agent/memory/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space-a", tenantId: "tenant-a", runSpaceMaintenance: true }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decayed: 3, pruned: 2, promoted: 1 });
    expect(maintenance).toHaveBeenCalledWith("space-a", "tenant-a");
  });

  it("refuses scheduled maintenance when the tenant or Space is inactive", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO(
      { storage, id: { toString: () => "agent" } } as never,
      {
        PLATFORM_SECRET: "memory-maintenance-test-secret",
        PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
      } as never,
    );
    const maintenance = vi.fn();
    (agent as unknown as { runMemoryMaintenanceForSpace: typeof maintenance }).runMemoryMaintenanceForSpace = maintenance;

    const response = await agent.fetch(new Request("http://agent/memory/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space-a", tenantId: "tenant-a", runSpaceMaintenance: true }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error_code: "tenant_suspended" });
    expect(maintenance).not.toHaveBeenCalled();
  });
});
