# Unified workspace requirements record

This record is the requirements companion to the [unified platform implementation plan](naelao-unified-platform-deep-plan.md) and the repository's [requirements-to-code trace matrix](../requirements-trace-matrix.md). Implementation evidence and unfinished work are tracked in [implementation progress](unified-platform-implementation-progress.md).

## Fixed product behavior

1. Every project workspace client must use one authorized workspace service for reads, staging, checked publication, and revision history. Virtual tools, containers, project UI, artifacts, Git/repository adapters, provider imports/exports, and extensions must not create alternate canonical write paths.
2. `checked_handoff` is the default. A session starts from a pinned revision, stages work on an isolated branch, and publishes a complete manifest only after expected hashes, allocation generation, policy, and fencing checks pass. Parallel agents use separate branches; conflicts preserve their staging data and do not partially advance a branch head.
3. `live_single_writer` is opt-in. One runtime owns a durable lease with a monotonic fencing token. Authorized readers see committed revisions and revision notifications. Runtime staging remains private. A writer change requires a flush, checked publication, lease revocation, generation advancement, and reopen from the committed revision.
4. Runtime admission must match requested capabilities, authorization, residency, policy, and available budget. Try another authorized capable runtime when possible; otherwise return a structured capability error. Never silently change live mode to copy or checked mode.
5. Runtime/container synchronization writes only to isolated staging. Only Naelao's checked publication service can advance canonical workspace state. Preserve existing tenant, space, project, branch, extension, and guest isolation; expected-hash checks; fencing; billing admission; and execution-ladder behavior.
6. Agent37 is the external persistent runtime lane. `ToolSandboxDO` is a separate internal bounded Cloudflare Container lane. Do not claim provider readiness from adapter code or mocks. Keep Agent37 unavailable until live lifecycle, file-transfer, region, generation, billing, cancellation, and recovery acceptance passes.
7. The canonical design uses project-scoped Durable Object metadata and immutable, tenant-scoped R2 content. Commit one manifest pointer and its receipt in one DO transaction after immutable objects are stored and verified. D1 and legacy R2 tree projections are compatibility/index layers, not part of the atomic commit.
8. Do not advertise FUSE or Cloudflare Computer container-sync capability until the exact package/daemon provenance, actual mount operations, synchronization, flush, auth, reconnect-generation, ignore behavior, billing, and failure cases pass on the target runtime. Live FUSE is not established for Agent37 by documentation alone.
9. Retain original source transcripts and previous research drafts unchanged. Treat the consolidated plan as the implementation guide, but verify each proposal against code, primary vendor documentation, and tests.

## Technical limits that affect acceptance

- Durable Object transactions can atomically update metadata held by one object; they do not make multiple R2 objects one transaction. Readers must resolve one complete immutable manifest through the committed head.
- Agent37 documents per-instance file endpoints, but its instance key can address arbitrary paths on the instance. Naelao must enforce a root and path policy; symlinks/special files, per-file/tree size, traversal, and output caps need explicit handling.
- Agent37 documents `X-Expected-Mtime` for conditional file writes. It does not document an equivalent conditional DELETE. Any deletion behavior must be reviewed against this provider limitation and cannot be treated as a CAS operation.
- Agent37 exec output truncation is a provider response signal; preserve it even when the returned text is below Naelao's own local cap.
- A successful unit test with mocked R2, Durable Object state, container, or provider calls is not evidence of deployed FUSE/runtime, provider billing, region, or end-to-end acceptance.

## Release evidence

For each phase, record changes, focused tests, typecheck/build results, deployment/runtime evidence, and unresolved blockers in [implementation progress](unified-platform-implementation-progress.md). Keep live-mode and provider capability flags disabled until their phase gates have real evidence.
