# Naelao claim ledger and next experiments

**Status:** experiment plan; it is not evidence that any comparative or production claim has passed  
**Prepared:** 2026-11-01  
**Tested base commit:** `2492058efca60ed3e7a55de41ac7e648c98a8dda` (the experiment and fixes documented below were tested on this base plus the current changes)
**Purpose:** turn the ambition to outperform into falsifiable, measured engineering targets; improve the system wherever it misses; and prevent test counts from being mistaken for product-performance evidence.

## Decision

The objective is to make Naelao outperform the relevant alternatives. The current test record supports specific implementation statements: Space and Project Assistants use the shared planner/worker path in local Wrangler; scoped artifacts can pass host evidence and Decisions verification; uncertain evidence blocks dependent work; blackboard claims have bounded concurrency tests; dispatch ambiguity fails closed; and the new team dashboard can render persisted root-run traces. It does **not** yet establish that Naelao is faster, cheaper, more reliable, or generally better than Grok, OpenClaw, Hermes, SAP Joule, or vertical products.

The test program is an optimization loop, not a scope-reduction exercise: measure against a fair baseline, find the losing dimensions, fix the implementation or architecture, and rerun until the target is met. Keep the long-term goal ambitious; distinguish a target from a result. Until matched evidence exists, do not present a desired advantage as an achieved one.

### Initial performance targets to pre-register

These are proposed experiment targets, not current Naelao results. Freeze or revise them **before** opening held-out results, and record why if a target changes.

- **Safety floor:** zero unauthorized side effects and zero false task verification in the held-out acceptance set; every uncertain case stays reviewable. Security invariants are never traded for speed or cost.
- **Board value:** at least 15% lower total model-token cost per independently verified task than the same workload without the intelligent blackboard, with success non-inferior by at most 2 percentage points and no increase in duplicate committed effects.
- **Environment optimization:** at least 15% lower p95 time-to-verified-result or cost for tasks where prewarming is predicted to help, counting idle prewarm cost and queue time; no cross-workspace/profile contamination.
- **Overall matched benchmark:** seek at least a 10% paired improvement on the declared primary outcome (verified success per dollar, or time per verified success) against each accessible competitor/baseline while keeping safety and task-quality non-inferior. A claim is supported only when its paired 95% interval excludes no improvement; otherwise iterate or report it as unproven.

Targets are intentionally demanding. If they fail, treat that as a product/architecture defect to investigate and improve, not as a reason to lower the public goal. Do not silently relax the test set, budget, verifier, or comparator after seeing results.

## Evidence rules

Use these evidence classes consistently:

| Class | What it proves | Example |
|---|---|---|
| `unit` | A component contract under controlled inputs | Host rejects stale artifact digests |
| `integrated-local` | Real local Worker/DO/D1/R2 path, with provider edges stubbed or blocked | Space Assistant to leaf worker to evidence receipt |
| `synthetic-model` | Orchestration correctness with deterministic model responses | A predefined plan runs and verifies |
| `provider-live` | A real provider request, response, usage and charge under test credentials | Bounded OpenRouter Decisions call |
| `cloudflare-live` | Deployed isolated Workers, DOs, bindings, queues and alarms | Staging Space task/restart test |
| `production-observed` | Representative, consented production usage over a declared period | 30-day cost per verified result |

Passing unit or CI tests does not imply any higher class. A green workflow counts only when the final summary and required suite artifacts agree. Record SHA, workflow/run, test fixture version, model and provider, request counts, skips, and external calls for each result.

For all task-success and safety rates, report the numerator and denominator plus a 95% Wilson interval. For paired comparisons, use the same task, prompt, tools, policy, input data, and time window, randomize run order, and compute paired differences with bootstrap intervals. Report malformed outputs and timeouts as outcomes, not as omitted samples.

**Zero-failure interpretation:** if 300 independent negative cases produce zero false acceptances, the approximate one-sided 95% upper bound is still about 1%; it is not proof of zero risk. To support a bound near 0.1% would require about 3,000 independent zero-failure negative cases, and correlated cases weaken that inference.

## Claim ledger

