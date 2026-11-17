# Shared compute scheduling and budget progress

## SC03 dispatch trace — 2026-11-17 (TBR07 complete; no safe disconnected dispatcher found)

The current DynamicSandbox → ToolSandbox path is still synchronous. Capacity retry carries the
original request and reruns `authorizeContainer`, which depends on the live Bash tool surface and
caller role clamp; ToolSandbox makes Billing admission only after capacity is acquired. The encrypted
R2 envelope is not reachable by an alarm-safe host caller and is not bound to a durable Billing hold.
No current installation-grant revision or consented async job receipt can be revalidated at dispatch.
Therefore disconnected replay remains disabled. This is an ordinary design/code gap, not a credential
gate, and the TBR07 SpaceDO/Knowledge/extension authority comparison must not be repeated.

**Reminder to myself:** Continue the complete mission after recording this trace; do not stop at an audit, test, progress update, commit or push.

Exact next action: keep SC03 on the active backlog for a host-owned durable job contract that stores a
bounded encrypted request reference, explicit invocation consent, exact revocable authority revision,
fenced dispatch lease and fresh Billing reservation before launch. The current code has no compatible
caller/authority API, so proceed with independent uncoded plan requirements in dependency order and
return to SC03 when that boundary can be implemented without widening grants or replaying stale work.
Keep rollout disabled.

## Resume pointer — 2026-11-17 (SC03 abandoned waiter cleanup; pushed as `d99720f0`)

When a synchronous caller exhausts six bounded retries against the exact persisted `waiting_for_capacity`
execution, CodeRunner now calls the signed `/cancel` route for that same scope/execution ID. The
cancellation helper is idempotent across caller abort, deadline and exhaustion. Existing retry logic
rechecks the live container grant and monotonic membership revision before each retry, and ToolSandbox
reserves current Billing only after capacity. Capacity test suite **4/4**, Agents typecheck and diff
check pass. This prevents an abandoned live request from retaining capacity until TTL.

This is not disconnected replay. The encrypted envelope is bounded storage only; there is no host caller
that can reconstruct `authorizeContainer`'s live `Bash` surface/role clamp after disconnect, no explicit
durable job-consent contract and no current Billing reservation tied to an admission receipt. Keep
automatic replay disabled. TBR07's authority comparison is complete and must not be repeated. Rollout
remains disabled.

**Reminder to myself:** Continue the whole mission after this checkpoint; never stop at tests, docs,
commit or push.

Exact next action after push: continue SC03's host-owned durable job contract only if exact current
authority, explicit invocation consent and fresh Billing can all be rechecked before dispatch. If the
live closure cannot be reconstructed from an existing authority, record that contract limitation and
move to another independent S2–S9/U01–U12/EP/K/P/PW/AP/TBR requirement. Keep replay fail-closed.

## Current checkpoint — 2026-11-17 (SC03 encrypted invocation receipt; `d3a0f194` pushed)

Commit `d3a0f1944fb279a24d8f9d10ca8ea870a9cfd252` is pushed to `origin/Mcbt5s-Backup-2`. ToolSandbox now stores a short-lived, size-bounded AES-GCM envelope in R2 when a native capacity waiter has a monotonic membership revision and the configured R2/key bindings exist. Authenticated data binds request path/hash, tenant, Space/Project, actor, agent, run, execution ID, revision and expiry. Sidecars and revision-less scopes do not persist a replay payload. Exact cancellation deletes the envelope; alarms erase expired payloads, mark waiting receipts expired, and retry cleanup after deletion failure. The execution record and ConcurrencyDO still hold metadata only. Focused DynamicSandboxDO tests **40/40**, Agents typecheck and `git diff --check` pass. The pnpm preflight stopped before package scripts because its no-TTY dependency reconciliation guard refused module removal; installed local binaries performed verification. No deployed, live or provider acceptance.

