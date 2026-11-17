# Adaptive planner, worker coordination and memory progress

Source plan copied from `origin/plan/microapps-ui-sdk-voice` commit
`f991071dbb955423a359dba4cdf3ea2054ce9efc`; copied SHA-256
`8845f496b399408592d45670f04ce88e12176d61940cb8e16356a949ae6d3edf`. This plan extends the
planner/worker isolation, resumable workflow, shared compute, workspace, Knowledge and platform
plans; it does not replace their IDs or authorities.

## Requirement map

| ID | Requirement | Status and evidence | Remaining work / gate |
| --- | --- | --- | --- |
| APW01 | Reconcile planner, DAG, model routing, task memory, branches, recovery, callers and billing against current source. | PARTIAL AUDIT: planner-first protocol is in `workers/agents/src/script-engine/planner-first.ts`; bounded DAG dispatch and recovery are in `goal-dag.ts`; directed scoped task messages use `task-blackboard.ts`; runtime and token limits already apply. Existing ledgers cover PW01–PW06, SC01–SC05, K01–K30 and platform P/AP requirements. | Continue current-source comparisons when implementation reaches a requirement; no baseline task-quality/cost benchmark is recorded. |
| APW02 | Choose direct, one-worker, sequential or parallel execution; adapt within limits and explain the choice. | PARTIAL: planner guidance and durable DAG topology receipt are pushed; task/worker UI displays topology and host limit. Chains use one worker; independent tasks use only current host-approved concurrency. | Planner selection is still prompt behavior; no evidence-calibrated routing, in-flight graph expansion, hierarchical planner tree, useful cost tradeoff or comparative evaluation. Worker ceiling remains a hard guardrail. |
| APW03 | Durable task tree, ownership, decisions, dependency/revision links, scoped blackboard and conflict coordination. | PARTIAL/OVERLAP: goal DAG journal and blackboard already persist task status, dependencies, dispatch IDs, directed messages, recoveries and verification; PW ledger covers isolated branches, checked publication and revision pinning. | Stable scope/owner/attempt/capability/budget/revision/decision lineage across all callers, versioned design-decision ownership and stale-decision invalidation remain code gaps. Reconcile before adding duplicate stores. |
| APW04 | Scoped memory layers, provenance, context assembly, safe compaction, field guide, privacy and invalidation. | PARTIAL/OVERLAP: Knowledge and agent memory have scoped access paths; memory tools now cannot select another user's namespace, local deletes are actor-scoped, and Project-fact deletes enforce the current effective role against fact rank. | Knowledge provenance/review/supersession/expiry, bounded field guide, token-aware selective context assembly and private-project non-disclosure remain partial; no general field-guide service or benchmark is claimed. |
| APW05 | Hierarchical cost accounting, pre-admission reservations, model/runtime selection, thrash control and fair scheduling. | PARTIAL/OVERLAP: shared-compute and TBR ledgers document runtime admission, queue receipts, internal-credit usage and gaps. | Atomic task/run reservations, uncertain-charge reconciliation, planner/integration/reviewer usage, automatic thrash detection, priority/fairness policy and provider USD evidence remain; exact contracts/policy and live billing are separate. |
| APW06 | SDK/template controls, authorized task UI, safe pause/cancel/resume, operations and evaluation. | PARTIAL/OVERLAP: actor-scoped task UI now shows topology, role, token budget, acceptance criteria, runtime recommendation, status and verification; worker checkpoint and recovery disclosures exist. | Decision/conflict/cost UX, user/admin topology/budget preferences, comprehensive cancel/pause controls, real-runtime/deployed acceptance and controlled one/sequential/adaptive evaluation remain. |

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
