# AI Studio implementation prompt — batch 27, plan items 51–52

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **Plan items 51–52**. This prompt is self-contained: the feature definitions and retained implementation
constraints have already been extracted and reconciled into the final specification below.
Do not seek or cite external design context. Repository code is evidence of current
state, not evidence that a requirement is complete.

## Non-negotiable production rules

- Trace and use the real router → authorization → worker/Durable Object → scoped persistence or
  binding → shell path. A helper, type, schema, comment, standalone endpoint, mock, or UI placeholder
  is not an implementation.
- Scope durable state and cache/index keys by every applicable tenant, space, project, invoker/user,
  actor, extension/gadget, and policy version. Conceal inaccessible private resources exactly like
  absent resources. Security-sensitive resolution fails closed.
- Reauthorize immediately before external side effects, artifact commits, merges, connector calls,
  workflow dispatch, and sibling-project calls. Preserve the original human invoker through every
  delegation and background boundary.
- Add migrations and identical development/staging/production Wrangler bindings, service bindings,
  queues, workflows, R2/KV/Vectorize/Analytics resources, secrets documentation, rotations,
  backfills, limits, alarms, and rollback behavior required by the feature.
- Add the real shell experience where applicable, including loading, empty, error, unauthorized,
  offline/reconnecting, spectator/frozen, air-gapped, and completed states. Treat model and source
  data as untrusted; never execute supplied HTML, JavaScript, URLs, or expressions.
- Add contract, isolation, race, replay, expiry, crash/hibernation, fail-closed, and router-to-worker
  journeys using realistic Cloudflare behavior. Success-only mocks may not replace authorization,
  transactions, bindings, namespace isolation, alarms, WebSockets, or Workflow behavior.
- Update the requirements trace matrix only after verification. Mark an item IMPLEMENTED only when
  every required production boundary and meaningful integration/E2E evidence exists.

## Final resolved implementation specification

## Newest cross-cutting architectural delta (overrides conflicts)

# AVOS Evolutionary Architectural Changelog

This is the authoritative architectural delta for plan items 1–130. These decisions postdate the source trails and `CLAUDE.md`; they override conflicts while retaining compatible implementation detail.

## Final reconciled upgrades

1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wins; all competitors receive abort signals immediately and only the winner enters the ordinary authorized merge path.
6. **Three-depth ceiling.** Depth 1 is the lead, depth 2 a domain sub-planner, and depth 3 a leaf executor. Depth-3 runtimes do not receive any delegation capability, making depth 4 structurally impossible.
7. **Five credit defenses.** Enforce model tiering by depth, up-front task escrow, plan-based parallelism, early-exit token reclaim, and daily personal budget envelopes. Starter executes sequentially; higher plans may enable races.
8. **Shared-space collision defense.** Combine 15-minute atomic task leases, sibling spectator mode, >0.85 intent deduplication, and sponsor-conflict RFC freezes in authoritative `SpaceDO` storage.
9. **Immutable kernel, userspace extensions.** Extensions may add manuals, virtual CLIs, daemons, and viewports but cannot replace the agent loop, bypass Gatekeepers or WriteGuard, or commit unreviewed code to `main`.
10. **Durable daemons.** Pair project-scoped DO-facet SQLite state with resumable Workflows for AST indexing, finance reconciliation, and legal citation graphs. Daemons consume no active-chat CPU/tokens and expose approved project MCP tools only.
11. **Dual-role workflows.** Dynamic Workflows support both ephemeral AI tasks and project-owned company automations. Deterministic steps remain deterministic and AI is invoked only for declared semantic work.
12. **No-code subagent studio.** The shell builds declarative `NoCodeSubagentManifest` documents from authorized tools, skills, knowledge, and triggers; a precompiled `GenericSubagentWorkflow` executes them. Creators cannot grant permissions above their current role.
13. **Logical connector aliases.** Code names semantic aliases such as `inbound_mail`; `SpaceDO` maps them to physical accounts. Rebinding never changes project source.
14. **Pluggable `primary_calendar`.** Calendar access is a space-shared MCP connector supporting Google, Microsoft, CalDAV, or scoped SQLite fallback. Voice booking acquires a 15-second `ConcurrencyDO` slot hold before external calls.
15. **Dual-plane customer bots.** Public WhatsApp, Telegram, and voice traffic reaches quarantined ephemeral Workflow agents with `CustomerBotContext`, never internal project agents. Customer contexts have no Bash, file mutation, Git Artifact, or internal-vault capability.
16. **Automation failure defenses.** Production ingress includes KV tombstones, Queue buffering, 14-day R2 replay, a 5 req/s leaky-bucket pacer, SHA-256 idempotency, `x-avos-hop-count` recursion breaking, and lenient validated adapters. The remaining defenses already specified by the relevant plan items remain mandatory.
17. **Deliverable canvas.** `/workspace/` versions every deliverable type, including code, documents, spreadsheets, and data; executable agent machinery remains under Git-ignored `/.avos/`. Review cards render type-aware diffs while bytes remain authoritative.
18. **Strict UI bifurcation.** `apps/shell` is an Apple-clean client workspace with an 85% canvas, command bar, and one-click outcomes, with no model, compute-tier, or raw merge controls. `apps/partner-studio` is the technical foundry for ladder ceilings, daemons, workflows, and blueprint packaging.

