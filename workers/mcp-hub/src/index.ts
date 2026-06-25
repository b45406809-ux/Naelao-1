// G-I17: MCP Tool Server Registry — registers MCP servers per Space and proxies tool calls
import { Hono } from "hono";
import { errorResponse, requestId } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
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

function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }): {
  tenantId: string;
  userId: string;
} {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
  };
}

// Validate that a URL is safe (not SSRF-prone)
function validateMcpUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; message: string } {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, message: "Invalid url" };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { ok: false, message: "url must use http or https" };
  }
  const hostname = u.hostname;
  if (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  ) {
    return { ok: false, message: "url must not point to private IP ranges" };
  }
  return { ok: true, url: u };
}

// Build auth headers for an MCP server
function buildAuthHeaders(server: McpServer): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Note: credential resolution would require credentials worker service binding.
  // For now, bearer token/api_key can be passed directly via auth_secret_name.
  if (server.auth_type === "bearer" && server.auth_secret_name !== null) {
    headers["Authorization"] = `Bearer ${server.auth_secret_name}`;
  } else if (server.auth_type === "api_key" && server.auth_secret_name !== null) {
    headers["X-API-Key"] = server.auth_secret_name;
  }
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

  const urlValidation = validateMcpUrl(body.url);
  if (!urlValidation.ok) {
    return c.json({ error_code: "bad_request", message: urlValidation.message }, 400);
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

  const headers = buildAuthHeaders(server);

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

  const headers = buildAuthHeaders(server);

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
