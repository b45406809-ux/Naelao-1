## Cross-plan update — 2026-11-17 (scheduled identity enforced at AgentDO ingress; local pending)

The scheduled service ID and exact job revision are persisted in its dedicated session and verified against that session by AgentDO before execution. The authorization row is rechecked after prep; busy-status uncertainty fails closed. Blackboard wake semantics are separated from scheduled work. Tests **22/22**, Agents typecheck and diff check pass. No deployment acceptance. Effect-level grant/revoke/budget and in-flight cancellation are still code gaps. Exact next action: propagate the service identity/revision into durable per-effect authorization and recovery receipts, then continue PW work.

## Cross-plan update — 2026-11-17 (scheduled run identity/revision correlation; local pending)

Scheduled goal and direct-script paths now share stable `scheduled_job:<id>` identity, exact configuration revision and deterministic sweep run ID. Goal execution stores identity/revision in session metadata and context; direct-script run ID feeds existing receipt/billing path. Together with stale-row reauthorization and fail-closed active-run status, this improves replay and conflict handling. Local tests **13/13**, Agents typecheck and diff check pass; no deployed acceptance. It does not cancel already-running effects or implement grant authority. Exact next action: enforce and persist the identity/revision at the downstream effect boundary, then continue other PW and cross-plan gaps.

## Cross-plan update — 2026-11-17 (unavailable active-run status now blocks wake; local pending)

Autonomous `wakeAgentGoal` now requires a valid idle response from the AgentDO active-run endpoint. Active remains a 409; missing/non-OK/malformed/missing-field status returns a retryable 503 without dispatch. This closes the former fail-open overlap behavior. Focused wake/dispatch/tenant-scope tests **12/12**, Agents typecheck and diff check pass. This is local evidence; no deployed DO/workflow acceptance. Exact next action: bind scheduled-work service identity, exact job revision and cancellation/revocation receipt to the durable run, then continue runtime/effect isolation and other PW gaps. Do not claim cancellation of already-running effects.

# Resumable workers, durable workflows and branches progress

## Cross-plan update — 2026-11-17 (scheduled direct-script stale authorization fence; `93568569` pushed)

The direct scheduled-script path now has a durable session identity/revision receipt and a final exact current-job revision/script/Project check. Code `93568569878ca356132a105ba206b4a77d35ff93` is remote-verified; local focused suites **14/14**, Agents typecheck and diff check pass. This blocks not-yet-started stale direct scripts; it does not cancel already-running effects or settle per-run effects/costs. No deployed Workflow/DO or runtime isolation acceptance. Exact next action: continue PW's effect cancellation and currency/compute settlement audit alongside the remaining cross-plan code requirements.

## Latest code checkpoint — 2026-11-16 (exact Coordinator worker branch pin; `c17b6e01` pushed)

For unified-workspace delegated worker executions, the host now supplies the exact current Coordinator branch revision and manifest hash through the authenticated Container invocation scope. Script execution reads the head for each launch; ToolSandbox validates the pin before replaying pending durable writes and rechecks it after recovery. Coordinator `/v1/branch` accepts an expected source head and atomically rejects a raced/stale source; runtime hydration verifies the exact worker branch base and its materialized run head. Tests: ToolSandbox, WorkspaceCoordinatorDO, container policy and execution ladder **155/155**, Agents typecheck and diff check. Code `c17b6e01709d16cfa8ea01eaf57f37abc52dc0ce` is remote-verified.

This covers local Coordinator-backed source pinning only. Legacy R2 branches have no immutable Coordinator revision; deployed Container process/filesystem/dependency/cache/credential/network isolation and cross-DO concurrency acceptance remain open. No deployed/runtime/live acceptance or rollout occurred. Exact next action: continue TBR05 invitation/identity boundaries in the platform ledger, then resume remaining PW isolation and S/U/P/K/EP/TBR/AP implementation gaps. Preserve `infra/scripts/__pycache__/` and keep rollout disabled.

