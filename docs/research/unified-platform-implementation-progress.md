# Unified platform implementation progress

Branch: `Mcbt5s-Backup-2`
Plan: [Naelao unified platform plan](naelao-unified-platform-deep-plan.md)
Requirements: [unified workspace requirements](unified-workspace-requirements.md)
Trace matrix: [requirements-to-code matrix](../requirements-trace-matrix.md)

## Status

Implementation has started through Phase 4. Phases 1–3 remain incomplete and are not ready for rollout. Phase 4 is partial and is not accepted: the Spaces workflow-plan and MCP patch writers, canonical blueprint seeding, and branch-scoped script CAS/artifact restore paths now use checked coordinator paths; bounded dual-read instrumentation exists for the project UI; many audited clients remain unmigrated. `UNIFIED_WORKSPACE_ENABLED`, `WORKSPACE_DUAL_READ_ENABLED`, and live-workspace admission remain disabled by default. Agent37 remains unavailable and auto-scheduling remains off.

## Phase 1 — Workspace contract and checked publication core

### Implemented so far

- Added a versioned typed contract for workspace scope, modes, manifest entries, heads, conflicts, and receipts.
- Added `WorkspaceCoordinatorDO` with tenant-bound internal authentication, project scope checks, immutable R2 content/manifests, one transactional branch-head/receipt advance, idempotency, expected-hash batch validation, generation checks, checked sessions, branch creation, three-way checked branch merge, live lease/fence checks, renewal, and checked handoff.
- Added R2-backed stage records: bytes are uploaded under a separate staging prefix and can be checkpointed by stage ID. Checkpoint receipts consume stages atomically with head advancement; pending ToolSandbox intents shrink to a stage reference after durable staging.
- Added bounded revision polling (`/v1/changes`) and monotonic subscriber acknowledgements. Notifications are not pushed; callers reconnect by polling the authoritative revision cursor.
- Added explicit metadata retention: revision polling keeps the newest 500 events per branch and returns `resetRequired` when a client cursor predates retained events; publication receipts and subscriber acknowledgements expire after 30 days. A Durable Object alarm processes bounded expiry-index pages.
- Added immutable retained-revision pointers and a resumable manifest/content mark-and-sweep. The first sweep backfills all existing manifests as legacy history roots, then marks branch heads, retained revisions, branch bases, and active session bases. It deletes only manifests and content unreachable from those roots. A 10-minute maintenance lease fences new canonical publications while each bounded sweep page runs; a Durable Object alarm drains the operation after it is kicked through the authenticated Agents maintenance route.
- Added a seven-day stage collector for consumed stages, expired closed-session stages, and aged orphan uploads. It never collects canonical content or active-session stages.
- The staging collector also removes aged metadata for delete-only/empty stages, which have no R2 object from which to discover their records.
- Added a server-side client using Naelao's HMAC-derived Durable Object names.
- Added authorized coordinator erasure: the coordinator keeps an erased tombstone present while deleting R2 objects and paginating through DO metadata, and later requests cannot recreate an erased scope. The existing data-erasure workflow now enumerates project, assistant, and space-extension scopes in bounded pages and calls the coordinator erasure endpoint before the broad legacy prefix sweep.
- R2 writes that lose the erasure race are removed when their coordinator transaction observes the erased tombstone; rejected initialization manifests and staged uploads receive the same cleanup.
- Added revision polling and subscriber acknowledgements as bounded APIs; subscriber acknowledgements are monotonic. Erasure project enumeration has a 100-scope page limit and workflow retries use stable per-page step names.
- Bound and migrated the coordinator in development, staging, and production Worker configuration; jurisdiction applies through the existing Durable Object jurisdiction gate.
- Live admission fails with `capability_unavailable` unless the feature is explicitly enabled and current runtime evidence proves the live mount, authenticated transport, allocation generation, template digest, and verification age.

### Verification

