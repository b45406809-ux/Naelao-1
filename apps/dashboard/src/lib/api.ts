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

// ── API Keys (Three-Tier Platform Model, Phase 3 — /builder/api-keys* not live until then) ──

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
  return apiFetch<void>(`/builder/api-keys/${id}`, { method: "DELETE" });
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

// ── Templates + first-run onboarding wizard ──────────────────────────────────

export interface OnboardingPrompt {
  id: string;
  type: "credential" | "choice" | "text" | "boolean";
  question: string;
  connector?: string;
  options?: string[];
  required?: boolean;
}

export interface TemplateBootstrap {
  prompts: OnboardingPrompt[];
  projects?: string[];
  setup_scripts?: string[];
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  free_tier_eligible: boolean;
  connectors: string[];
  coming_soon: boolean;
  bootstrap?: TemplateBootstrap;
}

/** Launchpad templates incl. their first-run bootstrap (the onboarding wizard reads this). */
export async function getTemplates(): Promise<TemplateInfo[]> {
  const res = await apiFetch<{ templates: TemplateInfo[] }>("/templates");
  return res.templates ?? [];
}

// ── Builder Dashboard API (Three-Tier Platform Model — /builder/*) ───────────────────────────
// Named `BuilderProduct` (not `Product`) to avoid colliding with the existing `Product` type
// above, which means a Launchpad commerce item a store sells — a completely different concept
// from a builder's own product/business (a NaelaoProduct, i.e. a Space with the Phase 1-3
// fields). See docs/spec-appendix/A1-script-agents-and-space-assistants.md §A1.17.

export interface BuilderProductSummary {
  id: string;
  name: string;
  status: string;
  spacetype_id: string;
  product_slug: string | null;
  created_at: string;
  updated_at: string;
}

export interface PricingPlan {
  id: string;
  name: string;
  priceCents: number;
  interval: "month" | "year";
  creditAllowance?: number;
  limits?: { maxThreadsPerUser?: number | null; maxCreditsPerMonth?: number | null };
  lsVariantId?: string;
}

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
  lsVariantId?: string;
}

export interface BuilderProductConfig {
  branding?: { brandColor?: string; logoUrl?: string; faviconUrl?: string; productDescription?: string; suppressNaelaoBranding?: boolean };
  authProvider?: { provider: "naelao-native" | "clerk" | "custom-oidc" | "saml-sso"; requireAdminApproval?: boolean; allowedEmailDomains?: string[] };
  pricingConfig?: {
    model: "free" | "credits" | "subscription" | "seats";
    creditsIncludedPerMonth?: number;
    overageCreditsPriceCents?: number;
    pricePerSeatCents?: number;
    includedSeats?: number;
    trialDays?: number;
    // Phase E (§A1.17) — subscription plans + credit packs a reseller/hybrid product offers.
    plans?: PricingPlan[];
    creditPacks?: CreditPack[];
  };
  featureFlags?: Record<string, boolean>;
  // Phase D (§A1.17) — product mode, limits, and the template catalog. All three already exist
  // on the backend's SpaceTypeProductConfig (workers/spaces/src/do/SpaceTypeRegistryDO.ts); this
  // is the first UI to actually read/write them.
  membershipModel?: "team" | "tenant" | "hybrid";
  allowPublicSignup?: boolean;
  allowedChildSpaceTypes?: string[];
  // WS-3 (§Polsia / G-AS34/G-AS35): the Naelao->builder wholesale-credit relationship for
  // tenant/hybrid products. Team mode has no rates — Naelao bills the builder for all end-user
  // usage, so this is only meaningful once membershipModel is tenant/hybrid.
  billingRelationship?: "reseller" | "referral" | "platform";
  resellerRates?: {
    wholesaleCents?: number | null;
    referralSharePct?: number;
  };
  userPermissions?: {
    canCreateSpace?: boolean;
    canCreateSubSpaces?: boolean;
    canCreateProjects?: boolean;
    maxThreadsPerUser?: number | null;
    maxCreditsPerMonth?: number | null;
  };
  catalog?: {
    businessTemplates?: string[];
    projectTemplates?: string[];
  };
}

export interface BuilderProductDetail extends BuilderProductSummary {
  tenant_id: string;
  conversation_access_approved_by: string | null;
  conversation_access_approved_at: string | null;
  product_config: BuilderProductConfig;
}

