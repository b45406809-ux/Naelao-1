Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 6 — Chunk 04**: `specs/phase-6/chunk-04-background-stateful-indexers.md`.

---

```markdown
---
chunk_id: "phase-6-chunk-04"
phase: 6
include_files:
  - workers/spaces/src/do/MicroAppDO.ts
  - workers/spaces/src/do/SpaceDO.ts
  - workers/knowledge/src/index.ts
  - packages/events/src/index.ts
repomix_include:
  - "workers/spaces/src/do/MicroAppDO.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/knowledge/src/index.ts"
  - "packages/events/src/index.ts"
expected_outputs:
  - workers/spaces/src/do/MicroAppDO.ts
  - workers/knowledge/src/background-processor.ts
  - workers/spaces/src/engine/AutoMcpFactory.ts
---

# Phase 6 — Chunk 04: Background Stateful Indexer Gadgets (Tier 3)

## 1. Mental Model & Architectural Vision

Traditional AI agents are "blind" to large-scale relationships in a codebase or a financial ledger because they can only see the few files they read into their context window. 

**Tier 3 Background Indexer Gadgets** solve this by acting as the **"Relational Senses"** of the project. These are headless, stateful micro-apps that run silently in the background. Whenever a file is modified in the workspace, these gadgets parse the change and update a private, high-speed relational graph in their own **DO Facet SQLite database**.

### The Workflow:
1.  **Change Event:** A human or agent edits a file (e.g., `auth.ts` or `q3_ledger.csv`).
2.  **Trigger:** The `SpaceDO` emits a `workspace.file_changed` event.
3.  **Ingestion:** The Tier 3 Indexer Gadget (e.g., `gadget_code_graph`) wakes up, parses the file (using Tree-sitter for code or CSV parsers for finance), and updates its SQLite tables.
4.  **Discovery:** The Agent asks: *"Who depends on the `verifyToken` function?"*
5.  **Query:** Instead of searching the whole repo, the Agent calls the Gadget's auto-generated **MCP v2 tool**. The Gadget queries its SQLite DB and replies in 2ms.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              THE BACKGROUND GADGET INDEXER MESH                                        │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ [ File Edited in Workspace (e.g. `src/auth.ts` or `invoices/Q3.csv`) ]                                 │
│                                           │                                                            │
│                                           ▼ (Event broadcast via WsHubDO)                              │
│ ┌────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 📱 TIER 3 GADGET (Headless Dynamic Worker + Private DO Facet SQLite)                               │ │
│ │ • Parses the file diff silently in the background (sub-5ms).                                       │ │
│ │ • Updates private internal graph in DO Facet SQLite (`graph.sqlite`).                              │ │
│ │ • Zero CPU or token overhead on the human's active chat!                                           │ │
│ └─────────────────────────────────────────┬──────────────────────────────────────────────────────────┘ │
│                                           │                                                            │
│                                           ▼ (Auto-Exposes Stateless MCP v2 Endpoint)                   │
│ ┌────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ⚡ UNIVERSAL AGENT (NaelaoAgentDO)                                                                 │ │
│ │ Calls the gadget natively via standard MCP: `mcp.call("code_graph", "find_impact", { file })`      │ │
│ └────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & Implementation Contracts

### A. The Auto-MCP v2 Factory (`workers/spaces/src/engine/AutoMcpFactory.ts`)

Every Tier 3 Gadget must automatically expose its internal SQLite tables as queryable MCP tools. We use the `@cloudflare/mcp` SDK to generate a stateless handler.

```typescript
import { createMcpHandler } from "@cloudflare/mcp";

/**
 * Automatically wraps a Gadget's SQLite schema into a set of standard MCP tools.
 */
