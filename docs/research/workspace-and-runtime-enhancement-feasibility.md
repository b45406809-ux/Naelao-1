# Naelao enhancement research: feasibility, failure modes, and original designs

**Purpose:** turn [the Cloudflare Computer design analysis](cloudflare-computer-design-analysis.md) into codebase-specific, researched implementation proposals. This document is for design and prioritization only. It changes no runtime behavior and does not claim live provider acceptance.

**Repository examined:** `Mcbt5s-Backup-2` at `3737c841ffc435acde204a2f826df0c448dc9a19`, with the sandbox bridge change `5229d607`. Key local sources: `workers/agents/src/sandboxes/workspace-bridge.ts`, `workers/sandboxes/src/index.ts`, `workers/sandboxes/src/providers/agent37.ts`, `workers/sandboxes/src/providers/opensandbox.ts`, `packages/sandboxes-core/src/index.ts`, `packages/sandboxes-sdk/src/index.ts`, and `new plan/NAELAO-SANDBOXES-EVIDENCE.md`.

## Findings at a glance

1. Naelao already has a safer foundation than a direct Cloudflare Computer adoption would provide: R2 content, authenticated bridge routes, immutable staged blobs, path filtering, expected hashes, idempotency journals, and fenced CAS publication. Preserve it.
2. The bridge's most important design limitation is not R2's consistency. It is that publication loops over paths and commits each path separately. R2 is strongly consistent per object, but that does not make a multi-object workspace update atomic. An immutable manifest plus one conditional branch-head update can create an atomic *reader visibility* boundary.
3. Cloudflare DO SQLite is appropriate for small coordinator metadata, leases, and cursors; it is not an unlimited file store. Each SQLite DO has a 10 GB paid-plan cap, 1 GB Free cap, and CPU/write limits. Keep file bodies in R2 and establish per-tenant/project quotas well below hard service limits.
4. Agent37's public product material describes file upload/download, shell, gVisor isolation, hard disk quotas, signed URLs, edge authentication, and outbound Internet-only egress. This suggests FUSE is not a prerequisite to use Agent37. However, these public product claims do not prove exact API semantics or Naelao account behavior; verify through the official API contract and disposable account before depending on range I/O, streaming, durable disk, cancellation, or generations.
5. The best likely cost wins are avoiding large dependency-tree synchronization, bounded/spooled output, lower-cost runtime selection for simple work, cache reuse with explicit ownership, and eliminating duplicate allocations/retries. Chunking or FUSE may help some workloads but can make metadata-heavy and large sequential I/O slower.

## Codebase map: current capability versus proposed extension

| Concern | Current code evidence | Current boundary | Proposal |
|---|---|---|---|
| Provider-neutral contracts | `sandboxes-core` defines provider kinds, connection status, allocation generation, runtime request/result, capability and workspace state types. | Abstract contract exists, but provider verification/execution is disabled in the control plane. | Preserve; add observed capability evidence and session protocol version rather than inferring capability from provider kind. |
| Agent37 control plane | `Agent37Provider` implements allocate/inspect/start/sleep/destroy/invoke and uses distinct API and instance hosts/credentials. | `workers/sandboxes/src/index.ts` reports it unavailable; endpoints return `provider_unavailable`; auto-scheduling is false. Evidence says no live API/instance credentials or acceptance. | Complete lifecycle and contract tests in an isolated Agent37 account before making the provider `verified` or enabling scheduling. |
| Workspace snapshot | Bridge enumerates the project/branch R2 prefix, filters unsafe/secret/runtime paths, stores hash metadata, copies eligible bodies to bridge blobs, and has caps: 200 files, 768 KiB/file, 64 MiB/snapshot, 24h TTL. | Snapshot is bounded but enumerates and reads the source tree; dependency-heavy trees can be expensive. | Instrument current path first. Add a path/hash index or immutable manifest so repeated snapshots avoid listing and fetching unchanged files. |
| Staging | Staged blobs are opaque IDs associated in D1 with tenant/filesystem/snapshot and stored in R2. Upload size is bounded. | Existing bridge is whole-file oriented; publication base64 encodes each file through a ConcurrencyDO call (maximum 1 MiB) and applies max 100 changes/publication. | Keep binary data out of JSON/base64 hot paths. Use opaque staged references across trusted services, bounded concurrency, and range/stream provider APIs if confirmed. |
| Publication | Publication journal, per-change expected baseline hash, staged blob integrity, per-file ConcurrencyDO lease/fence/CAS, retry recognition, and conflict list exist. | Files publish sequentially; a later conflict/failure can occur after earlier paths were applied. Readers can see a partially updated tree. Per-file fencing protects each key but not the tree as one revision. | Stage immutable objects/manifests, then atomically advance one branch head. Readers pin a head revision. Retain per-file adapter for compatibility until migrated. |
| Branches | R2 prefix includes branch; filesystem lookup scopes tenant, owner, project, branch. | Branch prefixes isolate data, but there is no revision graph/merge contract implied by that alone. | Define parent revision, branch head, merge/checkpoint and conflict contract, then bridge Git/artifact history deliberately. |
| Agent access | HMAC internal authorization and tenant/user/file-system lookup checks; SDK checks returned blob hash. | Current product evidence says no standalone sandbox API keys; bridge is internal service-to-service. | Preserve host-only credentials. Do not expose blob IDs as authorization; every fetch/publish must revalidate live parent scope and status. |
| Lifecycle/cleanup | Expiry sweep for bridge blobs/snapshots, computer deletion and usage tables exist. | Live provider allocation cleanup/reconciliation and actual usage settlement are not proven. | Treat desired state as durable and reconcile provider state; do not assume a lost response means no allocation occurred. |

