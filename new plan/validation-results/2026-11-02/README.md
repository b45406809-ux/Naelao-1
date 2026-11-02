# Naelao agent OS test checkpoint — 2026-11-02

## Results

| Run | Result | Evidence class |
|---|---:|---|
| Root `tests/vitest.config.ts` | 318 files, 3,141 tests passed | Local unit/integration fixtures |
| Agents Worker full suite | 217 files, 1,113 passed, 2 skipped | Local Worker tests |
| Spaces Worker full suite | 83 files, 362 passed | Local Worker tests |
| Combined packages/workers workspace | 476 files, 2,479 passed, 2 skipped | Local package/Worker suites, max 2 workers |
| Focused blackboard/goal suite | Agents 16 files, 102 passed, 1 skipped; Spaces 3 files, 7 passed | Local component tests |
| Runtime acceptance | 13 passed | Four local Wrangler Workers, real local D1/DO persistence, synthetic model endpoint |
| Shell + Project Bot browser journeys | 6 passed across desktop, 338px, and 740px | Playwright + local Shell and synthetic API fixture |
| Conformance and Node-only suites | 2 files/4 tests; 55 Node tests | Local conformance and Node/bridge tests |
| TypeScript checks | Agents, Spaces, Shell, Agent SDK all passed | Local static checks |
| Security lint | 2,792 files checked, no diagnostics | Local Biome security-only lint |

The push-triggered GitHub Actions inventory for commit `923aad5136adb4a9c1fada957d1b1c6f25600cd5` completed successfully: [run 41379283656](https://github.com/b45406809-ux/Naelao-1/actions/runs/41379283656). Its summary job was green; all eight inventory suites were recorded as passed, along with the connected binding-probe, router-dependencies, and agent-authorization jobs. The current results commit (`4cab5e74`) has its own full inventory queued as run 41379679760; that later run is not yet counted as complete here.

The default Playwright command first failed because its pinned Playwright browser was absent. Rerunning with the installed system Chromium (`NAELAO_BROWSER_EXECUTABLE=/usr/bin/chromium`) passed all six cases. No browser was downloaded.

## Measurements

- Local blackboard wake/admission: 30 samples, p50 **124 ms**, p95 **145 ms**, zero provider attempts. The test intentionally terminates at the air-gap `compliance_violation` before model/provider execution. These numbers are for this local Wrangler/D1 environment only.
- Wake-claim contention: **1, 2, 8, and 32** simultaneous sweepers each produced exactly one dispatch, one persisted attempt, and zero repeat dispatches for one event.
- Runtime bootstrap: applied 156 SQL migration files in **47.697 s**; started four local Wrangler Workers in **14.546 s** total. Full acceptance command wall time was about **114 s**. This is a single local run, not a deployed latency distribution.
- Goal orchestration benchmark: 9 synthetic graph scenarios repeated 3 times (27 runs, 54 tasks); expected state outcomes matched 27/27; zero false acceptances, dependency dispatch violations, or duplicate dispatches; 3 lost acknowledgements recovered, 3 unknown outcomes held for review. 64 generated DAGs/313 tasks/270 edges had zero dependency, configured concurrency, resource-lock, unverified-completion, and failure-containment violations. In-memory orchestration p50 **1.558 ms**, p95 **4.047 ms**.
- Independent evidence matrix: 400 cases (100 valid artifacts and 300 scope/mutation/path negatives); zero false acceptances, false rejections, scope-mismatch storage reads, or invalid-path host calls. Runtime **52.4 ms**.
- Blackboard visibility ablation: 100 deterministic graphs / 701 tasks / 595 dependency edges. Direct dependency handoff and recipient-filtered blackboard carried identical dependency payload bytes (**80,518** each), with zero payload or completion mismatches and zero cross-recipient message leaks. A counterfactual all-completion broadcast was **368,311 bytes** versus **81,173 bytes** for targeted messages (about **78.0% fewer bytes**). These are UTF-8 byte counts, not model tokens, inference spend, task quality, or latency savings; the comparison isolates routing visibility, not the intelligent triage benefit.

### Follow-up adversarial and retry experiment

- Added an actual `NaelaoAgentDO` blackboard-route matrix: **64 signed but cross-scoped identities** spanning tenant, Space, project, actor, root goal, parent DO, non-member worker, and another goal hash. Every read/publish request was denied (403), no private payload was returned, and the durable message key was never written.
- Added a transaction-serialized Durable Object storage model for retry stress: **64 concurrent identical publishes** all returned success while producing one stored message; **32 concurrent message-ID conflicts** were all rejected and left the original message unchanged. This validates route/store idempotency under a DO-like serialized transaction contract; it is not a real multi-isolate or Cloudflare contention measurement.
- Re-ran the local four-Worker Wrangler acceptance: **13/13 passed**, including separate Agents/Spaces Workers, real local D1/DO persistence, restart recovery, access revocation, evidence gates, and synthetic model execution. This run applied 156 migration files in **51.335 s**, started all four Workers in **12.013 s**, and completed in **113.987 s**. The 30 local admission samples measured p50 **125 ms** / p95 **149 ms**; zero external provider calls occurred. The air-gap case denied before model execution.
- Related focused suites passed: Agents blackboard/route/integration/delivery set **5 files / 16 tests**, Spaces sharing/wake policy **2 files / 3 tests**. These totals overlap broader suite inventories.

Raw machine-readable outputs are in this directory: `space-do-acceptance.local.json`, `goal-architecture-benchmark.json`, `goal-evidence-matrix.json`, `blackboard-visibility-ablation.json`, and `blackboard-adversarial-retry.json`.

## What this supports, and what it does not

These runs support local contract claims for role separation (Space Assistant, Project Assistant/Project Bot, and leaf worker), shared planner/worker execution, scoped workspace artifacts, evidence-gated completion and dependencies, blackboard wake idempotency, bounded concurrency, and fail-closed restart handling. The Project Bot and Space Assistant remain distinct principals/scopes while using the same execution architecture.

They do **not** demonstrate real model planning quality, paid provider cost/latency, Cloudflare production behavior, customer-scale capacity, delivery from a live email/phone provider, or production reliability. Model calls in the runtime acceptance use a local deterministic synthetic gateway; several recovery and ranking tests use deterministic in-memory fixtures. The browser backend is synthetic.

## Next validation work

1. Run the opt-in provider planning/evidence evaluation only with approved free-tier budgets, model-specific key rotation and explicit per-run request caps. Do not change the production OpenRouter route.
2. Expand beyond the new deterministic scope matrix to generated multi-tenant actor/property tests and D1/DO fault injection across lease claim, goal journal, blackboard publish/read/reply, and revocation races; the route retry model still does not reproduce multi-isolate Cloudflare contention.
3. Compare blackboard/intelligent triage with the direct/no-blackboard baseline on verified outcomes, duplicate work, messages per success, and cost; current ablation measures visibility payload routing only.
4. Add repeated/soak latency and queue-depth measurements; this checkpoint uses one startup and 30 local admission samples.
5. Execute isolated deployed Cloudflare acceptance and live provider/email/telephony acceptance only after the relevant bindings, test tenant, domains, and approvals are configured.
