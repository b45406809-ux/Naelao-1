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

## Durable workflow journal accounting and retry recovery (2026-10-20)

Traced workflow usage settlement and manual retry from `WorkflowRunDO` through its journal and billing/provider bindings. Found a lost-update race where parallel effects could each read the same `usedCredits` value and overwrite one another. Added `WorkflowJournal.addUsedCredits`, which validates finite nonnegative increments and performs read/modify/write inside a storage transaction; narrowed the general journal patch method so callers cannot overwrite that counter non-atomically. A concurrent-increment regression verifies all four measurements are retained.

Manual retry previously changed a failed run to queued before confirming that budget reservation succeeded or that the workflow provider binding existed. A billing outage could therefore strand the run in queued state. Retry now checks provider availability and reserves budget before transitioning the journal, and a regression proves a failed reservation leaves the run failed and retryable. Provider restart errors are reconciled with provider status before marking the retry failed. Signal now reports the explicit provider-unavailable error instead of dereferencing a missing binding.

Validation: workflow journal and WorkflowRunDO focused tests passed 4/4; Agents TypeScript passed; `git diff --check` passed. These tests model storage transactions and provider/billing failures but do not exercise Cloudflare DO eviction, real Workflow restart ambiguity, live billing idempotency, or concurrent production effects. Only these paths were stress-tested in this pass; the workflow files and their wider caller graph remain unchecked in the file checklist pending full review.

### Effect receipt and usage atomicity follow-up

Continued tracing the same effect path and found that a process crash after the effect receipt was marked committed but before measured credits were added would correctly prevent replay while omitting usage from settlement. `commitEffect` now writes the committed receipt and accumulated credits in one storage transaction, records the usage amount with the receipt, and treats an identical repeated commit as idempotent while rejecting conflicting commits. The effect handler computes the measured amount before this atomic commit.

Validation: workflow journal and WorkflowRunDO suites passed 6/6; Agents TypeScript and `git diff --check` passed. Regressions cover receipt-plus-credit commit, repeated commit without double-counting, and invalid usage without committing. This closes the local journal gap; it does not simulate a real DO transaction failure or reconcile indeterminate external effects.

### Static agent-task checkpoint scope

The checkpoint helper accepted its run ID and TaskDO name on the assumption that callers always used the same task ID and Space. It now rejects an instance ID that differs from `params.taskId` and rejects TaskDO names other than `tasks:${spaceId}` before accessing bindings. Added regressions for both cross-scope mismatches.

Validation: checkpoint, journal, and WorkflowRunDO focused tests passed 8/8; Agents TypeScript and `git diff --check` passed. The two task boundary checks are covered; the full AgentTaskWorkflow event lifecycle and TaskDO integration still need end-to-end review.


Refreshed the tracked inventory after adding `workers/agents/src/workflows/workflow-state.test.ts`: 1,942 tracked files and 1,736 source/config files. The tree snapshot is tied to code commit `23227de1`; 191 scoped file checks remain recorded.


Refreshed the tracked inventory after adding `workers/agents/src/workflows/agent-task-checkpoints.test.ts`: 1,943 tracked files and 1,737 source/config files. The tree snapshot is tied to code commit `e29bed43`; 191 scoped file checks remain recorded.

The Agents worker suite subsequently passed **145 test files / 637 tests** after the terminal-settlement protocol was added. Agents TypeScript also passed in the focused validation cycle. This does not close the Agents file checklist.

### Terminal transition and in-flight effect settlement

Addressed the cancellation/finish race between an authorized external effect and reservation cleanup. The journal now atomically registers external effects before dispatch, caps active effects at 128, and rejects new effects after terminal cleanup begins. Committing a receipt atomically removes its active marker and adds measured credits. Terminal cleanup waits up to 60 seconds for active effects, retries by alarm, and then marks stale receipts indeterminate; an indeterminate effect cannot be replayed and settles the run's reserved credit ceiling as a conservative bound. Failed and cancelled runs settle measured completed use instead of releasing the entire reservation.

Validation: journal and WorkflowRunDO focused suites passed 9/9; Agents TypeScript and `git diff --check` passed. Regressions cover atomic start/commit, terminal admission denial, stale-effect expiry, measured failed-run settlement, and reserved-ceiling settlement for uncertainty. Residual risk: an effect unresolved beyond 60 seconds is charged the whole reserved ceiling, which can exceed its true cost but is bounded by the reservation. The tests use storage and billing stubs; no real concurrent DO RPC, external side effect, provider termination, alarm delivery, or billing service was exercised.

## OpenRouter decision request deadline (2026-10-20)

Reviewed the shared decision client and all runtime construction sites. It already clamps retries and response size, but had no request deadline; a stalled OpenRouter call could hold a runtime preflight, WriteGuard, mention router, or other decision path indefinitely. Added one five-second overall deadline (100 ms–30 s bounded override) shared by attempts, retry backoff, and response-body reads. Timeout and network failures normalize to stable non-sensitive errors so existing callers can fall back deterministically. Updated the System One reference.

Validation: `packages/agent-sdk/src/fast-decision.test.ts` passed 24/24, including a never-resolving request and a stalled body stream; package TypeScript passed and `git diff --check` passed. No live OpenRouter latency/load measurements were made; the timeout value is an operational default, not a measured provider percentile.

## Market Radar provider fan-out bound (2026-10-20)

The Market Radar route loaded every verified signal from the previous 30 days, scored each concurrently with a decision-model call, and only then filtered to configured stacks and five displayed results. A growing or polluted table could therefore cause unbounded memory and provider fan-out for a route that returns at most five rows. The query now caps database rows at 100, and deterministic preselection keeps only the five highest-scoring rows with configured stacks before any model requests. At most five concurrent decision requests can be made per refresh.

Validation: Market Radar suite passed 5/5; Spaces TypeScript and `git diff --check` passed. The regression feeds 120 mixed configured/unconfigured candidates and proves preselection caps eligible work at five. No live DB growth or OpenRouter load was run.

After the targeted route pass, the complete Spaces worker suite passed **57 test files / 196 tests**. The full suite is regression evidence for this worker snapshot; it is not a complete Spaces source-file review.

### Workflow artifact accumulation cap

The per-object artifact size was bounded, but repeated workflow steps could create an unbounded number of R2 results. The journal now tracks unique artifact keys and cumulative bytes per run, initialized with the input artifact. Checkpoint writes reserve quota transactionally before R2 writes; identical content-addressed artifacts do not double-count. Runs are capped at 256 artifacts and 64 MiB total. Agent-task step results and dynamic workflow results now pass through the same quota boundary.

Validation: workflow-state, WorkflowRunDO, and agent-task checkpoint suites passed 12/12; Agents TypeScript and `git diff --check` passed. Tests cover idempotent duplicate artifact reservation and both count and byte limits. Per-run artifact deletion at expiry is handled below; immutable shared workflow-code objects remain open for reference-aware garbage collection.

### Workflow artifact expiry cleanup

Terminal runs now retain an alarm at their configured expiry. At expiry the DO deletes all R2 objects under that run's artifact prefix in bounded 256-object pages; artifact reads reject once the run expires. The run journal remains as a tombstone so the deterministic start ID cannot be reused to execute side effects again. If R2 cleanup fails, the alarm remains available for retry.

Validation: WorkflowRunDO and journal suites passed 11/11; Agents TypeScript and `git diff --check` passed. A fake-clock alarm regression confirms expiry transitions, artifact deletion, and retention of the expired run record. Immutable content-addressed workflow code under `workflow-code/` is shared by runs and can accumulate across code versions; safe reference-aware collection is not yet implemented.

## Workflow budget reservation and billing settlement (2026-10-20)

Traced `WorkflowRunDO` reserve/settle calls through the Billing worker endpoint. The reserve route previously coerced fractional/string credits, allowed reservation and workflow IDs to diverge, accepted mutable scope/budget changes on a repeated ID, and could report a false quota failure when concurrent identical launches raced the unique insert. Inputs are now strict bounded integers/strings, IDs must match, replay scope and credits are immutable, and a race loser reloads the winning held reservation. Settlement now inserts its usage event only if the reservation is actually settled, preventing a concurrent release from fabricating a charge without consuming the hold.

The Billing worker had existing tests but no Vitest project config, so workspace runs did not discover them. Added its config and included the workflow budget integration regression in that project. Validation: Billing project passed 4 files / 6 tests; billing-core source and Billing worker TypeScript checks passed after rebuilding the ignored billing-core `dist` declarations. The integration case covers strict fractional/mismatched IDs, identical replay, concurrent identical reservation requests, settlement dimensions, and settle-after-release. It uses the SQLite D1 shim; no live D1 concurrency or quota cache/queue integration was run.


Refreshed the tracked inventory after adding the Billing worker Vitest project config: 1,944 tracked files and 1,738 source/config files. The tree snapshot is tied to code commit `36389ec2`; 191 scoped file checks remain recorded.

Effect receipts were another unbounded per-run storage surface. The journal now limits each workflow to 1,024 unique effect keys (including the agent-run claim), keeps duplicate-key replay idempotent at the limit, and removes receipt rows when the run expires while retaining the run tombstone. Validation: WorkflowRunDO and journal suites passed 12/12; Agents TypeScript and `git diff --check` passed. The regression checks count enforcement, idempotent existing-key replay, and receipt deletion at expiry. Shared pinned code under `workflow-code/` remains the storage-GC follow-up.

After the artifact and receipt changes, the complete Agents worker suite passed **145 test files / 640 tests**. The Agents TypeScript check also passed; this remains worker-level regression evidence, not a complete repository audit.

## System One shared decision client review (2026-10-20)

Completed a scoped review of the entire `packages/agent-sdk/src/fast-decision.ts` implementation and its test file, and traced the runtime constructors in Agents and Spaces. The review covers typed choice/score/noul validation, probability/usage parsing, attachment metadata and advisory-only capability selection, work-plan/runtime caps, context-based Clef/Decider routing, bounded response streaming, retries, and the new wall-clock deadline. Only the decision client and its tests are checked in the file plan; the broader SDK and every downstream decision callsite still require their own passes.

Validation: `fast-decision.test.ts` passed 24/24, including request and response-body stalls, response-size limits, retry caps, model selection, malformed provider payloads, and typed decision bounds. Agent SDK TypeScript passed. No provider live benchmarking or network-load test was performed.

## Spaces TransactionCoordinatorDO saga boundary (2026-10-20)

Traced the coordinator export and Wrangler Durable Object binding. Static search found no production callsite in this repository; the namespace remains deployed, so it is retained pending confirmation of external compatibility and runtime use. Saga creation now rejects malformed JSON, invalid tenant/name/step fields, non-HTTPS or credentialed URLs, more than 16 steps, per-field payloads above 128 KiB, and aggregate serialized steps above 512 KiB. Completion/failure transitions require the current pending step; duplicate completion is idempotent and terminal states reject late mutations. Compensation verifies DNS destinations with the shared SSRF guard, disables redirects, applies a 10-second abort deadline, cancels failure bodies, and bounds/sanitizes persisted error details.

Validation: coordinator and request-boundary suites passed 2 files / 11 tests; full Spaces suite passed 57 files / 198 tests; Spaces TypeScript and `git diff --check` passed. Regressions cover malformed/unsafe/over-limit definitions, ordering, duplicate completion, reverse compensation, and failed compensation. The DO's own routes do not authenticate a tenant identity, and no internal production caller exists to establish a trusted tenant context; direct namespace access is service-binding-only in the current Worker model, but tenant authorization remains an unresolved integration requirement before adding a caller. SSRF DNS validation and fetch resolve separately, so DNS rebinding remains a defense-in-depth limitation. No live DO, DNS, outbound service, or concurrent RPC test was run. The two implementation/test files are checked in the file plan; broader Spaces files remain open.

## Spaces FeatureFlagDO list and configuration boundaries (2026-10-20)

Traced the FeatureFlagDO export and Wrangler namespace. Repository-wide static search found no production caller; this is a platform-wide internal flag store, distinct from builder product flags stored in `SpaceTypeRegistryDO`. Its flag list previously read the entire table into memory and returned it in one response. Added stable keyset pagination (default 50, maximum 100), a `next_cursor`, strict cursor/limit validation, and a path-safe bounded flag ID accepted consistently at write/evaluate boundaries. Existing targeted-rule attribute/operator/value limits and bounded evaluation context were reviewed and exercised.

Validation: FeatureFlagDO tests passed 3/3 and Spaces TypeScript passed. Tests cover invalid state/percent, disallowed target attributes and malformed context, paging order/cursor termination, maximum page size, and path-unsafe IDs. Full Spaces suite passed immediately before this change (57 files / 198 tests); only the focused FeatureFlagDO suite was rerun after this small pagination change. The DO exposes no tenant authorization on its own interface, but static search found no caller and the binding is service-internal; establish authenticated admin/tenant scope before connecting a caller. No live DO persistence/restart, high-cardinality table, or concurrent update test was run. Its test and implementation files are checked in the file plan; remaining Spaces files remain open.

## Spaces LockDO lease lifecycle (2026-10-20)

Traced its export and Wrangler namespace; no production caller exists in the repository, while `ConcurrencyDO` provides a separate lock/lease facility. Retained this deployed namespace pending external-use confirmation. Added request JSON/type validation, bounded caller IDs, and TTL bounds (1 second to 24 hours; default remains 30 seconds). Found an alarm renewal edge: if an older alarm fires after same-holder renewal, it left the lock held without a future alarm. The alarm handler now reschedules at the persisted expiration when it fires early, and clears both row and alarm after true expiry. Added dedicated real-SQLite-shim tests for invalid payloads/TTLs, exclusive acquisition/owner-only release, renewal alarm recovery, and expiry.

Validation: LockDO and shared request-boundary suites passed 2 files / 10 tests; the complete Spaces suite passed 58 files / 202 tests; Spaces TypeScript and `git diff --check` passed. No live DO alarm delivery, process restart, distributed request race, or cross-worker caller test was run. Static repository search found no caller, so equivalence with ConcurrencyDO and external compatibility are unresolved; retain and investigate instead of deleting. Both LockDO implementation and new test are checked in the file plan; broader Spaces surfaces remain unchecked.

Refreshed the tracked repository tree after adding `workers/spaces/src/do/LockDO.test.ts`: 1,945 tracked files and 1,739 source/config files, tied to code commit `30a00205`. The checklist currently records 199 scoped file reviews; all remaining files are still pending and this refresh is inventory maintenance, not review evidence.

## MicroAppDO gadget identity and MCP table isolation (2026-10-20)

Traced MicroAppDO through the project/space MCP routes, public dynamic-page routes, and internal extension-gadget workflow bridge. Route boundaries check tenant/space membership or signed internal invocation before reaching the DO; the DO itself is only reachable by service binding. Found two local trust-boundary gaps: concatenated scope keys accepted delimiter-bearing IDs, permitting scope-key aliasing; and MCP schema discovery treated platform bookkeeping tables as gadget-owned tables, allowing gadget tools to target internal audit, migration, page, nonce, collaboration, and key-value tables. Scope dimensions now require bounded alphanumeric/underscore/hyphen IDs. MCP table discovery excludes all platform-owned tables; schema tests prove only the user-created table is advertised and internal table access fails.

Validation: six related tests passed 6 files / 29 tests (MCP CRUD, key derivation, release proof/public pages, and three caller route suites); the full Spaces suite passed 58 files / 203 tests; Spaces TypeScript and `git diff --check` passed. Remaining issue found in the identity trace: `PROJECT_BOUND` key format omits `spaceId`, while project IDs are primary-key unique only inside each SpaceDO, so independently generated same IDs across spaces could theoretically share one gadget actor. Existing deployed actor keys are already in use; adding the missing scope component requires a data-preserving actor migration and was not changed in this patch. Verify global project-ID uniqueness or implement a migration before claiming project-bound storage isolation. The MicroAppDO implementation and two directly changed test files are checked; caller routes were reviewed in the following auth-boundary pass, and other MicroApp test files remain unchecked.

## Gadget route identity-header authentication (2026-10-20)

Traced registration of the gadget MCP and dynamic-page routes against the Spaces worker middleware. Unlike most sensitive `/spaces/...` routes, the module handlers trusted `x-naelao-tenant-id` and `x-naelao-role` but mounted no `requireInternalHmac`; the only global middleware validated environment, not caller identity. A direct request to the Spaces worker could therefore forge `x-naelao-role: owner/admin` and bypass membership checks on gadget storage, reads, writes, and page publishing. Added HMAC verification to both space and project gadget route trees and to authenticated page publication. Public preview rendering and form actions remain on their separate host/origin/token checks. Extension gadget invocation already verifies its tenant-scoped internal token and was retained.

Validation: gadget host, dynamic-page, and extension-gadget suites passed 3 files / 17 tests; after the middleware fix the full Spaces suite passed 58 files / 203 tests; Spaces TypeScript and `git diff --check` passed. Tests now mint signed internal headers for authorized calls and assert unsigned forged-owner requests return 403 without reaching the DO. The direct-mount checks are also evidence that internal role headers cannot be trusted alone. Six related route implementation/test files are marked scoped-reviewed. Project-bound actor-key space omission remains open as noted above.

## Builder account and Dashboard credential boundaries (2026-10-20)

Traced BuilderAccountDO through `builder-routes.ts`, the tenant-keyed namespace, builder API-key index, and the Dashboard key-scope choices. Found two authorization defects: session auth trusted a bare tenant header (a direct Worker caller could choose a tenant), and bearer scopes were returned by key verification but no Builder Dashboard route enforced them. The tenant branch now verifies the router's internal HMAC. Route middleware assigns `spaces:read/write`, `analytics:read`, `billing:read`, or `sessions:read` requirements and enforces write-implies-read; API-key creation requires the same authority as the new key's requested scopes, preventing privilege escalation. BuilderAccountDO now validates malformed JSON, bounded product IDs, supported unique scopes, key-name length, expiry of 1–3,650 days, and exact raw-key format. It caps indexed products at 500 and active keys at 1,000, transactionally enforcing the key cap after hash creation; verification rejects expired-at-this-instant credentials.

Validation: the real worker integration `tests/unit/builder-dashboard-api.test.ts` passed 30/30, including forged tenant rejection, scope denial, child-scope escalation denial, supported key creation, and revocation. Spaces TypeScript passed; after the builder change the full Spaces suite passed 58 files / 203 tests and `git diff --check` passed. The integration suite emits expected wallet-lookup warnings because its fixture omits the optional `users` table; those cases fall back and pass. API-key and product caps bound list memory/storage; no 1,000-key contention stress or live router-to-worker request was run. These three source/test files are checked; adjacent builder routes and infra migrations remain unchecked.

## ProductUserDO resource bounds and personal-data authorization (2026-10-20)

Bound session issuance to 100 active sessions per end user, prune expired/revoked rows during mint, and reject malformed auth-provider values and oversized session tokens. Ledger grants/debits/clawbacks now require positive safe-integer credits and bounded metadata, avoiding fractional truncation and SQLite integer overflow paths. Conversation references, preference values/count, and pending notifications now have field/payload limits and queue caps; conversation and notification reads are keyset-paginated (default 50, maximum 100), and the builder consent-gated metadata endpoint forwards its cursor. Regression cases cover session flooding, malformed/unsafe ledger amounts, pagination and cursors, and oversized stored values.

The same trace found that the older SpaceDO GDPR export and erasure handlers trusted a caller-supplied `end_user_id` without authenticating or binding it to the caller. Router product-session matching now includes those two routes; the Spaces worker verifies its signed internal identity, requires the requested ID to equal the verified product-user ID, and checks that the caller is an active product user or a member of the child business being accessed. The signed R2 export-download route remains independently HMAC-protected and is not added to session routing. Tests assert unauthenticated direct calls cannot export or erase another user's data, and router matching tests cover the allowlist boundary.

Validation: ProductUserDO reservation/bounds/pagination suite passed 3/3; Spaces request-boundary suite passed 3/3, including export/erasure denial; router product-session path suite passed 27/27. Full Spaces suite passed 58 files / 207 tests, Spaces and Router TypeScript checks passed, Router suite passed 9 files / 44 tests, and `git diff --check` passed. The implementation and directly changed tests/routes are checked in the file plan; no live Router-to-Spaces signed-session request or D1 membership integration was run. Root product users are checked against the active product roster, while child-space users require the real business membership relation.

## SpaceTypeRegistryDO install accounting and input validation (2026-10-20)

Tracing the registry through provisioning and builder listing found that every DO initialization re-registered the source-controlled Launchpad manifest with `INSERT OR REPLACE`. That delete-and-reinsert reset `install_count` to its default, so installs could appear to remain zero; record-install also counted repeated provisioning callbacks more than once and accepted unvalidated IDs/versions. Registration now uses UPSERTs that preserve install/rating counters, installation recording validates IDs and known versions, inserts idempotently, and increments the count only when a new `(type, space)` instance is recorded. Registration and install endpoints reject malformed JSON and apply basic manifest size/field bounds.

The internal provisioning wrapper now returns the registry's real error status/body instead of claiming success when the DO rejects an install record.

Validation: the registry regression suite passed 2/2, covering restart counter persistence, duplicate install idempotency, malformed registration/install payloads, invalid IDs, spoofed author denial, and unknown versions. The complete Spaces suite passed 59 files / 209 tests after wrapper status propagation; Spaces TypeScript and `git diff --check` passed. No real provisioning queue retry, production DO migration, or high-volume instance table was exercised. Registry mutation is reachable only through the Spaces worker's service binding; the platform seed route still uses the direct platform-secret gate and remains in the pending route/auth review.

