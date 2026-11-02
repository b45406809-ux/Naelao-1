# Live planner and verifier evaluation — 2026-11-02

## Scope

This exploratory evaluation checks whether test-only Gemini and GroqCloud models can produce task graphs that Naelao accepts and executes through its goal DAG and host evidence verifier. It also records the separate verifier-decision and blackboard-ranking results from the same day.

Gemini and GroqCloud are test adapters only. Production Decisions routing remains on OpenRouter. The benchmarks use synthetic prompts and fixtures; no production actions, customer data, or external writes were used.

## Live planning through the goal runtime

The independent planning-only profile ran four authored objectives per provider (expense arithmetic, release evidence, CSV counting, and prompt-injection handling). Each model generated plans that passed JSON parsing, DAG validation, and a simulated execution with host evidence checks.

| Provider / model | Requests | Valid plans | Valid DAGs | Host-verified fixtures | Rubric criteria | Plan latency p50 / p95 | Fixture execution p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Gemini `gemini-3.5-flash-lite` | 4 | 4/4 | 4/4 | 4/4 | 8/8 | 952 / 1,278 ms | 0.7 / 1.3 ms |
| GroqCloud `openai/gpt-oss-20b` | 4 | 4/4 | 4/4 | 4/4 | 8/8 | 440 / 728 ms | 0.6 / 0.8 ms |

The rubric checked two authored concepts per objective: calculate plus independently check; distinguish confirmed from unsupported evidence; count CSV items plus separately validate; extract document content while treating injected instructions as untrusted. Every sample covered both concepts.

These are small samples. The semantic rubric is lexical and hand-authored, so 8/8 is evidence of coverage of those phrases/concepts, not proof of factual correctness or general planning quality. Fixture execution, workspace writes, and persistence were simulated in memory; the measured sub-millisecond execution times are not production runtime latency.

