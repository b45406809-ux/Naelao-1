// G-I17: MCP Tool Server Registry — registers MCP servers per Space and proxies tool calls
import { Hono } from "hono";
import { errorResponse, requestId, requireInternalHmac, mintInternalToken } from "@naelao/http";
import { checkSsrf, scanAndScrubEgress } from "@naelao/security";
import { missingToolScopes } from "./connector-policy";
import type { ConnectorScope } from "./connector-policy";

export interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  /** Credentials worker — resolves auth_secret_name → plaintext at call time (never stored here). */
  CREDENTIALS_WORKER?: Fetcher;
  /** Spec G-BF02 (universal-tools doctrine): PLATFORM-PROVIDED provider keys. Naelao holds ONE
   *  Composio/Pipedream key as a Workers Secret so provider-backed connectors work with zero
   *  builder configuration (the Claude/ChatGPT bundled-connector model) — never the BYO
   *  space-credential path, which stays reserved for a builder's OWN provider project. The key
   *  never leaves this worker. Optional: when unset and a connector has no BYO credential, calls
   *  degrade honestly with `provider_not_configured`. */
  COMPOSIO_API_KEY?: string;
  /** VERIFIED (2026-07, against Pipedream's own docs): Pipedream's REST API is OAuth
   *  client_credentials-only — there is no "simple API key" the way Composio has one. Naelao's
   *  ONE Pipedream OAuth client id/secret (workers/agents/src/connectors/pipedream.ts holds the
   *  canonical implementation of the token exchange this worker mirrors below — kept in sync by
   *  hand, same precedent as the reserved-capability lists above). */
  PIPEDREAM_CLIENT_ID?: string;
  PIPEDREAM_CLIENT_SECRET?: string;
  /** "development" or "production", required on every Pipedream Connect call. Defaults below. */
  PIPEDREAM_ENVIRONMENT?: string;
  /** OAuth2 connectors ("Connect with Whop" etc.): buildAuthHeaders proactively refreshes a
   *  near-expiry access token by calling this internal endpoint — only the agents worker holds
   *  the connector's OAuth client secret, so refresh logic lives there, not here. */
  AGENTS_WORKER?: Fetcher;
  /** Meters a call that rode on Naelao's OWN platform provider key (not the builder's BYO
   *  credential) so it bills the builder's org rather than being an open, unattributed platform
   *  cost sink. Optional/best-effort — degrades to unmetered (not unblocked) when unwired. */
  BILLING_WORKER?: Fetcher;
}

/** Meter a tool call that resolved to Naelao's platform provider key (never a builder's own BYO
 *  credential — that case is the builder's own provider billing, not ours). Reuses the existing
 *  generic POST /billing/usage sink (same one llm_tokens/infra_credits already use), so this
 *  needs no new billing-worker route. Best-effort: never blocks or fails the tool call itself. */
async function recordPlatformKeyUsage(env: Env, tenantId: string, spaceId: string, connectorProvider: string): Promise<void> {
  if (!env.BILLING_WORKER) return;
  try {
    await env.BILLING_WORKER.fetch(
      new Request("http://billing-worker/billing/usage", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": tenantId,
          "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
        },
        body: JSON.stringify({ space_id: spaceId, event_type: "platform_connector_key", quantity: 1 }),
      })
    );
  } catch {
    // Best-effort — the tool call itself already succeeded/failed independently of billing.
  }
}

// Hosts that are external payment processors (incl. Naelao's own LS). A connector may never be
// registered against these — money-in is reserved to the prebuilt commerce script. Mirrors
// workers/agents/src/script-engine/reserved-capabilities.ts (kept in sync; defense-in-depth).
const RESERVED_PAYMENT_HOSTS: readonly string[] = [
  "api.stripe.com", "stripe.com", "js.stripe.com", "checkout.stripe.com",
  "api.paypal.com", "paypal.com", "paypalobjects.com",
  "squareup.com", "connect.squareup.com",
  "api.paddle.com", "paddle.com", "checkout.paddle.com",
  "braintreegateway.com", "api.braintreegateway.com",
  "razorpay.com", "api.razorpay.com", "api.checkout.com", "gr4vy.com",
  "commerce.coinbase.com", "api.coinbase.com",
  "api.lemonsqueezy.com", "lemonsqueezy.com",
];

function isReservedPaymentHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return RESERVED_PAYMENT_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
}

// Mirrors workers/agents/src/script-engine/reserved-capabilities.ts's RESERVED_CAPABILITIES +
// isReservedToolName (kept in sync by hand — same precedent as the payment-host list above).
const RESERVED_TOOL_CAPABILITIES: readonly string[] = [
  "collect_payment", "create_checkout", "charge_customer", "subscription_charge",
  "issue_invoice", "payout", "wallet_withdraw", "wallet_balance", "connect_payment_account",
];

function isReservedToolName(toolName: string): boolean {
  const n = toolName.toLowerCase().replace(/[^a-z]/g, "_");
  if (RESERVED_TOOL_CAPABILITIES.some((cap) => n.includes(cap))) return true;
  return /(create|start|new|capture|collect)_?(payment|checkout|charge|invoice|payout|subscription)/.test(n)
    || /\b(charge|payout|refund|withdraw)\b/.test(toolName.toLowerCase());
}