Refreshed the tracked inventory after adding `workers/spaces/src/do/SpaceTypeRegistryDO.test.ts`: 1,946 tracked files and 1,740 source/config files, tied to code commit `daedbf79`. The checklist preserves 219 reviewed source/config files; the remainder are still pending. This is inventory maintenance, not evidence that unchecked files were audited.

## Customer business creation quota and provisioning boundary (2026-10-20)

Traced both the legacy reseller route and product-scoped route through the shared creation helper, LockDO binding, D1 hierarchy tables, and provision queue. The routes previously trusted identity headers without verifying the router HMAC; create logic also lacked bounded name/template/config inputs and did not require a live product-user roster row. Concurrent same-user requests could both read the old business count and exceed the quota. Added signed product-user checks at both route entrypoints, verified the target product tenant, required an active unsuspended roster record, and bounded IDs, names, templates, and config overrides. A per-(product,user) lease now serializes creation through the existing LOCK_DO, with a ten-minute expiry and fail-closed behavior if the binding is unavailable. Invalid business ceilings are rejected, and the reseller-account upsert occurs only after quota gates.

D1 writes now create the hierarchy and owner membership before async provisioning starts; best-effort cleanup removes partial D1 state if those writes fail. If queue enqueue fails, the unprovisioned space, membership, and newly created hierarchy row are removed. The product-scoped route no longer writes the same membership after creation; SpaceDO owner seeding remains best effort and is idempotent through provisioning.

Validation: focused creation, route-identity, and legacy-route tests passed 8/8; the complete Spaces suite passed 61 files / 214 tests, Spaces TypeScript passed, and `git diff --check` passed after the D1 rollback adjustment. No live D1, concurrent network request, queue outage, queue-acceptance ambiguity, or 10-minute lease expiry was exercised. The lease is not renewed during a prolonged create; if an operation runs longer than its ten-minute TTL, a competing request could proceed. Queue enqueue and D1 are not a single transaction: a queue provider that accepts a message and then reports an error could race the cleanup path. `business-create.ts` and its tests received scoped review; `business-routes.ts` create route was reviewed, while its invite/directory handlers and all remaining routes are still pending.

Refreshed the tracked inventory after adding the business-creation regression files: 1,948 tracked files and 1,742 source/config files, tied to code commit `13d6240c`. The checklist now preserves 220 reviewed source/config files; all other files remain pending review.


## Business directory, invites, and membership boundary (2026-10-20)

Reviewed every handler in `workers/spaces/src/business-routes.ts` and its tests, including business listing/directory, invite creation/redemption, and member listing/removal. The routes previously trusted identity headers directly; several also allowed platform or unrelated roles through handlers intended for product end users. They now verify the internal HMAC, require the product-end-user role, and confirm that the user is active on the matching product tenant. Invite creation additionally requires an actual owner/admin membership, validates email and role, forbids inviting an owner, and caps pending/history records. Redemption validates token, expiration, user email, invited role, and active member count; conditional D1 consumption ensures simultaneous redemption yields one success. Member listing/removal checks current membership and owner/admin authority, refuses owner removal, and mirrors removal to SpaceDO best-effort.

Validation: full Spaces suite passed 61 files / 223 tests; Spaces TypeScript passed; `git diff --check` passed. New regression coverage rejects unsigned identity across each route group, mismatched tenant and platform identities, owner invite minting, email mismatch, and duplicate concurrent redemption. Live D1 locking/transaction semantics and SpaceDO synchronization remain unexercised: D1 and SpaceDO writes are separate, SpaceDO seed/removal errors are best-effort, and invite insertion rollback can itself fail. The focused route module and test file are marked reviewed; other files remain pending.


## Shared business membership authorization (2026-10-20)

Reviewed the membership resolver, wallet-specific resolver, request middleware, role-rank checks, and all direct call sites. Found a fail-open edge case if a corrupted or legacy `business_memberships.role` value escaped the SQL CHECK constraint: the resolver cast arbitrary strings to `BusinessRole`, then role comparison read an undefined rank; JavaScript's comparison returned false, allowing the request through. Both resolvers now validate stored role values and fail closed. Added a corrupted-role regression to the existing D1-backed membership suite.

Validation: membership role tests passed 6/6; full Spaces suite passed 61 files / 223 tests; Spaces TypeScript and `git diff --check` passed. Membership revocation can remain visible in the existing bounded 5-second isolate cache; this is intentional latency, but it is still a revocation propagation delay that merits production behavior verification. No real D1 corruption injection or concurrent isolate/cache behavior was exercised. The resolver and unit test received scoped review; other files remain pending.


## Custom hostname provisioning (2026-10-20)

Reviewed the Cloudflare for SaaS client and its builder-facing and internal business-service routes. Added DNS hostname normalization and validation, rejects IPs/wildcards/Naelao-owned hostnames, constrains zone and provider record IDs before URL construction, applies a 10-second fetch deadline, checks HTTP/API failures, validates provider response shape, and projects/caps DNS validation records. The internal create/get/status handlers now verify the target space belongs to the signed tenant and reject unsupported service kinds, closing an ID-guessing cross-tenant access path behind the shared internal HMAC. Builder status polling now maps provider errors to a controlled 502 response.

Validation: new Cloudflare client tests passed 6/6; full Spaces suite passed 62 files / 229 tests before the final tenant-scope checks, and focused tests plus Spaces TypeScript passed after the client response hardening. The final complete suite passed 63 files / 232 tests, followed by a passing Spaces TypeScript check and `git diff --check`. Three worker-level regressions cover cross-tenant create, read, and status-poll denial. There is no live Cloudflare account call, DNS propagation test, provider timeout simulation, or deployed tenant routing test. The client and regression test are reviewed; route integration was scoped reviewed in `index.ts` and `builder-routes.ts`, which remain unchecked as full files.


Refreshed the tracked repository tree after adding the two custom-hostname regression files: the inventory now reflects code commit `1d7832d0`; checked coverage is preserved and all other files remain pending.


## Shared root and product space creation (2026-10-20)

Reviewed the shared create path, config/schema handling, slug derivation, quota checks, hierarchy validation, and provisioning queue flow used by `/spaces` and `/builder/products`. Added bounds/validation for tenant and user IDs, printable names, template IDs, config override shape/size, and stricter platform slugs. The configured per-tenant LockDO now serializes the quota read and insert so concurrent creates cannot both pass the same stale count; held-lock contention returns 429 and releases on completion. A rejected provisioning enqueue now attempts to remove the newly inserted provisioning row and returns a controlled 503, avoiding a known permanently-counted orphan on definite queue failure.

Validation: `tests/unit/create-space-record.test.ts` passed 36/36; Spaces suite passed 63 files / 232 tests, typecheck passed, and `git diff --check` passed. Regression tests cover the lock-busy case, lock release, oversized input, and queue rejection cleanup. The queue and D1 are not transactional: a queue that accepts then reports an error can still produce an orphaned DO after cleanup; local tests do not reproduce actual cross-isolate concurrency or queue acceptance ambiguity. Lock coverage depends on the deployed `LOCK_DO` binding being present; the checked Wrangler configuration defines it. Scoped review and tests are checked; other files remain pending.


Refreshed the tracked tree and checklist after the space-creation code commit `34820917`; file counts are unchanged, checked rows are preserved, and remaining files stay pending.


## Template catalogue and free-tier plan gate (2026-10-20)

Reviewed the agent-worker catalogue fetch/cache path, shell catalogue path, plan-tier resolver, and both creation gates. Found that any unknown `plan_tier` was treated as paid by the template gate (`tier !== 'free'`), despite quota code falling back to the free limit. Unknown or malformed tiers now resolve to free. Space quotas now include the actual persisted `growth` and `business` tiers alongside historical aliases. Catalogue reads now tolerate KV failures, bound provider JSON to 2 MiB with a 5-second deadline, validate/cache only bounded catalogue shapes, and safely degrade malformed/unavailable responses according to the documented monetization-gate policy. Shell catalogue cache/provider errors now return bounded empty data rather than failing manifest reads.

Validation: focused template-catalog suite passed 5/5; plan gate + space creation root suites passed 52/52; full Spaces suite passed 64 files / 237 tests, Spaces typecheck passed, and `git diff --check` passed. Coverage includes unknown tier denial, malformed/oversized provider data, bad cache, provider outage, and normalized catalog caching. Free-tier template availability intentionally degrades open when the agent catalogue is unavailable; this remains a monetization-policy limitation. Live KV outage, provider timeout, actual paid-tier records, and D1 plan-tier drift were not exercised. The template catalogue, relevant plan gate test, and creation path received scoped review; other files remain pending.


Refreshed the tracked tree after adding the template catalogue regression suite; it now reflects code commit `24eb5d45`, with checked rows preserved and remaining files pending.


## Authentication tokens and timestamp expiry checks (2026-10-20)

A cross-cutting review found several SQL expiry comparisons mixing ISO timestamps (`YYYY-MM-DDTHH:...Z`) with SQLite `datetime('now')` (`YYYY-MM-DD HH:...`). Text ordering differs at the separator, so a credential or reservation that expired earlier the same day could still compare as live until the following day. Updated business-invite pending/cleanup/redemption queries, WhatsApp challenge lookup/consume, LLM token holds, workflow budget holds, API-key usage counts, and sweeper API-key cleanup to compare with `julianday()`. Password-reset and email-verification token reads now reject invalid timestamps and require the expiry in SQL; conditional updates consume each token once before applying the change. Added signup email/name/password bounds, duplicate-email conflict handling, and fixed outbound WhatsApp request IDs, payload bounds, and deadlines.

Validation: product-end-user routes + air-gap tests passed 12/12; business route tests passed 11/11; full Spaces suite passed 64 files / 240 tests with Spaces typecheck and `git diff --check` clean. Billing reservation, sweeper cleanup, and entitlement expiry tests passed 5/5; billing, sweeper, and entitlements typechecks passed. Password reset and email verification were raced concurrently in SQLite-backed tests and each returned one success / one invalid-token response. No live provider, deployed D1 clock, concurrent real request, or real quota reservation workload was exercised. The product end-user source and tests received scoped full-module review; billing, entitlement, and sweeper changes are limited to expiry expressions and remain unchecked as full files.


Refreshed the tracked tree after adding the entitlement expiry regression file; inventory reflects code commit `fb65809b`. The checklist preserves all completed review rows; remaining files are pending.


## Product authentication abuse limits and enumeration timing (2026-10-20)

Continued stress testing the public product login and WhatsApp challenge routes. The WhatsApp 3-per-10-minute check previously ran as a separate read from the insert, so parallel requests could exceed the intended limit. The count is now part of the same conditional `INSERT ... SELECT`; only successfully inserted challenges trigger provider delivery. Password login now performs the same-cost PBKDF2 check for unknown, malformed, and suspended records and returns the same credential failure body, closing the easy account-enumeration timing/status branch. Signup collisions already return a stable 409 after the earlier input-validation hardening.

Validation: the new 10-way concurrent WhatsApp test stored and delivered exactly three challenges; login tests confirmed unknown email, wrong password, and suspended accounts all return the same 401 body. The full Spaces suite passed 64 files / 242 tests; Spaces TypeScript and `git diff --check` passed. This is SQLite-backed concurrency simulation, not deployed D1 load. External Meta/Twilio delivery, provider timeout behavior, and distributed IP/phone abuse were not exercised.


Refreshed the tracked tree at code commit `4ba203c9`; tracked and source/config file counts are unchanged, completed review marks are preserved, and remaining files are still pending.

## ProductUserDO concurrency, numeric bounds, and cursor parsing follow-up (2026-10-20)

Revisited the session/credits/pagination paths after reviewing the DO as a whole. Session creation awaited SHA-256 after a non-atomic active-session count, allowing parallel requests to exceed the 100-session cap; hashing now happens before a `transactionSync` that prunes, checks the cap, and inserts atomically. Credit grants and debits/clawbacks now reject balances outside JavaScript's safe-integer range. Conversation and notification cursor length limits are enforced before base64 decoding/parsing.

Validation: added parallel 120-session creation coverage (exactly 100 created, 20 rejected), safe-integer overflow cases for grants/clawbacks, and oversized cursor cases for both paginated endpoints. ProductUserDO suite passed 5/5; full Spaces suite passed 64 files / 244 tests; Spaces TypeScript and `git diff --check` passed. These are SQLite DO-shim tests, not a deployed Cloudflare concurrency/load test. The ProductUserDO `notification_queue` table/routes have no external call sites in the repository; no removal was made because its migration/storage compatibility and future intended consumer are not yet established. ProductUserDO `/export` is likewise not exposed by the Spaces router; its scope/consumer remains a follow-up to trace with the user-facing data-export surface.

Refreshed the tracked tree and checklist after code commit `9598fd05`; file counts are unchanged, reviewed rows are preserved, and the inventory now records the new code revision.

## Tenancy configuration resolution (2026-10-20)

Traced the pure tenancy resolver through its registry re-export and the provisioner's manifest-load/topology-seeding call site. Since persisted/decoded config is runtime data, an unsupported explicit `tenancy` string previously escaped the TypeScript union and was returned as if valid; it is now restricted to `single`, `team`, or `saas`, with legacy tenant/hybrid membership inference retained and safe `team` fallback for malformed values. Stress coverage now includes invalid explicit and membership values plus `null`. This same trace found the Launchpad tenancy test had drifted from the actual shipped manifest: the product is explicitly SaaS with child business isolation. The assertion and description now match the implementation.

Validation: `tests/unit/space-tenancy.test.ts` passed 6/6; Spaces and Provisioner TypeScript checks passed; `git diff --check` passed. Provisioner has no local test file for the full queue-to-registry path, and no live queue/D1/SpaceDO provisioning run was performed. The exact resolver and its test are checked in the file plan; the provisioner was traced at this call site but remains unchecked as a full-file review.

Refreshed the tracked tree and checklist after code commit `9fa8ae19`; counts are unchanged, completed review marks are preserved, and the inventory records the tenancy-validation revision.

## Provisioning queue payload boundary (2026-10-20)

Traced the queue handler through provisioning, rollback, and deprovisioning entrypoints and confirmed that queue values reach D1 updates and broad R2-prefix cleanup. The handler previously read `message.body.type` without a runtime contract; malformed/unknown payloads could be retried until dead-lettering, while valid-looking payloads could carry unbounded IDs/names/template arrays. Added a shared bounded payload guard and reject/ack malformed messages before any side effects; retry remains reserved for valid messages whose processing fails. The current spaces and business creation producers emit the required payload fields.

Validation: new queue-contract tests passed 13/13, Provisioner TypeScript passed, and `git diff --check` passed. The tests exercise the pure validator; they do not run the Cloudflare queue runtime or prove delivery/ack/dead-letter behavior. `workers/provisioner/src/index.ts` was reviewed at queue/provisioning boundaries but remains unchecked as a complete file; the contract implementation and test are checked.

Refreshed the tracked tree after adding the queue contract module and its tests in commit `bccdc830`; inventory counts and completed-row coverage are current, and the two reviewed files are marked checked.

## Product-user export, root scoping, and erasure coverage (2026-10-20)

Compared ProductUserDO's internal `/export` and `/erase` operations to the spaces worker's public self-service routes. Found the export was not exposed at all, and profile/patch/erase addressed ProductUserDO using the current business ID rather than the product root, which could create/read an empty sibling DO for child-business requests. Added `GET /spaces/:spaceId/product-users/me/export`, root-resolved identity/profile operations, and mandatory tenant-to-root matching. The export combines D1 profile fields with DO-owned user data and omits credentials. Erasure now clears phone/verification and last-seen fields as well as email, display name, password hash, and preferences; its DO state wipe precedes D1 anonymization and remains safely retryable if the D1 write fails.

Validation: profile/export/erasure route suite passed 5/5, including child-business root routing and cross-tenant/missing-tenant denial; full Spaces suite passed 64 files / 247 tests; Spaces TypeScript and `git diff --check` passed. The route tests use mocked D1 and DO bindings, so real GDPR export size/streaming, D1-DO partial failure, and production session-revocation propagation remain untested. The modified integration test is checked; `index.ts` was already checked in the file plan from the earlier route audit.

Refreshed the tracked tree after code commit `6600e188`; tracked/source counts are unchanged and prior review marks are retained.

Erasure follow-up: traced the D1 recovery tables and found password-reset tokens, email-verification tokens, and WhatsApp OTP/magic-link challenge records also survived anonymization. The self-service erasure now clears all three user-scoped tables before anonymizing the profile; retries remain safe if a D1 delete or update fails. Regression coverage asserts all three cleanup statements. Focused route tests passed 5/5 and the full Spaces suite passed 64 files / 247 tests with Spaces TypeScript and `git diff --check` clean.

Refreshed the tracked inventory at code commit `cd8cc433`; counts remain 1954 tracked files / 1748 source or executable-configuration files.

## Provisioner queue handling and test wiring (2026-10-20)

Completed the queue-handler slice by separating message dispatch from the Cloudflare batch wrapper so ack/retry decisions can be stress-tested directly. Malformed payloads are acknowledged without side effects; valid provision/deprovision messages are acknowledged only after success; handler failures request retry. Added a Provisioner Vitest project and package `test` script because the workspace previously had no project for this worker, which would have left its tests out of CI's normal test graph.

Validation: standard Provisioner Vitest project passed 2 files / 16 tests; Provisioner TypeScript passed; Wrangler deploy dry-run bundled successfully at 14.2 MB upload / 2.57 MB gzip and showed the configured production bindings; `git diff --check` passed. The full D1/R2/SpaceDO provision, rollback, and dead-letter lifecycle still needs a service-binding harness or staging run. Provisioner package/config files and queue contract/dispatch implementation/tests are checked; the large `index.ts` remains unchecked as a whole.

Refreshed the tracked tree after queue test wiring commit `e0718084`; source/config file counts include the new Provisioner Vitest project and queue dispatch regression module.

## Provisioner manifest loading limits (2026-10-20)

The provisioner fetched a registry response using an unchecked typed `response.json()` and then iterated its resource declarations. Although registry writes are internal and size-limited, malformed/corrupted KV or registry data could still make provisioning do unbounded work or fail after partially seeding resources. The loader now reads at most 1 MiB and validates the requested SpaceType ID, bounded DO/prefix/workflow arrays, safe R2 path segments, optional feature flags, portal slug/template fields, and custom lifecycle URL shape before returning a manifest; malformed and oversized responses become the existing controlled not-found/provision rollback path.

Validation: Provisioner suite passed 3 files / 27 tests including 11 manifest-contract adversarial cases; Provisioner TypeScript and Wrangler dry-run passed (14.25 MB upload / 2.57 MB gzip); `git diff --check` passed. The tests cover the pure manifest guard, not malformed responses from a real KV/registry service binding. Manifest loading/failure handling is reviewed; `workers/provisioner/src/index.ts` remains unchecked as a complete file.

Provisioner manifest/queue boundary follow-up: the runtime manifest guard now validates the full required top-level manifest shape and all provisioner-consumed arrays/limits, and queue identifiers reject path separators and header control characters while preserving provider subject IDs such as `auth0|...`. Final Provisioner suite result is 3 files / 32 tests; typecheck and Wrangler dry-run pass.

Refreshed the tracked tree after manifest/queue validation commit `0838ba1c`; counts now include the two new manifest-contract files and the checklist marks their review complete.


## Provision/deprovision stale-message lifecycle guard (2026-10-20)

The saga previously set a space to `provisioning` by ID/tenant alone, so a delayed retry could reactivate a soft-deleted space; duplicate delivery after success could also rerun seeding. Provisioning now starts only when the D1 row exists in `provisioning` or retryable `error` state, conditions the start/activation/error writes on the allowed states, and ignores stale active/deleted/deleting requests. Deprovisioning marks the D1 row deleted before external cleanup, making cleanup retries idempotent and preventing a concurrent provisioning completion from restoring it.

Validation: Provisioner suite passed 4 files / 41 tests including status allow/deny cases; Provisioner TypeScript, Wrangler dry-run (14.25 MB / 2.57 MB gzip), and `git diff --check` passed. The state predicate is unit-tested; real concurrent D1 delivery and cleanup retry behavior still require a deployed queue/D1 exercise.

Refreshed tracked inventory after stale-message state guards in commit `7abe5a37`; the status guard and regression file are included in the checklist.

## Long conversation retrieval and channel-history pagination (2026-10-20)

Audited the conversation search/research prebuilt against the SpaceDO message route and the AgentDO channel transcript reader. Fixed a stale-cursor race in the scan-ceiling probe: if the cursor row disappears between requests, retrieval now reports an incomplete result instead of claiming the scan is complete. Channel transcript reads now accept a host-authorized older-message cursor and page limit, allowing search to continue beyond the initial 10,000-message window. The host callback and prebuilt enforce the 16 MiB content budget and preserve honest incomplete status when a single oversized item blocks progress.

Validation: final Agent worker suite passed 145 files / 644 tests; focused conversation and channel paging tests passed 17/17; Agent TypeScript passed. Regression cases cover a stale overflow cursor, channel pagination beyond 10,000 rows, exact older-page ordering, oversized host transcript input, and continuation across a mid-page 16 MiB byte-budget boundary. Tests use the SQLite DO shim and mocked SpaceDO HTTP response; distributed cursor deletion races and live DO response/storage limits remain unexercised. The conversation prebuilt and its tests plus the channel transcript test module are checked; `NaelaoAgentDO.ts` and `types.ts` remain unchecked as complete files because this was a scoped review of their channel-loading and host-callback sections.

Refreshed the tracked tree after code commit `dab89263`; it contains 1,961 tracked files and the checklist has 1,755 source/config files, preserving 250 reviewed rows.

## Tool result pagination bounds (2026-10-20)

