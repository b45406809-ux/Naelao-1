# Naelao Planner–Worker Swarm: Implementation Specification

Version 2.0 · draft for owner review · 2026-11-27. Based on [`V2.md`](V2.md) v1.0 and reconciled against
`origin/Mcbt5s-Backup-2` at `8b06d5f5`.

This document turns `V2.md` into a buildable specification for Sonnet- and Haiku-class implementers.
`V2.md` stays as the vision. Where they disagree, this spec wins.

**Nothing in this document is implemented yet.**

---

## 0. Conventions

- MUST / SHOULD / MAY follow RFC 2119.
- Requirement IDs look like `SW-<area>-<n>`. Implementation tasks look like `SWT-nn` (§17).
- Money is in **credits** (1 credit = US$0.01, `CREDITS_PER_USD`). V2.md's USD figures are converted.
- Every new behaviour ships behind a flag that defaults to off. With the flag off, behaviour MUST be byte-for-byte unchanged.
- Error codes are snake_case, following the repo's `error_code` style.

---

## 1. What already exists (do not rebuild)

`V2.md` §0 says integration points "need to be mapped". This section maps them. Most of V2's
*standard swarm* already exists.

| V2 concept | Existing code | Status |
|---|---|---|
| Standard swarm (1 planner, N workers) | `script-engine/prebuilt/goal-planner.ts` (`engine.plan_and_delegate_goal`), `script-engine/goal-dag.ts` (`executeGoalDag`) | **Exists** |
| Task contract | `GoalTask` (goal-planner.ts l.19–60): acceptance_criteria, evidence_checks, dependencies, priority, budget_tokens, resource_keys, redundancy_group, planner, expansion_depth | Exists. V2 `PlannedTask` adds `sideEffectClass`, `requiredCapabilities`, `timeoutSeconds`, `maxRetries`. |
| Task states | `GoalTaskStatus`: pending, running, cancelling, cancelled, verifying, completed, failed, blocked, needs_review | Exists (different names; mapping in §9.2) |
| DAG validation | `validateGoalDag`: cycles, communication cycles, redundancy groups, `MAX_GOAL_TASKS = 12` | Exists |
| Scheduling and concurrency | `selectGoalRouting` (single_worker, sequential, parallel), `progressive-v1` adaptive concurrency, host ceiling ≤ 4 | Exists (`GOAL_ADAPTIVE_CONCURRENCY_ENABLED`) |
| Sub-planners | `planner:true` tasks, depth ≤ 2, fanout 4/3 (`delegation-contract.ts`) | Exists. These are **hierarchical**, not competing. |
| Worker model routing | `resolveWorkerModel`, `selectWorkerModel` (System One advisory over a host-filtered pool), `applyWorkerModelTierPolicy` (MS-25) | Exists |
| Model pool | SpaceType `workerModelPool` (`SpaceTypeRegistryDO.ts:122`) | Exists, workers only |
| Config inheritance and snapshots | MS-23/24/25: `resolveWorkerPreferences` (tightest wins), Space/Project/user rows, audit, snapshot on `GoalDagJournal.preferences` | Exists (worker count, model tier, goal ceiling) |
| Budget | Per-worker `budget_tokens`; MS-18 goal credit ceiling (default 200) with `awaiting_budget_approval`; MS-26 resume; MS-39 composed limits | Exists |
| Retry and recovery | Fixers (`MAX_GOAL_FIXERS_PER_RUN = 2`), escalations, attempt fencing, outbox `goal_dispatch_outbox`, resume | Exists |
| Verification | `GOAL_VERIFICATION_REQUIRED`: per-task evidence plus Decisions assessor; `worker-integration-validation.ts`; MS-09 conflict candidates | Exists |
| Worker messaging | Task blackboard (host-granted recipients, PW02 replies) | Exists |
| Dynamic task addition | `goal-expansion.ts` (≤ 3 tasks, depth ≤ 1) | Exists |
| Cancel / stop | MS-07 Project task stop with a receipt | Exists |
| Execution approvals | MS-45 pipeline (payload-hash approval, outcome receipts) | Exists |
| Benchmarks | APW02 protocol, `goal-architecture-benchmark.test.ts` | Exists, single-planner only |
| Competing alternatives | `redundancy_group` (first verified wins); `model-race.ts` (oracle-gated) | Partial: worker-level only |
| **Multiple competing planners, critique, debate, selection, synthesis** | — | **Missing (the real new work)** |
| Planner model selection / planner pool | — | Missing: the planner is the run's own model |
| Per-phase budgets (planning/debate/execution/verification) | — | Missing |
| Live swarm view | Goal Activity is a text list | Missing |

