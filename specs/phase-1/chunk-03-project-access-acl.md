# Phase 1 — Chunk 03: Public vs. Private Project Access Control

## Objective
Implement project visibility rules (`public` vs `private`) and membership ACL verification inside `SpaceDO.ts`.

## Implementation Details

1. Update `workers/spaces/src/do/SpaceDO.ts`:
   - In `ensureInit()`, ensure table `projects` has:
     `visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private'))`
     `created_by_user_id TEXT`
   - Create table `project_members`:
     ```sql
     CREATE TABLE IF NOT EXISTS project_members (
       project_id TEXT NOT NULL,
       user_id TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'editor', 'member', 'viewer')),
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (project_id, user_id)
     );
     CREATE INDEX IF NOT EXISTS idx_pm_user ON project_members(user_id);
     ```
   - In `createProject()`: Auto-insert `(project_id, created_by, 'owner')` into `project_members`.
   - In `listProjects()`: Space admins see all projects; regular members see public projects + private projects where their user_id is in `project_members`.
   - In `getProject()`, `readWorkspaceFile()`, and `listThreads()`: Return 404 Not Found for non-members on private projects.

2. Update `workers/spaces/src/index.ts`:
   - Add routes: `POST /spaces/:spaceId/projects/:projectId/members`, `DELETE /spaces/:spaceId/projects/:projectId/members/:userId`, `PATCH /spaces/:spaceId/projects/:projectId/visibility`.