Scoped the ScriptToolSurface result-paging helper and its invocation path. Found that `limit=0` could produce an empty page with an unchanged `next_offset`, and negative or very large limits were not bounded. The helper now normalizes limits to 1–200, floors and bounds offsets, and measures serialized output in UTF-8 bytes. Oversized scalar previews are cut on code-point boundaries within the byte budget.

Validation: tool-result pagination tests passed 5/5, final Agent suite passed 146 files / 649 tests, Agent TypeScript passed, Wrangler dry-run succeeded with all three sandbox images and a 18.1 MiB / 3.4 MiB gzip bundle, and `git diff --check` passed. Tests cover zero/negative/fractional/huge page limits and multibyte Unicode output. `tool-surface.ts` remains unchecked as a complete file; this was a review of its pagination helper and result delivery call site.

## Multilingual tool-output context accounting (2026-10-20)

Traced tool-output offload admission and found it estimated tokens from UTF-16 string length divided by 3.85. That undercounted CJK text by several times, allowing a multilingual result to exceed the context threshold without being offloaded. The estimate now counts UTF-8 widths and uses a conservative three-byte-per-token divisor, including astral characters.

Validation: new estimator tests passed 2/2; final Agent suite passed 147 files / 651 tests; Agent TypeScript and Wrangler dry-run passed; `git diff --check` passed. This is a deterministic estimate rather than tokenizer parity, and model-specific tokenization can still vary. `tool-output.ts` remains pending full-file checklist recording; its regression module is reviewed, and the change exercised estimate/offload admission only.

Refreshed the tracked tree after code commit `6705612d`; it contains 1,963 tracked files and the checklist has 1,757 source/config files, preserving 251 checked rows before marking the new estimator regression module reviewed.

## Bounded virtual CLI web-fetch response (2026-10-20)

Traced the `fetch-md` CLI from the Agent worker to the internal Knowledge service. Knowledge caps upstream page text, but the Agent service-binding client used unbounded `response.json()` and trusted a TypeScript-only payload shape. Replaced it with a 1 MiB bounded JSON reader and runtime validation for URL, HTTP status, content type, format, truncation, and a 100 KB UTF-8 content ceiling. Invalid and oversized worker responses now fail closed before they enter tool context.

Validation: focused service-response tests passed 4/4; Agent suite passed 148 files / 655 tests; Agent TypeScript and Wrangler dry-run passed; `git diff --check` passed. The internal handler is unit-tested for malformed, oversized, error and valid payloads; a live Worker service binding is not exercised. `code-exec.ts` remains unchecked as a full file; this pass reviewed its fetch callback and added a focused helper regression test.

Refreshed the tracked tree after code commit `66b16bd3`; it contains 1,964 tracked files and the checklist has 1,758 source/config files, preserving 252 checked rows before marking the new service-response regression module reviewed.

## Virtual CLI provider write idempotency (2026-10-20)

Traced the built-in provider command dispatch through Vault to Credentials. Generic `api request` forwarded the required replay key, but built-in non-read commands dropped `--idempotency-key`; the Credentials egress boundary rejects all such requests, so writes such as `resend emails send` could never succeed. Built-in writes now require the same bounded key syntax, forward it to Vault, and omit it from the provider body.

Validation: focused virtual CLI tests passed 13/13, including missing-key denial and successful Resend dispatch; full Agent suite passed 148 files / 656 tests; Agent TypeScript and Wrangler dry-run passed; `git diff --check` passed. This slice reviewed `VirtualCliDispatcher` provider write handling only; provider-specific endpoint grammar for Stripe/GitHub/R2/Twilio remains under audit.

Refreshed the tracked tree after code commit `94355922`; it remains 1,964 tracked files and 1,758 source/config files, preserving 253 checked rows.

## Stripe virtual CLI action grammar (2026-10-20)

Continued the provider command pass and found Stripe actions were inserted into the URL (`/customers/retrieve`) instead of mapping verbs to resource/item endpoints. The command now has explicit supported actions and ID requirements, resource path segments are encoded independently, GET flags become query parameters, and writes use Stripe's URL-encoded form format. The earlier built-in write idempotency requirement applies to POST/DELETE actions here as well.

Validation: virtual CLI suite passed 14/14 including list, retrieve, form-encoded create, missing ID, and missing idempotency cases; full Agent suite passed 148 files / 657 tests; Agent TypeScript, Wrangler dry-run, and `git diff --check` passed. This implementation covers the declared generic Stripe command grammar; it does not validate every Stripe API resource/action against Stripe's live schema. `virtual-cli.ts` remains unchecked as a full file.

Refreshed the tracked tree after code commit `eb2e761f`; counts remain 1,964 tracked files / 1,758 source/config files, with prior review rows preserved before marking the CLI regression module complete.

Refreshed the tracked tree after code commit `cc2e2b97`; it contains 1,962 tracked files and the checklist has 1,756 source/config files, preserving 250 reviewed rows before marking the new focused regression module reviewed.

## Twilio virtual CLI auth and outbound credential containment (2026-10-20)

Continued the provider CLI pass and traced Twilio through the signed Vault proxy into Credentials. Found the command could not succeed: it generated a non-account-scoped URL and the final egress layer always replaced Authorization with Bearer, while Twilio REST requires account-scoped URLs and Basic auth. Added a narrow explicit Basic mode where the username is validated and the password remains the vaulted secret; Twilio now requires an Account SID, maps supported collection/item actions, and encodes GET parameters and write fields correctly. The Credentials worker still owns secret resolution and header construction.

The same boundary review found two security gaps: an upstream could reflect the injected Basic Authorization header into its response, and cross-origin read redirects kept forwarding credentials. Responses now redact both the raw secret and injected Authorization value, and redirect handling strips Authorization when the origin changes. The request receipt input hash now includes auth mode so replay checks bind to the effective auth shape.

Validation: Agents suite passed 148 files / 659 tests; focused Virtual CLI and Vault proxy tests passed 18/18; Credentials focused suite passed 6/6; Agents and Credentials TypeScript passed; Wrangler dry-run succeeded for both workers; `git diff --check` passed. Tests cover Twilio account URL/action mapping, auth-mode forwarding, Basic header construction/validation, reflected-secret redaction, and cross-origin redirect credential stripping. This pass reviewed the Twilio dispatch and selected Credentials outbound-auth/redirect/response handling; `virtual-cli.ts` and Credentials `index.ts` remain unchecked as full files. GitHub and R2 command endpoint grammars remain under review.

Refreshed the tracked tree after code commit `ba9cf2ff`: 1,965 tracked files and 1,759 source/config files. Preserved prior completed checklist rows and marked the newly reviewed Vault proxy and outbound-auth regression modules complete. The provider dispatcher and Credentials worker implementation files remain open for full-file review.

## GitHub and Cloudflare R2 virtual CLI endpoints (2026-10-20)

Continued the same provider dispatch trace. The GitHub shortcut `gh repos list` previously built `/repos`, which is not a usable collection route, and the positional router could not represent nested GitHub REST resources. Added a validated `gh api <endpoint-path>` route with bounded REST verbs, path-segment validation, JSON body/query parameter parsing, and the existing write idempotency requirement. The common `gh repos list` shortcut now targets `/user/repos` and preserves scalar pagination/filter flags.

The R2 shortcut previously called a bucket/action path without an account ID. Replaced it with explicit Cloudflare account-scoped bucket list/get/create/delete routes; validates account and bucket identifiers, maps create to the collection endpoint with `name` and optional `locationHint`, and does not pretend the control-plane API token supports S3 object operations. Delete requests omit empty bodies.

Validation: full Agents suite passed 148 files / 661 tests; focused virtual CLI tests passed 17/17; Agent TypeScript and Wrangler dry-run passed; `git diff --check` passed. Mocked transport assertions cover GitHub nested path/query/write mapping and traversal/method rejection, plus each R2 bucket operation and invalid account/bucket rejection. No live GitHub, Cloudflare, Stripe, Resend, or Twilio credentials were used; provider behavior beyond request construction is not live-verified. `virtual-cli.ts` remains open for full-file audit; API provider mappings still have future gaps to review (including whether each CLI intentionally exposes a sufficiently documented subset).

Refreshed the tracked tree after code commit `c5dffcd1`: 1,965 tracked files and 1,759 source/config files; prior checked rows were preserved. This provider pass added no source files.

## Bounded linear-time credential response redaction (2026-10-20)

Stress testing the new auth redaction uncovered a resource issue in its original matcher: a large secret compared against an 8 MiB response could trigger quadratic byte comparisons, while many short-secret matches could allocate millions of output chunks. Replaced it with a KMP byte matcher (linear time per secret), two-pass exact output sizing, and a 16 MiB post-redaction ceiling. If repeated secret matches would expand a response past that ceiling, the response is replaced with a fixed safe omission marker. This applies to the raw vaulted secret and the injected Authorization value.

Validation: Credentials suite passed all 8 tests, including a repeated-prefix adversarial case and 2 MiB short-secret repetition; Credentials TypeScript and Wrangler dry-run passed; `git diff --check` passed. These are deterministic matcher and handler-adjacent tests; no live provider echo behavior was exercised.

Refreshed the tracked tree after code commit `45d54a35`: 1,966 tracked files and 1,760 source/config files. No source files were added or removed in this follow-up; checklist rows are unchanged.

Follow-up during auth interoperability review: Basic-auth construction now Base64-encodes UTF-8 bytes in bounded chunks instead of relying on `btoa`'s Latin-1 input, so Unicode provider secrets do not fail or truncate. Credential tests cover a non-ASCII vaulted password; the full Credentials suite (8 tests), typecheck, and Wrangler dry-run passed again.

Refreshed the tracked tree after code commit `2bc9d755`: 1,966 tracked files and 1,760 source/config files; checklist inventory counts remain stable.

## Tenant-bound Credentials HMAC ingress (2026-10-20)

The Credentials token verifier allowed legacy HMAC claims without `tid` to reach internal plaintext and outbound routes. Because each route resolves data using the caller-supplied tenant header, this left a tenant-binding gap for any reused/colliding space identifier or legacy integration. Both internal receiving boundaries now require the signed token tenant to equal the request tenant before policy reads, credential resolution, or provider fetch. Current service callers already mint tenant claims; affected test helpers now model that contract. Token parsing also rejects duplicate/unknown fields, malformed timestamp encodings, oversized tokens, and non-64-hex signatures instead of accepting `parseInt`-style non-canonical timestamps.

Validation: Credentials suite passed 10/10; credential hierarchy tests passed 37/37; encrypted vault/egress plan tests passed 5/5; Credentials TypeScript and Wrangler dry-run passed. Regressions verify tenantless outbound and plaintext tokens are rejected, malformed/duplicate claims fail closed, and valid tenant-bound tokens preserve the existing vault flows. This intentionally drops acceptance of tenantless legacy tokens at the receiving routes; repository production callers and updated tests supply tenant IDs. `verifyCredentialToken` remains callable internally only and no external route accepts an unscoped token.

Refreshed the tracked tree after code commit `4cc122ff`: 1,966 tracked files and 1,760 source/config files; existing checklist rows were preserved.

The tenant-token follow-up also made HMAC parsing canonical: repeated or unknown token fields and partial numeric timestamps are now rejected before signature verification. A separate plaintext-route regression confirms tenantless legacy tokens are denied there as well as at outbound egress. Re-ran the affected suites: Credentials 10/10, credential hierarchy 37/37, and vault plan 5/5 passed.

## Shared bounded HTTP reader ceilings (2026-10-20)

Audited the shared request/response stream readers and their call sites. `readBoundedResponseText` and `readBoundedRequestBytes` trusted the numeric ceiling without validating it; with `NaN`, the `total > maximumBytes` checks were always false, defeating the memory bound. Both now require a non-negative safe integer before inspecting or consuming a stream. JSON/text wrappers inherit the validation, and the prefix reader already enforced the same contract.

Validation: `packages/http` suite passed 30/30 and typecheck passed; Agents suite passed 148 files / 661 tests, Agents typecheck and Wrangler dry-run passed; Credentials suite passed 10/10 and typecheck passed. New cases cover NaN, Infinity, unsafe integers, and negative ceilings for request and response reads. Call-site search across packages/workers/apps/tests shows the consumed limits are fixed values or module constants; broader individual call-site feature reviews remain in the file-by-file plan.

Refreshed the tracked tree after code commit `97dd605d`: 1,966 tracked files / 1,760 source and executable-configuration files. Marked the bounded-reader implementation and focused regression module reviewed; their larger worker call sites remain separately unchecked.

## Shared bounded pagination parser coverage (2026-10-20)

Reviewed `parseBoundedInteger` and enumerated its callers across Agents, Spaces/DOs, Knowledge, Threads, Search, Marketplace, Admin, and Mini-AGI. Bounds validation is explicit, parsing rejects fractions/exponents/unsafe integers, and values clamp to endpoint-specific limits. There was no focused regression module for this shared parser, so added coverage for missing/malformed/unsafe values, whitespace, negative values, both clamp edges, and invalid fallback/bounds. No implementation defect was found in this helper; endpoint-specific pagination semantics remain part of each worker review.

Validation: `packages/http` suite passed 33/33 and typecheck passed; `git diff --check` passed.

Refreshed the tracked tree after code commit `3ff4c111`: 1,967 tracked files and 1,761 source/config files; marked the pagination helper and its new stress module reviewed.

## Security request-body inspections and tee cancellation (2026-10-20)

Traced the two clone-based request inspectors in `packages/security`: the upload-size guard and WAF JSON body reader. Found the WAF helper accepted invalid byte ceilings, so NaN disabled its `total > maxBytes` bound. Also found both inspectors canceled only the cloned tee branch after an oversized chunked body; the untouched original branch could keep the tee's source alive and accumulate unread upload data while the endpoint returned an error. The WAF helper now validates a non-negative safe integer, and both helpers cancel clone and original branches together on an oversized streamed body. Declared-length rejects remain non-consuming.

Validation: Security package suite passed 21 files / 110 tests and typecheck passed; Agents suite passed 148 files / 661 tests, Agent typecheck and Wrangler dry-run passed. New regressions check invalid ceilings and underlying stream cancellation, while existing tests confirm declared-length fast rejection and downstream readability for valid bounded bodies. These are runtime stream simulations; Cloudflare's production request-body source behavior is not load-tested.

Refreshed the tracked tree after code commit `e4db8d7e`: 1,967 tracked files and 1,761 source/config files; marked the request-body guard and its regression suite reviewed.

## Entitlement tier validation and immutable plan limits (2026-10-20)

Reviewed the shared plan-limit table and its direct callers in Agents and Knowledge. `getTenantTier` cast arbitrary database strings to `PlanTier`, so an unexpected stored value could return undefined limits and break quota/feature checks. It now validates against the four known tiers and uses the restrictive `free` tier for missing or corrupt values; direct `getPlanLimits` calls also fall back to free for invalid runtime input. The returned tier object was a mutable shared singleton, allowing one caller to alter quota values seen by subsequent checks. Limits are now frozen and exposed as readonly.

Validation: existing entitlement tests plus new malformed-tier/mutation regressions passed 24/24; entitlements package typecheck passed; Knowledge suite passed 6 files / 25 tests with typecheck; Agents suite passed 148 files / 661 tests, typecheck, and Wrangler dry-run. This reviewed the common entitlement helper and its Agents/Knowledge consumers; other workers that query `plan_tier` directly remain open for separate review.

Refreshed the tracked tree after code commit `afa05301`: 1,968 tracked files and 1,762 source/config files; added the new entitlement stress module to the inventory and checked the reviewed package, compiler config, implementation, and tests.

## Events registries and legacy project-kind compatibility (2026-10-20)

Reviewed `packages/events` package exports/configuration and traced the feature-kind checks into Agents and SpaceDO project creation/update validation, plus failure-kind validation into SpaceDO and business diagnostics. The feature registry exposed mutable shared entries and nested `prebuiltScripts`; the failure-kind vocabulary was also mutable. All registry entries, nested arrays, the registry itself, filtered role views, failure vocabulary, and structural-kind vocabulary are now frozen and typed readonly. While rebuilding the package to ensure tests exercised current output, its existing regression suite exposed a separate mismatch: `customer_bot` is still present in SpaceDO migrations, normalization logic, tests, and legacy project handling, but `isKnownProjectKind()` rejected it. The shared structural allowlist now retains `customer_bot` as a compatibility kind alongside `workspace`.

Validation: rebuilt `@naelao/events`; focused events and root tests passed (4 files / 70 tests); Agents suite passed (148 files / 661 tests); Spaces suite passed (64 files / 247 tests); events package, Agents, and Spaces typechecks completed without diagnostics; `git diff --check` passed. The registry immutability regressions verify mutation attempts fail without changing role gates or accepted kinds. The compatibility behavior remains intentionally available for existing customer-bot projects; migrations that rewrite these to workspace remain in place.

Refreshed the tracked tree after code commit `4e6eabba`: 1,968 tracked files and 1,762 source/config files. Marked the events package metadata/config, inspected exports and registry implementations, and the two focused regression modules reviewed; broader package integration tests were run but remain separately unchecked pending their own source review.

## Browser scratchpad ciphertext bounds (2026-10-20)

Reviewed the Agent SDK package boundary and scratchpad helpers, then traced them to the browser UI and SpaceDO write guard. Space Worker requests are globally bounded at 8 MiB, but the exported ciphertext parser had no independent envelope ceiling and accepted noncanonical Base64 while decoding attacker-controlled values. Added a 1 MiB UTF-8 plaintext ceiling, a corresponding AES-GCM envelope/ciphertext maximum, canonical Base64 validation, and early string-length rejection before UTF-8 allocation. Exported the maximum so clients can use the same contract. Added boundary tests for exact 1 MiB Unicode payloads, over-limit byte and character counts, oversized envelopes, and noncanonical encoding.

Validation: Agent SDK suite passed 26 files / 123 tests; SDK build and typecheck passed; existing root scratchpad/token-accounting tests passed 4/4; SpaceDO private-scratchpad tests passed 2/2 and Spaces typecheck passed; `git diff --check` passed. Browser key loss on refresh remains the documented scratchpad behavior; this slice bounds memory and parser work but does not change key lifecycle or retention.

Refreshed the tracked tree after code commit `56e8cd70`: 1,969 tracked files and 1,763 source/config files. Added and checked the new scratchpad boundary test in the per-file plan; the broader Agent SDK implementation files remain unchecked pending individual review.

## No-code subagent manifest compiler integrity (2026-10-20)

Traced the Agent SDK no-code subagent compiler into the Subagent Studio UI. The trust-boundary function shallow-froze `trigger.configuration`, preserving nested caller aliases, and spread the full input manifest so undeclared fields could pass into durable dispatch. It also lacked size/depth limits for trigger configuration and relied on TypeScript-only assumptions for runtime inputs. The compiler now validates role/resource shapes and ceilings, bounds tools/knowledge bases/triggers and JSON configuration size/depth/node count, rejects cycles/accessors/non-JSON values, recursively clones and freezes configuration, trims display fields, and emits only its declared manifest shape. Capability filtering semantics remain unchanged.

Validation: Agent SDK full suite passed 26 files / 126 tests; Agent SDK typecheck and Apps Shell typecheck passed; `git diff --check` passed. New regressions prove nested source mutations cannot alter compiled output, nested values are frozen, unknown top-level fields are dropped, and sparse/invalid/cyclic/oversized configurations and invalid rank claims fail closed. This compiler is invoked by the Subagent Studio client; server-side persistence/dispatch validation remains a separate route review item.

Refreshed the tracked tree after code commit `7e040022`: 1,969 tracked files and 1,763 source/config files; the checked rows cover the compiler and its tests only.

## Ephemeral subagent snapshot and model-budget bounds (2026-10-20)

Reviewed `spawnSubagentVerb` and its RuntimeFileSystem/RuntimeAi contracts. Workspace snapshots previously read every path at once with an unbounded `Promise.all`, took a full copy both before and after execution, and allowed NaN/fractional configured or child token budgets into the model adapter. Snapshot work is now capped at 10,000 distinct normalized paths and 16 MiB of aggregate text, with at most eight reads in flight. Over-limit or initial snapshot errors return a structured failure before task execution; post-run snapshot errors also remain contained. Task text is capped at 64 KiB, token budgets must be positive safe integers, and each model request is clamped to the subagent's maximum of 1,999 tokens. Failure receipts are control-character cleaned and capped at 500 characters.

Validation: Agent SDK suite passed 26 files / 129 tests; SDK typecheck passed; `git diff --check` passed. Regressions cover invalid/NaN/fractional budgets, file-count and total-size ceilings, bounded snapshot concurrency, and preservation of the existing changed-file reporting. The exported helper currently has no production call site in this repository; this hardens the public SDK contract but does not establish that a production planner uses this local helper.

Refreshed the tracked tree after code commit `2695b1c8`: 1,969 tracked files and 1,763 source/config files; only the subagent helper and its focused test were checked in this slice.

## Provider token-usage sanity ceiling (2026-10-20)

Reviewed the Agent SDK usage parser and its Agents worker consumers. `validProviderUsage` accepted any nonnegative safe integer and returned it for use in run token totals and billing; two maximum safe integers could overflow when consumers summed them, and a single bogus report could manufacture an implausible charge. It now accepts only plain non-array objects whose input+output sum is at most 10 million tokens per call, rejects hostile property access cleanly, and exposes the ceiling as SDK metadata. This ceiling is deliberately above current provider context sizes; reports above it are treated as invalid and omitted from provider usage accounting.

Validation: Agent SDK suite passed 27 files / 132 tests; its build and typecheck passed; Agents suite passed 148 files / 661 tests and Agents typecheck passed; root token-accounting regression module passed 4/4; `git diff --check` passed. Focused cases cover exact ceiling, over-ceiling totals, maximum-safe-integer overflow, arrays, throwing getters, and large estimate arithmetic.

