import { Hono } from "hono";
import { requestId, jwtAuth, errorResponse, unauthorized, mintInternalToken } from "@naelao/http";
import { signHmac } from "@naelao/crypto";
import type { NaelaoJwtClaims } from "@naelao/types";
export { RateLimitDO } from "./RateLimitDO";

export interface Env {
  ENVIRONMENT: string;
  JWT_SECRET: string;
  PLATFORM_SECRET: string;
  CORS_ALLOWLIST?: string;
  SESSION_REVOCATION: KVNamespace;
  CONFIG: KVNamespace;
  NONCE_STORE: KVNamespace;
  QUOTA_CACHE: KVNamespace;
  PLATFORM_DB: D1Database;
  RATE_LIMIT_DO: DurableObjectNamespace;
  SPACES_WORKER: Fetcher;
  KNOWLEDGE_WORKER: Fetcher;
  AGENTS_WORKER: Fetcher;
  AUTH_WORKER: Fetcher;
  CREDENTIALS_WORKER: Fetcher;
}

// G-AX27: Replay attack prevention — max clock skew in seconds
const MAX_TIMESTAMP_SKEW_S = 300;

// ── G-AX27: validate timestamp and track nonce to prevent replay attacks ──────
async function checkReplayPrevention(
  request: Request,
  nonceStore: KVNamespace
): Promise<{ ok: boolean; reason?: string }> {
  const tsHeader = request.headers.get("x-naelao-timestamp");
  if (!tsHeader) return { ok: true }; // header optional for unauthenticated routes

  const ts = parseInt(tsHeader, 10);
  if (isNaN(ts)) return { ok: false, reason: "x-naelao-timestamp must be a unix epoch integer" };

  const nowS = Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - ts) > MAX_TIMESTAMP_SKEW_S) {
    return { ok: false, reason: `Request timestamp is outside ±${MAX_TIMESTAMP_SKEW_S}s window` };
  }

  // Nonce check (best-effort — KV eventual consistency ~60s, but catches most replays)
  const nonceHeader = request.headers.get("x-naelao-nonce");
  if (nonceHeader) {
    const nonceKey = `nonce:${nonceHeader}`;
    const existing = await nonceStore.get(nonceKey);
    if (existing !== null) {
      return { ok: false, reason: "Request nonce has already been used (replay detected)" };
    }
    // Store nonce with TTL slightly longer than the allowed skew window
    await nonceStore.put(nonceKey, "1", { expirationTtl: MAX_TIMESTAMP_SKEW_S + 60 });
  }

  return { ok: true };
}

// G-AD02: In-memory per-user token version cache (5s TTL)
// Map key: userId, value: { version, expiresAt }
const tokenVersionCache = new Map<string, { version: number; expiresAt: number }>();
const TOKEN_VERSION_CACHE_TTL_MS = 5_000;

async function checkTokenVersion(
  db: D1Database,
  userId: string,
  claimedVersion: number
): Promise<boolean> {
  const cached = tokenVersionCache.get(userId);
  let currentVersion: number;

  if (cached && Date.now() < cached.expiresAt) {
    currentVersion = cached.version;
  } else {
    const row = await db
      .prepare("SELECT token_version FROM users WHERE id = ?1")
      .bind(userId)
      .first<{ token_version: number }>();
    currentVersion = row?.token_version ?? 0;
    tokenVersionCache.set(userId, { version: currentVersion, expiresAt: Date.now() + TOKEN_VERSION_CACHE_TTL_MS });
  }

  return claimedVersion >= currentVersion;
}

// Extend Hono context variables for this worker
declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    claims: NaelaoJwtClaims;
    // §A1.17 Phase O: an agent (role:"agent") caller's effective approval policy, resolved in
    // the SAME round trip as its nak_... key so the approval-gate middleware below never needs
    // a second call just to find out whether this request needs to be gated.
    agentApproval?: { mode: "always_ask" | "yolo"; autoApproved: string[] };
  }
}