export interface CreateBuilderProductInput {
  name: string;
  spacetype_id: string;
  template_id?: string;
  product_slug?: string;
  product_config?: BuilderProductConfig;
}

export async function listBuilderProducts(): Promise<BuilderProductSummary[]> {
  const res = await apiFetch<{ data: BuilderProductSummary[] }>("/builder/products");
  return res.data ?? [];
}

export async function getBuilderProduct(id: string): Promise<BuilderProductDetail> {
  return apiFetch<BuilderProductDetail>(`/builder/products/${encodeURIComponent(id)}`);
}

export async function createBuilderProduct(input: CreateBuilderProductInput): Promise<BuilderProductSummary> {
  return apiFetch<BuilderProductSummary>("/builder/products", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateBuilderProduct(
  id: string,
  input: { name?: string; status?: string; product_config?: BuilderProductConfig }
): Promise<{ ok: true }> {
  return apiFetch(`/builder/products/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// Phase E (§A1.17): PATCH /builder/products/:id/pricing provisions Lemon Squeezy variants for
// any new plan/pack (once, on save — an already-provisioned item's lsVariantId is left alone)
// and persists into product_config.pricingConfig.{plans,creditPacks}.
export async function updateBuilderProductPricing(
  id: string,
  input: { plans?: PricingPlan[]; creditPacks?: CreditPack[] }
): Promise<{ pricing_config: BuilderProductConfig["pricingConfig"] }> {
  return apiFetch(`/builder/products/${encodeURIComponent(id)}/pricing`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// WS-3: the missing write path for reseller economics — updates BOTH the config_json display
// copy and the live reseller_accounts row (immediate effect for a tenant that already has one).
export async function updateBuilderProductReseller(
  id: string,
  input: { billing_relationship?: "reseller" | "referral" | "platform"; wholesale_cents?: number | null; referral_share_pct?: number }
): Promise<{ billing_relationship: string; reseller_rates: { wholesale_cents: number | null; referral_share_pct: number } }> {
  return apiFetch(`/builder/products/${encodeURIComponent(id)}/reseller`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteBuilderProduct(id: string): Promise<void> {
  return apiFetch<void>(`/builder/products/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface BuilderProductDomain {
  custom_domain: string | null;
  status: string;
  ssl_status?: string;
  dns?: { type: string; name: string; value: string };
  validation_records?: unknown[];
}

export async function configureBuilderProductDomain(id: string, customDomain: string): Promise<BuilderProductDomain> {
  return apiFetch<BuilderProductDomain>(`/builder/products/${encodeURIComponent(id)}/domain`, {
    method: "POST",
    body: JSON.stringify({ custom_domain: customDomain }),
  });
}

export async function getBuilderProductDomain(id: string): Promise<BuilderProductDomain> {
  return apiFetch<BuilderProductDomain>(`/builder/products/${encodeURIComponent(id)}/domain`);
}

// §A1.17 Phase G: the Space Assistant's approval policy — `spaceId` here is the product root
// space itself (a builder-owned product IS a space), not a `/builder/*` route. Reuses the
// already-built `GET/PATCH /spaces/:spaceId/assistant-policy` (SpaceDO migration v14) rather
// than adding a parallel builder-scoped endpoint.
export interface AssistantPolicy {
  approval_mode: "always_ask" | "yolo";
  auto_approved_actions: string[];
}

export async function getAssistantPolicy(spaceId: string): Promise<AssistantPolicy> {
  return apiFetch<AssistantPolicy>(`/spaces/${encodeURIComponent(spaceId)}/assistant-policy`);
}

export async function updateAssistantPolicy(spaceId: string, input: Partial<AssistantPolicy>): Promise<AssistantPolicy> {
  return apiFetch<AssistantPolicy>(`/spaces/${encodeURIComponent(spaceId)}/assistant-policy`, {
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
  return apiFetch(`/spaces/${encodeURIComponent(spaceId)}/agent-activity${qs ? `?${qs}` : ""}`);
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
  const res = await apiFetch<{ data: LocalGrant[] }>(`/spaces/${encodeURIComponent(spaceId)}/local-grants`);
  return res.data ?? [];
}

export async function createLocalGrant(
  spaceId: string,
  input: { grant_type: "read" | "write" | "readwrite" | "exec"; directory?: string; commands?: string[]; project_id?: string }
): Promise<LocalGrant> {
  return apiFetch<LocalGrant>(`/spaces/${encodeURIComponent(spaceId)}/local-grants`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteLocalGrant(spaceId: string, grantId: string): Promise<void> {
  await apiFetch<void>(`/spaces/${encodeURIComponent(spaceId)}/local-grants/${encodeURIComponent(grantId)}`, {
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
  return apiFetch<LocalTunnelConnectInfo>(`/spaces/${encodeURIComponent(spaceId)}/local-tunnel/connect-token`, {
    method: "POST",
  });
}

export interface BuilderSpaceTypeListing {
  id: string;
  name: string;
  description: string;
  author: string;
  current_version: string;
  price_usd: number;
  install_count: number;
}

/** The real, currently-seeded SpaceTypes a builder can pick (today: just Launchpad — see
 *  docs/spec-appendix A1.17, Phase 4). Deliberately not the same as the legacy, dead
 *  `listSpaceTypes()`/`GET /spacetypes` above, which calls a route no worker implements. */
export async function listBuilderSpaceTypes(): Promise<BuilderSpaceTypeListing[]> {
  const res = await apiFetch<{ types: BuilderSpaceTypeListing[] }>("/builder/space-types");
  return res.types ?? [];
}

// ── Product Detail management tabs (Three-Tier Platform Model, Phase 5) ──────────────────────

export interface BuilderProductAnalytics {
  dau: number;
  mau: number;
  total_users: number;
  /** Honestly null, not fabricated — see appendix A1.17 Phase 3: not bulk-aggregatable from D1
   *  without Analytics Engine wiring this platform hasn't added yet. */
  credits_consumed: number | null;
}

export async function getBuilderProductAnalytics(id: string): Promise<BuilderProductAnalytics> {
  return apiFetch<BuilderProductAnalytics>(`/builder/products/${encodeURIComponent(id)}/analytics`);
}

export interface BuilderProductRevenue {
  period: string;
  gross_revenue_cents: number;
  naelao_fee_cents: number;
  net_revenue_cents: number;
  order_count: number;
  naelao_wholesale_cost_cents: number;
}

export async function getBuilderProductRevenue(id: string): Promise<BuilderProductRevenue> {
  return apiFetch<BuilderProductRevenue>(`/builder/products/${encodeURIComponent(id)}/analytics/revenue`);
}

export interface BuilderProductEndUser {
  end_user_id: string;
  email: string | null;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string | null;
  suspended_at: string | null;
}

export async function listBuilderProductUsers(id: string): Promise<BuilderProductEndUser[]> {
  const res = await apiFetch<{ data: BuilderProductEndUser[] }>(`/builder/products/${encodeURIComponent(id)}/users`);
  return res.data ?? [];
}

export async function suspendBuilderProductUser(id: string, userId: string): Promise<void> {
  await apiFetch(`/builder/products/${encodeURIComponent(id)}/users/${encodeURIComponent(userId)}/suspend`, { method: "POST" });
}

export async function removeBuilderProductUser(id: string, userId: string): Promise<void> {
  await apiFetch<void>(`/builder/products/${encodeURIComponent(id)}/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

export async function putBuilderProductFeatureFlags(id: string, flags: Record<string, boolean>): Promise<{ feature_flags: Record<string, boolean> }> {
  return apiFetch(`/builder/products/${encodeURIComponent(id)}/feature-flags`, {
    method: "PUT",
    body: JSON.stringify({ flags }),
  });
}

export interface BuilderBillingPeriod {
  period: string;
  retail: number;
  wholesale: number;
  margin: number;
  events: number;
}

/** The builder's OWN wholesale statement — tenant-wide, not per-product (reseller_ledger tracks
 *  billing at the tenant level; there is no per-product wholesale breakdown to show here). */
export async function getBuilderBilling(period?: string): Promise<BuilderBillingPeriod> {
  const qs = period ? `?period=${encodeURIComponent(period)}` : "";
  return apiFetch<BuilderBillingPeriod>(`/builder/billing${qs}`);
}

export async function getBuilderBillingHistory(): Promise<BuilderBillingPeriod[]> {
  const res = await apiFetch<{ data: BuilderBillingPeriod[] }>("/builder/billing/history");
  return res.data ?? [];
}
