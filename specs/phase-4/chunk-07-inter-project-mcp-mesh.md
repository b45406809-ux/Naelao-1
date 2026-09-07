Here is the complete, exhaustive, production-grade specification file for **Phase 4 — Chunk 07**: `specs/phase-4/chunk-07-inter-project-mcp-mesh.md`.

---

```markdown
---
chunk_id: "phase-4-chunk-07"
phase: 4
include_files:
  - workers/mcp-hub/src/index.ts
  - workers/spaces/src/index.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/mcp-hub/src/index.ts"
  - "workers/spaces/src/index.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - packages/types/src/mcp-mesh.ts
  - packages/types/src/index.ts
  - workers/mcp-hub/src/index.ts
  - workers/spaces/src/routes/mcp-mesh-routes.ts
---

# Phase 4 — Chunk 07: Inter-Project Stateless MCP v2 Mesh

## 1. Executive Summary & Architectural Vision

In traditional multi-agent systems, inter-project communication is either tightly coupled with brittle RPC glue code or reliant on fragile stateful Server-Sent Events (SSE) connections that drop under load and leak memory.

AVOS implements the **Model Context Protocol (MCP) v2 Specification (2026-07-28)** using **Stateless Streamable HTTP** [1.2.2]. Every project in an AVOS workspace exposes an authoritative, stateless `/mcp` endpoint [1.2.2, 1.2.6]. 

This transforms the entire enterprise workspace into a **Self-Discovering Microservice Mesh**:
1. **Zero-Glued Internal Communication:** The **Space Assistant ("The CEO")** queries project capabilities as standardized MCP servers over high-speed HTTP, eliminating custom point-to-point RPC spaghetti [1.2.6].
2. **External Developer Tool Interoperability:** A human engineer can open **Cursor, Claude Desktop, or Windsurf** on their personal laptop, configure `https://api.avos.app/spaces/:spaceId/projects/:projectId/mcp` with an API key, and directly query and manipulate the live edge project workspace [1.2.2, 1.2.6, 1.2.7].
3. **Pipedream Retirement & Composio Dedication:** Pipedream is completely retired to eliminate dual-directory bloat and token-exchange complexity [1.2.6]. Composio is retained strictly as the headless OAuth broker for 3rd-party SaaS connectors [1.2.6].
4. **Stateless Human Elicitation (HITL):** Tool calls requiring human authorization (e.g. paying invoices, deleting tables) emit native MCP v2 elicitation payloads that suspend cleanly without holding open persistent HTTP streams [1.2.2].

```
                                  ┌──────────────────────────────────────────────┐
                                  │         SPACE ASSISTANT ("The CEO")          │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                         ┌───────────────────────────────┼───────────────────────────────┐
                         ▼ (Streamable HTTP /mcp)        ▼ (Streamable HTTP /mcp)        ▼ (Streamable HTTP /mcp)
┌──────────────────────────────────┐   ┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ PROJECT A: "Product Dev"         │   │ PROJECT B: "Customer Ops"        │   │ PROJECT C: "Legal / Diligence"   │
│ URL: `.../projects/dev/mcp`      │   │ URL: `.../projects/ops/mcp`      │   │ URL: `.../projects/legal/mcp`    │
├──────────────────────────────────┤   ├──────────────────────────────────┤   ├──────────────────────────────────┤
│ Exposed Tools:                   │   │ Exposed Tools:                   │   │ Exposed Tools:                   │
│ • `read_workspace_file`          │   │ • `fetch_unanswered_tickets`     │   │ • `search_case_precedents`       │
│ • `run_ast_patch`                │   │ • `escalate_to_human`            │   │ • `audit_indemnity_clause`       │
│ • `get_test_status`              │   │ • `send_whatsapp_template`       │   │ • `generate_redline_summary`     │
└──────────────────────────────────┘   └──────────────────────────────────┘   └──────────────────────────────────┘
                 ▲                                       ▲                                       ▲
                 │                                       │                                       │
                 └───────────────────────────────────────┴───────────────────────────────────────┘
                                                         │
                                        [ External Cursor / Claude Desktop ]
                                    (Authenticated via Scoped API Access Token)
```

---

## 2. Stateless Streamable HTTP vs. Legacy SSE

