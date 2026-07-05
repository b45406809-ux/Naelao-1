// Product Shell API client — a signed-in product end user talks to the platform via a
// product-scoped nps_... session token (ProductUserDO-backed), never the builder's platform JWT.
// Ported from apps/portal/src/lib/api.ts's proven hybrid-auth pattern (Three-Tier Platform
// Model, Phase 6): the router requires BOTH `Authorization: Bearer nps_...` AND
// `x-naelao-end-user-id` together, on an explicit per-route allowlist.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export interface SessionCredentials {
  sessionToken: string;
  endUserId: string;
}

async function apiFetch<T>(
  path: string,
  options: RequestInit & { session?: SessionCredentials } = {}
): Promise<T> {
  const { session, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(fetchOptions.headers as Record<string, string> | undefined),
  };
  if (session) {
    headers["Authorization"] = `Bearer ${session.sessionToken}`;
    headers["x-naelao-end-user-id"] = session.endUserId;
  }

  const res = await fetch(`${API_URL}${path}`, { ...fetchOptions, headers });

  if (!res.ok) {
    let message = `API error ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error_code?: string };
      message = body.message ?? body.error_code ?? message;
    } catch {
      // use default message
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ── Public, pre-login lookups ────────────────────────────────────────────────

export interface ProductBySlug {
  space_id: string;
  product_name: string;
  brand_color: string | null;
  logo_url: string | null;
  auth_provider: string;
}

/** GET /v1/products/by-slug/:slug — unauthenticated; resolves the product a visitor landed on. */
export async function getProductBySlug(slug: string): Promise<ProductBySlug> {
  return apiFetch<ProductBySlug>(`/v1/products/by-slug/${encodeURIComponent(slug)}`);
}

export interface ShellManifest {
  space_id: string;
  space_type_id: string;
  space_name: string;
  manifest_name: string;
  manifest_version: string;
  icon: string;
  ui: {
    sidebar_items: { id: string; label: string; icon: string; path: string }[];
    hidden_core_items: string[];
    default_view: string;
  };
  branding: {
    brand_color: string | null;
    logo_url: string | null;
    favicon_url: string | null;
    product_description: string | null;
    suppress_naelao_branding: boolean;
  };
  assistant_mode: string;
  sub_space_display: unknown;
  allow_public_signup: boolean;
  auth_provider: string;
  /** Phase C: "team" never shows a Create Business entry point; "tenant"/"hybrid" do. */
  membership_model: "team" | "tenant" | "hybrid";
  allowed_child_space_types: string[];
  /** Phase D: which business templates this product actually offers. Empty = every template the
   *  SpaceType ships (not yet configured by the builder) — the shell falls back to the full list. */
  business_templates: string[];
  /** Phase F: the real, coming_soon-aware template catalog — render the create-business dialog
   *  from this instead of a hardcoded copy of LAUNCHPAD_TEMPLATES. */
  template_catalog: Array<{ id: string; name: string; coming_soon: boolean }>;
}

/** GET /v1/spaces/:spaceId/shell/manifest — safe projection, works pre- and post-login. */
export async function getShellManifest(spaceId: string, session?: SessionCredentials): Promise<ShellManifest> {
  const opts: RequestInit & { session?: SessionCredentials } = {};
  if (session) opts.session = session;
  return apiFetch<ShellManifest>(`/v1/spaces/${spaceId}/shell/manifest`, opts);
}

// ── Authenticated end-user profile ───────────────────────────────────────────

export interface ProductUserMe {
  end_user_id: string;
  email: string | null;
  display_name: string | null;
  joined_at: string;
  last_seen_at: string | null;
  suspended: boolean;
  credits_balance: number;
}

export async function getMe(spaceId: string, session: SessionCredentials): Promise<ProductUserMe> {
  return apiFetch<ProductUserMe>(`/v1/spaces/${spaceId}/product-users/me`, { session });
}

export async function updateMe(
  spaceId: string,
  session: SessionCredentials,
  patch: { display_name?: string }
): Promise<{ ok: boolean; display_name: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/product-users/me`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    session,
  });
}

