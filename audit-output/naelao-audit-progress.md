# Naelao audit progress and evidence

This records completed passes from the current change set. It does not represent a completed audit of all repository files. The file-by-file checklist remains pending until each file's callers, runtime registration, and trust boundaries have been reviewed and evidence recorded.

## Completed focused review

| Area | Review scope | Evidence | Status |
|---|---|---|---|
| Conversation transcript search | Cursor paging, 10,000-message cap, unavailable/incomplete result semantics, result bounds, search ranking, Unicode, older-page continuation | `tests/unit/conversation-search.test.ts` (20 pass) | Focused pass complete |
| Transcript context loader | Multi-page loading and 10,000-message safety bound | `tests/unit/agent-conversation-pagination.test.ts` (2 pass) | Focused pass complete |
| Message list API | Malformed/negative limits and bounded response | `tests/unit/message-list-tail.test.ts` (8 pass) | Focused pass complete |
| Task-based worker capabilities | Static capability bundles, ambiguity fallback, failed-decision fallback, intersection with parent tools, skill allowlist enforcement | `workers/agents/src/script-engine/worker-capabilities.test.ts` (4 pass), `skill-role-targeting.test.ts` (2 pass) | Focused pass complete |
| Delegation capability integrity | Selected tools and skills are included in the host-signed delegation resource; tampering/invalid names rejected | `workers/agents/src/script-engine/delegation-contract.test.ts` (2 pass) | Focused pass complete |
| Jev/Clef typed decision | Bounded candidate count, validated task-specific yes/no classification, invalid output rejected | `packages/agent-sdk/src/fast-decision.test.ts` (17 pass) | Focused pass complete |

## Issues found and corrected during this pass

1. An exhaustive no-match conversation search had regressed to saying only “page” and no longer stated the detail was absent from the complete conversation. Restored the conclusive wording for full scans while keeping cursor-window misses explicitly page-scoped.
2. The initial worker capability keyword rule treated any mention of “project” inside a conversation-research task as a request for project administration. Narrowed the stress case to the actual intent and kept the deterministic capability groups explicit; unrelated selected tools are now covered by a regression assertion.
3. A strict TypeScript check caught optional decision and delegation-capability types that needed exact optional handling. Corrected these before the focused tests.

## Follow-up shared security and egress pass

| Area | Review scope | Evidence | Status |
|---|---|---|---|
| SSRF address classification | IPv4 reserved ranges, IPv4-mapped IPv6, NAT64, IPv6 special-use/non-global ranges, malformed IPv6, public IPv6 literals, DNS responses without usable A/AAAA values | `tests/unit/packages/security.test.ts` (32 pass), `tests/unit/mcp-hub-ssrf.test.ts` (11 pass) | Focused pass complete |
| Knowledge web egress | Every fetch/extract/download redirect is checked before the next request; protocol and embedded credentials are rejected at each hop | `workers/knowledge/src/web-fetch.test.ts` (7 pass), including private redirect cases for extract/download | Focused pass complete |
| Download memory bounds | Text download truncation and binary hard limit are enforced while streaming; oversized response stream is cancelled at the cap | `workers/knowledge/src/web-fetch.test.ts` (7 pass), `tests/unit/web-download-binary-route.test.ts` (7 pass) | Focused pass complete |
| JWT boundary | Oversized and malformed base64url tokens normalize to AuthError; claims shape is checked; expiration at the current second is expired | `tests/unit/packages/auth.test.ts` (13 pass) | Focused pass complete |

The follow-up targeted suites passed **74 tests** total across six files: 7 knowledge-worker web-fetch tests, 13 auth tests, 32 security tests, 11 MCP SSRF tests, 7 download-route tests, and 4 content-moderation route tests.

### Follow-up defects fixed

1. The shared SSRF check treated IPv4-mapped private IPv6 addresses such as `::ffff:7f00:1` as public and did not reject several special-use address ranges. Address parsing now handles mapped/NAT64 addresses and only permits IPv6 global-unicast space outside reserved prefixes. DNS answers with no parseable IP address fail closed.
2. `/internal/web-search/extract` and `/internal/web-search/download` followed redirects without authorizing each destination. They now use the same bounded manual-redirect path as `/fetch`, checking each target before dispatch and rejecting non-HTTP(S), credentialed, and over-limit redirects.
3. `/internal/web-search/download` read the whole response into memory before checking its size. It now streams up to the text/binary cap and cancels oversized bodies.
4. JWT verification accepted `exp` equal to the current second, propagated low-level parsing exceptions for malformed three-part tokens, and did not validate required identity claim fields. These cases now reject as `AuthError` with an expiry or invalid-token code.
5. A content-moderation route test expected a prompt-injection attempt to proceed to the Space lookup, contradicting the route's generic quarantine response. Updated it to assert the generic 400 and prove the planner/agent DO receives no run.

TypeScript checks passed for `packages/auth`, `packages/security`, and `workers/knowledge`. The configured package/worker workspace passes with 217 files and 884 tests. The separate root Vitest config still has the incomplete run described below; those failures were not triaged against a clean baseline.

## Webhook package file stress pass (2026-10-18)

This is one bounded package pass, not a repository-wide closeout. The per-file checklist now marks only the files below as reviewed. Source references were searched across workers, packages, and tests: no in-repository production caller of the `@naelao/webhooks` delivery/ingress/replay functions was found; `workers/notifications` has a separate webhook implementation. The package is still retained because public/package consumers outside this repository are not known.

| File | Features and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/webhooks/package.json`, `packages/webhooks/tsconfig.json`, `packages/webhooks/vitest.config.ts` | Package exports/dependency graph, build/typecheck inputs, test discovery | Added the missing Vitest project config; before this, `vitest.workspace.ts` did not include package tests. Package typecheck passed and the workspace now discovers this package. |
| `packages/webhooks/src/index.ts` | HMAC header grammar/timestamp/tolerance, enqueue SQL binding, persisted retry counts and delays, private URLs, redirect hops, response-body disposal, terminal state | Fixed permissive signature parsing; aligned D1 statements with `infra/migrations/0016_webhook_subscriptions.sql`; corrected retry delay indexing; validates SSRF for each manually handled redirect; invalid/private targets fail closed. Covered by 8 `index.test.ts` cases and 11 `tests/unit/packages/webhooks.test.ts` cases. |
| `packages/webhooks/src/ingress.ts` and `ingress.test.ts` | Stripe/GitHub/Shopify signatures, raw-byte preservation, numeric Stripe timestamp and freshness, declared/streamed payload cap, one-read handling, tombstones, dispatch availability, archived-header secrecy | Added bounded streaming body reads, raw-byte HMAC input, strict timestamp parsing, and an allowlist for archived headers. Tests cover valid/wrong secrets, invalid timestamps, size rejection, tombstones, secret-header exclusion, and dispatch. |
| `packages/webhooks/src/lenient-zod.ts` and `lenient-zod.test.ts` | Boolean false/true as booleans, strings and numeric values; unknown values; provider-added fields; malformed fallback | Fixed `z.coerce.boolean()` treating the string `"false"` as true. 11 cases pass. |
| `packages/webhooks/src/replay-lake.ts` and `replay-lake.test.ts` | Space/provider-scoped exact R2 lookup, missing scope/provider, required authorization callback, denied/throwing auth behavior, key/object scope mismatch, queue dispatch | Removed global bucket scan; replay now requires explicit space/provider scope plus an authorization hook, checks stored object identity, and fails closed without authorization. Four cases pass. No runtime route mounting this helper was found in the repository search. |
| `packages/webhooks/src/schema-repair.ts` and `schema-repair.test.ts` | Already-valid input, malformed AI JSON, AI output schema mismatch, bounded request/response JSON | Added a 64 KiB cap before sending repair input to AI and before parsing model output; Zod validation remains mandatory. Three cases pass. |
| `infra/migrations/0016_webhook_subscriptions.sql` | Compared delivery insert/update statements and state columns with the deployed schema | Found and fixed package SQL references to absent `tenant_id`, `payload`, `updated_at`, and `last_error` columns; updates now use declared delivery columns. |

The webhook package suite passed **39 tests across five files**; the separate legacy webhook unit file passed **11 tests**. Package TypeScript and focused Biome checks passed. The configured full workspace suite passed with the webhook project registered: **222 test files, 923 tests**.

### Remaining webhook risks and unverified behavior

- DNS classification and the subsequent `fetch()` are separate resolutions, so DNS rebinding remains possible without egress pinning/proxy support.
- D1 delivery persistence and queue publication are separate operations. An uncertain queue send can leave a pending delivery or produce duplicate dispatch; there is no transactional outbox/claim protocol in this package.
- Replay authorization is supplied by the eventual caller through `authorizeWebhookReplay`; no production route wiring was found to verify that callback is bound to the authenticated principal and current space.
- Tests use stubs; live D1 constraints, R2 retention/permissions, queue redelivery, concurrent duplicate delivery, and provider network behavior were not exercised.
- `packages/webhooks` includes existing source with no internal production callsites; external package consumers and deployment wiring remain unverified.

## Idempotency D1 and expiry stress pass (2026-10-18)

The batch covers the `@naelao/idempotency` adapter, its table migration, package tests, and the sweeper's idempotency cleanup function. Repository references show no production caller of `D1IdempotencyStore` or `withIdempotency`; the available legacy test uses an in-memory mock. The table is referenced by the daily sweeper. No external consumers are known.

| File | Features and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/idempotency/src/index.ts` | Tenant/key identity, TTL bounds, migration column names/status mapping, atomic insert/expired-key replacement, cached response serialization, request-hash reuse, DB failure propagation, check/lock race, result status/body validity | Reworked the D1 adapter to match migration 0017 (`id`, `locked`, `response_json`, `request_hash`); tenant/key tuples map to hashed IDs; expiry uses `julianday`; only an expired record can be atomically replaced; a lost check/lock race rechecks for a completed result. Errors now remain errors instead of being treated as uniqueness conflicts. |
| `infra/migrations/0017_idempotency_keys.sql` | Compared the actual schema and constraints with every adapter query | Confirmed the old adapter referred to columns/statuses absent from this table; the adapter now uses the declared schema. No migration change was needed. |
| `packages/idempotency/package.json`, `tsconfig.json`, `vitest.config.ts` | Package build/typecheck and test discovery | Added package test script/config and registered the source tests in the workspace; the package previously had no test project. Typecheck passed. |
| `packages/idempotency/src/index.test.ts` | D1 SQL/schema contract, tenant-separated storage IDs, expired duplicate upsert condition, TTL bounds, response mapping, request hash mismatch, race-to-cache, unserializable result | 12 focused tests pass. These use D1 stubs; they do not replace a live SQLite/D1 integration test. |
| `tests/unit/packages/idempotency.test.ts` | Existing execute/cache/pending/failure/tenant behavior using the in-memory implementation | 9 tests pass after the adapter/API changes. |
| `workers/sweeper/src/index.ts` (partial function review) | Expired ISO timestamp comparison in the daily cleanup query | Replaced lexicographic comparison against SQLite's space-separated datetime with `julianday` comparison. The rest of this worker file remains pending review. |
| `workers/sweeper/src/index.test.ts`, `workers/sweeper/package.json`, `workers/sweeper/vitest.config.ts` | Cleanup query shape/affected-row count and package test discovery | Added one cleanup regression test and registered the worker test project. The worker TypeScript check passed. |

This batch's focused tests passed **24 tests** (14 package D1 tests, 9 legacy unit tests, 1 sweeper cleanup test). Focused Biome checks passed on the idempotency package and test/config files. The touched sweeper source still has pre-existing Biome diagnostics elsewhere in the file; it was kept to the one-line expiry fix rather than reformatted wholesale. The configured workspace suite passed with both projects registered: **224 test files, 938 tests**.

