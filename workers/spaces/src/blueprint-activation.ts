import type { SpaceBlueprint } from "@naelao/agent-sdk";

export interface BlueprintActivationDependency {
  extension_id: string;
  status:
    | "installed"
    | "disabled"
    | "installable"
    | "unavailable"
    | "version_mismatch";
  required_version?: string;
  available_version?: string;
  required_digest?: string;
  available_digest?: string;
}

export interface BlueprintActivationPreview {
  ready: boolean;
  dependencies: BlueprintActivationDependency[];
  runtime_requirements: Array<{ project_id: string; runtime_id: string; required: boolean; status: "unavailable" | "deferred"; reason: "runtime_provisioning_unavailable" }>;
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
  installedExtensions: ReadonlyMap<
    string,
    { version: string | null; digest: string | null; status?: string }
  >,
  installableExtensions: ReadonlyMap<
    string,
    { version: string; digest: string }
  >
): BlueprintActivationPreview {
  const dependencies = [...new Set(blueprint.requiredExtensions ?? [])]
    .sort()
    .map((extension_id) => {
      const requiredVersion =
        blueprint.requiredExtensionVersions?.[extension_id];
      const installed = installedExtensions.get(extension_id);
      const installable = installableExtensions.get(extension_id);
      const isInstalled = installedExtensions.has(extension_id);
      const availableVersion = isInstalled
        ? (installed?.version ?? undefined)
        : installable?.version;
      const availableDigest = isInstalled
        ? (installed?.digest ?? undefined)
        : installable?.digest;
      const requiredDigest = blueprint.requiredExtensionDigests?.[extension_id];
      const versionMatches =
        !requiredVersion || availableVersion === requiredVersion;
      const digestMatches =
        !requiredDigest || availableDigest === requiredDigest;
      const status = isInstalled
        ? installed?.status === "disabled"
          ? ("disabled" as const)
          : versionMatches && digestMatches
            ? ("installed" as const)
            : ("version_mismatch" as const)
        : installable
          ? versionMatches && digestMatches
            ? ("installable" as const)
            : ("version_mismatch" as const)
          : ("unavailable" as const);
      return {
        extension_id,
        status,
        ...(requiredVersion ? { required_version: requiredVersion } : {}),
        ...(availableVersion ? { available_version: availableVersion } : {}),
        ...(requiredDigest ? { required_digest: requiredDigest } : {}),
        ...(availableDigest ? { available_digest: availableDigest } : {}),
      };
    });
  const blockers = dependencies
    .filter(
      (item) =>
        item.status === "unavailable" ||
        item.status === "version_mismatch" ||
        item.status === "disabled"
    )
    .map((item) =>
      item.status === "version_mismatch"
        ? `required_extension_version_mismatch:${item.extension_id}`
        : item.status === "disabled"
          ? `required_extension_disabled:${item.extension_id}`
          : `required_extension_unavailable:${item.extension_id}`
    );
  const runtime_requirements = blueprint.projects.flatMap(project => (project.runtimeRequirements ?? []).map(requirement => ({
    project_id: project.id ?? project.name, runtime_id: requirement.id, required: requirement.required,
    status: (requirement.required ? "unavailable" : "deferred") as "unavailable" | "deferred",
    reason: "runtime_provisioning_unavailable" as const,
  })));
  for (const requirement of runtime_requirements) if (requirement.required) blockers.push(`required_runtime_unavailable:${requirement.project_id}:${requirement.runtime_id}`);
  return {
    ready: blockers.length === 0,
    dependencies,
    runtime_requirements,
    setup_credentials: (blueprint.requiredCredentials ?? []).map(
      ({ name, description, required }) => ({ name, description, required })
    ),
    blockers,
    requires_human_activation: true,
    installs_or_grants_applied: false,
  };
}
