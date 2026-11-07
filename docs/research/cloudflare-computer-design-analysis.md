# Cloudflare Computer: design analysis for Naelao

**Purpose:** document the engineering ideas in Cloudflare Computer that may improve Naelao's workspace performance, cost, and reliability, and propose original Naelao designs. This is an analysis, not a proposal to copy its implementation. Upstream references below are pinned to commit [`bb0a5db4b7e8c8a79625d63e0e272602f909640e`](https://github.com/cloudflare/computer/tree/bb0a5db4b7e8c8a79625d63e0e272602f909640e), associated with the published `@cloudflare/computer@0.10.0` package. Claims about observed Naelao behavior refer to checkout `3737c841` and its recorded evidence, not live production measurements.

## Executive view

Cloudflare Computer's strongest contribution is a coherent filesystem protocol: a durable host-side content store, a local filesystem view for ordinary programs, and incremental synchronization with explicit recovery and observability. The performance idea is to move bytes only when their content changes and let the guest use familiar filesystem operations. The reliability idea is to make synchronization state and runtime identity part of the protocol instead of treating a container disk as the source of truth.

Naelao already has pieces that address the same problems: project/branch-scoped R2 workspaces, a snapshot/diff bridge, immutable blobs, SHA-256 checks, idempotent publication journals, ConcurrencyDO fences, Agent37 allocation generations, and an execution ladder. Its opportunity is to make these pieces one revision-oriented workspace contract. The principal risk is importing a remote filesystem implementation while also retaining a separate Naelao filesystem authority. That would add network and consistency cost without delivering a single source of truth.

**Recommendation:** borrow the protocol properties, not the code or assumptions. Keep Naelao's R2/CAS publication authority and provider-neutral Agent37 boundary. Build a Naelao workspace session protocol with chunk-aware staging, explicit synchronization watermarks, strict generation-bound reconnect, and atomic revision visibility. Treat a kernel FUSE mount as an optional, measured runtime capability; never make a workspace or execution depend on it where Agent37 does not provide the required device and mount guarantees.

## What Cloudflare Computer does well

| Upstream design | Why it is useful | Naelao opportunity | Main caveat |
|---|---|---|---|
| **Durable store separated from execution runtime.** A `Workspace` is created around the durable DOFS/SQLite-backed store; a backend is attached to it. | Container replacement does not have to mean loss of workspace truth. | Make the filesystem/revision service authoritative while Agent37 allocations are replaceable workers. | Never treat a provider disk or daemon SQLite database as canonical project data. |
| **Incremental bidirectional sync with watermarks.** Sync RPC uses positions/cursors and restartable blocks instead of blindly transferring a complete tree. | Reuses prior progress after interruption; lowers bytes, requests, cold-start delay, and repeated work. | Track per-session base revision, staged content inventory, and last acknowledged transfer position. Send only changed chunks and missing metadata. | Resume only after verifying session, tenant, filesystem, and allocation generation. |
| **Content addressed chunk reuse.** The VFS/chunk layer permits content reuse and sync accounting distinguishes missing/reused data. | Large unchanged files need not be retransmitted when a new execution starts. | Deduplicate immutable file chunks by cryptographic hash, with tenant-scoped references and explicit quotas. | Hashes are integrity identities, not authorization. Cross-tenant dedup can leak equality and create timing/usage side channels; begin tenant-scoped. |
| **Filesystem driver delegates to a storage provider.** FUSE maps kernel operations to the VFS/provider and handles write buffers, release, flush, permissions, and errors. | Programs use normal tools (`git`, compilers, editors) without bespoke adapters for each command. | Provide a normal POSIX path only on provider runtimes that pass mount acceptance. Keep virtual tools on the same workspace API. | FUSE capability depends on device, kernel, permissions, and libfuse. A userspace shim is not evidence of real kernel FUSE semantics. |
| **Explicit backend/host interface.** The backend consumes a narrow container host contract for lifecycle, ports, identity, and reconnection. | Decouples filesystem logic from one container provider and makes failure cases testable. | Extend Naelao's existing `SandboxProvider` / Agent37 boundary with workspace-session operations rather than embedding provider calls in project tools. | Keep provider control credentials inside the host worker. Do not pass them through a guest filesystem. |
| **Runtime identity and generation-aware reconnection.** Backend handles identify a particular runtime connection; stale transport state is discarded/rebuilt after failure. | Avoids accidentally treating a restarted container as the previous writer. | Bind every workspace session and callback to allocation ID plus generation and monotonically fenced lease. Reject every mismatch. | A provider ID alone is insufficient where IDs can be reused or instances replaced. |
| **Ignore policy is checked against the running daemon.** Configured ignore patterns are read back and compared to the applied daemon configuration. | Prevents host and daemon from silently syncing different path sets. | Compute one Naelao path policy and require runtime-reported equality before admitting sync/publication. | Ignore rules are not authorization. Reject secrets and control paths at canonical publication too. |
| **Pending synchronization, serialization, and recovery are explicit.** Workspace operations serialize mutations and track pending sync across reconnects. | Prevents overlapping sync operations from corrupting progress and gives recovery code a state machine. | Durable publication records should distinguish prepared, staged, publishing, published, conflicted, and indeterminate outcomes. Resume by idempotency key and expected hashes. | Never replay an external execution whose side effect/result is indeterminate; filesystem publication idempotency does not make command execution idempotent. |
| **Observer hooks and bounded sync telemetry.** Workspace operations emit spans and sync progress/counters, with logging opt-in/bounded. | Reveals whether cost is file enumeration, network, missing chunks, or runtime startup. | Emit counts and timings for workspace stage/publish, provider startup, lag, reused bytes, conflicts, and lease rejects; no file names/content by default. | High-cardinality paths and tenant IDs can make telemetry costly or expose private structure. Aggregate and sample. |
| **Clear distinction between stable filesystem API and experimental container synchronization.** Upstream documents its maturity boundaries. | Prevents a polished API from being mistaken for production guarantees of every backend. | Naelao should expose capabilities from verified runtime evidence and fail closed when a requested capability is absent. | Do not advertise FUSE, live sync, or provider support based only on configuration or a successful health endpoint. |