This is bounded encrypted persistence and cleanup only. There is no disconnected dispatcher, current installation-grant revision, durable Billing reservation link, process-memory restoration, or owner-visible recovery lifecycle. The 10-minute retention is an implementation bound matching the current maximum admission waiter TTL; it is not a general data-retention policy. Rollout remains disabled.

**Reminder to myself:** Keep implementing the full mission after this checkpoint. Do not stop at tests, a ledger update, commit or push; immediately continue with the next independent authorized requirement.

Exact next action: inspect and map the existing authority readers, durable scheduler receipt and Billing admission entry points into a host-owned dispatcher/job receipt. Then implement dispatch and owner status/cancel/retry only where current authority and budget can be rechecked; keep replay disabled if either check is unavailable, and continue the next independent active-plan code gap. TBR07 is already recorded; do not repeat it.

## Previous checkpoint — 2026-11-17 (SC03 monotonic authorization revision; `070e0326` pushed)

`070e0326` is pushed to `origin/Mcbt5s-Backup-2`. SpaceDO migration 158 maintains monotonic Space/Project membership revisions (including assistant clamp), with member readers exposing the version. Native container authorization binds its current revision into the signed runtime scope; code-runner cancels an exact capacity waiter if membership authority changes before retry. Local evidence: Agents code-runner/capacity and container-policy tests **13/13**, SpaceDO migration suite **10/10**, Agents/Spaces typechecks and diff check. Migration remains unapplied and there is no deployed acceptance.

This closes membership revision and caller-live retry binding only. SC03 still has no encrypted bounded request receipt, durable alarm/promotion dispatcher, current installation grant revision, owner-visible job lifecycle, or durable Billing-reservation link. ConcurrencyDO continues to store only scoped metadata and fencing state. Exact next action: add encrypted request persistence to ToolSandbox's waiting execution receipt with immutable hash/scope/revision AAD and bounded expiry, then build a durable reauthorizing dispatcher and authenticated owner status/cancel/retry path. Reuse current billing admission at dispatch and never store commands or secrets in ConcurrencyDO. If retention/human confirmation requires a product choice, record it exactly and continue other independent plan gaps. TBR07 remains recorded; do not repeat it. Rollout disabled.

## Active SC03 next action — 2026-11-17

TBR07's SpaceDO/Knowledge/extension authority comparison is already recorded below and in the TBR progress record; it found no shared ACL writer and leaves the owner/admin private-Project policy unresolved. Do not repeat the audit or widen access. The encrypted-store inspection found only purpose-specific backup/artifact paths; there is no reusable encrypted invocation store or disconnected host dispatcher. A safe SC03 lifecycle improvement is now pushed below: bounded owner-visible expiry receipts. Continue the missing dispatcher contract only with a separately persisted host authorization revision and current billing revalidation. Do not persist arbitrary code or secrets in ConcurrencyDO queue state, claim process-memory restoration, or turn a synchronous invocation into a blocking wait. If the host contract cannot be expressed from current authorities, record that narrow dependency and immediately continue other active code gaps. Rollout remains disabled.

Source: `docs/research/shared-compute-scheduling-and-budget-plan.md`, fetched from `origin/plan/microapps-ui-sdk-voice` commit `3770193d`; copied SHA-256 `7a03471b4396e5f2e5a35820659957dfb21ba3b756507292c9c7fb8bbe637145`. No planning branch checkout or merge.

## Current reconciliation — 2026-11-17

