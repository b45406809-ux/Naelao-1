# Foundry plan implementation progress

Updated: 2026-10-13
Branch: `Mcbt5s-Backup-2`
Authority: `FOUNDRY-SPACE-AND-PLATFORM-PLAN.txt` and its cited transcript. The transcript is context for user intent; model-generated vendor or architecture claims are not treated as requirements.

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

- Build a reviewed template package and publish/install flow. The current guided form creates a private Space worker, not a portable template. Product choices remain around draft revisions, source-material attachment, simulation criteria, licensing, and owner approval before publication.
- Add a durable FDE feature-request inbox and owner review UI. The plan names a private operations Space but does not identify its space ID, target, review roles, retention, or whether tenant submissions may be visible to platform operators. The current deployment has no configured destination contract. Assistant proposals must not change product behavior automatically.
- Specify and review cross-space worker installation, explicit knowledge/data/channel grants, per-user WhatsApp identities, revocation, audit, and retention before implementing the sensitive path. Patient/doctor examples remain unvalidated and are not a compliance claim.
- Resolve Space/Assistant/Project extension ownership, shared-resource billing, active-run migration, multi-linter conflict policy, resource ceilings, and an explicit shared-filesystem API before expanding shared execution. Existing project and assistant workspaces remain intact.
- Existing worker tests and runtime receipts provide pieces of the proposed test/monitoring strategy, but production end-to-end, load/stress/soak, replay, and monitored scenario coverage were not established by this pass.
- Exact-token context accounting and Jev/Clef integration remain research items. Preserve source text and citations; do not replace approximate token counts with an unverified vendor claim.
- Mass-market/feature-phone, broad localization, enterprise pricing, and extra swarm catalog work remain undefined/deferred in the source plan. The latest request reopens only additions that fit current boundaries; it does not authorize invented pricing, unreviewed regulated workflows, or unbounded orchestration.

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
