import type {
  ComputerConfig,
  ExecutionResult,
  ProviderConnection,
  WorkspacePublication,
  WorkspaceSnapshot,
} from "@naelao/sandboxes-core";
export type {
  ComputerConfig,
  ComputerScope,
  ExecutionResult,
  ProviderConnection,
  WorkspacePublication,
  WorkspaceSnapshot,
} from "@naelao/sandboxes-core";

export class SandboxesClient {
  /** `accessToken` is a router-issued bearer JWT. Standalone sandbox API keys are not live yet. */
  constructor(
    private readonly options: {
      baseUrl: string;
      accessToken: string;
      fetch?: typeof fetch;
    }
  ) {}
  private request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const fetcher = this.options.fetch ?? fetch;
    return fetcher(new URL(path, this.options.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
    }).then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok)
        throw Object.assign(
          new Error(
            String(body.message ?? body.error_code ?? `HTTP ${response.status}`)
          ),
          { status: response.status, body }
        );
      return body as T;
    });
  }
  createComputer(input: {
    scope: ComputerConfig["scope"];
    templateId: string;
    templateVersion: string;
    provider?: string;
    resources: ComputerConfig["resources"];
    filesystemId: string;
  }) {
    return this.request<{
      computer: ComputerConfig;
      operation: { id: string; status: string };
    }>("/v1/computers", { method: "POST", body: JSON.stringify(input) });
  }
  getComputer(id: string) {
    return this.request<{ computer: ComputerConfig }>(
      `/v1/computers/${encodeURIComponent(id)}`
    );
  }
  startComputer(id: string) {
    return this.request<{ operation: { id: string; status: string } }>(
      `/v1/computers/${encodeURIComponent(id)}/start`,
      { method: "POST" }
    );
  }
  sleepComputer(id: string) {
    return this.request<{ operation: { id: string; status: string } }>(
      `/v1/computers/${encodeURIComponent(id)}/sleep`,
      { method: "POST" }
    );
  }
  deleteComputer(id: string) {
    return this.request<{ operation: { id: string; status: string } }>(
      `/v1/computers/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }
  execute(
    id: string,
    input: {
      command: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
      idempotencyKey: string;
    }
  ) {
    return this.request<{ execution: ExecutionResult }>(
      `/v1/computers/${encodeURIComponent(id)}/executions`,
      {
        method: "POST",
        headers: { "idempotency-key": input.idempotencyKey },
        body: JSON.stringify(input),
      }
    );
  }
  sync(id: string) {
    return this.request<{
      snapshot: WorkspaceSnapshot;
      publication?: WorkspacePublication;
    }>(`/v1/computers/${encodeURIComponent(id)}/sync`, { method: "POST" });
  }
  listProviders() {
    return this.request<{
      providers: Array<{ id: string; status: string; reason?: string }>;
      autoSchedulingEnabled: boolean;
    }>("/v1/providers");
  }
  listTemplates() {
    return this.request<{
      templates: Array<{
        id: string;
        version: string;
        digest: string | null;
        capabilities: string[];
        verified: boolean;
        availability: string;
      }>;
    }>("/v1/templates");
  }
  listConnections() {
    return this.request<{
      connections: Array<{
        id: string;
        provider: string;
        ownership: string;
        status: string;
        region?: string;
      }>;
    }>("/v1/connections");
  }
  registerConnection(input: {
    provider: "agent37" | "opensandbox";
    credentials: Record<string, string>;
    region?: string;
    idempotencyKey: string;
  }) {
    return this.request<{
      connection: { id: string; provider: string; status: string };
    }>("/v1/connections", {
      method: "POST",
      headers: { "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({
        provider: input.provider,
        credentials: input.credentials,
        ...(input.region ? { region: input.region } : {}),
      }),
    });
  }
  revokeConnection(id: string) {
    return this.request<{ revoked: boolean }>(
      `/v1/connections/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }
}
