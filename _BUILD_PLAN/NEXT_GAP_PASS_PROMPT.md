# Next Gap Analysis Pass — Full Context Prompt

Paste this entire file as your first message in a new Claude Code session.

---

## Your Mission

Run one more deep technical gap analysis pass on the Naelao architecture spec.
Previous passes found 290 gaps. Your job is to find what those passes MISSED —
specifically gaps that would cause **silent failures, data loss, billing errors,
security breaches, or features that simply cannot work** on Cloudflare's actual
platform constraints.

## Repository

Branch: `claude/missing-technical-gaps-29zs41`
Working directory: `/home/user/Naelao-1/`

Key files:
- `/home/user/Naelao-1/naelao_expanded_gaps_resolved.html` — 2.25 MB, 39,556 lines
  This is the PRIMARY spec file. It contains the original architecture PLUS
  Appendices A-H with the 290 already-documented gaps. Do NOT re-report anything
  already in those appendices.
- `/home/user/Naelao-1/_BUILD_PLAN/` — 39 self-contained AI prompts (one per source file)
  These prompts contain the "intended implementation" for each file. Gaps you find
  here mean the implementation will be wrong when generated.

## What Naelao Actually Is

Full-stack AI agent platform running **100% on Cloudflare Workers + Durable Objects**.
No Node.js. No PostgreSQL. No Redis. No traditional servers.

### Core Workers (21 total, deploy in this order)
1. `naelao-spaces` — space CRUD + SpaceDO SQLite
2. `naelao-auth` — JWT issue/verify (Web Crypto)
3. `naelao-credentials` — HKDF per-space encrypted secrets
4. `naelao-agents` — agent run orchestration + NaelaoAgentDO
5. `naelao-threads` — conversation history
6. `naelao-knowledge` — RAG pipeline (chunk → embed → vectorize)
7. `naelao-billing` — Lemon Squeezy webhooks + credit management
8. `naelao-registry` — space types, app registry, workflow registry
9. `naelao-sweeper` — cron cleanup
10. `naelao-notifications` — queue consumer
11. `naelao-analytics` — Analytics Engine queue consumer
12. `naelao-triggers` — inbound webhooks from external services
13. `naelao-workflows` — CF Workers for Platforms dispatch
14. `naelao-provisioner` — space create/delete lifecycle
15. `naelao-admin` — internal admin API
16. `naelao-together-ai` — Together AI proxy (streaming, credit reservation)
17. `naelao-router` — public edge router (auth, CORS, rate limit)
18. `naelao-portal-router` — per-space portal routing
19. `naelao-artifact` — sandboxed code execution
20. `naelao-mcp-hub` — MCP protocol routing
21. `naelao-eval` — internal QA benchmark pipeline

### Durable Objects
- `SpaceDO` — per-space SQLite database (ALL space data lives here)
- `NaelaoAgentDO` — agent brain: WebSocket + fiber loop + tool execution
- `WalletDO` — per-user credit wallet (single-threaded = atomic)
- `ConcurrencyDO` — agent run gate (alarm-based TTL cleanup)
- `BuilderAccountDO` — developer account state
- `ThreadsDO` — conversation thread storage
- `LocalTunnelDO` — pending tool-call bridge (SQLite, not JS Map)
- `SpaceTypeRegistryDO`, `AppRegistryDO`, `WorkflowRegistryDO` — registry singletons

## Critical Platform Constraints (MUST know these)

### Cloudflare Workers
- CPU time limit: 30s (free), 30s wall (paid Unbound = ~15min, but CPU still resets)
- Subrequest limit: 1,000 per request
- Response size: 100 MB max
- Environment variables are strings only — never objects/numbers
- `crypto.randomUUID()` available; `Math.random()` is fine but not crypto-secure
- No `fs`, no `child_process`, no native Node modules
- `fetch()` is available but counts against subrequest limit

