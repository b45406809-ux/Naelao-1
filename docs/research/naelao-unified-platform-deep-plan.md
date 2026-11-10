# Naelao unified workspace and execution platform: independently researched plan

**Status:** implementation plan; implementation is in progress. See [phase progress and evidence](unified-platform-implementation-progress.md) and [fixed workspace requirements](unified-workspace-requirements.md). Runtime capability flags remain off until their phase gates pass.

**Code inspected:** `Mcbt5s-Backup-2` at `cd01638c` (2026-11-07). Earlier workspace and platform research files were used only as a topic checklist. Their findings were rechecked against this checkout and external primary sources. This document is the consolidated plan and supersedes those drafts as an implementation guide; retain them as research history until the team chooses to archive them.

The earlier commits `3737c841` and `5229d607` are historical planning/bridge anchors, not the code baseline verified here. The documents consolidated as topic history are [Cloudflare Computer design analysis](cloudflare-computer-design-analysis.md), [workspace/runtime feasibility](workspace-and-runtime-enhancement-feasibility.md), [platform-wide proposals](agent-platform-wide-enhancement-proposals.md), and [trust/security/data lifecycle proposals](trust-security-data-lifecycle-proposals.md).

## 1. Decision summary

Build one authorized workspace service that owns project file revisions and is used by virtual tools, internal container tools, the project UI, artifact history, Git/repository adapters, and external runtimes. Keep runtime filesystems as isolated working copies. Publish into canonical project state only through a Naelao checked publication operation.

Keep the two previously specified consistency modes:

| Mode | Contract | Default |
|---|---|---|
| `checked_handoff` | A run opens a pinned revision on an isolated branch. Writes remain staged. Explicit checkpoints and eligible completion/suspension paths publish against expected hashes. Parallel agents use separate branches. | Yes |
| `live_single_writer` | One runtime owns a fenced writer lease. Other authorized clients read committed revisions and receive revision notifications. The writer's changes become canonical only at checked checkpoints. Changing writers requires a drain, publication, lease revocation, and reopen from the committed revision. | No |

The production authority should be a project-scoped workspace coordinator Durable Object with SQLite metadata and an R2 immutable-content store. It should own branch heads, revision manifests, leases, publication receipts, and subscription cursors. Large file bytes belong in R2; SQLite stores hashes, paths, mode bits, revisions, pointers, and bounded receipts.

Use Cloudflare Computer selectively, not as an assumed turnkey runtime. The pinned `@cloudflare/computer@0.10.0` source has a stable SQLite filesystem surface, but its `ContainerBackend`, sync protocol, RPC protocol, and `computerd` are explicitly experimental. The package does not implement Naelao's authorization, branch merge, publication CAS, or tenant fencing. Reuse its stable filesystem abstractions where beneficial; keep the experimental mount/sync path behind a strict capability gate and do not advertise it until it passes real runtime acceptance.

Treat the runtime lanes separately:

- **Internal bounded tool execution:** Naelao already runs `ToolSandboxDO` over a Cloudflare Container for Tier-5 tools. Preserve its execution deadlines, guest isolation, budget admission, and local staging behavior. Do not turn it into the default customer computer provider.
- **External persistent computer:** Naelao has an Agent37 adapter, but `GET /providers` currently reports Agent37 unavailable, and auto-scheduling is disabled. Agent37's documented API provides instance lifecycle, command execution, file operations, custom images, and authenticated per-instance URLs. Its public docs do not establish `/dev/fuse` access or compatibility with `computerd`; FUSE must be proven on the chosen instance type/template before it is a capability.

When requested runtime capabilities are absent, search only authorized runtimes that satisfy residency, budget, and policy. Return a structured capability error if none qualifies. Never quietly change `live_single_writer` into snapshot or copy-based mode.

## 2. Evidence method and confidence

Claims below fall into three classes:

- **Observed in code:** verified in the inspected branch. This is source evidence, not proof that a deployed Worker is running that code.
- **Provider documented:** stated in current official docs, terms, or upstream source. Contract and account settings may still differ.
- **Implementation inference:** a design/risk derived from source or provider semantics. It must be tested before being treated as a production finding.

Cloudflare Computer was inspected at the requested commit `bb0a5db4b7e8c8a79625d63e0e272602f909640e`, and its `packages/computer/package.json` at that commit identifies version `0.10.0`. Current repository package manifests do not include `@cloudflare/computer`; no matching `computerd` build or recorded runtime image digest was found in the examined sandbox Dockerfile. Therefore earlier requirements to pin the dependency and daemon describe future work, not completed implementation.

## 3. What the current code actually does

| Area | Observed implementation | Consequence for this plan |
|---|---|---|
| Project workspace writes | `workers/agents/src/script-engine/r2-workspace.ts` and `r2-cas.ts` route shared writes through R2 and `ConcurrencyDO` locks/fences/expected hashes. Paths are partitioned by space/project/branch. | Preserve these protections, but move canonical commit semantics from independent per-file writes to an atomic revision-head transition. |
| Internal container tool workspace | `ToolSandboxDO` runs a bounded container harness. `container/server.mjs` says `/workspace` is the warm container's local disk and files move to/from shared storage through explicit operations. It does not currently mount Cloudflare Computer. | Keep these containers as one runtime adapter. They are a transient/staging filesystem, not proof of the Agent37 runtime contract. |
| Generic sandbox filesystem | `workers/sandboxes` persists filesystem rows and configures `filesystemMode = "snapshot_diff"`, `consistency = "file_cas"`; the bridge only accepts this mode. The stored consistency value is returned but does not implement separate `checked_handoff` and `live_single_writer` semantics. | Replace this mode-shaped configuration with enforced mode contracts and capability admission. Do not infer behavior from a column or enum. |
| Snapshot bridge | `workspace-bridge.ts` snapshots at most 200 files/64 MiB with a 24-hour TTL. Unified project snapshots pin coordinator revision, verify hashes/size/MIME against legacy, fail closed on drift, and publish through one checked checkpoint. Private R2 transfer staging supports 20 MiB files with a 28 MiB encoded request bound. Feature-off and non-project compatibility publication remains per-file. | Unified project publication is atomic at the manifest pointer. Verify the 20 MiB path against deployed request/runtime limits; retain explicit compatibility semantics and the mutation barrier until rollout. |
| Sandbox publication | `sandbox_publications` journals idempotency and pending state. Each path gets its own lock and CAS call. Recovery retries the same intended path mutations. | Retain journaling and expected-hash conflict behavior; add one atomic revision pointer so a reader cannot observe a multi-file publication half complete. |
| Git/repository workspace | `RepositoryDO` journals Git-to-workspace publication and checks expected file hashes. | Adapt this as another client of the canonical revision API; do not maintain its own final authority or allow divergent commit rules. |
| Agent37 provider | `workers/sandboxes/src/providers/agent37.ts` supports allocation/lifecycle/exec and a checked coordinator workspace handoff in code. The `/providers` endpoint still returns it unavailable, says runtime acceptance is not configured, and sets `autoSchedulingEnabled: false`. The handoff preserves manifest MIME and has a 20 MiB file bound behind a 30 MiB authenticated Agents request. | The service-binding adapter and local mocked transfer path do not establish provider behavior. Keep the provider unavailable until live credentials, templates, region, API limits, accounting, recovery, and workspace-transfer acceptance pass. |
| Workflow and effect control | Agents contain Durable Workflows, `WorkflowJournal`, budget reservations/settlement, effect receipts, task records, and uncertainty states. Credential egress journals external writes and blocks automatic retry after ambiguous outcomes. | Reuse these IDs and receipts in the workspace session/run contract; do not create a second competing workflow/task authority. |
| Access and secrets | Credentials are tenant/space scoped, resolved by the credentials Worker, and outbound requests pass through policy, SSRF checks, payload/response bounds, and secret redaction. | Workspace reads/writes must keep owner-side authorization. A mounted filesystem or provider file API must never be treated as an authorization grant. |
| Erasure | Workflows delete tenant/space rows and paginated R2 prefixes; specialized paths erase product users and communications. | Add a deletion manifest covering new revision manifests, content-addressed objects, staging branches, runtime disks, aliases, and provider-retained backups. |
| Telemetry | Workspace/sandbox and Workflow metrics already exist in places. | Add bounded revision/checkpoint metrics and a data inventory for retention; avoid contents and high-cardinality dimensions in metrics. |

### Phase 1 canonical workspace path inventory (source audit, 2026-11-08)

The coordinator is the intended owner of revisioned project state. A scoped `WorkspaceCoordinatorDO` stores branch heads/manifests, immutable content and receipts; `ToolSandboxDO` calls it through `workspaceCoordinatorRequest` to initialize, read, stage, checkpoint, merge, erase and hydrate runtime copies. Its feature-flag-off path still hydrates and publishes the legacy R2 tree. If the new head is absent, bootstrap imports that tree into coordinator content. The import is a compatibility bootstrap, not ongoing synchronization.

