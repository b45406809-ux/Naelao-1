# Sandbox implementation evidence record

## Source and interpretation

The governed conversation source is `new plan/Compare_Agent37_Infrastructure.txt`. Its repeated assistant replies are context, not user decisions or evidence. User requirements and the original line markers are indexed in `NAELAO-SANDBOXES-REQUIREMENTS.csv`. Earlier in this task the complete 8,908-line source was read in bounded sections; the current implementation review is being compared against those requirements again before completion.

The final bridge review reread source lines 8150–8908 in order, including repeated proposal text and the last user clarification that the execution ladder and agent-initiated AgentPort provisioning serve different purposes. This implementation only completes the filesystem sync prerequisite; it does not silently claim the later AgentPort provider, grant, or ladder dispatch work is complete.

## Repository evidence

- Current branch: `Mcbt5s-Backup-2`; bridge work started from `fd88706a80503431af14abab0adfe6cc06dc81cb` with a clean worktree. This update is not yet committed or pushed.
- Root instructions were read. They point to a different historical source task; the user's current explicit source and branch supersede that task.
- Project file key construction: `workers/agents/src/script-engine/types.ts` `workspacePrefix()` maps project workspace data to `spaces/{spaceId}/projects/{projectId}/workspace/` and branch data below `branches/{branch}/`. Relevant history includes staged dynamic sandbox execution (`e93a65f9`), hardened workspace/guest process boundaries (`eefb5405`), scoped shared filesystems (`3ef39290`), and persistent sidecar identity (`44ab0d0a`).
- The R2 workspace is exposed through existing Agents/Spaces code; new service-worker R2 access was not added because the existing bucket contains unrelated scripts, credentials, and extension artifacts.
- `workers/agents/container/artifact-fs.mjs` provides explicit hydrate/open/write/flush operations and is not a FUSE mount. `workers/artifact/src/do/RepositoryDO.ts` is a Git-object/ref projection; its public mounted routes are read-only. See architecture section in `NAELAO-SANDBOXES-IMPLEMENTATION.md`.
- `workers/agents/src/do/ToolSandboxDO.ts` performs canonical R2 hydration and staged/journaled workspace publication through per-file CAS and `ConcurrencyDO` fencing. The new bridge reuses the same `ConcurrencyDO` fencing/CAS primitive; its publication journal is in D1 because external providers cannot address the ToolSandbox Durable Object's private container state.
- `workers/agents/src/script-engine/code-runner.ts` enforces actor/run/max tier/grant and air-gap checks before Tier 6. `computer-use.ts` previously omitted several required values; the call now passes the host-derived values.

## Verification log

Commands and outcomes from this implementation run:

| Check | Result | Notes |
|---|---|---|
| `corepack pnpm@9.12.0 install --frozen-lockfile` | pass | Uses repository-pinned pnpm and restores declared Vitest 4.1; lockfile-only update for new packages followed. |
| `pnpm --filter @naelao/sandboxes-core typecheck` | pass | After replacing DOM-only streams in portable contracts with `AsyncIterable<Uint8Array>`. |
| `pnpm --filter @naelao/sandboxes typecheck` | pass | Typed REST client. |
| `pnpm --filter @naelao/sandboxes-worker typecheck` | pass | Worker and both provider adapters. |
| `pnpm --filter @naelao/sandboxes-core test` | pass | 4 contract/path/provider-selection/cost tests. |
| `corepack pnpm@9.12.0 --filter @naelao/sandboxes-worker test` | pass | 3 files, 6 tests: Agent37 host/credential/command/timeout handling, encrypted credential envelope, HMAC authorization and idempotent config creation. |
| `corepack pnpm@9.12.0 --filter @naelao/sandboxes-worker typecheck` | pass | Includes typed provider tests. |
| `corepack pnpm@9.12.0 --filter @naelao/sandboxes-worker build` | pass | Wrangler deploy dry run; D1 binding resolved. |
| `corepack pnpm@9.12.0 --filter @naelao/sandboxes typecheck` | pass | Typed REST client. |
| `corepack pnpm@9.12.0 --filter @naelao/agent-sdk typecheck` | pass | Discriminated Tier 6 backend option contract. |
| `corepack pnpm@9.12.0 --filter @naelao/agent-sdk build` | pass | Rebuilt declarations used by dependent checks. |
| `corepack pnpm@9.12.0 --filter @naelao/sdk build` | pass | Rebuilt declarations for shell check. |
| `corepack pnpm@9.12.0 --filter @naelao/shell typecheck` | pass | Project computers settings panel and route. |
| `pnpm --filter @naelao/agents-worker typecheck` | pass after building `@agentport/sdk` | Initial failure was stale/unbuilt workspace declarations; package build fixed the local dependency state. |
| `corepack pnpm@9.12.0 --filter naelao-router typecheck` | pass | Rebuilt workspace declarations first. |
| `corepack pnpm@9.12.0 --filter @naelao/agents-worker typecheck` | pass | Computer-use authorization context compiles. |
| Agents focused `computer-use.test.ts` | pass | 1 test; confirms the execution ladder context is forwarded to Tier 6. |
| Cloudflare Workers and OpenSandbox primary docs | pass | Confirmed Cloudflare per-second metering/allowances and OpenSandbox lifecycle paths, API-key header, and current execd diff/commit limitation; no live account/host acceptance. |
| `git diff --check` | pass | Final source and whitespace review. |
| `biome lint ... --only=security --max-diagnostics=0` | pass | New worker, SDK/core, router, and prebuilt execution files; matches the repository security-lint job. The full formatter check reports pre-existing formatting issues in large legacy files and was not used as a gate. |
| local Wrangler migration file execution | pass | `0173_sandboxes_platform.sql` executed against local D1; remote D1 untouched. Full `migrations apply --local` was interrupted because it was enumerating and running the entire historical migration stack. |
| migration ordering review | existing repository issue found | All numbers 1 through 173 exist, but two existing files use prefix `0092`; the PR workflow global migration-order check therefore reports a duplicate. This change adds `0173` and does not renumber already-applied migrations. |
| `workers/agents/src/script-engine/prebuilt/computer-use.test.ts` | pass | Included in the 3-file Agents worker focused run; suite total 24 assertions. |
| Wrangler dry-run for new worker | pass | Latest dry run included worker routes, provider adapters, and D1 binding. |
| Full Turbo test inventory | blocked | `CI=true pnpm exec turbo run test --concurrency=2` invoked package installs and npm registry connections failed/timed out in this environment. Workspace dependencies were restored with frozen lockfile install; focused checks listed above pass. |
| GitHub Actions `Naelao full test inventory` run `42249022998` (`844f8de7`) | partial; overall failure | Passed: node, conformance, typecheck, security-lint, runtime-acceptance, and all 3 connected worker checks. Repository suite: 3,130 passed / 7 failed; none were sandbox deployment coverage or erasure classification after this fix. Workspace suite: 2,525 passed / 4 failed (language-preference routes). Browser journey: 6 failed (signup expected 201, got 404 across desktop/mobile). Summary job fails because repository/workspace/browser suites failed. The recorded summary was inspected in job logs; ZIP artifact download returned HTTP 403 from GitHub artifact storage. |