### Remaining idempotency risks

- No real D1/SQLite integration or concurrent transaction test has run; the new SQL contract tests use a stub.
- An execution lasting beyond its TTL can overlap a second execution after its expired lock is replaced; a fencing token/heartbeat or downstream idempotency is needed to guarantee at-most-once side effects.
- The optional `requestHash` must be supplied by callers to detect same-key/different-request reuse; no in-repository runtime caller was found to verify this wiring.
- The sweeper cron runs daily, so physical deletion can lag expiry by nearly a day even though reads and lock replacement enforce expiry directly.
- Full worker sweeper behavior, other cleanup functions, deployment bindings, and route-to-store wiring remain unreviewed.

## Auth RBAC stress pass (2026-10-18)

The auth package exports JWT verification and a static role-permission matrix. Repository search found no production callsites of `hasPermission`/`assertPermission`; the existing tests were only in `tests/unit`, outside the configured package/worker workspace.

| File | Feature / boundaries | Evidence / disposition |
|---|---|---|
| `packages/auth/src/rbac.ts` | Owner/admin/editor/viewer distinctions; product-end-user and agent zero-permission roles; malformed runtime roles and permission strings; assertion-before-action behavior | Existing matrix checked against role definitions. Runtime unknown role/permission values fail closed. Added 9 stress cases in `src/rbac.test.ts`. No source defect reproduced in this file. |
| `packages/auth/src/index.ts` | Public source exports | Verified both JWT and RBAC modules are exported. |
| `packages/auth/package.json`, `tsconfig.json`, `vitest.config.ts` | Package build/typecheck inputs and configured test discovery | Added test script/config; included existing root auth suite in this package project so it runs in the configured workspace. Package typecheck passed. |
| `packages/auth/src/jwt.ts`, `tests/unit/packages/auth.test.ts` | JWT claim shape, strict decoding, expiration equality, oversized and malformed tokens, role checks | JWT fixes from the earlier security pass remain covered. The legacy auth suite (13 tests) and new RBAC suite (9 tests) pass together: 22 tests. |

Focused Biome checks passed on the added test/config files. No route-to-RBAC callsite was found, so enforcement relies on other worker-local policy layers; validating every route's independent authorization remains open. The configured workspace suite passed with the auth project registered: **226 test files, 960 tests**.

## Crypto package stress pass (2026-10-18)

This bounded review covered the crypto package exports and in-repository consumers found by search: credential encryption (`workers/credentials`), encrypted tool output (`workers/agents/src/script-engine/tool-output.ts`), and HMAC-based Durable Object naming throughout `workers/spaces` and `workers/agents`. The package's legacy tests were previously outside the configured workspace, so a package Vitest project now runs both legacy and new source tests.

| File | Features and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/crypto/src/index.ts` | PBKDF2 metadata verification, malformed hex/base64, AES-GCM envelopes and authenticated metadata, wrapped DEK framing, key lengths, HMAC signatures, large byte-to-base64 conversion, key derivation scope | Rejects noncanonical/attacker-controlled password metadata before derivation, malformed envelopes and encodings, invalid key sizes, absent key scope, and oversized password/plaintext/AAD. HMAC verification validates exact hex signatures. Large base64 conversion now chunks input. |
| `packages/crypto/src/index.test.ts` | Invalid iterations/algorithm/salt/hash; malformed signatures; invalid DEK/wrapped-DEK formats; algorithm/IV/tag/AAD mismatch; 1 MB payload; tenant/space key separation | 6 new focused tests pass. |
| `packages/crypto/package.json`, `packages/crypto/tsconfig.json`, `packages/crypto/vitest.config.ts` | Build/typecheck inputs, test dependency/configuration, discovery of legacy package tests | Added Vitest script/dependency and workspace config. Package typecheck passes. |
| `tests/unit/packages/crypto.test.ts` | Existing hashing, encrypt/decrypt, wrap/unwrap, HMAC, and derivation round trips | 15 existing tests pass in the crypto package project. |

The focused crypto project passed **21 tests across 2 files**; focused TypeScript and Biome checks passed. The configured workspace passed with **228 test files and 981 tests**.

### Remaining crypto risks and unverified behavior

- PBKDF2 verification is fixed to the stored 100,000-iteration Workers ceiling. Raising this requires a format/version migration and Worker runtime compatibility test.
- `deriveKek` uses PBKDF2 with one iteration as a deterministic tenant scoping function; the platform secret must carry strong entropy and be rotated deliberately. This does not replace a managed KMS/HSM.
- Stress tests use Node WebCrypto and mocks; Cloudflare Workers crypto limits, D1/R2 persistence, key rotation, and live ciphertext compatibility were not exercised.
- Durable Object names include caller-supplied type/resource identifiers; their production validation and Cloudflare name length constraints belong to the caller/runtime boundary and remain to be reviewed.
- Plaintext and authenticated metadata are capped in this library, but full production payload-size distributions and migration impact are not measured.

## DB migration stress pass (2026-10-18)

This pass covered package exports, SQL helper consumers, and migration initialization in `workers/spaces/src/do/SpaceDO.ts` and `ProductUserDO.ts`. Existing migration tests were outside the package workspace, so the DB package now registers both the package source stress tests and the existing SQLite migration suite.

| File | Features and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/db/src/migrate.ts` | Migration version validation, transaction rollback, replay behavior, statement splitting across comments/strings/trigger blocks, SQL execution diagnostics | Fixed a parser bug where `CASE ... END` inside a trigger was mistaken for the trigger terminator. The splitter now tracks CASE nesting and single/double/backtick/bracket quoting, including escaped closing delimiters, so semicolons in quoted identifiers are preserved. |
| `packages/db/src/migrate.test.ts` | Real SQLite trigger with CASE and multiple statements; semicolon inside a quoted table identifier | 2 new regression tests pass against the in-memory SQLite DO storage shim. |
| `packages/db/src/sql.ts`, `packages/db/src/sql.test.ts` | Bound positional argument forwarding, first-row and empty results, DB error propagation, write execution, sequential schema scripts and stop-on-error behavior | Corrected an inaccurate comment claiming the helpers enforced placeholder-only SQL. The helpers forward SQL and positional parameters unchanged; 5 tests cover the contract. |
| `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/vitest.config.ts` | Build/typecheck/test discovery and root test inclusion | Added package test script/config and Vitest dependency; tests are excluded from the package declaration build. Package TypeScript check passes. |
| `tests/unit/db-migrations.test.ts`, `workers/spaces/src/do/SpaceDO-migrations.test.ts` | Atomic migration rollback, replay, migration table behavior, production SpaceDO migration application | Existing DB suite passes (6 tests); SpaceDO migrations pass in the full configured workspace. |

Focused DB tests passed **13 tests across 3 files**. The configured workspace passed with **230 test files and 989 tests**. Focused Biome checks passed on the newly added test and Vitest config. The touched migration source retains pre-existing formatting/lint diagnostics; they were not mass-reformatted.

### Remaining DB risks and unverified behavior

- Transaction semantics use the Node SQLite shim; Cloudflare's actual `transactionSync()` behavior and migration lock contention were not exercised in a live Worker runtime.
- Existing migration versions are checked for duplicates and completeness, but the package has no persisted checksum to detect a historical migration body being edited after deployment.
- The helpers are covered directly, but every `queryAll`/`queryOne` callsite in the large SpaceDO and knowledge worker modules remains pending caller-by-caller review.
- The migration splitter covers SQLite's supported quote forms relevant to the tested statements; malformed unterminated quote/comment input relies on SQLite rejection and transaction rollback.

## HTTP shared package stress pass (2026-10-18)

The package is used by many workers for request IDs, CORS, internal HMAC authentication, JWT auth, cookie sessions, KV helpers, errors, and realtime events. Added a package Vitest project so these shared tests participate in the configured workspace.

| File | Feature and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/http/src/kv.ts` | Values around Cloudflare KV size thresholds, chunk assembly, UTF-8 boundaries, malformed/missing chunks, empty values, storage read failures | Fixed corruption when a 20 MiB chunk split a multibyte code point. Manifest keys/count/byte lengths are checked, missing chunks return a cache miss, empty values remain valid, and KV read errors propagate. Corrected the stale truncation comment. |
| `packages/http/src/cors.ts` | Allowed/disallowed origins, preflight, cache variation, immutable upstream response headers | Adds `Vary: Origin`; clones response headers before applying CORS to preserve proxied responses with immutable headers. |
| `packages/http/src/desk-drop-cookie.ts` | Cookie grammar/size, base64/JSON shape, token prefix, empty identity fields, invalid/expired timestamps | Requires canonical base64, nonempty identity fields, valid future expiry, and a bounded cookie value. |
| `packages/http/src/middleware.ts` | Internal and tunnel HMAC scope/freshness, duplicate/malformed token fields, request ID header safety | Strict timestamp/signature grammar is shared by both token verifiers; request IDs are bounded and restricted to safe characters before response reflection. Explicit 5xx `HttpError` messages and details are now logged server-side and masked from clients. |
| `packages/http/src/errors.ts` | Known error serialization and status/code factories; unexpected exception redaction | Confirms request IDs/details are preserved for `HttpError`; unexpected messages are masked in responses. |
| `packages/http/src/realtime.ts` | Scoped outbound request fields, missing binding/scope, upstream 503, network exception | Confirms this side effect remains best effort for HTTP and network failures. |
| `packages/http/src/index.ts`, `packages/http/package.json`, `packages/http/tsconfig.json`, `packages/http/vitest.config.ts` | Public exports, test discovery, package typecheck | Public export test passes; typecheck passes; seven source test files are registered. |

Focused HTTP tests passed **24 tests across 7 files**; package TypeScript and focused Biome checks passed. The configured workspace passed **238 test files and 1,017 tests**.

### Remaining HTTP risks and unverified behavior

- KV chunk operations are multi-write and not transactional; a failed write can leave orphan chunk keys. Existing data stored by older chunk writes may already contain replacement characters and cannot be reconstructed by this fix.
- Stress tests use an in-memory KV double and native Hono/Response behavior; Cloudflare KV quotas/TTL/consistency and Workers service-binding header immutability were not exercised in a deployed runtime.
- `jwtAuth` and `requireInternalHmac` have broad worker integration coverage but were not directly remounted in this package suite; route-by-route auth placement and every worker's secret binding remain pending.
- Realtime broadcast response bodies are intentionally ignored; retries/delivery guarantees and gateway auth configuration remain runtime concerns.

## Logger package stress pass (2026-10-18)

Repository-wide source search found no production imports of `@naelao/logger` or `createLogger`; the package is retained because package visibility does not rule out external consumers. Its PII scrubber and logger behavior are now registered and tested directly.

| File | Features and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/logger/src/index.ts` | Field-name redaction, PII text patterns, reserved structured fields, context propagation, level filtering, circular/deep/binary/large/BigInt values | Fixed case/format bypasses for compound secret keys, PII in log messages, caller overrides of core fields, and unbounded/cyclic values. Reserved fields now win over caller extras; values are scrubbed and bounded before JSON serialization. |
| `packages/logger/src/index.test.ts` | Camel-case and compound keys (`apiKey`, `openaiApiKey`, `refreshToken`, `phoneNumber`, `userEmail`), email/SSN/phone text, forged level/message/service/tenant/trace/timestamp, cycles/depth/bytes/long strings/BigInt, child logger level/context | 4 focused tests pass. |
| `packages/logger/package.json`, `packages/logger/tsconfig.json`, `packages/logger/vitest.config.ts` | Build/typecheck/test discovery | Added Vitest test script/dependency and package project; typecheck and Biome pass. |

The focused logger suite passed **4 tests**. The configured workspace passed **239 test files and 1,022 tests**.

### Remaining logger risks

