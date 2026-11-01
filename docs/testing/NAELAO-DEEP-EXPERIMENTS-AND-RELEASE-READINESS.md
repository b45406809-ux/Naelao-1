# Naelao deep experiments and release-readiness plan

**Status:** historical execution plan; claim-led testing priority is now maintained in [`NAELAO-CLAIM-LEDGER-AND-NEXT-EXPERIMENTS.md`](./NAELAO-CLAIM-LEDGER-AND-NEXT-EXPERIMENTS.md), not a completion or production-readiness claim
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

Historical reference checkout when this plan was first drafted: `Mcbt5s-Backup-2`, commit `42cfbabab89e95b498531532debd29fc9ce9563f`; `origin/Mcbt5s-Backup-2` matched and `origin/work` was three commits behind. This is not the current source baseline. Read the claim-led plan's current SHA and branch state before relying on any older run or restarting a batch.

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
| 2 — Joined task/evidence | **PARTIAL PASS** | The local four-Worker Wrangler suite exercises Space Assistant and Project Assistant planner → child AgentDO → scoped artifact → host evidence → Decisions verification → usage reservation/settlement. Verified/uncertain outcomes and dependent-task gating pass. A builder-only dashboard now groups persisted Space/Project Assistant and worker activity by root run; authenticated browser-to-DO execution, live-provider execution, and broad independent benchmark remain open. |
| 3 — Blackboard coordination | **PARTIAL PASS** | 1, 2, 8, and 32 simultaneous local-D1 sweepers each produce exactly one claim/dispatch; authorization revocation, busy retry, lease expiry and dedupe pass. The HTTP-200/script-failure false completion is fixed and tested. Fixer spawning is opt-in, host-kill-switch controlled and capped at two per goal in deterministic DAG tests. Worker-message recovery, AgentDO restart during dispatch, and a full AgentDO fixer execution/recovery trace remain open. |
| 4 — Durable dispatch/side effects | **PARTIAL** | Goal DAG, outbox, usage reconciliation, tunnel idempotency/restart and billing reservation tests pass. AgentDO outbox recovery plus real external side-effect uncertainty/reconciliation is not yet exercised across a running DO restart. |
| 5 — Decision/evaluation quality | **SYNTHETIC ONLY** | 9 repository-authored graph scenarios repeated 3 times plus generated DAG stress run in tests; one test is skipped. No external held-out dataset or current live model quality evaluation was part of this full-test run. |
| 6 — CLI/MCP/runtime environments | **PARTIAL PASS** | Selected command/MCP (52), MCP Hub (21), tunnel/container (42 + 38) tests pass; distinct container affinity and shared-resource queuing are covered in goal DAG tests. No live tunnel machine, managed container provider, browser profile or production snapshot acceptance. |
| 7 — UI/template journeys | **PARTIAL** | Browser CI passes its seeded fake-API Project Bot journey. A builder-only trace view is available in the team dashboard, but it has only local build/type/test evidence. Authenticated end-user UI-to-DO task/evidence/approval and member/editor/viewer/archive lifecycle journeys remain open. |
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
2. **Partially closed:** the local mock proves Space Assistant and Project Assistant use the shared planner/worker architecture, including host artifact evidence and active verification; the dependent-task test proves gating. A builder-only dashboard trace now joins activity rows by root run. Next, add an authenticated browser-to-DO journey that joins assistant, task, worker, artifact, verification receipt and durable task status; do not treat the local dashboard build as browser acceptance.
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

Added an integration regression that runs `executeGoalDag` with three deterministic workers calling `task_blackboard.recipients`, `.publish`, and `.read` through `ScriptToolSurface.run`, the worker orchestration hook, and the `NaelaoAgentDO` internal route. Worker A and independent C are dispatched concurrently; dependent B starts only after A finishes. The host-derived DAG grant lets A address B only. B reads the finding, C sees no message, and A's attempted send to C is rejected with HTTP 403. Removing the actor's membership from the D1 fixture then denies B's next read without modifying the stored message. Hostile-looking quoted source text remains explicitly untrusted data.

- Focused blackboard and DAG checks passed **46 tests across 5 files**; Agents typechecking passed.
- The full Agents Vitest suite passed **1,077 tests with 1 skipped across 212 files**; Agents TypeScript checking and `git diff --check` passed.
- The AgentDO route and `scopeAccess` implementation are real; DO storage is an in-memory serialized transaction double, while D1 and the Spaces membership route use narrow fixtures. Workers are driven deterministically by the test, not by model inference. This does not prove deployed Durable Object transaction behavior, model interpretation, wake-driven delivery, or deployed Cloudflare behavior. Batch 3 wake-claim races, interruption recovery, standing-policy revocation during dispatch, and fixer safety remain open.

