# Adaptive planner, worker coordination and memory progress

## APW02 follow-up — 2026-11-23 (comparative protocol and deterministic fixture)

Added the [adaptive goal-routing comparative protocol](../benchmarks/adaptive-goal-routing-comparative-protocol.md)
and a local paired scheduler fixture in
`workers/agents/src/script-engine/goal-routing-comparative-benchmark.test.ts`. The fixture runs six
fixed synthetic workloads (small/medium/large code and non-code), two repeats and three arms for 36
runs. Each arm host-verified all 48 expected artifacts and had matching synthetic token totals per
paired workload. Every run recovers one injected lost acknowledgement; each arm reports 12/12
recoveries, zero redispatches, duplicate dispatches, resource overlaps and incomplete runs. The
fixture reports p50/p95 local wall time but labels it test-runner timing; it records no provider
calls, no external writes and `providerSpendUsd: null`.

Verification: routing comparison, goal architecture and evidence-quality suites **6 passed, 2
provider/live tests skipped**, Agents typecheck, and `git diff --check`. The 480-case evidence suite
and architecture scenarios remain synthetic/local. Fixture artifact verification is not model or
customer task quality; lost-ack recovery does not measure failed-worker retries; synthetic token
counts are not spend; resource-key checks are not real workspace conflict acceptance. No live
provider, durable runtime, invoice or checked-publication experiment ran. Progressive routing,
dynamic expansion and redundant-worker cancellation remain disabled by default.

**Exact next action:** continue APW03 by tracing whether the goal activity/result path retains exact
worker-branch base/result revisions and checked publication validation receipts; implement the
smallest missing lineage link and test the host projection. Real-runtime/provider comparison and
cost-aware routing remain blocked as described in the protocol.

## APW02 follow-up — 2026-11-23 (safe redundant-worker cancellation; local verification)

Goal tasks may explicitly declare a `redundancy_group`; validation requires at least two independent
members with no dependency ancestry between them. When the host safety flag is enabled, only a
completed and verified member cancels its unfinished peers. The default-off
`GOAL_REDUNDANT_CANCELLATION_ENABLED` flag keeps rollout disabled.

The stop path records a winner and cancellation timestamp in `goal_dispatch_outbox`, checks that
marker before and during worker-session admission, fences the exact `sub_agents` attempt before
calling the child runtime, and gates goal-worker execution through a parent-side start check. A
completion crossing the fence is kept in a bounded late-result receipt without overwriting terminal
worker state; callback and HTTP races count its tokens once. Existing checked-workspace publication
receipts remain available, and cancellation/effects are exposed to the task UI with explicit wording
that effects may already have committed. A stop request is not treated as rollback. Runtime/task
projections distinguish `cancelling`, `cancelled` and uncertain effects.

Verification: goal DAG, goal planner and delegation admission suites **83/83**, Agents typecheck,
Shell source typecheck excluding stale generated `.next/types`, and `git diff --check`; local/mock
only. The regular Shell typecheck still stops on stale `.next/types` references to absent route
files. No live DO restart/cancellation, provider call or deployment was exercised. The cancellation,
progressive-routing and dynamic-expansion flags remain off by default.

**Exact next action:** define a controlled comparison of one-worker, sequential and adaptive execution
with fixed task/model/time/quality constraints and complete spend, latency, retry, conflict and
customer-visible correctness evidence. Separate local/mock measurements from provider invoices and
deployed acceptance; keep rollout disabled.

## APW02 follow-up — 2026-11-23 (bounded planner hierarchy; local verification)

The goal planner now allows at most four planner-marked children in a root goal graph and rejects
planner children from a depth-two planner, leaving depth-three workers as leaves. Each goal graph
still validates at most 12 tasks. Nested planner graphs allocate a shared child-task token pool no
larger than the parent task's assigned worker-token ceiling; omitted child budgets divide the
remaining pool. The host now passes the actual assigned `budgetTokens` as the nested worker's
`worker_token_budget`, preventing it from inheriting the caller's broader per-worker ceiling.
Delegation tokens continue binding actor, tenant, Space/Project, caller role, depth, planner bit,
model, file paths, and token limits; the child run gate rechecks the caller's current authority.

Verification: goal planner, goal DAG/kernel, delegation admission/contract and assistant-swarm
suites **38/38**, Agents typecheck and `git diff --check`; local/mock only. This bounds planned child
tokens, not all actual descendant model usage or provider charges, which remain subject to the
existing per-inference billing path. It does not enable deeper than the current three levels.
Progressive routing and dynamic expansion remain disabled by default.