- Focused `WorkspaceCoordinatorDO.test.ts` and `ToolSandboxDO.test.ts` pass, **40 tests**, covering idempotent publication/merge and changed-payload rejection, disjoint three-way merge, same-path conflict preservation, concurrent checkpoint races, stage persistence across coordinator reconstruction, stage idempotency and GC, metadata expiry, 500-event retention/reset, rooted-history preservation, unreachable manifest/content collection, GC write fencing and alarm continuation, revision polling/acknowledgement, lease expiry/fence advancement, capability rejection, run-branch isolation, completion-time ToolSandbox merge, and erased-scope tombstone behavior.
- `workers/workflows` `erasure-cleanup.test.ts` passes, **16 tests**, including cursor forwarding and the bounded coordinator-erasure page contract. `workers/sandboxes` `providers/agent37.test.ts` passes, **5 tests**.
- Typechecks pass for Agents, Spaces, Sandboxes, and Workflows after building their workspace SDK dependencies.
- Wrangler dry-run passes for Workflows and Sandboxes. Agents dry-run reached Docker image construction but failed because the execution environment ran out of disk space. Spaces has no package `build` script; its typecheck passes.
- `git diff --check` passes. No live deployment or provider acceptance has been run.

### 2026-11-08 Phase 1 continuation

- Added coordinator-alarm maintenance for initialized workspace scopes. The alarm advances one bounded content-GC step, one bounded staging page (with independent R2 and Durable Object-storage cursors), and a bounded metadata expiry page. It resumes content GC from persisted state, records `running`/`complete`/`failed` status, logs scoped failures, and schedules an explicit one-minute retry. `/internal/workspaces/gc` now supports authenticated `operation: "status"` for querying a known scope. New initialization schedules the first alarm; existing scopes schedule maintenance when reached through the authenticated coordinator.
- Added a focused mock test for automatic alarm setup and recorded retry recovery, plus an R2 content-upload-versus-erasure race test. The test holds the content PUT until the coordinator erasure sweep has completed, then verifies the transaction rejects and removes the late object. Existing serialized checkpoint race, GC write-fence, erased-tombstone, and workflow erasure paging tests were also rerun.
- Fresh verification: `WorkspaceCoordinatorDO.test.ts` **18 passed**; `ToolSandboxDO.test.ts` **24 passed**; workflow `erasure-cleanup.test.ts` **16 passed**. Agents typecheck passed after building `@agentport/sdk`; Workflows typecheck passed after building `@naelao/http`. The normal pnpm wrapper initially blocked on the existing lockfile/root-overrides mismatch. Dependencies were installed with `--lockfile=false`; the lockfile remains unchanged. These tests use in-memory R2/DO mocks and are not deployed runtime validation. `git diff --check` passes.
- Authoritative docs checked directly on 2026-11-08: Cloudflare Durable Object alarms are at-least-once and retry thrown handler failures with bounded exponential retries; R2 cursors are opaque and `truncated` determines continuation; DO rules warn that awaited external operations permit request interleaving. The code's in-memory bucket and storage mocks do not validate Cloudflare cursor, transaction, alarm, or deletion behavior. No deployed validation was performed.
- Added a source-audit inventory to the linked plan for canonical reads/writes and remaining R2/CAS, snapshot bridge, and repository-reconciliation legacy paths. This is not a complete caller migration audit.
- Added durable upload intents around coordinator-owned canonical content/manifest PUTs. GC marks these intents as roots, removes them atomically with successful pointer publication, and expires stale intents only after 24 hours. Content GC now runs initially and weekly; staging and metadata maintenance continue daily. R2 cursors are treated as opaque, and missing or non-advancing cursors fail closed into the alarm retry/status path.
- Additional fresh verification after the pushed scheduler commit: coordinator tests **20 passed**, ToolSandbox tests **24 passed** (44 together); Agents typecheck passed. New deterministic coverage holds an R2 content PUT response after the object is stored, completes GC, then resumes publication and verifies the content remains readable. A stalled-cursor test verifies failure is visible and retried. Workflow erasure tests **16 passed** and Workflows typecheck passed. These are mocked interleavings, not Cloudflare runtime evidence.
- Added a lost-response test in which the mock R2 service stores a PUT and then throws to model a client timeout. The upload intent preserves the object through GC; retrying the same publication completes and the committed file reads back. Added erased-scope alarm handling so a pending alarm clears itself after erasure rather than retrying GC without a scope.
- Added a repeatable local Wrangler runtime smoke harness using the real coordinator Durable Object and local R2. It exercises SQLite-backed DO transactions, alarm completion, concurrent checkpoint compare-and-swap (one succeeds, one conflicts), R2 readback, opaque cursor continuation, content GC, and scoped erasure. It passed on the local runtime; this is runtime evidence, not deployed Cloudflare validation.
- Expanded the linked plan's caller-by-caller source inventory across the coordinator, ToolSandbox, script-engine tools/readers, environment artifact restore, snapshot bridge, NaelaoAgentDO task/worker branch operations, RepositoryDO, Spaces workspace file routes, workflow-plan writes, and project starter seeding. Those direct legacy callers remain active and are migration work, not Phase 1 production acceptance.

