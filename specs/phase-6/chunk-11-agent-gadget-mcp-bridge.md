Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 6 — Remediation Chunk 11**: `specs/phase-6/chunk-11-agent-gadget-mcp-bridge.md`.

---

```markdown
---
chunk_id: "phase-6-chunk-11"
phase: 6
include_files:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/script-engine/tool-surface.ts
  - workers/spaces/src/do/SpaceDO.ts
repomix_include:
  - "workers/agents/src/do/NaelaoAgentDO.ts"
  - "workers/agents/src/script-engine/tool-surface.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
expected_outputs:
  - workers/agents/src/do/NaelaoAgentDO.ts
  - workers/agents/src/script-engine/tool-surface.ts
---

# Phase 6 — Remediation Chunk 11: Agent-to-Gadget MCP Discovery & Auto-Registration

## 1. Executive Summary & Architectural Vision

Chunk 02 established the `gadget_instances` registry in `SpaceDO`, and Chunk 04 auto-exposed stateless `/mcp` endpoints on every `MicroAppDO` (Gadget) instance. However, a critical bridge gap exists: **`NaelaoAgentDO` has no mechanism to discover which gadgets are active in a project and dynamically bind their `/mcp` tool definitions into `ScriptToolSurface.ts` at run initialization.**

Without this bridge:
* Background indexer gadgets (e.g., `gadget_code_graph`, `gadget_ledger_reconciler`) build relational graphs in DO Facet SQLite, but the agent cannot see or query them.
* Canvas viewports (Tier 2 Gadgets) expose stateful operations, but the agent cannot invoke them via tool calls.

**The Solution:**
At the start of every reasoning turn, `NaelaoAgentDO` queries `SpaceDO` for installed gadgets matching the active `projectId` (for Tier 2 & 3 gadgets) and `userId` (for Tier 1 personal gadgets). It resolves their internal MCP endpoints (`http://internal/spaces/${spaceId}/gadgets/${instanceId}/mcp`) and registers their tools dynamically into `ScriptToolSurface.ts` under the qualified namespace `mcp.gadget_<instanceId>.<toolName>`.

```
[ NaelaoAgentDO Run Initialization ]
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. QUERY SpaceDO.listGadgetInstancesForRun(projectId, userId)              │
│    • Resolves Tier 2/3 Gadgets bound to `projectId`.                        │
│    • Resolves Tier 1 Personal Gadgets bound to `userId`.                    │
└─────────────────┬───────────────────────────────────────────────────────────┘
                  │
                  ▼ (Returns array of active gadget endpoints)
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. DYNAMIC MCP TOOL REGISTRATION (`ScriptToolSurface.ts`)                   │
│    Queries each Gadget's `/mcp` endpoint over internal DO RPC.              │
│    Registers tools into LLM context window:                                 │
│    • `mcp.gadget_code_graph_102.find_callers`                              │
│    • `mcp.gadget_ledger_99.get_unreconciled_pos`                            │
└─────────────────┬───────────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. REASONING TURN EXECUTION                                                 │
│    Agent queries background gadgets natively during tool execution turns!   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & Data Contracts

### A. Gadget Binding Interface (`packages/types/src/gadgets.ts`)
Ensure the runtime carries typed structures for discovered gadget endpoints:

```typescript
export interface DiscoveredGadgetEndpoint {
  instanceId: string;
  manifestId: string;
  tier: 1 | 2 | 3;
  internalMcpUrl: string; // e.g. "http://internal/spaces/s1/gadgets/g102/mcp"
}

export interface GadgetMcpToolMap {
  qualifiedToolName: string; // "mcp.gadget_g102.find_callers"
  instanceId: string;
  originalToolName: string;  // "find_callers"
  description: string;
  inputSchema: Record<string, any>;
}
```

---

## 3. Implementation Requirements

### A. Update `workers/spaces/src/do/SpaceDO.ts`
Implement `listGadgetInstancesForRun` to fetch active gadgets filtered by scope and tier:

```typescript
// Inside SpaceDO.ts
export class SpaceDO extends DurableObject {
  /**
   * Returns active gadget instances available for an agent execution run.
   * - Tier 2 (Canvas) & Tier 3 (Background Indexers) are scoped by projectId.
   * - Tier 1 (Personal Task Apps) are scoped by ownerUserId.
   */
  async listGadgetInstancesForRun(projectId?: string, userId?: string) {
    const sql = `
      SELECT id as instanceId, manifest_id as manifestId, tier
      FROM gadget_instances
      WHERE status = 'active'
        AND (
          (tier IN (2, 3) AND project_id = ?)
          OR (tier = 1 AND owner_user_id = ?)
        )
    `;
    const params = [projectId || "", userId || ""];
    const rows = this.ctx.storage.sql.exec(sql, ...params).toArray() as Array<{
      instanceId: string;
      manifestId: string;
      tier: number;
    }>;

    return rows.map(r => ({
      instanceId: r.instanceId,
      manifestId: r.manifestId,
      tier: r.tier as 1 | 2 | 3,
      internalMcpUrl: `http://internal/spaces/${this.ctx.id.toString()}/gadgets/${r.instanceId}/mcp`
    }));
  }
}
```

---

### B. Update `workers/agents/src/script-engine/tool-surface.ts`
Implement dynamic gadget tool registration and execution dispatches:

```typescript
import { DiscoveredGadgetEndpoint, GadgetMcpToolMap } from "@naelao/types";