Primary references: [package README](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computer/README.md), [workspace](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computer/src/workspace.ts), [backend contracts](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computer/src/backend.ts), [container backend](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computer/src/backends/container/container-backend.ts), [container host](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computer/src/backends/container/container-host.ts), [FUSE driver](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computerd/src/fuse/driver.ts), and [daemon operations/configuration](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computerd/README.md).

## Naelao's current baseline and gaps

Evidence in this checkout shows a useful foundation:

- `workers/agents/src/sandboxes/workspace-bridge.ts` snapshots project/branch-scoped R2 data to staged blobs; filters control, secret, cache, and unsafe paths; verifies hashes; journals publications; and publishes through the existing fenced CAS gateway.
- `workers/sandboxes/src/providers/agent37.ts` provides the Agent37 control/execution adapter; `packages/sandboxes-core` includes generation-bearing allocation and execution contracts.
- `workers/sandboxes/src/index.ts` currently reports Agent37, OpenSandbox, and Cloudflare providers unavailable and disables auto-scheduling. Execution routes fail closed. The evidence record says provider verification, lifecycle/reconciliation, guest protocol, ladder dispatch, grants, MCP/AgentPort integration, desktop control, usage settlement, and live acceptance remain open.
- Bridge evidence records local typechecks/tests, while remote migration, deployed service binding, real R2/ConcurrencyDO behavior, provider snapshot/download, and provider execution are explicitly unverified.

The current bridge publishes per path through CAS and records conflicts. That protects each object from stale overwrite, but does not by itself give readers an atomic multi-file revision. A client can see an intermediate tree during publication. This is the most important consistency improvement to prioritize.

## Original Naelao design to pursue

### One revision manifest, several interchangeable execution surfaces

Make an immutable revision manifest the read boundary. A manifest maps validated paths to immutable content/chunk references, file metadata, and parent revision. Upload and verify all content first; then atomically compare-and-swap one branch-head pointer under the existing fence. Readers pin a manifest revision for the duration of an operation. This provides whole-revision visibility without copying Cloudflare's storage model. Existing R2 objects and Git/artifact history can remain content stores or projections behind adapters.

The publication protocol should be:

