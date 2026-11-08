# Unified platform implementation progress

Branch: `Mcbt5s-Backup-2`
Plan: [Naelao unified platform plan](naelao-unified-platform-deep-plan.md)
Requirements: [unified workspace requirements](unified-workspace-requirements.md)
Trace matrix: [requirements-to-code matrix](../requirements-trace-matrix.md)

## Status

Implementation has started through Phase 3. None of these phases is complete or ready for rollout. Both `UNIFIED_WORKSPACE_ENABLED` and live-workspace admission remain disabled by default. Agent37 remains unavailable and auto-scheduling remains off.

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

### Remaining Phase 1 work

- Add a timeout/lost-response test where an R2 PUT commits after the caller believes it failed. The delayed-response mock covers GC versus publication, but does not emulate a provider timeout followed by late server-side commit.
- Validate transaction interleaving and R2 cursor/deletion behavior against Miniflare or a deployed disposable namespace. Existing transaction and erasure tests use mocks and do not close these races.
- Exercise the alarm/status path against deployed Agents + Durable Object + R2 bindings, including retry delivery, jurisdiction, maintenance status polling, and slow/failing object pages. Per-workspace self-scheduling is source-implemented only; it is not evidence of deployed scheduling.
- Revision manifests and retained revision pointers are intentionally kept without an age/count limit so historical reads remain possible. Define the product's artifact-history retention policy before adding history pruning; current GC safely preserves every retained revision.
- Validate the new paginated coordinator-erasure flow against the deployed Spaces, Agents, Durable Object, and R2 services, including archived projects, space assistants, and space-wide extension scopes. A mocked workflow test cannot establish deployed binding or jurisdiction behavior.
- Complete a caller-by-caller audit of canonical reads/writes and decide which legacy R2/CAS and per-file snapshot paths must migrate before a pilot. Inventory is documented in the plan, but legacy paths remain active.
- Validate allocation generation advancement on real container replacement, duplicate changed-payload staging keys, failed manifest upload, and Cloudflare DO transaction/alarms plus R2 cursor semantics in Miniflare or deployed smoke tests.

## Phase 2 — Internal ToolSandbox vertical slice

### Implemented so far

- Added an opt-in ToolSandbox path that bootstraps an immutable revision from scoped R2, hydrates from a verified manifest, creates an isolated branch per run, checkpoints changes to that branch, and three-way merges to the requested branch only on successful completion. A blocked run checkpoints and remains isolated. Pending checkpoint intent is retried with the same idempotency key. A cold replacement closes the previous session before opening a new generation, preventing stale sessions from publishing after recovery.
- Added `UNIFIED_WORKSPACE_ENABLED=false` in development, staging, and production. It remains off because the integration is tested with a mocked container, not a real Cloudflare Container deployment.
- Preserved the current legacy path while rollout remains disabled. Do not enable until migration/canonical-reader behavior is resolved; otherwise old project readers may see stale R2 tree state.

### Verification

- ToolSandbox integration-style tests use the real coordinator class and a mocked container port; they verify writes stay off `main` until completion and then merge to the parent revision.
- Existing ToolSandbox tests passed alongside coordinator tests. This does not prove real Cloudflare Container, billing, mount, process cleanup, file permissions, or deployed R2 behavior.

### Remaining Phase 2 work

- Add actual Cloudflare Container integration/smoke coverage for read, binary files, rename, deletion, timeouts, cancellation, crash/restart, staging retention, and no guest access to coordinator/control paths.
- Resolve compatibility reads: migrate the relevant project/client readers to manifest reads or provide a safe transition strategy. Never expose a partially updated per-file R2 projection as a committed revision.
- Current `blocked` and `completed` task lifecycle calls flush; only `completed` merges. Cold runtime replacement closes the old checked session. Alarm-driven expiry, policy suspension, cancellation, and forced teardown do not claim publication; they preserve staged R2 content where staging completed.
- Real Cloudflare Container verification remains outstanding for file operations, flush semantics, access to internal control routes, failure teardown, and billed allocation behavior.
- Add cost/transfer measurements before and after the pilot; keep the feature disabled until those measurements and safety cases pass.

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

## Current next actions

1. Add delayed/ambiguous R2 PUT versus content-GC marking and pointer publication tests, then test the transaction interleavings in Miniflare or a deployed disposable namespace.
2. Validate the per-workspace authenticated alarm scheduler and GC/erasure against deployed DO/R2 cursor, transaction, deletion, retry, and jurisdiction behavior; record status output and runtime versions.
3. Keep artifact history unpruned until a product retention policy is approved; retain historical revisions and content safely meanwhile.
4. Complete the legacy reader/writer call-path audit before enabling the coordinator; legacy paths still exist.
5. Validate allocation generation advancement on real container replacement, duplicate changed-payload staging keys, and failed manifest upload.
6. Connect Agent37 to an atomic checked workspace adapter; run real provider lifecycle, billing, generation, file API, and indeterminate-execution acceptance with an authorized disposable account.
7. Keep both rollout flags disabled until all runtime gates pass; do not begin Phase 4 client migration before Phase 1–3 gates are closed or explicitly accepted as deployment-only blockers.