---

## 2. What changed from V2.md and why

| # | V2.md | This spec | Why |
|---|---|---|---|
| 1 | A new "swarm engine" with 15 components | **Extend `goal-planner`/`goal-dag`.** Add a `PlanningStrategy` seam before `executeGoalDag`. The standard swarm *is* today's path. | V2 §36 already says the only difference is how the plan is produced. Rebuilding the scheduler, verification and recovery would duplicate tested code. |
| 2 | 17 new D1 `swarm_*` tables | Candidate plans, critiques and rounds live in **NaelaoAgentDO SQLite**, next to `goal_dag_journals`. No new D1 tables. | Run state is already per-DO, and serialized writes come for free (§10). |
| 3 | `/v1/swarm/runs` API | Runs start through the existing goal-planner op. A swarm config route extends the MS-24 preference routes. Read views extend Goal Activity. | Avoids a parallel run API with its own authorization. |
| 4 | "Most specific wins for preferences; restrictive policies accumulate" | One rule: **every numeric limit and allow-list is tightest-wins** (D10). Only *non-limit* choices are most-specific-wins: architecture, perspectives, selection strategy. | V2's two rules conflict. Is "max planners" a preference or a limit? Making every bound tightest-wins removes the ambiguity. |
| 5 | Budgets in USD, with per day/month | Credits. Per-run = the goal ceiling (MS-18). Per day/month = existing Project spend cap, per-install caps and plan allowance (MS-39). | Those limits already exist and are enforced atomically. |
| 6 | An LLM `weighted_evaluation` picks the plan | Hard gates first (deterministic validator). Then a **deterministic score** over plan structure. An LLM judge MAY break ties only. The judge MUST NOT be one of the competing planners, MUST see anonymized candidates, and MUST NOT see planner identity or model. | An LLM scoring its own or its family's plan is biased. A judge-picked winner with no deterministic signal is unauditable. |
| 7 | Early stop on "no material improvement" (undefined) | Material improvement = the deterministic score rises by ≥ `min_improvement` (default 0.05), **or** blocking findings fall. Anything else stops. | V2 leaves this unmeasurable. It must be computable without another model call. |
| 8 | Synthesis output goes straight to commit | A synthesized plan MUST pass the validator. If debate rounds remain it MUST receive one critique pass, and it MUST NOT score lower than the best original candidate. Otherwise the best original wins. | V2 lets an unreviewed merged plan bypass the debate that justified it. |
| 9 | Adaptive planner count from a "complexity estimate" | Deterministic signals pick the count: deliverable count, dependency count, `side_effect` classes, prior failure rate for the Project. System One may only *lower* it. Capped by config and budget. | An LLM complexity guess can be steered by the prompt to spend more. |
| 10 | Planners are long-lived agents that go "dormant" | Competing planners are **bounded model calls**, not persistent agents. Only the lead planner continues: it is the run's existing planner. | No new agent lifecycle. "Dormant" then costs nothing by construction. |
| 11 | Planners may use read-only discovery tools during independent planning | Release 1: **no tools for competing planners.** They get the same prepared context pack (objective, Project journal excerpt, capability list). Tools come later behind a flag. | Tool use multiplies cost and breaks the isolation and repeatability that make comparison fair. |
| 12 | 100 tasks / 30 workers / 10 parallel | Keep `MAX_GOAL_TASKS = 12` and host concurrency ≤ 4 in Release 1. Raising them is a separate benchmarked change (SWT-11). | Those caps protect existing invariants such as the outbox and expansion. V2's numbers are unmeasured, and V2 says so itself. |
| 13 | "Direct worker-to-worker messaging disabled" | Keep the existing **host-granted task blackboard** (successors plus Decisions-selected peers). | V2 is stricter than shipped behaviour. Removing it would regress PW02. The current design already prevents self-granted access. |
| 14 | Planner-to-planner free messaging during debate | **No messaging.** Debate is turns run by the orchestrator: critiques and responses are structured records, passed only to their target. | A free channel would recreate the self-granted access the blackboard forbids. |
| 15 | Model aliases `glm-flash`, `gpt-luna`, `claude-opus` | Logical aliases resolve through the existing model cards and `ALLOWED_MODELS`. A template declares **requirements and preferences**, never provider IDs. Unknown aliases fail validation. | Matches V2 §5.3 and the existing pool. |
| 16 | 30+ `swarm.*` event types | Project them into the existing Goal Activity feed (§13). There is no separate event bus. | One read surface. |
| 17 | `$3 pilot` | Kept as an **owner-gated** live experiment (needs provider access and budget). The local deterministic benchmark arms come first. | Repo rule: live provider runs need authorization. |

