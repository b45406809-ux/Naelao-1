import { describe, expect, it, vi } from "vitest";
import { createSpaceSharedExtensionClient } from "./runtime-context.js";

describe("Space-shared extension client", () => {
  it("binds data methods to the host scoped transport and never exposes credentials", async () => {
    const request = vi.fn(async (input: unknown) => input);
    const operation = vi.fn(async (input: unknown) => input);
    const client = createSpaceSharedExtensionClient({ request, operation });
    await expect(client.write("catalog", [{ id: "p1" }])).resolves.toEqual({ method: "POST", path: "/api/data", body: { key: "catalog", value: [{ id: "p1" }] } });
    await expect(client.read("catalog")).resolves.toEqual({ method: "GET", path: "/api/data", query: { key: "catalog" } });
    await expect(client.remove("catalog")).resolves.toEqual({ method: "DELETE", path: "/api/data", query: { key: "catalog" } });
    await expect(client.storage()).resolves.toEqual({ method: "GET", path: "/api/storage" });
    await client.call("app_foundry_catalog_facet_list", { table: "foundry_products", limit: 10 });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ method: "POST", path: "/mcp", body: expect.objectContaining({ method: "tools/call", params: { name: "app_foundry_catalog_facet_list", arguments: { table: "foundry_products", limit: 10 } } }) }));
    await expect(client.exportBlueprint({ stateDeltaSuite: { fixtures: [] } })).resolves.toEqual({ capability: "blueprint.export", input: { stateDeltaSuite: { fixtures: [] } } });
    await expect(client.exportStatus({ jobId: "job-1" })).resolves.toEqual({ capability: "blueprint.status", input: { jobId: "job-1" } });
    await expect(client.graduate({ conformance_job_id: "job-1" })).resolves.toEqual({ capability: "marketplace.graduate", input: { conformance_job_id: "job-1" } });
    await expect(client.readBlackboard({ view: "cards" })).resolves.toEqual({ capability: "blackboard.read", input: { view: "cards" } });
    expect(Object.keys(client)).toEqual(["read", "list", "write", "remove", "storage", "call", "exportBlueprint", "exportStatus", "graduate", "readBlackboard"]);
    expect(request).toHaveBeenCalledTimes(5);
    expect(operation).toHaveBeenCalledTimes(4);
  });
});