## What the external documentation establishes

### Cloudflare Computer: strong abstractions, experimental transport

At the pinned package revision, the [README status table](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computer/README.md) marks `Workspace`, SQLite filesystem, Codemode, read-only mounts, agent tools, Git, assets/artifacts, and observers stable. It marks container backend, `computerd`, container sync protocol, RPC wire protocol, WorkerShell, browser/container modules, and interruption/replay pieces experimental. The [sync protocol document](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/docs/02_sync_protocol.md) explicitly says it is not yet suitable for production. Therefore its API design and benchmark are useful evidence; adopting its experimental wire path is not a production shortcut.

The pinned [performance guide](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/docs/19_performance.md) reports computerd FUSE roughly 17x slower than ext4 for a 64 MiB read, 26x slower for a 64 MiB copy, and about 2x slower for a full 854-package install. It attributes meaningful savings for ignored local-only paths to preventing their writes from entering VFS/chunk sync. These results come from one provider/instance/workload with only three measured repetitions; use as a reason to benchmark, not as a Naelao forecast.

### R2: atomic key writes support a manifest commit design

Cloudflare documents R2 as strongly consistent for object reads, writes, deletes, and listings. It also states unconditioned concurrent writes to the same key are last-completion-wins, while `If-Match`/`If-None-Match` conditional `PutObject` checks are atomic for that object. A negative read cannot resolve an earlier write whose outcome is still in flight; retrying with create-only condition can resolve ambiguous create-once operations. Sources: [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) and [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/).

**Feasible design:** write immutable manifest/content keys using create-only semantics; conditionally update one small mutable branch-head object using the prior ETag/expected head. The branch head is the commit point. If the head update response is lost, read the head and compare the unique new revision/idempotency token before retrying. Strong consistency makes the committed head visible immediately after successful commit. This does not make multiple independent R2 operations atomic; content must be complete and verified before exposing the head.

Potential issue: Worker R2 bindings do not necessarily surface every S3 conditional-write capability in exactly the same shape/version. Verify the specific Worker binding conditional API available to this repository's compatibility date and Wrangler types. If the needed conditional head write is unavailable, keep head mutation in a single SQLite DO transaction or route it through a proven fenced CAS service. Do not simulate CAS with HEAD followed by unconditional PUT; that has a race.

### Durable Object SQLite: good coordinator, finite storage and invocation budget

Cloudflare's current docs say SQLite DO storage is transactional/strongly consistent, supports PITR, and has a 10 GB paid-plan per-object limit (1 GB Free). Default CPU per invocation is 30 seconds unless raised; SQLite-full makes writes fail while reads/deletes continue. Large unbounded KV `list()` calls can load the whole result into memory. Sources: [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) and [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

