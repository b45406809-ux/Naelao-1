# Naelao Platform — Claude Code Session Guide

## What is Naelao
A Cloudflare-native AI agent platform. Builders create SpaceTypes (blueprints) and configure Templates (no coding — builders select/configure only). End-users interact via Space shell. Designed for millions of builders and millions of Spaces.

## ⭐ CURRENT DIRECTION — READ FIRST (supersedes older framing below)
This is the active plan. If anything further down conflicts, this wins.

1. **Build the ORIGINAL spec, not the niche.** The canonical spec is
   `naelao_expanded_gaps_resolved.html` (6.8 MB). The smaller
   `naelao_whop_businesses_spec.html` was written under the assumption we were only
   shipping the Whop niche — that assumption is **abandoned**. We are building the whole
   product as the original spec describes.
2. **Script-native agents + Space Assistants are our ADDITION on top of the original
   spec** — not a replacement. We keep the original spec's `NaelaoAgentDO` (the agent
   runtime as its own DO) and `SpaceDO` (owns structure), and run our script-first engine
   as the agent's *behavior* inside `NaelaoAgentDO`. These additions are documented in
   **`docs/spec-appendix/A1-script-agents-and-space-assistants.md`** (keep it updated).
3. **We start with the Launchpad SpaceType — but we build each component FULLY.** "Start
   with Launchpad" scopes *which* components we touch (the ones Launchpad needs and things
   related), NOT how completely we build them. If Launchpad needs `NaelaoAgentDO`, build
   the whole `NaelaoAgentDO` properly — never a Launchpad-only stub. Same for `SpaceDO`,
   provisioning, billing, etc. One SpaceType at a time; each part built as the spec says.
4. **Architecture ground rules (the niche pass violated these — being corrected):**
   - Agents are their **own DO** (`NaelaoAgentDO`), addressed `space:project:thread`.
   - `SpaceDO` owns threads, members, sub-spaces, **`agent_definitions`**, billing.
   - A **project is a grouping of threads within a space** — NOT a sub-space/workspace.
   - SpaceType differences live in config / agent definitions / manifests — never DB tables.
   - `BusinessDO` (a whop-niche monolith that re-implemented the agent loop + structure) is
     being **decomposed/retired**: agent loop → `NaelaoAgentDO`, structure → `SpaceDO`,
     script engine → a reusable behavior module.
5. **HOW TO READ THE SPEC — critical.** The original spec is written top-to-bottom as a
   running log: later sections contain **updates, appendixes, and fixes** that override
   earlier ones. Before building anything (e.g. `SpaceDO`), search and read the **entire**
   spec for that topic top-to-bottom — do NOT implement the first mention you find.
6. **Launchpad SpaceType (§11)** is defined as data in
   `workers/agents/src/launchpad/spacetype.ts` (5 templates + core agent_definitions).

### ⚠️ SPEC OVERRIDES — later appendixes supersede the early sections (verified top-to-bottom)
These three were read wrong in earlier passes by trusting the *top* of the spec. The **bottom
appendixes are authoritative** and override the early framing. Always confirm against these:

7. **No community SpaceTypes — Naelao authors all of them** (spec byte ~896493:
   *"Space Types are exclusively authored by Naelao. Community developers publish Apps or Space
   Templates instead."*). Model = **Naelao builds SpaceType → builder configures a product →
   users interact**. The early `createSpace` "community types from apps-registry" branch is dead.
   The authoritative provisioner is the **10-step transactional one at byte ~899k** (manifest from
   `SpaceTypeRegistryDO`, cached in KV, rollback on failure, Space Assistant init) — NOT the early
   inline version and NOT a separate provisioning queue.

8. **Agents are SCRIPT-NATIVE — the bottom appendix "Script-First General Agent Architecture"
   (byte ~6672k) is authoritative and overrides the early NaelaoAgentDO / ReAct / hardcoded-tools
   framing.** Load-bearing facts:
   - The agent's **entire tool surface is 6 ops**: `script.create / read / update / delete / find /
     run`. **Nothing else is hardcoded** — no browser/email/MCP/file tool. Every capability is a
     **script in a library** (Voyager / CodeAct). Loop: `OBSERVE → FINGERPRINT → FIND → GATE →
     EXECUTE → VERIFY → DISTILL`; the model only wakes for DIAGNOSE/REASON/DISTILL.
   - **MCP is the `mcp-connector` prebuilt script** (`mcp.register/call/list_tools`), not a hardcoded
     integration. (MCP Apps marketplace is ON HOLD — agents reach MCP through this script later.)
   - **Channels, heartbeats, notifications are scripts** (`notifications` prebuilt). Space Assistant
     = same engine + channel/heartbeat scripts. **Threads** become a default read/run-only script
     that cannot be removed (same pattern as other built-in features).
   - **An agent is defined by 4 R2 files** — `agents.md`, `system-prompt.md`, `scripts.json`,
     `skills.json` — under `spaces/{spaceId}/agents/{agentId}/`. NOT a DB row. Composed via
     **Profiles** (Default Naelao Agent, Code, Browser, Vertical Niche, Cowork Desktop, Marketplace).
   - **Skill library** in R2 (`spaces/{spaceId}/scripts/{name}/SCRIPT.md + code.ts + versions/`),
     versioned, with embeddings in **Vectorize** for `script.find`. **Execution ladder** Tier 1–5
     (R2 / V8 isolate / npm / CF Browser / Container), auto-routed per script `requires_tier`.
   - The engine lives **inside `NaelaoAgentDO`** as a behavior module (`workers/agents/src/script-engine/`).
   - `SpaceDO.agent_definitions` (added in an earlier pass) models the **early** layer; repurpose it
     as the *space-level installed-scripts registry index*, not agent behavior.

9. **Lemon Squeezy is PRIMARY billing, Stripe is "future"** (Appendix H, byte ~2261k):
   provider-agnostic `BillingProvider` interface + `NormalizedBillingEvent`. Launchpad's order
   trigger is a **Lemon Squeezy webhook**, not Stripe.

> **Keep this section current.** As direction evolves, update this block and the appendix,
> and commit — future sessions rely on it.

## Critical Distinction
- **SpaceType** = blueprint / product definition (what the Space IS)
- **Template** = configurable selection a builder makes (no coding ever)
- Builders configure via UI only — never write code (security requirement)

## Stack
- CF Workers (router, auth, spaces, agents, knowledge, billing, etc.)
- CF Durable Objects + DO SQLite (`SpaceDO` = structure/agent_definitions, `NaelaoAgentDO` = agent runtime, sessions, memory)
- CF R2 (KB documents, exports, backups, artifacts)
- CF Vectorize (KB semantic search — shared multi-tenant index with spaceId filter)
- CF KV (circuit breakers, config cache, session revocation, portal routes)
- CF Queues + DLQ (async events, webhook delivery, analytics, notifications)
- CF Workflows (provisioning, erasure, ingestion, billing, dunning)
- CF Analytics Engine (events, metrics — append-only, 25M rows/day limit)
- D1 (platform metadata, billing, users — sharded by tenant_id MOD n)
- LLM: Anthropic Claude (primary) with fallback chain
- Stripe (billing + Connect + Meters)
- Next.js on CF Pages (builder dashboard)

## DO SQLite Pattern — CRITICAL
```ts
// CORRECT — ? placeholders only
this.ctx.storage.sql.exec("SELECT * FROM t WHERE id = ?", id);
// WRONG — named params do not exist in DO SQLite
this.ctx.storage.sql.exec("SELECT * FROM t WHERE id = :id", { id });
```
WAL mode: `PRAGMA journal_mode=WAL` at DO init. 10GB limit per DO.
DO hibernation kills ALL in-memory state — always persist to SQLite.

## Key CF Invariants
- KV eventual consistency ~60s — never use for rate limiting
- Analytics Engine: append-only, 25M rows/day, ClickHouse dialect, no DELETE
- CF Workflows: 1000-step limit, 30s per step, JSON-serializable state
- Queues: at-least-once delivery, 5000 msg/sec limit, 128KB msg max, 4-day retention
- Vectorize filter: `{field: {$eq: value}}` — no nested filters
- Workers sub-request limit: 1000 per invocation
- Workers script size: 10MB compressed max

## Security Requirements
- Never hardcode secrets — CF Workers Secrets only
- All tenant data namespaced: `{tenantId}:{resourceType}:{resourceId}` in KV
- DO names: `HMAC-SHA256(tenantId, PLATFORM_SECRET):{type}:{resourceId}`
- Input moderation before every LLM call
- Output safety check after every LLM response
- KB chunks wrapped in `<kb_content>` XML tags (prompt injection protection)

## Monorepo Structure
- `packages/*` — shared libraries (@naelao/types, @naelao/auth, @naelao/db, etc.)
- `workers/*` — CF Workers (router, spaces, agents, knowledge, billing, etc.)
- `apps/*` — CF Pages frontends (dashboard, product-portal, widget, marketplace)
- `infra/` — Terraform IaC, migration scripts, dev tooling
- `tests/` — integration, e2e, contract, isolation, load tests

## Git
**Active branch: `claude/naelao-missing-gaps-pass-8vkakf`** — work here; do NOT push to any
other branch without explicit permission. Commit after every working subsystem; push after
every commit. (Older branch `...-713ruz` is superseded.)

## Build Progress
- [x] Phase 0: Scaffold (root workspace, packages, workers structure)
- [x] Phase 1: Foundation (router worker, auth, SpaceDO, D1 migrations)
- [x] Phase 2: KB System (knowledge worker, Vectorize ingestion, hybrid retrieval)
- [x] Phase 3: LLM Gateway + Agent Runtime (llm-gateway, agent loop, tool framework)
- [x] Phase 4: Billing (Stripe webhooks, subscriptions, metering)
- [x] Phase 5: Builder Dashboard (Next.js on CF Pages, all pages)
- [x] Phase 6: Space Shell / Product Portal (SSE streaming, i18n, magic link auth, feedback)
- [x] Phase 7: Async Systems (Queues consumers, Workflows, all 28 workers)
- [x] Phase 8: Analytics + Observability (analytics-schema, tracing, logger packages)
- [x] Phase 9: Security Hardening (PBKDF2 G-B02, JWT pin G-B01, moderation, SSRF, env validation)
- [x] Phase 10: Test Suite (167 tests across 14 suites — crypto, moderation, entitlements, webhooks, analytics-schema, idempotency, auth, rag, security, llm-gateway, spacedo, auth-flow, api-schema, tenant-isolation)

## Additional Infrastructure Built
- [x] Terraform IaC (cloudflare/cloudflare ~4.45, all KV/R2/D1/Queues/Vectorize/Pages resources)
- [x] GitHub Actions CI/CD (ci, bundle-check, pr-checks, deploy-staging, deploy-prod)
- [x] D1 migrations 0001-0028 (all tables including marketplace, threads, eval, artifacts, gdpr, etc.)
- [x] apps/widget/ (zero-dependency web component, SSE streaming, < 10KB gzip target)
- [x] apps/marketplace-web/ (SpaceType discovery, categories, listing detail, fork flow)
- [x] All 14 packages: types, auth, db, http, rag, security, llm-gateway, config, crypto, logger, tracing, idempotency, webhooks, analytics-schema, entitlements, tool-runtime, billing-core, moderation, testing, client-sdk, agent-sdk

## Spec Reference
**Canonical spec:** `/home/user/Naelao-1/naelao_expanded_gaps_resolved.html` (6.8 MB).
2260+ numbered gaps (G-A01 through G-BE50). Each gap has:
- The Gap: what is missing
- Required Fix: exact implementation to build
When implementing, cite the gap ID you are fulfilling.

**Read it top-to-bottom for any topic** — later sections add updates/appendixes/fixes that
override earlier ones (see CURRENT DIRECTION #5). It's a binary-matching file; use
`grep -a` / `python3` to extract a section, and read the whole topic before coding.

- `naelao_whop_businesses_spec.html` — the abandoned niche-only assumption. Do not build to it.
- `docs/spec-appendix/A1-script-agents-and-space-assistants.md` — our additions (script
  engine, Space Assistants, capability kernel, manifests). Keep current.
- `docs/SPEC_HEADER_INDEX.md` — section index into the canonical spec.
