# Naelao implementation queue

This is the live checklist for one session working through one plan at a time. The latest confirmed
commit on `origin/Mcbt5s-Backup-2` is the recovery checkpoint; fetch the branch tip before resuming.
The Tier 6 plan was activated first and its local acceptance work is verified; its separate live
acceptance remains open. An AGENTS.md pointer, when present, identifies the single active task; when
no local task is ready, the pointer is absent. The previous
claims checkpoint at `2b80e458` had parked the remaining functional claims workflow. Use the
checklist and linked ledgers to determine readiness and record a reason if the order changes.

## How to resume and advance

1. A new session can start with **start**. Follow the [startup instructions](../../AGENTS.md#start-or-resume)
   to recover the current checkout from `origin/Mcbt5s-Backup-2`, then use the queue entry and
   its latest checkpoint to choose exactly where to resume. Bring the AGENTS.md pointer into
   sync if it is stale.
2. When activating a plan, turn its remaining ready requirements into ordered checkboxes under that
   plan. Preserve the requirement IDs and use the linked ledger's verified status. Historical
   checkpoints can supply evidence. Use one task and one evidence entry for overlapping requirements.
3. After each finished task, check off its row and record a code commit or PR, relevant checks, and
   the level of acceptance in its linked ledger. A short queue entry can link to the ledger evidence.
   If code is ready and only live acceptance remains, track that acceptance as a distinct unchecked
   item. Keep every unfinished or blocked task unchecked.
4. Promote the next ready task from the same plan, update the single current pointer in AGENTS.md,
   and save the implementation and its handoff in the verified checkpoint history. Push authorized
   checkpoints to `Mcbt5s-Backup-2`, then continue with the task already selected. An interruption
   can resume from the same pointer without rereading the other plans.
5. Finish a plan when its tracked tasks are verified. If all remaining work in it is blocked,
   record the exact dependency and how to resume it, leave the plan unchecked, and proceed to the
   next ready plan. Clear the old active pointer when switching. Remove the Current task section
   from AGENTS.md only after the readiness review below. Recheck parked items when their recorded
   dependency changes.

## Before stopping for blockers

- Review all unchecked plan entries, including paused, parked and reconciled plans. Check the
  outstanding requirements against current source, the latest ledger evidence and the specific
  dependency. A plan label, a finished demo, or the end of the numbered list does not establish
  that its requirements are complete.
- Separate work that needs live access, external approval or an unresolved product decision
  from any independent local implementation, integration or verification. When local verification
  is authorized, a previous note that tests were not requested is historical context. Add relevant
  local checks to the queue and carry them out. Keep deployment and live acceptance open separately.
- Activate and continue the first ready item in queue order. If nothing can proceed, record the
  exact remaining dependency and resume condition for each parked plan. Report the status as
  blocked with work remaining. Mark the full queue complete only when every requirement is verified.

## Checkpoint format

Each checkpoint inside an open task should save a small, verified change and a handoff in the
same commit. Update the **Latest checkpoint** under the active plan with the task and slice,
what landed, what verification ran and its result, and the exact next action. Name a file,
function or verification command when that helps the next session pick up the work. Link
longer evidence in the task ledger, and keep older checkpoints in Git history or that ledger.
The containing commit identifies the checkpoint. Link earlier evidence commits where useful.

Keep the task unchecked between slices. Record a blocker only with the missing prerequisite,
the work already saved, and a condition for retrying. Preserve unpushed work when the checkout
survives. After local data loss, fetch the recovery branch and pick up from its latest saved
handoff. Anything that had yet to reach that branch may need to be redone.

## Paused plan — Single Project Tier 6 runtime

See the [plan](../research/single-project-tier-6-runtime-plan.md). It governs S4 and related S3/U10
execution and erasure work. Reuse the managed-services ledger for overlapping evidence.

- [x] **SPR01 — Inventory and contract.** Trace all runtime starts, including attachment
  tools, extension tools, prewarm and restore, across Project and branch scopes. Map each caller
  to the main runtime, a container-free service, an explicit external tool, or historical cleanup.
  Record the first locally verifiable admission or routing gap and the existing erasure coverage;
  the source map and existing erasure routes are documented in the
  [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
- [x] **SPR01 — Revalidate the runtime-start inventory on the active branch.** Current source routes
  Project main execution, video audio/frame extraction, scanned-PDF rendering and Project-native
  extension execution through `sandbox:<space>:<project>`. Project `MEDIA_SANDBOX` and
  `DOCUMENT_SANDBOX` references remain for historical erasure/discovery, not new Project starts;
  explicit AgentPort/tunnel execution remains separately authorized. Four focused routing,
  attachment and specialist-workspace suites pass 56/56; Agents typecheck and `git diff --check`
  pass. No additional local SPR01 code gap was found. Keep Cloudflare lifecycle and erasure acceptance
  blocked separately as recorded below.
- [x] **SPR02 — One allocation and image profiles.** Enforce Project-wide admission across
  branches, select approved capabilities before starting, and fence image replacement and recovery.
  - [x] **SPR02.1 — Stable Project runtime identity and branch admission.** Project branch IDs
    resolve to `sandbox:<space>:<project>` while retaining the exact branch in invocation scope.
    Race branches now participate in Project-main generation, active-branch fencing, writer
    admission and snapshot retention. In unified-workspace mode, the Workspace Coordinator
    hydrates and stages its run branch; the shared Durable Object serializes Container/workspace
    routes. `ToolSandboxDO` tests pass 37/37; DynamicSandbox, routing and execution tests pass 68/68;
    Agents typecheck and `git diff --check` pass. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
  - [x] **SPR02.2 — Host-owned capability admission for Project images.** Approved dynamic
    `TOOL_SANDBOX` pins can declare a unique Project profile ID and immutable capability list.
    Authenticated operation requirements are checked against the current Project base image before
    execution registration, writer reservation, billing/capacity admission or Container start. A
    missing capability returns a structured error with only fully matching profile IDs present in
    the deployed image map.
    Current Project base image has no FFmpeg or PDF-render capabilities and no Project profile pin
    is configured. DynamicSandbox and container-policy tests pass 55/55; `ToolSandboxDO` tests
    pass 38/38; Agents typecheck and `git diff --check` pass. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
  - [x] **SPR02.3 — Owner-selected Project image profile.** The owner/admin settings API now stores
    a requested image profile separately from its size tier under the existing optimistic version
    fence. Reads and writes expose only profiles meeting the tenant plan and whose exact image pin
    is present in the deployed DynamicSandbox image map. The selected size must meet the image
    minimum. Profile settings, audit rows and version 1 archives include the image profile; older
    archives default to `base`. Profile route, settings/archive and container-policy tests pass
    23/23; DynamicSandbox tests pass 44/44; Agents typecheck and `git diff --check` pass. The saved
    request is not applied to a running Container yet; SPR02.4 owns the checked replacement.
  - [x] **SPR02.4 — Checked image replacement and recovery.** DynamicSandbox resolves the saved
    Project image from trusted D1, verifies its exact deployed digest, capability declaration,
    minimum size and current plan before execution/resource admission. A durable replacement intent
    fences the prior generation as `recovery_required`; the old Container and billing hold must be
    confirmed stopped/settled before the new selection and next generation can start. Uncertain
    stop/start outcomes remain fenced until inspection reconciliation. Image-specific snapshots are
    marked `reference_dropped` and never restored to the replacement; the new image hydrates from
    checked Project workspace content. Stop/start uncertainty, stale pins, capabilities and checked
    workspace recovery pass in the local fixtures. The focused regression set passes 139 tests
    across eight suites; Agents typecheck and `git diff --check` pass. No Cloudflare image was built,
    deployed or started live.
- [x] **SPR03 — Migrate native tool callers.** Route video audio, video frame, PDF and
  extension native processing through the Project runtime while preserving isolation and operation
  limits.
  - [x] **SPR03.1 — Video audio extraction.** The prebuilt caller carries the active Project into
    the authenticated attachment route. Project video extraction now targets
    `sandbox:<space>:<project>` through DynamicSandbox when enabled, with host-created
    `media.audio_extract` admission. The route preserves input, 60-second extraction, base64 and
    output bounds, and forwards capability/profile errors. Projectless video fails before R2 read;
    ordinary audio remains on the container-free transcription service. Attachment route and
    prebuilt caller tests pass 22/22; Agents typecheck and `git diff --check` pass. No live image or
    provider operation was run.
  - [x] **SPR03.2 — Video frame sampling.** The authenticated frame-analysis route now requires
    Project context before reading R2, and calls `sandbox:<space>:<project>` through DynamicSandbox
    or the legacy main runtime with host-created `media.frame_extract` admission. It preserves the
    owner toggle, task ownership, Space egress and attachment revalidation, 0/10/20-second sampling,
    frame/JPEG/output bounds, image validation, quota accounting, timestamps and provenance.
    Projectless requests cannot create a specialist allocation. Attachment route and prebuilt tests
    pass 24/24; ToolSandbox and DynamicSandbox tests pass 89/89; Agents typecheck and
    `git diff --check` pass. No provider operation or live image was run.
  - [x] **SPR03.3 — Scanned PDF rendering.** Project-scoped `attachment.ocr` PDF requests target
    `sandbox:<space>:<project>` through DynamicSandbox or the main runtime with host-created
    `document.pdf_render` admission. The route preserves task/Space owner and egress checks, daily
    OCR quota accounting, the 1 MiB PDF input limit, five-page window, 8 MiB renderer response cap,
    page image checks and untrusted OCR provenance. Projectless scanned PDFs return
    `scanned_pdf_project_required` before body reads, quota reservation or runtime calls; they cannot
    start a Space Assistant DocumentSandbox. Attachment route/prebuilt tests pass 28/28; ToolSandbox
    and DynamicSandbox tests pass 90/90; Agents typecheck and `git diff --check` pass. The checked-in
    base has no PDF capability or selected deployed profile, so Project rendering remains fail-closed
    until an approved image profile is available. No provider operation or live image was run.
  - [x] **SPR03.4 — Extension native tools.** Project Bash, managed environment execution,
    prewarm and image-tagged stored scripts recheck the live native grant, active Project install,
    approved image and `extension.native_execute`, then execute on the exact owner-selected image in
    `sandbox:<space>:<project>`. Project artifact import/export uses checked workspace copies with
    idempotent digest recovery. Explicit AgentPort/tunnel execution stays independent; old sidecar
    status/reset/receipt routes remain for cleanup and historical allocations. Seven focused suites
    pass 136/136; Agents typecheck and `git diff --check` pass. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
- [x] **SPR04 — Retire direct specialist execution.** Stop new first-party Project
  allocations in Document/Media sandboxes after the replacement routes pass. Preserve cleanup,
  reconciliation and erasure of historical runtimes.
  - [x] **SPR04.1 — Gate Project-scoped specialist execution.** Project-scoped `/exec` and
    `/prewarm` on DocumentSandboxDO and MediaSandboxDO return `project_runtime_specialist_retired`
    in the shared allocation admission hook before execution receipts, reservation, billing or
    Container start. Main-runtime attachment routes and historical cleanup remain available.
    ToolSandboxDO, DynamicSandboxDO, specialist-workspace and attachment caller tests pass 146/146;
    Agents typecheck and `git diff --check` pass. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
  - [x] **SPR04.2 — Reconcile specialist discovery and deployment metadata.** Project `runtime.list`
    and `runtime.find`, managed environment availability and command/planned-runtime resolution expose
    only the exact deployed dynamic TOOL_SANDBOX images carrying `extension.native_execute`. Project
    image-tagged calls fail before resolving a sidecar; the Project runtime catalog and installation
    route admit only these same native-capable images, and blueprint runtime requirements fail closed
    without one. Projectless catalogue and sidecar behavior remains. Agents discovery, environment and
    CodeRunner suites pass 35/35; Spaces blueprint tests pass 28/28. Agents/Spaces typechecks, Shell
    build/type validation and `git diff --check` pass. Fixed specialist pins/bindings remain for
    Space Assistant execution and historical cleanup. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
  - [x] **SPR04.3 — Verify historical cleanup and recovery paths.** Cleanup seeds the stable legacy
    Document (`sandbox:<space>:<project>`) and Media (`attachment-media:<space>:<project>`) names,
    dispatches exact registered historical objects, and retains failed receipts for retry before
    workspace erasure advances. Five cleanup/runtime suites pass 132/132; Agents typecheck and
    `git diff --check` pass. Arbitrary unregistered historical DO IDs cannot be enumerated and the
    provider snapshot purge API is unsupported; see the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
- [ ] **Paused · SPR05 — Local acceptance complete; live acceptance blocked.** All seven local
  criteria are verified and mapped below; the separate Cloudflare acceptance remains open.
- [x] **SPR05.1 — Shared Project allocation and isolation.** Concurrent Shell, FFmpeg and PDF
  requests across branches share one runtime generation, provider admission and billing reservation;
  a second Project receives a separate runtime identity and allocation under the same tenant quota.
  DynamicSandbox and routing tests pass 57/57. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
- [x] **SPR05.2 — Admission and authority failures.** Missing capabilities, attachment ownership,
  air-gap egress, revoked Project extension grants, Project deletion and unavailable writer/compute
  admission are mapped to local fixtures. New regressions prove a revoked extension grant stops
  before runtime lookup and an unavailable compute-admission binding stops before billing or start.
  Six Agents suites pass 138/138; Agents typecheck and `git diff --check` pass. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
- [x] **SPR05.3 — Replacement and recovery safety.** Profile replacement, lost-claim recovery,
  interrupted starts, unknown stop outcomes, checked Project workspace hydration, and runtime
  scratch isolation are mapped to local fixtures. Four Agents suites pass 118/118; Agents typecheck,
  container server syntax checks and `git diff --check` pass. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
- [x] **SPR05.4 — Container-free and Project attachment paths.** Ordinary audio transcription and
  image analysis explicitly assert no Media or Project runtime calls. Authenticated Project video
  audio, bounded frame sampling and scanned-PDF tests assert main-runtime identity, capability
  admission, owner/egress gates, limits and no specialist fallback. Three Agents suites pass 43/43;
  Agents typecheck and `git diff --check` pass. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
- [x] **SPR05.5 — Explicit external tools.** Agent37 and tunnel fixtures enforce explicit
  owner/user routes, project or machine grants, scoped filesystem access and selected artifact
  transfers. A managed Project shell or extension capability denial does not fall back to a local
  computer. Five Agents suites pass 56/56; Agents typecheck and `git diff --check` pass. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
- [x] **SPR05.6 — Erasure and tombstone.** Historical Document/Media and registered sidecar
  cleanup, retry receipts, Project tombstone barriers, and truthful provider outcomes are mapped
  to local fixtures. Three Agents suites pass 114/114; Agents typecheck and `git diff --check`
  pass. See the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
- [x] **SPR05.7 — Evidence and live boundary review.** All seven criteria are mapped to local
  fixtures in the SPR ledger, with mock/local evidence separated from deployed behavior. Readiness
  review found no local SPR work remaining; the live acceptance is blocked as recorded below.
- [ ] **Blocked · Separate live acceptance.** Requires approved jurisdiction-specific Sandboxes/D1/R2
  configuration and access policy, a deployed Project image with the required capabilities, and an
  authorized Cloudflare journey for cold/warm allocation, capacity/billing, stop/reconciliation,
  recovery, snapshot retention and erasure. Physical snapshot purge is unsupported, and historical
  unregistered Durable Object IDs are not enumerable through the available namespace API. No live
  operation or deployment ran; keep rollout gated.

**Latest checkpoint:** SPR05.7 records all seven plan criteria against local fixtures and separates
local evidence from live evidence in the [SPR ledger](../research/single-project-tier-6-runtime-progress.md).
SPR05.1–SPR05.6 test counts and results remain on their checked task rows. Agents typecheck and
`git diff --check` pass; no live provider operation or deployment ran. Readiness review found no
independent ready work in the earlier APW, PW, S/U, SC, U, K, EP, TBR or P entries; their exact
policy, authority, jurisdiction, price and deployment dependencies remain recorded. The reconciled
AgentPort and AgentPhone reviews also found no source-only work without verified provider/API or
commercial evidence. The first ready task was the requested WhatsApp member-phone regression suite;
it is now complete at 20/20, with Agents typecheck and `git diff --check` passing. The post-test
review initially found no independent local task. A final APW07 audit selected a barrier-driven
local race regression for cancellation after publication authorization while the Artifact Worker
request is pending; it now passes 16/16. This verifies the integration helper's host contract only,
not real Agent DO permit storage or deployed Coordinator behavior. A follow-up source review found
that validation receipts omit the already-checked worker source-base pin, so that local lineage task
is now complete: 39/39 across four focused suites, Agents typecheck and `git diff --check` pass.
The delegation-admission test fixture was also corrected to use its declared local worker model.
APW08 budget-resume coverage now passes 17/17, with Agents typecheck and `git diff --check` passing.
Saved actor/Project scope revalidation also passes in the 19/19 delegation suite. Current
runtime-route revalidation on resume passes in the 20/20 suite. The stale workspace-checkpoint pin
regression now passes in the 22/22 delegation suite, Agents typecheck and `git diff --check` pass.
The current Project assistant-access gate also passes revoked/unavailable regression cases (2/2),
with Agents typecheck and `git diff --check` clean. Approval-resume contract and parent start-fence
coverage now passes 30/30 across four focused suites. Next is the APW08/PW/EP caller and contract
readiness review. Live and other policy/contract/provider/practitioner acceptance remains separate.
The SPR01 inventory was refreshed on the active branch: current Project main, attachment and native
extension execution use the stable Project main object, while specialist namespaces remain for
historical cleanup/discovery. Four focused routing/attachment/specialist suites pass 56/56, Agents
typecheck and `git diff --check` pass. No further local SPR01 implementation gap was found; the
separate live lifecycle/erasure blocker remains. **Exact next action:** continue the queued APW08
recovery and topology readiness review.

## Paused plan — Managed services and sidecar runtime

**Managed services and sidecar runtime.** See the [plan](../research/managed-services-and-sidecar-runtime-plan.md)
and [progress ledger](../research/managed-services-and-sidecar-implementation-progress.md).

- [x] **S/U · S1 — Reconcile current source and activate the first ready implementation gap.**
  Complete milestone S1 from the managed-services plan using this branch's current source; refresh
  coverage for plan sections 1–20 and inherited U01–U12, reusing later implementation evidence and
  marking policy/provider/deployment dependencies precisely. Keep gates disabled and preserve data.

- [x] **S/U · S3/U10 — Require registered host identity before Project runtime work.**
  `ToolSandboxDO.registerWorkspaceRuntime` now rejects a missing or mismatched host-derived name
  and fails closed if the Project runtime registry is unavailable. Agents typecheck and
  `git diff --check` pass; no tests, migration or deployment ran.

- [x] **S/U · S3/U10 — Finish the Project runtime erasure caller audit.**
  Project execution/workspace and sidecar artifact transfer/list/outcome routes register their exact
  host-derived Durable Object names. Direct Project video and scanned-PDF attachment routes now do
  the same for Media and Document sandboxes; Media identity validation matches its
  `attachment-media:…` name. D1 first-touch registration is conditional on no erasure tombstone.
  Feature-off private-state backup/restore, runtime snapshot references, cleanup namespaces,
  provider deletion queues and residual provider/historical namespace limits were reconciled in the
  progress ledger. Agents typecheck and `git diff --check` pass; no tests, migration or deployment ran.

- [ ] **Blocked · S/U · S3/U10 — Regional and deployed erasure acceptance.** The local caller audit
  is complete. Resume after jurisdiction-specific Sandboxes/D1/R2 configuration and access policy
  are approved and an authorized deployed erasure journey verifies each runtime receipt. Cloudflare
  exposes no supported physical snapshot purge in this code; provider snapshot deletion/expiry
  evidence remains separate. Historic sidecar Durable Objects created before registry registration
  cannot be enumerated through a namespace API, so inventory completeness for those objects also
  needs an accepted migration or provider-supported discovery path.

**S1 checkpoint:** the progress ledger now maps sections 1–20 to their owning implementation and
evidence records, and the U01–U12 matrix was reconciled against the current branch. U06–U08 remain
blocked on the absent supported runtime adapter/flush contract; U09's local private-state and
restart metadata remain feature-off; U11's supported cost alerts remain informational; U12's
dependency staging is wired. The source audit found one actionable U10 gap: current Project
execution/workspace callers send a host-derived object name, but `ToolSandboxDO.registerWorkspaceRuntime`
silently skips erasure registration if it is missing. Source review only; no tests, migrations,
deployment or live acceptance ran. This historical gap is fixed by the checked U10 checkpoints below.

**Latest S3/U10 checkpoint:** caller search also found direct Project video and scanned-PDF requests
to MediaSandboxDO and DocumentSandboxDO. Those routes now send the exact runtime identity, and
MediaSandboxDO validates its actual `attachment-media:…` Durable Object name. Runtime identity and
tombstone-conditional D1 registration now cover the reachable execution, workspace, artifact and
attachment paths. The source audit found no further local fix. Regional/deployed acceptance, physical
provider snapshot deletion evidence and discovery of historical unregistered sidecars remain
blocked as detailed above. **Next action:** no S/U source-only task is ready; resume this plan when
one of its recorded runtime, provider, policy or deployment dependencies changes, and recheck the
parked plans for newly ready work.

**S/U remaining-work review:** supported S2 account, grant and entitlement lanes are implemented
locally. U05/U06 still require a supported runtime transport contract; U09 backup use requires
approved key and jurisdiction bindings; U10 has only the regional/deployed/provider limits above;
U11 lacks authoritative invoice/billed-idle feeds and deployed cost measures; U12 awaits CI event
and image-parity evidence. Modal has a separately hosted, gated Node service and local journal, but
no Agents binding/caller or authoritative per-sandbox cost receipt. Its create path remains blocked
until pricing, metering and provider acceptance are defined. Other open S/U rows retain their exact
product, provider and live gates in the plan and progress ledger.

**Queue readiness:** PW worker-branch retention is blocked on owner policy. APW open work is blocked
on cost/quality, retention, task-control or staging acceptance contracts; APW07–APW09 point to
owning plans. S/U has no source-only task: regional/deployed erasure acceptance and historical
namespace discovery need jurisdiction/provider support. SC03 still lacks explicit durable native
invocation consent, alarm-safe current-authority revalidation and pre-dispatch Billing admission;
SC04 lacks owner-approved Space/Project caps. The Unified plan's current executable code work is
tracked by S/U, SC, PW, K, EP, TBR and P; its remaining workspace/runtime acceptance needs authorized
deployed/provider evidence. Preserve `infra/scripts/__pycache__/` and keep rollout defaults disabled.

## Paused plan — Mature Knowledge platform

**Mature Knowledge platform.** See the [plan](../research/mature-knowledge-platform-plan.md) and
[progress ledger](../research/mature-knowledge-platform-implementation-progress.md).

- [x] **K15 — Reconcile managed-index follow-up against scoped retrieval/deletion.** Current
  extension publication filtering and host rehydration are recorded in the K ledger and
  [follow-up](../extension-search.md#follow-up-for-managed-private-indexes). AI Search remains a
  disabled candidate; its metadata map, identifier/list limits, freshness and cleanup contract are
  not proven.
- [x] **K26 — Report actual bounded retrieval result counts.** RAG now emits hit counts on cached
  and uncached search events; Knowledge passes the count through the bounded privacy-safe telemetry
  and records it in Analytics Engine. RAG/Knowledge typechecks and `git diff --check` pass; no tests,
  deployment or live acceptance ran.
- [x] **K19 — Reconcile and fence the signed extension Knowledge search API.** The SDK result includes
  source content hash/revision and bounded citation coordinates. The Knowledge service now fails
  closed if document deletion or publication revision changes during retrieval. Knowledge typecheck
  and `git diff --check` pass; no tests, deployment or live acceptance ran.
- [x] **K18 — Add an owner-only collection-scoped search preview.** Project owners/admins can preview
  up to three passages against one exact published collection revision. The owner route and signed
  extension route share the same pre-ranked document fence, current source/chunk rehydration,
  deletion check and final publication revision fence; the Project Shell displays plain-text source
  passages and line/heading provenance. Knowledge typecheck and targeted Shell typecheck pass;
  `git diff --check` passes. Full Shell typecheck remains blocked by stale `.next/types` references
  to four missing routes. No tests, deployment or live acceptance ran.
- [x] **K20 — Fence Space-shared channel Knowledge grants at result handoff.** Channel dispatch now
  re-reads each used collection revision and the Space-shared installation grant immediately before
  passing passages to the extension runner. A changed or unavailable authority clears all retrieved
  context, records a failed dispatch, and requires human review. Agents typecheck and
  `git diff --check` pass; no tests, deployment or live acceptance ran.
- [x] **K26 — Instrument publication-scoped retrieval outcomes.** The shared extension/owner preview
  helper records fixed surface/outcome labels plus bounded latency and returned-hit count. It emits
  no query or tenant/Space/Project/publication/document/installation identifiers, and Analytics
  errors cannot alter retrieval. Knowledge typecheck and `git diff --check` pass; no tests,
  deployment or live acceptance ran.
- [x] **K21 — Add D1-backed result-cache freshness fencing.** Migration 0284 seeds and advances a
  per-tenant/Space source generation for canonical content, Space/member access, Project ACL,
  publication and website connection changes. Grounded KV and semantic-vector caches bind to the
  exact generation while preserving the separate deletion generation. Knowledge/RAG typechecks and
  `git diff --check` pass. No tests, migration apply, deployment or live acceptance ran; cache gates
  remain false.
- [ ] **Blocked · K21 — Deployed freshness acceptance.** Resume after separately authorized migration
  apply and deployed update/revocation/delete race evidence. Keep cache flags false until accepted.
- [ ] **Blocked · K20 — Agent semantic response-cache identity/effect contract.** Its caller currently
  provides only tenant/Space and query; session memory, Project/user/role and effect/extension-grant
  scope are absent. Resume when a host-owned contract can identify reusable read-only responses and
  their exact authority revisions. Keep both Agents and Knowledge cache flags false meanwhile.
  MS-11 landed the key-only `responseCacheIdentity` (agents `shared/`); still missing before any serving: caller `memoryRevision`, `grantRevision` and read-only effect classification.
- [ ] **Blocked · K15 — Implement and validate isolated managed-index adapter.** Resume after exact
  pre-retrieval scope fields and limits, current publication/source revision mapping, asynchronous
  deletion/retention and isolated cost evidence are established. Keep general user search on its
  current exact D1/Vectorize ACL paths and leave all provider gates off.

**Latest K21 checkpoint:** the D1 source-generation fence is implemented locally across current
content and D1 access/publication mutation paths. The shared Agents response cache remains disabled
because freshness does not establish safe caller/effect identity. No migration or deployment ran.
**Next action:** K21/K20 rollout acceptance remains parked. EP06's exact-install monthly credit and
unpriced resource-unit views are now complete locally; its remaining resource pricing/cap and
provider/live acceptance dependencies are recorded below.

## Paused plan — Extensible platform and managed resources

**Extensible platform and managed resources.** See the [plan](../research/extensible-platform-and-managed-resources-plan.md)
and [platform progress ledger](../research/platform-completion-and-guided-templates-progress.md).

- [x] **EP06 — Show exact-install current-month credit usage against its approved cap.** The owner
  usage route now returns the exact current installation budget revision, month-to-date settled
  `infra_credits`, unexpired held reservations and remaining cap under Billing's UTC month window.
  It uses tenant/Space/Project/install filters. Spaces typecheck and `git diff --check` pass; targeted
  Shell typecheck passes. Full Shell typecheck remains blocked by four stale `.next/types` route refs.
  No tests, deployment or live acceptance ran; resource gates remain off.
- [x] **EP06 — Show exact-install unpriced resource-unit totals.** The owner view now reports this
  UTC month's `extension_resource_requests` as invocations, `extension_resource_jobs` as job units,
  and `extension_resource_bytes` as request/response payload bytes, all scoped to the exact
  tenant/Space/Project/install. No provider cost is inferred.
- [ ] **Blocked · EP06 — Cross-resource quotes and reservations.** Workflow credits are admitted and
  settled through Billing, while resource invocations, job units and payload bytes are recorded
  separately as unpriced usage after the effect. There is no approved resource-unit price or unit-cap
  contract from which to calculate a safe cross-resource quote. Resume after the owner-approved
  resource pricing/cap contract exists; do not convert units into credits locally.
  Update: the owner-approved versioned unit price table (D8, MS-14) has landed locally as `priceExtensionResourceUnits` (mock/local only); quotes and reservations still wait on MS-15 to MS-17.
- [ ] **Blocked · EP06 — Provider cost and deployed lifecycle acceptance.** Owner inventory exposes
  declared/current provider connections, cleanup receipts and bounded job receipts. Provider invoices,
  shared-overhead reconciliation and deployed cleanup/export/uninstall outcomes need authorized
  provider and live acceptance evidence.

**Latest EP06 checkpoint:** the owner view reports exact-install UTC-month settled and held internal
credits, approved cap/revision, invocation totals, job units and request/response payload bytes. The
Spaces worker and targeted Shell typechecks plus `git diff --check` pass. The full Shell typecheck is
still blocked by stale generated `.next/types` references. No tests, migration, deployment, provider
call or live acceptance ran; resource gates remain off.
**Next action:** park EP06's remaining cross-resource pricing/cap and provider/live evidence gates;
resume the active plan shown below.

## Previous plan checkpoint — Template business roles and member onboarding

**Template business roles and member onboarding.** See the [plan](../research/template-business-roles-and-member-onboarding-plan.md)
and [progress ledger](../research/template-business-roles-and-member-onboarding-progress.md).

- [x] **TBR11 — Reconcile direct scheduled-script run-budget admission.** Source inspection found
  the script can invoke nested operations; its Project daily-cap hold is fixed at one credit and is
  created only when that cap is enabled. `settle_run` does not enforce the hold amount, while direct
  jobs cannot receive `max_run_credits` through the owner API. A run-only hold cannot bound nested
  effects, so the scheduled identity/revision alone is insufficient for a consumed per-run ceiling.
- [ ] **Blocked · TBR11 — Atomic per-effect scheduled-script ceiling.** Resume after a host contract
  can bind an owner-approved direct-job ceiling to exact current job identity/revision and consume it
  across nested effects before each effect. Reconciliation must preserve unknown outcomes and actual
  usage; do not borrow creator/owner grants or treat the current post-run usage tally as admission.
- [x] **TBR12 — Prevent duplicate member-onboarding actions.** `SpaceMemberOnboardingPanel` now
  locks concurrent invitation/proposal mutations, disables repeated submit/revoke actions, labels
  the active action, and sets `aria-busy` on the active form/button. The targeted Shell typecheck and
  `git diff --check` pass; no tests, browser, deployment or live acceptance ran.
- [x] **TBR08 — Audit acting-member assistant clamps at extension-resource dispatch.** The current
  Project effective role now gates typed workflow resource operations and direct Gadget operations
  at Agents dispatch: viewers can use only exact read operations; writes and unknown mappings deny.
  Space-only answer caches were removed from `/agent/run` and Knowledge search because they could
  return answers across Project/role scopes. The remaining grounded-result cache includes Project,
  role and user. Agents/Knowledge typechecks and `git diff --check` pass; no tests, deployment,
  provider call or live acceptance ran.

**Latest TBR08 checkpoint:** `WorkflowRunDO` revalidates its actor, membership and installation on
each effect. The Agent host then resolves the current Project role through `enforceRunGates` before
dispatch. Previously the direct `extension.resource.*` and `extension.gadget.*` branches bypassed
the viewer filter in `ScriptToolSurface`; they now allow only exact reads for viewers. The
Space-scoped semantic full-response cache also bypassed that host gate and could return another
actor's Project data; `/agent/run` no longer reads or writes that shared response cache. Knowledge
search also stopped reading its legacy tenant/Space-only answer cache, whose Vectorize filter
omitted Project, role and user. Its grounded-result cache still keys by exact Project, role-rank and
user. TBR08 remains PARTIAL for other channel, provider, cache and delegation surfaces. TBR11's
direct-script ceiling remains blocked on an owner-approved per-effect admission contract.

**Next action:** continue with P05 from the ordered platform plan: trace whether current host
authority can represent Space-shared provider connections across signed dependencies, activation,
owner selection and revocation; do not infer beneficiary, payer or shared authority.

## Parked plan — Platform completion and guided templates

**Platform completion and guided templates.** See the
[plan](../research/platform-completion-and-guided-templates-plan.md) and
[progress ledger](../research/platform-completion-and-guided-templates-progress.md).

- [x] **P05 — Trace Space-shared provider-connection scope.** Reconcile signed Blueprint
  dependencies, activation, owner connection selection and revocation against current host
  authority. **Latest checkpoint:** source trace complete; current records cannot express a safe
  Space-wide connection. See the P05 ledger entry. Keep the broader P05 requirement partial and
  the provider path gated.
- [x] **P06 — Continue the bounded customer voice-package caller.** Reconcile the installed signed
  phone package's owner dashboard and operations against current installation, line, call-pin and
  provider records. The source trace found the existing bounded scope already covers owner-published
  settings, revision history/rollback drafts, synthetic scenarios and exact-install line/call/cost
  status. P06 remains partial for first-party signed distribution/catalog, managed provisioning,
  verified cost/quality and deployed carrier acceptance; those need publisher/provider evidence.
- [x] **P07 — Fail closed on custom worker-model capability claims.** Reconcile the custom-model
  manifest and worker-selection/resume paths. A custom model has no trusted modality/context/tool
  profile today; do not infer capability from its base model or adapter ID. Enforce current private
  route and required-capability fences after saved-session model restoration. The host now rejects
  unsupported required-capability selections, prevents resumed worker settings from changing a
  local-only or BYOK route, and rechecks current model evidence after restoration. Custom-model
  capability selection itself remains unavailable.
- [x] **P08 — Reconcile bounded sampled-frame authorization and quota.** Trace current attachment
  ownership, owner opt-in, feature gate, egress, size/time limits and OCR/visual quota at the route
  and provider handoff. The route now rechecks active Space/tenant, current owner opt-in and egress,
  and the exact unexpired task attachment before media extraction, after extraction and immediately
  before model dispatch. P08 remains partial for deployed MediaSandbox/Workers AI and provider
  acceptance; no gate was enabled.
- [x] **P09 — Reconcile the disabled provider-training action.** Verify imports and every reachable
  `submit_training` caller against the current provider API/account, consent, dataset deletion,
  evaluation and billing contract. The owner lifecycle route reaches SpaceDO, which returns an
  explicit `training_unavailable` 501; import remains a separate existing-adapter path. No provider
  training API or billing call is reachable. P09 remains partial pending a verified provider/account,
  consent/data lifecycle, evaluation and billing contract.
- [x] **P10 — Reconcile signed extension update recovery.** Trace reachable Space-shared and
  Project-bound owner review/apply/status/recovery callers against exact publisher, installation,
  generation, dependency, runtime-drain and update-receipt fences. Implement a missing recovery slice
  only where current records enforce it; preserve unsupported migration/authority changes as gated.

**P10 checkpoint:** Space-shared review binds the signed source/candidate and exact installation; apply
rechecks the current paused version, publisher, candidate artifact, dependency closure and runtime
drain. Gadget migrations use deterministic operation keys and MicroApp receipts; the final pin change
and update receipt are atomic. Owner status lists durable receipts, and a retry with the same review
token returns the matching receipt. Project review/apply binds installation generation, source and
candidate manifest/artifact, publisher key, request ID and runtime drain. The reachable resume action
discovers staged receipts and revalidates the exact staged generation, both signed releases, compiled
artifacts and active publisher key before issuing a fresh token for the same request. Project recovery
is intentionally bound to the original receipt actor; another owner/admin cannot take over without a
separate authority contract. No current-record recovery slice was missing, so no code changed. P10/P24
remain partial for broader authority/connection/price changes, migration policy, cross-tenant artifact
rights, scanning/retention and deployed/live acceptance. Evidence is in the P ledger's P10 checkpoint.

**Parked requirements:** P01/P02 still need operator-attested resource separation, read-only receipts,
per-D1 baselines and deployed isolation; P03/P20 need product policy; P05/P06/P09 need verified
provider/marketplace terms, account and pricing contracts; P07 needs trusted custom-model capability
profiles; P08/P10/P24 retain provider/deployed acceptance and the broader lifecycle contracts. The
remaining P01–P24 dependencies are itemized in the linked progress ledger's current status index.
No additional local source-only P task is ready. Resume when a listed contract/evidence dependency
changes or relevant source changes.

## Reconciled plan — AgentPort managed messaging providers

See the [plan](../research/agentport-messaging-providers-managed-resale-plan.md) and [progress
ledger](../research/agentport-messaging-providers-managed-resale-progress.md).

- [x] **Reconcile current AgentPort and messaging callers.** Trace provider adapter and reachable
  channel/event/session, consent, owner credential, billing, Knowledge and deletion paths against
  the current managed-services, channel, extension and shared-compute records. Separate code gaps
  supported by current authority from provider agreement, account, pricing, jurisdiction and live
  acceptance gates. Do not provision accounts, send messages, buy service or enable a provider.

**Latest checkpoint:** current source has declaration-only generic provider metadata, a disabled
native Cloudflare Email lane, and reachable AgentMail and Telnyx-specific paths. AgentMail event
dispatch carries references and checks owner-selected routes; local unlink clears saved credentials
and revokes AgentPort access but does not erase upstream provider data. No ClawMessenger, Linq, Photon
or Sendblue adapter exists, and no current authority or records support implementing one. No tests or
typechecks ran; `git diff --check` passed. Evidence: the AgentPort messaging progress ledger.
**Next action:** reconcile AP01–AP06 against this branch's provider-neutral SDK, verified-capability
UI and AgentPhone gates. Keep AgentPhone absent and unavailable without verified provider evidence.

## Reconciled plan — AgentPhone and AgentPort adapter evaluation

See the [plan](../research/agentphone-agentport-adapter-evaluation-plan.md) and [progress
ledger](../research/agentphone-agentport-adapter-evaluation-progress.md).

- [x] **AP01–AP06 — Reconcile current capability, SDK and setup surfaces.** The generic operator-
  verified capability gate, provider-neutral typed AgentPort metadata and owner setup-scope UI are
  present. No AgentPhone adapter or current verified provider evidence exists; AP02–AP05 and live
  AP06 acceptance remain provider/API/commercial gates.

**Latest checkpoint:** current source corrects the ledger's stale AP06 generic-code-gap label.
ManagedServicesPanel shows only the newest currently verified capability and explicitly separates
scope from connection/live availability. SDK discovery is provider-declaration metadata only. No
AgentPhone support was found; Telnyx managed and streaming gates remain false. No tests or typechecks
ran; no provider action occurred. Evidence: the AP progress ledger.
**Handoff:** this reconciliation advanced to WhatsApp source tracing, which is complete. Focused
WhatsApp member-phone regression tests were then run and passed; remaining provider/phone acceptance
is blocked by the separate dependencies recorded in that plan. The post-test readiness review found
no next independent local task.

## Paused plan — WhatsApp member routing and extension testing

See the [plan](../../new%20plan/WHATSAPP-MEMBER-ROUTING-AND-EXTENSION-TESTING-PLAN.md).

- [x] **Reconcile current WhatsApp member, customer and test routing.** Trace the current shared
  inbound pairing, provider webhook, contact verification, membership/Project checks, extension
  execution, simulation and replay callers. The source review and first supported inbound-routing
  fixes are recorded in the [progress ledger](../research/whatsapp-member-routing-and-extension-testing-progress.md).

- [x] **Add one-turn customer extension simulation.** The Channels panel now runs the exact active
  WhatsApp handler through the no-capability isolate for an owner/admin with project access. Reply,
  answer-request and session-update outputs are staged for display; Knowledge/model answering,
  attachment reads, provider delivery and persistent session writes are excluded. Agent and
  targeted Shell typechecks passed; the full Shell typecheck still reports stale `.next/types`
  imports for missing generated routes. No tests, provider actions or deployment ran.

- [x] **Add member grants and verified contact routing.** Requires a multi-Space/project sender
  selection model that preserves the plan's per-member identity and current membership checks; do
  not reuse executive contacts or infer ownership from pairing.

  - [x] Add admin-managed WhatsApp member grants for Space or exact Project scope, including
    revisioned audit events. This grants record is not yet used to route inbound messages.
  - [x] Add member-started, short-lived single-use contact verification and a separate hashed
    multi-Space sender map. The signed inbound code proves contact control and binds the sender to
    the requesting member and Space; it does not use pairing or executive-contact records.
  - [x] Route verified senders to the current granted Space/Project assistant. Multiple choices
    require a sender-scoped, 30-minute `USE` selection. The Agent DO rechecks the exact contact,
    grant, Space membership, channel state, Project membership and current selection before
    transcript persistence, assistant execution and reply delivery.
  - [x] Add owner/member setup and route visibility, and an explicit Customer service only versus
    Staff and customers connection mode. The Channels panel manages exact-scope grants, self
    verification/replacement/revocation, current route selection and last successful use. The
    connection mode gates member and executive routing; customer-only inbound uses the customer
    extension path or remains in human review.

- [x] **Add isolated conversation replay.** The owner/admin Project inbox now replays a selected
  WhatsApp event through the current signed installation in a fresh isolate conversation. Active
  settings and optional current session state are snapshotted; edited input is transient. Replies,
  answer requests, Knowledge and tool behavior are staged through no-op simulation adapters. No
  provider effects or session writes run. The audit retains only bounded metadata and conversation
  deletion clears linked audit rows. Agents/Spaces typechecks and `git diff --check` pass; full Shell
  typecheck reports only stale `.next/types` imports for four missing routes. No tests, migration,
  provider action or deployment ran.

- [x] **Add a customer-service WhatsApp SDK example.** Build a versioned channel-only package
  example with owner-approved scoped Knowledge, bounded session state, staff escalation through the
  host inbox and documentation of the synthetic test/replay surfaces. Do not include provider
  credentials or claim unverified live behavior.

- [ ] **Blocked · Add bounded WhatsApp member phone testing — live acceptance.** Source routing and
  focused local regression coverage are complete; migration and real phone/provider acceptance
  remain open under the dependency below. Offer an optional, expiring single-use entry
  challenge for an authenticated member's verified sender, exact destination, Project and active
  extension installation. Keep every test turn on the customer handler before privileged routing;
  support explicit exit/revocation and show test status in the dashboard and chat.

  - [x] Implement source routing and status. Redemption runs before pairing, verification, member
    selection and executive commands. Test turns use their pinned customer handler and an isolated
    conversation/memory scope; the Agent DO rechecks current membership, grant, contact, destination,
    channel binding and installed version before handling and delivery. Explicit chat/dashboard exit,
    access-change revocation, retry receipts, inbox marking and chat labels are wired.
  - [x] **WhatsApp member-phone local regression tests.** A real-SQLite in-memory D1 fixture covers
    challenge redemption before pairing, duplicate provider retry, expired challenge, pinned
    customer-handler dispatch with executive routing disabled, active-session expiry/revocation, and
    idempotent exit. The Agent DO rejects a session when its current-authority check fails. Three
    Agents suites pass 20/20; Agents typecheck and `git diff --check` pass. No remote migration ran.
  - [ ] **Blocked — migration and live phone acceptance.** Requires separate authorization to apply
    migration `0289`, a configured test account, and provider/UI acceptance. No migration, provider
    message or deployment has run.

**Latest checkpoint:** source implementation now redeems challenges on the signed WhatsApp platform
webhook before pairing, verification, member route selection or executive commands. Active turns
forward only to the pinned customer handler with executive routing disabled and a separate Agent DO
conversation/memory scope. The Agent DO revalidates the contact, grant, Space/Project membership,
exact channel binding, test expiry and installed package version before handling and again before
answer, delivery and state persistence. Chat shows active/exit labels, the Project inbox marks test
events, and contact/grant/mode/channel/extension changes close active sessions and consume pending
challenges. Provider retry receipts retain only HMAC event keys for seven days. Migration `0289`
remains unapplied. The local follow-up adds webhook and Agent DO regression fixtures; three Agents
suites pass 20/20, Agents typecheck and `git diff --check` pass. Provider fetches are intercepted;
no provider message, migration, deployment or live phone acceptance ran. **Resume condition:** obtain
separate authorization to apply migration `0289`, configure a test account and authorize provider/UI
phone acceptance.

**Readiness review after the local tests:** all remaining unchecked plan items were rechecked against
their current queue entries and ledgers. The first pass found no independent local task; a final APW07
review identified a barrier-driven publication-race regression that does not require external policy
or provider access, so the queue now selects that task. Other remaining work depends on
policy/product contracts, jurisdiction/provider discovery, external pricing/API evidence, live
deployment access or practitioner validation. Their exact dependencies and resume conditions are
recorded in each plan section.

## Paused plan — Commercial cleaning Space template

See the [plan](../research/commercial-cleaning-space-template-plan.md) and [progress ledger](../research/commercial-cleaning-space-template-progress.md).

- [x] **Reconcile the existing Space Template and extension source.** The SDK has a portable,
  secret-free `SpaceBlueprint` contract and a private reference-template pattern. No commercial
  cleaning template, domain records, or operational integrations exist. Marketplace and runtime
  machinery is generic; it does not prove an installed vertical workflow. The source map and exact
  first slice are recorded in the progress ledger.
- [x] **Add the first fictional operations demo Blueprint.** Use one pilot project with synthetic
  site, scope, shift, inspection and blocked-work records plus a review packet. Keep it data-only:
  no credentials, connections, access grants, purchases, live sends or safety instructions. The SDK
  typecheck and `git diff --check` pass; no tests or activation ran.
- [ ] **Blocked — operational workflow and pilot validation.** Resume after practitioner discovery
  establishes the approved site/visit/correction records and transitions, and focused tests are
  requested. Partner contact, payment, provider setup and deployed acceptance remain separately
  unauthorized.

**Latest checkpoint:** added and exported the private `COMMERCIAL_CLEANING_OPERATIONS_SPACE_TEMPLATE`
with synthetic site, scope, shift, blocked task, inspection, exception and unsent client-update
fixtures. It has no credentials, connectors, permissions or live writes. SDK typecheck and
`git diff --check` pass. No tests, activation, partner contact, payment or provider operation ran.
**Next action:** wait for practitioner-approved operational records/transitions and requested test
coverage before extending this vertical workflow. The queue advances to the corporate-recovery
claims prototype.

## Paused plan — Corporate recovery claims prototype

See the [plan](../research/corporate-recovery-claims-prototype-plan.md) and [progress ledger](../research/corporate-recovery-claims-prototype-progress.md).

- [x] **Reconcile the current template, document and evidence source.** No vertical claims register,
  correction workflow, page-provenance store or brief generator exists. Generic Knowledge, document
  and artifact services do not establish those behaviors. The source map and partner/legal gates are
  recorded in the progress ledger.
- [x] **Add a private synthetic claims-review demo Blueprint.** Include the fictional claim/ledger
  variance, duplicate reference, missing document, ambiguous field, second currency and a review
  packet. Label legal/status conventions illustrative. Keep it data-only without real parsing,
  persistence, permissions, legal decisions, credentials or external effects. The exported SDK
  Blueprint includes source-indexed fictional fixtures, a USD 6,000 variance, explicit missing
  delivery record, duplicate candidate, unreadable invoice suffix, separate EUR claim, illustrative
  status labels and draft meeting brief. SDK typecheck and `git diff --check` pass; no tests ran.
- [ ] **Blocked — Functional claims register and evidence workflow.** The plan's import, correction
  history, role isolation, revised brief and export require a separate source design beyond the
  static data-only Blueprint. Resume after the owner selects that functional scope and practitioners
  validate the status/checklist language and access contract; request focused tests before making
  behavioral guarantees. No practitioner contact or real data is authorized.

**Latest checkpoint:** added and exported `CORPORATE_RECOVERY_CLAIMS_DEMO_SPACE_TEMPLATE` with
fictional claim and ledger records, page/excerpt references, an explicit missing delivery item,
ambiguous invoice suffix, duplicate candidate, separate-currency example and simulation-only review
packet. Ledger rows reconcile to USD 42,000; the displayed variance is USD 6,000. The SDK typecheck
and `git diff --check` pass. No tests, practitioner contact, real data, listing, payment or live
effect ran. **Next action:** hold functional workflow work until its scope, practitioner-validated
status/checklist language and access contract are approved, then request focused test coverage.

## Previous plan checkpoint — Resumable workers, durable workflows and branches

See the [plan](../research/resumable-workers-durable-workflows-and-branches-plan.md) and
[progress ledger](../research/resumable-workers-durable-workflows-and-branches-progress.md).

- [x] **PW01–PW06 — Source-to-ledger reconciliation.** Current code matches the saved summaries for
  branch/runtime routing, goal graph and signed communication, named leases, checked integration,
  per-attempt usage receipts, and exact-attempt publication permits. Remaining gaps and the source
  evidence are in the PW ledger. No runtime/deployed acceptance is inferred.
- [x] **PW06 — Direct scheduled-script pre-effect revision fence.** After policy and Project spend
  admission, the direct scheduled-script path rechecks the persisted service session and exact
  enabled job revision/script immediately before `tools.run`. A stale or unavailable authority
  attempts zero settlement for the Project spend reservation and fails closed. Agents typecheck and
  `git diff --check` pass; no tests or deployed acceptance ran. This fence cannot cancel an operation
  after it starts.
- [x] **PW06 — Scheduled direct-script outcome reconciliation.** Before direct dispatch, one D1 batch
  records the exact run identity, authorization revision and bounded attempt receipt in both the
  dispatch claim and run history with `outcome_unknown`. Later sweeps stay blocked until an
  owner/admin resolves that exact run with evidence. Ambiguous responses and script-level failures
  remain unknown; no provider rollback or completion is inferred. Agents and Spaces typechecks,
  Shell source-only typecheck and `git diff --check` pass; no tests or deployed acceptance ran.
- [x] **PW01 — Require an immutable Coordinator base for Project worker branches.** Project worker
  spawning now requires the unified-workspace flag and Coordinator binding before reserving the
  parent task branch; worker-branch reservation repeats the guard. The legacy R2 seed path cannot
  dispatch a Project worker. Agents typecheck and `git diff --check` pass; no tests or deployed
  acceptance ran.
- [ ] **Blocked · PW01 — Worker-branch retention and deletion semantics.** The current ledgers do
  not define an approved branch TTL or deletion policy. Preserve staged branch content; resume when
  the applicable owner approves retention, cleanup and recovery semantics. D9 (owner-approved
  2026-11-25) now defines 7 days after publication and 30 days after failed/terminated end; MS-20
  landed the local slice (Coordinator `/v1/branch/retire`, flag-gated alarm sweep, NaelaoAgentDO
  retire calls) behind `WORKER_BRANCH_RETENTION_ENABLED`, default off. Local evidence only; live
  enablement and deployed acceptance remain.
- [x] **PW02 — Correlate directed help requests with durable replies.** Task-blackboard messages can
  include an authenticated reply reference. The transaction checks the original question/blocker
  was addressed to the replying worker and the reply includes the original sender; existing host
  recipient grants still apply. Original and reply messages remain separate durable records, and
  goal activity UI displays the linked request. Agents typecheck, Shell source-only typecheck and
  `git diff --check` pass; no tests or deployed acceptance ran.
- [x] **PW02 — Recheck private-Project access for goal activity messages.** The route now forwards
  the authenticated caller role and AgentDO rechecks current Project read scope before projecting
  each Project-backed goal. Revoked/denied scopes omit that complete goal; thrown authority errors
  return 503. Agents worker typecheck and `git diff --check` pass; no tests or deployed acceptance
  ran.

**PW02 checkpoint.** Goal Activity now revalidates the actor's current Project read scope inside
`NaelaoAgentDO.handleGoalActivity` before reading and returning a Project-backed journal, task
projection or blackboard messages. The authenticated route forwards the caller role for the
membership and Project authority check. A denied scope filters the entire goal; an authority
exception returns 503. Agents worker typecheck and `git diff --check` pass. No tests, deployment or
live acceptance ran.

The PW plan has no remaining ready task: worker-branch retention/deletion remains blocked pending
an approved owner policy. The APW plan remains parked because its open cost, retention and live
acceptance work has explicit dependencies, while APW07–APW09 overlaps owning plans. The next plan
in the ordered list is S/U.

## Previous plan checkpoint — Adaptive planner, worker coordination and memory

**Adaptive planner, worker coordination and memory.** See the [plan](../research/adaptive-planner-worker-swarm-memory-plan.md)
and [progress ledger](../research/adaptive-planner-worker-swarm-memory-progress.md). APW01 was
reconciled in that ledger. Existing partial implementations remain recorded there.

- [x] **APW02 — Host admission for dynamic goal graph expansion.** Structured proposals can add at
  most three one-level children under the 12-task graph limit. The host derives stable child identity
  and authority, checks the parent's unused worker-token budget, actor scope, decision references and
  Billing path at admission, then rechecks authorization, decisions and Billing path at dispatch.
  It persists task membership/grants and serializes admissions against the graph limit. Expansion remains disabled
  unless explicitly enabled. See the APW ledger's 2026-11-23 checkpoint.
- [x] **APW02 — Goal-run evidence joins and report-only routing history.** Verification, queue/execution
  timing, worker model tokens/budget and internal-credit usage now join through stable task worker IDs.
  Progressive concurrency changes retain a bounded 32-entry journal history with the triggering task
  outcome and verification outcome where available. This is report-only; no routing behavior changed.
- [ ] **Blocked · APW02 — Cost-aware routing selection.** Do not tune concurrency from internal credits
  until a per-goal spend objective and a controlled quality/cost comparison baseline are defined. The
  current receipts are observable, but include unpriced events and do not represent provider invoices.
  Resume after the comparative evaluation contract supplies those inputs; keep progressive routing
  disabled meanwhile.
- [x] **APW02 — Hierarchical planner tree.** Root graphs admit at most four depth-two planners;
  nested planners can create leaf tasks only. Each graph remains capped at 12 tasks, and nested child
  task-token allocations sum within the assigned parent-task ceiling. The delegated child receives
  that assigned ceiling in its host context; signed scope and caller authorization remain inherited.
- [x] **APW02 — Safe cancellation of redundant workers.** Explicit independent `redundancy_group`s can
  stop remaining work after a completed and verified result. Dispatch cancellation is fenced in the
  durable outbox and exact-attempt child start check; late results and uncertain effects remain visible.
  `GOAL_REDUNDANT_CANCELLATION_ENABLED` is off by default.
- [x] **APW02 — Comparative protocol and deterministic fixture.** The paired protocol and local
  scheduler/evidence fixture compare one-worker, sequential and adaptive arms with synthetic tasks,
  host evidence, lost-ack recovery, latency and resource exclusion. It records no model-quality,
  provider-cost or deployed-runtime claim. See the [protocol](../benchmarks/adaptive-goal-routing-comparative-protocol.md)
  and APW ledger follow-up.
- [ ] **Blocked · APW02 — Real-runtime/provider comparative acceptance and cost-aware routing.** Resume
  after staging runtime/provider access is available, a per-goal spend ceiling and quality/latency
  thresholds are approved, a powered representative task set and blinded rubric are frozen, and
  provider usage can be reconciled to invoices. Keep progressive routing, dynamic expansion and
  redundant-worker cancellation disabled until separately accepted and authorized.
- [x] **APW03 — Goal task branch lineage projection.** Goal activity now joins the exact worker row
  only after checking parent-run, tenant, Space, actor and Project scope. It shows the branch base,
  recorded checkpoint pin, checked validation receipts and publication attempt status without
  exposing worker output. The UI labels the checkpoint as recorded and not rechecked for freshness.
  See the APW03 ledger follow-up.
- [x] **APW03 — Conflict review and owner decision controls.** The existing worker conflict receipt
  already has fresh version previews, expected-hash checks, reviewer-authored resolution and checked
  publication. Added a Project Journal decision register panel with exact-revision approve/reject,
  explicit supersession and workspace-pin rechecks. Stale proposals can be rejected, never approved.
  See the APW03 ledger follow-up.
- [x] **APW04 — Memory source provenance audit.** Knowledge source adapter,
  source revision, source hash, grant revision and chunk hash now flow through scoped search,
  citations and agent citation metadata. Project, Space and personal memory adapters expose stable
  row IDs and update/create timestamps but no content revision/hash; those exact gaps are in the APW
  ledger. Local/mock verification is recorded in the APW ledger; timestamps remain freshness
  metadata, not immutable revisions.
  See the APW ledger follow-up.
- [x] **APW04 — Retention invalidation and context privacy evaluation.** Recall validates promoted
  semantic vectors against live actor-scoped SQLite rows, so failed vector cleanup cannot restore a
  deleted note. Local tests also cover bounded actor-filtered ingress, role-gated facts, denial of
  Project Knowledge retrieval before search without membership, and isolation of fact/Fabric/Wiki
  recall between Projects. See the APW ledger follow-ups.
- [ ] **Blocked · APW04 — Retention schedule approval.** Personal and Project Fabric/Wiki plus
  promoted vectors have no approved TTL or erase schedule; current code only decays facts and caps
  unpromoted episodes. Resume after a retention owner approves per-class duration and deletion
  semantics. Do not introduce a new expiry without that policy. Under D9 (owner-approved 2026-11-25) the run-log retention slice (MS-21) has landed locally behind `RUN_LOG_RETENTION_ENABLED` (default off); Project-memory retention (MS-22) has landed locally behind `PROJECT_MEMORY_RETENTION_ENABLED` (default off): SpaceDO migration 163, a deletion tombstone, an owner/admin memory hold and a bounded alarm sweep of 30-day-deleted Projects; personal memory, live acceptance and the live schedule remain open.
- [x] **APW05 — Goal/task and runtime admission/accounting comparison.** Goal workers inherit bounded
  token budgets and ordinary model calls reserve against configured Project spend caps or plan token
  quotas; System One decisions use separate durable Billing holds. These do not define an aggregate
  per-goal credit ceiling. Dynamic extension workflows have owner-set
  run/monthly credit budgets and durable reservations; default AgentTaskWorkflow initializes its
  workflow journal without a run-credit budget. Its optional session ceiling is checked before a
  run and incremented after settlement, not atomically reserved. Shared compute enforces configured
  global/tenant limits and has hierarchical tenant/Space/Project/actor promotion, but no task
  priority weights. Exact path comparison and blockers are recorded in the APW ledger.
- [ ] **Blocked · APW05 — Aggregate goal credits and cost-aware scheduling.** No approved per-goal
  or per-task credit ceiling, cost/quality objective, or task-priority weights exist. Resume after
  those policies and their exact Billing reservation contract are approved; keep model/runtime
  cost selection and automatic thrash control disabled meanwhile. MS-18 local slice landed (flag
  `GOAL_CREDIT_CEILING_ENABLED`, off): a per-goal 200-credit ceiling gates task dispatch and an
  owner/admin raise route resumes it. MS-26 landed locally (same flag): a budget-held goal reports the existing `awaiting_approval` run status with `pending_budget_approval` (never completion) and a raise re-enters the same goal journal once; live Billing reservation acceptance remains.
- [ ] **Blocked · APW05 — Provider USD acceptance.** Internal credits and per-inference price
  snapshots are not invoice-reconciled provider charges. Resume with staging/provider access,
  representative controlled task runs, approved thresholds and reconciled invoices; reuse the APW02
  comparative protocol and blocker rather than duplicating its evaluation.
- [x] **APW06 — Goal decision-hold remediation.** Goal task rows map stale/missing decision reasons,
  display the exact referenced IDs/revisions and link directly to the Project Journal review panel.
  The link does not mutate or resume the task; the existing Project route rechecks current access,
  proposal revision and workspace pin. Source-only Shell typecheck and `git diff --check` pass;
  local UI evidence only, no browser/deployed acceptance.
- [x] **APW06 — Authorized conversation stop control.** The processing-task stop sends the task/run
  ID through the existing conversation-scoped cancel route. The route requires Space membership or
  access to that exact session; AgentDO persists `cancelling`, signals the active operation and the
  loop checks cancellation at step boundaries. The UI warns that in-flight work may finish or be
  interrupted, committed external effects are not undone, and the final result must be reviewed
  before retry. Project task activity remains read-only for run control.
- [ ] **Blocked · APW06 — Project task pause/cancel controls.** Project list/detail authorization
  permits status viewing, not mutation. The generic `WorkflowRunDO.cancel` path is not public and
  can terminate a workflow without reconciling `TaskDO`; goal-DAG cancellation is only for redundant
  workers. Resume after an owner/admin authority contract and a durable task/workflow cancellation
  receipt define status reconciliation and uncertain-effect review. Keep Project task controls
  read-only until then. **Stop slice landed locally (MS-07):** owner/admin or Project-owner `POST /spaces/:spaceId/projects/:projectId/task-stop` forwards to the conversation AgentDO stop and writes a durable `task_control_receipts` row (`stopped`, `already_terminal`, `uncertain`); pause/resume stay out of scope and `WorkflowRunDO.cancel` stays unused. Mock/local evidence only.
- [ ] **Blocked · APW06 — Topology and budget preferences.** User/admin preferences need an approved
  authority and precedence contract before changing worker count, model/runtime routing or budget.
  Resume when that contract is approved; keep existing rollout defaults unchanged. Local slice MS-23 landed: a pure precedence resolver (`workers/agents/src/shared/worker-preferences.ts`, 19/19 tests); Local slice MS-24 landed: SpaceDO migration 164 plus Space limits, Project override, own-user preference and owner/admin audit routes with bounds validation and one audit row per change (mock/local evidence); Local slice MS-25 landed behind `WORKER_PREFERENCES_ENABLED` (off): goal start snapshots the resolved preferences on the goal journal and applies them to worker capacity, model tier policy and the MS-18 ceiling (mock/local evidence); live acceptance and enabling the flag remain.
- [ ] **Blocked · APW06 — Real-runtime/deployed acceptance.** Resume with staging runtime access and
  separately accepted pause/cancel and task-control behavior; do not treat local/mock UI evidence
  as live acceptance.
- [ ] **APW07–APW09 — Cross-plan integration, recovery, and evaluation.** A bounded Goal Activity
  review signal now flags completed workers with distinct reported paths under the same exact Project
  decision revision. It is explicitly untrusted, review-only, and does not establish semantic conflict
  or authorize publication. Deterministic candidate classes (same path, migration, dependency
  manifest, exported interface, unknown) landed locally as `workerOutputConflictCandidates`; still
  untrusted and review-only, and the owner-approved taxonomy for confirmed conflicts remains open.
  Its test passes 3/3; Agents/Shell typechecks and `git diff --check` pass.
  Full APW07 classification still needs an APW/PW-approved evidence taxonomy, including interface
  evidence and uncertainty handling. The barrier-driven publication-race test and source-base
  validation lineage are complete. Validation
  receipts pin source base/commit, target revision/manifest, candidate and validation heads, command
  digest and publication outcome. Coordinator conflict reasons cover deterministic text/path/content
  collisions, not semantic/interface conflicts across files; resume classification after APW/PW owners
  approve the evidence taxonomy, candidate-versus-confirmed states, uncertainty handling and whether
  any classifier may use an existing task budget. Keep every classification untrusted and review-only.
  The local Node fixture does not exercise parent-DO permit storage against a real Coordinator DO;
  resume with authorized multi-DO staging access and cancellation before/after the permit. APW08 local
  budget, saved-scope, current-route, workspace-pin, access-gate, approval-resume fencing and interrupted-
  resume recovery tests are complete. User-facing pause/resume/approval still needs an owner/admin authority and durable
  status/effect-reconciliation contract; template/SDK topology declarations need a reviewed
  reusable-definition contract. Real interruption acceptance needs the deployed runtime. APW09 still needs a frozen representative
  quality/economics evaluation, complete provider-charge reconciliation and authorized real-runtime
  acceptance. Track each slice in PW, EP, workflow, platform, SC and TBR as applicable; see the APW
  ledger for the requirement mapping.
- [x] **APW07 — Barrier-test cancellation during an authorized publication request.**
  `worker-integration-validation.test.ts` pauses the simulated Artifact Worker request after
  `authorizePublication` returns, cancels while that request is pending, then releases it and checks
  the publication result is recorded without claiming rollback or replay. The focused suite passes
  16/16; Agents typecheck and `git diff --check` pass. This is local helper/host-contract evidence,
  not real DO storage concurrency or deployed Coordinator acceptance.
- [x] **APW07 — Preserve the worker source-base pin in validation lineage.** Validation receipts now
  carry the actual source-branch parent, Coordinator revision and manifest hash; the safe Goal Activity
  projection validates pins against the current lineage while preserving legacy receipts without a
  pin. Focused validation/lineage/route/delegation tests pass 39/39; Agents typecheck and
  `git diff --check` pass. The delegation test fixture now dispatches through its declared local model.
  This is local source evidence only; no real multi-DO Coordinator acceptance ran.
- [x] **APW08 — Revalidate resumed-worker token budget.** Tests prove a resumed worker receives the
  lesser of its saved budget and the current parent budget, minus prior token use; a zero remainder is
  denied without dispatch. `delegation-admission.test.ts` passes 17/17, Agents typecheck and
  `git diff --check` pass. This is local recovery evidence, not deployed runtime acceptance.
- [x] **APW08 — Revalidate saved worker scope on resume.** Actor and Project mismatch fixtures prove a
  resumed worker is rejected before dispatch when its saved scope differs from the current parent
  request. `delegation-admission.test.ts` passes 19/19, Agents typecheck and `git diff --check` pass.
  This verifies scope matching locally; live membership/grant revocation and runtime acceptance remain
  separate.
- [x] **APW08 — Revalidate a resumed worker's runtime route.** A saved remote model is rejected under
  the current local-only parent policy before any child request; prior token usage is preserved.
  `delegation-admission.test.ts` passes 20/20, Agents typecheck and `git diff --check` pass. This is a
  local policy-fixture test; live route/capability acceptance remains separate.
- [x] **APW08 — Revalidate saved workspace checkpoint pins during resume.** Regression cases with a
  changed revision or manifest hash prove the saved payload is withheld from the resumed child and a
  stale-checkpoint notice is used instead. `delegation-admission.test.ts` passes 22/22, Agents
  typecheck and `git diff --check` pass. Coordinator pin reads are mocked; live workspace acceptance
  remains separate.
- [x] **APW08 — Revalidate current Project access on resumed worker execution.** The child execution
  gate reads current Project assistant access for each attempt; direct gate tests prove revoked access
  and an unavailable authority both fail closed. `worker-run-access-revalidation.test.ts` passes 2/2,
  Agents typecheck and `git diff --check` pass. The unit test does not simulate actual child-DO
  dispatch, live membership revocation or deployed acceptance.
- [x] **APW08 — Preserve delegated approval-resume fencing.** Continuation context now carries the
  HMAC-bound worker attempt and runtime capability, plus signed resume authorization after HITL
  resolution. The parent start check atomically moves only the exact waiting attempt to `running`;
  duplicate, stale-attempt and unmarked fresh-run requests are denied. Four focused suites pass
  30/30; Agents typecheck and `git diff --check` pass. These are local fixtures, not cross-DO runtime
  acceptance.
- [x] **APW08 — Revalidate the resumed worker's runtime capability.** A worker's signed preferred
  capability is matched against the current Project runtime inventory and installed binaries before
  dispatch. A regression removes `ffmpeg` from the current inventory and proves the managed command
  fails without using a stale image or external machine; the approval-resume fixture separately
  proves the signed capability is forwarded in continuation context. The environment,
  approval-context and delegation-contract suites pass 28/28; Agents typecheck and `git diff --check`
  pass. These are local fixtures, not deployed capability acceptance.
- [x] **APW08 — Recover a claimed approval continuation after DO interruption.** A persisted
  `resuming` checkpoint reuses its saved continuation run ID; partial continuation tokens are
  included in the remaining-budget check. The parent records that exact resumed run ID and accepts
  only it for an idempotent start-check after recovery; other fresh IDs remain denied. The recovery,
  parent-admission and delegation-contract suites pass 29/29; Agents typecheck and `git diff --check`
  pass. Local fixtures do not simulate actual DO eviction or deployed recovery.
- [x] **APW08 — Remaining recovery and topology readiness review.** Current source confirms delegated
  `long_running` work has no wall-clock deadline; its expiry, approval-wait and resume semantics need
  an owner-reviewed contract. SDK `workerRoles` bind primitives but do not define reusable task/workflow
  topology; APW/PW/TBR owners must review the versioned schema, topology/model/capability/evidence/
  communication fields, reuse lifecycle and host-only authority/budget rule before implementation.
  Local approval recovery is covered, while real DO eviction/cross-DO/provider-effect acceptance needs
  authorized staging bindings and a disposable effect fixture. No independent APW08 code gap remains.
  See the [APW ledger](../research/adaptive-planner-worker-swarm-memory-progress.md).

**Latest checkpoint:** APW07 now projects bounded, untrusted shared-decision/distinct-path review
candidates in `0abb4433`; route and helper regressions pass 9/9 in pushed commit `4e040d97`, Agents
and Shell typechecks pass, and `git diff --check` passes. The authorized Goal Activity caller receives
the candidate; a different actor receives no goal. Full classification remains blocked on the APW/PW evidence contract.
On remote tip `9a1ea1a1`, `worker-integration-validation.test.ts`,
`environments.test.ts`, `delegation-contract.test.ts`, `worker-run-access-revalidation.test.ts`,
`delegated-worker-approval-resume.test.ts` and `delegation-admission.test.ts` pass **70/70**;
Agents typecheck and `git diff --check` pass. This is local revalidation only. APW08 deadline,
reusable SDK/template definition, and live recovery contracts
were reconciled against current sources and APW/PW/TBR owners; no additional source-only change is
ready until the owner-reviewed duration and definition contracts exist. APW07 source-base validation
lineage is preserved and projected safely; four
focused suites pass 39/39. APW08 budget/scope/route/pin tests pass 22/22, current Project access gate
tests pass 2/2, and delegated approval-resume contract/start-fence suites pass 30/30. Agents typecheck
and `git diff --check` pass. No real multi-DO publication race, live membership revocation, actual
Coordinator pin read, actual DO eviction/recovery or interruption runtime ran. The resumed preferred-
runtime capability suites pass 28/28. Approval continuation recovery, parent start-fence and contract
suites pass 29/29; Agents typecheck and `git diff --check` pass. **Exact next action:** resume APW07
after APW/PW owners approve its conflict evidence taxonomy; then implement and test the approved
classification mechanism. Keep APW08 deadline/definition contracts and all live acceptance gates open.

**APW checkpoint history.** APW06 goal decision-hold remediation adds a status explanation with
exact decision references and revisions plus a direct link to the Project decision review panel. It
adds no review write or task-resume path; the existing Project route retains access, exact-revision
and workspace-pin checks. APW06 conversation stop semantics and Project-control limits are recorded
above and in the APW ledger.

APW05 source reconciliation confirms that goal tasks have bounded token budgets; ordinary model
calls reserve against configured Project spend caps or plan token quotas, and System One decisions
use durable per-call Billing holds. These do not define an aggregate goal credit ceiling. Dynamic
extension workflows have owner-approved per-run/monthly budgets and durable reservations; default
AgentTaskWorkflow has no run-credit hold, and its optional session ceiling is a pre-run check plus
post-run tally increment rather than an atomic reservation. Existing shared-compute capacity limits
and hierarchical promotion do not include task priority weights. Exact blockers and evidence are in
the APW ledger. APW05 remains partial and unchecked.

APW05 comparison is source inspection only, with no deployed Billing or provider acceptance. The
APW04 local test evidence remains in its ledger; no retention schedule was invented.

**APW resume conditions:** return when an approved aggregate cost/priority policy, retention
schedule, task-control authority/recovery contract, or staging acceptance access becomes available.
APW07–APW09 implementation remains owned by PW, EP, workflow, platform, SC and TBR plans.

The existing **SC03** synchronous capacity retry was reconciled as implemented in `f9a2a02a`.
Track detached dispatch separately in the [shared compute ledger](../research/shared-compute-scheduling-and-budget-progress.md).
It needs durable invocation authority, alarm-safe revalidation and fresh Billing admission.
Keep disconnected replay disabled while those prerequisites are open.

## Paused plan — Planner investigation and worker reuse

See the [plan](../research/planner-investigation-and-worker-reuse-plan.md) and record implementation
evidence in the [APW ledger](../research/adaptive-planner-worker-swarm-memory-progress.md). This
entry supplements existing APW/PW/TBR requirements and uses their IDs.

- [x] **APW01/APW02 — Audit and enforce the planner investigation boundary.** Trace current Project,
  Space and nested planner callers, then deliver one locally verified host boundary slice around an
  existing exact decision or goal/evidence lookup. Migrate legitimate discovery callers to workers
  and close the corresponding planner `Read` and virtual CLI bypasses. Continue with supported
  exact workspace excerpts and verify invocation as well as tool discovery.
  - [x] **APW01/APW02 — First exact Project decision read.** Added `project_journal.read_decision`
    and `naelao project decision <id> --revision <n>` for Project planners. It derives Project scope
    from the run, returns one exact decision revision with its read-time workspace status, and denies
    planner `Read`, aliases, and virtual shell file inspection. Four focused suites pass 49/49;
    Agents typecheck and `git diff --check` pass. Pushed as `fee19873`.
  - [x] **APW01/APW02 — Direct alias, virtual shell and resume audit.** Confirmed persistent and
    nested planner scope is host-set in `NaelaoAgentDO`; delegated planner identity is included in
    the signed delegation contract and revalidated on resume. `ScriptToolSurface.run` gates raw
    operation names before dispatch, Code Mode authorization maps `storage.read` through the same
    gate, shell pipelines authorize each command, redirects/listings authorize file access, and
    saved commands are authorized before their source is loaded. Added regressions for `code.execute_bash`,
    pipeline and input-redirection reads, saved-command lookup, Code Mode tool caps and signed planner
    mutation. Five focused suites pass 53/53; Agents typecheck and `git diff --check` pass. Local
    checkpoint pending. No further broad planner file/domain reader was found on these paths.
  - [x] **APW01/APW02 — Bounded exact workspace excerpt.** Added Project-only
    `project_journal.read_workspace_excerpt` for one normalized path, immutable revision and bounded
    line range. It rejects non-text/binary payloads and caps each response at 8 KiB, with host-owned
    per-run admission of four calls and 24 KiB total requested response bytes. Stale revisions are
    marked; absent/deleted, unsafe and unpinned reads fail closed. Three focused suites pass 31/31;
    Agents typecheck and `git diff --check` pass. Local checkpoint pending push.
  - [x] **APW01/APW02 — Thread coordination scope.** Project planners now have their list/search
    selectors clamped to the run's Project; exact thread reads reject foreign Project/Space targets
    before fetching messages. Broad Space thread listings now filter private Projects using the
    viewer's membership/owner role. Project coordination and thread hierarchy suites pass 71/71;
    Agents and Spaces typechecks pass. Local checkpoint pending push.
  - [x] **APW01/APW02 — Project worker roster scope.** The roster now filters Space agent definitions
    by a non-empty current Project `allowed_agent_ids` list (including its default agent), preserves
    the general assistant, and fails closed if Project scope cannot be read. A disallowed consult
    target is rejected before dispatch. Task blackboard remains worker-only; Goal Activity is actor
    indexed and rechecks Project access; evidence collection verifies parent, actor scope, branch
    and declared file paths. Four focused suites pass 70/70; Agents typecheck and `git diff --check`
    pass. Local checkpoint pending push.
  - [x] Review the surviving planner operation allowlist against current callers. Project decision
    and workspace excerpt readers are disclosed/invocable only for Project planners; Space invocation
    is denied, including Code Mode. Thread and roster reads stay within the current Project; actor,
    Project and attempt checks remain on Goal Activity, evidence, blackboard and resume routes. Live
    coordinator/provider acceptance remains separate.
- [x] **APW02 — Use one scoped investigation worker by default and fan out independent tasks.** Added
  `naelao agent send --id <worker-id> --task <follow-up>` as the typed path to continue a dependent
  investigation in its existing session. The host keeps the same ID and revalidates saved actor,
  Project, attempt, branch, capabilities and remaining budget. Independent DAG work still uses distinct
  task worker IDs and host-capped concurrency; direct dependencies receive bounded untrusted handoffs,
  and failed/partial states remain visible while descendants block. Five focused suites pass 105/105;
  Agents typecheck and `git diff --check` pass. Pushed as `7c17eaad`.
- [ ] **Blocked · APW08 — Reusable and ephemeral worker definitions and delegated deadlines.** The
  source/owner review found no safe parser or host-binding slice before the APW/PW/TBR owners approve
  the versioned definition schema, topology/model/capability/evidence/communication fields,
  package/grant binding, reuse lifecycle and explicit host-only authority/budget rule. Delegated
  `long_running` workers also need an owner-approved active-duration, approval-wait, expiry/cleanup
  and expired-resume contract; do not infer the ordinary AgentDO 10-minute limit. Resume after both
  contracts are recorded, then implement independently testable parser/binding and deadline slices.
  Update: the MS-10 parser slice landed locally (versioned parser only, 8/8 tests); host binding,
  grant intersection and delegated-deadline enforcement remain unbuilt.
- [x] **APW02/APW09 — Local task-shape comparison and boundary verification.** The paired synthetic
  scheduler fixture and authorized caller regressions cover planner shell/raw-domain denial, bounded
  exact Project reads, bounded untrusted dependency handoffs and worker execution access checks.
  Eight focused suites pass 123/123 with two provider/live tests skipped; Agents typecheck and
  `git diff --check` pass. See the [comparison protocol](../benchmarks/adaptive-goal-routing-comparative-protocol.md)
  and [APW ledger](../research/adaptive-planner-worker-swarm-memory-progress.md). This is local
  fixture evidence only.
- [ ] **Blocked · APW09 — Real-runtime/provider comparison and rollout decision.** Resume only with
  authorized staging runtime and provider/quota, frozen representative tasks and analysis, approved
  quality/latency thresholds and per-goal spend ceiling, and reconcilable provider usage/invoice
  evidence. Keep progressive routing and cost-aware defaults disabled.

**Latest checkpoint:** The first exact Project decision lookup and planner file-read denial are
verified and pushed as `fee19873`; alias/pipeline/Code Mode/stored-command/resume regressions passed
53/53 and were pushed as `c140822b`. The bounded Project excerpt passed 31/31 and was pushed as
`5158d3bb`. Project thread scope passed 71/71 and was pushed as `b9a36f40`. The project-agent roster
and task/evidence scope audit passed 70/70 and was pushed as `3207c0bb`; exact-reader Project/Space
discovery and invocation checks pass 15/15 with Agents typecheck. APW02's same-session follow-up
command and DAG handoff checks pass five suites at 105/105 with Agents typecheck and is pushed as
`7c17eaad`. The APW08 review found the delegated deadline and reusable-definition contracts are
owner-blocked, with no independent safe parser/host-binding slice. The APW02/APW09 local comparison
plus boundary suites pass 123/123 (two provider/live tests skipped), Agents typecheck and diff hygiene.
**Exact next action:** resume APW07 classification after APW/PW owners approve its evidence taxonomy,
or resume APW08 definition/deadline work after its owners approve the versioned schema and expiry
contract. Keep APW09 live acceptance blocked until its exact staging/provider prerequisites are met.

## Active plan — AgentPort credential broker

See the [plan](../research/agentport-credential-broker-plan.md) and [CB progress ledger](../research/agentport-credential-broker-progress.md).

- [x] **CB01 — Source and threat-model audit.** The audit traced AgentPort mandate key storage and
  revocation, account/grant authorization, UserPort MCP mediation, provider manifests, AgentMail
  credential storage/use/unlink, result exposure, idempotency and uncertain sends. The source audit
  identifies the internal assistant AgentMail operation gate as the next local slice. AgentPort
  route/core tests pass 20/20; AgentMail tests pass 17/17; MCP gate/revocation tests pass 10/10; provider
  SDK tests pass 2/2. Local source/fixture evidence only; no provider action, deployment or live claim.
- [x] **CB02 — Scoped host execution path for AgentMail operations.** The internal assistant route
  now admits only `agentmail-operation`; existing current-scope, owner identity/account, AgentPort
  grant, autonomy, recipient, daily-limit and idempotency checks still run. Internal route tests prove
  owner account access and foreign-account/grant denials; send tests cover allowed recipient,
  standing autonomy, daily limit and no duplicate provider call on replay. The daily-limit error now
  maps to 429. AgentMail tests pass 19/19, Agents typecheck and `git diff --check` pass. See the CB
  ledger; no provider action or live acceptance was run.
- [x] **CB03 — Local credential lifecycle and leakage review.** User-connected credential and
  webhook secrets remain AES-GCM encrypted under the tenant-derived communications key with
  identity/account AAD; same-owner inbox reconnect replaces the local ciphertext after regional
  inbox validation. Owner unlink clears local secrets and reconciles AgentPort revoke. Scoped user
  erasure now confirms AgentPort revoke before scrubbing AgentMail credentials, webhook references
  and managed-service pointers; failed revoke preserves the identity and credential for retry.
  Tests verify replacement key use, absence from connect/tool results, scoped erasure, and
  fail-closed revoke; existing unlink tests verify local secret deletion and blocked reuse. Source
  review found no AgentMail credential logging and the provider SDK remains metadata-only.
  `agentmail.test.ts` plus `erasure-product-scope.test.ts` pass 23/23, Agents typecheck and diff
  check pass. Upstream key invalidation/rotation, inbox/message deletion, and webhook removal are
  unverified. Evidence: [CB ledger](../research/agentport-credential-broker-progress.md).
- [ ] **CB04 — Provider-minted temporary credential feasibility.** AgentMail documents an
  inbox-scoped API key endpoint, permission whitelist intersected with inbox scope, optional key
  expiry, and a key-delete endpoint. A short-lived key with only the AgentMail permission required
  for each existing host operation reduces authority, so proceed with a local wrapper and fixtures.
  The credential remains a transferable bearer with no documented audience/holder binding;
  refresh means minting a replacement with the owner credential. Live expiry enforcement,
  revocation latency, EU endpoint support and billing effects remain provider acceptance items.
  See source links and evidence boundary in the [CB ledger](../research/agentport-credential-broker-progress.md).
- [x] **CB04 local implementation.** AgentMail operation calls now use a 120-second inbox-scoped
  key and exactly one permission (`message_read`, `message_send`, or `draft_create`), validate the
  returned scope/permissions/expiry, and delete the key in `finally`. Bad scope fails closed and
  still attempts deletion. Parent credentials are not sent on operation requests or returned to
  callers. The focused AgentMail and erasure suites pass 24/24, Agents typecheck and diff hygiene
  pass. No provider request was made.
- [ ] **CB04 provider acceptance.** Confirm a disposable account can create the requested
  inbox-scoped keys with bounded `expires_at`, that expiry and delete actually invalidate them in
  US and EU, that the parent grant can manage child keys, and whether key creation changes billing.
  Resume only with provider sandbox credentials and acceptance evidence; this does not block
  independent CB05 local contract work.
- [x] **CB05 — Unified adapter and developer contract (local).** Provider SDK capability schemas
  are now typed, closed object schemas bound to declared capabilities and round-trip through
  metadata-only manifest publishing. MCP UserPort dispatch recomputes the deterministic action
  binding for each selected tool and rejects duplicate, oversized or substituted stored mappings
  before AgentPort authorization. Extension/template requirements remain host gatekeeper requests;
  schemas do not create grants. Provider SDK tests pass 2/2; MCP gate tests pass 10/10; provider SDK
  and MCP Hub typechecks and diff hygiene pass. Commits `f9f4945a` and `79623759`; see the [CB
  ledger](../research/agentport-credential-broker-progress.md). No live registration or provider
  action was performed.
- **CB05 checkpoint:** provider SDK now validates typed, closed capability schemas and requires
  every schema to match a capability declared in the same manifest. Schema round-trip and
  undeclared/permissive schema rejection pass; publish remains metadata-only and creates no grant.
  Provider SDK tests pass 2/2 and typecheck passes. The MCP gate now recomputes each selected
  tool's deterministic `mcp.tool.<sha256 prefix>` action and rejects substituted, duplicate or
  oversized stored mappings before authorization; MCP gate tests pass 10/10, MCP Hub typecheck and
  diff hygiene pass. The extension/template source pass found their requirements remain host
  gatekeeper requests. **Exact next action:** make AgentMail sends fail closed on an existing
  indeterminate receipt and test timeout plus replay does not dispatch a duplicate.
- [ ] **CB06 — Controls, accounting and acceptance.** Integrate existing approval, budget, billing,
  idempotency and operation-recovery authorities. Verify cross-tenant isolation, revoked/expired
  grants, malicious recipient/tool input, parameter substitution, stale policy, duplicate/unknown
  dispatch, provider timeout, callback replay, token leakage, log redaction and revocation race.
  Local MS-12 AgentMail tests landed for malicious recipients, substitution, log redaction and revocation race (34/34, mock/local evidence only; live provider behavior still gated).
- [x] **CB06 local control slice — indeterminate send replay.** An existing send receipt now blocks
  redispatch unless it is already recorded as sent; a request-hash mismatch still reports an
  idempotency conflict. A simulated provider timeout persists `indeterminate`, and the same-request
  replay returns 409 without creating another temporary key or calling send. AgentMail plus scoped
  erasure tests pass 25/25, Agents typecheck and `git diff --check` pass. AgentMail's published
  contract describes `Idempotency-Key` replay, but live behavior is tracked separately under provider
  acceptance and no live request was made. See the CB ledger.
- [x] **CB06 local control slice — current policy before dispatch.** AgentMail rechecks the
  account/identity state and current standing autonomy/recipient policy after AgentPort action
  authorization and again after temporary-key creation, immediately before provider dispatch. A
  fixture changes autonomy to approval-required during key creation; dispatch is denied and the key
  is deleted. AgentMail plus scoped erasure tests pass 26/26, Agents typecheck and diff hygiene
  pass. AgentPort does not provide a permit atomic with remote provider dispatch, so this narrows
  but does not eliminate the cross-system revocation race; see the CB ledger.
- [x] **CB06 local control slice — AgentPort callback replay.** The signed AgentMail event fixture
  now replays an already queued delivery and verifies the endpoint acknowledges with 204 without
  a second session-queue send or AgentPort claim. The focused callback integration test passes; it
  runs within the AgentMail suite recorded above. This is local fixture evidence only.
- [x] **CB06 local control slice — tenant and grant expiry boundary tests.** The AgentMail internal
  route rejects a connection ID belonging to another tenant even when its owner and AgentPort
  assistant ID match, before any provider call. AgentPort action authorization rejects a grant
  after its `expires_at` passes; existing coverage also rejects a revoked grant, action mismatch
  and resource substitution. AgentMail tests pass 25/25; AgentPort route/core tests pass 20/20;
  both workers typecheck and `git diff --check` passes. These are local fixtures.
- [x] **CB06 local control slice — send parameter substitution.** Reusing a successful send key
  with a changed subject now has a regression proving the stored payload hash rejects it as
  `agentmail_idempotency_conflict`; the route maps that conflict to 409 rather than 502. Existing
  tests retain recipient, autonomy, daily cap and same-request replay checks. AgentMail plus
  erasure tests pass 26/26, Agents typecheck and diff hygiene pass.
- [x] **CB06 local control slice — unknown action and credential leakage.** Unknown AgentMail
  operations are rejected before AgentPort authorization and mapped to 400. Success and provider
  timeout responses are asserted to exclude both parent and temporary API keys. Source review of
  `agentmail.ts` and its route found no credential logging; provider errors expose only a status
  code. AgentMail plus erasure tests pass 26/26, Agents typecheck and diff hygiene pass.
- [x] **CB06 local control slice — atomic send receipt claim.** New send receipts use
  `ON CONFLICT DO NOTHING`; a concurrent loser re-reads the durable receipt and returns the saved
  sent result or remains fenced for reconciliation. A barrier-driven pair of identical sends proves
  only one temporary key and one provider dispatch occur. AgentMail plus erasure tests pass 27/27,
  Agents typecheck and diff hygiene pass.
- [x] **CB06 local control slice — concurrent daily-cap admission and outcome accuracy.** The same
  atomic insert admits a send only while today's sent, sending and indeterminate receipts remain
  below the policy limit, preventing concurrent distinct keys from exceeding the cap. Pre-dispatch
  failures delete their un-dispatched claim so corrected attempts can retry; failures after the
  provider call begins remain indeterminate. Concurrent duplicate and distinct-key cap tests pass
  within the AgentMail 27/27 suite; Agents typecheck and diff hygiene pass.
- [x] **CB06 local control slice — owner-visible reconciliation state.** The scoped AgentMail
  connection status now reports an indeterminate-send count and a reconciliation-required flag,
  without exposing provider inbox IDs, payloads, idempotency hashes or credentials. A local fixture
  verifies the signal. AgentMail plus erasure suites pass 28/28, Agents typecheck and diff hygiene
  pass. This surfaces the blocker; it does not resolve the provider outcome.
- [x] **CB06 local control slice — bounded send result.** Successful send/reply/forward operations
  return only the provider message ID (or `{sent:true}` if the accepted response omits it), rather
  than passing through the provider response object. Idempotent replay returns the saved minimal
  receipt. A fixture includes thread, body, recipient and debug fields and verifies they are not
  returned. AgentMail plus erasure suites pass 28/28, Agents typecheck and diff hygiene pass.
- [x] **CB06 local source audit — approvals, caps, action/effect audit and callback recovery.**
  Standing autonomy and recipient allowlist are revalidated before send; AgentPort checks current
  account/service/agent/grant and expiry and persists an action receipt; an atomic local effect
  receipt enforces idempotency and daily count caps; signed callback receipts claim, queue, ack and
  fence replay. Timeout remains indeterminate and visible in owner status. Focused tests above
  verify these local controls. No standalone approval, wallet-budget or per-message monetary source
  was found for AgentMail sends.
- [ ] **CB06 payer/price/budget contract.** Managed-service credit reservations cover AgentMail
  provision and renewal only. Existing managed-service cost budgets evaluate alerts and do not gate
  dispatch. No verified per-message AgentMail cost feed/invoice import, tenant payer allocation,
  message price, or owner-approved send cap in currency exists. Resume this slice when the provider
  payer/rate and customer charge contract are authoritative and available to the send admission
  path; do not create Naelao charges from a count-only ceiling.
- [ ] **CB06 provider/live acceptance.** With separately authorized disposable AgentMail credentials,
  verify temporary-key expiry/revocation, provider idempotency, regional support, billing and
  callback/revocation behavior. Also resolve whether a provider-supported lookup or accepted retry
  procedure can reconcile indeterminate sends and whether an enforceable cross-system revocation
  permit exists. Keep deployment separate and gated by its own authorization.
- [ ] **CB06 deployment acceptance.** Remains separate until the reviewed account, payer, region and
  recovery contracts pass live acceptance and deployment is explicitly authorized.

**Latest checkpoint:** local CB06 controls and source audit are verified through `4db9426c`;
AgentMail plus erasure suites pass **28/28**, Agents typecheck and diff hygiene pass. The pushed
slices cover indeterminate replay, current policy rechecks, callback replay, cross-tenant and grant
expiry boundaries, payload substitution, early unknown-action rejection, credential/result
redaction, atomic duplicate-send and daily-cap admission, outcome accuracy, and owner-visible
reconciliation state. AgentMail's published idempotency retry documentation is not live acceptance.
No per-message cost/payer contract, documented send lookup, or atomic AgentPort-to-provider
revocation permit exists. The queue-wide review found no independent local task ready. **Exact next
action:** resume the payer/price task when its authoritative contract is available; resume provider
acceptance only with separately authorized disposable credentials; keep deployment as a distinct
authorization gate. The queue remains blocked with work open.

## Ordered plan list

Unchecked entries mean work or reconciliation remains, even where the linked ledgers already
contain substantial implementation. Activate one entry at a time. Copy only the missing tasks
into the active checklist. Keep finished task checkboxes and evidence in the queue or its linked
ledgers when moving to another plan.

1. [ ] **Paused; no ready source task after final APW review.** [Planner investigation and worker reuse](../research/planner-investigation-and-worker-reuse-plan.md) · [checklist](#paused-plan--planner-investigation-and-worker-reuse). APW02/APW09 local comparison and boundary verification are complete. APW07 classification, APW08 contracts and APW09 live acceptance remain blocked below and in the APW ledger.
2. [ ] **Earlier APW work remains open under existing dependencies.** [Adaptive planner, worker coordination and memory](../research/adaptive-planner-worker-swarm-memory-plan.md) · [APW ledger](../research/adaptive-planner-worker-swarm-memory-progress.md). A review-only APW07 shared-decision/distinct-path signal is implemented; full conflict classification and APW08 deadline/reusable-definition work need owner-reviewed contracts. APW04–APW06 and APW09 retain policy/authority/evaluation gates. Cross-DO recovery/publication and economics acceptance need authorized staging. Fixed a Shell durable-task list routing bug (it reached the Spaces AVOS task DAG; now `/durable-tasks` routes to Agents).
3. [ ] [Resumable workers, durable workflows and branches](../research/resumable-workers-durable-workflows-and-branches-plan.md) · [PW ledger](../research/resumable-workers-durable-workflows-and-branches-progress.md). No ready tasks remain; worker-branch retention landed locally (MS-20, flag off) and awaits live enablement. Use the [planner and worker isolation plan](../research/planner-worker-isolation-and-conflict-resolution-plan.md) and platform section 12 for the existing PW contracts.
4. [ ] **Paused; Project runtime changes are tracked under SPR.** [Managed services and sidecar runtime](../research/managed-services-and-sidecar-runtime-plan.md) · [S/U ledger](../research/managed-services-and-sidecar-implementation-progress.md). Resume independent work when its recorded dependencies change.
5. [ ] **Paused; local acceptance complete, live acceptance blocked.** [One Tier 6 container per Project](../research/single-project-tier-6-runtime-plan.md) · [SPR checklist](#paused-plan--single-project-tier-6-runtime). This plan owns the new runtime constraint for S4 and the affected S3/U10 callers.
6. [ ] **Paused; no ready source task.** [Shared compute scheduling and budget](../research/shared-compute-scheduling-and-budget-plan.md) · [SC ledger](../research/shared-compute-scheduling-and-budget-progress.md). Resume SC03 when durable invocation consent, exact alarm-safe authority revalidation and pre-dispatch reservation are supported; resume SC04 when owner-approved Space/Project caps exist.
7. [ ] **Reconciled; no standalone task selected.** [Unified platform](../research/naelao-unified-platform-deep-plan.md) · [U ledger](../research/unified-platform-implementation-progress.md). Code gaps remain tracked in their owning plans; remaining checked-workspace/runtime acceptance requires authorized deployed/provider evidence.
8. [ ] **Paused; no ready source task.** [Mature Knowledge platform](../research/mature-knowledge-platform-plan.md) · [K ledger](../research/mature-knowledge-platform-implementation-progress.md). K21 deployed acceptance and the K20 response-cache identity contract remain blocked; K15 waits on exact provider scope/freshness/cleanup evidence.
9. [ ] **Paused; remaining EP06 billing-price/cap and provider/live acceptance gates have no current local rate/acceptance contract.** The versioned unit price table (MS-14, `ext-units-2026-11-25`) has landed locally (mock/local only); the owner usage estimate and cap status (MS-15) now show locally as estimate-only with no charge; with the flag off, in-reservation settlement (MS-16) has landed locally: `WorkflowRunDO` accumulates the run's resource units in its journal and, only when `EXTENSION_RESOURCE_PRICING_ENABLED` is `true`, adds their once-rounded price to the existing settle quantity (capped at the hold; mock/local only, flag stays off), and default caps (MS-17) have landed locally (a new project installation seeds 200 run / 1,000 monthly credits at revision 1; existing rows untouched; mock/local only), ; this item still waits on cross-resource caps (the per-goal ceiling is queue item 2, MS-18) and provider/live acceptance. [Extensible platform and managed resources](../research/extensible-platform-and-managed-resources-plan.md) · EP entries in the [platform ledger](../research/platform-completion-and-guided-templates-progress.md)
10. [ ] **Paused; no current code-ready task.** [Template business roles and member onboarding](../research/template-business-roles-and-member-onboarding-plan.md) · [TBR ledger](../research/template-business-roles-and-member-onboarding-progress.md). TBR08's workflow-resource dispatch slice is locally fixed; broad channel/provider/cache/delegation acceptance remains partial. TBR11's direct-script per-effect ceiling needs an owner-approved admission contract; role-to-resource mapping and private-Project policy remain unresolved.
11. [ ] **Paused; no local source-only task is ready.** [Platform completion and guided templates](../research/platform-completion-and-guided-templates-plan.md) · [P ledger](../research/platform-completion-and-guided-templates-progress.md). Resume when one of the recorded policy, provider, resource-inventory or deployed-acceptance dependencies changes.
12. [ ] **Source reconciled; provider work remains gated by terms, API and pricing evidence.** [AgentPort managed messaging providers](../research/agentport-messaging-providers-managed-resale-plan.md) · [progress ledger](../research/agentport-messaging-providers-managed-resale-progress.md)
13. [ ] **Blocked; CB01–CB05 and CB06 local controls are verified.** [AgentPort credential broker and constrained provider actions](../research/agentport-credential-broker-plan.md) · [CB ledger](../research/agentport-credential-broker-progress.md). MS-19 landed the local slice of the CB06 payer/price/budget contract behind `AGENTMAIL_SEND_BILLING_ENABLED` (default off): a Naelao-managed send reserves, settles, releases or marks uncertain its configured `send` credits (mock/local evidence only; live provider pricing is still gated). CB06 still needs the authoritative managed-send payer/price/budget contract, provider reconciliation and revocation acceptance with separately authorized disposable credentials, and a separate deployment authorization. CB4A remains an expired informational draft.
14. [ ] **Source reconciled; provider work remains gated by API, commercial and regional evidence.** [AgentPhone and AgentPort adapter evaluation](../research/agentphone-agentport-adapter-evaluation-plan.md) · [AP ledger](../research/agentphone-agentport-adapter-evaluation-progress.md)
15. [ ] **Paused; source and focused local regression tests verified; migration/live acceptance blocked.** [WhatsApp member routing, extension testing, SDK and starter templates](../../new%20plan/WHATSAPP-MEMBER-ROUTING-AND-EXTENSION-TESTING-PLAN.md). Resume on the separate migration authorization, configured test-account and provider/UI acceptance dependencies recorded above.
16. [ ] **Paused; fictional static demo source is complete; operator validation is required for further workflow work.** [Commercial cleaning Space template](../research/commercial-cleaning-space-template-plan.md) · [progress ledger](../research/commercial-cleaning-space-template-progress.md)
17. [ ] **Paused; the private static Blueprint is complete; a functional workflow awaits approved scope and practitioner validation.** [Corporate recovery claims prototype](../research/corporate-recovery-claims-prototype-plan.md) · [progress ledger](../research/corporate-recovery-claims-prototype-progress.md)
18. [ ] **Evidence seeded; discovery blocked.** [Founder Growth TODO](../research/founder-growth-todo.md) · [evidence worksheet](../research/founder-growth-evidence.md). The first-hand evidence seed and workflow cluster are recorded. The next action is a discovery conversation with a founder who welcomes replies; no outreach is authorized and no paid demand is established. Resume when a permitted, welcomed route and separate outreach authorization are available, or an inbound founder starts the conversation.
19. [ ] **Paused; local work complete, live acceptance blocked.** [Subspace Blackboard Coordination](../research/subspace-blackboard-coordination-plan.md): SBB01–SBB04.2 done locally, including template role routes (MS-04–06) and flag-gated resource links (MS-01–03). Only SBB04.3 live acceptance/deployment remains, which needs separate authorization.

21. [ ] **Active; owner approved the spec and all OD-1..OD-8 recommendations on 2026-11-26. P0 runs as master-spec tasks MS-27..MS-30.** [Managed, Providers and AgentPort spec v2](../../new%20plan/V-spec.md) (from [V.md](../../new%20plan/V.md)): reconciles the plan with existing managed-service, AgentPort, billing and email code; phases P0–P6 with exit criteria; owner decisions OD-1..OD-8 listed in §18. P1 (Naelao Email) follows P0. MS-27 landed the P0 schema locally (migration 0291: offerings, commercial agreements, resource columns and the `managed_resources` view; P0 schema landed locally, not applied remotely; no code reads it yet). MS-28 added the flag-off (`MANAGED_OFFERINGS_ENABLED`) operator offering/agreement admin routes in the agents worker, the shared fail-closed `resolveOfferingAdmission` in `@naelao/billing-core` (called only by tests until MS-29) and migration 0292 (testing-tenant allowlist column plus Telnyx trigger classification); local only, not applied remotely. MS-29 moved the AgentMail and Workers AI quote rules out of the Billing reserve route into offering data (`quote_policy`, admission fail-closed) behind the same flag, with a never-auto-applied operator seed (`docs/operations/managed-offerings-seed.sql`); local/mock only, flag off.

20. [ ] **Active; MS-01 to MS-13 verified locally and pushed; MS-14 to MS-25 queued from owner decisions D8 (prices/caps), D9 (retention), D10 (preferences) approved 2026-11-25.** [Master implementation spec](master-implementation-spec.md). Commits 1ace1e7d (MS-01) through the MS-13 commit; each task's result line is in the spec. MS-12 fixed a real AgentMail bug: a malformed recipient in a mixed list was dropped before the allowlist check and could be dispatched. MS-13 fixed task detail so a Space member can no longer read another Project's task by ID, and allowlisted durable tasks and Stop for product end users on the router. Local only; no deployment or live acceptance.

## Latest plan checkpoint — Subspace Blackboard Coordination

See the [plan](../research/subspace-blackboard-coordination-plan.md).

- [x] **SBB01 — Trace current sibling identity, membership and blackboard callers.** The authoritative route for this first slice is the logical department hierarchy in one parent SpaceDO. The active immediate-sibling predicate, direct member/parent owner-admin authorization path, distinct assistant identities and scoped task-blackboard model are recorded in the [SBB01 source audit](../research/subspace-blackboard-coordination-plan.md#sbb01-source-audit--2026-11-25). Use the existing `root` / `dept-a` (Sales) / `dept-b` (Research) fixture plus `other-root` / `other-dept` as the non-sibling control. D1 `parent_space_id` alone is not sufficient authority.
- [x] **SBB02 — Implement one directed route.** SpaceDO migration 159 stores parent-owned routes/messages; Spaces routes derive user/parent scope and SpaceDO rechecks active sibling and membership authority. The API supports bounded source handoff, one linked reply, each participant's current board view, stable retry IDs, revocation, 500-message route capacity and 100-message reads. Helper, SpaceDO and route tests pass 8/8; Spaces typecheck and diff hygiene pass. No deployment/live acceptance ran.
- [x] **SBB03 — Add owner, assistant and template configuration.** Resolve template role bindings to actual logical subspaces, propose routes for explicit approval, expose owner/assistant configure and revoke actions, and connect subspace assistants to board publish/read using their own identity and current grants. Keep sharing disabled by default. Add bounded multi-recipient updates and scoped resource references only where current grant paths support them.
  - [x] **SBB03.1 — Expose route discovery and owner controls in the department view.** Active routes are listed only after current subspace membership is checked. The department page exposes explicit route creation/revocation for actors who can manage both siblings and source/target board views with question and linked-reply composition. Sharing remains opt-in. Spaces tests pass 9/9, Router product-session path tests pass 92/92, Shell typecheck passes.
  - [x] **SBB03.2 — Bind assistant board operations to exact subspace identities.** Internal Spaces read/publish calls require a valid tenant HMAC and host-selected assistant actor. SpaceDO compares that actor to the current immutable assistant record for the exact active child, revalidates the active sibling route each time, and keeps grant create/revoke outside the assistant script. Focused SpaceDO/Spaces route tests pass 7/7, assistant operation tests 3/3, Spaces and Agents typechecks and `git diff --check` pass. Local only; no live acceptance ran.
  - [x] **SBB03.3 — Resolve template roles to proposed routes.** Landed via master spec MS-04–06 (`620dc370`, `541984d6`, `5078f144`): signed `SpaceBlueprint` symbolic subspace roles and route proposals (SDK validation), owner role→department mapping at activation, migration 162 pending `subspace_route_proposals` approved only by an owner with manage on both subspaces, router allowlist and Shell inbox. Mock/local evidence only.
  - [x] **SBB03.4 — Add bounded multi-recipient updates.** Migration 160 stores the source, sender, canonical recipient routes and payload under a stable broadcast ID. SpaceDO validates 2–10 distinct destination children, every active source route, current sibling pairs, allowed kind, capacity and sender write authority before one transaction writes the broadcast and all per-route message copies. Identical retries return the existing copies; changed recipient/payload reuse conflicts; revocation blocks retries and future reads. Spaces tests pass 19/19, Agents tests 4/4, Router path tests 94/94, Spaces/Agents/Shell typechecks and diff hygiene pass. Local only; no deployment/live acceptance ran.
  - [x] **SBB04.1 — Verify current directed-route and fan-out privacy/lifecycle behavior locally.** The regression suite covers non-siblings, tenant-HMAC mismatch, wrong assistant IDs and roles, removed memberships, ignored undeclared payload fields, invalid message kinds, conflicting route/message/broadcast IDs, exact duplicate fan-out (one copy per route), rejected incomplete fan-out, recipient-to-recipient isolation, route revocation, and hidden stale-route metadata/counts. Focused Spaces suites pass 21/21 and Spaces typecheck passes.
  - [x] **SBB04.2 — Audit separately scoped resource links.** Source audit found exact, expiring, revocable `cross_space_grants` and a Knowledge shared-document reader, but no caller binds the authenticated route recipient to a capability check and then reads the resource. SpaceDO accepted-document records have no public Spaces route or Knowledge reader integration. Keep message resource links unavailable until a recipient-side resolver binds recipient subspace and user/assistant identity to the exact target/resource, verifies the current capability and revocation at each fetch, and returns content only after that check. Spaces grant tests pass 6/6; Knowledge shared-reader tests pass 4/4. See the SBB04.2 source audit in the plan. **Resource links landed (MS-01–03, `1ace1e7d`, `232681f0`, `73b64e14`):** messages carry a `resource_ref` that grants nothing; the recipient's own accepted, unexpired, unrevoked capability is checked on every open before the Knowledge shared reader; `SUBSPACE_RESOURCE_LINKS_ENABLED` defaults off. Mock/local evidence only.
  - [ ] **SBB04.3 — Live acceptance and deployment.** Keep disabled and separately tracked; this local work does not authorize rollout or production data migration.

**Latest checkpoint:** SBB01–SBB04.2 complete locally via master spec MS-01–06; resource links and template route proposals are behind default-off/owner-approval gates.

**Resume action:** SBB04.3 live acceptance and deployment only, after separate authorization.

## Final queue readiness review — 2026-11-25 (after SBB04.2 resource-link audit)

I reviewed all 19 unchecked entries in the ordered plan list against their current queue checklists,
the latest linked owner ledgers, and the current source. The 2026-11-24 dependency table and the
2026-11-25 CB06 review remain applicable to the other plans: APW/PW need owner-reviewed evidence,
retention, deadline and reusable-definition contracts or authorized staging receipts; S/U/SPR need
supported provider, jurisdiction, runtime and Cloudflare acceptance evidence; SC needs durable
invocation consent and approved caps; K needs deployed mutation/revocation evidence, cache identity
rules or provider scope/freshness/cleanup evidence; EP/TBR need approved prices/caps, identity and
grant contracts; P needs its recorded resource, policy, platform-admin, event, accounting or
artifact-rights contracts; AgentPort/AgentPhone need verified provider terms, APIs, payer/prices,
regions and lifecycle evidence; WhatsApp needs migration authorization and a configured test
account; the two prototypes need operator/practitioner-approved scope; Founder Growth needs an
inbound founder or an authorized, welcomed discovery route. Their existing local implementation and
verification notes were rechecked and revealed no new independent source-only slice.

For SBB, focused local evidence is current: route/fan-out privacy tests pass **21/21**, cross-space
grant tests pass **6/6**, and Knowledge shared-reader tests pass **4/4**. The SBB04.2 audit closes
the source-audit task but identifies a concrete integration prerequisite: no API gives the recipient
an accepted exact capability and no reader combines proof of current membership in the grantee
subspace, current user/assistant identity, resource target and an expiry/revocation check before
returning content. Define that recipient token acceptance and resolver contract before implementing
resource links. SBB03.3 remains blocked on signed symbolic subspace roles and owner mapping/review
inputs in authoring, preview and activation. SBB04.3 live acceptance/deployment remains separately
unauthorized. No local implementation, integration or verification task is ready across the queue.

The queue remains blocked with work open; keep rollout and deployment disabled. `AGENTS.md` has no
active pointer until one of the listed dependencies changes. On resume, fetch the branch and select
the first newly ready task from the ordered plan list; do not treat this checkpoint as completion.

## Queue readiness review — 2026-11-24 (after `4e040d97`)

I rechecked every unchecked plan against the current source and its latest owner ledger after pushing
`4e040d97`. SPR01's active-branch inventory refresh remains complete; its current routing callers,
focused local suites and typecheck are recorded in the SPR ledger. APW07 now has both unit and route
coverage for the bounded review candidate; the route test proves owner projection and other-actor
filtering. Its focused suites pass 9/9 with Agents and Shell typechecks. Semantic/interface
classification and APW08 deadline/reusable-definition work still need owner-reviewed contracts. I
found no independent local implementation, integration or verification slice ready in the remaining
plans without choosing a missing policy/contract, relying on unsupported provider behavior, or
obtaining live/practitioner evidence. Keep unchecked plan rows open; do not mark the queue complete.

| Plan | Readiness result and exact resume dependency |
| --- | --- |
| APW | Conflict taxonomy/evidence contract (APW/PW owners); bounded worker deadline and expiry contract; versioned reusable task/workflow definition contract (APW/PW/TBR owners); approved retention, task-control and per-goal cost policies; staging DO/provider receipts and frozen evaluation protocol. Implement only after each applicable contract is recorded. |
| PW | Owner-approved branch retention, deletion and recovery policy; real runtime isolation, cross-DO publication/cancellation and provider-cost acceptance require authorized Cloudflare bindings and reconciled effect/invoice receipts. Other local caller slices are recorded complete in the queue and PW/platform ledgers. |
| S/U | U05/U06 need a supported authenticated writer/drain/flush/reconnect transport; U09 needs approved key and jurisdiction bindings; U10 needs regional Cloudflare configuration and provider support or an accepted migration path for physical snapshot purge and historic unregistered sidecar discovery; U11 needs authoritative provider/idle-cost feeds; Modal needs pricing and settlement before a caller. |
| SPR | Local SPR01–SPR05 implementation/fixtures are complete. Resume live allocation, replacement, cleanup and erasure acceptance with approved jurisdiction-specific Sandboxes/D1/R2 configuration and authorized Cloudflare lifecycle receipts; physical snapshot purge and historic sidecar discovery need supported provider APIs or an accepted migration. |
| SC | SC03 detached replay requires a reviewed durable invocation-consent/job contract, revocable authority revision, alarm-safe revalidation, fresh pre-dispatch Billing reservation and owner status/cancel/retry; SC04 requires owner-approved Space/Project caps. |
| Unified platform | No standalone local task: code is assigned to S/U, SC, PW, K, EP, TBR and P owners. Remaining checked-workspace/runtime claims require authorized deployed/provider receipts against those owners' exact contracts. |
| Knowledge | K21 needs authorized migration 0284 and deployed mutation/revocation/delete-race evidence; K20 needs host-owned response-cache identity/effect and exact authority-revision rules; K15 needs provider-approved scope/identifier/freshness/deletion/retention and isolated cost evidence. Keep caches and provider gates off. |
| EP | EP06 needs owner-approved resource-unit prices and cross-resource caps before quotes/reservations; provider invoices and deployed export/uninstall/cleanup receipts need authorized provider acceptance. Keep resource descriptors unavailable. |
| TBR | TBR11 needs atomic per-effect ceiling consumption bound to exact job identity/revision; TBR04 needs approved symbolic-resource-to-host-grant bindings; TBR07 needs a decision on same-Space owner/admin access to private Projects and a cross-store deny/exception contract. Provider/channel and multi-user acceptance remain separate. |
| Platform completion (P) | No standalone local slice after the 2026-11-23 P10 source reconciliation. P01/P02 need distinct Cloudflare resource ownership, 158 read-only receipts and operator-attested D1 baselines; P03/P12 need approved grace/restriction/retry policy; P13 needs a supported platform-admin identity, backlog/DLQ source and redacted idempotent replay contract; P16 needs an accepted Discord attachment signature contract and real event; P17 needs cross-issuer identity handoff; P20 needs payout/refund accounting policy; P24 needs cross-tenant artifact rights and scanning/retention policy. Provider and deployment acceptance remains separate. |
| AgentPort providers | Candidate-specific executed terms, API/auth/event and account lifecycle contracts, supported territories, exact payer/rates/invoice evidence, and retention/deletion duties are missing. Reopen one adapter only after those records are verified. |
| AgentPhone | Verified API/auth/signature/event and voice/media behavior, parent/subaccount terms, supported regions, payer/rate/invoice evidence, deletion behavior and disposable live acceptance are missing. Do not infer support from other providers. |
| WhatsApp member routing | Local route and focused regression work is complete. Resume after authorization for migration 0289, a configured disposable test account, and separately authorized provider, browser/UI and live routing acceptance. |
| Commercial cleaning template | Practitioner discovery must approve site/scope/visit/correction/inspection records, transitions and evidence; pilot scope/terms must be agreed before operational workflows or validation. No partner contact is authorized. |
| Corporate recovery claims | Owner-approved functional scope and practitioner-validated status/checklist language, provenance and access contract are required before import/correction/export behavior; real claims data and practitioner outreach are not authorized. |

At this review, the queue was blocked with work remaining. APW07 classification, APW08 deadline
and reusable-definition contracts, and deployed acceptance were gated as recorded above. The
planner investigation plan was activated after that review and supplied a local comparison task,
which is now complete. The final queue readiness review below supersedes this earlier decision.
Keep all rollout gates disabled.

## Final queue readiness review — 2026-11-24 (after local APW comparison)

The APW02/APW09 local comparison and boundary verification are now complete and pushed with this
checkpoint. I rechecked every remaining unchecked plan against the readiness table above, the current
queue entries and their linked owner ledgers. The prior table's non-APW dependencies are unchanged.
APW07 semantic/interface classification still needs the APW/PW evidence taxonomy; APW08 needs the
owner-reviewed reusable-definition and delegated deadline/expiry contracts; APW09 live comparison
needs authorized staging/provider access, frozen tasks and thresholds, a spend ceiling and reconciled
usage/invoice evidence. The other paused plans retain the specific policy, provider, operator or
deployed-evidence dependencies in the table. I found no independent local implementation,
integration or verification task ready. The queue remains blocked with work open; deployment and live
acceptance remain separate, and rollout gates stay disabled. Resume when a listed dependency changes.

## Final queue readiness review — 2026-11-25 (after AgentPort credential broker local controls)

The CB06 local implementation and audit are complete through commit `4db9426c`. The focused
AgentMail and erasure suites pass **28/28**, Agents typecheck and diff hygiene pass. The source pass
confirms standing autonomy/recipient checks, current AgentPort account/service/agent/grant/expiry
authorization, atomic daily admission, durable local send and action receipts, signed callback
replay fencing, bounded result handling, credential redaction and owner-visible unknown state.
CB06 remains open for three concrete reasons: there is no verified per-message provider price,
tenant payer allocation or invoice/cost feed to connect a monetary budget; AgentMail has no
documented read-only send lookup by idempotency key and its documented retry behavior has not been
live accepted; and AgentPort exposes no enforceable one-shot revocation permit spanning remote
provider dispatch. Live expiry, revocation latency, regional support and billing acceptance require
separately authorized disposable credentials. Deployment remains a separate authorization gate.

I reviewed every other unchecked plan against the current ordered plan list, the 2026-11-24
readiness table and each linked latest owner ledger. No dependency changed and no independent local
implementation or verification task became ready: APW/PW need owner-approved contracts or staging
receipts; S/U and SPR need supported providers, jurisdiction configuration or live Cloudflare
receipts; SC needs durable consent/cap contracts; K/EP/TBR/P need their recorded identity, price,
policy, practitioner or deployed-evidence prerequisites; AgentPort messaging and AgentPhone need
verified terms/API/payer/region contracts; WhatsApp needs migration authorization and test account;
the two prototypes need practitioner-approved scope. The CB06 status and provider work remain open.
The queue is blocked with work remaining and rollout/deployment disabled. Resume when one of these
exact dependencies changes; keep `AGENTS.md` without an active pointer until then.

## Checkpoint archive

The former AGENTS.md is preserved at [checkpoints through 3a8701a6](agents-checkpoints-through-3a8701a6.md).
Its dated pointers document prior work. Resume through the active queue above. Copies from the
planning branch are kept under [planning branch snapshots](../research/planning-branch-snapshots/).
Use the current plans and ledgers for implementation status.