## Previous code checkpoint — 2026-11-16 (delegated branch runtime isolation; `21de8512` pushed)

The actual code-runner and lifecycle callers both use `sandboxInstanceName`. That router now assigns distinct exact-branch ToolSandbox/DynamicSandbox DO identities for delegated `workers/...` branches, isolating their warm process and private `/workspace` disk. Main and ordinary feature branches retain the existing shared project runtime; `race/...` remains isolated. Code `21de85123e85ead3aa1f7c2b107c0aa6ce890973` is remote-verified. Routing/execution-ladder tests **27/27**, Agents typecheck and diff check pass. This is local implementation evidence; no deployed container test ran. It does not bind the runtime to an immutable WorkspaceCoordinator head/revision, prove provider-level cache/credential/network isolation or restore unsaved process memory.

Exact next action: trace worker branch creation to Coordinator head and bind each worker runtime to the authorized exact base/head revision. Ensure materialization reads only the immutable pinned revision and stale/wrong branch identities fail closed; keep publication behind checked CAS. Add stale-head, wrong-branch, replay and concurrency tests, then continue TBR02 and other S/U/P/PW/K/EP/AP code gaps. Rollouts remain disabled.

## Latest code checkpoint — 2026-11-16 (authorized AgentTask recovery status; `fc3318bb` pushed)

The existing authorized task list/detail route now enriches each task from its tenant/Space/run-scoped WorkflowRunDO journal after its session/Project access checks. The response is content-free and omits private R2 keys/results; it reports last completed step metadata, digest prefix/size, and whether the workflow journal advanced after the checkpoint. A scope mismatch or unavailable journal produces no checkpoint data. Shell displays this receipt and warns that unsaved process memory is not recoverable. Code `fc3318bb702d355a21998b22651761edd591d307` is remote-verified. Recovery summary + AgentTask checkpoint + WorkflowJournal + WorkflowRunDO tests **28/28**, Agents/Shell typechecks and diff check pass. These are local tests only; no deployed Workflow/DO/R2, browser or runtime-isolation acceptance ran. It neither recovers model/process memory nor proves branch isolation.

The previously traced runtime isolation gap is partially implemented above for delegated worker branches. Exact branch/head revision binding, complete provider isolation and deployed acceptance remain open.

## Latest code checkpoint — 2026-11-16 (durable AgentTask step checkpoints; `1dd54057` pushed)

The static AgentTask workflow now records the last completed native durable step in `WorkflowJournal`, with monotonically increasing sequence and bounded 64-entry lineage to registered, scope-validated content-hashed artifacts. The wrapper records only after `step.do` returns; exact step replay returns the existing receipt and a changed pointer conflicts. Local verification: WorkflowJournal/WorkflowRunDO/AgentTask checkpoint tests **26/26**, Agents typecheck and diff check. Code `1dd540579b8af79c5dcbfcc638c0a384d5b3502c` is pushed and remote-verified. No deployed Workflow/DO/R2 or runtime recovery acceptance ran. This records step output metadata; it does not restore unsaved thought, stream tokens, process state, or guarantee branch/runtime isolation.

The formerly recorded task-status/Shell action is completed in `fc3318bb` above. Continue with actual branch mount/runtime isolation; the earlier local durable-step checkpoint does not imply recovered process state.

## Source and reconciliation — 2026-11-16

Fetched `docs/research/resumable-workers-durable-workflows-and-branches-plan.md` from `origin/plan/microapps-ui-sdk-voice` commit `ccca618f6c79be4f422f58e12408313e1b69622a`; copied SHA-256 `ccb7a388f6e3fc073c683d284c976ea45a74b0760ad1bbe22e5d518787acb384`. No checkout or merge of the planning branch.