- The free-text scrubber covers email, common phone, credit-card, and US SSN patterns; it is not a general secret detector and cannot guarantee removal of arbitrary credentials embedded in prose.
- No in-repository production callsites were found, so expected production field shapes and downstream log retention/redaction behavior remain unverified.

## LLM gateway package stress pass (2026-10-18)

Consumers found in `workers/agents/src/do/NaelaoAgentDO.ts`, `workers/knowledge/src/index.ts`, and `workers/agents/src/script-engine/sub-agent-output.ts`. The package now runs both its new source stress tests and the existing root unit suite in the configured workspace.

| File | Features and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/llm-gateway/src/gateway.ts` | Anthropic/CF Gateway endpoint construction, request validation/serialization, gateway-held credentials, retry and circuit behavior, non-streaming response size, SSE parsing/size/error paths, cache-control mutation, token budget, input/output moderation | Fixed gateway path component injection by encoding account/gateway IDs; streams now send `stream: true`; circuit state is isolated per endpoint; retries include 429 and remove abort listeners; request/response bodies are bounded; SSE supports CRLF, tracks thinking deltas, and surfaces provider error events; malformed budget values and moderation payloads fail closed. |
| `packages/llm-gateway/src/gateway.test.ts` | Gateway key/header behavior, invalid token limits, circuit isolation across gateway endpoints, split CRLF events, thinking token usage, SSE provider errors, cyclic budget payloads, oversized moderation input/output | 7 stress tests pass. |
| `packages/llm-gateway/src/types.ts`, `src/index.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts` | Request/response contracts, public exports, package typecheck and test discovery | Typecheck and focused Biome checks pass; added package test script/config. |
| `tests/unit/packages/llm-gateway.test.ts` | Existing prompt-jailbreak filters, system prompt leak checks, token budget estimates | 9 existing tests pass in the package project. |

Focused gateway tests passed **16 tests across 2 files**. The configured workspace passed **241 test files and 1,038 tests**.

### Remaining LLM gateway risks

- Provider retries use a fixed exponential schedule and do not honor `Retry-After`; circuit failure counts include individual attempts, not only failed logical calls.
- The circuit breaker key is the configured endpoint; direct Anthropic callers using that shared endpoint still share failure state.
- Streaming and body limits were exercised with native Fetch streams and stubs, not live Anthropic or Cloudflare AI Gateway traffic. Model-specific token ceilings, provider schema drift, and real prompt-cache billing behavior remain unverified.
- Token budgeting still uses the documented rough four-characters-per-token estimate; it is a planning heuristic, not a hard context-window guarantee.
- Input moderation remains a limited pattern filter and is not an authorization or prompt-injection proof.

## Moderation package stress pass (2026-10-18)

The package has no production callsites for `moderateImageHash` in this repository. The only implementation of `CsamHashChecker` is `StubCsamHashChecker`, which always returns false; no PhotoDNA/NCMEC integration is present, so image hash matching is not active moderation coverage.

| File | Features and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/moderation/src/index.ts` | PHI, prompt-injection, policy regex checks; full text pipeline; image SHA-256 checker contract | Text is capped at 1,000,000 UTF-16 code units. The aggregate pipeline rejects invalid or oversized input. Detector helpers skip malformed or oversized runtime values. Image hashing rejects non-byte inputs, inputs above 20 MiB, and missing checker implementations before hashing. Matching hashes are no longer copied into returned moderation details. |
| `packages/moderation/src/index.test.ts` | Boundary and result contract stress cases | 5 added tests cover classification/blocking, oversized text, hash privacy, oversized image rejection, and stub behavior. |
| `tests/unit/packages/moderation.test.ts` | Existing package contract cases | 18 existing tests registered in the package project; all pass. |
| `packages/moderation/package.json`, `tsconfig.json`, `vitest.config.ts` | Package scripts, typecheck, Vitest discovery | `tsc --noEmit` passes; focused Biome check passes. The workspace project now includes both package and existing unit tests. |

Focused moderation validation passed **23 tests across 2 files**. The configured workspace passed **243 test files and 1,061 tests**, including both moderation suites.

### Remaining moderation risks

- `detectPhi`, `detectPromptInjection`, and `detectPolicyViolations` are limited regex indicators, not comprehensive content screening. PHI flags remain medium confidence and do not block by themselves.
- Since only a false-returning checker stub exists and there are no production callers, the `csam_hash` path is contract-tested with a fake checker but is not connected to a real hash database.
- The image cap bounds bytes after they reach this function; upstream image downloads and decoded-image memory use require separate limits.

## RAG package stress pass (2026-10-18)

| File | Features and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/rag/src/chunk.ts` | Sentence/forced chunking, overlap and minimum-size behavior | Found and fixed a non-terminating forced split when the final slice overlapped the end. The short final slice is now retained without exceeding configured chunk size. Invalid/non-progressing size and overlap settings throw before processing. |
| `packages/rag/src/embed.ts` | Single/batch embedding response shape and model batch limit | Vectors must be non-empty and finite; batches reject malformed or inconsistent vectors. A 101-item batch test verifies 100+1 calls and no dropped values. |
| `packages/rag/src/semantic-cache.ts` | Similarity threshold, expiry and KV access | NaN/missing scores and missing, malformed, or expired expiries fail closed before KV reads. Threshold remains strictly greater than 0.96. |
| `packages/rag/src/vectorize.ts` | Permissioned query validation and bounded topK | Invalid vectors, role values/masks, and non-positive/non-integer topK are rejected before Vectorize calls; ACL filters are asserted by existing tests. |
| `packages/rag/src/hybrid.ts` | Dense/sparse RRF, live-grounding threshold, scoped cache and telemetry orchestration | Invalid confidence threshold, TTL, and result limit are rejected before adapter calls. Existing tests cover RRF and low-confidence web fallback. |
| `packages/rag/src/chunking.ts`, `citations.ts`, `envelope.ts`, `index.ts` | Markdown tables/headings, citation references/coordinates, XML escaping/hash, and exports | Existing focused tests cover table cohesion, citation numbering/forged coordinates, and retrieved-context boundary escaping; package TypeScript check passes. |
| `packages/rag/package.json`, `tsconfig.json`, `vitest.config.ts`; `batch05-*.test.ts`; `tests/unit/packages/rag.test.ts` | Scripts, typecheck, test discovery, regression and contract coverage | Focused package suite passed **23 tests across 4 files**. TypeScript and focused Biome checks passed. The configured workspace passed **247 test files and 1,084 tests** with the RAG project registered. |

### Remaining RAG risks

- The knowledge worker's semantic answer cache still filters Vectorize entries by `space_id` only. The regular grounded-result cache uses tenant, project, role, user, mode, and policy scope, but semantic-cache hit scope is narrower. Worker callsites and cache write routes need an end-to-end authorization pass before this can be called safe for private/project-specific answers.
- Embedding response shape and vector limits were tested with stubs; Cloudflare AI and Vectorize deployment behavior/model changes were not exercised live.
- `roleMask` is validated as an input but the Vectorize filter is expressed using `role`, visibility, and allowed-user metadata; writers/index metadata and route authorization still need review together.

## SDK package stress pass (2026-10-18)

| File | Features and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/sdk/src/canvas.ts` | Authenticated Gadget RPC, collaboration polling/events, audit polling, list pagination, JSON input/output | List limits are restricted to integers 1–100, cursors to non-negative safe integers, request bodies to 64 KiB, and response bodies to 1 MiB. Rejects happen before network requests for invalid inputs. |
| `packages/sdk/src/workflow.ts`, `testing.ts`, `channel.ts`, `index.ts` | Declarative workflow compilation, capability/reference validation, test harness, channel contract validation, and public exports | Existing workflow, offline-harness, and plan-contract tests run in the package project; TypeScript check passes. |
| `packages/sdk/package.json`, `tsconfig.json`, `vitest.config.ts`, tests | Package scripts, typecheck and test discovery | Focused SDK suite passed **17 tests across 4 files**, including 2 new boundary tests. Focused Biome check passes. |

### Remaining SDK risks

- `apiBaseUrl` is caller-configured and the client sends the result of `authorize()` to that URL. The host integrating this SDK must provide a trusted Naelao API origin; this package does not maintain a deployment-origin allowlist.
- Canvas response bodies are bounded by bytes but decoded as JSON before domain-level shape validation; malformed server payloads can still fail with JSON/type errors.
- Workflow compilation and mock-plan simulation are local synchronous helpers; very large caller-owned objects can consume memory before the generated 64 KiB source limit is evaluated.

## Security package partial stress pass (2026-10-18)

The package's registered source and existing unit tests now pass **98 tests across 20 files**, including existing capability-scope boundary and authorization-plan coverage. This partial pass has exercised bounded inputs across the modules listed below; the repository audit remains open.

| File | Features and stress boundaries exercised | Evidence / disposition |
|---|---|---|
| `packages/security/src/marketplace-conformance.ts` | Deterministic fixture validation and signed certificate canonicalization | Canonical serialization rejects cycles, depth above 64, non-JSON objects, and over 1,000,000 serialized characters. Certificate verification catches malformed artifact data and fails closed. Tests cover cycle, deep, oversized, signature, and fixture cases. |
| `packages/security/src/delegation.ts` | Cross-space capability and agent delegation token signing/verification | Claim identifiers cap at 256 characters, permissions at 64, signing secrets at 4,096 characters, and encoded tokens at 16,384 characters. Invalid/oversized tokens return null; boundary tests pass. |
| `packages/security/src/air-gap.ts` | Central network egress policy parsing and D1 lookup | Oversized policy JSON above 1,000,000 characters denies egress before JSON parsing; malformed, missing, or unavailable policy continues to fail closed. |
| `packages/security/src/data-residency.ts` | Durable Object namespace jurisdiction binding | Tests cover unset/global behavior, EU namespace wrapping, idempotence, optional bindings, and unsupported jurisdiction rejection. |
| `packages/security/src/headers.ts` | Browser response security headers middleware | Hono response test verifies HSTS, nosniff, frame, referrer, and CSP headers on successful response. CSP still allows inline scripts/styles and HTTPS images. |
| `packages/security/src/waf.ts` | Recursive JSON body scanning | Nested values beyond the depth cap now fail closed with `body_depth_exceeded`; strings above 1,000,000 characters fail closed before regex checks. Three new tests cover deep nesting, oversized values, and normal shallow inputs. |
| `packages/security/src/rate-limit-do.ts`, `rate-limit-policy.ts` | Rate-limit DO request parsing and policy bounds | Non-POST, malformed/oversized body, invalid limit, and invalid window requests return before DO SQL initialization. Limit is 1–100,000 and window is 1 second–24 hours; request bodies are capped at 4 KiB. Pure policy tests cover boundaries. |
| `packages/security/src/ssrf.ts` | DNS-over-HTTPS resolution and SSRF network checks | Hostnames above 253 characters, DNS responses above 64 KiB, and responses with more than 256 answers fail closed. Three tests cover oversized body, excessive answers, and invalid host length. DNS was stubbed. |
| `packages/security/src/egress-policy.ts` | Owner host grants, URL scheme/port checks, DNS policy and redirect origin | Host grants are exact, list length is capped at 1,000, and hostnames above 253 characters are dropped. Four tests cover host/scheme/port grants, private DNS answers, and same-origin redirects. |
| `packages/security/src/dlp.ts`, `blueprint-scrubber.ts`, `ephemeral-grant.ts` | Recursive egress scanning, credential scrubbing, and canonical parameter signing | Each recursive walk rejects cycles, nesting above 64, and over 1,000,000 input characters. DLP now scrubs sensitive strings in object keys as well as values. Three stress tests cover cyclic, deep, oversized values and invalid grant time. |
| `packages/security/src/write-guard.ts` | SQL/shell mutation inspection and Gatekeeper token signing/verification | Mutation strings above 1,000,000 characters fail closed; token and claim sizes are bounded before verification/signing. Tests cover quoted destructive keywords, oversize input, claim bounds, valid action/resource binding, and expiry. |
| `packages/security/src/audit.ts`, `blueprint-validator.ts` | Audit metadata/pagination and blueprint structure/security scoring | Audit pages are limited to 500 rows and 1,000,000 offset; metadata is capped at 64 KiB before D1 use. Blueprint validation rejects malformed structure, oversized project/file counts, non-finite tiers, and more than 1,000,000 scanned characters. Tests cover pagination, metadata, and malformed/oversized blueprints. |
| `packages/security/src/circuit-breaker.ts`, `knowledge-permissions.ts`, `secrets.ts` | Automation recursion headers, caller clearance, API key/password/CSRF checks | Hop counts must be canonical decimal and causal IDs are capped at 256 characters; circuit trip still blocks if logging/KV fails. Clearance validates role and bounded membership arrays. CSRF requires canonical timestamps/signatures and rejects tokens more than 30 seconds in the future; credential inputs are capped. |
| `packages/security/src/capability-policy.ts`, `index.ts`, `package.json`, `vitest.config.ts`, `tsconfig.json` | Scoped capability token and retrieval fences, public exports, project test discovery and typecheck | Existing security, capability-scope boundary, and plan authorization tests plus new stress cases are registered. Focused package tests passed 98/98 across 20 files; package TypeScript check and focused Biome checks pass. |