/**
 * Short-lived per-request HMAC credential token (mirrors workers/credentials generateCredentialToken).
 * Format: "t=<unix>,aid=<agentId>,v1=<hmac-hex>"; HMAC payload "<spaceId>:<agentId>:<timestamp>".
 * The credentials worker verifies signature + spaceId + 60s freshness before returning plaintext.
 */
async function generateCredentialToken(platformSecret: string, spaceId: string, agentId: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(platformSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${spaceId}:${agentId}:${timestamp}`));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},aid=${agentId},v1=${hex}`;
}

type ConnectorProvider = "direct" | "composio" | "pipedream";

export interface McpServer {
  id: string;
  space_id: string;
  tenant_id: string;
  name: string;
  url: string;
  auth_type: "bearer" | "api_key" | "none" | "oauth2";
  auth_secret_name: string | null; // references space_credentials table
  enabled: number; // 0 or 1 (D1 stores booleans as integers)
  connector_provider: ConnectorProvider;
  /** Provider's opaque connection reference (Composio connected_account_id / Pipedream user_id). Never the underlying OAuth token. */
  provider_connection_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── Phase P: Composio / Pipedream provider routing ────────────────────────────────────────────
// When connector_provider is 'composio' or 'pipedream', we route the tool call through the
// provider's execute-action API instead of calling the server URL directly. The script-native
// "6 ops only" surface is unchanged — more connector inventory, same surface.
// Both providers need an API key stored as a space-level credential; the connection_id stored in
// provider_connection_id scopes the call to the correct end-user OAuth connection on the provider side.

interface ProviderToolCallResult {
  result?: unknown;
  error?: string;
}

// Composio moved its tool-execution/listing API from v2 (`/api/v2/actions/...`) to v3
// (`/api/v3/tools/...`) — the connect-flow code in connectors/composio.ts was already updated to
// v3 for the OAuth handshake (see its own header), but these two functions, which is what every
// ACTUAL agent tool call goes through, were left on the dead v2 shape. Confirmed against
// Composio's real, live OpenAPI spec (`GET https://backend.composio.dev/api/v3/openapi.json`,
// fetched directly rather than assumed) — this is not a guess at a plausible shape the way some
// of this file's other defensive parsing is; the exact field names below are the schema's own.
const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3";

async function composioToolCall(
  connectionId: string,
  toolName: string,
  input: Record<string, unknown>,
  apiKey: string
): Promise<ProviderToolCallResult> {
  const resp = await fetch(
    `${COMPOSIO_API_BASE}/tools/execute/${encodeURIComponent(toolName)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ connected_account_id: connectionId, arguments: input }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { error: `Composio returned ${resp.status}: ${text.slice(0, 200)}` };
  }
  const data = await resp.json<{ data?: unknown; error?: string | null; successful?: boolean }>();
  if (data.error) return { error: data.error };
  // The v3 response envelope reports success via a dedicated `successful` boolean rather than
  // relying solely on `error` being absent — a call whose HTTP status was 200 but whose
  // `successful` field is `false` is still a failure (e.g. the upstream app itself rejected the
  // action), and reporting it as a result would hide that from the agent.
  if (data.successful === false) return { error: "Composio reported the tool call as unsuccessful" };
  return { result: data.data };
}

async function composioListTools(
  connectionId: string,
  apiKey: string
): Promise<{ tools: unknown[] }> {
  // v3 lists tools by TOOLKIT (`?toolkit_slug=`), not by connected account — there is no
  // "list tools for this connection" filter anymore, confirmed against the real spec. A
  // connected account always belongs to exactly one toolkit, so resolve that first.
  const acctResp = await fetch(
    `${COMPOSIO_API_BASE}/connected_accounts/${encodeURIComponent(connectionId)}`,
    { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(15_000) }
  );
  if (!acctResp.ok) return { tools: [] };
  const acct = await acctResp.json<{ toolkit?: { slug?: string } }>().catch(() => ({}) as { toolkit?: { slug?: string } });
  const toolkitSlug = acct.toolkit?.slug;
  if (!toolkitSlug) return { tools: [] };
  const resp = await fetch(
    `${COMPOSIO_API_BASE}/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=100`,
    { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(15_000) }
  );
  if (!resp.ok) return { tools: [] };
  const data = await resp.json<{ items?: unknown[] }>();
  return { tools: data.items ?? [] };
}

// Module-scoped OAuth access-token cache — mirrors connectors/pipedream.ts's own cache (a soft
// optimization only; a cold isolate simply refetches, never relied on for correctness).
const pipedreamTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

/** Exchanges Naelao's platform Pipedream OAuth client for a short-lived (1hr) access token —
 *  Pipedream's REST API accepts NOTHING else, confirmed against their own docs (no static API
 *  key path exists, unlike Composio's x-api-key). Never throws to its caller; a failed exchange
 *  degrades to the same provider_not_configured/credential_error path a missing key already
 *  takes. */
async function getPipedreamAccessToken(clientId: string, clientSecret: string): Promise<string | null> {
  const cached = pipedreamTokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
  try {
    const resp = await fetch("https://api.pipedream.com/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const json = await resp.json<{ access_token?: string; expires_in?: number }>();
    if (!json.access_token) return null;
    pipedreamTokenCache.set(clientId, { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
    return json.access_token;
  } catch {
    return null;
  }
}

async function pipedreamToolCall(
  connectionId: string,
  actionName: string,
  input: Record<string, unknown>,
  accessToken: string,
  environment: string
): Promise<ProviderToolCallResult> {
  // Pipedream Connect execute-action endpoint. `accessToken` is a real OAuth access token
  // (client_credentials-derived), never a static key — see getPipedreamAccessToken above.
  const resp = await fetch(
    `https://api.pipedream.com/v1/connect/actions/${encodeURIComponent(actionName)}/run`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "x-pd-environment": environment,
        "x-pd-end-user-id": connectionId,
      },
      body: JSON.stringify({ inputs: input }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { error: `Pipedream returned ${resp.status}: ${text.slice(0, 200)}` };
  }
  const data = await resp.json<{ data?: unknown; error?: string }>();
  if (data.error) return { error: data.error };
  return { result: data.data };
}

async function pipedreamListTools(
  connectionId: string,
  accessToken: string,
  environment: string
): Promise<{ tools: unknown[] }> {
  const resp = await fetch(
    `https://api.pipedream.com/v1/connect/components/actions?end_user_id=${encodeURIComponent(connectionId)}`,
    {
      headers: { "Authorization": `Bearer ${accessToken}`, "x-pd-environment": environment },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!resp.ok) return { tools: [] };
  const data = await resp.json<{ data?: unknown[] }>();
  return { tools: data.data ?? [] };
}

function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => {
  validateEnv(c.env);
  await next();
});
// §A1.17 Phase I: this worker's only real ingress is direct service bindings from the agents
// worker (mcp-connector's ctx.env.mcpHubWorker, and now the ctx.mcp isolate loopback) — never
// the public router — so `workers_dev = false` is the primary control. This adds the same
// defense-in-depth `requireInternalHmac` backstop every other internal-only worker in the
// platform already has (credentials, billing's /internal/*, spaces' /internal/*) in case that
// ever slips.
app.use("/v1/spaces/*", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));

function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }): {
  tenantId: string;
  userId: string;
} {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
  };
}

