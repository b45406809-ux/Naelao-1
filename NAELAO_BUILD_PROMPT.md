# Naelao Platform — Full Build Session Prompt

Paste everything below this line into a new Claude Code session on the Naelao-1 repository.

---

## YOUR MISSION

You are building the **Naelao platform** — a Cloudflare-native AI agent platform — from its specification to production-ready reality. This is not a prototype. Every line of code you write must be correct, secure, and production-grade. You will find bugs, fix them immediately, and never leave broken code in place.

## BRANCH INSTRUCTIONS — READ FIRST

**NEVER push to `main` or any other branch.** Your working branch is:

```
claude/naelao-missing-gaps-pass-713ruz
```

This branch already exists on the remote. Your first action in this session must be:

```bash
git fetch origin claude/naelao-missing-gaps-pass-713ruz
git checkout claude/naelao-missing-gaps-pass-713ruz
git pull origin claude/naelao-missing-gaps-pass-713ruz
```

All commits go to this branch. Push after every completed subsystem with:
```bash
git push -u origin claude/naelao-missing-gaps-pass-713ruz
```

---

## THE SPECIFICATION

The authoritative specification is at:
```
/home/user/Naelao-1/naelao_expanded_gaps_resolved.html
```

This file is **6.7 MB** and contains **2,510 individually numbered gaps** across 58 appendices (G-A through G-BE, plus Appendix I). Each gap has:
- A **gap ID** (e.g. `G-A01`, `G-B02`, `G-AF50`)
- A **severity** badge (CRITICAL / HIGH / MEDIUM / LOW)
- A **section tag** identifying which subsystem it belongs to
- **"The Gap"** — what is missing or broken
- **"Required Fix"** — the exact implementation to build

**You must implement every gap marked CRITICAL and HIGH.** MEDIUM gaps should be implemented where they do not conflict with higher-priority work. LOW gaps are implemented if time permits.

### Appendix Topics (what each covers)

| Appendix | Topic |
|---|---|
| G-A | Core Platform Architecture — monorepo, DO lifecycle, bundle limits, secret rotation, observability |
| G-B | Authentication & Identity — JWT security, PBKDF2 passwords, RBAC, MFA, OAuth2, GDPR |
| G-C | Configuration & Secrets — env isolation, feature flags, plan limits in D1, LLM fallback chain |
| G-D → G-Z | Foundation gaps (original pass) — auth, sessions, KB, billing, spaces, agents, security |
| G-AA | Enterprise identity, SCIM, Auth0/WorkOS, specialist platforms |
| G-AB → G-AE | Advanced platform gaps across auth, LLM, storage, billing |
| G-AF | API design & DX — OpenAPI, SDK, streaming, webhooks, pagination, HIPAA, usage billing |
| G-AG → G-BE | Scaling, reliability, observability, compliance, ecosystem, strategic |
| G-I | Integration & service mesh — inter-worker auth, missing workers, CF Workflow constraints |

**The new appendices (G-A, G-B, G-C, G-I, G-AF) were added to fill previously missed gaps. They contain some of the most critical fixes including:**
- **G-B02 CRITICAL**: Passwords hashed with SHA-256 must be replaced with PBKDF2 (600,000 iterations)
- **G-B01 CRITICAL**: JWT algorithm pinning (reject `alg: none`, hardcode HS256)
- **G-A09 HIGH**: DO SQLite migration locking (BEGIN EXCLUSIVE to prevent concurrent migration)
- **G-A11 CRITICAL**: Validate all CF Worker Secrets at startup
- **G-AF08 HIGH**: Stream agent responses via SSE
- **G-AF50 HIGH**: Complete usage-based billing pipeline end-to-end
- **G-I04 HIGH**: Agents must call the Knowledge worker for KB retrieval
- **G-I11 HIGH**: Agent run results must be written back to SpaceDO session messages
- **G-I17 HIGH**: MCP hub worker for external tool integrations

---

## WHAT IS ALREADY BUILT

The following exists on the `claude/naelao-missing-gaps-pass-713ruz` branch:

### Packages (7 built)
- `packages/types/` — all branded ID types, SpaceTypeManifest, ApiError, ApiResponse, etc.
- `packages/auth/` — `signJwt()`, `verifyJwt()`, `hasPermission()`, `assertPermission()`
- `packages/db/` — `queryAll()`, `queryOne()`, `execute()` — enforces `?` placeholder pattern
- `packages/http/` — Hono middleware: `requestId`, `jwtAuth`, error response helpers
- `packages/rag/` — `chunkText()`, `embedText()`, `embedBatch()`, `reciprocalRankFusion()`, `bm25Score()`
- `packages/llm-gateway/` — `callLlm()`, `streamLlm()`, `calculateTokenBudget()`, `moderateInput()`, `moderateOutput()`
- `packages/security/` — WAF, rate-limit DO, audit log, secrets, security headers

### Workers (9 built)
- `workers/router/` — Hono routing, JWT validation, service binding dispatch
- `workers/auth/` — login (SHA-256 passwords — **MUST BE FIXED to PBKDF2 per G-B02**), register, verify
- `workers/spaces/` — Space CRUD + SpaceDO (WAL SQLite, sessions, messages, FTS5)
- `workers/knowledge/` — KB ingestion, Vectorize + BM25 hybrid search
- `workers/agents/` — NaelaoAgentDO ReAct loop, tool dispatch, alarm watchdog
- `workers/billing/` — Stripe webhooks, checkout, subscription sync, quota enforcement
- `workers/analytics/` — CF Analytics Engine write + query
- `workers/workflows/` — SpaceProvisioningWorkflow, DataErasureWorkflow, KbIngestionWorkflow, DunningWorkflow
- `workers/security-gateway/` — WAF + rate limiting + security headers entry point

### Apps (2 partially built)
- `apps/dashboard/` — Next.js 14 App Router, SpaceType/Space/KB management UI
- `apps/portal/` — Next.js chat UI, session polling, embed variant

### Tests (8 files in `tests/`)
- Unit: auth, rag, security, llm-gateway
- Integration: auth-flow (mocked D1), spacedo (InMemorySql)
- Contract: api-schema shape tests
- Isolation: tenant isolation logic tests

---

## WHAT MUST BE BUILT

### Priority 1 — Critical Fixes to Existing Code

Before building anything new, fix these bugs in the existing codebase:

1. **`workers/auth/src/index.ts`** — Replace SHA-256 password hashing with PBKDF2 (G-B02 CRITICAL):
   ```ts
   // WRONG (current):
   crypto.subtle.digest('SHA-256', enc.encode(password))
   // CORRECT:
   crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:600_000}, key, 256)
   ```
   Store `{hash, salt, iterations}` in the `password_hash` column (JSON-encoded).

2. **`packages/auth/src/jwt.ts`** — Pin JWT algorithm to HS256 (G-B01 CRITICAL): reject tokens where `header.alg !== 'HS256'` before any verification.

3. **`workers/spaces/src/do/SpaceDO.ts`** — Wrap migration block in `BEGIN EXCLUSIVE` transaction (G-A09 HIGH) to prevent concurrent migration race condition.

4. **`workers/agents/src/do/NaelaoAgentDO.ts`** — After each agent run, write all conversation turns (user + assistant + tool) back to the SpaceDO session messages via service binding call (G-I11 HIGH).

5. **`workers/agents/src/do/NaelaoAgentDO.ts`** — Add `search_kb` tool that calls the knowledge worker via service binding (G-I04 HIGH).

6. **All workers** — Add `validateEnv(env: Env)` startup check for required secrets (G-A11 CRITICAL).

### Priority 2 — Missing Workers (implement in order of dependency)

Build each as a complete CF Worker with wrangler.toml, TypeScript source, and tests:

#### `workers/notifications/`
Consumes `naelao-notifications-queue`. Channels: email (Resend API), in-app (D1 `notifications` table), webhook. Templates in D1. Per-user preferences.

#### `workers/provisioner/`
Receives `space_provision` queue messages. Runs SpaceProvisioningWorkflow steps: DO init, KB placeholder, default tool config, welcome message.

#### `workers/credentials/`
Per-Space encrypted credential storage. Encrypt with Space's DEK (AES-256-GCM). `POST /v1/spaces/:spaceId/credentials`, `GET` returns names only. Agent runtime fetches plaintext at dispatch time.

#### `workers/ws-gateway/`
CF Durable Object-backed WebSocket server. One DO per org (`{orgId}:ws`). Subscribes to Space events and broadcasts to connected dashboard clients. Replaces polling in the dashboard.

#### `workers/portal-router/`
CF Worker on `*.naelao.app`. Reads subdomain from `Host` header, looks up tenant/Space in KV/D1, proxies to CF Pages portal with Space context. Supports custom domains.