---

## 3. Scope

**In scope:**
- the competitive planning strategy (independent candidates, validation, critique, revision, selection, synthesis);
- a planner model pool and per-planner model assignment;
- swarm configuration and inheritance;
- per-phase budgets;
- swarm events in Goal Activity, and a Shell view;
- benchmark arms.

**Out of scope:** everything in V2 §35, plus:
- competing execution swarms (redundancy and model-race already cover execution alternatives);
- planner tools in Release 1;
- raising task and concurrency caps in Release 1.

---

## 4. Architecture

```
user objective ─► goal start (existing)
                    │ snapshot config (extends MS-25 snapshot)
                    ▼
            PlanningStrategy.select(config)
             ├─ standard:    existing single planner → GoalTask[]
             └─ competitive: CompetitivePlanner (new, §8)
                    │  candidates → validate → critique/revise ×R → select/synthesize → validate
                    ▼
            committed GoalTask[]  ──►  executeGoalDag (existing scheduler, workers, verification, recovery)
                    │                       │ replan trigger (§11)
                    └──────── lead planner ◄┘
```

- **SW-ARCH-1** There is exactly one place that produces the committed plan: `PlanningStrategy`. `executeGoalDag` MUST NOT know which strategy ran, beyond a read-only `planning` summary on the journal.
- **SW-ARCH-2** The orchestrator is deterministic host code. Model output is only ever parsed into contracts and validated. It never directly causes dispatch, spending or grants.
- **SW-ARCH-3** Competitive planning MUST NOT dispatch workers, write workspace state or call side-effecting tools.

---

## 5. Configuration

### 5.1 Schema (`SwarmConfigV1`)

```ts
interface SwarmConfigV1 {
  schemaVersion: 1;
  architecture: "standard" | "competitive";
  adaptiveSizing: boolean;                       // §8.2
  planners: {
    min: number; max: number;                    // competitive: 2 ≤ min ≤ max ≤ 5
    defaultModel: ModelPreference;
    assignments?: { id: string; perspective: PerspectiveId; model?: ModelPreference }[]; // ≤ max
  };
  debate: {
    rounds: { min: 0 | 1; max: 0 | 1 | 2 | 3 };
    critique: "assigned_peers" | "all_to_all";   // default assigned_peers
    peersPerPlanner: 1 | 2;                      // assigned_peers only
    maxFindingsPerCritique: number;              // default 8, max 20
    minImprovement: number;                      // default 0.05 (§8.6)
    selection: "best_candidate" | "weighted" | "synthesis";
    judge?: ModelPreference;                     // tie-break only (§8.5)
    synthesizer?: ModelPreference;
  };
  workers: { maxActive: number; defaultModel?: ModelPreference }; // bounded by MS-23 resolver
  escalation: { allowedTiers: string[]; maxPerRun: number };      // reuses MS-25 tier policy
  budget: {
    runCeilingCredits?: number;                  // ≤ MS-18 goal ceiling (tightest)
    phaseFractions: { planning: number; execution: number; verification: number }; // sum = 1
    onExhaustion: "pause" | "return_partial" | "fail";            // "downgrade" deferred
  };
  observability: { exposeDebateSummary: boolean };
}
interface ModelPreference { alias: string; requirements?: ModelRequirements; credentialSource?: "naelao_managed" | "byok" }
type PerspectiveId = "balanced" | "efficiency" | "quality" | "critical" | "alternative" | `custom:${string}`;
```

**Defaults:**
- architecture `standard`;
- competitive planners min 2, max 3;
- 1 debate round, assigned peers with 1 peer;
- selection `weighted`;
- phase fractions 0.25 / 0.60 / 0.15;
- on exhaustion: `pause`.

### 5.2 Resolution

