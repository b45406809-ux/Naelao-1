# Naelao Agent OS empirical validation plan

**Status:** next experiment plan; not a claim of completed research  
**Prepared:** 2026-10-31

## Purpose

Measure the claims Naelao makes about scoped assistants, workers, the planner, the intelligent blackboard, evidence-based verification, durable execution, cost, and latency. Tests must distinguish code correctness from model quality and deployed reliability. Results must be reproducible and report failures, not just successful examples.

## Keep the actor model explicit

| Actor | Scope and responsibility | Relationship to the shared runtime |
|---|---|---|
| Space Assistant | Space-wide owner-facing planner; sees only projects and facts allowed by current grants. | Uses the canonical planner/worker path with Space scope. |
| Project Assistant / Project Bot | Internal planner for one project; owns that project’s conversation, journal, workspace context, and routines. | Uses the same planner/worker implementation, with a project scope and project-specific authorization. It is not a leaf worker. |
| Project thread/task agent | Bounded worker or consultation participant assigned to a specific thread/task and capability contract. | Delegated by the planner; it is not the Project Bot identity and does not become a Space Assistant. |
| External extension handler | Separate principal for a customer/public channel or extension event. | May use explicitly granted host operations; cannot enter an internal assistant planner or inherit member authority. |

Every experiment records all four role labels, effective scope, runtime entrypoint, workspace/thread IDs, task/worker IDs, and the authorization decision. Do not infer role from model name or prompt text.

## Claims and measured outcomes

| Claim | Metric |
|---|---|
| Scopes remain isolated | Cross-scope read/write acceptance count; unauthorized action count; expected denial rate. Target: zero unauthorized successes. |
| The planner can delegate useful work | Goal completion with required evidence; valid task graphs; dependency violations; number of planner repairs. |
| Worker success is not mistaken for verification | False acceptance rate; evidence coverage; uncertainty/review rate; false rejection rate. Score decisions against host-generated evidence and blinded human labels. |
| Blackboard coordination reduces redundant work | Duplicate task rate, useful handoff rate, messages per verified outcome, unresolved dependency rate, and coordination latency versus no-blackboard baseline. |
| The intelligent system chooses/warms execution resources usefully | Correct environment-selection rate, wrong warm rate, prewarm hit rate, cold-start savings, idle warm time, queue wait, and avoided context switching. Compare heuristic scheduling to disabled-prewarm baseline. |
| Durable dispatch recovers safely | Duplicate external effect rate, lost task rate, recovery rate after restart, held-uncertain count, and time to resume. Target: zero duplicate committed effects in injected crash/retry cases. |
| Cost and speed claims hold | Provider/model/tool/verification cost per verified outcome; end-to-end p50/p95 latency; cost and latency by role, task class, and plan limit. Include retries and failed runs. |

## Experiment sequence

### A. Contract and actor-boundary matrix (deterministic, no model calls)

Generate positive and negative cases across the four actor types, two Spaces, at least three projects, and task workers with overlapping/non-overlapping grants. Exercise reads, writes, consults, blackboard publish/read/respond, workspace access, extension calls, and thread creation. Include stale membership, changed grants, forged IDs, prompt-injected shared content, and duplicate event IDs.

**Exit:** every expected capability is allowed, every unauthorized path is denied, and denial happens before provider/tool work. Store raw case IDs and decisions; never store user secrets.

### B. BlackBoard → Project Bot path (local service integration)

Run real migrations on local D1/SQLite, create a shared card and event, execute the scheduled wake sweep, create a linked Project Bot session/thread, dispatch the normal planner entrypoint with project scope, and persist the resulting task/worker/evidence events. Repeat with access revoked, busy Bot, malformed event, duplicate request, lease expiry, failed session creation, failed dispatch, and worker restart at each boundary.

**Exit:** one trace ID links event → wake claim → project thread/session → planner → worker(s) → verification → completion; interrupted/uncertain side effects are held, never silently marked complete.

### C. Planner/worker/verification benchmark (synthetic first, then held-out tasks)

Use versioned tasks in software changes, document extraction, web research, and multi-step workflow simulation. Each item needs objective acceptance criteria, hidden tests or blinded labels, expected permissions, and known hazards. Run at least 30 pilot tasks per class before expanding to 100+; publish Wilson intervals for rates and bootstrap intervals for cost/latency. Keep planner-generated plans separate from host-evaluated outcomes.

Compare these arms under equal budgets:

1. single worker without planning;
2. planner + deterministic scheduler + workers, no blackboard;
3. same runtime with blackboard and intelligent triage;
4. same runtime with verification decision model in advisory mode.

Do not make model verification authoritative from a small benchmark. First compare its accept/review/reject choices with host evidence and blinded human labels, by criterion type and confidence bucket. Keep deterministic authorization, evidence collection, and state transitions in the host.

### D. Failure, load, and recovery