### Phase 1 acceptance status

The Phase 1 implementation and local evidence are recorded, but Phase 1 is **not complete or production-ready**. Rollout flags remain disabled. Remaining acceptance gates are external or require follow-up before enabling:

- Run the authenticated alarm/GC and erasure flows against a deployed disposable Cloudflare namespace. Confirm alarm retry delivery and status reporting, DO transaction interleaving, R2 cursor/deletion behavior, binding configuration, jurisdiction placement, and deployed runtime/version details. The local Wrangler smoke does not validate deployed regional or account configuration.
- Close the legacy caller migration and compatibility-read decision for the inventory in the linked plan. Current R2/CAS, per-file publication, snapshot bridge, repository reconciliation, Spaces reads/writes, and starter seeding paths can still overlap coordinator-owned state.
- Obtain a product decision for revision history retention, including legal holds and backup expiry. Until then, retained revisions and their content remain unpruned.
- Validate real allocation-generation advancement, duplicate changed-payload stage behavior, and failed manifest upload recovery in the selected deployed/runtime acceptance environment.

## Phase 2 — Internal ToolSandbox vertical slice

### Implemented so far

- Added an opt-in ToolSandbox path that bootstraps an immutable revision from scoped R2, hydrates from a verified manifest, creates an isolated branch per run, checkpoints changes to that branch, and three-way merges to the requested branch only on successful completion. A blocked run checkpoints and remains isolated. Pending checkpoint intent is retried with the same idempotency key. A cold replacement closes the previous session before opening a new generation, preventing stale sessions from publishing after recovery.
- Added `UNIFIED_WORKSPACE_ENABLED=false` in development, staging, and production. It remains off because the integration is tested with a mocked container, not a real Cloudflare Container deployment.
- Added authenticated compatibility reads for the Spaces project-file list/read routes. With unified mode enabled, these routes read the coordinator manifest and content-addressed object, verify SHA-256 and size, and fail closed if an initialized canonical revision is unavailable or corrupt. They use the legacy per-file R2 path only when the flag is off or the coordinator has no initialized head.
- Added an optional manifest-backed R2 read adapter to the agent `r2-workspace` operations. It covers `get`, `head`, and `list`; stale project workspace objects are not used once a canonical head exists. Writes/deletes through this compatibility adapter fail closed because they must go through checked coordinator publication. The adapter is opt-in through the unified-mode environment callback, leaving the legacy path intact while the flag is off.
- Applied the same read adapter to the script engine's project-scoped workspace buckets so sibling readers (file manager, document processing, observation, artifact restore, and other bucket-based tools) share the canonical view. Legacy R2 writes/deletes under the project workspace prefix fail closed while unified mode is active until their checked writer migration is complete.
- Extended transition guards to project workspace publication in the concurrency route, sandbox snapshot/stage/publish bridge, direct script-engine R2 CAS helpers, Space attachment/session-upload routes, workflow-plan writes, MCP patch writes, and Artifact RepositoryDO commit/reconcile/replay. With unified mode on, these paths return explicit conflict/unavailable errors rather than mutate legacy per-file state; feature-off behavior remains unchanged. Migrating these callers to checked publication is future work.
- Routed project MCP `readWorkspaceFile` and `listDirectory` through the coordinator-backed compatibility read; its `runAstPatch` write fails closed after a canonical head exists. Validated manifest entry paths, hashes, sizes, and content object keys against the tenant/Space/project/jurisdiction scope before Spaces compatibility clients consume them.
- Added mocked lifecycle cases for blocked completion, cancellation, suspension, forced teardown, and cold runtime replacement. Tests assert blocked/cancelled/suspended work does not merge into `main`, checkpointed work remains on its run branch, active runtime teardown occurs where required, and replacement advances allocation generation.
- Fixed interrupted-checkpoint recovery ordering: after a staged checkpoint failure, a replacement allocation now replays the durable stage against the still-active old coordinator session before closing it and opening the new generation. A mocked DO reconstruction regression test verifies `main` stays unchanged before recovery and receives the checked revision only after replay and completion.
- Added `LIVE_WORKSPACE_ENABLED=false` alongside `UNIFIED_WORKSPACE_ENABLED=false` for Agents development, staging, and production. Spaces unified mode is also false in all configured environments.

