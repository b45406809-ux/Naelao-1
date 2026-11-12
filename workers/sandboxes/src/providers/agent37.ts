import type {
  ComputerConfig,
  ExecutionResult,
  ProviderAllocation,
  RuntimeRequest,
  SandboxProvider,
} from "@naelao/sandboxes-core";
import { inferWorkspaceContentType } from "@naelao/types";

const API = "https://api.agent37.com";
const EXEC_API = "https://sandbox.agent37.app";
const MAX_OUTPUT = 512 * 1024;
const MAX_WORKSPACE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_WORKSPACE_TREE_FILES = 200;
const MAX_WORKSPACE_TREE_BYTES = 64 * 1024 * 1024;
const WORKSPACE_ROOT = "/home/node/workspace";
/** Agent37 directory entries do not provide reliable MIME metadata. Infer only from a known
 * filename extension; unknown names stay opaque, while an existing canonical MIME always wins. */
export function inferAgent37ContentType(path: string): string {
  return inferWorkspaceContentType(path);
}

interface Agent37FileEntry { name: string; path: string; type: "file" | "directory" | "symlink" | "other"; size: number | null; modified: number; }
export interface Agent37Credentials {
  apiKey: string;
  instanceKey: string;
}
export interface Agent37Template {
  id: string;
  version: string;
  instanceType: "default" | "performance" | "vm";
  region: "us" | "eu" | "ap-south";
  diskGiB: number;
}

export interface Agent37WorkspaceUsage {
  from: string;
  to: string;
  totalMicros: number;
  byIntegration: Array<{ kind: "compute" | "llm" | "brave" | "composio" | "perflo"; costMicros: number; awakeMinutes?: number }>;
}

/** Checked coordinator boundary. Implementations must call WorkspaceCoordinatorDO, never the
 * legacy per-file bridge. Provider files are only a temporary execution copy. */
export interface Agent37WorkspaceHandoff {
  readSelectedCommitted?(input: { tenantId: string; spaceId: string; projectId: string; branch: string; allocationGeneration: number;
    paths: string[]; allowMissing?: boolean }): Promise<{
      tenantId: string; spaceId: string; projectId: string; branch: string; sessionId: string; revision: number; fence: number;
      allocationGeneration: number;
      files: Array<{ path: string; sha256: string; executable: boolean; contentType?: string; bytes: Uint8Array }>;
    }>;
  readCommitted(input: { tenantId: string; spaceId: string; projectId: string; branch: string; allocationGeneration: number }): Promise<{
    tenantId: string; spaceId: string; projectId: string; branch: string;
    sessionId: string; revision: number; fence: number; allocationGeneration: number;
    files: Array<{ path: string; sha256: string; executable: boolean; contentType?: string; bytes: Uint8Array }>;
  }>;
  stage(input: { sessionId: string; revision: number; fence: number; allocationGeneration: number;
    stageId: string;
    changes: Array<{ path: string; expectedHash: string | null; bytes: Uint8Array | null; executable?: boolean; contentType?: string }>;
  }): Promise<{ stageId: string }>;
  publish(input: { sessionId: string; stageId: string; revision: number; fence: number;
    allocationGeneration: number; idempotencyKey: string }): Promise<{
      status: "published" | "conflicted" | "noop"; publicationId: string;
    }>;
  close?(input: { sessionId: string; fence: number; allocationGeneration: number }): Promise<void>;
}

/** Agent37's control plane and instance execution plane require different credentials.
 * This adapter deliberately receives secrets from the caller and never persists/logs them. */
