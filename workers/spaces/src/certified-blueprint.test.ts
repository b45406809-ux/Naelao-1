import { describe, expect, it, vi } from "vitest";
import { certifiedBlueprintKey, loadCertifiedBlueprint } from "./certified-blueprint.js";

const envelope = (id: string) => ({ blueprint: { id }, conformanceCertificate: { issuerTenantId: "tenant-a" } });

describe("tenant-scoped certified Space Template artifacts", () => {
  it("writes certificates under a tenant namespace and rejects unsafe identifiers", () => {
    expect(certifiedBlueprintKey("tenant-a", "tpl-a")).toBe("blueprints/tenant-a/tpl-a.json");
    expect(() => certifiedBlueprintKey("../tenant", "tpl-a")).toThrow("invalid_certified_blueprint_scope");
    expect(() => certifiedBlueprintKey("tenant-a", "../tpl")).toThrow("invalid_certified_blueprint_scope");
  });

  it("resolves only the requesting publisher namespace before legacy fallback", async () => {
    const get = vi.fn(async (key: string) => key === "blueprints/tenant-b/tpl-a.json"
      ? { json: async () => envelope("tpl-a") } as never
      : null);
    const db = { prepare: vi.fn(() => ({ bind: () => ({ first: async () => null }) })) };
    const loaded = await loadCertifiedBlueprint({ PLATFORM_DB: db as never, SCRIPTS_R2: { get } as never }, "tenant-b", "tpl-a");
    expect(loaded?.blueprint.id).toBe("tpl-a");
    expect(get).toHaveBeenCalledWith("blueprints/tenant-b/tpl-a.json");
    expect(get).not.toHaveBeenCalledWith("blueprints/tenant-a/tpl-a.json");
  });

  it("loads the exact certified artifact from a published tenant fork when no object is present", async () => {
    const blueprint = { id: "tpl-a", metadata: { name: "Template" } };
    const certificate = { issuerTenantId: "tenant-publisher", signature: "signed" };
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ artifact_json: JSON.stringify(blueprint), certificate_json: JSON.stringify(certificate) }) }) }) };
    const loaded = await loadCertifiedBlueprint({ PLATFORM_DB: db as never, SCRIPTS_R2: { get: async () => null } as never }, "tenant-buyer", "tpl-a");
    expect(loaded).toEqual({ blueprint, conformanceCertificate: certificate });
  });

  it("refuses malformed IDs before any storage access", async () => {
    const get = vi.fn(), prepare = vi.fn();
    expect(await loadCertifiedBlueprint({ PLATFORM_DB: { prepare } as never, SCRIPTS_R2: { get } as never }, "tenant-a", "../other")).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
