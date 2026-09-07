This chunk completes the Phase 6 foundation by formally defining the **`kind` architecture**, moving away from hardcoded UI components in `apps/shell` to a **runtime-registered Viewport registry**.

---

### Phase 6 — Chunk 10: Unified \"Studio\" Project Kinds Formalization

```markdown
---
chunk_id: "phase-6-chunk-10"
phase: 6
include_files:
  - packages/events/src/business-feature-kinds.ts
  - apps/shell/src/components/ProjectKindPanel.tsx
  - workers/spaces/src/do/SpaceDO.ts
repomix_include:
  - "packages/events/src/business-feature-kinds.ts"
  - "apps/shell/src/components/ProjectKindPanel.tsx"
  - "workers/spaces/src/do/SpaceDO.ts"
expected_outputs:
  - packages/events/src/business-feature-kinds.ts
  - apps/shell/src/components/ProjectKindPanel.tsx
  - workers/spaces/src/do/SpaceDO.ts
---

# Phase 6 — Chunk 10: Unified "Studio" Project Kinds Formalization

## 1. Mental Model & Architectural Vision

The platform must transition from hardcoded project behaviors to **declarative project kinds**. 

Previously, if we wanted to add a "Medical Charting Studio," we had to edit `ProjectKindPanel.tsx`. In this architecture, a "Kind" is simply a configuration manifest that tells the Shell:
1. Which **Viewport Gadget** to mount in the center canvas.
2. What the **Execution Ladder Ceiling** is (e.g., T1 for support vs. T6 for training).
3. Which **Plugin/Capability Bundle** is active.

This allows developers to ship new project kinds as marketplace templates without touching the core Shell codebase.

```
┌─────────────────────────────────────────────────────────────┐
│                   THE PROJECT KIND REGISTRY                 │
├─────────────────────────────────────────────────────────────┤
│ Kind Manifest:                                              │
│ • `viewportComponent` (The Gadget ID)                       │
│ • `allowedLadderTiers` (e.g., [1, 2, 6])                    │
│ • `lifecycle` (finite vs. continuous)                       │
│ • `domainSystemPrompt` (The Agent's Persona)                │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 🚀 SHELL DYNAMIC MOUNT (`ProjectKindPanel.tsx`)             │
│ • Reads Kind manifest from SpaceDO.                         │
│ • Mounts the correct Iframe Gadget/Viewport.                │
│ • Applies the specific Ladder Tier Firewall.                │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Implementation Requirements

### A. Formalize Registry (`packages/events/src/business-feature-kinds.ts`)

```typescript
export interface BusinessFeatureKind {
  kind: string;
  label: string;
  description: string;
  viewportComponent: string;     // Refers to an installed Gadget/Viewport
  allowedLadderTiers: number[];
  defaultContainer?: string;
  lifecycle: "finite" | "continuous";
  domainSystemPrompt: string;
  linterRules: string[];
}

export const AVOS_PROJECT_KINDS: Record<string, BusinessFeatureKind> = {
  product_dev: {
    kind: "product_dev",
    label: "Product Engineering Studio",
    description: "Full-stack edge development.",
    viewportComponent: "CodeWorkspaceCanvas",
    allowedLadderTiers: [1, 2, 6],
    defaultContainer: "standard_node_linux",
    lifecycle: "finite",
    domainSystemPrompt: "You are a Senior Edge Engineer...",
    linterRules: ["typescript-strict", "no-secrets"]
  },
  doc_studio: {
    kind: "doc_studio",
    label: "Document Redline Studio",
    description: "Legal/Finance contract redlining.",
    viewportComponent: "DocumentRedlineCanvas",
    allowedLadderTiers: [1, 2],
    lifecycle: "finite",
    domainSystemPrompt: "You are a Legal Counsel...",
    linterRules: ["pii-scrubber"]
  },
  voice_agent: {
    kind: "voice_agent",
    label: "Voice Phone Desk",
    description: "24/7 AI Receptionist.",
    viewportComponent: "VoiceAgentCanvas",
    allowedLadderTiers: [1, 2],
    lifecycle: "continuous",
    domainSystemPrompt: "You are a Voice Receptionist...",
    linterRules: []
  }
  // ... Add model_studio, customer_bot, growth_engine, app_studio
};
```

### B. Implement Dynamic Mounting (`apps/shell/src/components/ProjectKindPanel.tsx`)

```tsx
export function ProjectKindPanel({ project }: { project: any }) {
  const kind = AVOS_PROJECT_KINDS[project.kind];
  
  // Use React.lazy or a Registry Map to resolve the component
  const Viewport = ViewportRegistry[kind.viewportComponent];

  return (
    <div className="viewport-container">
      <Viewport 
        projectId={project.id}
        ladderTier={kind.allowedLadderTiers} 
        domainPrompt={kind.domainSystemPrompt}
      />
    </div>
  );
}
```

### C. Backend Enforcement (`workers/spaces/src/do/SpaceDO.ts`)
Ensure that project creation is restricted to registered kinds:

```typescript
// Inside SpaceDO.ts
async createProject(params: { name: string, kind: string }) {
  if (!AVOS_PROJECT_KINDS[params.kind]) {
    throw new Error("Invalid project kind");
  }
  
  // Perform record insertion...
}
```

---

## 3. Step-by-Step Implementation Flow

1. **Phase Registry:** Define the `BusinessFeatureKind` contract in `packages/types/` and the registry in `packages/events/`.
2. **Dashboard Logic:** Update the "New Project" creation form to dynamically fetch this registry and validate inputs.
3. **Shell Mounting:** Update `ProjectKindPanel.tsx` to handle the dynamic component resolution.
4. **DO Hardening:** Ensure `SpaceDO` performs type/kind validation before any SQL `INSERT` into the `projects` table.
```

---
