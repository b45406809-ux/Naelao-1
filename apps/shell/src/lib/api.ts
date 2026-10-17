import { ApiError, requestJson } from "./request";
// Product Shell API client — a signed-in product end user talks to the platform via a
// product-scoped nps_... session token (ProductUserDO-backed), never the builder's platform JWT.
// Ported from apps/portal/src/lib/api.ts's proven hybrid-auth pattern (Three-Tier Platform
// Model, Phase 6): the router requires BOTH `Authorization: Bearer nps_...` AND
// `x-naelao-end-user-id` together, on an explicit per-route allowlist.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export function getAgentVoiceHost(): string {
  return new URL(API_URL).host;
}

export interface SessionCredentials {
  sessionToken: string;
  endUserId: string;
}

export async function transcribeVoice(audio: Blob): Promise<string> {
  const response = await fetch(`${API_URL}/api/voice/transcribe`, {
    method: "POST",
    headers: { "content-type": audio.type || "audio/webm" },
    body: audio,
  });
  const result = await response.json() as { ok?: boolean; text?: string; error?: string };
  if (!response.ok || !result.ok) throw new Error(result.error ?? "Voice transcription failed");
  return result.text ?? "";
}

export interface OwnerVoiceTicket {
  agent: "OWNER_VOICE_AGENT";
  name: string;
  ticket: string;
  expires_at: number;
  session_id: string;
}

export async function requestOwnerVoiceTicket(
  spaceId: string,
  sessionId: string,
  session: SessionCredentials,
  projectId?: string,
): Promise<OwnerVoiceTicket> {
  return apiFetch<OwnerVoiceTicket>(`/v1/spaces/${encodeURIComponent(spaceId)}/sessions/${encodeURIComponent(sessionId)}/voice-ticket`, {
    method: "POST",
    session,
    body: JSON.stringify(projectId ? { project_id: projectId } : {}),
  });
}

export { ApiError } from "./request";

export async function apiFetch<T>(path: string, options: RequestInit & {
  session?: SessionCredentials;
  onRetry?: (attempt: number, max: number) => void;
  retries?: number;
} = {}): Promise<T> {
  const { session, onRetry, retries, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers);
  headers.set("Content-Type", "application/json");
  if (session) {
    if (session.sessionToken !== "cookie") headers.set("Authorization", `Bearer ${session.sessionToken}`);
    headers.set("x-naelao-end-user-id", session.endUserId);
  }
  return requestJson<T>(`${session?.sessionToken === "cookie" ? "/api/naelao" : API_URL}${path}`, { ...fetchOptions, headers, ...(session?.sessionToken === "cookie" ? { credentials: "include" as const } : {}) }, { onRetry, retries });
}

export interface CustomerVoiceNumber {
  id: string; provider_number_sid: string; phone_number: string; country_code: string; region: string;
  capabilities_json: string; monthly_cost_minor: number; inbound_price_per_minute_minor: number;
  max_concurrent_calls: number; max_call_duration_seconds: number; status: string; created_at: string;
}
const customerVoicePath = (spaceId: string) => `/v1/spaces/${encodeURIComponent(spaceId)}/customer-voice`;
export function listCustomerVoiceNumbers(spaceId: string, session: SessionCredentials) {
  return apiFetch<{ numbers: CustomerVoiceNumber[] }>(`${customerVoicePath(spaceId)}/numbers`, { session, cache: "no-store" });
}
export function searchCustomerVoiceNumbers(spaceId: string, session: SessionCredentials, country: string, areaCode?: string) {
  const query = new URLSearchParams({ country });
  if (areaCode) query.set("area_code", areaCode);
  return apiFetch<{ numbers: Array<{ phone_number: string; country_code: string; region: string; locality: string; capabilities: { voice: boolean; sms: boolean; mms: boolean } }>; pricing: { status: "current_rate_card"; number_type: "local"; monthly_cost_minor: number; currency: "USD"; quoted_at: string; taxes_included: false } | { status: "unavailable" }; purchase: "not_performed" }>(`${customerVoicePath(spaceId)}/available-numbers?${query}`, { session, cache: "no-store" });
}
export interface TwilioCustomerVoicePurchaseQuote {
  quote_id: string; phone_number: string; number_type: string; monthly_cost_minor: number;
  inbound_price_per_minute_minor: number; currency: "USD"; taxes_included: false; quoted_at: string; expires_at: string;
}
export function quoteCustomerVoiceNumber(spaceId: string, session: SessionCredentials, phoneNumber: string, countryCode: string) {
  return apiFetch<TwilioCustomerVoicePurchaseQuote>(`${customerVoicePath(spaceId)}/numbers/purchase/quote`, { method: "POST", session, body: JSON.stringify({ phone_number: phoneNumber, country_code: countryCode }) });
}
export function purchaseCustomerVoiceNumber(spaceId: string, session: SessionCredentials, quoteId: string, monthlyCostMinor: number, agentId: string, ownerPrompt: string) {
  return apiFetch<CustomerVoiceNumber>(`${customerVoicePath(spaceId)}/numbers/purchase`, { method: "POST", session, body: JSON.stringify({ quote_id: quoteId, confirm_monthly_cost_minor: monthlyCostMinor, confirm_purchase: true, agent_id: agentId, owner_prompt: ownerPrompt }) });
}
export function resolveCustomerVoicePurchaseQuote(spaceId: string, session: SessionCredentials, quoteId: string, resolution: "imported" | "not_purchased") {
  return apiFetch<{ resolved: boolean; status: string }>(`${customerVoicePath(spaceId)}/numbers/purchase/quotes/${encodeURIComponent(quoteId)}/resolve`, { method: "POST", session, body: JSON.stringify({ resolution, ...(resolution === "not_purchased" ? { confirm_account_checked: true } : {}) }) });
}
export function saveCustomerVoiceCredentials(spaceId: string, session: SessionCredentials, accountSid: string, authToken: string) {
  return apiFetch<{ configured: boolean; account_sid: string }>(`${customerVoicePath(spaceId)}/twilio-credentials`, { method: "PUT", session, body: JSON.stringify({ account_sid: accountSid, auth_token: authToken }) });
}
export function importCustomerVoiceNumber(spaceId: string, session: SessionCredentials, body: { phone_number_sid: string; agent_id: string; owner_prompt: string }) {
  return apiFetch<CustomerVoiceNumber>(`${customerVoicePath(spaceId)}/numbers/import`, { method: "POST", session, body: JSON.stringify(body) });
}
export function disableCustomerVoiceNumber(spaceId: string, session: SessionCredentials, bindingId: string) {
  return apiFetch<{ disabled: boolean }>(`${customerVoicePath(spaceId)}/numbers/${encodeURIComponent(bindingId)}/disable`, { method: "POST", session, body: "{}" });
}
export function releaseCustomerVoiceNumber(spaceId: string, session: SessionCredentials, bindingId: string) {
  return apiFetch<{ released: boolean }>(`${customerVoicePath(spaceId)}/numbers/${encodeURIComponent(bindingId)}`, { method: "DELETE", session, body: JSON.stringify({ confirm_release: true }) });
}

export interface ArchiveRewrapJob { job_id: string; status: "active" | "blocked" | "completed"; scanned_count: number; rewrapped_count: number; last_error?: string | null; updated_at?: string }
export function getSpaceDataOps(spaceId: string, session: SessionCredentials) {
  return apiFetch<{ archives: Array<{ archive_id: string; status: string }>; rewrap_jobs: ArchiveRewrapJob[] }>(`/v1/spaces/${encodeURIComponent(spaceId)}/data-ops`, { session, cache: "no-store" });
}
export function startArchiveRewrap(spaceId: string, session: SessionCredentials) {
  return apiFetch<ArchiveRewrapJob>(`/v1/spaces/${encodeURIComponent(spaceId)}/data-ops`, { method: "POST", session, body: JSON.stringify({ action: "start_rewrap_archives" }) });
}
export function resumeArchiveRewrap(spaceId: string, session: SessionCredentials, jobId: string) {
  return apiFetch<ArchiveRewrapJob>(`/v1/spaces/${encodeURIComponent(spaceId)}/data-ops`, { method: "POST", session, body: JSON.stringify({ action: "resume_rewrap_archives", job_id: jobId }) });
}

export interface CustomModelLifecycle {
  modelId: string; space_id: string; model_id: string; status: string; training_enabled: boolean;
  training_reason?: string; base_model?: string; provider_evidence?: string; evaluation_test_set?: string;
  evaluation_sample_count?: number; evaluation_score?: number; evaluation_threshold?: number;
  evaluation_passed?: number; approved_by?: string; updated_at?: string;
  previous_active_model_id?: string | null;
}
export function getCustomModelLifecycle(spaceId: string, modelId: string, session: SessionCredentials) {
  return apiFetch<CustomModelLifecycle>(`/v1/spaces/${encodeURIComponent(spaceId)}/custom-models/${encodeURIComponent(modelId)}/lifecycle`, { session, cache: "no-store" });
}
export function updateCustomModelLifecycle(spaceId: string, modelId: string, session: SessionCredentials, body: Record<string, unknown>) {
  return apiFetch<Record<string, unknown>>(`/v1/spaces/${encodeURIComponent(spaceId)}/custom-models/${encodeURIComponent(modelId)}/lifecycle`, { method: "POST", session, body: JSON.stringify(body) });
}
export interface CustomModelTestSet { id: string; version: string; cases: Array<{ input: string; expected: string }>; }
export function listCustomModelTestSets(spaceId: string, modelId: string, session: SessionCredentials) {
  return apiFetch<{ testSets: Array<{ id: string; version: string; case_count: number; created_by: string; updated_at: string }> }>(`/v1/spaces/${encodeURIComponent(spaceId)}/custom-models/${encodeURIComponent(modelId)}/test-sets`, { session, cache: "no-store" });
}
export function getCustomModelTestSet(spaceId: string, modelId: string, testSetId: string, session: SessionCredentials) {
  return apiFetch<{ testSet: CustomModelTestSet }>(`/v1/spaces/${encodeURIComponent(spaceId)}/custom-models/${encodeURIComponent(modelId)}/test-sets?test_set_id=${encodeURIComponent(testSetId)}`, { session, cache: "no-store" });
}
export function saveCustomModelTestSet(spaceId: string, modelId: string, session: SessionCredentials, testSet: CustomModelTestSet) {
  return apiFetch<Record<string, unknown>>(`/v1/spaces/${encodeURIComponent(spaceId)}/custom-models/${encodeURIComponent(modelId)}/test-sets`, { method: "POST", session, body: JSON.stringify({ action: "save", testSet }) });
}
export function deleteCustomModelTestSet(spaceId: string, modelId: string, session: SessionCredentials, testSetId: string) {
  return apiFetch<Record<string, unknown>>(`/v1/spaces/${encodeURIComponent(spaceId)}/custom-models/${encodeURIComponent(modelId)}/test-sets`, { method: "POST", session, body: JSON.stringify({ action: "delete", testSetId }) });
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
  // Product resolution is the shell's bootstrap request. During local development the router
  // can come up a moment before its Spaces service binding reconnects; one short retry turned
  // that transient 503 into a full-page runtime error for every route. Keep this read-only lookup
  // patient enough for the local worker topology to settle without replaying any mutation.
  return apiFetch<ProductBySlug>(`/v1/products/by-slug/${encodeURIComponent(slug)}`, { cache: "no-store", retries: 5 });
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
  /** §A1.28 model switcher — null means unset (the dispatch layer's own DEFAULT_WORKING_MODEL
   *  fallback applies). Present in the real backend response since item 48; the type just never
   *  carried it (item 79 — same "server sends it, TS type didn't know" gap as template_catalog's
   *  missing free_tier_eligible, item 65). */
  model: string | null;
  /** The business's stored default Effort (billing-core's EffortLevel) — null means unset (the
   *  dispatch layer's own "low" fallback applies). Not yet read by the shell's own initial-state
   *  resolution (which defaults to "low" locally, the same value this would resolve to when
   *  unset) — a business that's explicitly set a non-"low" default isn't picked up here until a
   *  user first opens the Effort panel; a real, deliberately deferred refinement. */
  effort: string | null;
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
   *  from this instead of a hardcoded copy of LAUNCHPAD_TEMPLATES. free_tier_eligible was already
   *  sent by the backend (workers/spaces/src/template-catalog.ts) but missing from this type, so
   *  the dialog had no way to warn a free-plan user before they hit the server-side
   *  plan_upgrade_required rejection — see spaces/page.tsx's "Requires upgrade" badge. */
  template_catalog: Array<{
    id: string;
    name: string;
    description?: string;
    template_mode?: "ave" | "cowork";
    vertical?: string;
    wallet_mode?: "business_wallet" | "company_budget";
    coming_soon: boolean;
    free_tier_eligible: boolean;
  }>;
  /** Browse-only: the project presets a business is configured with, and the core agents that
   *  run it. Static product data — an agent's system_prompt is never included. Absent on an older
   *  backend, so both are optional and default to empty. */
  project_template_catalog?: Array<{ id: string; name: string; description: string; kind: string }>;
  agent_catalog?: Array<{ id: string; name: string; description: string }>;
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
  preferred_language: string | null;
}

export async function getMe(spaceId: string, session: SessionCredentials): Promise<ProductUserMe> {
  return apiFetch<ProductUserMe>(`/v1/spaces/${spaceId}/product-users/me`, { session });
}

