# Phase 1 — Chunk 02: Sub-Space Inheritance & Access Middleware

## Objective
Implement strict downward oversight, upward isolation, and lateral air-gapping across department sub-spaces.

## Implementation Details

1. Create `workers/spaces/src/middleware/hierarchy-isolation.ts`:
   - Implement `enforceHierarchyIsolation(c, next)`:
     * Check target `spaceId` from params.
     * Query `spaces` to find `parent_space_id` and `depth`.
     * If user is Owner or Admin on `parent_space_id` -> Allow access via inherited role (Downward Oversight).
     * If user belongs only to child space and attempts to access `depth = 0` parent space -> 403 Forbidden (Upward Isolation).
     * If request is between sibling spaces -> verify active grant in `cross_space_grants_d1`.

2. Update `workers/spaces/src/business-auth.ts`:
   - In `resolveEndUserBusinessRole`, add inheritance check: if user has admin/owner role in `parent_space_id`, inherit that role for the sub-space request.
