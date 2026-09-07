import { Hono } from "hono";
import { requireInternalHmac } from "@naelao/http";
import { requireBusinessMembership } from "../business-auth.js";
import { getDOName } from "@naelao/crypto";
import { McpJsonRpcRequest, McpMeshEndpointManifest } from "@naelao/types";

export interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SPACE_DO: DurableObjectNamespace;
}

export const mcpMeshApp = new Hono<{ Bindings: Env }>();

function getCallerIdentity(c: any) {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
    role: c.req.header("x-naelao-role") ?? "viewer",
  };
}

async function spaceDoStub(env: Env, spaceId: string, tenantId: string) {
  const doId = env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, env.PLATFORM_SECRET));
  return env.SPACE_DO.get(doId);
}

mcpMeshApp.use("/spaces/:spaceId/projects/:projectId/mcp", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
mcpMeshApp.use("/spaces/:spaceId/projects/:projectId/mcp", requireBusinessMembership({ GET: "member", POST: "member" }));

/**
 * Discovery endpoint: Returns server capabilities and available tools for a project.
 */
mcpMeshApp.get("/spaces/:spaceId/projects/:projectId/mcp", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const manifestRes = await stub.fetch(`http://space-do/internal/projects/${projectId}/mcp-manifest`, {
    headers: {
      "x-naelao-caller-id": identity.userId || "anonymous",
      "x-naelao-tenant-id": tenantId,
    }
  });

  if (!manifestRes.ok) {
    return c.json({ error_code: "mcp_discovery_failed", message: "Failed to resolve project MCP manifest" }, manifestRes.status as any);
  }

  const manifest = await manifestRes.json<McpMeshEndpointManifest>();
  return c.json(manifest);
});

/**
 * Execution endpoint: Executes a JSON-RPC 2.0 tool call against the project.
 */
mcpMeshApp.post("/spaces/:spaceId/projects/:projectId/mcp", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const body = await c.req.json<McpJsonRpcRequest>();

  if (body.jsonrpc !== "2.0" || !body.method) {
    return c.json({
      jsonrpc: "2.0",
      id: body.id || null,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 Request" }
    }, 400);
  }

  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const response = await stub.fetch(`http://space-do/internal/projects/${projectId}/mcp-execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-caller-id": identity.userId || "anonymous",
      "x-naelao-caller-role": identity.role || "viewer",
      "x-naelao-tenant-id": tenantId
    },
    body: JSON.stringify(body)
  });

  const rpcResult = await response.json();
  return c.json(rpcResult, response.status as any);
});