### Remaining security package risks

- `wafMiddleware` parses JSON before the recursive scanner, with no streaming/body-byte limit at this middleware boundary. The scanner string limit protects regex work after parsing, not JSON allocation. Malformed JSON is passed downstream for endpoint validation.
- Rate-limit parameter validation is directly unit-tested, but Durable Object SQL behavior was not exercised with a runtime storage harness, and no in-repository caller of `RateLimiterDO` was found.
- DNS response bounds were tested with Fetch stubs, not live Cloudflare DNS-over-HTTPS. DNS verification and the later outbound `fetch()` remain separate resolutions, leaving the previously documented rebinding window.

## Security gateway worker stress pass (2026-10-18)

The security gateway previously skipped its global rate limiter when `CF-Connecting-IP` matched a short private-address regex. That created an avoidable bypass if a private-looking source address reached the gateway, and the regex did not cover all private IPv6 forms. The bypass is removed: all connecting IP values now receive the global limiter. The worker also rejects non-2xx, malformed JSON, invalid `allowed`, and invalid retry-delay responses from the limiter as denied requests.

`workers/security-gateway/src/index.test.ts` has five tests covering private-looking IPs, limiter outages, malformed JSON, wrong response types, and invalid retry delay. The new security-gateway Vitest project passed **5/5 tests**; worker typecheck and focused Biome passed. The gateway's Cloudflare bindings and Wrangler deployment were not exercised live; `workers_dev = false` and the router-only reachability constraint still require deployment verification.

## Shared test utility stress pass (2026-10-18)

`packages/testing` currently has no code imports in the repository; its package docs identify it as a reusable test utility. The mock D1 UPDATE path previously counted matched rows without changing stored values, and the KV mock treated an entry as live at the exact expiry timestamp. UPDATE now applies bounded parameterized `column = ?` assignments while honoring bound WHERE filters; unsupported SET expressions throw. KV expiry now uses the expected inclusive deadline. Tests cover tenant-filtered updates, exact TTL expiry, and queue order/binding compatibility.

Focused shared-test-utility tests passed **4/4**, package typecheck and focused Biome checks pass. The new testing project is included in the workspace; its mocks remain intentionally partial SQL/KV/Queue doubles and must not be used as a substitute for SQLite/Cloudflare runtime integration tests. No production behavior depends on this package according to repository-wide import search.

## Dynamic tool runtime stress pass (2026-10-19)

Repository-wide import search found no in-repository consumers of `@naelao/tool-runtime`. The previously exported `getTool` and `deleteTool` methods fenced only by tenant and could return/delete a known tool ID from a different Space in the same tenant. Both now require the Space ID and query by ID, tenant, and Space. Tool input validation now checks own required fields, malformed schemas, supported primitive types (including integer/number behavior), `additionalProperties: false`, 512-field and 1,000,000-character input limits, and cyclic serialization failure.

Three focused tests cover validation and tenant/Space fencing. The package typecheck and Biome checks pass. This validator intentionally supports a subset of JSON Schema; enum, pattern/format, nested properties/items, `$ref`, and combinators are not validated and must not be assumed to be enforced. The package had no production callsites when reviewed.
- Other security package callers and deployment bindings still need end-to-end review; focused module tests do not prove production DO, D1, DNS, or browser-policy behavior.

## Tracing package stress pass (2026-10-19)

`@naelao/tracing` has no direct in-repository consumers. Trace IDs and service names are now checked at tracer creation; injected trace IDs must be nonzero 32-character hex; span operation and parent IDs are bounded/validated. Span attributes reject reserved property names, invalid numbers, oversized keys/values, more than 64 attributes, and a serialized attribute payload above 12,000 characters. Error strings are truncated to the attribute value cap, span completion is idempotent, and negative duration from wall-clock movement is clamped to zero.

Three focused tests cover propagation, malformed identifiers, attribute limits, one-write behavior, and clock rollback. Focused tests, package typecheck, and Biome pass. Analytics Engine behavior is stubbed; no deployed dataset call was exercised. Action receipt signing/verification and production integration are still separate review items.

## Broader validation

| Check | Result | Evidence / limitation |
|---|---|---|
| Configured package/worker Vitest workspace | Passed: 286 test files, 1,258 tests, with webhook, idempotency, sweeper, auth, crypto, DB, HTTP, logger, LLM gateway, moderation, RAG, SDK, security, security-gateway, shared testing, tool-runtime, and tracing projects registered | `node_modules/.bin/vitest run --workspace vitest.workspace.ts` (2026-10-20) |
| Root TypeScript projects | Passed | `tsc --noEmit -p packages/agent-sdk/tsconfig.json` and `tsc --noEmit -p workers/agents/tsconfig.json` |
| Follow-up TypeScript projects | Passed | `packages/auth`, `packages/security`, and `workers/knowledge` |
| Follow-up focused Biome check | Passed: 6 files | JWT/SSRF source and their focused tests/route fixtures |
| Root Vitest config (`tests/vitest.config.ts`) | Completed: 655 files; 559 passed, 96 failed; 4,862 tests; 4,474 passed, 388 failed; 1 unhandled error | The completed run exposed a mixed legacy harness with stale planner/tool expectations, missing R2 `head`/DO bindings, incomplete SQLite schemas, old auth request fixtures, changed API contracts, a missing Shell alias import, and other failures. The root suite is not a clean baseline and these failures are not all confirmed production defects; they remain open until grouped and updated against current contracts. The configured package workspace separately passed its current registered tests. |
| Root `corepack pnpm test` wrapper | Failed before tests completed because Turbo launched parallel pnpm install subprocesses whose package fetches failed with `EAI_AGAIN`; the command was interrupted, with no tracked lockfile changes | Direct configured Vitest workspace run above completed successfully; root wrapper/install networking remains an environment limitation. |
| Biome on changed files | Failed with 124 diagnostics across 19 files; the three new worker-capability/transcript files pass a focused check after formatting | Remaining diagnostics include non-null assertions, formatting, and other style issues across the changed files. They were not mass-fixed because this would reformat unrelated surrounding code. |

Fresh workspace validation after the 2026-10-20 WAF and channel-attachment follow-ups passed 290 test files / 1,274 tests (`node_modules/.bin/vitest run --workspace vitest.workspace.ts`). This includes the updated 133-file / 558-test Agents Worker suite. It remains unit/in-memory evidence and does not exercise deployed Cloudflare resources or live provider accounts.

## OpenRouter Decisions API response bound (2026-10-20)

The System One client bounded request context but parsed OpenRouter Decisions responses with unbounded `response.json()` and read unbounded HTTP error text. Both single- and multi-question success paths now read at most 1 MiB, while error bodies cap at 8 KiB and surfaced detail is truncated to 200 characters. Limits apply to actual stream bytes even when Content-Length is missing or understated. Regressions cover both streamed success and error overflow. Agent SDK focused tests passed (20 fast-decision cases), SDK typecheck passed, and `git diff --check` passed. The configured full workspace run above predates these SDK changes. No live OpenRouter request was made.

The same bounded-response review found the project-to-project MCP client parsed arbitrary JSON result bodies. It now applies a 1 MiB streaming cap and rejects oversized or malformed responses before returning tool results. Its regression tests the missing-Content-Length overflow case. The full Agent SDK suite passed 24 files / 111 tests after both client changes, SDK typecheck passed, and `git diff --check` passed. No live inter-project MCP request was made.

The Artifact Repository SDK client also parsed unbounded successful JSON and read full error bodies into exception messages. Successful responses now have a 16 MiB streamed cap; error reads stop at 8 KiB and diagnostics include at most 200 characters. Tests cover valid results, streamed overflow without Content-Length, and oversized error bodies. Agent SDK suite passed 25 files / 114 tests; SDK typecheck and `git diff --check` passed. No live Artifact Worker binding was exercised.

Continued response parsing audit found two more unbounded allocations: the OpenRouter public model catalog called `response.text()` before checking its 8 MiB limit, and the universal model client accumulated SSE and non-stream bodies without a total byte ceiling. Catalog JSON is now read under its existing 8 MiB cap; universal model replies enforce a 16 MiB cap for both streaming and non-streaming bodies, and an oversize SSE fails rather than returning a partial answer. The catalog suite passed 6/6; the two new root-config streaming stress cases passed; Workers/Agents typecheck and `git diff --check` passed. The full root reasoner-streaming suite initially showed seven stale fixtures using retired `answer`/`run` wrapper tools; fixtures were updated to current plain-text/direct-operation contract and all 29 tests now pass. Biome on the large legacy AI and streaming files continues to report pre-existing diagnostics; no broad formatting rewrite was applied. No live provider response was tested.

The full legacy root config has now completed rather than timing out: 655 files, 559 passing and 96 failing; 4,862 tests, 4,474 passing and 388 failing, plus one unhandled error. Failures span stale planner schemas, missing mock APIs/bindings/migrations, obsolete authorization fixtures, and unrelated old route assertions; one Shell import alias fails before tests collect. This suite remains an open harness/triage workstream, and its failures are not assumed to be production defects without case-by-case reproduction.

Browser `see` previously called `arrayBuffer()` before checking its 4 MiB screenshot cap. It now reads the service response incrementally, rejects streamed or declared over-limit images before retaining the full body, and handles unavailable image streams explicitly. Browser screenshot byte-bound tests passed 2/2, Agents typecheck and `git diff --check` passed. The three SDK decoders also now set the Workers-compatible `ignoreBOM` option; both SDK and Agents typechecks passed after that compatibility fix.

The adjacent container virtual-display screenshot adapter also called `arrayBuffer()` on container output. It now enforces a 16 MiB stream cap matching the container screenshot command's existing maxBuffer ceiling. Added an unknown-Content-Length overflow regression; Launchpad runtime suite passed 13/13, Agent SDK typecheck and `git diff --check` passed.

Durable extension workflow release verification accumulated listed artifact bodies before checking its 2 MiB total. It now rejects from R2 listing-size metadata before fetching a file that would exceed the total, confirms fetched object size still matches listing metadata, and verifies decoded UTF-8 bytes before hashing. Regression proves an oversized artifact is rejected without `get()`. Workflow extension scope suite passed 6/6, Agents typecheck and `git diff --check` passed.

Before validation, the pnpm 11 install tool rewrote lockfile patch metadata and added an ignored-build policy block. Both repository files were restored to their original committed contents after dependencies installed. `node_modules` is ignored. `git diff --check` is run before commit.

