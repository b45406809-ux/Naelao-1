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
  /** Legal & support config — builder-defined; drives the cookie consent banner and the
   *  support contact link on error screens. Absent fields: shell falls back to Naelao defaults. */
  legal: {
    tos_url: string | null;
    privacy_policy_url: string | null;
    dpa_url: string | null;
    cookie_policy: "none" | "analytics" | "third_party";
    support_contact: string | null;
  };
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
  /** Security audit follow-up: a signup credit grant is now deferred until this is true —
   *  the "Verify your email" banner keys off it, alongside a 0 balance. */
  email_verified: boolean;
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

// Tier 2/3 follow-up: GDPR Art. 17 erasure — export existed, deletion didn't. Self-service only;
// the session used to call this becomes invalid immediately after (erase wipes session_state),
// so the caller should sign out and redirect right after a successful response.
export async function deleteMe(
  spaceId: string,
  session: SessionCredentials
): Promise<{ erased: boolean; erased_at: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/product-users/me`, {
    method: "DELETE",
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
  // §A1.17 Phase Q: pass `goal` explicitly (the message just persisted above) — the backend
  // will still derive it from the session's latest user message if this is ever omitted, but
  // sending it directly avoids that extra round trip on every single message.
  const agentRun = await apiFetch<{ id?: string; run_id?: string; task_id?: string }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/run`,
    { method: "POST", body: JSON.stringify({ session_id: sessionId, goal: content }), session }
  );
  return { userMessage, agentRunId: agentRun.id ?? agentRun.run_id ?? agentRun.task_id ?? "" };
}

/** Mint a short-lived (60s) single-use stream ticket, then build a stream URL that carries
 *  the ticket instead of the raw nps_ session token — keeps long-lived credentials out of
 *  CF access logs, proxy logs, and browser history. Falls back to the legacy ?session_token=
 *  path if the ticket endpoint is unreachable (e.g. during tests). */