// S0.5: was a literal-only hostname/IP blocklist (no DNS resolution, so a DNS-rebinding attack —
// register a public-IP hostname, then repoint its DNS to an internal address — sailed straight
// through) checked ONLY at registration time, never again before the actual outbound fetch. Now
// backed by the shared @naelao/security checkSsrf (DoH resolution, the same guard
// workers/browser/src/index.ts uses), and called again immediately before every outbound MCP
// fetch below — not just at registration — so a hostname that resolves safely at registration
// but is repointed afterward is still caught at call time.
async function validateMcpUrl(rawUrl: string): Promise<{ ok: true; url: URL } | { ok: false; message: string }> {
  const result = await checkSsrf(rawUrl);
  if (result.blocked) {
    return { ok: false, message: result.reason ?? "url failed SSRF validation" };
  }
  return { ok: true, url: new URL(rawUrl) };
}

/**
 * Resolve a credential reference (auth_secret_name → encrypted vault → plaintext) through the
 * credentials worker, then build the auth headers for the upstream MCP server. The plaintext is
 * fetched per call and never persisted in mcp_servers — the row only holds the credential NAME.
 * agentId scopes the short-lived credential token (for the vault's audit trail).
 *
 * §A1.18 connector scope model: `actingUserId`, when given, is passed to the credentials worker
 * as `on_behalf_of_user_id` — the plaintext-resolution route already implements the full
 * space-override > user > space-shared hierarchy (`resolveCredential`, unchanged by this pass),
 * it just never received an acting user from any caller. This is what makes a `scope='user'`
 * connector credential (a member's own personal account) actually reachable at call time — before
 * this, every resolution here was effectively space-only regardless of what was stored. Absent
 * (the vast majority of calls — most connectors are space-scoped) resolves exactly as before.
 */
/** Normalizes the `x-naelao-connector-scope` header (set by the mcp-connector prebuilt from the
 *  chat surface's per-session connector-mode preference) into buildAuthHeaders' preferScope
 *  param — any other/absent value degrades to undefined (today's default resolution), never a
 *  thrown error over a malformed header. */
function readPreferScope(raw: string | undefined): "business" | "personal" | undefined {
  return raw === "business" || raw === "personal" ? raw : undefined;
}

