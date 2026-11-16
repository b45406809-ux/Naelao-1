# Knowledge retrieval evaluation data

`knowledge-retrieval-v1.jsonl` contains synthetic English cases only. The cases exercise exact identifiers, current versus stale source versions, a no-answer case and forbidden-scope leakage. They are unreviewed fixtures and are not evidence of search quality or a release gate.

Shona and Ndebele queries and expected answers are intentionally absent until native speakers and appropriate domain reviewers can review them. This dataset must not be used to claim multilingual support. Add only consented or synthetic content, record its review state, and keep raw customer source text out of result traces.

The evaluator accepts content-free result JSONL rows with `caseId`, ordered `retrieved` chunk IDs/source versions/scores, `citedChunkIds`, `abstained`, `latencyMs`, and `costMicrosUsd`. By default it requires reviewed English (`en`), Shona (`sn`) and Ndebele (`nd`) coverage and reports missing languages explicitly. It reports retrieval, citation, forbidden exposure, stale citation, abstention, latency and cost metrics. It always reports `acceptanceEligible: false`; the project still needs a reviewed corpus, explicit quality/safety/cost thresholds, provider/deployed measurements and the rollout acceptance in K27–K30.

Run locally with:

```sh
node infra/scripts/knowledge-retrieval-eval.mjs tests/eval-datasets/knowledge-retrieval-v1.jsonl /path/to/content-free-results.jsonl 10
```