### Follow-up: Project Bot wake claim and interrupted-lease behavior (2026-11-01)

Added two SQLite-backed integration cases around the real `sweepBlackboardWakes` implementation. Concurrent sweeps race the same pending event while the winning wake callback is blocked; the losing sweep must finish without starting another assistant run, and the persisted attempt count remains one. A pre-existing `running` row with an expired lease becomes `held` and is not dispatched again, avoiding a duplicate run when the prior dispatch outcome is uncertain.

The focused wake integration passed **4/4**, Agents typechecking passed, and the Agents suite passed **1,079 tests with 1 skipped across 212 files**. The repository also has a separate local-Wrangler D1 acceptance that races 16 sweepers and observes one dispatch/attempt; it ends at the isolated AgentDO air-gap guard before provider execution. The new SQLite cases are narrower regression tests, not Cloudflare D1 concurrency or process-crash acceptance. The follow-up below adds the missing policy-revocation boundary; human reconciliation of held wakes remains open.

### Follow-up: wake-policy revocation linearization (2026-11-01)

Added migration `0154_blackboard_wake_acceptance.sql` with a durable `dispatch_accepted` marker. The Spaces policy update batches the policy mutation with holding pending and unaccepted running wakes. The Agents sweeper conditionally accepts a claim only while its lease, enabled policy, and authorized owner still match. If disable commits first, the wake cannot dispatch; if acceptance commits first, that already-accepted dispatch may finish while later events remain disabled. Regressions simulate revocation after the initial policy/membership check and verify it blocks dispatch, and verify the policy batch holds pending/unaccepted claims while preserving accepted work.

The policy transaction test passed **1/1**; focused Agents wake checks passed **8/8 across two files**. Local four-Worker Wrangler acceptance passed **12/12** with **155 migrations** applied, including the 16-way D1 claim race, restart-persistence paths, and the Space Assistant/Project Bot verification journeys. Agents passed **1,080 tests with 1 skipped across 212 files**; Spaces passed **362 tests across 83 files**; both typechecks passed. This run took **78.348 s** overall; migration application took **43.788 s**, Worker startup **9.074 s**, and 30 admission samples measured **p50 114 ms / p95 131 ms**. There were zero external model/provider requests. These are local emulator results; deployed Cloudflare behavior and operator reconciliation of held wakes remain unverified.

### Follow-up: bounded automatic fixer admission and resume behavior (2026-11-01)

The goal scheduler now accepts a host-derived per-goal fixer allowance, validates it, and enforces a kernel ceiling of two fixer attempts per goal. The AgentDO bounds that allowance by configured worker execution capacity. The allowance is persisted in the goal journal and may only decrease when resumed under a smaller host limit. The host's `TASK_FIXER_ENABLED` flag is authoritative at every resume, so a previously saved opt-in cannot bypass a deployment kill switch. Already-running fixer attempts are reconciled without launching replacements; uncertain, interrupted, or human/planner-waiting outcomes remain in review. Fixer success remains advisory: it does not change the failed original task, satisfy its verifier, or release dependents.

Current local results: the focused goal DAG and goal-activity route suites passed **47/47** tests; the full Agents suite passed **1,089 tests with 1 skipped across 212 files**; Agents TypeScript checking passed. The route regression confirms owners can see fixer status while private fixer output remains excluded. The local multi-Worker Wrangler acceptance passed **12/12**, applying **155 migrations**. The run took **100.895 s** overall, migration application **55.790 s**, Worker startup **13.996 s**, and 30 local wake-admission measurements were **p50 128 ms / p95 156 ms**. Space Assistant and Project Bot synthetic worker/evidence/dependency scenarios remained green; external-provider request count was zero. That runtime acceptance keeps automatic fixer execution disabled, so it does not prove a real fixer launch through AgentDO.

These tests prove deterministic graph-level limits, the live host kill switch, lowering a persisted cap on resume, uncertain outcome handling, and prevention of false task promotion. Still open: an end-to-end AgentDO fixer run with metered worker usage, durable restart at each fixer dispatch boundary, user-visible fixer result/action, and live Cloudflare/provider behavior. Repository pnpm commands were blocked by the supply-chain hook rejecting ignored dependency build scripts; installed local TypeScript and Vitest binaries were used. GitHub Actions on the resulting commit is still needed for CI confirmation.

### Follow-up: 1/2/8/32 local D1 wake-claim contention (2026-11-01)

