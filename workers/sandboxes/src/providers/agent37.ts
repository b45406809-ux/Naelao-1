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
    const workingDirectory = request.cwd
      ? `cd ${shellQuote(request.cwd)} && `
      : "";
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
      truncated: stdout.truncated || stderr.truncated,
      publicationId: null,
      workspaceState: "unchanged",
    };
  }
  private async control(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.credentials.apiKey}`);
    headers.set("content-type", "application/json");
    const response = await this.fetcher(new URL(path, API), {
      ...init,
      headers,
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
