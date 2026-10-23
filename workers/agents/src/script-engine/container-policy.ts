import { CLOUDFLARE_IMAGE_PIN, DYNAMIC_PROFILES, selectDynamicProfile } from "./dynamic-containers.js";
import { parseExtensionPrimitive, type ContainerContract, type InstallationScope } from "@naelao/agent-sdk";

export interface ContainerInvocationScope {
  tenantId: string; spaceId: string; projectId?: string | undefined; actorId: string; agentId: string;
  runId: string; executionId: string; workspaceBranch?: string | undefined; installationId?: string | undefined; installationScope?: InstallationScope | undefined; image?: string; dynamicImage?: boolean;
  deadline: number; timeoutMs: number;
}
export interface InstalledContainer {
  tenantId: string; spaceId: string; projectId?: string | undefined; userId?: string | undefined;
  installationId: string; extensionId: string; contract: ContainerContract; scope?: InstallationScope | undefined;
}
export interface ApprovedContainerImage {
  image: string; binding: "DOCUMENT_SANDBOX" | "MEDIA_SANDBOX" | "TOOL_SANDBOX";
  memoryMb: number; cpuCores: number;
  /** Static specialist deployments or versioned dynamic image selection. */
  schedulingPolicy: "default" | "durable_object"; networkPolicy: "none";
  /** Optional owner-reviewed marketplace card. TOOL_SANDBOX images must implement the
   *  Naelao sandbox harness protocol and are still pinned to this immutable digest. */
  marketplace?: { id: string; name: string; description: string; category: "media" | "compute" | "browser"; exportedBinaries: string[] };
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export function validateContainerScope(scope: ContainerInvocationScope, now = Date.now()): void {
  for (const value of [scope.tenantId, scope.spaceId, scope.actorId, scope.agentId, scope.runId, scope.executionId])
    if (!ID.test(value) || value === "system") throw new Error("container_actor_scope_required");
  if (scope.projectId && !ID.test(scope.projectId) || scope.installationId && !ID.test(scope.installationId)) throw new Error("container_scope_invalid");
  if (scope.workspaceBranch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(scope.workspaceBranch.replaceAll("\\", "/")) || scope.workspaceBranch.replaceAll("\\", "/").includes(".."))) throw new Error("container_workspace_branch_invalid");
  if (scope.installationScope && !["SPACE_SHARED", "SPACE_ASSISTANT", "SPACE_USER", "PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER"].includes(scope.installationScope)) throw new Error("container_installation_scope_invalid");
  if (scope.installationScope && !scope.installationId) throw new Error("container_installation_required");
  if (scope.installationScope === "SPACE_ASSISTANT" && scope.projectId) throw new Error("assistant_runtime_project_scope_mismatch");
  if (["PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER"].includes(scope.installationScope ?? "") && !scope.projectId) throw new Error("project_runtime_project_scope_required");
  if (!Number.isFinite(scope.timeoutMs) || scope.timeoutMs < 1 || scope.timeoutMs > 60000 || !Number.isFinite(scope.deadline) || scope.deadline <= now || scope.deadline > now + 65000)
    throw new Error("container_deadline_invalid");
  if (scope.image && !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(scope.image)) throw new Error("container_image_pin_required");
  if (scope.dynamicImage && !scope.image) throw new Error("container_image_pin_required");
  if (Boolean(scope.image) !== Boolean(scope.installationId)) throw new Error("container_installation_required");
}
export function parseApprovedContainerImages(json: string | undefined): ApprovedContainerImage[] {
  if (!json) return [];
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.length > 99) throw new Error("container_registry_invalid");
  const pins = new Set<string>(), ids = new Set(["postgres-16", "redis-7", "chrome-headless", "ffmpeg", "blender-cli", "pytorch-gpu", "r-statistical", "libreoffice"]);
  return value.map(item => {
    if (!item || typeof item !== "object" || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(item.image)
      || !["DOCUMENT_SANDBOX", "MEDIA_SANDBOX", "TOOL_SANDBOX"].includes(item.binding)
      || !["default", "durable_object"].includes(item.schedulingPolicy)
      || (item.binding === "TOOL_SANDBOX" && item.schedulingPolicy !== "durable_object") || item.networkPolicy !== "none"
      || !Number.isFinite(item.cpuCores) || !Number.isSafeInteger(item.memoryMb) || pins.has(item.image))
      throw new Error("container_registry_invalid");
    const size = DYNAMIC_PROFILES[selectDynamicProfile(item.cpuCores, item.memoryMb)];
    if (item.schedulingPolicy === "durable_object" && !CLOUDFLARE_IMAGE_PIN.test(item.image)) throw new Error("container_cloudflare_registry_required");
    if (item.schedulingPolicy === "default" && (item.memoryMb !== 4096 || item.cpuCores !== .5)) throw new Error("container_fixed_resource_mismatch");
    if (item.marketplace !== undefined) {
      const card = item.marketplace;
      if (item.binding !== "TOOL_SANDBOX" || !card || typeof card !== "object"
        || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(card.id) || ids.has(card.id)
        || typeof card.name !== "string" || card.name.trim().length < 1 || card.name.length > 100
        || typeof card.description !== "string" || card.description.trim().length < 1 || card.description.length > 500
        || !["media", "compute", "browser"].includes(card.category)
        || !Array.isArray(card.exportedBinaries) || card.exportedBinaries.length < 1 || card.exportedBinaries.length > 16
        || card.exportedBinaries.some((binary: unknown) => typeof binary !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(binary))
        || new Set(card.exportedBinaries).size !== card.exportedBinaries.length)
        throw new Error("container_marketplace_entry_invalid");
      ids.add(card.id);
    }
    pins.add(item.image); return { ...item, ...(item.schedulingPolicy === "durable_object" ? { memoryMb: size.memoryMb, cpuCores: size.cpuCores } : {}) } as ApprovedContainerImage;
  });
}
/** Resolve actual active installations visible to this actor; never infer a grant from a CLI name. */
function installationVisibleToOwner(item: InstalledContainer, owner: { tenantId: string; spaceId: string; projectId?: string | undefined; userId: string }): boolean {
  if (item.tenantId !== owner.tenantId || item.spaceId !== owner.spaceId || item.userId && item.userId !== owner.userId) return false;
  if (["PROJECT_BOUND", "PROJECT_SHARED", "PROJECT_USER"].includes(item.scope ?? ""))
    return Boolean(owner.projectId && item.projectId === owner.projectId);
  if (["SPACE_SHARED", "SPACE_ASSISTANT", "SPACE_USER"].includes(item.scope ?? ""))
    return !item.projectId && !(item.scope === "SPACE_ASSISTANT" && owner.projectId);
  return false;
}

