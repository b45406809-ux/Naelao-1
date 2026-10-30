import { Hono } from "hono";
import { requestId, jwtAuth, errorResponse, unauthorized, mintInternalToken, readDeskSession } from "@naelao/http";
import { signHmac } from "@naelao/crypto";
import type { NaelaoJwtClaims } from "@naelao/types";
import { loadSavedLanguagePreference } from "./preferred-language";
import { transcribeAudio } from "./routes/transcribe";
import { readBoundedRequestBytes } from "./routes/bounded-request-body";
import { isErasureLifecycleAccess, isTenantActive } from "./tenant-status";
export { RateLimitDO } from "./RateLimitDO";

export interface Env {
  ENVIRONMENT: string;
  JWT_SECRET: string;
  PLATFORM_SECRET: string;
  CORS_ALLOWLIST?: string;
  /** Apex domain product subdomains hang off, e.g. "naelao.com" → {slug}.naelao.com. Used only
   *  by the dynamic CORS origin resolver (isDynamicOriginAllowed); defaults to "naelao.com". */
  PRODUCT_SUBDOMAIN_APEX?: string;
  SESSION_REVOCATION: KVNamespace;
  CONFIG: KVNamespace;
  NONCE_STORE: KVNamespace;
  QUOTA_CACHE: KVNamespace;
  PLATFORM_DB: D1Database;
  RATE_LIMIT_DO: DurableObjectNamespace;
  SPACES_WORKER: Fetcher;
  KNOWLEDGE_WORKER: Fetcher;
  EVAL_WORKER: Fetcher;
  AGENTS_WORKER: Fetcher;
  AUTH_WORKER: Fetcher;
  CREDENTIALS_WORKER: Fetcher;
  ANALYTICS_WORKER?: Fetcher;
  /** F-2: billing worker — the public Lemon Squeezy webhook ingress proxies here. */
  BILLING_WORKER?: Fetcher;
  MARKETPLACE_WORKER?: Fetcher;
  /** Owner/admin portal domain mapping API; public requests still pass through JWT auth. */
  PORTAL_ROUTER?: Fetcher;
  AI: Ai;
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

  const ts = Number.parseInt(tsHeader, 10);
  if (Number.isNaN(ts)) return { ok: false, reason: "x-naelao-timestamp must be a unix epoch integer" };

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

// G-AD02: In-memory per-user token version cache (5s TTL, 2000-entry LRU cap).
// Map key: userId, value: { version, expiresAt }
// The cap prevents unbounded growth in long-lived isolates with many distinct users — evicts
// the oldest entry (insertion order, Map iteration guarantees) when the limit is reached.
const tokenVersionCache = new Map<string, { version: number; expiresAt: number }>();
const TOKEN_VERSION_CACHE_TTL_MS = 5_000;
const TOKEN_VERSION_CACHE_MAX = 2000;

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
    if (tokenVersionCache.size >= TOKEN_VERSION_CACHE_MAX) {
      // Evict the oldest entry (Map iterates in insertion order).
      const oldest = tokenVersionCache.keys().next().value;
      if (oldest !== undefined) tokenVersionCache.delete(oldest);
    }
    tokenVersionCache.set(userId, { version: currentVersion, expiresAt: Date.now() + TOKEN_VERSION_CACHE_TTL_MS });
  }

  return claimedVersion === currentVersion;
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

// Security audit follow-up: CORS_ALLOWLIST was one static platform-wide env var — fine for the
// two fixed platform frontends (dashboard, portal) but can't scale to arbitrary Space
// custom domains or even the platform's own {slug}.naelao.com subdomains (which were
// never added to it at all — apps/shell, the Product Shell every end user uses, would have been
// CORS-blocked in a real deployment). Resolves dynamically against spaces.product_slug and
// space_domains.domain, cached in KV (60s TTL — this platform's own stated KV
// eventual-consistency window) so this doesn't cost a D1 round trip on every single request once
// warm. Degrades to the static allowlist only when PLATFORM_DB/CONFIG aren't wired (tests, or a
// deploy that hasn't set them) rather than erroring — CORS denial is already the safe default.
const CORS_CACHE_TTL_S = 60;

function productSubdomainSlug(hostname: string, apex: string): string | null {
  if (!hostname.endsWith(`.${apex}`)) return null;
  const label = hostname.slice(0, -(apex.length + 1));
  // A leaf label only — "acme.shell.naelao.com" must not match as slug "acme.shell".
  if (!label || label.includes(".")) return null;
  return label;
}

async function isDynamicOriginAllowed(env: Env, origin: string): Promise<boolean> {
  if (!env.PLATFORM_DB) return false;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }

  const cacheKey = `cors:origin:${hostname}`;
  if (env.CONFIG) {
    const cached = await env.CONFIG.get(cacheKey).catch(() => null);
    if (cached === "1") return true;
    if (cached === "0") return false;
  }

  let allowed = false;
  const apex = env.PRODUCT_SUBDOMAIN_APEX ?? "naelao.com";
  const slug = productSubdomainSlug(hostname, apex);
  if (slug) {
    const row = await env.PLATFORM_DB.prepare(
      "SELECT id FROM spaces WHERE product_slug = ? AND status = 'active'"
    ).bind(slug).first<{ id: string }>().catch(() => null);
    allowed = !!row;
  }
  if (!allowed) {
    const row = await env.PLATFORM_DB.prepare(
      "SELECT id FROM space_domains WHERE domain = ? AND status = 'active'"
    ).bind(hostname).first<{ id: string }>().catch(() => null);
    allowed = !!row;
  }

  if (env.CONFIG) {
    await env.CONFIG.put(cacheKey, allowed ? "1" : "0", { expirationTtl: CORS_CACHE_TTL_S }).catch(() => {});
  }
  return allowed;
}

