import type { SpaceBlueprint } from "@naelao/agent-sdk";
import { describe, expect, it } from "vitest";
import { previewBlueprintActivation } from "./blueprint-activation.js";

const blueprint = (
  overrides: Partial<SpaceBlueprint> = {}
): SpaceBlueprint => ({
  id: "tpl_test",
  schemaVersion: "2.0",
  metadata: { name: "Test" },
  templateCategory: "other",
  projects: [],
  requiredExtensions: ["ext_installed", "ext_supported", "ext_missing"],
  requiredCredentials: [
    { name: "Calendar", description: "Connect a calendar", required: true },
  ],
  ...overrides,
});

describe("Space Template activation preview", () => {
  it("reports target dependency state and credential setup without installing or granting", () => {
    const result = previewBlueprintActivation(
      blueprint(),
      new Set(["ext_installed"]),
      new Set(["ext_supported"])
    );
    expect(result).toMatchObject({
      ready: false,
      requires_human_activation: true,
      installs_or_grants_applied: false,
      dependencies: [
        { extension_id: "ext_installed", status: "installed" },
        { extension_id: "ext_missing", status: "unavailable" },
        { extension_id: "ext_supported", status: "installable" },
      ],
      setup_credentials: [
        { name: "Calendar", description: "Connect a calendar", required: true },
      ],
      blockers: ["required_extension_unavailable:ext_missing"],
    });
  });

  it("deduplicates dependencies and is ready only when every dependency is present or installable", () => {
    const result = previewBlueprintActivation(
      blueprint({ requiredExtensions: ["ext_supported", "ext_supported"] }),
      new Set(),
      new Set(["ext_supported"])
    );
    expect(result.ready).toBe(true);
    expect(result.dependencies).toEqual([
      { extension_id: "ext_supported", status: "installable" },
    ]);
    expect(result.blockers).toEqual([]);
  });
});