export async function updateMe(
  spaceId: string,
  session: SessionCredentials,
  patch: { display_name?: string; preferred_language?: string | null }
): Promise<{ ok: boolean; display_name?: string; preferred_language?: string | null }> {
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
  /** Which identity produced this. A thread can carry the Space Assistant, one or more named
   *  project agents, and people — collapsing all of them into one anonymous "assistant" bubble
   *  makes a multi-agent thread unreadable, and hides who actually did a thing. */
  author_type?: "user" | "agent" | "assistant" | "tool";
  /** The agent's own id for author_type "agent"; the person's id for "user". */
  author_id?: string | null;
  /** item 79: when this assistant message resulted from consulting a project agent, which
   *  subthread(s) it opened — rendered inline as an expandable card at this exact turn instead
   *  of only in the separate "Assistant" tab. Absent/empty for an ordinary message.
   *  needs_connector/connector_id/connector_name: the assistant tried to use a catalogued but
   *  not-yet-connected app (script-engine's tool-surface.ts) — rendered as an inline "Connect X"
   *  card at this exact turn instead of the connector name only ever appearing in prose. */
  metadata?: {
    provider_usage?: { input_tokens: number; output_tokens: number };
    consulted_threads?: ConsultedThread[];
    workspace_publication?: {
      status?: string;
      review?: { id: string; thread_id?: string | null; status?: string; card?: Record<string, unknown> };
    };
    needs_connector?: boolean;
    connector_id?: string;
    connector_name?: string;
    /** The run that produced this message — durable (see NaelaoAgentDO's own comment on this
     *  field), unlike the client-only `activity` below. Lets a reload re-fetch this exact run's
     *  activity trail via getAgentRunTrace instead of losing it. */
    run_id?: string;
    /** Set by thread.send_message: the business assistant spoke INTO this thread on the owner's
     *  behalf, and (unless awaiting_reply is false) the named agent replied right after. Rendered
     *  as ONE collapsible card covering both, so it doesn't read as the assistant answering its
     *  own question in two adjacent left-aligned bubbles. */
    assistant_delegation?: {
      agent_id?: string | null;
      on_behalf_of_user?: boolean;
      awaiting_reply?: boolean;
    };

    /** Step 5/7/11: artifacts the assistant CREATED during this run — rendered inline as a
     *  preview (iframe for HTML + download) at this turn, like Claude showing an artifact. */
    created_artifacts?: Array<{ artifact_id: string; filename: string; content_type?: string }>;
    /** Versioned immutable citation events emitted by the agent stream. Ordinals are assigned
     * once server-side and are never inferred from render order. */
    citations?: Array<{ version: 1; ordinal: number; identity: string; document_id: string; chunk_id: string; label?: string }>;
  };
  /** CLIENT-ONLY, never persisted server-side: the "currently doing X" activity trail this run
   *  produced (observe/find/gate/reason/run/answer steps, live while the run was in flight — see
   *  LiveRunStep). Attached locally to the completed assistant bubble by Chat.tsx once the run
   *  finishes, so the tool-call/thinking summary stays visible under that turn — lost on reload,
   *  same documented scope as the backend's own in-memory (not persisted) live-progress map. */
  activity?: LiveRunStep[];
  /** CLIENT-ONLY: attached by Chat.tsx when THIS turn's run stopped waiting on a person, so an
   *  inline approval card renders at the exact turn that asked for it. Not persisted — a reload
   *  loses this (the run is still genuinely pending; the separate /approvals inbox is the
   *  durable, reload-safe way to find and answer it). */
  pendingApproval?: RunPendingApproval;
  /** CLIENT-ONLY questionnaire card attached to the live turn that is waiting for an answer. */
  pendingQuestion?: RunPendingApproval;
  /** CLIENT-ONLY, same non-persisted scope as pendingApproval: one or more actions this run
   *  parked and carried on around (as opposed to pendingApproval, where the WHOLE run stopped).
   *  Rendered as the same inline card, one per entry. */
  deferredApprovals?: RunPendingApproval[];
  /** CLIENT-ONLY, set once at creation for a message finalized from a live run THIS session (never
   *  set on a message loaded from history). Tells RevealText to animate this bubble's text in
   *  rather than show it instantly — a reload must never re-animate a message it already showed. */
  justArrived?: boolean;
  /** CLIENT-ONLY: how much of this message's text the viewer had ALREADY watched stream in, in the
   *  live in-flight block, before this bubble replaced it. The live block and the finalized
   *  message are two different render branches, so React unmounts one and mounts the other — the
   *  reveal animation would otherwise restart from empty and re-type text that was just read (the
   *  visible "snap" at stream completion). RevealText seeds itself with this instead. */
  revealedPrefix?: string;
}

export async function decidePullRequestCard(spaceId: string, projectId: string, cardId: string,
  decision: "merge" | "request_changes" | "reject", session?: SessionCredentials): Promise<{ id: string; status: string }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/pull-request-cards/${encodeURIComponent(cardId)}/decision`, {
    method: "POST", body: JSON.stringify({ decision }), ...(session ? { session } : {}),
  });
}

export interface PullRequestCard {
  id: string; status: string; thread_id?: string | null; title?: string; baseBranch?: string;
  forkBranch?: string; baseCommit?: string; headCommit?: string; reasoning?: string; files?: Array<Record<string, unknown>>;
}

export async function listPullRequestCards(spaceId: string, projectId: string, session?: SessionCredentials): Promise<PullRequestCard[]> {
  const response = await apiFetch<{ data?: PullRequestCard[] }>(
    `/v1/spaces/${encodeURIComponent(spaceId)}/pull-request-cards?project_id=${encodeURIComponent(projectId)}`,
    session ? { session } : {});
  return response.data ?? [];
}

export async function resolveCitation(
  spaceId: string,
  projectId: string,
  citation: { document_id: string; chunk_id: string },
  session: SessionCredentials
): Promise<{ citation: Record<string, unknown>; content: string }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/citations/${encodeURIComponent(citation.document_id)}/${encodeURIComponent(citation.chunk_id)}`, { session });
}

export interface ConsultedThread {
  thread_id: string;
  agent_id: string;
  title: string;
  session_id?: string;
}

/** One "currently doing X" checkpoint from the script-native loop (observe/find/gate/reason/run/
 *  answer/give_up) — mirrors workers/agents/src/index.ts's LiveRunStep. Live while a run is in
 *  flight (NaelaoAgentDO's in-memory liveRuns map); the SAME shape is what loop.ts persists to
 *  run_traces once the run completes, so a step seen live never changes shape once it's "done". */
export interface LiveRunStep {
  seq: number;
  phase: string;
  name?: string;
  detail?: string;
  ok?: boolean;
  tier?: number;
  duration_ms?: number;
  tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  usage_source?: "provider";
  /** A reasoning-capable model's own chain-of-thought for a "reason" step, when the model
   *  returned one. Rendered as a separate collapsed "Thoughts" block, not folded into `detail`. */
  thinking?: string;
  /** The live STATUS for this step's action ("Checking your existing projects") — shown beside it
   *  while it runs and REPLACED by the next action's own, so a run of tool calls shows one status
   *  line rather than one per call. See TraceStep's own doc header. */
  narration?: string;
  /** A real MESSAGE the model chose to write to the person on this step. Unlike `narration` it is
   *  never replaced: it renders as its own line in order, so a run reads as message → tool calls →
   *  message → tool calls. Present only on the turns where the model judged one was warranted. */
  message?: string;
  /** For a "run" phase step: the exact arguments the tool was called with — the real command,
   *  not just a duration (Claude Code's own cmd-tool view). Set on both the "begin" and
   *  "complete" checkpoints for the same step. */
  params?: unknown;
  /** For a "run" phase step that succeeded: a size-capped, stringified view of the tool's raw
   *  return value. A failed call's outcome is in `detail` instead. */
  output?: string;
  /** This step is still being written: the model is mid-sentence and the next update will carry
   *  more of the same text under the SAME seq. Merge by seq, never append (see mergeActivitySteps),
   *  or one reasoning turn renders as a dozen half-finished rows. Never set on a persisted trace. */
  partial?: boolean;
  ts: number;
}

/**
 * Fold an incoming batch of activity steps into what's already on screen, keyed by `seq`.
 *
 * The stream now sends a step AGAIN whenever its text has grown — that's what makes a sentence
 * appear as it's written — so a plain append would print each fragment as its own row. Replacing
 * by seq keeps one row per real step, growing in place. Order follows first-appearance so a
 * re-sent step stays where it was rather than jumping to the end of the list.
 */
export function mergeActivitySteps(existing: LiveRunStep[], incoming: LiveRunStep[]): LiveRunStep[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, LiveRunStep>();
  for (const s of existing) bySeq.set(s.seq, s);
  for (const s of incoming) bySeq.set(s.seq, s);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Re-fetches a COMPLETED run's persisted activity trail (§A1 HX1's run_traces, the same shape
 *  live_steps already used) — what makes a reload able to show the activity sequence again for a
 *  message that carries metadata.run_id, instead of the trail being gone the moment the client's
 *  own in-memory copy is. Business-member end users and builders alike; see the route's own
 *  header on the agents worker for the gating rationale. */
export async function getAgentRunTrace(
  spaceId: string,
  sessionId: string,
  runId: string,
  session: SessionCredentials
): Promise<LiveRunStep[]> {
  const res = await apiFetch<{ run_id: string; trace: LiveRunStep[] }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}/trace`,
    { session }
  );
  return res.trace ?? [];
}

/** What a run is waiting on a PERSON for — the data an inline in-chat approval card renders.
 *  Mirrors workers/agents/src/index.ts's RunPendingApproval. */
export interface RunPendingApproval {
  approval_id: string;
  action_name: string;
  params?: Record<string, unknown>;
  expires_at?: number;
  kind?: "approval" | "question";
  question_id?: string;
  question?: string;
  options?: string[];
  questions?: Array<{ question: string; options?: string[] }>;
}

export interface AgentRun {
  id: string;
  /** `awaiting_approval` means the run paused at a gate and is waiting on a PERSON, not on the
   *  machine. It is not terminal and it is not a failure — the work is intact and continues once
   *  someone answers, which is a completely different thing to tell a user than "still working". */
  status: "running" | "completed" | "failed" | "cancelled" | "awaiting_approval";
  final_answer?: string;
  /** The answer as the model is WRITING it, present only while status is "running". Distinct from
   *  final_answer so a client can tell "still growing" from "this is the result" — render it, but
   *  never treat it as the run having finished. */
  partial_answer?: string;
  error?: string;
  /** Machine-readable classification of `error` when it's a billing gate (insufficient_credits,
   *  subscription_inactive, quota_exceeded, infra_quota_exceeded, ...) — lets a client render an
   *  upgrade dialog instead of a bare error banner. Absent for any non-billing failure. */
  error_code?: string;
  /** New steps recorded since the run started, present only while status is "running" — see
   *  LiveRunStep's own doc. */
  live_steps?: LiveRunStep[];
  /** Present when status is "awaiting_approval" — which action, with what parameters. */
  pending_approval?: RunPendingApproval;
  pending_question?: RunPendingApproval;
  /** Actions the run parked and carried on around — distinct from pending_approval (which means
   *  the WHOLE run suspended). A run can finish (or even fail on something unrelated afterward)
   *  while still carrying one or more of these — they must be rendered regardless of `status`. */
  deferred_approvals?: RunPendingApproval[];
}

/** POST /v1/spaces/:spaceId/sessions — start a new chat session.
 *  `title` rides in the session's own metadata (SpaceDO has no title column) so the recent-
 *  sessions list can label a conversation without an N+1 fetch of every session's first message.
 *  `threadId`, when this session is the chat transport for a structural project thread (not a
 *  bare assistant/Home conversation), links the two server-side (threads.session_id) — without
 *  it the thread's own session was indistinguishable from a top-level conversation and leaked
 *  into the flat Sessions sidebar as an apparent duplicate. */
export async function startSession(
  spaceId: string,
  session: SessionCredentials,
  title?: string,
  threadId?: string
): Promise<{ id: string; space_id: string }> {
  const body: Record<string, unknown> = {};
  if (title) body.metadata = { title };
  if (threadId) body.thread_id = threadId;
  return apiFetch(`/v1/spaces/${spaceId}/sessions`, { method: "POST", body: JSON.stringify(body), session });
}

export interface SessionSummary {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  /** Derived from metadata.title (set at creation from the opening message). */
  title: string | null;
}

/**
 * If the given session is a heartbeat/cron-wake session (metadata.session_kind === "heartbeat"),
 * clears that flag so it starts appearing in the ordinary Sessions list/recents like any other
 * conversation — the "continue a heartbeat session as a normal one" ask. Never a no-op silent
 * failure: an already-promoted or ordinary session is simply left alone. `metadata` is a whole-
 * object PATCH server-side (updateSession), not a merge — so this reads the current value first
 * and writes back everything except the one key, rather than clobbering `title`/anything else.
 */
export async function promoteSessionIfHeartbeat(spaceId: string, sessionId: string, session: SessionCredentials): Promise<void> {
  try {
    const res = await apiFetch<{ metadata?: string }>(`/v1/spaces/${spaceId}/sessions/${sessionId}`, { session });
    const meta = JSON.parse(res.metadata ?? "{}") as Record<string, unknown>;
    if (meta["session_kind"] !== "heartbeat") return;
    delete meta["session_kind"];
    await apiFetch(`/v1/spaces/${spaceId}/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ metadata: meta }),
      session,
    });
  } catch {
    // Best-effort — a failed promote just means this session stays filed as a heartbeat one;
    // never blocks the actual message being sent.
  }
}

/** GET /v1/spaces/:spaceId/sessions — the signed-in user's own recent conversations. The
 *  end_user_id filter is applied SERVER-side from verified claims; a client-supplied one is
 *  ignored, so this can only ever return the caller's own sessions. */
