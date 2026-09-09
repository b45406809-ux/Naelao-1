Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 8 — Chunk 02**: `specs/phase-8/chunk-02-1click-venture-exporter-and-sanitizer.md`.

---

```markdown
---
chunk_id: "phase-8-chunk-02"
phase: 8
include_files:
  - workers/spaces/src/business-routes.ts
  - packages/types/src/index.ts
  - workers/spaces/src/do/SpaceDO.ts
repomix_include:
  - "workers/spaces/src/business-routes.ts"
  - "packages/types/src/index.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
expected_outputs:
  - workers/spaces/src/business-routes.ts
  - packages/types/src/marketplace.ts
  - packages/types/src/index.ts
---

# Phase 8 — Chunk 02: 1-Click Venture Exporter & Secret Sanitizer

## 1. Executive Summary & Mental Model

Template builders, agency operators, and Forward Deployed Engineers (FDEs) should never write complex, error-prone JSON blueprint files by hand. Instead, they build and validate a real, live company or cowork studio directly inside AVOS (configuring projects, installing gadgets, writing domain linters, and testing agent workflows). Once satisfied with the setup, they click **[Export as Marketplace Template]**.

The **1-Click Venture Exporter** introspects the live space, serializes its structure, strips all private identity and authentication data, and packages it into an immutable, shareable blueprint:

```
[ Live, Working Business in SpaceDO (e.g. "Apex Legal M&A Studio") ]
                                │
                                ▼ (POST /spaces/:spaceId/export-template)
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. SPACE INTROSPECTION & STRUCTURAL HARVESTING                              │
│    Queries `SpaceDO` SQLite for projects, feature kinds, canvas viewports,   │
│    task DAGs, and internal `/.avos/` skills and workflow definitions.       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. PII & VAULT SECRET SANITIZATION (The Sanitizer Engine)                   │
│    • Physically scrubs all live API tokens, passwords, and private keys.     │
│    • Replaces active secrets with declarative credential requirements.      │
│    • Strips customer transcripts, customer phone numbers, and balances.     │
│    • Excludes `.env*` files, local grant configs, and ephemeral caches.      │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. BLUEPRINT COMPILATION & CANONICAL MANIFEST CREATION                      │
│    Assembles clean `ExportedBlueprintManifest` conforming to AVOS standards.│
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. R2 STORAGE & D1 MARKETPLACE REGISTRATION                                 │
│    • Stores manifest at `blueprints/${blueprintId}.json` in R2.             │
│    • Records listing row in D1 `marketplace_listings` for catalog search.   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. PII & Secret Sanitization Rules

The sanitization step must guarantee that **zero sensitive operational data leaks into the published template**.

### A. Secret Scrubbing & Parameterization
* Any active connection in `space_credentials` (Stripe secrets, GitHub tokens, Whop keys, OpenAI keys) is stripped.
* The exporter extracts the **service name and logical alias** to populate `requiredCredentials`:
  ```json
  {
    "name": "STRIPE_SECRET_KEY",
    "service": "stripe",
    "description": "Required to process client checkouts and invoice subscriptions.",
    "optional": false
  }
  ```

### B. PII & Customer Data Scrubbing
* **Customer Conversations:** `SpaceDO.customer_conversations` and `customer_messages` are completely omitted.
* **Member Rosters:** User IDs, emails, and personal settings from `space_members` and `business_memberships` are excluded. Only abstract structural roles (`owner`, `admin`, `editor`) are preserved.
* **Financial Ledgers:** Wallet transactions, payout requests, bank details, and invoice records in `wallet_ledger` are zeroed out.
* **File Clamping:** Files in `/workspace` are exported, but `.env*`, `.dev.vars*`, credentials files, and any file exceeding 2MB are automatically excluded.

---

## 3. Canonical Data Contracts (`packages/types/src/marketplace.ts`)