export class ScriptToolSurface {
  private gadgetMcpTools = new Map<string, { internalMcpUrl: string; toolName: string }>();

  /**
   * Queries each discovered gadget's /mcp discovery endpoint and registers
   * its tools into the agent's available tool operations map.
   */
  async registerDiscoveredGadgetTools(
    gadgets: DiscoveredGadgetEndpoint[],
    ctx: { mcpHub: any; spaceId: string }
  ): Promise<void> {
    for (const gadget of gadgets) {
      try {
        // Query the gadget's auto-generated MCP v2 tool list
        const mcpResponse = await ctx.mcpHub.listToolsOverInternalRpc({
          endpointUrl: gadget.internalMcpUrl,
          spaceId: ctx.spaceId
        });

        if (mcpResponse && Array.isArray(mcpResponse.tools)) {
          for (const tool of mcpResponse.tools) {
            const qualifiedName = `mcp.gadget_${gadget.instanceId}.${tool.name}`;

            this.gadgetMcpTools.set(qualifiedName, {
              internalMcpUrl: gadget.internalMcpUrl,
              toolName: tool.name
            });

            // Register qualified operation in tool surface
            this.registerOperation(qualifiedName, {
              description: `[Gadget: ${gadget.manifestId}] ${tool.description}`,
              parameters: tool.inputSchema || { type: "object", properties: {} },
              handler: async (args: Record<string, any>) => {
                return await ctx.mcpHub.callToolOverInternalRpc({
                  endpointUrl: gadget.internalMcpUrl,
                  toolName: tool.name,
                  arguments: args,
                  spaceId: ctx.spaceId
                });
              }
            });
          }
        }
      } catch (err: any) {
        console.warn(`⚠️ Failed to register MCP tools for gadget '${gadget.instanceId}':`, err.message);
      }
    }
  }

  private registerOperation(name: string, opConfig: any) {
    // Registers operation in the internal operations map
  }
}
```

---

### C. Update `workers/agents/src/do/NaelaoAgentDO.ts`
Wire gadget discovery into `initializeRunContext()` before the reasoner loop begins:

```typescript
// Inside NaelaoAgentDO.ts
export class NaelaoAgentDO extends DurableObject {
  async initializeRunContext(runConfig: { spaceId: string; projectId?: string; userId?: string }) {
    // 1. Fetch space actor stub
    const spaceDO = this.getSpaceDOStub(runConfig.spaceId);

    // 2. Discover active gadgets for this project/user
    const discoveredGadgets = await spaceDO.listGadgetInstancesForRun(
      runConfig.projectId,
      runConfig.userId
    );

    // 3. Register discovered gadget MCP endpoints into tool surface
    const toolSurface = new ScriptToolSurface();
    await toolSurface.registerDiscoveredGadgetTools(discoveredGadgets, {
      mcpHub: this.env.MCP_HUB,
      spaceId: runConfig.spaceId
    });

    return { toolSurface, activeGadgetCounts: discoveredGadgets.length };
  }
}
```

---

## 4. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Update `workers/spaces/src/do/SpaceDO.ts`:
   - Add `listGadgetInstancesForRun(projectId, userId)` querying `gadget_instances` in SQLite.
2. Update `workers/agents/src/script-engine/tool-surface.ts`:
   - Add `gadgetMcpTools` Map and implement `registerDiscoveredGadgetTools()`.
   - Format qualified tool names as `mcp.gadget_<instanceId>.<toolName>`.
3. Update `workers/agents/src/do/NaelaoAgentDO.ts`:
   - In `initializeRunContext()`, fetch gadget endpoints from `SpaceDO` and pass them to `toolSurface.registerDiscoveredGadgetTools()`.
4. Run `node --check` syntax validation on all modified files to ensure strict TypeScript compliance.
```
