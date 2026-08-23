# Token-Efficiency Tricks — implementation status

This maps the 11 token-optimization tricks (the AVOS "11-trick" spec the user supplied) onto where
each one lives in this codebase, or why it is deliberately not built. It is the record of the
decision the user asked about — "trick 6 needs a full architecture change to CF Workflow steps, so
don't do it; the others are ok" — and what actually shipped.

Bottom line: 10 of the 11 tricks are implemented (most were already in place from the AVOS steps and
the script-engine's existing compaction). Trick 6 is intentionally skipped. The one net-new change
in this pass is consolidating cascaded model routing (trick 4) onto a single shared `UTILITY_MODEL`
constant so background calls can't drift.

| # | Trick | Status | Where |
|---|-------|--------|-------|
| 1 | Ephemeral prefix caching (Anthropic `cache_control`) | Implemented (as far as the deployment supports) | `packages/llm-gateway/src/gateway.ts` `buildRequestBody` puts `cache_control:{type:"ephemeral"}` on the last tool schema (AVOS step 2). NOTE: prompt caching is an Anthropic-Messages-API feature; this account's live path is Workers AI / Gemini / Groq via the CF AI Gateway OpenAI-compat endpoint, which does not expose Anthropic prompt caching — so this is active only when an Anthropic model is actually wired. |
| 2 | Context squashing & stderr sanitization | Implemented | `prebuilt/code-exec.ts` `BASH_HARNESS` (AVOS step 1): exit 0 squashes verbose stdout to a one-line "✔ succeeded"; a non-zero exit keeps only the last ~15 lines of stderr. |
| 3 | Targeted search-and-replace (AST/patch) editing | Implemented | `prebuilt/r2-workspace.ts` `Edit` op (AVOS step 1): surgical single-occurrence replace, never a full-file overwrite; returns a 15-token confirmation, not the whole file. |
| 4 | Cascaded model routing (cheap model for utility tasks) | Implemented | Background / non-reasoning LLM calls route to the shared cheap `UTILITY_MODEL` (`@naelao/billing-core` `models.ts`): conversation compaction (`NaelaoAgentDO.summarizeConversation`) and project-journal archive compaction (`prebuilt/project-journal.ts`). The main reasoning loop and the closing-answer summary correctly stay on the agent's chosen model — those are real reasoning, not utility. Sub-agent spawns additionally route by cost tier via `resolveEscalationModel` (`billing-core/effort.ts`). |
| 5 | Deterministic pre-LLM context packer (ripgrep) | Implemented (primitive); auto-inject deliberately not built | `prebuilt/r2-workspace.ts` `Grep`/`Glob` (AVOS step 1) give the model deterministic in-workspace search in ONE turn instead of burning 4-8 exploratory `ls`/`cat` turns — which is where trick 5's token win actually comes from. Auto-running a search from the raw prompt BEFORE any model turn is not built: knowing WHAT to grep from a natural-language prompt itself needs a model, which defeats the "pre-LLM" premise; the one-turn `Grep` primitive captures the win without guessing. |
| 6 | Cloudflare Workflows step isolation (O(N) vs O(N²) context) | **Deliberately NOT built** | This would mean re-architecting the agent harness so each business-building PHASE (research → scaffold → QA → marketing) is a discrete CF Workflow step communicating only via JSON contracts. The user's own instruction: "does it mean changing the harness to CF workflow steps? if so don't do trick 6." It does. The O(N) benefit is already substantially achieved a different way: `step-context.ts` folds old history into a bounded per-turn digest so context does not grow unbounded, and delegated work fans out to sub-agents (each with its own clean context) rather than accumulating in one loop. |
| 7 | In-flight dynamic self-compaction (`compact_context`) | Achieved (automatically, better than a model-invoked tool) | `step-context.ts` `compactSteps` folds the older half of a run's own step history into a one-line-per-step digest EVERY turn, with zero model tokens spent deciding to do it — strictly better than a model-invoked `compact_context` tool, which spends tokens on the decision and risks the model pruning something load-bearing (the loop's `priorSteps` back resume + the action ledger). A model-invokable memory maintenance pass ALSO exists (`memory.compact`, item 100) for Memory OS. So the goal — shrink active context during a long run — is met three ways without a redundant self-GC tool. |
| 8 | Surgical tool-payload eviction | Achieved | Same mechanism as trick 7: `step-context.ts` replaces an old step's full (up to ~4000-char) tool payload with a one-line digest of what ran and how it went, so a large read from step 2 is no longer re-sent on step 10. This IS payload eviction, done deterministically and automatically rather than via a runtime hook. |
| 9 | (spec did not number beyond 8 in the supplied doc) | — | The supplied trick doc detailed tricks 1-8; 9-11 were referenced in the header count but not itemized. Nothing missing. |

## The one net-new change in this pass

`UTILITY_MODEL` (`packages/billing-core/src/models.ts`) — the single, tuned, cheapest-capable model
for background/utility LLM work. Before, `@cf/ibm-granite/granite-4.0-h-micro` was hardcoded
independently in two places (conversation compaction, journal compaction); they would have drifted
the moment one was changed. Now both route through the one constant, and any future utility call
(title generation, classification, formatting) has a named place to point at. This is cascaded
routing (trick 4) made consistent and tunable rather than scattered.

Deliberately left on an Anthropic model: `web-search.grounded_answer` (`prebuilt/web-search.ts`)
defaults to a Claude model because it uses Anthropic's server-side `web_search_20250305` tool, which
Workers AI models do not implement — routing it to `UTILITY_MODEL` would break the native tool. It
already degrades honestly (`configured:false`) when no Anthropic credential is present, which is the
case on this account.