- **SW-CFG-1** Layers, from weakest to strongest preference: platform default → template → Space → Project → user → per-run override.
- **SW-CFG-2** Limits and allow-lists (`planners.max`, `debate.rounds.max`, `workers.maxActive`, tiers, credits) use **tightest wins** across all layers, including the platform and the plan. Choices (`architecture`, `selection`, perspectives) use **most specific wins**, but only among values the stronger layers permit.
- **SW-CFG-3** An admin MAY forbid `competitive` for a Space or Project. No lower layer can re-enable it.
- **SW-CFG-4** The effective config is snapshotted on the goal journal at start (it extends `GoalDagJournal.preferences`). Running goals never re-read config, except for **restrictions**: a revoked model, a lowered credit ceiling or an admin disable apply at the next phase boundary.
- **SW-CFG-5** A template carries a `SwarmConfigV1` with aliases and requirements only, and is validated at install. It never carries credentials or provider IDs.
- **SW-CFG-6** Validation errors use `invalid_swarm_config` with a field path. Unknown aliases return `model_alias_unknown`.

### 5.3 Storage

Extend the MS-24 SpaceDO tables:
- `worker_preference_limits` gains `swarm_limits_json`.
- A new `swarm_config` table holds Space- and Project-level choice rows.

Changes are audited in `worker_preference_audit`.

---

## 6. Models

- **SW-MOD-1** Add a **planner model pool**, alongside `workerModelPool`, in the SpaceType product config. It is resolved through the same model cards.
- **SW-MOD-2** Alias resolution: alias → candidate model IDs from model cards whose capabilities satisfy `requirements` (structured output is required for planners, tool calling for workers). Then filter by the MS-25 allowed tiers, the credential source (managed versus BYOK) and availability. Then pick the cheapest that meets requirements, unless a pinned model is present.
- **SW-MOD-3** Each planner assignment resolves independently, so mixed models are allowed. A missing model falls back only within allowed tiers and never to a more expensive tier. Otherwise that planner slot is dropped. If fewer than `planners.min` remain, the run falls back to `standard` and records why.
- **SW-MOD-4** Structured output is required: a planner model without a validated JSON-schema path MUST NOT be assigned.
- **SW-MOD-5** Usage per call records model, provider, input, cached and output tokens and credits. Reasoning tokens MUST NOT be double counted.

---

## 7. Contracts

### 7.1 Candidate plan

`CandidatePlanV1` = the existing `GoalTask[]`, plus:

```ts
interface CandidatePlanV1 {
  id: string; runId: string; slot: string /* anonymized "A","B",… */; version: number;
  summary: string;                                   // ≤ 1,200 chars
  assumptions: { id: string; text: string }[];       // ≤ 12
  risks: { id: string; text: string; severity: "low"|"medium"|"high" }[]; // ≤ 12
  acceptanceCoverage: { criterionId: string; taskIds: string[] }[];
  tasks: GoalTask[];                                  // validated by validateGoalDag
  estimatedTokens: number;                            // planner estimate, not trusted
}
```

V2 `PlannedTask` fields that are missing from `GoalTask` are added to `GoalTask`, all optional, so existing plans stay valid:

| Field | Type / rule |
|---|---|
| `side_effect_class` | `read_only` \| `internal_write` \| `external_action` \| `financial_action`. Default `internal_write`. |
| `required_capabilities` | `string[]` |
| `timeout_seconds` | at most the host maximum |
| `max_retries` | at most the run maximum |

- **SW-CON-1** A planner never sets `communication_recipients`, `runtime_*` or model IDs on tasks (existing rule).
- **SW-CON-2** `external_action` and `financial_action` tasks MUST route through the MS-45 execution pipeline, with approval. A plan cannot mark them pre-approved.

### 7.2 Critique and response

```ts
interface PlanCritiqueV1 { id; runId; round; reviewerSlot; targetSlot;
  findings: { id; severity: "info"|"minor"|"major"|"blocking";
    category: "correctness"|"completeness"|"efficiency"|"security"|"dependency"|"verification"|"budget";
    target: { kind: "task"|"assumption"|"criterion"|"plan"; ref: string }; // ref MUST exist in target plan
    explanation: string /* ≤ 600 */; proposedResolution?: string /* ≤ 600 */ }[]; // ≤ maxFindingsPerCritique
  recommendation: "accept" | "revise" | "reject" }
interface CritiqueResponseV1 { findingId; decision: "accepted"|"rejected"|"partially_accepted"; justification /* ≤ 400 */ }
```

