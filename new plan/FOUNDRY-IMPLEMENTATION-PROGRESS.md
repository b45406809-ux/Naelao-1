# Foundry plan implementation progress

Updated: 2026-10-13
Branch: `Mcbt5s-Backup-2`
Authority: `FOUNDRY-SPACE-AND-PLATFORM-PLAN.txt` and its cited transcript. The transcript is context for user intent; model-generated vendor or architecture claims are not treated as requirements.

## Current follow-up: first four requested items

Status: implemented; validation below is current for this follow-up. The user explicitly asked to skip expanded orchestration and token reduction. Those two items are out of scope here.

The user clarified that Space-wide extensions receive their own Space Workspace, separate from the Space Assistant workspace. Implemented these boundaries:

- Space Assistant storage uses `spaces/{spaceId}/workspace/`.
- Project storage remains `spaces/{spaceId}/projects/{projectId}/workspace/`.
- Each Space-wide extension installation has its own `spaces/{spaceId}/space-workspace/extensions/{installationId}/workspace/` prefix. Different installations cannot read one another's files. Project-installed extensions retain their existing project workspace; only a no-project, Space-wide extension uses the dedicated extension prefix. Container runs preserve the signed installation scope.
- Added a reviewed, revisioned per-Space Foundry template lifecycle. Deterministic structural checks gate review; only the current checked revision can be submitted and published. The checks do not simulate model behavior. Installing a published template creates a worker in the target Space and uses target-Space knowledge; source files, channels, members, and credentials are not cloned.
- Added a per-Space feature request inbox with explicit owner review states, plus optional forwarding through a specific `feature-inbox:submit` capability. Submission records a request only; it does not change code or create a worker.
- Added exact-resource, expiring, revocable cross-Space capabilities for reading one published template, invoking one named worker, or submitting to one feature inbox. Cross-Space worker invocation is available through the Foundry API/UI, requires target-Space membership and source-owner authorization, and forwards only the submitted goal. It does not mount target files or reuse the target user's channel identity.
- Added the Foundry UI and navigation for authoring/checking/submitting templates, reviewing requests, creating scoped grants, installing a template, and invoking an explicitly shared worker.

Boundaries and open limitations:

- Space-wide extension workspaces are distinct from the Space Assistant workspace and from project workspaces. This pass does not add broad filesystem sharing between them.
- Cross-Space invocation is a direct Foundry UI/API path. A WhatsApp/channel-native bridge is not included; the invoking user's channel identity remains local to the target Space.
- Template checks are deterministic configuration checks, not live model simulations. Global public marketplace publication is not included; lifecycle and review are Space-scoped.
- Cross-Space feature requests require an explicit inbox capability. There is no implicit platform-wide FDE destination or automatic implementation.
- No live Cloudflare deployment or credential-backed test was run. Worker dry runs and mocked/in-memory tests do not establish live deployment behavior.

Files changed in this follow-up: `workers/agents/src/do/ToolSandboxDO.ts`, `workers/agents/src/do/ToolSandboxDO.test.ts`, `workers/agents/src/script-engine/types.ts`, `workers/agents/src/script-engine/r2-workspace.test.ts`, `workers/spaces/src/do/SpaceDO.ts`, `workers/spaces/src/do/SpaceDO-migrations.test.ts`, `workers/spaces/src/foundry-and-cross-space.test.ts`, `workers/spaces/src/index.ts`, `apps/shell/src/app/p/[slug]/(shell)/layout.tsx`, `apps/shell/src/app/p/[slug]/(shell)/foundry/page.tsx`, and `apps/shell/src/lib/api.ts`.

Current verification for this follow-up:

- Focused route and SpaceDO lifecycle/capability test: `corepack pnpm --filter naelao-spaces exec vitest run src/foundry-and-cross-space.test.ts` — 6 tests passed. The invocation test verifies denial makes no source worker call and an allowed call forwards only the explicit goal and source-Space identifiers.
- `corepack pnpm --filter naelao-spaces test` — 24 files / 73 tests passed, including migration replay and Foundry lifecycle/grant tests.
- `corepack pnpm --filter naelao-spaces typecheck` — passed.
- `corepack pnpm --filter @naelao/agents-worker test` — 58 files / 240 tests passed, including extension workspace isolation.
- `corepack pnpm --filter @naelao/agents-worker typecheck` — passed.
- `corepack pnpm --filter @naelao/shell typecheck` and `corepack pnpm --filter @naelao/shell build` — passed; build emitted `/p/[slug]/foundry`.
- `corepack pnpm exec wrangler deploy --dry-run --config workers/spaces/wrangler.toml` and the equivalent Agents Worker command — passed. These are local bundle/config checks only, not live deployment tests.
- `git diff --check` — passed before commit.
- Source TXT/transcript files were left unchanged.

## Implemented in this pass

