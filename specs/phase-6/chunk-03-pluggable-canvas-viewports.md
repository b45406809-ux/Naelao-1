Here is the complete, single, fully-detailed Markdown specification file for **Phase 6 — Chunk 03**: `specs/phase-6/chunk-03-pluggable-canvas-viewports.md`.

---

```markdown
---
chunk_id: "phase-6-chunk-03"
phase: 6
include_files:
  - apps/shell/src/components/ProjectKindPanel.tsx
  - workers/spaces/src/do/SpaceDO.ts
  - workers/agents/src/script-engine/types.ts
repomix_include:
  - "apps/shell/src/components/ProjectKindPanel.tsx"
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/agents/src/script-engine/types.ts"
expected_outputs:
  - apps/shell/src/components/ProjectKindPanel.tsx
  - apps/shell/src/components/viewports/GadgetViewportHost.tsx
  - workers/spaces/src/do/SpaceDO.ts
---

# Phase 6 — Chunk 03: Pluggable Canvas Viewport Engine

## 1. Executive Summary & Architectural Vision

The "Composable OS" vision requires that the **apps/shell** remains agnostic of specific industry domains. We are moving away from hardcoding React components for every "Project Kind" (e.g., a specific `LegalCanvas` or `FinanceGrid`). 

Instead, we are implementing a **Pluggable Viewport Engine**. When a user opens a project, the Shell queries the `SpaceDO` to find the **Tier 2 Canvas Gadget** assigned to that project kind. The Shell then mounts a sandboxed iframe that loads its UI directly from a `MicroAppDO` instance.

This allows developers to build entirely new vertical interfaces (e.g., a DICOM medical image viewer or a 3D CAD renderer) as standalone Gadgets and register them as the default viewport for a new Project Kind without changing a single line of code in the core platform.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SHELL CANVAS ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│ 🖥️  apps/shell (The Host)                                                   │
│    └── 🧱 ProjectKindPanel.tsx (Container)                                  │
│        └── 🖼️  GadgetViewportHost.tsx (The pluggable iframe)                │
│             │                                                               │
│             ▼ (HTTPS GET /app)                                              │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ 📱  MicroAppDO (Tier 2 Gadget Instance)                                 │ │
│ │ • Serves SSR HTML/JS/CSS (Tailwind)                                     │ │
│ │ • Connects to Project Virtual FS (Tier 1)                               │ │
│ │ • Manages Private Project SQLite State                                  │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications

### A. Manifest-Driven Viewport Resolution (`SpaceDO.ts`)
The `ProjectKind` definition must now explicitly link to a `GadgetManifest` that serves the UI.

1.  **Update `Project` Table:** Ensure projects can store their active viewport configuration.
2.  **Logic:** When `getProject(id)` is called, the DO must resolve the `viewport_url` for the assigned Tier 2 Gadget.

```typescript
// Resolution Logic inside SpaceDO.ts
async function resolveProjectViewport(projectId: string) {
  // 1. Get Project Kind (e.g. "doc_studio")
  // 2. Lookup the Tier 2 Gadget Instance bound to this project
  const gadget = this.doStorage.sql.exec(
    "SELECT manifest_id FROM gadget_instances WHERE project_id = ? AND tier = 2", 
    projectId
  ).toArray()[0];
  
  // 3. Construct the secure, authenticated Gadget URL
  // Format: https://{spaceId}-{projectId}-{manifestId}.avos.apps/app
  return `https://${this.spaceId}-${projectId}-${gadget.manifest_id}.avos.apps/app`;
}
```

---

### B. The Viewport Host Component (`GadgetViewportHost.tsx`)
Create a new component in `apps/shell/src/components/viewports/GadgetViewportHost.tsx` that handles the secure mounting of the Micro-App.

**Requirements:**
*   **Sandboxing:** The iframe must use strict `sandbox` attributes (`allow-scripts`, `allow-forms`, `allow-popups`).
*   **Security:** Must use a `null-origin` or a dedicated per-instance subdomain to prevent Cross-Site Scripting (XSS) between gadgets.
*   **Authentication:** Passes a short-lived **Gatekeeper Token** via the URL fragment or a custom header to authorize the Gadget to read the project's Virtual FS.

---

### C. Updating `ProjectKindPanel.tsx`
Refactor the main project view to dynamic loading.

```tsx
// apps/shell/src/components/ProjectKindPanel.tsx refactor
export function ProjectKindPanel({ project, session }) {
  // If the project has a Tier 2 Gadget assigned, use the Pluggable Host
  if (project.viewportUrl) {
    return (
      <GadgetViewportHost 
        src={project.viewportUrl} 
        projectId={project.id}
        token={session.gatekeeperToken} 
      />
    );
  }

  // Fallback to standard File Explorer / Readme if no Gadget is installed
  return <DefaultWorkspaceView project={project} />;
}
```

---

## 3. The Communication Protocol (Shell ↔ Gadget ↔ Agent)

To ensure the "Live Hot-Reload" feel (sub-150ms updates), we utilize a three-way sync:

1.  **Agent ➔ Workspace:** Agent runs `Edit`. `NaelaoAgentDO` updates the SQLite Virtual FS and commits to Artifacts.
2.  **Workspace ➔ Gadget:** `SpaceDO` detects a file change and broadcasts a WebSocket message to all active `MicroAppDO` instances for that project.
3.  **Gadget ➔ UI:** The Gadget UI (inside the iframe) receives the signal and re-fetches the specific file fragment to update the view without a full page refresh.

---

## 4. Step-by-Step Implementation Instructions

1.  **Backend (Durable Object):**
    *   Update the `ProjectKind` registry to include a `default_viewport_id`.
    *   Modify `SpaceDO.getProject` to include a resolved `viewportUrl` in the JSON response.
2.  **Frontend (React):**
    *   Create `GadgetViewportHost.tsx`.
    *   Implement an `onLoad` handler to handle initial handshake with the iframe.
    *   Update `ProjectKindPanel.tsx` to remove hardcoded switches for `doc_studio`, `product_dev`, etc., and replace them with the dynamic `viewportUrl` logic.
3.  **Security:**
    *   Verify that the iframe is mounted with `loading="lazy"` and a restricted `csp` (Content Security Policy).
4.  **Testing:**
    *   Create a dummy Tier 2 Gadget manifest.
    *   Provision a project using that kind.
    *   Verify the shell successfully mounts the iframe and passes the `gatekeeperToken`.
```