- **SW-CON-3** A finding whose `target.ref` does not exist in the target plan is discarded by the host. A critique with no valid findings and no recommendation is dropped. This is how "generic statements are insufficient" gets enforced.
- **SW-CON-4** Every plan version and critique is immutable once stored.

---

## 8. Competitive planning protocol

### 8.1 Phases and budget

The planning budget = `phaseFractions.planning × run ceiling`. It is reserved once at phase start through the existing reservation path. Each model call draws on it, and each call's estimate is checked before the call.

### 8.2 Planner count

If `adaptiveSizing` is on, a deterministic score decides:

```
score = deliverables + dependencyEdgesInObjective/2 + 2·[any external/financial capability requested]
      + 2·[project failure rate over last 20 goals > 30%]
count = score ≤ 2 → 1 (use standard) ; ≤ 5 → 2 ; else 3   (then clamp to [planners.min, planners.max] and budget)
```

System One MAY lower the count by one. It never raises it.

### 8.3 Phase A: independent candidates

- **SW-CMP-1** Each planner gets the same context pack, plus its perspective instruction. Calls run in parallel, bounded by `max parallel model calls` (= host concurrency).
- **SW-CMP-2** No planner sees another's output.
- **SW-CMP-3** Each output is parsed into `CandidatePlanV1`. On a schema failure, the planner gets **one** repair attempt that includes the validator errors. A second failure drops that candidate.

### 8.4 Phase B: validation (deterministic, the hard gate)

