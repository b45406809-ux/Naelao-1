# Naelao implementation queue

This is the live checklist for one session working through one plan at a time. The recovered
`Mcbt5s-Backup-2` checkpoint is `3a1291ed`. The order below follows the existing APW queue; after
local APW02 evaluation is recorded, its remaining provider/cost acceptance is blocked, so APW03 is
the next ready requirement. Use actual dependencies to determine readiness and record a reason if
the order changes.

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
- [ ] **Active · APW04 — Memory source provenance and selective context.** Knowledge source adapter,
  source revision, source hash, grant revision and chunk hash now flow through scoped search,
  citations and agent citation metadata. Project, Space and personal memory adapters expose stable
  row IDs and update/create timestamps but no content revision/hash; those exact gaps are in the APW
  ledger. Continue with retention/invalidation and bounded selective-context evaluation; timestamps
  remain freshness metadata, not immutable revisions.
  See the APW ledger follow-up.
- [ ] **APW04 — Retention, invalidation and context evaluation.** Reconcile memory retention/deletion
  across stores, then evaluate selective context and private-project leakage against existing
  Knowledge and actor-scope contracts.
- [ ] **APW05 — Cost and scheduling.** Reconcile reservations, accounting and run limits with the
  shared compute and Billing ledgers.
- [ ] **APW06 — Task controls and SDK.** Continue authorized task UI, template controls and evaluation.
- [ ] **APW07–APW09 — Integration, recovery, and evaluation.** Track work through PW, EP, workflow,
  platform, SC and TBR entries where they own the implementation. Link back to that evidence.

**Latest checkpoint.** Knowledge search and its canonical citation resolver now preserve the
source adapter, source revision, canonical source SHA-256, external-grant revision and exact chunk
SHA-256 already stored by Knowledge. Agent citations retain this bounded source pin in answer/task
metadata. Search cache keys were versioned so old cached hits cannot omit the new fields. Existing
memory adapters were traced: Project facts and Project Wiki overwrite rows in place and expose only
IDs plus `updated_at`; Project Fabric is insert-only with ID and `created_at`; personal structured
facts and Wiki overwrite actor-scoped rows and expose only IDs/timestamps; personal episodic/Fabric
records are insert-only with IDs and `created_at`, and promoted semantic vectors keep the episodic
ID/text plus `sourceUpdatedAt`. None has a content revision/hash field. Actor filtering and bounded
context assembly were not changed.

Verification: Knowledge sparse search **5/5**, scoped search provenance route **1/1**, canonical
citation resolver **1/1**, Agents citation metadata **2/2**, Knowledge and Agents typechecks, exact
Shell source typecheck and `git diff --check`; local/mock only. A broader combined Knowledge run
passed **61/64**; three unrelated restored-chunk reindex cases returned 404 instead of their expected
200/409/410. No deployed/live acceptance. APW04 remains open for retention/invalidation reconciliation,
selective-context evaluation and private-project leakage checks.

**Exact next action:** reconcile memory retention and deletion behavior across personal, Project,
Space and Knowledge stores, then evaluate actor/project-bounded selective context and invalidation
against the existing Knowledge and ingress memory tests. Preserve `infra/scripts/__pycache__/`.

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
