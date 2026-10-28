import type { SpaceBlueprint } from "@naelao/agent-sdk";

export interface BlueprintActivationDependency {
  extension_id: string;
  status:
    | "installed"
    | "disabled"
    | "not_active"
    | "installable"
    | "unavailable"
    | "version_mismatch";
  required_version?: string;
  available_version?: string;
  required_digest?: string;
  available_digest?: string;
  /** Declared runtime surface only; it does not imply that the dependency will be granted. */
  summary?: import("./extension-activation-summary.js").ExtensionActivationSummary;
}

export interface BlueprintActivationPreview {
  ready: boolean;
  dependencies: BlueprintActivationDependency[];
  extension_connections: Array<{ extension_id: string; connection_id: string; provider: string; purpose: string; required: boolean; status: "unsupported" | "optional_unsupported" }>;
  runtime_requirements: Array<{ project_id: string; runtime_id: string; required: boolean; status: "installable" | "unavailable" | "deferred"; reason: "runtime_provisioning_unavailable" | "owner_approval_required" | "runtime_not_deployed" | "runtime_capability_mismatch" | "subscription_plan_required" | "subscription_resource_limit" | "subscription_slot_limit" | "project_execution_ceiling_required" | "optional_runtime_omitted"; project_slots_required?: number; project_slots_limit?: number; resources?: { cpu_cores: number; memory_mb: number } }>;
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
    { version: string | null; digest: string | null; status?: string; summary?: BlueprintActivationDependency["summary"] }
  >,
  installableExtensions: ReadonlyMap<
    string,
    { version: string; digest: string; summary?: BlueprintActivationDependency["summary"] }
  >,
  runtimeInstallability: ReadonlyMap<string, { installable: boolean; reason?: BlueprintActivationPreview["runtime_requirements"][number]["reason"]; projectSlotsRequired?: number; projectSlotsLimit?: number; resources?: { cpuCores: number; memoryMb: number } }> = new Map()
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
      const summary = isInstalled ? installed?.summary : installable?.summary;
      const versionMatches =
        !requiredVersion || availableVersion === requiredVersion;
      const digestMatches =
        !requiredDigest || availableDigest === requiredDigest;
      const status = isInstalled
        ? installed?.status === "disabled"
          ? ("disabled" as const)
          : installed?.status !== "active"
            ? ("not_active" as const)
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
        ...(summary ? { summary } : {}),
      };
    });
  const blockers = dependencies
    .filter(
      (item) =>
        item.status === "unavailable" ||
        item.status === "version_mismatch" ||
        item.status === "disabled" ||
        item.status === "not_active"
    )
    .map((item) =>
      item.status === "version_mismatch"
        ? `required_extension_version_mismatch:${item.extension_id}`
        : item.status === "disabled"
          ? `required_extension_disabled:${item.extension_id}`
          : item.status === "not_active"
            ? `required_extension_not_active:${item.extension_id}`
          : `required_extension_unavailable:${item.extension_id}`
    );
  const extension_connections = dependencies.flatMap(dependency => (dependency.summary?.connections ?? []).map(connection => ({
    extension_id: dependency.extension_id,
    connection_id: connection.id,
    provider: connection.provider,
    purpose: connection.purpose,
    required: connection.required,
    // Provider connections currently bind to project installations. Space Template dependencies
    // are SPACE_SHARED, and do not yet have a provider-connection lifecycle.
    status: (connection.required ? "unsupported" : "optional_unsupported") as "unsupported" | "optional_unsupported",
  })));
  for (const connection of extension_connections) if (connection.required)
    blockers.push(`required_space_extension_connection_unsupported:${connection.extension_id}:${connection.connection_id}`);
  const runtime_requirements = blueprint.projects.flatMap(project => (project.runtimeRequirements ?? []).map(requirement => {
    const project_id = project.id ?? project.name;
    const key = `${project_id}:${requirement.id}`;
    const availability = runtimeInstallability.get(key);
    const installable = availability?.installable === true;
    return {
      project_id, runtime_id: requirement.id, required: requirement.required,
      status: (requirement.required ? installable ? "installable" : "unavailable" : "deferred") as "installable" | "unavailable" | "deferred",
      reason: requirement.required ? installable ? "owner_approval_required" as const : availability?.reason ?? "runtime_provisioning_unavailable" as const : "optional_runtime_omitted" as const,
      ...(requirement.required && availability?.projectSlotsRequired !== undefined ? { project_slots_required: availability.projectSlotsRequired } : {}),
      ...(requirement.required && availability?.projectSlotsLimit !== undefined ? { project_slots_limit: availability.projectSlotsLimit } : {}),
      ...(requirement.required && availability?.resources ? { resources: { cpu_cores: availability.resources.cpuCores, memory_mb: availability.resources.memoryMb } } : {}),
    };
  }));
  for (const requirement of runtime_requirements) if (requirement.required && requirement.status === "unavailable")
    blockers.push(`required_runtime_unavailable:${requirement.project_id}:${requirement.runtime_id}`);
  return {
    ready: blockers.length === 0,
    dependencies,
    extension_connections,
    runtime_requirements,
    setup_credentials: (blueprint.requiredCredentials ?? []).map(
      ({ name, description, required }) => ({ name, description, required })
    ),
    blockers,
    requires_human_activation: true,
    installs_or_grants_applied: false,
  };
}