1. Open an authorized session pinned to branch, base revision, workspace mode, and allocation generation.
2. Stage changed file metadata and content-addressed chunks. Reuse already verified chunks within the tenant's isolation boundary.
3. At checkpoint, validate every path, expected base hash, byte/count quota, ignore/security policy, session identity, and fence.
4. Persist an idempotent publication intent and immutable manifest. Atomically advance the branch-head pointer only if the base revision is current and the fence is valid.
5. Return a committed revision or structured path conflicts. Preserve staging for conflict resolution; readers see either the prior revision or the new one.

Keep user-facing consistency modes as named in the product specification: `checked_handoff` default, and `live_single_writer` only when runtime capabilities pass admission. Both use the same canonical manifest and checked publication. Live mode changes checkpoint cadence and writer leasing, not the authority boundary. A second writer requires a flush, checked publication, lease revocation, and generation/fence change.

### Optimize cost at the right boundaries

- **Avoid full snapshots:** use persisted per-session sync cursors plus a path/hash index to identify changed files. Prove resume safety with generation-bound cursors.
- **Deduplicate chunks before whole-file transfer:** prototype fixed or rolling chunking for large files; keep whole-file hashing for integrity and small files. Benchmark CPU overhead versus bytes saved on code repos, generated artifacts, and binary assets.
- **Cache immutable reads:** short-lived edge/runtime caches may cache content by immutable hash, never mutable path. Respect tenant privacy, retention, and revocation policy.
- **Batch metadata, bound content concurrency:** send manifest/path operations in bounded batches and transfer content with a small concurrency cap. Avoid large base64 JSON payloads; stream or use opaque staged blob references where provider APIs permit.
- **Separate cold start from workspace transfer:** measure provider allocation, daemon readiness, mount readiness, first sync, and command start independently. Keep warm instances only when measured saved startup cost exceeds billed idle cost.
- **Use capability-aware runtime selection:** select Agent37 or another allowed provider based on required filesystem/exec/region/network features and verified state. Do not silently route to a provider with weaker semantics.

No dollar savings should be claimed until measured. Compare baseline bridge against the prototype on a fixed corpus and include R2 operations, D1 writes, transferred bytes, CPU time, provider startup, billed idle, conflict rate, and p50/p95 command-ready latency.

## Risks and decisions to hold

- **FUSE vs provider-native filesystem:** use FUSE only if Agent37 exposes and sustains the required device/mount capabilities. Otherwise implement the same session protocol over provider guest-agent file RPC or a mounted userspace filesystem that the provider supports. Never make a feature claim from a shim test.
- **R2 and D1 boundaries:** immutable content can reside in R2; D1/DO should hold manifests, refs, leases, and publication intent. Avoid duplicating content into SQLite or putting a giant path manifest in one database row.
- **Atomicity:** file-by-file CAS is insufficient for multi-file reader atomicity. One manifest-head CAS is the publication commit point.
- **Live readers:** notify only after manifest commit. Notifications are hints; reconnecting readers fetch current head and compare revision, so missed messages do not lose data.
- **Unknown command outcome:** if runtime dies after command execution but before response persistence, mark it indeterminate and require reconciliation. Do not rerun merely because filesystem sync is resumable.
- **Cross-tenant deduplication:** initially tenant-scope chunk indexes to avoid content-presence side channels. Reconsider broader dedupe only with a documented privacy and billing model.
- **Current inconsistent boundaries:** keep the sandbox bridge as a compatibility adapter until each client is migrated and audited; do not let UI/provider paths write canonical objects directly.

## Experiment and acceptance plan

### Prototype comparison

Use identical Agent37 template, region, workspace corpus, and workload for the existing snapshot/diff bridge and a manifest/chunk prototype. Cover cold start, warm start, no-change run, small edit, large text edit, binary edit, concurrent branch edits, publication conflict, connection loss mid-transfer, process death around manifest-head update, and reallocation with stale generation.

Record for each run: files enumerated, chunks/files sent and reused, bytes on wire, R2/D1 operations, CPU duration, startup-to-ready, first-command latency, checkpoint latency, p50/p95, billed instance seconds, publication conflicts, and recovery outcome. Repeat enough to report variance. Include a control using a small workspace so chunking overhead is visible.

### Release gates

