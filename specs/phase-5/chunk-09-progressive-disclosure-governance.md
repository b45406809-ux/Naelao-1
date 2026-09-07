Here is the complete, single, fully-detailed, production-ready Markdown specification file for **Phase 5 — Chunk 09** (`specs/phase-5/chunk-09-progressive-disclosure-governance.md`).

---

```markdown
---
chunk_id: "phase-5-chunk-09"
phase: 5
include_files:
  - workers/spaces/src/do/SpaceDO.ts
  - workers/agents/src/shared/ai-client.ts
  - packages/types/src/index.ts
repomix_include:
  - "workers/spaces/src/do/SpaceDO.ts"
  - "workers/agents/src/shared/ai-client.ts"
  - "packages/types/src/index.ts"
expected_outputs:
  - workers/spaces/src/do/SpaceDO.ts
  - packages/types/src/progressive-disclosure.ts
  - packages/types/src/index.ts
---

# Phase 5 — Chunk 09: Progressive Disclosure & UI Governance Architecture

## 1. Executive Summary & Architectural Vision

To ensure that non-technical business founders, clinic managers, and legal partners are never overwhelmed by complex distributed systems, AVOS implements **Progressive Disclosure** (the "Apple Surface, Linux Edge" philosophy).

Under this model, the underlying power of Cloudflare Artifacts (Git branches, SHA-256 OCC hashes, V8 isolates, and Durable Object memory states) remains fully operational at the edge, but the user interface dynamically adapts to the user's operational mode:
* **Business Mode (Default):** A clean, elegant, human-first collaborative interface (Slack/Linear meets iMessage). Git branch trees, raw terminal logs, and technical memory structures are 100% invisible. Actions are presented as plain-English decision cards (`[Approve Changes]`, `[Deploy to Edge]`).
* **Developer Mode (Opt-In Toggle):** Unlocks raw terminal compiler outputs, Git commit graphs, per-turn token spend meters, and AST search-and-replace inspectors for engineering teams and partner developers.

```
┌─────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────┐
│ 🍎 BUSINESS MODE (Default — Clean & Human)                  │ ⚙️ DEVELOPER MODE (Opt-In — Full Observability)             │
├─────────────────────────────────────────────────────────────├─────────────────────────────────────────────────────────────┤
│ • Sleek, conversational workspace interface.                │ • Unlocks Git commit graphs & branch visualizers.           │
│ • Sidebar tabs: **Chat**, **Tasks**, **Files**, **Preview**.│ • Unlocks raw terminal compiler logs & isolate traces.      │
│ • Actions are plain English: `[Approve]`, `[Deploy]`.       │ • Unlocks per-turn token spend meters and model selectors.  │
│ • Git branches, isolates, and DO memory are 100% hidden.    │ • Unlocks AST search-and-replace inspection tools.          │
└─────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────┘
```

---

## 2. The Progressive Disclosure State Machine

The interface state is governed on a per-user, per-space basis. Preferences are synchronized across clients using `SpaceDO` Durable Object SQLite storage and exposed to frontend shells via the `SpaceDO` state endpoint.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       USER PREFERENCE STATE MACHINE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. User toggles "Developer Mode" in apps/shell settings.                    │
│ 2. Dispatches `PATCH /spaces/:spaceId/preferences` with `{ uiMode: "dev" }` │
│ 3. `SpaceDO` persists state in SQLite table `user_workspace_preferences`.   │
│ 4. `WsHubDO` broadcasts `preferences.updated` to all open client sessions.   │
│ 5. Frontend shell mounts developer viewports (Commit graphs, term logs).   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Technical Specifications & File Implementation Contracts

### A. `packages/types/src/progressive-disclosure.ts`

Create `packages/types/src/progressive-disclosure.ts` and re-export in `packages/types/src/index.ts`:

```typescript
export type UIWorkspaceMode = "business_mode" | "developer_mode";

export interface UserWorkspacePreferences {
  userId: string;
  spaceId: string;
  uiMode: UIWorkspaceMode;
  showBotHeartbeats: boolean;
  showGitCommitGraphs: boolean;
  showTokenMeters: boolean;
  updatedAt: string;
}

export interface ProgressiveDisclosureViewConfig {
  displayNavbarDetails: boolean;
  enableRawTerminalAccess: boolean;
  enableTimeMachineScrubbing: boolean;
  renderTechnicalMetadata: boolean;
}