### Verification

- Current affected suites passed: Agents **45 tests** (`ToolSandboxDO`, concurrency boundaries, workspace bridge, R2 compatibility); Spaces **7 tests** (workspace compatibility and MCP); Artifact **9 tests** (repository adapter). All are mocked unit evidence. Agents, Spaces, and Artifact `tsc --noEmit` passed after building the local `@naelao/http` package so its generated exports matched source. `git diff --check` passed.
- Ran the Container harness server locally as a process: after control initialization, unauthenticated requests to `/workspace/list` and `/internal/workspaces/compat-read` returned **403**. This validates the harness HTTP control-token gate only; it does not validate guest UID isolation, container network boundaries, or Cloudflare Container behavior.
- A Wrangler local-runtime smoke passed against the real local SQLite-backed Durable Object and local R2 emulation for coordinator transactions, alarms, concurrent CAS, R2 reads, and erasure. It did not start or validate a ToolSandbox Container. The installed Wrangler was 4.149.0 and required overriding the smoke config's future compatibility date to 2026-10-13.
- Reviewed Cloudflare's current [Container architecture and lifecycle documentation](https://developers.cloudflare.com/containers/concepts/architecture/), which describes Containers as accessed through their Durable Object and covers startup failure, process exit, and shutdown transitions. This documentation review is not runtime or isolation evidence for this implementation.
- A local Docker build attempt for the ToolSandbox image did not complete: the build failed during image-context copy with `no space left on device`. No Container process was run. There was no deployed Cloudflare Container or billing validation.
- Wrangler `whoami` reports this environment is not authenticated and requires `wrangler login`; no Cloudflare account/runtime is available here for disposable deployed Container or billing validation.
- ToolSandbox lifecycle tests verify the completion merge and the blocked/cancelled/suspended/forced-teardown/cold-replacement paths with mocks. They do not establish Cloudflare process, mount, allocation, or crash-recovery behavior.

### Remaining Phase 2 work

- Run repeatable ToolSandbox Container runtime coverage for ordinary and binary reads/writes, rename, deletion, flush/checkpoint durability, timeout and cancellation, real process crash/restart and recovery, and guest isolation from coordinator credentials/control routes. Mocked Durable Object reconstruction now covers staged-checkpoint recovery ordering. The current local Wrangler evidence covers the coordinator only; the attempted local Docker image build failed before a Container could run.
- Verify Container mount readiness, teardown, allocation accounting, and billed idle behavior in an actual supported runtime. No deployed Container, mount, allocation, or billing evidence is available in this work session.
- Complete the remaining caller migration only after this internal slice: current audited legacy publication paths are fail-closed under unified mode, but they do not yet publish through the coordinator. Continue auditing for any project workspace writer not covered by the added guards before widening rollout.
- Semantics currently covered by mocks: successful completion flushes/checkpoints and merges; blocked execution flushes to its isolated run branch without merging; cancellation and suspension preserve the prior checked run branch and do not merge; forced teardown destroys the runtime without claiming unpublished staging as committed; cold replacement closes the old session and increments allocation generation. Validate each against real Container crashes, flush failures, and recovery before acceptance. A staged object is not itself a committed revision; only a successful coordinator checkpoint advances the branch.
- Extended Analytics Engine lifecycle points with a versioned workspace metric payload: bytes hydrated into the Container, bytes captured from it, bytes submitted for staging, successful checkpoint count, and successful checkpoint duration. Existing allocated milliseconds, estimated credits, cold starts/startup time, warm hits/idle time, executions, and execution time remain in their original double positions. A mocked ToolSandbox test verifies checkpoint byte/count accounting.
- Added per-execution Analytics Engine R2 list/read/write/delete count dimensions and lifecycle aggregate operation counts beside the existing hydrated/captured/staged byte totals and checkpoint metrics. A mock regression verifies the versioned per-execution event shape; it does not validate emitted R2 counts against a live service. Instrumentation still lacks per-execution byte dimensions, staging retention over time, failed checkpoint latency, R2 class/region pricing, and provider-reported billed idle charges. These events support transfer/cost analysis but do not establish actual billed cost.
- Phase 2 is **not complete under its acceptance criteria**. Keep `UNIFIED_WORKSPACE_ENABLED` and live-workspace admission disabled until the Container/runtime, isolation, mount/accounting, remaining caller migration, and cost/transfer gates pass. Phase 1's outstanding deployed GC/erasure, legacy migration, retention, and allocation-generation gates remain separately listed above and are not closed by this Phase 2 work.