**Exact next action:** trace durable worker dispatch acknowledgement, cancellation and late result/
workspace effects before changing redundant-worker cancellation semantics.

## APW02 follow-up — 2026-11-23 (report-only routing history; local verification)

Progressive routing now keeps a maximum of 32 concurrency-history records in the durable goal
journal. The records capture the previous and new concurrency, reason and timestamp; task-completion
changes also capture the triggering task ID, task outcome and verification outcome (`not_required`
or `unavailable` are explicit). The goal activity route bounds and validates this projection and
only exposes a trigger task that exists in the current journal. The Shell renders the history beside
the existing topology and per-task verification/runtime/token/internal-credit values. This adds
observation only; the selection algorithm and rollout flags are unchanged.

Verification: goal DAG suite **60/60**, goal activity route suite **5/5**, Agents typecheck,
Shell source typecheck excluding stale generated `.next/types`, and `git diff --check`; local/mock
only. The normal Shell typecheck remains blocked by stale `.next/types` references to absent route
files. No controlled cost/quality comparison or savings claim is established. Automatic cost-aware
selection remains blocked pending an explicit per-goal spend objective and the comparative baseline;
internal credits can be unpriced and do not represent provider invoices.

**Exact next action:** reconcile nested planner limits, authority inheritance and budget accounting
across `goal-planner.ts`, goal expansion and delegated worker contracts before implementing deeper
decomposition.

## APW02 follow-up — 2026-11-23 (goal usage joins; local verification)

Goal activity already projects each task's stable worker ID, verification result, queue wait and
execution duration. The corresponding `sub_agents` row stores reported model tokens and allocated
token budget, while Billing aggregates exact worker and `:attempt:` usage-event run IDs into
internal credits plus an unpriced-event count. The Shell joins these values by worker ID beside the
goal topology and task status. A route-validation mismatch had prevented this join for goal IDs:
the host derives IDs as a 64-character goal hash, colon, and a task ID up to 64 characters, while
the Agents and Billing usage selectors rejected colons and lengths above 128. Selectors now admit
the bounded namespaced IDs. Billing escapes `_` in the attempt prefix so `task_1` cannot match a
neighboring `taskX1`; the regression exercises the actual usage-summary route.

Verification: worker selector suite **2/2**, Billing worker-usage suite **25/25**, Agents typecheck
and `git diff --check`; local/mock only. These receipts can now be observed together for a goal
task, but they do not constitute a controlled quality/cost comparison. Queue/execution durations
are worker runtime measurements; credits are internal accounting and may include unpriced events;
provider invoices are not reported. No savings claim is supported. Progressive routing and dynamic
expansion remain disabled by default.

The report-only routing history follow-up above completes this next action.

## APW02 follow-up — 2026-11-23 (staged persistence replay; local verification)

The cross-DO expansion persistence path is now isolated in `goal-expansion-admission.ts`. It
prechecks actor-scoped goal metadata and blackboard scope before remote task creation, writes a
durable pending intent, replays immutable SpaceDO task IDs, and commits goal metadata, updated
recipient projection, blackboard membership/grants and intent completion in one AgentDO transaction.
The regression test injects an AgentDO transaction failure after remote task creation, confirms the
pending intent survives without local membership/grants, then retries and proves remote task IDs do
not duplicate while local state converges. A separate wrong-scope case rejects before the remote
write. Verification: goal expansion/admission/DAG suites **65/65**, Agents typecheck and
`git diff --check`; local/mock only. This exercises the contract through a transaction shim, not a
live Durable Object restart. The underlying boundary remains staged across two DOs.

The core expansion implementation is pushed in `139c6654`; this follow-up adds the replay coverage
and queue/pointer transition in this checkpoint. APW02 host admission is checked off in the queue.
**Exact next action:** trace current goal verification, latency, worker-token and internal
credit receipts to a single goal/task before implementing measured routing; keep progressive routing
and expansion disabled.

## APW02 checkpoint — 2026-11-23 (host-owned bounded expansion; local verification)

The durable goal DAG now accepts only an explicit structured worker result as an expansion proposal.
The host derives deterministic 96-bit namespaced task IDs, allows at most three children at one
additional depth, enforces the shared 12-task ceiling and confines child file paths and worker
authority to the completed parent. Child budgets must fit the parent's unused worker-token budget.
Expansion admissions serialize so concurrent completions cannot each pass the graph limit against
the same old task count. Invalid or refused proposals get durable rejection receipts while completed
parent work remains completed; admitted task definitions and receipts resume from the DAG journal.

