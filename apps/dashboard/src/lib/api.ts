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

// ── Reseller / client portfolio ──────────────────────────────────────────────

export interface ResellerClient {
  child_tenant_id: string;
  child_owner_user_id: string;
  status: string;
  created_at: string;
  space_count: number;
}

export interface ResellerClientsResponse {
  clients: ResellerClient[];
  client_count: number;
  current_period: string;
  billing: {
    retail: number;
    wholesale: number;
    margin: number;
    events: number;
  };
}

export async function getResellerClients(): Promise<ResellerClientsResponse> {
  return apiFetch<ResellerClientsResponse>("/reseller/clients");
}

export interface ResellerClientSpace {
  id: string;
  name: string;
  spacetype_id: string;
  status: string;
  tenancy_mode: string;
  created_at: string;
}

export interface ResellerClientDetail {
  child_tenant_id: string;
  parent_tenant_id: string;
  status: string;
  spaces: ResellerClientSpace[];
  space_count: number;
}

export async function getResellerClient(childTenantId: string): Promise<ResellerClientDetail> {
  return apiFetch<ResellerClientDetail>(`/reseller/clients/${encodeURIComponent(childTenantId)}`);
}

export async function setResellerClientStatus(
  childTenantId: string,
  status: "active" | "suspended"
): Promise<{ child_tenant_id: string; status: string }> {
  return apiFetch(`/reseller/clients/${encodeURIComponent(childTenantId)}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export async function promoteResellerClient(
  childTenantId: string
): Promise<{ promoted: boolean; child_tenant_id: string }> {
  return apiFetch(`/reseller/clients/${encodeURIComponent(childTenantId)}/promote`, {
    method: "POST",
    body: JSON.stringify({ acknowledge_irreversible: true }),
  });
}

// ── Sub-spaces (departments) + cross-space grants ────────────────────────────

export interface SubSpace {
  id: string;
  parent_id: string | null;
  name: string;
  space_type: string;
  tenancy_mode: string;
  agency_shell: boolean;
  depth: number;
  scenario_type: string | null;
  status: string;
  created_at: string;
}

export async function listSubSpaces(spaceId: string): Promise<SubSpace[]> {
  const res = await apiFetch<{ data: SubSpace[] }>(`/spaces/${spaceId}/sub-spaces`);
  return res.data ?? [];
}

export async function createSubSpace(
  spaceId: string,
  data: { name: string; parent_id?: string }
): Promise<SubSpace> {
  return apiFetch<SubSpace>(`/spaces/${spaceId}/sub-spaces`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ── Commerce (Launchpad: products / orders / revenue) ────────────────────────

export interface Product {
  id: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  kind: "one_time" | "subscription";
  fulfillment_r2_key: string | null;
  status: "draft" | "published" | "archived";
  created_at: string;
}

export interface Order {
  id: string;
  product_id: string | null;
  product_name?: string | null;
  customer_email: string | null;
  gross_cents: number;
  fee_cents: number;
  net_cents: number;
  currency: string;
  status: string;
  created_at: string;
}

export interface RevenueSummary {
  period: string;
  currency: string;
  gross_cents: number;
  fee_cents: number;
  net_cents: number;
  order_count: number;
}

export async function listProducts(spaceId: string): Promise<{ data: Product[]; currency: string }> {
  return apiFetch<{ data: Product[]; currency: string }>(`/spaces/${spaceId}/products`);
}

export async function createProduct(
  spaceId: string,
  data: { name: string; description?: string; price_cents?: number; kind?: "one_time" | "subscription" }
): Promise<Product> {
  return apiFetch<Product>(`/spaces/${spaceId}/products`, { method: "POST", body: JSON.stringify(data) });
}

export async function updateProduct(
  spaceId: string,
  productId: string,
  data: Partial<{ name: string; description: string; price_cents: number; status: "draft" | "published" | "archived" }>
): Promise<{ id: string }> {
  return apiFetch(`/spaces/${spaceId}/products/${productId}`, { method: "PATCH", body: JSON.stringify(data) });
}

export async function deleteProduct(spaceId: string, productId: string): Promise<void> {
  return apiFetch<void>(`/spaces/${spaceId}/products/${productId}`, { method: "DELETE" });
}

export async function listOrders(spaceId: string): Promise<{ data: Order[] }> {
  return apiFetch<{ data: Order[] }>(`/spaces/${spaceId}/orders`);
}

export async function getRevenue(spaceId: string): Promise<RevenueSummary> {
  return apiFetch<RevenueSummary>(`/spaces/${spaceId}/revenue`);
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

// ── Connectors (external-platform connector layer; "Whop first, rest coming soon") ──

export interface ConnectorOperation {
  name: string;
  description: string;
  kind: "read" | "write";
}

export interface Connector {
  id: string;
  name: string;
  category: string;
  status: "available" | "coming_soon";
  summary: string;
  docs_url?: string;
  auth: { type: "bearer" | "api_key" | "none"; credential_name: string };
  mcp_endpoint?: string;
  operations?: ConnectorOperation[];
  /** Present on the status endpoint: whether this space has already connected it. */
  connected?: boolean;
}

/** The read-only catalogue (Whop available, the rest coming_soon). */
export async function listConnectors(): Promise<Connector[]> {
  const res = await apiFetch<{ connectors: Connector[] }>("/connectors");
  return res.connectors ?? [];
}

/** The catalogue annotated with which connectors this space has already connected. */
export async function getConnectorStatus(spaceId: string): Promise<Connector[]> {
  const res = await apiFetch<{ connectors: Connector[] }>(
    `/connectors/status?space_id=${encodeURIComponent(spaceId)}`
  );
  return res.connectors ?? [];
}

/** Store the builder's API key in the vault and register the platform as an MCP server. */
export async function connectPlatform(
  platform: string,
  spaceId: string,
  apiKey: string
): Promise<{ connected: boolean; platform: string; server_id: string }> {
  return apiFetch(`/connectors/${encodeURIComponent(platform)}/connect`, {
    method: "POST",
    body: JSON.stringify({ space_id: spaceId, api_key: apiKey }),
  });
}
