# Phase 1 — Chunk 04: Project-Anchored Automation Architecture

## Objective
Anchor all company automations and background workflows into dedicated, versioned projects.

## Implementation Details

1. Create `packages/types/src/project-automations.ts` and re-export in `packages/types/src/index.ts`:
   - Export `WorkflowClass`: `"COMPANY_AUTOMATION" | "VERTICAL_EXTENSION" | "EPHEMERAL_TASK"`.
   - Export interface `ProjectAnchoredWorkflow`:
     `id, projectId, spaceId, workflowClass, title, scriptPath, triggerType, triggerSpec, status, createdAt, updatedAt`.

2. Update `workers/spaces/src/do/SpaceDO.ts`:
   - Create SQLite table `project_anchored_workflows`:
     ```sql
     CREATE TABLE IF NOT EXISTS project_anchored_workflows (
       id TEXT PRIMARY KEY,
       space_id TEXT NOT NULL,
       project_id TEXT NOT NULL,
       workflow_class TEXT NOT NULL CHECK (workflow_class IN ('COMPANY_AUTOMATION', 'VERTICAL_EXTENSION', 'EPHEMERAL_TASK')),
       title TEXT NOT NULL,
       script_path TEXT NOT NULL,
       trigger_type TEXT NOT NULL,
       trigger_spec TEXT,
       status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'DISABLED')),
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
     );
     CREATE INDEX IF NOT EXISTS idx_paw_proj ON project_anchored_workflows(project_id, workflow_class);
     ```
   - Add DO methods: `registerProjectWorkflow()`, `listProjectWorkflows()`, and `listCompanyAutomations()`.