// G-A11: Validate required secrets at startup
function validateEnv(env: Env): void {
  const required = ["JWT_SECRET", "PLATFORM_SECRET"] as const;
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required secret: ${key}`);
  }
}

const app = new Hono<{ Bindings: Env }>();

// F11: cors(["*"]) allowed any origin to drive cross-origin requests carrying a Bearer JWT.
// The allowlist is env-driven (CORS_ALLOWLIST, comma-separated) because it must be read per
// request from c.env — a static cors(...) factory bakes its list in at module-load time,
// before env is available. Never echo "*" — only an exact allowlisted origin, or nothing.
app.use("*", async (c, next) => {
  const origin = c.req.header("origin") ?? "";
  const allowlist = (c.env.CORS_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = allowlist.includes(origin) ? origin : "";

  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  await next();
  if (allowed) c.res.headers.set("Access-Control-Allow-Origin", allowed);
  return;
});
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// ── Health check (unauthenticated) ───────────────────────────────────────────
app.get("/health", (c) =>
  c.json({ status: "ok", env: c.env.ENVIRONMENT, ts: Date.now() })
);

// ── Auth routes (forwarded to auth worker) ───────────────────────────────────
app.all("/v1/auth/*", async (c) => {
  const url = new URL(c.req.url);
  const downstream = new URL(url.pathname.replace("/v1/auth", ""), "http://auth");
  downstream.search = url.search;
  return c.env.AUTH_WORKER.fetch(
    new Request(downstream.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    })
  );
});

// ── Public connector webhook ingress (unauthenticated; HMAC signature is the auth) ──
// External platforms (Whop, Gumroad, …) POST events here — they can't carry a JWT, so this is
// registered BEFORE the authenticated api group. The agents worker verifies the signature.
app.all("/v1/connectors/:platform/webhook/:spaceId", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.AGENTS_WORKER.fetch(
    new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body })
  );
});

// ── Public multi-channel ingress (unauthenticated; the channel's own signature is the auth) ──
// Slack/Discord/inbound-email providers can't carry a JWT either — same pattern as connectors
// above, registered before the authenticated api group. The agents worker verifies the
// channel-specific signature (HMAC for Slack/email, Ed25519 for Discord) before acting on it.
app.all("/v1/channels/:channel/inbound/:spaceId", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.AGENTS_WORKER.fetch(
    new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body })
  );
});

// ── Three-Tier Platform Model, Phase 6: product end-user signup/login (unauthenticated — a
// visitor has no token at all before this) ── Journey 1B: "End user signs up... via the
// builder's configured auth provider." Registered before the JWT-gated api group, same
// reasoning as /v1/auth/* above.
app.all("/v1/spaces/:spaceId/end-users/*", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.SPACES_WORKER.fetch(
    new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body })
  );
});

// Three-Tier Platform Model, Phase A (apps/shell): the shell resolves a product by its
// subdomain-style slug (/p/[slug]) before a visitor has any credential — same reasoning and same
// "strip client-supplied identity headers" precaution as shell/manifest below (the spaces
// worker's handler already returns a fully public-safe projection regardless of caller identity).
app.get("/v1/products/by-slug/:slug", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-naelao-tenant-id");
  headers.delete("x-naelao-user-id");
  headers.delete("x-naelao-role");
  headers.delete("x-naelao-scopes");
  headers.delete("x-naelao-internal-token");
  return c.env.SPACES_WORKER.fetch(new Request(u.toString(), { method: c.req.method, headers, body: c.req.raw.body }));
});

// Three-Tier Platform Model, Phase 6: the shell's login page needs branding (logo/color/name)
// and auth_provider BEFORE a visitor has any credential at all — registered unauthenticated,
// same reasoning as end-users/* above. The spaces worker's handler already returns a fully
// public-safe projection (no internal manifest fields) regardless of caller identity, so there
// is nothing extra to leak by allowing a bare, tokenless GET here. Since this path is reached
// with NO claims verification at all, strip any client-supplied identity headers first (same B2
// precedent as proxyTo below) — otherwise a caller could set x-naelao-tenant-id themselves and
// have the spaces worker's getCallerIdentity trust it as if it had been verified.
app.get("/v1/spaces/:spaceId/shell/manifest", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-naelao-tenant-id");
  headers.delete("x-naelao-user-id");
  headers.delete("x-naelao-role");
  headers.delete("x-naelao-scopes");
  headers.delete("x-naelao-internal-token");
  return c.env.SPACES_WORKER.fetch(new Request(u.toString(), { method: c.req.method, headers, body: c.req.raw.body }));
});

// Three-Tier Platform Model, Phase 6: routes a product end user (authenticated against
// ProductUserDO, Phase 2 — no platform tenant, no JWT) is allowed to reach directly, carrying a
// Bearer nps_... session token + x-naelao-end-user-id instead of a platform JWT. Deliberately a
// narrow allowlist, not "any Bearer nps_ token works everywhere" — kb ingestion, credentials,
// member-billing etc. stay JWT-only.
//
// Phase 6's own note here previously rejected /projects, /threads, and /agent-definitions
// outright because each carried a blanket "builder-only, confirmed never end-user-facing"
// comment with no per-caller floor. Phase B (§A1.17) revisits that: the Product Shell's
// Projects/Threads views need list/create/read access to exactly those three, so
// `workers/spaces/src/index.ts` grew a `requireBusinessMembership` gate (business-auth.ts) that
// is additive-only for `product_end_user` — every other role's access is completely unchanged —
// and per-route/per-method: agent-definitions only allows GET for a product_end_user (never a
// write); projects/threads allow GET+POST but NOT the admin-only sub-paths (rules, spend,
// per-project PATCH config) — those stay off this allowlist entirely, so no product_end_user
// request can reach them regardless of what the spaces worker's gate would otherwise allow.
// `/scheduled-jobs` is still deliberately excluded — nothing in the shell needs it yet, and its
// own gate (`loadOwnedSpace`) is tenant-match-only with no per-caller floor at all, exactly the
// footgun this comment originally warned about (claims.tid is the space's OWNING tenant, so a
// tenant-match-only gate would silently accept end-user traffic the moment it's allowlisted).
// Do not add it without first giving it the same treatment projects/threads got here.
//
// Phase C (§A1.17) added the business/invite routes. /businesses and /my-businesses are always
// called with a PRODUCT ROOT :spaceId (no parent_space_id) — safe under the same reasoning as
// projects/threads above. /invites* and /business-members* are called with a BUSINESS :spaceId
// (parent_space_id set) — this is the first real exerciser of product-sessions/verify's
// parent-walk (previously unexercised since no businesses existed yet): the router resolves the
// caller's identity against the PRODUCT ROOT's ProductUserDO (sessions are product-scoped, not
// per-business) but the spaces worker's own resolveEndUserBusinessRole is what actually enforces
// "does this end user belong to THIS specific business" — the router's allowlist only proves
// identity, never authorization, exactly as documented at the top of this list.
const PRODUCT_END_USER_PATH_PATTERNS: RegExp[] = [
  /^\/spaces\/([^/]+)\/sessions(\/|$)/,
  /^\/spaces\/([^/]+)\/shell\/manifest$/,
  /^\/spaces\/([^/]+)\/kb\/(documents|search)(\/|$)/,
  /^\/spaces\/([^/]+)\/product-users\/me$/,
  /^\/spaces\/([^/]+)\/projects(\/[^/]+)?$/,
  // Phase T (§A1.17): project collaboration — real per-project membership + the exclusive-mode
  // thread lock. Additionally gated by requireBusinessMembership on the spaces worker exactly
  // like every other business-scoped route above (identity here, authorization there); capped so
  // /rules and /spend still don't match, matching the Phase B precedent for this same route family.
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/members(\/[^/]+)?$/,
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/activate-thread$/,
  // Launchpad Wallet (user-directed feature): balance/history are a business owner's own read
  // surface, gated the same way as the routes above (identity here, requireBusinessMembership on
  // the spaces worker). Explicitly capped to those two sub-paths so /wallet/credit and
  // /wallet/debit — money-moving, internal-only (billing worker webhook + the wallet prebuilt) —
  // never match this allowlist, matching /rules and /spend's existing precedent.
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/wallet\/(balance|history)$/,
  /^\/spaces\/([^/]+)\/threads(\/[^/]+)?$/,
  /^\/spaces\/([^/]+)\/agent-definitions(\/|$)/,
  /^\/spaces\/([^/]+)\/presence$/,
  /^\/spaces\/([^/]+)\/businesses$/,
  /^\/spaces\/([^/]+)\/my-businesses$/,
  /^\/spaces\/([^/]+)\/invites(\/|$)/,
  /^\/spaces\/([^/]+)\/business-members(\/|$)/,
  // Phase E (§A1.17): pricing display + checkout initiation. All three are additionally gated by
  // requireBusinessMembership on the spaces worker (member+) — this allowlist only proves the
  // caller is a valid product end user, never that they belong to the specific business in the
  // URL (same "identity, not authorization" split every other entry above documents).
  /^\/spaces\/([^/]+)\/pricing$/,
  /^\/spaces\/([^/]+)\/business-subscription\/checkout$/,
  /^\/spaces\/([^/]+)\/credit-packs\/checkout$/,
  // Phase N (§A1.17): the manifest-driven operator-shell view (Revenue/Orders/Products) for a
  // business owner operating their OWN Launchpad business — additionally gated by
  // requireBusinessMembership on the spaces worker exactly like the pricing routes above.
  /^\/spaces\/([^/]+)\/products(\/[^/]+)?$/,
  /^\/spaces\/([^/]+)\/orders$/,
  /^\/spaces\/([^/]+)\/revenue$/,
  // Phase S (§A1.17): a business member granting the assistant access to their OWN machine —
  // additionally gated by requireBusinessMembership on the spaces worker exactly like the
  // pricing/products routes above (identity here, authorization there).
  /^\/spaces\/([^/]+)\/local-grants(\/|$)/,
  /^\/spaces\/([^/]+)\/local-tunnel\/connect-token$/,
  // WS-2 (Space Assistant surface): the Status/Crons panels — additionally gated by
  // resolveEndUserBusinessRole on the spaces worker exactly like the routes above.
  /^\/spaces\/([^/]+)\/assistant-policy$/,
  /^\/spaces\/([^/]+)\/scheduled-jobs$/,
  // The Memory/Channels/Sub-agents/Files panels — additionally gated by
  // requireEndUserBusinessMembership on the agents worker (same floor, different worker since
  // these routes live there).
  /^\/spaces\/([^/]+)\/assistant\/(memory|channels|sub-agents|files)$/,
];

/** Resolve productId from the path if it matches an end-user-reachable route pattern. Strips the
 *  /v1 mount prefix first — c.req.path inside the `api` sub-app still carries it (same reason
 *  proxyTo strips it before forwarding downstream; see its comment above). */
function matchProductEndUserPath(path: string): string | null {
  const stripped = path.replace(/^\/v1(?=\/|$)/, "") || "/";
  for (const pattern of PRODUCT_END_USER_PATH_PATTERNS) {
    const m = pattern.exec(stripped);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** Verify a Bearer nps_... product session token against the space's ProductUserDO via the
 *  spaces worker's internal endpoint, returning router-shaped claims on success. The chicken-
 *  and-egg here (we don't know the owning tenantId until AFTER verifying) is why this is gated
 *  by a direct platform-secret header, not requireInternalHmac — same precedent as
 *  /internal/space-types/seed. */
async function resolveProductEndUserClaims(
  env: Env,
  productId: string,
  endUserId: string,
  sessionToken: string
): Promise<NaelaoJwtClaims | null> {
  const res = await env.SPACES_WORKER.fetch(
    new Request("http://spaces/internal/product-sessions/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-platform-secret": env.PLATFORM_SECRET },
      body: JSON.stringify({ productId, endUserId, sessionToken }),
    })
  );
  if (!res.ok) return null;
  const result = await res.json<{ valid: boolean; tenant_id?: string }>();
  if (!result.valid || !result.tenant_id) return null;

  const now = Math.floor(Date.now() / 1000);
  return {
    sub: endUserId,
    tid: result.tenant_id,
    email: "",
    role: "product_end_user",
    scopes: [],
    iat: now,
    exp: now + 3600,
    jti: "",
  };
}

// §A1.17 Phase O: "make an API for the whole platform — what a builder/user can do manually, an
// agent can do the same way, through the same routes." An agent authenticates with its own
// Bearer nak_... key (minted per agents/:agentId/api-keys, workers/spaces) against ANY
// /spaces/:spaceId/... route — deliberately broad (not a narrow allowlist like
// PRODUCT_END_USER_PATH_PATTERNS above) because the whole point is the agent gets the same
// surface a human builder has, just attributed to itself. What's actually money/identity-
// sensitive is protected by the mutating-action approval gate below, not by narrowing which
// routes an agent key can reach.
function matchAgentSpacePath(path: string): string | null {
  const stripped = path.replace(/^\/v1(?=\/|$)/, "") || "/";
  const m = /^\/spaces\/([^/]+)(?:\/|$)/.exec(stripped);
  return m ? m[1]! : null;
}

/** Verify a Bearer nak_... agent key against the space's SpaceDO (via the spaces worker's
 *  internal verify endpoint), returning router-shaped claims plus the agent's effective
 *  approval policy in the same round trip — see SpaceDO.resolveAgentPolicy. */
async function resolveAgentApiKeyClaims(
  env: Env,
  spaceId: string,
  apiKey: string
): Promise<{ claims: NaelaoJwtClaims; approval: { mode: "always_ask" | "yolo"; autoApproved: string[] } } | null> {
  const res = await env.SPACES_WORKER.fetch(
    new Request("http://spaces/internal/agent-keys/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-platform-secret": env.PLATFORM_SECRET },
      body: JSON.stringify({ spaceId, key: apiKey }),
    })
  );
  if (!res.ok) return null;
  const result = await res.json<{
    valid: boolean; tenant_id?: string; agent_id?: string;
    approval_mode?: "always_ask" | "yolo"; auto_approved_actions?: string[];
  }>();
  if (!result.valid || !result.tenant_id || !result.agent_id) return null;

  const now = Math.floor(Date.now() / 1000);
  return {
    claims: {
      sub: result.agent_id, tid: result.tenant_id, email: "", role: "agent", scopes: [],
      iat: now, exp: now + 3600, jti: "",
    },
    approval: { mode: result.approval_mode ?? "always_ask", autoApproved: result.auto_approved_actions ?? [] },
  };
}

/** Coarse action name a mutating agent request maps to for the approval gate —
 *  "METHOD:firstSegmentAfterSpaceId" (e.g. POST /spaces/S/projects -> "POST:projects"). Coarse
 *  by design: matches the granularity agents.md's own requires_approval_for list already uses
 *  for script actions, not a full URL-per-permission model. */
function agentActionKey(method: string, path: string, spaceId: string): string {
  const stripped = path.replace(/^\/v1(?=\/|$)/, "") || "/";
  const rest = stripped.slice(`/spaces/${spaceId}`.length).replace(/^\//, "");
  return `${method.toUpperCase()}:${rest.split("/")[0] || ""}`;
}

// ── Protected API routes ─────────────────────────────────────────────────────
const api = new Hono<{ Bindings: Env }>();
api.use("*", async (c, next) => {
  const authHeader = c.req.header("authorization") ?? "";
  const headerMatch = /^Bearer\s+(nps_\S+)$/.exec(authHeader);
  // The browser's native EventSource API cannot set custom headers, so the SSE stream endpoint
  // (.../agent/runs/:runId/stream) has no way to carry a Bearer header — accept the same
  // credentials as query params for GET requests as the standard, accepted workaround. Header
  // form still wins when both are present.
  const queryToken = c.req.query("session_token");
  const queryEndUserId = c.req.query("end_user_id");
  const sessionToken = headerMatch?.[1] ?? (c.req.method === "GET" && queryToken?.startsWith("nps_") ? queryToken : undefined);
  const endUserId = c.req.header("x-naelao-end-user-id") ?? (c.req.method === "GET" ? queryEndUserId : undefined);
  const productId = matchProductEndUserPath(c.req.path);

  if (sessionToken && endUserId && productId) {
    const claims = await resolveProductEndUserClaims(c.env, productId, endUserId, sessionToken);
    if (!claims) throw unauthorized("Invalid or expired product session");
    c.set("claims", claims);
    return next();
  }

  const agentKeyMatch = /^Bearer\s+(nak_\S+)$/.exec(authHeader);
  const agentSpaceId = agentKeyMatch ? matchAgentSpacePath(c.req.path) : null;
  if (agentKeyMatch && agentSpaceId) {
    const resolved = await resolveAgentApiKeyClaims(c.env, agentSpaceId, agentKeyMatch[1]!);
    if (!resolved) throw unauthorized("Invalid or expired agent API key");
    c.set("claims", resolved.claims);
    c.set("agentApproval", { mode: resolved.approval.mode, autoApproved: resolved.approval.autoApproved });
    return next();
  }

  // Not a product end-user or agent-key request (or missing required pieces for one) — fall
  // through to the ordinary platform JWT path. A Bearer nps_/nak_ token on a non-matching path
  // is rejected here, same as any other malformed/foreign token.
  return jwtAuth((cc) => (cc as unknown as { env: Env }).env.JWT_SECRET)(c, next);
});

// §A1.17 Phase O: "agents are given a default API key that requires approval for actions — but
// the user can always change that." An agent's mutating request (POST/PUT/PATCH/DELETE) is
// gated exactly like the in-loop HITL gate (loop.ts's gate_unless_listed): allowed straight
// through under 'yolo' or when its coarse action key is in auto_approved_actions; otherwise it
// opens a (longer-lived, non-30s-auto-reject) HITLApprovalDO request, fires approval.requested
// (which wakes the Space Assistant to notify the owner over its configured channel — see
// NaelaoAgentDO.notifyApprovalRequested), and returns 202 instead of proxying. The agent's own
// caller (its script, or the @naelao/agent-sdk wrapper around this API) polls
// GET /spaces/:spaceId/approvals/:id and, once approved, resubmits the SAME request with an
// `X-Naelao-Approval-Id` header — checked and single-use-consumed by the second branch below.
api.use("*", async (c, next) => {
  const claims = c.get("claims");
  const approval = c.get("agentApproval");
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method);
  if (claims?.role !== "agent" || !approval || !isMutating) return next();

  const spaceId = matchAgentSpacePath(c.req.path);
  if (!spaceId) return next();
  const actionKey = agentActionKey(c.req.method, c.req.path, spaceId);
  const preApproved = approval.mode === "yolo" || approval.autoApproved.includes(actionKey);
  if (preApproved) return next();

  const internalToken = await mintInternalToken(c.env.PLATFORM_SECRET, claims.tid);
  const approvalIdHeader = c.req.header("x-naelao-approval-id");
  if (approvalIdHeader) {
    const consumeRes = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/agent-approvals/consume", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": claims.tid, "x-naelao-internal-token": internalToken },
      body: JSON.stringify({ spaceId, approvalId: approvalIdHeader, agentId: claims.sub, actionKey }),
    }));
    if (consumeRes.ok) {
      const { consumed } = await consumeRes.json<{ consumed: boolean }>();
      if (consumed) return next();
    }
    return c.json({ error_code: "approval_not_ready", message: "Approval is not approved (or already used) for this exact action" }, 409);
  }

  const createRes = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/agent-approvals", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": claims.tid, "x-naelao-internal-token": internalToken },
    body: JSON.stringify({
      spaceId, tenantId: claims.tid, agentId: claims.sub, actionKey,
      description: `Agent '${claims.sub}' wants to ${c.req.method} ${c.req.path}`,
    }),
  }));
  if (!createRes.ok) {
    return c.json({ error_code: "approval_unavailable", message: "Could not create an approval request" }, 503);
  }
  const { approval_id, poll_url } = await createRes.json<{ approval_id: string; poll_url: string }>();
  return c.json({ status: "pending_approval", approval_id, poll_url }, 202);
});

// G-AX27: Replay attack prevention — timestamp skew + nonce dedup
api.use("*", async (c, next) => {
  if (c.env.NONCE_STORE) {
    const result = await checkReplayPrevention(c.req.raw, c.env.NONCE_STORE);
    if (!result.ok) {
      return c.json({ error_code: "replay_detected", message: result.reason }, 400);
    }
  }
  return next();
});

// G-AX12: Token bucket rate limiting per authenticated user
// Default: 120 requests/minute (2× smoother than fixed 60-window)
const DEFAULT_RATE_LIMIT = 120;
api.use("*", async (c, next) => {
  if (!c.env.RATE_LIMIT_DO) return next();
  const claims = c.get("claims");
  // F7: X-Forwarded-For is client-supplied on the first hop — an unauthenticated attacker can
  // rotate it to mint unlimited fresh buckets (bypass) or converge onto a victim's IP (targeted
  // starvation). cf-connecting-ip is set by Cloudflare's edge and cannot be spoofed by the
  // client. Sharding by idFromName(bucketKey) (was a single "global-rate-limiter" DO for the
  // whole platform) also means each key gets its own DO instead of serializing all traffic
  // through one chokepoint.
  const bucketKey = claims?.sub ?? c.req.header("cf-connecting-ip") ?? "anonymous";
  const doId = c.env.RATE_LIMIT_DO.idFromName(bucketKey);
  const stub = c.env.RATE_LIMIT_DO.get(doId);
  try {
    const rl = await stub.fetch("http://do/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: bucketKey, limit: DEFAULT_RATE_LIMIT }),
    });
    const result = await rl.json<{ allowed: boolean; remaining: number; retry_after_ms: number }>();
    if (!result.allowed) {
      return c.json(
        { error_code: "rate_limited", message: "Too many requests", retry_after_ms: result.retry_after_ms },
        429
      );
    }
    // Surface remaining quota in response headers (set after response via header)
    c.header("X-RateLimit-Limit", String(DEFAULT_RATE_LIMIT));
    c.header("X-RateLimit-Remaining", String(result.remaining));
  } catch {
    // Rate limiter unavailable — fail open to avoid blocking all traffic
  }
  return next();
});

// G-BA02: Tenant resource quota enforcement at ingress.
// Reads cached quota status from KV (written by billing/usage workers every 60s).
// Key: quota:{tenantId}:blocked → "1" | absent
// Grace: 5% overage is allowed; only hard-blocked tenants are rejected.
// Fails open — if KV unavailable, request passes through.
api.use("*", async (c, next) => {
  if (!c.env.QUOTA_CACHE) return next();
  const claims = c.get("claims");
  const tenantId = claims?.tid ?? "";
  if (!tenantId) return next();

  try {
    const blocked = await c.env.QUOTA_CACHE.get(`quota:${tenantId}:blocked`);
    if (blocked === "1") {
      const detail = await c.env.QUOTA_CACHE.get(`quota:${tenantId}:detail`);
      let detailObj: Record<string, unknown> = {};
      try { detailObj = detail ? JSON.parse(detail) : {}; } catch { /* ignore */ }
      return c.json({
        error_code: "quota_exceeded",
        message: "Tenant resource quota exceeded — upgrade plan or contact support",
        detail: detailObj,
      }, 429);
    }
  } catch {
    // Fail open — quota check errors never block requests
  }
  return next();
});

// G-AD02: Token version check — reject tokens whose version is behind the DB value.
// Uses 5s in-memory cache to avoid a D1 read on every request.
api.use("*", async (c, next) => {
  const claims = c.get("claims");
  if (claims?.tv !== undefined) {
    const valid = await checkTokenVersion(c.env.PLATFORM_DB, claims.sub, claims.tv);
    if (!valid) {
      return c.json(
        { error_code: "token_revoked", message: "Session has been revoked" },
        401
      );
    }
  }
  return next();
});

// G-I01: Sign inter-worker requests with HMAC so downstream workers can verify origin
async function proxyTo(
  worker: Fetcher,
  claims: NaelaoJwtClaims | undefined,
  req: Request,
  platformSecret: string,
): Promise<Response> {
  const headers = new Headers(req.headers);
  // B2 fix: strip client-supplied identity/internal headers UNCONDITIONALLY before setting
  // them from verified claims below. Previously these were only overwritten inside
  // `if (claims)`, so any route reachable without auth would forward the caller's own
  // (attacker-controlled) x-naelao-tenant-id / x-naelao-role straight through to the
  // downstream worker, which trusts them as-is.
  headers.delete("x-naelao-tenant-id");
  headers.delete("x-naelao-user-id");
  headers.delete("x-naelao-role");
  headers.delete("x-naelao-scopes");
  headers.delete("x-naelao-internal-token");
  // WS-7 (audit plan): x-naelao-end-user-id was never stripped here — a latent client-controlled
  // identity header (not an active authz bypass today, since the business gate keys off
  // x-naelao-user-id, but closed for defense in depth). Genuinely-public routes that accept an
  // end_user_id with no JWT at all (GDPR /me/export) already read it from the query string first
  // (`?end_user_id=`), same precedent as the SSE stream endpoint's ?session_token=&end_user_id=
  // — so stripping the header here doesn't break their intended, documented usage.
  headers.delete("x-naelao-end-user-id");
  const ts = Date.now().toString();
  if (claims) {
    headers.set("x-naelao-tenant-id", claims.tid);
    headers.set("x-naelao-user-id", claims.sub);
    headers.set("x-naelao-role", claims.role);
    headers.set("x-naelao-scopes", claims.scopes.join(","));
    if (claims.role === "product_end_user") {
      headers.set("x-naelao-end-user-id", claims.sub);
    }
    const sig = await signHmac(`internal:${claims.tid}:${ts}`, platformSecret);
    headers.set("x-naelao-internal-token", `t=${ts},v1=${sig}`);
  }
  // Strip the /v1 mount prefix so downstream workers (which define routes WITHOUT
  // /v1, e.g. /spaces, /business) actually match. Mirrors the auth-route rewrite.
  const u = new URL(req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return worker.fetch(new Request(u.toString(), {
    method: req.method,
    headers,
    body: req.body,
  }));
}

// Knowledge (KB) → knowledge worker
// S0.1: For product_end_user callers, verify business membership first.
api.all("/spaces/:spaceId/kb/*", async (c) => {
  const claims = c.get("claims") as NaelaoJwtClaims | undefined;
  if (claims?.role === "product_end_user") {
    const spaceId = c.req.param("spaceId");
    const endUserId = claims.sub;
    const token = await mintInternalToken(c.env.PLATFORM_SECRET, claims.tid);
    const res = await c.env.SPACES_WORKER.fetch(
      new Request(`http://spaces/internal/business-role?spaceId=${encodeURIComponent(spaceId)}&endUserId=${encodeURIComponent(endUserId)}`, {
        method: "GET",
        headers: { "x-naelao-tenant-id": claims.tid, "x-naelao-internal-token": token },
      })
    );
    if (!res.ok) {
      return c.json({ error_code: "forbidden", message: "Not a member of this business" }, 403);
    }
  }
  return proxyTo(c.env.KNOWLEDGE_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET);
});