export async function listSessions(
  spaceId: string,
  session: SessionCredentials,
  limit = 20,
  kind?: "heartbeat"
): Promise<SessionSummary[]> {
  const res = await apiFetch<{ data?: Array<{ id: string; status: string; created_at: string; updated_at: string; metadata?: string }> }>(
    `/v1/spaces/${spaceId}/sessions?limit=${limit}${kind ? `&kind=${kind}` : ""}`,
    { session }
  );
  return (res.data ?? []).map((row) => {
    let title: string | null = null;
    try {
      title = (JSON.parse(row.metadata ?? "{}") as { title?: string }).title ?? null;
    } catch {
      // A session whose metadata isn't valid JSON still belongs in the list, just unlabeled.
    }
    return { id: row.id, status: row.status, created_at: row.created_at, updated_at: row.updated_at, title };
  });
}

export async function getMessages(spaceId: string, sessionId: string, session: SessionCredentials): Promise<Message[]> {
  // Ask for a deep tail explicitly. The server returns the NEWEST `limit` messages, and this client
  // has no "load older" affordance, so whatever is not in this one response is unreachable in the
  // UI — 200 covers any realistic conversation, where the default of 50 visibly cut history off.
  const res = await apiFetch<{ data?: Message[]; messages?: Message[] } | Message[]>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/messages?limit=200`,
    { session }
  );
  if (Array.isArray(res)) return res;
  return res.data ?? res.messages ?? [];
}

/**
 * Truncate a session's transcript from `fromMessageId` onward (that message included).
 *
 * Editing your last message is a re-ask, and a re-ask should REPLACE the exchange it corrects.
 * Without this the client dropped the old pair from its own array while the server kept it, so
 * the correction looked clean until a reload re-read the transcript and rendered both versions.
 * Best-effort by design: the caller re-asks either way, since losing the new question to a failed
 * cleanup would be worse than briefly showing a stale one.
 */
export async function truncateMessagesFrom(
  spaceId: string,
  sessionId: string,
  fromMessageId: string,
  session: SessionCredentials
): Promise<{ deleted: number }> {
  return apiFetch<{ deleted: number }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/messages?from=${encodeURIComponent(fromMessageId)}`,
    { method: "DELETE", session }
  );
}

/** Model switcher options for one send — both optional, both already validated server-side
 *  against billing-core's ALLOWED_MODELS/MODEL_CAPABILITIES; an invalid pairing 400s rather than
 *  silently running a different config than the user chose. */
export interface RunModelOptions {
  model?: string;
  reasoningEffort?: string;
  /** The escalation-budget dial (billing-core's EffortLevel — "low"/"medium"/"high"/"ultra") —
   *  caps which model any work THIS run delegates (a sub-agent spawn, a consult) is allowed to
   *  use, independent of reasoningEffort (which only tunes the active model's own thinking
   *  depth). Validated server-side against the resolved model before use. */
  effort?: string;
  /** Which project agent (a bare or `${spaceId}:` composite agent_definition id) should handle
   *  this run — the project thread agent switcher's own selection. Omitted for an assistant
   *  session (no second agent to pick) or when the default binding is fine. */
  agentDefinitionId?: string;
  /** The project this run's thread lives in, when there is one — see workspacePrefix() on the
   *  agents worker. Without this the backend can't tell a project thread's run apart from the
   *  Space Assistant's, so EVERY tool a project agent calls (r2-workspace, file-manager, KB,
   *  Memory OS, the project journal, lock) silently falls back to the space-wide scope instead
   *  of this thread's own project — a file the AI creates lands in the wrong workspace, and a
   *  file the person already uploaded (which the upload route DOES scope correctly) becomes
   *  unreadable to the AI, which is looking in the wrong place. Omitted for an assistant session,
   *  which is deliberately space-wide. */
  projectId?: string;
  /** Names of the exact session uploads attached to this turn. The server reconstructs and
   *  authorizes their workspace keys; browser-supplied storage keys are never trusted. */
  uploadNames?: string[];
}

/** Persists the user's message, then kicks off an agent run.
 *  `onRetry`, when given, is called on every transient-failure retry attempt (network hiccup or
 *  a 5xx/429 from the gateway) — the caller's hook for showing "Request failed, retrying (x/10)…"
 *  instead of a multi-second silent stall or an immediate, unnecessary error. */
export async function sendMessage(
  spaceId: string,
  sessionId: string,
  content: string,
  session: SessionCredentials,
  modelOptions?: RunModelOptions,
  onRetry?: (attempt: number, max: number) => void
): Promise<{ userMessage: Message; agentRunId: string }> {
  // Minted ONCE, outside the retry loop inside apiFetch, so every retry of this same send carries
  // the same key. apiFetch retries a POST on a network-level throw or a 5xx/429 — and neither
  // proves the server didn't already commit the row (a reset connection or a response lost on the
  // way back both throw here while the write succeeded). Without this the retry wrote a second
  // identical message: invisible live, since the client only renders the one response it finally
  // got, and plainly visible the moment you reload. SpaceDO dedupes on (session_id, this).
  const clientMessageId = crypto.randomUUID();
  const userMessage = await apiFetch<Message>(`/v1/spaces/${spaceId}/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ role: "user", content, client_message_id: clientMessageId }),
    session,
    ...(onRetry ? { onRetry } : {}),
  });
  // §A1.17 Phase Q: pass `goal` explicitly (the message just persisted above) — the backend
  // will still derive it from the session's latest user message if this is ever omitted, but
  // sending it directly avoids that extra round trip on every single message.
  const agentRun = await apiFetch<{ id?: string; run_id?: string; task_id?: string }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/run`,
    {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        goal: content,
        ...(modelOptions?.model ? { model: modelOptions.model } : {}),
        ...(modelOptions?.reasoningEffort ? { reasoning_effort: modelOptions.reasoningEffort } : {}),
        ...(modelOptions?.effort ? { effort: modelOptions.effort } : {}),
        ...(modelOptions?.agentDefinitionId ? { agent_definition_id: modelOptions.agentDefinitionId } : {}),
        ...(modelOptions?.projectId ? { project_id: modelOptions.projectId } : {}),
        ...(modelOptions?.uploadNames?.length ? { upload_names: modelOptions.uploadNames } : {}),
      }),
      session,
      ...(onRetry ? { onRetry } : {}),
    }
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
    if (session.sessionToken === "cookie") throw new Error("Stream authorization is temporarily unavailable");
    // Legacy fallback: raw session token in URL (logged but functional — used during local dev).
    const params = new URLSearchParams({ session_token: session.sessionToken, end_user_id: session.endUserId });
    return `${API_URL}/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}/stream?${params.toString()}`;
  }
}

/**
 * Is anything still running in this conversation?
 *
 * The in-flight run used to be tracked in sessionStorage, which is per-tab by construction — so
 * closing the tab meant the run carried on with nobody watching, and reopening showed a silent
 * transcript with no sign the agent was still working. The server knows, so ask it: this works
 * from a new tab, a different browser, or another device.
 *
 * Returns the steps and partial answer accumulated so far alongside the id, so the caller can
 * paint what it missed immediately and then continue live, rather than starting from blank.
 */
export async function getActiveRun(
  spaceId: string,
  sessionId: string,
  session: SessionCredentials
): Promise<{ active: boolean; run_id?: string; live_steps?: LiveRunStep[]; partial_answer?: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/sessions/${sessionId}/agent/active-run`, { session });
}

/**
 * Ask a run to stop.
 *
 * Cooperative, not a kill: the agent finishes whatever action it is inside and stops at the next
 * step boundary. Tearing it down mid-action would leave a side effect — an email, a payment, a
 * created project — in a state nobody could report on afterwards.
 */
export async function cancelRun(
  spaceId: string,
  sessionId: string,
  runId: string,
  session: SessionCredentials
): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}/cancel`, {
    method: "POST",
    session,
  });
}

/** Polling fallback for environments without SSE. `onRetry` — see sendMessage's own doc. */
export async function pollRun(
  spaceId: string,
  sessionId: string,
  runId: string,
  session: SessionCredentials,
  onRetry?: (attempt: number, max: number) => void
): Promise<AgentRun> {
  const res = await apiFetch<{ id: string; status: string; final_answer?: string; partial_answer?: string; error?: string; error_code?: string; live_steps?: LiveRunStep[]; pending_approval?: RunPendingApproval; pending_question?: RunPendingApproval; deferred_approvals?: RunPendingApproval[] }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}`,
    { session, ...(onRetry ? { onRetry } : {}) }
  );
  return {
    id: res.id,
    status: (res.status as AgentRun["status"]) ?? "running",
    ...(res.final_answer !== undefined ? { final_answer: res.final_answer } : {}),
    ...(res.partial_answer !== undefined ? { partial_answer: res.partial_answer } : {}),
    ...(res.error !== undefined ? { error: res.error } : {}),
    ...(res.error_code !== undefined ? { error_code: res.error_code } : {}),
    ...(res.live_steps ? { live_steps: res.live_steps } : {}),
    ...(res.pending_approval ? { pending_approval: res.pending_approval } : {}),
    ...(res.pending_question ? { pending_question: res.pending_question } : {}),
    ...(res.deferred_approvals?.length ? { deferred_approvals: res.deferred_approvals } : {}),
  };
}


// ── Approvals — the things an agent is waiting on you for ────────────────────
//
// A gated action opens a request and does NOT run; the agent parks it and carries on with the
// rest of the task. Until this existed there was no way to answer one from the product at all,
// so every parked action sat until it expired — the feature was real end to end except for the
// one step that needs a person.

export interface PendingApproval {
  id: string;
  run_id: string;
  session_id: string;
  tool_name: string;
  /** JSON string of the arguments the agent wants to run with — shown so a decision is informed. */
  tool_input: string;
  action_description: string;
  status: "pending" | "approved" | "rejected" | "timeout";
  reject_reason: string | null;
  created_at: string;
  expires_at: number;
  kind?: "approval" | "question";
  question?: string | null;
  options_json?: string | null;
  answer?: string | null;
}

/** Every open request in this space. The list is space-wide — the session in the path is only
 *  there because that's where the route lives. */
export async function listApprovals(spaceId: string, session: SessionCredentials): Promise<PendingApproval[]> {
  const res = await apiFetch<{ approvals: PendingApproval[] }>(
    `/v1/spaces/${spaceId}/sessions/inbox/approvals`,
    { session }
  );
  return (res.approvals ?? []).filter((a) => a.status === "pending");
}

/** An approval tagged with which business it belongs to — see listAllApprovals's own header for
 *  why this exists. */
export interface PendingApprovalWithBusiness extends PendingApproval {
  business_id: string;
  business_name: string;
}

/** Live-reported bug: approvals are per-space (HITLApprovalDO is addressed `hitl:{spaceId}`,
 *  one instance per business), but the sidebar badge and the Approvals page only ever checked
 *  `activeSpaceId` — whichever business the switcher happened to be pointed at. A gated action
 *  parked under Business A was completely invisible while looking at Business B: no badge, no
 *  entry in the Approvals list, nothing — reported live as "the agent said it's waiting for
 *  approval but there's nothing anywhere to approve." Fixed by checking every business the
 *  person belongs to, not just the one currently in view. A handful of businesses per end user
 *  is the normal case (unlike the platform-wide enumeration this codebase deliberately avoids
 *  elsewhere), so a small parallel fan-out here is the right trade, not a scale risk.
 *
 *  `productSpaceId` is included too (tagged with `business_name: "Assistant"`) since a "team"-mode
 *  product (no businesses concept) can itself have pending approvals at the root — and even on a
 *  business-first product, the assistant can still open one there before any business exists. */
export async function listAllApprovals(
  productSpaceId: string,
  productName: string,
  businesses: Business[],
  session: SessionCredentials
): Promise<PendingApprovalWithBusiness[]> {
  const targets = [
    { id: productSpaceId, name: productName },
    ...businesses.map((b) => ({ id: b.id, name: b.name })),
  ];
  const results = await Promise.allSettled(
    targets.map(async (t) => {
      const items = await listApprovals(t.id, session);
      return items.map((a) => ({ ...a, business_id: t.id, business_name: t.name }));
    })
  );
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

export async function approveAction(spaceId: string, approvalId: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/sessions/inbox/approvals/${approvalId}/approve`, { method: "PUT", session });
}

export async function rejectAction(
  spaceId: string,
  approvalId: string,
  reason: string,
  session: SessionCredentials
): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/sessions/inbox/approvals/${approvalId}/reject`, {
    method: "PUT",
    body: JSON.stringify({ reason }),
    session,
  });
}

/** What handleResumeRun's own continuation pass is called, once it's started — lets the chat
 *  surface attach to it via the SAME pollRun/streamRun machinery an ordinary run uses, instead of
 *  only learning the answer on reload with no activity trail. `resumed_run_id` is null until the
 *  continuation has actually begun (it's recorded the moment it's minted, ahead of it finishing). */
export async function getApprovalResumeStatus(
  spaceId: string,
  approvalId: string,
  session: SessionCredentials
): Promise<{ resumed_run_id: string | null; resume_status: string | null }> {
  const res = await apiFetch<{ resumed_run_id?: string | null; resume_status?: string | null }>(
    `/v1/spaces/${spaceId}/sessions/inbox/approvals/${approvalId}`,
    { session }
  );
  return { resumed_run_id: res.resumed_run_id ?? null, resume_status: res.resume_status ?? null };
}

// ── Notifications — what the assistant/its agents surface for a human to see ─
//
// Distinct from approvals: a notification doesn't necessarily need a decision (a run failed, a
// connector needs setup) — it just needs to be SEEN. Reading the list here does not mark
// anything read; call markNotificationRead explicitly (mirrors the approvals inbox's own
// explicit approve/reject, not an implicit "viewed it" side effect).

export interface AppNotification {
  id: string;
  space_id: string;
  project_id: string | null;
  kind: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  source_agent_id: string | null;
  related_id: string | null;
  status: "unread" | "read";
  read_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export async function listNotifications(
  spaceId: string,
  session: SessionCredentials,
  opts?: { status?: "unread" | "read"; limit?: number; projectId?: string | null | undefined }
): Promise<AppNotification[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.projectId) params.set("project_id", opts.projectId);
  params.set("limit", String(opts?.limit ?? 50));
  const res = await apiFetch<{ data: AppNotification[] }>(
    `/v1/spaces/${spaceId}/notifications?${params.toString()}`,
    { session }
  );
  return res.data ?? [];
}

export async function markNotificationRead(spaceId: string, notificationId: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/notifications`, {
    method: "POST",
    body: JSON.stringify({ action: "mark_read", notification_id: notificationId }),
    session,
  });
}