Run: [41453940313](https://github.com/b45406809-ux/Naelao-1/actions/runs/41453940313), commit `8f8fd7d0b3094d2301e6606dbd234ce9b95f7aab`.

## Verifier decision comparison

Each model classified eight evidence cases: three supported passes and five cases that should remain in review. Both returned valid decisions for all cases, matched all eight expected labels, and made zero false acceptances.

| Provider / model | Cases | Valid responses | Expected labels matched | False acceptances | Latency p50 / p95 | Nominal paid-rate estimate per 1,000 cases |
|---|---:|---:|---:|---:|---:|---:|
| Gemini `gemini-3.5-flash-lite` | 8 | 8/8 | 8/8 | 0 | 710 / 1,216 ms | $0.060737 |
| GroqCloud `openai/gpt-oss-20b` | 8 | 8/8 | 8/8 | 0 | 330 / 793 ms | $0.033188 |

Paid-rate estimates use the workflow’s 2026-10-31 price snapshot and token counts; the test used provider free-tier credentials and did not retrieve billing receipts. Treat them as estimates, not actual spend or current pricing.

Run: [41444914127](https://github.com/b45406809-ux/Naelao-1/actions/runs/41444914127), source commit `5c46949e4e7b8cc2b1aafaa557c69f27bd124bdb`.

## Blackboard ranking comparison

The live model scores were evaluated on a synthetic, hand-labeled corpus and fed through the same test blackboard reranking operation. Both provider runs stopped on HTTP 429 before finishing the query set, so these figures are partial.

| Provider / model | Completed holdout queries | Bounded-search MRR, baseline → model | Recall@5, baseline → model | nDCG@5, baseline → model | Request latency p50 / p95 |
|---|---:|---:|---:|---:|---:|
| Gemini `gemini-3.5-flash-lite` | 12/16 | 0.334 → 0.528 | 0.500 → 0.500 | 0.355 → 0.500 | 2,281 / 3,334 ms |
| GroqCloud `openai/gpt-oss-20b` | 8/16 | 0.310 → 0.518 | 0.500 → 0.500 | 0.345 → 0.500 | 948 / 1,104 ms |

MRR and nDCG improved on the completed slice, while Recall@5 did not. Results are not complete, independently labeled, or representative of user traffic. The test did not obtain provider billing receipts. The 429 response stopped further calls; key rotation was not used to bypass provider rate limits.

## Deterministic runtime check

The same Actions runs also exercised `validateGoalDag`, `executeGoalDag`, evidence collection, dependency blocking, dispatch recovery, and concurrency using deterministic in-memory adapters:

- 27/27 scenario runs matched expected states.
- 0 unverified false acceptances, dependency dispatch violations, or duplicate dispatches.
- Three lost acknowledgements recovered without replay; three unknown effects were held for review.
- Generated graph stress: 64 graphs, 313 tasks, 270 dependency edges; zero dependency, concurrency, resource-lock, unverified-completion, or failure-containment violations.

These verify control flow and invariants with test adapters; they do not establish deployed Cloudflare reliability, external queue delivery, or persistent-storage behavior.

## What this supports—and does not

The runs support the narrower claim that these two configured test models produced schema-valid plans and expected verifier decisions on small, repository-authored synthetic sets, and that the host DAG/evidence path enforced its tested safety outcomes. They do not establish broad model quality, production readiness, durable Cloudflare acceptance, actual provider billing, or an advantage over other systems.

## Expanded held-out run

Run [41462508250](https://github.com/b45406809-ux/Naelao-1/actions/runs/41462508250), commit `a7acb9b48eb40fd8bf28294fa0a5aac311b8734e`, tested the four prior planning objectives plus eight newly authored holdouts. Each held-out objective had two criteria written independently of the model output.

| Provider / model | All objectives: valid plan / DAG / host fixture | Heldout: valid plan / DAG / host fixture | Heldout rubric | Heldout latency p50 / p95 |
|---|---:|---:|---:|---:|
| Gemini `gemini-3.5-flash-lite` | 11/12 / 11/12 / 11/12 | 8/8 / 8/8 / 8/8 | 16/16 | 1,193 / 4,164 ms |
| GroqCloud `openai/gpt-oss-20b` | 12/12 / 12/12 / 12/12 | 8/8 / 8/8 / 8/8 | 16/16 | 1,004 / 2,193 ms |

Gemini timed out on one of the four baseline objectives; all eight newly authored holdouts completed. GroqCloud completed all 12. The returned semantic coverage is still only lexical rubric coverage, not factual task quality. The goal runtime used simulated worker outputs and in-memory workspace/persistence for fixture execution.

### OpenRouter Decisions comparison status

The held-out workflow attempted to read the standard GitHub Actions secret `OPENROUTER_API_KEY`, but the secret was absent in Actions. It made **zero OpenRouter requests** and recorded `openrouter_api_key_missing`. Therefore, the configured OpenRouter Decisions route has not yet been live-compared in this experiment. The workflow is prepared to make at most eight sequential requests, with retries disabled and the selected model fixed to `cloudflare/clef-flash`; it records actual returned cost metadata only, and labels missing cost as unknown. The secret needs to be available to Actions before that comparison can run.

The provider-evaluation workflow concluded success because it produced valid reports and the planner evaluations passed their host-path checks; that green workflow conclusion does not mean the OpenRouter comparison ran.

## Repeated held-out planning and stability

Two explicitly tagged runs repeated each of the eight held-out objectives twice per test model (16 requests per model per run): [first run 41466816121](https://github.com/b45406809-ux/Naelao-1/actions/runs/41466816121) and [topology-aware run 41467242085](https://github.com/b45406809-ux/Naelao-1/actions/runs/41467242085). The second run added separate exact-plan, coarse-topology, and lexical-rubric-outcome fingerprints.

| Provider / model | First run: valid plan / DAG / host fixture | Second run: valid plan / DAG / host fixture | Second run: complete repeat pairs | Exact text stable | Coarse topology stable | Rubric outcome stable | Second run latency p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Gemini `gemini-3.5-flash-lite` | 16/16 / 16/16 / 16/16 | 13/16 / 13/16 / 13/16 | 6/8 | 0/6 | 5/6 (83.3%) | 6/6 (100%) | 5,596 / 9,784 ms |
| GroqCloud `openai/gpt-oss-20b` | 16/16 / 16/16 / 16/16 | 16/16 / 15/16 / 15/16 | 7/8 | 0/7 | 5/7 (71.4%) | 7/7 (100%) | 667 / 2,251 ms |

Gemini had three request timeouts in the second run; GroqCloud returned one graph rejected by the host DAG validator. Among completed repeat pairs, neither model reproduced an identical full task graph. Most did reproduce the coarse task-count/dependency-count shape and all reproduced the same two rubric outcomes. The topology measure is intentionally coarse; it does not show that task meanings or execution quality were equivalent. Incomplete pairs are excluded from the stability denominators, so rates are not reported as full-dataset estimates.

The largest observed mismatch is latency variance: Gemini's second-run p95 reached 9.8 seconds, close to the 12-second request timeout, compared with 2.25 seconds for GroqCloud. This is an exploratory sample of 8 objectives and 2 repetitions, not a reliability distribution. It suggests the next useful experiment is a larger fixed prompt set with randomized provider order, per-case semantic adjudication, and measured timeout/retry behavior. No retries or alternate-key rotation were used here.

Although both tagged Actions workflows concluded success, the second provider report was `partial` for each model: Gemini had timed-out calls and GroqCloud had an invalid DAG. The successful workflow conclusion means the experiment ran and published its results; it does not mean the model evaluation was complete or that the models passed every case.

## Revised next experiment

The eight newly authored planning holdouts are complete. Next, run a blinded, independently adjudicated task-quality evaluation with real worker outputs and persistent storage, then repeat the OpenRouter Decisions comparison when `OPENROUTER_API_KEY` is available to Actions. Do not treat mocked fixture success or lexical rubric coverage as proof of end-to-end task correctness.