`NaelaoAgentDO` keeps expansion off unless `GOAL_DYNAMIC_EXPANSION_ENABLED=true`. Admission checks
the durable parent worker's run/tenant/space/project/actor scope, current actor authorization,
current Project decision references and the configured Billing path. It creates explicit stable
SpaceDO task IDs behind a durable pending intent, then commits matching goal metadata and blackboard
membership/grants in the AgentDO transaction. Dispatch rechecks current authorization, decision
references and Billing path readiness. Verification: goal expansion and DAG suites **63/63**,
Agents typecheck and `git diff --check`; local/mock only, with no deployed acceptance. The SpaceDO
write and AgentDO transaction are a replayable staged boundary rather than one distributed atomic
transaction, so a failed local commit can leave a visible pending SpaceDO row until replay. Existing
per-inference quota/project-spend reservations remain in force where configured; this slice adds no
aggregate USD/credit reservation for all proposed children. Rollout remains disabled.

**Exact next action:** add host-boundary fault/replay coverage for the SpaceDO-write/AgentDO-commit
gap, then continue APW02's remaining routing, cancellation and evaluation requirements. Preserve
`infra/scripts/__pycache__/`.

## APW04 checkpoint — 2026-11-18 (actor-owned memory deletion; local verification)

The member-facing Space Assistant memory route now exposes a delete action only for personal
structured facts and episodic rows owned by the authenticated actor. Reads include stable row IDs
and a `deletable` bit only when `user_id` exactly matches that actor; shared Project facts,
explicitly unscoped rows and legacy entries remain non-deletable in this panel. DELETE requires
current Space membership and an actor identity, then Memory OS uses exact `(id, user_id)` predicates;
semantic vector cleanup is best-effort after an owned episode is removed. AgentDO projection/delete
suite **2/2**, Agents and Shell typechecks, and `git diff --check` pass. Local/mock only; no deployed
privacy acceptance. Rollout remains disabled. The follow-up route-to-store suite is **2/2**:
membership is checked before the DO call, actor identity comes from the authenticated request, and
exact row identity is preserved. Agents typecheck passes after adding the caller test.

Implementation commit `63e01415`, ledger/runbook commits `82c78b15` and `8d97b66e`, and route test
commit `2161e627` are pushed to `origin/Mcbt5s-Backup-2`. This remains local/mock verification
only, with no deployed privacy acceptance.

**Exact next action:** continue APW02 with a host-owned expansion/admission contract for dynamic
goal graphs. SC03's bounded synchronous waiter retry is already implemented and recorded in the
shared-compute ledger; only detached dispatch after caller disconnect remains open without explicit
durable invocation authority and fresh Billing. Preserve `infra/scripts/__pycache__/`.

## APW04 refinement — 2026-11-18 (category-qualified exact deletion; local verification)

The member-facing delete contract now includes both category (`fact` or `episodic`) and row ID. The
DO deletes only the corresponding table row under exact `(id, actor)` scope; a defensive same-ID
collision across tables no longer deletes both. Vector cleanup is limited to an owned episodic row.
AgentDO deletion suite **2/2** includes a cross-table ID collision regression; authenticated
route-to-store suite **2/2** proves membership gate, actor forwarding and exact target. Agents/Shell
typechecks and diff hygiene pass. Code commit `cba38ee9` and ledger/runbook commit `f58133a3` are
pushed to `origin/Mcbt5s-Backup-2`. Local/mock only; no deployed acceptance.

**Exact next action:** continue APW02 graph-expansion design across stable IDs, blackboard authority,
worker grant resolution and billing admission. Do not wire model-supplied additions until all these
host boundaries can be revalidated at expansion and dispatch.

## APW04 checkpoint — 2026-11-18 (Space Assistant memory scope; `89764820` pushed)

The member-facing Space Assistant memory projection now sends the authenticated actor and effective
Space role to AgentDO. Local structured/episodic memory reads include only that actor's rows and
explicitly unscoped rows; legacy entries without actor scope are owner/admin-only. Shared Assistant
facts are listed through an explicit read-only list mode, with required-role filtering derived from
the caller's current role. Verification: Agent memory projection/ingress suites **5/5**, Spaces
Project memory suites **3/3**, Agents/Spaces typechecks and `git diff --check`. Code
`89764820231025acd92395dd2e1f9c7fc9f49505` is pushed to `origin/Mcbt5s-Backup-2`. Local/mock only;
no deployed privacy acceptance. APW04 remains partial for retention/deletion semantics across stores,
immutable source revisions, selective-context evaluation and private-project leakage testing.