export interface BrowserPushConfig { enabled: boolean; publicKey?: string }
export async function getBrowserPushConfig(spaceId: string, session: SessionCredentials): Promise<BrowserPushConfig> {
  return apiFetch<BrowserPushConfig>(`/v1/spaces/${spaceId}/push-notifications`, { session });
}
export async function saveBrowserPushSubscription(spaceId: string, subscription: PushSubscriptionJSON, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/push-notifications`, {
    method: "PUT", body: JSON.stringify({ subscription }), session,
  });
}
export async function removeBrowserPushSubscription(spaceId: string, endpoint: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/push-notifications`, {
    method: "DELETE", body: JSON.stringify({ endpoint }), session,
  });
}

// ── Context-window usage (§A1.27) ────────────────────────────────────────────

export interface ContextUsageBreakdown {
  key: string;
  label: string;
  tokens: number;
  estimated: boolean;
}

export interface ContextUsage {
  current_tokens: number;
  estimation_method?: string;
  model: string;
  model_window: number;
  percent_full: number;
  /** Step 1: per-category breakdown for the Stats-tab segmented bar (conversation/overhead/free). */
  breakdown?: ContextUsageBreakdown[];
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
  last_activity_at?: string | null;
  // Generic project shape plus independently configured business features.
  kind?: string;
  external_channel_profile?: number | boolean;
  viewport_config?: { component?: string; resourceId?: string; canvasPrimary?: boolean; copilotPlacement?: string; mount?: string; tab?: string };
  execution_ceiling?: number;
  daily_spend_cap_credits?: number;
  channel_config?: Record<string, unknown>;
  visibility?: "public" | "private";
}

export async function listProjects(spaceId: string, session: SessionCredentials): Promise<Project[]> {
  const res = await apiFetch<{ data: Project[]; count: number }>(`/v1/spaces/${spaceId}/projects`, { session });
  return res.data;
}

export interface ProjectDepartment {
  id: string;
  name: string;
  status: string;
  created_at: string;
  is_primary: number;
}

export interface DepartmentOption {
  id: string;
  parent_id: string | null;
  name: string;
  status: string;
  depth: number;
}

export async function listDepartments(spaceId: string, session: SessionCredentials): Promise<DepartmentOption[]> {
  const result = await apiFetch<{ data: DepartmentOption[] }>(`/v1/spaces/${encodeURIComponent(spaceId)}/sub-spaces`, { session, cache: "no-store" });
  return result.data;
}

export async function createDepartment(spaceId: string, name: string, session: SessionCredentials): Promise<DepartmentOption> {
  return apiFetch<DepartmentOption>(`/v1/spaces/${encodeURIComponent(spaceId)}/sub-spaces`, {
    method: "POST", body: JSON.stringify({ name }), session,
  });
}

export async function listProjectDepartments(spaceId: string, projectId: string, session: SessionCredentials): Promise<ProjectDepartment[]> {
  const result = await apiFetch<{ data: ProjectDepartment[] }>(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/sub-spaces`, { session, cache: "no-store" });
  return result.data;
}

export async function listDepartmentProjects(spaceId: string, departmentId: string, session: SessionCredentials): Promise<Project[]> {
  const result = await apiFetch<{ data: Project[]; count: number }>(`/v1/spaces/${encodeURIComponent(spaceId)}/sub-spaces/${encodeURIComponent(departmentId)}/projects`, { session, cache: "no-store" });
  return result.data;
}

export async function associateProjectDepartment(spaceId: string, projectId: string, departmentId: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/sub-spaces`, {
    method: "POST", body: JSON.stringify({ subspace_id: departmentId }), session,
  });
}

export async function detachProjectDepartment(spaceId: string, projectId: string, departmentId: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/sub-spaces/${encodeURIComponent(departmentId)}`, { method: "DELETE", session });
}

/** kind, when given, creates a Business Feature project (Wallet, CRM, Business Email, …) instead
 *  of a plain workspace project — SpaceDO validates it against BUSINESS_FEATURE_KIND_REGISTRY and
 *  role-gates/singleton-gates it server-side; a rejection here is real, not just UI-hidden. */
export async function createProject(
  spaceId: string,
  session: SessionCredentials,
  name: string,
  description?: string,
  kind?: string
): Promise<Project> {
  return apiFetch(`/v1/spaces/${spaceId}/projects`, {
    method: "POST",
    body: JSON.stringify({ name, ...(description ? { description } : {}), ...(kind ? { kind } : {}) }),
    session,
  });
}

// ── Plugins directory (BUSINESS_FEATURE_KIND_REGISTRY, browsable+role-filtered) ────────────────

export interface FeatureKind {
  kind: string;
  label: string;
  description: string;
  singleton: boolean;
  minCreationRole: "owner" | "admin" | "editor";
  autoProvisionable: boolean;
  uiPanel?: string;
}

export async function getFeatureKinds(spaceId: string, session: SessionCredentials): Promise<FeatureKind[]> {
  const res = await apiFetch<{ feature_kinds: FeatureKind[] }>(`/v1/spaces/${spaceId}/feature-kinds`, { session });
  return res.feature_kinds;
}

/** One call, fully configured — the project row (kind, execution ceiling, spend cap, agent
 *  binding) plus its starter rules/scheduled jobs, from any entry in the manifest's
 *  `project_template_catalog`. The same mechanism a business's own onboarding already uses. */
export async function createProjectFromTemplate(
  spaceId: string,
  session: SessionCredentials,
  templateId: string,
  name?: string
): Promise<{ project_id: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/projects/from-template`, {
    method: "POST",
    body: JSON.stringify({ template_id: templateId, ...(name ? { name } : {}) }),
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
    kind: string;
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

// ── Business-wide BYOK LLM keys (step 28) ────────────────────────────────────

/** Which BYOK providers this business has a key configured for. Never carries the key value. */
export interface ByokProviderStatus {
  provider: string;
  configured: boolean;
  active_key_id?: string | null;
  keys: ByokKeyMetadata[];
}

/** Submit the answer to a planner questionnaire and resume the suspended run. */
export async function answerQuestion(
  spaceId: string,
  questionId: string,
  answer: string,
  session: SessionCredentials
): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/sessions/inbox/approvals/${questionId}/answer`, {
    method: "PUT",
    body: JSON.stringify({ answer }),
    session,
  });
}

export interface ByokKeyMetadata {
  id: string;
  label: string;
  created_at?: string;
  active: boolean;
}

export interface OpenRouterModelCandidate {
  id: string;
  model: string;
  name: string;
  contextLength?: number;
  promptPriceUsdPerToken?: number;
  completionPriceUsdPerToken?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  supportedParameters?: string[];
}

export interface OpenRouterModelRecommendation {
  category: "general_text" | "vision_input" | "long_context" | "lower_published_cost";
  label: string;
  candidates: OpenRouterModelCandidate[];
  evidence: string;
}

export interface DomainGlossaryEntry { term: string; meaning: string; locale: string; notes?: string }
export async function getDomainGlossary(spaceId: string, session: SessionCredentials): Promise<DomainGlossaryEntry[]> {
  const result = await apiFetch<{ entries: DomainGlossaryEntry[] }>(`/v1/spaces/${encodeURIComponent(spaceId)}/domain-glossary`, { session });
  return result.entries;
}
export async function putDomainGlossary(spaceId: string, session: SessionCredentials, entry: DomainGlossaryEntry): Promise<void> {
  await apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/domain-glossary`, { method: "POST", session, body: JSON.stringify(entry) });
}
export async function deleteDomainGlossary(spaceId: string, session: SessionCredentials, term: string, locale: string): Promise<void> {
  await apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/domain-glossary?term=${encodeURIComponent(term)}&locale=${encodeURIComponent(locale)}`, { method: "DELETE", session });
}

/** GET /v1/spaces/:spaceId/llm-byok — which providers are wired (member+). */
export async function getByokStatus(spaceId: string, session: SessionCredentials): Promise<ByokProviderStatus[]> {
  const res = await apiFetch<{ providers: ByokProviderStatus[] }>(`/v1/spaces/${spaceId}/llm-byok`, { session });
  return res.providers;
}

/** Fetch the public OpenRouter model catalog after the selected Space key is validated. Catalog
 * membership is not a promise that the key can invoke a particular model. */
export async function getOpenRouterModels(spaceId: string, session: SessionCredentials): Promise<{
  configured: boolean; key_validated?: boolean; availability_note?: string; active_model?: string | null; models: OpenRouterModelCandidate[]; recommendations?: OpenRouterModelRecommendation[];
}> {
  return apiFetch(`/v1/spaces/${spaceId}/llm-byok/models`, { session });
}

/** Owner-confirmed activation runs a fixed one-token preflight with the selected Space BYOK key
 * before changing the active model. */
export async function activateOpenRouterModel(spaceId: string, session: SessionCredentials, model: string): Promise<{ model: string; activated: boolean }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/llm-byok/models/activate`, {
    method: "POST", session, body: JSON.stringify({ model, preflight_confirmed: true }),
  });
}

/** PUT — store a business's own provider key (admin). The key is vaulted, never returned again. */
export async function setByokKey(
  spaceId: string,
  session: SessionCredentials,
  provider: string,
  key: string,
  label?: string,
): Promise<ByokKeyMetadata> {
  return apiFetch<ByokKeyMetadata>(`/v1/spaces/${spaceId}/llm-byok`, {
    method: "PUT",
    body: JSON.stringify({ provider, key, ...(label?.trim() ? { label: label.trim() } : {}) }),
    session,
  });
}