## Phase 3 — Agent37 checked-handoff acceptance

### Implemented so far

- Preserved Agent37's provider `truncated` signal in the normalized execution result.
- Added bounded, root-restricted file list/read/write helpers using the documented Agent37 per-instance file endpoints. Write updates use the documented `X-Expected-Mtime` guard after checking the expected content hash. Paths are normalized under `/home/node/workspace`; file count, tree bytes, per-file bytes, depth, redirects, and request time are bounded. Symlinks and unsupported file types are rejected.
- Agent37 execution now defaults its working directory to the Naelao workspace root when no explicit working directory is supplied.

### Verification

- `workers/sandboxes`: focused `providers/agent37.test.ts` passed, **5 tests**, using mocked HTTP responses. These tests validate adapter logic only; they do not prove a live instance/template or provider service behavior.
- Independent primary-source check: Agent37's current official `files.md` documents instance-root credentials, `GET /v1/files`, raw-body `PUT /v1/files/content`, `GET /v1/files/content`, `DELETE /v1/files`, and `X-Expected-Mtime` on writes. The docs say file keys can reach paths outside the workspace and document no conditional delete header. The current `exec.md` documents a 512 KB cap per stdout/stderr and a `truncated` boolean. Source: [Agent37 Files](https://www.agent37.com/docs/agents-api/files.md), [Agent37 Run commands](https://www.agent37.com/docs/agents-api/exec.md).

### Remaining Phase 3 work / external dependency

- Connect an authorized disposable Agent37 account, API/instance credentials, approved template, region, and billing account; none is available in this repository session, so live acceptance cannot be run here.
- Wire the Agent37 file helper into the checked snapshot/stage/execute/publish flow through an atomic canonical workspace adapter. The current Agent37 Filesystem bridge is legacy per-file CAS, so routing new runs through it would violate all-or-none publication; Agent37 execution remains unavailable until the unified service integration exists.
- Add real lifecycle, generation, wake/sleep, file-path, file-size, timeout-after-dispatch, truncated output, cancellation, uncertain-result reconciliation, resource cap, region, and billing-receipt journeys.
- Do not mark Agent37 available or auto-schedule it until the full acceptance gate passes. Investigate the provider's unguarded recursive delete behavior before using it for staged workspace cleanup.

## Phase 4 — Client migration and dual-read verification

### Implemented in this continuation

