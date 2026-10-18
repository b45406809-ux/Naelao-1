# ScaleDown and DeepSeek integration: research, decisions and delivery plan

Research date: 2026-10-18. User direction: use specialist summarization, extraction and compression broadly; keep Clef Flash/Omni for classification; add `deepseek/deepseek-v4.1-flash-1017` for selectable planners and host-selected LLM workers. FDEs specify worker effort rather than an arbitrary expensive model. The existing planner/worker topology remains the execution architecture.

## Verified findings

| Operation | Verified interface | Meaning and important limits |
| --- | --- | --- |
| Summarize | OpenRouter `scaledown/summarize`, or native chat completions | Abstractive digest; separate system instructions and source text. OpenRouter advertises 1,000,000 context tokens and a 4,000-token completion limit. It is not a tool-calling planner. |
| Extract | OpenRouter `scaledown/extract` | Field descriptions belong in `provider.options.scaledown.entities`. Response text contains JSON entities with source spans and confidence. It does not use OpenRouter `response_format` or tool calling. |
| Compress | Native `https://api.scaledown.xyz/compress/raw/`, `x-api-key` | Request separates `context`, `prompt`, and `scaledown.rate`; compressed context is under `results.compressed_prompt`. It is a separate endpoint, not an assumed OpenRouter model. |
| Classify-1 | Separate decision model | Investigated to understand the suite; excluded from this integration at the user's request. Existing Clef classification remains authoritative. |
| DeepSeek V4.1 Flash 1017 | OpenRouter `deepseek/deepseek-v4.1-flash-1017` | Published October 17 snapshot, 1M context, coding/agent focus and native image understanding. Key entitlement, supported request features and active rates still need live catalog checks. |

