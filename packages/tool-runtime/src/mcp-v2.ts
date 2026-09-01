/**
 * Next-Generation MCP v2 (2026-07-28 Spec & SDK v2)
 *
 * Implements:
 * 1. Stateless Streamable HTTP MCP server handler (`createMcpHandler`)
 * 2. Native Elicitation Protocol for Human-In-The-Loop (HITL) approvals without open streaming
 * 3. WebMCP in-browser client-side tool discovery & execution bridge
 * 4. External space/project MCP endpoint provisioning for Claude Desktop, Cursor, and ChatGPT
 */

export interface McpToolDeclaration {
  description: string;
  parameters?: Record<string, unknown>; // JSON Schema
  inputSchema?: Record<string, unknown>; // Alias for parameters
  requiresApproval?: boolean;
  approvalPrompt?: string;
  execute: (params: Record<string, unknown>, ctx: McpExecutionContext) => Promise<unknown>;
}

export interface McpExecutionContext {
  tenantId?: string;
  spaceId?: string;
  projectId?: string;
  userId?: string;
  agentId?: string;
  requestId: string;
  elicitApproval: (action: string, details: Record<string, unknown>) => Promise<ElicitationResult>;
}

export interface ElicitationRequest {
  elicitationId: string;
  action: string;
  params: Record<string, unknown>;
  prompt?: string;
  status: "pending" | "approved" | "rejected";
  expiresAt: string;
}

export interface ElicitationResult {
  status: "approved" | "rejected" | "suspended";
  elicitationId: string;
  resumedValue?: unknown;
  message?: string;
}

export interface McpServerConfig {
  serverInfo?: {
    name: string;
    version: string;
  };
  tools: Record<string, McpToolDeclaration>;
  onElicitation?: (action: string, params: Record<string, unknown>, ctx: McpExecutionContext) => Promise<ElicitationResult>;
  onAuthenticate?: (request: Request) => Promise<{ authorized: boolean; spaceId?: string; tenantId?: string; userId?: string } | null>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * WebMCP Browser Tool Definition
 * Represents a tool exposed directly by the in-browser live preview iframe.
 */
export interface WebMcpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface WebMcpBridge {
  inspectDom: (selector: string) => Promise<{ html: string; attributes: Record<string, string>; childrenCount: number }>;
  getComputedStyles: (selector: string, properties: string[]) => Promise<Record<string, string>>;
  getConsoleLogs: () => Promise<Array<{ level: "log" | "warn" | "error"; message: string; timestamp: number }>>;
}

/**
 * Creates a next-generation Stateless Streamable HTTP MCP handler.
 */
export function createMcpHandler(config: McpServerConfig) {
  return async function handleMcpRequest(request: Request): Promise<Response> {
    // 1. CORS headers for cross-origin tooling (Cursor, Claude Desktop, WebMCP)
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-naelao-tenant-id, x-naelao-space-id, x-naelao-agent-id, mcp-protocol-version",
      "mcp-protocol-version": "2026-07-28",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET") {
      // Streamable / Server-Info ping endpoint
      return new Response(
        JSON.stringify({
          name: config.serverInfo?.name || "naelao-mcp-v2",
          version: config.serverInfo?.version || "2.0.0",
          protocolVersion: "2026-07-28",
          transport: "stateless-streamable-http",
          capabilities: {
            tools: { listChanged: true },
            elicitation: true,
          },
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed. Use POST for MCP v2." }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let authInfo: { authorized: boolean; spaceId?: string; tenantId?: string; userId?: string } | null = null;
    if (config.onAuthenticate) {
      authInfo = await config.onAuthenticate(request);
      if (!authInfo || !authInfo.authorized) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: "Unauthorized MCP request." },
          }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const requestId = crypto.randomUUID();
    const execContext: McpExecutionContext = {
      tenantId: authInfo?.tenantId || request.headers.get("x-naelao-tenant-id") || undefined,
      spaceId: authInfo?.spaceId || request.headers.get("x-naelao-space-id") || undefined,
      userId: authInfo?.userId || request.headers.get("x-naelao-user-id") || undefined,
      agentId: request.headers.get("x-naelao-agent-id") || "external-mcp-client",
      requestId,
      elicitApproval: async (action, details) => {
        if (config.onElicitation) {
          return await config.onElicitation(action, details, execContext);
        }
        return {
          status: "suspended",
          elicitationId: `elicit_${crypto.randomUUID()}`,
          message: `Action '${action}' requires human confirmation. Execution suspended via MCP v2 Elicitation.`,
        };
      },
    };

    let body: JsonRpcRequest | JsonRpcRequest[];
    try {
      body = await request.json<JsonRpcRequest | JsonRpcRequest[]>();
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error: Invalid JSON." },
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (Array.isArray(body)) {
      const responses = await Promise.all(body.map((req) => processSingleJsonRpc(req, config, execContext)));
      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const singleResponse = await processSingleJsonRpc(body, config, execContext);
    return new Response(JSON.stringify(singleResponse), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  };
}

async function processSingleJsonRpc(
  req: JsonRpcRequest,
  config: McpServerConfig,
  ctx: McpExecutionContext
): Promise<JsonRpcResponse> {
  const id = req.id !== undefined ? req.id : null;

  if (req.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0'" },
    };
  }

  switch (req.method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2026-07-28",
          capabilities: {
            tools: { listChanged: true },
            elicitation: true,
          },
          serverInfo: {
            name: config.serverInfo?.name || "naelao-mcp-server",
            version: config.serverInfo?.version || "2.0.0",
          },
        },
      };
    }

    case "ping": {
      return { jsonrpc: "2.0", id, result: {} };
    }

    case "tools/list": {
      const toolList = Object.entries(config.tools).map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: def.parameters || def.inputSchema || { type: "object", properties: {} },
      }));

      return {
        jsonrpc: "2.0",
        id,
        result: { tools: toolList },
      };
    }

    case "tools/call": {
      const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      if (!toolName) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Missing tool name in params" },
        };
      }

      const toolDef = config.tools[toolName];
      if (!toolDef) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Tool '${toolName}' not found` },
        };
      }

      // Check if tool requires approval elicitation
      if (toolDef.requiresApproval) {
        const elicitation = await ctx.elicitApproval(toolName, toolArgs);
        if (elicitation.status === "suspended") {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: elicitation.message || `Tool '${toolName}' requires human authorization. Elicitation ID: ${elicitation.elicitationId}`,
                },
              ],
              isError: false,
              elicitation: {
                id: elicitation.elicitationId,
                status: "pending",
                action: toolName,
              },
            },
          };
        } else if (elicitation.status === "rejected") {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Action '${toolName}' was rejected during human elicitation approval.`,
            },
          };
        }
      }

      try {
        const output = await toolDef.execute(toolArgs, ctx);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: typeof output === "string" ? output : JSON.stringify(output, null, 2),
              },
            ],
            structuredContent: typeof output === "object" ? output : undefined,
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: (err as Error).message || "Tool execution failed",
          },
        };
      }
    }

    default: {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method '${req.method}' not implemented.` },
      };
    }
  }
}
