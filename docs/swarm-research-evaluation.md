# Swarm research evaluation

`.github/workflows/naelao-swarm-research.yml` is a hosted, report-producing evaluation path. Its deterministic runtime and billing jobs run on the `work` branch when the workflow or selected swarm files change. Dispatch can separately request the CPU-only Laya experiment and the synthetic Gemini/GroqCloud smoke comparison. Neither optional experiment changes production routing.

The deterministic batch exercises the goal DAG, evidence manifests and mutation checks, dependency blocking, dispatch identity and lost acknowledgements, CAS workspace conflicts, delegation admission, provider-harness privacy controls, and D1 decision reservation/quota behavior. The tests use local stubs and synthetic fixtures. This is a focused regression suite, not a measure of deployed worker reliability or real-world task success. The final Actions summary reports required jobs, optional jobs, and blocked/not-run states; JSON and Markdown reports are retained as artifacts.

The suite is informed by SWE-bench (repository coding and held-out verification), AgentBench (multi-environment task interaction), and BrowserGym/WebArena (browser task organization). Repository metadata currently reports MIT for SWE-bench, Apache-2.0 for AgentBench and WebArena, and no SPDX assertion for BrowserGym. No external benchmark code, task examples, or datasets are copied into this evaluation. It uses repository-authored tests and a small synthetic verification set. Browser journeys, connector sandboxes, stress/throughput, independent research citation scoring, and deployed Cloudflare acceptance remain unmeasured here.

## Optional provider smoke

The harness is test-only and has no production router import. It uses the same four synthetic cases and decision rubric for each selected provider, verifies that the configured model is listed for the key, limits inference to at most seven requests per provider (eight total HTTP requests including model discovery), emits at most 64 output tokens per inference, uses one request at a time, and has a 45-second total budget. Its admitted spend limit is zero: it will call only after a repository variable explicitly attests the model/account is approved for free-tier use. It does not retry a rate-limit response or rotate keys to evade shared quota. It only advances to another key after an authentication/access denial; all keys may still share the same project or organization quota.

Optional workflow configuration:

- Secrets: `GEMINI_API_KEYS` or `GEMINI_API_KEY`; `GROQ_API_KEYS` or `GROQ_API_KEY`. Comma-separated keys are parsed in memory, individually masked, and represented in reports only by slot number. Missing secrets block that provider without a request.
- Variables: `GEMINI_FREE_TIER_CONFIRMED=true` after checking the actual Google AI Studio project/model eligibility; `GROQ_FREE_TIER_CONFIRMED=true` and `GROQ_FREE_MODEL_ID` after checking the actual GroqCloud organization/model eligibility. An unset confirmation or model blocks calls. Model-list access does not prove free-tier eligibility; the account owner must confirm it. Do not infer quota independence from the number of keys.
- The fixed Gemini allowlist is `gemini-3.5-flash-lite`; GroqCloud requires one explicitly configured model that its authenticated `/models` endpoint lists. No xAI Grok endpoint is used. A 429 stops that provider's remaining cases and records quota exhaustion. Network/provider errors do not trigger paid fallback or automatic retries.

Provider docs: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) and [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) explain that quotas are project-scoped; [Groq rate limits](https://console.groq.com/docs/rate-limits) describe organization-scoped limits and rate-limit headers. The account settings are authoritative. The workflow can check secret presence without revealing values, but cannot read or validate repository secret contents before dispatch. A completed report is the only evidence that a configured secret was usable.

The provider smoke is a four-case engineering check, not model certification. It records provider/model, anonymized key slot, requests, latency, token usage, outcome, accuracy, false acceptance, and abstentions without writing prompt/response bodies. The current adapter does not implement a provider/model rotation matrix or automatic Gemini-to-Groq fallback: it makes independent, same-case comparisons, and stops a provider on quota exhaustion. This avoids turning the comparison into quota evasion.

## Optional Laya experiment

The run pins the official [Laya source](https://github.com/NandhaKishorM/laya) at `55a19f7b7b56787e1a3e41063def9bb9a8737351` and the Apache-2.0 [English model card/checkpoint](https://huggingface.co/convaiinnovations/laya) at `7b928d828b7b0e022f929d9bd2e44165aa270148`. It verifies the published `model.safetensors` SHA-256 before loading. The Apache-2.0 Laya 0.4.19 wheel is hash-pinned; top-level CPU runtime dependencies are version-pinned in the workflow. `USE_TF=0`, CPU device selection, and omission of remote-code loading constrain the experiment. Runner RAM/disk are checked first; the job has a 35-minute timeout and the inference script has a 15-minute experiment budget.

It compares a fixed host-evidence rule and Laya on eight synthetic Naelao verification fixtures and reports download/load time, peak resident memory, inference CPU time, p50/p95 latency, accuracy, false acceptance, review rate, Brier score and expected calibration error where the model returns confidence. The small sample is exploratory. Laya's published model card itself reports that the base English checkpoint scores below majority baseline on its own typed-decision set; this run must be read on its own results and cannot support a claim of parity with Jev. The model's choice output has no abstention primitive, so review rate is reported and abstention is marked unsupported. OpenRouter is not called: no paid budget was authorized for this experiment. Laya is not used for authorization, billing, concurrency, evidence provenance, or enforcement.

## External benchmark references

- [SWE-bench repository](https://github.com/SWE-bench/SWE-bench), SPDX MIT.
- [AgentBench repository](https://github.com/THUDM/AgentBench), SPDX Apache-2.0.
- [BrowserGym repository](https://github.com/ServiceNow/BrowserGym), repository metadata has no asserted SPDX identifier.
- [WebArena repository](https://github.com/web-arena-x/webarena), SPDX Apache-2.0.

These are methodological references only. The corresponding datasets, benchmark runners, browser environments, and scoring systems have not been integrated. Before importing any such data, review the exact dataset terms and version independently of the code repository's license.
