# Naelao implementation queue

This is the live checklist for one session working through one plan at a time. The latest confirmed
commit on `origin/Mcbt5s-Backup-2` is the recovery checkpoint; fetch the branch tip before resuming.
APW05 admission/accounting paths have been reconciled; its remaining aggregate cost-policy and
provider-USD work is blocked pending the listed prerequisites. Use the checklist below and linked
ledgers to determine readiness and record a reason if the order changes.

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
   from AGENTS.md if nothing is ready. Recheck parked items when their recorded dependency changes.

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

## Paused plan

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
- [ ] **Blocked · K15 — Implement and validate isolated managed-index adapter.** Resume after exact
  pre-retrieval scope fields and limits, current publication/source revision mapping, asynchronous
  deletion/retention and isolated cost evidence are established. Keep general user search on its
  current exact D1/Vectorize ACL paths and leave all provider gates off.

**Latest K21 checkpoint:** the D1 source-generation fence is implemented locally across current
content and D1 access/publication mutation paths. The shared Agents response cache remains disabled
because freshness does not establish safe caller/effect identity. No migration or deployment ran.
**Next action:** leave K21/K20 rollout acceptance parked and continue with EP06's exact-install
current-month credit summary using the UTC-month settled-usage and live-held-reservation rules already
enforced by Billing.

## Active plan

**Extensible platform and managed resources.** See the [plan](../research/extensible-platform-and-managed-resources-plan.md)
and [platform progress ledger](../research/platform-completion-and-guided-templates-progress.md).

- [ ] **EP06 — Show exact-install current-month credit usage against its approved cap.** The existing
  owner resource route already verifies the signed installation, grant, dependency and usage receipt
  scope. Extend it with the current installation budget and the settled/held credit totals using
  Billing's `start of month` window and exact tenant/Space/Project/install filters; render internal
  credits and remaining cap in the Project resource review. Do not infer provider prices or invoices.

**Latest checkpoint:** current owner review shows the exact signed installation, approved budget
limits, storage bytes, declared/resolved dependencies, provider connection/cleanup receipts, and
operation/job receipts. **Next action:** trace the Billing admission query and current SpaceDO budget
revision, then add only the matching current-month settled plus unexpired held credit summary.

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
  the applicable owner approves retention, cleanup and recovery semantics.
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

## Parked plan — Adaptive planner, worker coordination and memory

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
  semantics. Do not introduce a new expiry without that policy.
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
  cost selection and automatic thrash control disabled meanwhile.
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
  read-only until then.
- [ ] **Blocked · APW06 — Topology and budget preferences.** User/admin preferences need an approved
  authority and precedence contract before changing worker count, model/runtime routing or budget.
  Resume when that contract is approved; keep existing rollout defaults unchanged.
- [ ] **Blocked · APW06 — Real-runtime/deployed acceptance.** Resume with staging runtime access and
  separately accepted pause/cancel and task-control behavior; do not treat local/mock UI evidence
  as live acceptance.
- [ ] **APW07–APW09 — Integration, recovery, and evaluation.** Track work through PW, EP, workflow,
  platform, SC and TBR entries where they own the implementation. Link back to that evidence.

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

## Ordered plan list

Unchecked entries mean work or reconciliation remains, even where the linked ledgers already
contain substantial implementation. Activate one entry at a time. Copy only the missing tasks
into the active checklist. Keep finished task checkboxes and evidence in the queue or its linked
ledgers when moving to another plan.

1. [ ] **Parked.** [Adaptive planner, worker coordination and memory](../research/adaptive-planner-worker-swarm-memory-plan.md) · [APW ledger](../research/adaptive-planner-worker-swarm-memory-progress.md). Remaining tasks have explicit policy, authority or live-acceptance dependencies; APW07–APW09 overlap later plans.
2. [ ] [Resumable workers, durable workflows and branches](../research/resumable-workers-durable-workflows-and-branches-plan.md) · [PW ledger](../research/resumable-workers-durable-workflows-and-branches-progress.md). No ready tasks remain; worker-branch retention is blocked on approved policy. Use the [planner and worker isolation plan](../research/planner-worker-isolation-and-conflict-resolution-plan.md) and platform section 12 for the existing PW contracts.
3. [ ] **Paused; no ready source task.** [Managed services and sidecar runtime](../research/managed-services-and-sidecar-runtime-plan.md) · [S/U ledger](../research/managed-services-and-sidecar-implementation-progress.md). Resume on the regional, provider or jurisdiction acceptance dependencies above.
4. [ ] **Paused; no ready source task.** [Shared compute scheduling and budget](../research/shared-compute-scheduling-and-budget-plan.md) · [SC ledger](../research/shared-compute-scheduling-and-budget-progress.md). Resume SC03 when durable invocation consent, exact alarm-safe authority revalidation and pre-dispatch reservation are supported; resume SC04 when owner-approved Space/Project caps exist.
5. [ ] **Reconciled; no standalone task selected.** [Unified platform](../research/naelao-unified-platform-deep-plan.md) · [U ledger](../research/unified-platform-implementation-progress.md). Code gaps remain tracked in their owning plans; remaining checked-workspace/runtime acceptance requires authorized deployed/provider evidence.
6. [ ] **Paused; no ready source task.** [Mature Knowledge platform](../research/mature-knowledge-platform-plan.md) · [K ledger](../research/mature-knowledge-platform-implementation-progress.md). K21 deployed acceptance and the K20 response-cache identity contract remain blocked; K15 waits on exact provider scope/freshness/cleanup evidence.
7. [ ] **Active.** [Extensible platform and managed resources](../research/extensible-platform-and-managed-resources-plan.md) · EP entries in the [platform ledger](../research/platform-completion-and-guided-templates-progress.md)
8. [ ] [Template business roles and member onboarding](../research/template-business-roles-and-member-onboarding-plan.md) · [TBR ledger](../research/template-business-roles-and-member-onboarding-progress.md)
9. [ ] [Platform completion and guided templates](../research/platform-completion-and-guided-templates-plan.md) · [P ledger](../research/platform-completion-and-guided-templates-progress.md). Reuse the dedicated ledgers for incorporated PW, K, EP, TBR and AP requirements.
10. [ ] [AgentPort managed messaging providers](../research/agentport-messaging-providers-managed-resale-plan.md). Reconcile with managed communications before opening implementation tasks.
11. [ ] [AgentPhone and AgentPort adapter evaluation](../research/agentphone-agentport-adapter-evaluation-plan.md) · [AP ledger](../research/agentphone-agentport-adapter-evaluation-progress.md)
12. [ ] [WhatsApp member routing, extension testing, SDK and starter templates](../../new%20plan/WHATSAPP-MEMBER-ROUTING-AND-EXTENSION-TESTING-PLAN.md). Reconcile against channel, extension, identity and platform ledgers first.
13. [ ] [Commercial cleaning Space template](../research/commercial-cleaning-space-template-plan.md)
14. [ ] [Corporate recovery claims prototype](../research/corporate-recovery-claims-prototype-plan.md)

## Checkpoint archive

The former AGENTS.md is preserved at [checkpoints through 3a8701a6](agents-checkpoints-through-3a8701a6.md).
Its dated pointers document prior work. Resume through the active queue above. Copies from the
planning branch are kept under [planning branch snapshots](../research/planning-branch-snapshots/).
Use the current plans and ledgers for implementation status.
