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

// Callers need to distinguish "not found" (self-healable — e.g. Chat.tsx recreating a stale
// session) from other failures, but the backend's `message` field is human text ("Session not
// found") with no reliable substring to match on — a prior version of this threw a plain Error
// and callers guessed via `message.includes("404")`, which never actually matched and meant a
// 404 always surfaced as a raw, un-recovered error instead of self-healing. Carrying the real
// HTTP status lets callers check `err.status === 404` instead of parsing prose.
export class ApiError extends Error {
  status: number;
  errorCode?: string | undefined;
  constructor(message: string, status: number, errorCode?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.errorCode = errorCode;
  }
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
    let errorCode: string | undefined;
    try {
      const body = (await res.json()) as { message?: string; error_code?: string };
      message = body.message ?? body.error_code ?? message;
      errorCode = body.error_code;
    } catch {
      // use default message
    }
    throw new ApiError(message, res.status, errorCode);
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
  template_catalog: Array<{ id: string; name: string; coming_soon: boolean; free_tier_eligible: boolean }>;
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
    consulted_threads?: ConsultedThread[];
    needs_connector?: boolean;
    connector_id?: string;
    connector_name?: string;
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
  /** CLIENT-ONLY, same non-persisted scope as pendingApproval: one or more actions this run
   *  parked and carried on around (as opposed to pendingApproval, where the WHOLE run stopped).
   *  Rendered as the same inline card, one per entry. */
  deferredApprovals?: RunPendingApproval[];
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
  /** A reasoning-capable model's own chain-of-thought for a "reason" step, when the model
   *  returned one. Rendered as a separate collapsed "Thoughts" block, not folded into `detail`. */
  thinking?: string;
  ts: number;
}

/** What a run is waiting on a PERSON for — the data an inline in-chat approval card renders.
 *  Mirrors workers/agents/src/index.ts's RunPendingApproval. */
export interface RunPendingApproval {
  approval_id: string;
  action_name: string;
  params?: Record<string, unknown>;
  expires_at?: number;
}

export interface AgentRun {
  id: string;
  /** `awaiting_approval` means the run paused at a gate and is waiting on a PERSON, not on the
   *  machine. It is not terminal and it is not a failure — the work is intact and continues once
   *  someone answers, which is a completely different thing to tell a user than "still working". */
  status: "running" | "completed" | "failed" | "cancelled" | "awaiting_approval";
  final_answer?: string;
  error?: string;
  /** New steps recorded since the run started, present only while status is "running" — see
   *  LiveRunStep's own doc. */
  live_steps?: LiveRunStep[];
  /** Present when status is "awaiting_approval" — which action, with what parameters. */
  pending_approval?: RunPendingApproval;
  /** Actions the run parked and carried on around — distinct from pending_approval (which means
   *  the WHOLE run suspended). A run can finish (or even fail on something unrelated afterward)
   *  while still carrying one or more of these — they must be rendered regardless of `status`. */
  deferred_approvals?: RunPendingApproval[];
}

/** POST /v1/spaces/:spaceId/sessions — start a new chat session.
 *  `title` rides in the session's own metadata (SpaceDO has no title column) so the recent-
 *  sessions list can label a conversation without an N+1 fetch of every session's first message. */
export async function startSession(
  spaceId: string,
  session: SessionCredentials,
  title?: string
): Promise<{ id: string; space_id: string }> {
  const body = title ? { metadata: { title } } : {};
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

/** GET /v1/spaces/:spaceId/sessions — the signed-in user's own recent conversations. The
 *  end_user_id filter is applied SERVER-side from verified claims; a client-supplied one is
 *  ignored, so this can only ever return the caller's own sessions. */
export async function listSessions(
  spaceId: string,
  session: SessionCredentials,
  limit = 20
): Promise<SessionSummary[]> {
  const res = await apiFetch<{ data?: Array<{ id: string; status: string; created_at: string; updated_at: string; metadata?: string }> }>(
    `/v1/spaces/${spaceId}/sessions?limit=${limit}`,
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
  const res = await apiFetch<{ data?: Message[]; messages?: Message[] } | Message[]>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/messages`,
    { session }
  );
  if (Array.isArray(res)) return res;
  return res.data ?? res.messages ?? [];
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
}

/** Persists the user's message, then kicks off an agent run. */
export async function sendMessage(
  spaceId: string,
  sessionId: string,
  content: string,
  session: SessionCredentials,
  modelOptions?: RunModelOptions
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
    {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        goal: content,
        ...(modelOptions?.model ? { model: modelOptions.model } : {}),
        ...(modelOptions?.reasoningEffort ? { reasoning_effort: modelOptions.reasoningEffort } : {}),
        ...(modelOptions?.effort ? { effort: modelOptions.effort } : {}),
        ...(modelOptions?.agentDefinitionId ? { agent_definition_id: modelOptions.agentDefinitionId } : {}),
      }),
      session,
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
    // Legacy fallback: raw session token in URL (logged but functional — used during local dev).
    const params = new URLSearchParams({ session_token: session.sessionToken, end_user_id: session.endUserId });
    return `${API_URL}/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}/stream?${params.toString()}`;
  }
}

/** Polling fallback for environments without SSE. */
export async function pollRun(spaceId: string, sessionId: string, runId: string, session: SessionCredentials): Promise<AgentRun> {
  const res = await apiFetch<{ id: string; status: string; final_answer?: string; error?: string; live_steps?: LiveRunStep[]; pending_approval?: RunPendingApproval; deferred_approvals?: RunPendingApproval[] }>(
    `/v1/spaces/${spaceId}/sessions/${sessionId}/agent/runs/${runId}`,
    { session }
  );
  return {
    id: res.id,
    status: (res.status as AgentRun["status"]) ?? "running",
    ...(res.final_answer !== undefined ? { final_answer: res.final_answer } : {}),
    ...(res.error !== undefined ? { error: res.error } : {}),
    ...(res.live_steps ? { live_steps: res.live_steps } : {}),
    ...(res.pending_approval ? { pending_approval: res.pending_approval } : {}),
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
  opts?: { status?: "unread" | "read"; limit?: number }
): Promise<AppNotification[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
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
  session_id: string | null;
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

export interface ChannelConnectResult {
  connected?: boolean;
  channel: string;
  enabled?: boolean;
  /** Paste this into the provider's own dashboard — connecting on our side isn't enough on its
   *  own for messages to actually arrive. */
  webhook_url?: string;
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
  body: { action: "connect" | "disconnect" | "enable"; channel: string; secret?: string; project_id?: string }
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
  session: SessionCredentials
): Promise<AssistantCapabilities> {
  return apiFetch<AssistantCapabilities>(`/v1/spaces/${spaceId}/assistant/capabilities`, { session });
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
    Authorization: `Bearer ${session.sessionToken}`,
    "x-naelao-end-user-id": session.endUserId,
  };
  const res = await fetch(`${API_URL}/v1/spaces/${spaceId}/sessions/${sessionId}/uploads`, {
    method: "POST", headers, body: form,
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

/** Composio "click Install" hosted-connect flow (G-1/G-3 growth layer) — same real-browser-
 *  navigation contract as startOAuthConnect above (no credential in the URL, only an opaque
 *  single-use ticket); the caller does `window.location.href = connect_url` itself. */
export async function startProviderConnect(
  spaceId: string,
  session: SessionCredentials,
  platform: string,
  returnUrl: string
): Promise<{ connect_url: string }> {
  return apiFetch(`/v1/spaces/${spaceId}/connectors/provider-connect-start`, {
    method: "POST",
    body: JSON.stringify({ platform, return_url: returnUrl }),
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
