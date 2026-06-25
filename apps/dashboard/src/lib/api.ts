// API client for Naelao router worker
// G-BE01: Auth endpoints, G-BE10: SpaceType CRUD, G-BE20: Space CRUD, G-BE30: KB management

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SpaceType {
  id: string;
  name: string;
  description: string;
  status: string;
  schema_json: string;
  version: string;
  created_at: string;
}

export interface CreateSpaceTypeInput {
  name: string;
  description: string;
  system_prompt_template: string;
  model_config: {
    model: string;
    max_tokens: number;
    temperature: number;
  };
  kb_config: {
    max_documents: number;
    chunk_size: number;
    top_k: number;
  };
  tools: Array<{ name: string; description: string }>;
}

export interface Space {
  id: string;
  name: string;
  spacetype_id: string;
  status: string;
  config_json: string;
  created_at: string;
}

export interface CreateSpaceInput {
  name: string;
  spacetype_id: string;
  config_overrides?: Record<string, unknown>;
}

export interface KbDocument {
  id: string;
  title: string;
  status: string;
  chunk_count: number;
  content_type: string;
  created_at: string;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    role: string;
    plan_tier: string;
  };
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
}

// ── Token helpers ────────────────────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("naelao_token");
}

export function getApiBase(): string {
  return API_URL;
}

export function getAuthHeader(): string | null {
  const token = getToken();
  return token ? `Bearer ${token}` : null;
}

// ── Core fetch wrapper ───────────────────────────────────────────────────────

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let message = `API error ${res.status}`;
    try {
      const body = await res.json() as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // use default message
    }
    throw new Error(message);
  }

  // Handle 204 No Content
  if (res.status === 204) {
    return undefined as unknown as T;
  }

  return res.json() as Promise<T>;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export async function login(
  email: string,
  password: string
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function register(
  email: string,
  password: string,
  orgName?: string
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, org_name: orgName }),
  });
}

// ── SpaceTypes ───────────────────────────────────────────────────────────────

export async function listSpaceTypes(): Promise<SpaceType[]> {
  const res = await apiFetch<{ data: SpaceType[] } | SpaceType[]>("/spacetypes");
  // Handle both wrapped and unwrapped responses
  if (Array.isArray(res)) return res;
  return (res as { data: SpaceType[] }).data ?? [];
}

export async function createSpaceType(
  data: CreateSpaceTypeInput
): Promise<SpaceType> {
  return apiFetch<SpaceType>("/spacetypes", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getSpaceType(id: string): Promise<SpaceType> {
  return apiFetch<SpaceType>(`/spacetypes/${id}`);
}

export async function updateSpaceType(
  id: string,
  data: Partial<CreateSpaceTypeInput>
): Promise<SpaceType> {
  return apiFetch<SpaceType>(`/spacetypes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ── Spaces ───────────────────────────────────────────────────────────────────

export async function listSpaces(): Promise<Space[]> {
  const res = await apiFetch<{ data: Space[] } | Space[]>("/spaces");
  if (Array.isArray(res)) return res;
  return (res as { data: Space[] }).data ?? [];
}

export async function createSpace(data: CreateSpaceInput): Promise<Space> {
  return apiFetch<Space>("/spaces", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getSpace(id: string): Promise<Space> {
  return apiFetch<Space>(`/spaces/${id}`);
}

export async function updateSpace(
  id: string,
  data: Partial<{ name: string; status: string; configOverrides: Record<string, unknown> }>
): Promise<Space> {
  return apiFetch<Space>(`/spaces/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ── KB Documents ─────────────────────────────────────────────────────────────

export async function listKbDocs(spaceId: string): Promise<KbDocument[]> {
  const res = await apiFetch<{ data: KbDocument[] } | KbDocument[]>(
    `/spaces/${spaceId}/kb`
  );
  if (Array.isArray(res)) return res;
  return (res as { data: KbDocument[] }).data ?? [];
}

export async function uploadKbDoc(
  spaceId: string,
  data: { title: string; content: string; content_type: string }
): Promise<KbDocument> {
  return apiFetch<KbDocument>(`/spaces/${spaceId}/kb`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteKbDoc(
  spaceId: string,
  docId: string
): Promise<void> {
  return apiFetch<void>(`/spaces/${spaceId}/kb/${docId}`, {
    method: "DELETE",
  });
}

// ── API Keys ─────────────────────────────────────────────────────────────────

export async function listApiKeys(): Promise<ApiKey[]> {
  const res = await apiFetch<{ data: ApiKey[] } | ApiKey[]>("/settings/api-keys");
  if (Array.isArray(res)) return res;
  return (res as { data: ApiKey[] }).data ?? [];
}

export async function createApiKey(name: string): Promise<{ key: string } & ApiKey> {
  return apiFetch<{ key: string } & ApiKey>("/settings/api-keys", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  return apiFetch<void>(`/settings/api-keys/${id}`, { method: "DELETE" });
}

// ── Billing ──────────────────────────────────────────────────────────────────

export async function createBillingCheckout(planTier: string): Promise<{ url: string }> {
  return apiFetch<{ url: string }>("/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ plan_tier: planTier }),
  });
}

export async function getBillingSubscription(): Promise<{
  plan_tier: string;
  status: string;
  current_period_end: string;
}> {
  return apiFetch<{ plan_tier: string; status: string; current_period_end: string }>(
    "/billing/subscription"
  );
}