| Claim we may want to make | Current evidence | Current status | Evidence required before a stronger claim |
|---|---|---|---|
| Space Assistant and Project Assistant are distinct identities using one planner/worker architecture | Local four-Worker Wrangler journeys for both scopes, host evidence/verification, dependent-task gate, scope trace, typechecks | `integrated-local` with synthetic model/Decisions | Repeated randomized task fixtures, auth/UI-to-DO trace, deployed staging parity |
| Workers cannot self-verify their own success | Host artifact evidence and verification path; uncertain result blocks descendants | `integrated-local`/`synthetic-model` | Held-out positive, negative, stale, cross-attempt and adversarial evidence set; provider decision evaluation; live canary |
| Blackboard improves coordination and reduces duplicate work/token use | 100 deterministic task graphs compare direct DAG handoffs with recipient-targeted worker-board messages; payload bytes were identical. Space-wide Decisions triage is now bounded to five cards and reranks its scored prefix, with lexical fallback. No real model/token/cost comparison yet. | Partial; initial cost hypothesis missed | Same task graph with no-board, broadcast-board and policy-filtered board; measure outcomes, messages, planner/decision tokens, duplicate work and latency. Separately measure cross-project relevance/recall and decision cost for the Space-wide board. |
| The intelligent system prewarms/selects the right environment efficiently | Environment policy and admission tests exist; no representative selection accuracy/economics result | Partial | Blind environment-requirement fixtures; compare policy selection and no-prewarm baseline; record correct selection, cold/warm time, idle waste and total verified-task cost |
| Naelao is cheaper | Test logic and reservation/reconciliation coverage; no complete live unit economics | Unproven | End-to-end provider usage plus Cloudflare invoice attribution, storage/egress/runtime costs and successful/failed/review denominators |
| Naelao is faster | Local wake-admission p50/p95 observations only; those stop before provider execution | Narrow local route timings only | End-to-end first response and verified completion p50/p95/p99 under matched hardware/provider/config, with cold/warm and queue breakdowns |
| Naelao is more reliable or safer than named products | Safety invariants are tested in focused suites; no matched multi-product study | Unproven comparative claim | Same benchmark tasks and constraints on accessible systems, independent scoring, repeat runs and uncertainty intervals |
| Naelao supports many industries as production vertical agents | Generic primitives and templates/extensions support packaging; integrations/compliance differ by vertical | Architecture capability, not vertical readiness | Per-template connector, permission, data-rights, evaluation, operational and regulatory acceptance |
| The platform is production-ready | Local CI/Worker emulation and some integrated-local flows pass; live providers/deployment remain outstanding | Not established | All enabled production features pass their live release gates; incident, recovery, cost, monitoring and deletion controls evidenced |

Older competitive documents contain retired product framing (business wallet, per-business identity) and categorical “we beat” language. Treat them as historical research, not approved external copy. Before external use, reconcile them with current generic Space/Template architecture and this ledger. Remove or qualify dashboard/demo figures that are mock data.

## Next experiments — ordered and gated

### Experiment 0 — Freeze claims and the tested subject

1. Fetch both maintained branches; record their exact SHA and require equality before testing.
2. Run the complete Actions inventory on that SHA and inspect final summary plus suite artifacts. Preserve the latest local result separately from Actions evidence.
3. Search outward-facing docs/UI for numeric or comparative claims. Mark each as: `measured`, `architecture description`, `hypothesis`, or `historical/retire`.
4. Remove/qualify unsupported claims before any application, investor, marketplace, or customer-facing use.

**Gate:** one source SHA; all changed suites have known results; no unsupported measured/comparative claim is presented as fact.

### Experiment 1 — Assistant-to-worker correctness and authority matrix

Build on the existing four-Worker local Wrangler harness. Run a generated matrix spanning Space Assistant, Project Assistant, leaf worker, owner/member/viewer, revoked membership, two Spaces, multiple Projects, same-looking resource IDs, extension identity and stale grant. Include valid and adversarial artifact references, branch/attempt/hash mismatch, malformed evidence, prompt injection, and a dependent task attempted before verification.

Start with 30 cases per boundary to find defects; after fixes, run a held-out set of at least 300 negative authorization/evidence cases and 100 valid workflow cases. Preserve per-case expected/actual stage, actor/scope, side-effect counter, evidence digest, verification state and trace IDs. Synthetic models may choose only among generated plans; they cannot fabricate host evidence or bypass the worker path.

**Metrics:** unauthorized side effects, false verified completions, false rejection, correct scope, artifact/attempt binding, dependent early dispatch, trace completeness, per-stage latency.  
**Gate:** zero unauthorized effects and zero false acceptance in the held-out set; all expected valid cases complete; uncertainty remains review-only. If a failure appears, minimize it, fix the host boundary, rerun the failing case, all related suites, and the complete matrix.

### Experiment 2 — Blackboard value and fixer ablation

The first task-level ablation is now implemented as a fixed-seed synthetic control. It is diagnostic, not the full experiment: 100 graphs, 701 tasks, and 595 dependency edges produced 80,518 UTF-8 bytes for both direct DAG handoffs and targeted-board handoffs. Targeted messages themselves totaled 81,173 bytes. A synthetic all-to-all broadcast counterfactual totaled 368,311 bytes, but that broadcast mode is not a production baseline. There were zero payload/status mismatches or cross-recipient leaks. Thus the first cost-reduction hypothesis is **not supported**: the current task board adds coordination state but does not reduce handoff payload versus direct DAG delivery. Continue toward the target by measuring the intelligent Space-wide board and testing whether relevance retrieval, deduplication, and summarization avoid actual worker/planner calls; do not present the counterfactual as a product advantage.