## Supersession rule

Apply this delta after each item's complete Origin & Transition trail. If it conflicts with an earlier plan statement, this file wins. If it is silent, retain the earlier final decision. All authorization, tenant isolation, fail-closed policy, provenance, billing, deployment parity, and realistic end-to-end verification requirements remain in force.


### 51. Google Search AI Mode at the Edge

**Final behavior:** Sub-50ms KV semantic cache + Dense/Sparse Hybrid Reciprocal Rank Fusion ($k=60$) combining Vectorize and BM25 with live web grounding.

**Production acceptance contract:**
Production entry: `googleModeSearch`; knowledge hybrid search and web-search routes.
Persistence/deployment: scoped cache adapter contract, Vectorize, KV, R2 and Tavily.
Required observable verification: `grounded-search-contract.test.ts` proves scope propagation/cache/grounding/telemetry without mocking those requirements away.

**Retained implementation constraints:**
- Required Fix Implement a hybrid search pipeline: (1) for each knowledge base, maintain a BM25 index in SpaceDO SQLite using SQLite FTS5 (CREATE VIRTUAL TABLE knowledge_fts USING fts5(chunk_id, text, tokenize="porter ascii")). (2) On query: run FTS5 BM25 search and Vectorize ANN search in parallel. (3) Fuse rankings with Reciprocal Rank Fusion (RRF): score = 1/(k + rank_bm25) + 1/(k + rank_vector), k=60 (standard). (4) Feed top-N fused results to the optional cross-encoder reranker (G-AH25). Configurable per space: hybrid_search: true | false (default: true). Benchmark precision@5 on an eval set.
- `GET .../kb/search` gained `retrieval_mode=autorag` (default: `legacy`, the existing pipeline) — a
**per-request** opt-in the caller decides (the knowledge-base prebuilt, or whatever's calling this
route), not a stored per-space policy row. When requested and configured, calls
`c.env.AI.autorag(instanceName).search({query, max_num_results, filters: {folder: "autorag/{spaceId}/{projectId}/"}})`
— the `folder` filter narrows to this exact space+project (defense in depth matching the legacy
path's own Vectorize metadata filter guarantee) — and maps AutoRAG's result shape into the same
`{chunk_id, doc_id, chunk_index, content, score, dense_score, sparse_score}` shape the legacy path
already retu
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- # PART 2: Reaching "Google Search AI Mode" Speed & Accuracy
To match the speed, precision, and grounding of **Google Search AI Mode (AI Overviews)** at Cloudflare's edge, you combine **Sub-50ms Semantic Caching**, **Hybrid Reciprocal Rank Fusion (RRF)**, and **Instant Live Web Grounding**.
```
User Query: "What is our refund SLA for enterprise accounts under Delaware jurisdiction?"
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. SUB-50ms SEMANTIC CACHE CHECK (SEMANTIC_CACHE_KV + Vectorize)           │
│    Embeds query in 15ms. If cosine similarity > 0.96 against past queries,  │
│    returns verified cached answer in 35ms with zero LLM generation cost.    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ (C

### 52. Interactive Numbered Citation Footnotes

**Final behavior:** Streams text with clickable citation badges (`[1]`, `[2]`) anchored to verified source chunk coordinates in R2.

**Production acceptance contract:**
Production entry: `verifyCitationCoordinate`, `stableCitationNumbers`.
Persistence/deployment: authoritative document row plus R2 object metadata required.
Required observable verification: `grounded-search-contract.test.ts` rejects forged keys/ranges; no router-to-shell E2E yet.

**Retained implementation constraints:**
- Required Fix: Implement citation injection: after KB retrieval, include source citations in agent response. Format: "According to [Document Title]([doc_url]), ..." For multi-source responses: numbered citations [1][2] with footnote list. Builder configures: citation_style=inline|footnote|none. Citation links open document in Space shell sidebar or navigate to source URL. Track citation_click_rate. Builder can specify citation_display_text template: "Source: {doc_title} (updated {date})."
- 1799/1799 tests pass (18 new: `streaming-real-deltas.test.ts` drives the real SSE endpoint
end-to-end and parses the actual wire-format output, proving no `event:` line survives and every
frame carries `type`; `context-window-usage-endpoint.test.ts` covers both the context-size and
usage-summary halves plus every degradation path; `billing-usage-summary.test.ts` covers the new
day/week/month SQL windowing directly; 2 new `contextWindowForModel` cases), `pnpm turbo run
typecheck` clean (75 tasks), `apps/shell` verified via `next build`.
- 1. **Universal swarm orchestrator.** Replace the five-avatar coworker roster with one sovereign `NaelaoAgentDO` lead. It turns goals into `SpaceDO.tasks` DAGs, forks isolated Artifact branches, dispatches ephemeral workers, and leaves the human as outcome definer and final approver.
2. **Executive Cabinet.** The Space Assistant primarily exposes `delegate_to_space_worker(worker_id, task)`. Isolated `project_manager_worker`, `treasury_worker`, `identity_worker`, and `comms_worker` receive mutually exclusive capabilities; no cabinet worker can cross its functional boundary.
3. **Bifurcated runtime.** Interactive prebuilt operators taking under 30 seconds use in-memory `NaelaoAgentDO` V8 actor RPC. Custom developer agents and durable batch sagas use Cloudflare Dynamic Workflows with retries and sleeping.
4. **Asymmetric topology.** Parent agents are persistent nouns owning threads and UI. Subagents are ephemeral verbs with only `ai`, `fs`, `cli`, `vault`, and `step`; they never create user threads or WebSockets and return one compact two-line receipt.
5. **SR-EEO races.** Critical tasks may run N isolated speculative branches. The first candidate satisfying the deterministic oracle wi
- # PART 2: Reaching "Google Search AI Mode" Speed & Accuracy
To match the speed, precision, and grounding of **Google Search AI Mode (AI Overviews)** at Cloudflare's edge, you combine **Sub-50ms Semantic Caching**, **Hybrid Reciprocal Rank Fusion (RRF)**, and **Instant Live Web Grounding**.
```
User Query: "What is our refund SLA for enterprise accounts under Delaware jurisdiction?"
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. SUB-50ms SEMANTIC CACHE CHECK (SEMANTIC_CACHE_KV + Vectorize)           │
│    Embeds query in 15ms. If cosine similarity > 0.96 against past queries,  │
│    returns verified cached answer in 35ms with zero LLM generation cost.    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ (C

## Required execution and response

1. Convert every numbered specification above into a file/request-path checklist before editing.
2. Implement in dependency order and reuse canonical workers/DOs rather than parallel helpers.
3. Return complete apply-ready unified diffs for every changed, created, or deleted file. Do not use
   ellipses, pseudo-code, TODO-only stubs, omitted boilerplate, or comments standing in for code.
4. Include exact migration, provisioning, secret rotation, rollout/backfill, rollback, and staging
   smoke commands.
5. Include exact test/typecheck/config-parity commands and the security/race assertions they prove.
6. Finish with an item-by-item release ledger: IMPLEMENTED, PARTIAL, or MISSING with honest gaps.

For automation, put exactly one machine-readable line before the first diff:
`PHASE_STATUS: CONTINUE` when another implementation turn is required, or
`PHASE_STATUS: COMPLETE` only when every numbered item and verification boundary is finished.
Place all prose after the diff or in a separate `PHASE_NOTES` section. A COMPLETE response with no
apply-ready diff is valid only when the current branch already satisfies and verifies every item.

Do not silently omit an item. If one response cannot hold the implementation, stop only after an
atomic, testable commit boundary and return a continuation prompt containing the remaining numbered
specifications and current verification state. Never claim completion because code merely compiles.