| Caller / source path | Reads | Writes / deletes | Status and migration owner |
|---|---|---|---|
| `workers/agents/src/workspace/WorkspaceCoordinatorDO.ts` | Head, manifest, content, staging and metadata in scoped `workspace-v1/` keys | Revisioned content/manifests, stage records, GC and scoped erasure | Target canonical authority. Alarm maintenance is bounded and status-visible; deployed alarm and jurisdiction behavior remains unvalidated. |
| `workers/agents/src/do/ToolSandboxDO.ts` | Coordinator head/manifest/content when enabled; legacy `workspacePrefix` R2 tree for disabled mode and bootstrap | Coordinator stage/checkpoint/merge when enabled; legacy per-file R2/CAS publication when disabled | Main runtime adapter. Keep flag disabled until all acceptance gates close; remove compatibility import only after migration coverage is proven. |
| `workers/agents/src/script-engine/r2-workspace.ts`; `script-engine/prebuilt/{workspace,r2-workspace,file-manager}.ts`; `script-engine/r2-cas.ts` | Direct R2 reads/listing of the old workspace tree; file manager also reads history/diff data | Writes, append/patch, move/copy and deletes through per-file CAS plus `ConcurrencyDO` | Manifest reads are available. Shared CAS write/delete operations publish through checked coordinator branches for existing isolated non-`main` runs; unbranched runs fail closed under unified mode. Legacy CAS operations use the project migration mutex. Full call-site and branch lifecycle audit remains open. |
| `workers/agents/src/script-engine/prebuilt/{document-processing,code-exec,attachments,skill-manager,web-search}.ts`; `script-engine/{video-distill,observe}.ts`; `environment-artifacts.ts` | Direct reads/listing of workspace R2 objects for inputs and artifacts | Artifact restore uses the shared CAS adapter; new immutable handoff objects use a separate tenant/space/project namespace with legacy raw-bucket read fallback | Restore checkpoints only on an existing isolated branch. Other direct mutations and history/projection paths remain active migration work. |
| `workers/agents/src/sandboxes/workspace-bridge.ts` | Legacy snapshot and staging objects | Publishes snapshot changes per file under old branch R2 prefix; staging under `sandbox-workspace-bridge/` | Active snapshot bridge; separate from coordinator staging and cleaned by Agents cron. Migrate or retire with runtime adapter rollout. |
| `workers/agents/src/do/NaelaoAgentDO.ts` | `onWorkspaceChange` rereads latest R2 bytes; task/worker branch setup lists and copies base trees; worker merge reads branch and baseline objects | Task/worker branch seed copies/deletes R2 trees; worker merge publishes per-file conditional puts; Git projection is separately sent to Artifact Worker | Active orchestration and branch isolation path. Replace tree-copy/merge authority with coordinator branch/revision operations; retain Git as projection. |
| `workers/artifact/src/RepositoryDO.ts` | `/reconcile` lists canonical `WORKSPACE_R2`, gets and hashes objects; pending publication checks current R2 head/hash | Pending per-file mutations publish conditional puts to `WORKSPACE_R2`; repository Git objects/refs are a separate projection | Active direct reader/writer. Route canonical publication/reconciliation through coordinator; keep repository data as projection only. |
| `workers/spaces/src/index.ts` project workspace file routes, `routes/mcp.ts`, Agents file-manager | Member-authorized UI/MCP reads from the workspace view | Workflow-plan, MCP AST patch, and file-manager restore writes | UI/MCP/VFS reads use revision-aware compatibility adapters; bounded dual-read remains disabled. Workflow-plan, MCP patch, VFS, and file restore use checked coordinator publication when unified mode is enabled. Session/attachment ingress remains separately scoped. |
| `workers/spaces/src/do/SpaceDO.ts` project creation and explicit migration route | Reads starter-file definitions and the existing R2 workspace prefix | New projects initialize the coordinator before visibility; existing projects use an admin-authorized migration route, Agents internal adapter, shared per-project mutation barrier, and coordinator revision-1 initialization | Main and explicitly inventoried branch overlays are hash verified; branch tombstones apply over main and each imported branch is seeded through checked coordinator checkpoints with `main` as parent. The source alias and branch revision identities are retained. Checked rollback restore and retryable rollback-window alias cleanup now have local coverage; deployed migration/overlay/restore/cleanup verification remains open. Tenant-shared provider connections are not modified. |

The checked-out source inventory covers identified Agents, Artifact, Spaces, Workflow and Provisioner direct `put`, CAS, prefix-copy, import, restore and attachment paths. Every matched call site is assigned to an owner and classified as canonical, feature-off compatibility, private staging, immutable projection/release, or unrelated archive. This completes the source-level inventory for this checkout; it does not prove deployed callers are all using these adapters. Keep rollout flags disabled until deployed traffic/call-graph evidence and read policy are closed. The per-workspace alarm avoids a second D1 workspace roster; authenticated `/internal/workspaces/gc` provides status for a known scope. This source behavior does not establish deployed alarm delivery, R2 binding behavior or jurisdiction placement.

### Phase 4 mutation-barrier source audit follow-up (2026-11-10)

The project-prefix writer audit confirms these owners and guards in the current source tree:

- `WorkspaceCoordinatorDO` owns canonical manifest/head commits. Script VFS, history/restore, workflow-plan/MCP patch, project session writes, and unified RepositoryDO publication use expected-revision checked coordinator routes. Migration/cutover state rejects coordinator publication while import or the atomic policy switch is active.
- Legacy CAS through `r2-cas.ts` now fails closed for `spaces/{space}/projects/{project}/workspace/` keys when the caller did not provide `withProjectWorkspaceMutation`. The production project runtime installs this callback in `NaelaoAgentDO`; it takes `lock:{space}:{project}:workspace-migration-barrier`, checks migration/policy state, and holds the lease across the mutation. This removes the helper's previous unguarded fallback for a project workspace key.
- Other direct legacy project publication/recovery paths use the same barrier: ToolSandbox publication replay, sandbox bridge publication, RepositoryDO compatibility publication/replay, chat upload/delete and explicit attachment copy, project legacy CAS routes, and subagent task/worker branch seeding and merge. Each applies per-file expected-hash/fencing checks inside the project barrier.
- SpaceDO's feature-off starter seeding only runs before new project rows are visible; unified seeding writes immutable content objects and calls checked coordinator initialization before exposing projects. Email/channel attachment bytes remain private scoped staging. Extension releases, workflow code, Git objects, reports, and archives use distinct prefixes and are not project workspace heads.

Focused local coverage passes for CAS fail-closed and scope checks plus guarded writes (**29 R2/VFS tests**), the Agents CAS/bridge/ToolSandbox set (**63 tests**), Agents `tsc --noEmit`, and RepositoryDO publication/replay (**14 tests**). This is a source and test audit only: deployed caller traffic is unavailable in this environment, so no deployed proof that every observed writer is represented or that no external/deployed caller bypasses these owners has been captured.

### Phase 4 direct-writer inventory update (2026-11-09)

The source audit includes `SCRIPTS_R2.put`, `WORKSPACE_R2.put`, CAS wrappers, prefix-based workspace writers, and the read/restore call sites that publish into project workspaces. A direct R2 put is not automatically a canonical publication: immutable coordinator content uploads, private staging, Git objects, extension releases, communication blobs, and artifact handoffs have separate prefixes and pointers. These paths remain feature-off compatibility or pre-publication object storage; they do not publish a canonical head. Ownership and remaining evidence are recorded here:

| Caller / path | Storage role and current write behavior | Owner / remaining Phase 4 work |
|---|---|---|
| Script VFS: `r2-workspace.ts`, `workspace.ts`, `file-manager.ts`, `r2-cas.ts`, skill manager, web search, distillation, artifact restore | Text/binary mutations flow through checked CAS on eligible coordinator branches. `file.history` reads bounded coordinator revision history and `file.restore` publishes historical bytes against an expected hash. MIME is preserved on copy/restore and new text writes declare `text/plain`. | Agents script-engine owner. Source call-site ownership is inventoried; verify product history/restore and MIME behavior on deployed bindings. Legacy CAS remains only behind the flag-off compatibility path and the migration mutex. |
| ToolSandbox and sandbox bridge | Coordinator immutable content/stage uploads live under `workspace-v1/`; snapshot bridge transfer objects live under `sandbox-workspace-bridge/`. Unified snapshots/checkpoints pin revision and include MIME. ToolSandbox and container write paths now accept 20 MiB files with bounded 30 MiB write requests; legacy publication remains feature-off and barrier serialized. | Agents runtime owner. Local 20 MiB staging and ToolSandbox-to-coordinator tests verify hash and manifest size through in-memory Worker/DO/R2 doubles. Verify the same transfer against deployed Worker/DO/container limits; local tests are not runtime acceptance. |
| SpaceDO project seeding and existing-project migration | Unified new-project seeding writes immutable content objects before checked `/v1/initialize`; project rows remain hidden until revision 1. Legacy project-prefix seeding is feature-off and barrier-serialized. Existing-project migration requires an explicit complete branch inventory, imports overlay content and tombstones, seeds checked branches from `main`, and retains the original revision alias. Admin rollback restore checks expected heads and publishes retained revisions through checked checkpoints under a durable barrier. | Spaces project lifecycle + Agents coordinator owners. Exercise migration, branch inventory, rollback restore, post-switch alias cleanup, and tenant-connection preservation on disposable deployed bindings. |
| NaelaoAgentDO task/worker branch setup and merge | Unified mode seeds coordinator branches and publishes accepted merges through RepositoryDO. Feature-off R2 branch copies and merges are now serialized through the project mutation barrier. | Agents orchestration owner. Local lifecycle and checked-merge coverage exists; obtain real push/subagent lifecycle acceptance and verify every task/worker caller on deployed runtime. |
| RepositoryDO | `REPOSITORY_OBJECTS` Git blobs/trees and DO refs are a projection; unified writes/reconcile/rollback publish canonical deltas through WorkspaceCoordinatorDO. Bounded `/verify-workspace`, tree/file/history read comparisons and reconcile repair report scoped hashes and counters. Local tests cover partial journal replay and conflict preservation. | Artifact owner. Run bounded deployed Git dual-read, capture scoped drift/repair evidence and repeat verification; exercise journal replay and the full push lifecycle on deployed disposable bindings. |
| Email/channel/AgentMail attachment and communication ingress | Email and channel bytes are private task-scoped `email-inbound/`, `channel-inbound/`, or communications objects, not project workspace files. Explicit attachment copy into a project destination uses expected-absent checked publication and MIME; provider-hosted AgentMail attachments remain provider reads until an explicit user-selected copy. | Agents communications + Spaces product owners. Exercise the complete attachment/session ingress and copy journey, retention/revocation, and project isolation; do not silently auto-publish inbound content. |
| Spaces extension releases, workflow bundles, communication state, private skill library, Git objects | Immutable releases, workflow code, encrypted communications, learning artifacts, and Git projection data use their own namespaces and are not canonical project workspace writes. | Owning extension/workflow/communications teams. Keep separate from project file inventory; reclassify any future path that targets `spaces/{space}/projects/{project}/workspace/`. |

