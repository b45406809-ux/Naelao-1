
***

```markdown
---
chunk_id: "phase-3-chunk-04"
phase: 3
include_files:
  - workers/spaces/src/do/SpaceDO.ts
  - workers/agents/src/connectors/bindings.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/agents/src/connectors/bindings.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - workers/spaces/src/do/SpaceDO.ts
  - workers/agents/src/connectors/bindings.ts
  - packages/types/src/connectors.ts
---

# Phase 3 — Chunk 04: Decoupled Logical Connector Binding Matrix

## 1. Mental Model & Architectural Vision

To make automations, dynamic workflows, and micro-apps truly modular and configurable by both humans and agents, **application code must never contain hardcoded email addresses, account handles, or specific token IDs.** 

If an agent hardcodes `gmail.send({ to: "sales@company.com" })`, the automation breaks the moment the company changes its support email.

Instead, AVOS implements **Logical Connector Aliasing**:
1. **The Code** requests a semantic alias (e.g., `ctx.connectors.use("inbound_support_mail")`).
2. **The Project** maintains a dynamic **Connection Binding Matrix** in `SpaceDO` SQLite that maps logical aliases to physical connections (e.g., Company Shared Gmail vs. Alice's Personal Gmail).
3. **The User or Agent** can switch accounts anytime through the UI or via MCP without modifying a single line of application code.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              DECOUPLED LOGICAL CONNECTOR BINDING MATRIX                                │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 📜 WORKFLOW / MICRO-APP CODE (In Tier 2 Isolate or Tier 3 Workflow):                                   │
│ `const gmail = await ctx.connectors.use("primary_inbox");`                                             │
│ `const crm   = await ctx.connectors.use("customer_database");`                                         │
└───────────────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                                    │ (Runtime resolves alias at execution)
                                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 🗄️ PROJECT BINDING MATRIX (`SpaceDO` SQLite `project_connector_bindings`)                              │
├──────────────────────────┬──────────────────────────────────────────┬──────────────────────────────────┤
│ Logical Alias            │ Active Mapped Connection                 │ Scope & Identity Override        │
├──────────────────────────┼──────────────────────────────────────────┼──────────────────────────────────┤
│ `"primary_inbox"`        │ 🏢 **`conn_gmail_company_support`**      │ Scope: Space-Shared (Team)       │
├──────────────────────────┼──────────────────────────────────────────┼──────────────────────────────────┤
│ `"customer_database"`    │ 📸 **`conn_notion_client_crm`**          │ Scope: Project-Bound             │
└──────────────────────────┴──────────────────────────────────────────┴──────────────────────────────────┘
```

If the alias is **not found** or the connection is broken, the runtime pauses execution and emits an **MCP v2 Elicitation Card** directly into the user's chat or canvas: `[ 🔗 Authenticate 'primary_inbox' via Composio ]`.

---

## 2. Implementation Requirements

### A. Define Connector Types (`packages/types/src/connectors.ts`)
Create a new file `packages/types/src/connectors.ts` (and export it from `packages/types/src/index.ts`):

```typescript
export interface ConnectorBinding {
  projectId: string;
  entityId: string;           // Workflow ID, Micro-App ID, or "default"
  logicalAlias: string;       // e.g., "primary_inbox"
  mappedConnectionId: string; // The physical Composio/Pipedream/Vault ID
  connectionType: string;     // e.g., "gmail", "stripe", "notion"
  customConfigJson: string;   // JSON string of app-specific configurations
  updatedBy: string;          // User ID or Agent ID who mapped it
  updatedAt: string;
}

export interface ConnectorResolutionResult {
  connected: boolean;
  connectionId?: string;
  connectionType?: string;
  config?: Record<string, any>;
  requiresElicitation?: boolean;
  elicitationPayload?: {
    message: string;
    requestedAlias: string;
    suggestedProviders: string[];
  };
}
```

### B. Update `SpaceDO.ts` (The Binding Matrix Schema)
In `workers/spaces/src/do/SpaceDO.ts`, update the `ensureInit()` method to create the `project_connector_bindings` table, and add methods to read/write it.

```typescript
// Inside SpaceDO.ts -> ensureInit()
this.ctx.storage.sql.exec(`
  CREATE TABLE IF NOT EXISTS project_connector_bindings (
    project_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    logical_alias TEXT NOT NULL,
    mapped_connection_id TEXT NOT NULL,
    connection_type TEXT NOT NULL,
    custom_config_json TEXT DEFAULT '{}',
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, entity_id, logical_alias)
  );
`);

// Add Methods to SpaceDO class:
async setConnectorBinding(params: Omit<ConnectorBinding, "updatedAt">) {
  this.ctx.storage.sql.exec(`
    INSERT INTO project_connector_bindings 
    (project_id, entity_id, logical_alias, mapped_connection_id, connection_type, custom_config_json, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, entity_id, logical_alias) DO UPDATE SET
      mapped_connection_id = excluded.mapped_connection_id,
      connection_type = excluded.connection_type,
      custom_config_json = excluded.custom_config_json,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `, params.projectId, params.entityId, params.logicalAlias, params.mappedConnectionId, params.connectionType, params.customConfigJson, params.updatedBy);
  return { ok: true };
}

async getConnectorBinding(projectId: string, entityId: string, logicalAlias: string): Promise<ConnectorBinding | null> {
  const row = this.ctx.storage.sql.exec(`
    SELECT * FROM project_connector_bindings 
    WHERE project_id = ? AND entity_id = ? AND logical_alias = ?
  `, projectId, entityId, logicalAlias).first();
  
  if (!row) return null;
  return {
    projectId: row.project_id as string,
    entityId: row.entity_id as string,
    logicalAlias: row.logical_alias as string,
    mappedConnectionId: row.mapped_connection_id as string,
    connectionType: row.connection_type as string,
    customConfigJson: row.custom_config_json as string,
    updatedBy: row.updated_by as string,
    updatedAt: row.updated_at as string
  };
}
```

### C. Create Resolver logic in `workers/agents/src/connectors/bindings.ts`
This file implements the logic that runs inside the V8 isolate or Workflow when `ctx.connectors.use("alias")` is called.

```typescript
import { ConnectorResolutionResult } from "@naelao/types";

/**
 * Resolves a logical connector alias into a physical connection ID by querying SpaceDO.
 * If the binding doesn't exist, it returns an elicitation payload to prompt the user in the UI.
 */
export async function resolveConnectorAlias(
  projectId: string, 
  entityId: string, 
  logicalAlias: string, 
  spaceDOStub: DurableObjectStub
): Promise<ConnectorResolutionResult> {
  
  // 1. Fetch the binding matrix row from SpaceDO
  const res = await spaceDOStub.fetch(`http://internal/projects/${projectId}/bindings/${entityId}/${logicalAlias}`);
  
  if (res.status === 404) {
    // 2. Missing Binding: Trigger MCP v2 Elicitation flow!
    // This tells the orchestrator to pause execution and render a UI card asking the user
    // to connect an account for this specific logical alias.
    return {
      connected: false,
      requiresElicitation: true,
      elicitationPayload: {
        message: `This automation requires an active account connection for '${logicalAlias}'.`,
        requestedAlias: logicalAlias,
        suggestedProviders: [] // UI will display the generic app catalog
      }
    };
  }

  const binding = await res.json() as any;

  // 3. Return the physical credentials mapping for Outbound Egress
  return {
    connected: true,
    connectionId: binding.mappedConnectionId,
    connectionType: binding.connectionType,
    config: JSON.parse(binding.customConfigJson || "{}")
  };
}
```
```