/** POST — make one of several stored keys for a provider the active key (admin). */
export async function selectByokKey(
  spaceId: string,
  session: SessionCredentials,
  provider: string,
  keyId: string,
): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/llm-byok/select`, {
    method: "POST",
    body: JSON.stringify({ provider, key_id: keyId }),
    session,
  });
}

/** POST — remove one stored key (admin). */
export async function deleteByokKey(
  spaceId: string,
  session: SessionCredentials,
  provider: string,
  keyId?: string,
): Promise<void> {
  if (keyId) {
    await apiFetch(`/v1/spaces/${spaceId}/llm-byok/remove`, {
      method: "POST",
      body: JSON.stringify({ provider, key_id: keyId }),
      session,
    });
    return;
  }
  // Compatibility for callers that still remove the single legacy provider key.
  await apiFetch(`/v1/spaces/${spaceId}/llm-byok/${provider}`, { method: "DELETE", session });
}

// ── Customer-bot no-code automation rules (step 21) ──────────────────────────

/** A no-code "after the customer says X, this happens" rule on a customer_bot project. Checked
 *  deterministically before the reasoning loop ever runs — cheap, admin-authored. */
export interface ProjectRule {
  id: string;
  project_id: string;
  trigger_pattern: string;
  action: "reply" | "run_script" | "human_takeover";
  reply_text?: string | null;
  script_name?: string | null;
  enabled?: number;
  priority?: number;
  created_at: string;
}

/** GET /v1/spaces/:spaceId/projects/:projectId/rules — the customer bot's automation rules
 *  (business member+). */
export async function getProjectRules(
  spaceId: string,
  projectId: string,
  session: SessionCredentials,
): Promise<ProjectRule[]> {
  const res = await apiFetch<{ rules: ProjectRule[] } | { data: ProjectRule[] } | ProjectRule[]>(
    `/v1/spaces/${spaceId}/projects/${projectId}/rules`,
    { session },
  );
  // The DO returns { rules: [...] }; tolerate a bare array or { data } too.
  if (Array.isArray(res)) return res;
  if ("rules" in res) return res.rules;
  return res.data;
}

/** POST — create a rule (business admin). */
export async function createProjectRule(
  spaceId: string,
  projectId: string,
  session: SessionCredentials,
  rule: {
    trigger_pattern: string;
    action: "reply" | "run_script" | "human_takeover";
    reply_text?: string;
    script_name?: string;
    priority?: number;
  },
): Promise<ProjectRule> {
  return apiFetch(`/v1/spaces/${spaceId}/projects/${projectId}/rules`, {
    method: "POST",
    body: JSON.stringify(rule),
    session,
  });
}

/** DELETE — remove a rule (business admin). */
export async function deleteProjectRule(
  spaceId: string,
  projectId: string,
  ruleId: string,
  session: SessionCredentials,
): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/projects/${projectId}/rules/${ruleId}`, {
    method: "DELETE",
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
  thread_tier?: "tier_1_team" | "tier_2_task" | "tier_3_consult" | "tier_4_scratchpad";
  created_by?: string | null;
  system_internal?: number | boolean;
  parent_thread_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function listThreads(
  spaceId: string,
  session: SessionCredentials,
  opts: { projectId?: string; includeSubThreads?: boolean } = {}
): Promise<ThreadSummary[]> {
  const params = new URLSearchParams();
  if (opts.projectId) params.set("project_id", opts.projectId);
  if (opts.includeSubThreads) params.set("include_sub_threads", "true");
  const qs = params.size ? `?${params.toString()}` : "";
  const res = await apiFetch<{ data: ThreadSummary[]; count: number }>(`/v1/spaces/${spaceId}/threads${qs}`, { session });
  return res.data;
}

// A project thread's own private assistant<->agent consult subthreads (§A1.18 thread model) —
// hidden from the default project thread list, fetched explicitly here for the collapsed
// "Assistant" panel on that thread's own page. Always answered in full regardless of the
// project's show_sub_threads default (SpaceDO honors an explicit parent_thread_id ask).
export async function listSubthreads(spaceId: string, parentThreadId: string, session: SessionCredentials): Promise<ThreadSummary[]> {
  const res = await apiFetch<{ data: ThreadSummary[]; count: number }>(
    `/v1/spaces/${spaceId}/threads?parent_thread_id=${encodeURIComponent(parentThreadId)}`,
    { session }
  );
  return res.data;
}

export async function createThread(
  spaceId: string,
  session: SessionCredentials,
  opts: { title?: string; project_id?: string; thread_tier?: "tier_1_team" | "tier_2_task" | "tier_3_consult" | "tier_4_scratchpad" } = {}
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

export interface AgentTemplateSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  prebuilt_scripts: string[];
  approval_mode: string;
}

/** The browsable Naelao Agent Templates catalogue — real, distinct configurations (tool list,
 *  autonomy default, vertical instructions), not a cosmetic label on the same generic agent. */
export async function listAgentTemplates(spaceId: string, session: SessionCredentials): Promise<AgentTemplateSummary[]> {
  const res = await apiFetch<{ templates: AgentTemplateSummary[] }>(`/v1/spaces/${spaceId}/agent-templates`, { session });
  return res.templates ?? [];
}

/** Instantiate a template as a real agent_definition — writes its own config, seeds its own
 *  approval policy, and (when project_id is given) binds it into that project's
 *  allowed_agent_ids so it shows up in the project's own agent switcher immediately. */
export async function instantiateAgentTemplate(
  spaceId: string,
  session: SessionCredentials,
  params: { template_id: string; name?: string; project_id?: string }
): Promise<{ agent_id: string; agent_definition_id: string; template_id: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/agent-templates`, { method: "POST", body: JSON.stringify(params), session });
}

/** Step 17: create a fully custom agent — its own instructions, tool (prebuilt-script) list, and
 *  autonomy. Goes through the same /agent-templates route with a `custom` payload. */
export async function createCustomAgent(
  spaceId: string,
  session: SessionCredentials,
  custom: {
    name: string; description?: string; instructions: string;
    prebuilt_scripts: string[]; approval_mode?: "always_ask" | "gate_unless_listed" | "yolo";
    auto_approved_actions?: string[]; project_id?: string;
    skills?: string[]; connectors?: string[];
    // AVOS plan step 5 — optional capability-firewall archetype. Omitted = unrestricted (the
    // prebuilt_scripts list above is used verbatim, unchanged legacy behavior).
    archetype?: string;
  }
): Promise<{ agent_id: string; agent_definition_id: string; custom: boolean; rejected_scripts?: string[] }> {
  return apiFetch(`/v1/spaces/${spaceId}/agent-templates`, { method: "POST", body: JSON.stringify({ custom }), session });
}

export interface FoundryTemplateDefinition {
  expertise: string; audience: string; outcome: string; workflow: string; safetyLimits: string; instructions: string;
  sourceReferences: string[]; toolAllowlist: string[]; runtimeDependencies?: string[];
  calibrationExamples?: Array<{ input: string; desiredOutcome: string }>;
  approvalMode?: "always_ask";
}
export interface FoundryTemplate {
  id: string; space_id: string; created_by: string; name: string; description: string; status: "draft" | "in_review" | "published" | "rejected";
  version: number; validated_version: number; validation_json: string; reviewed_by: string | null; review_note: string | null; created_at: string; updated_at: string; published_at: string | null;
  definition: FoundryTemplateDefinition;
}
export interface FoundryFeatureRequest {
  id: string; space_id: string; requested_by: string; title: string; problem: string; workflow: string; evidence: string[];
  status: "open" | "accepted" | "declined" | "delivered"; reviewed_by: string | null; review_note: string | null; created_at: string; updated_at: string;
}
export interface CrossSpaceGrant {
  id: string; grantee_space_id: string; target_space_id: string; resource_id: string; granted_by: string; created_at: string;
  expires_at: string; revoked_at: string | null;
}
export interface RuntimeCatalogueEntry {
  id: string; name: string; description: string; category: string; available: boolean;
  image?: string; exported_binaries?: string[];
  install_manifest?: { id?: string; containers?: Array<{ id: string; image: string; resources: { memoryMb: number; cpuCores: number; timeoutSeconds: number }; networkPolicy?: string }> };
}
export async function listRuntimeCatalogue(spaceId: string, session: SessionCredentials) {
  return apiFetch<{ images: RuntimeCatalogueEntry[] }>(`/v1/spaces/${encodeURIComponent(spaceId)}/runtime-catalog`, { session });
}
export interface ContainerInstallation {
  instance: { instance_id?: string; extension_id: string; instance_key?: string; project_id: string | null; scope: string; status: string; installed_at: string };
  manifest: { id?: string; name?: string; containers?: Array<{ id?: string }>; bundle?: { version?: string; primitives?: Array<{ kind?: string; id?: string }> } };
}
export async function listContainerInstallations(spaceId: string, session: SessionCredentials, projectId?: string) {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return apiFetch<{ installations: ContainerInstallation[] }>(`/v1/spaces/${encodeURIComponent(spaceId)}/container-installations${query}`, { session });
}
export async function installRuntime(spaceId: string, session: SessionCredentials, imageId: string, options: {
  scope?: "SPACE_SHARED" | "SPACE_ASSISTANT" | "PROJECT_SHARED"; projectId?: string; promoteExisting?: boolean; acknowledgePromotion?: boolean; acknowledgeIsolation?: boolean;
} = {}) {
  return apiFetch<{ installed?: boolean; manifest?: unknown; installedAt?: string; installationId?: string; status?: "promotion_confirmation_required" | "already_available_space_shared" | "already_available_assistant"; existing_project_ids?: string[]; warning?: string; scope?: string }>(
    `/v1/spaces/${encodeURIComponent(spaceId)}/runtime-installations`,
    { method: "POST", body: JSON.stringify({ image_id: imageId, scope: options.scope ?? "SPACE_SHARED", ...(options.projectId ? { project_id: options.projectId } : {}),
      ...(options.promoteExisting ? { promote_existing: true, acknowledge_promotion: options.acknowledgePromotion === true } : {}),
      ...(options.acknowledgeIsolation ? { acknowledge_isolation: true } : {}), acknowledge_permissions: true }), session });
}
export async function listFoundryTemplates(spaceId: string, session: SessionCredentials) {
  const result = await apiFetch<{ data: FoundryTemplate[] }>(`/v1/spaces/${spaceId}/foundry/templates`, { session }); return result.data;
}
export async function createFoundryTemplate(spaceId: string, session: SessionCredentials, input: { name: string; description: string; definition: FoundryTemplateDefinition }) {
  return apiFetch<{ id: string; status: string; version: number }>(`/v1/spaces/${spaceId}/foundry/templates`, { method: "POST", body: JSON.stringify(input), session });
}
export async function updateFoundryTemplate(spaceId: string, templateId: string, session: SessionCredentials, input: { name: string; description: string; definition: FoundryTemplateDefinition }) {
  return apiFetch<{ id: string; status: string; version: number }>(`/v1/spaces/${spaceId}/foundry/templates/${encodeURIComponent(templateId)}`, { method: "PUT", body: JSON.stringify(input), session });
}
export async function testFoundryTemplate(spaceId: string, templateId: string, session: SessionCredentials) {
  return apiFetch<{ id: string; kind: string; passed: boolean; checks: Array<{ id: string; passed: boolean }>; tested_version: number }>(`/v1/spaces/${spaceId}/foundry/templates/${encodeURIComponent(templateId)}/test`, { method: "POST", body: "{}", session });
}
export async function transitionFoundryTemplate(spaceId: string, templateId: string, session: SessionCredentials, input: { action: "submit" | "review"; decision?: "publish" | "reject"; review_note?: string }) {
  const path = input.action === "submit" ? `/foundry/templates/${encodeURIComponent(templateId)}/submit` : `/foundry/templates/${encodeURIComponent(templateId)}/review`;
  return apiFetch(`/v1/spaces/${spaceId}${path}`, { method: "POST", body: JSON.stringify(input), session });
}
export async function listFoundryRequests(spaceId: string, session: SessionCredentials) {
  const result = await apiFetch<{ data: FoundryFeatureRequest[] }>(`/v1/spaces/${spaceId}/foundry/requests`, { session }); return result.data;
}
export async function createFoundryRequest(spaceId: string, session: SessionCredentials, input: { title: string; problem: string; workflow: string; evidence?: string[] }) {
  return apiFetch<{ id: string; status: string }>(`/v1/spaces/${spaceId}/foundry/requests`, { method: "POST", body: JSON.stringify(input), session });
}
export async function forwardFoundryRequest(targetSpaceId: string, session: SessionCredentials, input: { from_space_id: string; capability_token: string; title: string; problem: string; workflow: string }) {
  return apiFetch<{ id: string; status: string }>(`/v1/spaces/${targetSpaceId}/foundry/forward-request`, { method: "POST", body: JSON.stringify(input), session });
}
export async function reviewFoundryRequest(spaceId: string, requestId: string, session: SessionCredentials, input: { status: "accepted" | "declined" | "delivered"; review_note?: string }) {
  return apiFetch(`/v1/spaces/${spaceId}/foundry/requests/${encodeURIComponent(requestId)}`, { method: "PATCH", body: JSON.stringify(input), session });
}
export async function createCrossSpaceGrant(spaceId: string, session: SessionCredentials, input: { grantee_space_id: string; resource_id: string; expires_at: string; permissions?: Array<"read" | "invoke"> }) {
  return apiFetch<{ id: string; capability_token: string; resource_id: string; permissions: string[] }>(`/v1/spaces/${spaceId}/cross-space-grants`, { method: "POST", body: JSON.stringify({ ...input, target_space_id: spaceId }), session });
}
export async function listCrossSpaceGrants(spaceId: string, session: SessionCredentials) {
  const result = await apiFetch<{ data: CrossSpaceGrant[] }>(`/v1/spaces/${spaceId}/cross-space-grants`, { session }); return result.data;
}
export async function revokeCrossSpaceGrant(spaceId: string, grantId: string, session: SessionCredentials) {
  return apiFetch(`/v1/spaces/${spaceId}/cross-space-grants/${encodeURIComponent(grantId)}`, { method: "DELETE", session });
}
export async function acceptFoundryDocumentGrant(spaceId: string, session: SessionCredentials, input: { source_space_id: string; document_id: string; capability_token: string }) {
  return apiFetch<{ accepted: boolean; id: string; expires_at: string }>(`/v1/spaces/${spaceId}/foundry/accept-document`, { method: "POST", body: JSON.stringify(input), session });
}
export async function revokeFoundryDocumentGrant(spaceId: string, session: SessionCredentials, input: { source_space_id: string; document_id: string }) {
  const query = new URLSearchParams(input);
  return apiFetch(`/v1/spaces/${spaceId}/foundry/accept-document?${query}`, { method: "DELETE", session });
}
export async function acceptFoundryWorkerGrant(spaceId: string, session: SessionCredentials, input: { source_space_id: string; agent_id: string; capability_token: string }) {
  return apiFetch<{ accepted: boolean; id: string; expires_at: string }>(`/v1/spaces/${spaceId}/foundry/accept-worker`, { method: "POST", body: JSON.stringify(input), session });
}
export async function revokeFoundryWorkerGrant(spaceId: string, session: SessionCredentials, input: { source_space_id: string; agent_id: string }) {
  const query = new URLSearchParams(input);
  return apiFetch(`/v1/spaces/${spaceId}/foundry/accept-worker?${query}`, { method: "DELETE", session });
}
export async function installFoundryTemplate(spaceId: string, session: SessionCredentials, input: { source_space_id: string; template_id: string; capability_token: string; name?: string; project_id?: string }) {
  return apiFetch<{ agent_id?: string; agent_definition_id?: string; custom?: boolean }>(`/v1/spaces/${spaceId}/foundry/install-template`, { method: "POST", body: JSON.stringify(input), session });
}
export async function invokeSharedWorker(spaceId: string, session: SessionCredentials, input: { source_space_id: string; agent_id: string; capability_token: string; goal: string }) {
  return apiFetch<{ result?: unknown; output?: unknown; error?: string; status?: string }>(`/v1/spaces/${spaceId}/foundry/invoke-worker`, { method: "POST", body: JSON.stringify(input), session });
}

/** AVOS plan step 5 — the capability-firewall archetype presets a custom agent can opt into. */
export interface ArchetypePreset {
  role: string;
  label: string;
  description: string;
  allowedScripts: string[];
}
export async function listArchetypes(spaceId: string, session: SessionCredentials): Promise<ArchetypePreset[]> {
  const res = await apiFetch<{ archetypes: ArchetypePreset[] }>(`/v1/spaces/${spaceId}/archetypes`, { session });
  return res.archetypes ?? [];
}

/** A single project agent's own approval-policy override — falls back to the space-wide
 *  assistant_policy row (getAssistantPolicy) when the agent has no override of its own. GET is
 *  member-level, PATCH is business-admin-only (requireBusinessMembership on the spaces worker). */
export interface AgentPolicy {
  approval_mode: "always_ask" | "yolo";
  auto_approved_actions: string[];
}

export async function getAgentPolicy(spaceId: string, agentId: string, session: SessionCredentials): Promise<AgentPolicy> {
  return apiFetch(`/v1/spaces/${spaceId}/agents/${encodeURIComponent(agentId)}/policy`, { session });
}

export async function updateAgentPolicy(
  spaceId: string,
  agentId: string,
  session: SessionCredentials,
  patch: Partial<AgentPolicy>
): Promise<AgentPolicy> {
  return apiFetch(`/v1/spaces/${spaceId}/agents/${encodeURIComponent(agentId)}/policy`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    session,
  });
}

// ── Space Assistant surface (WS-2) — read-only panels, all pure consumers of existing backends ──

export interface AssistantPolicy {
  approval_mode: "always_ask" | "gate_unless_listed" | "gate_listed" | "yolo";
  auto_approved_actions: string[];
}

export async function getAssistantPolicy(spaceId: string, session: SessionCredentials): Promise<AssistantPolicy> {
  return apiFetch(`/v1/spaces/${spaceId}/assistant-policy`, { session });
}

export async function getAttachmentOcrSettings(spaceId: string, session: SessionCredentials): Promise<{ enabled: boolean }> {
  return apiFetch(`/v1/spaces/${spaceId}/assistant/attachment-ocr`, { session });
}

export async function updateAttachmentOcrSettings(spaceId: string, session: SessionCredentials, enabled: boolean): Promise<{ enabled: boolean }> {
  return apiFetch(`/v1/spaces/${spaceId}/assistant/attachment-ocr`, { method: "PATCH", body: JSON.stringify({ enabled }), session });
}

// item 79: a business admin can now change their OWN business's guided/autonomous policy — this
// was previously a builder-dashboard-only write (the route 403'd every product_end_user caller
// outright). Not exposed for a plain member — the caller composing the request enforces that in
// the UI, and requireBusinessMembership enforces it for real on the backend either way.
export async function updateAssistantPolicy(
  spaceId: string,
  session: SessionCredentials,
  patch: Partial<AssistantPolicy>
): Promise<AssistantPolicy> {
  return apiFetch(`/v1/spaces/${spaceId}/assistant-policy`, { method: "PATCH", body: JSON.stringify(patch), session });
}

// item 79: which model this business's assistant/agents run on — a business-scoped counterpart
// to the dashboard's own product-level model picker (Configuration tab), reachable by whoever
// actually owns the business rather than only the platform builder account.
export async function updateModelConfig(
  spaceId: string,
  session: SessionCredentials,
  model: string,
  effort?: string
): Promise<{ model: string; effort?: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/model-config`, {
    method: "PATCH",
    body: JSON.stringify({ model, ...(effort ? { effort } : {}) }),
    session,
  });
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
  script_name?: string;
  goal?: string | null;
  params?: string;
  enabled: number;
  last_run_at: string | null;
  consecutive_failures: number;
  last_error?: string | null;
  project_id?: string | null;
  agent_id?: string | null;
  created_at?: string;
  updated_at?: string;
  /** Phase 3 item 27/28 — computed fresh on every read, never stored. Null for a disabled job. */
  next_run_at: number | null;
}

