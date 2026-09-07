This is the **full, high-fidelity specification for Phase 6 — Chunk 02**. 

It establishes the "Composable OS" foundation of AVOS by turning the user interface and background intelligence into a **3-Tier Gadget System**. This moves the platform away from a static, hardcoded dashboard into a dynamic marketplace of pluggable capabilities.

---

### `specs/phase-6/chunk-02-gadget-hierarchy-registry.md`

```markdown
---
chunk_id: "phase-6-chunk-02"
phase: 6
include_files:
  - workers/spaces/src/do/SpaceDO.ts
  - workers/spaces/src/do/MicroAppDO.ts
  - packages/types/src/index.ts
  - packages/events/src/business-feature-kinds.ts
repomix_include:
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/spaces/src/do/MicroAppDO.ts"
  - "packages/types/src/index.ts"
  - "packages/events/src/business-feature-kinds.ts"
expected_outputs:
  - packages/types/src/gadgets.ts
  - infra/migrations/0074_gadget_registry_schema.sql
  - workers/spaces/src/do/SpaceDO.ts
  - workers/spaces/src/do/MicroAppDO.ts
---

# Phase 6 — Chunk 02: 3-Tier Micro-App (Gadget) Hierarchy & Registry

## 1. Executive Summary & Architectural Vision

AVOS is transitioning from a **Monolithic Shell** (where UI is hardcoded in React) to a **Composable Edge Operating System**. 

The core primitive of this OS is the **Gadget**: a sandboxed, full-stack micro-application running in a Cloudflare V8 Isolate with its own private **Durable Object Facet SQLite database**. Gadgets handle everything from specialized UI canvases to background data indexers.

To ensure strict privacy, security, and multi-tenant scaling, Gadgets are organized into a **3-Tier Hierarchy**. This prevents a "Customer Support Bot" from seeing a "CFO's Private Spreadsheet" and ensures that background indexers don't slow down the main user interface.

### The 3-Tier Gadget Taxonomy:

| Tier | Name | Scoping / Identity | Purpose |
| :--- | :--- | :--- | :--- |
| **1** | **Personal Task Gadget** | `(spaceId, userId, gadgetSlug)` | **Strictly Private.** Only the creating user can see/use this. Ideal for private scratchpads or personal productivity tools. |
| **2** | **Project Canvas Gadget** | `(spaceId, projectId, gadgetSlug)` | **Collaborative UI.** Shared by everyone in the project. Powers the specialized "Center Viewport" for a project kind. |
| **3** | **Background Indexer** | `(spaceId, projectId, gadgetSlug)` | **Headless Intelligence.** Runs silently to build symbol graphs (Code), ledgers (Finance), or citation maps (Legal). Auto-exposes `/mcp`. |

---

## 2. Technical Specification & Implementation Contracts

### A. Define Canonical Gadget Types (`packages/types/src/gadgets.ts`)

Create a new type definition file to govern the Gadget ecosystem:

```typescript
export type GadgetTier = 1 | 2 | 3;

export interface GadgetManifest {
  id: string;              // e.g. "naelao-code-editor-v1"
  slug: string;            // e.g. "editor"
  name: string;
  description: string;
  tier: GadgetTier;
  
  // Viewport Metadata (For Tier 2)
  isViewportProvider: boolean; 
  targetProjectKind?: string; // e.g. "product_dev"
  
  // Runtime Configuration
  runtime: {
    engine: "v8_isolate";
    database: "do_facet_sqlite";
    autoMcpV2: boolean;      // If true, wraps SQLite schema into tool-calls automatically
  };
}

export interface GadgetInstanceRecord {
  instanceId: string;      // Unique UUID for this specific install
  manifestId: string;      // Pointer to the Gadget template
  spaceId: string;
  projectId: string | null; // NULL for Tier 1 (Space-wide search)
  ownerUserId: string | null; // PRESENT only for Tier 1 (Privacy)
  configJson: string;       // Instance-specific settings
  status: "active" | "hibernating" | "archived";
}
```

---

### B. Database Migration: The Registry (`infra/migrations/0074_gadget_registry_schema.sql`)

Implement the schema in D1 to track installations and scoping. Note the `UNIQUE` constraint which prevents a project from having two "Main Viewports" or two "Code Graphs" of the same type.

```sql
-- Migration 0074: Gadget Registry and Scoping
CREATE TABLE IF NOT EXISTS gadget_instances (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
  space_id TEXT NOT NULL,
  project_id TEXT,             -- NULL for Tier 1
  owner_user_id TEXT,          -- NULL for Tier 2/3
  config_json TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hibernating', 'archived')),
  storage_usage_bytes INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  -- Prevent duplicate installs of the same tool in the same scope
  UNIQUE(space_id, project_id, owner_user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_gadget_lookup ON gadget_instances(space_id, project_id, owner_user_id);
```

---

### C. Update `SpaceDO.ts` (Registry Management)

Update `SpaceDO.ts` to manage the installation of gadgets. The Registry must resolve the "Effective Roster" of tools available to an agent or user based on their current project and identity.

1. **`installGadget(params)`**: Validates permissions and inserts a row into `gadget_instances`.
2. **`resolveGadgetRoster(projectId, userId)`**: Performs a union query:
   * Select Tier 1 gadgets owned by `userId`.
   * Select Tier 2/3 gadgets bound to `projectId`.
   * Returns a list of active `MicroAppDO` IDs.

---

### D. Update `MicroAppDO.ts` (The Factory & Addressing)

The `MicroAppDO` is a "Multi-Tenant Factory" Durable Object. To prevent data corruption, you must ensure that each Tier has a unique, isolated name for `idFromName()`.

**Addressing Logic (Naming Invariant):**
- **Tier 1 (Personal):** Name = `HMAC(spaceId + userId + gadgetSlug)`
- **Tier 2/3 (Project):** Name = `HMAC(spaceId + projectId + gadgetSlug)`

Update the `fetch` handler to verify the **Gatekeeper Token** (from Phase 3) to ensure the request is coming from the authorized owner of that Tier.

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

1.  **Types:** Create `packages/types/src/gadgets.ts` and add it to the main types export.
2.  **Migration:** Create the D1 migration file `0074_gadget_registry_schema.sql`.
3.  **SpaceDO Logic:**
    *   Add the `gadget_instances` table to the `ensureInit` transaction.
    *   Implement `installGadget` and `listGadgets` methods.
4.  **MicroAppDO Logic:**
    *   Refactor the DO addressing to support the **(Space:Project:Slug)** or **(Space:User:Slug)** naming convention.
    *   Ensure the SQLite storage inside the DO uses these isolated keys.
5.  **API Routes:** 
    *   In `workers/spaces/src/index.ts`, add:
        *   `GET /spaces/:spaceId/gadgets` (Lists all project/personal gadgets).
        *   `POST /spaces/:spaceId/gadgets` (Admin-gated: installs a new gadget).
6.  **Validation:** Run `npx turbo run typecheck` to ensure no circular dependencies were introduced between `SpaceDO` and `MicroAppDO`.
```

.