// F11: cors(["*"]) allowed any origin to drive cross-origin requests carrying a Bearer JWT.
// The static allowlist is env-driven (CORS_ALLOWLIST, comma-separated) because it must be read
// per request from c.env — a static cors(...) factory bakes its list in at module-load time,
// before env is available. Never echo "*" — only an exact allowlisted (or dynamically resolved)
// origin, or nothing.
app.use("*", async (c, next) => {
  const origin = c.req.header("origin") ?? "";
  const allowlist = (c.env.CORS_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = origin && (allowlist.includes(origin) || await isDynamicOriginAllowed(c.env, origin)) ? origin : "";

  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id, X-Naelao-End-User-Id",
        "Access-Control-Max-Age": "86400",
        // F-6: the allowed origin is computed per-request (dynamic allowlist), so a shared cache
        // MUST vary on Origin or it could serve one origin's ACAO header to a different origin.
        "Vary": "Origin",
      },
    });
  }
  await next();
  // Routes that proxy a service-binding fetch() response directly through (proxyTo,
  // proxyBillingWebhook, and every route built on them — i.e. most of this router) return a
  // Response whose headers the Workers runtime treats as immutable once the body has started
  // streaming back to the client. Mutating c.res.headers in place then throws "Can't modify
  // immutable headers", turning every proxied route's own successful response into a generic 500
  // from app.onError — a genuine, previously-undetected bug affecting nearly every route in this
  // file, only surfaced once a real end-to-end call hit the deployed router.
  // `new Response(body, otherResponse)` does NOT reliably give a fresh, mutable Headers instance
  // in workerd (it links back to the same immutable object) — build a genuinely new `Headers()`
  // and copy entries into it explicitly instead of trusting the Response constructor to clone.
  const freshHeaders = new Headers();
  for (const [k, v] of c.res.headers.entries()) freshHeaders.append(k, v);
  // F-6: same reason — the response's ACAO reflects the request Origin, so mark it Vary: Origin.
  freshHeaders.append("Vary", "Origin");
  if (allowed) freshHeaders.set("Access-Control-Allow-Origin", allowed);
  if (allowed) freshHeaders.set("Access-Control-Allow-Credentials", "true");
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: freshHeaders });
  return;
});
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// ── Health check (unauthenticated) ───────────────────────────────────────────
app.get("/health", (c) =>
  c.json({ status: "ok", env: c.env.ENVIRONMENT, ts: Date.now() })
);

// A service-level canary complements the router's own health check. Keep this bounded to
// fixed internal health paths and return only service names/status codes, never response bodies.
app.get("/health/dependencies", async (c) => {
  const checks = [
    ["auth", c.env.AUTH_WORKER],
    ["spaces", c.env.SPACES_WORKER],
  ] as const;
  const results = await Promise.all(checks.map(async ([service, worker]) => {
    const startedAt = Date.now();
    try {
      const response = await worker.fetch(new Request("http://internal/health", {
        method: "GET",
        signal: AbortSignal.timeout(2_500),
      }));
      return { service, status: response.status, latency_ms: Date.now() - startedAt, ok: response.ok };
    } catch {
      return { service, status: 0, latency_ms: Date.now() - startedAt, ok: false };
    }
  }));
  const ok = results.every((result) => result.ok);
  return c.json({ ok, services: results }, ok ? 200 : 503);
});
for (const path of ["/v1/marketplace", "/v1/marketplace/:id", "/v1/marketplace/:id/reviews"]) app.get(path, async c => {
  if (!c.env.MARKETPLACE_WORKER) return c.json({ error_code: "marketplace_unavailable" }, 503);
  return c.env.MARKETPLACE_WORKER.fetch(new Request(c.req.url, { method: "GET" }));
});
// Public ticket redemption authenticates itself; internal issuance is never proxied here.
app.all("/v1/desk-drop/:action", async c => {
  if (!["redeem", "session", "logout", "challenge", "status"].includes(c.req.param("action"))) return c.json({ error_code: "not_found" }, 404);
  const limited = await checkPreAuthRateLimit(c, "desk-drop", 20);
  if (!limited.allowed) return c.json({ error_code: "rate_limited" }, 429);
  if (c.req.method !== "GET") {
    const origin = c.req.header("origin");
    const ownOrigin = new URL(c.req.url).origin;
    const allowed = origin === ownOrigin || !!origin && ((c.env.CORS_ALLOWLIST ?? "").split(",").map(v => v.trim()).includes(origin) || await isDynamicOriginAllowed(c.env, origin));
    if (!allowed) return c.json({ error_code: "origin_required" }, 403);
  }
  const url = new URL(c.req.url); url.pathname = url.pathname.replace(/^\/v1/, "");
  let body: Uint8Array | undefined;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    try { body = await readBoundedRequestBytes(c.req.raw, 64 * 1024); }
    catch { return c.json({ error_code: "payload_too_large" }, 413); }
  }
  return c.env.SPACES_WORKER.fetch(new Request(url, { method: c.req.method, headers: c.req.raw.headers, ...(body ? { body } : {}) }));
});

// Browser dictation intentionally has its own small, rate-limited media endpoint. It accepts no
// caller-selected model or prompt, so user audio can only reach the fixed Whisper binding.
app.post("/api/voice/transcribe", async (c) => {
  const limited = await checkPreAuthRateLimit(c, "voice-transcribe", 30);
  if (!limited.allowed) return c.json({ ok: false, error: "Too many transcription requests", retry_after_ms: limited.retryAfterMs }, 429);
  return transcribeAudio(c.req.raw, c.env);
});

// Launch-readiness audit follow-up: /v1/auth/* had ZERO pre-auth rate limiting at all — login
// (brute-force) and register (account-farming) were both completely unthrottled, and the new
// password-reset routes below are an equally real brute-force/spam target. Same per-route-suffix
// budget pattern as END_USER_ROUTE_LIMITS further down.
const AUTH_ROUTE_LIMITS: Record<string, [routeKey: string, limit: number]> = {
  login: ["builder-login", 10],
  register: ["builder-register", 5],
  "request-password-reset": ["builder-reset-request", 5],
  "reset-password": ["builder-reset-confirm", 10],
  verify: ["builder-token-verify", 30],
  revoke: ["builder-token-revoke", 10],
};

// ── Auth routes (forwarded to auth worker) ───────────────────────────────────
app.all("/v1/auth/*", async (c) => {
  const url = new URL(c.req.url);
  const suffix = Object.keys(AUTH_ROUTE_LIMITS).find((s) => url.pathname.endsWith(`/${s}`));
  const authLimits = suffix ? AUTH_ROUTE_LIMITS[suffix] : undefined;
  if (authLimits) {
    const [routeKey, limit] = authLimits;
    const rl = await checkPreAuthRateLimit(c, routeKey, limit);
    if (!rl.allowed) {
      return c.json({ error_code: "rate_limited", message: "Too many requests", retry_after_ms: rl.retryAfterMs }, 429);
    }
  }
  const downstream = new URL(url.pathname.replace("/v1/auth", ""), "http://auth");
  downstream.search = url.search;
  return c.env.AUTH_WORKER.fetch(
    new Request(downstream.toString(), {
      method: c.req.method,
      // duplex: "half" is required by spec-compliant fetch implementations (Node's undici, used
      // by this repo's own tests) whenever a streaming body is attached — same fix already
      // applied to the session proxy and the end-users proxy.
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      duplex: "half",
    } as RequestInit)
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

// ── Public "Connect with X" OAuth callback (unauthenticated; the single-use ticket in `state`
// is the auth) ── Whop (and any future oauth-capable connector) redirects the raw BROWSER here
// with no Naelao credential attached at all — same posture as the webhook ingress above, and
// registered the same way (before the authenticated api group).
app.all("/v1/connectors/:platform/oauth/callback", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.AGENTS_WORKER.fetch(
    new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body })
  );
});

// Project extension provider callbacks use a short-lived single-use state ticket as their auth.
app.all("/v1/extensions/oauth/slack/callback", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.AGENTS_WORKER.fetch(new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body, duplex: "half" } as RequestInit));
});