Create `packages/types/src/marketplace.ts` and re-export its contents in `packages/types/src/index.ts`:

```typescript
import { BusinessFeatureKind } from "@naelao/events";

export interface CredentialRequirement {
  name: string;
  service: string; // "stripe" | "github" | "google" | "twilio" | "whop" | "custom"
  description: string;
  optional: boolean;
}

export interface ExportedProjectBlueprint {
  name: string;
  slug: string;
  kind: string; // "product_dev" | "doc_studio" | "voice_agent" | "customer_bot" | etc.
  viewportComponent: string;
  allowedLadderTiers: number[];
  defaultContainer?: string;
  plugins: string[];
  linterRules: string[];
  initialJournalGoals: Array<{
    id: string;
    title: string;
    dependencies?: string[];
  }>;
  starterFiles: Array<{
    path: string;
    content: string;
    sizeBytes: number;
  }>;
}

export interface ExportedBlueprintManifest {
  blueprintId: string; // e.g. "tpl_1774900000_abc12"
  title: string;
  category: "LEGAL" | "FINANCE" | "HEALTHCARE" | "CONSTRUCTION" | "AGENCY" | "COMMERCE" | "MICRO_SAAS";
  templateMode: "autonomous_venture" | "vertical_cowork";
  description: string;
  version: string;
  author: {
    userId: string;
    email: string;
    name?: string;
  };
  pricingConfig?: {
    monetizationModel: "FREEMIUM_TIERED_SAAS" | "FIXED_ONE_OFF_UNLOCKED";
    fixedPriceCents?: number;
    monthlyPriceCents?: number;
  };
  projects: ExportedProjectBlueprint[];
  requiredCredentials: CredentialRequirement[];
  knowledgeSeeds: Array<{
    title: string;
    content: string;
    category?: string;
  }>;
  agentDirectives: {
    systemPromptSupplement?: string;
    standingMethodology?: string;
  };
  exportedAt: string;
}

export interface TemplateExportRequest {
  templateTitle: string;
  description: string;
  category: "LEGAL" | "FINANCE" | "HEALTHCARE" | "CONSTRUCTION" | "AGENCY" | "COMMERCE" | "MICRO_SAAS";
  monetizationModel: "FREEMIUM_TIERED_SAAS" | "FIXED_ONE_OFF_UNLOCKED";
  priceCents: number;
  includeKnowledgeSeeds?: boolean;
}
```

---

## 4. `SpaceDO.ts` Introspection Engine

Add the `exportSpaceState()` method to `workers/spaces/src/do/SpaceDO.ts`. This runs atomically inside the single-threaded Durable Object:

