// TypeScript client SDK — typed methods, JWT refresh, WebSocket events

export interface NaelaoClientConfig {
  baseUrl: string;
  apiKey?: string;
  jwt?: string;
  onTokenExpired?: () => Promise<string>; // refresh callback
}

export interface ApiResponse<T> {
  data: T;
  error?: never;
}

export interface ApiError {
  data?: never;
  error: { error_code: string; message: string };
  status: number;
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

// ── Space types ──────────────────────────────────────────────────────────────

export interface Space {
  id: string;
  name: string;
  status: string;
  space_type_id: string;
  created_at: string;
}

export interface Session {
  id: string;
  space_id: string;
  status: "active" | "ended";
  created_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

// ── Main client ──────────────────────────────────────────────────────────────

export class NaelaoClient {
  private jwt: string | undefined;

  constructor(private readonly config: NaelaoClientConfig) {
    this.jwt = config.jwt;
  }

  // Spaces
  readonly spaces = {
    list: () => this.get<Space[]>("/v1/spaces"),
    get: (spaceId: string) => this.get<Space>(`/v1/spaces/${spaceId}`),
    create: (params: { name: string; space_type_id: string; config?: Record<string, unknown> }) =>
      this.post<Space>("/v1/spaces", params),
    delete: (spaceId: string) => this.delete<{ deleted: boolean }>(`/v1/spaces/${spaceId}`),
  };

  // Sessions
  readonly sessions = {
    list: (spaceId: string) => this.get<Session[]>(`/v1/spaces/${spaceId}/sessions`),
    create: (spaceId: string, params?: { end_user_id?: string }) =>
      this.post<Session>(`/v1/spaces/${spaceId}/sessions`, params ?? {}),
    end: (spaceId: string, sessionId: string) =>
      this.post<{ ended: boolean }>(`/v1/spaces/${spaceId}/sessions/${sessionId}/end`, {}),
  };

  // Messages
  readonly messages = {
    list: (spaceId: string, sessionId: string) =>
      this.get<Message[]>(`/v1/spaces/${spaceId}/sessions/${sessionId}/messages`),
    send: (spaceId: string, sessionId: string, content: string) =>
      this.post<Message>(`/v1/spaces/${spaceId}/sessions/${sessionId}/messages`, { content }),
    stream: (spaceId: string, sessionId: string, runId: string): EventSource => {
      const url = `${this.config.baseUrl}/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}/stream`;
      if (typeof EventSource === "undefined") throw new Error("EventSource not available");
      return new EventSource(url);
    },
  };

  // API Keys
  readonly apiKeys = {
    list: () => this.get<{ id: string; name: string; scopes: string[]; created_at: string }[]>("/v1/api-keys"),
    create: (params: { name: string; scopes?: string[]; expires_in_days?: number }) =>
      this.post<{ id: string; key: string; name: string }>("/v1/api-keys", params),
    revoke: (keyId: string) => this.delete<{ revoked: boolean }>(`/v1/api-keys/${keyId}`),
  };

  // ── HTTP helpers ─────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<ApiResult<T>> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    return this.request<T>("POST", path, body);
  }

  private async delete<T>(path: string): Promise<ApiResult<T>> {
    return this.request<T>("DELETE", path);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.jwt) {
      headers["Authorization"] = `Bearer ${this.jwt}`;
    } else if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const makeInit = (hdrs: Record<string, string>): RequestInit => {
      const init: RequestInit = { method, headers: hdrs };
      if (body !== undefined) init.body = JSON.stringify(body);
      return init;
    };

    const resp = await fetch(`${this.config.baseUrl}${path}`, makeInit(headers));

    // Handle 401 with JWT refresh
    if (resp.status === 401 && this.config.onTokenExpired && this.jwt) {
      const newToken = await this.config.onTokenExpired();
      this.jwt = newToken;
      headers["Authorization"] = `Bearer ${newToken}`;
      const retryResp = await fetch(`${this.config.baseUrl}${path}`, makeInit(headers));
      return this.parseResponse<T>(retryResp);
    }

    return this.parseResponse<T>(resp);
  }

  private async parseResponse<T>(resp: Response): Promise<ApiResult<T>> {
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        error: {
          error_code: (json as Record<string, string>)["error_code"] ?? "unknown",
          message: (json as Record<string, string>)["message"] ?? `HTTP ${resp.status}`,
        },
        status: resp.status,
      };
    }
    const data = ((json as Record<string, unknown>)["data"] ?? json) as T;
    return { data };
  }

  // Update JWT (e.g., after manual refresh)
  setJwt(jwt: string): void {
    this.jwt = jwt;
  }
}

export function createClient(config: NaelaoClientConfig): NaelaoClient {
  return new NaelaoClient(config);
}