**Exact next action:** implement owner-visible deletion for the current actor's personal memory rows
with exact row identity, then continue APW02 bounded replanning or another independent gap. Keep
rollout flags disabled and preserve the untracked Python cache.

## APW02 checkpoint — 2026-11-18 (progressive concurrency controller; `796182c7` pushed)

The durable goal DAG now supports an opt-in `progressive-v1` admission policy. Independent work
starts with one worker, successful progress ramps concurrency up to the current host/task ceiling,
ready-frontier narrowing lowers it, and failure/review contracts future admission. Existing
in-flight workers are not cancelled. AgentDO wires the policy only when
`GOAL_ADAPTIVE_CONCURRENCY_ENABLED=true`; the flag is absent by default, so rollout remains disabled.
The goal activity API and Shell display current concurrency and the adjustment reason. Verification:
goal DAG/architecture suites **59/59**, Agents/Shell typechecks and `git diff --check`; local only.
APW02 remains partial: no mid-run task insertion, evidence/cost-calibrated routing, safe cancellation,
or deployed evaluation. Code `796182c785f18a69c0624d93acee1385cf7201e5` is pushed; rollout gate is off.

**Exact next action:** continue bounded dynamic replanning with stable task identity and host
revalidation, or move to another independent active-plan gap if planner inference would lack durable
billing/admission.

## Checkpoint — 2026-11-18 (`5aca9a29` pushed; APW02 next)

APW03 task decision references are pushed in `41c3b886b089d741441bc0d7fb7daf6072decb16` to
`origin/Mcbt5s-Backup-2`. PW03 writes v2 bounded checkpoint lineage (eight attempt
receipts) and pins progress to the Coordinator worker-branch revision/manifest hash when available.
Resume and the internal worker-result reader include that payload only if the same branch head still
matches; stale, legacy or unavailable branch checkpoints are withheld from both resume and internal
result reads, and the worker is told to recover from current workspace and disclose missing process
memory. Verification: checkpoint/delegation suites **18/18**, Agents typecheck and `git diff --check`.
Local/mock only; no deployed interruption acceptance. Legacy/R2 branches have no Coordinator pin;
full result revision lineage remains open. Code `5aca9a29746307dd60d840b320c39200f83cf67d` is pushed.

**Exact next action:** implement APW02 bounded dynamic host replanning in the durable goal DAG, then
continue the next independent gap. Keep rollouts disabled and preserve `infra/scripts/__pycache__/`.

## Checkpoint — 2026-11-18 (task-level Project decision dependencies; local verification)

Goal tasks now accept up to four validated `{id, revision}` references to the Project decision register. The host loads the scoped CAS Journal and rechecks that every referenced decision remains active at the exact revision and that any workspace pin still matches before dispatch, immediately before the external dispatch boundary, after successful worker completion/verification and when resuming saved completed tasks. A missing/stale/unavailable reference holds work as `needs_review`; DAG dependents become blocked. Dispatch race holds are marked in the durable outbox. References/reasons are stored in actor-scoped goal metadata and shown in the authenticated task UI; worker prompts carry the bounded references and tell workers to reread the current register. Verification: goal DAG/Project Journal/goal activity route suites **69/69**, Agents and Shell typechecks, `git diff --check`. Local/mock only; no browser/deployed acceptance. APW03 still lacks full base/result workspace revision linkage, semantic conflict mapping, integration evidence UX and owner review actions.

**Exact next action:** safely push this checkpoint to `origin/Mcbt5s-Backup-2`, then continue APW02's uncoded dynamic graph expansion/contraction only through a bounded host replan contract; otherwise continue the next independent active-plan requirement. Preserve the Python cache and rollout-disabled boundary.

## Latest pushed checkpoint — 2026-11-18 (`4b982864`)

The prior Project field-guide deletion and actor-filtered, bounded ingress memory checkpoint is `2b16d9f7f191619ff23e78378a9008f5b5546c3a`. This checkpoint adds store freshness timestamps from local structured/episodic records, Vectorize metadata when present, and authoritative Project fact `updated_at` through the Spaces route/client. Agent prompt context displays these as timestamps alongside bounded record IDs and layer. Do not describe timestamps as immutable content revisions. Legacy vectors may lack timestamps. Verification: Agents memory client/ingress/scope **13/13**, Spaces Project fact route **2/2**, Agents/Spaces typechecks and diff hygiene; local/mock only, no deployment/live acceptance. `4b9828643d1daa550ad96ce181e8d408e72954a8` is pushed to `origin/Mcbt5s-Backup-2`.