- Added a tenant-authenticated `checked-publish` adapter in Agents. It pins `main` at an observed revision, opens a checked session, stages a bounded single-file update with its observed expected hash, checkpoints with an idempotency key, and closes the session. It never writes the legacy R2 tree. A head race or expected-hash conflict fails closed.
- Migrated the Spaces workflow-plan writer to this adapter when `UNIFIED_WORKSPACE_ENABLED=true`. Owner/admin and project authorization remain in front of publication; an initialized coordinator revision is required. Feature-off behavior remains the existing legacy-only path. No dual-write path was added.
- Migrated project MCP `runAstPatch` to checked coordinator publication in unified mode. It reads and integrity-checks the manifest entry, requires a unique UTF-8 patch target, publishes with the observed file hash, and returns the new main revision. The route still requires project manage authorization; feature-off behavior remains legacy CAS.
- Added `WORKSPACE_DUAL_READ_ENABLED` for bounded project UI verification. When explicitly enabled, the UI compares at most 50 manifest entries plus a bounded legacy-only page and 16 MiB of legacy bytes per request, hashing both sides. It records only tenant/space/project IDs, branch/revision, path hashes, content hashes, mismatch class, and bounded counters; it never records filenames, content, or credentials. Drift classes are `legacy_missing`, `manifest_missing`, `hash_mismatch`, and `size_mismatch`.
- Drift is surfaced in the `workspace_dual_read` structured log event for operator review. No automatic repair is attempted. Before switching the UI read source, an operator must pause migration for affected projects, compare scoped hashes, resolve concurrent writers, import intended legacy content through a checked revision with expected hashes, verify a clean bounded dual-read pass, and retain rollback aliases until project verification completes. The flag is false in dev/staging/production configuration.
- Project UI manifest reads already return branch/revision on directory listings; single-file canonical responses now include `x-workspace-branch` and `x-workspace-revision` headers.
- Connected the script engine's shared R2 CAS write/delete helpers to the checked publisher only when a project run already has an isolated non-`main` workspace branch. The adapter pins that branch head, submits the observed expected hash, stages, checkpoints idempotently, and returns the committed revision. Unbranched runs receive no coordinator write adapter and stay fail-closed under unified mode, preserving parent-branch lifecycle semantics.
- Added branch/revision identity to manifest-backed virtual filesystem `read_file`, `stat_file`, and `list_directory` responses. The compatibility R2 adapter carries the branch/revision on manifest objects so file reads identify the exact manifest snapshot that supplied their bytes; legacy and non-project storage keep their existing response shape. Focused tests assert the canonical content and revision identity.
- Moved new immutable environment handoff blobs to a tenant/space/project-scoped `workspace-artifacts/` namespace outside the canonical file tree. Legacy workspace-prefixed blobs remain readable through a host-retained raw-bucket fallback. Restoring an artifact into an isolated project branch now uses the same checked CAS callback; the existing 768 KiB coordinator file limit applies to these restores.
- Migrated SpaceDO blueprint/template starter seeding when unified mode is enabled: content-addressed objects are uploaded and hash verified by the coordinator's `/v1/initialize`, producing revision 1 before project rows become visible. New project IDs mean there is no pre-existing legacy tree to alias; project migration/rollback aliases remain a separate unfinished path. If initialization fails, the seed attempts coordinator erasure before exposing project rows, logs a scoped `workspace_seed_rollback_pending` event if cleanup fails, and removes objects that were never submitted for initialization.

### Remaining clients / direct paths

The source audit remains broader than the completed migration. The following are still unowned or not fully migrated to revision-aware checked adapters; rollout flags must remain disabled:

| Client class | Current path | Phase 4 status |
|---|---|---|
| Virtual filesystem tools and file manager | `script-engine/r2-workspace.ts`, prebuilt file manager/workspace operations, `r2-cas.ts` | Manifest-backed file/stat/list reads return branch/revision identity; shared CAS write/delete operations publish through the coordinator on already isolated non-`main` branches. Direct R2 writers and unbranched run writes remain unmigrated/fail-closed. |
| Project UI / Spaces routes | Workspace file routes and `workers/spaces/src/routes/mcp.ts` | Manifest compatibility reads and revision identity exist. Bounded dual-read is implemented but disabled. Workflow-plan and MCP `runAstPatch` writers are migrated; attachment/session uploads and other scoped mutations remain guarded, not migrated. |
| Artifact history and restore | Artifact Worker plus `environment-artifacts.ts` | New immutable handoff blobs use a project-scoped non-workspace R2 namespace; old blobs retain raw-bucket read compatibility. Restore uses checked coordinator publication only on isolated branches; main/history/repository projection paths remain unmigrated. |
| Git/repository operations | `workers/artifact/src/RepositoryDO.ts` | Repository projection remains separate; reconcile, replay, and commits are not coordinator-backed publications. |
| Subagents and project branches | `workers/agents/src/do/NaelaoAgentDO.ts` | Task/worker setup still copies R2 trees and worker merges still perform per-file publication. Must use isolated checked branches and checked merges. |
| Provider import/export and external runtimes | `workspace-bridge.ts`, Agent37 helpers, environment artifact tools | Agent37 checked handoff has an adapter but remains mock-only; provider import/export and bridge migration are incomplete. |
| Project creation/seeding and migration | `workers/spaces/src/do/SpaceDO.ts` | Blueprint/template starter files create a verified initial coordinator revision before project rows become visible. Existing-project migration, durable retry of ambiguous rollback cleanup, and rollback aliases remain unimplemented. Tenant-shared provider connections are not changed by seeding. |
| Project deletion | Spaces deletion paths and erasure workflow | Coordinator erasure exists, but project deletion does not yet revoke all workspace sessions/subscriptions and retryably clean staging plus alias records while preserving sibling-project tenant connections. |
| Other ingress / specialized writers | Attachments, workflow plans, MCP patch, project journal, distillation, and audited R2/CAS call sites in the plan inventory | Some paths are guarded while unified mode is active; guards are not migration evidence. Re-audit all direct writers before acceptance. |

