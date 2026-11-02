# Naelao agent OS test checkpoint — 2026-11-02

## Results

| Run | Result | Evidence class |
|---|---:|---|
| Root `tests/vitest.config.ts` | 318 files, 3,141 tests passed | Local unit/integration fixtures |
| Agents Worker full suite | 217 files, 1,113 passed, 2 skipped | Local Worker tests |
| Spaces Worker full suite | 83 files, 362 passed | Local Worker tests |
| Focused blackboard/goal suite | Agents 16 files, 102 passed, 1 skipped; Spaces 3 files, 7 passed | Local component tests |
| Runtime acceptance | 13 passed | Four local Wrangler Workers, real local D1/DO persistence, synthetic model endpoint |
| Shell + Project Bot browser journeys | 6 passed across desktop, 338px, and 740px | Playwright + local Shell and synthetic API fixture |
| TypeScript checks | Agents, Spaces, Shell, Agent SDK all passed | Local static checks |

The default Playwright command first failed because its pinned Playwright browser was absent. Rerunning with the installed system Chromium (`NAELAO_BROWSER_EXECUTABLE=/usr/bin/chromium`) passed all six cases. No browser was downloaded.

## Measurements

- Local blackboard wake/admission: 30 samples, p50 **124 ms**, p95 **145 ms**, zero provider attempts. The test intentionally terminates at the air-gap `compliance_violation` before model/provider execution. These numbers are for this local Wrangler/D1 environment only.
- Wake-claim contention: **1, 2, 8, and 32** simultaneous sweepers each produced exactly one dispatch, one persisted attempt, and zero repeat dispatches for one event.
- Runtime bootstrap: applied 156 SQL migration files in **47.697 s**; started four local Wrangler Workers in **14.546 s** total. Full acceptance command wall time was about **114 s**. This is a single local run, not a deployed latency distribution.
- Goal orchestration benchmark: 9 synthetic graph scenarios repeated 3 times (27 runs, 54 tasks); expected state outcomes matched 27/27; zero false acceptances, dependency dispatch violations, or duplicate dispatches; 3 lost acknowledgements recovered, 3 unknown outcomes held for review. 64 generated DAGs/313 tasks/270 edges had zero dependency, configured concurrency, resource-lock, unverified-completion, and failure-containment violations. In-memory orchestration p50 **1.558 ms**, p95 **4.047 ms**.
- Independent evidence matrix: 400 cases (100 valid artifacts and 300 scope/mutation/path negatives); zero false acceptances, false rejections, scope-mismatch storage reads, or invalid-path host calls. Runtime **52.4 ms**.

Raw machine-readable outputs are in this directory: `space-do-acceptance.local.json`, `goal-architecture-benchmark.json`, and `goal-evidence-matrix.json`.

## What this supports, and what it does not

These runs support local contract claims for role separation (Space Assistant, Project Assistant/Project Bot, and leaf worker), shared planner/worker execution, scoped workspace artifacts, evidence-gated completion and dependencies, blackboard wake idempotency, bounded concurrency, and fail-closed restart handling. The Project Bot and Space Assistant remain distinct principals/scopes while using the same execution architecture.

They do **not** demonstrate real model planning quality, paid provider cost/latency, Cloudflare production behavior, customer-scale capacity, delivery from a live email/phone provider, or production reliability. Model calls in the runtime acceptance use a local deterministic synthetic gateway; several recovery and ranking tests use deterministic in-memory fixtures. The browser backend is synthetic.

## Next validation work

1. Run the opt-in provider planning/evidence evaluation only with approved free-tier budgets, model-specific key rotation and explicit per-run request caps. Do not change the production OpenRouter route.
2. Expand multi-tenant actor/property testing and D1/DO fault injection across lease claim, goal journal, blackboard publish/read/reply, and revocation races.
3. Add repeated/soak latency and queue-depth measurements; this checkpoint uses one startup and 30 local admission samples.
4. Execute isolated deployed Cloudflare acceptance and live provider/email/telephony acceptance only after the relevant bindings, test tenant, domains, and approvals are configured.