**Exact next action:** continue the next independent active-plan code gap. APW03 still needs task-level decision references and invalidation; APW04 still needs canonical source versions where the store can supply them and broader retention/leakage checks. Reconcile latest Knowledge and resumable-workflow callers before selecting the implementation slice.

## Checkpoint — 2026-11-18 (memory source freshness metadata; local verification)

Local structured facts now carry their `updated_at`, episodic and promoted semantic memories carry their creation timestamp when Vectorize metadata is present, and the Project fact endpoint/client passes through the authoritative row `updated_at`. The prompt renderer exposes this bounded freshness timestamp with layer/record identity. This is an update timestamp, not a content revision or hash; legacy vectors without metadata remain unversioned. Verification: Agents memory client/ingress/scope **13/13**, Spaces Project memory route **2/2**, both worker typechecks and `git diff --check` pass. Local/mock only; no deployed acceptance. APW04 exact source revisions, source hashes, retention/deletion policy across all stores and quality/leakage evaluation remain open.

**Exact next action:** safely push this checkpoint to `origin/Mcbt5s-Backup-2`, then continue the next independent requirement. For APW04, add immutable source revision/hash links only where the authoritative store provides them; otherwise keep the gap explicit and move to an independent planner, workflow, shared-compute, Knowledge or extensible-platform code gap. Preserve the Python cache and rollout-disabled boundary.

## Checkpoint — 2026-11-18 (memory prompt scope and guide deletion; local verification)

The Project field-guide register now has an admin/owner-only deletion operation requiring the exact entry revision; deleting removes both content and source pointers from the shared journal. The ingress memory prompt renderer independently filters actor-attributed recall to the current authenticated actor (and excludes it when there is no actor), retains bounded layer/record IDs for provenance, and limits selected rows to about 900 estimated tokens. This is a second privacy boundary; underlying store authorization remains required. Local ingress and Project Journal tests **12/12**, Agents typecheck and `git diff --check` pass. The renderer does not yet receive canonical source revisions or expiry/retention metadata; shared Project/Space and personal memory review/deletion rules still need reconciliation. No deployed/live acceptance.

**Exact next action:** safely push this checkpoint to `origin/Mcbt5s-Backup-2`, then implement revision-bearing memory provenance from existing stores or record the exact adapter contracts that prevent it, and continue auditing selective context assembly and Knowledge retention. Keep rollout disabled and preserve `infra/scripts/__pycache__/`.

## Checkpoint — 2026-11-18 (reviewed Project field guide; local verification)

APW04 now reuses the existing scoped Project Journal for a bounded field-guide register: one-line entries up to 400 chars, up to four source pointers, max 40 retained entries and the Journal's 16 KiB cap. Authenticated Project members can propose; current admin/owner must approve/reject the exact revision. Approval pins the current workspace head when available; reads report `current`, `stale`, `unavailable`, `unpinned` or `not_active`. Tool results and descriptions explicitly identify content as untrusted, non-authoritative guidance that is not auto-injected and cannot grant capabilities or budget. Round-trip/staleness/review/validation and planner kernel tests **22/22**, Agents typecheck and `git diff --check` pass. Local/mock only, not deployed. This covers Project guidance only; personal/Space guides, deletion/retention controls, selective token-aware context assembly and memory evaluation remain uncoded or partial.

**Exact next action:** safely push this checkpoint to `origin/Mcbt5s-Backup-2`, then implement a scoped owner/admin field-guide deletion/retention path and continue the APW04 context assembly trace. Preserve `infra/scripts/__pycache__/`; keep rollout disabled.

## Checkpoint — 2026-11-18 (cross-thread Project decision staleness; local verification)

`project_journal.read_decisions` now compares each active pinned decision with the current canonical workspace head and returns `workspaceStatus` (`current`, `stale`, `unavailable`, `unpinned`, or `not_active`). This is read-time advisory metadata: it does not mutate or revoke approval. The operation guidance tells later threads to revalidate stale/unavailable decisions against current Project code. The regression test proves a second actor sees a stale decision after the workspace advances and the persisted reviewed record remains unchanged. Focused Project Journal suites **20/20**, Agents typecheck and `git diff --check` pass. Local/mock only; no deployed acceptance. APW03 remains partial: tasks do not yet persist explicit decision ID/revision dependencies or automatically become `needs_review` when one changes.

**Exact next action:** safely push this checkpoint to `origin/Mcbt5s-Backup-2`, then implement the next APW04 scoped memory/context gap using existing Knowledge and Project stores, starting by tracing current context assembly and retention callers. Keep rollouts disabled and preserve `infra/scripts/__pycache__/`.