export async function getStreamUrl(spaceId: string, sessionId: string, runId: string, session: SessionCredentials): Promise<string> {
  try {
    const ticket = await apiFetch<{ ticket: string }>(
      `/v1/spaces/${spaceId}/sessions/stream-ticket`,
      { method: "POST", body: JSON.stringify({}), session }
    );
    const params = new URLSearchParams({ stream_ticket: ticket.ticket, end_user_id: session.endUserId });
    return `${API_URL}/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}/stream?${params.toString()}`;
  } catch {
    // Legacy fallback: raw session token in URL (logged but functional — used during local dev).
    const params = new URLSearchParams({ session_token: session.sessionToken, end_user_id: session.endUserId });
    return `${API_URL}/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}/stream?${params.toString()}`;
  }
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

// ── Context-window usage (§A1.27) ────────────────────────────────────────────

export interface ContextUsage {
  current_tokens: number;
  model: string;
  model_window: number;
  percent_full: number;
  daily_used: number | null;
  daily_limit: number | null;
  weekly_used: number | null;
  weekly_limit: number | null;
  monthly_used: number | null;
  monthly_limit: number | null;
}

export async function getContextUsage(
  spaceId: string,
  sessionId: string,
  session: SessionCredentials,
  model?: string
): Promise<ContextUsage> {
  const qs = model ? `?model=${encodeURIComponent(model)}` : "";
  return apiFetch(`/v1/spaces/${spaceId}/sessions/${sessionId}/context-usage${qs}`, { session });
}

/** Client-driven pre-send compaction — call when getContextUsage's percent_full crosses a
 *  threshold (the shell UI uses 85%, matching the compaction hook's own documented default). */
export async function compactSession(spaceId: string, sessionId: string, session: SessionCredentials): Promise<{ ok: boolean }> {
  return apiFetch(`/v1/spaces/${spaceId}/sessions/${sessionId}/compact`, { method: "POST", body: JSON.stringify({}), session });
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
  // WS-4.2 / F-40: a project's kind — 'workspace'/'customer_bot' plus any Business Feature kind
  // (wallet, storefront, crm, ...). The project-page shell mounts the natively-built panel for it.
  kind?: string;
  execution_ceiling?: number;
  daily_spend_cap_credits?: number;
  channel_config?: Record<string, unknown>;
  visibility?: "public" | "private";
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

// WS-4.2: surfaces the already-built rich project config (customer_bot kind, execution ceiling,
// spend cap, max threads, agent bindings) — PATCH succeeds for an admin/owner in the target
// business (or fails 403, same "identity here, authorization there" pattern as every other
// business-scoped route; the UI surfaces that error rather than pre-computing role).
export async function updateProject(
  spaceId: string,
  projectId: string,
  session: SessionCredentials,
  patch: Partial<{
    name: string;
    description: string;
    kind: "workspace" | "customer_bot";
    execution_ceiling: number;
    daily_spend_cap_credits: number;
    max_threads: number;
    default_agent_id: string | null;
    allowed_agent_ids: string[] | null;
  }>
): Promise<Project> {
  return apiFetch(`/v1/spaces/${spaceId}/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    session,
  });
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

// ── Space Assistant surface (WS-2) — read-only panels, all pure consumers of existing backends ──

export interface AssistantPolicy {
  approval_mode: "always_ask" | "gate_unless_listed" | "gate_listed" | "yolo";
  auto_approved_actions: string[];
}

export async function getAssistantPolicy(spaceId: string, session: SessionCredentials): Promise<AssistantPolicy> {
  return apiFetch(`/v1/spaces/${spaceId}/assistant-policy`, { session });
}

export interface MemoryFact {
  key: string;
  category: string;
  value: unknown;
  confidence: number;
}

export async function getAssistantMemory(spaceId: string, session: SessionCredentials): Promise<MemoryFact[]> {
  const res = await apiFetch<{ entries: MemoryFact[]; count: number }>(`/v1/spaces/${spaceId}/assistant/memory`, { session });
  return res.entries;
}

export interface ScheduledJob {
  id: string;
  name: string;
  cron_expression: string;
  enabled: number;
  last_run_at: string | null;
  consecutive_failures: number;
}

export async function listScheduledJobs(spaceId: string, session: SessionCredentials): Promise<ScheduledJob[]> {
  const res = await apiFetch<{ data: ScheduledJob[] }>(`/v1/spaces/${spaceId}/scheduled-jobs`, { session });
  return res.data;
}

export interface ChannelLink {
  channel: string;
  enabled: number;
  created_at: string;
}

export async function listAssistantChannels(spaceId: string, session: SessionCredentials): Promise<ChannelLink[]> {
  const res = await apiFetch<{ data: ChannelLink[] }>(`/v1/spaces/${spaceId}/assistant/channels`, { session });
  return res.data;
}

export interface SubAgentSummary {
  id: string;
  goal: string;
  status: string;
  progress_note: string | null;
  created_at: string;
  updated_at: string;
}

export async function listSubAgents(spaceId: string, session: SessionCredentials, parentRunId: string): Promise<SubAgentSummary[]> {
  const res = await apiFetch<{ data?: SubAgentSummary[] } | SubAgentSummary[]>(
    `/v1/spaces/${spaceId}/assistant/sub-agents?parent_run_id=${encodeURIComponent(parentRunId)}`,
    { session }
  );
  return Array.isArray(res) ? res : res.data ?? [];
}

export interface WorkspaceFile {
  path: string;
  size: number;
  uploaded: string;
}

export async function listAssistantFiles(spaceId: string, session: SessionCredentials): Promise<WorkspaceFile[]> {
  const res = await apiFetch<{ data: WorkspaceFile[] }>(`/v1/spaces/${spaceId}/assistant/files`, { session });
  return res.data;
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

// F-WALLET-7: the consolidated per-business wallet view (available balance + lifetime cut summary
// + recent transactions).
export interface WalletTransaction {
  id: string;
  delta_cents: number;
  currency: string;
  reason: string;
  balance_after_cents: number;
  created_at: string;
}
export interface BusinessWallet {
  space_id: string;
  project_id: string | null;
  available_balance_cents: number;
  currency: string;
  lifetime: {
    gross_cents: number;
    naelao_cut_cents: number;
    builder_cut_cents: number;
    net_settled_cents: number;
    order_count: number;
  };
  transactions: WalletTransaction[];
}

export async function getBusinessWallet(spaceId: string, session: SessionCredentials): Promise<BusinessWallet> {
  return apiFetch(`/v1/spaces/${spaceId}/wallet`, { session });
}

// F-39: read-only workspace file viewer for a project.
export interface WorkspaceFile { path: string; size: number; uploaded: string }
export async function listWorkspaceFiles(spaceId: string, projectId: string, session: SessionCredentials): Promise<WorkspaceFile[]> {
  const res = await apiFetch<{ data: WorkspaceFile[] }>(`/v1/spaces/${spaceId}/projects/${projectId}/workspace/files`, { session });
  return res.data ?? [];
}
export async function readWorkspaceFile(spaceId: string, projectId: string, path: string, session: SessionCredentials): Promise<{ path: string; size: number; content?: string; too_large?: boolean }> {
  return apiFetch(`/v1/spaces/${spaceId}/projects/${projectId}/workspace/files/${path.split("/").map(encodeURIComponent).join("/")}`, { session });
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

// §A1.17 Phase S: local-machine-as-container grants — a business member opting THEIR OWN
// machine in so the business's assistant can read/write files or run exact commands on it. The
// spaces worker filters GET to the caller's own grants automatically (requireBusinessMembership
// + SpaceDO's user_id filter) — never trust a client-supplied user_id for that.
export interface LocalGrant {
  id: string;
  space_id: string;
  project_id: string | null;
  user_id: string;
  grant_type: "read" | "write" | "readwrite" | "exec";
  directory?: string | null;
  commands: string[];
  created_at: string;
}

export async function listLocalGrants(spaceId: string, session: SessionCredentials): Promise<LocalGrant[]> {
  const res = await apiFetch<{ data: LocalGrant[] }>(`/v1/spaces/${spaceId}/local-grants`, { session });
  return res.data;
}

export async function createLocalGrant(
  spaceId: string,
  session: SessionCredentials,
  input: { grant_type: "read" | "write" | "readwrite" | "exec"; directory?: string; commands?: string[] }
): Promise<LocalGrant> {
  return apiFetch(`/v1/spaces/${spaceId}/local-grants`, { method: "POST", body: JSON.stringify(input), session });
}

export async function deleteLocalGrant(spaceId: string, grantId: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/local-grants/${encodeURIComponent(grantId)}`, { method: "DELETE", session });
}

export interface LocalTunnelConnectInfo {
  token: string;
  space_id: string;
  user_id: string;
  connect_path: string;
  expires_in_seconds: number;
}

export async function mintLocalTunnelConnectToken(spaceId: string, session: SessionCredentials): Promise<LocalTunnelConnectInfo> {
  return apiFetch(`/v1/spaces/${spaceId}/local-tunnel/connect-token`, { method: "POST", session });
}

// ── Knowledge Base (WS-4: optional project_id isolates a document to a project's own KB;
// omitted = the pre-existing space-wide default) ─────────────────────────────────────────────

export interface KbDocument {
  id: string;
  space_id: string;
  project_id: string | null;
  title: string;
  source_url: string | null;
  content_type: "text" | "url" | "code" | "pdf";
  status: "pending" | "processing" | "indexed" | "flagged" | "failed";
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export async function listKbDocuments(spaceId: string, session: SessionCredentials, projectId?: string): Promise<KbDocument[]> {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  const res = await apiFetch<{ data: KbDocument[]; count: number }>(`/v1/spaces/${spaceId}/kb/documents${qs}`, { session });
  return res.data;
}

export async function createKbDocument(
  spaceId: string,
  session: SessionCredentials,
  input: { title: string; content: string; content_type?: string; source_url?: string; project_id?: string }
): Promise<KbDocument> {
  return apiFetch(`/v1/spaces/${spaceId}/kb/documents`, { method: "POST", body: JSON.stringify(input), session });
}

export async function deleteKbDocument(spaceId: string, docId: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/kb/documents/${encodeURIComponent(docId)}`, { method: "DELETE", session });
}

// ── Business Wallet (Whop sub-merchant model): the business's OWN bank account ────────────────
// Every business auto-provisions an isolated Whop sub-merchant wallet the moment it's created —
// no owner action, no OAuth, no personal bank/card details. Balance/history are member-visible;
// managing payout destinations and requesting a payout is admin-only (enforced by
// requireBusinessMembership on the spaces worker).

export interface WhopWalletBalance {
  status: "pending" | "awaiting_kyc" | "active" | "error" | "not_provisioned";
  balance_cents?: number;
  currency?: string;
  last_synced_at?: string | null;
  /** Set only while status='awaiting_kyc' — the one-time Whop verification link the owner must
   *  complete before payouts work. Null when Whop's response didn't include a direct link. */
  onboarding_url?: string | null;
}

export interface WhopWalletTransaction {
  type: "revenue" | "expense" | "payout" | "fee_debit";
  amount_cents: number;
  currency: string;
  description: string | null;
  external_ref: string | null;
  created_at: string;
}

export interface PayoutDestination {
  id: string;
  type: "bank" | "crypto" | "venmo" | "cashapp";
  label: string;
  status: "pending" | "verified" | "error";
  is_default: number;
  created_at: string;
}

export async function getBusinessWalletBalance(spaceId: string, session: SessionCredentials): Promise<WhopWalletBalance> {
  const res = await apiFetch<{ wallet: WhopWalletBalance | null; status?: string }>(`/v1/spaces/${spaceId}/business-wallet/balance`, { session });
  return res.wallet ?? { status: (res.status as WhopWalletBalance["status"]) ?? "not_provisioned" };
}

export async function getBusinessWalletTransactions(spaceId: string, session: SessionCredentials, limit = 20): Promise<WhopWalletTransaction[]> {
  const res = await apiFetch<{ transactions: WhopWalletTransaction[] }>(`/v1/spaces/${spaceId}/business-wallet/transactions?limit=${limit}`, { session });
  return res.transactions ?? [];
}

export async function getPayoutDestinations(spaceId: string, session: SessionCredentials): Promise<PayoutDestination[]> {
  const res = await apiFetch<{ destinations: PayoutDestination[] }>(`/v1/spaces/${spaceId}/business-wallet/destinations`, { session });
  return res.destinations ?? [];
}

export async function addPayoutDestination(
  spaceId: string,
  session: SessionCredentials,
  params: { type: PayoutDestination["type"]; label: string; details: Record<string, unknown> }
): Promise<{ destination: PayoutDestination }> {
  return apiFetch(`/v1/spaces/${spaceId}/business-wallet/destinations`, {
    method: "POST",
    body: JSON.stringify(params),
    session,
  });
}

export async function requestPayout(
  spaceId: string,
  session: SessionCredentials,
  params: { destination_id: string; amount_cents: number; note?: string }
): Promise<{ payout: { id: string; status: string } }> {
  return apiFetch(`/v1/spaces/${spaceId}/business-wallet/payouts`, {
    method: "POST",
    body: JSON.stringify(params),
    session,
  });
}

// ── Connect your OWN Whop account (no Naelao Platforms invite needed) ─────────────────────────
// A business owner's OWN Whop API key (from their own Whop dashboard — generally available, no
// invite required, unlike the Platforms/business-wallet rail above). The agent then reads it
// read-only via mcp-connector, and Naelao's revenue cut is billed as a surcharge on the builder's
// NEXT platform subscription (the existing revenue-tracker mechanism), not auto-split at checkout.

export interface ConnectorInfo {
  id: string;
  name: string;
  category: string;
  status: "available" | "coming_soon";
  summary: string;
  connected?: boolean;
}

export async function getConnectorStatus(spaceId: string, session: SessionCredentials): Promise<ConnectorInfo[]> {
  const res = await apiFetch<{ connectors: ConnectorInfo[] }>(`/v1/spaces/${spaceId}/connectors/status`, { session });
  return res.connectors ?? [];
}

export async function connectPlatform(
  spaceId: string,
  session: SessionCredentials,
  platform: string,
  apiKey: string
): Promise<{ connected: boolean; platform: string; server_id: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/connectors/connect`, {
    method: "POST",
    body: JSON.stringify({ platform, api_key: apiKey }),
    session,
  });
}

/** "Connect with X" OAuth flow (Whop first) — returns the real Whop authorize URL to navigate
 *  the browser to; the caller does `window.location.href = authorize_url` itself (a real page
 *  navigation, never a fetch — no Naelao credential appears in it, only an opaque single-use
 *  ticket). return_url should be the current page — the callback redirects back here with
 *  `?whop_connected=1` or `?whop_oauth_error=...` on completion. */
export async function startOAuthConnect(
  spaceId: string,
  session: SessionCredentials,
  platform: string,
  returnUrl: string
): Promise<{ authorize_url: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/connectors/oauth-start`, {
    method: "POST",
    body: JSON.stringify({ platform, return_url: returnUrl }),
    session,
  });
}