## External verification and blockers

No Agent37 API key/instance key, Agent37 account, customer OpenSandbox host/key, custom guest image, deployed R2 bridge, Cloudflare account check, or desktop ingress was available. Provider adapters have not been live-run. The Agents37 endpoint schema and runtime behavior must be acceptance tested before status can become `verified`; current worker status is hardcoded `unavailable` and auto-scheduling is false. OpenSandbox `invoke()` explicitly rejects until the Naelao guest endpoint is designed and verified.

The full-test workflow was dispatched on `844f8de7` as run `42249022998`. The job summary and test logs were read directly; the uploaded artifact ZIP also returned HTTP 403, so its JSON files could not be fetched. Sandbox deployment coverage and data-erasure classification pass in that run. Overall summary remains failed due the unrelated repository, language-preference, and browser signup failures listed in the verification table.

## Unresolved requirements and decisions

See the `partial` rows in `NAELAO-SANDBOXES-REQUIREMENTS.csv`. The snapshot/diff bridge is now implemented and locally tested, but provider connection verification, provider lifecycle/reconciliation, guest runtime protocol, desktop view-only/takeover, execution-ladder dispatch, REST grants, MCP and AgentPort integration, encrypted browser profiles, real reservation/usage settlement, and live acceptance remain unimplemented. Provider routes must stay unavailable until those foundations pass tests.

## R2 snapshot/diff bridge implementation (2026-11-06)

- `infra/migrations/0174_sandbox_workspace_bridge.sql` adds expiring snapshot/blob records, per-snapshot file hashes, and idempotency/snapshot references on publication records. No existing project keys or relationships are migrated.
- `workers/agents/src/sandboxes/workspace-bridge.ts` is the only code with R2 bridge access. HMAC-authenticated internal routes resolve the filesystem by tenant and owner, read only its project/branch prefix, skip unsafe/runtime/secret paths, cap a snapshot at 200 files, 768 KiB per file (matching the 1 MiB ConcurrencyDO base64 mutation cap), and 64 MiB total, and copy bytes into an opaque bridge-only prefix. Those limits stay under Workers' per-request subrequest budgets. One publication contains at most 100 file changes; callers can publish separate batches against the same unexpired snapshot. Snapshot and changed-file blobs are hash checked. A provider reads blobs through the authenticated computer API.
- Publication validates each expected hash against the immutable snapshot, validates that each staged blob belongs to that filesystem and snapshot, journals a unique idempotency key before changing canonical R2, then publishes each file via the same per-file lock and `ConcurrencyDO /workspace/publish` fencing/CAS used by ToolSandbox. A retry after a lost result recognizes already-applied desired hashes; pending journals protect referenced blobs from expiry cleanup. Conflicts are reported per path with expected and observed hashes.
- `workers/sandboxes/src/index.ts`, the Router dispatch table, `workers/sandboxes/wrangler.toml`, and `packages/sandboxes-sdk/src/index.ts` connect snapshot, stage, publish, and read operations. The sandbox worker receives an Agents service binding, never the broad R2 bucket. `workers/agents` runs a five-minute bounded R2/D1 expiry sweep. Data erasure removes bridge objects before removing authorization rows.
- Verified locally in this run: Agents typecheck and bridge test (snapshot filters secrets/other branches; staged edit publishes through a mocked fenced writer and identical idempotent replay), sandbox worker typecheck and its 6 tests, SDK typecheck, Router typecheck, and 27 erasure tests. The workflow erasure test was updated to reflect its existing two-batch delete ordering and added dependent publication-blob cleanup.
- Not verified: remote D1 migration application, production/staging deployed service binding, live Cloudflare R2/ConcurrencyDO behavior, provider snapshot/download protocol, real provider execution or crash injection against a deployed bridge, and complete GitHub Actions runs. The Agents Wrangler dry-run was blocked by Docker reporting `no space left on device` while rebuilding the pre-existing ToolSandbox container image; pruning unused images reclaimed only 15 MB, so the workspace remained full. Sandboxes dry-run succeeded and showed `AGENTS_WORKER` bound. The CI workflow only runs pushes to `main`/`claude/**` or pull requests targeting `main`; this feature branch push does not satisfy those filters. No PR or deployment was opened. Router has no package build script.