- Correctness: no reader observes partial revisions; retries do not duplicate publication; conflicts retain recoverable staging; stale allocation/fence callbacks are rejected.
- Isolation: adversarial tenant, project, branch, owner, revoked grant, secret path, and forged provider callback cases fail closed.
- Provider: real Agent37 allocate/inspect/exec/cancel/sleep/restart/delete and lost-ack reconciliation pass in a disposable account; record actual capabilities and region.
- Performance/cost: prototype improves measured p95 readiness or bytes/R2 cost for target workloads without regressing small-workspace latency beyond an agreed budget.
- Operations: migration replay, provider outage, R2/D1 outage, instance termination, backup restore, quota exhaustion, and cleanup are rehearsed.
- Claims: expose `verified` capabilities only from completed acceptance records tied to image/template digest, provider region, test date, and protocol version.

## Implementation sequence

1. Complete Agent37 live acceptance and provider lifecycle/reconciliation without enabling auto-scheduling by default.
2. Add an internal revision-manifest prototype behind a workspace feature flag; route the existing snapshot/diff bridge through it while retaining compatibility.
3. Add tenant-scoped chunk reuse and persisted transfer cursors; instrument the baseline before optimizing.
4. Migrate one client at a time (sandbox execution, virtual tools, project UI, artifact history, provider import/export) to the shared revision API.
5. Enable checked handoff first. Add live single-writer only after lease, generation, reader freshness, and recovery gates pass on the actual runtime.
6. Publish benchmark results and operational acceptance; enable capability advertisement and scheduling only for verified provider/template combinations.

## Open questions for implementation owners

These are research decisions, not upstream facts: whether Agent37 exposes supported FUSE/device passthrough; whether file RPC can stream range/chunk operations; target repository size and latency/cost budgets; where the branch-head manifest should be transactionally stored; and which provider regions/products are in the first launch. Resolve these from provider docs/account acceptance and Naelao product SLOs before finalizing resource limits.

## Wider pass: the rest of the Computer design

The first pass emphasized storage/sync. The pinned repository is broader: it treats the workspace as a platform made from filesystem, runtimes, tools, Git, mounts, assets/artifacts, browser/container modules, and observability. The README explicitly grades these components separately. At this revision, `Workspace`/SQLite filesystem, Codemode, read-only mounts, agent tools, Git, assets/artifacts, and observability are marked stable, while the container backend, computerd, FUSE synchronization protocol, WorkerShell, container/browser modules, and parts of replay are experimental. This distinction is essential: the integration ideas below are valuable research, but upstream itself does not warrant advertising the experimental container/sync path as production ready.

### 1. Execution is an adapter over one capability surface

`workspace.runtime.exec()` can target a fast isolate/codemode backend, a worker-shell backend, or a full container, while operating against the same workspace API. It can also provide only a filesystem. This separates *what the agent may do* from *where/how it runs*.

**Naelao idea:** normalize runtime requests around typed capabilities (`read/write`, shell, language execution, browser, network egress, mounts, desktop), required policy, and observed provider capability. Resolve to Agent37 or another authorized provider only after policy and budget admission. Do not use provider preference as a promise that the capability exists. Existing `@naelao/agent-sdk` tier contracts and `workers/agents/src/script-engine/code-runner.ts` are natural integration points. Keep the current execution ladder as host policy, not model choice.

**Potential gain:** avoid renting a full VM for deterministic file reads, parsing, or bounded scripts. Route each operation to the lowest-cost runtime that satisfies its contract; keep VM allocation for native dependencies or OS behavior.

**Tradeoff:** runtime parity is not automatic. Filesystem edge cases, shell quoting, packages, networking, and interruption semantics differ. Maintain a capability conformance suite and fail admission for unmet requirements instead of pretending every backend is equivalent.

### 2. Host modules turn the runtime into a controlled tool host

Computer exposes host modules for Git, artifacts, assets, browser, tools, and container operations to its isolate runtime. The guest can call narrow operations without receiving raw storage bindings or provider credentials. A capability facade enforces roots, read sizes, directory bounds, and safe path traversal.

**Naelao idea:** treat existing tools/MCP/prebuilts as host modules with explicit scoped inputs, outputs, budgets, and side-effect classification. Put access checks at the service boundary, not only in planner prompts. Give guest code opaque artifact/workspace handles instead of bucket names, credentials, or general Worker bindings. Use a shared path-capability library across UI, tool, agent, and provider ingress.

