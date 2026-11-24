# Adaptive goal routing comparison protocol

## Purpose and status

This protocol defines the evidence needed to compare one worker, serialized task execution, and
adaptive parallel execution. It keeps local scheduler checks separate from model quality, actual
provider spend, and deployed runtime acceptance. Thresholds, sample size, spend ceiling, and any
staging/provider execution must be approved and recorded before a live comparison starts.

The repository includes a deterministic scheduler fixture in
`workers/agents/src/script-engine/goal-routing-comparative-benchmark.test.ts`. It is protocol
plumbing evidence only. The earlier [2026-11-02 exploratory evaluation](2026-11-02-live-agent-planning-evaluation.md)
contains small provider experiments, but it is not a paired comparison of routing strategies and
its nominal price estimates are not invoice evidence.

## Arms and controls

Use the same frozen objective, input material, acceptance criteria, tool permissions, workspace
base revision, runtime class, deadline, and per-goal budget in each paired arm:

1. **One worker:** one worker receives the complete objective and produces the complete result.
2. **Sequential:** a fixed, host-validated task graph runs with one active worker at a time.
3. **Adaptive:** the same fixed task graph and host policy as the sequential arm, with the existing
   progressive controller allowed to adjust only within the declared concurrency ceiling.

Use the same worker model/version, prompt version, sampling settings, and worker token limits across
arms where the role is comparable. Record unavoidable differences, including planner, integration,
review, repair, and verification calls. Count all of those calls in total objective spend and quality;
do not omit failed or unfinished attempts. Freeze task decomposition before execution for the
sequential/adaptive pair. The one-worker objective must preserve the same outputs and criteria.

Stratify a held-out task set by small, medium, and large objectives and by code and non-code work.
Randomize arm order within each task block and repeat each paired block. Before any run, record the
task-set hash, assignment seed, sample size and power rationale, model/runtime revisions, timeout
and retry rules, hard spend cap, quality rubric, and analysis plan. Report all assigned runs,
including timeouts, refusals, failed work, unknown outcomes, and incomplete pairs. Do not stop early
after inspecting arm results.

## Measures

| Measure | Required evidence |
| --- | --- |
| Quality and correctness | Route-independent hard acceptance checks plus a held-out task-specific rubric. Use blinded independent reviewers for subjective criteria, record disagreements and adjudication, and report pass rate, score distribution, and unresolved cases per assigned objective. Host fixture checks alone are not model-quality evidence. |
| Latency | Submission-to-checked-publication p50/p95 and per-stage queue, planning, worker, integration, verification, and review times. Include failed and unfinished runs in the accounting and label censored durations. |
| Retry and recovery | Worker attempts, transport retries, recovered lost acknowledgements, duplicate dispatches, unknown effects, and terminal outcomes. Distinguish recovery of an existing result from a new worker attempt. |
| Conflict | Record branch base/result revisions, overlapping paths, text and semantic conflicts, merge/validation failures, resolution attempts, and whether original branches and checked publication receipts were preserved. Report conflicts per assigned objective and per overlapping path. |
| Spend | Record provider/model, dated price source, input/output/cache tokens, provider-returned cost, reconciled invoice or usage statement, internal credits, and unpriced events separately. Include planner, worker, integration, verifier, reviewer, repair, and runtime costs. Report actual USD per assigned objective and per quality-passing objective; label estimates and unknowns. |

The primary quality outcome, acceptable non-inferiority margin, latency objective, spend ceiling, and
retry/conflict guardrails are decision inputs and must be set before results are inspected. Internal
credits are not provider invoices. A token count without a verified price source does not establish
USD spend. Do not use synthetic latency or mock token totals to select a production topology.

## Execution stages and gates

1. **Local fixture:** exercise topology selection, host evidence, concurrency/resource exclusion,
   dispatch idempotency, and bounded lost-ack recovery without provider calls or external writes.
2. **Real-runtime staging:** repeat paired tasks on the intended durable runtime with isolated
   workspaces and checked publication; capture restart, recovery, conflict, and usage receipts.
3. **Provider and cost acceptance:** use an authorized provider configuration and actual usage or
   invoice evidence. Apply the predeclared spend cap and stop conditions. Preserve rate limits and
   do not rotate credentials to bypass them.
4. **Rollout decision:** review the complete paired report against the predeclared thresholds. Any
   rollout change or production deployment requires its own authorization; progressive routing,
   dynamic expansion, and redundant-worker cancellation stay off by default until then.

Do not label a stage complete using evidence from an earlier stage. If a live stage is unavailable,
record its exact prerequisite and leave that acceptance blocked.

## Current local fixture result

At the 2026-11-23 checkpoint, the local fixture ran six fixed synthetic workloads (small, medium,
and large code and non-code), two repeats, and three arms (36 runs total). All 48 expected artifacts
per arm passed host evidence checks; synthetic token totals matched within each paired workload.
Each of the 12 runs per arm recovered one injected lost acknowledgement; there were zero
redispatches, duplicate dispatches, resource overlaps, and incomplete runs. Observed fixture p50 /
p95 wall times in milliseconds were one worker 32.56 / 60.71, sequential 34.29 / 64.10, and adaptive
parallel 26.31 / 46.15. Peak adapter concurrency was 1, 1, and 3 respectively. These timers include
test-runner overhead and are not provider or Cloudflare latency. Provider calls and external writes
were zero; `providerSpendUsd` is unknown. The fixture does not measure customer/model quality,
failed-worker retry policy, durable runtime behavior, external conflicts, or checked publication.

The local boundary stage is also covered by authorized caller fixtures: `batch04-kernel.test.ts`
and `virtual-cli.test.ts` exercise planner shell/raw-domain denials and typed operation dispatch;
`project-journal-decisions.test.ts` covers exact-revision lookup, bounded excerpt output and exhausted
cumulative read budget; `goal-dag.test.ts` proves dependency results arrive only as bounded untrusted
handoffs; and `worker-run-access-revalidation.test.ts` rejects revoked or unavailable Project access.
Together with `goal-routing-comparative-benchmark.test.ts`, `goal-architecture-benchmark.test.ts`
and `goal-evidence-quality.test.ts`, the focused local run passed **123 tests across 8 suites**
with **2 provider/live tests skipped**. Agents typecheck and `git diff --check` pass. This is local
fixture coverage; no provider, Cloudflare runtime, customer data or checked publication was used.

## Blocked acceptance

Real-runtime/provider acceptance resumes when a staging runtime and approved provider/quota are
available, an authorized live run is scheduled, the owner has set the per-goal spend ceiling and
quality/latency thresholds, and invoice/usage evidence can be reconciled. Cost-aware routing remains
blocked until a representative controlled comparison and a spend objective are available; do not
derive a USD objective from unpriced internal credits.