## Not yet reviewed

This is still a partial audit. DNS verification and the later Workers `fetch()` are separate resolutions, so a hostile hostname can theoretically rebind between the SSRF check and socket connection. Preventing that race needs an egress proxy or a runtime API that pins the verified address; this pass does not claim to eliminate it. Other SSRF consumers (including browser and MCP call-time networking), shared foundations, non-focused worker routes/DOs/container paths, runtime deployment wiring, and indirect/dynamic dispatch remain to be reviewed. The root Vitest failures need triage by owner and a clean baseline run. No legacy file deletion has been authorized by evidence; none was deleted in this pass.

## WAF JSON body memory bound (2026-10-20)

The WAF previously parsed arbitrary-size JSON before applying its recursive scanner's string and depth limits. It now inspects a cloned request body with a 1 MiB byte ceiling before JSON parsing, rejects over-limit JSON with HTTP 413, and preserves the original body for downstream handlers. The stream limit is enforced even when Content-Length is absent or understated. If the JSON stream is locked or cannot be cloned for inspection, the middleware now fails closed with HTTP 503. Malformed JSON that was successfully inspected still reaches endpoint validation. Focused streamed-body tests and the full security package passed (20 files / 103 tests); the package TypeScript check and Biome checks passed. The refreshed full configured workspace passed 286 files / 1,258 tests before the additional fail-closed regression was added; the 8-test WAF stress file and all 103 security package tests passed afterward. No deployed Worker test was run.

## Chat attachment upload request bounds (2026-10-20)


## Channel provider metadata response bounds (2026-10-20)

WhatsApp Graph, Telegram getFile, and Slack files.info metadata previously used unbounded `Response.json()` before declared media-size checks. They now share a streaming JSON reader capped at 256 KiB and reject malformed/non-object data; Telegram file paths are also capped at 1,024 characters. WhatsApp voice transcription's metadata request now disables redirects. Slack/Discord attachment arrays are sliced to five references before mapping. Focused provider media and bounded-reader tests passed (17 tests), Agents Worker typecheck and changed-file Biome checks passed, the full Agents suite passed (131 files / 550 tests), and `git diff --check` passed. No live provider call was run. This does not verify provider credential revocation, deployment networking, or every media parsing/model invocation path.

Provider download URL review found that some host allowlists accepted non-standard HTTPS ports. WhatsApp Graph CDN, Twilio API, Slack file, and Discord CDN URLs now reject explicit ports; focused WhatsApp/Slack/Discord port regressions passed (12 tests including adjacent media cases), and Agents Worker typecheck plus `git diff --check` passed. Biome reports pre-existing whole-file style/format diagnostics in the large media test files; no broad reformat was applied.

## Chat attachment session and project authorization (2026-10-20)

The upload/list/delete routes previously checked Space membership but did not verify the product user's ownership of the addressed conversation, and accepted a caller-selected project prefix. They now resolve the SpaceDO compact-scope contract with signed caller identity, reject inaccessible sessions/private scratchpads, confirm the canonical linked project is accessible, and use only that project as the R2 prefix. Chat-run attachment indexing uses the same canonical scope and rejects a conflicting body project ID. Added scope tests for canonical project lookup, session denial, private scratchpads, inaccessible projects, malformed scope, and signed identity headers; route-level tests verify foreign-session denial before R2, rejection of a conflicting multipart project prefix, and successful multipart upload to the canonical R2 prefix. Agents typecheck passed; full Agents suite passed (132 files / 552 tests) before the route tests were extended; the final route suite passed 3/3; focused Biome and `git diff --check` passed. No deployed Spaces/Agents call was run. Downstream project-scoped attachment consumers still need review.

## Telegram attachment aggregate download bound (2026-10-20)

Telegram previously allowed up to five individual 5 MiB files to be downloaded before the shared store rejected aggregate payloads above 15 MiB. The downloader now preflights each declared size against a 15 MiB running total, bounds unknown-size streams by the remaining aggregate allowance, and rejects another file at metadata lookup if no budget remains. Invalid values below the documented unknown sentinel are rejected. Regressions verify both declared and unknown-size fourth files are rejected before download after three 5 MiB attachments. Telegram suite passed 4/4; Agents typecheck passed; focused Biome and `git diff --check` passed. No live Bot API call was made.

The same review found Twilio WhatsApp media checked the 15 MiB aggregate only after buffering each individual file. Its downloader now rejects another fetch at an exhausted aggregate and bounds each response stream by the remaining aggregate bytes (and declared Content-Length when available). A regression confirms the fourth 5 MiB fetch is never started after three files; WhatsApp media suite passed 8/8, Agents typecheck and `git diff --check` passed. No Twilio request was made.

After these media changes, the full Agents Worker suite passed 133 files / 558 tests. This is the current Agents package suite result, not a full monorepo or deployed-runtime result.

## Provider and workflow response allocation bounds (2026-10-20)

The final voice/workflow response scan found Twilio number search and pricing buffered full provider bodies before enforcing byte caps; the generic subagent result path had no cap, and AgentTaskWorkflow buffered arbitrary failure responses. Added a shared UTF-8 reader that enforces a byte limit while streaming. Twilio search now returns a stable too-large/invalid response error; price lookup fails with its existing unavailable error; subagent error detail is capped to 8 KiB and result output to 2 MiB; AgentTaskWorkflow reads at most 256 KiB of error JSON before its existing parser. Workflow resume grant hashing now rejects agent R2 config files over 1 MiB based on object metadata and verifies actual UTF-8 size before hashing. Regressions cover stream overflow with no Content-Length, overlarge config metadata before `.text()`, and adjacent Twilio/workflow behaviors. Focused suite passed 5 files / 20 tests; Agents TypeScript check and `git diff --check` passed. `pnpm --filter` could not complete because the workspace's ignored-build approval policy aborts its automatic install; invoking the local TypeScript compiler directly succeeded. No live provider or deployed workflow request was made.

The same pass extended byte limits to OpenRouter entitlement preflight (64 KiB), Virtual CLI provider replies (1 MiB success / 8 KiB error), company automation step output (1 MiB), and workflow effect JSON results (4 MiB). These paths previously buffered whole responses or had no response limit. Virtual CLI added a streamed overflow regression; existing entitlement and workflow cases remain green. After updating two R2 mock fixtures to include real object-size metadata, the full Agents suite passed 135 files / 567 tests, Agents TypeScript check passed, focused Biome on the new shared reader passed, and `git diff --check` passed. Whole-file Biome checks on older touched files still report pre-existing formatting/style diagnostics; no broad reformat was applied. No live provider, service binding, or deployed workflow request was made.

## Inbound body allocation bounds (2026-10-20)

Agents signed Twilio callbacks, connector/channel webhooks, WhatsApp/Telegram extension webhooks, AgentMail webhooks, and tunnel enrollment previously called `.text()` before applying or without a byte limit. They now stream under a 16 KiB Twilio or 1 MiB external webhook cap; tunnel enrollment/authentication use 32 KiB. The Agents Worker entry point also enforces a 4 MiB cap on all JSON request bodies before routing, covering every `c.req.json()` parser. The assistant inline file route checks R2 head metadata before reading and the shared R2 CAS reader can reject before downloading; artifact viewer success/error responses are now streamed under 2 MiB / 8 KiB. Regressions cover streamed request overflow, oversized tunnel enrollment and JSON entry-point rejection, plus R2 refusal before `get()`. Agents suite passed 136 files / 571 tests, Agents typecheck passed, router transcription suite passed 3/3, router typecheck passed, and `git diff --check` passed. The pre-existing root harness failure totals remain separately documented. No live provider or deployment was exercised.

Router stress review also found dictation body caps were enforced only after `request.formData()` or `arrayBuffer()`. `transcribeAudio` now incrementally reads under its existing 10 MiB cap before multipart parsing and bounds transcript text returned to callers. A no-Content-Length stream over the cap is rejected before Workers AI; router suite passed 3/3 and router TypeScript check passed. Desk Drop request forwarding now streams into a 64 KiB bounded reader before proxying instead of copying arbitrary input with `arrayBuffer()`.

The Router ingress test now also proves an oversized Desk Drop body returns 413 before calling Spaces. Focused bounded-ingress and transcription tests pass 4/4; the full Router suite passed 8 files / 39 tests. Router TypeScript check and Biome checks on new request-reader/test files passed. No provider or deployment calls were made.

## Knowledge and workflow response bounds (2026-10-20)

Continued the response-allocation sweep into Knowledge, Threads and Workflows. Added shared `@naelao/http` streaming text/JSON readers with UTF-8 validation and a caller-supplied byte ceiling. Cohere Parse responses now cap at 16 MiB; Tavily search/extract responses at 4 MiB; thread summary responses at 64 KiB; QueueHealth GraphQL at 1 MiB. Workflow error responses now retain at most 8 KiB for 300-character diagnostics, and KB ingestion rechecks the staged R2 size/actual UTF-8 bytes before its second read. Package HTTP suite passed 8 files / 27 tests, Knowledge suite passed 6 files / 25 tests, HTTP package build/typecheck passed, and Knowledge/Workflows/Threads typechecks passed. No provider or deployed workflow request was made.

## Cross-worker request and response bounds (2026-10-20)

Added a reusable streaming request reader to `@naelao/http` (Content-Length preflight plus actual-byte enforcement, with no request clone) and extended its tests. Artifact uploads now cap at 7 MiB before multipart/JSON parsing; the streamed no-Content-Length regression returns 413 without an R2 write. Browser request JSON caps at 32 KiB; Spaces dynamic-page and gadget-MCP proxy bodies cap at 1 MiB (collaboration initialization uses 4.5 KiB); Billing webhooks cap at 1 MiB; Channels generic webhook bodies cap at 1 MiB. Spaces raw task/document lease forwarding now caps at 1 MiB and maps oversize input to 413. Billing payout-approval errors and connector/portal/eval/MCP upstream diagnostics are streamed under 8 KiB and displayed at most 300 characters; Whop and Gumroad API JSON bodies cap at 1 MiB. Focused shared-reader and Artifact regressions passed 4/4 and 1/1; Artifact suite passed 3 files / 10 tests, Spaces focused suite passed 2 files / 15 tests, package and affected-worker typechecks passed, and `git diff --check` passed. The broader legacy root test failures documented above remain open and are not claimed as resolved. No live provider or deployed Worker request was made.

## Agent-tool and workspace body bounds (2026-10-20)

The provider response sweep extended to Provisioner service-binding errors and Agents' project, commerce, wallet, knowledge, conversation, web-search, artifact, task, schedule and other prebuilt APIs. Error bodies stream at most 8 KiB and expose no more than 300 characters; JSON result bodies cap at 2 MiB (web search at 4 MiB; artifact content at 2 MiB). Workspace R2 reads now verify returned byte length against R2 size metadata, ranged reads enforce the requested cap, sync skips objects whose listed size changed, and file-manager operations cap reads/writes at 1 MiB. Added stream/metadata mismatch regressions; updated an existing R2 test double to include the size metadata returned by real R2 objects. Agents full suite passed 137 files / 573 tests; Agents and Provisioner typechecks passed after rebuilding the local Agent SDK declarations; focused R2 tests passed 8/8; the new boundary test passes Biome. Whole-file Biome on legacy `file-manager.ts`, `r2-workspace.ts`, and `workspace.ts` still reports existing diagnostics and no broad formatting changes were applied. No live provider, service binding or deployment was exercised.

### Newly surfaced work queue

The next static scan still shows unbounded response parsing in Spaces extension setup and market-radar service bindings, Together AI, Analytics, Notifications, and parts of Agents' Durable Objects/workflow hosts. Some R2 reads have metadata checks but need an individual check that fetched bytes still match the listed size; request JSON parsing remains route-specific outside Workers with a body-limiting ingress wrapper. Continue the per-file review and add the affected routes to the plan before treating the audit as complete.

