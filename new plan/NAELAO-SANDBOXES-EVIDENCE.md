# Sandbox implementation evidence record

## Source and interpretation

The governed conversation source is `new plan/Compare_Agent37_Infrastructure.txt`. Its repeated assistant replies are context, not user decisions or evidence. User requirements and the original line markers are indexed in `NAELAO-SANDBOXES-REQUIREMENTS.csv`. Earlier in this task the complete 8,908-line source was read in bounded sections; the current implementation review is being compared against those requirements again before completion.

## Repository evidence

- Current branch: `Mcbt5s-Backup-2`; remote tip was fetched and matched local `d1e083c4ae7d2aeefe4cfb56bdfa7e3cd63e6dcc`; starting worktree clean.
- Root instructions were read. They point to a different historical source task; the user's current explicit source and branch supersede that task.
- Project file key construction: `workers/agents/src/script-engine/types.ts` `workspacePrefix()` maps project workspace data to `spaces/{spaceId}/projects/{projectId}/workspace/` and branch data below `branches/{branch}/`. Relevant history includes staged dynamic sandbox execution (`e93a65f9`), hardened workspace/guest process boundaries (`eefb5405`), scoped shared filesystems (`3ef39290`), and persistent sidecar identity (`44ab0d0a`).
- The R2 workspace is exposed through existing Agents/Spaces code; new service-worker R2 access was not added because the existing bucket contains unrelated scripts, credentials, and extension artifacts.
- `workers/agents/container/artifact-fs.mjs` provides explicit hydrate/open/write/flush operations and is not a FUSE mount. `workers/artifact/src/do/RepositoryDO.ts` is a Git-object/ref projection; its public mounted routes are read-only. See architecture section in `NAELAO-SANDBOXES-IMPLEMENTATION.md`.
- `workers/agents/src/do/ToolSandboxDO.ts` already performs canonical R2 hydration and staged/journaled workspace publication through per-file CAS and `ConcurrencyDO` fencing. This is the safe implementation to reuse for a future provider-neutral bridge.
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

See the `partial` rows in `NAELAO-SANDBOXES-REQUIREMENTS.csv`. In particular: provider connection enrollment, durable provider lifecycle/reconciliation, guest runtime protocol, shared R2 snapshot/diff/publication bridge, desktop view-only and takeover enforcement, SDK `naelao_sandboxes` dispatch, REST grants, MCP and AgentPort integration, encrypted browser profile handling, real reservation/usage settlement, and live acceptance suites remain unimplemented. Their routes must stay unavailable until those foundations pass tests. This is a concrete gap list, not a claim that configuration CRUD completes the user-requested end-to-end platform.