export class Agent37Provider implements SandboxProvider {
  readonly kind = "agent37" as const;
  constructor(
    private readonly credentials: Agent37Credentials,
    private readonly template: Agent37Template | null,
    private readonly fetcher: typeof fetch = fetch
  ) {
    if (!credentials.apiKey || !credentials.instanceKey)
      throw new Error("agent37_credentials_required");
  }
  async capabilities() {
    return new Set(["exec", "files"] as const);
  }
  async allocate(
    computer: ComputerConfig,
    idempotencyKey: string
  ): Promise<ProviderAllocation> {
    if (!this.template) throw new Error("agent37_allocation_template_required");
    validateAgent37Shape(computer.resources);
    const response = await this.control("/v1/instances", {
      method: "POST",
      body: JSON.stringify({
        template: `${this.template.id}@${this.template.version}`,
        type: this.template.instanceType,
        region: this.template.region,
        resources: {
          cpu: computer.resources.cpu,
          memory: computer.resources.memoryMiB / 1024,
          disk: computer.resources.diskGiB,
        },
        name: computer.id,
        metadata: {
          naelao_computer_id: computer.id,
          naelao_operation_id: idempotencyKey,
        },
        auto_sleep: true,
        idle_timeout_seconds: Math.max(300, computer.idleTimeoutSeconds),
        public_ports: [],
      }),
    });
    const instance = asObject(response);
    const id = instance.id ?? instance.instance_id;
    if (typeof id !== "string" || !/^[a-z0-9]{10}$/.test(id))
      throw new Error("agent37_invalid_instance_response");
    // The instance URL is derived from the documented provider id pattern, not a URL selected
    // by the provider response. The exec API uses its separate documented host.
    const endpoint = `https://${id}.agent37.app`;
    return {
      provider: "agent37",
      externalId: id,
      generation: computer.allocationGeneration,
      region: this.template.region,
      endpoint,
      ...(typeof instance.image_digest === "string" ? { imageDigest: instance.image_digest } : {}),
    };
  }

