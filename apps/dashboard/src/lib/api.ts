// API client for Naelao router worker
// G-BE01: Auth endpoints, G-BE10: SpaceType CRUD, G-BE20: Space CRUD, G-BE30: KB management
import { getStoredToken } from "./auth";

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

export interface Space {
  id: string;
  name: string;
  spacetype_id: string;
  status: string;
  config_json: string;
  created_at: string;
}

export interface ByokKeyMetadata {
  id: string;
  label: string;
  created_at?: string;
  active: boolean;
}

export interface ByokProviderStatus {
  provider: string;
  configured: boolean;
  active_key_id?: string | null;
  keys: ByokKeyMetadata[];
}

export interface OpenRouterWorkerModelCard {
  id: string;
  model: string;
  name: string;
  description?: string;
  contextLength?: number;
  promptPriceUsdPerToken?: number;
  completionPriceUsdPerToken?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  supportedParameters?: string[];
}

export async function getOpenRouterWorkerModelCards(spaceId: string): Promise<OpenRouterWorkerModelCard[]> {
  const result = await apiFetch<{ models?: OpenRouterWorkerModelCard[] }>(`/v1/spaces/${pathSegment(spaceId)}/llm-byok/models`);
  return result.models ?? [];
}

export interface CreateSpaceInput {
  name: string;
  spacetype_id: string;
  config_overrides?: Record<string, unknown>;
  template_id?: string;
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

// F: two separate, uncoordinated API-key UIs existed (dashboard/settings and dashboard/api-keys),
// each calling a different route (/settings/api-keys, /v1/api-keys) that neither worker ever
// implemented — both were dead client code. Consolidated onto this single typed shape (the
// richer of the two: scopes + expiry, matching the spec's scoped builder API key model) and a
// single future backend route, /builder/api-keys (Three-Tier Platform Model, Phase 3).
export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

// ── Token helpers ────────────────────────────────────────────────────────────

export function getToken(): string | null {
  return getStoredToken();
}

function pathSegment(value: string): string {
  if (!value || value === "." || value === "..") {
    throw new Error("Invalid API path identifier");
  }
  return encodeURIComponent(value);
}

export function getApiBase(): string {
  return API_URL;
}

export function getAuthHeader(): string | null {
  const token = getToken();
  return token ? `Bearer ${token}` : null;
}

export async function getMyPreferences(): Promise<{ preferred_language: string | null }> {
  return apiFetch("/me/preferences");
}

export async function updateMyPreferences(
  patch: { preferred_language: string | null }
): Promise<{ preferred_language: string | null }> {
  return apiFetch("/me/preferences", { method: "PATCH", body: JSON.stringify(patch) });
}

// ── Core fetch wrapper ───────────────────────────────────────────────────────

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
// Avoid adding an unnecessary JSON Content-Type to bodyless calls. Authenticated requests still
// preflight because of Authorization; this can keep unauthenticated public reads simple.
  if (typeof options.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
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

// The auth worker wraps success payloads as `{ data: { token, user } }` (see workers/auth).
// apiFetch returns the raw JSON, so unwrap `data` here — callers expect a bare AuthResponse.
function unwrapAuth(res: { data: AuthResponse } | AuthResponse): AuthResponse {
  return (res as { data?: AuthResponse }).data ?? (res as AuthResponse);
}

export async function login(
  email: string,
  password: string
): Promise<AuthResponse> {
  const res = await apiFetch<{ data: AuthResponse } | AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return unwrapAuth(res);
}

export async function register(
  email: string,
  password: string,
  orgName?: string
): Promise<AuthResponse> {
  const res = await apiFetch<{ data: AuthResponse } | AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, org_name: orgName }),
  });
  return unwrapAuth(res);
}

