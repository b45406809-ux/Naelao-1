## Cross-plan update — 2026-11-17 (scheduled identity enforced at AgentDO ingress; local pending)

The scheduled service ID and exact job revision are persisted in its dedicated session and verified against that session by AgentDO before execution. The authorization row is rechecked after prep; busy-status uncertainty fails closed. Blackboard wake semantics are separated from scheduled work. Tests **22/22**, Agents typecheck and diff check pass. No deployment acceptance. Effect-level grant/revoke/budget and in-flight cancellation are still code gaps. Exact next action: propagate the service identity/revision into durable per-effect authorization and recovery receipts, then continue PW work.

## Cross-plan update — 2026-11-17 (scheduled run identity/revision correlation; local pending)

Scheduled goal and direct-script paths now share stable `scheduled_job:<id>` identity, exact configuration revision and deterministic sweep run ID. Goal execution stores identity/revision in session metadata and context; direct-script run ID feeds existing receipt/billing path. Together with stale-row reauthorization and fail-closed active-run status, this improves replay and conflict handling. Local tests **13/13**, Agents typecheck and diff check pass; no deployed acceptance. It does not cancel already-running effects or implement grant authority. Exact next action: enforce and persist the identity/revision at the downstream effect boundary, then continue other PW and cross-plan gaps.

## Cross-plan update — 2026-11-17 (unavailable active-run status now blocks wake; local pending)

Autonomous `wakeAgentGoal` now requires a valid idle response from the AgentDO active-run endpoint. Active remains a 409; missing/non-OK/malformed/missing-field status returns a retryable 503 without dispatch. This closes the former fail-open overlap behavior. Focused wake/dispatch/tenant-scope tests **12/12**, Agents typecheck and diff check pass. This is local evidence; no deployed DO/workflow acceptance. Exact next action: bind scheduled-work service identity, exact job revision and cancellation/revocation receipt to the durable run, then continue runtime/effect isolation and other PW gaps. Do not claim cancellation of already-running effects.

# Resumable workers, durable workflows and branches progress

## PW06 checkpoint — 2026-11-23 (scheduled direct-script outcome reconciliation)

The queue now persists an exact direct-script run ID and bounded prior-attempt receipt with
`outcome_unknown` in a single D1 batch before invoking AgentDO. The status is excluded from dispatch
retention, blocks claims for all later sweeps of the job, and is surfaced in run history from the
dispatch row if history needs recovery. Definite pre-effect 4xx responses can become failed/skipped;
transport/5xx ambiguity, malformed success responses and script-level failures stay unknown because
the action may have started or partially applied.

An evidence-backed reconciliation endpoint requires Space admin membership plus Project manage
access, matches the exact job/run identity, and records the caller and evidence note. It supports
confirmed completion or verified no-effect; only the latter permits a later scheduled sweep to try
again. The Crons history UI shows the unresolved state and controls for authorized users. The
receipt is operational evidence only; it does not prove provider rollback, provider completion or
invoice-reconciled cost.

Verification: Agents worker and Spaces worker typechecks, Shell source-only typecheck and
`git diff --check` pass. The normal Shell typecheck still reports pre-existing stale imports in
generated `.next/types`. No tests, provider calls, deployment or live acceptance ran.

**Exact next action:** in `NaelaoAgentDO.ts`, make Project `reserveWorkerBranch` refuse the legacy
R2 copy fallback when no immutable Coordinator base pin is available; verify rejection occurs
before branch creation or worker dispatch.

## PW06 checkpoint — 2026-11-23 (direct scheduled-script pre-effect revision fence)

The direct scheduled-script path already checked the service session and exact job revision at
AgentDO ingress. It now repeats both checks after policy/budget admission and immediately before
`tools.run`. A changed, disabled, retargeted or unavailable job fails closed and attempts to settle
any reserved Project spend to zero under the same service identity/revision. Settlement uses the
existing best-effort helper; its failed outcomes rely on the current reservation expiry. This fences
work that has not started yet. It does not cancel an operation after dispatch or reconcile an
unknown provider result.

Verification: `corepack pnpm@9.12.0 --filter @naelao/agents-worker typecheck` and
`git diff --check` pass. The attempted filter `@naelao/agents` matched no workspace package; the
correct package check above passed. No tests, provider calls, deployment or live acceptance ran.