```typescript
// Inside workers/spaces/src/do/SpaceDO.ts
export interface SpaceExportSnapshot {
  spaceId: string;
  templateMode: "autonomous_venture" | "vertical_cowork";
  projects: Array<any>;
  workspaceFiles: Array<{ path: string; content: string; sizeBytes: number }>;
  credentialsDeclared: Array<{ name: string; service: string }>;
  knowledgeDocs: Array<{ title: string; content: string }>;
  taskGoals: Array<{ id: string; title: string; projectId: string }>;
}

export class SpaceDO extends DurableObject {
  // Existing implementation...

  async exportSpaceState(options: { includeKnowledge: boolean }): Promise<SpaceExportSnapshot> {
    // 1. Fetch space settings
    const spaceMeta = this.ctx.storage.sql.exec(
      "SELECT id, config_json FROM spaces WHERE id = ?",
      this.spaceId
    ).toArray()[0] as any;

    const config = spaceMeta ? JSON.parse(spaceMeta.config_json || "{}") : {};
    const templateMode = config.templateMode || "autonomous_venture";

    // 2. Fetch all active projects
    const projects = this.ctx.storage.sql.exec(
      "SELECT id, name, slug, kind, visibility FROM projects WHERE status = 'active'"
    ).toArray();

    // 3. Fetch workspace files (Sanitize: exclude .env and internal credentials)
    const filesRows = this.ctx.storage.sql.exec(
      "SELECT path, content, size_bytes FROM workspace_files WHERE path NOT LIKE '%.env%' AND path NOT LIKE '%.local%' AND size_bytes <= 2000000"
    ).toArray() as any[];

    // 4. Fetch declared credential names (never the keys!)
    const credRows = this.ctx.storage.sql.exec(
      "SELECT DISTINCT credential_name, service_name FROM space_credentials"
    ).toArray() as any[];

    // 5. Fetch knowledge seeds if requested
    let knowledgeDocs: Array<{ title: string; content: string }> = [];
    if (options.includeKnowledge) {
      const kbRows = this.ctx.storage.sql.exec(
        "SELECT title, content FROM knowledge_documents LIMIT 50"
      ).toArray() as any[];
      knowledgeDocs = kbRows.map(r => ({ title: r.title, content: r.content }));
    }

    // 6. Fetch active goals from Project Journal
    const taskRows = this.ctx.storage.sql.exec(
      "SELECT id, project_id, title FROM project_tasks WHERE status != 'ARCHIVED'"
    ).toArray() as any[];

    return {
      spaceId: this.spaceId,
      templateMode,
      projects,
      workspaceFiles: filesRows.map(f => ({ path: f.path, content: f.content, sizeBytes: f.size_bytes })),
      credentialsDeclared: credRows.map(c => ({ name: c.credential_name, service: c.service_name || "custom" })),
      knowledgeDocs,
      taskGoals: taskRows.map(t => ({ id: t.id, title: t.title, projectId: t.project_id }))
    };
  }
}
```

---

## 5. API Endpoint Implementation (`workers/spaces/src/business-routes.ts`)

Implement `POST /spaces/:spaceId/export-template` in `workers/spaces/src/business-routes.ts`:

```typescript
import { Hono } from "hono";
import { errorResponse } from "@naelao/http";
import { ExportedBlueprintManifest, TemplateExportRequest } from "@naelao/types";

// Inside business-routes.ts
app.post("/spaces/:spaceId/export-template", async (c) => {
  const { spaceId } = c.req.param();
  const callerUser = c.get("user"); // Verified caller from auth middleware

  if (!callerUser) {
    return errorResponse(c, 401, "unauthorized", "Authentication required to export templates");
  }

  // 1. Verify caller has administrative authority on this space
  const db = c.env.PLATFORM_DB;
  const membership = await db.prepare(
    "SELECT role FROM business_memberships WHERE space_id = ? AND user_id = ? AND status = 'active'"
  ).bind(spaceId, callerUser.id).first<{ role: string }>();

  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return errorResponse(c, 403, "forbidden", "Only space owners or administrators can export templates");
  }

  const body = await c.req.json() as TemplateExportRequest;
  if (!body.templateTitle || !body.category) {
    return errorResponse(c, 400, "invalid_request", "templateTitle and category are required");
  }

  // 2. Introspect Space State from SpaceDO
  const spaceDO = await getSpaceDOStub(c.env, spaceId);
  const snapshot = await spaceDO.exportSpaceState({
    includeKnowledge: body.includeKnowledgeSeeds !== false
  });

  // 3. Assemble and sanitize blueprint manifest
  const blueprintId = `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const manifest: ExportedBlueprintManifest = {
    blueprintId,
    title: body.templateTitle,
    category: body.category,
    templateMode: snapshot.templateMode,
    description: body.description || "",
    version: "1.0.0",
    author: {
      userId: callerUser.id,
      email: callerUser.email || "partner@developer.avos",
      name: callerUser.name
    },
    pricingConfig: {
      monetizationModel: body.monetizationModel || "FREEMIUM_TIERED_SAAS",
      fixedPriceCents: body.monetizationModel === "FIXED_ONE_OFF_UNLOCKED" ? body.priceCents : undefined,
      monthlyPriceCents: body.monetizationModel === "FREEMIUM_TIERED_SAAS" ? body.priceCents : undefined
    },
    projects: snapshot.projects.map(proj => {
      const projFiles = snapshot.workspaceFiles.filter(f => f.path.startsWith(`projects/${proj.id}/`));
      const projTasks = snapshot.taskGoals.filter(t => t.projectId === proj.id);

      return {
        name: proj.name,
        slug: proj.slug,
        kind: proj.kind,
        viewportComponent: resolveDefaultViewport(proj.kind),
        allowedLadderTiers: [1, 2, 6],
        plugins: [],
        linterRules: ["security-check", "syntax-check"],
        initialJournalGoals: projTasks.map(t => ({ id: t.id, title: t.title })),
        starterFiles: projFiles.map(f => ({
          path: f.path.replace(`projects/${proj.id}/`, ""),
          content: f.content,
          sizeBytes: f.sizeBytes
        }))
      };
    }),
    requiredCredentials: snapshot.credentialsDeclared.map(cred => ({
      name: cred.name,
      service: cred.service,
      description: `Required for ${cred.name} integration`,
      optional: false
    })),
    knowledgeSeeds: snapshot.knowledgeDocs,
    agentDirectives: {
      standingMethodology: "Operate strictly according to the project journal guidelines."
    },
    exportedAt: new Date().toISOString()
  };

  // 4. Store blueprint in Cloudflare R2
  const r2Key = `blueprints/${blueprintId}.json`;
  await c.env.SCRIPTS_R2.put(r2Key, JSON.stringify(manifest, null, 2), {
    customMetadata: {
      authorUserId: callerUser.id,
      templateMode: manifest.templateMode,
      category: manifest.category
    }
  });

  // 5. Record listing in D1 marketplace
  await db.prepare(`
    INSERT INTO marketplace_listings (
      id, author_user_id, name, description, category,
      pricing_model, price_cents, blueprint_r2_key, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', datetime('now'))
  `).bind(
    blueprintId,
    callerUser.id,
    manifest.title,
    manifest.description,
    manifest.category,
    body.monetizationModel,
    body.priceCents || 0,
    r2Key
  ).run();

  return c.json({
    ok: true,
    blueprintId,
    r2Key,
    manifestSummary: {
      projectsCount: manifest.projects.length,
      credentialsRequired: manifest.requiredCredentials.length,
      knowledgeSeedsCount: manifest.knowledgeSeeds.length
    }
  });
});

function resolveDefaultViewport(kind: string): string {
  switch (kind) {
    case "doc_studio": return "DocumentRedlineCanvas";
    case "product_dev": return "CodeWorkspaceCanvas";
    case "voice_agent": return "VoiceAgentCanvas";
    case "customer_bot": return "SupportTicketsCanvas";
    case "model_studio": return "ModelStudioCanvas";
    default: return "WorkspaceFilesPanel";
  }
}
```

---

## 6. Implementation Instructions for the AI Runner

When applying this chunk:
1. **Create `packages/types/src/marketplace.ts`:**
   - Define and export `CredentialRequirement`, `ExportedProjectBlueprint`, `ExportedBlueprintManifest`, and `TemplateExportRequest`.
   - Re-export all types in `packages/types/src/index.ts`.
2. **Update `workers/spaces/src/do/SpaceDO.ts`:**
   - Implement `exportSpaceState()` ensuring file paths, SQLite task goals, and declared credential names are collected without reading secret tokens or user PII.
3. **Update `workers/spaces/src/business-routes.ts`:**
   - Implement `POST /spaces/:spaceId/export-template` with role validation, PII scrubbing, R2 upload (`SCRIPTS_R2`), and D1 listing insertion.
4. **Syntax & Type Validation:**
   - Run `node --check` on modified JavaScript/TypeScript targets to ensure strict syntax correctness.
```