Refreshed the tracked tree after code commit `d7c8773c`: 1,970 tracked files and 1,764 source/config files; added the new accounting regression test to the checklist and checked the two reviewed token-accounting files.

## Normalized inbound channel envelope validation (2026-10-20)

Traced `toNormalizedInboundMessage` into `NaelaoAgentDO.handleChannelInbound`; provider adapters perform their own webhook parsing and this helper builds the shared envelope used for normalized text. The helper previously checked sender/external IDs only for truthiness, accepted arbitrary finite timestamps, passed caller attachment arrays through by reference, and had no text or attachment bounds. It now requires bounded control-free string IDs, safe integer timestamps within the JavaScript date range, caps UTF-8 message text at 1 MiB and attachments at 20, validates attachment type/MIME/HTTP(S) URL shape, and copies attachment metadata into the envelope. Provider signature verification and provider-specific attachment fetching remain separately audited.

Validation: Agent SDK channel-envelope tests passed 5/5; Agent SDK and Agents typechecks passed; `git diff --check` passed. Regressions cover wrong-type/control/oversized identities, invalid timestamps, exact and over-limit Unicode payloads, malformed URLs, attachment count limits, and source-object mutation after normalization.

Refreshed the tracked tree after code commit `c13c7f20`: 1,970 tracked files and 1,764 source/config files; marked the normalized envelope implementation and its stress tests reviewed.

## Extension manifest path and complexity validation (2026-10-20)

Reviewed the shared extension manifest and bundle parsers and traced them to SpaceDO installation, Spaces Worker upload routes, the channel-only installer, and runtime catalog validation. The legacy `SAFE_PATH` accepted `../` segments in gadget, daemon, and command references; composed `CONTRACT_PATH` also accepted traversal segments. Both now accept only bounded relative path segments that cannot be `.` or `..`. Manifest kernel-override screening used recursive descent with no depth/work limit, so deeply nested input could exhaust the call stack; it is now iterative, detects cycles, caps depth at 64 and visited objects at 100,000, and permits ordinary shared references. Top-level permissions, capability requirements, gadgets, daemons, and commands also have explicit collection ceilings.

Validation: Agent SDK suite passed 27 files / 138 tests; Spaces extension/gadget route tests passed 7/7; Agents channel extension/media tests passed 27/27; Agent SDK, Spaces, and Agents typechecks passed; `git diff --check` passed. Added regressions exercise traversal across legacy and composed paths, deep/cyclic manifests, and collection overages. Existing dogfood manifests and published starter bundle tests continue to pass.

Refreshed the tracked tree after code commit `5691ee75`: 1,970 tracked files and 1,764 source/config files; checked only the extension validator and its stress suite in this slice.

## Artifact linter memory and output ceilings (2026-10-20)

Traced structural artifact linting through the SpaceDO validation endpoint. The endpoint already rejected content above 2 MiB of JavaScript string length, but the exported `lintArtifact` helper could be called directly with unlimited content. It also built a diagnostic object for every unexpected key before truncating to 128, multiplying memory use on a malformed large JSON object. The helper now rejects over-limit input before `JSON.parse`, bounds configured linter paths to 512 characters, and stops allocating diagnostics at the 128-item limit. Policy cardinality bounds remain in effect (32 linters, 64 fields each).

Validation: Agent SDK artifact-linter tests passed 4/4; SpaceDO artifact-linter route test passed 1/1; Agent SDK and Spaces typechecks passed; `git diff --check` passed. New cases exercise oversized input, path traversal/path length, and a JSON object with 10,000 unexpected fields. The SpaceDO endpoint's existing body boundary and workflow storage remain separately checked in their own file rows.

Refreshed the tracked tree after code commit `7cac8226`: 1,970 tracked files and 1,764 source/config files; marked the artifact-linter implementation and focused regression module reviewed.

## Artifact repository client request/response bounds

Reviewed the public Agent SDK Artifact Repository adapter and existing response stress tests. The adapter already bounded success responses at 16 MiB and error responses at 8 KiB, canceled oversized streams, rejected invalid UTF-8, encoded scope/query identifiers, and used fixed operation names. Outbound JSON bodies had no ceiling and were serialized before any request check. Added a bounded JSON serializer with cycle/accessor/type/depth/node checks, a 2 MiB encoded request limit, and header cloning before setting content type. The client has no in-repository production callsite today, but it is exported from the SDK for consumers.

Validation: Agent SDK full suite passed 27 files / 142 tests; package typecheck passed; `git diff --check` passed. Regressions verify oversized input is rejected before binding fetch and caller headers remain unchanged, alongside the existing streamed success/error response limit tests.

Refreshed the tracked tree after code commit `3f8df7a2`: 1,970 tracked files and 1,764 source/config files; marked only the Artifact client contract and its focused suite reviewed.

## Customer-bot capability and task-scoped attachment operations

Reviewed the SDK CustomerBotContext projection and the Agents customer-bot/attachment prebuilt operations. The capability projection is an allowlist with no privileged handles, and tool names/tier checks fail closed. Found the appointment operation sent `start_at`/`end_at` while SpaceDO reads `start_date`/`end_date`, making the supported calendar lookup fail for valid requests. Corrected the parameter mapping and validate ordered bounded date inputs before egress. FAQ queries and top-k values now have explicit limits; canned-response selection uses own-property checks (so inherited keys such as `toString` are not accepted); escalation reasons are bounded. Attachment responses now use the shared 2 MiB bounded JSON reader, and transcription language hints are restricted to bounded language tags.

Validation: Agents suite passed 149 files / 666 tests; targeted customer-bot and customer-attachment tests passed 10/10; SDK capability-context tests passed 3/3; Agents and Agent SDK typechecks passed. Regressions cover the calendar query contract, invalid date ranges, FAQ limits, prototype-property canned keys, escalation length, oversized downstream responses, and malformed language hints.

Refreshed the tracked tree after customer-bot code and test commits `aa0e90c0` / `b7f907f6`: 1,971 tracked files and 1,765 source/config files; included and checked the new customer-bot regression test.


## Document processing and ScaleDown boundaries (2026-10-20)

Traced the Agent SDK document gateway and chunked summarizer through the Agents worker dispatcher, durable document workflow, PDF/text partitioner, and ScaleDown provider adapter. Existing host boundaries cap workspace text at 2 MiB, partition sources at 10 MiB, extracted text at 1.5 MiB, PDF pages at 100, workflow partitions at 24, document calls at 48 per workflow, provider request/response bytes at 2 MiB, and provider work at an abort timeout. The SDK chunk helper also preserves original UTF-16 text across boundaries and rejects inputs that require durable partitioning.

Found two remaining SDK edge cases: a gateway adapter could return malformed or oversized summary text that the helper would forward into the merge request, and finite inputs to the cost estimator could overflow to `Infinity`. The helper now validates runtime text/options, rejects malformed or over-16k-character partial/final summaries, and the estimator returns `null` for non-finite arithmetic. Added regression tests for invalid instructions, oversized model results, and numeric overflow.

Validation: Agent SDK suite passed 27 files / 143 tests; document-files, ScaleDown, and worker document-dispatch suites passed 19/19; Agent SDK and Agents typechecks passed; Biome check passed. `pnpm` preflight could not run these commands because it repeatedly resolved the full workspace, exceeded its 2 GiB heap in one concurrent invocation, and separately rejected an ignored dependency build script; direct local binaries succeeded.

Reviewed and checked only the SDK document-processing implementation/test, shared document-files implementation/test, ScaleDown implementation/test, and worker document-processing implementation/test. The large `NaelaoAgentDO.ts` integration was traced to the document processor and call-budget methods but remains unchecked pending full-file review.


## Conversation transcript pagination at aggregate byte ceiling (2026-10-20)

Reviewed the conversation search and research prebuilt against the SpaceDO message endpoint and the channel transcript reader. Search is scoped to the host-authorized current thread, uses exact `before_id` cursors, scans newest to oldest in 100-row pages, caps total transcript work at 10,000 messages / 16 MiB, bounds each service response, and sends only top matching excerpts into document processing. Both readers report incomplete scans rather than claiming absence; stale cursors fail explicitly.

Found a pagination gap in SpaceDO-backed scans when the 16 MiB ceiling cut through a chronological page. The code retained the page's oldest prefix, while the continuation cursor only moves older, so newer rows dropped from that page could not be recovered. It now retains the newest contiguous suffix and returns the oldest retained row as the continuation cursor; a follow-up search reaches the dropped older prefix. Added regressions spanning an actual simulated 16 MiB boundary with service-sized pages and a mid-page cut.

Validation: conversation search tests passed 16/16; full Agents worker suite passed 149 files / 667 tests; Agents worker typecheck passed; `git diff --check` passed.

Checked only `conversation.ts` and its focused test in this slice. The Agent DO channel reader and SpaceDO transcript endpoint were traced and their focused tests ran in the full suite, but both large files remain unchecked pending full-file review.


## Knowledge retrieval isolation, request bounds, and derived context (2026-10-20)

Traced the Agent SDK knowledge-base operations through the Knowledge Worker search route and the shared RAG Vectorize filter. The worker applies tenant/space ownership in its `/spaces/:spaceId/kb/*` middleware before the search handler, then checks air-gap policy, role/project scope, and ACL-filtered retrieval. Dense candidates are role and user filtered before BM25 reranking; retrieved text is marked untrusted and citations remain attached to derived summaries.

Found that the prebuilt sent `x-naelao-role: owner` whenever `effectiveRole` was absent. In an acting-user run, a missing role claim therefore widened the retrieval role mask. The prebuilt now preserves explicit effective/caller roles, uses viewer for user-bound runs missing those claims, and keeps owner for userless host runs. Also bounded semantic queries to 1,000 characters at both the prebuilt and worker route, validated top-k before egress, bounded and type-checked prebuilt indexing inputs to the worker contract, and replaced an unbounded `response.json()` for shared documents with the 2 MiB streaming JSON reader before truncation.

Validation: Knowledge Worker suite passed 7 files / 27 tests; focused knowledge-base tests passed 8/8; new worker route tests verify foreign-Space denial and query rejection before Workers AI/Vectorize; Agent and Knowledge Worker typechecks passed; `git diff --check` passed.

Checked only the Agent knowledge-base prebuilt and focused tests. The Knowledge Worker's search route/middleware and new regression test were traced, but `workers/knowledge/src/index.ts` remains unchecked because it is a large file and only its retrieval/ownership sections were reviewed. The RAG Vectorize helper had previously been reviewed and checked in the earlier batch-05 stress pass.


## Web search, guarded fetch, and file download ceilings (2026-10-20)

Traced the web-search prebuilt into the Knowledge Worker search/fetch/extract/download routes, shared SSRF checker, DNS-over-HTTPS resolver, and workspace CAS write. Redirects are manual and every destination is rechecked; fetched text is stream-capped at 100,000 bytes; downloads distinguish 2 MB text from 12 MB binary and cancel oversized streams; downloaded files are status-checked, decoded, and CAS-published into the scoped workspace.

Found that the prebuilt used the same 4 MiB response cap for every operation even though a maximum 12 MB binary is returned as about 16 MB of Base64, so larger valid downloads always failed before workspace write. It now gives download responses a 17 MiB JSON ceiling, caps the existing-object hash read at 12 MB, bounds URL/query/result/name inputs before egress, and keeps filenames within 255 characters. Knowledge Worker search and URL routes now enforce the same limits directly; malformed tool payloads fail with 400 rather than type errors. DNS-over-HTTPS, external page fetches, and Tavily requests now have explicit timeouts (5 / 30 / 15 seconds).

Validation: Agents full suite passed 150 files / 673 tests; Knowledge Worker suite passed 7 files / 29 tests; Security suite passed 21 files / 111 tests; Agent, Knowledge, and Security typechecks passed; `git diff --check` passed. Added a 5 MB Base64 response regression proving a 3.75 MB binary file reaches R2 as decoded bytes, along with URL/query/result/name bounds and DNS timeout coverage.

Checked only the web-search prebuilt, the web-fetch test module, and shared SSRF checker. The large Knowledge Worker `index.ts` was inspected only around web-search endpoints and remains unchecked pending full-file review.


## RAG document ingestion and oversized Markdown tables (2026-10-20)

Traced PDF content through `chunkStructuredMarkdown`, the Knowledge Worker embedding batches, Vectorize metadata, and R2 citation chunks. Found that Markdown tables were treated as atomic at any size. A single large table could exceed the embedding model's per-input limit and fail indexing; CRLF-normalized structural chunks could also lose accurate source positions when the worker searched for their text in the original document.

Structured Markdown now splits oversized tables at row boundaries, repeats the table header in each bounded chunk, splits unusually long rows without cutting UTF-16 surrogate pairs, validates chunk limits, and records source spans in the original text. The Knowledge Worker now uses those spans to derive byte and line citation coordinates. Added regression coverage for oversized CRLF tables, repeated headers, source ranges, bad limits, and emoji boundary splits.

Validation: RAG package suite passed 4 files / 25 tests; Knowledge Worker suite passed 7 files / 29 tests; RAG and Knowledge Worker TypeScript checks passed; `git diff --check` passed. The repository-local Biome binary was unavailable in this workspace, so formatting checks were not run.

This is a focused review of the RAG chunker and the Knowledge Worker document-ingestion coordinate path. `workers/knowledge/src/index.ts` remains unchecked overall; its many other route, authorization, database, external-fetch, and storage paths still need caller-by-caller review.


## Cohere Parse provider boundary (2026-10-20)

Traced `createParseV5Request` from the Knowledge Worker PDF ingestion route to Cohere's v2 Parse endpoint. The route bounds the incoming JSON field, but the helper itself had no direct upload-byte cap, no request timeout, and accepted extracted Markdown up to the 16 MiB response envelope. That result then bypassed the worker's 1 MiB input document limit. Provider JSON was also trusted as its declared TypeScript shape.

Added a 10 MiB direct upload cap, a 30 second request timeout, sanitized network/provider failures, response-shape validation, and a 1 MiB extracted-Markdown cap before returning data to the indexer. The existing 16 MiB streamed response ceiling remains in place to bound JSON parsing. Added coverage for limits, timeout signal, malformed body shape, upstream status, missing API configuration, and empty documents.

Validation: Knowledge Worker suite passed 7 files / 32 tests; Knowledge Worker TypeScript check and `git diff --check` passed.

Checked `parse-v5.ts` and `parse-v5.test.ts`. Its sole in-repository caller is the PDF ingestion route in `workers/knowledge/src/index.ts`; that large module remains unchecked overall.


## Knowledge Worker sparse reranking boundaries (2026-10-20)

Traced `sparseRank` from the grounded retrieval route. It receives only the ACL-filtered Vectorize/SQL candidates, currently at most twice the requested top-k (up to 100 hits). Its standalone helper nevertheless accepted arbitrarily large query strings, candidate populations, and candidate text, leaving future callers or legacy oversized chunks able to create unbounded tokenization work.

Added explicit 1,000-character query and 200-candidate ceilings, capped text scanned per candidate at 16,384 characters while preserving full hit content in results, and validated candidate IDs/content. Also filtered zero-score BM25 results: the underlying implementation returns candidates with score zero despite its documented “zero-score docs excluded” contract, causing irrelevant sparse hits to enter RRF. Added tests for ranking, caps, malformed candidates, long content, and omitted late matches.

Validation: Knowledge Worker suite passed 8 files / 35 tests; Knowledge Worker TypeScript check and `git diff --check` passed.

Checked `search.ts` and the new `search.test.ts`. Repository search found `sparseRank` called only from the grounded retrieval route; `hybridRank` currently has no production caller. The authorization adapter in `auth.ts` also has no discovered in-repository caller and remains pending a separate contract and dead-code review.


## Knowledge Worker authorization adapter dead-code check (2026-10-20)

Triple-checked `workers/knowledge/src/auth.ts` before removal: full tracked-source search found no import or callsite; `workers/knowledge/wrangler.toml` and `package.json` both identify `src/index.ts` as the only runtime entry; no test imported the adapter. Its only behavior was a pass-through to the shared, still-exported security implementation, which has its own tests. Removed the unreferenced Worker wrapper while retaining the shared security API.

Validation after removal: Knowledge Worker suite passed 8 files / 35 tests; Knowledge Worker TypeScript check and `git diff --check` passed; repository search confirms no remaining Worker adapter references.


## Knowledge Worker route middleware ordering and external publications (2026-10-20)

Mapped all route registrations in the 1,697-line Knowledge Worker entry file. The external publication list/create/delete and internal published-collection search handlers were registered before the `/spaces/.../kb/*` and `/internal/spaces/.../kb/*` HMAC guards. A route test without an internal token returned HTTP 200, proving those early handlers bypassed the later middleware. The same early routes also ran before the KB tenant-to-space ownership gate.

Moved the shared HMAC and ownership middleware ahead of all routes. Added regressions proving the project publication list and service-only external search reject unsigned requests; existing tests continue to prove signed project actions and retrieval work. No endpoint behavior or signature format changed.

Validation: Knowledge Worker suite passed 8 files / 36 tests; Knowledge Worker TypeScript check and `git diff --check` passed.

This closes the early-route group (publication list/write/delete and external collection search) and their test module. The main `index.ts` remains unchecked overall; later route groups and every DB/R2/Vectorize side-effect path still need review.


## Knowledge document lifecycle routes (2026-10-21)

Reviewed list, ingest, update, delete, and citation retrieval paths. Project-scoped list/search/update/delete routes did not consult the project ACL, so a caller with a valid internal service token and space access could address a project by ID without proving project membership. Project document list/search/update/delete now call the shared project access guard.

Ingestion silently filtered malformed `allowed_user_ids` and clamped invalid role ranks, which could turn a malformed private-document request into a broadly visible document. These ACL fields and project IDs now validate strictly; PDF Base64 is decoded and checked before a processing row or R2 object is created. Content reindexing previously rewrote every vector as public and dropped sovereign-user ACLs. It now reads the first chunk's ACL metadata before mutation, applies the more restrictive persisted role rank, and preserves the user allowlist; missing or malformed ACL metadata fails closed. Reindex embedding now completes before the old index is deleted, so model failure keeps the prior indexed content intact. Provider errors carrying HTTP status are translated into the shared `HttpError` contract instead of becoming generic 500s.

Added lifecycle tests for malformed ACL/PDF requests, valid private ACL storage, ACL preservation, missing vector metadata, embedding failure before deletion, and project membership gates for listing/editing/deleting.

Validation: Knowledge Worker suite passed 9 files / 42 tests; Knowledge Worker TypeScript check and `git diff --check` passed.

This is a focused pass of the five document routes and their test module. `workers/knowledge/src/index.ts` remains unchecked overall; cancellation/partial-write behavior after destructive reindex begins, deletion partial failures, and other route groups need further review.

During the same route pass, I replaced every remaining `c.req.json()` in the Knowledge Worker with the shared streaming request-byte reader and per-endpoint ceilings. Document JSON allows 6.5 MB to support the existing 1 MiB character contract with JSON escaping; smaller metadata, search, and URL operations have 16–64 KiB ceilings; semantic-cache writes allow 2 MiB. Oversized bodies now stop at the byte ceiling before JSON parsing, and malformed JSON remains a 400/fallback according to each route's existing contract. The lifecycle test verifies a declared oversized body is rejected before any DB or R2 write. Knowledge Worker suite passed 9 files / 43 tests after this extension.


## Semantic response-cache tenant isolation and invalidation (2026-10-21)

Traced all three `/internal/semantic-cache` routes, the direct Agents Worker callers, and the second cache lookup from ordinary `/kb/search`. The cache routes had valid HMAC authentication but trusted caller-supplied `spaceId` without confirming tenant ownership; Vectorize filters also used `space_id` alone. The regular search path used a shared RAG helper that had no tenant scope and did not know about cache generations, so it could bypass endpoint-side invalidation.

All semantic-cache operations now verify the signed tenant owns the requested space. Store, lookup, and invalidation include tenant and space filters; stored vectors carry both fields. The shared RAG helper now requires tenant and space scope and includes the current generation in its filter. Cache responses with missing/invalid expiry or over 1 MiB text are not served. Invalidation rotates a tenant+space generation before cleanup, making every old cache entry unreachable even when more than 1,000 vectors exist; it removes one bounded cleanup batch and reports `cleanup_pending` when the batch ceiling is reached.

Added route regressions for foreign-space lookup/store/invalidation, query/result bounds, tenant filters, expiry validation, oversized KV values, and the 1,000-vector invalidation ceiling; added RAG-helper tests for generation/tenant filters and result-size bounds.

Validation: Knowledge Worker suite passed 10 files / 47 tests; RAG suite passed 4 files / 26 tests; both TypeScript checks and `git diff --check` passed.

Checked the semantic-cache route test and shared RAG helper/test. Storage cleanup for old generations beyond the 1,000-vector best-effort delete batch is still incomplete: those vectors remain stored but are excluded from lookup by generation. They should be reclaimed by a later maintenance sweep or a paginated provider cleanup API.


## Knowledge storage usage metering on reindex (2026-10-21)

Traced `reportKnowledgeStorageWrite` to Billing Worker's authenticated `/billing/usage` route and checked the accepted usage-event schema. Storage metering used the document ID as its idempotency key, so every later rewrite of the same document was silently deduplicated. The document PATCH route also wrote R2 chunk records, citation text, and optional AutoRAG mirrors without reporting their bytes.

Storage reports now accept an operation ID and derive idempotency from that write operation. Reindexing generates one operation ID and reports the serialized chunk records, citation chunks, and mirror bytes on success or partial failure. Billing remains best effort; a 5xx or network failure does not roll back already-written content. Added tests for distinct rewrite keys, invalid/zero byte suppression, and billing outage behavior.