// ── Public Composio "click Install" connect callback (unauthenticated; the single-use `ticket`
// query param is the auth) ── same posture/registration as the OAuth callback above — Composio
// redirects the raw browser here with no Naelao credential attached.
app.all("/v1/connectors/:platform/provider-connect/callback", async (c) => {
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

// Telegram bots installed for project extensions have their own secret-verified, installation-
// scoped webhook path. It must stay outside the JWT-gated API group like the shared ingress.
app.all("/v1/channels/telegram/extensions/:spaceId/:installationId/:connectionId", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.AGENTS_WORKER.fetch(new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body, duplex: "half" } as RequestInit));
});

// Meta sends WhatsApp Cloud API webhooks to one app-level callback, which is authenticated by
// Meta's signature and then routed by the verified phone-number ID to one active installation.
app.all("/v1/channels/whatsapp/extensions", async c => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.AGENTS_WORKER.fetch(new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body, duplex: "half" } as RequestInit));
});

// Scan-to-connect (launchpad/channel-pairing.ts): the same public posture, for Naelao's OWN app on
// each channel. There is no :spaceId here on purpose — a message arriving at the platform bot
// carries only the channel's id for the conversation, and the agents worker resolves the business
// from its pairing table. `pair-callback` is where Slack and Discord send the browser back after
// an install; its single-use `state` token is the auth, exactly like the connector callback.
app.all("/v1/channels/platform-inbound/:channel", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.AGENTS_WORKER.fetch(
    new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body })
  );
});
app.all("/v1/channels/pair-callback/:channel", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.AGENTS_WORKER.fetch(
    new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body })
  );
});

// ── F-2: Public Lemon Squeezy webhook ingress (unauthenticated; the LS HMAC signature is the auth) ──
// Platform subscriptions and FDE marketplace settlement depend
// on this: a buyer pays at Lemon Squeezy → LS POSTs the event here → the billing worker verifies
// the LEMON_SQUEEZY_WEBHOOK_SECRET signature and settles. Without this route the webhook 404'd and
// every purchase silently never fulfilled. Registered BEFORE the JWT-gated api group, same pattern
// as the connector/channel webhooks above. The `/v1` mount prefix is stripped so the billing worker
// sees its own `/webhooks/lemon-squeezy` path.
app.all("/v1/webhooks/lemon-squeezy", async (c) => {
  if (!c.env.BILLING_WORKER) return c.json({ error_code: "billing_unavailable", message: "Billing worker not configured" }, 503);
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.BILLING_WORKER.fetch(
    new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body, duplex: "half" } as RequestInit)
  );
});

// ── Whop platform-plan webhook ingress (unauthenticated; Whop-Signature HMAC is the auth) ──
// Naelao's OWN normal Whop seller company's webhook (builder Growth/Business plans) — a
// Webhook ingress for Naelao's subscription provider. It is separate from generic Whop MCP
// connections users configure inside their Spaces.
app.all("/v1/webhooks/whop-platform-plan", async (c) => {
  if (!c.env.BILLING_WORKER) return c.json({ error_code: "billing_unavailable", message: "Billing worker not configured" }, 503);
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return c.env.BILLING_WORKER.fetch(
    new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body, duplex: "half" } as RequestInit)
  );
});

// Security audit follow-up: the authenticated `api` group's rate limiter (G-AX12, below) only
// covers routes registered AFTER it — every route in this unauthenticated block runs before
// that middleware exists in the chain, so none of it was ever rate limited. That's the exact
// surface an attacker reaches with no credential at all: unlimited password-guessing against
// end-users/login, and unlimited free-credit-grant signups against end-users/signup (each new
// email mints a fresh ProductUserDO with its own signup allowance — see
// product-end-user-routes.ts). Shards the same way the authenticated limiter does
// (idFromName(bucketKey), keyed on the edge-set cf-connecting-ip since there's no claims.sub
// yet) but fails CLOSED here — an attacker able to make the rate limiter itself unavailable
// must not get an unthrottled credential-guessing or free-credit oracle out of it.
export async function checkPreAuthRateLimit(
  c: { env: Env; req: { header: (name: string) => string | undefined } },
  routeKey: string,
  limit: number
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  if (!c.env.RATE_LIMIT_DO) return { allowed: false, retryAfterMs: 30_000 };
  const ip = c.req.header("cf-connecting-ip");
  // If the edge-set IP header is absent (e.g. misconfigured routing), fall back to a random
  // per-request UUID so the request always passes through without creating a shared "unknown"
  // bucket that would lock out ALL anonymous traffic on limiter error. The IP is not trusted
  // anyway when absent — the caller still has to pass subsequent credential checks.
  const bucketKey = `preauth:${routeKey}:${ip ?? crypto.randomUUID()}`;
  const doId = c.env.RATE_LIMIT_DO.idFromName(bucketKey);
  const stub = c.env.RATE_LIMIT_DO.get(doId);
  try {
    const rl = await stub.fetch("http://do/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: bucketKey, limit }),
    });
    const result = await rl.json<{ allowed: boolean; retry_after_ms: number }>();
    return { allowed: result.allowed, retryAfterMs: result.retry_after_ms };
  } catch {
    // Fail CLOSED for pre-auth surfaces (unlike the authenticated limiter below, which fails
    // open) — this is exactly the credential-guessing / signup-farming oracle a rate limiter
    // outage must not hand an attacker.
    return { allowed: false, retryAfterMs: 30_000 };
  }
}

// ── Three-Tier Platform Model, Phase 6: product end-user signup/login (unauthenticated — a
// visitor has no token at all before this) ── Journey 1B: "End user signs up... via the
// builder's configured auth provider." Registered before the JWT-gated api group, same
// reasoning as /v1/auth/* above.
// Per-route pre-auth rate limit budgets (requests/min per cf-connecting-ip), keyed by URL suffix
// → [bucket name, limit]. Login/signup/reset-request/verification-resend are all farming or
// brute-force targets — deliberately tighter than a generic pre-auth read like by-slug (see
// checkPreAuthRateLimit below for by-slug/manifest).
const END_USER_ROUTE_LIMITS: Record<string, [routeKey: string, limit: number]> = {
  "end-users/login": ["end-user-login", 10],
  "end-users/signup": ["end-user-signup", 5],
  "end-users/request-password-reset": ["end-user-reset-request", 5],
  "end-users/reset-password": ["end-user-reset-confirm", 10],
  "end-users/verify-email": ["end-user-verify-email", 10],
  "end-users/resend-verification": ["end-user-resend-verification", 5],
  "end-users/request-whatsapp-login": ["end-user-whatsapp-request", 3],
  "end-users/verify-whatsapp-login": ["end-user-whatsapp-verify", 10],
};

