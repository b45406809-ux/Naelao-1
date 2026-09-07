Here is the complete, single, fully-detailed Markdown specification file for **Phase 6 — Chunk 02**: `specs/phase-6/chunk-02-canvas-viewport-architecture.md`.

---

```markdown
---
chunk_id: "phase-6-chunk-02"
phase: 6
include_files:
  - apps/shell/src/components/ProjectKindPanel.tsx
  - workers/spaces/src/do/SpaceDO.ts
  - workers/ws-gateway/src/WsHubDO.ts
  - packages/ui/src/styles.css
repomix_include:
  - "apps/shell/src/components/ProjectKindPanel.tsx"
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/ws-gateway/src/WsHubDO.ts"
  - "packages/ui/src/styles.css"
expected_outputs:
  - apps/shell/src/components/viewports/DocumentRedlineCanvas.tsx
  - apps/shell/src/components/viewports/CodeWorkspaceCanvas.tsx
  - apps/shell/src/components/ProjectKindPanel.tsx
---

# Phase 6 — Chunk 02: Canvas-First / Domain Viewport Architecture

## 1. Executive Summary & Architectural Vision

The core shift in Phase 6 is moving from **Chat-Centric UI** (where the user watches text bubbles) to **Canvas-Centric UI** (where the user works inside a domain-specific "Workshop").

In this "Canvas-First" model, the chat becomes a side-drawer, and the center of the screen is a **Viewport**. Each `project.kind` (Legal, Dev, Finance) mounts a specialized React component that provides direct, high-bandwidth interaction with the project's data.

### The Hot-Reload Invariant:
When an agent or a background workflow applies an AST edit via `Edit` or `Write`, the backend (`SpaceDO`) broadcasts a `workspace.file_changed` event. The Viewport intercepts this event and hot-reloads the visual state in **sub-150ms**, ensuring the human and AI are always looking at the same "live" reality.

---

## 2. The Viewport Registry & Dispatcher (`ProjectKindPanel.tsx`)

Update the `ProjectKindPanel` to act as the central dispatcher for domain viewports.

```typescript
// apps/shell/src/components/ProjectKindPanel.tsx

import { DocumentRedlineCanvas } from "./viewports/DocumentRedlineCanvas";
import { CodeWorkspaceCanvas } from "./viewports/CodeWorkspaceCanvas";
import { useProjectWebSocket } from "../hooks/useProjectWebSocket";

export function ProjectKindPanel({ project, spaceId }) {
  // 1. Subscribe to real-time project events (WsHubDO)
  const { lastEvent } = useProjectWebSocket(spaceId, project.id);

  // 2. Resolve Viewport based on Project Kind
  const renderViewport = () => {
    switch (project.kind) {
      case "doc_studio":
        return <DocumentRedlineCanvas project={project} lastEvent={lastEvent} />;
      case "product_dev":
        return <CodeWorkspaceCanvas project={project} lastEvent={lastEvent} />;
      case "finance_grid":
        return <FinanceGridCanvas project={project} lastEvent={lastEvent} />;
      default:
        // Default to a rich File Tree + Preview if no specialized viewport exists
        return <StandardWorkspaceCanvas project={project} lastEvent={lastEvent} />;
    }
  };

  return (
    <div className="viewport-container" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <header className="viewport-header">
        <Badge>{project.kind.toUpperCase()}</Badge>
        <h2>{project.name}</h2>
      </header>
      <main className="viewport-main">
        {renderViewport()}
      </main>
    </div>
  );
}
```

---

## 3. Specialized Viewport: Document Redline Canvas (`doc_studio`)

Implement the side-by-side legal diffing canvas. This is the "Harvey AI" equivalent for AVOS.

```typescript
// apps/shell/src/components/viewports/DocumentRedlineCanvas.tsx

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";

