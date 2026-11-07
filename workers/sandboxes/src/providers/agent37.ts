import type {
  ComputerConfig,
  ExecutionResult,
  ProviderAllocation,
  RuntimeRequest,
  SandboxProvider,
} from "@naelao/sandboxes-core";

const API = "https://api.agent37.com";
const EXEC_API = "https://sandbox.agent37.app";
const MAX_OUTPUT = 512 * 1024;
const MAX_WORKSPACE_FILE_BYTES = 768 * 1024;
const MAX_WORKSPACE_TREE_FILES = 200;
const MAX_WORKSPACE_TREE_BYTES = 64 * 1024 * 1024;
const WORKSPACE_ROOT = "/home/node/workspace";
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

/** Agent37's control plane and instance execution plane require different credentials.
 * This adapter deliberately receives secrets from the caller and never persists/logs them. */
export class Agent37Provider implements SandboxProvider {
  readonly kind = "agent37" as const;
  constructor(
    private readonly credentials: Agent37Credentials,
    private readonly template: Agent37Template,
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
    };
  }
  async inspect(allocation: ProviderAllocation) {
    const result = asObject(
      await this.control(
        `/v1/instances/${encodeURIComponent(allocation.externalId)}`,
        { method: "GET" }
      )
    );
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
    } catch (error) {
      if (controller.signal.aborted)
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
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const result = asObject(await readJson(response));
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

  /** Agent37 file paths are not jailed by the provider. These methods expose only a Naelao-owned subtree. */
  async listWorkspace(allocation: ProviderAllocation): Promise<Array<{ path: string; size: number; modified: number }>> {
    const pending: Array<{ path: string; depth: number }> = [{ path: WORKSPACE_ROOT, depth: 0 }];
    const files: Array<{ path: string; size: number; modified: number }> = [];
    let totalBytes = 0;
    while (pending.length) {
      const { path: directory, depth } = pending.shift()!;
      const entries = await this.directoryEntries(allocation, directory);
      if (entries === null) {
        if (directory === WORKSPACE_ROOT) return [];
        throw new Error("agent37_workspace_directory_missing");
      }
      for (const raw of entries) {
        const entry = asObject(raw) as unknown as Agent37FileEntry;
        if (typeof entry.path !== "string" || entry.path !== `${directory}/${entry.name}` || !entry.path.startsWith(`${WORKSPACE_ROOT}/`)) throw new Error("agent37_workspace_path_escape");
        const relativePath = entry.path.slice(WORKSPACE_ROOT.length + 1);
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

  async readWorkspaceFile(allocation: ProviderAllocation, relativePath: string, maximumBytes = MAX_WORKSPACE_FILE_BYTES): Promise<Uint8Array> {
    const path = workspaceAbsolutePath(relativePath);
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

  async writeWorkspaceFile(allocation: ProviderAllocation, relativePath: string, bytes: Uint8Array, expectedHash: string | null): Promise<void> {
    const path = workspaceAbsolutePath(relativePath);
    if (bytes.byteLength > MAX_WORKSPACE_FILE_BYTES) throw new Error("agent37_workspace_file_limit_exceeded");
    const headers = new Headers({ "content-type": "application/octet-stream" });
    const existing = await this.findWorkspaceFile(allocation, path);
    let url: URL;
    if (expectedHash === null) {
      if (existing) throw new Error("workspace_conflict");
      url = this.fileUrl(allocation, "/v1/files/content", { path, overwrite: "false" });
    } else {
      if (!existing || existing.type !== "file") throw new Error("workspace_conflict");
      if (!Number.isFinite(existing.modified)) throw new Error("agent37_invalid_file_metadata");
      const previous = await this.readWorkspaceFile(allocation, path.slice(WORKSPACE_ROOT.length + 1));
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

  private async findWorkspaceFile(allocation: ProviderAllocation, absolutePath: string): Promise<Agent37FileEntry | null> {
    const slash = absolutePath.lastIndexOf("/");
    const parent = absolutePath.slice(0, slash);
    const target = absolutePath.slice(slash + 1);
    if (!await this.workspaceParentExists(allocation, absolutePath)) return null;
    const entries = await this.directoryEntries(allocation, parent);
    const entry = entries?.map((item) => asObject(item)).find((item) => item.name === target);
    if (entry && entry.path !== absolutePath) throw new Error("agent37_workspace_path_escape");
    return entry ? entry as unknown as Agent37FileEntry : null;
  }

  private async workspaceParentExists(allocation: ProviderAllocation, absolutePath: string): Promise<boolean> {
    const parent = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
    const relative = parent === WORKSPACE_ROOT ? "" : parent.slice(WORKSPACE_ROOT.length + 1);
    let current = WORKSPACE_ROOT;
    if (!await this.directoryEntries(allocation, WORKSPACE_ROOT)) return false;
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
      return await this.fetcher(url, { method, headers, ...(body ? { body } : {}), signal: controller.signal, redirect: "error" });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("agent37_file_request_timeout");
      throw error;
    } finally { clearTimeout(timer); }
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
    const body = await readJson(response);
    if (!response.ok) throw new Error(`agent37_http_${response.status}`);
    return body;
  }
}
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error("agent37_response_too_large");
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
function workspaceAbsolutePath(relativePath: string): string {
  validateWorkspaceRelativePath(relativePath);
  return `${WORKSPACE_ROOT}/${relativePath}`;
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