// Launch-readiness audit follow-up: builders had no account-recovery path at all — a forgotten
// password permanently locked a builder out of their own business. Same shape as the product
// end-user reset flow (apps/shell's productAccount.ts).
export async function requestPasswordReset(email: string): Promise<{ ok: boolean; message: string }> {
  return apiFetch("/auth/request-password-reset", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<{ ok: boolean; message: string }> {
  return apiFetch("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, new_password: newPassword }),
  });
}

// ── SpaceTypes ───────────────────────────────────────────────────────────────

// ── Spaces ───────────────────────────────────────────────────────────────────

export async function listSpaces(): Promise<Space[]> {
  const res = await apiFetch<{ data: Space[] } | Space[]>("/spaces");
  if (Array.isArray(res)) return res;
  return (res as { data: Space[] }).data ?? [];
}

export async function createSpace(data: CreateSpaceInput): Promise<{ id: string; name: string; status: string; created_at: string }> {
  return apiFetch<{ id: string; name: string; status: string; created_at: string }>("/spaces", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getSpace(id: string): Promise<Space> {
  return apiFetch<Space>(`/spaces/${pathSegment(id)}`);
}

// ── Space model provider keys ───────────────────────────────────────────────

export async function getByokStatus(spaceId: string): Promise<ByokProviderStatus[]> {
  const res = await apiFetch<{ providers: ByokProviderStatus[] }>(`/v1/spaces/${pathSegment(spaceId)}/llm-byok`);
  return res.providers;
}

export async function addByokKey(spaceId: string, provider: string, key: string, label?: string): Promise<ByokKeyMetadata> {
  return apiFetch<ByokKeyMetadata>(`/v1/spaces/${pathSegment(spaceId)}/llm-byok`, {
    method: "PUT",
    body: JSON.stringify({ provider, key, ...(label?.trim() ? { label: label.trim() } : {}) }),
  });
}

export async function selectByokKey(spaceId: string, provider: string, keyId: string): Promise<void> {
  await apiFetch(`/v1/spaces/${pathSegment(spaceId)}/llm-byok/select`, {
    method: "POST",
    body: JSON.stringify({ provider, key_id: keyId }),
  });
}

export async function removeByokKey(spaceId: string, provider: string, keyId: string): Promise<void> {
  await apiFetch(`/v1/spaces/${pathSegment(spaceId)}/llm-byok/remove`, {
    method: "POST",
    body: JSON.stringify({ provider, key_id: keyId }),
  });
}

export async function updateSpace(
  id: string,
  data: Partial<{ name: string; status: string; configOverrides: Record<string, unknown> }>
): Promise<Space> {
  return apiFetch<Space>(`/spaces/${pathSegment(id)}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ── KB Documents ─────────────────────────────────────────────────────────────

export async function listKbDocs(spaceId: string): Promise<KbDocument[]> {
  const res = await apiFetch<{ data: KbDocument[] } | KbDocument[]>(
    `/spaces/${pathSegment(spaceId)}/kb`
  );
  if (Array.isArray(res)) return res;
  return (res as { data: KbDocument[] }).data ?? [];
}

export async function uploadKbDoc(
  spaceId: string,
  data: { title: string; content: string; content_type: string }
): Promise<KbDocument> {
  return apiFetch<KbDocument>(`/spaces/${pathSegment(spaceId)}/kb`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteKbDoc(
  spaceId: string,
  docId: string
): Promise<void> {
  return apiFetch<void>(`/spaces/${pathSegment(spaceId)}/kb/${pathSegment(docId)}`, {
    method: "DELETE",
  });
}

// ── Naelao team API keys ─────────────────────────────────────────────────────

export async function listApiKeys(): Promise<ApiKey[]> {
  const res = await apiFetch<{ data: ApiKey[] } | ApiKey[]>("/builder/api-keys");
  if (Array.isArray(res)) return res;
  return (res as { data: ApiKey[] }).data ?? [];
}

export async function createApiKey(
  name: string,
  scopes: string[],
  expiresInDays?: number
): Promise<{ key: string } & ApiKey> {
  const body: Record<string, unknown> = { name, scopes };
  if (expiresInDays) body["expires_in_days"] = expiresInDays;
  return apiFetch<{ key: string } & ApiKey>("/builder/api-keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  return apiFetch<void>(`/builder/api-keys/${pathSegment(id)}`, { method: "DELETE" });
}

export interface TeamPrivateSpaceTemplate {
  visibility: "team_private";
  template: {
    id: string;
    metadata: { name?: string; description?: string };
    projects: unknown[];
    requiredExtensions: string[];
    [key: string]: unknown;
  };
}
export async function listTeamPrivateTemplates(): Promise<TeamPrivateSpaceTemplate[]> {
  const res = await apiFetch<{ data: TeamPrivateSpaceTemplate[] }>("/builder/templates");
  return res.data;
}

// ── Child Spaces and cross-Space grants ──────────────────────────────────────

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
  const res = await apiFetch<{ data: SubSpace[] }>(`/spaces/${pathSegment(spaceId)}/sub-spaces`);
  return res.data ?? [];
}

export async function createSubSpace(
  spaceId: string,
  data: { name: string; parent_id?: string }
): Promise<SubSpace> {
  return apiFetch<SubSpace>(`/spaces/${pathSegment(spaceId)}/sub-spaces`, {
    method: "POST",
    body: JSON.stringify(data),
  });
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

// ── Connectors (external-platform MCP connector layer) ──

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

/** The configured connector catalogue, including hosted Composio integrations. */
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
  return apiFetch(`/connectors/${pathSegment(platform)}/connect`, {
    method: "POST",
    body: JSON.stringify({ space_id: spaceId, api_key: apiKey }),
  });
}

// ── Space, assistant, and execution controls ───────────────────────────────────────────────

// §A1.17 Phase G: the Space Assistant's approval policy — `spaceId` here is the product root
// space itself (a builder-owned product IS a space), not a `/builder/*` route. Reuses the
// already-built `GET/PATCH /spaces/:spaceId/assistant-policy` (SpaceDO migration v14) rather
// than adding a parallel builder-scoped endpoint.
export interface AssistantPolicy {
  approval_mode: "always_ask" | "yolo";
  auto_approved_actions: string[];
}

export async function getAssistantPolicy(spaceId: string): Promise<AssistantPolicy> {
  return apiFetch<AssistantPolicy>(`/spaces/${pathSegment(spaceId)}/assistant-policy`);
}

export async function updateAssistantPolicy(spaceId: string, input: Partial<AssistantPolicy>): Promise<AssistantPolicy> {
  return apiFetch<AssistantPolicy>(`/spaces/${pathSegment(spaceId)}/assistant-policy`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// Tier 2/3 follow-up: agent_activity_log (SpaceDO migration v27) has been built and populated by
// NaelaoAgentDO since the security-audit pass that added it, but had zero consuming UI — a
// builder had no way to see what their agent has actually been doing, why it escalated, or what
// it cost. GET /spaces/:spaceId/agent-activity is the existing builder-only read (same
// requireInternalHmac-via-router pattern as assistant-policy above).
export interface AgentActivityEntry {
  id: string;
  space_id: string;
  project_id: string | null;
  thread_id: string | null;
  agent_id: string;
  event_type: "run_completed" | "run_failed" | "approval_requested" | "approval_resolved" | "moderation_blocked";
  summary: string;
  tokens_used: number | null;
  cost_credits: number | null;
  created_at: string;
}

export async function getAgentActivity(spaceId: string, opts: { projectId?: string; limit?: number } = {}): Promise<{ data: AgentActivityEntry[]; count: number }> {
  const params = new URLSearchParams();
  if (opts.projectId) params.set("project_id", opts.projectId);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return apiFetch(`/spaces/${pathSegment(spaceId)}/agent-activity${qs ? `?${qs}` : ""}`);
}

// §A1.17 Phase S: local-machine-as-container grants + the connect-token flow. These routes
// (workers/spaces/src/index.ts) are gated by requireInternalHmac, the SAME mechanism every other
// builder-only route in this dashboard already goes through (naelao-router's proxyTo mints that
// token for any authenticated request it proxies) — no new backend auth path was needed, only
// this UI, which never previously existed for either surface (Phase M shipped the mechanism with
// no frontend at all).
export interface LocalGrant {
  id: string;
  space_id: string;
  project_id: string | null;
  user_id: string;
  grant_type: "read" | "write" | "readwrite" | "exec";
  directory?: string | null;
  commands_json?: string;
  created_at: string;
}

export async function listLocalGrants(spaceId: string): Promise<LocalGrant[]> {
  const res = await apiFetch<{ data: LocalGrant[] }>(`/spaces/${pathSegment(spaceId)}/local-grants`);
  return res.data ?? [];
}

export async function createLocalGrant(
  spaceId: string,
  input: { grant_type: "read" | "write" | "readwrite" | "exec"; directory?: string; commands?: string[]; project_id?: string }
): Promise<LocalGrant> {
  return apiFetch<LocalGrant>(`/spaces/${pathSegment(spaceId)}/local-grants`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteLocalGrant(spaceId: string, grantId: string): Promise<void> {
  await apiFetch<void>(`/spaces/${pathSegment(spaceId)}/local-grants/${pathSegment(grantId)}`, {
    method: "DELETE",
  });
}

export interface LocalTunnelConnectInfo {
  token: string;
  space_id: string;
  user_id: string;
  connect_path: string;
  expires_in_seconds: number;
}

export async function mintLocalTunnelConnectToken(spaceId: string): Promise<LocalTunnelConnectInfo> {
  return apiFetch<LocalTunnelConnectInfo>(`/spaces/${pathSegment(spaceId)}/local-tunnel/connect-token`, {
    method: "POST",
  });
}