Extended the earlier 16-way experiment to 32 contenders, then ran separate events at 1, 2, 8, and 32 simultaneous sweeper calls. Each race goes through the separate local Agents and Spaces Workers and the real D1 conditional claim; the test harness records contender, dispatch, attempt and repeat-dispatch counts in its JSON metrics.

The full local Wrangler runtime suite passed **12/12**. At every contention level, the result was exactly **one** dispatch and **one** durable attempt; an immediate repeat sweep produced **zero** additional dispatches. The four-race matrix took **600 ms** total. Across that run, 155 migrations applied in **46.354 s**, four Workers started in **8.973 s**, and 30 wake-admission samples were **p50 107 ms / p95 137 ms**; total runtime was **81.030 s**. Provider attempts remained zero. These are one-run local emulator measurements, not deployed Cloudflare concurrency or service-level guarantees.

### Follow-up: AgentDO restart and dispatch receipt visibility (2026-11-01)

Goal activity now includes a bounded, status-only view of each task's durable dispatch outbox row. It resolves rows by the exact goal/task IDs and exposes only `intent`, `delivering`, `acknowledged`, `uncertain`, or `review`, plus a positive attempt number. It does not return the worker ID, branch, payload, or output. The assistant panel shows dispatch acceptance separately from worker execution and verification, preserving the distinction between “worker accepted” and “work verified.”