The Space-wide search path now uses its optional Decisions scores to rerank the top five lexically relevant shared cards. Calls remain opt-in and bounded at five; scores are advisory, lexical order breaks ties, unscored results retain lexical order, and provider failure returns lexical results. The Decisions SDK carries provider usage cost alongside tokens and latency, and blackboard search now exposes per-call and aggregate triage telemetry. If cost evidence is missing, reported cost is `null`, never synthesized from token counts. A paired ranking evaluator now computes MRR, Recall@K, nDCG@K, and deterministic-seed bootstrap intervals. Its 28-query synthetic hand-labeled corpus measures the lexical baseline and an explicit label-oracle ceiling; this identifies headroom but is not independent, held-out, or model-quality evidence. No real Decisions relevance/cost result exists yet.

Use at least 100 fixed multi-worker task graphs with three treatments, randomized by task/seed:

1. No shared board (existing direct planner/worker communication only).
2. Unfiltered broadcast board.
3. Current permission-filtered, summarized, policy-driven board.

Include repeated findings, irrelevant messages, conflicting messages, slow workers, failures fixable by deterministic recovery, ambiguous failures, and a revoked recipient. For each graph, use equal models, token caps, tools, workers, wall-clock cap, and budget. Add a no-fixer versus bounded-fixer pair for the subset with repairable failures; fixer output must still pass the independent verifier.

**Metrics:** verified completion rate, total model tokens/$, wall time, duplicate tool/action count, messages delivered/read, irrelevant-message rate, retries, fixer success/rework, escalations, and scope violations. Report paired deltas with confidence intervals and stratify by task type.

**Target:** at least 15% lower total model-token cost per independently verified task, with success no worse than 2 percentage points below the no-board baseline, zero duplicate committed effects, and zero scope violations. If it misses, inspect redundant messages, extra decision calls, blocked work and fixer churn; change summarization/routing/scheduling and rerun the same blinded tasks. A fixer never promotes unverified work.

### Experiment 3 — Decision verification quality, not provider connectivity

Freeze a versioned set of at least 300 evidence decisions, balanced across supported true/false/uncertain criteria and enriched with hard negatives: missing evidence, changed digest, wrong attempt, wrong branch, prompt injection, partial outputs and criteria requiring human judgment. Have two independent reviewers label judgment-based cases and adjudicate disagreements. Keep fixtures held out from prompt or rule changes.

Compare deterministic host rules, the configured OpenRouter Decisions model (current production path), and optional Gemini/GroqCloud test-only models. Provider calls are a separate explicit phase; Gemini/GroqCloud never replace OpenRouter routing. Report validity, strict accuracy, false acceptance/rejection, review rate, calibration, p50/p95, token usage, price-snapshot estimate and actual billed usage where trustworthy. Score every case including malformed output and outage.

**Gate:** host eligibility and evidence rules remain deterministic; model output cannot grant permission or mark unproven evidence as present. For verifier use, require zero false acceptance on the held-out high-risk negatives before enabling the feature, with the confidence bound stated. A small free-tier smoke is connectivity evidence only, not quality evidence.

### Experiment 4 — Environment choice, prewarm and contention economics

Use at least 100 task packets with explicit/nonexplicit tool, browser, GPU, OS, credential-profile, workspace and tunnel requirements. Compare no prediction/no prewarm, deterministic hints, and the intelligent predictor. Replay at concurrency 1/2/4/8 with two workers sharing an identical container, two needing different containers, and dependent command chains. Include cold/warm image, prewarm cancellation, container crash, offline tunnel, profile restore and plan limits.

**Metrics:** environment-choice precision/recall, wrong-target executions, p50/p95 queue and startup time, task completion, prewarm hit/miss, idle-warm seconds/$, resource utilization, bytes moved, contention fairness, quota denials and verified-task cost. Separate safe parallel slots from serial shared-container capacity.

**Safety gate:** zero cross-workspace/profile leakage, zero unsafe parallel writes and no plan-limit overrun. **Performance target:** in the workload declared to benefit from prediction, reduce p95 time-to-verified-result or total cost by at least 15% after charging for idle warm resources. If it misses, analyze false prediction, prewarm timing, queue fairness and task affinity; improve policy and rerun before accepting the subsystem as an optimization.

### Experiment 5 — End-to-end latency, reliability, and cost envelope

