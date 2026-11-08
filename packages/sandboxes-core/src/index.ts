export type ProviderKind =
  | "agent37"
  | "opensandbox"
  | "cloudflare"
  | "local"
  | "webcontainer";
export type OwnershipMode =
  | "provider_native"
  | "customer_owned"
  | "naelao_managed"
  | "delegated";
export type ComputerState =
  | "configured"
  | "provisioning"
  | "starting"
  | "running"
  | "syncing"
  | "sleeping"
  | "stopping"
  | "recovery_required"
  | "deleting"
  | "deleted"
  | "error";
export type FilesystemMode = "snapshot_diff" | "managed_volume" | "live_mount";
export type ComputerCapability =
  | "exec"
  | "files"
  | "browser"
  | "desktop.screenshot"
  | "desktop.control"
  | "desktop.stream"
  | "preview";

export interface ComputerScope {
  tenantId: string;
  ownerId: string;
  spaceId?: string;
  projectId?: string;
  branch?: string;
}
export interface ResourceShape {
  cpu: number;
  memoryMiB: number;
  diskGiB: number;
}
export interface ComputerConfig {
  id: string;
  scope: ComputerScope;
  templateId: string;
  templateVersion: string;
  ownership: OwnershipMode;
  filesystemId: string;
  filesystemMode: FilesystemMode;
  providerPreference: ProviderKind | "auto";
  state: ComputerState;
  resources: ResourceShape;
  idleTimeoutSeconds: number;
  allocationGeneration: number;
}
export interface ProviderConnection {
  id: string;
  tenantId: string;
  provider: ProviderKind;
  ownership: OwnershipMode;
  status:
    | "configured"
    | "configured_unverified"
    | "verified"
    | "unavailable"
    | "revoked";
  region?: string;
  capabilities: ComputerCapability[];
}
export interface ProviderAllocation {
  provider: ProviderKind;
  externalId: string;
  generation: number;
  region?: string;
  endpoint?: string;
}
export interface RuntimeRequest {
  executionId: string;
  computer: ComputerConfig;
  allocation: ProviderAllocation;
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  environment?: Record<string, string>;
}
export interface ExecutionResult {
  id: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "indeterminate";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  publicationId: string | null;
  /** Present when a checked handoff needs explicit receipt/recovery reconciliation. */
  workspaceSessionId?: string;
  workspaceState:
    | "unchanged"
    | "published"
    | "conflicted"
    | "recovery_required";
}
export interface SnapshotEntry {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
  blobId: string;
}
export interface WorkspaceSnapshot {
  id: string;
  filesystemId: string;
  branch: string;
  consistency: "file_cas" | "exclusive_workspace";
  entries: SnapshotEntry[];
}
export interface WorkspaceChange {
  path: string;
  expectedHash: string | null;
  blobId: string | null;
  executable?: boolean;
}
export interface WorkspacePublication {
  id: string;
  status: "pending" | "published" | "conflicted" | "recovery_required";
  appliedPaths: string[];
  conflicts: Array<{
    path: string;
    expectedHash: string | null;
    actualHash: string | null;
  }>;
}
export interface SandboxProvider {
  readonly kind: ProviderKind;
  capabilities(
    connection: ProviderConnection
  ): Promise<Set<ComputerCapability>>;
  allocate(
    computer: ComputerConfig,
    idempotencyKey: string
  ): Promise<ProviderAllocation>;
  inspect(
    allocation: ProviderAllocation
  ): Promise<{ state: ComputerState; healthy: boolean }>;
  start(allocation: ProviderAllocation): Promise<void>;
  sleep(allocation: ProviderAllocation): Promise<void>;
  destroy(allocation: ProviderAllocation): Promise<void>;
  invoke(request: RuntimeRequest): Promise<ExecutionResult>;
}
export interface WorkspaceFilesystem {
  snapshot(
    filesystemId: string,
    scope: ComputerScope,
    branch: string
  ): Promise<WorkspaceSnapshot>;
  readBlob(blobId: string): Promise<AsyncIterable<Uint8Array>>;
  stageBlob(
    filesystemId: string,
    bytes: AsyncIterable<Uint8Array>,
    expectedSha256: string
  ): Promise<string>;
  publish(
    filesystemId: string,
    scope: ComputerScope,
    branch: string,
    changes: WorkspaceChange[]
  ): Promise<WorkspacePublication>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export function validateComputerScope(scope: ComputerScope): void {
  for (const [name, value] of Object.entries(scope)) {
    if (value !== undefined && (typeof value !== "string" || !ID.test(value)))
      throw new Error(`invalid_${name}`);
  }
  if ((scope.spaceId && !scope.tenantId) || (scope.projectId && !scope.spaceId))
    throw new Error("invalid_computer_scope_hierarchy");
}
export function validateResourceShape(shape: ResourceShape): void {
  if (!Number.isFinite(shape.cpu) || shape.cpu <= 0 || shape.cpu > 64)
    throw new Error("invalid_cpu");
  if (
    !Number.isInteger(shape.memoryMiB) ||
    shape.memoryMiB < 256 ||
    shape.memoryMiB > 262144
  )
    throw new Error("invalid_memory_mib");
  if (
    !Number.isInteger(shape.diskGiB) ||
    shape.diskGiB < 1 ||
    shape.diskGiB > 4096
  )
    throw new Error("invalid_disk_gib");
}
export function assertWorkspacePath(path: string): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("invalid_workspace_path");
  if (
    path
      .split("/")
      .some(
        (part) =>
          part === ".git" ||
          part === "node_modules" ||
          part.startsWith(".environment-artifacts")
      )
  )
    throw new Error("restricted_workspace_path");
  return path;
}
export function selectProvider<
  T extends {
    provider: ProviderKind;
    status: ProviderConnection["status"];
    capabilities: ComputerCapability[];
  },
>(
  connections: T[],
  required: ComputerCapability[],
  preference: ProviderKind | "auto"
): T | null {
  const eligible = connections.filter(
    (item) =>
      item.status === "verified" &&
      required.every((capability) => item.capabilities.includes(capability))
  );
  if (preference !== "auto")
    return eligible.find((item) => item.provider === preference) ?? null;
  return eligible[0] ?? null;
}

export interface MonthlyCostEstimate {
  provider: ProviderKind;
  currency: "USD";
  micros: number;
  assumptions: string[];
  source: string;
  observedAt: string;
}
export function estimateAgent37Monthly(
  shape: ResourceShape,
  allocatedPercent: number,
  observedAt: string,
  instanceType: "default" | "performance" | "vm" = "default"
): MonthlyCostEstimate {
  if (allocatedPercent < 0 || allocatedPercent > 1)
    throw new Error("invalid_allocated_percent");
  // Current Agent37 billing docs: $0.80/vCPU-month, $0.70/GB-month RAM,
  // $0.09/GB-month disk; VM compute is 2.5x and performance compute is 4x.
  const factor =
    instanceType === "vm" ? 2.5 : instanceType === "performance" ? 4 : 1;
  const compute = shape.cpu * 0.8 * factor * allocatedPercent;
  const dollars =
    compute + (shape.memoryMiB / 1024) * 0.7 + shape.diskGiB * 0.09;
  return {
    provider: "agent37",
    currency: "USD",
    micros: Math.round(dollars * 1_000_000),
    assumptions: [
      `allocated_cpu_percent=${allocatedPercent}`,
      `instance_type=${instanceType}`,
      `compute_multiplier=${factor}x`,
      "RAM and disk charged while allocated",
    ],
    source: "https://www.agent37.com/docs/agents-api/billing",
    observedAt,
  };
}
