# Phase 1 — Chunk 07: Clean Namespace Separation (/workspace vs /.avos/)

## Objective
Enforce strict filesystem boundaries between user application source code and internal agent operating system meta-state.

## Implementation Details

1. Update `workers/agents/src/script-engine/types.ts`:
   - Export helper `getWorkspacePath(spaceId, projectId)` returning `spaces/{spaceId}/projects/{projectId}/workspace/`.
   - Export helper `getAvosInternalPath(spaceId, projectId)` returning `spaces/{spaceId}/projects/{projectId}/.avos/`.
   - Export `AVOS_PATH_CONVENTIONS`:
     * `sharedSkills: ".avos/shared/skills/"`
     * `sharedWorkflows: ".avos/shared/workflows/"`
     * `agentSoul: (agentId) => ".avos/agents/" + agentId + "/SOUL.md"`
     * `agentMemory: (agentId) => ".avos/agents/" + agentId + "/memory.json"`
     * `agentScratchpad: (agentId) => ".avos/agents/" + agentId + "/scratchpad/"`

2. Update `workers/spaces/src/index.ts` and `workers/agents/src/script-engine/prebuilt/file-manager.ts`:
   - In `file-manager.ts` and workspace file tree endpoints: Exclude paths starting with `.avos/` by default unless `include_internal=true` is passed.
