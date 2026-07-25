# Which LLM should Naelao's agents run on?

Measured against a live production deployment on 2026-07-25, not estimated. Every number below
came from a real `/agent/run` per case through the real reasoning loop, judged by an LLM judge —
the harness is `workers/eval` in `mode: "agent"`, driven by `infra/scripts/run-eval-suite.mjs`.

## The short answer

**`@cf/meta/llama-3.3-70b-instruct-fp8-fast`** — which is already what the Launchpad product is
configured to use. It is the only model tested that reliably produces a decision the agent loop
can act on.

That recommendation comes with a finding that matters more than the ranking: **on this benchmark,
no free Workers AI model is yet good at the tasks a business agent actually has to do.** The
ranking tells you which to use; it does not tell you the agent is ready.

## Why this account has no Claude option

The AI Gateway on this account exposes **zero Anthropic models** (`?search=claude` → 0 results).
Workers AI is not the cheap option here, it is the only option. 13 of the 26 text-generation
models advertise `function_calling: true`; those are the candidates, and their real context
windows (read from the account's own `/ai/models/search`, not from upstream model cards) are now
in `MODEL_CONTEXT_WINDOWS`.

## The metric that separates the models

Raw score is the least useful column. What actually distinguishes these models is whether they
can participate in an agent loop at all:

- **usable decisions** — the model returned a tool call (or parseable JSON) the loop could act on.
  A model that fails here is not a worse agent, it is not an agent.
- **never answered** — it produced tool calls but looped, exhausting its step budget without
  composing an answer.
- **no valid tool call** — it ignored the tool contract and emitted prose that isn't JSON.

The reasoner declares its five actions as real provider tools with `tool_choice: "required"`, so
"no valid tool call" means the model failed a constraint it was explicitly given.

Before attributing these failures to the models, the parser was checked against each provider's
real captured wire payload (including gpt-oss's sibling `reasoning` field, which must not be
mistaken for the answer). It handles them correctly — see
`tests/unit/reasoner-tool-calling.test.ts`. The failures are the models'.

## Results

`tool-use-policy.jsonl`, 6 cases, one real agent run per case. **7 of 9 models complete** —
`glm-4.7-flash` and `gemma-4-26b` were still running when this was written and will be appended.

Ranked by usable decisions first, then score. "usable" means the loop got an actionable
decision; the remaining columns are why it did not.

| Model | avg score | usable | gate | no tool call | looped | s/run |
|---|---|---|---|---|---|---|
| `@cf/ibm-granite/granite-4.0-h-micro` | **3.83** | 5/6 | 1 | 0 | 0 | 70 |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 1.33 | **6/6** | 0 | 0 | 0 | 49 |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 0.33 | 5/6 | 1 | 0 | 0 | 60 |
| `@cf/qwen/qwen3-30b-a3b-fp8` | 2.00 | 4/6 | 2 | 0 | 0 | 137 |
| `@cf/openai/gpt-oss-120b` | 0.00 | 0/6 | 2 | 4 | 0 | 86 |
| `@cf/openai/gpt-oss-20b` | 0.00 | 0/6 | 0 | 6 | 0 | 28 |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 0.00 | 0/6 | 4 | 0 | 2 | 144 |

### Reading this

**`granite-4.0-h-micro` is the best model tested** — highest answer quality by a wide margin, and
it held the tool contract on 5 of 6 cases. It is also small and among the fastest. That is a
genuinely surprising result: it beats every larger model here.

**`llama-3.3-70b` is the most *reliable*** — 6/6 usable decisions, the only perfect contract
adherence — but its answers score poorly. It is the safe choice if predictability matters more
than answer quality, and it is what the product currently runs.

**Both gpt-oss models and `llama-4-scout` are unusable as agent models.** gpt-oss ignores the
tool contract outright despite `tool_choice: "required"`; scout emits tool calls but loops
without ever composing an answer. None of the three produced a single actionable decision.

**Score and reliability are not the same axis, and score alone misleads.** `qwen3-30b` outscores
`llama-3.3` (2.00 vs 1.33) while failing the contract twice as often — it does better on the
cases it reaches and simply doesn't reach some. For an autonomous business agent, "sometimes
isn't an agent at all" is disqualifying, which is why this table sorts on usable decisions first.

### The result that matters more than the ranking

The best score is 3.83/10, and across all seven models **only a handful of cases scored a pass
(≥7)**. On this benchmark the agent is not yet good at the work a business agent has to do —
checking before acting, refusing cleanly, grounding claims in a real lookup.

Since this account cannot reach any Anthropic model, that gap is not closable by swapping models.
It is loop, prompt, and skill-library work.

## How to reproduce

```
source .cf-credentials.local
export NAELAO_API_BASE="https://naelao-router.crzzphillip.workers.dev/v1"
export NAELAO_TENANT_TOKEN=<a builder JWT for the eval org>

node infra/scripts/run-eval-suite.mjs \
  --dataset tests/eval-datasets/tool-use-policy.jsonl \
  --name "matrix-tool-use" \
  --space-id <eval space> \
  --session-id <eval session> \
  --models "@cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/qwen/qwen3-30b-a3b-fp8"
```

Runs are persisted to `eval_runs` + `eval_results` (per case), so a later run can be diffed
against an earlier one. Without `--models` the script runs a single model and acts as a
regression gate against that suite's own previous result.

## Caveats — read these before acting on the numbers

1. **The web-search case cannot be grounded by any model.** `TAVILY_API_KEY` is not set on the
   knowledge worker, so `web-search.search` degrades honestly to `configured: false`. This
   depresses every model equally, so the *ranking* holds, but absolute scores understate.
2. **Approval-gate failures are slightly overstated, equally for all models.** A cold-start
   retry for the assistant-policy fetch was committed but deliberately not deployed mid-run, so
   that all nine models faced identical conditions.
3. **One dataset.** `tool-use-policy.jsonl` is deliberately hard: verify-before-acting, refusal,
   real tool grounding, no self-escalation, real scheduling. It is not a general capability
   benchmark and a model that scores badly here may be fine for chat.
4. **Two earlier matrix runs were discarded, not reported.** The first hit a quota wall (models
   "failing" in 2s were 402s); the second ran against pre-fix code where an approval-gate bug
   dominated. Both would have produced a plausible-looking ranking that measured infrastructure
   rather than models.

## What this run cost to make possible

The eval had never actually been runnable end to end. Six real bugs were found and fixed by
running it, the largest being that the reasoning loop returned the moment any tool call
succeeded — so the model never observed its own tool output, multi-step work was structurally
impossible, and users got blank replies. See the git history for 2026-07-25 and CLAUDE.md.
