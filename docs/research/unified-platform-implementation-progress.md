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
- Added a seven-day stage collector for consumed stages, expired closed-session stages, and aged orphan uploads. It never collects canonical content or active-session stages.
- The staging collector also removes aged metadata for delete-only/empty stages, which have no R2 object from which to discover their records.
- Added a server-side client using Naelao's HMAC-derived Durable Object names.
- Added authorized coordinator erasure: the coordinator tombstones the scope before deleting its R2 objects and metadata, and later requests cannot recreate an erased scope. The existing data-erasure workflow now enumerates project, assistant, and space-extension scopes in bounded pages and calls the coordinator erasure endpoint before the broad legacy prefix sweep.
- R2 writes that lose the erasure race are removed when their coordinator transaction observes the erased tombstone; rejected initialization manifests and staged uploads receive the same cleanup.
- Added revision polling and subscriber acknowledgements as bounded APIs; subscriber acknowledgements are monotonic. Erasure project enumeration has a 100-scope page limit and workflow retries use stable per-page step names.
- Bound and migrated the coordinator in development, staging, and production Worker configuration; jurisdiction applies through the existing Durable Object jurisdiction gate.
- Live admission fails with `capability_unavailable` unless the feature is explicitly enabled and current runtime evidence proves the live mount, authenticated transport, allocation generation, template digest, and verification age.

### Verification

- Focused `WorkspaceCoordinatorDO.test.ts` and `ToolSandboxDO.test.ts` pass, **36 tests**, covering idempotent publication/merge and changed-payload rejection, disjoint three-way merge, same-path conflict preservation, concurrent checkpoint races, stage persistence across coordinator reconstruction, stage idempotency, stage GC including empty-stage metadata, revision polling/acknowledgement, lease expiry/fence advancement, capability rejection, run-branch isolation, completion-time ToolSandbox merge, and erased-scope tombstone behavior.
- `workers/workflows` `erasure-cleanup.test.ts` passes, **16 tests**, including cursor forwarding and the bounded coordinator-erasure page contract. `workers/sandboxes` `providers/agent37.test.ts` passes, **5 tests**.
- Typechecks pass for Agents, Spaces, Sandboxes, and Workflows after building their workspace SDK dependencies.
- Wrangler dry-run passes for Workflows and Sandboxes. Agents dry-run reached Docker image construction but failed because the execution environment ran out of disk space. Spaces has no package `build` script; its typecheck passes.
- `git diff --check` passes. No live deployment or provider acceptance has been run.

### Remaining Phase 1 work

- Content-addressed orphan collection remains open. Historical immutable manifests are currently retained without a bounded history policy; deleting their content without a mark/sweep over every retained manifest would break historical reads.
- Add bounded event/receipt retention and subscription expiry. Polling cursors and acknowledgement monotonicity exist, but event pruning/reset behavior and operational notification fan-out need a retention contract.
- Validate the new paginated coordinator-erasure flow against the deployed Spaces, Agents, Durable Object, and R2 services, including archived projects, space assistants, and space-wide extension scopes. A mocked workflow test cannot establish deployed binding or jurisdiction behavior.
- Ensure every canonical write path and read client is inventoried; the legacy workspace paths remain active until the later migration phase.
- Add tests for allocation generation advancement on real container replacement, duplicate changed-payload staging keys, failed manifest upload, and Cloudflare DO transaction semantics in Miniflare/deployed smoke tests.

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

1. Add a mark/sweep protocol for immutable content/manifests with retained-history roots, bounded batches, and crash-safe cursors.
2. Define and implement bounded subscription, event, and publication-receipt retention. Polling and monotonic acknowledgements exist, but pruning and expired-subscriber reset behavior do not.
3. Validate coordinator metadata erasure and bounded page traversal against deployed DO/R2/services, including retries and partial deletion.
4. Connect Agent37 to an atomic checked workspace adapter; run real provider lifecycle, billing, generation, file API, and indeterminate-execution acceptance with an authorized disposable account.
5. Re-run the Agents Wrangler dry-run after freeing build space, then run deployed runtime, billing, isolation, teardown, binary-file, and crash tests. Keep both rollout flags disabled until the runtime gates pass.
6. Do not begin Phase 4 client migration until the above Phase 1–3 gates are closed or explicitly accepted as deployment-only blockers.