export async function buildAuthHeaders(
  server: McpServer,
  env: Env,
  agentId: string,
  actingUserId?: string,
  /** §A1 connector default-vs-personal switch: forwarded verbatim to the credentials worker's
   *  resolveCredential (see that function's own doc for the tier semantics). Absent for every
   *  pre-existing caller — byte-identical behavior. */
  preferScope?: "business" | "personal"
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (server.auth_type === "none" || !server.auth_secret_name) return headers;

  if (!env.CREDENTIALS_WORKER) {
    throw new Error("Credential resolution requires CREDENTIALS_WORKER binding");
  }
  const token = await generateCredentialToken(env.PLATFORM_SECRET, server.space_id, agentId);
  const resp = await env.CREDENTIALS_WORKER.fetch(
    new Request(
      `http://credentials/v1/internal/spaces/${server.space_id}/credentials/${encodeURIComponent(server.auth_secret_name)}/plaintext`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": server.tenant_id,
          "x-naelao-credential-token": token,
        },
        body: JSON.stringify({
          ...(actingUserId ? { on_behalf_of_user_id: actingUserId } : {}),
          ...(preferScope ? { prefer_scope: preferScope } : {}),
        }),
      }
    )
  );
  if (resp.status === 404) {
    const body = await resp.json<{ error_code?: string }>().catch(() => ({}) as Record<string, never>);
    if (body.error_code === "personal_credential_required") {
      throw new Error(`personal_credential_required: no personal account connected for '${server.name}' — switch to the business account or connect your own`);
    }
  }
  if (!resp.ok) {
    throw new Error(`Failed to resolve credential '${server.auth_secret_name}' (${resp.status})`);
  }
  const { value } = await resp.json<{ value: string }>();
  if (server.auth_type === "bearer") headers["Authorization"] = `Bearer ${value}`;
  else if (server.auth_type === "api_key") headers["X-API-Key"] = value;
  else if (server.auth_type === "oauth2") {
    headers["Authorization"] = `Bearer ${await resolveOAuthAccessToken(server, env, value)}`;
  }
  return headers;
}

interface OAuthCredentialValue {
  access_token: string;
  refresh_token: string;
  /** Epoch millis. */
  expires_at: number;
}

// Refresh a bit before actual expiry so a call in flight doesn't race token expiration.
const OAUTH_REFRESH_BUFFER_MS = 5 * 60_000;

/** Resolves an oauth2 connector's access token, proactively refreshing via the agents worker
 *  (the only place that holds the connector's OAuth client secret) when near expiry. Never
 *  throws on a refresh failure — falls back to the current (possibly stale) access token so a
 *  transient refresh-endpoint outage doesn't turn every call into a hard failure; the upstream
 *  connector call itself will surface a real 401 if the token has actually expired. */
export async function resolveOAuthAccessToken(server: McpServer, env: Env, rawValue: string): Promise<string> {
  let tokens: OAuthCredentialValue;
  try {
    tokens = JSON.parse(rawValue) as OAuthCredentialValue;
  } catch {
    // Not a JSON blob — treat as a bare access token (defensive; shouldn't happen for a
    // correctly-registered oauth2 server).
    return rawValue;
  }
  if (!tokens.expires_at || Date.now() < tokens.expires_at - OAUTH_REFRESH_BUFFER_MS) {
    return tokens.access_token;
  }
  if (!env.AGENTS_WORKER) return tokens.access_token;
  try {
    const token = await mintInternalToken(env.PLATFORM_SECRET, server.tenant_id);
    const resp = await env.AGENTS_WORKER.fetch(
      new Request("http://agents-worker/internal/connectors/oauth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": server.tenant_id, "x-naelao-internal-token": token },
        body: JSON.stringify({ space_id: server.space_id, platform: server.name, refresh_token: tokens.refresh_token }),
      })
    );
    if (!resp.ok) return tokens.access_token;
    const refreshed = await resp.json<{ access_token?: string }>();
    return refreshed.access_token ?? tokens.access_token;
  } catch {
    return tokens.access_token;
  }
}

type ProviderKeyResolution =
  | { ok: true; apiKey: string; source: "byo" | "platform" }
  | { ok: false; status: 400 | 502 | 503; errorCode: string; message: string };

/**
 * G-BF02: resolve the provider API key for a Composio/Pipedream-routed connector.
 *
 * Order matters: BYO wins when the row names a vault credential — a builder running their own
 * provider project keeps full control (and their own provider billing). Only when NO credential
 * is named does the PLATFORM key apply: Naelao's own Composio/Pipedream key, injected
 * server-side, never visible to (or enterable by) any builder or end user. Neither configured
 * → an honest, explicit error — never a silent empty result.
 */
async function resolveProviderApiKey(server: McpServer, env: Env, agentId: string): Promise<ProviderKeyResolution> {
  if (server.auth_secret_name) {
    let authHeaders: Record<string, string>;
    try {
      authHeaders = await buildAuthHeaders(server, env, agentId);
    } catch (err) {
      return { ok: false, status: 502, errorCode: "credential_error", message: (err as Error).message };
    }
    const apiKey = authHeaders["Authorization"]?.replace("Bearer ", "") ?? authHeaders["X-API-Key"] ?? "";
    if (!apiKey) {
      // Declared BYO but resolved to nothing (e.g. auth_type 'none' with a secret name) — a
      // registration bug. Deliberately NOT falling back to the platform key: that would silently
      // mask the misconfiguration and bill Naelao's provider account for a builder-project
      // connector.
      return {
        ok: false, status: 400, errorCode: "credential_error",
        message: `Credential '${server.auth_secret_name}' resolved to no API key (check the connector's auth_type)`,
      };
    }
    return { ok: true, apiKey, source: "byo" };
  }

  if (server.connector_provider === "composio") {
    if (env.COMPOSIO_API_KEY) return { ok: true, apiKey: env.COMPOSIO_API_KEY, source: "platform" };
  } else if (env.PIPEDREAM_CLIENT_ID && env.PIPEDREAM_CLIENT_SECRET) {
    // Pipedream has no static platform key — resolve to a live OAuth access token instead
    // (client_credentials-only per its own docs; see getPipedreamAccessToken above).
    const accessToken = await getPipedreamAccessToken(env.PIPEDREAM_CLIENT_ID, env.PIPEDREAM_CLIENT_SECRET);
    if (accessToken) return { ok: true, apiKey: accessToken, source: "platform" };
    return {
      ok: false, status: 502, errorCode: "provider_auth_failed",
      message: "Pipedream OAuth token exchange failed (check PIPEDREAM_CLIENT_ID/PIPEDREAM_CLIENT_SECRET)",
    };
  }
  return {
    ok: false, status: 503, errorCode: "provider_not_configured",
    message: `${server.connector_provider} connectors are not configured on this platform (no platform credentials set) and this connector has no credential of its own`,
  };
}