| ID | Status | Current evidence and remaining gap |
| --- | --- | --- |
| SC01 project, goal and computer lifecycle | PARTIAL | Checked WorkspaceCoordinator revisions, durable workflow/task state and on-demand runtime DOs are separate. Project files and goals persist while runtime may stop. Safe publication/checkpoint paths exist, but there is no general sleep/drain/flush bridge for arbitrary processes. Never claim process-memory, socket or credential restoration. |
| SC02 runtime routing and capability truth | PARTIAL | Existing classifier routes supported VFS/JS paths separately; Python/Wasm is bounded/feature-gated and `python`/`npm` shell requests require Linux/container capability. Some runtime capability gates and provider isolation still need complete caller and live acceptance coverage. |
| SC03 durable fair capacity scheduler | PARTIAL_LOCAL / CODE_GAP | DynamicSandbox uses one authenticated ConcurrencyDO ledger for global+tenant capacity. It stores scoped IDs, limits, state, expiry and fencing token; release/expiry promotes eligible waiters round-robin by tenant→Space→Project→actor and FIFO within each leaf. Owner/admin Project status/cancellation use scoped metadata and a 24-hour tombstone. Queue saturation returns a same-ID retryable `capacity_queue_full` outcome, not a false waiting receipt. Safe automatic wake/replay remains blocked on a durable host-owned invocation/job contract: current queue intentionally has no executable payload or secrets, and there is no durable caller that can revalidate/reconstruct after disconnect. Priority aging/heterogeneous scheduling, configurable hierarchical quota policy (none exists today), and deployed acceptance also remain. |
| SC04 layered quotas, reservations and settlement | PARTIAL | Selected LLM, Project, extension and managed-provider paths reserve and settle idempotently; schedule grants add an exact job ceiling. Billing atomically admits against the configured monthly tenant infra-credit limit and the exact current extension-install monthly cap. There is no configured authoritative Space/Project infra-credit cap to intersect, no uniform platform→provider→tenant→Space→Project→user/service→agent/job window intersection, nor authoritative provider invoice reconciliation across runtime types. |
| SC05 owner queue and budget controls | PARTIAL_LOCAL / CODE_GAP | Owner/admins can see scoped active/waiting Project compute admissions, cancel waiting executions, and view up to 50 exact main-runtime plus active PROJECT_BOUND/PROJECT_SHARED sidecar Tier 5 receipts from Shell. Sidecars are filtered through the current SpaceDO installation scope; PROJECT_USER receipts are excluded. The view joins exact settled internal-credit usage and explicitly makes no USD/provider-invoice claim. Queue-hard-cap requests are not waiting entries. No reliable ETA, quota-window resets, non-Project reservation view, or provider invoice view exists. |
| SC06 verified commercial and provider acceptance | EXTERNAL/LIVE GATE | Cloudflare runtime/Queue prices, included allowances, current account availability, snapshot behavior and actual invoices have not been verified in this checkout. Source-plan examples remain illustrations, not quotes or customer prices. Real Container/FUSE, deployed billing and invoice acceptance remain separate gates. |

## SC03 lifecycle checkpoint — 2026-11-17 (local verification)

ConcurrencyDO now retains owner-scoped, content-free receipts for expired queued admissions for at most 24 hours, with a 2,000-row global cap. The Project Shell status API returns expired records separately and labels them as expired; it does not offer a retry button or dispatch them. Re-entering work still requires a current same-request caller and fresh authorization/budget checks. Cancellation tombstones remain distinct. This closes expiry observability only, not automatic wake, disconnected replay, or durable job authorization.

Local evidence: ConcurrencyDO **27/27**, Shell compute admission API **2/2**, Spaces admission route **4/4**, Agents/Shell typechecks and `git diff --check`. Tests use local DO/D1 fakes; no deployed Worker, browser, Container, provider or live acceptance. Exact next action: design a host-owned job receipt with an explicit current authority revision and billing-reservation link; do not infer either from actor IDs or internal tokens. If no existing AgentDO grant revision can be recorded and rechecked by an alarm-safe caller, keep dispatch disabled and proceed to the next independent active-plan code gap. Fetch before each push; preserve the untracked pycache and keep rollout disabled.

Reconciled code locations: `workers/agents/src/do/ConcurrencyDO.ts` implements durable resource waiters and lease fencing, and now the scoped compute-admission ledger; `DynamicSandboxDO.ts` routes capacity through the single ledger; `ToolSandboxDO.ts` persists the waiting execution receipt; and `script-engine/code-runner.ts` retries the same authorized invocation. Durable workflows and workspace checkpoints persist logical task/project state but do not restore arbitrary process memory. Billing holds exist in selected paths only. Do not add a competing authority.