Source plan copied from `origin/plan/microapps-ui-sdk-voice` commit
`f991071dbb955423a359dba4cdf3ea2054ce9efc`; copied SHA-256
`8845f496b399408592d45670f04ce88e12176d61940cb8e16356a949ae6d3edf`. This plan extends the
planner/worker isolation, resumable workflow, shared compute, workspace, Knowledge and platform
plans; it does not replace their IDs or authorities.

## Requirement map

| ID | Requirement | Status and evidence | Remaining work / gate |
| --- | --- | --- | --- |
| APW01 | Reconcile planner, DAG, model routing, task memory, branches, recovery, callers and billing against current source. | PARTIAL AUDIT: planner-first protocol is in `workers/agents/src/script-engine/planner-first.ts`; bounded DAG dispatch and recovery are in `goal-dag.ts`; directed scoped task messages use `task-blackboard.ts`; runtime and token limits already apply. Existing ledgers cover PW01–PW06, SC01–SC05, K01–K30 and platform P/AP requirements. | Continue current-source comparisons when implementation reaches a requirement; no baseline task-quality/cost benchmark is recorded. |
| APW02 | Choose direct, one-worker, sequential or parallel execution; adapt within limits and explain the choice. | PARTIAL: planner-first routing is in `script-engine/planner-first.ts`; the bounded topology controller and durable receipt are in `script-engine/goal-dag.ts`. Opt-in `progressive-v1` begins independent graphs at one worker, ramps on verified progress, contracts after failure/review and narrows to the ready frontier (`796182c7`); a bounded 32-entry report-only history now records task/verification evidence. A gated host path supports structured one-level expansion, deterministic namespaced IDs, a 12-task ceiling, parent-budget inheritance, scoped metadata/blackboard updates, authorization/Billing-path checks and staged persistence replay (`139c6654` plus 2026-11-23 follow-ups). Goal plans admit at most four depth-two planners with bounded nested child-task allocations. Explicit alternative groups now have a default-off cancellation gate, durable dispatch fence, exact-attempt start check and bounded late-result/effects receipts (2026-11-23 follow-up above). Goal verification/runtime, token and internal-credit receipts join by stable worker ID. The paired local protocol/fixture is recorded above. | Cost-aware selection remains blocked pending a per-goal spend objective and representative controlled quality/cost evidence; internal credits may be unpriced and do not represent provider invoices. Real-runtime/provider comparative acceptance remains blocked under the protocol. Progressive routing, expansion and redundant-worker cancellation stay disabled by default. No savings claims or aggregate USD/credit escrow for expansions; per-inference quota/project-spend admission remains authoritative where configured. |
| APW03 | Durable task tree, ownership, decisions, dependency/revision links, scoped blackboard and conflict coordination. | PARTIAL/OVERLAP: goal tasks can carry up to four exact Project decision refs. Host rechecks active status, proposal revision and canonical workspace pin before dispatch, again at dispatch/result/resume; stale work becomes `needs_review` and blocks dependents. Actor-scoped task UI displays refs and the hold reason. | Result-branch/workspace revision lineage, conflict integration/evidence UX and owner decision-review controls remain partial; Journal is bounded at 16 KiB. |
| APW04 | Scoped memory layers, provenance, context assembly, safe compaction, field guide, privacy and invalidation. | PARTIAL/OVERLAP: ingress rendering rechecks actor; Space Assistant reads scope rows to the current actor and restricts legacy entries to owner/admin; personal fact/episode UI deletion is member-gated and exact on category, row ID and actor (`cba38ee9`); shared facts are role-filtered. Existing Knowledge provenance and reviewed Project guide controls are reused. | Canonical content revisions/hashes are missing for some stores; legacy vectors lack timestamps; retention/deletion policy across stores, selective assembly evaluation and private-project leakage testing remain. |
| APW05 | Hierarchical cost accounting, pre-admission reservations, model/runtime selection, thrash control and fair scheduling. | PARTIAL/OVERLAP: shared-compute/TBR ledgers cover admissions; existing owner usage is now visible beside goal tasks as internal credits plus unpriced or pending states. | Atomic task/run reservations, uncertain-charge reconciliation, planner/integration/reviewer usage, automatic thrash detection, priority/fairness policy and provider USD evidence remain; exact contracts/policy and live billing are separate. |
| APW06 | SDK/template controls, authorized task UI, safe pause/cancel/resume, operations and evaluation. | PARTIAL/OVERLAP: actor-scoped task UI shows topology, role, token budget, acceptance criteria, runtime recommendation, per-task internal-credit usage, status and verification; worker checkpoint/recovery disclosures exist. | Decision/conflict UX, user/admin topology/budget preferences, comprehensive cancel/pause controls, and real-runtime/deployed comparative acceptance remain. |
| APW07 | Exact-revision workspace integration, conflict classification, neutral resolution proposals and checked publication. | PARTIAL/OVERLAP: PW03/EP04 provide isolated worker branches, pinned checkpoint lineage, checked publication, Project decision revision guards and conflict preview/resolve callers. APW02 now retains bounded late cancellation receipts and existing publication evidence. | Semantic/interface conflict classification, full base/result revision and validation receipt linkage, cross-DO/live cancellation races and broad integrated behavior evidence remain in the PW/EP ledgers. |
| APW08 | Durable resume, scoped user-visible task state and SDK/template orchestration declarations. | PARTIAL/OVERLAP: PW01–PW06 persist bounded workflow/checkpoint state; authenticated goal activity exposes topology, decisions, budgets and status; template/business-role and extensible SDK requirements are tracked in their ledgers. | Full user pause/resume/approval controls, stale authorization/budget recovery coverage, adaptive topology declarations for templates/SDK and real interruption acceptance remain. Never claim process-memory restoration. |
| APW09 | Evaluation, comprehensive economics and runaway/thrash controls before rollout. | PARTIAL/OVERLAP: SC/TBR ledgers cover internal credit admission, usage receipts and concurrency; the APW02 local comparison protocol/fixture is in the benchmark ledger; progressive routing and redundant-worker cancellation are opt-in and absent by default. | Representative model/customer task-quality and actual spend evidence, complete planner/integration/reviewer/provider metering, fair scheduling and real-runtime/live acceptance remain; no savings claims. |