| Check | Rule | Failure |
|---|---|---|
| Schema | `CandidatePlanV1` plus `validateGoalDag` | Repair once, then drop |
| Limits | tasks ≤ `MAX_GOAL_TASKS`; sub-planner depth rules | Drop |
| Capabilities | every `required_capabilities` entry is available in the Project | Drop |
| Authority | no task needs an action the objective's `allowedCapabilities` forbid | Drop, recorded as `unauthorized_plan` |
| Coverage | every acceptance criterion is mapped to ≥ 1 task | Score penalty (not a drop) |
| Budget | estimated execution cost (tokens × the resolved worker model's rate) ≤ execution budget | Drop |

- **SW-CMP-4** If zero candidates survive, fall back to the standard planner once. If that fails too, the run fails with `no_valid_plan`.

### 8.5 Deterministic score (0..1)

```
coverage    = mapped criteria / total criteria                      (weight 0.35)
structure   = 1 − (orphan tasks + duplicate titles)/tasks            (0.15)
risk        = min(1, risks with mitigation-task refs / max(1,risks)) (0.15)
efficiency  = 1 − estCost/executionBudget                            (0.20)
verifiable  = tasks with evidence_checks / tasks                     (0.15)
score       = Σ weight·component − 0.1·(unresolved major findings) − 0.3·(unresolved blocking findings)
```

- Templates MAY override the weights (they must sum to 1).
- Hard gates are never weighted.
- **Tie-break:** within 0.02 of the top score, if a `judge` is configured, one judge call is made over anonymized slots and returns a single slot. Otherwise the lower estimated cost wins, then the lower slot letter.

### 8.6 Phases C–E: critique, response and revision rounds

- **Who critiques whom:**
  - `assigned_peers`: a ring, so slot *i* reviews *i+1…i+k* (mod n), with k = `peersPerPlanner`.
  - `all_to_all`: n(n−1) critiques. It is only allowed when n ≤ 3.
- **Each round:**
  1. critique calls run in parallel;
  2. the host filters findings (SW-CON-3);
  3. each target planner gets **only** its own findings and returns responses plus a revised plan (a new version);
  4. the revised plan is re-validated (§8.4);
  5. it is re-scored (§8.5).
- **Stop conditions, checked after each round:**
  - (a) rounds = max;
  - (b) the planning budget would be exceeded by the next round's estimate;
  - (c) the top candidate has no unresolved blocking findings, and the top score rose by < `minImprovement` since the last round;
  - (d) all candidates are dropped, in which case SW-CMP-4 applies.
- **SW-CMP-5** Consensus alone never stops a round early unless (c) holds.

### 8.7 Phase F: selection and synthesis

- `best_candidate` / `weighted`: the top score after the last round wins.
- **`synthesis`:**
  1. One synthesizer call gets the top-2 plans and their unresolved findings.
  2. It must return a `CandidatePlanV1`, which is then validated.
  3. If rounds remain in the budget, one critique pass from the best non-author planner follows.
  4. The synthesis is committed only if its score ≥ the best original. Otherwise the best original wins, recorded as `synthesis_rejected`.
- **SW-CMP-6 Commit:**
  - The committed `GoalTask[]` is written to the journal as `taskDefinitions`.
  - `planning` summary fields: strategy, candidates, rounds, scores, the winner slot, synthesis used, planning credits spent, and the reasons for any drops or fallbacks.
  - Control then passes to `executeGoalDag`.

### 8.8 Lead planner

The run's existing planner (the conversation model) stays the lead for replans and expansion.

---

## 9. Execution (existing engine)

### 9.1 Requirements

- **SW-EXE-1** Workers, scheduling, verification, fixers, expansion, redundancy and recovery are unchanged.
- **SW-EXE-2** The execution budget = `phaseFractions.execution × ceiling` is enforced through the MS-18 goal ceiling, with the remaining verification fraction kept apart. Exhaustion follows `onExhaustion`:
  - `pause` = MS-26 `awaiting_budget_approval`;
  - `return_partial` = finalize with completed tasks marked `partial`;
  - `fail` = stop dispatch and fail.

### 9.2 Task state mapping

| V2 state | Existing state |
|---|---|
| ready / assigned | pending, when ready |
| running | running |
| awaiting_approval | needs_review, or the MS-45 approval state |
| verifying | verifying |
| succeeded | completed |
| retrying | handled by the fixer |
| failed | failed |
| cancelled | cancelled |
| skipped | not added (optional deps are deferred) |

---

## 10. Persistence (NaelaoAgentDO SQLite, schema-migration pattern)

```sql
swarm_candidate_plans(run_id, slot, version, planner_alias, model_id, plan_json, score REAL, status, created_at,
                      PRIMARY KEY(run_id, slot, version))
swarm_critiques(id PRIMARY KEY, run_id, round, reviewer_slot, target_slot, critique_json, valid_findings, created_at)
swarm_rounds(run_id, round, started_at, ended_at, stop_reason, planning_credits, PRIMARY KEY(run_id, round))
swarm_usage(run_id, phase, slot, model_id, input_tokens, cached_tokens, output_tokens, credits, created_at)
```

- Run IDs are goal journal keys.
- Rows are append-only. A status update is the only allowed mutation, from `proposed`/`revised` to `rejected` or `selected`.
- Plans are capped at 64 KB of JSON. A larger plan is a validation failure.

---

## 11. Replanning

- **SW-RPL-1** Standard replanning is the existing path: fixers, escalations and the lead planner.
- **SW-RPL-2** Competitive replanning is allowed only when an escalation reason is `verification_failed` for a task on the critical path, or when fixers are exhausted, and only if `max_replans` (default 1) remains.
  - The council receives the objective, the committed plan, completed task IDs and evidence references, the failure evidence and the remaining budget.
  - It plans **only the remaining tasks**. Completed tasks are frozen.
- **SW-RPL-3** When the allowance is exhausted, `onExhaustion` applies. Loops are impossible because the counters live in the journal.

---

## 12. Security

- **SW-SEC-1** Planner outputs, critiques and synthesis are untrusted. Model output MUST NOT satisfy approvals or grants (MS-45 MR-EXE-2).
- **SW-SEC-2** Competing planners have no tools (Release 1). Their context pack excludes credentials and other tenants' data. It may include Project journal excerpts the user can already read.
- **SW-SEC-3** An `unauthorized_plan` drop is final for that candidate. Another planner's or a judge's approval cannot revive it.
- **SW-SEC-4** Every row and call carries tenant, Space and Project. Cross-tenant reads return the not-found shape.

---

## 13. Events and UI

- **SW-UI-1** Goal Activity gains a `planning` section:
  - strategy and planner count with their models;
  - per-candidate summary and score;
  - for each critique round, the counts of major and blocking findings;
  - the selected slot and the reason;
  - planning credits;
  - any fallback reasons.

  Debate text appears only if `exposeDebateSummary` is on, and only finding summaries are shown, never raw model reasoning.
- **SW-UI-2** Settings: a Space/Project panel (owner/admin) for architecture, planner count, rounds, selection and models. It has a simple view, plus advanced fields.
- **SW-UI-3** Per-run override in the start-goal UI, bounded by SW-CFG-2.
- **SW-UI-4** Runtime controls reuse MS-07 stop and the MS-26 budget raise. Pause/resume as a user action is deferred.

---

## 14. Observability and benchmark

- **SW-OBS-1** Per run, record: credits per phase, model calls, tokens (cached/uncached), rounds, candidates dropped and why, the final outcome, and verification pass/fail.
- **SW-OBS-2** The metric is credits per verified-successful goal, computed from `swarm_usage` plus existing worker usage.
- **SW-BEN-1** Extend `goal-architecture-benchmark.test.ts` with deterministic local arms:
  - A: standard
  - B: 2 candidates, 0 rounds
  - C: 3 candidates, 0 rounds
  - D: 3 candidates, 1 round
  - E: 3 candidates, 1 round, synthesis

  Use scripted planner outputs to test protocol correctness, costs-as-counts and stop rules. **No quality claims.**
- **SW-BEN-2** The live pilot (V2 §31.4) is owner-gated. It needs provider keys, a frozen task set and rubric, and a budget approval. Report sample sizes and uncertainty.

---

## 15. Errors

```
invalid_swarm_config  model_alias_unknown  no_valid_plan  unauthorized_plan  planning_budget_exhausted
synthesis_rejected    swarm_architecture_forbidden       replan_limit_reached
```

---

## 16. Flags (all default off)

| Flag | Gates |
|---|---|
| `SWARM_CONFIG_ENABLED` | Config storage, resolution and snapshot |
| `SWARM_COMPETITIVE_ENABLED` | The competitive strategy |
| `SWARM_DEBATE_ENABLED` | Rounds > 0 |
| `SWARM_SYNTHESIS_ENABLED` | Synthesis selection |
| `SWARM_COMPETITIVE_REPLAN_ENABLED` | §11 council replanning |

---

## 17. Implementation tasks (for Sonnet / Haiku)

Each task lists its model, the files to start from, the work, and the tests that define done.
"Done" also always means:
- focused and full suites pass, with only the known failures;
- typecheck passes;
- the vars parity test passes;
- `git diff --check` passes;
- one commit is pushed, with the master-spec bookkeeping updated.

### SWT-01: `SwarmConfigV1` schema, validator and defaults (Haiku)

- **Where:** `workers/agents/src/shared/swarm-config.ts`, a pure module.
- **Do:** parse and validate §5.1, apply the defaults, enforce `sum(phaseFractions) = 1` within 1e-6, and implement the planner bounds and the all_to_all limit when n ≤ 3. Return field-path errors.
- **Tests:**
  - every bound;
  - defaults;
  - unknown fields rejected;
  - templates carry no provider IDs.

### SWT-02: Resolution (tightest-wins limits, most-specific choices) and snapshot (Sonnet)

- **Where:** extend `shared/worker-preferences.ts`, the MS-24 SpaceDO tables (new migration) and routes, and the MS-25 snapshot. Flag `SWARM_CONFIG_ENABLED`.
- **Tests:**
  - the V2 §5.1 example table;
  - admin forbids competitive;
  - snapshot immutable;
  - restriction applied at a phase boundary;
  - audit row written.

### SWT-03: Planner model pool and alias resolution (Sonnet)

- **Where:** `SpaceTypeRegistryDO` planner pool, `worker-model-routing.ts`, `worker-model-tier-policy.ts`.
- **Tests:**
  - structured output required;
  - fallback is never more expensive;
  - BYOK versus managed;
  - fewer than min planners triggers fallback to standard;
  - unknown alias is refused.

### SWT-04: Contracts, validator and deterministic scorer (Sonnet)

- **Where:** `script-engine/swarm/contracts.ts`, `validate.ts`, `score.ts`. Add the optional `GoalTask` fields to goal-planner.ts.
- **Tests:**
  - each §8.4 gate;
  - §8.5 score vectors;
  - tie-break order;
  - finding refs filtered;
  - existing goal-planner tests unchanged.

### SWT-05: DO persistence tables and usage recording (Haiku)

- **Where:** NaelaoAgentDO schema-migration pattern, `script-engine/swarm/store.ts`.
- **Tests:**
  - append-only;
  - only allowed status moves;
  - 64 KB cap;
  - tenant scoping.

### SWT-06: `PlanningStrategy` seam and the standard strategy wrapper (Sonnet)

- **Where:** goal-planner op. Standard = today's code, unchanged. Record a `planning` summary.
- **Tests:**
  - flag off byte-identical;
  - flag on standard produces the same DAG and adds the summary.

### SWT-07: Competitive Phase A + B (independent candidates, repair, validation, fallback) (Sonnet)

- **Flag:** `SWARM_COMPETITIVE_ENABLED`.
- **Tests:**
  - isolation (no candidate sees another's output);
  - parallel bound;
  - one repair;
  - drop rules;
  - zero valid → standard fallback → `no_valid_plan`;
  - planning budget reserved once;
  - no worker dispatch before commit.

### SWT-08: Debate rounds (Sonnet)

- **Flag:** `SWARM_DEBATE_ENABLED`.
- **Do:** ring and all-to-all assignment, finding filtering, revisions, re-validation, re-scoring, and stop conditions (a)–(d).
- **Tests:**
  - critique counts per topology;
  - each stop reason;
  - budget stop before an over-budget call;
  - immutable versions.

### SWT-09: Selection, judge tie-break and synthesis (Sonnet)

- **Flag:** `SWARM_SYNTHESIS_ENABLED`.
- **Tests:**
  - the judge never sees identities;
  - the judge is only used on ties;
  - synthesis is validated and critiqued;
  - `synthesis_rejected` when it scores lower;
  - commit writes `taskDefinitions` and the summary.

### SWT-10: Adaptive planner count (Haiku)

- **Do:** implement the §8.2 formula; System One may only lower the count.
- **Tests:** score bands, clamps, budget clamp.

### SWT-11: Phase budgets and `onExhaustion` (Sonnet)

- **Do:** split the MS-18 ceiling by fraction; implement `return_partial` and `fail`; reuse MS-26 for `pause`.
- **Tests:**
  - debate exhaustion keeps the best valid candidate;
  - execution exhaustion stops dispatch;
  - concurrent reservations cannot overspend.

### SWT-12: Competitive replanning (Sonnet)

- **Flag:** `SWARM_COMPETITIVE_REPLAN_ENABLED`. Implements §11.
- **Tests:**
  - only the remaining tasks are planned;
  - completed tasks frozen;
  - `replan_limit_reached`;
  - no loop.

### SWT-13: Goal Activity planning section and Shell views (Sonnet)

- **Do:** §13 SW-UI-1..3, with the router allowlist if needed.
- **Tests:**
  - summary shape;
  - no raw reasoning;
  - owner/admin settings;
  - per-run override bounded;
  - Shell tsc not above baseline.

### SWT-14: Benchmark arms A–E (Haiku)

- **Where:** extend `goal-architecture-benchmark.test.ts` with scripted planner outputs. Write results JSON under `new plan/validation-results/`.
- **Tests:** stop rules, credit counts, determinism.

### SWT-15: Template integration (Sonnet)

- **Do:** `SpaceBlueprint.swarmConfig` (SDK validation), resolved at install against the org policy.
- **Tests:** no secrets, restrictive parents win, unknown alias refused.

**Order:** 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 15.

---

## 18. Acceptance (from V2 §34, mapped)

| V2 test | Where proven |
|---|---|
| Standard 1/10 workers | Existing goal-dag tests + SWT-06 |
| 3 independent plans, isolation | SWT-07 |
| Zero / one debate round | SWT-08 |
| Mixed-model planners | SWT-03, SWT-07 |
| Invalid / circular / unauthorized plans | SWT-04, SWT-07 |
| Budget exhaustion during debate / execution | SWT-08, SWT-11 |
| Concurrent reservations | SWT-11 (MS-39 path) |
| Worker timeout, duplicate message, provider outage, verification failure, cancel, recovery | Existing goal-dag / outbox / MS-07 / MS-45 tests (re-run with flags on) |
| Replanning preserves artifacts | SWT-12 |
| Config inheritance, template install, cross-tenant | SWT-02, SWT-15, SWT-05 |
| Max rounds / model calls | SWT-08 |

---

## 19. Owner decisions (with recommendations)

| ID | Decision | Recommendation |
|---|---|---|
| SD-1 | May Free-plan users run competitive swarms? | No. Standard only on Free, because the planning cost multiplies. |
| SD-2 | Default planning fraction | 0.25 (V2), revisit after benchmark arms |
| SD-3 | Which models count as planner-eligible at launch | Those with validated structured output in the model cards; operator-curated planner pool |
| SD-4 | Expose debate summaries to end users by default | Off; owners/admins only |
| SD-5 | Run the live $3 pilot | After SWT-14, with an approved task set and keys |