#### `workers/synthetics/`
CF Cron Trigger (every minute). Runs synthetic transactions against each worker. Records latency + success in Analytics Engine. Alerts via queue when p99 > 2s or success rate < 99.5%.

#### `workers/sweeper/`
Daily CF Cron Trigger. Cleans up: old sessions with no messages (> 90 days), failed KB documents (> 7 days), orphaned R2 objects, stale DO state. Uses CF Workflow for timeout safety.

#### `workers/feedback/`
`POST /v1/sessions/:sessionId/messages/:messageId/feedback`. Stores in D1. Emits to Analytics Engine. Weekly quality score per SpaceType.

#### `workers/admin/`
Platform ops. JWT-gated with `role: 'platform_admin'`. Tenant management, feature flags, usage reports, user impersonation log, billing overrides.

#### `workers/search/`
Semantic search across SpaceTypes in a dedicated Vectorize index. Hybrid retrieval. Powers marketplace discovery.

#### `workers/channels/`
Inbound channels: CF Email Routing handler, Slack Events API, generic webhook. Translates to session format. Routes responses back to originating channel.

#### `workers/triggers/`
Scheduled and event-driven Space activation. Stores trigger definitions in D1. CF Cron Triggers fire the worker. Creates synthetic sessions with injected user messages.

#### `workers/eval/`
Evaluation suites against SpaceType configs. LLM judge (Claude Haiku) scores outputs. `POST /v1/evals`, `GET /v1/evals/:id/results`.

#### `workers/artifact/`
Agent-generated file storage in R2. Presigned retrieval URLs (7-day TTL). `POST /v1/artifacts`, returns `{artifact_id, download_url}`.

#### `workers/mcp-hub/`
MCP tool server registry per Space (D1: `mcp_servers`). Proxies tool calls to external MCP servers with auth. Returns tool definitions for agent runtime.

#### `workers/marketplace/`
SpaceType publishing, review workflow, discovery. Rating/review system. Fork into workspace.

#### `workers/together-ai/`
Alternative LLM provider wrapping Together AI / Fireworks / Groq (OpenAI-compatible endpoint). Same `LlmRequest`/`LlmResponse` interface as the LLM gateway. Used as fallback when Anthropic returns 529.

#### `workers/threads/`
Multi-session conversation threading. Thread = sequence of sessions for `{space_id, end_user_id}`. Thread summaries generated by LLM when context fills.

#### `workers/assistant/`
Platform-level Claude-powered helper for builders. Pre-configured with platform docs as KB. Accessible to all authenticated builders.

#### `workers/browser/`
CF Browser Rendering (Puppeteer) for agents. `POST /v1/browser/navigate {url, actions}`. Returns `{text, screenshot_base64, links}`. SSRF protection: block private IP ranges and internal hosts.

#### `workers/mini-agi/`
Hierarchical agent orchestration. Planner LLM decomposes goals into subtasks → dispatches child agent runs → aggregates results. Depth limit 3, total token budget enforced.

### Priority 3 — Missing Packages

Build in dependency order:

```
packages/config/        — Feature flags (KV-backed), env-specific config, schema validation with Zod
packages/crypto/        — PBKDF2 password hashing, AES-256-GCM envelope encryption, DEK management
packages/logger/        — Structured JSON logging with PII scrubbing, trace_id propagation
packages/tracing/       — x-trace-id propagation across service bindings, span writing to Analytics Engine
packages/idempotency/   — Idempotency key store (D1), check-before-execute pattern
packages/webhooks/      — Outbound webhook signing (HMAC-SHA256), delivery queue publishing, retry state
packages/analytics-schema/ — Versioned Analytics Engine event schemas, slot assignment registry
packages/entitlements/  — Plan-tier feature gating, seat counting, per-tenant resource quotas
packages/tool-runtime/  — Dynamic tool registry (D1-backed), tool contract validation
packages/billing-core/  — Stripe Meters API calls, proration, subscription lifecycle helpers
packages/moderation/    — Content policy enforcement, CSAM hash check interface, PHI detection
packages/testing/       — InMemorySql mock (reusable), D1 mock, KV mock, test fixtures
packages/client-sdk/    — TypeScript client SDK: typed methods, JWT refresh, WebSocket events
packages/agent-sdk/     — Builder-facing SDK for programmatic Space/session access
```