Source-level inventory is complete for the checked-out tree and every matched path has an owner. The remaining direct R2 writes are the explicit feature-off CAS/branch and project-seed compatibility paths plus private staging, immutable releases, workflow code, communications, archives, Git projection and provider handoffs; none is an unowned canonical head publisher. This is not deployed caller-graph evidence. The rollout gate remains zero unowned canonical writers in deployed traffic, plus complete client migration and read/repair evidence—not zero R2 puts in unrelated namespaces.

### Per-project read cutover and clean dual-read gate (implemented locally; deployed acceptance open)

Use a persisted project-scoped policy with three states: `legacy` (serve and mutate the legacy workspace), `shadow` (continue serving legacy while collecting bounded comparisons), and `coordinator` (serve and mutate only through checked coordinator revisions). The policy is stored in WorkspaceCoordinatorDO by tenant/space/project scope and carries a monotonic generation, migration ID, rollback expiry, and last clean receipt. `UNIFIED_WORKSPACE_ENABLED` remains the emergency master gate; per-project cutover returns 423 while it is off. The coordinator rejects canonical writes outside `coordinator` mode, and the UI/MCP, Agent script runtime, legacy mutation lease, and RepositoryDO adapters consult policy or fail closed.

The `shadow` state is not sufficient by itself to authorize a switch: ordinary bounded UI or script reads cover only the paths they happen to touch. To mint a clean receipt, acquire the same project mutation barrier used by import/restore, stop every legacy writer, and compare a complete source inventory with the coordinator snapshot for `main` and every explicitly inventoried branch. Compare path sets, content SHA-256, sizes, MIME types, executable bits, and branch tombstones; count unreadable objects, skipped bytes, and truncated pages as failures. Record only scoped IDs, branch/revision, aggregate manifest hashes, hashes/path hashes, mismatch classes, and bounded counters. A pass is clean only when coverage matches the complete inventories and mismatch, read-error, omitted-path, and truncation counts are all zero. Resolve any drift by importing the selected source through checked publication with expected hashes, then repeat the complete pass.

While the mutation barrier is held, the implementation marks migration `cutover` in the DO to block coordinator writers, then atomically advances policy to `coordinator`, increments its generation, and stores the clean receipt. Receipts have one entry per main/inventoried branch and aggregate hashes for sorted path sets, content hashes, sizes, MIME, executable bits, and tombstones; they record no file bytes or raw paths. Failed passes persist bounded mismatch classes/counters and keep policy in `shadow`. The admin repair route reimports the legacy-authoritative snapshot through expected-revision checked checkpoints, records a scoped repair receipt, and requires a fresh clean pass. No dual-write occurs. Keep legacy aliases for the explicit rollback duration; retirement pages only the project workspace prefix and is retryable after a lost response. Retire only after rollback expiry and a clean receipt; deployed validation remains required.

Bounded `WORKSPACE_DUAL_READ_ENABLED` adapters remain sampling detectors; they do not replace the complete all-branch cutover receipt. Local tests exercise persisted policy, feature-flag fail-closed behavior, clean and drifted receipts, checked repair, branch tombstones, rollback-window enforcement, and retryable alias cleanup. Git drift repair and the full project migration lifecycle still need deployed receipts before acceptance.

### Phase 4 continuation record (2026-11-09)

The authenticated Spaces workflow-plan writer and MCP AST patch call `workers/agents/src/workspace/workspace-checked-publish-route.ts` for pinned, staged, expected-hash coordinator checkpoints; neither dual-writes. Script engine CAS writes/deletes use this adapter on isolated branches or authorized non-run project operations. `file.history` now exposes bounded revision metadata and `file.restore` publishes retained bytes with an expected hash. Manifest compatibility reads return branch/revision identity; workspace prebuilt bulk sync checks every content read against its enumerated branch/revision and aborts before copying if the head changes. The opt-in script adapter compares at most 20 legacy file reads per run instance (512 KiB per file, 2 MiB total), records only scoped identifiers and hashes, and skips comparisons on legacy R2 read errors. Project chat-session upload, list, and delete use checked coordinator operations behind existing session/project authorization; uploads support 20 MiB per file and preserve MIME metadata. The sandbox bridge and ToolSandbox carry MIME through private staging and checked checkpoints, with 20 MiB files and bounded 28–30 MiB request bodies. `WORKSPACE_DUAL_READ_ENABLED` runs bounded hash-only comparison for project UI reads while preserving legacy UI response behavior. All rollout flags remain false. Drift repair is operator-controlled: stop affected legacy mutations, compare scoped hashes and MIME, publish selected bytes through a checked revision, verify a clean comparison, then switch the reader. Retain migration aliases through deployed verification and rollback restore tests.

This does not close Phase 4. Source-level direct-writer ownership is complete for this checkout; deployed caller-graph confirmation, Git drift/repair and journal/push receipts, project migration/overlay/rollback/alias-cleanup verification, MIME parity, provider/email journeys, and deployed transfer limits remain open. Email/channel attachments remain private staging until an explicit checked project copy is selected. Repository Git publication, local partial journal replay/conflict recovery, subagent branch seeding/checked merges, artifact history/restore, explicit main/branch migration, checked rollback restore, and the per-project policy/receipt/repair path have local evidence. The admin per-project delete route archives before retryable cleanup under the shared mutation lease; lost-response and sibling-connection cases are mocked locally. No authenticated Cloudflare session was available. See the [current progress record](unified-platform-implementation-progress.md) for exact limits.

### Existing-project migration adapter

The follow-up implementation adds `POST /spaces/:spaceId/projects/:projectId/workspace/migrate` for authorized project administrators, plus a status endpoint and checked `POST /spaces/:spaceId/projects/:projectId/workspace/restore`. The optional `branchNames` array supplies the exact legacy branch inventory when `branches/` keys exist; migration verifies complete, non-ambiguous coverage, imports each overlay and tombstone over main, seeds coordinator branches through checked stage/checkpoint operations, and preserves `main` as their parent. Main and branch content hashes are checked before and after import. Restore requires the exact current heads, keeps a durable coordinator mutation barrier active, and republishes retained main/branch snapshots through checked sessions; partial restore retries use the same restore ID. The main tree supports 10,000 entries, 64 MiB total and 20 MiB per file; combined branch source bytes are bounded at 512 MiB. Agents serializes import and restore alongside legacy project writers through the project `ConcurrencyDO` barrier. Failed imports retain a blocking migration record for same-ID retry. Original R2 objects and tenant-level provider connections remain untouched. Post-reader-switch legacy alias cleanup and disposable deployed migration/branch/restore verification remain open. See the implementation progress record for local evidence.

History retention is also an unresolved product policy. Current GC preserves every retained revision and referenced content indefinitely. Do not add age/count pruning until product owners approve retention, legal holds, backup expiry and user-visible history behavior.

Implementation anchors include [workspace bridge](../../workers/agents/src/sandboxes/workspace-bridge.ts), [ToolSandboxDO](../../workers/agents/src/do/ToolSandboxDO.ts), [Agent37 provider](../../workers/sandboxes/src/providers/agent37.ts), [sandbox control API](../../workers/sandboxes/src/index.ts), [R2 CAS](../../workers/agents/src/script-engine/r2-cas.ts), [repository owner](../../workers/artifact/src/RepositoryDO.ts), and [erasure cleanup](../../workers/workflows/src/workflows/erasure-cleanup.ts).

### Corrected interpretation of the runtime architecture

Cloudflare Containers are present in the current codebase, but in the observed paths they back the internal `ToolSandboxDO` used for bounded execution. Agent37 is a different, external provider integration for persistent computers. The unified plan needs adapters for both where the product uses both, but must not migrate Agent37 execution onto Cloudflare Containers by assumption, nor rewrite `Dockerfile.toolsandbox` as if it were the Agent37 customer image.

## 4. Independent feasibility findings

### 4.1 Cloudflare Computer is a useful filesystem/sync reference, with a production caveat

