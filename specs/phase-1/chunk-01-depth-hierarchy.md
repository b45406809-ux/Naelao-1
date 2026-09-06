# Phase 1 — Chunk 01: Enterprise Depth Hierarchy Schema & Types

## Objective
Establish the canonical TypeScript interfaces and D1 database schema extensions for the 2-level enterprise hierarchy (Parent Root Space -> Department Sub-Spaces) and project automation anchoring.

## Implementation Details

1. Create `packages/types/src/space-hierarchy.ts` and re-export from `packages/types/src/index.ts`:
   - Export `SpaceDepth`: `0` (Parent Holding Co) | `1` (Department Sub-Space).
   - Export `TenancyTopology`: `"single"` | `"team"` | `"saas"`.
   - Export `SubSpaceScenario`: `"organizational"` | `"agency-child"` | `"user-workspace"`.
   - Export `CrossSpaceGrant`:
     ```typescript
     export interface CrossSpaceGrant {
       id: string;
       grantingSpaceId: string;
       receivingSpaceId: string;
       targetProjectId?: string;
       grantType: "read" | "write" | "admin" | "delegate_task";
       allowedOperations?: string[];
       grantedByUserId: string;
       grantedAt: string;
       expiresAt?: string;
     }
     ```
   - Export `SpaceHierarchyNode` carrying `id`, `tenantId`, `name`, `depth`, `parentSpaceId`, `tenancyMode`, `isAutomationAnchor`.

2. Create D1 Migration `infra/migrations/0073_space_hierarchy_and_projects.sql`:
   - Add index on spaces: `CREATE INDEX IF NOT EXISTS idx_spaces_parent_depth ON spaces(tenant_id, parent_space_id, depth);`
   - Add column: `ALTER TABLE spaces ADD COLUMN is_automation_anchor INTEGER NOT NULL DEFAULT 0;`
   - Create table `cross_space_grants_d1` with `(id, tenant_id, granting_space_id, receiving_space_id, target_project_id, grant_type, allowed_operations_json, granted_by_user_id, created_at, expires_at)`.
