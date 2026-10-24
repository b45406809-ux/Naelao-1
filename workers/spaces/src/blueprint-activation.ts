import type { SpaceBlueprint } from "@naelao/agent-sdk";

export interface BlueprintActivationDependency {
  extension_id: string;
  status: "installed" | "installable" | "unavailable";
}

export interface BlueprintActivationPreview {
  ready: boolean;
  dependencies: BlueprintActivationDependency[];
  setup_credentials: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
  blockers: string[];
  requires_human_activation: true;
  installs_or_grants_applied: false;
}

/** Read-only, target-Space-specific preview. It never installs dependencies or grants access. */
export function previewBlueprintActivation(
  blueprint: SpaceBlueprint,
  installedExtensionIds: ReadonlySet<string>,
  installableExtensionIds: ReadonlySet<string>
): BlueprintActivationPreview {
  const dependencies = [...new Set(blueprint.requiredExtensions ?? [])]
    .sort()
    .map((extension_id) => ({
      extension_id,
      status: installedExtensionIds.has(extension_id)
        ? ("installed" as const)
        : installableExtensionIds.has(extension_id)
          ? ("installable" as const)
          : ("unavailable" as const),
    }));
  const blockers = dependencies
    .filter((item) => item.status === "unavailable")
    .map((item) => `required_extension_unavailable:${item.extension_id}`);
  return {
    ready: blockers.length === 0,
    dependencies,
    setup_credentials: (blueprint.requiredCredentials ?? []).map(
      ({ name, description, required }) => ({ name, description, required })
    ),
    blockers,
    requires_human_activation: true,
    installs_or_grants_applied: false,
  };
}
