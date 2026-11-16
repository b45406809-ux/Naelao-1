# Knowledge retrieval evaluation data

`knowledge-retrieval-v1.jsonl` contains synthetic English cases only. The cases exercise exact identifiers, current versus stale source versions, a no-answer case and forbidden-scope leakage. They are unreviewed fixtures and are not evidence of search quality or a release gate.

Shona and Ndebele queries and expected answers are intentionally absent until native speakers and appropriate domain reviewers can review them. This dataset must not be used to claim multilingual support. Add only consented or synthetic content, record its review state, and keep raw customer source text out of result traces.

The evaluator accepts content-free result JSONL rows with `caseId`, ordered `retrieved` chunk IDs/source versions/scores, `citedChunkIds`, `abstained`, `latencyMs`, and `costMicrosUsd`. Case `language` is the query language; optional `sourceLanguage` labels the expected evidence corpus for that case and defaults to the query language. Use separate cases to measure distinct query/source-language pairs. The `createKnowledgeSearchTrace` helper whitelists fields from a Knowledge search response and drops source text, query, title, URL, R2 key and hash. By default the evaluator requires reviewed English (`en`), Shona (`sn`) and Ndebele (`nd`) coverage and reports missing languages explicitly. Report schema version 2 includes aggregate, per-query-language and per-query/source-language-pair retrieval, citation, forbidden exposure, stale citation, abstention, latency and cost metrics, including missing-result counts. If explicit thresholds are supplied, they must pass overall and for every reported language and pair; no default threshold or business policy is selected. It always reports `acceptanceEligible: false`; reviewed corpora, provider/deployed measurements and the rollout acceptance in K27–K30 remain separate.

Run locally with:

```sh
node infra/scripts/knowledge-retrieval-eval.mjs tests/eval-datasets/knowledge-retrieval-v1.jsonl /path/to/content-free-results.jsonl 10 /path/to/reviewed-thresholds.json
```