### Durable Objects
- Single-threaded per instance — but concurrent requests QUEUE, they don't run parallel
- SQLite API: `this.ctx.storage.sql.exec<T>(sql, ...params)` — returns `SqlStorageCursor<T>`
  Convert to array: `[...cursor]` or `Array.from(cursor)`
  NEVER use `db.query()`, `db.prepare()`, or any Knex/Drizzle pattern
- Storage alarm: `this.ctx.storage.setAlarm(timestamp)` — only ONE alarm at a time
  If you call `setAlarm()` when one already exists, it REPLACES it (use `getAlarm()` first)
- WebSocket hibernation: MUST call `this.ctx.acceptWebSocket(server, tags)` BEFORE
  returning the 101 response. If you return first, hibernation is broken silently.
- DO hibernation kills all in-memory state — reconstruct from SQLite on wake
- DO-to-DO calls via stub ALWAYS go through the CF network (not in-memory), so they
  count against subrequest limits and add ~5-10ms latency each
- Schema migrations: NEVER rely on `CREATE TABLE IF NOT EXISTS` to add new columns.
  Must use `ALTER TABLE ADD COLUMN` gated by `schema_version` table.

### Cloudflare Queues
- At-least-once delivery — consumers MUST be idempotent
- `max_retries` must be set or messages retry forever
- `dead_letter_queue` must be configured or failed messages are silently dropped
- Max message size: 128 KB
- Max batch size: 100 messages
- `ctx.waitUntil()` needed if consumer does async work after `return`

### Cloudflare Analytics Engine
- Positional fields: blob1-blob6 (strings), double1-double6 (numbers)
- Field positions are FIXED per dataset — wrong position = wrong data forever
- ALWAYS use schema registry constants, NEVER hardcode positions
- No query API in Workers — queries via HTTP API (separate from Worker runtime)
- Writes are fire-and-forget via `env.ANALYTICS.writeDataPoint()`

### Cloudflare Vectorize
- Single shared index: `naelao-knowledge-base` (768 dims, cosine similarity)
- Filter syntax MUST use explicit operator: `{ spaceId: { $eq: spaceId } }`
  NOT `{ spaceId: spaceId }` — that silently returns wrong results
- Metadata filter keys must be pre-declared in index configuration
- `insert()` vs `upsert()` — use `upsert()` for idempotency
- Max 100 vectors per upsert batch
- Nearest-neighbor query default topK is 10 — always pass explicit topK

### Cloudflare Workers for Platforms (Dispatch Namespace)
- Required for dynamic code execution — no `eval()`, no `new Function()`, no dynamic import
- Worker scripts must be uploaded via API before dispatch
- Each dispatch runs in isolated Worker — can't share memory with caller
- Dispatch namespace binding: `env.DISPATCH_NAMESPACE.get(scriptName)`

### KV Namespace
- Eventually consistent — reads after writes may return stale data (up to 60s)
- NOT suitable for counters or coordination — use Durable Objects for that
- `expirationTtl` minimum is 60 seconds
- `list()` returns max 1,000 keys per call — must paginate with cursor

### R2 Storage
- No native append — must read + write with ETag `onlyIf` for atomic append
- `onlyIf: { etagMatches: etag }` will 412 on conflict — must retry
- Max object size: 5 TB, but max `put()` body is 5 GB
- Multipart upload required for >5 GB
- No server-side encryption key rotation — if you change the key, old objects unreadable