export function resolveContainerBinary(command: string, installations: readonly InstalledContainer[], owner: { tenantId: string; spaceId: string; projectId?: string | undefined; userId: string }): InstalledContainer | undefined {
  const matches: InstalledContainer[] = [];
  for (const item of installations) {
    if (!installationVisibleToOwner(item, owner)) continue;
    const contract = parseExtensionPrimitive(item.contract);
    if (contract.kind !== "container") throw new Error("container_contract_required");
    if (contract.exportedBinaries.some(binary => command === binary || command === item.extensionId + "/" + contract.id + "/" + binary)) matches.push(item);
  }
  if (matches.length > 1) throw new Error("container_binary_ambiguous: qualify extension/container/binary");
  return matches[0];
}

/**
 * Resolve planner-declared capabilities to an installed runtime without accepting an image or
 * installation ID from model output. An exact, unique host-side match is required before the
 * caller may prewarm or execute it.
 */
export function resolveContainerCapabilities(
  requiredCapabilities: readonly string[],
  installations: readonly InstalledContainer[],
  owner: { tenantId: string; spaceId: string; projectId?: string | undefined; userId: string },
): InstalledContainer | undefined {
  if (!requiredCapabilities.length || requiredCapabilities.length > 16) return undefined;
  const required = new Set<string>();
  for (const capability of requiredCapabilities) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(capability)) throw new Error("container_capability_invalid");
    required.add(capability);
  }
  const matches = installations.filter(item => {
    if (!installationVisibleToOwner(item, owner)) return false;
    const contract = parseExtensionPrimitive(item.contract);
    if (contract.kind !== "container" || !contract.permissions.some(permission => permission.actions.includes("execute"))) return false;
    // `capabilityRequirements` describes permissions this container needs; the actual commands
    // it provides are its exported binaries. Use the latter for runtime matching.
    const capabilities = new Set(contract.exportedBinaries);
    return [...required].every(capability => capabilities.has(capability));
  });
  if (matches.length > 1) throw new Error("container_capability_ambiguous: qualify the task requirements");
  return matches[0];
}
export function approvedContainer(item: InstalledContainer, registry: readonly ApprovedContainerImage[]): ApprovedContainerImage {
  const approved = registry.find(entry => entry.image === item.contract.image);
  if (!approved) throw new Error("container_image_not_approved");
  if (approved.binding === "TOOL_SANDBOX" && approved.schedulingPolicy !== "durable_object") throw new Error("container_scheduling_policy_mismatch");
  if (item.contract.resources.memoryMb > approved.memoryMb || item.contract.resources.cpuCores > approved.cpuCores) throw new Error("container_resources_exceed_binding");
  if ((item.contract.networkPolicy ?? "none") !== approved.networkPolicy) throw new Error("container_network_proxy_unavailable");
  // These images expose exactly these writable directories. More restrictive mounts need a
  // separately built binding: do not advertise nonexistent provider mount/read-only options.
  if (item.contract.mounts?.some(mount => !mount.writable)) throw new Error("container_mount_profile_unavailable");
  return approved;
}
export function sidecarKey(scope: ContainerInvocationScope): string {
  return "sidecar:" + JSON.stringify([scope.tenantId, scope.spaceId, scope.projectId, scope.installationId, scope.runId, scope.image]);
}
export interface BrowserContainerLease {
  actorId: string; tenantId: string; spaceId: string; projectId?: string | undefined; runId: string;
  expiresAt: number; consent: boolean; live: boolean; crossOriginIsolated: boolean;
}
export function assertBrowserContainerLease(lease: BrowserContainerLease | undefined, scope: ContainerInvocationScope, compatible: boolean, now = Date.now()): void {
  if (!compatible) throw new Error("webcontainer_native_workload_unsupported");
  if (!lease || !lease.consent || !lease.live || !lease.crossOriginIsolated || lease.expiresAt <= now || lease.expiresAt > now + 300000)
    throw new Error("webcontainer_browser_disconnected_or_consent_required");
  if (lease.tenantId !== scope.tenantId || lease.spaceId !== scope.spaceId || lease.projectId !== scope.projectId || lease.actorId !== scope.actorId || lease.runId !== scope.runId)
    throw new Error("webcontainer_owner_mismatch");
}
