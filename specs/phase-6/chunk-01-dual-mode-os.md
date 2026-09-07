Here is the full, ultra-detailed, production-ready Markdown specification file for **Phase 6 — Chunk 01**: `specs/phase-6/chunk-01-dual-mode-os.md`. 


---

```markdown
---
chunk_id: "phase-6-chunk-01"
phase: 6
include_files:
  - packages/types/src/blueprint.ts
  - workers/agents/src/launchpad/spacetype.ts
  - workers/spaces/src/do/SpaceDO.ts
repomix_include:
  - "packages/types/src/blueprint.ts"
  - "workers/agents/src/launchpad/spacetype.ts"
  - "workers/spaces/src/do/SpaceDO.ts"
expected_outputs:
  - packages/types/src/blueprint.ts
  - workers/agents/src/launchpad/spacetype.ts
---

# Phase 6 — Chunk 01: The Dual-Mode Operating System Switch

## 1. Executive Summary & Architectural Vision

AVOS is designed as a universal operating system capable of instantiating two fundamentally different business architectures from the exact same underlying Cloudflare edge infrastructure:
1. **Mode A: Autonomous Ventures ("The AI Operator"):** Built for solo founders, digital franchises, and automated web businesses. The agent operates proactively, runs unattended crons, manages storefront payments, and executes growth campaigns with an `approval_mode: "yolo"` posture.
2. **Mode B: Vertical Cowork Studios ("Harvey AI for X"):** Built for regulated professionals (law firms, private equity funds, medical clinics, civil engineers). The agent operates as an assistive, human-in-the-loop co-pilot (`approval_mode: "always_ask"`), specializing in document redlining, financial modeling, compliance checking, and case briefings.

```
┌─────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────┐
│ 🚀 MODE A: AUTONOMOUS VENTURE ("The AI Operator")           │ 💼 MODE B: VERTICAL COWORK STUDIO ("Harvey AI for X")       │
├─────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ • **Target Buyer:** Solo founders, digital franchises.      │ • **Target Buyer:** Law firms, PE funds, clinics, architects.│
│ • **Operation:** Proactive, unattended, scheduled crons.    │ • **Operation:** Assistive, collaborative, human-in-the-loop.│
│ • **Workflows:** Auto-deploys sites, runs outreach, Stripe. │ • **Workflows:** Redlines contracts, SEC 10-K RAG, SOAP notes│
│ • **UI Canvas:** Live Edge Website Preview + MRR Radar.     │ • **UI Canvas:** Domain Viewports (Redline / Financial Grid).│
│ • **Autonomy Posture:** `approval_mode: "yolo"`             │ • **Autonomy Posture:** `approval_mode: "always_ask"`       │
└─────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications & File Implementation Contracts

### A. Update Blueprint Types (`packages/types/src/blueprint.ts`)

Extend the core `BusinessBlueprint` interface to support the dual-mode switch and cowork-specific compliance configurations:

```typescript
export type TemplateOperatingMode = "autonomous_venture" | "vertical_cowork";

export interface CoworkStudioConfig {
  defaultViewport: "DocumentRedlineCanvas" | "SpreadsheetFormulaGrid" | "ClinicalSoapEditor" | "PlanSpecCanvas";
  enforceCitationFootnotes: boolean;
  auditLogRetentionDays: number; // e.g. 365 for HIPAA/Legal compliance
  airGappedModeAvailable: boolean;
  collaborativeMode: "realtime_crdt" | "git_pr_mesh";
}

export interface BusinessBlueprint {
  id: string; // e.g. "tpl_lexpulse_legal_v1"
  title: string;
  category: "LEGAL" | "FINANCE" | "HEALTHCARE" | "CONSTRUCTION" | "AGENCY" | "MICRO_SAAS";
  
  // The Core Operating Mode Switch
  templateMode: TemplateOperatingMode;
  
  description: string;
  version: string;
  author: {
    userId: string;
    name: string;
    royaltyRate: number; // 0.40 for referral, 0.20 for organic
  };

  // Optional Cowork Configuration (Required when templateMode === "vertical_cowork")
  coworkConfig?: CoworkStudioConfig;

  // Pre-configured project workspaces in this space
  projects: Array<{
    name: string;
    slug: string;
    kind: "product_dev" | "doc_studio" | "voice_agent" | "customer_bot" | "model_studio" | "growth_engine" | "app_studio";
    viewportComponent: string;
    allowedLadderTiers: Array<1 | 2 | 3 | 4 | 5 | 6>;
    defaultContainer?: string;
    plugins: string[];
    linterRules: string[];
    initialJournalGoals: Array<{ id: string; title: string; dependencies?: string[] }>;
  }>;

  // Domain Knowledge Seeds (Pre-indexed into Cloudflare AI Search)
  knowledgeSeeds: Array<{
    title: string;
    content: string;
    category: string;
    sourceDocumentUrl?: string;
  }>;
}
```

---

### B. Update Spacetype Launchpad Registry (`workers/agents/src/launchpad/spacetype.ts`)

Configure how blueprints instantiate their runtime environment based on `templateMode`:

```typescript
import { BusinessBlueprint } from "@naelao/types";

export function resolveTemplateRuntimeBehavior(blueprint: BusinessBlueprint) {
  const isCowork = blueprint.templateMode === "vertical_cowork";

  return {
    operatingMode: blueprint.templateMode,
    defaultAutonomy: isCowork ? "always_ask" : "yolo",
    enableProactiveCrons: !isCowork, // Autonomous ventures run background crons; cowork studios wait for human turns
    enforceCitations: isCowork ? (blueprint.coworkConfig?.enforceCitationFootnotes ?? true) : false,
    auditRetentionDays: isCowork ? (blueprint.coworkConfig?.auditLogRetentionDays ?? 365) : 30,
    defaultViewport: isCowork ? (blueprint.coworkConfig?.defaultViewport ?? "DocumentRedlineCanvas") : "CodeWorkspaceCanvas"
  };
}
```

---

### C. Update `SpaceDO.ts` Runtime Mode Enforcement

Ensure `SpaceDO` initializes space metadata reflecting the active template operating mode:

```typescript
export async function initializeSpaceRuntimeMode(
  spaceId: string,
  blueprint: BusinessBlueprint,
  doStorage: DurableObjectStorage
) {
  const runtimeBehavior = resolveTemplateRuntimeBehavior(blueprint);

  // Store runtime configuration in DO SQLite state
  doStorage.sql.exec(`
    INSERT OR REPLACE INTO space_metadata (key, value, updated_at)
    VALUES 
      ('template_mode', ?, datetime('now')),
      ('default_autonomy', ?, datetime('now')),
      ('audit_retention_days', ?, datetime('now'))
  `, runtimeBehavior.operatingMode, runtimeBehavior.defaultAutonomy, runtimeBehavior.auditRetentionDays);

  return { ok: true, runtimeBehavior };
}
```

---

## 3. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Update `packages/types/src/blueprint.ts` with the new `TemplateOperatingMode`, `CoworkStudioConfig`, and updated `BusinessBlueprint` fields.
2. Update `workers/agents/src/launchpad/spacetype.ts` to include `resolveTemplateRuntimeBehavior`.
3. Update `SpaceDO.ts` to initialize space metadata using `initializeSpaceRuntimeMode`.
4. Run `node --check` syntax checks across modified files to ensure strict TypeScript compliance.
```