// ── Chat (sessions + streaming) — ported from apps/portal's proven SSE client ────────────────

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at: string;
}

export interface AgentRun {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  final_answer?: string;
  error?: string;
}

/** POST /v1/spaces/:spaceId/sessions — start a new chat session. */
export async function startSession(spaceId: string, session: SessionCredentials): Promise<{ id: string; space_id: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/sessions`, { method: "POST", body: JSON.stringify({}), session });
}

export async function getMessages(spaceId: string, sessionId: string, session: SessionCredentials): Promise<Message[]> {
  const res = await apiFetch<{ data?: Message[]; messages?: Message[] } | Message[]>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/messages`,
    { session }
  );
  if (Array.isArray(res)) return res;
  return res.data ?? res.messages ?? [];
}

/** Persists the user's message, then kicks off an agent run. */
export async function sendMessage(
  spaceId: string,
  sessionId: string,
  content: string,
  session: SessionCredentials
): Promise<{ userMessage: Message; agentRunId: string }> {
  const userMessage = await apiFetch<Message>(`/v1/spaces/${spaceId}/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ role: "user", content }),
    session,
  });
  const agentRun = await apiFetch<{ id?: string; run_id?: string }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/run`,
    { method: "POST", body: JSON.stringify({ session_id: sessionId }), session }
  );
  return { userMessage, agentRunId: agentRun.id ?? agentRun.run_id ?? "" };
}

/** The browser's native EventSource can't set headers, so the stream URL carries credentials as
 *  query params — the router's GET-only query-param fallback (see workers/router/src/index.ts). */
export function getStreamUrl(spaceId: string, sessionId: string, runId: string, session: SessionCredentials): string {
  const params = new URLSearchParams({ session_token: session.sessionToken, end_user_id: session.endUserId });
  return `${API_URL}/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}/stream?${params.toString()}`;
}