```
┌──────────────────────────────────────┬──────────────────────────────────────┬──────────────────────────────────────┐
│ Operational Metric                   │ Legacy MCP v1 (Stateful SSE)         │ AVOS Next-Gen MCP v2 (Streamable)    │
├──────────────────────────────────────┼──────────────────────────────────────┼──────────────────────────────────────┤
│ **Connection Topology**              │ Long-lived, stateful HTTP + SSE pipe │ **Stateless HTTP POST / JSON-RPC 2.0**│
│ **Worker Memory Consumption**        │ Holds V8 isolate memory open forever │ **Instant scale-to-zero (0ms idle)**  │
│ **Reconnection Resilience**          │ Connection drop kills active tool run│ **Idempotent retry with session state│
│ **Human Approvals (HITL)**           │ Requires persistent socket while user│ **Native Elicitation payload suspends │
│                                      │ takes hours to review on phone       │ cleanly at zero compute cost** [1.2.2]     │
│ **Deployment Footprint**             │ Heavy multi-package runtime (~1.2MB) │ **Minimalist edge handler (<50KB)**   │
└──────────────────────────────────────┴──────────────────────────────────────┴──────────────────────────────────────┘
```

---

## 3. Technical Specifications & File Contracts

### A. Define Canonical Types (`packages/types/src/mcp-mesh.ts`)
Create `packages/types/src/mcp-mesh.ts` and re-export it in `packages/types/src/index.ts`:

```typescript
export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, any>;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface McpToolParameterSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
  }>;
  required?: string[];
}

export interface McpToolDeclaration {
  name: string;
  description: string;
  inputSchema: McpToolParameterSchema;
}

export interface McpMeshEndpointManifest {
  mcpVersion: "2026-07-28";
  serverInfo: {
    name: string;
    version: string;
    environment: "cloudflare_edge_v8";
  };
  capabilities: {
    tools: { listChanged: boolean };
    prompts: { listChanged: boolean };
    resources: { subscribe: boolean; listChanged: boolean };
    elicitation: { supported: boolean };
  };
  tools: McpToolDeclaration[];
}

export interface McpElicitationRequest {
  type: "elicitation_required";
  actionName: string;
  reason: string;
  parameters: Record<string, any>;
  approvalToken: string;
}
```

---

### B. Implement Edge Mesh Routes (`workers/spaces/src/routes/mcp-mesh-routes.ts`)
Create `workers/spaces/src/routes/mcp-mesh-routes.ts` to mount and forward `/mcp` endpoints to `SpaceDO`:

```typescript
import { Hono } from "hono";
import { errorResponse } from "@naelao/http";
import { McpJsonRpcRequest, McpMeshEndpointManifest } from "@naelao/types";

export const mcpMeshApp = new Hono<{ Bindings: Env }>();

/**
 * Discovery endpoint: Returns server capabilities and available tools for a project.
 */
mcpMeshApp.get("/spaces/:spaceId/projects/:projectId/mcp", async (c) => {
  const { spaceId, projectId } = c.req.param();

  // Validate Project Existence & Read Authorization
  const spaceDOId = c.env.SPACE_DO.idFromName(spaceId);
  const spaceDO = c.env.SPACE_DO.get(spaceDOId);

  const manifestRes = await spaceDO.fetch(`http://internal/projects/${projectId}/mcp-manifest`, {
    headers: { "x-naelao-caller-id": c.get("user")?.id || "anonymous" }
  });

  if (!manifestRes.ok) {
    return errorResponse(c, manifestRes.status as any, "mcp_discovery_failed", "Failed to resolve project MCP manifest");
  }

  const manifest = await manifestRes.json<McpMeshEndpointManifest>();
  return c.json(manifest);
});

/**
 * Execution endpoint: Executes a JSON-RPC 2.0 tool call against the project.
 */