Inject provider timeout before/after response receipt, duplicate queue delivery, D1 failure, DO restart, expired lease, race for a shared container, budget exhaustion, long-running task, partial artifact writes, and contradictory evidence. Add concurrency levels 1, 2, 4, 8, then stop at observed resource saturation. Record p50/p95 and error distributions, memory, CPU, invocations, and queue depth. Report saturation instead of extrapolating past tested capacity.

### E. Browser and deployed acceptance

Browser tests cover owner and restricted member workflows on desktop and narrow viewports: sign in, Bots roster, project scope, create/reopen thread, inspect activity, create/pause routine, find approval, and switch Space. Deployed acceptance uses an isolated disposable test tenant and synthetic data; verify current API auth, actual D1/DO bindings, logs/audit, and cleanup. Live provider model tests are a separate opt-in job with independent budgets and no production routing changes.

## Dataset and reproducibility requirements

- Version every task, expected result, permission fixture, tool set, prompt, model ID, price snapshot, evaluator, and harness revision.
- Maintain disjoint development and held-out evaluation sets; do not tune against the held-out set.
- Include adversarial and ambiguous cases, not only successful happy paths.
- Record model/provider request IDs, token usage, tool timing, reservation/settlement, and failure category. Redact prompt and identity data from public artifacts.
- Emit machine-readable JSON and a human summary for each run, including sample size, skipped/blocked tests, retries, cost, confidence intervals, and limitations.
- Pin seeds and dependency versions. Preserve raw synthetic fixtures and aggregate results as CI artifacts.

## Next implementation tickets

1. **Complete locally:** Shell and Project Bot browser journeys use an authenticated synthetic API fixture and pass at desktop, 338px, and 740px. The Wrangler runtime acceptance applies repository D1 migrations, starts separate Spaces, Model Gateway, Artifact, and Agents Workers in separate processes, and joins them through local Wrangler bindings. The real wake sweep and `wakeAgentGoal` reach `SpaceDO` and `NaelaoAgentDO`; tests verify heartbeat thread/session persistence, duplicate/conflicting requests, repeated wake deduplication, D1 authority revocation, viewer denial, busy-assistant retry, expired-lease hold, AgentDO/SpaceDO restart recovery, role/scope traces, evidence gating, and dependent-task blocking (13/13 tests). The air-gapped case returns `compliance_violation` before provider I/O; successful task cases use a local deterministic synthetic model gateway, not a live model. The 2026-11-02 run applied 156 SQL migrations in 47.697s, started four Workers in 14.546s combined, and took 114.210s test-runner time. Across 30 local admission samples, p50 was 124ms and p95 145ms; wake claim with 32 concurrent sweepers still dispatched exactly once. These are one-run local measurements, not benchmark percentiles or deployed acceptance.
2. **Complete locally:** Agents/Spaces Worker processes communicate through the local inter-worker service binding. Deployed binding behavior remains untested; keep this integration no-provider and retain adapter tests for fast fault matrices.
3. **Complete locally:** correlated actor/task activity traces assert that Space Assistant and Project Bot remain distinct root principals/scopes while leaf workers link to each root and run through the shared planner/worker architecture, using the correct Space or project scope. No role is inferred from model or prompt text.
4. **Complete for the current deterministic local matrix; expand before release:** local tests cover authority revocation before dispatch, duplicate request submission, conflicting request-ID reuse, concurrent wake claims at 1/2/8/32 sweepers, repeat sweep deduplication, busy-assistant retry, expired-lease hold, SpaceDO session recovery, and AgentDO restart during a `delivering` intent. Synthetic DAG tests cover lost acknowledgements and unknown effects: known effects recover without replay; unknown effects remain in review and block descendants. A new route-level blackboard matrix denied 64/64 signed cross-scope cases without message writes, and a serialized DO-storage model collapsed 64 identical concurrent retries to one stored message while denying 32/32 conflicting ID reuse requests. Still add generated property-based tenant races, failure injection after independently confirmed external side effects, and deployed multi-isolate restart/queue behavior.
5. **Partial:** deterministic machine-readable artifacts cover a 400-case independent evidence matrix, a 27-run/64-generated-DAG orchestration benchmark, and a 100-graph task-blackboard visibility ablation, preserved under `new plan/validation-results/2026-11-02/`. The ablation found identical direct-dependency and recipient-filtered handoff payloads (80,518 UTF-8 bytes each), zero leaks/mismatches, and 81,173 targeted-message bytes versus 368,311 counterfactual naive-broadcast bytes; this is about 78.0% fewer bytes, not tokens or model spend. A fair no-blackboard versus blackboard/intelligent-triage outcome comparison, broader versioned task set, and verified model-quality/budget comparison remain outstanding. Keep live model calls optional and capped.
6. **Local acceptance complete; deployed acceptance open:** browser journeys passed against the synthetic API at desktop, 338px, and 740px. Add an isolated deployed acceptance environment and cleanup workflow; report deployment acceptance only after a full live run succeeds.

## Release bar

Do not say “secure,” “durable,” “faster,” or “cheaper” without stating the measured population, baseline, test environment, confidence interval, and excluded behavior. A local mock, a synthetic benchmark, and a deployed customer run are different evidence classes and must remain labeled separately.