**Feasible design:** use an actor per project/filesystem (or shard) for branch heads, sessions, leases, revision metadata, and durable small journals; use R2 for content. Avoid one global workspace DO, which serializes unrelated tenants and creates a hot key. Avoid one DB row per chunk if it makes snapshot publication generate huge synchronous SQL work; batch indexes and page listings. Set headroom quotas and alert before platform limits. PITR is useful for metadata recovery but must not be mistaken for restoring R2 bodies or cross-service D1 state.

### Agent37: file API likely makes FUSE optional; provider claims still need validation

Agent37's [Cloud product/API page](https://www.agent37.com/cloud) advertises file upload/download, shell commands, signed URLs for terminal/desktop/file browser, gVisor isolation, per-sandbox filesystem and disk quota, API-key access, and outbound Internet-only egress. Its [pricing page](https://www.agent37.com/pricing) says compute stops when sandbox sleeps/stops while disk is billed while retained. These claims make a native file API plus Naelao R2 staging a plausible architecture and weaken the case for requiring an in-guest FUSE daemon.

The public page is not a sufficient contract for atomic upload, path confinement, byte-stream size limits, concurrent file writes, signed URL scope/expiry, exec idempotency, cancellation guarantees, sleep durability, filesystem snapshots, or allocation generation. Agent37 advertises two credentials in this codebase (control-plane API key and instance execution key); keep each server-side and never put either into guest environment, logs, or model context. Verify all of the above against the current authenticated [Agent37 documentation](https://www.agent37.com/docs) and a test account. If no provider request receipt or durable operation ID exists, Naelao must store its own operation ID and reconcile by inspecting provider state/metadata before retrying allocation or command execution.

## Recommended original design: immutable revision objects + one fenced head

This is the core proposal, not a Cloudflare Computer implementation.

### Data placement

- **R2:** immutable file bodies/chunks, immutable revision manifests, optional large output artifacts. Keys are opaque and tenant-scoped; each referenced body is checked by hash and size.
- **D1 or scoped coordinator DO:** session/lease metadata, authorized owner, base revision, branch head, allocation generation, publication intent/result, retention/refcounts, and provider operation state. Use the store that gives the required atomic conditional update; do not keep two writers for the same head.
- **Provider disk:** cache/staging only, never canonical truth. Reconstructable dependencies may remain locally cached under a digest and quota.

### Commit algorithm

1. On open, authorize the actor; resolve filesystem/branch; create a session bound to base revision, consistency mode, provider allocation ID/generation, and policy version.
2. Read the immutable manifest for that base revision. Provider receives either a bounded file plan or signed, short-lived data-plane URLs, not broad R2 access.
3. Provider changes are uploaded to staging. Validate path rules, size/count quotas, executable metadata, forbidden secret/control paths, base hash and file hash. A staged object is not visible from canonical workspace APIs.
4. Build an immutable revision manifest referencing verified existing and new blobs. For a rename/delete, represent explicit tombstones; absence must not ambiguously mean “not transferred yet.”
5. Start/complete a publication journal using unique idempotency key and expected parent/head. Atomically CAS the single branch head from expected revision to candidate revision while checking lease/fencing token. If this atomic check fails, return structured conflict and retain staging.
6. Notify readers with the committed revision as a hint. Readers always resolve the branch head/revision at read time; they never trust a notification as the data source.
7. Expire unreferenced staged blobs/manifests only after a grace period and verified reference scan. Cleanup failure leaks storage temporarily; it must never delete referenced data.

**Why this solves the observed issue:** sequential per-path R2 CAS remains useful to protect files but readers can observe a mix of old/new paths. A manifest pointer converts a set of immutable objects into one visible revision. The pointer is the linearization point. Neither R2 strong consistency nor a per-object ETag alone supplies multi-object transaction semantics.

**Critical implementation detail:** if head and lease are in D1, use a single D1 transaction/conditional update that validates the fence and expected head together. If head is in R2, a separate D1 lease check then R2 head CAS can race with lease revocation unless the fence is embedded in the head and CAS is serialized by one coordinator. Prefer the coordinator DO transaction as authoritative head/fence, with R2 manifest immutable and pointer mirrored only as a projection. Or use one object-store head CAS with a monotonically increasing fence included and ensure all writers are ordered by that object. Do not split ownership casually.

## Consistency modes: feasible semantics and hazards

| Mode | Proposed implementation | Feasibility | Failure to prevent |
|---|---|---|---|
| `checked_handoff` | Each run pins parent revision and writes a branch/session overlay. Checkpoints commit a new manifest only if expected branch head matches. Parallel agents use child refs. | High. Fits existing branch prefix, expected hashes, CAS journal, and immutable R2 blobs. | Treating directory listing as a revision; partial promotion; silent rebase that changes task inputs. |
| `live_single_writer` | Coordinator owns a lease with monotonic fence. One runtime mutation stream; periodic flush creates immutable revision; readers subscribe to revision notifications and fetch committed heads. | Medium. Requires real Agent37 event/stream latency and durable coordinator semantics. | Lease expiry while a paused runtime can still write; stale session after instance restart; duplicate writer due non-atomic lease check; notification loss; uncommitted reads. |

For live mode, do not let the provider write canonical R2 directly. It writes staging only. Every checkpoint validates the generation and fence inside the same authoritative commit boundary. On lease expiry, old callbacks fail even if the old machine wakes up. A handoff drains writes, commits/abandons pending stage explicitly, revokes fence, and grants a new session at committed head. A 2-second cadence is a target for measurement, not a promise: provider API rate, D1 transaction rate, data size, and pricing may require batching or a slower interval. Persist max dirty bytes and max checkpoint age; if exceeded, pause writes or report degraded capability rather than unbounded staging.

## Performance/cost proposals with predicted regressions

| Proposal | Expected win | Likely regression / bug risk | Cheap first experiment |
|---|---|---|---|
| Do not sync dependency/build trees; retain digest-keyed local cache | Large reduction in bytes, object operations, snapshot listing, and install-result publication | Cache misses on a new allocation; stale/poisoned cache; hidden dependency state violates reproducibility | Benchmark cold/warm tasks; key cache by lockfile hash, image digest, architecture, package manager, policy; verify contents before reuse |
| Incremental path/hash index and transfer cursor | Avoid repeat full R2 listing/body reads; resumable transfer after transport loss | Cursor invalid after branch change/deletion; stale index; missed rename if no tombstone | Concurrently mutate/delete/rename during snapshot and restart at every cursor boundary; reconcile with authoritative manifest |
| Chunk large immutable files (initially >1 MiB) | Reuse unchanged file regions across revisions, lower retransmission on small edits to large artifacts | CPU/hash/index cost; worse tiny-file workloads; chunk-boundary shifts; more metadata and garbage-collection complexity | Compare whole-file and fixed 512 KiB/1 MiB chunks on representative source, package lock, archives, and media; record CPU, R2 operations, total bytes |
| Use direct Agent37 file upload/download APIs instead of custom FUSE | Avoid kernel/device requirements and FUSE syscall overhead; provider-native auth/data plane | API caps, base64 overhead, no streaming/range, partial write semantics, extra round trips | Inspect current API docs then test files across sizes, binary, interruption, path traversal, concurrent update, signed URL expiry |
| Bounded parallel blob upload | Better latency for independent files | Provider/Workers subrequest limits, memory pressure, throttling, nondeterministic partial completion | Concurrency sweep 1/2/4/8 under byte cap; keep a durable per-object receipt and retry individually |
| Output spool to artifact with small tail in task result | Less DO memory, serialization, and model token use | Redaction/ACL/retention risk; spool failure could lose diagnostic evidence | Generate multi-MB output; verify bounded result, complete artifact hash, redaction, pagination auth, TTL cleanup |
| Warm allocation pool | Lower p95 startup | Billed idle, tenant isolation complexity, leaked identity/cache, capacity starvation | Compare measured startup saved against actual compute + retained disk cost by template and concurrency; start with opt-in pool and strict owner handoff |
| Lower-cost runtime for pure operations | Avoid unnecessary Agent37 start | Semantic mismatch/unsupported dependencies; result differences | Shadow-run safe read-only tasks across virtual/runtime backends; compare output and exact capability requirements before routing writes |

Do not promise “cheaper” from reduced bytes alone. Cost model should include Agent37 compute and retained disk; R2 storage/class-A/B ops/egress; D1 rows/queries; Worker/DO invocation and CPU; build-cache storage; failed allocation and idle time; and support/recovery cost. Agent37 public pricing is mutable; store the observed quote/date and verify against account billing before using it in pricing decisions.

## Failure and security analysis

| Failure / attack | How it can happen | Required invariant / original remedy |
|---|---|---|
| Partial tree published | Per-path write 1 succeeds, write 2 conflicts/fails | Canonical readers resolve one immutable revision head; per-file bridge route becomes migration-only. |
| Lost PUT response | Client times out while R2/provider write may still commit | Retry create-only immutable object by content hash; for mutable head read commit token/current head and reconcile, not blind overwrite. R2 docs explicitly warn a negative read may precede an earlier in-flight write. |
| Old runtime writes after reallocation | Process pause, provider sleep/wake, callback retry after instance replacement | Validate allocation generation and monotonic fence at commit, not just connection time. |
| Stale or forged signed URL | URL leaks or remains active after revocation | Narrow key, method, content length/checksum where supported, short expiry; still require server-side manifest authorization before publication. URL expiry is not session revocation of already uploaded staging. |
| Blob ID becomes bearer access | Guessable/object key or bridge response exposed | Opaque random IDs plus authenticated lookup against tenant, owner, filesystem, snapshot, and status on every access. Never trust hash/ID as ACL. |
| Path traversal/symlink | Provider guest writes symlink that redirects operations or `..` paths | Validate canonical POSIX components, reject absolute/backslash/NUL/traversal; decide symlink policy explicitly; resolve with `lstat`/no-follow semantics in guest; recheck path at publication. Existing path filter is a good start but provider filesystem semantics need tests. |
| Cross-tenant dedup oracle | Shared hash index reveals another tenant has same content | Tenant-scope indexes/quotas and response timing; shared physical dedup only behind a non-observable service with careful threat review. |
| Duplicate external command | Timeout/retry after side effect but before result persistence | Unique execution ID/provider receipt, explicit side-effect class, query/reconcile before retry; `indeterminate` when result cannot be established. |
| Quota exhaustion/DO full | Huge workspace or snapshot bursts hit D1/DO/R2/Worker limits | Tenant/project quotas, backpressure, resumable pagination, preflight reservation, `SQLITE_FULL` handling, alert headroom, and cleanup that never deletes live references. |
| Cache poisoning | Untrusted build writes into reusable cache or image dependency changes | Cache key contains all build inputs; producer provenance and package lock digest; read-only consume; tenant-bound writer policy; cache eviction/rebuild path. |
| Missed live notification | WebSocket/event delivery disconnects | Notification is hint only; revision cursor on reconnect; client compares current head and fetches gap. |
| Provider URL/egress SSRF | Untrusted endpoint or redirect reaches private service | Allowlisted provider hosts; do not accept arbitrary runtime endpoint from provider response; redirect policy and DNS/pinning consistent with network layer. Current Agent37 endpoint is derived from validated instance ID, a good pattern; verify all signed URL hosts separately. |

Cloudflare supports large DO wall-time while callers remain connected, but CPU defaults, alarm wall limit, per-object storage limits, and in-memory list pitfalls still shape algorithm design. Chunk manifest building must be paginated and bounded; do not turn a snapshot into one unbounded DO invocation or giant serialized D1 transaction.

## How other systems approach the same problem

This section focuses on documented patterns, not claims of direct equivalence:

- **Object stores with conditional writes:** R2/S3-style ETag preconditions solve single-object compare-and-swap; immutable blobs plus a conditional pointer is a common way to compose a multi-object snapshot. The pointer must own concurrency. Conditional object writes are not cross-object transactions.
- **Git:** content-addressed objects plus refs provide immutable data and mutable named heads. Naelao can use the same conceptual split while retaining R2 and RepositoryDO, but should avoid a double-write where Git ref advances and workspace manifest does not (or vice versa). Pick a single commit point; project Git history can be derived/materialized from it or the head transaction must atomically coordinate both through a journal/reconciler.
- **Container sandbox APIs:** Agent37 publicly exposes files and shell; Kubernetes SIG Agent Sandbox similarly documents a runtime API where path validation alone is explicitly not OS isolation—the runtime class/security context/network policy provide that boundary. The transferable lesson: host authorization, guest OS isolation, and network policy are independent layers.
- **Build caches:** reproducibility requires keying cache entries by complete declared inputs and treating entries as disposable accelerators. Never use a cache hit as proof that the underlying project artifact exists or was authorized.

These are design analogies. Production behavior must be validated against the actual implementations and current vendor contracts before relying on it.

## Research links and claim provenance

### Primary documentation consulted

- Cloudflare Computer pinned [status/limits](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/packages/computer/README.md), [sync protocol](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e272602f909640e/docs/02_sync_protocol.md), [VFS design](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/docs/01_vfs.md), [performance measurements](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/docs/19_performance.md), [workspace implementation](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/packages/computer/src/workspace.ts), [backend interface](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/packages/computer/src/backend.ts), and [container backend](https://github.com/cloudflare/computer/blob/bb0a5db4b7e8c8a79625d63e0e/packages/computer/src/backends/container/container-backend.ts).
- Cloudflare [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/), [R2 S3 conditional operations](https://developers.cloudflare.com/r2/api/s3/api/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), and [SQLite-backed DO storage and transaction semantics](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/). These pages are current/live docs and may change; checked 2026-11-07. Recheck before implementation because platform limits and APIs are time-sensitive.
- Agent37 [Cloud/API overview](https://www.agent37.com/cloud), [pricing](https://www.agent37.com/pricing), and [documentation portal](https://www.agent37.com/docs). Public product statements are treated as vendor claims; account-specific API contracts and live behavior remain unverified.
- Kubernetes SIG [Agent Sandbox runtime API](https://agent-sandbox.sigs.k8s.io/docs/api/runtime/) and [TypeScript client security notes](https://agent-sandbox.sigs.k8s.io/docs/typescript-client/) as a comparison for guest path validation versus OS/network isolation.

## Decision checklist before implementation

1. Confirm which Agent37 operations are supported by current authenticated API docs: upload/download limits, streaming/range support, signed URL scope, disk persistence on sleep, execution cancellation and receipts, lifecycle idempotency, event stream replay, and provider generation semantics.
2. Choose one authoritative branch-head/fence transaction location. Proposed default: per-filesystem/project coordinator DO SQLite; R2 holds immutable payloads/manifests. Prove tenant-keyed DO naming and no single global hot shard.
3. Select no-sync path classes from product semantics. `node_modules`, build caches, temp, and tool caches are ephemeral/reconstructable; source/artifacts durable; credentials/control data forbidden. Publish this distinction in developer-facing docs.
4. Define revision manifest encoding, size/page bounds, tombstones, metadata, rename semantics, reference lifecycle, and Git projection before writing clients.
5. Define admission capability evidence shape and expiry; no route auto-enables from a configured credential alone.
6. Pick representative corpus and cost ceiling; obtain Agent37 account pricing plus Cloudflare usage rates as of test date.
7. Only then decide whether FUSE, native file transfer, a guest agent, or an overlay filesystem is the right staging surface.

## Proposed phased work (documentation recommendation only)

**Phase A — verify and instrument:** re-run focused sandbox/bridge tests; add no behavior until baseline snapshot/publish bytes, ops, time, allocation, idle, and conflicts are measured; perform Agent37 control-plane acceptance for isolated disposable tenant.

**Phase B — provider completion:** implement/verify provider operation reconciliation, guest protocol, cancellation, runtime generation checks, exact capability reports, usage settlement, and destruction. Keep provider unavailable until acceptance evidence is tied to template/image digest and region.

**Phase C — revision publication prototype:** implement a separate design prototype behind a test flag, using immutable manifests and one fenced head commit. Run crash injection before/after each blob, manifest, journal, and head write. Verify reader sees only old or new complete tree. Do not replace bridge yet.

**Phase D — performance prototypes:** separately compare (1) whole file versus chunk dedupe, (2) repeated list versus revision index/cursor, (3) FUSE versus native Agent37 file API, (4) dependency exclusion/cache, and (5) bounded parallel upload. Keep only improvements measured at full task completion and billed cost.

**Phase E — gradual clients and consistency modes:** migrate one client class at a time through compatibility adapters; checked branch mode first; live writer only after generation-fenced writes, flush/handoff, missed-event recovery, and reader freshness pass against real Agent37.

**Phase F — production acceptance:** test multi-tenant isolation, burst concurrency, quota exhaustion, provider outages, lost acknowledgements, R2/D1 outages, restore, deletion, and rollback; enable capability advertisement only after evidence is current.

This sequence deliberately keeps the current fail-closed sandbox routes unavailable until their missing prerequisites are satisfied.