export function DocumentRedlineCanvas({ project, lastEvent }) {
  const [activeFile, setActiveFile] = useState(null);
  const [diffData, setDiffData] = useState(null);

  // Hot-reload when the backend reports a file change
  useEffect(() => {
    if (lastEvent?.type === "workspace.file_changed" && lastEvent.path === activeFile?.path) {
      refreshDiff();
    }
  }, [lastEvent]);

  async function refreshDiff() {
    const res = await apiFetch(`/spaces/${project.space_id}/projects/${project.id}/diff`, {
      method: "POST",
      body: JSON.stringify({ path: activeFile.path, branch: "main", vs: "proposed" })
    });
    setDiffData(res);
  }

  return (
    <div className="redline-canvas">
      <div className="document-sidebar">
        {/* List of project documents (Leases, NDAs, Deeds) */}
      </div>
      <div className="diff-viewer">
        <header>
          <h3>Reviewing: {activeFile?.name}</h3>
          <div className="action-buttons">
            <button className="btn-approve">✅ Accept Redlines</button>
            <button className="btn-reject">❌ Reject</button>
          </div>
        </header>
        <div className="side-by-side-pane">
           <div className="original-text">
             {/* Renders original Markdown from Parse 5 */}
           </div>
           <div className="proposed-changes">
             {/* Renders high-contrast redlines/diffs */}
           </div>
        </div>
      </div>
    </div>
  );
}
```

---

## 4. Backend Broadcast Wiring (`SpaceDO.ts`)

Whenever a file is updated in the SQLite Virtual Filesystem, `SpaceDO` must notify all connected UI canvases via `WsHubDO`.

```typescript
// workers/spaces/src/do/SpaceDO.ts (inside handleFileWrite)

async handleFileWrite(path: string, content: string, hash: string) {
  // 1. Perform the atomic SQLite write (OCC)
  const result = this.db.sql.exec(
    `UPDATE workspace_files SET content = ?, hash = ? WHERE path = ?`,
    content, newHash, path
  );

  // 2. Broadcast the change event to the Project WebSocket Room
  await this.env.WS_GATEWAY.get(this.env.WS_GATEWAY.idFromName(this.spaceId)).fetch(
    "http://ws-hub/broadcast",
    {
      method: "POST",
      body: JSON.stringify({
        type: "workspace.file_changed",
        projectId: this.projectId,
        path: path,
        hash: newHash,
        timestamp: Date.now()
      })
    }
  );
}
```

---

## 5. CSS tokens for Canvas Layout (`packages/ui/src/styles.css`)

Add base layout primitives for the side-by-side canvas:

```css
.viewport-main {
  display: flex;
  height: 100%;
  background: var(--bg-canvas);
}

.redline-canvas {
  display: grid;
  grid-template-columns: 240px 1fr;
  width: 100%;
}

.side-by-side-pane {
  display: flex;
  gap: 20px;
  padding: 20px;
  overflow-y: auto;
}

.proposed-changes .diff-add {
  background: rgba(34, 197, 94, 0.1);
  border-left: 3px solid #22c55e;
}

.proposed-changes .diff-remove {
  background: rgba(239, 68, 68, 0.1);
  text-decoration: line-through;
  color: #ef4444;
}
```

---

## 6. Step-by-Step Implementation Instructions

1.  **Create Viewport Directory:** Create `apps/shell/src/components/viewports/`.
2.  **Implement `DocumentRedlineCanvas.tsx`:** Use the provided Preact/React code to handle side-by-side diff rendering.
3.  **Update `ProjectKindPanel.tsx`:** Replace the legacy "Coming Soon" placeholders with a dynamic switch that imports the new Viewports.
4.  **Wire `SpaceDO` Broadcasts:** Ensure every mutating file operation (`write`, `edit`, `patch`) calls the `WS_GATEWAY` to notify the UI.
5.  **Run UI check:** Verify that `apps/shell` compiles and renders the new layout when a project of kind `doc_studio` is opened.
```