// GET /v1/spaces/:spaceId/mcp-servers — list registered MCP servers
app.get("/v1/spaces/:spaceId/mcp-servers", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = c.req.param("spaceId");

  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, name, url, auth_type, enabled, created_at FROM mcp_servers WHERE space_id = ? AND tenant_id = ?"
  )
    .bind(spaceId, tenantId)
    .all();

  return c.json({ data: results });
});

// POST /v1/spaces/:spaceId/mcp-servers — register a new MCP server
app.post("/v1/spaces/:spaceId/mcp-servers", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = c.req.param("spaceId");

  const body = await c.req.json<{
    name: string;
    url?: string;
    auth_type?: "bearer" | "api_key" | "none";
    auth_secret_name?: string;
    connector_provider?: ConnectorProvider;
    provider_connection_id?: string;
  }>();

  const connectorProvider: ConnectorProvider = body.connector_provider ?? "direct";
  if (!["direct", "composio", "pipedream"].includes(connectorProvider)) {
    return c.json({ error_code: "bad_request", message: "connector_provider must be 'direct', 'composio', or 'pipedream'" }, 400);
  }

  // For provider-routed connectors a url is optional (the provider resolves the endpoint);
  // for direct connections a url is required.
  const url = body.url ?? "";
  if (connectorProvider === "direct" && !body.name) {
    return c.json({ error_code: "bad_request", message: "name is required" }, 400);
  }
  if (connectorProvider === "direct" && !url) {
    return c.json({ error_code: "bad_request", message: "url is required for direct connectors" }, 400);
  }
  if (!body.name) {
    return c.json({ error_code: "bad_request", message: "name is required" }, 400);
  }

  // SSRF + reserved-payment checks apply only to direct connectors (the provider handles
  // routing for Composio/Pipedream — we validate the provider API host at deploy time, not here).
  if (connectorProvider === "direct") {
    const urlValidation = await validateMcpUrl(url);
    if (!urlValidation.ok) {
      return c.json({ error_code: "bad_request", message: urlValidation.message }, 400);
    }
    if (isReservedPaymentHost(urlValidation.url.hostname)) {
      return c.json({
        error_code: "reserved_capability",
        message: "Payment processors cannot be registered as MCP connectors; money-in is reserved to Naelao commerce.",
      }, 403);
    }
  }

  if ((connectorProvider === "composio" || connectorProvider === "pipedream") && !body.provider_connection_id) {
    return c.json({ error_code: "bad_request", message: "provider_connection_id is required for Composio/Pipedream connectors" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const authType = body.auth_type ?? "none";
  const authSecretName = body.auth_secret_name ?? null;
  const providerConnectionId = body.provider_connection_id ?? null;

  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO mcp_servers (id, space_id, tenant_id, name, url, auth_type, auth_secret_name, enabled, connector_provider, provider_connection_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  )
    .bind(id, spaceId, tenantId, body.name, url, authType, authSecretName, connectorProvider, providerConnectionId, now, now)
    .run();

  return c.json(
    { id, name: body.name, url, auth_type: authType, connector_provider: connectorProvider, enabled: true, created_at: now },
    201
  );
});

// PATCH /v1/spaces/:spaceId/mcp-servers/:serverId — update enabled state
app.patch("/v1/spaces/:spaceId/mcp-servers/:serverId", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = c.req.param("spaceId");
  const serverId = c.req.param("serverId");

  const body = await c.req.json<{ enabled?: boolean }>();
  if (typeof body.enabled !== "boolean") {
    return c.json({ error_code: "bad_request", message: "enabled (boolean) is required" }, 400);
  }

  const now = new Date().toISOString();
  const result = await c.env.PLATFORM_DB.prepare(
    "UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ? AND space_id = ? AND tenant_id = ?"
  )
    .bind(body.enabled ? 1 : 0, now, serverId, spaceId, tenantId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error_code: "not_found", message: "MCP server not found" }, 404);
  }
  return c.json({ id: serverId, enabled: body.enabled, updated_at: now });
});

// DELETE /v1/spaces/:spaceId/mcp-servers/:serverId
app.delete("/v1/spaces/:spaceId/mcp-servers/:serverId", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = c.req.param("spaceId");
  const serverId = c.req.param("serverId");

  const result = await c.env.PLATFORM_DB.prepare(
    "DELETE FROM mcp_servers WHERE id = ? AND space_id = ? AND tenant_id = ?"
  )
    .bind(serverId, spaceId, tenantId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error_code: "not_found", message: "MCP server not found" }, 404);
  }
  return c.json({ deleted: true });
});