## Checkpoint — 2026-11-17 (scheduled job approval slice; `15b48e03` pushed)

Code and plan incorporation `15b48e039716b96d82dc86dab13ef2cb066810bb` are pushed to `origin/Mcbt5s-Backup-2`. Migration 0282 adds normalized per-job approved action names and a bounded per-run credit ceiling. Owner/admin configuration is reachable through Spaces API and Shell; AgentDO reloads grants from D1 against the exact enabled goal/job revision, intersects them with currently enabled operations, and clamps the run ceiling against the existing session ceiling. Legacy jobs remain read-safe; direct-script jobs receive no added effects. Local evidence: security tests **2/2**, scheduled identity/approval tests **13/13**, migration tests **3/3**, Agents/Spaces/Shell typechecks, `git diff --check`. Migration remains unapplied; no deployed or live acceptance.

This closes only part of TBR11 and the per-job slice of SC04. Generic connector/provider event principals, all effect-boundary revocation/cancellation races, direct-script budgets, shared capacity fairness, quota windows and broad queue UX remain code gaps. Provider prices/invoices and deployed runtime behavior remain separate gates. Rollout stays disabled.

A direct synchronous conversion of DynamicSandbox admission into polling on the ConcurrencyDO waiter queue was inspected and not retained: `ToolSandboxDO.ensureMeter` runs inline with an invocation and has no durable owner-visible job row, asynchronous completion, queue cancellation or resume contract. Blocking that path would strand whole requests; therefore SC03 is still an ordinary code gap, not a provider blocker. Reuse the existing fenced planner queue only behind a durable admission record/dispatcher with cancel/retry/recovery semantics.

## TBR07 reconciliation — 2026-11-17

The requested authority comparison is recorded in the TBR progress ledger. SpaceDO's scoped Project membership/assistant clamp, Knowledge's fail-closed D1 `project_access` reader and per-installation extension grants have no shared resolver or visible ACL synchronization writer. Same-Space SpaceDO owner/admin access versus Knowledge explicit membership is still a product/security decision; no access is widened. See the TBR07 comparison above.

## SC03 dispatch reauthorization checkpoint — 2026-11-17 (`c405921f` pushed)

`c405921fcc829f4d1fad5bac3cff7f2319ae7149` rechecks `authorizeContainer` after a durable capacity-wait receipt and before every exact same-ID retry. If the current host grant was revoked while waiting, the caller cancels that exact waiter and does not retry `/exec`. Existing ToolSandbox `ensureMeter` still makes the current Billing reservation before guest execution. Focused code-runner, ConcurrencyDO, DynamicSandbox and ToolSandbox suites **103/103**, Agents typecheck and diff hygiene pass; all are local mocks. No live/deployed acceptance.

This closes the caller-live revocation race only. It is not durable dispatch after disconnect: the retry body remains in caller memory, no encrypted reusable invocation artifact or host dispatcher was found in the current paths, and queue state intentionally stores no command or secret. Exact next action: design and implement an explicit durable job contract with bounded encrypted request reference and retention, current actor/service authorization revision, current budget reservation, job lifecycle and fenced lease; add owner status/cancel/retry/recovery plus an authenticated dispatcher that can reconstruct only the same request. If this needs a policy decision on persistence/retention of executable code, record that narrowly and continue independent requirements. Keep rollout disabled.

## SC04/SC05 checkpoint — 2026-11-17 (`0c1278ff` local; ledger/push pending)

Owner/admin Project Shell now reads up to 50 existing main-runtime reservation rows through a scoped Product API. The query requires exact tenant, Space, Project, main-container budget key and Tier-5 runtime; it excludes extension installations and sidecar/provider reservations. Matching settled usage is joined by exact workflow/run receipt. The UI reports internal credits only and states it is not an invoice or USD cost. This makes the existing reservation state visible; it does not create a new budget authority or change admission.