Once Experiments 1–4 pass locally, measure Space Assistant, Project Assistant, leaf worker, blackboard wake, host verification, browser/shell and managed-container flows separately. Warm up; run concurrency 1/2/4/8, at least 30 repetitions for descriptive route percentiles and at least 100 verified tasks per category before publishing category-level cost/success estimates. Use synthetic data locally and a bounded staging cohort for provider cost.

Record first response separately from terminal verified result; include queue, model, tool, verification and approval wait. Charge failures, retries, review cases, startup/idle resources, LLM, Cloudflare Workers/DO/D1/R2, egress and support where attributable. Publish p50/p95/p99, confidence intervals, denominator, model/version, date, region, concurrency, and exclusions. Never divide provider cost only by successful tasks while hiding failed-run cost.

**Gate:** budget caps are never exceeded; no runaway loop; measured saturation/limits are visible; all costs reconcile or are labeled estimated. “Cheaper/faster” requires a matched control (at minimum the same Naelao task under a simple baseline); comparisons to named products require a valid accessible competitor run.

### Experiment 6 — Matched competitor and vertical-product comparison

Choose a narrow category and user job first (for example, document intake and evidence-backed review), not “all AI agents.” Select products users can actually access and test. Freeze task inputs, tool permissions, expected outputs, price plans, model availability and test date. Do not compare a Naelao synthetic planner task to a competitor's production workflow or compare features the competitor does not offer.

Use at least 100 blind tasks per system if practical, independent reviewers unaware of system identity, a published rubric, and paired scoring for correctness, grounded evidence, action confirmation, recoverability, latency, human intervention and total cost. If the competitor cannot be run under comparable conditions, publish a feature/architecture table with sources and no performance-superiority statement.

**Target:** achieve a statistically supported advantage on at least one predeclared high-value outcome per chosen workflow, while matching or exceeding quality and safety. If Naelao loses, use reviewer disagreement and per-step traces to find the cause, fix the product, and rerun on the same held-out set plus a fresh holdout. If equivalent access or a fair comparison is impossible, do not invent a result; keep that comparison open while continuing the internal optimization work.

### Experiment 7 — Deployed staging canary

Only after local gates: deploy the exact tested SHA to an isolated Cloudflare environment, apply migrations, test actual service bindings/DO SQLite/D1/R2/alarms/queues, run one no-provider assistant task and one bounded provider-backed task, then restart/interrupt at durable boundaries. Test each enabled channel/runtime separately with synthetic data and strict request/spend caps. Reconcile invoices and receipts; then test cleanup and rollback.

**Gate:** advertise only the integrations that passed deployed acceptance. Missing secrets, carrier registration, plan entitlement or hardware is `BLOCKED_EXTERNAL`, not pass. Do not use production accounts or data for destructive fault injection.

## Required per-run record and stop/fix loop

Every experiment writes JSON and a short human summary with source SHA, workflow ID, evidence class, code/data/model versions, cases (pass/fail/skip/block), denominators, confidence intervals, latency/cost metrics, failures, side-effect counts, artifacts and caveats. Store no secret, prompt body or customer data in public artifacts.

When any assertion or metric gate fails:

1. Keep the failed artifact; do not overwrite it with a rerun.
2. Minimize the failing fixture and identify whether the defect is in policy, implementation, harness or environment.
3. Add a regression test before changing behavior.
4. Fix code/harness as appropriate; rerun the failing suite, directly dependent suites and full relevant experiment.
5. Run the complete CI inventory on the final candidate SHA and inspect each required suite artifact and summary.
6. Update the ledger with the result and any claim downgraded or newly supported.

Never stop merely because one experiment fails: identify the root cause, add a regression, improve the system, rerun the failed test and its dependents, and continue independent experiments. Keep the original failing result for comparison. A genuine external blocker is recorded with the exact missing configuration and its effect on evidence; it does not count as a product pass.

## First run after this plan

1. Confirm `work` and `Mcbt5s-Backup-2` are equal and clean at the candidate commit.
2. Run Experiment 0, then Experiment 1's 30-case defect-discovery tranche.
3. Continue Experiment 1 to the held-out matrix after fixes; do not run quality/cost comparisons on a failing safety boundary.
4. Run Experiment 2's ablation using the same fixed tasks and model/budget configuration.
5. Schedule Experiments 3–5 in dependency order; start model/cost measurements only after capture/reconciliation completeness is checked.
6. Attempt matched external comparisons only where equivalent product access exists; otherwise document the limitation and do not claim superiority.

At the time of writing, the latest dashboard work passed a local production build, trace-grouping tests (2/2), and builder-access/migration tests (10/10). The Actions API returned `Forbidden` when querying the new commit, so its push-triggered workflow result was not inspected. This is not a full baseline pass. The latest testable SHA was `f36ee93bd7289ff0584fab0d8ba065ddbf93faf3`, synchronized to both maintained branches.