### Service Bindings
- Worker-to-Worker only — NEVER use `fetch()` for internal calls
- Binding type: `Service<Env>` where Env is the target worker's Env interface
- Calls do NOT count against subrequest limit (they're free)
- But they DO add latency (~1ms for same-region, ~10ms cross-region)
- The called worker sees request as if from the edge — including all headers

## Architecture Decisions Already Made

### Billing: Lemon Squeezy + Stripe (via provider abstraction)
- Primary: Lemon Squeezy (available in user's country)
- Future: Stripe (not available now but planned)
- Pattern: `BillingProvider` interface with `processWebhook()`, `createCheckout()`,
  `getSubscription()`, `cancelSubscription()` methods
- Switch via `BILLING_PROVIDER` env var (`'lemon-squeezy'` or `'stripe'`)
- Lemon Squeezy specifics:
  - Webhook signature: `X-Signature` header, HMAC-SHA256 of raw body
  - Amounts: strings in cents — use `parseInt()`, never `parseFloat()`
  - Custom data location: `meta.custom_data.spaceId` (orders), 
    `data.attributes.custom_data.spaceId` (subscriptions)
  - Webhook events: `order_created`, `subscription_created`, `subscription_updated`,
    `subscription_cancelled`, `subscription_payment_success`, `subscription_payment_failed`

### Credits System
- WalletDO: per-user, tracks `balance_credits`, `reserved_credits`
- Reservation pattern for streaming: reserve upfront, release unused after completion
- SpaceDO: tracks `balance_credits`, `daily_spent_credits`, `daily_limit_credits`
- Both must be checked before allowing agent runs
- Credit amounts: integers (microcredits), 1 credit = $0.000001 (example scale)

### Agent Run Architecture (Fiber/WAL pattern)
- `NaelaoAgentDO` receives WebSocket connection
- Runs a "fiber loop": LLM call → tool calls → LLM call → ...
- Write-Ahead Log (WAL) in SQLite ensures exactly-once tool execution on recovery
- Tool calls append to R2 transcript atomically (ETag retry pattern)
- `AbortController` with timeout kills stuck LLM calls
- `token_buffer` in DO SQLite cleaned up after run to prevent unbounded growth
- Run state stored in DO SQLite: `run_id`, `status`, `messages`, `tool_calls`

### Security
- JWT: `HS256` with `JWT_SECRET` env var, expiry enforced, no algorithm confusion
- Credentials: AES-256-GCM, per-space key via HKDF from master key
  `HKDF(masterKey, salt=spaceId, info="naelao-credential-v1", length=32)`
  Never store derived keys — always re-derive
- Webhook signatures: constant-time comparison (crypto.subtle.timingSafeEqual or
  manual hex compare in constant time loop)
- Admin API: `X-Admin-Secret` header, never expose to public router
- Impersonation tokens: scoped to specific spaceId, short TTL (15 min max)
- Code sandbox (naelao-artifact): no template literal injection —
  user code concatenated as base64, never interpolated into Worker script string

### traceId Propagation
- Generated at naelao-router: `crypto.randomUUID()`
- Passed via `X-Trace-ID` header through ALL Service Binding calls
- Every error response must include `traceId`
- Analytics events must include traceId as blob6

## What Previous Passes Found (Do Not Re-Report)

Appendices A-H in the spec already cover:
- A: SpaceDO SQLite API misuse (db.query vs ctx.storage.sql.exec)
- B: `rootSpaceId` undefined at 56 call sites
- C: PostgreSQL stored functions in a Workers-only codebase
- D: WebSocket hibernation violations
- E: ConcurrencyDO alarm replacement bug
- F: Analytics Engine hardcoded positions
- G: BuilderAccountDO missing entirely from original spec
- H: LocalTunnelDO pending calls in JS Map (lost on hibernation)
- Plus 200+ more gaps across billing, security, R2 append, Vectorize filter syntax,
  KV consistency, Queue idempotency, CORS, rate limiting, cron implementations

## How to Do This Pass Better

Previous passes were "what's missing from the spec." This pass should be:

### 1. Cross-Reference Pass (Build Plan vs Spec)
Read each prompt file in `_BUILD_PLAN/prompts/` and check:
- Does the spec CONTRADICT what the prompt says?
- Is there a binding/env var in the prompt that doesn't appear in `28_wrangler_configs.md`?
- Does the prompt assume a Service Binding that the target worker doesn't export?
- Are there TypeScript types used in one prompt that are defined in another but might
  have incompatible shapes?

### 2. Integration Failure Pass
Focus on the SEAMS between workers — where does Worker A's output become Worker B's input?
- What happens if naelao-router calls naelao-agents and the DO doesn't exist yet?
- What happens if a Lemon Squeezy webhook arrives before the space is provisioned?
- What happens if the Together AI proxy is rate-limited mid-stream?
- What happens if WalletDO and SpaceDO have conflicting credit balances?
- What if the analytics queue is full when an event is written?

### 3. Operational Gaps Pass
Things that will break in production but not in testing:
- What is the DO eviction policy? If `NaelaoAgentDO` is evicted mid-run, what happens?
- Are there unbounded growth patterns? (e.g., audit log with no TTL or pagination)
- What happens when R2 storage reaches billing limits?
- Are there memory leaks in long-lived DOs? (e.g., `Map` that grows forever)
- Are cron jobs idempotent if they run twice simultaneously (CF can do this)?
- Is there a thundering herd problem when many spaces provision at once?

### 4. Security Blind Spots Pass
- SSRF: does any worker make a `fetch()` to a URL from user input?
- Path traversal: does any R2 key include user-controlled strings without sanitization?
- Injection: does any SQL query use string concatenation instead of parameterized queries?
- Token leakage: are JWTs ever logged, included in error responses, or stored in KV?
- Confused deputy: can User A's agent access User B's credentials via a race condition?
- Timing attacks: are there any non-constant-time secret comparisons?

### 5. CF Platform Limits Pass
Walk through the subrequest count for the most expensive operations:
- Provisioning a new space: how many Service Binding calls? DO stubs? KV writes?
- A single agent turn with 3 tool calls: how many subrequests total?
- Knowledge ingestion of a 1 MB document: how many Vectorize upserts? R2 puts?
- Could any realistic user action exceed the 1,000 subrequest limit?

### 6. Missing Error Recovery Pass
- If naelao-provisioner fails halfway through, is there a rollback mechanism?
- If a Lemon Squeezy webhook is delivered twice, does the credit balance double?
- If the WAL replay fails during agent recovery, is the user's data corrupted?
- Are there any error paths that leave Durable Objects in an inconsistent state?

## Output Format for New Gaps

For each new gap found, use this format:

```
GAP-XXX [SEVERITY: CRITICAL|HIGH|MEDIUM|LOW]
Title: <one line>
File(s): <which prompt/worker is affected>
Problem: <what goes wrong and when>
Root Cause: <the specific CF API, platform constraint, or logic error>
Fix: <exact code or configuration change>
```

SEVERITY guide:
- CRITICAL: data loss, billing error, security breach, or feature completely non-functional
- HIGH: feature broken in production but works in testing; or significant data inconsistency
- MEDIUM: degraded behavior under load or edge cases
- LOW: suboptimal but functional

## Before You Start

1. Run: `git checkout claude/missing-technical-gaps-29zs41`
2. Verify you're on the right branch: `git log --oneline -5`
3. Read `_BUILD_PLAN/00_START_HERE.md` for the full project structure
4. Read `_BUILD_PLAN/FILE_TREE.md` for the worker-to-prompt mapping
5. Use `sed -n '<start>,<end>p' naelao_expanded_gaps_resolved.html` to read sections
   of the large spec file (it's 39,556 lines — don't try to read it all at once)
6. Appendices start around line 35,000 of the spec — scan those to know what's already documented

## After Finding Gaps

1. Write all new gaps as a new appendix in `naelao_expanded_gaps_resolved.html`
   (match the existing CSS/visual style of Appendices A-H)
2. For any gap that affects a `_BUILD_PLAN/prompts/` file, update that prompt file
   to include the fix directly
3. Commit everything to `claude/missing-technical-gaps-29zs41`
4. Push with: `git push -u origin claude/missing-technical-gaps-29zs41`

The goal is: after this pass, someone could take `_BUILD_PLAN/prompts/` and generate
every file, assemble the project, and it would deploy and run correctly on CF without
hitting any showstopper architectural errors.
