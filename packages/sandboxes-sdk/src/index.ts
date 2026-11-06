import type {
  ComputerConfig,
  ExecutionResult,
  ProviderConnection,
  WorkspaceChange,
  WorkspacePublication,
  WorkspaceSnapshot,
} from "@naelao/sandboxes-core";
export type {
  ComputerConfig,
  ComputerScope,
  ExecutionResult,
  ProviderConnection,
  WorkspaceChange,
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
  sync(id: string, input?: { snapshotId: string; changes: WorkspaceChange[]; idempotencyKey: string }) {
    return this.request<{
      snapshot?: WorkspaceSnapshot;
      publication?: WorkspacePublication;
    }>(`/v1/computers/${encodeURIComponent(id)}/sync`, {
      method: "POST",
      body: JSON.stringify(input ? { operation: "publish", ...input } : { operation: "snapshot" }),
    });
  }
  async stageBlob(id: string, snapshotId: string, bytes: Uint8Array, sha256: string, executable = false) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return this.request<{ blobId: string; sha256: string; size: number }>(
      `/v1/computers/${encodeURIComponent(id)}/sync`,
      { method: "POST", body: JSON.stringify({ operation: "stageBlob", snapshotId, sha256, contentBase64: btoa(binary), executable }) },
    );
  }
  async readBlob(blobId: string, expectedSha256?: string): Promise<AsyncIterable<Uint8Array>> {
    const fetcher = this.options.fetch ?? fetch;
    const response = await fetcher(new URL(`/v1/sandbox-workspace-blobs/${encodeURIComponent(blobId)}`, this.options.baseUrl), {
      headers: { authorization: `Bearer ${this.options.accessToken}` },
    });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actualSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const expected = expectedSha256 ?? response.headers.get("x-content-sha256") ?? undefined;
    if (expected && actualSha256 !== expected) throw new Error("sandbox_blob_integrity_failed");
    return { async *[Symbol.asyncIterator]() { yield bytes; } };
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