The local Wrangler acceptance asserts both a passed worker and an uncertain verification retain `acknowledged` dispatch status across an Agents Worker restart; the task remains `completed/passed` in the first case and `needs_review/uncertain` in the second. The full runtime suite passed **12/12**. It applied 155 D1 migration files in **45.464 s**, started four Workers in **8.827 s**, and took **82.794 s** by harness instrumentation (**83.160 s** by Node's test runner). The passed Project Bot leaf-worker journey completed in **685 ms**; its AgentDO restart took **4.364 s**, and the uncertain-verification restart took **4.223 s**. Thirty local wake-admission samples measured **p50 115 ms / p95 155 ms**. The 1/2/8/32 wake-claim races each retained one dispatch/attempt and zero repeat dispatches. Focused route/DAG tests passed **47/47**; Agents and shell TypeScript checks passed. These are local Wrangler observations with synthetic model adapters, not deployed Cloudflare timing or live-provider execution.

This observes completed work after process restart, not a crash injected in the narrow interval during `delivering`; ambiguous delivery remains held for review rather than replayed. The panel's new dispatch badge is visibility-only, and activation policy is unchanged.

### Follow-up: worker blackboard message survives Agents Worker restart (2026-11-01)

The local Wrangler harness now creates a two-task Project Bot graph, signs a worker delegation contract, and publishes a finding from the prerequisite worker to its declared dependent through the real `NaelaoAgentDO` `/internal/task-blackboard` route. The test restarts the Agents Worker process and reads the goal activity from the same persisted DO storage; the recipient still sees exactly the committed message. The route rechecks the real test Space membership and DAG-derived recipient grant. No test-only production message storage path was added.

The full local runtime suite passed **12/12**. This run applied 155 migrations in **52.437 s**, started four Workers in **12.183 s**, and completed in **97.423 s** by harness timing (**97.673 s** under Node). The message publish took **17 ms**, and the restart/readback took **4.344 s**. Thirty local admission samples measured **p50 130 ms / p95 161 ms**; provider calls were zero. The synthetic local model fixtures completed the prerequisite/dependent run; these numbers do not represent deployed Cloudflare, external providers, or production SLOs.

### Follow-up: interrupted `delivering` journal recovery simulation (2026-11-01)

Added a scheduler fault-injection test that pauses a worker dispatch after the atomic journal/outbox commit, captures the durable state with task `running` and outbox `delivering`, and resumes from that journal in a replacement scheduler with no worker receipt. The restored run marks the task `needs_review`, blocks its dependent, and does not call dispatch or launch again. Releasing the original lost acknowledgement also leaves it in review; no second worker attempt is created.

The targeted goal-DAG suite passed **46/46**, the complete Agents suite passed **1,090 tests with 1 skipped across 212 files**, Agents TypeScript checking passed, and `git diff --check` passed. This is a deterministic scheduler/journal recovery simulation; it does not kill a running Wrangler process or inject a crash into the actual AgentDO `delivering` boundary. The multi-Worker process-crash acceptance remains open.

### Follow-up: AgentDO process crash during real dispatch (2026-11-01)

The local four-Worker Wrangler acceptance now pauses an actual Project Bot goal dispatch after the durable outbox reaches `delivering` and before `spawnSubAgent`, then kills and restarts the Agents Worker process. On reconstruction, the pending run becomes terminal with an interruption reason, the outbox moves to `review`, the task is projected as `needs_review`, its dependent remains `blocked`, and the child is not launched. The next `/active-run` check clears the ghost busy state and performs signed concurrency-lease reconciliation only when the host can prove the child never started or is terminal. Reconciliation proofs are short-lived and single-use; invalid and replayed proofs cannot remove a later lease. Ambiguous dispatches with a live child remain held.

The complete local Wrangler acceptance passed **13/13**. It applied 155 D1 migrations in **49.527 s**, started the four Workers in **9.773 s**, and took **96.633 s** by harness timing (**111.226 s** under Node). The injected Agents Worker restart took **4.578 s**. Thirty local wake-admission samples measured **p50 118 ms / p95 149 ms**. Space Assistant verification, Project Bot leaf dispatch, passed/uncertain dependency gating, restart-persisted blackboard messages, and 1/2/8/32-way wake-claim races passed. Focused queue/DAG/blackboard regressions passed **67/67** across three files, the full Agents suite passed **1,091 tests with 1 skipped across 212 files**, Agents TypeScript checking passed, and there were zero external provider requests.

This proves process termination and restart in the local Wrangler emulator with synthetic model and Decisions adapters. It does not establish Cloudflare production eviction semantics, live provider billing, container-sidecar termination, or production latency guarantees. Recovery remains fail-closed when a child may have launched; that case requires trusted child-state reconciliation or operator review.

### Follow-up: host evidence path matrix and blackboard ablation (2026-11-01)

Adversarial evidence-path testing found that the evidence operation schema accepted traversal-shaped artifact paths before the host's stricter workspace check. The host check already rejected the paths, but the SDK/runtime boundary was unnecessarily permissive. The canonical relative workspace artifact validator now rejects traversal, absolute paths, backslashes, empty and dot segments, and NUL bytes both during evidence-check validation and manifest capture. Regression coverage confirms invalid paths never call the host capture operation. A fixed-seed matrix of 400 cases (100 valid, 100 scope mismatches, 100 mutation/deletion/revision cases, 100 path attacks) recorded zero false acceptances, zero false rejections, zero mismatched-scope storage reads, and zero invalid-path host calls. This is deterministic unit evidence, not an independent or model-based verifier benchmark.

The same run measured 100 task DAGs (701 tasks, 595 dependency edges). Direct DAG handoffs and recipient-targeted task-blackboard handoffs each serialized to **80,518 UTF-8 bytes**; the board's messages totaled **81,173 bytes**. There were zero payload mismatches, cross-recipient leaks, or completion-state mismatches. A hypothetical all-to-all broadcast serialization was 368,311 bytes, but the product does not use that broadcast mode, so this is not a valid product comparison. The initial hypothesis that the task board itself reduces handoff payload is falsified for this path; the board's value must be measured in communication policy, durable visibility, and cross-project coordination instead.

That finding exposed a concrete gap in Space-wide `blackboard.search`: Decisions triage produced relevance scores but did not affect candidate ordering. The search operation now reranks only the five scored candidates, preserving lexical order as a stable tie-break and leaving unscored candidates in lexical order. Triage remains explicitly opt-in and advisory; failure returns lexical results. Contract tests verify the cap, ordering, and fallback. The mock scorer is not evidence of real-model relevance, token savings, or cost improvement. The target remains an intelligent system that measurably improves verified outcomes; cross-project recall/precision and actual provider cost are still unmeasured.

The generated matrix completed in **47.77 ms** and the 100-graph DAG ablation in **112.07 ms** on the final serial run. The matrix also made 100 invalid-path manifest-capture attempts; both evidence collection and manifest capture made zero host/storage calls for invalid paths. The focused evidence, blackboard, matrix, and DAG-ablation suites passed **9/9 across 3 files**. The complete Agents suite passed **1,094 tests with 1 skipped across 214 files** in **69.39 s**; Agents TypeScript checking passed.

Serial local Wrangler acceptance passed **13/13** in **105.19 s** under Node (**89.867 s** harness timing). It applied 155 migration files in **45.534 s**, started the four Workers in **9.339 s**, and measured 30 wake-admission attempts at **p50 112 ms / p95 133 ms**. The Project Bot leaf-worker artifact and host evidence/Decisions verification completed in **647 ms**; Space Assistant verification and billing reserve/settlement passed. Uncertain evidence remained `needs_review` and blocked its dependent. The actual AgentDO process-crash injection ended in review without launching a child; 1/2/8/32 concurrent wake claimants each produced exactly one dispatch and zero repeat dispatches. Provider calls were zero.

The first full Wrangler attempt, run concurrently with CPU-heavy checks, missed its 30-second dispatch-observation window; dependent scenarios then saw `assistant_busy`. The crash-recovery test passed alone, and the serial full run passed, so the timing miss is recorded as a harness/load sensitivity rather than hidden. GitHub Actions access is unavailable in this environment because the configured `GH_TOKEN` is rejected as invalid, so no Actions result is claimed for this follow-up.

### Follow-up: Space Blackboard Decisions cost and latency telemetry (2026-11-01)

The Decisions SDK already received OpenRouter usage and exact reported cost for host billing, but typed `ScoreDecision` results exposed tokens only and `blackboard.search` discarded all usage metadata. `FastDecisionMeta.usage` now carries optional `costUsd`, and each blackboard triage result returns provider/model, latency, token counts, and provider-reported cost when present. A bounded aggregate reports call count, calls with usage, token totals, per-call latency samples, and total provider-reported cost. If any cost receipt is missing, aggregate cost is `null`; token prices are never guessed. This remains telemetry returned by the operation, not a live-model result or an independently benchmarked relevance claim.

Blackboard contract tests passed **8/8**, including capped reranking, five-call usage aggregation, and missing-cost behavior. Decisions SDK tests passed **29/29**; the full Agents suite passed **1,095 tests with 1 skipped across 214 files**; Agents and Agent SDK typechecks passed. The preceding 13/13 local Wrangler run remains the integration baseline; no external provider request or GitHub Actions result was available for this telemetry-only increment.

### Follow-up: correlated Space Assistant, Project Assistant, and worker audit trace (2026-11-01)

The previous audit surface stored per-run IDs and optional project scope but lacked a first-class root-run link. SpaceDO migration 108 adds `assistant_scope`, `root_run_id`, `parent_run_id`, and `worker_id` to `agent_activity_log`, plus an indexed root-run lookup. NaelaoAgentDO classifies only host-verified delegated runs as `worker`; top-level runs use their Space or Project scope. The builder read route can filter by a bounded root-run ID. The new fields are optional, preserving older rows and writer compatibility.

The local multi-Worker Wrangler acceptance verified one trace for each scope: Space Assistant root plus leaf worker (no project ID), and Project Assistant root plus leaf worker (project scoped). Both trace reads returned both records under the same root ID and preserved each worker's parent and worker IDs. Existing verification and billing assertions remained green. After adding malformed-correlation rejection, the complete local runtime suite passed **13/13**; 155 D1 migration files applied in **48.387 s**, four Workers started in **9.812 s**, total harness timing was **96.325 s** (**110.298 s** Node duration), and 30 air-gap wake admission samples measured **p50 114 ms / p95 133 ms**. Focused activity-log tests passed **9/9**; Agents and Spaces TypeScript checks passed. No external provider requests were made.

This establishes a persisted cross-scope execution trace in local Wrangler and builder audit storage. A dashboard that renders this joined trace, a live Cloudflare deployment, and live provider execution remain untested.

### Follow-up: paired blackboard ranking evaluator (2026-11-01)

Implemented `communications/blackboard-ranking-evaluation.ts` as the comparison harness for lexical ranking versus a candidate ranking on the same labeled queries. It reports MRR, Recall@K, nDCG@K, paired mean deltas, and deterministic-seed bootstrap 95% intervals. Input checks reject empty cases, missing relevance labels, duplicate IDs, invalid K, and undersized or oversized bootstrap runs. The evaluator does not call a model and its fixture tests measure the evaluator's math only.

The first versioned corpus contains **16 synthetic shared-project cards and 28 hand-labeled queries**, including multi-project intents and eight paraphrase cases. The lexical baseline measured **MRR 0.714, Recall@5 0.661, and nDCG@5 0.673**. The paired label-oracle ceiling was 1.0 on all three metrics; paired 95% bootstrap intervals for the oracle-minus-lexical delta were **[0.143, 0.464] MRR**, **[0.179, 0.518] Recall@5**, and **[0.170, 0.492] nDCG@5**. This fixture result exposes synthetic lexical-retrieval headroom; the oracle is constructed from labels and is not a model or achievable-system result.

Evaluator and corpus tests passed **4/4**; Agents typechecking passed. The corpus is not independently adjudicated or held out, and no Decisions requests were made. The next experiment step is a separately adjudicated holdout plus an opt-in Decisions run recording per-call usage, latency, and provider-reported cost beside the paired lexical baseline. Only that run can show whether the model improves relevance enough to justify its cost.