- Added a guided domain-worker creator to the existing Workers page. It captures expertise, intended audience/outcome, workflow, and safety limits in plain language, turns those into worker instructions, and creates a worker in the active Space through the existing custom-agent API. It defaults to the existing `knowledge-base` tool and `always_ask` approval mode. The UI says the worker uses only the active Space's knowledge and that packaging/sharing is a separate action. This is a space-local authoring path, not a published template marketplace or cross-space installer.
- Added the virtual shell command `fetch-md <http(s)-url>`. It calls the Knowledge Worker using the existing internal HMAC and tenant/space scope, asks for `Accept: text/markdown`, returns the response, and reports when the origin returns ordinary source or when the response is capped.
- Hardened `/internal/web-search/fetch`: validates HTTP(S) URLs without embedded credentials, applies the existing space-egress check, checks SSRF on each manually followed redirect (maximum five), disables automatic redirect following, and caps streamed response bytes at 100,000. It identifies the response content type and whether Markdown was actually returned.
- Kept data and execution local to the active Space. No automatic template publishing, cross-space data grant, channel identity sharing, or patient-data path was added.

## Architecture reused

- Custom agents already persist independently of projects and can be bound to projects; the guided authoring flow uses this API rather than creating a parallel worker registry.
- The planner-first execution boundary, bounded subagent delegation, dynamic-workflow user-created subagents, project workspace, and Space Assistant workspace are existing mechanisms. This pass did not add duplicate orchestration or workspace layers.
- Space egress policy, internal HMAC calls, SSRF validation, response bounding, and approval policy remain the enforcement points for the new fetch command and guided worker.
- Context pruning/retrieval already exists. The RAG helper uses a rough character-based token estimate, so no exact-token claim or alternate provider integration was added.

## Verification and evidence

- `CI=true corepack pnpm install --frozen-lockfile`: passed using the repository-pinned pnpm 9.12.0. Plain `pnpm` resolved to pnpm 11 and rejected the lockfile's patched dependency configuration; use `corepack pnpm@9.12.0` in this repository.
- `corepack pnpm --filter @naelao/shell typecheck`: passed.
- `corepack pnpm --filter @naelao/shell build`: passed; Next.js compiled and emitted the `/p/[slug]/agents` route.
- `corepack pnpm --filter @naelao/agents-worker test`: passed, 58 files / 238 tests (includes the new virtual CLI and shell tests).
- `corepack pnpm --filter @naelao/agents-worker typecheck`: passed.
- `corepack pnpm --filter @naelao/knowledge-worker test`: passed, 3 files / 11 tests. Tests cover Markdown negotiation, redirect revalidation/SSRF rejection, response-size truncation, invalid schemes, and air-gap egress denial. Upstream fetch and DNS checks are mocked; this does not establish live behavior for arbitrary websites.
- `corepack pnpm --filter @naelao/knowledge-worker typecheck`: passed.
- `corepack pnpm --filter @naelao/knowledge-worker build`: passed with Wrangler 3.114.17.
- Worker dry run passed with the repository root's Wrangler 4.149.0: `corepack pnpm exec wrangler deploy --dry-run --config workers/agents/wrangler.toml`. The package-local agent `build` script failed because it resolves Wrangler 3.114.17, which rejects the existing `worker_loaders` and `containers` configuration; the root-pinned Wrangler 4 dry run validates the updated worker. Dependency cleanup is separate from this feature.
- Current official Cloudflare docs were fetched successfully at `https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/` and the linked Oct. 9 changelog. They confirm `Accept` negotiation with `text/markdown`, conversion only for zones with Markdown for Agents enabled, and that ordinary source may be returned otherwise. No live target-zone conversion was claimed or required by these tests.
- A full Biome check across edited legacy files reports existing diagnostics in those files; the new Knowledge Worker test file was formatted and passes its focused Biome check. `git diff --check` passes.

## Remaining work / concrete dependencies

- The current feature scope is implemented. It does not include global marketplace publication, a channel-native cross-Space WhatsApp bridge, implicit platform-wide FDE routing, or model-behavior simulation tests.
- Production end-to-end, load/stress/soak, and monitored live deployment coverage remain unestablished. Cloudflare credentials/live tests were not needed for this pass and were explicitly waived for the requested work.
- Exact-token context accounting, expanded orchestration, and token reduction are excluded from this follow-up. Preserve earlier bounded orchestration and approximate context estimates.
- Mass-market/feature-phone, broad localization, enterprise pricing, and extra swarm catalog work remain deferred; no new product promises were added for them.

## Changed files

- `apps/shell/src/app/p/[slug]/(shell)/agents/page.tsx`
- `workers/agents/src/script-engine/prebuilt/code-exec.ts`
- `workers/agents/src/script-engine/virtual-cli.ts`
- `workers/agents/src/script-engine/virtual-cli.test.ts`
- `workers/agents/src/script-engine/virtual-posix.ts`
- `workers/agents/src/script-engine/virtual-posix.test.ts`
- `workers/knowledge/src/index.ts`
- `workers/knowledge/src/web-fetch.test.ts`

The source plan and transcript were left unchanged.