**Potential gain:** fewer duplicated authorization wrappers, smaller prompts/tool schemas, and less data movement through orchestration. Reads can occur in the runtime near storage; only bounded results return to the planner.

**Tradeoff:** a common interface can hide meaningful capability differences. Every method must still enforce tenant/project/branch scope, byte/count/deadline limits, and whether a write is canonical, staged, or external.

### 3. Shell and agent tools are composed from smaller operations

The repository supplies reusable bounded `read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, and optional `exec` tools, plus a command surface for agent frameworks. This lets common work avoid constructing a full arbitrary shell command and gives tools structured arguments.

**Naelao idea:** make virtual filesystem operations the fast path for routine inspection and edits; use OS shell only when a task needs it. Standardize result schemas, truncation metadata, byte caps, and error codes across script tools and external sandbox execution. Use host-side search/index operations for metadata-only discovery where possible.

**Potential gain:** less process startup, smaller output/token volume, fewer command-injection and quoting errors, and lower provider time for simple tasks.

**Tradeoff:** do not build a bespoke partial shell that claims POSIX compatibility. Document exact supported operations and test only the compatibility Naelao promises.

### 4. Git worktrees provide cheap task isolation and reviewable merges

The stable Git layer includes status, branching/worktree operations, stash/reset/clean, and merge-oriented support. This makes filesystem isolation and review part of the runtime, rather than an informal naming convention over shared files.

**Naelao idea:** connect agent/task IDs to immutable base revisions and branch refs. Each parallel worker gets its own branch or overlay; a coordinator validates the selected result and advances the project branch with conflict reporting. Publish commit/provenance metadata alongside the workspace revision. Reuse RepositoryDO history and project branch semantics where they match.

**Potential gain:** parallel agents stop overwriting one another; only winning changes need canonical publication; clean-up of losing branches becomes measurable and safe.

**Tradeoff:** Git commits and file manifests must not become two competing authorities. Decide whether a commit ID names the canonical manifest, is derived from it, or is only an artifact projection. Avoid requiring full Git object packing on hot, high-frequency checkpoints.

### 5. Mounts make static and remote resources composable

Computer's mount registry validates absolute roots and rejects nested roots. It can materialize read-only R2 objects and worker bundles into the virtual filesystem; R2 mount materialization is bounded and streaming rather than buffering every object body at once.

**Naelao idea:** define mounts for immutable extension bundles, templates, shared reference data, and approved provider assets. Keep these mounts read-only and version-pinned; overlay a per-session writable layer. Cache by immutable object/version and invalidate by version, not mutable path. Keep user project files, secrets, `/.avos`, temp/cache, and mounted dependencies in distinct namespaces.

**Potential gain:** stop copying the same template/tool bundle into every session; lower startup transfer and R2 reads; make template provenance reproducible.

**Tradeoff:** eager materialization is expensive for large trees; lazy reads can add latency and make tools behave differently. Benchmark both, expose mount limits, and prohibit mount roots that overlap or expose control/secret paths.

### 6. Assets and artifacts separate large payloads from control state

Computer has separate asset upload and artifact publication surfaces with scoping and bounded metadata. This keeps large files out of prompts and leaves structured references for orchestration.

**Naelao idea:** return artifact handles, hashes, content types, and bounded previews from tasks. Keep bulky command output, generated files, browser captures, and model intermediates in artifact/blob storage; retain small summaries and provenance in task/session state. Make final artifact publication explicit and authorized.

**Potential gain:** smaller Worker/DO payloads and model context, lower serialization/memory pressure, easier retention and sharing, and fewer accidental content logs.

**Tradeoff:** artifact ACL, expiry, encryption, range reads, and project deletion must follow the owning tenant/project and branch. A blob that exists without a valid authorized reference must not be discoverable.

### 7. Long commands need bounded output and explicit completion semantics

Computer's runtime includes output windows and a spool-to-file path, plus truncation metadata. This addresses the classic failure where a long process fills memory or sends huge stdout/stderr through a Worker response. Replay safety is also explicit: side-effecting calls can be marked unsafe to repeat after interruption.

**Naelao idea:** stream bounded output to a scoped artifact spool, return a small tail plus truncation/byte counts, and provide an authorized cursor/read tool for the full log. Persist command state separately from output storage. Require side-effect labels and idempotency/reconciliation for external actions; an interrupted command with unknown completion must become `indeterminate`.

**Potential gain:** lower peak memory and DO/Worker payload sizes; fewer timeouts caused by response serialization; safe long-running diagnostics without returning megabytes to the model.

**Tradeoff:** log artifacts may contain secrets or customer data. Redact before storage where possible, restrict access, set retention, and never put content into default telemetry.

### 8. Modules and mounts give dynamic workers an explicit dependency graph

The Codemode runtime resolves host modules and workspace dependencies with a module graph rather than encouraging arbitrary ambient imports. The worker bundle/Vite integration lets applications package selected code and dependencies.

**Naelao idea:** give extensions versioned manifests with declared capabilities and dependencies. Resolve a reproducible, signed dependency bundle once; cache the bundle by digest; pass only declared host modules. This complements existing extension contracts and security scanning.

**Potential gain:** faster cold starts than repeatedly fetching/installing dependencies; smaller attack surface; repeatable behavior across task retries.

**Tradeoff:** build cache poisoning and stale vulnerable bundles. Cache keys need full lockfile/build provenance, signer identity, policy version, and revocation checks.

### 9. Egress is mediated by the host, not trusted to guest intent

The pinned code has explicit egress policy plumbing and authenticated interception for container traffic. A runtime capability should not imply unrestricted Internet access.

**Naelao idea:** route provider egress through Naelao policy gates that bind destination grant, tenant, purpose, run, and credential alias. Inject credentials at the egress boundary; guest tools see aliases, not secrets. Capture bounded destination/policy decisions for audit. Require a separate capability for broad or air-gap-breaking access.

**Potential gain:** centralized authorization and credential handling, easier tenant limits, and consistent egress across Agent37/other providers.

**Tradeoff:** a proxy may add latency and becomes a critical service. DNS resolution and connection must be coupled or pinned to avoid rebinding between validation and fetch; independently checking DNS then using normal fetch leaves a race.

### 10. Observability is operation-oriented and cost-aware

The Workspace observer can emit spans around operations; sync telemetry records operation ID, connection generation, direction, blocks, entries, bytes, skipped content, elapsed time, worst block, and restarts. Telemetry is bounded/opt-in because logging every event is itself a billed cost.

**Naelao idea:** define a common trace envelope across planner → task → runtime admission → provider allocation → workspace checkpoint → artifact → usage settlement. Record IDs, revision/generation, capability decision, byte/entry counters, provider startup, billed idle, retry class, and final consistency result. Aggregate or sample routine success; retain detailed traces for failures and explicitly sampled runs.

**Potential gain:** identify whether cost comes from allocation idle time, repeated transfer, model context, retries, or inefficient tool choice; make unit economics actionable rather than estimated.

**Tradeoff:** high-cardinality or sensitive tags create cost/privacy risks. Never include file content, command output, credentials, full URLs with query parameters, or raw customer prompts in default telemetry.

## Reframed opportunity map

| Naelao problem | Upstream idea worth adapting | Original Naelao implementation direction | Expected metric |
|---|---|---|---|
| Too much VM use for small tasks | One runtime API, several backends | Capability-based execution ladder across DO/V8/Workflow/Agent37 | Cost per successful task; p95 ready time |
| Repeated workspace copying | Watermarks, incremental sync, content reuse | Revision manifests, tenant-scoped chunk index, resumable cursor | Bytes transferred and R2 operations per task |
| Parallel agents collide | Git worktree/branch abstraction | Run-scoped workspace branches with checked merge | Conflict rate; losing-work bytes |
| Large tool output inflates model context | Output spool and tail windows | Artifact-backed bounded logs with authorized paging | Model tokens and Worker memory per run |
| Same templates/dependencies fetched repeatedly | Read-only mounts and digest-addressed bundles | Versioned immutable mount/cache keyed by signed digest | Cold-start time and cache-hit rate |
| Security duplicated across tools | Scoped runtime capability facade | Host-enforced typed capability APIs | Authorization bug rate; denied-path coverage |
| Hard to understand cost/performance | Observer spans and bounded sync counters | Joined run-level trace with provider, storage, and usage events | Cost attribution completeness; trace sampling cost |
| Unclear provider support | Explicit maturity/capability status | Verified capability matrix keyed by provider, region, template digest, and date | False capability advertisement count (target zero) |

## Revised implementation priority

1. **Establish exact Naelao baseline and acceptance failures.** Re-run the recorded failing repository/workspace/browser suites on `3737c841`, classify each failure, and keep the run attached to that SHA. This is prerequisite evidence, not a Computer integration task.
2. **Make the provider capability contract truthful.** Keep Agent37 unavailable until live verification. Complete allocation generations, reconnect/cleanup, guest protocol, side-effect reconciliation, budgets, and dispatch before enabling scheduling.
3. **Unify revision authority.** Strengthen the existing bridge to atomic manifest-head publication and pinned reads; do not introduce a second canonical store. Implement checked branches, idempotent recovery, and only then live single-writer leases.
4. **Reduce hot-path cost.** Instrument current baseline first; then test incremental cursors, content chunks, artifact spooling, immutable bundle mounts, and lower-tier runtime routing independently. Keep an experiment if it does not improve the measured workload.
5. **Compose capabilities and provenance.** Migrate virtual tools, project UI, Git/artifact history, provider sync, and extension mounts onto the same authorization/revision contract.
6. **Gate claims and operations.** Require real provider acceptance, failure injection, migration replay, restore, and rollout/rollback before enabling features or claiming production support.

## Additional upstream caution

Cloudflare's own README says the container backend, daemon, sync protocol, WorkerShell, browser/container modules, and replay/interruption portions are experimental at this pinned revision. Its container filesystem is memory-held and intended for agent-scale trees, not full monorepos; FUSE has extra I/O cost for heavy operations such as package installs and extraction. Therefore the useful lesson is the separation and protocol design, not “adopt Cloudflare Computer and performance gets better.” For Naelao, a native provider file API or sparse overlay may outperform FUSE on Agent37; only an apples-to-apples benchmark can decide.

## Final performance pass: upstream numbers change the cost story

The pinned upstream [performance guide](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/docs/19_performance.md) is unusually useful because it publishes a baseline instead of implying that a virtual filesystem is automatically faster. On its stated Cloudflare Containers `standard-2` setup (1 vCPU, 6 GiB RAM, 12 GB disk; benchmark repetitions 3, warmup 1), the FUSE-backed mount was substantially slower than tmpfs and often slower than the container's ext4 disk:

| Upstream workload | computerd | ext4 | computerd/ext4 |
|---|---:|---:|---:|
| Create 1,000 files | 560.6 ms | 303.2 ms | 1.85× slower |
| Read 64 MiB | 437.5 ms | 25.6 ms | 17.1× slower |
| Copy 64 MiB | 1,037.2 ms | 39.8 ms | 26.1× slower |
| Git init + commit 100 files | 459.2 ms | 635.4 ms | 0.72× (FUSE faster in this measured case) |
| Full 854-package / 36,675-file npm install | 124.7 s | 63.9 s | 1.95× slower |

These are upstream's workload and configuration, not a prediction for Agent37 or Naelao. The guide states the npm install timing excludes the subsequent transfer of the 36,675-file dependency tree back to the Durable Object. So end-to-end persistent workspace cost can be worse than the install number suggests. It recommends `MOUNT_IGNORE` for local-only paths, which removes ignored writes from VFS storage, change packing, and synchronization. Linux FUSE passthrough can send local file data directly to disk, but metadata operations still cross the daemon, and passthrough depends on kernel support (the guide identifies Linux 6.9+ for its behavior).

**Implication for Naelao:** do not persist build products and dependency trees in canonical project state by default. Classify state into (a) canonical source/artifacts, (b) reproducible disposable dependencies/build cache, and (c) secrets/control/runtime state. Store (a) through Naelao's revision/publication path; keep (b) in provider-local ephemeral or digest-keyed cache with quota, eviction, provenance, and explicit cache-hit telemetry; exclude (c) from guest-visible sync and canonical publication. If dependencies must persist across allocations, use a separately authorized, content-addressed cache keyed by lockfile, runtime, platform, and policy—not an ignored directory that users mistakenly expect to be durable.

The relevant performance objective is **total useful task cost**, not raw filesystem syscall speed: provider allocation plus daemon readiness plus base-workspace hydration plus command execution plus changed-content upload plus billed idle plus retries. Measure p50/p95 and tail failures by workload class. Run FUSE, native local disk plus explicit checked sync, and Agent37's supported file interface against the same corpus. Include metadata-heavy trees, source edits, `node_modules`, package installation, large binary artifacts, and Git operations. Report transfer-after-command separately so a benchmark cannot hide delayed synchronization cost.

### Additional overlooked design details worth borrowing

- **Replay only across proven-safe boundaries.** Upstream distinguishes transport failure before dispatch from failure after a command might have started, serializes mutations per backend, invalidates a stale backend handle, and refuses to replay a possibly-started command. Naelao should preserve that distinction in the Agent37 guest protocol: retry allocation/status and idempotent reads when safe; reconcile command receipts by execution ID; return `indeterminate` for ambiguous side effects. Never equate a retried HTTP request with a safe retried command.
- **Share connection setup without sharing mutable execution.** Workspace caches backend handles and in-flight connection promises, but serializes mutation streams per backend and tracks which runtime owns execution IDs. Naelao can coalesce simultaneous cold-start/probe operations for one allocation while retaining per-run IDs, per-branch state, and fences. This avoids duplicate provider allocations without collapsing isolation between agents.
- **Persist output outside the hot response.** The output spool keeps a bounded in-memory tail, writes full output to a file after limits are exceeded, and returns truncation information. Naelao should produce a small model-visible summary and authorized artifact reference, not pipe arbitrary command output through the DO/task row or model context. Failure to save the full log must be explicit; a truncated tail must never be presented as complete evidence.
- **Make interruptible work distinct from unreplayable work.** Cloudflare's experimental recovery supports pending host calls and interrupted runs, while explicitly marking side-effecting host functions unsafe to repeat. Naelao already journals external workflow effects; unify task, runtime command, provider call, and publication receipts around that principle. Recovery should ask “what effect was prepared/committed?” before deciding to re-dispatch.
- **Use a small number of non-overlapping mount roots.** Upstream validates roots as absolute and rejects nested mounts, simplifying path resolution. Naelao's equivalent should define a canonical project root plus explicit read-only mounts, and reject overlap, traversal, control-root exposure, and ambiguous shadowing at configuration time.
- **Version mounts and outputs.** Immutable bundle mounts should carry a digest and origin. Artifacts should carry owner scope, source revision, execution ID, retention, and content digest. This enables reproducible runs and makes cache invalidation deterministic.
- **Treat benchmark caveats as part of the interface contract.** State limits, sync limits, provider generation, local-only exclusions, and capability verification date should be visible to administrators. A package's stable filesystem API does not confer stable semantics on experimental backends.

### Revised recommendations by likely payoff

1. **Highest confidence and low risk:** bound model-visible output; stream/spool full logs to scoped artifacts; stop publishing dependencies/build outputs; cache immutable tool/template bundles; coalesce duplicate allocation probes; preserve execution idempotency receipts.
2. **High potential but needs design work:** atomic manifest-head publication, resumable changed-file/chunk sync, run-scoped Git branches, and a unified host capability API.
3. **Provider-dependent experiments:** FUSE, passthrough, long-lived live sync, warm pools, cross-run writable caches, and broad content deduplication. Enable only when Agent37 documents/supports the primitive and an isolated benchmark shows lower end-to-end cost without weakening tenancy or recovery.

### Evidence quality and remaining research

Upstream's benchmark is concrete but small (three repetitions, one container size, one dependency tree, specific Linux/kernel/runtime details). It is strong enough to reject the claim that the FUSE mount itself is generally faster than disk; it is not strong enough to choose Naelao's production architecture. The benchmark's own note that post-install synchronization is excluded is a warning against comparing command time alone. A Naelao result needs repeated warm/cold trials, confidence intervals or at least observed variance, full transfer completion, identical provider class/region, and billed cost from actual provider usage records.

Before selecting an Agent37 filesystem strategy, verify from current Agent37 documentation and an isolated account: native disk persistence across stop/start; filesystem import/export or guest-agent streaming; supported FUSE device/mount privileges; network and port exposure; instance replacement semantics; maximum request/response and execution duration; cancellation guarantees; and actual billing granularity. No Agent37 capability should be inferred from Cloudflare's container example.