**Exact next action:** trace `scheduled_job_dispatches`, queue error handling and `scheduled_job_runs`
to determine how a post-dispatch lost/ambiguous response can be stored as `outcome_unknown` and kept
from replay on a later sweep until an authorized reconciliation path resolves it.

## PW01–PW06 source reconciliation — 2026-11-23

Current source matches the latest saved implementation summaries for the six PW areas:

| Requirement | Current source evidence | Remaining gap or acceptance limit |
| --- | --- | --- |
| PW01 branch lifecycle | `NaelaoAgentDO` records worker branch bases and checks the exact Coordinator head; `sandbox-routing.ts` routes delegated `workers/...` branches to separate ToolSandbox identities. | Legacy R2 has no immutable Coordinator revision; deployed process, filesystem, package, cache, port and credential isolation is unverified. Retention, revocation and cleanup remain partial. |
| PW02 task graph and communication | `goal-dag.ts` bounds graph admission and exact-attempt dispatch; `task-blackboard.ts` uses signed scope and host-granted recipient edges; authorized conversation routes project persisted worker progress. | File/resource hints are advisory; interface ownership, help/conflict/result receipts and all private-Project readers still need broader coverage. |
| PW03 selective resource leases | `ConcurrencyDO` implements bounded named leases with fencing; Coordinator writes recheck hashes, generations and fences. | Leases are cooperative. No mandatory lease is enforced at every shared mutable writer; deployed expiry/stale-holder behavior remains unaccepted. |
| PW04 integration and conflict | `mergeWorkerWorkspace` uses exact source/target pins, bounded merge/review paths, isolated validation branches and expected-head checked publication. | >2 MiB/corrupt object handling, some ambiguous rename cases, complete route/runtime integration coverage and deployed acceptance remain open. |
| PW05 runtime, cost and UI | Worker attempt run IDs feed normal billing settlement; owner/admin Space and Project reads aggregate exact attempt receipts. | Internal credits are not provider invoices. Process isolation, unknown/no-event explanation, cancellation/recovery UX and deployed acceptance remain partial. Default `AgentTaskWorkflow` still has no atomic per-run credit reservation (cross-reference APW05). |
| PW06 validation and operations | Exact revision receipts and the parent-DO permit fence cancellation against an exact worker attempt/candidate/target; scheduled direct scripts now persist an unknown attempt receipt and require authorized reconciliation before another sweep. | Cross-DO/Artifact publication races, in-flight effect cancellation, per-run currency/compute settlement and deployed concurrency/recovery acceptance remain open. |

Checkpoint and workflow comparison: versioned worker checkpoint lineage and exact Coordinator pins are present; `WorkflowJournal` stores bounded step/artifact receipts; authorized task routes expose content-free recovery summaries; HITL resume revalidates the scheduled service identity and job revision. These do not restore unsaved process/model state. Dynamic extension workflow effects have their own prepared/committed/indeterminate records and budget settlement; those guarantees do not automatically cover static `AgentTaskWorkflow` or direct scheduled scripts.

Scheduled-run caller comparison: the queue rechecks an exact job snapshot after claiming and preparation. Goal runs revalidate the current job at loop boundaries and before approval resume. At the source-audit point, direct scheduled scripts checked the exact enabled job revision and script name at AgentDO ingress but performed config/policy/budget work before `tools.run` without a final source recheck; the final pre-effect fence is implemented in the checkpoint above. It prevents a stale operation from starting, but does not stop an operation already in flight or provide an unknown-outcome effect receipt.

This source audit's pre-effect recheck and the scheduled direct-script unknown-outcome path are
completed in the PW06 checkpoints above. The scheduled path is code-only and requires human
evidence for reconciliation; other in-flight effect cancellation and cross-service effect contracts
remain open.

## PW03 checkpoint — 2026-11-18 (bounded workspace-pinned attempt lineage; `5aca9a29` pushed)