## Spaces, Analytics and model-provider follow-up (2026-10-20)

Spaces now applies an 8 MiB streamed body ceiling before routing any non-GET/HEAD request, including JSON routes that previously called `c.req.json()` directly; oversized bodies return 413 before route/DO work. Extension artifact immutability checks preflight R2 size and validate the fetched byte count. Workspace inline reads verify bytes against object metadata. Extension setup and market-radar service-binding JSON/errors are bounded (64 KiB/2 MiB success, 8 KiB errors with 300-character details). Together AI bounds non-stream replies to 16 MiB, errors to 8 KiB/300 characters, and streamed output to 16 MiB with declared-length preflight. Analytics Engine responses cap at 4 MiB and errors at 8 KiB/300 characters. APNs and Resend error bodies cap at 8 KiB/300 characters. Added Spaces ingress and Together AI response-boundary tests plus an Analytics response overflow regression. Spaces full suite passed 55 files / 184 tests; Agents full suite remains 137 files / 573; Together AI 2 tests, Analytics 2 tests, Notifications 13 focused tests passed. Spaces, Together AI, Analytics, Notifications TypeScript checks passed; `git diff --check` passed. Changed legacy test files have pre-existing whole-file formatter diagnostics; newly added boundary tests pass Biome. No live provider, deployment or production R2 object was exercised.

### Remaining queue after this slice

Static scan still finds response parsing and/or object reads needing per-sink bounds in Agents Durable Objects, workflow hosts, transcript loader, vault proxy, skill/config readers, Notifications success bodies, Together AI request ingress, and portions of Spaces DO internals (including archive decode and state-delta harness). Credentials, Billing, Analytics ingress, and remaining SpaceDO direct JSON ingress also need route-specific limits; Spaces' Worker wrapper covers requests entering that Worker but does not by itself bound direct Durable Object calls. Continue across those call sites and add stress tests where limits change externally visible behavior. This remains a partial audit, not a system-wide security sign-off.

## Direct Durable Object ingress and web-response bounds (2026-10-20)

Added a 4 MiB request ceiling at `NaelaoAgentDO.fetch` before initialization and route parsing, matching the Agents Worker's JSON ingress maximum. `ToolSandboxDO.fetch` now enforces 4 MiB before queueing execution and retains only non-screenshot results up to 2 MiB. `LocalTunnelDO` reads its command body under 64 KiB before JSON parsing and returns 413 for overflow. Agent `http_get` previously buffered the complete remote response and truncated only afterward; it now reads a 64 KiB prefix and cancels the rest before prompt-injection scanning. Added the shared prefix reader and a cancellation regression. Replaced several DO service-binding result/error parsers with 2 MiB success / 8 KiB error readers; project extension code now checks R2 size and actual bytes before decoding; workflow extension source does the same. HTTP bounded-reader suite passed 5/5, Agents DO/workflow focused tests passed 26/26, Agents typecheck passed, `git diff --check` passed, and changed shared/helper test files pass Biome. Whole-file Biome on large legacy DO/workflow files reports existing diagnostics; no broad reformat was applied. No live service, container, provider or deployment was exercised.

### Still open

NaelaoAgentDO still has several bounded-by-caller or route-specific `.json()` reads that need confirming against every service's response contract; not all have been converted yet. ToolSandbox direct output streaming, LocalTunnel WebSocket frames, SkillLibrary/agent config R2 reads, transcript-loader pages, credential and billing ingress, and SpaceDO archive/state-delta paths remain in the audit queue. The full root Vitest baseline failures above also remain unresolved.

## Agent DO, R2 skill/config, and ingress follow-up (2026-10-20)

Extended the response byte ceiling to remaining JSON responses parsed by `NaelaoAgentDO` (2 MiB each), changed the agent's HTTP tool to stream only a 64 KiB response prefix and cancel the remainder, and retained existing bounded direct-DO request behavior. Agent config and SkillLibrary R2 reads now preflight object sizes, verify actual bytes against metadata, decode UTF-8 strictly, and reject oversized writes (agent config 1 MiB; skill metadata 512 KiB; skill code 1 MiB). Transcript pages and Vault error details are also bounded. Credentials and Billing Worker entry points now cap streamed request bodies at 1 MiB and 4 MiB, respectively, before Hono routing. Added boundary tests for skill/config R2, transcript pages, Vault errors, and ingress overflow.

Validation: full Agents suite passed 139 files / 577 tests; Agents TypeScript check passed; focused script-engine regressions passed 15 tests; Credentials and Billing ingress tests each passed; new boundary test files pass Biome; `git diff --check` passed. Whole-file Biome checks still expose legacy diagnostics in older large files; no unrelated reformat was applied. No live service or deployment was exercised. Remaining audit targets include workflow response parsing, other workers' direct Durable Object ingress/state/archive paths, WebSocket frame limits, and root-harness failure triage. This is not a complete Naelao audit.

## Workflow and direct DO ingress follow-up (2026-10-20)

Workflow HTTP response parsing now has explicit byte ceilings: extension inventory and authorization grants (2 MiB), schedule creation and budget reservation identifiers (64 KiB), task-ledger reads (2 MiB), reminder lookup results (4 MiB plus a 1,000-event maximum), and outbound reminder call responses (64 KiB). SpaceDO now applies its 8 MiB streamed request cap even when invoked directly by a service binding, before migrations or route dispatch. TaskDO and HITLApprovalDO now likewise enforce 1 MiB and 2 MiB streamed request caps before initialization.

Validation: workflow regressions passed 15 tests; direct SpaceDO request-boundary test passed; TaskDO/HITLApprovalDO boundary tests passed 2/2; Agents and Spaces TypeScript checks passed; new DO boundary tests pass Biome; `git diff --check` passed. No deployment or live service was exercised. Remaining direct DO targets include the other Spaces DOs, BrowserSessionDO, RepositoryDO, RateLimitDO, and the remaining Agents DOs; separately, root-harness failure triage and live acceptance remain open.

## Additional direct DO ingress (2026-10-20)

ConcurrencyDO now caps command bodies at 1 MiB; RiskGuardDO at 64 KiB; Router RateLimitDO at 8 KiB; BrowserSessionDO at 1 MiB. These limits reject streamed bodies before JSON parsing and, where applicable, before DO migration work. Added direct overflow regressions for ConcurrencyDO, RiskGuardDO, and RateLimitDO. Agents ingress tests passed 2/2, Router ingress test passed 1/1, Agents/Router/Browser TypeScript checks passed, test-file Biome and `git diff --check` passed. Browser's package has no Vitest harness, so its integration boundary is typechecked but not locally exercised. Remaining DO ingress targets: the remaining Spaces DOs and RepositoryDO; then WebSocket messages and state/archive limits. No live runtime tests/deployment.

## Remaining DO request and archive allocation pass (2026-10-20)

Added direct request limits to all remaining Spaces DOs (BuilderAccount 256 KiB, FeatureFlag/ProductUser/TransactionCoordinator 1 MiB, Lock 16 KiB, MicroApp 4 MiB, SpaceTypeRegistry 2 MiB) and RepositoryDO (16 MiB before entering its serialized state gate). The conformance sandbox and its guest entrypoint previously read arbitrary streams with `.text()`/`.arrayBuffer()` before checking a character count; both now enforce 512 KiB during streaming, and UTF-8 decoding is strict. Encrypted Space archives are capped from R2 metadata at 16 MiB before `arrayBuffer()`, and fetched bytes must match object metadata; rewrap now reads its verified stored archive only once.

WebSocket text/binary messages are capped at 64 KiB before JSON parsing in NaelaoAgentDO and WsHubDO; oversized LocalTunnel frames close with code 1009. WsHubDO internal broadcasts are capped at 1 MiB. A 1-second container-duration test asserted an impossible strict `>=1000 ms` measurement despite the correct 1000 ms abort; its check now allows 900–1100 ms to cover timer/event-loop measurement variance while still detecting gross errors.

Validation: Agents full suite passed 141 files / 584 tests; Spaces full suite passed 57 / 194; Artifact full suite passed 4 / 11; Agents, Spaces, Artifact, Router, Browser, and ws-gateway typechecks passed in this work cycle. Focused direct DO/workflow tests and WebSocket/conformance tests passed; new boundary tests pass Biome; `git diff --check` passed. No live Cloudflare/provider deployment was exercised. The broad historical root Vitest suite has 96 failing files/388 tests and remains a separate case-by-case triage queue; full Naelao audit is still open.

## Behavior and test harness follow-up (2026-10-20)

Closed a route registration gap where `POST /spaces/:spaceId/members` fell through before its internal-token guard; collection and descendant paths now share the guarded handler and missing IDs return 404. Fixed strict UTF-8 decoder typing in Spaces. Scheduled goal wakes now include the same bounded wake-up brief as connector polls. Project-scoped channel messages now fail closed when project policy lookup fails, including ordinary messages and matched script actions. Updated test fixtures that had drifted from current business, workspace R2, launchpad, scheduled-job, and local-machine gateway contracts.

Validation: business routes (26), launchpad runtime (10), launchpad SpaceTypes (7), route backstops (17), project-policy fail-closed (6), scheduled wake brief (11), and local-machine/workspace scoping (19) passed: 96 tests across 8 files. Agents and Spaces TypeScript checks passed; `git diff --check` passed. A full root Vitest recheck is running to refresh the outstanding failure queue; no production deployment or external provider call was exercised. This does not complete the repository audit.

## Root-suite refresh and current-contract regressions (2026-10-20)

The refreshed configured root Vitest run discovered all 675 files and completed with 597 passing / 78 failing files, 4,622 passing / 294 failing tests, and 1 unhandled error. The prior refresh was 581 passing / 94 failing files and 4,541 passing / 376 failing tests; the comparison is useful for tracking, but the baseline includes stale fixtures and is not a clean production-code baseline. The JSON report used to produce the failure roster is a temporary workspace artifact, not audit evidence to retain in git. The remaining failing-file list is still large and is not closed by this batch.

This pass corrected the reasoner tool-call tests to exercise the current Bash/Read/Edit/AskUser planner schema instead of the retired native `run` action. Legacy JSON prose answers are now accepted as a compatibility path, while the live planner tool declaration stays unchanged. The sub-agent model test was brought in line with runtime-selected child models and now directly tests the cost-ceiling boundary; its former end-to-end fixture attempted an approval-gated Bash mutation without providing an approval service. The credential hierarchy test harness now applies migration 0082, which creates the per-space DEK table used by current encrypted credential storage. The assistant-file route fixture now supplies R2 `head()` and byte-consistent object metadata required by the route's size preflight.

Evidence: the current-contract worker-model/reasoner checks, credential hierarchy, assistant files, templates, approval gates, concurrency alarms, scheduled-job dispatch, and the earlier R2/configuration clusters passed together: 18 test files / 289 tests. Agents TypeScript and `git diff --check` passed after the fixtures were updated. The root result above predates this last fixture batch, so its 78 failing-suite count must be refreshed before using it as the current count. No deployment or live provider call was made. The full file-by-file review and triage of the remaining failures are still pending.

## Membership cache isolation and route fixtures (2026-10-20)

The business-role cache keyed entries only by `(spaceId, endUserId)`, even though it is process-global and survives requests for different tenant databases. Added tenant ID to both general-membership and wallet-membership cache keys, with a regression that primes an authorized entry for one tenant and verifies the same identifiers are denied in another tenant. This is a production authorization isolation fix. Several route fixtures were also updated to include the migrated `space_members` table and explicit direct root membership; production now intentionally requires a direct root membership and does not treat every product-root session as membership. Project visibility tests now explicitly request `visibility: "private"` where they exercise private ACL behavior; public remains the persisted creation default.