The runtime's reservation identity is `container:<UUID>` from pending `ContainerMeter` through `reserveWorkflowBudget`; its workflow ID is retained for exact usage-event matching at settlement. Local verification: Agents reservation/status suites **4/4**, Router managed-runtime route test **1/1**, Shell admission API tests **2/2**, all three package typechecks and `git diff --check` passed. No deployed Worker/DO, migration, invoice, browser or live acceptance. Code commit `0c1278ffe8667787bbd8d99aea9e4a56d2668752` is local; update/push this ledger with it after fetching the recovery branch.

SC04 remains partial: no uniform platform/provider/tenant/Space/Project/user-or-service/agent/job quota-window intersection, configurable Project budget policy, sidecar invoice reconciliation, or authoritative provider invoice proof. SC05 remains partial: no reliable ETA, quota reset controls, non-Project caller controls or provider invoice view. Rollout remains disabled.

Exact next action: compare current billing window and runtime admission code paths for supported quota authorities; implement one concrete missing intersection only where an existing configured limit and owner are authoritative, with exact-reservation idempotency and current-revision checks. Record absent policy as a product/configuration gap, then proceed to other independent active-plan requirements.

### Contract comparison follow-up — 2026-11-17

Billing's workflow reserve transaction atomically counts current month tenant `infra_credits` plus unexpired workflow and managed-service holds against `PLAN_LIMITS.monthly_infra_credits`. Extension job reservations additionally count settled month usage and held credits against the exact caller-provided installation cap/revision; callers derive that tuple from the current signed installation grant, and retries conflict if the persisted tuple changes. No Space/Project infra-credit budget configuration or owner exists in the current source. The separate managed-service USD budget/alerts are not a runtime-infra cap and must not be substituted. Therefore the SC04 Space/Project window intersection is an uncoded policy/configuration gap; this comparison yielded no safe cap to implement without inventing product policy. Provider invoice reconciliation remains an external/live acceptance gate.

The queue review confirms `ConcurrencyDO` promotes a fenced lease, but a promoted runtime cannot be resumed by the DO after caller disconnect: durable state stores scope and payload hash only, and no durable host job caller can reconstruct/re-authorize the command. Persisting raw commands/secrets in the shared scheduler would violate its data-minimization boundary. This is a missing invocation contract, not a provider credential block. The owner queue still supports same-invocation caller retries and cancellation/status for registered waiters; no server-push wake is claimed.

SC03 remains **PARTIAL_LOCAL / CODE_GAP**. Existing `ConcurrencyDO` has two distinct primitives: immediate counter slots (currently used by DynamicSandboxDO) and a durable fenced resource waiter queue (used by planner paths). The latter has a bounded waiter list, expiry, promotion on reconciliation/release and position, but no compute job authority/deadline/budget record, authenticated owner status/cancel API, or async dynamic-container dispatcher. `ToolSandboxDO.ensureMeter` is synchronous and receives the original execution request; moving it to a durable wait without persisting/re-authorizing the execution intent would either strand an invocation or risk replaying stale authorization. This is ordinary missing implementation, not a provider gate.

The owner/admin Project queue surface, exact cancellation and fair promotion are implemented in the checkpoints below. No configured Space/Project/member concurrency thresholds or priority weights exist, so they have not been invented. Exact next action: trace SC04's existing plan/Project runtime budget holds into owner-visible reservation state and verify runtime admission and billing settlement use the same exact reservation identity. The TBR07 private-Project policy gap is separate and unresolved.

## SC03 code checkpoint — `fa17d910` pushed, 2026-11-17 (retryable capacity admission)