// GET /v1/spaces/:spaceId/mcp-servers/:serverId/tools — list tools from an MCP server
app.get("/v1/spaces/:spaceId/mcp-servers/:serverId/tools", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = c.req.param("spaceId");
  const serverId = c.req.param("serverId");

  const server = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM mcp_servers WHERE id = ? AND space_id = ? AND tenant_id = ? AND enabled = 1"
  )
    .bind(serverId, spaceId, tenantId)
    .first<McpServer>();

  if (!server) {
    return c.json({ error_code: "not_found", message: "MCP server not found or disabled" }, 404);
  }

  // Provider-routed connectors skip direct SSRF/credential checks and go through the provider API.
  // G-BF02: key resolution is BYO-credential-first, then Naelao's platform key — see
  // resolveProviderApiKey.
  if (server.connector_provider === "composio" || server.connector_provider === "pipedream") {
    const keyRes = await resolveProviderApiKey(server, c.env, c.req.header("x-naelao-agent-id") ?? "mcp-hub");
    if (!keyRes.ok) {
      return c.json({ error_code: keyRes.errorCode, message: keyRes.message }, keyRes.status);
    }
    if (!server.provider_connection_id) {
      return c.json({ error_code: "bad_request", message: "Provider connection_id missing" }, 400);
    }
    if (server.connector_provider === "composio") {
      return c.json(await composioListTools(server.provider_connection_id, keyRes.apiKey));
    }
    return c.json(await pipedreamListTools(server.provider_connection_id, keyRes.apiKey, c.env.PIPEDREAM_ENVIRONMENT ?? "development"));
  }

  // S0.5: re-validate at CALL TIME, not just registration — a hostname that resolved to a
  // public IP when registered can be repointed via DNS afterward (rebinding) to an internal
  // address. Checked BEFORE resolving credentials, so a URL that now fails validation never
  // even causes a credential lookup, let alone gets the resolved credential attached to a fetch.
  const callTimeValidation = await validateMcpUrl(server.url);
  if (!callTimeValidation.ok) {
    return c.json({ error_code: "bad_request", message: `MCP server URL failed SSRF validation: ${callTimeValidation.message}` }, 400);
  }

  let headers: Record<string, string>;
  try {
    headers = await buildAuthHeaders(
      server, c.env, c.req.header("x-naelao-agent-id") ?? "mcp-hub", c.req.header("x-naelao-user-id") || undefined,
      readPreferScope(c.req.header("x-naelao-connector-scope"))
    );
  } catch (err) {
    return c.json({ error_code: "credential_error", message: (err as Error).message }, 502);
  }

  const mcpPayload = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/list",
    params: {},
  };

  let resp: Response;
  try {
    resp = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(mcpPayload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (fetchErr) {
    console.error("[mcp-hub] tools/list fetch error:", fetchErr);
    return c.json({ error_code: "upstream_error", message: "Failed to reach MCP server" }, 502);
  }

  if (!resp.ok) {
    return c.json(
      { error_code: "upstream_error", message: `MCP server returned ${resp.status}` },
      502
    );
  }

  const result = await resp.json<{ result?: { tools?: unknown[] }; error?: { message: string } }>();
  if (result.error) {
    return c.json({ error_code: "tool_error", message: result.error.message }, 422);
  }
  return c.json({ tools: result.result?.tools ?? [] });
});

app.get("/v1/spaces/:spaceId/connector-aliases", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT id, alias, scope, project_id, user_id, server_id, granted_scopes_json, updated_at
     FROM connector_aliases WHERE tenant_id=? AND space_id=? ORDER BY alias, scope`
  ).bind(tenantId, c.req.param("spaceId")).all();
  return c.json({ data: results });
});

app.post("/v1/spaces/:spaceId/connector-aliases", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = c.req.param("spaceId");
  const body = await c.req.json<{ alias: string; scope: ConnectorScope; project_id?: string; user_id?: string; server_id: string; granted_scopes?: string[] }>();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(body.alias ?? "") || !["space_shared", "project_bound", "user_personal"].includes(body.scope)) {
    return c.json({ error_code: "bad_request", message: "Invalid alias or scope" }, 400);
  }
  const callerUser = c.req.header("x-naelao-user-id") ?? "";
  const userId = body.scope === "user_personal" ? callerUser : null;
  const projectId = body.scope === "project_bound" ? body.project_id ?? null : null;
  if ((body.scope === "user_personal" && !userId) || (body.scope === "project_bound" && !projectId)) {
    return c.json({ error_code: "bad_request", message: "Requested scope identity is missing" }, 400);
  }
  const server = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM mcp_servers WHERE id=? AND tenant_id=? AND space_id=? AND enabled=1"
  ).bind(body.server_id, tenantId, spaceId).first();
  if (!server) return c.json({ error_code: "not_found", message: "Connector not found" }, 404);
  const scopes = [...new Set((body.granted_scopes ?? []).filter((s) => /^[a-z0-9:._-]{1,128}$/i.test(s)))];
  const existing = await c.env.PLATFORM_DB.prepare(
    `SELECT id FROM connector_aliases WHERE tenant_id=? AND space_id=? AND alias=? AND scope=?
      AND ifnull(project_id,'')=ifnull(?,'') AND ifnull(user_id,'')=ifnull(?,'')`
  ).bind(tenantId, spaceId, body.alias, body.scope, projectId, userId).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await c.env.PLATFORM_DB.prepare(
      `UPDATE connector_aliases SET server_id=?, granted_scopes_json=?, updated_at=datetime('now')
       WHERE id=? AND tenant_id=? AND space_id=?`
    ).bind(body.server_id, JSON.stringify(scopes), id, tenantId, spaceId).run();
  } else {
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO connector_aliases
       (id,tenant_id,space_id,alias,scope,project_id,user_id,server_id,granted_scopes_json)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(id, tenantId, spaceId, body.alias, body.scope, projectId, userId, body.server_id, JSON.stringify(scopes)).run();
  }
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO connector_alias_audit (id,tenant_id,space_id,alias_id,alias,action,actor_id,project_id)
     VALUES (?,?,?,?,?,'created',?,?)`
  ).bind(crypto.randomUUID(), tenantId, spaceId, id, body.alias, callerUser || "system", projectId).run();
  return c.json({ id, alias: body.alias, scope: body.scope, project_id: projectId, user_id: userId, server_id: body.server_id, granted_scopes: scopes }, existing ? 200 : 201);
});

