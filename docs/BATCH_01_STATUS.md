# Batch 01 — Items 1–19 implementation matrix

Authority order used for this audit: `repomix/Update the batches.md`, `repomix/Updates2.md`, then
`repomix/prompts/batch-01-items-1-19.md`. Superseded space-wide automation and five-tier runtime
assumptions are intentionally not retained.

| Item | Feature | Status | Primary production and verification files |
|---:|---|---|---|
| 1 | Enterprise depth hierarchy | Implemented | `workers/spaces/src/do/SpaceDO.ts`, `workers/spaces/src/index.ts`, `infra/migrations/0034_space_hierarchy.sql`, `apps/shell/src/lib/api.ts`, `workers/spaces/src/space-hierarchy-policy.test.ts` |
| 2 | Sub-space inheritance and isolation | Implemented | `workers/spaces/src/do/SpaceDO.ts`, `workers/spaces/src/index.ts`, `workers/spaces/src/space-hierarchy-policy.test.ts` |
| 3 | Public/private project ACL | Implemented | `workers/spaces/src/do/SpaceDO.ts`, `workers/spaces/src/index.ts`, `apps/shell/src/app/p/[slug]/(shell)/projects/all/page.tsx`, `packages/agent-sdk/src/launchpad-runtime.test.ts` |
| 4 | Project-anchored automations | Implemented | `infra/migrations/0073_project_scoped_automation.sql`, `workers/spaces/src/index.ts`, `workers/spaces/src/do/SpaceDO.ts`, `workers/spaces/src/project-automation.test.ts`, `tests/unit/scheduled-jobs-fires-events.test.ts` |
| 5 | Cloudflare Artifacts Git engine | Implemented | `workers/artifact/src/RepositoryDO.ts`, `workers/artifact/src/repository.ts`, `workers/artifact/src/index.ts`, `workers/artifact/src/repository.test.ts` |
| 6 | In-memory virtual POSIX shell | Implemented | `workers/agents/src/script-engine/r2-workspace.ts`, `workers/agents/src/script-engine/prebuilt/r2-workspace.ts`, `workers/agents/src/script-engine/r2-workspace.test.ts` |
| 7 | `/workspace` and `/.avos` separation | Implemented | `packages/agent-sdk/src/launchpad-runtime.ts`, `workers/agents/container/server.mjs`, `workers/agents/container/artifact-fs.mjs`, `packages/agent-sdk/src/launchpad-runtime.test.ts` |
| 8 | Six-tier execution ladder | Implemented | `workers/agents/src/script-engine/execution-ladder.ts`, `workers/agents/src/script-engine/code-runner.ts`, `workers/agents/src/script-engine/execution-ladder.test.ts`, `tests/unit/code-runner.test.ts` |
| 9 | Invisible runtime hypervisor | Implemented | `workers/agents/src/script-engine/tool-surface.ts`, `workers/agents/src/script-engine/execution-ladder.ts`, `packages/agent-sdk/src/launchpad-runtime.ts` |
| 10 | ArtifactFS lazy hydration | Implemented | `workers/agents/container/artifact-fs.mjs`, `workers/agents/container/server.mjs`, `workers/agents/container/artifact-fs.test.mjs` |
| 11 | Four-dimension state synchronization | Implemented | `packages/agent-sdk/src/launchpad-runtime.ts`, `workers/agents/src/do/ToolSandboxDO.ts`, `packages/agent-sdk/src/launchpad-runtime.test.ts` |
| 12 | 60-second micro-sleep | Implemented | `workers/agents/src/do/ToolSandboxDO.ts`, `workers/agents/src/do/ToolSandboxDO.test.ts` |
| 13 | In-isolate Python routing | Implemented | `workers/agents/src/script-engine/execution-ladder.ts`, `workers/agents/src/script-engine/code-runner.ts`, `packages/agent-sdk/src/launchpad-runtime.ts` |
| 14 | Kitesurf browser with Chromium fallback | Implemented | `workers/browser/src/index.ts`, `workers/agents/src/script-engine/code-runner.ts`, `workers/agents/src/script-engine/execution-ladder.test.ts` |
| 15 | Virtual-display container automation | Implemented | `workers/agents/src/do/ToolSandboxDO.ts`, `workers/agents/container/server.mjs`, `packages/agent-sdk/src/launchpad-runtime.ts`, `workers/agents/src/do/ToolSandboxDO.test.ts` |
| 16 | Multiplexed persistent bridge | Implemented | `packages/agent-sdk/src/launchpad-runtime.ts`, `workers/agents/src/do/LocalTunnelDO.ts`, `workers/agents/src/do/LocalTunnelDO.test.ts` |
| 17 | Zero-copy branch micro-forking | Implemented | `workers/artifact/src/RepositoryDO.ts`, `workers/artifact/src/repository.ts`, `workers/artifact/src/repository.test.ts` |
| 18 | Turn-by-turn Git time machine | Implemented | `workers/agents/src/do/NaelaoAgentDO.ts`, `workers/agents/src/script-engine/prebuilt/artifacts.ts`, `workers/artifact/src/RepositoryDO.ts` |
| 19 | Reasoning-aware Git blame | Implemented | `workers/artifact/src/repository.ts`, `workers/artifact/src/RepositoryDO.ts`, `workers/artifact/src/repository.test.ts` |

## Verification contract

The release gate is the complete monorepo test suite, typecheck, and production dry-run build. The
worker-local Vitest projects explicitly exercise Cloudflare runtime imports rather than silently
skipping the Durable Object suites. Project reads issued by trusted internal callers carry an
explicit server-derived manager assertion; user-facing reads continue to use the caller's verified
user ID, preserving private-project concealment.
