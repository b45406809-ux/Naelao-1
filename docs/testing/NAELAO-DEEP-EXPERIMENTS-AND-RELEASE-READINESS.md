# Naelao deep experiments and release-readiness plan

**Status:** execution plan, not a completion or production-readiness claim  
**Prepared:** 2026-11-01  
**Target:** establish the strongest defensible release candidate by 2026-11-02; live acceptance follows only after local gates pass.

## Decision in brief

The next step is a dependency-ordered evidence run, not another undifferentiated “full test” push. Start with the current commit and the exact CI inventory, close local correctness and security gaps in the assistant/worker path, then run bounded reliability, UI, resource, and cost experiments. Only after those pass should an isolated Cloudflare/provider canary run.

The stated goal that “only live tests remain by tomorrow” is **not supported by current evidence**. The repository already records local gaps: concurrent blackboard claim races; AgentDO goal-state recovery during dispatch; uncertain external side-effect reconciliation; a successful provider-free reasoning-adapter task; fully joined actor/task traces; authenticated UI-to-DO and member lifecycle journeys; sidecar/tunnel contention; and broader extension/template lifecycle acceptance. Some of these can and should be tested locally. Live tests cannot substitute for them. A release candidate may be achievable tomorrow if critical gates pass; production readiness cannot be promised in advance.

## How to decide which plan is current

`new plan/` is a historical implementation ledger and design archive, not one uniformly current specification. Resolve conflicts using this order:

1. Later explicit product/security decisions in conversation, reconciled in `new plan/TRANSCRIPT-CROSS-SOURCE-RECONCILIATION.md`.
2. Current code, migrations, runtime bindings, and tests at the tested commit.
3. Newer commit history and dated progress/evidence records.
4. The older plan text, only where it remains consistent with the above.

Do not infer that a plan paragraph is implemented because it is written in the past tense. Do not reopen superseded proposals merely because an old plan mentions them. In particular:

- Naelao is a general AI OS/kernel. Domain workflows, customer-facing bots, business behavior, and vertical products belong in FDE templates/extensions; they are not new hard-coded kernel agents.
- A Space Assistant and a Project Assistant/Bot are distinct identities and scopes using the same underlying planner/worker architecture. A Project Assistant is not a leaf task worker; thread/task workers are separate delegated actors.
- The intelligent Space/worker blackboard is coordination state and policy-driven routing, not a prompt that makes assistants poll every journal. The deterministic host owns grants, leases, state transitions, and action authorization; models can advise or classify only within those bounds.
- The CLI and execution ladder remain the agent-facing surface. Dynamic commands, scripts, workflows, workers, and MCP-backed capabilities compose that surface; Code Mode is a composition pattern, not a replacement architecture.
- Managed sidecars and user-connected tunnels are different environment classes. A tunnel is an external execution target/last-resort eligible resource, not silently promoted to a managed sidecar. Workspace, credential/profile, file ownership, locking, plan quotas, and reconnect semantics must remain explicit.
- “Space types,” business wallets/accounting, and hard-coded business/customer-agent product framing were superseded. Test generic Space/template/extension flows and verify retired routes do not remain reachable.
- Live phone, WhatsApp, Cloudflare, email, OAuth, and model-provider behavior is not established by mocks or local Wrangler.

The source documents most relevant to this run are `new plan/NAELAO-AGENT-OS-EMPIRICAL-VALIDATION-PLAN.md`, `new plan/PROJECT-BOTS-UNIVERSAL-AGENT-OS-ROADMAP.md`, `new plan/OPEN-GAPS-IMPLEMENTATION-PLAN.md`, `new plan/TRANSCRIPT-CROSS-SOURCE-RECONCILIATION.md`, `new plan/DEPLOYMENT-ACCEPTANCE-LOG.md`, `new plan/FDE-EXTENSIONS-AND-MICROAPPS-ARCHITECTURE.md`, and `docs/ai-os-competitive-platform-progress.md`. The empirical and Project Bots plans already contain some newer local evidence; preserve their narrower status labels and update them after each gate rather than copying old checklists wholesale.

## Current evidence baseline

Reference checkout at planning time: `Mcbt5s-Backup-2`, commit `42cfbabab89e95b498531532debd29fc9ce9563f`; `origin/Mcbt5s-Backup-2` matches. `origin/work` is at `68922e7e` and is three commits behind this reference. Recheck remotes before running or publishing results.

Evidence recorded in the current repository includes:

- Focused competitive-platform checks: 86 tests / 14 files, one recorded local run.
- Local Wrangler runtime acceptance: 5/5 tests using separate Spaces and Agents Worker processes, repository D1 migrations, local service binding, SpaceDO/AgentDO, and process restart. It verifies duplicate/conflicting blackboard requests, repeat-sweep deduplication, revoked authority, viewer denial, busy retry, expired-lease hold, and persisted SpaceDO session/thread state.
- That runtime fixture is air-gapped: AgentDO rejects model execution with `compliance_violation`. It does **not** prove a successful planner/worker completion.
- Prior synthetic browser journeys: 6/6 across desktop, 338px, and 740px, using a fake API/seeded session. These are not authenticated backend-to-browser tests and must be rerun against current code before relying on them.
- Recorded one-run local runtime timings (migration 45.311s, harness 58.478s, initial wake 134ms, viewer denial 7ms, restart 6.266s) are point observations, not p50/p95 or capacity claims.
- `.github/workflows/naelao-full-test.yml` has repository, workspace, node, conformance, typecheck, security-lint, browser-journey, and runtime-acceptance suites, plus a connected-worker check and result summary. The workflow itself correctly warns that its current browser fixture is synthetic and its runtime fixture is air-gapped.
- `docs/ai-os-competitive-platform-progress.md` still lists unfinished extension discovery/dependency installs, assistant/blackboard execution, Foundry lifecycle, team benchmarking, and reference-template end-to-end work.