/** Scope jobs to one readable project, to the assistant-only legacy scope, or to the caller's
 *  visible project set. The backend resolves visibility before returning schedule metadata. */
export async function listScheduledJobs(
  spaceId: string,
  session: SessionCredentials,
  scope?: { projectId: string | null; visibleProjects?: boolean }
): Promise<ScheduledJob[]> {
  const qs = scope?.visibleProjects
    ? "?scope=visible-projects"
    : scope ? (scope.projectId ? `?project_id=${encodeURIComponent(scope.projectId)}` : "?scope=assistant") : "";
  const res = await apiFetch<{ data: ScheduledJob[] }>(`/v1/spaces/${spaceId}/scheduled-jobs${qs}`, { session });
  return res.data;
}

// Phase 3 item 27/28 — the backend CRUD routes (POST/PATCH/DELETE
// /spaces/:spaceId/scheduled-jobs[/:jobId]) have existed since scheduled jobs shipped; only a
// read wrapper existed here, so the Crons panel could show a job but never create, edit, or
// remove one.
export async function createScheduledJob(
  spaceId: string,
  session: SessionCredentials,
  input: {
    name: string;
    cron_expression: string;
    script_name?: string;
    goal?: string;
    params?: Record<string, unknown>;
    project_id?: string;
    agent_id?: string;
  }
): Promise<ScheduledJob> {
  return apiFetch(`/v1/spaces/${spaceId}/scheduled-jobs`, { method: "POST", body: JSON.stringify(input), session });
}

export async function updateScheduledJob(
  spaceId: string,
  jobId: string,
  session: SessionCredentials,
  patch: Partial<{
    name: string;
    cron_expression: string;
    script_name: string;
    goal: string;
    params: Record<string, unknown>;
    agent_id: string;
    enabled: boolean;
  }>
): Promise<{ id: string; updated_at: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/scheduled-jobs/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    session,
  });
}

/** A dedicated enable/disable helper — the common case, without needing to remember the shape
 *  of a full PATCH body just to flip one field. */
export async function toggleScheduledJob(
  spaceId: string,
  jobId: string,
  session: SessionCredentials,
  enabled: boolean
): Promise<{ id: string; updated_at: string }> {
  return updateScheduledJob(spaceId, jobId, session, { enabled });
}

export async function deleteScheduledJob(spaceId: string, jobId: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/scheduled-jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", session });
}

export interface ScheduledJobRun {
  id: string;
  fired_at: number;
  ok: number;
  error: string | null;
  duration_ms: number | null;
  skipped_busy: number;
}

/** Recent fires for one job (migration 0071), newest first. */
export async function listScheduledJobRuns(
  spaceId: string,
  jobId: string,
  session: SessionCredentials,
  limit = 20
): Promise<ScheduledJobRun[]> {
  const res = await apiFetch<{ data: ScheduledJobRun[] }>(
    `/v1/spaces/${spaceId}/scheduled-job-runs?job_id=${encodeURIComponent(jobId)}&limit=${limit}`,
    { session }
  );
  return res.data;
}

export interface ChannelLink {
  channel: string;
  enabled: number;
  created_at: string;
  project_id?: string | null;
  model_override?: string | null;
  extension_instance_id?: string | null;
}

/** Same scoping convention as listScheduledJobs. */
export async function listAssistantChannels(
  spaceId: string,
  session: SessionCredentials,
  scope?: { projectId: string | null }
): Promise<ChannelLink[]> {
  const qs = scope ? (scope.projectId ? `?project_id=${encodeURIComponent(scope.projectId)}` : "?scope=assistant") : "";
  const res = await apiFetch<{ data: ChannelLink[] }>(`/v1/spaces/${spaceId}/assistant/channels${qs}`, { session });
  return res.data;
}

export interface ChannelConnectResult {
  connected?: boolean;
  channel: string;
  enabled?: boolean;
  /** Paste this into the provider's own dashboard — connecting on our side isn't enough on its
   *  own for messages to actually arrive. */
  webhook_url?: string;
}

export interface ChannelExtensionInstallation {
  instance_id: string;
  extension_id: string;
  scope: "PROJECT_BOUND" | "PROJECT_SHARED";
  name: string;
  version?: string;
  channels: Array<{ id: string; provider: string; handlerScript: string; connection_id?: string; session?: { enabled: true; max_bytes: number; ttl_days: number } }>;
  connections?: Array<{ id: string; provider: string; purpose: string; required: boolean }>;
}

export interface ExtensionRelease { version: string; artifactSha256: string; hostSignature: string; signatureValid: boolean; createdAt: string }

export async function listProjectExtensionReleases(spaceId: string, projectId: string, extensionId: string, session: SessionCredentials): Promise<ExtensionRelease[]> {
  const result = await apiFetch<{ releases: ExtensionRelease[] }>(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/extensions/${encodeURIComponent(extensionId)}/releases`, { session });
  return result.releases;
}

export async function rollbackProjectExtension(spaceId: string, projectId: string, extensionId: string, version: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/extension-releases/rollback`, { method: "POST", body: JSON.stringify({ project_id: projectId, extension_id: extensionId, version }), session });
}

export interface ChannelExtensionSessionSummary {
  activeConversations: number;
  storedBytes: number;
  nextExpiryAt: number | null;
}

export interface ChannelExtensionInboxEvent {
  event_id: string;
  channel: string;
  human_takeover: boolean;
  text: string;
  status: "queued" | "processing" | "running" | "delivering" | "sent" | "uncertain" | "failed";
  error_code: string | null;
  reply_text: string | null;
  human_reply_text?: string | null;
  human_reply_status?: "delivering" | "sent" | "uncertain" | null;
  created_at: number;
}

export interface ChannelExtensionInboxPage {
  events: ChannelExtensionInboxEvent[];
  next_before: number | null;
  next_before_id: string | null;
}

export async function listChannelExtensionInbox(spaceId: string, projectId: string, instanceId: string, session: SessionCredentials, cursor?: { before: number; beforeId: string }): Promise<ChannelExtensionInboxPage> {
  const query = cursor ? `?${new URLSearchParams({ before: String(cursor.before), before_id: cursor.beforeId })}` : "";
  return apiFetch<ChannelExtensionInboxPage>(
    `/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/channel-extensions/${encodeURIComponent(instanceId)}/inbox${query}`, { session }
  );
}

export async function takeOverChannelExtensionInboxEvent(spaceId: string, projectId: string, instanceId: string, eventId: string, session: SessionCredentials): Promise<{ human_takeover: true; paused_pending_reply: boolean }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/channel-extensions/${encodeURIComponent(instanceId)}/inbox/takeover`, {
    method: "POST", session, body: JSON.stringify({ event_id: eventId }),
  });
}

export async function deleteChannelExtensionConversation(spaceId: string, projectId: string, instanceId: string, eventId: string, session: SessionCredentials): Promise<{ deleted: true }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/channel-extensions/${encodeURIComponent(instanceId)}/inbox/delete-conversation`, {
    method: "POST", session, body: JSON.stringify({ event_id: eventId }),
  });
}

export async function replyToChannelExtensionEvent(spaceId: string, projectId: string, instanceId: string, eventId: string, text: string, session: SessionCredentials): Promise<{ status: "sent" | "uncertain" }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/channel-extensions/${encodeURIComponent(instanceId)}/inbox/reply`, {
    method: "POST", session, body: JSON.stringify({ event_id: eventId, text }),
  });
}

export async function exportChannelExtensionConversation(spaceId: string, projectId: string, instanceId: string, eventId: string, session: SessionCredentials): Promise<{ schema_version: number; channel: string; events: Array<{ direction: string; text: string; created_at: number; replies: Array<{ text: string; by: string; status: string | null; created_at: number | null }> }> }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/channel-extensions/${encodeURIComponent(instanceId)}/inbox/export?${new URLSearchParams({ event_id: eventId })}`, { session });
}

export async function getChannelExtensionSessionSummary(spaceId: string, projectId: string, instanceId: string, session: SessionCredentials): Promise<ChannelExtensionSessionSummary> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/channel-extensions/${encodeURIComponent(instanceId)}/session-state`, { session });
}

export async function clearChannelExtensionSessionState(spaceId: string, projectId: string, instanceId: string, session: SessionCredentials): Promise<{ deletedConversations: number }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/channel-extensions/${encodeURIComponent(instanceId)}/session-state`, { method: "DELETE", session });
}

export async function removeChannelExtension(spaceId: string, projectId: string, instanceId: string, session: SessionCredentials): Promise<{ removed: boolean }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/channel-extensions/${encodeURIComponent(instanceId)}`, { method: "DELETE", session });
}

export async function listChannelExtensionInstallations(
  spaceId: string,
  projectId: string,
  session: SessionCredentials
): Promise<ChannelExtensionInstallation[]> {
  const response = await apiFetch<{ installations: ChannelExtensionInstallation[] }>(
    `/v1/spaces/${spaceId}/assistant/channel-extensions?project_id=${encodeURIComponent(projectId)}`,
    { session }
  );
  return response.installations;
}

export async function installProjectChannelExtension(
  spaceId: string,
  projectId: string,
  session: SessionCredentials,
  manifest: unknown,
  scope: "PROJECT_BOUND" | "PROJECT_SHARED" = "PROJECT_BOUND",
  handlerSources?: Record<string, string>,
  upgrade = false
): Promise<{ installed?: boolean; installationId?: string; error_code?: string; message?: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/projects/${encodeURIComponent(projectId)}/channel-extensions`, {
    method: "POST", body: JSON.stringify({ manifest, scope, ...(handlerSources ? { handlerSources } : {}), ...(upgrade ? { upgrade: true } : {}) }), session,
  });
}