  /** Control-plane-only instance for inspect/delete recovery; it cannot allocate or execute. */
  static forControlPlane(credentials: Agent37Credentials, fetcher: typeof fetch = fetch): Agent37Provider {
    return new Agent37Provider(credentials, null, fetcher);
  }
  /** Checks only the control-plane API key. The instance execution key and runtime/template
   * capabilities remain unverified until a separately admitted allocation passes acceptance. */
  async verifyControlPlaneCredentials(): Promise<void> {
    asObject(await this.control("/v1/instances?limit=1", { method: "GET" }));
  }
  /** Read the provider-account usage summary. This does not fund, mutate, or admit an instance. */
  async readWorkspaceUsage(from: string, to: string): Promise<Agent37WorkspaceUsage> {
    if (!validUsageDate(from) || !validUsageDate(to) || from > to || dayDistance(from, to) > 89)
      throw new Error("agent37_usage_period_invalid");
    const url = new URL("/v1/usage", API);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    let response: Response;
    try {
      response = await this.fetcher(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.credentials.apiKey}` } });
    } catch { throw new Error("agent37_usage_unavailable"); }
    if (!response.ok) throw new Error(`agent37_http_${response.status}`);
    const result = asObject(await readJson(response));
    if (result.from !== from || result.to !== to || !validProviderMicros(result.total_micros))
      throw new Error("agent37_usage_response_invalid");
    const integrations = result.by_integration;
    if (!integrations || typeof integrations !== "object" || Array.isArray(integrations)) throw new Error("agent37_usage_response_invalid");
    const byIntegration: Agent37WorkspaceUsage["byIntegration"] = [];
    for (const kind of ["compute", "llm", "brave", "composio", "perflo"] as const) {
      const entry = (integrations as Record<string, unknown>)[kind];
      if (entry === undefined) continue;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("agent37_usage_response_invalid");
      const costMicros = (entry as Record<string, unknown>).cost_micros;
      if (!validProviderMicros(costMicros)) throw new Error("agent37_usage_response_invalid");
      const awakeMinutes = (entry as Record<string, unknown>).awake_minutes;
      if (kind === "compute" && awakeMinutes !== undefined && !validProviderMicros(awakeMinutes)) throw new Error("agent37_usage_response_invalid");
      byIntegration.push({ kind, costMicros, ...(kind === "compute" && typeof awakeMinutes === "number" ? { awakeMinutes } : {}) });
    }
    return { from, to, totalMicros: result.total_micros, byIntegration };
  }
  /** Read-only check of the separate instance key against the Agent37 file plane. */
  async verifyInstanceCredentials(allocation: ProviderAllocation): Promise<void> {
    const response = await this.fileRequest(this.fileUrl(allocation, "/v1/files", {}), "GET");
    if (!response.ok) throw new Error(`agent37_file_http_${response.status}`);
    const result = asObject(await readJson(response));
    if (!Array.isArray(result.entries) || typeof result.path !== "string") throw new Error("agent37_invalid_file_listing");
  }
  /** Read-only discovery for a journaled create. Never treats absence as permission to create again. */
  async findInstanceByOperationId(operationId: string): Promise<Record<string, unknown> | null> {
    if (!operationId || operationId.length > 200) throw new Error("agent37_invalid_operation_id");
    const result = asObject(await this.control("/v1/instances", { method: "GET" }));
    if (!Array.isArray(result.data) || result.data.length > 1000) throw new Error("agent37_incomplete_instance_listing");
    const matches = result.data.filter((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const metadata = (value as Record<string, unknown>).metadata;
      return !!metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
        (metadata as Record<string, unknown>).naelao_operation_id === operationId;
    }) as Record<string, unknown>[];
    if (matches.length > 1) throw new Error("agent37_duplicate_operation_metadata");
    return matches[0] ?? null;
  }
  async inspect(allocation: ProviderAllocation) {
    let result: Record<string, unknown>;
    try { result = await this.inspectDetails(allocation); }
    catch (error) {
      if (error instanceof Error && error.message === "agent37_http_404") return { state: "deleted" as const, healthy: false };
      throw error;
    }
    const state = String(result.status ?? result.state ?? "unknown");
    return {
      state:
        state === "running"
          ? ("running" as const)
          : state === "sleeping" || state === "stopped"
            ? ("sleeping" as const)
            : state === "deleted"
              ? ("deleted" as const)
              : ("error" as const),
      healthy: state === "running",
    };
  }
  async inspectDetails(allocation: ProviderAllocation): Promise<Record<string, unknown>> {
    if (!/^[a-z0-9]{10}$/.test(allocation.externalId)) throw new Error("agent37_invalid_instance_id");
    return asObject(await this.control(`/v1/instances/${encodeURIComponent(allocation.externalId)}`, { method: "GET" }));
  }
  async start(allocation: ProviderAllocation) {
    await this.control(
      `/v1/instances/${encodeURIComponent(allocation.externalId)}/start`,
      { method: "POST" }
    );
  }
  async sleep(allocation: ProviderAllocation) {
    await this.control(
      `/v1/instances/${encodeURIComponent(allocation.externalId)}/sleep`,
      { method: "POST" }
    );
  }
  async destroy(allocation: ProviderAllocation) {
    await this.control(
      `/v1/instances/${encodeURIComponent(allocation.externalId)}`,
      { method: "DELETE" }
    );
  }
  async invoke(request: RuntimeRequest): Promise<ExecutionResult> {
    const name = `naelao-${request.executionId}`
      .replace(/[^A-Za-z0-9_.-]/g, "-")
      .slice(0, 120);
    const command = [request.command, ...request.args]
      .map(shellQuote)
      .join(" ");
    const workingDirectory = `cd ${shellQuote(request.cwd ?? WORKSPACE_ROOT)} && `;
    const env = Object.entries(request.environment ?? {})
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || value.includes("\0"))
          throw new Error("agent37_invalid_environment");
        return `export ${key}=${shellQuote(value)};`;
      })
      .join(" ");
    const body = JSON.stringify({
      name,
      command: `${workingDirectory}${env}${env ? " " : ""}${command}`,
    });
    if (new TextEncoder().encode(body).byteLength > 128 * 1024)
      throw new Error("agent37_exec_request_too_large");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(Math.max(1, request.timeoutMs), 300_000)
    );
    let response: Response;
    let result: Record<string, unknown>;
    try {
      response = await this.fetcher(
        new URL(
          `/v1/instances/${encodeURIComponent(request.allocation.externalId)}/exec`,
          EXEC_API
        ),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent37-key": this.credentials.instanceKey,
          },
          body,
          signal: controller.signal,
          redirect: "error",
        }
      );
      result = asObject(await readJson(response));
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.message === "agent37_response_too_large"))
        return {
          id: request.executionId,
          status: "indeterminate",
          exitCode: null,
          stdout: "",
          stderr:
            "Execution response timed out; the provider may still be running the command.",
          truncated: false,
          publicationId: null,
          workspaceState: "recovery_required",
        };
      // A malformed or interrupted response after dispatch cannot prove the command did not run.
      return { id: request.executionId, status: "indeterminate", exitCode: null, stdout: "", stderr: "Provider execution response was incomplete; outcome requires reconciliation.", truncated: false, publicationId: null, workspaceState: "recovery_required" };
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const message = typeof result.error === "string" ? result.error : typeof result.message === "string" ? result.message : `HTTP ${response.status}`;
      return { id: request.executionId, status: "indeterminate", exitCode: null, stdout: "", stderr: bounded(message).text,
        truncated: false, publicationId: null, workspaceState: "recovery_required" };
    }
    const stdout = bounded(result.stdout);
    const stderr = bounded(result.stderr);
    const exitCode =
      typeof result.exit_code === "number" ? result.exit_code : null;
    return {
      id: request.executionId,
      status:
        exitCode === null
          ? "indeterminate"
          : exitCode === 0
            ? "succeeded"
            : "failed",
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated || result.truncated === true,
      publicationId: null,
      workspaceState: "unchanged",
    };
  }

  /** Hydrate and reconcile only through a checked revision handoff. Never use writeWorkspaceFile
   * as publication: Agent37 does not document atomic conditional file writes/deletes. */
  async invokeWithWorkspace(request: RuntimeRequest, coordinator: Agent37WorkspaceHandoff): Promise<ExecutionResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,140}$/.test(request.executionId)) throw new Error("invalid_execution_id");
    if (request.allocation.generation !== request.computer.allocationGeneration) throw new Error("allocation_generation_mismatch");
    const { tenantId, spaceId, projectId, branch } = request.computer.scope;
    if (!tenantId || !spaceId || !projectId) throw new Error("workspace_scope_required");
    const base = await coordinator.readCommitted({ tenantId, spaceId, projectId, branch: branch ?? "main", allocationGeneration: request.allocation.generation });
    let preserveSessionForRecovery = false;
    let executionResult: ExecutionResult | undefined;
    const recovery = (result: ExecutionResult): ExecutionResult => ({ ...result, workspaceState: "recovery_required", workspaceSessionId: base.sessionId });
    try {
    if (base.tenantId !== tenantId || base.spaceId !== spaceId || base.projectId !== projectId || base.branch !== (branch ?? "main")) throw new Error("workspace_scope_mismatch");
    if (base.allocationGeneration !== request.allocation.generation) throw new Error("allocation_generation_mismatch");
    if (!/^ws_[0-9a-f-]{36}$/.test(base.sessionId)) throw new Error("invalid_workspace_session");
    if (base.files.length > MAX_WORKSPACE_TREE_FILES || base.files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > MAX_WORKSPACE_TREE_BYTES) throw new Error("agent37_workspace_tree_limit_exceeded");
    const providerRoot = `${WORKSPACE_ROOT}/handoffs/${base.sessionId}`;
    for (const file of base.files) {
      if (await sha256Hex(file.bytes) !== file.sha256) throw new Error("workspace_snapshot_hash_mismatch");
      await this.writeWorkspaceFile(request.allocation, file.path, file.bytes, null, providerRoot);
    }
    const executablePaths = base.files.filter((file) => file.executable).map((file) => workspaceAbsolutePath(file.path, providerRoot));
    if (executablePaths.length) {
      const mode = await this.invoke({ ...request, executionId: `${request.executionId}.chmod`, command: "chmod", args: ["+x", "--", ...executablePaths], cwd: providerRoot });
      if (mode.status !== "succeeded" || mode.truncated) {
        preserveSessionForRecovery = true;
        return recovery({ ...mode, id: request.executionId });
      }
    }
    executionResult = await this.invoke({ ...request, cwd: workspaceWorkingDirectory(request.cwd, providerRoot) });
    if (executionResult.status === "indeterminate" || executionResult.status === "running" || executionResult.status === "queued") {
      preserveSessionForRecovery = true;
      return recovery(executionResult);
    }
    if (executionResult.status === "cancelled" || executionResult.truncated) {
      preserveSessionForRecovery = true;
      return recovery(executionResult);
    }
    const current = await this.listWorkspace(request.allocation, providerRoot);
    if (current.length > MAX_WORKSPACE_TREE_FILES) throw new Error("agent37_workspace_tree_limit_exceeded");
    const original = new Map(base.files.map((file) => [file.path, file]));
    const changes: Array<{ path: string; expectedHash: string | null; bytes: Uint8Array | null; executable?: boolean; contentType?: string }> = [];
    let total = 0;
    for (const item of current) {
      const before = original.get(item.path);
      const bytes = await this.readWorkspaceFile(request.allocation, item.path, MAX_WORKSPACE_FILE_BYTES, providerRoot);
      total += bytes.byteLength;
      if (total > MAX_WORKSPACE_TREE_BYTES) throw new Error("agent37_workspace_tree_limit_exceeded");
      const hash = await sha256Hex(bytes);
      if (!before || hash !== before.sha256) changes.push({ path: item.path, expectedHash: before?.sha256 ?? null, bytes,
        contentType: before?.contentType ?? inferAgent37ContentType(item.path) });
      original.delete(item.path);
    }
    for (const [path, before] of original) changes.push({ path, expectedHash: before.sha256, bytes: null });
    if (!changes.length) return { ...executionResult, workspaceState: "unchanged" };
    let staged: { stageId: string };
    try {
      staged = await coordinator.stage({ sessionId: base.sessionId, revision: base.revision, fence: base.fence,
        allocationGeneration: base.allocationGeneration, stageId: `agent37:${request.executionId}:stage`, changes });
    } catch {
      // The stage operation may have committed. The coordinator must reconcile this stable
      // execution key; neither the command nor stage request is replayed here.
      preserveSessionForRecovery = true;
      return recovery(executionResult);
    }
    let publication: { status: "published" | "conflicted" | "noop"; publicationId: string };
    try {
      publication = await coordinator.publish({ sessionId: base.sessionId, stageId: staged.stageId,
        revision: base.revision, fence: base.fence, allocationGeneration: base.allocationGeneration,
        idempotencyKey: `agent37:${request.executionId}` });
    } catch {
      // A lost response after dispatch is ambiguous. Recovery queries this receipt; never retry
      // execution or assume the publication failed.
      preserveSessionForRecovery = true;
      return recovery(executionResult);
    }
    return { ...executionResult, publicationId: publication.publicationId,
      workspaceState: publication.status === "published" || publication.status === "noop" ? "published" : "conflicted" };
    } catch (error) {
      if (executionResult) {
        preserveSessionForRecovery = true;
        return recovery(executionResult);
      }
      throw error;
    } finally {
      if (!preserveSessionForRecovery) await coordinator.close?.({ sessionId: base.sessionId, fence: base.fence, allocationGeneration: base.allocationGeneration }).catch(() => undefined);
    }
  }

  /** Agent37 file paths are not jailed by the provider. These methods expose only a Naelao-owned subtree. */
  async listWorkspace(allocation: ProviderAllocation, root = WORKSPACE_ROOT): Promise<Array<{ path: string; size: number; modified: number }>> {
    validateWorkspaceRoot(root);
    const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    const files: Array<{ path: string; size: number; modified: number }> = [];
    let totalBytes = 0;
    while (pending.length) {
      const { path: directory, depth } = pending.shift()!;
      const entries = await this.directoryEntries(allocation, directory);
      if (entries === null) {
        if (directory === root) return [];
        throw new Error("agent37_workspace_directory_missing");
      }
      for (const raw of entries) {
        const entry = asObject(raw) as unknown as Agent37FileEntry;
        if (typeof entry.path !== "string" || entry.path !== `${directory}/${entry.name}` || !entry.path.startsWith(`${root}/`)) throw new Error("agent37_workspace_path_escape");
        const relativePath = entry.path.slice(root.length + 1);
        validateWorkspaceRelativePath(relativePath);
        if (entry.type === "directory") {
          if (depth >= 32) throw new Error("agent37_workspace_depth_limit_exceeded");
          pending.push({ path: entry.path, depth: depth + 1 });
          if (pending.length + files.length > MAX_WORKSPACE_TREE_FILES) throw new Error("agent37_workspace_file_limit_exceeded");
        } else if (entry.type === "file") {
          if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_WORKSPACE_FILE_BYTES || !Number.isFinite(entry.modified)) throw new Error("agent37_workspace_file_limit_exceeded");
          totalBytes += entry.size;
          if (totalBytes > MAX_WORKSPACE_TREE_BYTES || files.length >= MAX_WORKSPACE_TREE_FILES) throw new Error("agent37_workspace_tree_limit_exceeded");
          files.push({ path: relativePath, size: entry.size, modified: entry.modified });
        } else {
          // Symlinks and special files are not represented in the Naelao manifest contract.
          throw new Error("agent37_workspace_unsupported_file_type");
        }
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readWorkspaceFile(allocation: ProviderAllocation, relativePath: string, maximumBytes = MAX_WORKSPACE_FILE_BYTES, root = WORKSPACE_ROOT): Promise<Uint8Array> {
    validateWorkspaceRoot(root);
    const path = workspaceAbsolutePath(relativePath, root);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAX_WORKSPACE_FILE_BYTES) throw new Error("agent37_workspace_file_limit_exceeded");
    if (!await this.workspaceParentExists(allocation, path)) throw new Error("agent37_workspace_file_not_found");
    const url = this.fileUrl(allocation, "/v1/files/content", { path });
    const response = await this.fileRequest(url, "GET");
    if (!response.ok) throw new Error(`agent37_file_http_${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new Error("agent37_workspace_file_limit_exceeded");
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximumBytes) {
          await reader.cancel();
          throw new Error("agent37_workspace_file_limit_exceeded");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }

  async writeWorkspaceFile(allocation: ProviderAllocation, relativePath: string, bytes: Uint8Array, expectedHash: string | null, root = WORKSPACE_ROOT): Promise<void> {
    validateWorkspaceRoot(root);
    const path = workspaceAbsolutePath(relativePath, root);
    if (bytes.byteLength > MAX_WORKSPACE_FILE_BYTES) throw new Error("agent37_workspace_file_limit_exceeded");
    const headers = new Headers({ "content-type": "application/octet-stream" });
    const existing = await this.findWorkspaceFile(allocation, path, root);
    let url: URL;
    if (expectedHash === null) {
      if (existing) throw new Error("workspace_conflict");
      url = this.fileUrl(allocation, "/v1/files/content", { path, overwrite: "false" });
    } else {
      if (!existing || existing.type !== "file") throw new Error("workspace_conflict");
      if (!Number.isFinite(existing.modified)) throw new Error("agent37_invalid_file_metadata");
      const previous = await this.readWorkspaceFile(allocation, path.slice(root.length + 1), MAX_WORKSPACE_FILE_BYTES, root);
      if (await sha256Hex(previous) !== expectedHash) throw new Error("workspace_conflict");
      headers.set("x-expected-mtime", String(existing.modified));
      url = this.fileUrl(allocation, "/v1/files/content", { path, overwrite: "true" });
    }
    const response = await this.fileRequest(url, "PUT", headers, bytes);
    if (response.status === 409 || response.status === 412) throw new Error("workspace_conflict");
    if (!response.ok) throw new Error(`agent37_file_http_${response.status}`);
    const entry = asObject(await readJson(response));
    if (entry.path !== path || entry.type !== "file" || entry.size !== bytes.byteLength) throw new Error("agent37_invalid_file_write_receipt");
  }

  async deleteWorkspaceFile(allocation: ProviderAllocation, relativePath: string, expectedHash: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("invalid_expected_hash");
    const path = workspaceAbsolutePath(relativePath);
    const existing = await this.findWorkspaceFile(allocation, path);
    if (!existing || existing.type !== "file") throw new Error("workspace_conflict");
    const bytes = await this.readWorkspaceFile(allocation, relativePath);
    if (await sha256Hex(bytes) !== expectedHash) throw new Error("workspace_conflict");
    const response = await this.fileRequest(this.fileUrl(allocation, "/v1/files", { path }), "DELETE");
    if (!response.ok) throw new Error(`agent37_file_http_${response.status}`);
  }

  private async findWorkspaceFile(allocation: ProviderAllocation, absolutePath: string, root = WORKSPACE_ROOT): Promise<Agent37FileEntry | null> {
    const slash = absolutePath.lastIndexOf("/");
    const parent = absolutePath.slice(0, slash);
    const target = absolutePath.slice(slash + 1);
    if (!await this.workspaceParentExists(allocation, absolutePath, root)) return null;
    const entries = await this.directoryEntries(allocation, parent);
    const entry = entries?.map((item) => asObject(item)).find((item) => item.name === target);
    if (entry && entry.path !== absolutePath) throw new Error("agent37_workspace_path_escape");
    return entry ? entry as unknown as Agent37FileEntry : null;
  }

  private async workspaceParentExists(allocation: ProviderAllocation, absolutePath: string, root = WORKSPACE_ROOT): Promise<boolean> {
    const parent = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
    const relative = parent === root ? "" : parent.slice(root.length + 1);
    let current = root;
    if (!await this.directoryEntries(allocation, root)) return false;
    for (const segment of relative ? relative.split("/") : []) {
      const entries = await this.directoryEntries(allocation, current);
      if (!entries) return false;
      const child = entries.map((item) => asObject(item)).find((item) => item.name === segment);
      const expected = `${current}/${segment}`;
      if (!child) return false;
      if (child.path !== expected) throw new Error("agent37_workspace_path_escape");
      if (child.type !== "directory") throw new Error("agent37_workspace_unsupported_file_type");
      current = expected;
    }
    return current === parent;
  }

  private async directoryEntries(allocation: ProviderAllocation, path: string): Promise<unknown[] | null> {
    let value: unknown;
    try { value = await this.fileJson(this.fileUrl(allocation, "/v1/files", { path }), "GET"); }
    catch (error) {
      if (error instanceof Error && error.message === "agent37_file_http_404") return null;
      throw error;
    }
    const result = asObject(value);
    if (result.path !== path) throw new Error("agent37_workspace_path_escape");
    if (result.truncated === true || !Array.isArray(result.entries)) throw new Error("agent37_workspace_listing_incomplete");
    return result.entries;
  }

  private fileUrl(allocation: ProviderAllocation, path: string, query: Record<string, string>): URL {
    if (!/^[a-z0-9]{10}$/.test(allocation.externalId)) throw new Error("agent37_invalid_instance_id");
    const url = new URL(path, `https://${allocation.externalId}.agent37.app`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private async fileRequest(url: URL, method: string, headers = new Headers(), body?: Uint8Array): Promise<Response> {
    headers.set("x-agent37-key", this.credentials.instanceKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetcher(url, { method, headers, ...(body ? { body } : {}), signal: controller.signal, redirect: "error" });
      if (!response.body) { clearTimeout(timer); return response; }
      const reader = response.body.getReader();
      let finished = false;
      const finish = () => { if (!finished) { finished = true; clearTimeout(timer); } };
      const boundedBody = new ReadableStream<Uint8Array>({
        async pull(target) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { finish(); target.close(); }
            else target.enqueue(chunk.value);
          } catch (error) { finish(); target.error(controller.signal.aborted ? new Error("agent37_file_request_timeout") : error); }
        },
        async cancel(reason) { finish(); await reader.cancel(reason); },
      });
      return new Response(boundedBody, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new Error("agent37_file_request_timeout");
      throw error;
    }
  }

  private async fileJson(url: URL, method: string): Promise<unknown> {
    const response = await this.fileRequest(url, method);
    if (!response.ok) throw new Error(`agent37_file_http_${response.status}`);
    return readJson(response);
  }
  private async control(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.credentials.apiKey}`);
    headers.set("content-type", "application/json");
    const response = await this.fetcher(new URL(path, API), {
      ...init,
      headers,
      redirect: "error",
    });
    // A 404 is authoritative absence for read-only reconciliation and does not need a
    // provider error body, which may be empty or non-JSON.
    if (response.status === 404) throw new Error("agent37_http_404");
    const body = await readJson(response);
    if (!response.ok) throw new Error(`agent37_http_${response.status}`);
    return body;
  }
}
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new Error("agent37_response_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("agent37_invalid_json");
  }
}
function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("agent37_invalid_response");
  return value as Record<string, unknown>;
}
function validUsageDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function dayDistance(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000;
}
function validProviderMicros(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 9_000_000_000_000;
}
function bounded(value: unknown) {
  const text = typeof value === "string" ? value : "";
  return {
    text: text.slice(0, MAX_OUTPUT),
    truncated: text.length > MAX_OUTPUT,
  };
}
function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("agent37_invalid_command");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function validateWorkspaceRelativePath(value: string): void {
  if (!value || value.length > 1024 || value.startsWith("/") || value.includes("\\") || value.includes("\0") ||
      value.split("/").some((part) => !part || part === "." || part === ".." || new TextEncoder().encode(part).byteLength > 255 ||
      part === ".env" || part.startsWith(".env.") && part !== ".env.example" || [".git", ".naelao", ".avos", "node_modules", ".cache", ".turbo", ".next", ".vite", "coverage", "tmp", ".tmp", ".artifactfs-staging"].includes(part))) {
    throw new Error("agent37_workspace_path_rejected");
  }
}
function workspaceAbsolutePath(relativePath: string, root = WORKSPACE_ROOT): string {
  validateWorkspaceRelativePath(relativePath);
  validateWorkspaceRoot(root);
  return `${root}/${relativePath}`;
}
function validateWorkspaceRoot(root: string): void {
  if ((root !== WORKSPACE_ROOT && !root.startsWith(`${WORKSPACE_ROOT}/`)) || root.includes("..") || root.includes("\\") || root.includes("\0")) throw new Error("agent37_workspace_path_rejected");
}
function workspaceWorkingDirectory(requested: string | undefined, root: string): string {
  if (!requested) return root;
  if (requested === ".") return root;
  if (requested === WORKSPACE_ROOT) return root;
  if (requested.startsWith(`${WORKSPACE_ROOT}/`)) return `${root}/${validateAndReturnRelative(requested.slice(WORKSPACE_ROOT.length + 1))}`;
  return `${root}/${validateAndReturnRelative(requested)}`;
}
function validateAndReturnRelative(value: string): string {
  validateWorkspaceRelativePath(value);
  return value;
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function validateAgent37Shape(shape: ComputerConfig["resources"]): void {
  const memoryGiB = shape.memoryMiB / 1024;
  const maxDisk =
    shape.cpu === 2 && memoryGiB === 4
      ? 12
      : shape.cpu === 4 && memoryGiB === 8
        ? 20
        : shape.cpu === 4 && memoryGiB === 16
          ? 40
          : shape.cpu === 4 && memoryGiB === 32
            ? 80
            : 0;
  if (
    !maxDisk ||
    !Number.isInteger(shape.diskGiB) ||
    shape.diskGiB < 2 ||
    shape.diskGiB > maxDisk
  )
    throw new Error("agent37_unsupported_resource_shape");
}