### Execution log — 2026-11-01

Candidate SHA `8590bfe323600d302a83cd28daed881e14d8a673` full inventory Actions run [41258926581](https://github.com/b45406809-ux/Naelao-1/actions/runs/41258926581) succeeded on attempt 2. Attempt 1 was cancelled while the browser-journey job was running; attempt 2 reran the matrix, and the overall summary concluded success. Repository, workspace, Node, conformance, typecheck, security-lint, browser-journey, runtime-acceptance, and all three connected checks passed. This is the documentation-plan SHA; subsequent test additions require their own run before they count as CI evidence.

Additional local evidence on the current working tree:

- Batch 1 scope/assistant/blackboard focused suites: **24/24** across 6 files.
- Batch 2–4 goal DAG, evidence, architecture benchmark, Decisions client, usage reconciliation, and billing reservations: **86 passed, 1 skipped** across 7 files. The skipped case remains skipped; no live provider result is implied.
- Batch 3 two-Worker local runtime suite after adding a 16-way sweep race: **6/6**. Sixteen simultaneous D1-backed sweepers yielded exactly one dispatch and one attempt; the wake then remained held because this fixture deliberately prohibits cloud-model execution. The other cases still covered restart of both Worker processes and Project Bot session persistence.
- Follow-up local runtime run after adding a 30-sample measurement: **7/7**. The blackboard-to-Project-Bot wake/admission route measured p50 **94 ms** and p95 **114 ms** in this local Wrangler run. These times end at the air-gap `compliance_violation` before model/provider execution and do not measure a successful planner/worker task. The 16-way concurrent claim still dispatched exactly once.
- Batch 6 Worker-side runtime/tunnel/container admission suites: **42/42** across 7 files; repository tunnel/container policy suites: **38/38** across 6 files. These are deterministic/local tests, not tests against a user's connected machine or a live container fleet.
- CLI/MCP and extension boundary follow-up: **52/52** across 6 files for dynamic-code, Code Mode, worker capabilities, virtual CLI, daemon MCP, and SDK artifact-client tests; **21/21** across 5 MCP Hub files for tenant/Space isolation, connector policy, upstream response bounds, Composio handling, and air-gap rejection.
- The latest local runtime run applied 154 migrations in **44.368 s**, started both Workers in **6.544 s**, restarted both in **6.536 s**, and completed in **58.752 s**. The concurrent-wake route took **225 ms**. These are single-run local timings, not percentile or capacity results.
- The CI runtime acceptance on commit `f7b152eb5ddd3010c55222b6fd56220edcbf3d4f` passed **7/7** in Actions run [41267466326](https://github.com/b45406809-ux/Naelao-1/actions/runs/41267466326). Its 30 local-Wrangler wake/admission samples measured p50 **126 ms** / p95 **133 ms**; this ended at the air-gap denial before model execution. CI applied 154 migrations in **50.694 s**, started both Workers in **6.540 s**, restarted them in **6.619 s**, and finished the runtime harness in **69.188 s**. All eight full-test matrix suites, all connected checks, and the overall workflow summary succeeded on attempt 1. This remains local Cloudflare emulation, not a deployed Cloudflare test.
- Documentation commit `b96f82a573be2c7f697fb0fb9b94459c5d795417` triggered full inventory run [41267865577](https://github.com/b45406809-ux/Naelao-1/actions/runs/41267865577), which completed **success** (attempt 1). The eight recorded suite artifacts (`repository`, `workspace`, `node`, `conformance`, `typecheck`, `security-lint`, `browser-journey`, `runtime-acceptance`), three connected checks (`binding-probe`, `agent-authorization`, `router-dependencies`), and final summary all reported success. This run verifies the same code SHA as `f7b152eb`; it contains documentation-only changes. A local direct Vitest rerun of goal DAG, evidence, synthetic architecture benchmark, Project Bot/blackboard integration and delivery/wake, and usage reconciliation passed **50 tests**, with **1 skipped**. Running through the environment's pnpm 11 wrapper was blocked by its ignored-build-script policy; invoking the checked-in Vitest binary directly succeeded.
- A local package build attempt could not serve as clean-install evidence: the environment has pnpm 11 despite `packageManager` pinning pnpm 9.12.0, pnpm 11 refused ignored dependency install scripts, and the overlay had under 300 MB free. The GitHub runner's install and prerequisite build passed; do not treat the local attempt as a source failure or as a pass.

The test-only concurrent wake option is bounded to 32 sweeps and only exists in the isolated `tests/plan/runtime` wrapper. It does not change production wake behavior.

### Follow-up: deterministic Project Bot run and wake-result correction (2026-11-01)

- Added a host-injected model transport usable only when `ENVIRONMENT === "test"`, plus an isolated local OpenAI-compatible stub Worker. The stub keeps request counts and model IDs only, never prompts. Ordinary runtime cases remain air-gapped; only the explicit test case temporarily relaxes its synthetic Space policy and restores it afterward.
- A three-Worker Wrangler run (Spaces, Agents/AgentDO, and the test model endpoint) exercises a Project Bot blackboard wake through `wakeAgentGoal`, real `SpaceDO`/`NaelaoAgentDO`, the actual Reasoner request parser, and a completed script run. It made **1** local mock inference request for `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, completed in **213 ms**, and made **0 external-provider requests**. This proves a successful Project Assistant wake/run using a deterministic mock response; it does not prove a delegated leaf worker or production model quality.
- The experiment caught a status bug: `NaelaoAgentDO` can return HTTP 200 while the script result contains `ok:false`. The blackboard coordinator previously marked any HTTP 200 wake `completed`, hiding model/tool failure. It now requires `result.ok === true`; explicit failure, missing result, and deferred approvals remain `held`. Focused regression suites passed **20/20** and Agents typecheck passed.
- Full local Wrangler acceptance passed **8/8** on the updated source. It applied 154 migrations in **43.891 s**, started Spaces in **2.516 s**, Agents in **3.883 s**, and measured the 30-sample air-gap admission boundary at p50 **88 ms** / p95 **104 ms**. These are local emulation timings, not an SLO or production latency claim.

### Follow-up: planner DAG command was unreachable through the documented CLI (2026-11-01)

- Review of `PLANNER_FIRST_PROTOCOL`, `ScriptToolSurface`, and `virtual-cli.ts` found that planner instructions named `engine.plan_and_delegate_goal`, while the model-facing surface intentionally hides that operation and no `naelao` CLI command dispatched to it. The operation was allowed by the host planner policy but unreachable using the documented Bash route. This made the planner-to-DAG contract inconsistent at its public interface.
- Added `naelao goal plan --json '<JSON object with objective and tasks>'` as a typed virtual-CLI route to the existing host operation. It requires an object with a non-empty objective and task array; DAG schema, permissions, budgets, runtime choice, persistence, and execution remain in their existing host-controlled code paths. Updated planner instructions and command help to use the CLI form.
- Added a parser test plus an execution-surface test that invokes the command through `ScriptToolSurface.run("Bash", ...)`, reaches `engine.plan_and_delegate_goal`, and confirms that the internal operation remains hidden from the model-facing operation list. Focused CLI/kernel/assistant architecture suites passed **37/37**; Agents TypeScript check passed. This closes the planner command reachability gap but is not a real DO leaf-worker/evidence journey.
- The source commit and new Actions inventory are recorded below after the push completes. The previous full Actions inventory on `7a843dbe9dde5dc048104872ef0e70120b0c6249` was still in progress at the time of this entry; do not count that run as a pass until its final suite artifacts and summary are inspected.

### Batch state after the first pass

| Batch | State | Evidence and remaining gap |
|---|---|---|
| 0 — Freeze/baseline | **PASS** | Full Actions inventory and connected checks passed on `f7b152eb`; clean checkout and synced branches. Local clean install is blocked by this session's pnpm 11/script policy/disk, while the clean runner install/build passed. |
| 1 — Actor/scope boundary | **PARTIAL PASS** | Focused scope/assistant/blackboard tests passed; full CI passed. Needs a larger generated matrix covering extension principals, archive/delete, tunnels, and all tool surfaces in joined traces. |
| 2 — Joined task/evidence | **PARTIAL PASS** | The local four-Worker Wrangler suite now exercises both Space Assistant and Project Bot planner → child AgentDO → correctly scoped workspace artifact → host evidence → Decisions verification → usage reservation/settlement. Verified/uncertain outcomes and dependent-task gating pass. UI trace continuity, live-provider execution, and a broad independent benchmark remain open. |
| 3 — Blackboard coordination | **PARTIAL PASS** | 16 simultaneous D1 sweepers produce exactly one claim/dispatch; authorization revocation, busy retry, lease expiry and dedupe pass. The HTTP-200/script-failure false completion is fixed and tested. Worker-message recovery, AgentDO restart during dispatch and fixer escalation remain open. |
| 4 — Durable dispatch/side effects | **PARTIAL** | Goal DAG, outbox, usage reconciliation, tunnel idempotency/restart and billing reservation tests pass. AgentDO outbox recovery plus real external side-effect uncertainty/reconciliation is not yet exercised across a running DO restart. |
| 5 — Decision/evaluation quality | **SYNTHETIC ONLY** | 9 repository-authored graph scenarios repeated 3 times plus generated DAG stress run in tests; one test is skipped. No external held-out dataset or current live model quality evaluation was part of this full-test run. |
| 6 — CLI/MCP/runtime environments | **PARTIAL PASS** | Selected command/MCP (52), MCP Hub (21), tunnel/container (42 + 38) tests pass; distinct container affinity and shared-resource queuing are covered in goal DAG tests. No live tunnel machine, managed container provider, browser profile or production snapshot acceptance. |
| 7 — UI/template journeys | **PARTIAL** | Browser CI passes its seeded fake-API Project Bot journey. Authenticated UI-to-DO task/evidence/approval and member/editor/viewer/archive lifecycle journeys remain open. |
| 8 — Migration/recovery | **PARTIAL PASS** | All 154 D1 migrations apply in local Wrangler acceptance. Restore from backup, deletion/retention cleanup and deployed rollback have not been proven. |
| 9 — Cost/latency/load | **PARTIAL** | 30-sample local admission latency is recorded (94/114 ms local, 126/133 ms on CI runner). These are pre-model timings; no end-to-end verified-task cost, production p95, or saturation curve is measured. |
| 10 — Live acceptance | **NOT RUN** | No deployed Cloudflare test Space, real model call, telephone/SMS, WhatsApp, email, billing-provider, or external runtime acceptance in these runs. |

These are the baseline, not a claim that all tests passed on the planning commit. For every new result record exact SHA, workflow/run URL, each suite's *recorded suite result*, overall workflow conclusion, counts, skips, artifacts, and whether the test used mocks, local Cloudflare emulation, or live services. A green wrapper job alone is not evidence that a provider test passed.

## Release claim taxonomy

Use these labels in the dashboard, logs, docs, and final report:

| Label | Meaning |
|---|---|
| `unit` | Component logic with mocks/fakes. |
| `integrated-local` | Real local Worker/DO/D1/runtime path; external services emulated or denied. |
| `synthetic-model` | Deterministic fixture adapter; proves orchestration contracts, not model quality. |
| `provider-live` | Actual provider account/API operation with bounded synthetic data and recorded provider response/usage. |
| `cloudflare-live` | Deployed isolated Cloudflare environment with actual bindings, queues, DOs, and logs. |
| `production-observed` | Monitored real production usage; never infer from a staging run. |

Never label the product “production-ready” solely because unit/workspace CI passes. The meaningful interim label is “release candidate: local gates passed, live acceptance pending.”

## Execution order and experiment batches

Run batches in order. Independent static/type/security and package suites can run concurrently in CI; tests that depend on migrations, local Workers, tenant state, or previous failures must remain sequential. If a batch fails, save its evidence, fix the root cause, rerun that batch and its dependents, then continue with unrelated batches. Do not mark dependent batches as passed after prerequisite failures.

### Batch 0 — Freeze the subject and reproduce the baseline

**Purpose:** make every measurement attributable to one exact tree.

1. Fetch both remotes; check for remote advances, dirty files, and branch divergence. Preserve the current work rather than resetting it.
2. Record `git rev-parse HEAD`, branch refs, Node/pnpm versions, lockfile state, platform, CPU/memory, and CI event/run identifiers.
3. Install from the lockfile with the repository's frozen install mode. If that fails, diagnose lockfile/dependency drift; do not silently regenerate the lockfile.
4. Run the full workflow suite matrix as defined by the workflow. Inspect downloaded per-suite JSON/artifacts and the final summary, not just the workflow badge.
5. Verify all Worker configs/builds and required migrations are represented in current CI. Record any Worker or config omitted from the matrix.

**Pass:** clean, reproducible source SHA; all required local suites passed; no missing or blocked suite misreported as pass.  
**Fail action:** repair environment/build/test failures before architecture experiments. Do not use a green subset as a full baseline.

### Batch 1 — Product boundary, identity, and authority matrix

**Actors:** Space Assistant, Project Assistant/Bot, task/thread worker, ordinary member, owner/admin, viewer, extension/channel principal, disconnected/revoked principal.

**Dimensions:** at least two Spaces, three Projects per Space, same-named IDs across tenants, project archive/delete, role changes, stale tokens, explicit capability grants, Space-wide and project-scoped workspace, tunnel/sidecar profile, and connector scope.

Exercise reads/writes, task creation, blackboard publish/read/respond, wake-up, file access, tool execution, connection use, extension events, approval, and task cancellation. Include forged IDs, traversal, stale role/grant, cross-project artifact reference, duplicate events, untrusted/shared prompt-injected content, and non-owner channel senders. Assert denial occurs before model call, container start, or provider side effect.

**Measurements:** allowed/denied confusion matrix; unauthorized side-effect count; denial stage; audit attribution completeness; grant recheck latency.  
**Pass:** zero unauthorized successes; all intended allowed operations remain usable; each action has principal, scope, grant version, and correlation ID. Security regression is a release blocker.

### Batch 2 — One joined assistant → planner → worker → evidence journey

Build a provider-free but real-runtime acceptance path for both Space Assistant and Project Assistant. Use actual authenticated local requests, D1/SQLite migrations, service bindings, SpaceDO and AgentDO; use a deterministic local reasoning adapter only at the provider boundary. The adapter must not bypass planner, tool, capability, budget, evidence, or dispatch code.

For each assistant type run: open/create session → submit a bounded goal → planner creates a valid DAG → deterministic scheduler dispatches a scoped worker → worker produces a versioned artifact → host evidence collector binds evidence to the exact worker attempt/branch/artifact digest → verifier evaluates criteria → dependent task unblocks only after required verification → UI/task history shows the same correlated run. Assert Space Assistant, Project Assistant, and leaf worker remain distinct actors while reusing the same runtime primitives.

Add negative cases: worker says success but no artifact; artifact hash changes after collection; artifact belongs to a different branch/attempt; evidence is stale or incomplete; criterion requires human judgment; verifier returns uncertain; retry returns duplicate artifact; dependent task attempts to run early.

**Measurements:** valid graph rate, criteria coverage, missing-evidence detection, false acceptance/rejection, planner repairs, worker attempts, end-to-end latency, audit-trace completeness.  
**Pass:** no task becomes verified/completed from worker self-report alone; no dependent task runs before all required criteria pass; uncertain/human criteria enter review; one trace joins assistant → plan → worker → evidence → verifier → UI.

### Batch 3 — Blackboard coordination, wake claims, and fixer safety

Extend current local two-Worker acceptance with simultaneous claim races (1/2/8/32 competing wake consumers), duplicate delivery, out-of-order events, stale lease holder, DO restart between claim/dispatch/result, blackboard message replay, revoked standing policy, Project Bot busy, and source/recipient project deletion. Simulate two Project Assistants and multiple leaf workers sharing the board; verify workers receive only messages addressed/granted to them. Exercise automatic fixer selection only for an allowlisted deterministic repair; ambiguous/high-impact cases must escalate to the appropriate planner/owner and not spawn unbounded fixers.

**Measurements:** duplicate dispatch/effect count, lost wake count, stale lease commits, useful vs redundant messages, wake/claim latency, fix success/rework/escalation, model tokens per verified result (if model adapters run). Compare with a no-blackboard baseline on the same fixed task fixtures.

**Pass:** single active lease per idempotency key; zero duplicate committed external effects; revoked grants block dispatch at execution time; no worker/assistant gains scope via a board message; bounded retries and fixer depth; all unresolved cases visible to a human.

### Batch 4 — Durable dispatch, evidence, and provider-side effects

Inject process termination at every durable boundary: before intent commit, after intent/outbox commit, before send, after send/before acknowledgement, after acknowledgement/before result persist, and while collecting usage. Repeat for queue redelivery and AgentDO restart. Cover reserved/settled/uncertain budgets, provider receipt present/missing/mismatched, timeout before/after response, rate limits, malformed response, D1 unavailable, partial R2 write, artifact rollback, approval revoke during wait, and task cancellation.

For an external action stub, model `not_sent`, `confirmed_sent`, and `unknown` explicitly. A missing acknowledgement is not proof of failure; the safe result is an uncertainty hold/reconciliation path, not automatic replay. Verify deterministic idempotency keys include tenant, operation, action payload/version, and logical attempt rules.

**Measurements:** recovery rate by injected point; duplicates/lost work; uncertainty duration; reservation leakage; reconcile success; retry count; user-visible status delay.  
**Pass:** restart/replay is idempotent; costs are reserved before every provider attempt and reconciled only from trusted evidence; unknown effects are never blindly repeated or marked successful.

### Batch 5 — Decision model and evaluation quality

Keep Clef Flash/OpenRouter production routing unchanged. Any Gemini/GroqCloud keys are evaluation-only, opt-in, quota-aware, and must never alter production configuration. Separate provider connectivity tests from quality evaluations.

Use a versioned held-out task set with deterministic host truth for state transitions and independent labels for judgment-based criteria. Compare: deterministic rules only; decision model in shadow/advisory mode; model-selected among host-generated eligible actions. Include adversarial and ambiguous criteria, malformed/partial model output, model outage, latency timeout, prompt injection, and budget exhaustion. Report per-model results; rotate keys only within a provider/model-specific quota policy and never infer limits from another model on the same key.

**Metrics:** valid decision rate, criterion-level agreement, false acceptance, false rejection, review rate, calibration by confidence bucket, latency p50/p95, provider cost per correct decision, outage fallback behavior, and sample sizes/intervals.  
**Pass:** model cannot create permissions/actions outside host eligible candidates; deterministic fallback preserves invariants; no model is promoted from a tiny synthetic sample. For high-impact verification, false acceptance must be zero in the tested held-out set and all residual uncertainty remains human-reviewed; state that finite samples do not prove zero real-world risk.

### Batch 6 — Six-tier execution ladder, commands, MCP, containers, and tunnels

Exercise virtual CLI tools, worker-created commands, dynamic workers/workflows/scripts, MCP authorization, shell and file scopes, Browser/KiteSurf/full browser, managed sidecars, and external tunnels. Test at least two workers requiring different containers concurrently; two workers requiring the same container; shared-image but separate workspaces; one dependent multi-command task; prewarm hit/miss; container crash; tunnel offline/reconnect; profile restore; credential isolation; snapshot restore; and plan quota/concurrency boundaries.

For same-container requests, prove scheduler choice: safe isolated parallel slots only if the runtime/image contract guarantees filesystem/process isolation; otherwise queue only the conflicting resource while allowing unrelated work to continue. A dependent command chain must carry one declared environment affinity or a content-addressed artifact handoff; never rely on invisible mutable filesystem state across two machines. Tunnel invocation remains last resort unless task requirements explicitly select it.

**Measurements:** environment selection accuracy, cold/warm start, prewarm hit rate, queue time, parallel throughput, resource utilization, state-transfer bytes/time, profile persistence, quota denials, cross-workspace contamination, tunnel use reason.  
**Pass:** zero cross-scope filesystem or profile leaks; no plan-cap overrun; environment choice is explainable from declared requirements; unavailable/untrusted target fails closed. If current container contracts cannot support safe parallel slots, report the concurrency limit and test queue fairness rather than pretending parallel capacity.

### Batch 7 — User-visible journeys and generic product/template lifecycle

Run current browser tests, then add authenticated local UI/API-to-DO journeys for Space creation from the default product/Space Template, project creation, Space Assistant and Project Bot entry, role/viewer denial, archive/restore, approvals, blackboard/task graph/evidence visibility, cancellation, connection setup/disconnect, extension install preview, extension grants, fresh-Space template install, upgrade/rollback, and failure cleanup. Desktop plus 338px and 740px viewports. Confirm retired business/wallet/legacy customer-agent routes are absent or explicitly extension-owned.

**Pass:** backend authorization matches UI affordances; no success toast before durable result; task status distinguishes running, succeeded, verified, review, uncertain, and failed; partial installs leave no active residue; template capability/connection/plan limits are truthful.

### Batch 8 — Migration, backup, deletion, and operational recovery

Apply all migrations from empty D1 and from the prior supported schema; repeat migration runner; verify checksums/order and rollback/forward recovery where supported. Exercise Space/Project deletion, retention/erasure, R2 and SQLite artifact references, stale indexes, queue/dead-letter recovery, DO alarm replay, backup restore, and feature-flag rollback. Verify no retired billing/accounting data path is still invoked by generic Space creation.

**Pass:** migration is repeat-safe; data ownership/deletion policy is honored; no dangling active dispatch/credential/extension after deletion; rollback instructions are executable and tested locally.

### Batch 9 — Cost, latency, and load envelope

Do not advertise extrapolated capacity. Start with a warmed-up baseline then concurrency 1, 2, 4, 8 and increase only while error, CPU/memory, queue depth, and provider-budget headroom remain inside configured limits. Run at least 30 repetitions per critical route for latency percentiles; at least 100 synthetic tasks per category before making broad model-quality claims. Keep test payloads synthetic.

Report separately for Space Assistant, Project Assistant, task worker, blackboard wake, verification, shell/browser, container, and connector: p50/p95/p99 latency; cold vs warm start; error class/rate; CPU/memory/invocations/queue depth; model tokens/provider USD; platform storage/egress; retries; cost per verified outcome. Include successful, failed, review, and timed-out tasks in denominators. Measure first response and total verified completion separately.

**Pass:** no unbounded queue/token loop, no budget overspend, no noisy-neighbor cross-tenant effects, configured limits stop admission predictably, and observed saturation is reported. If p95 or error budgets are not defined by the product, label the result descriptive rather than passed against a fabricated SLO.

### Batch 10 — Isolated live Cloudflare and provider canary

This is the final gate, not the first. Use a disposable test Space/account, synthetic fixtures, minimum-privilege credentials, explicit spend/request limits, and cleanup. Do not run destructive writes against customer or production systems.

1. Deploy the exact tested SHA to a staging Cloudflare environment. Verify migrations, actual Worker bindings, service bindings, DO SQLite, D1, R2, queues, alarms, secrets, logs, and rollback. Exercise login, Space/project creation, one deterministic no-provider task, then one bounded provider-backed task.
2. For each enabled provider, separately test authentication, one read/probe, one bounded operation, webhook signature/replay, timeout/uncertain outcome, usage/cost receipt, revocation, and cleanup. One provider passing does not qualify another.
3. Test Cloudflare Containers/Browser/Calls only if enabled in the release: actual startup, image digest, mount isolation, timeout/termination, browser profile, audio/media path, and billable usage. Do not claim features not activated in this canary.
4. Exercise backup restore, observability alert and rollback on the deployed test tenant.

**Pass:** every deployed operation matches its local contract, durable audit/evidence is observable, cost reconciles, cleanup completes, and rollback is demonstrated. Any missing provider configuration is an exact blocker, not a passed test.

## Tomorrow's release gate

By 2026-11-02, classify each gate as `PASS`, `FAIL`, `BLOCKED_EXTERNAL`, or `NOT_RUN`; do not turn `BLOCKED` into `PASS`.

### Required for a defensible release candidate

- Batch 0 is green on the candidate SHA with a clean lockfile install and complete suite result inventory.
- Batches 1, 2, and 4 pass for the supported core assistant/task path; zero unauthorized actions, false verified completions, duplicate committed effects, or budget overspends in the tested cases.
- Batch 3's critical authorization and idempotency cases pass; concurrency gaps are explicitly capped or fixed.
- Browser path and migration checks pass for the features being released; feature flags default off for any unaccepted runtime/provider capability.
- A release/rollback checklist, alert path, backup/restore evidence, known limitations, and live-test owner/actions are recorded.

### Required before saying “production-ready”

- Batch 10 passes on a deployed isolated environment for each provider/runtime feature advertised as enabled.
- Security, recovery, cost, and role/scope gates have no unresolved release-blocking failures.
- Monitoring, backup/restore, rollback, incident handling, data retention/deletion, and support ownership have concrete evidence.
- Feature availability and marketplace/template claims match what passed; unsupported paths are disabled or clearly marked.

If live Cloudflare/provider acceptance cannot happen by tomorrow, the accurate claim is “release candidate with local tests passed; live deployment/provider acceptance pending,” not production-ready.

## Required result artifact for every batch

Each run writes machine-readable JSON and a human-readable summary containing:

```json
{
  "schemaVersion": 1,
  "sourceCommit": "<full sha>",
  "batch": "<id and name>",
  "evidenceClass": "unit|integrated-local|synthetic-model|provider-live|cloudflare-live",
  "state": "PASS|FAIL|BLOCKED_EXTERNAL|NOT_RUN",
  "startedAt": "<UTC>",
  "durationMs": 0,
  "cases": {"passed": 0, "failed": 0, "skipped": 0, "blocked": 0},
  "metrics": {},
  "failureIds": [],
  "artifacts": [],
  "limitsAndCaveats": []
}
```

Keep prompt contents, credentials, user data, and live customer identifiers out of artifacts. Preserve raw synthetic case IDs and aggregate outputs. For Actions, inspect both every suite result artifact and the final workflow conclusion. Reruns must point to the same source SHA or clearly identify the amended SHA.

## Immediate next actions

1. **Complete for commit `f7b152eb`:** the full GitHub Actions inventory and connected checks passed; the per-suite summary and runtime metrics were inspected. A documentation-only update may trigger another inventory run, but does not change this code-tested SHA.
2. **Partially closed:** the local mock proves Space Assistant and Project Bot use the shared planner/worker architecture, including host artifact evidence and active verification; the Project Bot two-task test proves dependent gating. Next, add authenticated browser-to-DO visibility assertions that join the assistant, task, worker, artifact, and verification receipt in one user-visible trace.
3. Continue Batch 3 with concurrent wake-claim recovery across crash/lease boundaries and blackboard message delivery; continue Batch 4 with AgentDO goal-state restart and uncertain external-effect tests.
4. Run authenticated UI-to-DO lifecycle cases and archive/restore/member journeys. The current browser tests are useful but synthetic.
5. Continue independent Batch 5 decision-quality and Batch 6 environment/browser/container experiments, then Batch 9. Batch 8's migrations have already been applied successfully during the local runtime test, but deletion/backup/rollback recovery remains open.
6. Only after the relevant local gates pass, perform Batch 10 with the required staging/provider configuration. Keep both maintained branches at the tested SHA and attach result artifacts.

### Follow-up: full local Project Bot → leaf AgentDO workspace publication (2026-11-01)

- The scoped Project Bot experiment now crosses the real blackboard wake, planner CLI, persisted task DAG, host dispatch, separate child AgentDO, scoped workspace write, and SpaceDO publication authorization. The synthetic worker wrote `reports/blackboard-worker-smoke.txt`; the fixture verifies its exact contents and SHA-256, the published task branch, and terminal task status. The local model gateway is deterministic and test-only; this run made four local synthetic inference requests and zero external-provider requests. Goal-verification enforcement remains disabled in this acceptance fixture, so this proves artifact publication and task completion, not an independent production verifier.
- A focused rerun after adding exact-content and digest assertions passed **1/1** in **54.209 s** including the local database/Worker setup; the actual wake-to-publication route took **651 ms**. The returned artifact digest matched the bytes read back from the scoped R2 workspace path.
- Full local Wrangler runtime acceptance passed **9/9**. It applied 154 D1 migration files in **44.003 s**, started four local Workers in **9.317 s**, and completed the harness in **68.399 s**. The 30 pre-model air-gap admission samples measured p50 **118 ms** / p95 **156 ms**. The successful delegated Project Bot task path took **540 ms** in this full run (the separately targeted rerun took 701 ms); these values are local development measurements, not service SLOs.
- Reliability cases in that same run passed: 16 concurrent wake sweepers produced one claim/dispatch; membership revocation blocked AgentDO dispatch; busy delivery retried after backoff; expired leases stayed held; repeated sweeps did not duplicate work; and a viewer could not create Project Bot threads. The full suite also passed Project Assistant session persistence/restart and the provider-free air-gap boundary. No provider call was made.
- The run exposed and fixed an infinite-loop edge case in request-context trimming (`slice(-0)` at a one-element remainder), an overlong duplicated worker system catalog, paid-tier worker budgets lost on host-created blackboard wakes, project-memory recall exceeding Cloudflare SQLite's variable limit, and misleading generic child-worker failure reporting. Regression tests cover each code fix. Local targeted tests passed **33/33** across request budgeting, worker capability boundaries, kernel, and wake behavior, plus **16/16** project-memory tests. Agents and Spaces TypeScript checks and `git diff --check` passed.
- Harness issues found and corrected: the membership fixture seeded only platform membership, not the separate SpaceDO publisher roster; sequential free-port probes could select the same released port; readiness accepted HTTP 404 as ready; and Wrangler debug logs filled the workspace overlay. The fixture now provisions the SpaceDO roster over its authenticated production route, reserves each port by starting its Worker before selecting the next, requires a successful readiness response, and disables Wrangler disk logs for this isolated run. The local test again runs entirely in Wrangler with its state under `/tmp`.
- **Updated Batch 2 status at that point:** real local AgentDO dispatch and versioned-branch artifact publication were proven for a Project Bot. The subsequent Space Assistant parity and dependency-gate experiments below close the delegated assistant/evidence/gating paths locally. UI visibility of the joined actor/task/evidence trace, Batch 4 in-flight AgentDO recovery, and live provider side effects remain open.
- Current limitations remain material: no deployed Cloudflare environment, live OpenRouter usage, phone/channel provider, production container/tunnel, external benchmark dataset, independent verification, or browser UI → live DO lifecycle was exercised. This is stronger local integration evidence, not a production-readiness claim.

### Follow-up: Decisions model catalog ID compatibility (2026-11-01)

- Reviewing the real Durable Object Decisions billing admission found an ID-format mismatch: the Decisions API model is `cloudflare/clef-flash`, while the OpenRouter catalog adapter exposes its same card as `openrouter/cloudflare/clef-flash`. The reserve callback compared only the qualified value and consequently rejected a fresh card before budget reservation.
- The host now resolves a catalog card by either its raw catalog ID or its qualified BYOK ID, then still requires fresh catalog pricing and the existing billing service before admission. Missing, stale, or unpriced cards remain fail-closed.
- Regression coverage passed for both representations and verifies that the selected card carries usable prices. Five focused Agents suites passed **41/41**, and the Agents TypeScript project check passed. No OpenRouter request was made.
- This closes catalog lookup compatibility only. It does not exercise a live Decisions call, production billing ledger, or active goal-verifier enforcement in the multi-Worker runtime acceptance; those remain separate acceptance gates.

### Follow-up: host evidence → active verification → metered Decisions contract (2026-11-01)

- Added a focused integration suite joining the production `executeGoalDag`, host evidence collector contract, `assessGoalEvidence`, and the real `SystemOneDecisionClient`. A local synthetic Decisions endpoint validates the OpenRouter request URL, auth header, model, generation receipt and usage shape; mock billing callbacks validate reservation and settlement lifecycle without contacting a provider.
- Verification passed **3/3** cases: verified host evidence is sent to Decisions and the dependent worker launches only after a passing assessment; uncertain host evidence bypasses Decisions/billing and blocks descendants; a Decisions uncertainty is settled against its confirmed receipt and moves the task to review while blocking descendants.
- An earlier attempt to turn verification on in the multi-Worker Wrangler acceptance did **not** pass: the synthetic Project Bot leaf returned a success narrative but published no file (`modifiedFiles: []`), so the host collector correctly held the task for review. The later dedicated leaf-action fixture and dependent-task experiment below supersede that incomplete fixture and pass the real scoped write plus host-verification path. No provider call is implied by either result.
- Still open: build a dedicated test-only model/action script that performs a valid leaf-scoped write through the real worker tool surface, then rerun the full Wrangler path with required verification and confirm the exact attempt/branch/hash, Decisions call, reserve/settle receipt, and dependent gating in one run. No production change enabled verification, and no live OpenRouter or deployed billing request was made.

### Follow-up: artifact manifest corruption and read-race checks (2026-11-01)

- Host artifact verification now rejects persisted manifests with unsupported versions, invalid capture metadata, malformed or duplicate paths, invalid captured hashes/ETags/byte counts, and invalid selected paths. It also compares the final storage HEAD size after reading bytes, in addition to ETag and SHA-256, so an object changing size during verification remains uncertain.
- Regression tests cover unsupported manifest versions, duplicate entries, malformed hashes, traversal paths, and a same-ETag final-size race. Focused evidence/verifier suites passed **12/12**; Agents TypeScript checking passed; the complete Agents suite passed **1,075 tests across 211 files**, with **1 skipped**; `git diff --check` passed.
- This hardens the host evidence boundary. At that point the full required-verification runtime path remained open; the later local multi-Worker runs recorded below now exercise a scoped leaf artifact, Decisions outcome, and dependent-task gate. No live OpenRouter or deployed billing call was made.

### Follow-up: Space Assistant delegated-worker parity (2026-11-01)

- Added a host-triggered Space Assistant run to the same separate-Worker Wrangler harness. The Space Assistant used the shared planner CLI, dispatched a distinct leaf AgentDO, wrote `reports/blackboard-worker-smoke.txt` into `spaces/{spaceId}/workspace/`, and completed host evidence collection, Decisions assessment, and billing reserve/settlement. Its task was `completed` with `passed` verification.
- In the combined local run, the Project Bot verified/uncertain dependency-gating cases and this Space Assistant path all passed: **12/12** Wrangler tests. The Space Assistant dispatch route took **407 ms**; 154 migrations took **62.181 s**, initial four-Worker startup took **12.644 s**, and total harness runtime was **107.741 s**. These are local one-run measurements, not production SLOs.
- Agents tests passed **1,076/1,077** (one intentionally skipped) across 211 files; Agents TypeScript checking and diff checks passed. A delegation-contract test confirms absent system-wake caller roles remain absent and cannot be changed to `viewer` or `owner`.
- The test exposed a production delegation defect: the host invented `viewer` when a system wake had no caller role. That caused a delegated worker to lose the owner's configured autonomous approval policy and wait on an unreachable HITL approver. The host-signed delegation now preserves a caller role only when the parent actually has one. The Reasoner also reports generic inference-budget admission failures rather than incorrectly labeling them as project-spend failures.
- **External calls:** zero. The model gateway and Decisions endpoint were deterministic local test fixtures. This run does not test live OpenRouter/billing, deployed Cloudflare, host-wake plan quota policy, UI actor/task/evidence visibility, or restart during a running AgentDO operation. GitHub Actions acceptance for the amended source SHA remains the next verification step.

## Explicitly out of scope for a one-day proof

Passing a bounded test plan does not prove broad model intelligence, zero real-world false acceptance, production scalability, regulatory compliance, marketplace trustworthiness, or availability in every country/provider. External benchmark datasets, large-scale customer load, independent FDE publishing, and every vertical integration require separate evidence and must not be smuggled into a “green CI” claim.

### Follow-up: delegated worker blackboard delivery boundary (2026-11-01)

Added an integration regression that invokes `task_blackboard.recipients`, `.publish`, and `.read` through `ScriptToolSurface.run`, the worker orchestration hook, and the `NaelaoAgentDO` internal route. A three-worker task graph grants the sender access to its dependent worker only. The receiver reads the finding, an unrelated worker sees no message, and an attempted send to that unrelated worker is rejected by the host with HTTP 403. Hostile-looking quoted source text remains explicitly untrusted data.

- Focused blackboard and DAG checks passed **46 tests across 5 files**.
- The full Agents Vitest suite passed **1,077 tests with 1 skipped across 212 files**; Agents TypeScript checking and `git diff --check` passed.
- The AgentDO route is real; DO storage is an in-memory transaction test double and membership `scopeAccess` is mocked. The workers are driven deterministically by the test, not by model inference. This does not prove model interpretation, simultaneous live Worker exchange, wake-driven delivery, or deployed Cloudflare behavior. Batch 3 wake-claim races, interruption recovery, standing-policy revocation, and fixer safety remain open.
