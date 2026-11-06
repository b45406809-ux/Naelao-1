import type {
  ComputerConfig,
  ExecutionResult,
  ProviderAllocation,
  RuntimeRequest,
  SandboxProvider,
} from "@naelao/sandboxes-core";

export interface OpenSandboxConfig {
  baseUrl: string;
  apiKey: string;
  template: string;
}
/** Adapter for a customer or Naelao managed OpenSandbox control plane. The API key stays
 * provider-side; runtime execution still uses the Naelao guest protocol, never Docker exec. */
export class OpenSandboxProvider implements SandboxProvider {
  readonly kind = "opensandbox" as const;
  constructor(
    private readonly config: OpenSandboxConfig,
    private readonly fetcher: typeof fetch = fetch
  ) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "https:" || !config.apiKey)
      throw new Error("opensandbox_https_endpoint_and_key_required");
  }
  async capabilities() {
    return new Set(["exec", "files"] as const);
  }
  async allocate(
    computer: ComputerConfig,
    idempotencyKey: string
  ): Promise<ProviderAllocation> {
    const body = await this.call("/sandboxes", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({
        template: this.config.template,
        metadata: { computer_id: computer.id },
        expires_in: 3600,
      }),
    });
    const id = object(body).id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(id))
      throw new Error("opensandbox_invalid_create_response");
    return {
      provider: "opensandbox",
      externalId: id,
      generation: computer.allocationGeneration,
      endpoint: this.config.baseUrl,
    };
  }
  async inspect(allocation: ProviderAllocation) {
    const value = object(
      await this.call(
        `/sandboxes/${encodeURIComponent(allocation.externalId)}`,
        { method: "GET" }
      )
    );
    const state = String(value.status ?? value.state);
    return {
      state:
        state === "running"
          ? ("running" as const)
          : state === "paused"
            ? ("sleeping" as const)
            : ("error" as const),
      healthy: state === "running",
    };
  }
  async start(allocation: ProviderAllocation) {
    await this.call(
      `/sandboxes/${encodeURIComponent(allocation.externalId)}/resume`,
      { method: "POST", body: "{}" }
    );
  }
  async sleep(allocation: ProviderAllocation) {
    await this.call(
      `/sandboxes/${encodeURIComponent(allocation.externalId)}/pause`,
      { method: "POST", body: "{}" }
    );
  }
  async destroy(allocation: ProviderAllocation) {
    await this.call(`/sandboxes/${encodeURIComponent(allocation.externalId)}`, {
      method: "DELETE",
    });
  }
  async invoke(_request: RuntimeRequest): Promise<ExecutionResult> {
    throw new Error("opensandbox_runtime_endpoint_unverified");
  }
  private async call(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.set("OPEN-SANDBOX-API-KEY", this.config.apiKey);
    headers.set("content-type", "application/json");
    const response = await this.fetcher(
      new URL(`/v1${path}`, this.config.baseUrl),
      { ...init, headers }
    );
    const text = await response.text();
    if (text.length > 1024 * 1024)
      throw new Error("opensandbox_response_too_large");
    let value: unknown = {};
    try {
      if (text) value = JSON.parse(text);
    } catch {
      throw new Error("opensandbox_invalid_json");
    }
    if (!response.ok) throw new Error(`opensandbox_http_${response.status}`);
    return value;
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("opensandbox_invalid_response");
  return value as Record<string, unknown>;
}