Validation: Knowledge Worker focused storage/lifecycle suites passed 2 files / 10 tests; Knowledge Worker TypeScript check and `git diff --check` passed.

Checked `storage-usage.ts` and `storage-usage.test.ts`. Document deletion usage accounting and retrying failed billing events remain unimplemented; these events measure bytes written and do not claim retained GB-months or a price.


## Internal web-search space ownership for egress policy (2026-10-21)

Traced all four internal web-search routes through `requireWebToolEgress` to the shared network egress policy. The routes required `x-naelao-space-id` and checked that space's air-gap flag, but never verified that the HMAC-authenticated tenant owned that space. A trusted worker could therefore request an external fetch under a different tenant's space policy.

The shared preflight now resolves the signed tenant, verifies space ownership, then checks air-gap policy before any DNS or network request. Added a foreign-space regression that expects 404 and proves no outbound fetch occurs. Existing air-gap and web-fetch tests continue to pass.

Validation: Knowledge Worker air-gap and web-fetch tests passed 2 files / 16 tests; Knowledge Worker TypeScript check passed.

Checked `air-gap.test.ts` for this boundary. The main Knowledge Worker `index.ts` remains unchecked overall; all its other route groups still need review.


## RAG sentence chunking under dense punctuation (2026-10-21)

Re-stressed `packages/rag/src/chunk.ts` with a 60,000-character input containing 20,000 short sentences. The sentence splitter repeatedly searched and sliced the entire remaining suffix, and first retained every resulting sentence string in an array. This made punctuation-dense input scale quadratically in scan/copy work and increased peak memory.

Changed sentence splitting to a single global boundary scan that yields segments directly to the chunk builder. Added the dense punctuation case and asserts that chunk count and size stay bounded.

Validation: RAG suite passed 4 files / 27 tests; RAG TypeScript check and `git diff --check` passed. Workspace `pnpm` scripts were blocked by the automatic dependency check rejecting the ignored `core-js-pure` build script, so the installed Vitest and TypeScript binaries were run directly.

Re-reviewed `chunk.ts` and `batch05-stress.test.ts`. This is an efficiency fix; the existing output overlap and sentence boundary behavior are preserved.


## CI and deployment workflow boundaries (2026-10-21)

Reviewed CI, PR checks, and staging/production deployment workflow wiring. The PR migration workflow selected Node 20 although the test helpers require `node:sqlite`, available from Node 22.5. CI and deploy workflows also relied on implicit repository token permissions. The staging deployment had no dependency on build, typecheck, or test preflight, so deploy jobs could begin while checks failed.

Updated PR checks to Node 22, set read-only `contents` permissions on CI, PR checks, staging, and production workflows, and made staging worker and frontend deployments depend on a preflight that installs, builds, typechecks, and runs the test workspace. The production frontend job retains `contents: write` because it creates the GitHub release; other production jobs inherit read-only permissions.

Confirmed YAML parsing for all four workflows. Reviewed D1 migration invocation and the referenced Wrangler config: every deploy replays all historical SQL files with `d1 execute` and suppresses every error via `|| true`; several historical migrations contain non-idempotent `ALTER TABLE` operations. Replacing this with Wrangler's migration ledger without first baselining the existing remote database could replay destructive or already-applied migrations, so this remains a release-blocking migration-management gap requiring a verified remote baseline and a one-time ledger bootstrap. No remote D1 command was run.

Checked the four workflow files listed above. Their other steps still require ongoing action-version pinning and deployment configuration review as the workflow audit continues.


## Worker staging and production Wrangler bindings (2026-10-21)

Compiled every worker with Wrangler 4.149.0 in both staging and production using `deploy --dry-run --env=...`. This exposed that Wrangler does not inherit resource bindings into named environments. Most worker configs declared D1, KV, Durable Object, queue, workflow, service, Vectorize, analytics, or AI bindings only at the top level, while the deploy workflows always pass `--env=staging` or `--env=production`. The production router dry-run, for example, had only environment variables and no database, services, Durable Object, KV, or AI binding. The existing binding test checked only that a binding appeared somewhere in the config.

Added the missing environment resource tables across the worker manifests while preserving explicit staging overrides. Corrected invalid array-form cron tables in sweeper, synthetics, and triggers; bound their D1 resources in each deployed environment; turned off duplicate sweeper/synthetic/trigger schedules in staging; aligned the sweeper's R2 and Vectorize targets with the Knowledge Worker; added the missing Browser binding to staging and production; and changed search/workflows `vectorize_indexes` to Wrangler's supported `vectorize` table.

The bundle workflow now dry-runs every Wrangler config with `--env=production`, requires an emitted `index.js`, fails on Wrangler config warnings/build failures, measures compressed bytes without KB rounding, and runs when shared packages or workspace config change. Extended `wrangler-binding-parity.test.ts` to ensure each top-level resource binding is represented in both named environments.

Validation: all 32 worker Wrangler configs parsed as TOML; all 32 production and all 32 staging dry-runs completed without binding omissions, config warnings, or errors; the binding parity test passed 58 tests; bundle workflow YAML parsed; `git diff --check` passed. These checks compile bundles and inspect declared bindings, but do not prove remote service/bucket/index existence, correct cross-worker target names, secret installation, or live scheduled behavior.

Residual environment risk: where there was no explicit staging-specific resource override, staging now receives the resource ID/name already declared at top level. This follows the repository's existing shared-D1 configuration and restores runtime bindings, but does not establish staging data isolation. Remote resource IDs and service target names still need confirmation before relying on staging as an isolated environment.


## Sweeper deletion and retry boundaries (2026-10-21)

Traced the scheduled sweeper against Knowledge ingestion keys, Vectorize chunk IDs, D1 chunk rows, and the AutoRAG mirror. Both failed-document cleanup and deleted-space cleanup used `kb/{space}/{doc}/`, but Knowledge stores documents at `kb/{space}/{project-or-_space}/{doc}/`; cleanup therefore missed the R2 originals/chunks/citations. It also left `kb_chunks` and their FTS entries after deleting or purging the document, and did not remove the separate `autorag/` mirror. The sweeper allocated all vector IDs at once from unchecked D1 `chunk_count`, deleted each R2 page with unbounded parallelism, and could mark a space clean despite an incomplete R2 pass.

Cleanup now uses the real project-aware prefixes, deletes the mirror and tenant/space/project-scoped D1 chunk rows, generates at most 100 vector IDs per request, limits R2 deletion to ten 1,000-object pages and 100 concurrent deletes at a time, detects broken/repeated cursors, and keeps documents pending for another sweep when R2 work remains. Rejects corrupt chunk counts above 12,000 without deleting the D1 record. Deleted-space selection also revisits previously purged documents with leftover chunk rows and removes remaining objects for the space. A bounded orphan repair groups old `kb_chunks` rows whose document rows were already deleted, then removes their project-scoped R2 objects, AutoRAG mirrors, vectors derived from chunk indexes, and D1/FTS rows. Expired session, API-key, and idempotency cleanup is capped at 1,000 rows per pass. Knowledge ingestion now saves the expected chunk count before Vectorize writes so the sweeper can remove a partially accepted vector batch.

While validating limits, SQLite rejected direct `DELETE ... LIMIT` syntax in the test/runtime SQLite build. Rewrote bounded deletes as `DELETE ... WHERE rowid IN (SELECT rowid ... LIMIT 1000)` and executed all four query shapes against SQLite successfully.

Validation: sweeper suite passed 1 file / 8 tests; Knowledge document lifecycle suite passed 1 file / 8 tests; both worker TypeScript checks passed; the complete Knowledge Worker suite passed 10 files / 50 tests; sweeper staging and production Wrangler dry-runs passed without configuration warnings; all worker config tests and inventory are unchanged by this slice. Executed the bounded cleanup and deleted-space selection SQL against SQLite. Full Knowledge Worker tests emit expected stderr for deliberately simulated provider and HTTP failures. No live R2, Vectorize, or D1 cleanup was run.

Checked `workers/sweeper/src/index.ts` and its test file. `workers/knowledge/src/index.ts` remains unchecked overall; this slice covers its document ingestion/reindex cleanup metadata path only.

Checked the bundle workflow and every worker `wrangler.toml`. Runtime source, APIs, Durable Object state behavior, and provider-side resource targets remain under audit.

## Conversation message pagination and request bounds (2026-10-21)

Re-reviewed SpaceDO message writes and transcript paging, the agent's bounded transcript loader/compactor, and conversation search/research. ID cursors resolved to SQLite `rowid` but pages were still sorted primarily by `created_at`; imported or out-of-order timestamps could therefore make the rowid cursor skip or repeat messages. Default newest-page retrieval had the same mixed ordering. ID-based paging and the default page now consistently sort by insertion rowid; the legacy timestamp-only `before` query remains available.

The DO's global 8 MiB request cap bounded message writes, but allowed large JSON buffers despite the per-message 128 KiB content ceiling. Message-write requests now have a 1 MiB transport cap, which allows escaped JSON and the metadata ceiling while keeping excess input away from JSON parsing.

Added regressions for out-of-order timestamps across three cursor pages and an oversized body rejected before parsing. Validation: SpaceDO message-pagination suite passed 1 file / 4 tests; conversation search, compaction, and transcript-loader suites passed 3 files / 22 tests; Spaces and Agents TypeScript checks passed. Existing suites also exercise large transcript pages and byte trimming.

Reviewed `conversation.ts`, the transcript loader, the session message route, and automatic compaction path. Search is capped at 10,000 messages / 16 MiB per call and exposes a cursor when incomplete; automatic compaction materializes at most 10,000 messages / 16 MiB and preserves recent context when it cannot scan the full transcript. These are explicit caps rather than complete whole-history guarantees. The full `SpaceDO.ts` and `NaelaoAgentDO.ts` files remain unchecked overall; authorization, migration behavior, tool routing, compaction recovery, and remaining endpoints still need file-by-file review.

## Avoid transcript-wide scans on ordinary message pages (2026-10-21)

A follow-up complexity check found every paginated message request also executed `COUNT(*)` plus `SUM(length(content))` over the full transcript, even though only the context-usage endpoint consumes those totals. Repeated page/search requests therefore reread every stored message body. The aggregate is now opt-in with `include_totals=1`; only context metering requests it. Added coverage that ordinary pages omit totals while explicit metering returns exact transcript-wide counts and character totals.

Validation: Spaces pagination suite passed 1 file / 4 tests; Spaces and Agents TypeScript checks passed.

## Stop duplicating full transcripts during compaction (2026-10-21)

Searched all runtime references to `archived_messages`: the Agent DO created and wrote this table but no code ever read from it. The authoritative full transcript remains in Spaces and `conversation.search` reads that source. Compaction was therefore copying up to the entire bounded 16 MiB transcript into a second durable database for no retrieval benefit. Removed new archive-row writes and added a regression asserting compaction stores its summary/cursor without duplicating message bodies. Kept the table definition and any already-persisted rows for compatibility; their eventual cleanup remains a separate verified data-retention task.

Validation: conversation compaction, conversation search, and transcript loader suites passed 3 files / 22 tests; Agents TypeScript check passed.

## Bounded message-page serialization work (2026-10-21)

Stress review of a maximum 500-row response found the 1 MiB trimming loop removed one oldest message and re-serialized the entire page each time. With near-ceiling messages this could perform hundreds of full-page serializations. The reader now measures row JSON sizes once from newest to oldest, retains the largest contiguous newest suffix under a reserved envelope budget, and serializes the final bounded response once. It fails closed if even one row cannot fit. Expanded the regression to 200 × 100 KiB messages (~20 MB source page) and verified the response stays under 1 MiB with an exact continuation cursor.

Validation: Spaces pagination suite passed 1 file / 4 tests; Spaces TypeScript check passed.

## Fail closed on empty pages with an active history cursor (2026-10-21)

The automatic transcript loader and `conversation.search` both stopped on an empty page without checking `has_more`. A contradictory/failed page response could therefore be treated as complete history and make the agent infer a fact was never discussed. Both paths now reject that state as incomplete; the compactor refuses to replace context from it, and search returns an explicit unavailable/incomplete result. Added regressions to both readers.

Validation: Agents conversation search, transcript loader, and compaction suites passed 3 files / 24 tests; Agents TypeScript check passed.

## Product end-user ownership on all SpaceDO session subroutes (2026-10-21)

Traced the router's product-session allowlist through `handleSpaceSessions` into SpaceDO. The router derived `end_user_id` for session/message reads and writes, but left other session-local requests untouched. SpaceDO's `PATCH /sessions/:id`, state GET/PUT, and connector-mode GET/PATCH therefore lacked an owner check. Product-session callers could target those routes with another known session ID. The Spaces router now overwrites the owner query value from its verified claims for every remaining session subroute, and SpaceDO checks it before dispatching any session-scoped endpoint. This keeps ownership enforcement at the storage boundary and preserves internal callers that omit end-user identity.

Added regressions proving a foreign customer cannot read connector preferences or write agent state while the owner can read its preference. Validation: Spaces session scope, message pagination, and private scratchpad suites passed 3 files / 9 tests; Spaces TypeScript check passed. Router-level forwarding was traced in code but not exercised end-to-end with a full Hono/D1 fixture.

## Authenticate conversation ownership before agent execution (2026-10-21)

The Agents `/agent/run` route verified the caller's internal token and space tenancy, then resolved a missing goal by reading the target session and dispatched the planner without checking that a product end user owned that session. Since the router's product-session allowlist covers agent runs, a customer who learned another session ID could trigger a paid run using that conversation and write the response into it. The route now resolves canonical session scope before reading the transcript or doing model work, hides foreign sessions with 404, and refuses private scratchpads because they are client-only encrypted storage. This check runs before goal processing, injection detection, attachment lookup, or task creation.

Added ingress regressions for cross-customer session denial and private-scratchpad refusal; updated the prompt-injection ingress test for the earlier scope lookup. Validation: Agents route/session tests plus conversation suites passed 4 files / 22 tests; Agents TypeScript check passed.

## Cover all Agents session routes with product-session ownership (2026-10-21)

The agent-run ownership check uncovered a broader routing gap: Agents owns connector-mode, run status/streaming, approvals, context, and upload subroutes, while the router allowlists the product-session namespace broadly. Connector-mode's Agents proxy called SpaceDO with only tenant HMAC and omitted the caller identity, so SpaceDO could not apply its new owner check. Added an Agents middleware for every `/spaces/:spaceId/sessions/:sessionId/*` route: product callers must present a verified internal token, the canonical session scope must resolve, the session owner must match, and private scratchpads are rejected. Agent runs also resolve scope for non-product callers so encrypted scratchpads are never sent to a model. This runs before the route can read or mutate Agent DO state.

Added coverage for foreign product sessions on run and connector-mode paths, and for private scratchpads on product and builder runs. Validation: agent session scope, prompt-injection, and voice planner tests passed; Agents TypeScript check passed. These focused checks do not replace review of each run-status/approval/upload handler's additional authorization rules.

### Full worker-suite verification after session-scope changes

After the Agents middleware began requiring `owned_by_caller` in product-session scope responses, the complete Agents suite exposed two upload-route test fixtures that represented an owner scope without that field. Updated the fixtures to match the SpaceDO response contract. Re-ran full suites: Spaces passed 64 files / 250 tests; Agents passed 151 files / 679 tests. Expected PDF.js font-data warnings appeared in document/PDF tests; all tests passed. Spaces and Agents TypeScript checks passed in the focused validation runs.

## Task-scoped worker capabilities and decision response cleanup (2026-10-21)

Reviewed the default worker capability catalog, selection logic, delegation contract signing, and the child DO's tool/skill allowlist enforcement. The catalog maps every non-planner built-in to a task bundle; model selections are intersected with the parent's configured tools, and the signed delegation contract binds the exact selected tools and skills. Found that a task matching no bundle fell back to every configured worker tool, defeating task-scoped delegation. It now retains only `plan` (when configured), leaves skills empty, and records `no_capability_match`; added tests for ambiguous tasks with and without the planner substrate.

The shared OpenRouter Decisions client also left non-2xx response streams open. It now cancels every unsuccessful response body before retrying or returning the status-only error. Added a retry-bound/resource-cancellation regression.

Validation: worker capability suite passed 1 file / 9 tests; Fast Decision suite passed 1 file / 24 tests; Agent SDK and Agents TypeScript checks passed. Full Agents suite not rerun for this slice. Unrelated product verification (remote provider latency/availability, production Decisions API behavior, and end-to-end delegated execution under tenant load) remains outstanding.

## Session upload route bounds and canonical scope review (2026-10-21)

Reviewed the upload scope resolver and Agents POST/GET/DELETE session-upload handlers. Every operation resolves the canonical session scope through an authenticated Spaces request; private scratchpads and project-scope mismatches fail before R2 access. Upload request bodies are streamed through a byte-ceiling check before multipart parsing, then constrained to 6 files, 20 MiB each, and 60 MiB total. Filenames are reduced to basename and path traversal is removed before R2 keys are formed. Project-linked uploads also verify project access. Added regressions that seven files produce no R2 writes and traversal filenames remain inside the session prefix.

Validation: upload route and worker-capability suites passed 2 files / 14 tests. Agent SDK and Agents TypeScript checks passed for the adjacent decision/worker-capability changes; the upload-only addition was covered by Vitest.

This review did not test production R2 quotas, concurrent duplicate-name uploads, lifecycle cleanup, or the full multipart 60 MiB edge in a live Worker. Those remain open audit items; the R2 listing is also intentionally bounded, and cumulative storage quotas are not enforced by this route.

### Broad Agents verification after worker/upload changes

Full Agents worker suite passed 151 files / 682 tests (one new worker-capability regression and two new upload stress regressions). Agents TypeScript check passed. Existing PDF.js standard-font warnings were emitted by PDF tests; all suites passed.

## Bind attachment indexing to the source object version (2026-10-21)

The chat upload indexer first read object metadata and later fetched bytes for task-scoped copying. It verified only byte length, so a concurrent same-size overwrite could change the file between validation and indexing. The second read now must match both size and R2 ETag before any attachment record is stored. Added a same-length replacement regression that confirms indexing fails closed.

Validation: chat upload attachment suite passed 1 file / 3 tests; Agents TypeScript check passed. This closes the size-only TOCTOU gap; production R2 consistency and concurrent upload behavior still need environment-level verification.

## Enforce the Decisions API deadline during retry backoff (2026-10-21)

The Decisions client uses one abort signal for the entire request, but its retry sleep did not listen for that signal. A second retry could therefore finish its backoff after the configured total timeout. Replaced the unconditional sleep with an abort-aware delay and added a fake-clock regression proving the next request is not sent after the shared deadline.

Validation: Fast Decision suite passed 1 file / 25 tests; Agent SDK and Agents TypeScript checks passed. The Agents full suite had passed 151 files / 682 tests immediately before this later attachment ETag and backoff slice; focused tests cover these latest changes.

### Broad Agents verification after ETag and retry-deadline changes

Re-ran the complete Agents suite on the latest tree: 151 files / 683 tests passed, including the new same-size attachment replacement regression. Expected PDF.js standard-font warnings appeared. Agents and Agent SDK TypeScript checks both passed.

## Reconcile shared integration fixtures with session ownership checks (2026-10-21)

The first broad `tests/` run reported 3,443 passing and 264 failing tests across 356 files, plus one unhandled mock error. Comparison with the saved Oct 20 report showed 118 failure cases were newly present. Several were caused by the new fail-closed session-scope lookup: older `/agent/run`, trace, and upload fixtures returned 404 for `/compact-scope` or omitted `owned_by_caller`, so tests never reached the behavior they intended to cover. Updated five shared integration fixtures to represent an owned non-private session; the trace test now separately represents a non-member business-role response. Focused rerun passed 5 files / 34 tests.

The repository-wide suite remains red and is not represented as fully passing. The machine-readable report is at `/tmp/naelao-root-vitest-20261021.json` for this workspace session. Remaining failures span many older test doubles and several route/model/billing contracts; they require individual triage. The report is execution evidence only and is not committed.

## Correct shared-memory stress fixtures to match strict relevance and scope filters (2026-10-21)

Reviewed semantic memory isolation and hybrid project/thread recall after the shared suite flagged two cases. The implementation filters Vectorize queries by tenant, space, project, and user; the test asserted an obsolete two-field filter. Updated it to assert the full isolation predicate. Structured facts intentionally require at least 0.80 query-token coverage before crossing into another thread; the end-to-end fixture used a three-topic query for a one-topic fact and expected it to bypass the relevance gate. Reworked the fixture so its episodic note and project fact are both relevant to the same `payout` query, preserving strict privacy/relevance behavior.

Validation: memory OS end-to-end and per-user scope suites passed 2 files / 15 tests. No production code change was required.

## Restore business creation route stress fixtures to deployed auth/schema (2026-10-21)

Triaged the business-create/business-routes failures from the broad test report. The test D1 schemas were missing `product_end_users.deleted_at`, the `business_memberships` table, and some real roster fields; customer IDs used by route tests were not registered. The tests also authenticated business-specific requests as the product-root tenant even though the route correctly requires the child business tenant, and several missing-identity assertions expected 401 while these internal product-user routes return 403. Updated the fixtures and assertions to match the worker's actual auth boundaries. LockDO is now constructed with the same SQLite-backed storage used by its focused unit test.

Validation: `business-create.test.ts` and `business-routes.test.ts` passed 2 files / 39 tests. This closes those two test modules only; the full shared `tests/` suite remains open and has many unrelated failures.

Committed and pushed as `99dbc446`. Refreshed the inventory afterward: 1,976 tracked files and 1,770 source/config checklist rows; 375 rows are checked.

## Align R2 tool fixtures with CAS and tombstone semantics (2026-10-21)