The new plan was fetched from `origin/plan/microapps-ui-sdk-voice` at
`f991071dbb955423a359dba4cdf3ea2054ce9efc` and copied into this worktree. SHA-256:
`8845f496b399408592d45670f04ce88e12176d61940cb8e16356a949ae6d3edf`. APW07–APW09 explicitly
reuse PW/EP, workflow/template/SDK and SC/TBR authorities rather than duplicating them.

## Latest code checkpoint — 2026-11-17 (adaptive DAG topology receipt)

`goal-dag.ts` now computes topology from validated dependency reachability. A single task records
`single_worker`; a total dependency order records `sequential` and uses one active worker; a graph
with independent tasks records `parallel` and uses no more than current host concurrency or task
count. The journal is recomputed against live host limits on each resume, preventing a saved choice
from raising the current ceiling. The normal scheduler expands when its ready frontier has capacity
and contracts as tasks/dependencies exhaust it. It does not dynamically add tasks or make live model
quality/cost claims.

Local verification: `corepack pnpm --filter @naelao/agents-worker exec vitest run
src/script-engine/goal-dag.test.ts` **51/51**; Agents typecheck; `git diff --check`. No deployment,
provider call, migration or live acceptance. Rollouts remain disabled. At this entry the source,
tests, AGENTS.md and this ledger are uncommitted; preserve `infra/scripts/__pycache__/`.

**Exact next action:** fetch `origin/Mcbt5s-Backup-2`, verify no divergence, commit and push this
coherent checkpoint without rewriting remote history. Then continue SC03 durable admission only if
exact invocation authority and fresh Billing can be revalidated; otherwise proceed to the next
independent code gap in the active ledgers.

## Cross-plan checkpoint — 2026-11-17 (planner topology guidance; `c0c0f0fb` pushed)

`PLANNER_FIRST_PROTOCOL` now instructs the planner to use direct answers only for self-contained
requests and otherwise choose the smallest useful worker topology: one coherent worker, sequential
dependencies, or independent DAG work. It prohibits unnecessary workers and topology-based bypasses
of specialists, permissions, approvals or requested capabilities. Existing host controls continue to
select models/runtimes and enforce depth, attempts, concurrency and billing. Focused planner/DAG
tests **66/66**, Agents typecheck and diff hygiene pass. `c0c0f0fb` (including the topology receipt
and copied plan/ledger) is pushed to `origin/Mcbt5s-Backup-2`.

This guides model planning; it is not measured adaptive quality/cost, dynamic task insertion during a
running DAG, a new memory store, or live/deployed evidence. Exact next action: reconcile APW03 durable
task ownership/revisions and APW04 memory provenance with existing workflow journals, project memory,
Knowledge ACLs and private-Project policy, then implement the next missing reachable boundary.
SC03 remains independently blocked from disconnected replay because the host cannot yet revalidate
the exact invocation authority and fresh Billing admission; keep it fail-closed and continue other
code work. Rollouts remain disabled.