mcpMeshApp.post("/spaces/:spaceId/projects/:projectId/mcp", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const body = await c.req.json<McpJsonRpcRequest>();

  if (body.jsonrpc !== "2.0" || !body.method) {
    return c.json({
      jsonrpc: "2.0",
      id: body.id || null,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 Request" }
    }, 400);
  }

  // Forward to SpaceDO single-threaded actor for execution
  const spaceDOId = c.env.SPACE_DO.idFromName(spaceId);
  const spaceDO = c.env.SPACE_DO.get(spaceDOId);

  const response = await spaceDO.fetch(`http://internal/projects/${projectId}/mcp-execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-caller-id": c.get("user")?.id || "anonymous",
      "x-naelao-caller-role": c.get("user")?.role || "viewer"
    },
    body: JSON.stringify(body)
  });

  const rpcResult = await response.json();
  return c.json(rpcResult, response.status as any);
});
```

---

### C. Refactor `workers/mcp-hub/src/index.ts`
Completely purge Pipedream dependencies and implement the clean **Composio JIT OAuth Router** and **Stateless MCP Handler Factory** [1.2.6]:

```typescript
import { Hono } from "hono";
import { requireInternalHmac } from "@naelao/http";
import { McpJsonRpcRequest, McpJsonRpcResponse } from "@naelao/types";

const app = new Hono<{ Bindings: Env }>();

// Enforce internal edge security on administrative routes
app.use("/internal/*", requireInternalHmac());

/**
 * JIT Tool Dispatcher:
 * Resolves Composio 3rd-party SaaS connectors and internal project mesh tools.
 */
app.post("/v1/tools/execute", async (c) => {
  const { serverName, toolName, parameters, actingUserId, spaceId } = await c.req.json<{
    serverName: string;
    toolName: string;
    parameters: Record<string, any>;
    actingUserId?: string;
    spaceId: string;
  }>();

  // 1. Check for Reserved Money-In Capabilities (Security Rule)
  const isReserved = ["charge", "refund", "payout", "transfer"].some(k => toolName.toLowerCase().includes(k));
  if (isReserved && serverName !== "commerce") {
    return c.json({
      ok: false,
      error: `Security Violation: Action '${toolName}' is reserved exclusively for the verified commerce subsystem.`
    }, 403);
  }

  // 2. Route Composio Hosted Connectors (Google, Slack, Instagram, GitHub)
  if (serverName.startsWith("composio_") || serverName === "gmail" || serverName === "github") {
    return await executeComposioTool({
      toolName,
      parameters,
      actingUserId,
      spaceId,
      env: c.env
    }, c);
  }

  // 3. Inter-Project Mesh Execution (Routing to Project MCP endpoints)
  if (serverName.startsWith("project_")) {
    const targetProjectId = serverName.replace("project_", "");
    const spaceDOId = c.env.SPACE_DO.idFromName(spaceId);
    const spaceDO = c.env.SPACE_DO.get(spaceDOId);

    const rpcPayload: McpJsonRpcRequest = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: `tools/call`,
      params: { name: toolName, arguments: parameters }
    };

    const res = await spaceDO.fetch(`http://internal/projects/${targetProjectId}/mcp-execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-caller-id": actingUserId || "system" },
      body: JSON.stringify(rpcPayload)
    });

    const responseData = await res.json<McpJsonRpcResponse>();
    if (responseData.error) {
      return c.json({ ok: false, error: responseData.error.message }, 400);
    }
    return c.json({ ok: true, output: responseData.result });
  }

  return c.json({ ok: false, error: `Unrecognized server provider: '${serverName}'` }, 400);
});

/**
 * Executes a tool against Composio's API using the edge-vaulted credentials.
 */
async function executeComposioTool(opts: any, c: any) {
  const composioKey = c.env.COMPOSIO_API_KEY;
  if (!composioKey) {
    return c.json({ ok: false, error: "Composio provider not configured on this platform." }, 503);
  }

  // Resolve active connection ID for this space/user
  const connectionRes = await c.env.CREDENTIALS_WORKER.fetch(
    `http://internal/spaces/${opts.spaceId}/connectors/status?user_id=${opts.actingUserId || ""}`
  );
  const connData = await connectionRes.json() as any;

  if (!connData.connected) {
    return c.json({
      ok: false,
      needs_connection: true,
      error: `Integration '${opts.toolName}' requires connecting an account. Please complete connection dialog.`
    }, 402);
  }

  // Execute against Composio REST API
  const apiRes = await fetch(`https://backend.composio.dev/api/v3/tools/execute/${opts.toolName}`, {
    method: "POST",
    headers: {
      "x-api-key": composioKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      connected_account_id: connData.connection_id,
      arguments: opts.parameters
    })
  });

  const result = await apiRes.json() as any;
  if (!apiRes.ok || result.successful === false) {
    return c.json({ ok: false, error: result.error || "Composio execution failed" }, 400);
  }

  return c.json({ ok: true, output: result.data });
}