The workspace/download tests used incomplete R2 doubles that lacked `head`, `arrayBuffer`, ETags, and CAS metadata. Added those behaviors to the fakes so the tests exercise the production `r2-cas` path. The move test had expected a hard R2 delete; conditional deletes are represented by a tombstone, so it now verifies the deleted marker and confirms the source is no longer readable. Download tests now verify exact stored bytes, including plain text, and the missing-URL assertion matches the documented uppercase URL error.

Validation: `workspace-prebuilt.test.ts` and `web-search-platform.test.ts` passed 2 files / 28 tests; Agents `tsc --noEmit` passed. The workspace command `pnpm --filter @naelao/agents-worker typecheck` could not start because pnpm stopped at its ignored dependency build-script policy; direct installed TypeScript execution passed.

Committed and pushed as `ef69f0d4`. Refreshed the inventory after both audit/test commits: 1,976 tracked files and 1,770 source/config checklist rows; 377 rows are checked.

## Refresh shared-suite baseline and reconcile model-switcher fixtures (2026-10-21)

Re-ran the full shared `tests/` suite after the business and R2 fixture updates. It now reports 3,527 passing assertions and 181 failing assertions across 127 of 1,182 suites (report: `/tmp/naelao-root-vitest-20261021-after-r2.json`). The previous report had 3,443 passing and 264 failing assertions, so 83 failures were removed; the suite remains red.

The largest cluster was `model-switcher-config-resolution.test.ts` (18 assertions). Builder tests supplied an unsigned tenant header even though builder routes require a router-signed internal token; the agent-run fixture also omitted the current owned-session `/compact-scope` response. Added signed fixture requests and the session-scope response, and included the `users` table so the normal optional wallet-owner lookup behaves like the real schema without emitting a test-only SQL error.

Validation: `model-switcher-config-resolution.test.ts` passed all 18 tests. This closes the test module only; builder model authorization implementation and broader agent-run authorization still have their own checklist rows and route coverage.

Committed and pushed as `0bf20c59`; refreshed the inventory after the code/test commit: 1,976 tracked files / 1,770 source/config rows / 378 checked rows.

## Rebuild durable-task failure fixtures around the scoped workflow journal (2026-10-21)

The fresh suite showed the older failure-handling test bypassed the newly required durable-workflow setup: workflow instance ID did not match task ID, the TaskDO name was not scoped to the Space, the actor was missing, and no workflow build pin, journal, agent configuration, or membership grant existed. The test's fake `WorkflowStep.do` also supported only the three-argument overload, while the terminal step uses the callback-only overload. Updated the harness to use the real `WorkflowRunDO` and SQLite-backed journal/storage fixture, scoped membership and agent config, valid task/run IDs, and both step signatures. No workflow production code was weakened.

Validation: `agent-task-workflow-failure-handling.test.ts` passed 1 file / 9 tests. The shared suite's other failures remain open.

Committed and pushed as `99cbef0c`; refreshed the inventory: 1,976 tracked files, 1,770 source/config checklist rows, and 379 checked rows.

## Restore signed builder identity in conversation-access tests (2026-10-21)

The conversation-access security tests sent only an `x-naelao-tenant-id` header. Builder routes intentionally treat that header as an assertion and require its router HMAC signature; without it, product creation never succeeded, later tests used an undefined product ID, and SQLite reported null binds. Converted the test request helper to issue signed tenant assertions and added the deployed `users` table so product creation's optional wallet-owner lookup is represented accurately. The authorization behavior and three independent disclosure gates remain unchanged.

Validation: `conversation-access-gate.test.ts` passed 1 file / 11 tests. It verifies each gate independently, zero audit rows on denial, metadata-only response, successful audit attribution, and cross-tenant non-disclosure.

Committed and pushed as `9f374301`; refreshed the inventory: 1,976 tracked files, 1,770 source/config checklist rows, and 380 checked rows.

## Sign builder payout-route test requests (2026-10-21)

The builder payout tests also sent unsigned tenant headers. The balance/list/request routes correctly reject them with 401; the subsequent test failures were unauthorized responses, not ledger calculation errors. Signed the tenant headers in the fixture while retaining explicit no-credential tests and the internal fulfillment HMAC tests.

Validation: `builder-payout-requests.test.ts` passed all 13 tests, including multi-currency balances, reservation/release, tenant isolation, and one-time fulfillment.

Committed and pushed as `03d41a2e`; refreshed the inventory: 1,976 tracked files, 1,770 source/config checklist rows, and 381 checked rows.

## Reconcile browser tests with the scoped session protocol (2026-10-21)

The old browser test sent an unsigned token and a bare URL to `/v1/browser/navigate`. The worker has since moved to a tenant-signed, task-scoped `BrowserSessionDO` protocol, so the tests stopped at 401 before reaching browser behavior. Replaced those obsolete request expectations with current gateway tests for HMAC scope forwarding, tenant-scope mismatch rejection, malformed scope, and unauthenticated access. Added a real `BrowserSessionDO` launch-path test with a minimal Puppeteer page and DNS stub; it confirms a tier-4 run selects Kitesurf and calls the documented `puppeteer.launch(BROWSER, { browser: "kitesurf" })` contract.

Validation: `browser-worker-kitesurf.test.ts` passed 1 file / 5 tests; Browser Worker `tsc --noEmit` passed. This test slice does not validate the complete action/accessibility/screenshot surface, which remains open in the worker and DO checklist rows.

Committed and pushed as `1e6e1a09`; refreshed the inventory: 1,976 tracked files, 1,770 source/config checklist rows, and 382 checked rows.

## Rebaseline shared suite and reconcile connector provider expectations (2026-10-21)

After the auth/workflow/browser fixes, the full shared suite reports 3,577 passing assertions and 129 failing assertions across 106 of 1,183 suites (`/tmp/naelao-root-vitest-20261021-after-auth-fixes.json`). This is 52 fewer failing assertions than the preceding 181-failure run; the suite is still open.

The remaining connector-catalogue failure was a stale Notion expectation: the catalogue declares Notion as Composio-routed, and the unified directory explicitly chooses Composio when both providers list the same slug. Updated the test and the adjacent directory-test comment to match that policy. Validation: catalogue and directory tests passed 2 files / 39 tests.

Committed and pushed as `64ec6cf9`; refreshed the inventory: 1,976 tracked files, 1,770 source/config checklist rows, 383 checked rows.

## Repair container and prebuilt test contracts (2026-10-21)

The next current shared-suite failures showed outdated Tier assumptions in the code-exec/browser-use tests and a ToolSandboxDO test that still treated proxying as unauthenticated. Updated expectations to the Tier 2 Python isolate, Tier 1 virtual Bash, the browser's bounded untrusted-text receipt, and fail-closed unauthenticated container requests. Reordered ad hoc JS guards so the reserved payment-processor check runs before generic SQL mutation analysis; reserved-capability attempts now get the specific rejection consistently. BuilderAccountDO tests now use the full SQLite Durable Object storage shim, including `transactionSync`, matching the production atomic API-key write path.

Validation: browser/code prebuilt, BuilderAccountDO, and ToolSandboxDO focused suites passed 23 tests. The next fresh repository test sweep reported 114 failures across 41 files (down from the prior 129 across 106 files; this includes current test discovery at 706 files). Additional fixture repairs aligned the webhook idempotency D1 double with subscription lookup/update columns, made lock release use its required fencing token, and added the current `space_members` table to the business-role fixture. Those three suites passed 18 tests. The async task run-ID test now supplies an `ExecutionContext`, matching the route's scheduled evidence recording; it passed its focused check. No full-suite pass is claimed; 114 failures remain in the captured report and further audit remains open.

## Bound tool-output previews after serialization and enforce valid TTL stress fixtures (2026-10-21)

The shared suite exposed a real context-budget gap: preview length was estimated from a fixed character multiplier, but the actual JSON envelope measured 1,882 tokens against a 1,500-token ceiling. Replaced the estimate-only preview with a bounded search that measures the serialized envelope using the same UTF-8 token estimator, including escaped/multibyte content. Added a CJK/emoji stress regression; the existing 500-line preview test now passes.

The expired-slot test itself used `ttl_ms: -1`, which the API correctly rejects as invalid, then expected an active count that intentionally excludes expired rows. Reworked it to acquire with a valid 1-second lease, advance fake time past expiry, and verify the next acquire reclaims the slot.

Validation: private tool output stress suite passed 1 file / 46 tests; ConcurrencyDO suite passed 1 file / 7 tests; Agents TypeScript check passed.

## Complete billing model registry and reconcile credit-margin assertion (2026-10-21)

The shared integration suite found the allowed OpenRouter DeepSeek Flash slug had no explicit `MODEL_CAPABILITIES` entry. Runtime fallback was no-reasoning, but a missing row made model-picker capability introspection incomplete. Added an explicit `NO_REASONING` entry pending independent confirmation of a supported reasoning parameter. The same suite's credit conversion assertion omitted the documented 15% operating margin in `tokensToCredits`; corrected the assertion so it checks provider cost × margin × credits per USD.

Validation: billing-core package suite passed 5 files / 16 tests; shared billing-core suite passed 1 file / 22 tests after rebuilding the workspace package.

## Continue collaboration, webhook, and channel stress pass (2026-10-21)

Updated tests for the current Telegram contract, which preserves sender identity separately from the group chat recipient, WhatsApp's human-readable missing phone-number ID hint, and the `presence.update` broadcast event. The stale-presence test exposed a production threshold bug: heartbeat cleanup used 60 seconds even though the documented retention window is 24 hours. Changed the deletion cutoff to `PRESENCE_PRUNE_CUTOFF_MS` so stale rows disappear from active GET results immediately but remain stored until 24 hours old. Validation: SpaceDO collaboration/presence (23 tests), real-time broadcasts (7), and outbound channel delivery (9) all passed. This confirms the 24-hour row retention behavior and the event/identity contracts; the broader suite and checklist are still open.

Also aligned memory recall assertions to its `{results}` response, added `arrayBuffer()` to the R2 test double used by hash-verified reads, and updated the missing-query assertion to the web-search validator's bounded-query error. These three suites passed 21 tests.

The latest full shared-suite snapshot after scheduler, approval, lock, and spend-cap fixture repairs reports 5,185 passing and 61 failing tests across 49 test files (5,246 total tests; report: `/tmp/naelao-root-vitest-20261021-after-spend-cap.json`). The failure assertion set is 7 lower than the prior 68-failure snapshot. It is still red.

Closed the async lock gateway test contract (awaiting `buildScriptEngineEnv()` and using the current `acquired`/fencing-token reply), long-running approval route identity (owner membership and user headers), and spend-cap harness requirements (model-policy route, byte-accurate CAS R2 fake, alarm methods). The combined focused suites passed 23 tests.

The cross-project workspace-change fixture now supplies required `expectedHash` values and models R2 head/ETag/byte behavior, including a real write before the CAS delete. The file/schedule R2 fake now returns byte buffers for hash-verified ranged reads. Together with the previous three suites, the five focused suites passed 44 tests. This only closes those targeted test modules; the 19 failing shared-suite modules and the wider file-by-file audit remain open.

## Reconcile retrieval, auth, memory, and remaining route fixtures (2026-10-21)

The next full shared run reported 5,185 passing and 61 failing assertions across 19 files (`/tmp/naelao-root-vitest-20261021-after-spend-cap.json`). Targeted repairs brought the next full snapshot to 5,245 passing and one failing assertion; that remaining test expected semantic memory at exactly 0.80 to be admitted.

The knowledge and notification tests now use owner/space identities allowed by the actual knowledge ACL, include the configured space policy row, and model the production notifications route's space policy lookup. AutoRAG remains disabled when configured because its current query interface cannot enforce required visibility metadata filters; the regression now proves it falls back to hybrid retrieval and does not call AutoRAG. The builder pricing route tests now sign tenant assertions.

Product end-user tests now include the WhatsApp challenge schema used by the GDPR erasure cleanup, sign product-user identity claims on profile erasure/read requests, and preserve login's indistinguishable 401 for suspended accounts. Project-memory assertions now include the role-rank query and the returned ACL metadata; hybrid recall uses a query relevant to the structured fact. The skill library fake returns byte-accurate R2 objects required by size-checked metadata reads.

The project steward test schema now includes `extension_provider_connections`. Workspace viewer tests model the authorized project lookup and read returned bytes. MCP-hub fixtures now include current spaces/MCP migrations and a public DNS answer; valid HMAC, reserved tool rejection, and ordinary tool proxy tests pass. Activity-log/live-run tests now include model-policy/alarm bindings and byte-accurate R2 configuration reads. Project-thread tests distinguish visible Tier 2 subthreads from private Tier 3 consults, account for the lazily created project team room, and create the project before linking a thread session.

The reasoner keeps compatibility decoding for legacy action envelopes after the advertised tool surface changed to Bash/AskUser/Read/Edit; the new request schema still advertises only current tools. The prompt assertion now checks the current terminal-native identity. Operation suggestions include enough same-namespace candidates to avoid dropping a relevant action on a tie. BYOK tests follow current OpenRouter-only key creation and include active-key pointer metadata in their credentials fake so deletion exercises both stored rows.

The semantic-memory implementation now rejects scores equal to the documented strict 0.80 boundary in both admission and rendering. Updated the boundary test to cover exact, below, and above values. Focused validation passed: product end-user auth (36), thread hierarchy (21), knowledge + notifications + pricing (33), reasoner prompt/coercion (12), skill health (15), project-memory (12), steward review (5), workspace viewer (5), MCP HMAC (5), activity/live feed (3), BYOK routes (4), script naming suggestions (18), and memory boundary/retrieval (16). Agents TypeScript and `git diff --check` passed. The shared suite is being rerun after the final boundary assertion; no full-pass claim is recorded until that report completes.

Final shared-suite report for this batch: 5,246/5,246 tests passed across 1,938 discovered suites (`/tmp/naelao-root-vitest-20261021-after-strict-cutoff.json`). The Agents Worker `tsc --noEmit` and `git diff --check` passed. This validates the configured repository suite and the targeted route/memory stress cases recorded above. The inventory still has 1,387 unchecked source/config files (383/1,770 checked); the full file-by-file audit, external load testing, and unrepresented deployment/container/DO failure modes remain open and this is not a certification that the platform has no bugs.

The next full `tests/vitest.config.ts` run reported 103 failures across 31 files and 706 collected test files. The durable-workflow failures came from preparing effects before journal initialization and using the pure-effect API for externally visible notifications/charges; the harness now initializes a realistic workflow and uses `prepareExternalEffect`, including its exact receipt and usage contract. The durable-workflow suite passed 9 tests. The other 101 failures from that full-run snapshot remain to triage; the suite is still red.

Two additional fixture/API gaps are repaired. The Launchpad provisioning harness now provides the authenticated agent-config lock gateway and a CAS-capable R2 fake (head/ETag/arrayBuffer/conditional PUT), which is required for safe multi-file profile installation. The scheduled-job run-history cap is now exported from the Agents Worker, as its test contract expects. Launchpad profile and scheduled-job history suites passed 10 tests.

The agent message attribution tests expected `x-naelao-role: agent` to grant permission to create assistant messages, but the SpaceDO explicitly rejects role headers paired with non-user messages to prevent caller-supplied agent impersonation. Updated those cases to assert the 403 boundary; the separate trusted internal write-back case continues to verify that server-provided `agent_id` is persisted. Agent API key/attribution suite passed 13 tests.

The later full run captured 95 failures across 27 files, down from 103 across 31 files; it was a red suite snapshot taken while fixes were still being applied. Since then, fixed additional fixture mismatches: daily tick roster fixtures now distinguish the daily-digest SQL from unrelated root-space rosters, and the wake-policy D1 fixture returns an existing compliant Space; provisioner trigger tests now supply the required signed config-lock gateway and CAS-capable R2; federation skill R2 objects expose byte size and `arrayBuffer`; and Product Wizard requests now carry signed tenant assertions. Their focused validation passed 10 + 7 + 7 + 7 tests. The air-gap model activation ordering fix also passed all 4 voice/model route tests. Run the shared suite again before reporting a new count.

## Recheck reasoner action surface and repository conformance (2026-10-21)

Re-reviewed the Agents reasoner action schema after the shell-tool migration. Static reference search showed the old provider-specific `PARAMS_PARAM_STRING`, `PARAMS_PARAM_OBJECT`, and hint string were declared but had no runtime references; the active schema now exposes Bash/AskUser/Read/Edit. Removed those dead declarations and replaced stale comments that described an obsolete per-model schema. Compatibility decoding for old operation envelopes remains in place.

Validation: reasoner tool-calling and prompt suites passed 67 tests; Agents Worker TypeScript passed; the full shared suite passed 5,246/5,246 tests across 1,938 suites; conformance passed 4/4 tests; all 62 discovered TypeScript configurations passed in the prior batch; all 32 Worker production dry runs passed in the prior batch. `git diff --check` is rerun before commit.

Biome is not clean repository-wide: the earlier repository scan reported 9,366 diagnostics across 2,097 files, including generated `.next` files. On this reasoner file, after removing the unused declarations, remaining diagnostics are pre-existing style choices (including literal-key, template, non-null assertion, and `delete` rules); no unsafe automated fixes were applied. Changed test files also retain style-only diagnostics. No broader formatting cleanup is included in this stress pass.

Audit status remains open: the inventory is still 383/1,770 checked source/config rows (1,387 unchecked), and this batch does not provide live provider, D1/R2/Queue, container load, or deployment fault-injection evidence. Passing local tests do not establish that all features are defect-free.

## Repository automation runner safety pass (2026-10-21)

Reviewed `run-phase.mjs` (the implementation workflow entrypoint), the unreferenced `run-phase (1).mjs` legacy runner, and `create_patch.js` for filesystem writes, patch application, shell execution, branch cleanup, staging, and deployment wiring. The two runners previously staged the entire repository; the legacy runner also ran `git reset --hard`, `git clean -fd`, interpolated dynamic values into shell commands, wrote arbitrary model-selected paths, and force-pushed its branch. The legacy patch applier silently inserted unmatched code near the last brace, and its syntax check wrote through a fixed `/tmp/syntax_check.js` path.

Added `infra/scripts/phase-runner-safety.mjs` to reject absolute/traversal paths, repository-root writes, and symlink escapes, and to parse/validate generated patch paths. Both runners use the shared checks. They now refuse a dirty initial worktree, stage only paths from the generated patch/output, and invoke Git/GH without shell interpolation. The legacy runner no longer resets/cleans the checkout or force-pushes; unmatched search blocks fail closed. Its syntax checker uses a unique temporary directory and removes it after checking.

Validation: added `tests/unit/phase-runner-safety.test.ts`; all 11 cases pass, covering normal/quoted patch paths, traversal, `.git`, rename rejection, absolute paths, repository-root paths, and symlink escapes. Both runner files and the helper pass `node --check`; Agents Worker TypeScript and `git diff --check` pass. A runtime smoke of the legacy script was blocked because `@google/genai` is not installed in this checkout. No workflow or package script references `run-phase (1).mjs`; references found are historical planning/tree documents. I retained it because external/manual consumers cannot be ruled out. `create_patch.js` is a fixed patch-generation utility with no direct runtime/workflow entrypoint found; it remains pending external-consumer verification.

The repository-wide audit remains incomplete. This scoped runner review does not validate the AI provider network behavior, Repomix parser behavior on hostile repository names, GitHub CLI/provider outages, or the remaining root configuration and script files.

Inventory refreshed after the runner audit commit `21b52474`: 1,978 tracked files, 1,772 source/config checklist rows, 385 checked and 1,387 unchecked. The two newly added safety helper/test rows are checked; both runner files remain unchecked for their broader provider, CLI, and deployment behavior.

## Root shell patch-generator review (2026-10-21)

Reviewed both `ai_studio_code` shell files. The primary file only writes a fixed embedded patch to `repomix/patches/batch-01.patch`; the duplicate `(2)` file previously overwrote the primary script with an embedded copy. No CI, package script, workflow, or application entrypoint references either file; the only other repository match is the stale `project_tree.md`. Kept the duplicate path as a compatibility wrapper that invokes the primary generator, so it no longer carries a second 1,600-line patch copy or overwrites source. The primary generator now resolves its output relative to the script, quotes its fixed target, and fails immediately on write errors.

Validation: `bash -n` passed for both scripts and `git diff --check` passed. I did not execute the generator because it would overwrite the tracked batch patch artifact; the patch itself remains unverified against the current branch. These are manual tooling files with no known production callers; possible external/manual use remains unverified.

Inventory refreshed after the root shell pass at `4b6b70c3`: 1,978 tracked files and 1,772 source/config checklist rows; 387 checked and 1,385 unchecked. The two shell-generator rows are now checked after the wrapper refactor and syntax validation.

## CI test-surface and KB ingestion boundary pass (2026-10-21)

The CI test job previously ran `pnpm --filter @naelao/tests test` from the tests package, which covers the `tests/` tree but not package/Worker Vitest projects, the native Node suites, or the separate conformance harness. Expanded the job to run the repository-root Vitest suite, all package/Worker projects via `vitest.workspace.ts`, native Node test files, and conformance. This matches the locally exercised commands and avoids the Turbo-invoked package-manager install behavior seen in this environment.

The workspace suite passed **1,618/1,618 tests across 754 suites**. The repository-root suite passed **5,261/5,261 across 1,943 suites**. Native Node suites passed **27/27** and conformance passed **4/4**. `workers/workflows/src/workflows/KbIngestionWorkflow.ts` had an unused fetched-size result and described a UTF-8 byte check as a character limit; removed the unused result and report the actual byte count. Added workflow tests for success ordering and cleanup, oversized R2 metadata, understated metadata with oversized UTF-8 content, and missing objects; all four pass. Workflow TypeScript and targeted unused-variable lint checks pass.

