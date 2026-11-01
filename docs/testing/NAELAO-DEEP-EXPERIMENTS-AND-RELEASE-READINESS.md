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

1. Run Batch 0 against the exact current remote commit and retrieve its complete per-suite result artifacts.
2. Turn every failed test into a root-cause ticket, fix the code, and rerun dependent gates; do not spend time on optional model comparison while core authorization/durability is red.
3. Close Batch 2's missing successful provider-free joined task and exact evidence binding, then Batch 3 concurrent claim/recovery cases and Batch 4 crash-point/uncertain-side-effect cases.
4. Run Batch 7 browser and Batch 8 migration/rollback checks in parallel with independent Batch 5 synthetic decision evaluation and Batch 6 environment tests only after the core contract remains stable.
5. Reconcile this plan and existing evidence docs after every batch. Then perform Batch 9, and Batch 10 only with the required staging/provider configuration.
6. Keep both maintained Git branches synchronized to the final tested SHA and attach the batch result artifacts to that commit.

## Explicitly out of scope for a one-day proof

Passing a bounded test plan does not prove broad model intelligence, zero real-world false acceptance, production scalability, regulatory compliance, marketplace trustworthiness, or availability in every country/provider. External benchmark datasets, large-scale customer load, independent FDE publishing, and every vertical integration require separate evidence and must not be smuggled into a “green CI” claim.