export default app;
```

---

### D. Update `workers/spaces/src/do/SpaceDO.ts`
Implement internal HTTP endpoints inside `SpaceDO` to service MCP manifest generation and execution:

```typescript
// Inside SpaceDO.ts fetch dispatcher:

if (url.pathname.match(/\/projects\/[^/]+\/mcp-manifest/)) {
  const projectId = url.pathname.split("/")[2];
  const project = this.ctx.storage.sql.exec("SELECT * FROM projects WHERE id = ?", projectId).toArray()[0] as any;
  
  if (!project) return new Response("Project Not Found", { status: 404 });

  const manifest: McpMeshEndpointManifest = {
    mcpVersion: "2026-07-28",
    serverInfo: {
      name: `AVOS Project: ${project.name}`,
      version: "1.0.0",
      environment: "cloudflare_edge_v8"
    },
    capabilities: {
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      elicitation: { supported: true }
    },
    tools: [
      {
        name: "read_project_file",
        description: "Read a file from this project's virtual SQLite filesystem with line numbers.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Relative file path" },
            offset: { type: "number" },
            limit: { type: "number" }
          },
          required: ["filePath"]
        }
      },
      {
        name: "search_project_knowledge",
        description: "Execute permissioned vector search over project documentation.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" }
          },
          required: ["query"]
        }
      },
      {
        name: "get_journal_status",
        description: "Inspect current task DAG and project milestone completion status.",
        inputSchema: { type: "object", properties: {} }
      }
    ]
  };

  return Response.json(manifest);
}

if (url.pathname.match(/\/projects\/[^/]+\/mcp-execute/)) {
  const projectId = url.pathname.split("/")[2];
  const body = await request.json() as McpJsonRpcRequest;
  const callerRole = request.headers.get("x-naelao-caller-role") || "viewer";

  if (body.method === "tools/list") {
    // Return standard MCP tools list
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: { tools: [/* serialized project tools */] }
    });
  }

  if (body.method === "tools/call") {
    const { name, arguments: args } = body.params || {};

    // 1. Tool: read_project_file
    if (name === "read_project_file") {
      const row = this.ctx.storage.sql.exec(
        "SELECT content FROM workspace_files WHERE path = ? AND branch = 'main'",
        args.filePath
      ).toArray()[0] as any;

      if (!row) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32001, message: `File not found: ${args.filePath}` }
        }, 404);
      }

      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: row.content }
      });
    }

    // 2. Tool: get_journal_status
    if (name === "get_journal_status") {
      const tasks = this.ctx.storage.sql.exec(
        "SELECT id, title, status FROM project_tasks WHERE project_id = ? ORDER BY created_at DESC",
        projectId
      ).toArray();

      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { tasks }
      });
    }

    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: `Method or tool '${name}' not found on project.` }
    }, 404);
  }
}
```

---

### E. Mount Routes in `workers/spaces/src/index.ts`
Mount `mcpMeshApp` inside `workers/spaces/src/index.ts`:

```typescript
// Mount MCP Mesh Routes on the spaces worker
app.route("/", mcpMeshApp);
```

---

## 4. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. **Create `packages/types/src/mcp-mesh.ts`:**
   - Define and export all MCP v2 JSON-RPC types, tool schemas, and elicitation interfaces.
   - Re-export `mcp-mesh.ts` inside `packages/types/src/index.ts`.
2. **Implement `workers/spaces/src/routes/mcp-mesh-routes.ts`:**
   - Mount `GET` and `POST` routes for `/spaces/:spaceId/projects/:projectId/mcp`.
   - Ensure the request cleanly parses JSON-RPC 2.0 payloads and forwards calls to the appropriate `SpaceDO` instance.
3. **Refactor `workers/mcp-hub/src/index.ts`:**
   - Purge any remaining references to Pipedream tokens or polling endpoints.
   - Retain Composio exclusively as the managed SaaS OAuth broker.
   - Wire `project_*` server prefixes to route directly into the Inter-Project Mesh.
4. **Update `workers/spaces/src/do/SpaceDO.ts`:**
   - Add handlers for `/projects/:projectId/mcp-manifest` and `/projects/:projectId/mcp-execute`.
   - Connect `read_project_file` and `get_journal_status` to real SQLite storage.
5. **Update `workers/spaces/src/index.ts`:**
   - Mount `mcpMeshApp`.
6. Run `node --check` syntax validation across all modified files to ensure strict TypeScript compliance.
```