Refreshed model-override tests now distinguish statically shared model slugs from OpenRouter models, which require fresh catalog evidence before a run is dispatched. R2 and DO alarm fixtures were aligned with their current interfaces. Evidence: membership, wallet, onboarding, feature-kind, project ACL, model-override, project-wallet payer, and related route suites passed (12 files / 84 tests); Agents and Spaces TypeScript checks and `git diff --check` passed. This does not resolve the remaining code-runner compatibility suite or other root failures; the latest full root run predates these changes.

## Sandbox, knowledge isolation, uploads, and erasure regression refresh (2026-10-20)

Replaced the code-runner unit suite's retired `ctx.fetch`, `ctx.mcp`, `ctx.browser`, legacy loader and implicit Tier 6 expectations with the live contracts. The fake loader now executes the production `main.js` guest harness source and compiles the restricted guest, with only its static policy/guest imports linked. Coverage checks no ambient `ctx.fetch`, host-network denial, explicit scoped RPC grants, forbidden imports/dynamic code, actor/run/ceiling and host approval on containers, and browser authorization before service contact. Code-runner suite passed 11/11.

Aligned chat-upload fixtures with canonical SpaceDO compact-scope resolution and current R2 CAS behavior (including deletion tombstones). Corrected knowledge fixtures to include space compliance policy and use supported knowledge roles; added retrieval ACL metadata. Updated the product-user fixture to apply the canonical users and preferred-language migrations. Chat-upload passed 9/9, product-user auth passed 36/36, knowledge project isolation passed 5/5, owned-space knowledge search passed 2/2, and knowledge tenant isolation passed 4/4. A combined code-runner/chat-upload/product-user run passed 56/56. Agents, Knowledge, and Spaces TypeScript checks passed; `git diff --check` passed.

A new all-root unit run was started, but its detached Vitest process had not exited when this note was written; no refreshed root pass/fail count is claimed. Partial output showed additional fixture and behavior failures, including agent-loop and pricing tests; each requires individual triage. The whole-repository file-by-file audit and full cross-worker stress pass remain open. No deployment or live provider request was made.

Additional stale fixtures from that failure roster are now corrected: loop stress scripts supply required R2 compare-and-swap metadata and `expectedHash`, so 15-step execution, compaction, retained checkpoints, and progress are actually tested; the token estimate assertion now matches the conservative `ceil(chars / 3.85)` implementation. Pricing tests now include the direct product-root membership required for root-scoped end-user access. The action-ledger and continue tests now use the shared conditional-write R2 double, and distinguish a fresh action invocation from a successful second write to an existing CAS-protected file. End-user credit and session-budget fixtures now expose model-policy, monthly-refresh, alarm, and background-task methods. Verification: agent-loop (32), action ledger (6), continuation (5), credit gate (7), session budget (8), and pricing (19) passed: 77 tests across 6 files.

`turbo run test` was attempted for a fresh monorepo run, but package lifecycle hooks tried to install dependencies and network DNS failed; that run was interrupted before tests began. The direct Vitest workspace run completed with 683 files / 1,331 tests passing and no failures. Its sole initial failure was a missing `vi` import in the archive test, which is fixed. A subsequent focused run covering this audit tranche passed 151/151 across 13 files, including source/input/output limits for the sandbox. The prior 675-file root report belongs to a different invocation and is not treated as current. Full per-file audit and all-worker stress coverage are still open.

## Long-thread usage and conversation retrieval continuation (2026-10-20)

Found that the context-usage endpoint fetched only the newest 500 messages and silently undercounted older history. SpaceDO now returns a transcript-wide message count and content-character aggregate with each page; context usage requests one message and uses the aggregate, avoiding full transcript transfer. The response now reports `transcript_complete`; older page-only Spaces responses are labeled incomplete. The token estimate's category is explicitly marked estimated because character-to-token conversion is not exact. Compaction fixtures now follow current authenticated user, canonical session scope, membership, and session-DO routing.

Conversation search already had bounded 100-message paging, 10,000-message / 16 MiB scan ceilings, 20-result caps, and optional summarize/extract/compress chaining. Stress review found two edge cases: an invalid `before_id` silently fell back to the newest page, and a host-owned message exceeding the scan byte ceiling could be reported as an empty exhausted transcript. SpaceDO now exposes whether the requested cursor was applied (retaining the existing newest-page fallback for chat clients); conversation search rejects a stale cursor explicitly and reports an empty-but-incomplete byte-limited scan honestly.

Evidence: context-usage, compaction, and message-list-tail regressions passed (22 tests across 3 files); conversation prebuilt + virtual CLI tests passed (23 tests across 2 files); Spaces pagination/aggregate regression passed (1 test). Agents and Spaces typechecks passed; `git diff --check` passed. No live deployment or provider call was exercised. The full file-by-file audit and broader root failure triage remain open.

The shell context meter now shows when history size is incomplete and only auto-triggers maintenance after the backend confirms a complete transcript count. Manual maintenance remains available as an explicit user action. Shell TypeScript check passed. This closes the frontend propagation path for the new completeness state; live UI/browser verification remains unrun.

The bounded full-transcript loader used by automatic summarization now rejects an unapplied cursor and repeated page IDs instead of accepting duplicated or restarted history. Focused loader regressions cover both cases. Full worker suites after the thread usage/search changes passed Agents 141 files / 586 tests and Spaces 57 files / 194 tests. Shell, Agents, and Spaces typechecks passed. The root-wide audit remains active; these service suites do not cover browser acceptance, live bindings, or remaining worker and application surfaces.

## Context-meter authorization boundary follow-up (2026-10-20)

The context-usage endpoint verified only tenant ownership before returning per-session transcript size and tenant billing totals. It now also requires an authenticated user, canonical session scope, Space membership, and project membership for project-linked sessions; product end users are restricted to their own session and business role. Regression coverage denies missing identity, removed Space membership, and non-member access to a private project session. Focused context/compaction suites passed 17 tests and Agents TypeScript passed. The complete Agents/Spaces runs above predate this authorization-only follow-up; a targeted recheck was used here.

## Compaction prompt provenance hardening (2026-10-20)

The local fallback summarizer truncated each older message at 1,500 characters without marking the omission and omitted message IDs. It now includes source message IDs, explicit omitted-character counts, and an instruction to treat transcript text as untrusted data. This keeps prompt-injection text from being elevated to instructions and makes partial evidence visible in the summarization input. Regression, transcript paging, and conversation-compaction checks passed (11 tests); Agents TypeScript passed. The entire audit remains open.

## Decisions API error redaction (2026-10-20)

The OpenRouter Decisions client copied up to 200 characters from provider error bodies into thrown errors. A provider could echo request fragments, placing user conversation text or account metadata in logs. Both single and batched decision paths now expose only the HTTP status. Regressions verify prompt-like provider error text is absent. Agent SDK decision tests passed 21/21 and its TypeScript check passed. Decisions remain OpenRouter-only, Clef Flash is the ordinary route, and Decider is reserved for long-context overflow; no provider benchmark/live request was run in this pass.

## ScaleDown derivative-cache integrity (2026-10-20)

Fresh extraction output validates every entity span against the supplied source, but cache hits checked only the model name and bypassed those source-span validations. Cached summaries, extraction spans, compression output, and usage metadata now receive operation-specific schema/source validation before reuse; invalid entries are treated as misses and recomputed through the provider admission path. A regression corrupts a cached extraction span and verifies it is rejected and fetched again. ScaleDown and document-processing tests passed (12 tests); Agents TypeScript passed. No external provider request was made by these mocked tests.

## Message write isolation and serialized-page ceilings (2026-10-20)

The session message POST path did not apply the product end-user ownership filter used by GET/DELETE. Spaces now derives `end_user_id` for POST from verified claims, and SpaceDO checks that it matches the target session before writing. Authenticated callers are restricted to user-authored messages and cannot set assistant/agent authorship, tool fields, token counts, owner IDs, or internal message metadata. Message metadata is capped at 32 KiB, client idempotency keys at 256 characters, and tool identifiers are bounded.

A row-count-only GET cap could serialize 500 near-maximum messages into a 64 MiB response. SpaceDO now serializes pages under 1 MiB, trims only the oldest rows in the page, and returns `has_more` plus the exact `next_before_id`; transcript and conversation-search readers honor byte-trimmed short pages and continue without gaps. Regressions cover large pages, cursor continuity, stale cursor behavior, cross-user POST denial, forged authorship/metadata, and trusted internal attribution.

Validation: full Agents suite passed 141 files / 592 tests; full Spaces suite passed 57 / 195; product-shell + message-edit root tests passed 42/42; Agents and Spaces TypeScript checks passed; `git diff --check` passed. No production deployment or live load test was run. Remaining whole-repository checklist and root test failure triage continue.

## Delegated worker capability coverage (2026-10-20)

Traced the default-worker selector from planner spawn through the host-signed delegation contract to the child tool surface. The child correctly intersects enabled tools with its agent configuration and limits skills to the signed allowlist. The capability catalog did not cover several built-in worker families (browser/computer operations, language services, approvals, business diagnostics, Foundry intake, skill management, local-machine access, and customer support); these fell through to a first-nine standalone candidate list and could not be task-selected. Added explicit related-tool bundles and a catalog-completeness regression over every shipped non-planner prebuilt. Also hardened malformed Decisions API results to fall back safely rather than throwing during capability filtering.

Validation: worker-capability selector suite passed 7/7; Agents TypeScript check passed. `pnpm exec` attempted workspace dependency resolution and stalled on registry access, so checks were rerun directly from the existing local Vitest/TypeScript binaries. No live OpenRouter request or deployed worker test was run. Full file-by-file review and cross-worker stress testing remain open.

## RiskGuard extreme input validation (2026-10-20)

Stress-tested the deterministic order gate with malformed and near-maximum JSON numbers. The evaluator previously accepted fractional/unsafe equity values and multiplied potentially huge integers as floating-point numbers; malformed `null` JSON could also escape the limits/order handlers as an exception. It now validates IDs, sides, integer amounts, equity, and basis-point bounds before storage or scoring, uses exact `BigInt` cross-products for ratio checks, and returns 400 for invalid JSON/object shapes.

Validation: reconciliation/risk tests and RiskGuard ingress-boundary tests passed (11/11); Agents TypeScript check passed. The guard is a worker-internal DO namespace and its emergency freeze caller is the verified executive-channel path; external deployment routing has not been exercised here. The full repository audit remains open.

## Decisions API retry ceiling (2026-10-20)

The OpenRouter Decisions client accepted an arbitrary `maxRetries` override, so a bad deployment value could create unbounded request amplification and latency during provider outages. Retry overrides are now clamped to zero through two; invalid non-integer values use the default ceiling. Validation: full Decisions client suite passed 22/22 and Agent SDK TypeScript passed. Provider outage timing was exercised with mocked 503 responses only.

## Concurrency slot input and lease bounds (2026-10-20)

The concurrency slot endpoint converted arbitrary JSON values to string IDs, treated malformed limits as defaults, and accepted unbounded/negative TTL values. Slot acquisition and release now require bounded non-empty string IDs, reject malformed JSON and invalid/fractional limits or TTLs, and cap the lease at the existing 30-minute reclaim window. Oversized positive limits remain capped at 100 slots. Validation: ConcurrencyDO and ingress-boundary suites passed 12/12; Agents TypeScript passed. Other ConcurrencyDO operations (locks, pacer, appointment holds, node leases, and workspace publication) still require their own scoped audit.

## Fenced lock release propagation (2026-10-20)

Tracing ConcurrencyDO lock callers found that several callers discarded the fencing token returned by acquisition. The DO then accepted holder-only release, allowing an old operation with a reused holder ID to release a newer lease. Release now requires the exact positive fencing token; the generic lock tool, workspace sync, agent-config local/remote adapters, and workspace CAS paths preserve it. Added a stale-token replay regression proving the newer lease remains active.