### Verification and limits

- Spaces focused tests: dual-read/compatibility and seed barrier suites, **9 passed**; project MCP route suite, **3 passed**. These cover mismatch classification, legacy-only drift, entry/byte bounds, redacted logging, canonical compatibility parsing, seed hash verification/visibility/rollback, and checked MCP publication.
- Agents focused tests: checked-publish and initialize routes, CAS, virtual filesystem, environment artifact, compatibility route, and coordinator suites, **62 passed** before this continuation; the updated virtual filesystem suite adds a branch/revision identity assertion and is rerun below. They use mocks; no live Cloudflare bindings were exercised.
- Spaces `tsc --noEmit` passed after building local `@naelao/sdk` declarations. Agents `tsc --noEmit` passed after building local `@agentport/sdk` declarations.
- Blueprint seed plus activation regression run: **17 passed**; it verifies that tenant-authenticated activation reaches the SpaceDO import path. The seed test uses mocked R2/Agents services, not deployed coordinator bindings.
- The normal `pnpm --filter` command attempted a dependency reinstall and failed on the repository's existing lockfile/overrides mismatch. Dependencies were restored using `pnpm install --lockfile=false --ignore-scripts`; the lockfile was not changed.
- No migration dual-read was enabled, no project content imported, no mutation barrier or rollback alias was exercised, and no deployment/provider/runtime validation was performed.

### Phase 4 exit criteria (still open)

1. Complete the caller inventory and assign owners for every direct canonical reader/writer; no unowned direct R2 writer remains.
2. Migrate virtual filesystem tools, artifacts/history/restore, RepositoryDO/Git, subagents/branch merge, provider import/export, project creation/seeding, and remaining Spaces/MCP/attachment ingress one client class at a time. Every read returns branch/revision identity; every write uses observed revision/expected hashes and coordinator publication.
3. Run bounded dual-read verification for each client class, resolve and recheck all drift before switching that class's read source, and document repair receipts. Do not dual-write.
4. Preserve authorization, tenant/project/branch isolation, fencing, idempotency, expected-hash conflict handling, billing admission, and execution lifecycle semantics. Test that failed, blocked, cancelled, suspended, and indeterminate runs never publish to the parent branch.
5. Complete project migration with a mutation barrier, verified imported hashes, initial revision, rollback aliases retained until verification, and tenant-level provider connections preserved for sibling projects.
6. Complete retryable project deletion cleanup that revokes sessions/subscriptions and removes project staging/aliases without deleting shared tenant provider connections.
7. Keep rollout flags disabled until Phase 1–3 acceptance is independently recorded. Deployed Cloudflare GC/erasure validation, real ToolSandbox runtime validation, and Agent37 live acceptance remain separate gates and are not satisfied by these local mocks.

## Current next actions

1. Add delayed/ambiguous R2 PUT versus content-GC marking and pointer publication tests, then test the transaction interleavings in Miniflare or a deployed disposable namespace.
2. Validate the per-workspace authenticated alarm scheduler and GC/erasure against deployed DO/R2 cursor, transaction, deletion, retry, and jurisdiction behavior; record status output and runtime versions.
3. Keep artifact history unpruned until a product retention policy is approved; retain historical revisions and content safely meanwhile.
4. Complete the legacy reader/writer call-path audit before enabling the coordinator; legacy paths still exist.
5. Validate allocation generation advancement on real container replacement, duplicate changed-payload staging keys, and failed manifest upload.
6. Connect Agent37 to an atomic checked workspace adapter; run real provider lifecycle, billing, generation, file API, and indeterminate-execution acceptance with an authorized disposable account.
7. Keep both rollout flags disabled until all runtime gates pass. Phase 4 code migration may proceed with independent Phase 1–3 acceptance gates still explicitly open.