DynamicSandbox capacity refusal is now distinct from an indeterminate execution. ToolSandboxDO persists `waiting_capacity` only for the exact pre-execution `container_concurrency_limit` error; a matching execution ID, signed scope and payload can atomically claim that receipt once. The response is HTTP 429 with `waiting_for_capacity`, `admission_id`, `execution_started:false` and `Retry-After`; the code runner retries only this structured response, preserving the immutable scope and request body. Existing authorization and budget checks run again on every retry, and no guest command starts or billing hold is created until capacity is acquired.

Evidence: the next local uncommitted delta adds the integrated queue/lease path. See the checkpoint immediately below. The previous `fa17d910` retry-only version did not itself queue waiters.

## SC03 code checkpoint — `d314f4c16a377443a51c6715f3d82c897f36e97a` (2026-11-17; pushed via ledger commit `29f737b3`)

The shared ConcurrencyDO owns one authenticated atomic global+tenant admission ledger. Waiting rows hold scoped tenant/Space/Project/actor/execution IDs, limits, expiry and state. They promote on release/expiry in oldest eligible order while skipping tenants already at their cap; every active lease has a monotonic fence and release requires the exact tenant/holder/token. DynamicSandbox uses this composite admission rather than taking global then tenant slots independently. A full wait leaves the matching ToolSandbox execution in `waiting_capacity`; the code runner retries that same scope/request; caller cancellation removes the waiter; no code or credentials are persisted. Existing tenant and Project/erasure/billing checks run again before launch. Owner/admin status is routed through the authenticated Product Project API and Shell, and a 24-hour scoped tombstone keeps owner cancellation effective across late retries.

Evidence: Agents ConcurrencyDO/DynamicSandbox/code-runner suites **62/62** and typecheck; Spaces admission/extension suites **39/39** and typecheck; Shell admission API test **1/1** and typecheck. No deployment, browser, rollout or live DO/provider acceptance. This is retry-driven dispatch, not a server-pushed wake: a bounded caller can still return waiting after five retries. Owner-visible rows are scoped to stored admissions; hard-cap waiters do not have a ConcurrencyDO row. Fairness remains tenant-only rather than tenant→Space→Project/member, and priority aging/workload weighting remain open. Preserve untracked `infra/scripts/__pycache__/`.

Exact next action: investigate the durable receipt path for hard-cap waiters and add owner cancellation/status without exceeding the queue bound; then implement Space/Project/member fairness where current limit authorities support it, and continue SC04 quota intersection and remaining active-plan gaps. Keep rollout disabled.

## SC03 code checkpoint — `bed140342327950e794df9048b21d918616cb2c8` (2026-11-17; pushed via `dc6f5585`)

When the bounded ConcurrencyDO queue is full, DynamicSandbox now emits a distinct `container_admission_queue_full` failure. ToolSandbox persists the exact execution scope/payload as `capacity_rejected`; a later identical retry may re-attempt admission, while mismatched requests remain rejected and no guest/billing work starts. The code runner does not spin-retry an unqueued request. This prevents queue saturation from falsely claiming the caller is in an owner-visible waiting list. Evidence: Agents capacity suites **63/63**, Agents typecheck and `git diff --check`. No live/deployed acceptance.

Exact next action: continue SC04's runtime budget-reservation review, then other active-plan code gaps.

## SC03 code checkpoint — `24ddc2d41f9aafd8d283c92ccae3976072e088c3` (2026-11-17; local, pending ledger push)

The durable promotion algorithm uses a persisted hierarchical cursor and round-robins eligible tenants, then Spaces, Projects, and actors. Each partition is FIFO within its turn. Existing per-tenant and global caps remain the only configured concurrency limits; this change does not invent Space/Project/member quota values or priority weights. Agents ConcurrencyDO/DynamicSandbox/code-runner suites **65/65**, Agents typecheck and diff check pass. No live/deployed acceptance.

Exact next action: trace SC04's existing runtime plan/Project budget holds into owner-visible reservation state and verify runtime admission and billing settlement use the same exact reservation identity. Document any absent configurable windows/policy as a product/configuration gap and proceed to independent plan requirements.