A full `turbo run test` attempt is not a valid result in this execution environment: the provided pnpm shim re-runs workspace installs from package tasks, then rejects `core-js-pure@3.50.0` under `ERR_PNPM_IGNORED_BUILDS`. I restored its incidental lock/workspace edits. The test suites were instead executed directly through Vitest workspace mode and Node's test runner.

A repository unused-variable scan still reports 52 diagnostics across 51 files after excluding generated build/plan artifacts. Some are real dead state/functions, others are parameters required by test doubles or APIs; they need file-by-file triage. The existing CI recursive lint job excludes the root and there are no package lint scripts, so that job currently performs no checks. The root `biome check .` script remains red on its large pre-existing formatter/style baseline. I did not wire either command into required CI as a false passing or knowingly failing gate; lint-gate repair remains open.

Inventory refresh pending this batch: one new checked test row was added; repository source file count will be refreshed after this commit.

Inventory refreshed after CI and KB ingestion changes at `372f9e36`: 1,979 tracked files, 1,773 source/config checklist rows, 388 checked and 1,385 unchecked. The workflow implementation remains unchecked for its full durable retry/outage surface; its newly added boundary test file is checked.

## Root CI matrix and unused-code follow-up (2026-10-21)

Confirmed the new CI commands locally: repository Vitest 5,261/5,261, package/Worker workspace Vitest 1,618/1,618, native Node 27/27, conformance 4/4. Root typecheck configurations (62 total) and all 32 Worker deployment dry-runs had passed earlier in this audit. CI now runs these test surfaces directly; the prior package-filter command omitted tests outside `tests/`.

Triaged unused-symbol findings rather than treating the raw scan as authoritative: the report includes JSX props used later in render and callback arguments required by doubles/contracts. Removed only confirmed dead values: the unused `current` serialization in request-context budgeting, unused dashboard currency state (products, orders, and revenue each render their own currency), an unused password-reset catch binding, and an unused auth-session value. Request-context tests passed 2/2; dashboard and shell TypeScript checks passed; changed-file unused-variable lint passed. The rest of the 52-file scan is not cleared and remains a separate audit queue.

Biome now ignores generated `.next`, build-plan, phase-run, and local scratch outputs, reducing generated-file noise. The repository-wide formatting/lint baseline remains red; CI's recursive lint job still has no package lint scripts to run. Wiring a meaningful strict lint gate requires triaging the remaining 52 diagnostics and broader formatting baseline.

Inventory refreshed after the CI and unused-state audit at `83c07042`: 1,979 tracked files, 1,773 source/config checklist rows, 393 checked and 1,380 unchecked.

## Workspace file-tool boundary follow-up (2026-10-21)

While continuing the `r2-workspace` and `file-manager` review, confirmed and removed three unused SHA-256 helper functions (`contentHash` in each prebuilt and `bytesHash` in `r2-workspace`). A path boundary mismatch was also found: `file-manager` built R2 keys with a local substring check, unlike `r2-workspace`'s canonical validator. It could address the reserved `branches/` storage namespace, while it rejected harmless filenames containing `..`. The prebuilt now uses `normalizeWorkspacePath`, which rejects traversal, machine-state paths, reserved branch storage, NULs, and the workspace root consistently.

Added `tests/unit/file-manager-paths.test.ts` covering parent and backslash traversal, machine state, the reserved branch namespace, workspace-root writes, and a normal filename with consecutive dots. Focused validation passed: 6 new path tests plus 52 existing R2/REPL tests; Agents Worker TypeScript passed; Biome passed on the new test. Full Biome checks on the two prebuilt source files remain noisy from the repository's existing style baseline, so they are not represented as clean. The two source files remain unchecked in the exhaustive checklist because every operation and failure mode has not yet been reviewed. The new test file and existing R2 size test are checked for the cases exercised here.

The next boundary pass traced the DOCX extractor through the task-scoped attachment endpoint and its auth/route tests. A regression test exposed that the regex extractor accepted a fake `<w:document>` and paragraph entirely inside an XML comment, and could return comment markup as extracted document text. It now strips valid XML comments before checking the document root and text paragraphs, and rejects unclosed comment markers. This keeps commented markup from being presented as attachment text.

Validation passed: DOCX extraction 6/6, attachment route 9/9, task-scoped business-email routes 20/20, Agents Worker TypeScript, and focused Biome on the DOCX test. The route tests emit a PDF.js warning about missing standard font data for a fixture, but pass. The DOCX source remains unchecked until namespace/XML conformance and duplicate archive-entry behavior receive deeper review; only its current focused test file is checked.

The PDF text-size test initially triggered an unhandled PDF.js stream error (`Controller is already closed`) after the expected size-limit rejection. This was caused by cancelling `streamTextContent()` as soon as the output cap was crossed. The extractor now stops retaining additional text but drains the current bounded stream before reporting `attachment_pdf_text_limit`, avoiding the asynchronous close race. An actual generated PDF whose extracted text exceeds the cap reproduces the boundary; it now rejects cleanly with no unhandled Vitest errors.

Validation passed: PDF extractor 5/5, Agents Worker TypeScript, and the focused PDF test's formatting/lint check. The encrypted PDF fixture, malformed input, page cap, request-size cap, extracted text cap, and multi-page provenance are covered. The PDF test is checked; its source remains open for broader parser and hostile-document review. PDF.js emits its existing missing-standard-font fixture warning during text extraction.

The OCR route previously spent isolated document-sandbox rendering work before checking whether the Space had exhausted its daily OCR allowance. The first quota reservation now happens before reading PDF bytes or invoking the sandbox; additional reservations account for each further rendered page. Added a route regression asserting an exhausted PDF request returns 429 without any sandbox call. Added provider-output stress coverage verifying OCR output is capped at its 12,000-character contract.

Validation passed: attachment OCR route 10/10, OCR helper and SQLite admission tests 6/6, Agents Worker TypeScript. The OCR helper/test review covered PNG/JPEG dimension parsing, pixel and byte limits, invalid/no-text outputs, provider response truncation, per-Space atomic daily admission, and task-scoped route ownership. The helper and test are checked; the larger route implementation remains unchecked pending wider timeout/provider/container fault testing.

Inventory refreshed after the attachment/R2 and OCR follow-ups at code commit `5a9c92e3`: 1,980 tracked files, 1,774 source/config checklist rows, 398 checked and 1,376 unchecked. The overall audit remains open; these are scoped feature passes, not a whole-repository safety certification.

## Conversation cursor continuity at the transcript byte ceiling (2026-10-21)

The channel-thread reader now returns the ID of a single message that does not fit the 16 MiB page budget. The conversation prebuilt carries that host-provided cursor through as `next_cursor`, so a worker can skip the oversized message and continue into older transcript rows instead of repeating the same failed page. Regression coverage inserts a 16 MiB+1 message between the newest page and an older message, verifies the returned cursor, then confirms paging before that cursor retrieves the older message. Added a prebuilt-level case that checks host cursor precedence over the oldest retained row.

Validation passed: conversation prebuilt 18/18, channel transcript DO 3/3, Agents Worker TypeScript. These tests exercise current-thread scoping, transcript paging beyond 1,000 and 10,000 messages, stale and repeated cursors, byte-window overflow, and the oversized single-message continuation. The existing conversation files remain scoped complete in the checklist; full prompt compaction/retrieval behavior across live DO eviction and production channel storage still needs runtime fault testing.

## Repository regression suites after this audit batch (2026-10-21)

After the file-manager, DOCX, PDF, OCR, and conversation-cursor changes, the package/Worker Vitest workspace passed **1,623 tests across 341 files**. The repository-root Vitest suite passed **5,272 tests across 709 files**. Both commands were run directly through the installed Vitest binary to avoid this workspace's pnpm shim attempting an install. These runs validate the local test doubles and configured projects; they do not exercise deployed Cloudflare storage, live AI provider latency, or production container failures. Earlier native Node and conformance runs remain 27/27 and 4/4, respectively.

## Scanned email PDF OCR response bound (2026-10-21)

The task-scoped attachment OCR endpoint previously called `response.json()` on the document sandbox response before validating its page count and per-page PNG sizes. A faulty or compromised container could return an arbitrarily large streamed body and cause a large Worker allocation. The endpoint now reads the response under an 8 MiB streamed byte ceiling before JSON parsing; invalid or oversized responses return `pdf_render_output_limit` without invoking hosted OCR.

Added a regression where the sandbox returns more than 8 MiB without a `Content-Length` header. The email attachment route suite passes 11/11 tests, and the Agents Worker `tsc --noEmit` check passes. The suite emits the existing PDF.js missing-standard-font warning for its PDF fixture. The package-filter pnpm command could not run because the pnpm shim attempted an install and rejected an ignored dependency build script; direct installed Vitest and TypeScript binaries were used. The attachment route test file is checked; the large `workers/agents/src/index.ts` implementation remains unchecked pending review of its other routes and deeper sandbox/provider failure modes.

The adjacent video attachment transcription path had the same unbounded sandbox-response parse: it validated extracted base64 only after `response.json()` had allocated the response. It now caps the streamed JSON response at 2 MiB before parsing, enough for the documented 1 MiB extracted audio payload and encoding overhead. A regression streams over the cap without a declared content length and verifies the AI transcription provider is never called. Attachment transcription tests pass 4/4 and the Agents Worker typecheck passes. The test is checked; the large route implementation remains open while its other paths and failure modes are reviewed.

The same review found that audio/video transcription and image description trusted the D1 attachment size without comparing it to the fetched R2 object. Those routes now reject size disagreement before reading, and verify the actual audio buffer length after reading. Image dimensions are validated before reserving the per-Space OCR attempt, so malformed images do not spend the quota. The combined email OCR and attachment transcription suites pass 16/16, with Agents Worker TypeScript passing. The existing PDF.js fixture warning remains. These focused cases do not complete the broader route-file review.

The storage-only attachment copy path also trusted D1 size metadata until after loading the R2 object's full `ArrayBuffer`. It now compares the R2 object size to the authorized D1 row and rejects over-limit objects before reading bytes. Regression coverage proves no byte read or destination write occurs on inconsistent metadata. Copy and transcription suites pass 8/8; Agents Worker TypeScript passes. The attachment-copy route test is checked; the route implementation remains part of the open Agents Worker file review.

## Cloudflare inbound email parser byte ceiling (2026-10-21)

The email worker entrypoint checked Cloudflare's declared `rawSize`, but the reusable MIME parser accepted an unrestricted stream on its own. Added a streaming transform at the parser boundary that rejects input once it crosses the same 20 MiB cap, even if an upstream caller omits or misstates the metadata. The regression feeds repeated 6 MiB chunks and confirms parsing stops and rejects at the ceiling.

Validation passed: parser helper suite 5/5, Cloudflare email handler suite 20/20, and Agents Worker TypeScript. The email parser test file is checked; the parser source and ingress handler remain unchecked pending partial-write cleanup and idempotency review.

## AgentMail provider response and timeout bounds (2026-10-21)

The AgentMail REST helper previously parsed the entire provider response with `response.json()` and had no request deadline. It now uses a 64 KiB streamed response ceiling and a 12-second abort signal. Malformed JSON, oversized output, and non-object payloads fail closed through the existing honest error result. Added the first direct tests for this previously untested adapter: unconfigured behavior, valid authenticated request, oversized response, malformed JSON, and local recipient validation.

Validation passed: AgentMail and Cloudflare email helper suites 9/9, Agents Worker TypeScript, and Cloudflare handler integration 20/20. The new AgentMail test file is checked. Its source remains unchecked for full Svix/header conformance, malformed payload fields, webhook retry/idempotency, and live provider behavior.

## AgentMail webhook retry behavior on dispatch failure (2026-10-21)

The public Svix webhook acknowledged with HTTP 200 even when forwarding the verified email to the agent Durable Object threw or returned a non-2xx response. That permanently dropped messages because Svix would not retry. The route now returns a generic 503 `inbound_dispatch_failed` for either failure so the provider can retry; a regression signs a valid request and exercises both failure modes. The AgentMail route suite passes 21/21. The existing channel message table uses a unique `(session_id, direction, external_id)` dedupe index, but real Svix retry behavior and end-to-end duplicate delivery remain unverified. The test file is checked; the large index implementation remains unchecked.

The task-correlated reply sender had branched to the notifications worker before calling the central air-gap policy. Moved the egress check ahead of all email provider branches and added a reply-to-specific air-gap regression. This also tightened the allowed test fixture to provide explicit non-air-gapped policy data because missing policy is correctly denied. The route suite now passes 22/22 and Agents Worker TypeScript passes.

Reviewing the other provision path confirmed it already checks active Space state and stored air-gap policy before external mailbox creation. The business-email route tests now cover regular sends, reply-to sends, provisioning, and inbound dispatch failure behavior; this does not replace live provider verification.

After the email-boundary changes, the full configured package/Worker workspace passed **1,632 tests across 342 files**, the Agents Worker suite passed **697 tests across 152 files**, and the Agents Worker TypeScript check passed. These local tests do not cover live Cloudflare bindings or AgentMail/Svix delivery conditions.

Refreshed the tracked tree and source/config checklist at code commit `92cd6ee4`: **1,981 tracked files, 1,775 source/config files, 404 checked and 1,371 unchecked**. This refresh includes the new AgentMail adapter test and preserves all prior checked rows. The whole-repository review remains substantially incomplete.

## Channel provider air-gap and response-bound pass (2026-10-21)

The extension provider setup paths (Slack OAuth, Slack channel listing, Telegram setup, WhatsApp setup) did not consult Space egress policy before calling provider APIs. The platform Slack/Discord pairing callback and owner pairing-link action also lacked a policy check, and a valid inbound pairing token could bind a channel and send an external confirmation after the Space had become air-gapped. These paths now check policy before provider requests or pairing/binding side effects. Provider disconnect still performs local revocation and skips remote cleanup calls when egress is denied.

The same provider calls used unbounded `response.json()` parsing. Replaced provider metadata parsing in the Slack, Discord, Telegram, and WhatsApp setup/list paths with the shared 256 KiB bounded JSON reader. Air-gap regressions cover extension Slack/Telegram/WhatsApp setup and Slack channel listing, plus pairing start and OAuth callback; existing helper tests stress declared/streamed response ceilings and malformed JSON.

Validation passed: platform channel-pairing tests 27/27, extension provider tests 4/4, Agents Worker TypeScript. The related test files are checked. Full `workers/agents/src/index.ts` review remains open, including deployed provider API contracts, webhook retry behavior, and runtime egress verification.

Inventory refreshed after the provider pass at code commit `25cce99d`: **1,981 tracked files, 1,775 source/config files, 406 checked and 1,369 unchecked**. The audited source additions did not change file counts; two existing test files were checked.

## Connector and hosted MCP upstream response ceilings (2026-10-21)

The focused connector egress review found unbounded JSON parsing on successful Composio/Pipedream responses and on direct MCP `tools/list` and `tools/call` responses. A large or malformed upstream body could allocate excessive Worker memory; some provider adapters also converted parse failure into an empty successful result. Provider metadata and OAuth responses now use 2 MiB ceilings, provider action and direct MCP tool results use 4 MiB ceilings, and direct MCP tool listings use 2 MiB. Successful-response parse failures now return bounded upstream errors instead of empty results. Small credential and token responses are capped at 8–16 KiB.

Added streamed oversized-body regressions for Composio actions and both direct MCP routes. Validation passed: MCP Hub boundary suite 10/10 across four files, Agents Worker TypeScript, MCP Hub TypeScript, and `git diff --check`. The full root suite passed immediately before this scoped change: 5,286 tests across 710 files; the Agents package/Worker suite passed 698 tests across 152 files. The new focused boundary test is checked; the provider and hub implementation files remain unchecked because their auth, scope, egress, and failure paths still need a complete per-file review. Inventory refreshed and code pushed in `589da851`.

## Platform assistant chat and gateway bounds (2026-10-21)

The platform assistant accepted an unbounded JSON chat body and persisted arbitrarily large individual messages. Its last 40 history rows were count-limited but could still collectively expand the prompt without a character budget. Embeddings and chat gateway responses also used unbounded JSON parsing and had no explicit request deadline. The route now reads at most 64 KiB of request bytes, rejects messages above 16 KiB, caps retained history at 32,000 characters and 4,000 characters per row, caps retrieved document context at 32,000 characters, bounds embeddings and chat JSON to 256 KiB, and applies 15-second and 30-second timeouts. Invalid JSON and non-text messages return 400; oversized requests/messages return 413. The existing fallback response handles oversized or malformed model output.

Added route tests for oversized request streams, oversize messages, oversized streamed model output, and large retrieved documents. Validation passed: assistant route tests 4/4 and assistant Worker TypeScript. The new test file is checked; `workers/assistant/src/index.ts` remains unchecked for full authorization, session concurrency, retention, and provider semantics review. Inventory refreshed in `31ff8f69` and included in subsequent audit refreshes.

## Stripe payout reconciliation response ceiling (2026-10-21)

Stripe payout reconciliation validates the returned transfer ID, amount, currency, and destination before marking a payout paid, and retries uncertain outcomes with the same idempotency key. However, both the connected-account capability lookup and transfer response were parsed with unbounded JSON reads. Both now use a 64 KiB streamed ceiling. An oversized/invalid transfer response follows the existing uncertain-outcome path and leaves the payout deferred for same-key reconciliation; it is never marked paid based on a partial response.

Added a regression with a successful capability lookup and an oversized streamed transfer response. Validation passed: payout reconciliation test 1/1, billing Worker TypeScript, and `git diff --check`. The test file is checked; payout source remains unchecked pending full review of payout selection, concurrent claim behavior, and provider reconciliation. Inventory refreshed and code pushed in `a66a3e56`.

## Lemon Squeezy product provisioning response bounds (2026-10-21)

The shared product/variant provisioning adapter parsed Lemon Squeezy's JSON:API responses without a byte cap, had no request deadline, and trusted response resource types/IDs. Both requests now have 15-second deadlines, responses are capped at 64 KiB, and resource type plus identifier shape are validated before the ID is persisted by callers. New tests cover a valid two-step create, oversized first-step response (which prevents the second request), and a resource-type mismatch.

Validation passed: full billing worker suite 11/11 across six test files, billing Worker TypeScript, and `git diff --check`. The new test file is checked; the adapter and callers remain unchecked for full retry/idempotency and partial-create recovery review. A provider timeout after successful creation can still leave a Lemon Squeezy product without a locally stored ID; safe resumability needs a stable provider idempotency/reconciliation design and remains an explicit audit gap. Inventory refreshed and code pushed in `ae217b57`.

## OAuth token, refresh, and userinfo response bounds (2026-10-21)

The generic OAuth adapter exchanged authorization codes and rotating refresh tokens without request deadlines or response byte limits. Malformed/oversized refresh replies were converted into empty objects, and userinfo followed redirects while carrying the bearer token. Token exchange/refresh now use 15-second deadlines and 64 KiB JSON ceilings, require bounded non-empty access/refresh tokens and a valid expiry range, and userinfo uses a 16 KiB ceiling, the same deadline, and rejects redirects. Oversized and malformed identity responses remain best-effort `null`; token failures throw without returning partial credentials.

Added regressions for valid exchange with timeout, oversized refresh, invalid token fields/expiry, and oversized or overlong userinfo identity. Validation passed: OAuth helper and ticket tests 6/6, Agents Worker TypeScript, and `git diff --check`. The new test file is checked; the OAuth source remains unchecked pending review of callback state consumption, issuer/audience validation, and live provider contract behavior. Inventory refreshed and code pushed in `19f61476`.

## Shared Stripe billing client bounds (2026-10-21)

The shared Stripe client parsed success and error bodies with unbounded `response.json()` and had no outbound deadline. It now applies a 15-second timeout, caps success JSON at 256 KiB and error JSON at 8 KiB, and clips surfaced provider messages. Subscription IDs are validated before path use. Customer search now escapes quote/backslash characters in tenant IDs and encodes the full search expression with `URLSearchParams`, closing a search-language injection path that could select a different tenant's Stripe customer.

Added tests for oversized responses/timeouts, escaped tenant query values, and invalid subscription IDs. Validation passed: billing-core package suite 19/19 across six files, package TypeScript, and `git diff --check`. The new test is checked; the shared billing source remains unchecked pending review of billing provider lifecycle, status transitions, and live Stripe idempotency behavior. The billing-core package now declares `@naelao/http` as a workspace dependency for streamed response parsing. Inventory refreshed and code pushed in `f5f8bba3`.

## Lemon Squeezy provider response and identifier bounds (2026-10-21)

The primary Lemon Squeezy billing provider parsed checkout, customer portal, store listing, and webhook setup responses without byte ceilings and did not set explicit deadlines. Subscription paths also interpolated caller-supplied IDs directly. These paths now use 256 KiB bounded JSON parsing, 15-second deadlines, and validated/encoded subscription IDs. Checkout and customer portal links must be HTTPS before being returned to the browser.

Extended the provider tests for oversized streamed checkout and store-list responses, timeout signal presence, and subscription path separators. Validation passed: full billing-core suite 22/22 across six files, billing-core TypeScript, and `git diff --check`. The existing provider test file is checked; the provider implementation remains open for complete webhook, checkout authorization, cancellation, and live API contract review. Inventory and code were pushed in `6aa05e9d`.

## Whop OAuth checkout provider bounds (2026-10-21)

The OAuth-delegated Whop checkout helper buffered complete response text and had no request deadline while performing access-pass, plan, and checkout-configuration calls. It now caps successful JSON at 128 KiB, error diagnostics at 8 KiB, applies 15-second timeouts, validates provider IDs before using them in later steps, and only returns HTTPS checkout links. Oversized or invalid responses stop the flow before further provider requests.