app.all("/v1/spaces/:spaceId/end-users/*", async (c) => {
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  const suffix = Object.keys(END_USER_ROUTE_LIMITS).find((s) => u.pathname.endsWith(`/${s}`));
  const endUserLimits = suffix ? END_USER_ROUTE_LIMITS[suffix] : undefined;
  if (endUserLimits) {
    const [routeKey, limit] = endUserLimits;
    const rl = await checkPreAuthRateLimit(c, routeKey, limit);
    if (!rl.allowed) {
      return c.json({ error_code: "rate_limited", message: "Too many requests", retry_after_ms: rl.retryAfterMs }, 429);
    }
  }
  // duplex: "half" is required by spec-compliant fetch implementations (Node's undici, used by
  // this repo's own tests) whenever a streaming body is attached — same fix already applied to
  // the session proxy and forwardToSpaceDO for the same reason (§A1.17 Phase 6).
  return c.env.SPACES_WORKER.fetch(
    new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body, duplex: "half" } as RequestInit)
  );
});

// Three-Tier Platform Model, Phase A (apps/shell): the shell resolves a product by its
// subdomain-style slug (/p/[slug]) before a visitor has any credential — same reasoning and same
// "strip client-supplied identity headers" precaution as shell/manifest below (the spaces
// worker's handler already returns a fully public-safe projection regardless of caller identity).
app.get("/v1/products/by-slug/:slug", async (c) => {
  const rl = await checkPreAuthRateLimit(c, "by-slug", 60);
  if (!rl.allowed) {
    return c.json({ error_code: "rate_limited", message: "Too many requests", retry_after_ms: rl.retryAfterMs }, 429);
  }
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-naelao-tenant-id");
  headers.delete("x-naelao-user-id");
  headers.delete("x-naelao-role");
  headers.delete("x-naelao-scopes");
  headers.delete("x-naelao-internal-token");
  return c.env.SPACES_WORKER.fetch(
    new Request(u.toString(), {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      duplex: "half",
    } as RequestInit)
  );
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
  const rl = await checkPreAuthRateLimit(c, "shell-manifest", 60);
  if (!rl.allowed) {
    return c.json({ error_code: "rate_limited", message: "Too many requests", retry_after_ms: rl.retryAfterMs }, 429);
  }
  const u = new URL(c.req.url);
  u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-naelao-tenant-id");
  headers.delete("x-naelao-user-id");
  headers.delete("x-naelao-role");
  headers.delete("x-naelao-scopes");
  headers.delete("x-naelao-internal-token");
  return c.env.SPACES_WORKER.fetch(
    new Request(u.toString(), {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      duplex: "half",
    } as RequestInit)
  );
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
// `workers/spaces/src/index.ts` grew a `requireSpaceMembership` gate (business-auth.ts) that
// is additive-only for `product_end_user` — every other role's access is completely unchanged —
// and per-route/per-method: agent-definitions only allows GET for a product_end_user (never a
// write); projects/threads allow GET+POST but NOT the admin-only sub-paths (rules, spend,
// per-project PATCH config) — those stay off this allowlist entirely, so no product_end_user
// request can reach them regardless of what the spaces worker's gate would otherwise allow.
// `/scheduled-jobs` (and its Phase 3 sibling `/scheduled-job-runs`) WAS deliberately excluded
// here for the reason this paragraph used to give — `loadOwnedSpace` alone is tenant-match-only,
// exactly the footgun warned about above (claims.tid is the space's OWNING tenant, so that gate
// would silently accept end-user traffic the moment it's allowlisted). It was given the same
// treatment projects/threads got before being added (see WS-2/the GET route's own comment):
// resolveEndUserSpaceRole on the spaces worker now does the real per-caller authorization.
//
// Business invite/member and child-business lifecycle APIs were retired with the former
// Launchpad business surface. Generic platform-member Space creation uses /spaces instead.
export const PRODUCT_END_USER_PATH_PATTERNS: RegExp[] = [
  /^\/spaces\/([^/]+)\/runtime-catalog$/,
  /^\/spaces\/([^/]+)\/runtime-installations$/,
  /^\/spaces\/([^/]+)\/sessions(\/|$)/,
  /^\/spaces\/([^/]+)\/shell\/manifest$/,
  /^\/spaces\/([^/]+)\/my-spaces$/,
  /^\/spaces\/([^/]+)\/spaces$/,
  /^\/spaces\/([^/]+)\/memberships$/,
  /^\/spaces\/([^/]+)\/template-listings\/([^/]+)\/fork$/,
  /^\/spaces\/([^/]+)\/kb\/(documents|search)(\/|$)/,
  /^\/spaces\/([^/]+)\/product-users\/me$/,
  /^\/spaces\/([^/]+)\/me\/export$/,
  /^\/spaces\/([^/]+)\/me\/data$/,
  /^\/spaces\/([^/]+)\/projects(\/[^/]+)?$/,
  // Phase T (§A1.17): project collaboration — real per-project membership + the exclusive-mode
// thread lock. Additionally gated by the Spaces worker's project membership check; the pattern
// deliberately excludes admin-only routes and does not match project spend/config operations.
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/members(\/[^/]+)?$/,
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/activate-thread$/,
  // F-39: read-only workspace file viewer — a project member browses/views the artifacts their
  // agent wrote to R2. Identity here, real per-project ACL (requireSpaceMembership) on the
  // spaces worker. Read-only GET only; the write side is the agent's, never end-user-reachable.
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/workspace\/files(\/.*)?$/,
  // Visual workflow plan drafts are owner/admin writes; Spaces validates and compiles them.
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/workflows\/plan$/,
  // Signed project-extension install/rollback/release management. These patterns only establish
  // the product session identity; the Spaces/Agents handlers still enforce project membership,
  // owner/admin policy, publisher trust, and exact installation scope.
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/extensions$/,
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/extension-installations\/([^/]+)\/lifecycle$/,
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/extensions\/([^/]+)\/releases$/,
  /^\/spaces\/([^/]+)\/extension-releases\/rollback$/,
  /^\/spaces\/([^/]+)\/extension-publishers(\/[^/]+)?$/,
  // Composed provider connections are installation scoped and re-authorized by Agents.
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/extensions\/([^/]+)\/connections\/([^/]+)(?:\/(?:oauth\/slack\/start|telegram\/connect|whatsapp\/connect|routes(?:\/available)?))?$/,
  // Extension channel installation and operations queue; the downstream worker owns role checks.
  /^\/spaces\/([^/]+)\/channel-extensions$/,
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/channel-extensions$/,
  /^\/spaces\/([^/]+)\/projects\/([^/]+)\/channel-extensions\/([^/]+)(?:\/(?:session-state|inbox(?:\/(?:sla|notes|assign|takeover|delete-conversation|reply|export))?))?$/,
  /^\/spaces\/([^/]+)\/assistant\/channel-extensions$/,
  /^\/spaces\/([^/]+)\/threads(\/[^/]+)?$/,
  /^\/spaces\/([^/]+)\/agent-definitions(\/|$)/,
  /^\/spaces\/([^/]+)\/presence$/,
  /^\/spaces\/([^/]+)\/assistant-communications$/,
  /^\/spaces\/([^/]+)\/assistant-channels$/,
  /^\/spaces\/([^/]+)\/assistant-voice$/,
  /^\/spaces\/([^/]+)\/website-connections$/,
  /^\/spaces\/([^/]+)\/website-browser$/,
  /^\/spaces\/([^/]+)\/blueprints\/([^/]+)\/activate$/,
  /^\/spaces\/([^/]+)\/blueprints\/([^/]+)\/activation-preview$/,
  /^\/spaces\/([^/]+)\/shared-extension-installations\/([^/]+)(?:\/(?:filesystem-grants|lifecycle))?$/,
  // Step 18: the public-within-the-product business directory (all active businesses under this
  // product; safe projection only + an is_mine flag). Identity here (which product's session to
  // verify), authorization there (the route computes is_mine from the caller's own memberships and
  // never leaks owner identity/revenue). A single dynamic leaf segment, not the corrupting shape.
  // Discover's "what other businesses are doing" showcase — cross-tenant AGGREGATE COUNTS only
  // (see the route's own header on the spaces worker). No requireSpaceMembership needed: the
  // productSpaceId in the path only identifies which product's session to verify, the query
  // itself carries no tenant filter to authorize against.
  // Live Market Radar is product-scoped for session verification; the spaces worker creates the
  // launched venture as a child of this product and applies the same authenticated identity.
  // Phase E (§A1.17): pricing display + checkout initiation. All three are additionally gated by
  // Storefront pricing, business subscriptions, revenue, orders, and personal billing routes
  // were retired with Launchpad's business-commerce surface. Naelao plan billing and FDE
  // marketplace settlement use their dedicated platform endpoints.
  /^\/spaces\/([^/]+)\/agent-analytics$/,
  // Phase S (§A1.17): a business member granting the assistant access to their OWN machine —
  // additionally gated by requireSpaceMembership on the spaces worker exactly like the
  // pricing/products routes above (identity here, authorization there).
  /^\/spaces\/([^/]+)\/local-grants(\/|$)/,
  /^\/spaces\/([^/]+)\/local-tunnel\/connect-token$/,
  // Per-business connector connect (BYO Whop account — no Naelao Platforms invite needed):
  // additionally gated by requireSpaceMembership on the spaces worker exactly like the
  // routes above (status is member-level read, connect is admin-level write).
  /^\/spaces\/([^/]+)\/connectors\/status$/,
  /^\/spaces\/([^/]+)\/connectors\/connect$/,
  /^\/spaces\/([^/]+)\/connectors\/oauth-start$/,
  // The full provider directory (every Composio toolkit + Pipedream app, not just the curated
  // dozen) — a member-level read; connecting one is still admin-gated by provider-connect-start
  // below, same identity-here-authorization-there split.
  /^\/spaces\/([^/]+)\/connectors\/directory$/,
  // Composio "click Install" hosted-connect flow (G-1/G-3 growth layer): same admin-level write
  // gate as connect/oauth-start above (requireSpaceMembership on the spaces worker).
  /^\/spaces\/([^/]+)\/connectors\/provider-connect-start$/,
  /^\/spaces\/([^/]+)\/connector-aliases(\/[^/]+)?$/,
  // Step 28: business-wide BYOK LLM keys and catalog activation. Credential mutations and model
  // activation are re-authorized by their destination worker; key material stays in the vault.
  /^\/spaces\/([^/]+)\/llm-byok(?:\/.*)?$/,
  // Naelao Agent Templates: browsing is member-level, instantiating a real agent from one is
  // admin-level — both enforced by requireSpaceMembership on the spaces worker.
  /^\/spaces\/([^/]+)\/agent-templates$/,
  // AVOS plan step 5 — the capability-firewall archetype presets a custom agent can opt into;
  // read-only, member-level, same enforcement split as agent-templates above.
  /^\/spaces\/([^/]+)\/archetypes$/,
  // WS-2 (Space Assistant surface): the Status/Crons panels — additionally gated by
  // resolveEndUserSpaceRole on the spaces worker exactly like the routes above. PATCH is now
  // reachable too (a business-admin end user genuinely IS the owner of their own business, see
  // that route's own comment) — requireSpaceMembership's admin floor does the real gating.
  /^\/spaces\/([^/]+)\/assistant-policy$/,
  // Which model this business's assistant/agents run on — admin-gated by requireSpaceMembership
  // on the spaces worker, same identity-here-authorization-there split as every route above.
  /^\/spaces\/([^/]+)\/model-config$/,
  // Phase 3 item 27/28: a self-serve Crons editing UI needs write access too, not just the list
  // — the trailing `(\/[^/]+)?` also allows the single-job PATCH/DELETE path (`:jobId`), gated
  // by requireSpaceMembership's admin floor on the spaces worker exactly like model-config
  // above (identity here, authorization there). This is a single dynamic LEAF segment (no static
  // suffix after it), the same safe shape as /projects(\/[^/]+)? a few entries up — not the
  // dynamic-then-static-suffix shape that has repeatedly corrupted this codebase's Hono route
  // tables (that risk lives in the spaces worker's own route table, not this plain regex list).
  /^\/spaces\/([^/]+)\/scheduled-jobs(\/[^/]+)?$/,
  // Phase 3 item 27/28: recent-fires history for a scheduled job — same auth floor as
  // scheduled-jobs itself (resolveEndUserSpaceRole on the spaces worker).
  /^\/spaces\/([^/]+)\/scheduled-job-runs$/,
  // The Memory/Channels/Sub-agents/Files panels — additionally gated by
// requireEndUserSpaceMembership on the agents worker (same floor, different worker since
  // these routes live there).
  /^\/spaces\/([^/]+)\/assistant\/(memory|channels|sub-agents|files|capabilities)$/,
  // The same panels' per-item routes. These were unreachable because the pattern above is anchored
  // with `$`: the Files panel could LIST files but opening one 401'd, and the Artifacts panel was
  // never reachable at all. `files` takes an arbitrary nested path; `artifacts` takes an id (and
  // its own list route, which the pattern above never covered). Authorization is unchanged and
// still enforced on the agents worker by requireEndUserSpaceMembership — identity here,
  // authorization there, exactly like the routes above.
  /^\/spaces\/([^/]+)\/assistant\/files\/.+$/,
  /^\/spaces\/([^/]+)\/assistant\/artifacts(\/[^/]+)?$/,
  // Notifications inbox — end-user-facing (a business admin reading their own business's
  // notifications), additionally gated by requireSpaceMembership on the spaces worker exactly
  // like the routes above (identity here, authorization there).
  /^\/spaces\/([^/]+)\/notifications$/,
  /^\/spaces\/([^/]+)\/push-notifications$/,
  // A single project agent's own approval-policy override — same identity-here-authorization-
  // there split as assistant-policy above (requireSpaceMembership: member GET / admin PATCH
  // on the spaces worker). Previously builder-JWT-only; a business admin had no reachable way to
  // configure a project agent's own approvals at all.
  /^\/spaces\/([^/]+)\/agents\/[^/]+\/policy$/,
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
  // Sessions belong to the root Space. Child Spaces share the product session but are authorized
  // independently by their own membership records in the downstream handler.
  const requested = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id, parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(productId).first<{ tenant_id: string; parent_space_id: string | null }>();
  if (!requested) return null;
  let sessionProductId = productId;
  if (requested.parent_space_id) {
    const root = await env.PLATFORM_DB.prepare(
      "SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND parent_space_id IS NULL AND status = 'active'"
    ).bind(requested.parent_space_id, requested.tenant_id).first<{ id: string }>();
    if (!root) return null;
    sessionProductId = root.id;
  }
  const res = await env.SPACES_WORKER.fetch(
    new Request("http://spaces/internal/product-sessions/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-platform-secret": env.PLATFORM_SECRET },
      body: JSON.stringify({ productId: sessionProductId, endUserId, sessionToken }),
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
// /spaces/:spaceId/... route EXCEPT the credential store (credentials/* exposes OAuth tokens,
// API keys, and secrets that an agent must never be able to read even via a GET — a leaked or
// prompt-injection-steered agent key is a read-everything key otherwise). Mutating access is
// still gated by the approval gate below; this is an additional, unconditional READ block on
// the credentials surface alone.
const AGENT_KEY_BLOCKED_PATH_PREFIXES = ["/credentials"];

function matchAgentSpacePath(path: string): string | null {
  const stripped = path.replace(/^\/v1(?=\/|$)/, "") || "/";
  const m = /^\/spaces\/([^/]+)(\/|$)/.exec(stripped);
  if (!m) return null;
  const spaceId = m[1];
  if (!spaceId) return null;
  // Block agent keys from the credential store regardless of method — credentials/* carries
  // raw secrets (OAuth tokens, API keys) that an agent must never read directly.
  const afterSpace = stripped.slice(`/spaces/${spaceId}`.length);
  if (AGENT_KEY_BLOCKED_PATH_PREFIXES.some((p) => afterSpace === p || afterSpace.startsWith(`${p}/`))) {
    return null; // treat as "no agent space match" → falls through to JWT auth → 401
  }
  return spaceId;
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

async function resolveBuilderApiKeyClaims(env: Env, apiKey: string): Promise<NaelaoJwtClaims | null> {
  const response = await env.SPACES_WORKER.fetch(new Request("http://spaces/internal/builder-api-keys/verify", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-platform-secret": env.PLATFORM_SECRET },
    body: JSON.stringify({ key: apiKey }),
  }));
  if (!response.ok) return null;
  const verified = await response.json<{ valid?: boolean; tenant_id?: string; scopes?: string[] }>();
  if (!verified.valid || !verified.tenant_id || !Array.isArray(verified.scopes) || verified.scopes.some(scope => typeof scope !== "string")) return null;
  const now = Math.floor(Date.now() / 1000);
  return { sub: "team-api-key", tid: verified.tenant_id, email: "", role: "team_api_key", scopes: verified.scopes,
    iat: now, exp: now + 300, jti: "" };
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
  const desk = readDeskSession(c.req.header("cookie"));
  const cookieAuth = !c.req.header("authorization") && desk;
  if (cookieAuth && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin") ?? "";
    if (!origin || !((c.env.CORS_ALLOWLIST ?? "").split(",").map(v => v.trim()).includes(origin) || await isDynamicOriginAllowed(c.env, origin))) throw unauthorized("Cookie requests require an authorized origin");
  }
  const authHeader = c.req.header("authorization") ?? (desk ? `Bearer ${desk.token}` : "");
  const headerMatch = /^Bearer\s+(nps_\S+)$/.exec(authHeader);
  // Builder API keys are accepted only on the team administration surface. The downstream
  // Spaces worker resolves the key hash, expiry, revocation and exact scope, then independently
  // pins the tenant to NAELAO_DASHBOARD_TENANT_ID. Do not turn this into a generic API-key auth
  // path: ordinary Space APIs require a user session or an explicitly scoped agent key.
  const builderKeyMatch = /^Bearer\s+(nbk_[a-f0-9]{32})$/.exec(authHeader);
  const authPath = c.req.path.replace(/^\/v1(?=\/|$)/, "") || "/";
  if (/^\/builder(?:\/|$)/.test(authPath) && builderKeyMatch?.[1]) {
    const claims = await resolveBuilderApiKeyClaims(c.env, builderKeyMatch[1]);
    if (!claims) throw unauthorized("Invalid, expired or revoked team API key");
    c.set("claims", claims);
    return next();
  }
  // The browser's native EventSource API cannot set custom headers, so the SSE stream endpoint
  // (.../agent/runs/:runId/stream) has no way to carry a Bearer header. Previously we accepted
  // the full nps_ session token as a query param — but that puts a long-lived credential into
  // CF access logs, proxy logs, and browser history. Fixed: the client POSTs to
  // /spaces/:spaceId/sessions/stream-ticket first (authenticated with the Bearer header), gets
  // a short-lived (60s), single-use stream_ticket, and passes that in ?stream_ticket= instead.
  // The spaces worker's stream-ticket endpoint verifies the ticket and replies with the real
  // identity, so the stream endpoint never needs the raw session token at all.
  // Legacy ?session_token= fallback kept ONLY for the GET stream path while clients migrate;
  // scope-limited to SSE paths matching agent/runs/:id/stream to prevent it being a general
  // auth bypass for any GET endpoint.
  const isStreamPath = /\/agent\/runs\/[^/]+\/stream$/.test(c.req.path);
  const queryStreamTicket = c.req.method === "GET" && isStreamPath ? c.req.query("stream_ticket") : undefined;
  const queryToken = c.req.method === "GET" && isStreamPath ? c.req.query("session_token") : undefined;
  const queryEndUserId = c.req.method === "GET" ? c.req.query("end_user_id") : undefined;

  // Stream ticket path — short-lived, single-use, no long-lived secret in logs.
  if (queryStreamTicket && queryEndUserId) {
    const productId = matchProductEndUserPath(c.req.path);
    if (productId) {
      const ticketRes = await c.env.SPACES_WORKER.fetch(new Request("http://spaces/internal/stream-tickets/consume", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-platform-secret": c.env.PLATFORM_SECRET },
        body: JSON.stringify({ productId, endUserId: queryEndUserId, ticket: queryStreamTicket }),
      }));
      if (!ticketRes.ok) throw unauthorized("Invalid or expired stream ticket");
      const { valid, tenant_id } = await ticketRes.json<{ valid: boolean; tenant_id?: string }>();
      if (!valid || !tenant_id) throw unauthorized("Invalid or expired stream ticket");
      const now = Math.floor(Date.now() / 1000);
      c.set("claims", { sub: queryEndUserId, tid: tenant_id, email: "", role: "product_end_user" as const, scopes: [], iat: now, exp: now + 3600, jti: "" });
      return next();
    }
  }

  const sessionToken = headerMatch?.[1] ?? (queryToken?.startsWith("nps_") ? queryToken : undefined);
  const endUserId = cookieAuth ? desk.userId : c.req.header("x-naelao-end-user-id") ?? queryEndUserId;
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
    const apiKey = agentKeyMatch[1];
    if (!apiKey) throw unauthorized("Invalid or expired agent API key");
    const resolved = await resolveAgentApiKeyClaims(c.env, agentSpaceId, apiKey);
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

// Tenant suspension is the organization-wide emergency gate. Resolve it after every public
// identity path (JWT, product session, and agent key) has populated claims, before proxying to
// any feature worker. A short isolate cache bounds D1 load while keeping the kill switch prompt.
api.use("*", async (c, next) => {
  const tenantId = c.get("claims")?.tid;
  if (tenantId) {
    // An org owner must be able to inspect or cancel an erasure during its cooling-off period.
    // The Spaces route rechecks tenant, owner, request ID, and pending status before restoring.
    const erasureLifecycleRoute = isErasureLifecycleAccess(c.req.method, c.req.path);
    if (!c.env.PLATFORM_DB) return c.json({ error_code: "tenant_status_unavailable" }, 503);
    if (!(await isTenantActive(c.env.PLATFORM_DB, tenantId)) && !erasureLifecycleRoute) {
      return c.json({ error_code: "tenant_suspended", message: "This tenant is suspended" }, 403);
    }
  }
  return next();
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
  const pathSpaceId = matchAgentSpacePath(c.req.path);
  const claimedSpaceId = c.req.header("x-naelao-space-id");
  // The route and authenticated claims are authoritative. A caller cannot substitute a
  // different space through a header while the request is being proxied downstream.
  if (claims && pathSpaceId && claimedSpaceId && claimedSpaceId !== pathSpaceId) {
    return c.json({ error_code: "capability_scope_mismatch", message: "The requested space does not match the authenticated scope" }, 403);
  }
  return next();
});

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

// G-AD02: Token version check — only the exact current version is valid. A signed claim from a
// future version can exist after DB restore/rollback, so treating it as "newer" would bypass the
// revocation epoch check until that version catches up.
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
  preserveV1 = false,
  preferredLanguage?: string | null,
): Promise<Response> {
  const headers = new Headers(req.headers);
  const desk = readDeskSession(req.headers.get("cookie") ?? undefined);
  if (!headers.has("authorization") && desk && claims?.role === "product_end_user" && claims.sub === desk.userId) headers.set("authorization", `Bearer ${desk.token}`);
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
  // end_user_id with no JWT at all used to be accepted by the GDPR /me/export and /me/data
  // handlers. Those paths now participate in product-session resolution and the Spaces worker
  // binds the target ID to verified claims; callers may still supply it in the query while the
  // router uses it only to locate and verify the matching session.
  headers.delete("x-naelao-end-user-id");
  // Never accept this private planner context from a caller. It is populated only after
  // authentication, from the product end user's own roster row, for the agent-run request.
  headers.delete("x-naelao-preferred-language");
  const ts = Date.now().toString();
  if (claims) {
    headers.set("x-naelao-tenant-id", claims.tid);
    headers.set("x-naelao-user-id", claims.sub);
    headers.set("x-naelao-role", claims.role);
    headers.set("x-naelao-scopes", claims.scopes.join(","));
    if (claims.role === "product_end_user") {
      headers.set("x-naelao-end-user-id", claims.sub);
    }
    if (preferredLanguage) headers.set("x-naelao-preferred-language", preferredLanguage);
    const sig = await signHmac(`internal:${claims.tid}:${ts}`, platformSecret);
    headers.set("x-naelao-internal-token", `t=${ts},v1=${sig}`);
  }
  // Strip the /v1 mount prefix so downstream workers (which define routes WITHOUT
  // /v1, e.g. /spaces, /business) actually match. Mirrors the auth-route rewrite.
  const u = new URL(req.url);
  if (!preserveV1) u.pathname = u.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return worker.fetch(new Request(u.toString(), {
    method: req.method,
    headers,
    body: req.body,
    duplex: "half",
  } as RequestInit));
}

for (const path of ["/marketplace", "/marketplace/*"]) api.all(path, async c => {
  if (!c.env.MARKETPLACE_WORKER) return c.json({ error_code: "marketplace_unavailable" }, 503);
  return proxyTo(c.env.MARKETPLACE_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET, true);
});

api.post("/spaces/:spaceId/template-listings/:listingId/fork", async c => {
  if (!c.env.MARKETPLACE_WORKER) return c.json({ error_code: "marketplace_unavailable" }, 503);
  const claims = c.get("claims") as NaelaoJwtClaims | undefined;
  if (!claims || claims.role !== "product_end_user") return c.json({ error_code: "forbidden" }, 403);
  const target = new Request(`http://marketplace/v1/marketplace/${encodeURIComponent(c.req.param("listingId"))}/fork`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  return proxyTo(c.env.MARKETPLACE_WORKER, claims, target, c.env.PLATFORM_SECRET, true);
});

// Portal domain mappings are owner/admin operations. Forward through the signed service binding
// so the Portal Router never trusts identity headers received directly from a public caller.
for (const path of ["/domains", "/domains/*", "/subdomains", "/subdomains/*"]) api.all(path, async (c) => {
  const claims = c.get("claims") as NaelaoJwtClaims | undefined;
  if (!claims || (claims.role !== "owner" && claims.role !== "admin")) {
    return c.json({ error_code: "forbidden", message: "Only tenant owners and admins can manage portal domains" }, 403);
  }
  if (!c.env.PORTAL_ROUTER) return c.json({ error_code: "portal_unavailable" }, 503);
  return proxyTo(c.env.PORTAL_ROUTER, claims, c.req.raw, c.env.PLATFORM_SECRET, true);
});

for (const path of ["/billing/partner/*", "/billing/template-subscriptions"]) api.all(path, async c => {
  if (!c.env.BILLING_WORKER) return c.json({ error_code: "billing_unavailable" }, 503);
  return proxyTo(c.env.BILLING_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET);
});

// Eval suites (G-Q03 / §A1 Harness Excellence HX3) → eval worker.
//
// Builder-only, tenant-scoped: every query in that worker filters on the tenant_id proxyTo sets
// from verified claims, and the worker itself is workers_dev=false so this is its only ingress.
// It had NO router route at all until now — meaning the benchmark runner
// (infra/scripts/run-eval-suite.mjs) had never actually been able to reach a deployment, and the
// worker's own routes were registered under /v1 (which proxyTo strips), so they could not have
// matched even if a route had existed. Both fixed together.
api.all("/evals", async (c) => proxyTo(c.env.EVAL_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/evals/*", async (c) => proxyTo(c.env.EVAL_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// Knowledge (KB) → knowledge worker
// S0.1: For product_end_user callers, verify business membership first.
api.all("/spaces/:spaceId/kb/*", async (c) => {
  const claims = c.get("claims") as NaelaoJwtClaims | undefined;
  if (claims?.role === "product_end_user") {
    const spaceId = c.req.param("spaceId");
    const endUserId = claims.sub;
    const token = await mintInternalToken(c.env.PLATFORM_SECRET, claims.tid);
    const res = await c.env.SPACES_WORKER.fetch(
      new Request(`http://spaces/internal/space-role?spaceId=${encodeURIComponent(spaceId)}&endUserId=${encodeURIComponent(endUserId)}`, {
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

// Authenticated, service-bound citation resolution must win over the generic spaces catch-all.
// The knowledge worker independently repeats project authorization and derives the R2 key.
api.get("/spaces/:spaceId/projects/:projectId/citations/:documentId/:chunkId", async (c) =>
  proxyTo(c.env.KNOWLEDGE_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

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
api.post("/spaces/:spaceId/sessions/:sessionId/voice-ticket", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.post("/spaces/:spaceId/sessions/:sessionId/agent/run", async (c) => {
  const claims = c.get("claims");
  let preferredLanguage: string | null = null;
  if (claims) {
    preferredLanguage = await loadSavedLanguagePreference(c.env.PLATFORM_DB, claims, c.req.param("spaceId"));
  }
  return proxyTo(c.env.AGENTS_WORKER, claims, c.req.raw, c.env.PLATFORM_SECRET, false, preferredLanguage);
});
api.all("/spaces/:spaceId/sessions/:sessionId/agent/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/sessions/:sessionId/approvals/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/sessions/:sessionId/approvals", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
// §A1.27: context-window usage UI + pre-send compaction — implemented on the agents worker
// (reuses NaelaoAgentDO/getAgentDOForSpace), so these two need the same explicit-before-catch-all
// registration the agent/approvals sub-paths above needed, or they'd silently fall through to the
// generic sessions/* catch-all below and 404 against SPACES_WORKER (which doesn't implement them).
api.all("/spaces/:spaceId/sessions/:sessionId/context-usage", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/sessions/:sessionId/compact", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
// §A1 connector default-vs-personal switch — same explicit-before-catch-all registration as
// context-usage/compact above (implemented on the agents worker, would otherwise silently fall
// through to the generic sessions/* catch-all and 404 against SPACES_WORKER).
api.all("/spaces/:spaceId/sessions/:sessionId/connector-mode", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/connector-aliases/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/connector-aliases", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
// Chat uploads (files attached in this conversation, read directly by the agent — see the
// agents-worker route's own header for how this differs from knowledge-base ingestion). Same
// explicit-before-catch-all registration as every other agents-worker sub-path above.
api.all("/spaces/:spaceId/sessions/:sessionId/uploads/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/sessions/:sessionId/uploads", async (c) =>
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

// Customer-bot channel observability + human-takeover admin control → agents worker
// (proxies straight through to the space's agent DO).
api.all("/spaces/:spaceId/channels/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);

api.all("/spaces/:spaceId/assistant-communications", async c => proxyTo(c.env.AGENTS_WORKER,c.get("claims"),c.req.raw,c.env.PLATFORM_SECRET));

// Provider OAuth, credential vaulting, and connection lifecycle for a specific composed project
// extension are Agents-owned. Keep this before `/spaces/*` so it does not land in Spaces Worker.
api.all("/spaces/:spaceId/projects/:projectId/extensions/:installationId/connections/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
// The external channel inbox is Agents-owned; channel installation, removal, and session cleanup
// remain on Spaces. Keep the exact inbox subtree ahead of the general Spaces project proxy.
api.all("/spaces/:spaceId/projects/:projectId/channel-extensions/:installationId/inbox/*", async (c) =>
  proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
);
api.all("/spaces/:spaceId/projects/:projectId/channel-extensions/:installationId/inbox", async (c) =>
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
api.all("/me/preferences", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/spaces/*", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/spaces", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// F-1: Builder Dashboard API (/builder/products*, /builder/api-keys*, /builder/space-types,
// /builder/billing, /builder/payouts, …) → spaces worker (registerBuilderRoutes). Authenticated
// with the builder JWT (this is inside the `api` group), so proxyTo mints the internal token from
// verified claims. Without this route the ENTIRE builder dashboard 404'd — every management tab
// (create product, users, analytics, pricing, domain, payouts) was dead.
api.all("/builder/*", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/builder", async (c) => proxyTo(c.env.SPACES_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// Go-live audit F2: the builder's OWN platform subscription surface (billing worker's
// /billing/subscription plan+quota, /billing/checkout upgrade, /billing/portal) was never
// proxied here at all — apps/dashboard's Settings page calls getBillingSubscription()/
// createBillingCheckout() against these paths and every call 404'd at the router, so a builder
// could neither see their plan nor upgrade off free (which now gates free_tier_eligible templates,
// G-BF08 — a builder stuck on free had no in-product way out). These are builder-authenticated
// (the billing worker reads x-naelao-tenant-id set by proxyTo from the validated JWT; the worker
// is shielded by workers_dev=false so the header can't be spoofed by a direct caller). Proxied as
// three EXPLICIT routes rather than a blanket /billing/* on purpose: /billing/usage and every
// /internal/* billing route are requireInternalHmac-gated for service callers only and must NOT
// become reachable by an ordinary authenticated builder.
const proxyBilling = async (c: { env: Env; get: (k: "claims") => NaelaoJwtClaims | undefined; req: { raw: Request } }) =>
  c.env.BILLING_WORKER
    ? proxyTo(c.env.BILLING_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET)
    : new Response(JSON.stringify({ error_code: "billing_unavailable", message: "Billing worker not configured" }), { status: 503, headers: { "content-type": "application/json" } });
api.all("/billing/subscription", proxyBilling);
api.all("/billing/checkout", proxyBilling);
api.all("/billing/portal", proxyBilling);
// Owner-only runtime distribution evidence. The analytics worker performs a second role and
// platform-secret check before querying the private agent-event dataset.
api.get("/analytics/runtime-economics", async (c) => {
  if (!c.env.ANALYTICS_WORKER) {
    return c.json({ error_code: "analytics_unavailable", message: "Analytics worker not configured" }, 503);
  }
  const url = new URL(c.req.url);
  url.pathname = "/metrics/runtime-economics";
  return proxyTo(
    c.env.ANALYTICS_WORKER,
    c.get("claims"),
    new Request(url, c.req.raw),
    c.env.PLATFORM_SECRET,
  );
});

// External-platform connectors (catalogue + connect flow) → agents worker.
api.all("/connectors/*", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/connectors", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// Federated template learning (promote / inherit shared skills) → agents worker.
api.all("/skills/*", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));
api.all("/templates/*", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));

// Multi-channel gateway connect flow (authenticated; the public inbound webhook is registered
// above, before the JWT gate) → agents worker.
api.all("/channels/:channel/connect", async (c) => proxyTo(c.env.AGENTS_WORKER, c.get("claims"), c.req.raw, c.env.PLATFORM_SECRET));


app.route("/v1", api);

export { app };

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
