import { parseExtensionPrimitive, type ContainerContract, type InstallationScope } from "@naelao/agent-sdk";

export interface ContainerInvocationScope {
  tenantId: string; spaceId: string; projectId?: string | undefined; actorId: string; agentId: string;
  runId: string; executionId: string; installationId?: string | undefined; installationScope?: InstallationScope | undefined; image?: string; dynamicImage?: boolean;
  deadline: number; timeoutMs: number;
}
export interface InstalledContainer {
  tenantId: string; spaceId: string; projectId?: string | undefined; userId?: string | undefined;
  installationId: string; extensionId: string; contract: ContainerContract; scope?: InstallationScope | undefined;
}
export interface ApprovedContainerImage {
  image: string; binding: "DOCUMENT_SANDBOX" | "MEDIA_SANDBOX" | "TOOL_SANDBOX";
  memoryMb: number; cpuCores: number;
  /** Fixed default-policy deployment, not runtime arbitrary-image selection. */
  schedulingPolicy: "default"; networkPolicy: "none";
  /** Optional owner-reviewed marketplace card. TOOL_SANDBOX images must implement the
   *  Naelao sandbox harness protocol and are still pinned to this immutable digest. */
  marketplace?: { id: string; name: string; description: string; category: "media" | "compute" | "browser"; exportedBinaries: string[] };
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export function validateContainerScope(scope: ContainerInvocationScope, now = Date.now()): void {
  for (const value of [scope.tenantId, scope.spaceId, scope.actorId, scope.agentId, scope.runId, scope.executionId])
    if (!ID.test(value) || value === "system") throw new Error("container_actor_scope_required");
  if (scope.projectId && !ID.test(scope.projectId) || scope.installationId && !ID.test(scope.installationId)) throw new Error("container_scope_invalid");
  if (scope.installationScope && !["SPACE_SHARED", "SPACE_ASSISTANT", "SPACE_USER", "PROJECT_SHARED", "PROJECT_USER"].includes(scope.installationScope)) throw new Error("container_installation_scope_invalid");
  if (scope.installationScope && !scope.installationId) throw new Error("container_installation_required");
  if (scope.installationScope === "SPACE_ASSISTANT" && scope.projectId) throw new Error("assistant_runtime_project_scope_mismatch");
  if (!Number.isFinite(scope.timeoutMs) || scope.timeoutMs < 1 || scope.timeoutMs > 60000 || !Number.isFinite(scope.deadline) || scope.deadline <= now || scope.deadline > now + 65000)
    throw new Error("container_deadline_invalid");
  if (scope.image && !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(scope.image)) throw new Error("container_image_pin_required");
  if (scope.dynamicImage && !scope.image) throw new Error("container_image_pin_required");
  if (Boolean(scope.image) !== Boolean(scope.installationId)) throw new Error("container_installation_required");
}
export function parseApprovedContainerImages(json: string | undefined): ApprovedContainerImage[] {
  if (!json) return [];
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.length > 16) throw new Error("container_registry_invalid");
  const pins = new Set<string>(), ids = new Set(["postgres-16", "redis-7", "chrome-headless", "ffmpeg", "blender-cli", "pytorch-gpu", "r-statistical", "libreoffice"]);
  return value.map(item => {
    if (!item || typeof item !== "object" || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(item.image)
      || !["DOCUMENT_SANDBOX", "MEDIA_SANDBOX", "TOOL_SANDBOX"].includes(item.binding) || item.schedulingPolicy !== "default" || item.networkPolicy !== "none"
      || item.memoryMb !== 4096 || item.cpuCores !== 0.5 || pins.has(item.image))
      throw new Error("container_registry_invalid");
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
    pins.add(item.image); return item as ApprovedContainerImage;
  });
}
/** Resolve actual active installations visible to this actor; never infer a grant from a CLI name. */
export function resolveContainerBinary(command: string, installations: readonly InstalledContainer[], owner: { tenantId: string; spaceId: string; projectId?: string | undefined; userId: string }): InstalledContainer | undefined {
  const matches: InstalledContainer[] = [];
  for (const item of installations) {
    if (item.tenantId !== owner.tenantId || item.spaceId !== owner.spaceId || item.projectId && item.projectId !== owner.projectId || item.userId && item.userId !== owner.userId
      || item.scope === "SPACE_ASSISTANT" && owner.projectId) continue;
    const contract = parseExtensionPrimitive(item.contract);
    if (contract.kind !== "container") throw new Error("container_contract_required");
    if (contract.exportedBinaries.some(binary => command === binary || command === item.extensionId + "/" + contract.id + "/" + binary)) matches.push(item);
  }
  if (matches.length > 1) throw new Error("container_binary_ambiguous: qualify extension/container/binary");
  return matches[0];
}
export function approvedContainer(item: InstalledContainer, registry: readonly ApprovedContainerImage[]): ApprovedContainerImage {
  const approved = registry.find(entry => entry.image === item.contract.image);
  if (!approved) throw new Error("container_image_not_approved");
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