export async function installProjectCanvasExtension(
  spaceId: string, projectId: string, session: SessionCredentials, manifest: unknown,
  artifacts: Record<string, string>, upgrade = false, instanceKey = "default",
): Promise<{ installed?: boolean; installationId?: string; error_code?: string; message?: string }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/extensions`, {
    method: "POST", body: JSON.stringify({ manifest, artifacts, instanceKey, ...(upgrade ? { upgrade: true } : {}) }), session,
  });
}

/** Connect a channel, or turn one off/back on. Owner/admin only, enforced server-side. */
/** What the server hands back for action:"pair" — a link to open (or scan) plus human steps. */
export interface ChannelPairing {
  channel: string;
  pair_url: string;
  mode: "scan" | "redirect";
  completion: "message" | "callback";
  steps: string[];
  expires_in_seconds: number;
}

export async function pairAssistantChannel(
  spaceId: string,
  session: SessionCredentials,
  channel: string,
  projectId?: string
): Promise<ChannelPairing> {
  return apiFetch<ChannelPairing>(`/v1/spaces/${spaceId}/assistant/channels`, {
    method: "POST",
    body: JSON.stringify({ action: "pair", channel, ...(projectId ? { project_id: projectId } : {}) }),
    session,
  });
}

export async function updateAssistantChannel(
  spaceId: string,
  session: SessionCredentials,
  body: { action: "connect" | "disconnect" | "enable" | "set_model" | "bind_extension" | "unbind_extension"; channel: string; secret?: string; project_id?: string; extension_instance_id?: string; media_access_token?: string; whatsapp_phone_number_id?: string; whatsapp_access_token?: string; model_override?: string | null }
): Promise<ChannelConnectResult> {
  return apiFetch<ChannelConnectResult>(`/v1/spaces/${spaceId}/assistant/channels`, {
    method: "POST",
    body: JSON.stringify(body),
    session,
  });
}

export interface SubAgentSummary {
  id: string;
  goal: string;
  status: string;
  progress_note: string | null;
  result?: string | null;
  error?: string | null;
  tokens_used?: number;
  created_at: string;
  updated_at: string;
}

/**
 * Sub-agents for a conversation. `sessionId` is what makes this work at all: an agent DO is
 * addressed per conversation, so without it the server falls back to the space-wide assistant DO
 * — an instance that never ran this chat's spawns and therefore always answers "none".
 * `agentId` mirrors /agent/run's own `{sessionId}:{agentId}` addressing for an explicitly bound
 * project agent.
 */
export async function listSubAgents(
  spaceId: string,
  session: SessionCredentials,
  parentRunId: string,
  opts?: { sessionId?: string | null | undefined; agentId?: string | null | undefined }
): Promise<SubAgentSummary[]> {
  const qs = new URLSearchParams({ parent_run_id: parentRunId });
  if (opts?.sessionId) qs.set("session_id", opts.sessionId);
  if (opts?.agentId) qs.set("agent_id", opts.agentId);
  const res = await apiFetch<{ data?: SubAgentSummary[] } | SubAgentSummary[]>(
    `/v1/spaces/${spaceId}/assistant/sub-agents?${qs.toString()}`,
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

/** A read workspace file: text inline (`content`), or a viewable binary (`encoding:"base64"` +
 *  `content_type`), or `too_large`. Step 4 added the binary case for PDF/image/Office viewing. */
export interface WorkspaceFileContent {
  path: string;
  size?: number;
  content?: string;
  too_large?: boolean;
  encoding?: "base64";
  content_type?: string;
}

export async function readAssistantFile(spaceId: string, path: string, session: SessionCredentials): Promise<WorkspaceFileContent> {
  return apiFetch(`/v1/spaces/${spaceId}/assistant/files/${path.split("/").map(encodeURIComponent).join("/")}`, { session });
}

// Phase 5: agent-authored deliverables — distinct from the workspace files above.
export interface ArtifactSummary {
  artifact_id: string;
  filename: string;
  content_type: string;
  size: number;
  uploaded: string;
}
export interface ArtifactContent {
  artifact_id: string;
  filename: string;
  content_type: string;
  content?: string;
  too_large?: boolean;
  binary?: boolean;
}
export async function listArtifacts(spaceId: string, session: SessionCredentials): Promise<ArtifactSummary[]> {
  const res = await apiFetch<{ data: ArtifactSummary[] }>(`/v1/spaces/${spaceId}/assistant/artifacts`, { session });
  return res.data;
}
export async function getArtifact(spaceId: string, artifactId: string, session: SessionCredentials): Promise<ArtifactContent> {
  return apiFetch(`/v1/spaces/${spaceId}/assistant/artifacts/${encodeURIComponent(artifactId)}`, { session });
}
export async function deleteArtifact(spaceId: string, artifactId: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/assistant/artifacts/${encodeURIComponent(artifactId)}`, { method: "DELETE", session });
}

export interface PrebuiltCapability {
  name: string;
  description: string;
  domain: string;
  requires_tier: number;
  operations: string[];
  source: "prebuilt";
}

export interface LearnedSkill {
  name: string;
  source: "learned";
}

export interface AssistantCapabilities {
  prebuilts: PrebuiltCapability[];
  skills: LearnedSkill[];
  prebuilt_count: number;
  skill_count: number;
}

/** What the assistant can actually do — built-in scripts plus the space's own learned skills.
 *  Metadata only; script source is deliberately not exposed to the end-user shell. */
export async function getAssistantCapabilities(
  spaceId: string,
  session: SessionCredentials,
  /** Step 15: pass the project id inside a project thread so the space-assistant-only
   *  orchestration scripts (create project/thread, spawn, schedule) are hidden — a project
   *  agent doesn't have them. */
  projectId?: string
): Promise<AssistantCapabilities> {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return apiFetch<AssistantCapabilities>(`/v1/spaces/${spaceId}/assistant/capabilities${qs}`, { session });
}

// ── Skills directory (the shared, fleet-learned template library a business can browse and pull
// individual skills from — distinct from Learned Skills above, which is what a space already has;
// see workers/agents/src/index.ts's /skills/directory and /skills/inherit) ────────────────────

export interface DirectorySkill {
  name: string;
  description: string;
  domain: string;
  version: number;
  requires_tier: number;
  installed: boolean;
}

/** Resolves the business's own template server-side — the caller never needs to know its id. A
 *  template-less space (none was picked, or no template ships a shared library) is a real,
 *  distinct 409, not an error the caller should surface as broken. */
export async function getSkillsDirectory(
  spaceId: string,
  session: SessionCredentials
): Promise<{ template_id: string; skills: DirectorySkill[] } | null> {
  try {
    return await apiFetch<{ template_id: string; skills: DirectorySkill[] }>(
      `/v1/skills/directory?space_id=${encodeURIComponent(spaceId)}`,
      { session }
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return null;
    throw e;
  }
}

/** names omitted = pull in everything the space is missing; a specific list = the directory's
 *  per-skill Add button. */
export async function inheritSkills(
  spaceId: string,
  session: SessionCredentials,
  names?: string[]
): Promise<{ inherited: string[]; skipped: string[] }> {
  return apiFetch(`/v1/skills/inherit`, {
    method: "POST",
    body: JSON.stringify({ space_id: spaceId, ...(names ? { names } : {}) }),
    session,
  });
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
  /** Where this business is in its setup checklist, read from the space's own config. `null` for
   *  a business created without a template — there is no checklist, so nothing is outstanding. */
  onboarding_status?: "pending" | "awaiting_setup" | "complete" | null;
  template_id?: string | null;
}

/** GET /v1/spaces/:productSpaceId/my-businesses — the space switcher's list. */
export async function listMyBusinesses(productSpaceId: string, session: SessionCredentials): Promise<Business[]> {
  const res = await apiFetch<{ data: Business[]; count: number }>(`/v1/spaces/${productSpaceId}/my-businesses`, { session });
  return res.data;
}

/** A safe-projection entry in the product's public business directory (step 18). */
export interface DirectoryBusiness {
  id: string;
  name: string;
  template_id?: string | null;
  created_at?: string | null;
  /** 1 when the signed-in user is a member of this business (so the UI can gate navigation). */
  is_mine: number;
}

/**
 * GET /v1/spaces/:productSpaceId/directory — every active business under this product (step 18).
 * DISCOVER what others have built; NAVIGATE only into your own (is_mine). Never leaks owner
 * identity, revenue, or any private metric — safe projection only.
 */
export async function getBusinessDirectory(
  productSpaceId: string,
  session: SessionCredentials,
): Promise<DirectoryBusiness[]> {
  const res = await apiFetch<{ data: DirectoryBusiness[]; count: number }>(
    `/v1/spaces/${productSpaceId}/directory`,
    { session },
  );
  return res.data;
}

export interface TemplateActivity {
  template_id: string;
  active_count: number;
  created_last_30d: number;
}

/** Discover's "what other businesses are doing" showcase — aggregate counts only, no names, no
 *  revenue, cross-tenant. See the route's own header on the spaces worker for why this is safe. */
export async function getTemplateActivity(productSpaceId: string, session: SessionCredentials): Promise<TemplateActivity[]> {
  const res = await apiFetch<{ data: TemplateActivity[] }>(`/v1/spaces/${productSpaceId}/template-activity`, { session });
  return res.data ?? [];
}

export interface BusinessAnalytics {
  window_days: number;
  runs: { total: number; completed: number; failed: number; success_rate: number | null; vs_prior_period: number | null };
  credits: { used: number; vs_prior_period: number | null };
  tokens_used: number;
  by_agent: Array<{ agent_id: string; runs: number; completed: number; failed: number; success_rate: number | null; credits: number }>;
  daily: Array<{ day: string; credits: number; runs: number }>;
  heartbeats: { completed_with_work: number; failed: number; by_trigger: Array<{ trigger: string; failed: number }> };
  structure: { projects: number; threads: number };
}

/** Analytics page — pure aggregate rollups of agent_activity_log, safe for any business member
 *  (see the route's own header on the spaces worker for why this differs from the builder-only
 *  agent-activity/agent-diagnostics endpoints it shares a table with). */
export async function getBusinessAnalytics(spaceId: string, session: SessionCredentials, window: "7d" | "30d" | "90d" = "7d"): Promise<BusinessAnalytics> {
  return apiFetch(`/v1/spaces/${spaceId}/business-analytics?window=${window}`, { session });
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
  /** The server's own field name (workers/spaces/src/index.ts). This was typed as `orders` here,
   *  which never existed on the wire — the dashboard rendered a literal "undefined orders". */
  order_count: number;
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
export async function readWorkspaceFile(spaceId: string, projectId: string, path: string, session: SessionCredentials): Promise<WorkspaceFileContent> {
  return apiFetch(`/v1/spaces/${spaceId}/projects/${projectId}/workspace/files/${path.split("/").map(encodeURIComponent).join("/")}`, { session });
}

export type DocumentNodeLeaseOperation = "claim" | "renew" | "release";
export async function updateDocumentNodeLease(
  spaceId: string, projectId: string, nodeId: string, operation: DocumentNodeLeaseOperation, session: SessionCredentials
): Promise<{ acquired?: boolean; renewed?: boolean; released?: boolean; error_code?: string; holderType?: string; holderId?: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/projects/${projectId}/document-nodes/${encodeURIComponent(nodeId)}/lease`, {
    method: "POST", body: JSON.stringify({ operation }), session,
  });
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

export async function listLocalGrants(
  spaceId: string,
  session: SessionCredentials,
  opts?: { projectId?: string }
): Promise<LocalGrant[]> {
  const qs = opts?.projectId ? `?project_id=${encodeURIComponent(opts.projectId)}` : "";
  const res = await apiFetch<{ data: LocalGrant[] }>(`/v1/spaces/${spaceId}/local-grants${qs}`, { session });
  return res.data;
}

export async function createLocalGrant(
  spaceId: string,
  session: SessionCredentials,
  input: { grant_type: "read" | "write" | "readwrite" | "exec"; directory?: string; commands?: string[]; project_id?: string }
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

export interface ExternalKnowledgePublication {
  id: string;
  name: string;
  updated_at: string;
  document_count: number;
  document_ids: string[];
}

export async function listExternalKnowledgePublications(
  spaceId: string, projectId: string, session: SessionCredentials
): Promise<ExternalKnowledgePublication[]> {
  const response = await apiFetch<{ publications: ExternalKnowledgePublication[] }>(
    `/v1/spaces/${spaceId}/kb/projects/${encodeURIComponent(projectId)}/external-publications`, { session }
  );
  return response.publications;
}

export async function publishExternalKnowledge(
  spaceId: string, projectId: string, publicationId: string, session: SessionCredentials,
  input: { name: string; document_ids: string[] }
): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/kb/projects/${encodeURIComponent(projectId)}/external-publications/${encodeURIComponent(publicationId)}`, {
    method: "PUT", body: JSON.stringify(input), session,
  });
}

export async function unpublishExternalKnowledge(
  spaceId: string, projectId: string, publicationId: string, session: SessionCredentials
): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/kb/projects/${encodeURIComponent(projectId)}/external-publications/${encodeURIComponent(publicationId)}`, {
    method: "DELETE", session,
  });
}

export interface KbSearchResult {
  chunk_id: string;
  doc_id: string;
  chunk_index: number;
  content: string;
  score: number;
}

export async function searchKb(
  spaceId: string,
  session: SessionCredentials,
  query: string,
  projectId?: string
): Promise<KbSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (projectId) params.set("project_id", projectId);
  const res = await apiFetch<{ data: KbSearchResult[] }>(`/v1/spaces/${spaceId}/kb/search?${params.toString()}`, { session });
  return res.data ?? [];
}

// ── Chat uploads (input-bar attachments the agent reads directly — NOT knowledge-base
// ingestion; see the agents-worker route's own header for the distinction) ────────────────────

export interface ChatUpload {
  name: string;
  key: string;
  size: number;
  content_type: string;
  uploaded?: string;
}

export async function uploadChatFiles(
  spaceId: string,
  sessionId: string,
  files: File[],
  session: SessionCredentials,
  projectId?: string
): Promise<ChatUpload[]> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  if (projectId) form.append("project_id", projectId);
  const headers: Record<string, string> = {
    ...(session.sessionToken === "cookie" ? {} : { Authorization: `Bearer ${session.sessionToken}` }),
    "x-naelao-end-user-id": session.endUserId,
  };
  const res = await fetch(`${session.sessionToken === "cookie" ? "/api/naelao" : API_URL}/v1/spaces/${spaceId}/sessions/${sessionId}/uploads`, {
    method: "POST", headers, body: form, ...(session.sessionToken === "cookie" ? { credentials: "include" as const } : {}),
  });
  const body = (await res.json()) as { uploaded?: ChatUpload[]; message?: string; error_code?: string };
  if (!res.ok) throw new ApiError(body.message ?? "Upload failed", res.status, body.error_code);
  return body.uploaded ?? [];
}

export async function listChatUploads(
  spaceId: string,
  sessionId: string,
  session: SessionCredentials,
  projectId?: string
): Promise<ChatUpload[]> {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  const res = await apiFetch<{ files: ChatUpload[] }>(`/v1/spaces/${spaceId}/sessions/${sessionId}/uploads${qs}`, { session });
  return res.files ?? [];
}

export async function deleteChatUpload(
  spaceId: string,
  sessionId: string,
  filename: string,
  session: SessionCredentials,
  projectId?: string
): Promise<void> {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  await apiFetch(`/v1/spaces/${spaceId}/sessions/${sessionId}/uploads/${encodeURIComponent(filename)}${qs}`, {
    method: "DELETE", session,
  });
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
  /** Real provider logo, resolved server-side from whichever provider brokers this app. Absent
   *  for a connector neither brokers (Whop, Gumroad) — the card falls back to its initial. */
  logo?: string;
  oauth?: unknown;
  composio?: unknown;
  /** Pipedream Connect — the second hosted "click Install" provider (item 57), e.g. Notion.
   *  Mutually exclusive with `composio` in practice, same real-catalogue precedent as that field. */
  pipedream?: unknown;
  /** The durable workspace provider pin for an already connected app. */
  connected_provider?: "composio" | "pipedream" | "direct";
  /** "space" (default, absent = space): one shared connection for the whole business. "user":
   *  each member connects their OWN account — never visible to or usable by anyone else. */
  scope_model?: "space" | "user";
}

// §A1 connector default-vs-personal switch: which credential tier a session's connector calls use
// — "business" (default, the shared account) or "personal" (this member's own connected one). A
// missing entry means business. Read once by the agent per run, so a mismatch ("do X on my Gmail"
// while still on business) can be reported instead of silently used against the wrong account.

export async function getConnectorMode(
  spaceId: string,
  sessionId: string,
  session: SessionCredentials
): Promise<Record<string, "business" | "personal">> {
  const res = await apiFetch<{ modes?: Record<string, string> }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/connector-mode`,
    { session }
  );
  const out: Record<string, "business" | "personal"> = {};
  for (const [k, v] of Object.entries(res.modes ?? {})) if (v === "personal") out[k] = "personal";
  return out;
}