At the pinned upstream revision, the package README marks the SQLite filesystem and primary Workspace APIs stable, while `ContainerBackend`, `workspace.push()`/`pull()`, the sync protocol, RPC, and `computerd` are experimental. The same README says a workspace shares its Durable Object storage budget (about 10 GB at that revision's stated limit) and is intended for agent-scale working trees. The documented sync uses monotonic revisions, durable cursors, bounded blocks, content-addressed 512 KiB chunks, and “which chunks are missing?” probes. This is a strong performance design to adapt.

The upstream sync protocol also explicitly converges by last-writer-wins state reconciliation in some conflicts, discards local-only descendants when node types conflict, does not preserve hardlink identity, and does not represent rename as a single wire operation. It is a replication protocol, not Naelao's checked multi-file publish transaction. Mounting it directly over the canonical workspace would violate the required staging boundary.

The upstream performance guide reports about 2x slower `npm install` on the FUSE mount than its ext4 container disk (124.7s vs 63.9s for one measured 36,675-file install), with a still-unmeasured transfer of the installed tree. The guide identifies that comparison as a Cloudflare Containers `standard-2` run. Separate local-only and native-root comparisons use an arm64 laptop/OrbStack; they must not be presented as measurements from that container. Neither setup predicts Agent37 or Naelao production performance. The guide also documents an upstream timeout/recovery incident for a large dependency-tree pull. Treat these as a warning and benchmark recipes, not performance guarantees.

**Design choice:** reuse the stable SQLite VFS API for host-side semantics if its API fits; prototype the experimental FUSE/sync adapter as a capability-labeled runtime. Keep canonical manifest publication in Naelao. Benchmark the exact template and Agent37 VM/container type before enabling it.

### 4.2 Agent37 is feasible for checked file transfer; live FUSE is unproven

Agent37's official docs describe API-managed instances, shell/exec, files APIs, custom images, authenticated instance endpoints, auto-sleep, and usage billing. The current custom-image docs state `linux/amd64` and an 8 GB image ceiling; re-check this at image-build time because the provider can change it. The current agent response endpoint documents a 2 MB request-body cap, and exec output is bounded to 512 KB per stream in the provider documentation. These limits differ by endpoint; Naelao should honor the contract for the exact operation, not infer one generic “file size” limit.

The available `Agent37Provider` uses control-plane bearer auth and the `X-Agent37-Key` data-plane header for execution. Its local implementation bounds commands, execution time, request body, and returned output. Those controls do not demonstrate that a FUSE mount can be created inside Agent37. Public API docs inspected here do not guarantee `/dev/fuse`, privileged mounts, FUSE kernel support, or a private host callback for the `computerd` RPC port. A VM instance may have a different kernel boundary, but the public sources do not establish that it grants the required FUSE device/mount permissions.

**Design choice:** checked handoff can use the existing explicit file API or bounded archive transfer without FUSE. Treat `agent37 + computerd + FUSE` as a distinct capability that remains unavailable until a real custom-image test verifies mount, reconnect, control-plane authentication, container/VM type, and cost. Do not expose live mode based solely on “exec” or “files.”

Agent37 billing makes lifecycle material: public docs describe compute metering while running and disk cost while sleeping/stopped; deletion ends active instance billing but its privacy policy describes a recovery copy retained for a window. Confirm the applicable terms/account configuration and show users that deletion and backup purge are different states. Vendor docs and policies can change; store the checked date and contract version in launch review.

### 4.3 Cloudflare storage supports atomic pointers, not an atomic R2 tree

Cloudflare documents SQLite Durable Objects as transactional, strongly consistent storage private to one object; current paid DO SQLite storage is limited to 10 GB per object. R2 is strongly consistent and supports conditional operations, but it does not make a batch of object updates one atomic revision. Therefore put immutable file/chunk bytes in R2 first, then atomically compare-and-swap the project head and publication receipt in a single workspace DO transaction. Readers fetch the manifest named by the committed head. A failed CAS leaves only unreferenced staged objects for garbage collection.

Avoid storing a complete project’s bytes or every artifact body inside one Durable Object. Use it as the project’s serialization point and metadata owner. If one project becomes too hot, batch changes per checkpoint and measure before sharding; sharding the head prematurely recreates multi-object transaction problems.

### 4.4 Retries and workflow semantics require receipts, not hope

Cloudflare Workflows says each step is individually retryable and recommends idempotent operations. Queues provide at-least-once delivery, with duplicate messages possible. DO alarms can retry. The provider call may succeed while its response is lost. Reuse Naelao’s effect journals and operation IDs; for workspace publication use an idempotency key bound to the exact sorted change set, base revision, branch, session, and generation. Never replay an execution whose command outcome is indeterminate; reconcile status first.

### 4.5 FUSE health is more than HTTP health

The pinned `computerd` README says `/health` returns once the HTTP server is up and **does not wait for FUSE readiness**. It exposes `/__computerd/info` with selected FUSE backend, mount point, port, and ignore information, plus `/__computerd/stats` and a checkpoint endpoint. The pinned ContainerBackend performs authenticated connection setup, readiness probes, runtime identity checks, and ignore-pattern comparison. Naelao should reuse those health dimensions or stronger equivalents. A green `/health` alone is not mount readiness.

## 5. Target architecture and invariants

### 5.1 Authority map

1. **Space/tenant authorization owner** confirms membership, actor role, guest isolation, project status, and allowed branch/action.
2. **Workspace coordinator DO**, keyed from an authorized tenant + space + project + jurisdiction tuple, owns canonical branch heads, revision metadata, writer lease/fence, session state, idempotency receipts, and subscriptions.
3. **R2 immutable content store** holds file and chunk bytes with tenant/project-scoped keys or content hashes scoped so hash equality cannot leak across tenants. Stage content before commit; garbage-collect unreferenced objects after a safe grace period.
4. **Runtime adapter** receives a short-lived session capability and materializes only its branch/base revision into isolated staging. It never gets the right to mutate canonical R2 keys or workspace heads directly.
5. **Publication service** validates path policy, expected hashes, base revision, policy, lease/fence, allocation generation, and payload digests. It writes the complete new manifest and then advances one canonical pointer atomically.
6. **Client adapters** for virtual tools, project UI, artifact history, Git, internal containers, Agent37, provider import/export, and extensions call the same service contract. They do not invent an alternate canonical write path.

The coordinator should be project-scoped, not tenant-global, to isolate hot projects and keep unrelated work independent. Its identifiers must be generated from verified server-side scope, never directly from caller-controlled strings. Keep tenant and space predicates in D1/index lookups even when the DO ID includes a tenant hash.

### 5.2 Workspace records

Persist compact, versioned records:

- `WorkspaceHead`: tenant/space/project/jurisdiction, branch, monotonically increasing revision, manifest hash, parent revision, timestamp, publication ID.
- `ManifestEntry`: normalized path, content digest/chunk list, byte size, executable bit and supported metadata. Do not promise unsupported POSIX details.
- `WorkspaceSession`: actor and authorization scope, requested/resolved mode, branch, base revision, runtime provider/template/digest, allocation ID/generation, expiry, capabilities, state.
- `WriterLease`: holder session/runtime, monotonic fence, expiry, state, and transition receipt.
- `PublicationReceipt`: idempotency key, base/head revisions, exact change-set hash, applied/conflicting paths, new revision or no-op, fence/generation, time and source.
- `SubscriptionCursor`: last committed revision acknowledged by a reader. Notifications are hints; reconnect reads authoritative head and missing revisions.

Record file bytes in immutable R2, not in Workflow payloads, DO value fields, metrics, or queue messages. Use bounded manifests and paginated directory views for large workspaces.

### 5.3 Publish algorithm

For each publication:

1. Authenticate the caller and rebuild scope from trusted records.
2. Confirm active project, session mode, branch, actor grant, requested operation, allocation generation, and current fencing token.
3. Validate normalized paths and exclusions; reject duplicates, absolute paths, traversal, reserved metadata directories, secrets, symlinks/hardlinks unless explicitly modeled, and unsupported file types.
4. Verify all changed file bytes/chunks against declared digests, sizes, and manifest entries. Upload immutable content first with conditional-create semantics.
5. Write the new immutable manifest object to R2 and verify its digest. In the project DO transaction, re-read the current branch head and verify base revision/expected path hashes; insert the publication receipt and advance the branch pointer to the manifest digest atomically. For conflict, advance nothing and return exact conflict paths while preserving staged content.
6. Return a stable receipt. A replay with the same key and same payload returns that receipt; same key with different payload returns `idempotency_conflict`.
7. Notify listeners only after pointer commit. Garbage collection removes unreferenced blobs after retention and recovery windows.

Do not publish one path at a time and label the batch atomic. For merge of isolated branches, compute a three-way merge against the pinned base; conflict is per path, but the resulting manifest pointer still advances as one transaction.

### 5.4 Mode transitions

Expose the mode in developer configuration and template contracts. An omitted value resolves to `checked_handoff`. Persist the requested and resolved modes on the session; do not infer mode from provider or filesystem enum. Template builders may advertise supported modes, but the runtime's recent verified capability record and current policy/budget decide admission.

**Checked session lifecycle:** admit -> pin head -> create branch/session -> runtime stages changes -> checkpoint by explicit request or configured policy -> checked publication -> terminal publication on successful completion or graceful suspend -> close/retain staging by policy. Failed, cancelled, or indeterminate execution does not silently publish; a task-specific product policy may offer review of its staged result.

**Live single-writer lifecycle:** admission verifies live mount and authenticated session capabilities before reserving/billing or selecting runtime -> acquire project branch write lease with monotonic fence -> runtime starts on latest committed revision -> writes go to isolated staging -> checkpoint publishes a revision atomically -> reader notifications follow commit -> graceful handoff blocks new writes, drains active syscalls, flushes local buffers, publishes, revokes lease, increments fence, opens next writer from new revision. Force stop, crash, expiry, and stale generation preserve recoverable staging but never grant a second writer before old authority is fenced out.

In live mode, “live” describes an active single runtime writer and prompt delivery of committed revisions; it does not mean uncommitted staging becomes readable as canonical. Display measured reader freshness and last committed revision. Do not promise two-second end-to-end propagation until measured; it can remain an internal target for checkpoint scheduling.

## 6. Runtime and capability plan

### 6.1 Capability contract

Represent capabilities as an enforced, versioned tuple rather than a provider label: `workspace.read`, `workspace.stage_write`, `workspace.publish`, `workspace.live_mount`, `exec`, `files_api`, `network.egress(policy)`, `browser`, `desktop`, `region`, file-size/tree-size limits, allocation generation, authentication transport, and readiness evidence. Capability claims expire and are tied to provider, template digest, region, runtime type, and verification timestamp.

Admission sequence: authorize user and project -> inspect requested mode and exact requirements -> verify residency and allowed egress -> check entitlements/budget -> select a configured, recently verified runtime -> reserve billing -> allocate/start -> confirm actual generation/image and workspace readiness -> issue capability. If any capability is missing, try another authorized provider before returning `capability_unavailable` with required and available capabilities. Do not allocate billable resources before cheap policy and budget denials.

### 6.2 Agent37 path

- Keep Agent37 as the external persistent runtime lane the product intends to support.
- Use its custom image/template API to publish a Naelao-specific image only after source, image, resource shape, region, lifecycle, and actual billing receipts are verified.
- First ship checked handoff over documented file or exec APIs: pin a base revision; transfer a bounded changed-file set; run; capture a changed-file set; publish only through Naelao CAS. The existing full snapshot bridge can be a compatibility fallback during migration but must not define the final performance target.
- Test files API path behavior and instance key scope; Agent37 documentation and examples show file operations on instance disk. Treat any key that can address arbitrary instance paths as a provider credential boundary; restrict Naelao-side paths before request construction and never expose provider root keys to guest code.
- FUSE/`computerd` is a separate gated experiment. Test selected Agent37 container and VM types for `/dev/fuse`, `mount(2)` behavior, signal handling, custom image digest, private daemon port access, network isolation, sleeping/waking, recovery, and remote mount readiness. Test with no public port. If any element is unsupported or not contractually stable, capability remains false; checked file-transfer mode can still work.
- Observe Agent37 exec/output/request/time limits from official API docs for each operation. Existing adapter caps are Naelao's additional bounds, not provider guarantees. Map timeout to `indeterminate` when command execution may continue.
- Separate compute, disk retention, managed model spend, integration spend, and Naelao transfer/egress charges. Sleeping does not mean storage is free; deleting an instance does not mean provider backup copies are already purged.

### 6.3 Internal Cloudflare Container path

- Keep current `ToolSandboxDO` as a bounded internal execution tier.
- Integrate the workspace service as its staging source/sink. Do not materialize every project file around every execution; fetch only authorized paths and publish only selected changes.
- Any computerd/FUSE prototype here must prove the platform's `/dev/fuse` mount permissions in deployed containers, process cleanup, file flush on interruption, and behavior under container replacement. The existing Dockerfile's root supervisor and UID 10001 guest separation must remain intact.
- The internal runtime may have a different capability set from Agent37. Do not promise interactive browser, long-running persistence, or external provider features from its presence.

### 6.4 Cloudflare Computer and daemon supply chain

- Pin exact `@cloudflare/computer@0.10.0` if the stable Workspace/SQLite VFS API is adopted; update lockfile and package provenance in the same change.
- Build `computerd` from commit `bb0a5db4b7e8c8a79625d63e0e272602f909640e` using its matching build scripts and binary distribution Dockerfile. Record source commit, package lock/build environment, architecture, OCI digest, and CI artifact digest. Do not combine daemon from another version.
- Keep `COMPUTERD_DB` outside the FUSE mount; otherwise it can recursively observe its own store. Choose persistent-on-disk versus in-memory based on runtime lifecycle: upstream says in-memory restarts require a complete rebaseline; persistent stores require version compatibility and durable storage semantics.
- Compare ignore patterns on both ends. Secrets, `.env*`, Naelao control paths, caches, package installs, generated assets, and private provider data must never leak through sync. Ignored data is runtime-local and may be lost on restart; user-facing tools must not call it durable workspace state.
- `/health` is insufficient. Probe auth rejection, `/__computerd/info`, exact mountpoint, FUSE operation tests, runtime ID, allocation generation, ignore policy, then incremental push/pull. A failed mount check denies the capability.

## 7. Client unification and migration

### 7.1 Route every project workspace client through the service

Inventory and adapt:

- script-engine/prebuilt virtual filesystem tools and `workspace.copy/move/list`;
- project file read/write/list/delete APIs and UI editor;
- AgentTaskWorkflow, ScriptRunWorkflow, subagents and blackboard publication;
- ToolSandboxDO workspace commands;
- Agent37 and other provider import/export;
- RepositoryDO Git clone/commit/import/export;
- artifacts, previews, immutable snapshots, and project history;
- extension/publisher build inputs and run outputs.

Each read response includes branch + revision or a cursor tied to them. Each write carries `baseRevision`, expected hashes, idempotency key, actor/run/session, and allocation generation. Existing public contracts get adapters, but new writes do not directly mutate canonical R2 keys. File imports from external machines remain explicit, scoped, size-limited transfers with a receipt; do not mount account home directories or silently sync arbitrary remote filesystems.

### 7.2 Retain specialized workspaces where isolation is intentional

Do not merge extension development, private model workspaces, task scratchpads, or per-user runtime disks into a single shared directory just to unify the API. They can use the same service protocol with different resource IDs, retention, permissions, and publication policy. Shared APIs do not imply shared content or scope.

### 7.3 Data migration

1. Inventory current R2 prefixes and D1 ownership rows for project branches, artifacts, repository commits, sandbox snapshots, pending publications, and aliases.
2. Establish a mutation barrier per project; keep guest access read-only or paused for that migration window.
3. Import current canonical paths into a manifest, validate hashes and byte sizes, and retain a compatibility alias for old R2 keys.
4. Compare every path/hash against the source index and test reads through the new service.
5. Switch reads to the manifest pointer; route all writes to staging/publication.
6. Preserve old data through a rollback interval. After verification, remove compatibility copies through retryable erasure, with per-surface receipts.
7. Make migration resumable by project ID and source cursor. A retry must detect already imported immutable content and never overwrite a newer canonical revision.

## 8. Cross-platform reliability, security, privacy, and cost

### 8.1 Reuse current durable effects

Use an immutable `RunEnvelope` reference spanning tenant/space/project, actor/effective principal, root run/task and attempt IDs, policy version, workspace session/branch/base revision, runtime/allocation generation, model route, budget reservation, deadline, and trace ID. Put hashes/pointers in Workflow state, not prompts or file contents. Keep `prepared -> dispatching -> committed | rejected | uncertain -> reconciled` for external effects. A Workflow retry is not permission to repeat a non-idempotent external command.

### 8.2 Authorization, guest isolation, and egress

- Preserve owner-side authorization at every read and write. A signed session token is bound to tenant, project, branch, actor, mode, exact runtime allocation ID/generation, capabilities, expiry, and revocation epoch.
- Recheck active tenant/project status before publication and provider dispatch. Fencing is verified by the canonical workspace owner, not only the runtime or adapter.
- Never pass provider root keys or decrypted credentials into workspace files, shell history, Workflow inputs, artifact contents, metrics, or guest environment. Use credential proxy aliases and short-lived scoped tokens.
- Keep egress policy separate from filesystem access. Host allowlists and SSRF checks are authorization controls, not proof that payload contents are safe. Recheck redirects and test DNS changes at connect time; use a controlled egress proxy/pinning where runtime behavior permits.
- Treat files, retrieved snippets, tool outputs, and model-generated workspace diffs as untrusted data. Prompt injection must not grant tools or broaden scope.

### 8.3 Data retention and deletion

Extend current erasure workflows with a per-project/tenant deletion manifest covering DO revision metadata, R2 blobs/manifests, active and expired staging, artifact history, provider runtime disks, aliases, audit rows, logs, external connection records, and replicas. Revoke sessions, writer leases, credentials, and subscriptions first. Record `deleted`, `retained_by_policy`, `provider_pending`, or `failed` separately; verify provider backup purge according to the applicable contract.

Cloudflare's current DO SQLite PITR can restore up to 30 days of history. If a DO is restored, an erasure tombstone held outside the restored state must be replayed before reads or runtime admission. R2 lifecycle rules are asynchronous expiration controls, not proof of immediate purge. Retain financial records only under explicit policy and remove identifying information where required.

### 8.4 Observability without content capture

Record workspace open/read/checkpoint/publish/handoff/conflict/recovery events using bounded dimensions. Measure checkpoint lag/duration, bytes/files/chunks transferred, reused/missing chunks, branch merge results, stale fence and generation rejection, reader freshness, staging and canonical storage, runtime startup/wake, idle billing, reservation/settlement variance, FUSE health and recovery attempts. Do not log file contents, prompts, secret aliases that reveal sensitive provider setup, credentials, signed URLs, or raw external response bodies.

Keep high-cardinality per-run details in scoped receipts; aggregate/sanitize metrics. Add synthetic secret canaries through error/log/trace paths and test that telemetry does not contain them.

### 8.5 Performance and economic measurement

Benchmark the current implementation before replacing it: file-count distribution, bytes, largest file, snapshot time, R2 requests, D1 writes, CAS calls, branch conflicts, cold/warm runtime times, total billed compute+disk, and cost per successful run. Compare:

1. current full `snapshot_diff` bridge;
2. manifest and file-hash diff;
3. content-addressed chunk diff with upstream's 512 KiB baseline;
4. FUSE with normal dependency writes;
5. FUSE with dependency/cache paths ignored or native-local.

Use actual Agent37 and internal Cloudflare runtime measurements. Count transfer time and post-command sync; the upstream filesystem microbench alone excludes full-tree upload cost. Keep caches per tenant/template with immutable digest and strict quota. Do not reuse tenant-generated `node_modules` or private credentials across tenants.

For Agent37, model sleeping disk costs and backup retention in actual cost. For Cloudflare, check DO object storage size and CPU ceilings, R2 operations/bytes, Workers/Workflow cost, and retry amplification. Avoid cost claims based on vendor minimum monthly examples or a single warm benchmark.

### 8.6 Orchestration, shared evidence, and status

Carry one versioned RunEnvelope reference through task admission, model route, subagents, runtime allocation, workspace session, external actions, artifacts, and billing settlement. Each owner returns a small typed receipt; keep detailed source artifacts by hash/reference rather than embedding them in Workflow state. The envelope is a correlation and scope consistency record, not a bearer grant: each owner still checks its own authorization.

Keep the task DAG and artifacts authoritative in their existing owners. Treat the task blackboard as a scoped evidence/event index with source, branch/revision, trust label, sequence, and expiry. Workers fetch relevant evidence by bounded query rather than broadcasting the whole board. Treat retrieved content as untrusted; test cross-project isolation and compare success/cost with direct handoff before claiming multi-agent efficiency.

Use a normalized event view for queued, approval-needed, allocating, running, checkpointing, conflicted, complete, failed, uncertain/reconciling, and cancelled. Events carry a monotonically increasing cursor. SSE/WebSocket delivery is a hint; reconnect fetches the authoritative snapshot and missing event range. Keep workspace revision, publication conflicts, capability selected, reader freshness, and settlement state visible where those affect user expectations. Do not mark a run complete until its required publication and billing policy are resolved; if accounting reconciliation is pending, show that separately.

For context and model cost, use evidence handles and bounded summaries that name source/revision/age/authorization scope. Let an agent fetch exact ranges when needed instead of automatically including every project memory, transcript, board item, or tool output. Evaluate quality, unsupported claims, leakage, tokens, latency, and total cost together; token savings alone do not establish an improvement.

### 8.7 Product trust and operational governance

Before a run, make provider/runtime, region/residency, requested mode, workspace base revision, data classes available to it, egress scope, credential aliases, and external retention expectations understandable to the project owner. During execution, expose approvals and external-action receipts; after deletion, distinguish active-store deletion from provider backup expiry and legally retained billing records. Provide operator access by scope and expiry with reason and audit; separate metadata support from content access. This should compose with existing permissions and credential mediation rather than introduce a second consent authority.

### 8.8 Execution surfaces, mounts, and output handling

Preserve the existing execution ladder as host policy: select the least costly authorized tier that satisfies the actual operation, while preserving each tier's distinct filesystem, network, package, timeout, and interruption behavior. Provide bounded structured `read`, `list`, `find`, `search`, and edit operations for ordinary work; require shell/native execution only when its capabilities are needed. A common interface must not claim full shell or POSIX parity across runtimes.

Prototype version-pinned, read-only mounts for extension bundles, templates, and approved reference data, with a separate session-writable layer. Validate mount roots and reject overlaps with control, secret, and writable project paths. Compare lazy loading with eager materialization for startup time and read latency. Cache bundles only by immutable digest plus build and policy provenance; revoke cached releases when trust changes.

Long commands should stream bounded output to a scoped, expiring artifact spool, returning a small tail, byte counts, truncation state, and an authorized cursor. Classify logs as potentially sensitive customer data and apply access and retention policy. A lost command response remains indeterminate until reconciled. Make Git commits an artifact/provenance projection linked to the canonical manifest, with checked merge and no second workspace authority.

### 8.9 Durable delivery and release provenance

Inventory each business-state-plus-queue or provider dual write. Where the state store supports it, write an outbox intent atomically with the state transition; dispatch at least once and deduplicate in the consumer's authoritative transaction. Validate aggregate versions because queue order is not guaranteed. Record dead-letter items with an owner, retry policy, and alert. For external providers without idempotency or lookup support, retain an uncertain outcome for reconciliation.

Extend existing extension publisher and host signatures into a verifiable chain: source and publisher key, lockfile, build recipe and builder, compiled artifact digest, image digest, admission decision, and deployed release. Verify at execution, not only CI. Plan key rotation, revocation, affected-session identification, and rollback. Protect signing keys outside tenant runtimes; a signed build attests provenance, not safety.

### 8.10 Coverage audit of the last two commits

| Research file | Consolidated treatment and remaining decision |
|---|---|
| `cloudflare-computer-design-analysis.md` | Workspace/sync, execution tiers, host capabilities, mounts, output spooling, Git, provenance, and benchmark caveats are covered in §§4–8. Mount and output optimizations remain experiments with measured acceptance. |
| `workspace-and-runtime-enhancement-feasibility.md` | Atomic head, staging, modes, Agent37 capability checks, migration, recovery, cost, and limits are covered in §§4–7 and 9–10. Provider FUSE support and workload budgets remain open until live evidence exists. |
| `agent-platform-wide-enhancement-proposals.md` | Run envelope, effect receipts, outbox, blackboard, budget settlement, status, context handles, and provider economics are covered in §§8–10. Measure each bounded vertical slice before expanding it. |
| `trust-security-data-lifecycle-proposals.md` | Scope checks, egress, deletion/restore, signing, logging, support access, and adversarial validation are covered in §§8–10. Contractual retention and deployed controls require separate verification. |

The previous files are research inputs and topic inventories, not evidence that an implementation or test passed. Attach fresh test and deployment evidence to the exact candidate commit, including previously recorded browser and integration failures, before a release decision.

## 9. Implementation sequence and go/no-go gates

### Phase 0 — Release and source baseline

- Record exact branch/commit, current deployed Worker versions, D1 migrations, R2 buckets/prefixes, DO classes, queue/workflow bindings, current provider settings, billing profile, and customer-visible modes.
- Reconcile the requirements record and trace matrix with the two modes, default, one live writer, staging-only provider sync, strict capability selection, and distinction between internal Cloudflare tool sandbox and external Agent37.
- Add a current-state adapter inventory and migration/rollback plan. Identify all direct canonical R2 write paths and remove them from the “new architecture” list only after a call-path audit proves migration.
- **Gate:** no rollout until every canonical write path, retention surface, provider region, and billing owner is known.

### Phase 1 — Workspace contract and checked publication core

- Define typed request/receipt schemas and an authorization boundary for open/read/stage/checkpoint/subscribe/handoff/close.
- Implement project-scoped coordinator metadata and immutable manifest/CAS publication. Advance the head and receipt in one workspace DO transaction after immutable R2 upload; D1 is an independently reconciled projection, not part of that transaction.
- Record each in-flight canonical content/manifest R2 key in a bounded Durable Object upload intent before starting the external PUT. Keep the intent until the pointer transaction commits or the failed operation is resolved; GC marks active intent objects as roots and only removes intents older than a 24-hour stale-operation bound.
- Self-schedule bounded first-run content backfill and weekly content mark/sweep plus daily staging/metadata maintenance on each initialized coordinator. Persist status and cursors; fail closed on missing or stalled R2 cursors and retry with observable error state.
- Add branch creation, idempotency, expected hashes, allocation generation, fencing, conflict preservation, and operation receipts.
- Build an adapter over current R2/CAS and artifact repository. Prove readers cannot observe a partial multi-file publication.
- **Gate:** race/crash/duplicate/fence tests pass; zero canonical mutation paths bypass the service in a bounded pilot.

### Phase 2 — First vertical slice on internal ToolSandboxDO

- Start an internal execution on a pinned branch/revision, stage only needed files, run a representative bounded script, collect staged changes, and publish through the new service.
- Keep container process controls, UID isolation, network restrictions, execution timeout, billing reservation and cleanup.
- Measure changed bytes, R2 operations, execution time, publication time, and staged retention against the previous path.
- **Gate:** real container test verifies read, binary write, rename/delete, timeout, crash, cancellation, and no guest reachability to control paths. Internal Docker test is not evidence of Agent37 or FUSE readiness.

### Phase 3 — Agent37 checked-handoff acceptance

- Verify a dedicated Agent37 API connection and template with scoped credentials. Test create/start/exec/files/read/write/list/stop/delete, allocation generation, status reconciliation, resource cap, region, auto-sleep, and provider billing receipts.
- Exercise wrong tenant, revoked key, sleeping wake, timeout after dispatch, malformed output, oversized file, corrupted digest, and delete during pending job.
- Use a small file-based handoff first. Only then evaluate the custom image and computerd mount.
- **Gate:** all required production acceptance passes on the real account; otherwise keep provider unavailable. Do not treat mocked adapter tests or API health alone as acceptance.

### Phase 4 — Client migration and dual-read verification

- Port virtual tools, UI, artifacts, Git/repository, subagents, and provider import/export one at a time.
- During transition, compare legacy path values to manifest reads and report hash drift; avoid dual writes.
- Migrate projects with mutation barriers and rollback aliases. Keep tenant provider connections shared at the tenant scope when sibling projects depend on them.
- **Gate:** every client reads revision identity and submits expected hashes; no unowned direct R2 writer remains.

### Phase 5 — Live single-writer pilot

- Enable only for runtime/template/region combinations with proven mount, auth, FUSE operations, incremental sync, real flush, reconnect generation check, and accounting.
- Test lease expiry while process is alive, old runtime mutation after handoff, stale callback, missed notification, disconnect/reconnect, sleep, crash, and graceful shutdown. The coordinator fences first; runtime kill is defense in depth.
- Label other runtimes/readers with committed revision/freshness. If the live writer loses capability, block further writes and preserve staging; require explicit checked recovery/handoff.
- **Gate:** exactly one writer accepted through repeated multi-runtime races and kill/reconnect tests; no silent fallback to file-copy mode.

### Phase 6 — Migration cleanup, privacy and production operations

- Finish tombstone-aware erasure, provider delete tracking, retention policy, restore replay, storage garbage collection, and bounded observability.
- Add image provenance/SBOM and pin exact daemon source/package/build digest if FUSE is enabled.
- Establish SLOs from actual latency and freshness data; alert on pending publications, stale lease, reconciliation age, disk quota, DO size/CPU, pending erasure, and billing variance.
- **Gate:** disaster recovery, restore + erasure tombstone replay, load, cost, and operational playbooks pass with the deployed provider and template revisions.

### Rollout policy

Feature flags are workspace/project scoped with audit history. Checked mode launches first. Live mode is separately gated by runtime capability and explicit authorization. Turning off admission does not change an active session's stored mode or delete its staging data. Disable new sessions first; drain or recover active sessions explicitly.

## 10. Validation matrix

| Category | Required evidence |
|---|---|
| Authorization/isolation | Tenant, space, project, branch, guest, extension, and provider credential mismatch tests; revoked access after admission; cross-project provider connection remains scoped as intended. |
| Manifest publication | Atomic visibility under concurrent readers; same idempotency key replay; key reuse with changed input; R2 object exists but pointer CAS fails; DO crash before/after pointer update; partial per-file legacy publication migration. |
| Checked branches | Parallel agents see their pinned base only; disjoint merge succeeds; same-path conflict preserves both branches; successful task publishes only eligible changes. |
| Live lease | Exactly one writer; monotonic fence after expiry; stale callback/generation rejects; handoff drains outstanding calls; readers only observe committed head; notification loss repaired by cursor fetch. |
| Filesystem | Binary files, large files, nested directories, symlink policy, rename, deletion, executable bit, ignored paths, flush/release, mount readiness, daemon restart, disk-full and corrupted chunk. |
| Runtime/provider | Actual Agent37 lifecycle, API/file limits, region, image digest, idle billing, sleep/wake, timeout ambiguity, cancellation, destroy, data recovery and generation checks. Keep mocks distinct from live evidence. |
| External side effects | Provider timeout-after-commit, idempotency, receipts, no cross-provider replay when uncertain, authorization re-check after suspension. |
| Migration/erasure | Retry at every batch boundary; old paths not rewritten; sibling project connections survive; delete revokes sessions; tombstone applied after PITR/restore; provider backup retention accurately represented. |
| Cost/performance | Before/after p50/p95 startup, file transfer, checkpoint duration, bytes and calls, total storage, running and sleeping cost, retries and cost/successful job. |

## 11. Risks and explicit non-goals

- **Experimental upstream coupling:** exact version pins prevent accidental drift, not experimental status. Keep a local adapter contract, integration tests, and kill switch; avoid making experimental sync an unreviewed canonical dependency.
- **FUSE tradeoffs:** mounted files may be slow for package installs and metadata-heavy trees; ignored paths improve speed but are local-only and can disappear on restart. Surface this as runtime behavior.
- **Single-writer contention:** a project DO serializes canonical commits by design. Reduce pressure through chunk upload outside the DO and batch commit metadata, not by making the canonical head multi-writer.
- **Unbounded project size:** enforce project byte/file/quota limits and archive old immutable content. DOs have finite per-object storage; content-addressed R2 doesn't remove per-object, list, bandwidth, or garbage-collection costs.
- **Provider fact drift:** Agent37 capabilities, execution timeouts, privacy terms, price, and API limits can change. Recheck official docs and account contracts in each production release.
- **No exactly-once external actions:** local idempotency plus provider receipts only reduce duplicate effects; any unsupported provider outcome remains uncertain and must be reconciled.
- **Not in scope:** making all customer files live-mounted into every runtime; sharing task scratchpads by default; persisting dependency directories in canonical history; using a Cloudflare Container as an undisclosed Agent37 substitute; enabling live mode on an unverified provider; or treating every prompt/tool result as telemetry.

## 12. Primary sources checked

### Upstream Cloudflare Computer at the pinned source revision

- [`@cloudflare/computer@0.10.0` package status, limitations, and API map](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computer/README.md)
- [Workspace construction, backend registration, serialization, push/pull, and reconnect code](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/packages/computer/src/workspace.ts)
- [Backend interfaces](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/packages/computer/src/backend.ts)
- [Container backend connection and health behavior](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/packages/computer/src/backends/container/container-backend.ts)
- [Container host API to adapt, not blindly copy](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/packages/computer/src/backends/container/container-host.ts)
- [Documented sync protocol, ordering, resume, conflict, and chunk behavior](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/docs/02_sync_protocol.md)
- [Upstream performance measurements and caveats](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/docs/19_performance.md)
- [`computerd` API, auth, FUSE readiness, disk state, and checkpoint behavior](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/packages/computerd/README.md)
- [Pinned binary distribution Dockerfile](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/packages/computer-computerd-linux-x64/Dockerfile)

### Current Cloudflare platform documentation

- Durable Objects [SQLite storage and 30-day PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
- Durable Objects [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) document one alarm per object, at-least-once invocation, and automatic retries when the handler throws (up to six retries with exponential backoff). The new handler records a bounded error and sets its own one-minute retry alarm; local tests do not reproduce Cloudflare's alarm delivery/retry runtime.
- R2 [Workers API list options](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions) specify opaque continuation cursors and require `truncated` (not object count) to determine whether more results exist. The GC stores separate R2 and DO-storage continuation cursors. Its test bucket is an in-memory mock and its cursor ordering is not evidence of deployed cursor behavior.
- Durable Objects [rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) describe request interleaving at awaited external operations. The implementation's publication tests use a serialized in-memory transaction mock; they do not prove Cloudflare transaction rollback, request interleaving, or R2/DO race behavior in deployment.
- R2 [consistency model](https://developers.cloudflare.com/r2/reference/consistency/), [Workers API conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), and [lifecycle expiration](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).
- Workflows [step retry/idempotency rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) and [limits](https://developers.cloudflare.com/workflows/reference/limits/).
- Queues [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) and [delivery/ordering behavior](https://developers.cloudflare.com/queues/reference/how-queues-works/).
- Cloudflare Containers [lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/), [limits](https://developers.cloudflare.com/containers/platform/limits/), and [pricing](https://developers.cloudflare.com/containers/platform/pricing/). These apply to Naelao's internal Container lane, not automatically to Agent37.

### Agent37 and agent security sources

- Agent37 [Cloud API overview](https://www.agent37.com/cloud), [API documentation index](https://www.agent37.com/docs), [custom image build docs](https://www.agent37.com/docs/agents-api/custom-image), [agent response API](https://www.agent37.com/docs/agents-api/chat), [exec API](https://www.agent37.com/docs/agents-api/exec), [file API](https://www.agent37.com/docs/agents-api/files), [privacy policy](https://www.agent37.com/privacy), [terms](https://www.agent37.com/terms), and [DPA](https://www.agent37.com/dpa). Policy, pricing, limits and retention statements are provider claims and should be validated against the applicable account and contract.
- OWASP GenAI Security Project [Top 10](https://genai.owasp.org/llm-top-10/) for prompt injection, sensitive information disclosure, excessive agency, supply chain, and unbounded consumption risk classes.

## 13. Independent evidence and design corrections — 2026-11-07

This pass checked the source at `cd01638cb18d3186a2b9c17988f606f3c2bc7064`, ran the existing focused tests, and rechecked provider and platform documentation. Evidence grades: **local mock** proves behavior only under the test doubles; **documented** describes a vendor contract; **unverified** requires a deployed experiment. None establishes end-to-end production readiness.

| Claim or decision | Evidence and limits | Required action |
|---|---|---|
| Existing workspace bridge, locking and internal sandbox | Direct Vitest invocation passed 44 tests: workspace bridge (1), ConcurrencyDO (21), ToolSandboxDO (22). The bridge test uses fake D1, R2 and DO; it covers one-file snapshot/stage/publish/replay, not atomic multi-file visibility, real contention, or provider recovery. | Add real multi-file conflict, crash and concurrent-reader journeys against actual Cloudflare bindings before claiming atomic revisions. |
| Agent37 adapter behavior | Three adapter tests passed with mocked `fetch`, including a timeout classified as indeterminate. They do not allocate or execute on Agent37. | Run the provider acceptance matrix against a disposable authorized account and record template digest, runtime type, region and cost. |
| Test environment | The repository declares Vitest `4.1.0` and pnpm `9.12.0`; the available direct binary reported Vitest `2.1.9`, and system pnpm `11.25.0` stopped before running because it wanted to reinstall modules in a noninteractive shell. The direct test results are useful local evidence, not the required pinned-toolchain result. | Repeat on a clean install with the declared toolchain and record exact versions and commit. No dependency reinstall was forced here. |
| Provider truncation | The Agent37 adapter bounds returned strings but does not propagate the upstream `truncated` boolean. Agent37 documents that it can cut the middle of each 512 KB stream and set this flag. A provider-truncated response can therefore be reported as not truncated when its returned strings are below Naelao's local limit. See [adapter](../../workers/sandboxes/src/providers/agent37.ts) and [Agent37 exec docs](https://www.agent37.com/docs/agents-api/exec). | Preserve upstream truncation alongside local truncation; add a regression test and validate actual output bytes/encoding. This is a source finding, not a deployed incident. |
| Create deduplication | The adapter's allocation test checks that the operation ID is included in instance metadata and explicitly asserts no idempotency header. That establishes correlation in a mock, not provider-enforced deduplication. | Before retrying an ambiguous create, establish supported provider lookup/idempotency semantics for the account and reconcile by stable operation identity; otherwise keep outcome uncertain and prevent duplicate allocation. |
| Named exec deduplication | Agent37 documents that the same `name` and identical command are deduplicated while running and for five minutes after completion; a changed command with the same name is rejected in that window. Timeout does not stop the process. [Exec docs](https://www.agent37.com/docs/agents-api/exec) | Bind a collision-resistant name to exact input and generation, record the provider's time window, and test it on the actual endpoint. Do not assume deduplication after the window or across allocation replacement; reconcile uncertain execution instead of blind replay. |
| Atomic pointer publication | Cloudflare documents that DO requests may interleave across external `await`s. R2 conditional writes are atomic per object, but an earlier timed-out PUT can still commit after a later negative read. [DO concurrency rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) | Upload immutable objects first, retain an upload-intent record through ambiguity, then revalidate head, fence, lease, generation and idempotency inside one synchronous DO transaction. Never assume a negative R2 read proves a timed-out write failed. GC must protect in-flight and unresolved uploads as well as referenced revisions. |
| Residency | Putting a jurisdiction string into an object ID does not itself restrict execution or storage placement. Cloudflare documents jurisdiction-restricted DO namespaces separately from location hints. [DO data location](https://developers.cloudflare.com/durable-objects/reference/data-location/) | Use the appropriate jurisdiction-restricted namespace and verify R2, D1, queue, telemetry, Agent37 region and subprocessors individually. A location hint or one regional component is not an end-to-end residency guarantee. |
| Supply-chain provenance | SLSA's verification guidance requires checking that the attestation subject matches the artifact digest and evaluating the builder and build inputs against policy. [SLSA artifact verification](https://slsa.dev/spec/v1.2/verifying-artifacts) | Verify at admission and retain the signed attestation; test altered artifacts, untrusted builders, revoked keys and rollback. |

### Further experiments and unresolved design constraints

1. **Concurrent commits:** inject a second commit between R2 manifest upload and the DO transaction. Only one matching head/fence may commit. Repeat with duplicate idempotency keys, lease expiry, DO eviction, and response loss.
2. **Garbage collection:** race staged uploads, timed-out writes, migration and deletion against mark/sweep. Retain objects referenced by committed revisions, active sessions, pending or indeterminate uploads and retention holds; use a grace period, then recheck before deletion. This is a proposed protocol requiring implementation and fault injection.
3. **Filesystem semantics:** compare native Agent37 disk, file API copy and experimental FUSE on binary/large files, open handles across rename/delete, mmap, fsync/close, symlinks, hardlinks and crash recovery. Specify unsupported behaviors explicitly. Upstream sync's cursor is a resume point, not a point-in-time snapshot; freeze or drain writers before deriving a checkpoint manifest. [Pinned sync protocol](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/docs/02_sync_protocol.md)
4. **Lease safety:** an expired lease does not stop an old process from writing its local staging copy. Reject its canonical publication using the coordinator's current fence and allocation generation; only grant a successor according to the checked handoff/recovery policy. Test stale processes, delayed callbacks and network partitions.
5. **Erasure and shared chunks:** tenant-scoped deduplication complicates deletion when multiple revisions reference a chunk. Track references and retention holds; do not delete a chunk still referenced by a surviving project or treat a removed reference as physical purge. Include external backups and cached/presigned delivery in the deletion model.
6. **Provider capability is evidence, not configuration:** prove FUSE device and mount permissions, authenticated port reachability, wake/restart behavior and flush under the selected Agent37 instance type. Public API file/exec support does not establish these properties.
7. **Performance:** measure current full snapshot versus manifest/file diff and chunk diff on identical real workloads, including hashing, R2 requests, cold/warm startup, post-command sync, idle compute and disk. Establish acceptance thresholds before implementing an optimization; no cost or speed improvement is established by these local unit tests.

## 14. Phase 1 continuation — 2026-11-08

The branch now adds `upload-intent:<id>` metadata before coordinator-owned immutable content and manifest PUTs. The DO transaction removes the intent atomically with pointer/receipt publication; when GC scans roots, it marks valid in-scope content and manifest keys from non-stale intents. GC fails closed on malformed intents and deletes only intents older than 24 hours. A deterministic mock race now stores a content object, holds the PUT response, completes a GC sweep, and then resumes the pointer transaction; the object remains readable after publication. Another test verifies repeated continuation cursors fail closed and enter the alarm retry/status path.

Fresh local evidence on `Mcbt5s-Backup-2` after the scheduler commit: `WorkspaceCoordinatorDO.test.ts` and `ToolSandboxDO.test.ts` passed together (**44 tests**) and the Agents typecheck passed. Test R2 cursors are deliberately opaque to exercise cursor forwarding, but the in-memory R2 and DO transaction mocks do not establish Cloudflare runtime semantics. No Miniflare or deployed test was run; GC/erasure acceptance, jurisdiction, alarm delivery, and real transaction interleaving remain deployment gates.

Follow-up Phase 1 evidence: the coordinator suite now also covers a PUT that the mock service commits before the client observes a simulated timeout, then successfully retries the same publication after GC. An erased-scope alarm clears without trying to resume maintenance. A repeatable local Wrangler 4.158.0 smoke harness (`workers/agents/workspace-runtime-smoke/`) ran the real `WorkspaceCoordinatorDO` on SQLite-backed Durable Objects and local R2: maintenance alarm completion, concurrent checkpoint CAS (one success and one conflict), committed content readback, opaque continuation-cursor traversal, bounded content GC and scoped erasure all passed. This is local runtime evidence, distinct from the in-memory unit mocks and from deployed Cloudflare evidence. It does not validate production bindings, retry delivery under platform failure, jurisdiction placement, or regional/account behavior.

The Phase 1 path inventory below was expanded to enumerate the identified read/write callers in Agents script tools and orchestration, ToolSandbox, the snapshot bridge, Artifact RepositoryDO, Spaces project file/workflow routes and project seeding. Legacy paths remain active. Revision history is still unpruned pending an explicit product retention policy; these are outstanding acceptance gates, not claims of completion.

## Appendix A. Proposed interface shape

These are illustrative operation names, not a frozen public API.

```text
workspace.open({ scope, branch?, mode?, runtimeRequest, idempotencyKey })
workspace.head({ scope, branch })
workspace.read({ session, revision?, paths?, cursor? })
workspace.stage({ session, baseRevision, changes[], chunks[] })
workspace.checkpoint({ session, baseRevision, changeSetHash, idempotencyKey })
workspace.subscribe({ scope, branch, afterRevision })
workspace.handoff({ session, targetRuntime?, idempotencyKey })
workspace.close({ session, disposition })
```

Every operation returns a typed receipt with resolved mode, scope identity, branch/revision, allocation generation, capability evidence, and stable error code. No request contains a caller-selected R2 object key. Content is addressed only after the host verifies the digest and authorizes its parent manifest.

## Appendix B. Decision gates for a production release

Do not call this complete or production-ready until all of the following are true:

1. Canonical workspace state has one authority and one atomic revision-head publication path used by all migrated clients.
2. Checked mode is default and branch-isolated; conflicts preserve stage and never partially advance canonical state.
3. Live mode is enabled only on a runtime with demonstrated single-writer fencing, actual FUSE/mount readiness, flush, reconnect, identity, generation, and billing tests.
4. Agent37 is explicitly enabled only after its real instance/template/account passes acceptance; otherwise its provider remains unavailable.
5. Package, daemon source, build provenance, template image digest, and deployed digest match exactly.
6. Migration and deletion receipts are verifiable; recovery cannot resurrect erased content without replaying tombstones.
7. Costs and freshness are measured from actual provider/runtime journeys, not mocked adapters or vendor examples.
