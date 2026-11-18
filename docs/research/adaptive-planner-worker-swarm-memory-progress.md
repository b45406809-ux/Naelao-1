# Adaptive planner, worker coordination and memory progress

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
| APW02 | Choose direct, one-worker, sequential or parallel execution; adapt within limits and explain the choice. | PARTIAL: planner guidance and durable topology receipt are pushed. Opt-in `progressive-v1` begins independent graphs at one worker, ramps on success, contracts on failure/review, and persists current concurrency/adjustment reason; Agents/Shell exposes it. Feature gate is absent by default (`796182c7`). | No dynamic task insertion/replanning, measured quality/cost policy, hierarchical planner tree, safe cancellation of redundant running work or deployed/comparative evaluation. Worker ceiling remains a hard guardrail. |
| APW03 | Durable task tree, ownership, decisions, dependency/revision links, scoped blackboard and conflict coordination. | PARTIAL/OVERLAP: goal tasks can carry up to four exact Project decision refs. Host rechecks active status, proposal revision and canonical workspace pin before dispatch, again at dispatch/result/resume; stale work becomes `needs_review` and blocks dependents. Actor-scoped task UI displays refs and the hold reason. | Result-branch/workspace revision lineage, conflict integration/evidence UX and owner decision-review controls remain partial; Journal is bounded at 16 KiB. |
| APW04 | Scoped memory layers, provenance, context assembly, safe compaction, field guide, privacy and invalidation. | PARTIAL/OVERLAP: ingress rendering rechecks actor; the member-facing Space Assistant memory route now scopes personal rows to the current actor, adds only unscoped rows, restricts legacy unscoped entries to owner/admin, and role-filters shared assistant facts. Existing Knowledge provenance and reviewed Project guide controls are reused. | Canonical content revisions/hashes are missing for some stores; legacy vectors lack timestamps; retention/deletion policy across stores, selective assembly evaluation and private-project leakage testing remain. |
| APW05 | Hierarchical cost accounting, pre-admission reservations, model/runtime selection, thrash control and fair scheduling. | PARTIAL/OVERLAP: shared-compute/TBR ledgers cover admissions; existing owner usage is now visible beside goal tasks as internal credits plus unpriced or pending states. | Atomic task/run reservations, uncertain-charge reconciliation, planner/integration/reviewer usage, automatic thrash detection, priority/fairness policy and provider USD evidence remain; exact contracts/policy and live billing are separate. |
| APW06 | SDK/template controls, authorized task UI, safe pause/cancel/resume, operations and evaluation. | PARTIAL/OVERLAP: actor-scoped task UI shows topology, role, token budget, acceptance criteria, runtime recommendation, per-task internal-credit usage, status and verification; worker checkpoint/recovery disclosures exist. | Decision/conflict UX, user/admin topology/budget preferences, comprehensive cancel/pause controls, real-runtime/deployed acceptance and controlled one/sequential/adaptive evaluation remain. |

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