### Priority 4 — Frontend Completions

#### `apps/dashboard/` — add missing pages
- WebSocket-based live session monitoring (replace polling with ws-gateway)
- SpaceType A/B testing UI (variant management, results display)
- Eval suites management page
- Credentials management per Space
- Team invitations flow
- Webhook subscription management
- API key scoping UI (scope checkboxes on create)
- Usage analytics with D1 real-time + Stripe meter display
- Bulk data export trigger

#### `apps/portal/` — add missing features
- SSE streaming for agent responses (replace polling)
- Anonymous session support with localStorage session ID
- Magic link authentication flow
- Feedback widget (thumbs up/down per message)
- Multi-language UI (detect from browser `Accept-Language`)

#### `apps/widget/` — NEW
A zero-dependency embeddable chat widget (`<script src="...">` + `<naelao-chat space-id="...">` web component). No React. Works in any website. Connects to portal via iframe or direct API. Less than 10KB gzipped.

#### `apps/marketplace-web/` — NEW
Public SpaceType discovery site. Browse by category, sort by installs/rating. Preview SpaceType config. "Use this template" button creates a fork into the builder's workspace.

### Priority 5 — Infrastructure

#### `infra/terraform/`
Terraform for all CF resources using `cloudflare/cloudflare` provider:
- All KV namespaces (per worker, per environment: prod/staging/dev)
- All D1 databases (platform metadata, per-shard)
- All R2 buckets (kb-documents, exports, artifacts, backups)
- All Queues (analytics, billing, notifications, ingestion, webhooks, DLQ)
- Vectorize indexes (kb-prod, kb-staging, space-types-prod)
- Worker routes (api.naelao.com, ws.naelao.com, status.naelao.com)
- CF Pages projects (dashboard, portal, marketplace)
- CF Email Routing for channels worker

Store Terraform state in R2 (S3-compatible backend). Use workspaces for environment isolation.

#### `.github/workflows/`
```
ci.yml          — pnpm install, typecheck, lint (biome), test (vitest)
bundle-check.yml — wrangler build + size budget check (< 8MB per worker)
deploy-staging.yml — on push to main: terraform plan + apply staging, wrangler deploy --env staging
deploy-prod.yml — on release tag: terraform plan + apply prod (manual approval), wrangler deploy --env production
pr-checks.yml   — contract tests, tenant isolation tests, security scan (pnpm audit)
```

#### `infra/migrations/`
Add any missing D1 migration files for new tables:
- `notifications`, `triggers`, `mcp_servers`, `space_type_tools`
- `eval_suites`, `eval_results`, `artifacts`, `webhooks_subscriptions`
- `idempotency_keys`, `active_sessions`, `oauth_providers`
- `service_accounts`, `space_members`, `api_key_scopes`
- `feature_flags`, `do_registry`, `gdpr_requests`

---

## MANDATORY TECHNICAL STANDARDS

These are non-negotiable. Violating them is a bug you must fix immediately.

### DO SQLite — THE ONE RULE
```ts
// ✅ ALWAYS — positional ? placeholders only
this.ctx.storage.sql.exec("SELECT * FROM t WHERE id = ?", id);

// ❌ NEVER — named params do not exist in DO SQLite
this.ctx.storage.sql.exec("SELECT * FROM t WHERE id = :id", { id });
```
WAL mode at every DO init: `this.ctx.storage.sql.exec("PRAGMA journal_mode=WAL")`.

### CF Invariants — Know These or Break Production
- **KV eventual consistency ~60s** — NEVER use KV for rate limiting or strong consistency (use DO instead)
- **Analytics Engine append-only** — no UPDATE, no DELETE, ClickHouse dialect only
- **CF Workflows** — 1000-step limit, 30s per step, JSON-serializable state only, NO service bindings (use HTTP fetch with internal HMAC token)
- **Queues** — at-least-once delivery, 5000 msg/sec, 128KB max message, 4-day retention
- **Vectorize filter** — `{field: {$eq: value}}` only — no nested filters, no range queries
- **Workers subrequest limit** — 1000 per invocation (fetch + KV + D1 + R2 + Vectorize all count)
- **Worker script size** — 10MB compressed max (enforce 8MB budget in CI)
- **DO memory limit** — 128MB; never cache large objects in memory, always read from SQLite