/**
 * Resolves UI configuration flags based on the user's active workspace mode.
 */
export function resolveViewConfig(mode: UIWorkspaceMode): ProgressiveDisclosureViewConfig {
  if (mode === "developer_mode") {
    return {
      displayNavbarDetails: true,
      enableRawTerminalAccess: true,
      enableTimeMachineScrubbing: true,
      renderTechnicalMetadata: true
    };
  }

  // Default Business Mode: Clean, human-centric abstraction
  return {
    displayNavbarDetails: false,
    enableRawTerminalAccess: false,
    enableTimeMachineScrubbing: false,
    renderTechnicalMetadata: false
  };
}
```

---

### B. Update `SpaceDO.ts` (User Preferences Persistence Engine)

Implement database storage and retrieval for user workspace preferences inside `SpaceDO.ts` Durable Object SQLite:

```typescript
// Inside SpaceDO.ts ensureInit() and execution handlers:

/*
CREATE TABLE IF NOT EXISTS user_workspace_preferences (
  user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  ui_mode TEXT NOT NULL DEFAULT 'business_mode' CHECK (ui_mode IN ('business_mode', 'developer_mode')),
  show_bot_heartbeats INTEGER NOT NULL DEFAULT 0,
  show_git_commit_graphs INTEGER NOT NULL DEFAULT 0,
  show_token_meters INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, space_id)
);
*/

export async function setUserPreferences(
  storage: DurableObjectStorage,
  userId: string,
  spaceId: string,
  prefs: { uiMode?: string; showBotHeartbeats?: boolean; showGitCommitGraphs?: boolean; showTokenMeters?: boolean }
) {
  const existing = storage.sql.exec(
    "SELECT * FROM user_workspace_preferences WHERE user_id = ? AND space_id = ?",
    userId,
    spaceId
  ).toArray()[0] as any || {
    ui_mode: "business_mode",
    show_bot_heartbeats: 0,
    show_git_commit_graphs: 0,
    show_token_meters: 0
  };

  const uiMode = prefs.uiMode ?? existing.ui_mode;
  const showHeartbeats = prefs.showBotHeartbeats !== undefined ? (prefs.showBotHeartbeats ? 1 : 0) : existing.show_bot_heartbeats;
  const showGit = prefs.showGitCommitGraphs !== undefined ? (prefs.showGitCommitGraphs ? 1 : 0) : existing.show_git_commit_graphs;
  const showTokens = prefs.showTokenMeters !== undefined ? (prefs.showTokenMeters ? 1 : 0) : existing.show_token_meters;

  storage.sql.exec(
    `INSERT OR REPLACE INTO user_workspace_preferences 
     (user_id, space_id, ui_mode, show_bot_heartbeats, show_git_commit_graphs, show_token_meters, updated_at) 
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    userId,
    spaceId,
    uiMode,
    showHeartbeats,
    showGit,
    showTokens
  );

  return {
    userId,
    spaceId,
    uiMode,
    showBotHeartbeats: showHeartbeats === 1,
    showGitCommitGraphs: showGit === 1,
    showTokenMeters: showTokens === 1
  };
}

export async function getUserPreferences(storage: DurableObjectStorage, userId: string, spaceId: string) {
  const row = storage.sql.exec(
    "SELECT * FROM user_workspace_preferences WHERE user_id = ? AND space_id = ?",
    userId,
    spaceId
  ).toArray()[0] as any;

  if (!row) {
    return {
      userId,
      spaceId,
      uiMode: "business_mode",
      showBotHeartbeats: false,
      showGitCommitGraphs: false,
      showTokenMeters: false
    };
  }

  return {
    userId,
    spaceId,
    uiMode: row.ui_mode,
    showBotHeartbeats: row.show_bot_heartbeats === 1,
    showGitCommitGraphs: row.show_git_commit_graphs === 1,
    showTokenMeters: row.show_token_meters === 1
  };
}
```

---

## 4. Step-by-Step Implementation Instructions for the AI Runner

When applying this chunk:
1. Create `packages/types/src/progressive-disclosure.ts` and export the types and `resolveViewConfig`.
2. Re-export `progressive-disclosure.ts` inside `packages/types/src/index.ts`.
3. Update `workers/spaces/src/do/SpaceDO.ts` to include the `user_workspace_preferences` SQLite table and implement `setUserPreferences` and `getUserPreferences`.
4. Run `node --check` syntax validation across modified files to ensure strict TypeScript compliance.
```
