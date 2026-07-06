// G-I17: MCP Tool Server Registry — registers MCP servers per Space and proxies tool calls
import { Hono } from "hono";
import { errorResponse, requestId, requireInternalHmac } from "@naelao/http";
import { checkSsrf } from "@naelao/security";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  /** Credentials worker — resolves auth_secret_name → plaintext at call time (never stored here). */
  CREDENTIALS_WORKER?: Fetcher;
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

interface McpServer {
  id: string;
  space_id: string;
  tenant_id: string;
  name: string;
  url: string;
  auth_type: "bearer" | "api_key" | "none";
  auth_secret_name: string | null; // references space_credentials table
  enabled: number; // 0 or 1 (D1 stores booleans as integers)
  created_at: string;
  updated_at: string;
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
 */
async function buildAuthHeaders(server: McpServer, env: Env, agentId: string): Promise<Record<string, string>> {
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
      }
    )
  );
  if (!resp.ok) {
    throw new Error(`Failed to resolve credential '${server.auth_secret_name}' (${resp.status})`);
  }
  const { value } = await resp.json<{ value: string }>();
  if (server.auth_type === "bearer") headers["Authorization"] = `Bearer ${value}`;
  else if (server.auth_type === "api_key") headers["X-API-Key"] = value;
  return headers;
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
    url: string;
    auth_type?: "bearer" | "api_key" | "none";
    auth_secret_name?: string;
  }>();

  if (!body.name || !body.url) {
    return c.json({ error_code: "bad_request", message: "name and url are required" }, 400);
  }

  const urlValidation = await validateMcpUrl(body.url);
  if (!urlValidation.ok) {
    return c.json({ error_code: "bad_request", message: urlValidation.message }, 400);
  }

  // Reserved-capability guard (defense-in-depth — the mcp-connector prebuilt also checks):
  // a payment processor may not be registered as a connector. Money-in is reserved to the
  // prebuilt commerce script so the platform fee is always captured.
  if (isReservedPaymentHost(urlValidation.url.hostname)) {
    return c.json({
      error_code: "reserved_capability",
      message: "Payment processors cannot be registered as MCP connectors; money-in is reserved to Naelao commerce.",
    }, 403);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const authType = body.auth_type ?? "none";
  const authSecretName = body.auth_secret_name ?? null;

  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO mcp_servers (id, space_id, tenant_id, name, url, auth_type, auth_secret_name, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(id, spaceId, tenantId, body.name, body.url, authType, authSecretName, now, now)
    .run();

  return c.json(
    { id, name: body.name, url: body.url, auth_type: authType, enabled: true, created_at: now },
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
    headers = await buildAuthHeaders(server, c.env, c.req.header("x-naelao-agent-id") ?? "mcp-hub");
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

  // S0.5: re-validate at CALL TIME, not just registration — see the tools/list handler above.
  // Checked before resolving credentials, same ordering rationale.
  const callTimeValidation = await validateMcpUrl(server.url);
  if (!callTimeValidation.ok) {
    return c.json({ error_code: "bad_request", message: `MCP server URL failed SSRF validation: ${callTimeValidation.message}` }, 400);
  }

  let headers: Record<string, string>;
  try {
    headers = await buildAuthHeaders(server, c.env, c.req.header("x-naelao-agent-id") ?? "mcp-hub");
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