### Security — Non-Negotiables
- **Never hardcode secrets** — CF Workers Secrets only; validate all at startup
- **All tenant data namespaced** — `{tenantId}:{resourceType}:{resourceId}` in KV
- **DO names** — `HMAC-SHA256(tenantId, PLATFORM_SECRET):{type}:{resourceId}` via the shared `getDOName()` function
- **Input moderation** — call `moderateInput()` before EVERY LLM call; block if `blocked: true`
- **Output safety** — call `moderateOutput()` after EVERY LLM response; flag if `flagged: true`
- **KB chunks** — ALWAYS wrap in `<kb_content>` XML tags before inserting into LLM context
- **SSRF protection** — block `169.254.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `localhost`, `0.0.0.0` in any outbound fetch from agent tools
- **Passwords** — PBKDF2 with SHA-256, 600,000 iterations, random 32-byte salt; never SHA-256 raw
- **JWT algorithm** — pin to HS256; reject any token with `alg !== 'HS256'`
- **Tenant isolation** — every D1 query, every DO access, every KV read/write must be scoped to the requesting tenant ID. A tenant MUST NEVER see another tenant's data

### TypeScript Standards
- Strict mode: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `strict: true`
- Use branded ID types everywhere: `TenantId`, `SpaceId`, `SessionId`, `UserId` etc. from `@naelao/types`
- No `any` types except at CF Workers API boundaries (cast immediately)
- All async functions must have try/catch; unhandled rejections are bugs

### Code Quality
- No comments unless the WHY is non-obvious (a constraint, a workaround, a subtle invariant)
- No TODO comments in committed code — either implement it or file it as a gap
- No console.log in production code — use the structured logger from `@naelao/logger`
- Validate all inbound request bodies with Zod schemas
- All mutations return the mutated resource (not just a status code)

### Git Discipline
- Commit after every completed subsystem (worker, package, or major feature)
- Commit message format: `{component}: {what was built/fixed} (addresses G-X##)`
- Push after every commit: `git push -u origin claude/naelao-missing-gaps-pass-713ruz`
- NEVER amend published commits; create new commits for fixes

---

## HOW TO WORK THROUGH THE SPEC

### Step 1 — Read Before You Build
Before implementing any component, read the relevant gap divs in the spec file. Use:
```bash
python3 -c "
import re
with open('naelao_expanded_gaps_resolved.html') as f: c = f.read()
gaps = re.findall(r'<div id=\"(G-[A-Z]+\d+)\".*?</div>\n\n', c, re.DOTALL)
"
```
Or search for gaps by section: `grep -n 'workers/auth\|§Auth' naelao_expanded_gaps_resolved.html`.

### Step 2 — Implement Completely
For each subsystem:
1. Write the complete implementation (no stubs, no `// TODO`, no placeholder returns)
2. Write the wrangler.toml with correct bindings for all environments
3. Write tests in `tests/` covering the happy path and the specific failure mode described in the gap
4. Verify the implementation actually satisfies the gap's "Required Fix" description

### Step 3 — Self-Review Before Committing
Before every commit, ask yourself:
- Does this code introduce any CF invariant violations? (KV for rate limiting? Named DO SQLite params?)
- Does every LLM call have input moderation before and output check after?
- Is every D1 query scoped to the requesting tenant's ID?
- Does this code validate the request body with Zod before using any field?
- Are there any hardcoded secrets or magic strings?
- Could a tenant's API call access another tenant's data through any path in this code?
- Does this code handle the case where a CF binding is missing (undefined env.BINDING)?

If the answer to any of these is "maybe" — stop and fix it.

### Step 4 — Fix What You Find
When reading existing code and you spot a bug, a security issue, or a spec violation — fix it immediately in a separate commit before continuing. Do not defer fixes. The spec's "Required Fix" descriptions are the source of truth; if existing code contradicts them, the existing code is wrong.

---

## PLATFORM CONCEPT — Keep This in Mind

- **SpaceType** = blueprint / product definition (what the Space IS). Builders create these. **Builders NEVER write code** — they configure only via UI. This is a security requirement.
- **Space** = a deployed instance of a SpaceType. Many Spaces can share one SpaceType.
- **Template** = a configurable selection a builder makes (no coding, selection/configuration only)
- End-users interact with Spaces via the portal or embedded widget
- The platform must support **millions of builder products** scalable to **millions of end-users**. Every design decision must be made with this scale in mind.

---

## SCALABILITY REQUIREMENTS

- **SpaceDO** is the hot path — every end-user message touches it. Optimise for low latency reads (KV read-through cache for non-mutating queries, TTL 10s).
- **Vectorize** is shared multi-tenant — always include `{spaceId: {$eq: spaceId}}` filter to prevent cross-tenant data leakage in search results.
- **D1** — never do N+1 queries. Batch with `Promise.all`. For high-read paths, read from KV cache (D1 as authoritative store, KV as fast path).
- **Queue consumers** — always write to R2/D1 inside `try/catch` and `ack()` only on success; `nack()` on error to trigger retry.
- **Analytics Engine** — use `ctx.waitUntil(writeEvent(...))` so event writes never block the response.
- **CF Workers** — never block the event loop. All heavy computation goes to DOs or queues.

---

## CRITICAL GAP IDs TO ADDRESS FIRST

These are the most impactful items from the new appendices. Address them before building new features:

| Gap ID | Severity | Description | File to Fix |
|---|---|---|---|
| G-B02 | CRITICAL | PBKDF2 password hashing | `workers/auth/src/index.ts` |
| G-B01 | CRITICAL | JWT algorithm pinning | `packages/auth/src/jwt.ts` |
| G-A11 | CRITICAL | Startup env validation | All workers |
| G-A09 | HIGH | DO migration locking | `workers/spaces/src/do/SpaceDO.ts` |
| G-I04 | HIGH | KB retrieval in agent tools | `workers/agents/src/do/NaelaoAgentDO.ts` |
| G-I11 | HIGH | Agent results → session messages | `workers/agents/src/do/NaelaoAgentDO.ts` |
| G-AF08 | HIGH | SSE streaming for agent responses | `workers/agents/`, `apps/portal/` |
| G-I13 | HIGH | Quota enforcement in spaces worker | `workers/spaces/src/index.ts` |
| G-A07 | MEDIUM | Centralise DO name derivation | Create `packages/do-names/` |
| G-C35 | HIGH | D1 migration runner in CI | `.github/workflows/` |
| G-AF07 | HIGH | Idempotency keys on POST endpoints | All mutating endpoints |
| G-AF10 | HIGH | Outbound webhook system | `workers/notifications/` |
| G-AF50 | HIGH | Usage billing end-to-end | `workers/billing/src/` |
| G-I14 | HIGH | Transactional Vectorize ingestion | `workers/knowledge/src/index.ts` |
| G-B07 | HIGH | Email verification on registration | `workers/auth/src/index.ts` |
| G-A45 | HIGH | JWT refresh token flow | `workers/auth/src/index.ts` |

---

## DEFINITION OF DONE

A component is **done** when:

1. ✅ All CRITICAL and HIGH gaps for that component are implemented
2. ✅ The code compiles with zero TypeScript errors (`pnpm typecheck`)
3. ✅ Tests exist and pass (`pnpm test`)
4. ✅ `wrangler.toml` has correct bindings for all three environments (dev/staging/production)
5. ✅ D1 migration files exist for any new tables
6. ✅ The implementation is committed and pushed to `claude/naelao-missing-gaps-pass-713ruz`
7. ✅ No security vulnerabilities introduced (tenant isolation, SSRF, injection, hardcoded secrets)
8. ✅ No CF invariants violated (KV consistency, DO SQLite pattern, Analytics Engine append-only)

The platform as a whole is **done** when every worker, package, and app in the `NAELAO_FILE_TREE.md` exists and passes these criteria.

---

## STARTING POINT

Run these commands right now to orient yourself:

```bash
# 1. Switch to the correct branch
git fetch origin claude/naelao-missing-gaps-pass-713ruz
git checkout claude/naelao-missing-gaps-pass-713ruz

# 2. See what's built
ls workers/ packages/ apps/

# 3. Check TypeScript errors in existing code
pnpm typecheck 2>&1 | head -50

# 4. Run existing tests
pnpm test 2>&1 | tail -30

# 5. Count spec gaps by severity
python3 -c "
import re
with open('naelao_expanded_gaps_resolved.html') as f: c = f.read()
crits = len(re.findall(r'CRITICAL<', c))
highs = len(re.findall(r'>HIGH<', c))
print(f'CRITICAL: {crits}, HIGH: {highs}')
"
```

Then start with **Priority 1 — Critical Fixes** listed above before building anything new.

Good luck. Build it right.
