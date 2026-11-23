# Naelao implementation queue

This is the live checklist for one session working through one plan at a time. The recovered
`Mcbt5s-Backup-2` recovery checkpoint is `b3f7e9aa`. APW05 admission/accounting paths have been
reconciled; its remaining aggregate cost-policy and provider-USD work is blocked pending the listed
prerequisites. APW06 is active. Use the active checklist below and the linked ledgers to determine
readiness and record a reason if the order changes.

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

## Active plan

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
- [ ] **Active · APW06 — Safe task pause/cancel controls.** Trace conversation and Project activity
  controls against existing task APIs, durable workflow cleanup and worker dispatch fences. Add
  only actions supported by current actor/owner authorization and recovery contracts; preserve
  uncertain external effects for review.
- [ ] **Blocked · APW06 — Topology and budget preferences.** User/admin preferences need an approved
  authority and precedence contract before changing worker count, model/runtime routing or budget.
  Resume when that contract is approved; keep existing rollout defaults unchanged.
- [ ] **Blocked · APW06 — Real-runtime/deployed acceptance.** Resume with staging runtime access and
  separately accepted pause/cancel and task-control behavior; do not treat local/mock UI evidence
  as live acceptance.
- [ ] **APW07–APW09 — Integration, recovery, and evaluation.** Track work through PW, EP, workflow,
  platform, SC and TBR entries where they own the implementation. Link back to that evidence.

**Latest checkpoint.** APW06 goal decision-hold remediation adds a status explanation with exact
decision references and revisions plus a direct link to the Project decision review panel. It adds
no review write or task-resume path; the existing Project route retains access, exact-revision and
workspace-pin checks. Source-only Shell typecheck passes. The normal Shell typecheck still reports
stale generated `.next/types` imports for absent route files; no browser/deployed acceptance ran.

APW05 source reconciliation confirms that goal tasks have bounded token budgets; ordinary model
calls reserve against configured Project spend caps or plan token quotas, and System One decisions
use durable per-call Billing holds. These do not define an aggregate goal credit ceiling. Dynamic
extension workflows have owner-approved per-run/monthly budgets and durable reservations; default
AgentTaskWorkflow has no run-credit hold, and its optional session ceiling is a pre-run check plus
post-run tally increment rather than an atomic reservation. Existing shared-compute capacity limits
and hierarchical promotion do not include task priority weights. Exact blockers and evidence are in
the APW ledger. APW05 remains partial and unchecked.

APW06 verification: source-only Shell TypeScript check and `git diff --check`; the normal Shell
typecheck is blocked by stale `.next/types` references to missing routes. Local UI evidence only;
no browser/deployed acceptance. APW05 comparison is source inspection only, with no deployed Billing
or provider acceptance. The APW04 local test evidence remains in its ledger; no retention schedule
was invented.

**Exact next action:** trace `StopDurableTaskButton`, `cancelRun`, Project activity APIs and the
durable goal dispatch cancellation fences. Determine which cancellation/status actions can be
exposed with current scope checks; preserve uncertain external effects for review and preserve
`infra/scripts/__pycache__/`.

The existing **SC03** synchronous capacity retry was reconciled as implemented in `f9a2a02a`.
Track detached dispatch separately in the [shared compute ledger](../research/shared-compute-scheduling-and-budget-progress.md).
It needs durable invocation authority, alarm-safe revalidation and fresh Billing admission.
Keep disconnected replay disabled while those prerequisites are open.

## Ordered plan list

Unchecked entries mean work or reconciliation remains, even where the linked ledgers already
contain substantial implementation. Activate one entry at a time. Copy only the missing tasks
into the active checklist. Keep finished task checkboxes and evidence in the queue or its linked
ledgers when moving to another plan.

1. [ ] **Active.** [Adaptive planner, worker coordination and memory](../research/adaptive-planner-worker-swarm-memory-plan.md) · [APW ledger](../research/adaptive-planner-worker-swarm-memory-progress.md)
2. [ ] [Resumable workers, durable workflows and branches](../research/resumable-workers-durable-workflows-and-branches-plan.md) · [PW ledger](../research/resumable-workers-durable-workflows-and-branches-progress.md). Use the [planner and worker isolation plan](../research/planner-worker-isolation-and-conflict-resolution-plan.md) and platform section 12 for the existing PW contracts.
3. [ ] [Managed services and sidecar runtime](../research/managed-services-and-sidecar-runtime-plan.md) · [S/U ledger](../research/managed-services-and-sidecar-implementation-progress.md)
4. [ ] [Shared compute scheduling and budget](../research/shared-compute-scheduling-and-budget-plan.md) · [SC ledger](../research/shared-compute-scheduling-and-budget-progress.md)
5. [ ] [Unified platform](../research/naelao-unified-platform-deep-plan.md) · [U ledger](../research/unified-platform-implementation-progress.md). Link requirements already owned by managed services.
6. [ ] [Mature Knowledge platform](../research/mature-knowledge-platform-plan.md) · [K ledger](../research/mature-knowledge-platform-implementation-progress.md)
7. [ ] [Extensible platform and managed resources](../research/extensible-platform-and-managed-resources-plan.md) · EP entries in the [platform ledger](../research/platform-completion-and-guided-templates-progress.md)
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
