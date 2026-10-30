import { describe, expect, it } from "vitest";
import { FOUNDRY_SPACE_TEMPLATE } from "./foundry-space.js";
import { DOGFOOD_EXTENSION_BY_ID, DOGFOOD_EXTENSION_CANVASES, digestExtensionManifest, validateExtensionManifest } from "../index.js";

describe("Foundry dogfood Space Template", () => {
  it("is a portable Space blueprint with an isolated Template Studio project", () => {
    expect(FOUNDRY_SPACE_TEMPLATE.id).toBe("tpl_foundry_space_v1");
    expect(FOUNDRY_SPACE_TEMPLATE.schemaVersion).toBe("2.0");
    expect(FOUNDRY_SPACE_TEMPLATE.requiredExtensions).toContain("ext_foundry_catalog");
    expect(FOUNDRY_SPACE_TEMPLATE.requiredCredentials).toEqual([]);
    expect(FOUNDRY_SPACE_TEMPLATE.projects).toHaveLength(1);
    expect(FOUNDRY_SPACE_TEMPLATE.projects[0]?.configuration).toMatchObject({ studio_only: true });
    expect(FOUNDRY_SPACE_TEMPLATE.projects[0]?.starterFiles.map(file => file.path)).toEqual(expect.arrayContaining([
      "product/brief.md", "product/export-manifest.json", "eval/README.md",
    ]));
    expect(JSON.stringify(FOUNDRY_SPACE_TEMPLATE)).not.toMatch(/(?:sk_live_|ghp_|whsec_|xox[baprs]-)/);
  });

  it("declares its catalog as a least-privilege Space-shared extension", async () => {
    const manifest = DOGFOOD_EXTENSION_BY_ID.ext_foundry_catalog;
    expect(manifest).toBeDefined();
    expect(manifest?.releaseVersion).toBe(FOUNDRY_SPACE_TEMPLATE.requiredExtensionVersions?.ext_foundry_catalog);
    expect(await digestExtensionManifest(manifest!)).toBe(FOUNDRY_SPACE_TEMPLATE.requiredExtensionDigests?.ext_foundry_catalog);
    expect(validateExtensionManifest(manifest, { gatekeeperCapabilities: manifest!.capabilityRequirements })).toEqual(manifest);
    expect(manifest!.gadgets).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "SPACE_SHARED", gadgetTier: 3 }),
    ]));
    expect(manifest!.declaredPermissions).toEqual(["facet.sqlite.read", "facet.sqlite.write", "blueprint.export", "blueprint.status", "marketplace.graduate"]);
    expect(manifest!.capabilityRequirements).not.toContain("payments.disburse");
    expect(manifest!.gadgets[0]?.migrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 1, up: expect.stringContaining("ALTER TABLE foundry_products ADD COLUMN description") }),
    ]));
    expect(DOGFOOD_EXTENSION_CANVASES.ext_foundry_catalog).toContain("/mcp");
    expect(DOGFOOD_EXTENSION_CANVASES.ext_foundry_catalog).toContain("tenant-owned export");
  });
});