/** Polling fallback for environments without SSE. */
export async function pollRun(spaceId: string, sessionId: string, runId: string, session: SessionCredentials): Promise<AgentRun> {
  const res = await apiFetch<{ id: string; status: string; final_answer?: string; error?: string }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}`,
    { session }
  );
  return {
    id: res.id,
    status: (res.status as AgentRun["status"]) ?? "running",
    ...(res.final_answer !== undefined ? { final_answer: res.final_answer } : {}),
    ...(res.error !== undefined ? { error: res.error } : {}),
  };
}

// ── Projects ───────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: string;
  default_agent_id: string | null;
  max_threads: number;
  allowed_agent_ids: string[] | null;
  created_at: string;
}

export async function listProjects(spaceId: string, session: SessionCredentials): Promise<Project[]> {
  const res = await apiFetch<{ data: Project[]; count: number }>(`/v1/spaces/${spaceId}/projects`, { session });
  return res.data;
}

export async function createProject(spaceId: string, session: SessionCredentials, name: string, description?: string): Promise<Project> {
  return apiFetch(`/v1/spaces/${spaceId}/projects`, {
    method: "POST",
    body: JSON.stringify({ name, ...(description ? { description } : {}) }),
    session,
  });
}

export async function getProject(spaceId: string, projectId: string, session: SessionCredentials): Promise<Project> {
  return apiFetch(`/v1/spaces/${spaceId}/projects/${projectId}`, { session });
}

// ── Threads ────────────────────────────────────────────────────────────────

export interface ThreadSummary {
  id: string;
  space_id: string;
  project_id: string | null;
  title: string | null;
  status: string;
  thread_kind: string;
  parent_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function listThreads(
  spaceId: string,
  session: SessionCredentials,
  opts: { projectId?: string } = {}
): Promise<ThreadSummary[]> {
  const qs = opts.projectId ? `?project_id=${encodeURIComponent(opts.projectId)}` : "";
  const res = await apiFetch<{ data: ThreadSummary[]; count: number }>(`/v1/spaces/${spaceId}/threads${qs}`, { session });
  return res.data;
}

export async function createThread(
  spaceId: string,
  session: SessionCredentials,
  opts: { title?: string; project_id?: string } = {}
): Promise<ThreadSummary> {
  return apiFetch(`/v1/spaces/${spaceId}/threads`, { method: "POST", body: JSON.stringify(opts), session });
}

export async function getThread(spaceId: string, threadId: string, session: SessionCredentials): Promise<ThreadSummary> {
  return apiFetch(`/v1/spaces/${spaceId}/threads/${threadId}`, { session });
}

// ── Agent definitions (read-only picker) ─────────────────────────────────────

export interface AgentDefinitionSummary {
  id: string;
  name?: string;
  description?: string;
}

export async function listAgentDefinitions(spaceId: string, session: SessionCredentials): Promise<AgentDefinitionSummary[]> {
  // space_id must be explicit — SpaceDO returns EVERY agent definition in the DO instance when
  // it's omitted (fine for single-space DOs, wrong once sub-space registry rows share one DO).
  const res = await apiFetch<{ data?: AgentDefinitionSummary[] } | AgentDefinitionSummary[]>(
    `/v1/spaces/${spaceId}/agent-definitions?space_id=${encodeURIComponent(spaceId)}`,
    { session }
  );
  return Array.isArray(res) ? res : res.data ?? [];
}

// ── Businesses (Phase C — reseller-mode end users create/switch/invite into their own
// businesses) ─────────────────────────────────────────────────────────────────

export interface Business {
  id: string;
  name: string;
  role: "member" | "admin" | "owner";
  membership_status: string;
  space_status: string;
  joined_at: string;
}

/** GET /v1/spaces/:productSpaceId/my-businesses — the space switcher's list. */
export async function listMyBusinesses(productSpaceId: string, session: SessionCredentials): Promise<Business[]> {
  const res = await apiFetch<{ data: Business[]; count: number }>(`/v1/spaces/${productSpaceId}/my-businesses`, { session });
  return res.data;
}

/** POST /v1/spaces/:productSpaceId/businesses — create a new business under this product.
 *  Only reachable when the product's membershipModel allows it (shell/manifest surfaces this via
 *  allow_public_signup + auth_provider today; a dedicated membershipModel field is a small
 *  follow-up if the create-business entry point needs to hide itself for "team" mode products). */
export async function createBusiness(
  productSpaceId: string,
  session: SessionCredentials,
  opts: { name: string; spacetype_id: string; template_ids?: string[] }
): Promise<{ tenant_id: string; space_id: string; status: string }> {
  return apiFetch(`/v1/spaces/${productSpaceId}/businesses`, { method: "POST", body: JSON.stringify(opts), session });
}

export interface BusinessMember {
  end_user_id: string;
  role: "member" | "admin" | "owner";
  status: string;
  joined_at: string;
}

export async function listBusinessMembers(businessSpaceId: string, session: SessionCredentials): Promise<BusinessMember[]> {
  const res = await apiFetch<{ data: BusinessMember[]; count: number }>(`/v1/spaces/${businessSpaceId}/business-members`, { session });
  return res.data;
}

export async function removeBusinessMember(businessSpaceId: string, endUserId: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${businessSpaceId}/business-members/${encodeURIComponent(endUserId)}`, { method: "DELETE", session });
}

export async function inviteToBusiness(
  businessSpaceId: string,
  session: SessionCredentials,
  opts: { email: string; role?: "member" | "admin" }
): Promise<{ id: string; token: string; expires_at: string }> {
  return apiFetch(`/v1/spaces/${businessSpaceId}/invites`, { method: "POST", body: JSON.stringify(opts), session });
}

export async function acceptBusinessInvite(
  businessSpaceId: string,
  token: string,
  session: SessionCredentials
): Promise<{ business_space_id: string; role: string }> {
  return apiFetch(`/v1/spaces/${businessSpaceId}/invites/${encodeURIComponent(token)}/accept`, { method: "POST", session });
}

