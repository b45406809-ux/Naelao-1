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

export async function listSpaceTypes(): Promise<SpaceType[]> {
  // F-3: the legacy `/spacetypes` REST route was never implemented by any worker, so the
  // post-login landing page's Promise.all([listSpaces(), listSpaceTypes()]) 404'd and crashed the
  // whole dashboard on every login. Point at the REAL registry wrapper (GET /builder/space-types,
  // which fronts SpaceTypeRegistryDO) — now reachable since F-1 routes /builder/* through the router.
  const res = await apiFetch<{ data: SpaceType[] } | { types: SpaceType[] } | SpaceType[]>("/builder/space-types");
  if (Array.isArray(res)) return res;
  return (res as { data?: SpaceType[]; types?: SpaceType[] }).data ?? (res as { types?: SpaceType[] }).types ?? [];
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

// ── Builder API keys (/builder/api-keys* is implemented by workers/spaces builder routes) ──

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
  return apiFetch<{ data: Product[]; currency: string }>(`/spaces/${pathSegment(spaceId)}/products`);
}

export async function createProduct(
  spaceId: string,
  data: { name: string; description?: string; price_cents?: number; kind?: "one_time" | "subscription" }
): Promise<Product> {
  return apiFetch<Product>(`/spaces/${pathSegment(spaceId)}/products`, { method: "POST", body: JSON.stringify(data) });
}

export async function updateProduct(
  spaceId: string,
  productId: string,
  data: Partial<{ name: string; description: string; price_cents: number; status: "draft" | "published" | "archived" }>
): Promise<{ id: string }> {
  return apiFetch(`/spaces/${pathSegment(spaceId)}/products/${pathSegment(productId)}`, { method: "PATCH", body: JSON.stringify(data) });
}

export async function deleteProduct(spaceId: string, productId: string): Promise<void> {
  return apiFetch<void>(`/spaces/${pathSegment(spaceId)}/products/${pathSegment(productId)}`, { method: "DELETE" });
}

export async function listOrders(spaceId: string): Promise<{ data: Order[] }> {
  return apiFetch<{ data: Order[] }>(`/spaces/${pathSegment(spaceId)}/orders`);
}

export async function getRevenue(spaceId: string): Promise<RevenueSummary> {
  return apiFetch<RevenueSummary>(`/spaces/${pathSegment(spaceId)}/revenue`);
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

export interface BuilderProductPage {
  data: BuilderProductSummary[];
  product_count: number;
  page: number;
  page_size: number;
  page_count: number;
}

export interface NaelaoLaunchpadDashboard {
  product: BuilderProductSummary | null;
  can_initialize: boolean;
}

export function getNaelaoLaunchpadDashboard(): Promise<NaelaoLaunchpadDashboard> {
  return apiFetch<NaelaoLaunchpadDashboard>("/builder/launchpad");
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
  // §A1.28: which LLM this product's agents run on — validated against a curated allowlist at
  // the PATCH route (workers/spaces/src/builder-routes.ts's ALLOWED_MODELS).
  modelConfig?: {
    model?: string;
  };
  workerModelPool?: {
    modelIds: string[];
    modelsByPlan?: Record<string, string[]>;
    selectionMode?: "automatic" | "planner";
    inputUsdPerMillion?: number;
    outputUsdPerMillion?: number;
  };
  // Tier 2/3 follow-up: a proactive daily digest email (agent activity summary) — opt-in, off by
  // default.
  notificationsConfig?: {
    dailyDigestEnabled?: boolean;
  };
  legal?: {
    tosUrl?: string;
    privacyPolicyUrl?: string;
    dpaUrl?: string;
    cookiePolicy?: "none" | "analytics" | "third_party";
    supportContact?: string;
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
  const res = await apiFetch<BuilderProductPage>("/builder/products");
  return res.data ?? [];
}

export async function listBuilderProductsPage(page: number): Promise<BuilderProductPage> {
  return apiFetch<BuilderProductPage>(`/builder/products?page=${encodeURIComponent(String(page))}`);
}

export async function getBuilderProduct(id: string): Promise<BuilderProductDetail> {
  return apiFetch<BuilderProductDetail>(`/builder/products/${pathSegment(id)}`);
}

// F-WALLET-6: the builder-facing wallet aggregate across a product + all its child businesses.
export interface BuilderProductWallet {
  product_id: string;
  businesses: {
    gross_cents: number;
    naelao_cut_cents: number;
    builder_cut_cents: number;
    net_settled_cents: number;
    order_count: number;
  };
  builder_revenue_share: Array<{ currency: string; earned_cents: number }>;
}

export async function getBuilderProductWallet(id: string): Promise<BuilderProductWallet> {
  return apiFetch<BuilderProductWallet>(`/builder/products/${pathSegment(id)}/wallet`);
}

export async function createBuilderProduct(input: CreateBuilderProductInput): Promise<BuilderProductSummary> {
  return apiFetch<BuilderProductSummary>("/builder/products", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateBuilderProduct(
  id: string,
  input: { name?: string; status?: string; product_config?: BuilderProductConfig; legal?: BuilderProductConfig["legal"] }
): Promise<{ ok: true }> {
  return apiFetch(`/builder/products/${pathSegment(id)}`, {
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
  return apiFetch(`/builder/products/${pathSegment(id)}/pricing`, {
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
  return apiFetch(`/builder/products/${pathSegment(id)}/reseller`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteBuilderProduct(id: string): Promise<void> {
  return apiFetch<void>(`/builder/products/${pathSegment(id)}`, { method: "DELETE" });
}

export interface BuilderProductDomain {
  custom_domain: string | null;
  status: string;
  ssl_status?: string;
  dns?: { type: string; name: string; value: string };
  validation_records?: unknown[];
}

export async function configureBuilderProductDomain(id: string, customDomain: string): Promise<BuilderProductDomain> {
  return apiFetch<BuilderProductDomain>(`/builder/products/${pathSegment(id)}/domain`, {
    method: "POST",
    body: JSON.stringify({ custom_domain: customDomain }),
  });
}

export async function getBuilderProductDomain(id: string): Promise<BuilderProductDomain> {
  return apiFetch<BuilderProductDomain>(`/builder/products/${pathSegment(id)}/domain`);
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
  return apiFetch<BuilderProductAnalytics>(`/builder/products/${pathSegment(id)}/analytics`);
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
  return apiFetch<BuilderProductRevenue>(`/builder/products/${pathSegment(id)}/analytics/revenue`);
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
  const res = await apiFetch<{ data: BuilderProductEndUser[] }>(`/builder/products/${pathSegment(id)}/users`);
  return res.data ?? [];
}

export async function suspendBuilderProductUser(id: string, userId: string): Promise<void> {
  await apiFetch(`/builder/products/${pathSegment(id)}/users/${pathSegment(userId)}/suspend`, { method: "POST" });
}

export async function removeBuilderProductUser(id: string, userId: string): Promise<void> {
  await apiFetch<void>(`/builder/products/${pathSegment(id)}/users/${pathSegment(userId)}`, { method: "DELETE" });
}

export async function putBuilderProductFeatureFlags(id: string, flags: Record<string, boolean>): Promise<{ feature_flags: Record<string, boolean> }> {
  return apiFetch(`/builder/products/${pathSegment(id)}/feature-flags`, {
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