Worker checkpoint envelopes are now v2 with at most eight metadata-only prior-attempt receipts.
For Coordinator-backed worker branches, each checkpoint records exact branch, workspace revision and
manifest hash. Resume re-reads the head and includes checkpoint progress only when the pin matches;
legacy, stale or unavailable branch checkpoints are withheld from both resume prompts and the internal
worker-result reader so work resumes from the current authorized workspace and the worker is instructed
to disclose that process memory was not recovered. The host session-update caller and direct delegation
completion both persist the pin status. Focused checkpoint/delegation suites **18/18**, Agents typecheck
and `git diff --check` pass. Code `5aca9a29746307dd60d840b320c39200f83cf67d` is pushed to
`origin/Mcbt5s-Backup-2`. Local/mock only;
no deployed DO/Workflow interruption acceptance. R2/legacy branches cannot provide immutable
Coordinator pins, and no process memory is restored.

**Exact next action:** continue APW02 bounded dynamic replanning; preserve the untracked Python cache
and keep rollout disabled.

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

## Worker checkpoint receipt — 2026-11-17 (`856fb145` pushed)

The worker list API now returns a timestamp when durable checkpoint JSON exists, without returning
checkpoint payloads. The Shell worker panel shows that timestamp and explicitly says resume uses
saved progress plus the currently authorized workspace; unsaved process memory is not restored.
Agents focused delegation test **10/10**, Agents/Shell typechecks and `git diff --check` pass.
This is a UI receipt and loss-boundary disclosure, not complete versioned checkpoint lineage,
workspace-head verification, lost-state detection or recovery after real DO/runtime interruption.
No deployment or runtime isolation acceptance. Code `856fb145` is pushed to
`origin/Mcbt5s-Backup-2`; preserve `infra/scripts/__pycache__/`.

Exact next action at this historical checkpoint was TBR11; it has since been partially implemented
in `7af7ce5e` and retraced in the shared-compute ledger. The scheduled history is pruned, so it
cannot be reused as the reservation ledger; uncertain completion still requires new durable state.

## Cross-plan continuation correction — 2026-11-17 (`7af7ce5e` pushed)

The former TBR11 direct-script caller gap is now partially implemented: exact current grants feed
the session tally guard and settlement (`7af7ce5e`, evidence in the shared-compute ledger). The
missing atomic durable hold/uncertain-outcome receipt remains code work, not a provider blocker.
PW checkpoint timestamp and loss-boundary UI are pushed in `856fb145`; versioned lineage, exact
workspace-head proof, lost-state UI, runtime isolation and real interruption acceptance remain
partial. Do not return to the stale TBR05 action above without new source evidence. Exact next action:
proceed to SC03 durable compute admission/dispatch across ConcurrencyDO, ToolSandbox recovery and
owner queue callers; then return to TBR11 reservation design and all remaining active-plan gaps.
Keep the full mission active.

The prior action to trace WorkflowRunDO checkpoint/recovery was completed in `1dd54057`/`fc3318bb`; delegated branch runtime separation is completed locally in `21de8512`, and exact Coordinator head binding is completed locally in `c17b6e01`. Continue from the top checkpoint: TBR05 invitation and identity boundaries, then remaining independent PW and cross-plan code gaps. Keep rollout disabled.
## Cross-plan update — 2026-11-17 (scheduled HITL resume authorization recovery; `688f69e4` pushed)

Code `688f69e4c9cae6c29986efb17d65a507779134e9` is remote-verified. Durable suspended-run rows now preserve the scheduled job service context; resume rechecks the signed internal heartbeat session and exact current enabled job revision, and a missing/stale identity cannot be resumed as an ordinary user run. Older rows may recover only from the authenticated session; transient session lookup failure remains retryable. Focused tests **28/28**, Agents typecheck and diff hygiene pass. This is not unsaved process-memory recovery, in-flight provider cancellation, runtime isolation acceptance or a per-job compute-cost reservation. Continue PW cost/cancellation requirements alongside other plans.
## Current PW05 checkpoint — 2026-11-17 (owner-scoped worker usage receipts; `c1372b54` pushed)

Owner/admin-only Space and Project routes now forward bounded worker IDs to a HMAC-protected Billing
aggregate. Billing matches only `<worker-id>` and `<worker-id>:attempt:n` run IDs within the exact
tenant/Space and either the exact Project or Space-level (`project_id IS NULL`) scope, returning
internal credits, event count and unpriced-event count. The Shell owner view labels missing receipts as
pending/unavailable and explicitly says provider invoices may differ. It does not expose receipt detail
through the ordinary Space conversation list endpoint.