export async function setConnectorMode(
  spaceId: string,
  sessionId: string,
  connectorId: string,
  mode: "business" | "personal",
  session: SessionCredentials
): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/sessions/${sessionId}/connector-mode`, {
    method: "PATCH",
    body: JSON.stringify({ connector_id: connectorId, mode }),
    session,
  });
}

/** Which hosted-connect provider (or mechanism) a connector uses — for the Connectors page's
 *  provider filter. Composio is the default/most common; Pipedream and bespoke OAuth/manual-key
 *  connectors are real but fewer. */
export function connectorProvider(c: ConnectorInfo): "composio" | "pipedream" | "oauth" | "manual" {
  if (c.composio) return "composio";
  if (c.pipedream) return "pipedream";
  if (c.oauth) return "oauth";
  return "manual";
}

export async function getConnectorStatus(spaceId: string, session: SessionCredentials): Promise<ConnectorInfo[]> {
  const res = await apiFetch<{ connectors: ConnectorInfo[] }>(`/v1/spaces/${spaceId}/connectors/status`, { session });
  return res.connectors ?? [];
}

export interface ConnectorAlias {
  id: string;
  alias: string;
  scope: "space" | "project" | "user";
  project_id: string | null;
  user_id: string | null;
  server_id: string;
  granted_scopes_json: string;
  updated_at: string;
}

export async function getConnectorAliases(spaceId: string, session: SessionCredentials): Promise<ConnectorAlias[]> {
  const res = await apiFetch<{ data?: ConnectorAlias[] }>(`/v1/spaces/${spaceId}/connector-aliases`, { session });
  return res.data ?? [];
}

export async function createConnectorAlias(spaceId: string, input: { alias: string; scope: "space" | "project" | "user"; connector_name: string; project_id?: string; granted_scopes?: string[] }, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/connector-aliases`, { method: "POST", body: JSON.stringify(input), session });
}

export async function deleteConnectorAlias(spaceId: string, aliasId: string, session: SessionCredentials): Promise<void> {
  await apiFetch(`/v1/spaces/${spaceId}/connector-aliases/${aliasId}`, { method: "DELETE", session });
}

/** One app from the full provider directory (every Composio toolkit + Pipedream app), as opposed
 *  to the curated catalogue `ConnectorInfo` describes. `curated_as` means we already ship a
 *  purpose-built connector for it — the UI should point there instead. */
export interface DirectoryApp {
  id: string;
  provider: "composio" | "pipedream";
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  categories: string[];
  auth?: string;
  curated_as?: string;
  /** Position in the provider's own popularity ordering, 0 = most reached for. Present only in
   *  the default `popular` sort, and only for a provider that actually ranks. */
  rank?: number;
  connected?: boolean;
  connected_provider?: "composio" | "pipedream" | "direct";
}

export interface DirectoryPage {
  apps: DirectoryApp[];
  next_cursor?: string;
  providers: Array<{ provider: string; available: boolean; reason?: string }>;
}

export async function getConnectorDirectory(
  spaceId: string,
  session: SessionCredentials,
  opts: {
    q?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    /** Default `popular` — alphabetical opens the directory on "0codekit". */
    sort?: "popular" | "name" | undefined;
  } = {}
): Promise<DirectoryPage> {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.sort) params.set("sort", opts.sort);
  const qs = params.toString();
  return apiFetch(`/v1/spaces/${spaceId}/connectors/directory${qs ? `?${qs}` : ""}`, { session });
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

export async function startTenantCustomOAuth(
  spaceId: string,
  session: SessionCredentials,
  config: { connector_id: string; display_name: string; client_id: string; client_secret: string; authorization_url: string; token_url: string; scopes: string[]; mcp_url: string },
  returnUrl: string,
): Promise<{ authorize_url: string; redirect_uri: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/connectors/custom-oauth-start`, {
    method: "POST", body: JSON.stringify({ ...config, return_url: returnUrl }), session,
  });
}

export async function getTenantCustomOAuthRedirectUri(
  spaceId: string,
  session: SessionCredentials,
  connectorId: string,
): Promise<{ redirect_uri: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/connectors/custom-oauth-redirect?connector_id=${encodeURIComponent(connectorId)}`, { session });
}

/** Composio "click Install" hosted-connect flow (G-1/G-3 growth layer) — same real-browser-
 *  navigation contract as startOAuthConnect above (no credential in the URL, only an opaque
 *  single-use ticket); the caller does `window.location.href = connect_url` itself. */
export async function startProviderConnect(
  spaceId: string,
  session: SessionCredentials,
  platform: string,
  returnUrl: string,
  preferredProvider?: "composio" | "pipedream"
): Promise<{ connect_url: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/connectors/provider-connect-start`, {
    method: "POST",
    body: JSON.stringify({ platform, return_url: returnUrl, ...(preferredProvider ? { preferred_provider: preferredProvider } : {}) }),
    session,
  });
}

// ── First-run business setup wizard ──────────────────────────────────────────
// One route on the spaces worker (GET reads, POST's `action` saves or completes) wrapping the
// agents worker's real bootstrap machinery. Deliberately not a client-side script: the prompt set
// belongs to the SpaceType template, so the wizard renders whatever the template defines rather
// than carrying a copy that silently drifts the moment a template is edited.

export interface OnboardingPrompt {
  id: string;
  type: "connection" | "credential" | "channel" | "choice" | "text" | "boolean";
  question: string;
  help?: string;
  options?: string[];
  connector?: string;
  required?: boolean;
  /** Never populated for credential/connection prompts — the server doesn't echo secrets back. */
  answer?: string | null;
  /** A connection prompt is satisfied by a REAL registered connector, not by a stored string. */
  satisfied: boolean;
  /** Whether one-click connect actually works on this deployment (the connector's OAuth app is
   *  registered). False means the key-paste path is the only one that works — lead with it rather
   *  than offering a button whose only possible outcome is a platform-internal error. */
  oauth_available?: boolean;
}

export interface OnboardingState {
  status: "pending" | "awaiting_setup" | "complete";
  /** The SPACE's own status. A business is created before provisioning finishes, so an empty
   *  prompt list means "still provisioning, wait" while this is not yet "active" — and genuinely
   *  "nothing to configure" (a Custom business) once it is. */
  space_status: string;
  template_ids: string[];
  templates: Array<{ id: string; name: string; description: string | null; connectors: string[] }>;
  prompts: OnboardingPrompt[];
  projects_created: string[];
  setup_scripts: string[];
}

export async function getOnboarding(spaceId: string, session: SessionCredentials): Promise<OnboardingState> {
  return apiFetch<OnboardingState>(`/v1/spaces/${spaceId}/onboarding`, { session });
}

/** Persist answers WITHOUT completing. Load-bearing before any connect click: that's a real
 *  browser navigation away from the wizard, so unsaved answers would simply be gone on return. */
export async function saveOnboarding(
  spaceId: string,
  session: SessionCredentials,
  answers: Record<string, string>
): Promise<{ ok: boolean }> {
  return apiFetch(`/v1/spaces/${spaceId}/onboarding`, {
    method: "POST",
    body: JSON.stringify({ action: "save", answers }),
    session,
  });
}

/** Finish setup: creates the template's project presets, runs its setup scripts, and wakes the
 *  assistant to introduce itself on the channel just chosen. Rejects with `onboarding_incomplete`
 *  (carrying `missing`) while a required prompt is unmet. */
export async function completeOnboarding(
  spaceId: string,
  session: SessionCredentials,
  answers: Record<string, string>
): Promise<{ ok: boolean; projects_created: string[]; first_contact_sent: boolean }> {
  return apiFetch(`/v1/spaces/${spaceId}/onboarding`, {
    method: "POST",
    body: JSON.stringify({ action: "complete", answers }),
    session,
  });
}

// ── Interrupted runs ─────────────────────────────────────────────────────────
// A run that failed leaves a standing offer to CONTINUE it. Read from the server rather than
// held in the page, so the offer survives a refresh — the work is already done and paid for;
// losing the only way to pick it up because someone reloaded would be the real failure.

export interface InterruptedRun {
  run_id: string;
  goal: string;
  reason: string;
  /** How much the run had already completed before it stopped — what a Continue picks up from. */
  steps_completed: number;
  created_at: number;
  /** Classified server-side (@naelao/events classifyFailure) from the reason text. */
  failure_kind?: string;
  /** True when simply waiting is likely enough — the model allowance resetting, a rate window
   *  passing. Changes the card's advice from "continue" to "try again now". */
  clears_on_its_own?: boolean;
  /** What the error means, in words, since a raw provider string tells a person nothing. */
  explanation?: string;
}

export async function getInterruptedRun(
  spaceId: string,
  sessionId: string,
  session: SessionCredentials
): Promise<InterruptedRun | null> {
  const res = await apiFetch<{ interrupted: InterruptedRun | null }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/interrupted`,
    { session }
  );
  return res.interrupted ?? null;
}

/** Continue re-enters the loop under the original run's ledger key, so actions that already
 *  executed replay instead of running a second time. Dismiss just closes the offer. */
export async function resolveInterruptedRun(
  spaceId: string,
  sessionId: string,
  runId: string,
  action: "continue" | "dismiss",
  session: SessionCredentials
): Promise<{ continued: boolean; run_id?: string }> {
  return apiFetch<{ continued: boolean; run_id?: string }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/interrupted`,
    { method: "POST", body: JSON.stringify({ run_id: runId, action }), session }
  );
}

export interface MarketRadarOpportunity {
  id: string;
  name: string;
  search_surge_pct: number;
  saturation_index: number;
  saturation_label: string;
  arr_low_cents: number;
  arr_high_cents: number;
  source_url: string;
  observed_at: string;
  score: number;
  preconfigured_stack: string[];
  blueprint: { id: string };
}

export async function getMarketRadar(productSpaceId: string, session: SessionCredentials): Promise<MarketRadarOpportunity[]> {
  const result = await apiFetch<{ data: MarketRadarOpportunity[] }>(`/v1/spaces/${encodeURIComponent(productSpaceId)}/market-radar/top-trends`, { session });
  return result.data;
}

export async function launchMarketRadarOpportunity(
  opportunityId: string,
  productSpaceId: string,
  input: { name?: string; spacetype_id: string },
  session: SessionCredentials
): Promise<{ space_id: string; opportunity_id: string; blueprint_id: string }> {
  return apiFetch(`/v1/spaces/${encodeURIComponent(productSpaceId)}/market-radar/${encodeURIComponent(opportunityId)}/launch`, {
    method: "POST", body: JSON.stringify(input), session,
  });
}