app.delete("/v1/spaces/:spaceId/connector-aliases/:aliasId", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const result = await c.env.PLATFORM_DB.prepare(
    "DELETE FROM connector_aliases WHERE id=? AND tenant_id=? AND space_id=?"
  ).bind(c.req.param("aliasId"), tenantId, c.req.param("spaceId")).run();
  return result.meta.changes === 1 ? c.json({ deleted: true }) : c.json({ error_code: "not_found", message: "Alias not found" }, 404);
});

// Resolve logical aliases on every call. Explicit personal/project scope never falls back to a
// broader shared account, and every key includes tenant + space before narrower dimensions.
app.post("/v1/spaces/:spaceId/connector-aliases/:alias/tools/call", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = c.req.param("spaceId");
  const projectId = c.req.header("x-naelao-project-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const requiredScope = c.req.header("x-naelao-connector-scope") ?? "";
  if (requiredScope && !["space_shared", "project_bound", "user_personal"].includes(requiredScope)) {
    return c.json({ error_code: "bad_request", message: "Invalid connector scope" }, 400);
  }
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT id, server_id, scope, granted_scopes_json FROM connector_aliases
     WHERE tenant_id=? AND space_id=? AND alias=?
       AND ((scope='user_personal' AND user_id=?) OR (scope='project_bound' AND project_id=?) OR scope='space_shared')
       AND (?='' OR scope=?)
     ORDER BY CASE scope WHEN 'user_personal' THEN 3 WHEN 'project_bound' THEN 2 ELSE 1 END DESC LIMIT 1`
  ).bind(tenantId, spaceId, c.req.param("alias"), userId, projectId, requiredScope, requiredScope)
    .first<{ id: string; server_id: string; scope: string; granted_scopes_json: string }>();
  if (!row) return c.json({ error_code: "not_found", message: "Connector alias not found in the requested scope" }, 404);
  const callBody: { tool_name?: string } = await c.req.raw.clone().json<{ tool_name?: string }>().catch(() => ({}));
  let grantedScopes: string[] = [];
  try {
    const parsed = JSON.parse(row.granted_scopes_json) as unknown;
    if (Array.isArray(parsed)) grantedScopes = parsed.filter((scope): scope is string => typeof scope === "string");
  } catch {
    // Corrupt scope metadata fails closed: write actions require re-authorization.
  }
  const missingScopes = missingToolScopes(callBody.tool_name ?? "", grantedScopes);
  if (missingScopes.length) {
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO connector_alias_audit (id,tenant_id,space_id,alias_id,alias,action,actor_id,project_id)
       VALUES (?,?,?,?,?,'scope_denied',?,?)`
    ).bind(crypto.randomUUID(), tenantId, spaceId, row.id, c.req.param("alias"), userId || "system", projectId || null).run();
    return c.json({
      error_code: "scope_upgrade_required",
      missing_scopes: missingScopes,
      authorization_url: `/spaces/${encodeURIComponent(spaceId)}/connectors/${encodeURIComponent(c.req.param("alias"))}/oauth/start?scopes=${encodeURIComponent(missingScopes.join(" "))}`,
      card: { type: "scope_upgrade_required", alias: c.req.param("alias"), missing_scopes: missingScopes },
    }, 409);
  }
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO connector_alias_audit (id,tenant_id,space_id,alias_id,alias,action,actor_id,project_id)
     VALUES (?,?,?,?,?,'called',?,?)`
  ).bind(crypto.randomUUID(), tenantId, spaceId, row.id, c.req.param("alias"), userId || "system", projectId || null).run();
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-naelao-connector-scope", row.scope);
  return app.fetch(new Request(
    `https://mcp-hub.internal/v1/spaces/${encodeURIComponent(spaceId)}/mcp-servers/${encodeURIComponent(row.server_id)}/tools/call`,
    { method: "POST", headers, body: await c.req.raw.text() }
  ), c.env, c.executionCtx);
});