Validation: ConcurrencyDO, agent-config, R2 CAS, and workspace CAS tests passed (23 tests across 4 files); Agents TypeScript passed. Fencing tests use the DO SQLite test harness; no concurrent live Durable Object deployment test was run. The remaining ConcurrencyDO endpoints still need scoped review.

The continued lock-endpoint pass also added strict JSON/object, key/holder, fencing-token, and TTL validation to acquire/renew/release. Positive lock TTLs remain capped at the existing 30-second file-lock maximum. Regression tests cover null JSON, string/fractional/unsafe TTLs, missing release tokens, and stale-token replay. Recheck: the same four targeted suites passed 24 tests and Agents TypeScript passed. The outbound pacer, appointment holds, node leases, and workspace publication remain on the ConcurrencyDO audit list.

## Concurrency appointment holds and outbound pacer (2026-10-20)

Continued the DO audit: appointment-hold acquisition/confirmation/release now reject malformed or oversized IDs instead of coercing arbitrary JSON values, and derived slot times must parse as dates. Pacer ingress now validates domain/rate types, accepts only HTTP(S) URLs without userinfo, and responds 400 on invalid requests without recording a reservation.

Validation: ConcurrencyDO suite passed 12/12; Agents TypeScript passed. The 5 req/s cap and 15-second appointment lease behavior remain covered by existing tests. Node-lease and workspace-publication boundaries still require scoped review.

The same pass found `/status` included expired concurrency slots until the alarm's next sweep, despite admission treating them as expired. Status now counts only unexpired rows. Regression confirmed a slot reports `active: 0` after TTL but before alarm cleanup; ConcurrencyDO suite passed 13/13.

## Fenced workspace publication validation and Agents suite (2026-10-20)

The shared workspace publisher accepted coercible IDs/tokens, malformed CAS hashes/metadata/content, and request JSON `null` could become a 500. It now validates bounded key/holder/path values, binds the lock key suffix to the exact workspace path, requires a numeric fencing token and SHA-256 CAS value, bounds metadata/content, rejects traversal and malformed Base64, and returns 400 before storage access for invalid requests. Existing project/space path construction remains in the workspace helper and container recovery callers.

Validation: malformed publication/ingress plus ConcurrencyDO tests passed (18 tests); Agents and provisioner TypeScript checks passed. After lock contract changes, the full Agents suite passed 141 files / 605 tests. No live DO or R2 race/load test was run. Remaining unchecked repository files and the rest of ConcurrencyDO are still open.

## Inventory refresh after audit commits (2026-10-20)

Recounted tracked repository files after the earlier audit additions. The previous tree listed 1,888 files / 1,682 source and executable-configuration files; the tracked tree now contains 1,939 / 1,733. Refreshed `naelao-repository-tree.txt` from `git ls-files` and rebuilt the source-file checklist while preserving 176 already checked rows. Temporary untracked `work/`, root test reports, and failure lists are excluded. The platform-surface route/worker discovery index remains unchanged because this tranche altered existing routes and DOs rather than adding registrations. Inventory is tied to commit `b928acb7`; audit findings remain open.

Refreshed root-workspace validation after the inventory and worker changes: direct local Vitest run passed 308 files / 1,356 tests with no failures in 92 seconds. This run uses the currently configured workspace projects; it is not a substitute for build/deploy or live provider/DO load checks.

## Bounded task-relevant skill discovery (2026-10-20)

Default-worker delegation read metadata only for the first 100 R2 skill names, so an otherwise relevant skill later in a large library could never reach the decision selector. The bounded scan now ranks valid skill names by task-term overlap with deterministic tie-breaking before loading up to 100 descriptions. Added coverage showing a conversation-research skill at position 151 is selected first without increasing metadata reads.

Validation: worker-capability and skill-role-targeting suites passed 10/10; Agents TypeScript passed. Description-based ranking and the OpenRouter capability filter remain advisory; signed parent tool/skill authority is still the execution boundary.

Marked the worker-capability selector implementation and its complete test file reviewed in the file-by-file plan after tracing the host spawn path, signed child contract, child tool filtering, built-in catalog coverage, and role-limited skills. This is a scoped completion for those two files only; the adjacent `NaelaoAgentDO.ts` and `ConcurrencyDO.ts` remain unchecked because their broader responsibilities are still under review.

## ScaleDown provider-boundary stress pass (2026-10-20)

Reviewed `workers/agents/src/shared/scaledown.ts` and its full test file, including all summarize/extract/compress request shapes, the 2 MiB UTF-8 source and streamed-response caps, host admission before egress, gateway/native credential separation, provider usage settlement before output validation, offset-to-source checks, and cache scope/schema/source validation. Traced the two `NaelaoAgentDO` callers and confirmed the shared processor receives scoped cache identity, model policy, provider pricing, and reserve/settle callbacks; the broader DO file remains unchecked.

Found and fixed two input-integrity gaps: non-string `instructions` passed the length check and were interpolated into the model system message, and malformed UTF-8 provider bytes were silently replacement-decoded before JSON parsing. Runtime null inputs now fail with the documented source validation error, instruction values must be text within the existing limit, and provider JSON decoding rejects malformed UTF-8. Added regressions for each case.

Validation: ScaleDown suite passed 11/11; Agents TypeScript check passed. No live provider call, timeout, Cloudflare gateway, or bill-settlement integration/load test was run. The two ScaleDown files are checked in the plan; this does not complete the document-processing callsite or `NaelaoAgentDO.ts` review.

## ConcurrencyDO queue and lease-surface pass (2026-10-20)

Reviewed the full ConcurrencyDO implementation and its test file, including slot admission/expiry, lock acquisition/renewal/release and fencing, workspace R2 CAS publication, node leases, appointment holds, outbound pacing, request-body bounds, alarms, and the Wrangler binding. Traced direct production callers for agent slots, file locks, workspace publication, and node-lease ingress. The slot-hold methods have no in-repository production callers; they remain available pending owner/deployment compatibility review rather than being removed speculatively.

The outbound pacer previously let callers queue an unbounded delayed wait per domain. Reservations now reject once the next release would exceed 30 seconds, leave the persisted schedule unchanged, and report HTTP 429. A 151-request fake-clock stress case proves the 30-second ceiling and rejection behavior. Repository search found no production reference to `/locks/force-release`; the only Wrangler binding is within the agents worker, and its wrapper routes use fenced release. Removed this unfenced bypass and added a regression proving the route returns 404 without changing the live lease.

Validation: ConcurrencyDO suite passed 15/15; Agents TypeScript passed. The implementation and test file are checked in the checklist. The tests use an in-memory SQLite shim; no Cloudflare DO eviction, alarm scheduling, SQLite contention, or R2 race/load integration was run. `NaelaoAgentDO.ts`, `ToolSandboxDO.ts`, and their callsites remain unchecked.

## HITL approval expiry, scope, and redemption pass (2026-10-20)

Reviewed the HITLApprovalDO state transitions and traced creation/list/resolve/consume routes through the agent worker and shell inbox. The route's `session_id=inbox` is an intentional space-wide inbox contract; actual session IDs now filter to that session. Lists keep a bounded 50-row page and expose `has_more`/`next_offset`; the wrapper URL-encodes `run_id` and forwards offsets. Added 51-row paging coverage.

Found that late approve/reject/answer requests could win after expiry if the alarm had not run yet. Resolve and answer now mark expired requests as timeout and return 409; expiry equality uses the same inclusive boundary as the alarm. Approval creation now validates required identity/action fields, JSON object shape, tool-input size (64 KiB), description/name limits, question options, resume DO ID, and a seven-day maximum TTL while retaining the existing 24-hour flows. Consume now requires exact run and action identities (previously either could be omitted), and reject/answer/consume safely handle malformed and null bodies.

Validation: new HITL boundary suite plus direct DO body-boundary suite passed 8/8; Agents TypeScript passed. Coverage includes session vs inbox scope, 50+1 pagination, invalid offsets, large/malformed creation inputs, expired approvals/questions, exact one-time redemption, and null action bodies. A legacy root test file is outside configured workspace discovery; equivalent redemption cases run in the new agents suite. The HITL DO and its new test are checked; the small `index.ts` wrapper edit is only a scoped change and does not mark that large file complete. No live alarm delays, DO restart, or cross-request production integration was exercised.

## TaskDO async-state and callback pass (2026-10-20)

Reviewed TaskDO with the task creation/status/poll routes and AgentTaskWorkflow callers. Found a callback SSRF path: a caller-controlled callback URL was fetched without URL validation, DNS checks, redirect denial, or timeout. Task creation now accepts only bounded HTTPS URLs without credentials and rejects destinations that fail the shared SSRF check; delivery rechecks DNS, fails closed, disallows redirects, times out after 10 seconds, and cancels the response body. DNS resolution and fetch remain separate operations, so rebinding is a residual risk.

Task creation previously used `INSERT OR REPLACE`, allowing duplicate IDs to reset an existing task to queued; it now rejects collisions. Task creation fields, callback size, task IDs, status enum/transitions, JSON results, result size, and error strings are validated. Terminal state updates are idempotent and callbacks fire only on the first transition. Poll timeout syntax/range is strict, and expired rows are hidden/deleted on reads.

Validation: direct TaskDO/HITL request-boundary suite passed 6/6; Agents TypeScript passed. Tests cover private/HTTP/credentialed callback destinations, non-overwrite on duplicate IDs, malformed state, oversized and malformed results, allowed/denied transitions, duplicate terminal callback suppression, and poll bounds. Public DNS and delivery are stubbed; no live callback service, DNS rebinding, task workflow replay, DO eviction, or callback authentication/retry integration was exercised. `TaskDO.ts` and the shared direct-DO boundary test file are checked; the much larger `index.ts` and `AgentTaskWorkflow.ts` remain unchecked.

## Local tunnel concurrency and lifecycle pass (2026-10-20)

Reviewed the named tunnel DO, host gateway, request journal, public enrollment/authentication/connect routes, SpaceDO authority operation, and the typed machine proof/grant contracts. Added an atomic journal-plus-active-slot admission transaction so concurrent requests cannot exceed the eight-command cap. Deadline alarms now remove timed-out IDs from the durable active set, and missing journal records are removed from that set during cleanup. Direct `/authorize` calls enforce the same 32 KiB body cap as the public ingress wrapper. The host gateway tests verify actor authorization, active tenant/Space filtering, alias ambiguity failure, and immutable actor/project/run scope.

Validation: LocalTunnelDO and host gateway suites passed 13/13; Agents TypeScript passed. Stress coverage includes nine simultaneous dispatches (exactly eight sent, one HTTP 429), timeout cleanup, oversized auth body, websocket frame cap, reversed responses, grant denial, cancellation, and no replay after DO restart. The in-memory storage mock now serializes transactions to model DO storage atomicity; live WebSocket/DO concurrency was not run.

Open issue discovered in this pass: request journal records, including output/result payloads, have no retention/compaction policy. Per-request output is capped, and active commands are capped at eight, but completed journal storage can still grow without bound over a long-lived machine. Keep this as a tracked storage-exhaustion item for the tunnel lifecycle follow-up; do not call the tunnel surface fully closed until retention semantics preserve the no-replay guarantee while bounding accumulated receipts. The LocalTunnelDO, its test, tunnel host/test, and request-journal files are marked reviewed; this residual risk remains open.

Refreshed the tracked tree after adding `workers/agents/src/tunnels/host.test.ts`: 1,941 tracked files and 1,735 source/config files. The tree snapshot is tied to code commit `a9de2354`; 191 scoped file checks are recorded. This inventory refresh does not change the open journal-retention finding or close the broader audit.
