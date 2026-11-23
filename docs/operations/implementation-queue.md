# Naelao implementation queue

This is the live checklist for one session working through one plan at a time. The transition
baseline is `Mcbt5s-Backup-2` at `3a8701a6`. The order below keeps the existing APW02 resume point
first. The remaining order is a proposed starting point. Use the actual dependencies to determine
readiness and record a reason here if the order changes.

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

**Latest checkpoint.** APW02 now has a bounded host-owned expansion path in `goal-expansion.ts`,
`goal-dag.ts` and `NaelaoAgentDO.ts`; progressive routing and expansion remain disabled unless
their flags are set. Structured proposals can add at most three one-level children under the
12-task graph limit. The host derives child identity and authority, checks the parent's unused
worker-token budget, revalidates scope and decision references, persists task membership/grants,
and rechecks authorization and Billing path readiness at dispatch. Concurrent admissions serialize
against the graph limit. Verification: goal expansion/DAG suites **63/63**, Agents typecheck and
`git diff --check`; local/mock only. Cross-DO persistence is staged and replayable, not a distributed
transaction; the existing per-inference quota/project-spend path remains authoritative and this slice
does not reserve aggregate USD/credits for all proposed children.

**Exact next action:** add host-boundary fault/replay coverage for a failure after SpaceDO task
creation but before the AgentDO metadata/grant transaction, then continue APW02's remaining routing,
cancellation and evaluation gaps. Keep both rollout flags off by default.

- [ ] **Active · APW02 — Host admission for dynamic goal graph expansion.** Trace the current durable
  DAG caller and implement the next missing host-owned expansion slice. Preserve stable task identity,
  bounded graph size, worker membership and blackboard grants, current authorization, and Billing
  admission at expansion and dispatch. Keep progressive routing gated.
- [ ] **APW02 follow-ups.** Track measured routing, planner hierarchy, and safe cancellation as
  separate tasks as their prerequisites become ready.
- [ ] **APW03 — Decisions and task lineage.** Reconcile result-branch revision links, conflict review
  and integration evidence with the PW and EP requirements.
- [ ] **APW04 — Memory and context.** Continue provenance, retention and context evaluation from the
  existing actor-scoped memory work and the Knowledge ledger.
- [ ] **APW05 — Cost and scheduling.** Reconcile reservations, accounting and run limits with the
  shared compute and Billing ledgers.
- [ ] **APW06 — Task controls and SDK.** Continue authorized task UI, template controls and evaluation.
- [ ] **APW07–APW09 — Integration, recovery, and evaluation.** Track work through PW, EP, workflow,
  platform, SC and TBR entries where they own the implementation. Link back to that evidence.

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