// POST /v1/spaces/:spaceId/mcp-servers/:serverId/tools/call — proxy a tool call to an MCP server
// Internal: called by agent runtime
app.post("/v1/spaces/:spaceId/mcp-servers/:serverId/tools/call", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const spaceId = c.req.param("spaceId");
  const serverId = c.req.param("serverId");

  const server = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM mcp_servers WHERE id = ? AND space_id = ? AND tenant_id = ? AND enabled = 1"
  )
    .bind(serverId, spaceId, tenantId)
    .first<McpServer>();

  if (!server) {
    return c.json({ error_code: "not_found", message: "MCP server not found or disabled" }, 404);
  }

  const body = await c.req.json<{ tool_name: string; input: Record<string, unknown> }>();
  if (!body.tool_name) {
    return c.json({ error_code: "bad_request", message: "tool_name is required" }, 400);
  }

  // §A1.17 Phase I: this guard previously existed ONLY in the mcp-connector prebuilt (a client
  // of this route), so any caller that reaches this endpoint directly — e.g. the new ctx.mcp
  // isolate loopback — bypassed it entirely. Enforced here too so it protects every caller, not
  // just one; kept in sync with reserved-capabilities.ts's isReservedToolName by hand (same
  // precedent as isReservedPaymentHost above).
  if (isReservedToolName(body.tool_name)) {
    return c.json({
      error_code: "reserved_capability",
      message: `Tool '${body.tool_name}' looks like a money-in capability, which is reserved to the prebuilt commerce script.`,
    }, 403);
  }

  // Scan the serialized structure at the final outbound boundary. Fail closed and never log
  // payload contents; aliases and custom MCP URLs cannot bypass this centralized gate.
  const dlp = scanAndScrubEgress(body.input);
  if (dlp.findings.length > 0) {
    const findings = dlp.findings.map(({ rule }) => rule);
    console.warn("[mcp-hub] outbound DLP blocked", { tenantId, spaceId, serverId, toolName: body.tool_name, findings, timestamp: new Date().toISOString() });
    return c.json({ error_code: "egress_dlp_blocked", message: "Connector payload contains protected data and was not sent", findings }, 422);
  }

  // Provider-routed connectors skip SSRF/credential checks — route through provider API.
  // G-BF02: key resolution is BYO-credential-first, then Naelao's platform key.
  if (server.connector_provider === "composio" || server.connector_provider === "pipedream") {
    const keyRes = await resolveProviderApiKey(server, c.env, c.req.header("x-naelao-agent-id") ?? "mcp-hub");
    if (!keyRes.ok) {
      return c.json({ error_code: keyRes.errorCode, message: keyRes.message }, keyRes.status);
    }
    if (!server.provider_connection_id) {
      return c.json({ error_code: "bad_request", message: "Provider connection_id missing" }, 400);
    }
    if (keyRes.source === "platform") {
      c.executionCtx.waitUntil(recordPlatformKeyUsage(c.env, tenantId, spaceId, server.connector_provider ?? "unknown"));
    }
    let providerResult: ProviderToolCallResult;
    if (server.connector_provider === "composio") {
      providerResult = await composioToolCall(server.provider_connection_id, body.tool_name, body.input, keyRes.apiKey);
    } else {
      providerResult = await pipedreamToolCall(server.provider_connection_id, body.tool_name, body.input, keyRes.apiKey, c.env.PIPEDREAM_ENVIRONMENT ?? "development");
    }
    if (providerResult.error) {
      return c.json({ error_code: "upstream_error", message: providerResult.error }, 502);
    }
    return c.json({ result: providerResult.result });
  }

  // S0.5: re-validate at CALL TIME, not just registration — see the tools/list handler above.
  // Checked before resolving credentials, same ordering rationale.
  const callTimeValidation = await validateMcpUrl(server.url);
  if (!callTimeValidation.ok) {
    return c.json({ error_code: "bad_request", message: `MCP server URL failed SSRF validation: ${callTimeValidation.message}` }, 400);
  }

  let headers: Record<string, string>;
  try {
    headers = await buildAuthHeaders(
      server, c.env, c.req.header("x-naelao-agent-id") ?? "mcp-hub", c.req.header("x-naelao-user-id") || undefined,
      readPreferScope(c.req.header("x-naelao-connector-scope"))
    );
  } catch (err) {
    return c.json({ error_code: "credential_error", message: (err as Error).message }, 502);
  }

  const mcpPayload = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: body.tool_name, arguments: body.input },
  };

  let resp: Response;
  try {
    resp = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(mcpPayload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (fetchErr) {
    console.error("[mcp-hub] tools/call fetch error:", fetchErr);
    return c.json({ error_code: "upstream_error", message: "Failed to reach MCP server" }, 502);
  }

  if (!resp.ok) {
    return c.json(
      { error_code: "upstream_error", message: `MCP server returned ${resp.status}` },
      502
    );
  }

  const result = await resp.json<{ result?: unknown; error?: { message: string } }>();
  if (result.error) {
    return c.json({ error_code: "tool_error", message: result.error.message }, 422);
  }
  return c.json({ result: result.result });
});

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