## Cross-plan checkpoint — 2026-11-17 (durable task contract in owner view; implementation pending push)

The persisted actor-scoped goal metadata now keeps each task's role, bounded model-token budget,
acceptance criteria and host-approved runtime recommendation. The authenticated activity route
validates/bounds these optional fields while retaining compatibility with older records; the Shell
shows them beside dependencies, verification and status. The runtime recommendation is descriptive
and does not grant capability. Local AgentDO route tests **5/5**, Agents/Shell typechecks and diff
hygiene pass. No browser/deployed acceptance. Exact next action: fetch and safely push this checkpoint,
then continue APW03 revision/ownership lineage or APW04 scoped memory and privacy gaps from their
existing records. SC03 remains fail-closed pending exact disconnected invocation authorization and
Billing admission. Keep rollout disabled and preserve the Python cache.

## Cross-plan checkpoint — 2026-11-17 (owner task topology receipt; implementation pending push)

The authenticated goal-activity projection now includes only a validated topology receipt from the
actor-scoped durable journal. The Shell task and worker panels display its mode and selected
concurrency relative to the host ceiling. This makes the actual persisted decision visible without
exposing worker transcripts beyond the existing actor/message scope. Local verification: AgentDO
goal-activity route **5/5**, Agents and Shell typechecks, `git diff --check`. No browser/deployed
acceptance. Exact next action: fetch and push this caller/UI checkpoint safely, then continue
APW03/APW04 lineage and memory authorization gaps; keep rollout disabled and preserve the Python
cache artifact.

## Cross-plan checkpoint — 2026-11-17 (personal-memory isolation and deletion authorization; pending push)

The memory prebuilt now rejects an explicit `user_id` that differs from the authenticated run actor
and cannot select a personal namespace when no actor exists. `MemoryStore.forget` carries the current
actor; local structured facts and episodic rows delete only under that user scope, and semantic
Vectorize deletion occurs only when an owned episode exists. Shared Project-fact deletion sends the
current effective role rank, and SpaceDO deletes only rows whose `required_role_rank` is no greater.
Local tests: Agents memory/client **14/14**, Spaces fact deletion **1/1**, Agents/Spaces typechecks,
diff hygiene. No migration, deployment or live acceptance. Exact next action: fetch and safely push;
then continue Knowledge/Project memory retention/review and APW03 decision/revision lineage across
the existing ledgers. Shared-memory policy for other layers and private-Project visibility remains
open; do not widen scope or infer product policy. Rollouts remain disabled.

## Cross-plan checkpoint — 2026-11-17 (per-task internal usage in worker panel; implementation pending push)

The worker panel now joins each goal task's persisted worker ID with the existing owner/admin usage
response and displays settled internal credits, unpriced-event count, or pending/unavailable state.
It labels the unit as internal credits and does not infer USD provider cost. Shell typecheck and
`git diff --check` pass; no browser/deployed acceptance. Exact next action: fetch and push, then
continue APW03 durable decision/revision lineage and APW04 scoped memory lifecycle. Hierarchical
atomic reservations and exact provider charges remain open under the existing billing/shared-compute
contracts. Rollouts remain disabled.

## Cross-plan checkpoint — 2026-11-18 (reviewed project decision register; implementation pending push)

The existing CAS-backed Project Journal now stores a bounded, versioned decision register with topic
key, proposal, rationale, interface references, proposer, reviewer, status, revision, timestamps and
explicit supersession. Project members with an authenticated actor may propose; current Project
admin/owner rank (>=2) is required to approve/reject. Review uses exact expected revision; another
active decision on the topic requires naming the exact superseded ID. Legacy `active_decisions` are
read-only through the old update operation and are explicitly labelled unreviewed. The planner is
instructed to read this register before creating project contracts. When the canonical workspace
manifest is available, proposals pin branch, revision and manifest hash; review rechecks that exact
head and refuses stale/unavailable revisions. Legacy workspaces without a manifest hash remain
unpinned. Verification: journal round-trip/hostile-data, decision proposal/review/supersession/
stale-head and planner tests **21/21**, Agents typecheck, diff hygiene. No browser/deployed
acceptance. Exact next action: fetch and push safely, then continue APW03 cross-thread decision
invalidation and APW04 field-guide/context gaps without duplicating the Journal or Knowledge
authority. Rollout remains disabled.
