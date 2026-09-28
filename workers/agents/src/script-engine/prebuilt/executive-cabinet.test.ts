import { describe, expect, it, vi } from "vitest";
import { executiveCabinet } from "./executive-cabinet.js";

describe("executive cabinet capability isolation", () => {
  const delegate = executiveCabinet.operations.delegate_to_space_worker!;

  it("lets the project manager invoke only its exact project grants", async () => {
    const run = vi.fn(async () => ({ id: "p1" }));
    await expect(delegate({ worker_id: "project_manager_worker", task: { operation: "project.create", params: { name: "One" } } }, { env: {} as never, run })).resolves.toEqual({ id: "p1" });
    expect(run).toHaveBeenCalledWith("project.create", { name: "One" });
  });

  it("fails closed before a PM can touch treasury", async () => {
    const run = vi.fn();
    await expect(delegate({ worker_id: "project_manager_worker", task: { operation: "wallet.get_balance" } }, { env: {} as never, run })).rejects.toThrow("Capability violation: project_manager_worker cannot invoke 'wallet.get_balance'");
    expect(run).not.toHaveBeenCalled();
  });
});