Added tests for the three-step success path, timeout signals, oversized first-step response, and insecure checkout URLs. Validation passed: billing-core package suite 25/25 across seven files, package TypeScript, and `git diff --check`. The new test file is checked; the implementation remains open for idempotency/recovery after partial provider creation and live Whop OAuth contract validation. Inventory refreshed and code pushed in `a357c61b`.

## Whop platform checkout and sub-merchant response ceilings (2026-10-21)

The platform sub-merchant and platform-plan adapters also buffered unbounded Whop response text and had no request timeout. Both now cap JSON at 128 KiB, cap upstream error diagnostics at 8 KiB, use 15-second deadlines, and only return HTTPS checkout links. The sub-merchant helper validates returned company, withdrawal, and transfer IDs before using or persisting them.

Added tests for oversized responses, deadline signals, and insecure checkout links on both checkout rails. Validation passed: billing-core suite 28/28 across eight files, package TypeScript, and `git diff --check`. The new test is checked; both provider files remain open for full state-transition, provider idempotency, and live API-contract testing. Inventory refreshed and code pushed in `3c894c03`.

## Thread attachment integrity and pagination (2026-10-21)

Reviewing the threads worker found that migration `0027_threads.sql` never added `last_active_at`, although thread list, create, and attach queries all read or write it. New thread creation and listing could fail against a database built from the checked-in migrations. Migration `0114_thread_last_active_at.sql` adds the column, backfills existing rows from message/update/create time, and adds an activity index. A real SQLite migration test reproduces the old schema and verifies the upgrade and backfill.

Retrying the same session attachment previously incremented `session_count` repeatedly, and a global session-ID conflict could move a session from one thread into another without repairing the old count. The route now keeps the original attachment, returns an idempotent result for same-thread retries, rejects cross-thread conflicts, checks that the session end-user matches the thread owner, and derives the count from stored session rows. Thread detail now pages its session list (default 50, max 100; bounded offset) instead of returning every session at once.

Thread create/attach/update bodies now have a 64 KiB ceiling and basic field-size/range validation. Per-session summaries are capped at 4,000 characters and aggregate summarization input at 32,000 characters; the model request has a 15-second deadline. Tests cover replay count stability, conflict rejection, user mismatch, paged detail, and overlarge create input. Validation passed: threads Worker suite 6/6, the real SQLite migration test 1/1, threads Worker TypeScript, and `git diff --check`. The migration and both test files are checked; the route source remains open for broader tenant authorization, status transition, deletion-race, and long-running summary review. Inventory refreshed and changes pushed in `75d8fa06`.

## Thread retention counter integrity (2026-10-21)

Tracing the sweeper's 90-day cleanup showed that it deleted ended rows from `thread_sessions` without refreshing the parent `threads.session_count`. The deleted-space cleanup also removed all session rows but left each parent counter unchanged. Retention now selects affected thread IDs, deletes the bounded old rows and recounts those parents in one D1 batch; deleted-space cleanup resets counts after removing its session shadows.

Added a real SQLite regression test using the checked-in active-session, thread, and thread-session migrations. It verifies the ended row is gone and the parent count matches the surviving row. Validation passed: sweeper suite plus retention regression 9/9, sweeper Worker TypeScript, and `git diff --check`. The test file is checked. Broader sweeper failure fairness under persistent provider errors and the data-erasure workflow's separate thread cleanup remain open audit items. Inventory refreshed and changes pushed in `d5111785`.

## Organization data-erasure completeness (2026-10-21)

Tracing the previously open erasure cleanup found several concrete gaps: the workflow built pre-project R2 keys, did not delete Autorag objects, could stop early on a missing/repeated R2 cursor, allocated the full Vectorize ID list for a document, and left `kb_chunks` plus parent thread summaries in D1. The user anonymization step also retained password hashes and last-login timestamps despite its stated goal of clearing credentials.

Erasure now uses project-aware R2 paths, drains pages with bounded object/vector batches and rejects incomplete pagination, removes space-wide KB/Autorag leftovers, and deletes searchable chunks, documents, sessions, and parent threads in one D1 batch. The user step now clears password hashes and login timestamps while keeping stable IDs needed by retained audit records. Tests cover project keys, multi-page deletion, bad cursors, corrupt chunk counts, D1 thread/chunk removal against real SQLite migrations, and org-scoped user anonymization. Validation passed: erasure helper and database tests 8/8, workflows Worker TypeScript, and `git diff --check`. The helper and focused tests are checked; the full WorkflowEntrypoint step/retry/cancellation lifecycle remains open pending a Cloudflare Workflows harness.

## KB ingestion workflow API and long-document batching (2026-10-21)

The workflow posted to `/internal/docs/...`, but the Knowledge Worker registered no matching handlers. The existing workflow test mocked every service call as success, so it could not catch that the deployed feature always failed. Added tenant-HMAC-gated, tenant/space/project-scoped status and chunk-ingestion routes, and updated the workflow to mint a fresh internal token for each call. The new handler enforces a 700 KiB request cap, at most 50 chunks per batch, per-chunk and total-byte ceilings, document state and range checks, and idempotent chunk/vector IDs.

The normal Knowledge API now stages and queues eligible project documents larger than 1 MiB, up to 5 MiB, while preserving `required_role_rank` and `allowed_user_ids` through the workflow into Vectorize and D1. Space-wide documents above the synchronous limit fail clearly because the queue contract currently requires a project scope. Queue submission failure rolls back the staged object and document row. The workflow validates that its staging key exactly matches tenant, space, project, and document IDs; the Knowledge worker now declares the shared queue producer binding in development, staging, and production.

The workflow counts chunks and sends batches of 50 with stable chunk offsets, avoiding one 5 MiB JSON request and reducing request timeouts. It checks the staged R2 object's size and ETag on each processing pass, rejects empty content, and fixes a splitter boundary bug that dropped one character from long unbroken text. Each batch also gets a distinct stable storage-usage idempotency key so a retry does not double-charge one batch or suppress accounting for the rest. Tests now call the real Knowledge Worker routes and cover auth, tenant-scoped status updates, malformed bodies, restrictive ACL preservation, queue dispatch/rejection/rollback, 55-chunk batching, content preservation, ETag changes, and unsafe keys. Validation passed: Knowledge, workflow, and queue suites 28/28, both Worker TypeScript projects, and staging Wrangler dry runs for both workers. The test files are checked; both large implementation files remain open for broader ACL, quota, retry, and workflow-state review.

## Queue redelivery idempotency and full root suite (2026-10-21)

The full root test run exercised 723 files and 5,344 tests: 5,343 passed and one Whop OAuth checkout assertion failed because its expected “no id” phrase no longer matched the implementation's clearer “no valid id” error. The message now includes the contract phrase, and that complete Whop checkout file passed 9/9 on a focused rerun.

The queue consumer review also found an at-least-once delivery gap shared by provisioning, erasure, KB ingestion, and dunning. If a workflow instance was created but the queue acknowledgement was lost, redelivery used the same instance ID, treated the duplicate-create error as failure, and retried indefinitely. Dispatch now checks the deterministic workflow ID after a create error: an existing instance is treated as already accepted, while an unconfirmed instance preserves queue retry. Added regressions for both paths.

The erasure lifecycle review found KV cleanup stopped silently when KV reported an incomplete page without a cursor, and could repeat a cursor forever. KV deletion now bounds per-page delete fanout and fails closed on missing or repeated cursors, with pagination regressions. Tests passed: 22/22 across the queue consumer, erasure cleanup, and Whop checkout files; workflows Worker TypeScript and `git diff --check` passed. The full suite has not been rerun after these focused changes. Review also found no request producer or cancellation/restore path for `data.erasure`, despite the workflow describing its 24-hour wait as a reversible window. The workflow has only the KB and quota KV bindings and does not reach artifact, export, script/workspace storage or the rest of the tenant's D1 records. This is an open product and lifecycle gap requiring an end-to-end scoped resource inventory and implementation. Queue consumer and billing provider implementations remain open for complete file-level review. Audit inventory was 1,996 tracked files / 1,790 source or executable-configuration files at this review point, and the file-by-file plan remains substantially incomplete.

## Analytics marker contract for organization erasure (2026-10-21)

Tracing the erasure completion event into Analytics found two connected defects. First, the workflow sent `{ type: "analytics.user_erased", orgId, erasedAt, reason }`, while the consumer accepts `eventType` and `tenantId`, so it would acknowledge the event as invalid. Second, the Analytics Worker had no configured queue consumer. Cloudflare permits one consumer Worker per queue, so Analytics cannot share `naelao-events` with the Workflows consumer. The workflow now emits the analytics schema's `user_erased` event with `tenantId` and bounded metadata, without a user ID, through the existing Terraform-provisioned `naelao-analytics` queue. Analytics consumes that dedicated queue in development, staging, and production. Added queue-contract and environment-wiring regressions and added the producer/consumer map to the platform-surface inventory. Validation passed: analytics + erasure tests 10/10, Wrangler binding parity 59/59, analytics/workflows TypeScript, dry runs for analytics development/staging/production and workflow development/staging/production. The test is checked in the plan; event producer and workflow source remain open for full cross-file review. Audit inventory is 1,997 tracked files / 1,791 source or executable-configuration files. The erasure initiation/cancellation gap remains open.

The full root suite was rerun after the workflow queue idempotency, KV cursor, and analytics marker changes: **724 test files / 5,350 tests passed** in 293 seconds. Workflows TypeScript and `git diff --check` also passed after clarifying that the current 24-hour erasure delay is not reversible. The file-by-file checklist then recorded 428 scoped reviews with 1,366 files open; its refreshed inventory now records 427 scoped reviews and 1,366 open files after removing duplicate checklist rows and adding the two queue regression files. Full tenant erasure is not complete: no authorized request/cancellation route exists, and artifacts, exports, scripts/workspaces, and non-KB tenant records are outside the workflow's current bindings and cleanup.

## At-least-once notification and DLQ record handling (2026-10-21)

The admin dead-letter consumer generated a random failure-row ID for each delivery, so a lost queue acknowledgement could create duplicate operator records. It now keys the row from the stable queue message ID with `INSERT OR IGNORE`. The notification consumer similarly used random IDs for in-app rows and the email audit row; these records now use stable message-derived IDs, and in-app writes ignore duplicates. Tests passed 2/2 across the new queue regressions; Admin and Notifications TypeScript checks passed. External email/webhook/push sends can still be repeated after an uncertain provider success because there is no confirmed provider-side idempotency key in this path; that remains open for provider-specific review. The repository tree then listed 1,999 tracked files / 1,793 source or executable-configuration files. The refreshed file-by-file plan recorded 430 scoped reviews with 1,366 files still open at that checkpoint; service implementations remain unchecked for broader review.


## Sweeper fairness under persistent cleanup failures (2026-10-21)

The daily sweeper selected the first 100 failed documents and orphan chunk groups and the first 20 deleted spaces on each run. It caught per-item R2/Vectorize errors and left the row eligible, so a persistent failure near the start of each ordered result set could starve every later item indefinitely. Added migration `0115_sweeper_fairness_cursors.sql` and independent persisted scan cursors for each of the three cleanup groups. Each pass advances after its examined batch and wraps to the beginning when it reaches the end, allowing later candidates to progress while retaining retries for failures. The keyset predicates retain stable ordering and avoid offset scans. Added a regression test for advance-and-wrap behavior. Validation passed: sweeper tests 9/9, platform migration tests 6/6, sweeper TypeScript, and `git diff --check`. External provider idempotency and full lifecycle stress coverage remain open.

The same boundedness pass also found that a single deleted space selected only its first 200 eligible documents without a per-space continuation point. Cleanup now stores a cursor per deleted space and orders documents by ID, so a repeatedly failing document cannot block later documents in that space. Regression coverage remains in the sweeper's cursor advance/wrap test and deleted-space cleanup tests. Validation passed again: sweeper tests 9/9, platform migration tests 6/6, sweeper TypeScript, and `git diff --check`.

## Sweeper migration deployment guarantee (2026-10-21)

Tracing the new cursor table through release workflows found that both staging and production replay raw D1 migration files with `|| true`, suppressing any migration error before deploying workers. A missing `sweeper_cursors` table would make each cursor-backed sweep reject at startup. Added an explicit required execution of the idempotent cursor migration after the legacy best-effort loop in both workflows, plus a regression test asserting both deployment paths contain that required command. Validation passed: sweeper tests 10/10, sweeper Worker TypeScript, and `git diff --check`. The broader migration runner still suppresses errors for historical migrations and remains a deployment-system audit item.

## Notification webhook SSRF boundary (2026-10-21)

The Notifications worker's webhook check only rejected a short list of literal IPv4 strings and loopback IPv6. Hostnames were not resolved, so a webhook domain resolving into RFC1918, link-local, or private IPv6 space could reach a private destination. Replaced the local check with the shared bounded, fail-closed `checkSsrf` implementation, which checks literal IP ranges and A/AAAA answers. Webhook fetches now reject redirects and have a 10-second timeout. Regression coverage verifies private DNS answers and private IPv6 literals are blocked, while public DNS is allowed and delivery is bounded. Validation passed: full Notifications suite 17/17, Notifications TypeScript, and `git diff --check`. Residual risk: `fetch` resolves the hostname again after the check; closing that DNS-rebinding window requires a network egress proxy that pins the validated address.

## MCP Hub Composio tenant-space binding (2026-10-21)

Two internal Composio endpoints authenticated the tenant HMAC but trusted a separate `x-naelao-space-id` header without checking that the space belonged to the signed tenant. Their air-gap check also reads space policy by ID only. Added an active-space ownership check (`space_id`, `tenant_id`, and `status='active'`) before egress checks, OAuth-link creation, execution, or usage metering. Regression tests use a valid tenant-A HMAC with a tenant-B space and verify both connect and execute stop with 404 before any outbound provider request. Validation passed: MCP Hub suite 12/12, MCP Hub TypeScript, and `git diff --check`.

## Admin restore boundary under tenant suspension (2026-10-21)

Reviewing the product kill-switch paths found `/admin/products/:spaceId/restore` reactivated any suspended space without checking its parent org. An org already suspended by admin or erasure could therefore have a child space reactivated through the product restore endpoint. Restore now requires the parent org to remain active, accepts only suspended spaces, and uses a conditional update to catch status races. Real SQLite regression tests verify a suspended org stays blocked and an active org's suspended space restores. Validation passed: admin schema suite 8/8, Admin Worker TypeScript, and `git diff --check`.

Cross-file review found a larger gap: `/admin/tenants/:tenantId` can set `orgs.status='suspended'`, but worker access did not check it. A shared router gate now checks tenant status for JWT, product-session, and agent-key identities before proxying, with a two-second bounded cache and fail-closed behavior when the organization row or D1 is unavailable. Regression coverage checks suspended tenant rejection, cache expiry, missing rows, and database failure. This protects public requests that pass through the router; direct internal service calls and queue consumers still need a tenant-wide policy audit, and restoration still needs a model that preserves per-space suspension reasons. The Data Erasure workflow separately suspends spaces.

## Conversation history scan subrequest budget (2026-10-21)

The conversation search allowed a 10,000-message scan but fetched only 100 messages per SpaceDO request, requiring up to 100 service-binding calls plus a continuation probe. This could exceed low-tier Workers subrequest limits and return an incomplete search on long threads. SpaceDO supports a 500-message cap, so the prebuilt now uses 500-row pages while retaining the 16 MiB content budget and byte-trimmed cursor behavior. Updated the 1,234-message stress fixture to follow requested page size; it still finds the oldest match with 3 calls instead of 13. Validation passed: conversation prebuilt tests 18/18, Agents Worker TypeScript, and `git diff --check`.

Follow-up on the MCP Hub DNS finding: both direct connector fetches (tool listing and tool execution) followed redirects after validation. Redirects now fail closed on both paths so credentials and MCP payloads cannot be forwarded to a redirected destination without revalidation. Added request-option assertions for both endpoints. Validation passed: MCP Hub suite 14/14, MCP Hub TypeScript, and `git diff --check`. DNS re-resolution between validation and connection remains an egress-proxy issue.

## Channel session queue delivery path (2026-10-21)

The channel and trigger Workers published to `naelao-channel-sessions`, but no Worker consumed it and Terraform did not provision that queue. Inbound messages were acknowledged as queued by their HTTP endpoint and then never became agent work. The Agents Worker now consumes both `inbound_channel` and `space_trigger` messages in development, staging, and production; Terraform provisions the queue and its DLQ. The consumer validates bounded message shapes, retries transient dispatch failures, drops malformed poison messages, checks active space and tenant status, creates a stable per-sender conversation session, stores inbound messages with the queue ID as the message idempotency key, then wakes the space agent. SpaceDO session creation now accepts a validated internal idempotency ID and rejects reuse across tenant, space, or end-user ownership. Validation passed: Agents queue tests 3/3 and TypeScript; Spaces session lifecycle tests 9/9 and TypeScript; Wrangler TOML parsed with the expected queue consumers; `git diff --check` passed. Terraform is unavailable in this workspace, so `terraform fmt`/plan were not run.

This closes message delivery into the agent runtime, not the full external channel loop. The legacy channel endpoint still lacks provider signature verification and a configured outbound reply path, so the caller receives only its immediate queued acknowledgement and the agent's answer is retained in Naelao rather than delivered back to Slack/email/webhook. Multi-event agent dispatch idempotency after an uncertain model-run success also needs a durable run receipt; the session and inbound message writes are idempotent, but a redelivered run may execute twice. These are open channel reliability/security items. The broader per-file audit remains substantially incomplete.

The tracked inventory now contains 2,008 files, including 1,802 source or executable-configuration files, anchored at code commit `7d4f998f`. The checklist has 437 reviewed rows and 1,365 still open; new queue and tenant-status source and regression files are included. This is an inventory refresh and focused review, not completion of the full Naelao audit.

### Inventory refresh after queue and workflow suspension checks

Regenerated `naelao-repository-tree.txt` from `git ls-files` at code commit `e88aa8d7` after adding three tracked TypeScript files. The inventory now records 2,011 tracked files and 1,805 source or executable-configuration files. Added the three files to the per-file checklist; the counts are 437 reviewed and 1,368 open. The classification follows the previously recorded extension policy; this refresh does not indicate broader audit completion.

## Public router tenant suspension gate (2026-10-21)

After adding the gate, an initial router stress run failed 36 assertions because test environments did not bind the D1 database needed to establish organization status. Updated the affected router fixtures to model an active tenant, then added an integration regression proving a suspended tenant is rejected before feature routing. The focused router set passes 79/79, including product-session, agent-key, dispatch, pre-auth, CORS, rate-limit, and dynamic-origin cases; tenant status tests pass 3/3; Router TypeScript and `git diff --check` pass. The enforcement currently covers public requests through `naelao-router`; worker-to-worker invocations need their own scoped audit and this does not yet make tenant suspension a complete platform-wide stop.

## Internal tenant suspension gates (2026-10-21)

Continued the tenant-status pass across agent background work and notification delivery. Agent tick consumption now checks that both the space and its organization remain active before running scheduled jobs, connector polls, or project-steward reviews; external channel and attachment paths reviewed in this pass also bind the space to an active organization. Notifications now check tenant status before queued delivery and before synchronous `/internal/notify` email, push, or chat dispatch. Suspended or unknown tenants are dropped without egress, while a D1 failure on queued authorization retries rather than losing the delivery. Validation: Notifications focused suites 20/20 (queue idempotency, webhook egress, air-gap, web push, and interactive delivery); Notifications and Agents TypeScript; scheduled-job/dispatch/AgentMail suites 73/73; `git diff --check`.

This remains a scoped pass, not a global tenant authorization layer. Other workers' internal routes, queue consumers, durable-object alarms, workflows, and already-running operations still require review. The notification synchronous route continues to rely on the worker service-binding boundary for caller authentication; this pass enforces tenant activity after the asserted tenant header is provided. Inventory remains 2,008 tracked files and the file-by-file checklist remains 437 reviewed / 1,365 open at the last anchored inventory. The full codebase audit is not complete.

Follow-up queue review found that a suspended tenant's delayed space-provision message could still allocate and initialize resources: the provisioner checked only the space status and tenant ownership. Provisioning now requires an active organization in the same D1 lookup, so suspended or unknown tenants are treated as stale work and acknowledged without side effects; authorization lookup failures still flow to the queue retry handler. Deprovisioning remains available for cleanup. Validation: provisioner queue and tenant-suspension tests 5/5, Provisioner TypeScript, and `git diff --check`.

The same delayed-work review found KB ingestion jobs were launched without checking current tenant or space status, and an already-running ingestion workflow could continue writing chunks through signed internal Knowledge routes. The workflow queue now drops stale KB ingestion jobs before workflow creation and retries on a status database failure. Knowledge now requires an active tenant and active space on both public KB paths and every signed internal `/internal/spaces/:spaceId/kb/*` path, including each chunk call from a running workflow. Tests prove stale queue jobs do not start and suspended internal chunk calls write neither R2 nor Vectorize data. Validation: Knowledge suite 62/62, workflow queue suite 6/6, Knowledge and Workflows TypeScript, and `git diff --check`. An operation already past its active-space check can still race with a suspension during that individual request; broader cancellation of in-flight Workflows is a separate lifecycle gap.

Reviewing the workflow queue's separate `space.provision` path found its workflow validated a subscription but omitted organization suspension; its final update could also reactivate any non-active Space by ID alone. Eligibility now requires the matching active org, active/trialing subscription, and a Space still in `provisioning`; activation is an atomic conditional update requiring that same org to remain active. If suspension or space state wins the race, the workflow exits before publishing `space.provisioned`. Validation: workflow queue and activation guard tests 8/8, Workflows TypeScript, and `git diff --check`.