// Credentials (per-user / per-space / privileged-override hierarchy) → credentials worker.
// Never proxy /internal/* here — internal credential resolution is service-binding-only.
api.all("/spaces/:spaceId/credentials", async (c) =>
  proxyTo(c.env.CREDENTIALS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/credentials/:credId", async (c) =>
  proxyTo(c.env.CREDENTIALS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

// Three-Tier Platform Model, Phase 6: found and fixed a real routing mismatch here — every
// /spaces/:spaceId/sessions/* request was sent to AGENTS_WORKER, but session CREATE and
// message GET/POST are implemented in the SPACES worker (forwarded to SpaceDO, gated by
// requireInternalHmac — see workers/spaces/src/index.ts's SpaceDO session proxy comment).
// AGENTS_WORKER only implements the agent-run sub-paths (kicking off/polling/streaming the
// actual reasoning loop) and approvals — never session/message CRUD itself. Previously this
// meant startSession()/getMessages()/sendMessage()'s first step 404'd even once auth was fixed.
// The more specific agent/approvals sub-paths are registered FIRST so they win over the general
// catch-all below.
api.all("/spaces/:spaceId/sessions/:sessionId/agent/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/sessions/:sessionId/approvals/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/sessions/:sessionId/approvals", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

// Session + message CRUD (session create/get, message get/post, feedback) → spaces worker,
// which owns this via SpaceDO. proxyTo already mints the x-naelao-internal-token
// requireInternalHmac checks there, using claims.tid (the product's owning tenant for a
// product_end_user, or the real tenant for a Team collaborator) — no separate gate needed here.
api.all("/spaces/:spaceId/sessions/*", async (c) =>
  proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/sessions", async (c) =>
  proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

// First-run bootstrap (create projects + run setup scripts) → agents worker
api.all("/spaces/:spaceId/bootstrap/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

// Apply a customer-bot project template (WhatsApp/Discord/email support bot) → agents worker
// (it composes the call across the spaces worker's project endpoints + seeds starter rules).
api.all("/spaces/:spaceId/projects/from-template", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

// Customer-bot channel observability + human-takeover admin control → agents worker
// (proxies straight through to the space's agent DO).
api.all("/spaces/:spaceId/channels/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

// WS-2: Space Assistant surface read-only panels (Memory/Channels/Sub-agents/Files) → agents
// worker, which owns the NaelaoAgentDO forwarding + R2 workspace listing for these.
api.all("/spaces/:spaceId/assistant/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

// Spaces CRUD → spaces worker
// F15: this catch-all MUST be registered AFTER every specific /spaces/:spaceId/... route
// above. Hono dispatches to the first matching handler in registration order, and none of
// the proxy handlers call next() — so if this were registered first (as it originally was),
// it would swallow every /spaces/:spaceId/kb, /credentials, /sessions, /bootstrap,
// /projects/from-template, and /channels request before the specific routes ever got a look.
api.all("/spaces/*", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/spaces", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// Reseller / partner endpoints → spaces worker (G-AS34/G-AS35)
api.all("/reseller/*", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/reseller", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// Launchpad / Whop Businesses (the one live niche) → agents worker.
// Catalog (roadmap), product config, and per-user business endpoints.
api.all("/catalog/*", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/product/*", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/business/*", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// External-platform connectors (catalogue + connect flow) → agents worker.
api.all("/connectors/*", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/connectors", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// Federated template learning (promote / inherit shared skills) → agents worker.
api.all("/skills/*", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/templates/*", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// Multi-channel gateway connect flow (authenticated; the public inbound webhook is registered
// above, before the JWT gate) → agents worker.
api.all("/channels/:channel/connect", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// Customer-bot project template catalogue → agents worker.
api.all("/project-templates", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

app.route("/v1", api);

// ── Error handler ────────────────────────────────────────────────────────────
app.onError((err, c) => {
  const reqId = c.get("requestId") ?? "unknown";
  return errorResponse(err, reqId);
});

app.notFound((c) => {
  return c.json(
    { error_code: "not_found", message: "Route not found", request_id: c.get("requestId") },
    404
  );
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