// ── Pricing + checkout (Phase E — subscription plans + credit packs) ───────────────────────
// A business subscribes to a plan as a whole; a credit pack tops up the buyer's OWN balance.
// Both checkout calls redirect the browser to the returned checkout_url (Lemon Squeezy).

export interface PricingPlan {
  id: string;
  name: string;
  price_cents: number;
  interval: "month" | "year";
  credit_allowance: number | null;
}

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  price_cents: number;
}

export async function getPricing(spaceId: string, session: SessionCredentials): Promise<{ plans: PricingPlan[]; credit_packs: CreditPack[] }> {
  return apiFetch(`/v1/spaces/${spaceId}/pricing`, { session });
}

export async function checkoutBusinessSubscription(
  spaceId: string,
  session: SessionCredentials,
  planId: string
): Promise<{ checkout_url: string; dev?: boolean }> {
  return apiFetch(`/v1/spaces/${spaceId}/business-subscription/checkout`, {
    method: "POST",
    body: JSON.stringify({ plan_id: planId }),
    session,
  });
}

export async function checkoutCreditPack(
  spaceId: string,
  session: SessionCredentials,
  packId: string
): Promise<{ checkout_url: string; dev?: boolean }> {
  return apiFetch(`/v1/spaces/${spaceId}/credit-packs/checkout`, {
    method: "POST",
    body: JSON.stringify({ pack_id: packId }),
    session,
  });
}

// ── Business operations (Phase N — manifest-driven operator shell) ─────────────────────────
// The Revenue/Orders/Products views a business owner sees when operating their OWN Launchpad
// business, sourced from the SAME commerce backend the builder dashboard's legacy commerce page
// uses. Only reachable on a business whose SpaceType manifest offers `commerce` (shell/manifest's
// `ui.sidebar_items` includes "products"/"orders"/"revenue" — the page checks this before calling).

export interface LaunchpadProduct {
  id: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  kind: "one_time" | "subscription";
  status: "draft" | "published" | "archived";
  ls_variant_id: string | null;
  created_at: string;
}

export interface LaunchpadOrder {
  id: string;
  product_id: string | null;
  product_name: string | null;
  customer_email: string | null;
  gross_cents: number;
  fee_cents: number;
  net_cents: number;
  currency: string;
  status: "paid" | "fulfilling" | "fulfilled" | "refunded" | "failed";
  created_at: string;
}

export interface RevenueSummary {
  period: string;
  currency: string;
  gross_cents: number;
  fee_cents: number;
  net_cents: number;
  orders: number;
}

export async function listBusinessProducts(spaceId: string, session: SessionCredentials): Promise<LaunchpadProduct[]> {
  const res = await apiFetch<{ data: LaunchpadProduct[] }>(`/v1/spaces/${spaceId}/products`, { session });
  return res.data;
}

export async function createBusinessProduct(
  spaceId: string,
  session: SessionCredentials,
  input: { name: string; description?: string; price_cents?: number; kind?: "one_time" | "subscription" }
): Promise<{ id: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/products`, { method: "POST", body: JSON.stringify(input), session });
}

export async function updateBusinessProduct(
  spaceId: string,
  productId: string,
  session: SessionCredentials,
  patch: { status?: "draft" | "published" | "archived" }
): Promise<{ id: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/products/${productId}`, { method: "PATCH", body: JSON.stringify(patch), session });
}

export async function listBusinessOrders(spaceId: string, session: SessionCredentials): Promise<LaunchpadOrder[]> {
  const res = await apiFetch<{ data: LaunchpadOrder[] }>(`/v1/spaces/${spaceId}/orders`, { session });
  return res.data;
}

export async function getBusinessRevenue(spaceId: string, session: SessionCredentials): Promise<RevenueSummary> {
  return apiFetch(`/v1/spaces/${spaceId}/revenue`, { session });
}
