import { describe, expect, it, vi } from "vitest";
import type { AgentsEnv } from "../index.js";
import { reconcileManagedServiceOperations } from "./managed-service-reconciliation.js";

describe("provider-neutral managed service reconciliation dispatcher", () => {
  it("caps the shared batch and lets one provider adapter fail without blocking the next", async () => {
    const now = new Date("2026-11-11T12:00:00.000Z");
    const failed = vi.fn(async () => { throw new Error("provider unavailable"); });
    const successful = vi.fn(async (_env: AgentsEnv, _now: Date, limit: number) => ({ checked: Math.min(limit, 2), reconciled: 1, deferred: 1, failed: 0 }));
    const result = await reconcileManagedServiceOperations({} as AgentsEnv, [
      { provider: "agent37", serviceId: "workspace", runDue: failed },
      { provider: "agentmail", serviceId: "agentmail", runDue: successful },
    ], now, 3);
    expect(result).toEqual({ adapters: 2, checked: 2, reconciled: 1, deferred: 1, failed: 1 });
    expect(successful).toHaveBeenCalledWith(expect.anything(), now, 3);
  });

  it("rejects duplicate or malformed adapter registrations before dispatch", async () => {
    const runDue = vi.fn(async () => ({ checked: 0, reconciled: 0, deferred: 0, failed: 0 }));
    await expect(reconcileManagedServiceOperations({} as AgentsEnv, [
      { provider: "agentmail", serviceId: "agentmail", runDue },
      { provider: "agentmail", serviceId: "agentmail", runDue },
    ])).rejects.toThrow("managed_service_reconciliation_adapter_invalid");
    expect(runDue).not.toHaveBeenCalled();
  });
});