export function generateMcpHandlerForGadget(
  gadgetId: string, 
  doStorage: DurableObjectStorage
) {
  return createMcpHandler({
    tools: {
      // 1. Semantic Search / Query Tool
      [`query_${gadgetId}`]: {
        description: `Run a read-only SQL query against the ${gadgetId} relational graph.`,
        parameters: {
          sql: { type: "string", description: "The SQL SELECT statement to execute." },
          params: { type: "array", items: { type: "string" }, description: "Query parameters." }
        },
        execute: async ({ sql, params }) => {
          // Strictly enforce read-only SELECT
          if (!sql.trim().toLowerCase().startsWith("select")) {
            throw new Error("Only SELECT queries are permitted via MCP.");
          }
          return doStorage.sql.exec(sql, ...(params || [])).toArray();
        }
      },
      // 2. Schema Discovery Tool
      [`inspect_${gadgetId}_schema`]: {
        description: `List tables and columns available in the ${gadgetId} indexer.`,
        parameters: {},
        execute: async () => {
          return doStorage.sql.exec("SELECT name, sql FROM sqlite_master WHERE type='table'").toArray();
        }
      }
    }
  });
}
```

---

### B. Update `MicroAppDO.ts` (Headless Execution)

The `MicroAppDO` must now handle background event ingestion and MCP requests.

```typescript
import { generateMcpHandlerForGadget } from "../engine/AutoMcpFactory";

export class MicroAppDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const gadgetId = this.ctx.id.toString(); // Resolved via Tier-3 naming

    // 1. Route: Inbound Workspace Events (Ingestion)
    if (url.pathname === "/events/ingest") {
      const event = await request.json() as { type: string; filePath: string; content: string };
      await this.processWorkspaceChange(event);
      return new Response(JSON.stringify({ ok: true }));
    }

    // 2. Route: Stateless MCP v2 Endpoint
    if (url.pathname === "/mcp") {
      const handler = generateMcpHandlerForGadget(gadgetId, this.ctx.storage);
      return handler(request);
    }

    // 3. Fallback: Standard Micro-App UI/API (T1/T2)
    return new Response("Not Found", { status: 404 });
  }

  private async processWorkspaceChange(event: any) {
    // 1. Identify File Type (Code vs Data)
    // 2. Run Parser (Wasm Tree-sitter or CSV Stream)
    // 3. Perform atomic upsert into private DO Facet SQLite
    console.log(`Indexing ${event.filePath}...`);
  }
}
```

---

### C. Background Event Dispatcher (`workers/knowledge/src/background-processor.ts`)

Create a new service that listens to `workspace.file_changed` events and pings the correct Tier 3 gadgets.

```typescript
export async function dispatchToProjectIndexers(
  spaceId: string, 
  projectId: string, 
  fileChange: { path: string; content: string },
  env: any
) {
  // 1. Query SpaceDO for installed Tier 3 gadgets in this project
  const spaceDO = await env.SPACES_WORKER.getSpace(spaceId);
  const gadgets = await spaceDO.listGadgets({ projectId, tier: 3 });

  // 2. Fan-out to each indexer gadget
  const pings = gadgets.map(gadget => {
    const gadgetDO = env.MICRO_APP_DO.get(env.MICRO_APP_DO.idFromName(`${spaceId}:${projectId}:${gadget.manifestId}`));
    return gadgetDO.fetch("http://internal/events/ingest", {
      method: "POST",
      body: JSON.stringify({
        type: "file_changed",
        filePath: fileChange.path,
        content: fileChange.content
      })
    });
  });

  await Promise.allSettled(pings);
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

1.  **MCP Factory:** Create `workers/spaces/src/engine/AutoMcpFactory.ts` implementing the generic SQL-to-MCP wrapper.
2.  **Durable Object Update:** Update `workers/spaces/src/do/MicroAppDO.ts` to handle the `/mcp` route and the background `/events/ingest` logic.
3.  **Knowledge Worker Integration:** In `workers/knowledge/src/index.ts`, hook into the post-upload/post-edit cycle to call `dispatchToProjectIndexers`.
4.  **Schema Migration:** If not done in Chunk 02, ensure `SpaceDO` has the indexing logic for mapping events to gadget instances.
5.  **Validation:** Ensure that the `query_` MCP tools strictly enforce `SELECT` statements to prevent agents from corrupting the indexer's private database.
```