Sources: [Summarize model](https://openrouter.ai/scaledown/summarize), [Extract model](https://openrouter.ai/scaledown/extract), [native compression quickstart](https://docs.scaledown.ai/quickstart), [compression response](https://docs.scaledown.ai/response), [DeepSeek model](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017), [DeepSeek release](https://api-docs.deepseek.com/news/news261017/).

The advertised 1M context on Summarize/Extract does not establish the native Compress endpoint's maximum payload, nor Naelao's safe per-request memory and cost envelope. This implementation starts with bounded text and rejects oversized requests rather than silently truncating documents. Long PDFs need durable partitioning, page/source tracking and existing attachment authorization before direct multimodal transport is enabled.

ScaleDown's vendor describes compression as preserving intent. That is not proof of mathematical losslessness or guaranteed hallucination prevention. Summaries can omit an exception; extraction can misidentify a value; compression can remove a decisive qualifier. Original files, exact citations, active instructions, approvals, grants and action receipts stay authoritative. An Extract confidence score measures its match, not verified truth. [Extraction contract](https://docs.scaledown.ai/api-reference/extract-overview), [OpenRouter invoice example](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/extract-invoice-fields-with-scaledown).

## What developers demonstrably use

Evidence is separated from marketing and inferred opportunities:

1. **Agent history compaction:** OpenRouter publishes a TypeScript recipe that serializes old tool messages, summarizes bounded segments, retains recent complete turns and preserves history on failure. This directly supports our manual/automatic compaction use case. Its example includes measured cost for its own sample, not a Naelao result. [Recipe](https://openrouter.ai/docs/cookbook/building-agents/compact-agent-sessions-with-scaledown).
2. **Structured document ingestion:** OpenRouter's extraction recipe describes invoice fields, validates returned spans and then checks arithmetic/business rules before downstream actions. This is useful evidence for an extraction-plus-validation extension design, not permission for Naelao to automate payments. [Recipe](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/extract-invoice-fields-with-scaledown).
3. **Gateway integration:** LiteLLM implements task-specific ScaleDown adapters, including native compression, and documents missing output-token usage, unsupported sampling/strict-schema features, response normalization and text-only restrictions in its integration. Those details show why forwarding generic planner payloads is wrong. [LiteLLM adapter documentation](https://litellm.vercel.app/docs/providers/scaledown).
4. **Code-context selection:** ScaleDown's public Python SDK chains AST/BM25 selection, semantic retrieval and compression. This suggests a Naelao coding-worker pipeline: retrieve the relevant functions first, then reduce explanatory context; retain exact code for editing and execution. [SDK source and examples](https://github.com/scaledown-team/scaledown). No vendor implementation was copied or added as a dependency.
5. **Migration and prompt evaluation:** ScaleDown's public SLM Agent scans existing LLM calls, classifies migration opportunities and evaluates specialist prompts against reference outputs. It is a vendor-authored developer tool, not independent proof of universal savings. [SLM Agent](https://github.com/scaledown-team/SLM_Agent).
6. **Compression evaluation:** ScaleBench compares full-context and processed-context runs using answer, retrieval, extraction and summary metrics alongside end-to-end latency and total cost. This supports evaluating the whole pipeline instead of celebrating token reduction alone. [ScaleBench](https://github.com/scaledown-team/scalebench).

OpenRouter's model activity pages name law, email-digest, trading and agent applications. That establishes reported API traffic only; it does not reveal their pipelines or prove accuracy/savings. Two linked public application repositories could not be fetched (404), so their implementation details are not treated as verified. I found useful primary examples and actual adapter implementations; I did not establish that native Compress is the dominant RAG choice across developers.

## Economics: when it saves and when it does not

Published snapshots on the research date: Summarize/Extract show a promotional **$0.04/M input, $0 output**, alongside a regular **$0.05/M input** price; DeepSeek shows **$0.05/M input, $0.60/M output**. Prices, promotion and provider availability may change. Live catalog evidence is used for admission/settlement. Native compression's commercial rate must be confirmed for the actual configured account; LiteLLM's registered text price is not an account-specific contract.

Use this decision equation, separately tracking cached downstream input:

`net savings = reuse count × tokens removed × downstream input price − preprocessing cost − extra storage/transport/validation cost`

Example using 100k input tokens, a $0.04/M preprocessing rate and a measured 60% reduction:

| Downstream situation | Input saving | Processing cost | Net before other overhead |
| --- | ---: | ---: | ---: |
| One uncached DeepSeek request at $0.05/M input | $0.003 | $0.004 | **−$0.001** |
| Same prepared context reused five times | $0.015 | $0.004 | **+$0.011** |
| One request at an illustrative $3/M input | $0.18 | $0.004 | **+$0.176** |

These are arithmetic scenarios, not measured Naelao savings. Replacing an entire expensive extraction/summary call can save more than putting an extra compression call in front of an already cheap model. Avoid unconditional preprocessing of short documents, cache hits, direct file forwarding, exact quotations, exact code edits and simple deterministic parsing. A lower invoice to Naelao also does not automatically reduce a customer's bill: whole-credit minimums and markup need separate product review so cheaper models produce visible customer value.

## Opportunity inventory across the OS

The following are proposed Naelao uses inferred from its architecture, not claims that every use is already implemented:

| Surface | Specialist use | Preserve or validate |
| --- | --- | --- |
| Automatic conversation compaction | Summarize newly aged turns, then merge with prior summary | Recent complete turns, original searchable transcript, later corrections, pending work |
| Explicit `memory.compact` | Same summarized transcript path plus existing memory maintenance | Correct Space/project/thread identity and separate billing |
| Shell Compact button | Same host service after membership/session lookup | Authenticated actor, project identity and private-session policy |
| Project journal archives | Summarize old activity entries | Goal, rules, todos and active decisions remain structured truth |
| Worker handoff | Extract identifiers/outcomes; summarize research evidence | Exact action receipts, workspace paths and unresolved failures |
| Large tool outputs | Query-aware reduction of logs and API bodies | Original output handle, tool errors and side-effect status |
| Search/research | Summarize fetched pages; extract dated facts/entities | Source URLs, publication dates, contradictory claims |
| RAG after retrieval | Compress or summarize only authorized, reranked chunks | Original chunk IDs/citations and exact-source re-open |
| RAG indexing | Derived synopsis/metadata index alongside original chunks | Original embeddings/source remain; measure retrieval recall before changing defaults |
| Multi-hop RAG | Extract entities/dates to form follow-up retrieval queries | Host-filtered query scope and no source-invented authority |
| PDF/text ingestion | Partition parsed text; extract fields and section summaries | Raw file hash, page/byte coordinates and OCR quality |
| Scanned forms | Provider OCR + Extract after explicit file grant | Per-page OCR text, confidence, locale and arithmetic consistency |
| Spreadsheets/CSV | Extract narrative notes or column explanations | Parse numeric rows deterministically; do not summarize away rows |
| Inbox/email | Digests, case facts, commitments and next-action proposals | Sender identity and permissions come from host; dates/amounts checked |
| Meeting transcripts | Decisions, named actions, deadlines and topic digests | Speaker/time references and corrections; never substitute for transcription |
| Support/education extensions | Prepare published knowledge and bounded FAQs | Exact publication grants, external principal, subject budgets and escalation |
| Legal/research extensions | Parties, dates, clauses and review briefs | Exact source spans, clause exceptions, jurisdiction and human review |
| Finance/procurement extensions | Invoice fields, statement metadata and reconciliation candidates | Currency, decimal precision, totals, duplicates and approvals |
| Commerce/catalog extensions | Product fields and concise searchable descriptions | SKU, price, stock and contractual claims from authoritative sources |
| Healthcare/admin extensions | Administrative form fields and document triage | Consent/residency and domain validation; no implied clinical correctness |
| Engineering/incident extensions | Log digests, error entities and incident timelines | Raw logs, request IDs, ordering and unresolved root-cause uncertainty |
| Personal/consumer templates | Reading digests, receipts and personal action lists | Privacy, timezone, original documents and user-controlled automation |
| Steward portfolio review | Compact authorized activity evidence for advisory ranking | Structured health/spend/routine facts and owner confirmation |
| Workflow branching | Extract structured inputs for deterministic validation nodes | No extracted field grants capabilities or selects credentials |
| Canvas/Gadget imports | Preview entities, source highlights and correction UI | Explicit validated writes, row provenance and undo |
| Foundry economics | Compare specialist pipelines against current general models | Total price, cache behavior, quality, latency and retry rate |

Build generic kernel operations and template recipes; these domains do not become new native project kinds. Clef can decide *whether* a specialist operation is appropriate, while its result remains advisory and server policy controls invocation. Do not add Classify-1.

## Architecture and rollout phases

### A. Research and policy contract

- Preserve original documents/transcripts and exact source coordinates.
- Keep general planner/worker model routing separate from specialist task selection.
- Capture model/provider, input tokens, unknown output usage explicitly, actual price evidence, payer, latency, derived-artifact identity and validation results.
- Native Compress is separately configured; never send an OpenRouter key to its native API or invent an OpenRouter Compress ID.
- Hosted specialist operations obey local/private placement and the current Space model policy. Source text cannot supply grants or credentials.

Acceptance: concrete wire contracts and source-backed limitations recorded; no classifier migration or planner-topology change.

### B. DeepSeek catalog and worker selection

- Add the pinned snapshot, context accounting and published baseline pricing, marking its Naelao evaluation status honestly.
- Preserve live OpenRouter key/catalog checks for curated and dynamic planner IDs.
- Select economy workers independently of an expensive OpenRouter planner while retaining the same provider/key/payer. Ignore FDE/planner-authored worker model IDs.
- Reject live price increases above the pinned economy worker's published input/output price ceiling; a catalog price increase must not silently change the meaning of economy effort. A larger dynamically verified worker pool remains follow-up work.
- Let configured System One advise only over host-approved candidates within the chosen effort ceiling. Revalidate its answer; deterministic selection handles outage or invalid output.

Acceptance: selectable planner; same-provider economy worker; no arbitrary model or provider cost escalation; private routes remain local.

### C. SDK and host document tasks

- Add `document.summarize`, `document.extract`, `document.compress` contracts and a grant-checked SDK transport.
- Summarize/Extract use the Space's existing OpenRouter key through AI Gateway with wholesale fallback disabled. Do not put specialist models into the general tool-using planner list.
- Validate source span text, offsets, entity definitions, unknown usage and response size; account paid usage before rejecting malformed output.
- Reserve and settle each specialist call at its own live model rate with a distinct run ID. Do not add these tokens a second time at the parent planner's rate.
- Bound calls per run and work size. Keep native compression unavailable in the default host until its credential, rate and quota policy are configured.

Acceptance: actual callable tools with policy and budget admission, independently settled usage and tested provider contracts.

### D. Compaction and project maintenance

- Use chunked Summarize for newly aged conversation turns and journal archives, retaining full originals and recent turns.
- Process only new uncovered messages; later amendments must survive repeated compaction. Map/reduce within a bounded call budget; partition larger work through durable workflows.
- Advance summary coverage only after successful output and durable summary storage. Show skipped/failed compaction honestly.
- Migrate the Shell Compact endpoint to the same service after verified session/project lookup. The historical endpoint's actor/project forwarding and utility-provider path need dedicated tests before replacement.
- Keep grants, pending approvals, current plans, terminal receipts and source documents outside lossy model memory.

Acceptance: explicit tool and automatic compaction use the same scoped specialist gateway; failure does not falsely advance coverage; manual Shell path separately verified.

### E. RAG and file pipelines

- Add explicit `knowledge.search_brief` after current authorized retrieval; retain citation metadata and label summaries as derived, non-verbatim text.
- Add native compression only after measured net savings/quality gates, not as an unconditional search default.
- Implement durable file partitioning, OCR/page tracking, content-hash/version/policy-scoped derivative caching, invalidation and exact-source re-open.
- Keep cache keys scoped by tenant/project/publication, source version, model, prompt/options and policy version. Reauthorize source access even on a cache hit.
- Add extraction previews and validators before Gadget imports or workflow actions. Direct multimodal PDF upload needs separate byte/page pricing and private-data controls.

Acceptance: no cross-scope retrieval or cache leakage; original citations survive; quotations always reopen originals; arithmetic/required-field/schema failures are surfaced.

### F. Extension/FDE composition

- Expose the SDK's task operations through existing role/tool grants, workflow nodes and scoped Canvas actions.
- Offer recipes for document review, FAQ preparation, case intake, transcripts, procurement and incident reports.
- External extensions operate only on their published inputs and cannot reuse internal planner context or member tools.
- Add per-installation/subject/run ceilings, cost preview and progress for large file workflows. Normal worker configuration remains effort-based.

Acceptance: an FDE composes extract → validate → review → store without provider keys in package code, and can understand cost, provenance and failure behavior.

### G. Evaluation and release

- Compare original/full-context and processed variants on representative synthetic or explicitly approved examples: exact identifiers/numbers, negation, later corrections, multilingual/Unicode, long-tail exceptions, conflicting sources, OCR noise and injection text.
- Measure field precision/recall, missing fields, citation support, downstream answer correctness, retrieval recall, wall time, token usage and actual total price including retries/cache.
- Use held-out examples and more than one run; do not accept a better compression ratio that reduces correctness. Measure DeepSeek tool use and long-running worker completion separately.
- Start with explicit tools and a small opt-in population, then broaden automatic use only where economics and quality pass.

Acceptance: reproducible measured quality/cost evidence and deployment support matrix; no invented savings or live-verification claim.

## Initial implementation checkpoint

Implemented in this task: DeepSeek curated planner metadata; economy OpenRouter worker resolution, live price ceilings and bounded System One advice; fresh capability evidence for direct child runs; SDK document contracts and savings arithmetic; bounded provider adapters; worker prebuilt tools and Bash commands; per-call model-policy/key/catalog/budget checks with independent settlement; chunked specialist auto-compaction and `memory.compact`; journal specialist summaries; explicit scoped `knowledge.search_brief`.

The Agents Worker also supports separately configured native compression via `SCALEDOWN_API_KEY` and `SCALEDOWN_INPUT_USD_PER_MILLION`. Both must be present and valid; the exact `scaledown/compress` ID must pass the Space model policy, and the call uses existing run-budget reservation and settlement. The input rate must match the deployed ScaleDown account contract; it is not inferred from a third-party price list. The worker rejects missing or invalid configuration, preserves native credentials separately from OpenRouter, and records unknown output tokens as unknown at the adapter boundary. This makes native compression available to authorized tools after deployment configuration; no provider key or live request is supplied by the repository.

`document.partition` reads only the active project/Space workspace and checks delegated file grants before opening bytes. It accepts source files up to 10 MiB, extracts plain UTF-8 text or unencrypted PDF text up to 100 pages and 1.5 MiB, and produces at most 24 64k-character chunks with a source SHA-256 and page/offset provenance. The current path does not OCR scanned workspace PDFs. `createDocumentSummaryWorkflowSource()` in the SDK provides a durable extension workflow recipe: partition, summarize each chunk with a stable effect key, then merge and return citations. Workflow document steps re-check membership, model policy, credentials and caller billing, with a 48-operation ceiling per run.

An opt-in seven-day derivative cache can be enabled with `SCALEDOWN_DERIVATIVE_CACHE_ENABLED=true` when `AGENT_CACHE` is bound. Cache identities include tenant, Space, project scope, actor, current model policy, exact source text and ID, model and operation options. The source is authorized/retrieved again before lookup. Only validated outputs are stored; cache hits report zero new provider tokens and `cacheHit: true`. Results above 512 KiB are not cached.

Automatic conversation/journal specialist summaries are an opt-in pilot controlled by `SCALEDOWN_AUTO_COMPACTION_ENABLED=true` on the Agents Worker. The default is off pending measured quality and billing-granularity review. Explicit document tools and `memory.compact` still require the configured Space key and policy/budget admission. Document paths resolve within the active project/branch and enforce delegated file-path grants. The adapter rejects raw PDF/binary workspace files; use existing authorized attachment extraction first.

Worker Bash examples (subject to the normal grants/approvals):

```sh
document summarize --path /workspace/research/report.txt --max-output-tokens 800
document extract --path /workspace/imports/invoice.txt --entities '{"vendor":"company issuing the invoice","total":"total due with currency"}'
knowledge brief --query "What changed in the renewal terms?" --top-k 3
```

SDK examples use an existing host-authorized operation transport, not provider credentials:

```ts
import { createDocumentTools } from "@naelao/agent-sdk";
const documents = createDocumentTools(dispatchAuthorizedOperation);
const result = await documents.extract({
  text: authorizedDocumentText,
  sourceId: "document-version-opaque-id",
  entities: { effective_date: "the date this agreement takes effect" },
});
// Verify required fields/business rules before any workflow or Gadget write.
```

Shell Compact now resolves session ownership and canonical project scope from the stored thread link, checks Space and project membership, and passes only verified identity/scope into the session's own Agent DO. Product end users can compact their own sessions but cannot trigger Space-wide memory maintenance. It uses the same policy-checked, separately billed ScaleDown summary gateway as explicit document tasks, with the existing deterministic summary fallback if specialist setup is unavailable. Scope lookup has focused tests.

Added a repeatable live-evaluation command, `pnpm evaluate:scaledown [output.json]`, implemented by `infra/scripts/evaluate-scaledown-pipeline.mjs`. It uses three synthetic cases for contract exceptions, Unicode and later corrections, and incident negation/injection; it can call Summarize/Extract through a configured Cloudflare AI Gateway BYOK route or direct OpenRouter, and native Compress separately. It records per-case repetitions, attempts, latency, provider usage/cost when returned, explicit-rate estimates when configured, fact recall, forbidden-claim presence, extraction precision/recall, compression ratio and estimated downstream break-even. Set `SCALEDOWN_EVAL_REPETITIONS` from 1 to 10 (default 3). A live run is billable. `OPENROUTER_API_KEY` enables Summarize/Extract; `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_ID` select the AI Gateway route, with optional `CF_AIG_TOKEN`; `SCALEDOWN_API_KEY` enables native Compress. Set the corresponding `SCALEDOWN_*_USD_PER_MILLION` and `DOWNSTREAM_INPUT_USD_PER_MILLION` variables for rate-based cost estimates. No automatic retry is performed because a retry could create duplicate charges.

Still incomplete: provider-specific deployment credentials/rates and live entitlement checks; a representative held-out corpus and measured downstream answer/retrieval/citation quality; observed retries/cache savings from production; durable provider-usage recovery for ambiguous failures; multimodal PDF input and OCR; broader Canvas action authoring beyond the declarative workflow capability; and wider deployment-support verification. The evaluation harness currently supplies smoke fixtures and metrics, not evidence that any model passed a production-quality threshold. No provider keys are configured in this execution environment, so no billable live inference was performed.

## Verification recorded for the initial checkpoint

SDK/billing builds and Agents/Spaces/Shell typechecks passed. The focused runs passed 144 distinct tests: 90 model/config/compaction/journal, 35 worker/provider/CLI/scope, 4 SDK and 15 billing. Biome passed on the six new TypeScript files, and `git diff --check` passed. Thirteen pre-existing journal/conversation test failures were reproduced on an isolated checkout of `bd20429` before being repaired in the separate regression commit `6fd7f0c`. No claim is made about the historical 16 failures or the full monorepo suite.

These checks validate contracts and local behavior with mocked providers. They do not establish live provider entitlement, downstream answer quality, latency, measured savings or deployment readiness. The next release gate is configured provider evaluation and billing-granularity review, followed by native compression/file/cache/UI phases above.