Code `c1372b54421b1a958c44bfa7c77ff67933ef1ab6` is pushed to `origin/Mcbt5s-Backup-2`. Local evidence:
Billing route suite **24/24**, Billing/Agents/Shell typechecks and `git diff --check`.
No browser, deployed worker, provider invoice or live acceptance. Run-level reservation/settlement was
already present and is now accurately recorded. SC03 comparison confirms `d3a0f194` persists and expires
encrypted intent but supplies neither alarm-safe authority revalidation nor durable Billing linkage;
keep disconnected replay disabled. Exact next action: continue the next uncoded Knowledge/platform
requirement without repeating TBR07.

## Cross-plan update — 2026-11-17 (PW05 per-attempt accounting trace)

The PW05 matrix claim that no per-run reservation/settlement exists was stale. A delegated worker
executes with run ID `<worker-id>` on attempt 1 and `<worker-id>:attempt:<n>` on later attempts.
Its normal `handleScriptRun` path performs model admission through the existing Project/Billing
reservation callbacks and calls `settleRunBilling` with that same run ID, actual token counts,
runtime tier and duration; canonical usage events are idempotently keyed to the run. Parent worker
rows retain aggregate token use and the monotonic attempt number, so each attempt ID is derivable.
This does not prove external invoice reconciliation or runtime isolation.

PW05 remains PARTIAL for owner-visible per-worker internal-credit/compute receipts: the Shell shows
model tokens and allocated token budget but does not query/render cost by worker attempt. Existing
Project usage is an aggregate and must not be presented as an exact worker receipt. Next code action:
add an owner/admin-authorized, exact Project-scoped read of worker-attempt usage events and show
internal credits with pending/unpriced states; keep provider invoice/USD claims out. Also continue
other independent plan gaps after this slice.

## Previous cross-plan update — 2026-11-17 (K03 page-marker preservation; pushed `acc85dd8`)

The Knowledge PDF adapter now preserves only explicit increasing page numbers from optional parser
response metadata and binds the behavior to a new parser version. Missing/malformed metadata falls back
to the previous flat text path; no current Cohere response contract or live page output was verified.
Local Knowledge parser/ingestion/archive/workflow checks **26/26** and typecheck pass. K03 remains partial.

Exact next action: implement the owner/admin worker-attempt usage read described above, with tests for
project scope, missing/unpriced receipts and multiple attempts. Then continue all remaining active-plan
requirements. Do not equate token allocation with actual currency/compute or claim runtime isolation.

## PW03 checkpoint lineage — 2026-11-17 (`b7b2d163` pushed)

Sub-agent checkpoint JSON now uses a bounded v1 envelope carrying save time and attempt metadata;
oversized payloads become an explicit truncated receipt. Readers continue to accept legacy raw JSON,
and malformed v1 envelopes fail explicitly instead of appearing as absent progress. Focused
checkpoint/delegation tests **14/14**, Agents typecheck and `git diff --check` pass. Code `b7b2d163`
is pushed to `origin/Mcbt5s-Backup-2`.

PW03 remains partial: the envelope does not pin a verified workspace head, persist a checkpoint
history/lineage chain, or prove restored state after process/DO/runtime interruption. The Shell
timestamp/loss disclaimer is in `856fb145`; owner attempt usage receipts are in `c1372b54`. Exact next
action: continue SC03 durable compute admission/dispatch, then return to PW exact workspace revision,
missing/corrupt checkpoint status and runtime interruption evidence. Do not claim unsaved process
memory recovery.

## PW03 malformed checkpoint regression — 2026-11-17 (`53d53ee1` pushed)

The receive path now has a regression test showing malformed persisted checkpoint data yields
`worker_session_checkpoint_invalid` rather than a successful response with no checkpoint. Focused
checkpoint/delegation tests **15/15**, Agents typecheck and diff check pass. Test checkpoint
`53d53ee1` is pushed. Exact next action remains SC03 durable admission/dispatch; continue this PW03
recovery-state work afterward. Runtime interruption and workspace-head recovery remain unaccepted.