The new plan extends, and does not replace, PW01–PW06. Current code/ledger evidence already covers logical task/worker branches, branch-parent checks, durable worker attempts/status, approval resume reconstruction, workflow/effect journals, bounded merges/manual conflict review, exact-revision check evidence in some paths, and the PW06 parent-DO cancellation/publication permit. PW01–PW06 remain partial: branch identity is not runtime isolation; process/filesystem/package/cache/port isolation is unproven; restart does not restore unsaved model/process memory; durable worker transcript/checkpoint lineage and user-visible recovery/loss semantics are incomplete; workflow steps/artifacts and parallel orchestration are partial; full runtime/provider cost settlement, branch/Git synchronization contracts, cross-service cancellation races, recovery UX and deployed acceptance remain open. See platform progress PW matrix for exact prior test evidence; do not repeat it without code changes.

| Area | Status | Next evidence/gap |
| --- | --- | --- |
| Multiple logical branches and coordinator publication | PARTIAL | Audit simultaneous branch callers and branch lifecycle/retention; do not equate logical branch with process isolation. |
| Runtime isolation and branch mount | PARTIAL_LOCAL + LIVE_GATE | Exact Coordinator branch/revision pin and stale-head fail-closed behavior are implemented in `c17b6e01`; legacy R2 has no immutable Coordinator revision, and deployed process/filesystem/dependency/cache/port/env/credential isolation remains unverified. |
| Durable worker checkpoints/recovery | CODE_GAP | Persist bounded versioned checkpoint lineage and recovery states; resume only verified durable state, disclose missing unsaved memory, fence attempts and recheck authority/budget. |
| Durable workflow steps/artifacts | PARTIAL | Reconcile WorkflowRunDO step receipts, pinned inputs/code, retry/idempotency and artifact retention with interruption/recovery cases. |
| Effects, billing, cancellation | PARTIAL | Preserve unknown outcomes; no replay of indeterminate effects; close per-run compute/currency settlement and cross-DO cancellation/publication races. |
| UI/operations/acceptance | CODE_GAP + LIVE_GATE | Show last durable checkpoint and known loss window; real Workflow/DO/R2/runtime/provider recovery tests remain deployment gates. |

No rollout, deployment, provider call or migration occurred for this plan. These are mostly ordinary code and runtime-contract gaps, not credential blockers. Distinguish logical branches, actual runtime isolation, durable checkpoint recovery and unsaved process memory. Never claim the latter is recovered.

The prior action to trace WorkflowRunDO checkpoint/recovery was completed in `1dd54057`/`fc3318bb`; delegated branch runtime separation is completed locally in `21de8512`, and exact Coordinator head binding is completed locally in `c17b6e01`. Continue from the top checkpoint: TBR05 invitation and identity boundaries, then remaining independent PW and cross-plan code gaps. Keep rollout disabled.
## Cross-plan update — 2026-11-17 (scheduled HITL resume authorization recovery; `688f69e4` pushed)

Code `688f69e4c9cae6c29986efb17d65a507779134e9` is remote-verified. Durable suspended-run rows now preserve the scheduled job service context; resume rechecks the signed internal heartbeat session and exact current enabled job revision, and a missing/stale identity cannot be resumed as an ordinary user run. Older rows may recover only from the authenticated session; transient session lookup failure remains retryable. Focused tests **28/28**, Agents typecheck and diff hygiene pass. This is not unsaved process-memory recovery, in-flight provider cancellation, runtime isolation acceptance or a per-job compute-cost reservation. Continue PW cost/cancellation requirements alongside other plans.
## Cross-plan update — 2026-11-17 (K03 page-marker preservation; PW05 next)

The Knowledge PDF adapter now preserves only explicit increasing page numbers from optional parser
response metadata and binds the behavior to a new parser version. Missing/malformed metadata falls back
to the previous flat text path; no current Cohere response contract or live page output was verified.
Local Knowledge parser/ingestion/archive/workflow checks **26/26** and typecheck pass. K03 remains partial.

Exact next action: trace PW05 delegated worker execution through current per-run Billing reservation and
settlement receipts; implement an exact run-scoped host receipt if current authorization, budget and
runtime identities align. Do not equate model token allocations with actual currency/compute usage or
claim runtime isolation. Continue all other active plans after this slice.
