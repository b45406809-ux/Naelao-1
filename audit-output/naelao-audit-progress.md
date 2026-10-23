# Naelao audit progress and evidence

This records completed passes from the current change set. It does not represent a completed audit of all repository files. The file-by-file checklist remains pending until each file's callers, runtime registration, and trust boundaries have been reviewed and evidence recorded.

## Data erasure infrastructure pass (2026-10-21)

Extended the existing erasure worker coverage across the 57 per-space operational D1 tables, tenant access records, notifications, agent-authored artifacts, workspace objects, blueprint export files, and repository Git object/publication prefixes. Deletion walks R2 pages with cursor validation; exact export-key deletion uses batches of at most 100. Organization user PII is anonymized, operational tenant access is removed, spaces are marked erased, marketplace subscriptions are cancelled while referenced earnings history is retained, and wallet/order contact details are scrubbed while accounting totals remain. `audit_log` remains for security/audit context. Financial records remain pending a retention policy decision.

Evidence: `workers/workflows/src/workflows/erasure-cleanup.test.ts` (11 pass), `tests/unit/data-erasure-records.test.ts` (3 pass), and `workers/workflows` TypeScript check. A migration cross-check found and added cleanup for `fde_graduations`, `launchpad_products`, and `llm_token_reservations`. Wrangler TOML R2 bindings are configured in default, staging, and production environments. The bindings now cover `naelao-artifacts`, `naelao-repository-objects`, and `naelao-agent-scripts`.

The queue consumer now rejects malformed or oversized `data.erasure` messages before workflow creation. Its focused queue and erasure tests pass (20 combined), and the workflows TypeScript check passes. No authenticated producer/request API was found, so this only protects the internal dispatch boundary and does not make organization erasure user-accessible.

An additional scale review found blueprint exports, organization spaces, and each space's KB documents were read with unbounded D1 queries. The workflow now keyset-pages spaces, documents, and exports in groups of 100 and validates monotonic progress. Vector, R2, and export-key deletes are bounded. A schema-backed inventory assertion now classifies every live D1 table with a `space_id`; it found and added deletion of workflow budget reservations. Migration-level D1 erasure tests pass (4), the erasure helper suite passes (12), and the workflow TypeScript check passes.

Erasure object-scope review also found that export keys were trusted from D1 after selecting rows by space. Since the R2 key namespace is tenant-level, a corrupted cross-space key could have deleted another space's export. The workflow now requires the stored key to equal `conformance-jobs/{tenantId}/{exportId}.json`; the 12-case erasure helper suite and Workflows TypeScript check pass. A full-migration SQLite classification test covers every live D1 table with a `space_id` and separates deletion from documented retention/anonymization; it found and added workflow budget reservation cleanup. Order customer contact fields and provider references are now scrubbed while financial totals remain.

The organization-level D1 pass found more non-`space_id` records: business invites/membership indexes and product end-user profiles. These are now deleted by their space relationships. Existing `gdpr_requests` keep the rights-request audit row while clearing subject identifiers and cancelling pending requests. Full-migration SQLite tests cover those actions along with wallet/order PII scrubbing (4 D1 tests); the workflow erasure suite passes 12 tests and Workflows TypeScript passes. ProductUserDO sessions and other durable state remain open.

The follow-up PII scan found product-user password reset/email verification tokens and builder password reset tokens were outside the space-table deletion list. Erasure now deletes product tokens by their product space and builder reset tokens before anonymizing the org's user rows. Full-migration SQLite D1 erasure tests pass (4); the recovery-token assertions verify no pending credential reset survives identity anonymization.

External resource review found custom hostnames registered through Cloudflare for SaaS were deleted from D1 without being removed from Cloudflare. Added a signed internal Spaces cleanup route and a bounded, timed DELETE call; provider 404 is treated as already erased, while missing credentials or provider failures stop the workflow before deleting its service row. Cloudflare API JSON parsing is now capped at 64 KiB. Validation: Cloudflare helper suite 9/9, D1 erasure/product-user suites 8/8, Spaces and Workflows TypeScript. Oversized provider JSON is rejected. Other external provider resources still require a full inventory and cleanup policy.

ProductUserDO records are now erased through a tenant-HMAC-protected internal Spaces route before deleting their D1 roster rows. The D1 helper keyset-pages users in batches of 100, stops on any DO failure, and only removes a profile after the DO confirms success. Validation: 205-user SQLite-backed paging test plus cross-tenant and retry-preservation cases (2 pass); Workflows and Spaces TypeScript checks; workflow erasure/queue suites 20/20. ProductUserDO credit ledgers remain by design for accounting; other durable-object namespaces are still unaudited for organization erasure.

Refreshed the tracked repository tree after adding the ProductUserDO erasure helper and its SQLite test. At code commit `bb4d6b18`, the tree records 2,016 tracked files / 1,810 source or executable-configuration files; the checklist has 439 reviewed and 1,371 open. The tree and file checklist remain an inventory and work tracker, not a completed audit.

This is not complete erasure coverage. RepositoryDO SQLite state, durable object state in other services, repo/workspace materialization races, export request/cancellation/restoration lifecycle, storage surfaces outside these prefixes, and a legal retention schedule for financial/audit records remain open. The current pass deletes the repository R2 prefix but does not yet purge per-repository Durable Object metadata.

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

### Retire duplicate patch generator after reference verification (2026-10-22)

Completed the pending three-way reference check for `create_patch.js`: repository-wide search found no code import, package script, workflow, or generated runtime lookup; its only product-adjacent use was writing the fixed `repomix/patches/batch-01.patch`, which the separate `ai_studio_code.sh` generator already writes. Remaining references were only the stale tree/checklist/progress records. Removed the redundant 72 KiB generator. The patch artifact and its manual apply workflow remain; no external package API or deployed binding referenced the deleted file. The tracked repository tree and checklist are refreshed in the following audit update. No test suite imports or executes this utility.

The post-deletion inventory refresh records 2,035 tracked files / 1,827 source or executable-configuration files at code commit `fe85a1e8`. The checklist preserves 515 reviewed rows and now has 1,312 open rows; newly tracked source/config entries were not marked complete.

### Retire unreachable legacy phase runner (2026-10-22)

Completed the reference check for `run-phase (1).mjs`: no package script, workflow, code import, or runtime registry invokes it, and `@google/genai` is absent from every workspace manifest and the lockfile, so the standalone runner cannot execute in this checkout. The active workflow calls the maintained `run-phase.mjs`, which now has bounded inputs, safe child environments, tested patch paths, and the focused 17-case safety suite. Removed the unlaunchable duplicate. No production application imports either standalone runner. The tracked tree/checklist are regenerated immediately after this deletion; no legacy execution test was possible because its dependency was not installed or declared.

The refreshed inventory at `65ad6b0c` now contains 2,034 tracked files and 1,826 source/config files. It preserves 515 completed scoped reviews and lists 1,311 open rows.

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

Follow-up on reseller suspension found the router checked only `orgs.status`, while `/reseller/clients/:childTenantId/status` suspends the separate `tenant_hierarchy` relationship and cascades a space status. The public router gate now requires both an active org and an active (or absent) reseller relationship; suspended and terminated child relationships fail closed. Validation: tenant status helper tests 4/4, router dispatch/agent-key/product-session/rate-limit suites 48/48, Router TypeScript, and `git diff --check`. The first follow-up also identified that reseller restoration could reactivate independently suspended spaces; the source-preserving fix is recorded below.

## Suspension source preservation and deploy guard (2026-10-21)

Fixed the reseller restoration risk recorded above. Migration `0116_space_suspension_reason.sql` adds `spaces.suspension_reason`. Reseller suspension now atomically changes the hierarchy and only currently active child spaces, marking those spaces `reseller`; restoration reactivates only spaces marked `reseller` and requires the child org to be active. Product abuse suspension/restoration uses `admin_product`, and the erasure workflow marks only formerly active spaces `erasure`. Product restore refuses to clear another control's reason, and terminated reseller relationships cannot be reactivated. Added real-SQLite coverage proving reseller suspension/restoration preserves an admin abuse hold. Validation: reseller suspension and Admin schema suites 11/11, Sweeper/deployment guard suite 10/10, Spaces and Admin TypeScript, `git diff --check`.

The deploy workflows' legacy migration loop suppresses failures. Staging and production now run a required `SELECT suspension_reason FROM spaces LIMIT 0` after the loop, which fails before deploy if migration 0116 did not apply. This new column does not retroactively identify the source of preexisting suspended rows; Admin restore fails closed for those rows and they need operator reconciliation. Other suspension writers and the broader erasure resource inventory remain under audit.

Refreshed the tracked tree and checklist after migration 0116 and its real-SQLite test were added. At code commit `b2899390`, the tree records 2,013 tracked files / 1,807 source or executable-configuration files; checklist totals are 439 reviewed and 1,368 open. The full file-by-file and runtime audit remains incomplete.

## Data-erasure resource coverage follow-up (2026-10-21)

The D1 migration inventory showed the erasure workflow removed KB/session rows but left dozens of other operational records, including space credentials, extension/provider configuration, notifications, integrations, scheduled jobs, access records, and tenant API credentials. Expanded space cleanup to 53 per-space operational tables in FK-safe order; it preserves financial ledgers and platform audit context. Added organization cleanup that removes org memberships/API credentials/notifications/push subscriptions, anonymizes org and SpaceType labels, detaches erased users from the org, and marks spaces deleted after cleanup. R2 cleanup now walks the tenant/space artifact prefix and script workspace prefix, deletes exact tenant-scoped conformance export objects, and continues to use bounded pagination and batches. Workflows received explicit artifact and script bucket bindings in dev, staging, and production.

Validation: full-migration SQLite erasure suite 3/3, workflow erasure/queue/provisioning tests 18/18, Workflows TypeScript, Wrangler TOML parsed with all required bucket bindings in all three environments, and `git diff --check`.

This is still a partial erasure implementation. There is no request producer or cancellation/restoration route; live Durable Object state, repository objects, browser artifacts, and some financial/content tables remain outside the cleanup. Financial retention and external-provider resource cleanup need explicit policy and service coverage before claiming organization-wide erasure. These gaps stay open in the audit plan.

## Internal tenant suspension gates (2026-10-21)

Continued the tenant-status pass across agent background work and notification delivery. Agent tick consumption now checks that both the space and its organization remain active before running scheduled jobs, connector polls, or project-steward reviews; external channel and attachment paths reviewed in this pass also bind the space to an active organization. Notifications now check tenant status before queued delivery and before synchronous `/internal/notify` email, push, or chat dispatch. Suspended or unknown tenants are dropped without egress, while a D1 failure on queued authorization retries rather than losing the delivery. Validation: Notifications focused suites 20/20 (queue idempotency, webhook egress, air-gap, web push, and interactive delivery); Notifications and Agents TypeScript; scheduled-job/dispatch/AgentMail suites 73/73; `git diff --check`.

This remains a scoped pass, not a global tenant authorization layer. Other workers' internal routes, queue consumers, durable-object alarms, workflows, and already-running operations still require review. The notification synchronous route continues to rely on the worker service-binding boundary for caller authentication; this pass enforces tenant activity after the asserted tenant header is provided. Inventory remains 2,008 tracked files and the file-by-file checklist remains 437 reviewed / 1,365 open at the last anchored inventory. The full codebase audit is not complete.

Follow-up queue review found that a suspended tenant's delayed space-provision message could still allocate and initialize resources: the provisioner checked only the space status and tenant ownership. Provisioning now requires an active organization in the same D1 lookup, so suspended or unknown tenants are treated as stale work and acknowledged without side effects; authorization lookup failures still flow to the queue retry handler. Deprovisioning remains available for cleanup. Validation: provisioner queue and tenant-suspension tests 5/5, Provisioner TypeScript, and `git diff --check`.

The same delayed-work review found KB ingestion jobs were launched without checking current tenant or space status, and an already-running ingestion workflow could continue writing chunks through signed internal Knowledge routes. The workflow queue now drops stale KB ingestion jobs before workflow creation and retries on a status database failure. Knowledge now requires an active tenant and active space on both public KB paths and every signed internal `/internal/spaces/:spaceId/kb/*` path, including each chunk call from a running workflow. Tests prove stale queue jobs do not start and suspended internal chunk calls write neither R2 nor Vectorize data. Validation: Knowledge suite 62/62, workflow queue suite 6/6, Knowledge and Workflows TypeScript, and `git diff --check`. An operation already past its active-space check can still race with a suspension during that individual request; broader cancellation of in-flight Workflows is a separate lifecycle gap.

Reviewing the workflow queue's separate `space.provision` path found its workflow validated a subscription but omitted organization suspension; its final update could also reactivate any non-active Space by ID alone. Eligibility now requires the matching active org, active/trialing subscription, and a Space still in `provisioning`; activation is an atomic conditional update requiring that same org to remain active. If suspension or space state wins the race, the workflow exits before publishing `space.provisioned`. Validation: workflow queue and activation guard tests 8/8, Workflows TypeScript, and `git diff --check`.

## Internal suspension gates across Agents (2026-10-21)

Continued the direct service-route audit beyond task dispatch. External agent approval creation/consumption could reach the Agent and HITL Durable Objects for a suspended tenant; document-node lease operations could mutate a coordinator for a tenant-owned Space without checking that the Space belonged to the signed tenant and remained active. The routes now validate active tenant/Space scope before invoking those Durable Objects. Business-email provisioning and per-run reply-address creation now also check organization status, closing their prior Space-only checks. Regression coverage proves suspended and cross-tenant scopes are rejected before DO/provider/database writes.

Validation: business-email route suite 26/26; Agents approval and scope suites 3/3; full Agents suite 156 files / 714 tests; Agents TypeScript and focused security lint passed. Commits `8c1df0da` and `f4a1b8a6` are pushed. The repository tree was refreshed to include the two new test files and now lists 2,026 tracked files / 1,820 source or executable-configuration files. The full audit remains open: other internal routes, queues, DO alarms and in-flight work still require tracing.

## OAuth lifecycle suspension rechecks (2026-10-21)

The credential-refresh gate did not cover consent flows already in progress. A provider callback could use a still-valid single-use ticket after tenant suspension to exchange authorization, save credentials, or register an MCP server. Built-in OAuth, custom OAuth, hosted provider-connect and Slack extension OAuth now check both tenant and Space activity when issuing tickets and again before callback side effects. Callback tickets are consumed even when suspension blocks completion, preventing later replay.

Validation: connector suites passed 50/50, including a regression proving a pre-suspension hosted-provider ticket makes no provider calls or MCP registrations after suspension. Full Agents suite passed 156 files / 714 tests; Agents TypeScript, security lint and `git diff --check` passed. The suspension audit remains open across remaining internal routes, queue/DO alarms, and already-running work.

## Provider consent authorization boundary (2026-10-21)

Review of connector OAuth start routes found that authenticated business members could request shared built-in OAuth or hosted provider consent, even though connecting an integration changes Space-wide provider/MCP state. Both routes now require owner/admin authority, resolving product-end-user membership through the Spaces Worker. A regression confirms an ordinary member is rejected before any Pipedream call or MCP registration.

Validation: built-in OAuth, custom OAuth, Composio, and Pipedream suites passed 51/51; the full Agents suite passed 156 files / 714 tests; Agents TypeScript, focused security lint and `git diff --check` passed. The broader audit remains open.

## Owner voice ticket suspension check (2026-10-21)

The owner voice-ticket route checked `spaces.status` but did not verify the parent organization. A suspended organization whose Space remained active could still mint a short-lived hosted voice ticket. It now uses the shared active tenant/Space gate before session lookup; the regression confirms it returns 403 without contacting the Spaces Worker.

Validation: owner voice route suite 5/5; full Agents suite 156 files / 714 tests; Agents TypeScript, focused security lint and `git diff --check` passed. Other tenant-scoped read/write routes remain under review.

## Agent restart and approval continuation gates (2026-10-21)

The direct HMAC-protected `/agents/:agentId/script/run` route could bypass the already-added task-run and trigger suspension checks. Interrupted-run continuation and HITL approval could also resume previously admitted work after suspension. All three dispatch paths now recheck the active organization and Space, and the asynchronous approval-resume helper repeats the check immediately before resuming its DO. Approval rejection remains available as a stop/cleanup action.

Validation: direct script HMAC, approval authority and continuation regressions passed 11/11; full Agents suite passed 156 files / 714 tests; Agents TypeScript, focused security lint and `git diff --check` passed. Queue alarms, long-running in-flight tool loops and other entrypoints remain in the open audit.

Refreshed the tracked repository tree after adding the continuation-route regression file. The tree now records 2,027 tracked files and 1,821 source or executable-configuration files at code commit `a621df58`; the scratch `work/` files and root Vitest reports remain untracked and excluded.

## Interactive agent dispatch suspension gates (2026-10-21)

The user-facing chat `/agent/run`, `/agent/mention-run`, and channel-session `/resume` entrypoints could still dispatch new work or reactivate bot responses after tenant suspension. They now check tenant and Space activity before session/roster work or Durable Object dispatch. Added a regression that exercises all three suspended paths and asserts no agent run is dispatched. The full Agents suite initially identified two fixtures that lacked a `PLATFORM_DB` binding; both now explicitly model an active tenant and preserve their original authorization/injection assertions.

Validation: focused chat/mention/resume regressions passed 34/34; session-scope and injection regressions passed 5/5; full Agents suite passed 156 files / 714 tests; Agents TypeScript and Biome security lint passed; `git diff --check` passed. No new tracked files were added, so the repository tree remains current at 2,027 tracked files / 1,821 source or executable-configuration files. Remaining suspension work includes already-running tool loops and complete queue/DO-alarm coverage; the repository audit remains open.

## Durable agent loop suspension checks (2026-10-21)

The worker ingress and workflow dispatch gates did not revoke work already admitted into a NaelaoAgentDO loop. The DO now rechecks active tenant/Space status through its configured D1 binding before run gates and at every script reasoning boundary, again after model reasoning, and immediately before invoking a tool. The legacy ReAct loop also rechecks before each inference iteration, after inference, and per tool dispatch. D1 lookup errors stop the run. Suspension exits as a terminal `tenant_suspended` failure rather than a resumable user cancellation. Added regressions for suspension before observation and suspension while model reasoning is in flight; both prove no tool invocation occurs.

Validation: focused loop regression 11/11; full Agents suite 156 files / 716 tests; Agents TypeScript, Biome security lint and `git diff --check` passed. No inventory refresh is needed because this batch adds no files. A provider side effect already executing at the instant of suspension cannot be safely interrupted; the next dispatch is blocked. Remaining audit work includes queue/DO alarms, direct Durable Object operation surfaces, and other workers. The full per-file audit remains incomplete.

## Durable workflow suspension revocation (2026-10-21)

`WorkflowRunDO.authorize()` refreshed actor, project and installation grants but `readWorkflowGrant()` did not check tenant or Space status. Long-lived workflow code could continue between steps after suspension. Grant refreshes now query the Agents Worker's configured D1 binding and reject inactive scopes; D1 errors fail closed. Owner status and cancellation remain available while suspended so an authorized operator can stop outstanding work. A regression suspends an initialized workflow and proves execution authorization fails, while a second proves owner cancellation remains available.

Validation: full Agents suite passed 156 files / 717 tests; updated workflow DO suite 7/7; Agents TypeScript and Biome security lint passed; `git diff --check` passed. No new files were added. The audit continues across alarm handlers, direct DO operations, and non-Agent workers.

## Local-machine authority suspension gate (2026-10-21)

The signed `/spaces/:spaceId/tunnel-authority` route forwarded machine authenticate, lookup, heartbeat and enrollment operations to SpaceDO after checking only the internal HMAC. A suspended tenant could therefore retain a live local-machine connection/grant. The Spaces Worker now verifies active org and Space status before every authority operation; stale machine heartbeats/requests fail before reaching SpaceDO. Added active and suspended regressions.

Validation: full Spaces suite passed 66 files / 257 tests; Spaces TypeScript and Biome security lint passed; `git diff --check` passed. The repository tree will be refreshed with this new regression file before commit. Suspension audit still needs review of other long-lived resource and alarm surfaces; the whole repository audit remains open.

## Tool sandbox suspension and reservation revocation (2026-10-21)

The authenticated ToolSandboxDO API accepted new execution and workspace operations without rechecking tenant/Space activity. Its alarm also kept an active container alive after suspension, and a suspension racing a billing reservation could leave a reserved budget or start a container later. Sandbox operations now check the active organization and Space in D1 (failing closed on D1 errors), including output/cancel and the final workspace publication boundary. The alarm aborts active work, destroys the container without snapshot/publication, and releases pending reservations. `ensureMeter()` checks status before reservation and again after the billing call to cover an in-flight reservation race. Added regressions for denied execution, suspended active execution, and reservation completion after suspension.

Validation: focused ToolSandboxDO suite passed 16/16; full Agents suite passed 156 files / 721 tests; Agents TypeScript and targeted Biome security rule checks passed; `git diff --check` passed. Full Biome style checks on these legacy files still report existing formatting/style diagnostics. No new tracked files were added; the source tree remains current at 2,028 tracked files / 1,822 source or executable-configuration files. The per-file audit remains open across queue/alarm and other worker surfaces.

## Gadget and dynamic page suspension gates (2026-10-21)

Gadget app routes and public dynamic pages treated any non-deleted Space as available and did not check the parent organization. This allowed suspended tenants to continue accessing app data, invoking extension gadget operations, viewing public pages, and submitting public actions. Gadget and project bridges now require both the Space and organization to be active; public page lookup and publishing use the same active-state gate. Added regressions that assert no Durable Object dispatch occurs for inactive tenants/Spaces.

Validation: focused gadget, extension-gadget, and dynamic-page suites passed 20/20; full Spaces suite passed 66 files / 260 tests; Spaces TypeScript, targeted Biome security rule checks, and `git diff --check` passed. No new tracked files were added; the tree remains current. Direct Durable Object and queued side-effect audit continues.

## Durable workflow launch and retry suspension races (2026-10-21)

Workflow authorization was checked before reserving budget, but suspension could race the reservation call and still allow provider create/restart. `WorkflowRunDO.launch()` and `retry()` now reauthorize immediately after reservation and release the reservation if the grant was revoked. A second check after provider creation terminates the workflow and marks the run failed if suspension raced startup; its first workflow step also remains independently guarded. Added race regressions for launch reservation, retry reservation, and suspension during provider creation.

Validation: workflow DO suite passed 10/10; full Agents suite passed 156 files / 724 tests; Agents TypeScript, targeted Biome security checks, and `git diff --check` passed. No new tracked files were added. Alarm and DO review continues; the full repository audit remains incomplete.

Follow-up: a suspension could also race the provider restart call after retry authorization. Retry now reconciles a failed restart without skipping the post-restart tenant check; if status changed during restart, it terminates the provider instance and marks the journal failed before cleanup. Regression covers suspension during restart. Workflow DO suite passed 11/11 and the full Agents suite passed 156 files / 725 tests; TypeScript, targeted Biome security checks, and `git diff --check` passed.

## Customer voice in-flight suspension revocation (2026-10-21)

CustomerVoiceAgent validated the number binding and network-egress policy, but an already connected call did not recheck the organization and Space before each model turn. A call could continue after suspension, and a model response that completed after suspension could still be spoken. Connection, call start, each turn, post-inference response, and TTS synthesis now require an active organization and Space. The voice websocket closes on a suspended turn. Added regressions for suspension before inference and during inference. The source stays unchecked in the exhaustive plan because its provider lifecycle and every call path still need review; the focused regression file is checked.

Validation: focused voice revocation tests passed 2/2; full Agents suite passed 157 files / 727 tests; Agents TypeScript, targeted Biome security checks, and `git diff --check` passed. Refreshed the tracked tree to 2,029 files / 1,823 source or executable-configuration files at `a58bd16c`; scratch files remain excluded. The audit remains open across other voice, queue, worker, and durable-object surfaces.

## Internal membership lookup revocation for suspended tenants (2026-10-21)

BrowserSessionDO relies on the internal Spaces `/members` endpoint to refresh membership before browser operations. That endpoint previously forwarded to SpaceDO without checking the owning Space or organization status, so an existing browser session could retain authority for a suspended tenant. The bridge now checks active Space and organization status in PLATFORM_DB before forwarding; status lookup errors fail closed. The existing browser authorization then closes revoked sessions. Added active and suspended bridge regressions.

Validation: full Spaces suite passed 67 files / 262 tests; Spaces TypeScript, targeted Biome security checks, and `git diff --check` passed. Refreshed the tracked tree to 2,030 files / 1,824 source or executable-configuration files at `6ff841ac`; scratch files remain excluded. The per-file audit continues across browser, scheduler, webhook, and other worker paths.

## Customer channel heartbeat suspension boundary (2026-10-21)

The scheduled and event-driven channel heartbeat had no direct tenant/Space status check at its Durable Object boundary. It could claim inbound messages after suspension, leave a whole batch stuck as in-progress if suspension raced the claim, and continue with billing or reply processing after an in-flight model/extension call returned. The heartbeat now checks the active tenant and Space before selecting work, after claiming, at each message boundary, immediately before rule/extension delivery effects, and after extension/reasoning work. A suspension releases all rows claimed by that batch; any extension dispatch still in its pre-delivery `running` state is marked failed with `tenant_suspended`. Added regressions for an already-suspended tenant and a suspension immediately after a two-message claim.

Validation: focused heartbeat suspension tests passed 2/2; full Agents suite passed 158 files / 729 tests; Agents TypeScript, focused Biome security lint, and `git diff --check` passed. The file-by-file audit remains open; this slice only completes the channel heartbeat boundary within `NaelaoAgentDO.ts`.

## Scheduled Memory OS maintenance dispatch (2026-10-21)

The hourly agent heartbeat sent `{spaceId}` to `/memory/maintenance`, while the Durable Object route required `tenantId`, `userId`, `sessionId`, and `callerRole`; the scheduled maintenance request therefore always returned 400 and its result was ignored. The queue now sends the tenant scope and an explicit space-maintenance intent. The DO has a separate scheduled-only path that performs the per-space decay/prune pass without pretending to be an interactive user, and checks active tenant/Space status before and after the pass. Interactive compaction still uses its caller identity and normal run gates. Added regressions for the scheduled path and suspended tenants.

Validation: focused maintenance route tests passed 2/2; full Agents suite passed 159 files / 731 tests; Agents TypeScript, focused Biome security lint, and `git diff --check` passed. The audit remains open across the rest of the queued tick variants and other workers.

## Project Steward tenant suspension gates (2026-10-21)

The scheduled Project Steward's internal installation and summary routes used `loadOwnedSpace`, which allows any non-deleted Space even when its organization or Space is suspended. A delayed tick could therefore provision the managed extension or read its portfolio summary after suspension. Both routes now require an active organization and active Space before accessing SpaceDO. Added a regression that verifies both suspended paths stop before Durable Object access.

Validation: focused Spaces test passed 1/1; full Spaces suite passed 68 files / 263 tests; Spaces TypeScript, targeted Biome security lint, and `git diff --check` passed. The broad audit remains open.

Follow-up: the same `loadOwnedSpace` status gap exposed `/internal/spaces/:spaceId/owner-contact`, which could return an owner's email to the scheduled digest worker after suspension. It now returns no contact unless both tenant and Space remain active. The Project Steward suspension regression also asserts owner-contact is withheld.

Validation: full Spaces suite passed 68 files / 263 tests after the owner-contact change; Spaces TypeScript, focused security lint, and `git diff --check` passed.

## Scheduled job queue tenant/Space binding (2026-10-21)

The scheduled-job consumer checked that the queue message's tenant and Space were active, then looked up the job by `id` alone. A malformed or mismatched internal queue message could validate one tenant's Space and dispatch a job belonging to another active tenant. The lookup now also binds `space_id` and `tenant_id` to the validated message scope. Added a regression asserting all three identifiers are present in the D1 lookup.

Validation: focused queue-scope test passed 1/1; full Agents suite passed 160 files / 732 tests; Agents TypeScript, focused Biome security lint, and `git diff --check` passed. The audit continues across queue variants and other worker surfaces.

Follow-up: signature-verified channel ingress also rechecks active tenant/Space status at the Agent Durable Object boundary before creating a session or storing an inbound message. This closes the race between the public webhook's status lookup and its DO dispatch. The updated channel suspension regression now covers ingress as well as heartbeat processing.

Validation: focused channel suspension tests passed 3/3; full Agents suite passed 160 files / 733 tests; Agents TypeScript, focused Biome security lint, and `git diff --check` passed.

## Connector poll cursor reliability (2026-10-21)

The connector-poll queue consumer advanced its saved `since` timestamp after every Agent DO response, including failed runs and suspension errors. That made the next poll skip records the agent had not processed. It now reads the bounded run response and advances the cursor only when the run reports success; non-2xx, unsuccessful, malformed, or oversized results leave the cursor untouched and retry through the queue. Added success and failure regressions.

Validation: focused cursor tests passed 2/2; full Agents suite passed 161 files / 735 tests; Agents TypeScript, focused Biome security lint, and `git diff --check` passed. The broader per-file audit remains open.

## Daily digest prerequisite handling (2026-10-21)

The queue advanced `last_digest_sent_at` before checking that notifications were configured or that the Space had an owner contact. A missing binding or contact therefore suppressed a digest for 24 hours without attempting delivery. The handler now checks notification wiring first, gathers contact and activity before claiming the day, and rechecks active tenant/Space status immediately before recording the send timestamp. Added regressions for missing notification binding and missing owner contact.

Validation: focused digest prerequisite tests passed 2/2; full Agents suite passed 162 files / 737 tests; Agents TypeScript, focused Biome security lint, and `git diff --check` passed. The queue and worker audit continues.

## Cloudflare email ingress suspension races (2026-10-21)

Cloudflare email ingress checked status once before parsing MIME, then could persist attachments and dispatch an Agent turn after a long parse or while an R2 upload was in flight. It now rechecks tenant/Space status after parsing, before attachment writes, after each R2 write (deleting the object if suspension landed), and before DO dispatch. Added regressions for suspension after parse and during an attachment upload.

Validation: focused email suspension tests passed 2/2; full Agents suite passed 163 files / 739 tests; Agents TypeScript, focused Biome security lint, and `git diff --check` passed. The repository-wide file audit remains incomplete and active.

## Channel heartbeat claim cleanup on setup faults (2026-10-21)

Channel heartbeat claims were released per-message, but an exception during shared setup (engine/config/pricing/policy/wallet preparation) occurs before that loop and could leave the whole claimed batch permanently stuck at `answered = 2`. The method now has a batch-level `finally` that releases any remaining in-flight claims on every return or exception. Added an injected setup-failure regression.

Validation: focused channel suspension/claim tests passed 4/4; full Agents suite passed 163 files / 740 tests; Agents TypeScript, focused Biome security lint, and `git diff --check` passed.

## Shared notification outbound tenant/Space authorization (2026-10-21)

The shared `/internal/notify` route checked organization status but trusted any supplied `space_id`; stale internal callers could still send email, web push, or chat messages for a suspended Space or a Space outside the header tenant. The route now validates that the supplied Space belongs to the active tenant and is active before any outbound branch. Added a regression proving an inactive/mismatched Space is rejected before provider fetch.

Validation: focused notification tests passed 11/11; full Notifications suite passed 5 files / 21 tests; Notifications TypeScript, targeted Biome security lint, and `git diff --check` passed. The audit continues across remaining service bindings and worker APIs.

## Trigger API and scheduled dispatch status/retry gates (2026-10-21)

Trigger listing exposed records for suspended Spaces, and update/delete could still mutate them. The minute scheduler selected every enabled schedule regardless of tenant/Space status, ignored non-2xx Agent responses, and advanced `last_run_at` even when dispatch failed. Listing and mutations now require an active tenant and Space; scheduled selection joins active tenant and Space rows; non-success Agent responses leave the trigger due for retry; and last-run updates bind trigger, tenant, Space, and enabled state. Added a scheduled-trigger regression proving the active-scope query and failed-dispatch retry behavior.

Validation: trigger regression passed 1/1; Triggers TypeScript, Biome lint, and `git diff --check` passed. Refreshed repository tree and file-by-file plan: 2,037 tracked files / 1,831 code and configuration files; 462 checklist rows reviewed. The exhaustive audit remains open.

## Knowledge internal workflow suspension and race checks (2026-10-21)

Correction after the full Knowledge suite: the worker already had active-tenant/Space verification in prefix middleware for `/internal/spaces/:spaceId/kb/*`; my initial route-level scan missed it, so the first pass added redundant reads. Those duplicate reads were removed. The actual race gap was long chunk ingestion continuing after embedding even if suspension occurred mid-request. Chunk ingestion now rechecks active ownership after embedding, before each chunk persistence step, and before Vectorize writes. Added regressions for suspended internal routes and a suspension that lands after the initial middleware check but before the first chunk write.

Validation: full Knowledge suite passed 10 files / 64 tests; Knowledge TypeScript, targeted Biome security lint, and `git diff --check` passed. Full repository lint includes existing diagnostics outside this change, so it was not used as a clean gate. The file-by-file audit remains in progress.

## Analytics metrics active-tenant gates (2026-10-21)

The Analytics space-metrics ownership check accepted suspended Spaces (`status != 'deleted'`), and tenant metrics trusted the tenant header without checking organization status. Both routes now require active status before reading the tenant-scoped cache or querying provider analytics. Added regressions asserting suspended space and tenant requests return not found before cache access.

Validation: focused Analytics suite passed 5/5; Analytics TypeScript, targeted Biome security lint, and `git diff --check` passed. Inventory remains 2,038 tracked files / 1,832 code and configuration files with 462 checklist rows reviewed. The audit remains active.

## Channel ingress size and suspension guards (2026-10-21)

Email and Slack ingress parsed unbounded JSON bodies, while their queue consumer accepts at most 100,000 content bytes and 16 KiB of metadata. Oversized but otherwise valid requests could therefore consume excess memory and then be silently dropped by the consumer. All channel paths now bound inbound JSON to 1 MiB and validate the exact queued content, end-user ID, and metadata limits before enqueueing. Channel listing, creation, deletion, and ingress also require active tenant/Space ownership, preventing suspended routes from being configured or queued. Added regressions for the 1 MiB body limit, queue payload limit, and suspended ingress.

Validation: focused Channels tests passed 2/2; Channels TypeScript, full targeted Biome lint, and `git diff --check` passed. Inventory refreshed; 2,038 tracked files / 1,832 code and configuration files, 462 checklist rows reviewed. The audit remains active.

## File checklist status after reviewed service slices (2026-10-21)

Marked the complete Triggers, Channels, and Analytics entrypoint/test files reviewed; the large Knowledge and Agent files remain unchecked because only specific paths were examined. The refreshed inventory contains 2,040 tracked files / 1,834 code and executable-configuration files, with 468 checklist files marked reviewed. These are scoped increments; the remaining file-by-file audit and runtime stress coverage are still open.

## Remove unreachable legacy Channels worker (2026-10-21)

Triple-checked the legacy `workers/channels` surface against tracked callers, worker deployment config, and the schema/deployment graph. No router route, service binding, or code caller referenced it; its Wrangler config set `workers_dev = false` and declared no route; and no migration created the `channels` table its API queries. Current channel entrypoints are routed through the Agents worker. Removed the unreachable worker, its worker-specific tenant-guard test, stale lockfile importer, and active architecture/inventory references. The historical generated HTML snapshot is retained. The repo cannot prove whether an external Cloudflare account has an untracked manual binding, so external deployment inventory remains a verification item.

Validation: Channels tests passed 2/2 before removal; the five-worker regression pass passed Channels, Triggers, Analytics, and Notifications, and initially found three stale Knowledge expectations, corrected and followed by a full Knowledge pass (10 files / 64 tests). Inventory now lists 2,034 tracked files / 1,828 source and executable configuration files with 465 checklist entries reviewed. The audit remains incomplete.

## Gumroad MCP shim request and path bounds (2026-10-21)

The managed connector built product URLs from model-supplied IDs. `encodeURIComponent` leaves dot segments intact, so `../../user` could escape `/products/:id` and invoke another Gumroad GET endpoint with the user's token. IDs now require a bounded alphanumeric/underscore/hyphen format. MCP requests are capped at 64 KiB, and provider fetches reject redirects and have a 15-second timeout. Added tests for traversal rejection, oversized input, redirect policy, and outbound deadline configuration.

Validation: Gumroad shim suite passed 1 file / 2 tests; TypeScript and targeted-file Biome lint passed; `git diff --check` passed. Refreshed the source checklist; this connector entrypoint is checked after reviewing its MCP/HMAC path and outbound request construction. External live provider calls remain deployment-level validation. The broader audit continues.

## Whop MCP shim request, path, and write bounds (2026-10-21)

The Whop connector interpolated model-supplied membership IDs into REST paths; `encodeURIComponent` does not encode dot segments. It also accepted unbounded JSON-RPC bodies, had no provider deadline or redirect rejection, and permitted empty or oversized direct-message/announcement writes. Membership and write target IDs now require bounded safe segments, write text is nonempty and size-capped, MCP requests are limited to 64 KiB, and provider requests reject redirects and time out after 15 seconds. Added regression coverage for path traversal, invalid writes, request bounds, and fetch controls.

Validation: Whop shim suite passed 1 file / 2 tests; TypeScript, targeted-file Biome lint, and `git diff --check` passed. Inventory refreshed; the file-by-file audit remains open.

## Credential resolution and outbound suspension checks (2026-10-21)

The Credentials worker's short-lived credential token scoped tenant and Space but did not independently check whether either remained active. A stale internal caller could still resolve plaintext or reach the final credential-bearing egress route after suspension. Both plaintext resolution and outbound egress now require an active tenant and Space before reading credentials; outbound egress repeats the check before every provider fetch/redirect hop. If suspension lands after a write receipt is claimed but before dispatch, the action is finalized as failed without sending the request. Outbound requests also have a 30-second deadline; timed-out writes retain the existing unknown-outcome/no-automatic-retry behavior. Added regressions for suspended plaintext and egress.

Validation: full Credentials suite passed 3 files / 11 tests; TypeScript, targeted Biome security lint, and `git diff --check` passed. The large credentials implementation file remains unchecked in the file-by-file plan; only its internal credential/egress paths were reviewed in this slice.

## Evaluation worker bounds, ownership, and result retention (2026-10-21)

The Eval worker accepted unbounded JSON bodies, did not validate individual case sizes, and could create suites for unknown, suspended, or cross-tenant Spaces. Suite writes now enforce a 1 MiB request cap, bounded case/name fields, and active tenant/Space ownership. Listing and result queries exclude inactive Spaces and tenants; run and trace calls reject malformed inputs, and trace retrieval has a 10-second deadline, encoded path segments, and a 2 MiB response cap. Successful agent answers now persist in `eval_results.actual_output`, which was previously always null. Added six route regressions for the ingress ceiling, case validation, active ownership, malformed run JSON, successful suite creation, and answer persistence.

Validation: Eval regressions passed 6/6; Eval TypeScript, targeted Biome lint, and `git diff --check` passed. The Eval entrypoint and test are checked in the file plan; other Eval files and deployment-level live model behavior remain open.

Follow-up trace-grader review found that malformed stored check data could throw during scoring, the retry check counted same-name calls with different parameters as duplicates, and user regex patterns were run synchronously without a work guard. Checks and trace steps now get runtime schema validation, repeated calls use canonicalized parameters, trace processing is capped at 10,000 steps, and common nested-quantifier/backreference patterns fail closed. Added five deterministic grader tests. Validation: combined Eval route/grader suite 11/11, TypeScript, Biome lint, and `git diff --check` passed; the trace grader and test are checked.

Package-level audit found Eval had no `test` script or Vitest dependency, so Turbo did not include its regressions. Added `vitest run` and the existing workspace Vitest version to the package manifest and lockfile. Confirmed both Eval test files run from the package root (11/11).

## Retire the unconnected Feedback worker (2026-10-21)

Triple-checked `workers/feedback` as an unreachable partial worker: no router route or service binding references it; its Wrangler config disables `workers_dev` and declares no route; staging and production deploy lists omit it; no migration creates the `message_feedback` table its handlers query; and the repo has no callers or tests. Its route paths also used `/v1`, unlike the router's strip-prefix proxy convention. Removed the four worker files, workspace lock importer, stale file-tree/Repomix/surface-inventory entries, and refreshed the repo tree and file checklist. Historical architecture snapshots were retained. This feedback capability was not wired into the current product; implementing it as a working feature would require a schema, authenticated Space/session/message ownership checks, router binding, deployment configuration, and product UI/API integration.

## Retire the unconnected Search worker (2026-10-21)

Triple-checked `workers/search`: there is no router service binding, route, source caller, or staging/production deploy entry; its Wrangler config has `workers_dev = false`; no Terraform or migration provisions its `SPACETYPES_VECTORS`/D1 search data; and no D1 migration creates the `space_types` table used by its handlers. The only `space_types` table is local to `SpaceTypeRegistryDO`, a separate SQLite store. Removed the isolated worker, stale lockfile and Repomix inputs, and active architecture/surface references. The existing marketplace `search.ts` implementation remains. The old search worker's intended SpaceType index/search capability was unreachable and remains an implementation gap if product search is required.

## Retire the disconnected Together AI proxy (2026-10-21)

The Together AI Worker had no router/service binding, runtime source caller, deployment workflow entry, own route, or platform resource configuration. `workers_dev = false` and its manifest declared no route; the only `/chat` handler was therefore unreachable through repository-managed ingress. Its implementation was an unmetered direct provider proxy, while current agent inference uses the shared AI Gateway. Removed this obsolete provider path, tests, workspace importer, active deployment-secret/build/tree/surface references, and stale Repomix inputs; historical build-plan archives remain. External manual Cloudflare routing cannot be established from repository files and is outside this repo audit.

## Complete staging and production worker deployment coverage (2026-10-21)

Manifest-to-workflow comparison found that both deployment workflows omitted multiple live worker manifests, including `provisioner`, `credentials`, `triggers`, `sweeper`, `synthetics`, and `portal-router`. Added every remaining manifest-backed worker to the staging/production deployment lists and removed the stale `channels` entry. Added a regression that compares each workflow's explicit/loop worker set against all `workers/*/wrangler.toml` manifests, so future additions and deletions stay synchronized.

Validation: deployment coverage tests passed 2/2; both workflow YAML files parse; the staging shell loop passes `bash -n`; targeted Biome lint and `git diff --check` passed. The actual Cloudflare deployments remain environment-level operations.

## Portal Router domain management and storefront boundary (2026-10-21)

Reviewed the Portal Router source, manifest/type configuration, service-binding deployment configuration, Router forwarding/auth path, and storefront request tests. The domain API trusted caller-set tenant headers, queried an uncreated `space_domains` table, accepted unbounded JSON, and could map an unverified hostname. Storefront resolution served `pending_dns` records, and product portal subdomains matched the first label on unrelated hostnames.

Portal domain management now requires a valid internal HMAC and a Router owner/admin role, caps request bodies, validates hostname labels, checks active tenant/Space ownership, and requires custom domains to have an active verified `business_services` record. Atomic ownership reservations and routing now use a D1 `portal_domains` table with a unique `(kind, hostname)` key; this closes the simultaneous KV claim race and avoids eventually consistent routing. Tenant mapping listing uses bounded cursor pagination. The new migration is required and schema-checked in staging and production deploy workflows. Portal requests require active tenant/Space state; subdomain resolution only accepts one-label hosts under `.naelao.app`. Storefront content and checkout are tenant-bound and active-gated; checkout input/response sizes are bounded, redirect targets must be credential-free HTTPS URLs, and `workers_dev` is disabled.

Added regressions for forged headers, reserved names, active ownership, verified custom-hostname requirement, atomic cross-tenant reservation conflict, D1 listing, inactive records, unrelated-host subdomain matching, invalid checkout redirects, oversized checkout input, and rendered header structure. Router domain forwarding tests require owner/admin and verify signed identity forwarding.

Validation: focused Portal Router tests passed 16/16; Router domain tests passed 2/2; Router/Portal TypeScript checks, scoped Biome lint, the migration's SQLite uniqueness check, binding parity, and `git diff --check` passed. Staging Wrangler dry runs passed for both workers and showed the service binding. No deployed Cloudflare routing or live custom-host verification was exercised. Confirm the deployed Cloudflare for SaaS custom-hostname route points verified portal hostnames at this worker and validate DNS/SSL ownership in a real staging account. The broader repository audit remains open.

## Synthetic Monitoring storage, retention, and alert transitions (2026-10-21)

The scheduled worker inserted into `synthetic_results`, but repository migrations never created the table; every database write failed and was silently ignored. Added migration `0120_synthetics_storage.sql` for result history and persistent alert state, with a timestamp index. Staging and production deploy workflows now apply the migration as a required step and verify the schema. Results older than 30 days are pruned on each cycle. The old in-app alert path had no producer queue binding and omitted the required recipient ID, so the Notifications worker discarded every alert. Failures now create one idempotent row in the existing `platform_failures` table, visible in the platform-admin failure dashboard; recovery allows a later outage to create a new row. Repeated cycles retry the same primary key after transient D1 errors, avoiding duplicate operator alerts. Network error text and failure details are bounded.

Added tests for recording and operator failure events, repeated failure deduplication, recovery/new-failure transitions, D1 outages, bounded error details, and the two fixed probe targets. Worker tests passed 4/4, TypeScript and scoped lint passed, and the migration ran against SQLite successfully. Production Wrangler dry run passed with the D1 binding. Staging disables the cron. A live scheduled execution and admin dashboard observation have not been exercised. The full worker audit remains open.

## Retire the disconnected Mini-AGI worker (2026-10-21)

Triple-checked the standalone worker's reachability: `workers_dev` is disabled; its Wrangler manifest declares no route; Router has no service binding or `/agi/runs` route; no app/package calls its API; and the deployment entries were the only runtime wiring. Its `SESSIONS_QUEUE` binding was never used, and its child-agent dispatch attempted session creation on the Agents worker, which does not own that endpoint. The package had no tests, and its create-run SQL omitted the `goal` bind parameter. The current Agents runtime already owns scoped planning, project-worker delegation, and subagent workflows, so this duplicate prototype was removed from the workspace, deployments, conformance file list, and active repository/surface documentation. The historical `0028_agi_runs.sql` migration remains intact to preserve deployed data and migration history. The old hierarchical run API is no longer deployed; current planner/delegation capability is through Agents. `git grep` and Router/Wrangler/deploy graph checks found no remaining runtime callers. The full repository audit remains open.

## Retire the disconnected Triggers worker (2026-10-21)

Triple-checked the worker graph: it had `workers_dev = false`, no Wrangler route, no Router binding or `/v1/triggers` proxy route, and its deployment list was its only ingress-like wiring. Migration `0073_project_scoped_automation.sql` deletes the old `triggers` rows before rebuilding the table; there are no other source writers. Its cron therefore queried an empty table, while event definitions are managed through the Spaces worker and time-based `scheduled_jobs` are dispatched by Agents. The worker's REST path also offered `trigger_type = event` creation although its cron query only fires `schedule` rows. Removed the duplicate worker, its unused workspace importer, deployment entries, Repomix source input, and active inventory/docs references. Kept migrations `0011_triggers.sql` and `0073_project_scoped_automation.sql` as immutable history. The shared `naelao-channel-sessions` queue remains because Agents, Threads, and Spaces use it. Regression checks cover deployment manifest parity and the existing Agents `space_trigger` consumer. The full repository audit remains open.

## Remove unconsumed SpaceType workflow and quota declarations (2026-10-21)

Provisioner wrote `workflow-template:{spaceId}:{id}` values and removed them on rollback, but no worker or app read that key prefix. Launchpad's `workflowTemplates` and `cronJobs` declarations were likewise only validated and never provisioned. Separately, all six `resourceBudget` values were required and range-checked but had no runtime enforcement path. Removed those dead fields and the workflow-template KV write/rollback; SpaceType registration no longer requires a fictitious quota declaration. Existing scheduled agent definitions still go through `scheduled_jobs`, and event triggers remain managed by Spaces. Added a registry regression for registration without `resourceBudget` and updated product manifest fixtures.

Validation: Provisioner manifest tests passed 10/10; SpaceType registry tests passed 2/2; root product manifest/wizard tests passed 37/37; Spaces and Provisioner TypeScript checks passed; `git diff --check` passed. Biome check on the touched legacy files reports existing formatting/style diagnostics; no broad formatting was applied. The audit plan now tracks real quota enforcement as an open product gap. The Provisioner entrypoint was only reviewed for the removed provision/rollback paths and remains unchecked overall.

## Require successful registry writes before activating a Space (2026-10-21)

Provisioner previously logged and ignored failures from the root SpaceDO registry seed, then continued to activate the Space; it also ignored the SpaceType install-record response. Either failure could leave a live Space without its required hierarchy metadata or install accounting. Both calls now fail provisioning and enter rollback when their response is non-success. Added integration-level tests that inject a 503 at each route and assert the Space is marked `error` without reaching activation. Existing root creation and successful queue paths remain unchanged.

Validation: full Provisioner suite passed 43/43, and Spaces and Provisioner TypeScript checks passed. The route regression tests passed for both failure points. `workers/provisioner/src/index.ts` remains unchecked overall; this review covered only the critical registry response paths. Deprovision remains an open contract: no producer sends it, while its current handler does not purge the DO/D1 state and must not be wired to soft-delete routes without a retention decision.

## Provisioner queue contract and retry audit (2026-10-21)

Reviewed the bounded queue payload validator, poison-message acknowledgement, retry-on-handler-failure behavior, Wrangler batch/retry settings, and both `PROVISION_QUEUE.send` callsites. The senders produce compatible required fields; the validator rejects malformed IDs, header controls, and oversized template arrays before side effects. Tests cover malformed-message acknowledgement and retry behavior. Found a separate duplicate-delivery race: concurrent queue attempts can both claim a Space because `status='provisioning'` is accepted by both the preflight and update predicate. Added this as an open finding requiring a recoverable per-Space lease and concurrent/crash-retry tests; a non-expiring lock or a condition that merely skips active status would lose valid retries. The queue contracts and state predicate files are checked; `index.ts` remains only scoped-reviewed.

After the manifest contract update, the complete Spaces worker suite passed 68 test files / 263 tests, and its TypeScript project check passed. This refreshes the earlier suite count and covers the active registry and creation paths; it does not close the full Spaces file-by-file audit.

## Reconcile source tree and platform worker inventory (2026-10-21)

Refreshed the tracked repository tree and file checklist after the Provisioner test additions and worker retirements: 2,021 tracked files, 1,815 source/executable-config files, and 484 scoped checks retained. Reconciled the platform inventory's Wrangler manifest count from 28 to the 26 manifests found in `workers/*/wrangler.toml`. Durable Object count remains 22. The inventory remains a discovery index; route counts and dynamic dispatch still require full tracing.

## Notifications worker API reachability and request limits (2026-10-21)

The Notifications worker duplicated `GET /notifications` and `PATCH /notifications/:id/read` using columns absent from migration `0010_notifications.sql`. Repository-wide caller and Wrangler binding review found no route to those handlers: the shell calls `/v1/spaces/:spaceId/notifications`, Router forwards that path to Spaces, and the live SpaceDO implementation uses the correct inbox store and `read_at` behavior. Removed the dead duplicate handlers and their stale surface-inventory entries. The synchronous `/internal/notify` service route also parsed an unbounded request body and let malformed JSON become a server error. It now rejects bodies over 256 KiB with 413 and invalid JSON/non-object payloads with 400 before any provider send; regression coverage checks both cases and no egress.

Validation: Notifications worker suite passed 22/22; Notifications TypeScript check passed; live SpaceDO notification route tests passed 11/11; `git diff --check` passed. The full Notifications entrypoint remains unchecked; review here covered notification API reachability and notify ingress parsing.

## Browser push endpoint and subscription stress pass (2026-10-21)

The push subscription cap used a `COUNT` followed by a separate insert, so concurrent enrollment requests could all observe fewer than 20 devices and exceed the per-user limit. Replaced this with one conditional `INSERT ... SELECT ... ON CONFLICT` statement, which serializes cap enforcement at the database write; refreshing an existing endpoint remains allowed at capacity. Push subscription endpoints now require exact known provider hosts (rather than arbitrary subdomains), key material shapes are checked, and expiration timestamps must be finite non-negative numbers. Both Spaces forwarding and Notifications handlers cap push request bodies at 16 KiB and reject malformed JSON before forwarding/storage.

Added a real SQLite-backed concurrency test: 21 parallel distinct subscriptions yield exactly 20 stored rows and one 429; a same-endpoint refresh succeeds at capacity. Oversized/malformed input, subdomain host rejection, invalid expiration, and invalid keys are covered. Notifications tests passed 22/22, the SQLite-backed cap tests passed 2/2, Notifications and Spaces TypeScript checks passed, and Biome lint passed for `web-push.ts`. The two Web Push implementation files are checked; `workers/notifications/src/index.ts` remains only scoped-reviewed.

## Credential sharing authorization fail-closed pass (2026-10-21)

The Credentials hierarchy route tests were stale: they omitted active tenant and Space rows, so they did not exercise the worker's current authorization boundary. Updated the fixture to use the active hierarchy and tested the real routes. Persisted `shared_with_user_ids` parsing previously treated malformed JSON as a match for every caller; corrupt or invalid data now fails closed and remains visible as an empty list in metadata responses. Credential creation validates the list (maximum 100 unique, bounded, control-free IDs). PATCH now requires an explicit sharing value, preventing `{}` from converting a selectively shared secret to SQL `NULL` (shared with everyone); JSON `null` and arrays are rejected as request objects.

Added route regressions for malformed stored JSON, empty PATCH access widening, too many users, duplicate IDs, and create-body coercions. The create route now requires a non-empty string name/value, bounded string description, boolean `is_override`, and string project ID; this prevents JSON objects being coerced into persisted secret values and `"false"` becoming a truthy override. Credentials worker tests passed 11/11, `tsc --noEmit` passed, and the root SQLite-backed hierarchy suite passed 41/41. `git diff --check` passed. Biome reports existing formatting/import-order diagnostics in the large root hierarchy test file; no broad reformat was applied. The source row `workers/credentials/src/index.ts` remains unchecked overall; plaintext credential resolution, outbound proxying, token validation, and other routes still require a full-file review.

## Notifications to Credentials token interoperability (2026-10-21)

Tracing `resolveChannelCredential` from Notifications through the Credentials plaintext endpoint found that it sent `x-naelao-internal-token`, while the endpoint requires `x-naelao-credential-token`. Every per-Space channel secret lookup therefore returned unauthorized and the caller silently fell through as though no credential were configured. Notifications now signs a short-lived tenant/Space-scoped v3 token using the Credentials worker contract. Regressions verify that the generic token header is absent and cryptographically validate the credential token for both Meta transport selection and extension channel delivery.

Notifications interactive tests passed 10/10, Notifications `tsc --noEmit` passed, and `git diff --check` passed. Biome on the large Notifications entrypoint/test reports existing style diagnostics; no broad formatting was applied. Both files remain unchecked overall; this pass covers only the channel credential resolution integration.

## Provisioner duplicate-delivery lease (2026-10-21)

Queue consumers can run up to 10 concurrent batches, and the previous Space status update allowed every delivery that observed `provisioning` to enter the saga. Added `space_provisioning_leases` with a conditional SQLite upsert keyed by Space, tenant binding, an owner token, and a 30-minute expiry. Provisioning rechecks status after acquiring the lease, releases the claim after success or rollback, and only the matching owner can release it. A duplicate queue delivery retries after the lease expiry instead of acknowledging a busy Space; an expired claim can be recovered after a hard Worker termination. Staging and production deploy workflows now explicitly apply and verify migration 0121.

Added SQLite-backed concurrency, tenant mismatch, expiration/recovery, and owner-only release tests, plus delayed duplicate-retry coverage. Provisioner tests passed 44/44, lease tests passed 3/3, Provisioner TypeScript passed, the staging Wrangler dry run passed with the D1 binding, the migration executed in SQLite, and `git diff --check` passed. No deployed D1 race or forced Worker termination was exercised. The 30-minute lease assumes queue invocations terminate before expiry; the full Provisioner entrypoint remains unchecked. The new migration, lease helper, and lease test are checked in the plan.

Refreshed the tracked tree after code commit `b20dacbf`: 2,025 tracked files and 1,818 source/config checklist rows; 490 rows are checked and 1,328 remain open. Untracked work reports and scratch configurations are excluded.

## Vault egress DLP coverage across URL and headers (2026-10-21)

The final Credentials egress boundary applied DLP only to the HTTP body; sensitive values in query strings or caller-controlled headers could bypass the block policy. The Credentials worker now scans the complete outbound envelope (URL, headers, Basic-auth username, and body) before credential decryption and upstream fetch. Added regressions proving an SSN in either the URL query or a custom header returns 403 without an upstream request. The existing Vault integration fixture also lacked the current active `orgs`/tenant schema, causing its outbound tests to fail before reaching the implementation; updated it to exercise the real tenant/Space gate.

The Vault contract suite passed 5/5, Credentials TypeScript passed, and `git diff --check` passed. Biome still reports existing whole-file diagnostics in the legacy Credentials entrypoint and Vault integration test; no broad formatting was applied. The Vault test file is checked; Credentials `index.ts` remains unchecked as a full source file. Checklist coverage is now 491/1,818 source/config files (1,327 still open).

## Product-root credential inheritance suspension gate (2026-10-21)

Credential resolution checked that the requesting Space was active but fetched its parent product's shared credential without checking the product root's tenant or status. A suspended/deleted root could therefore keep supplying secrets to an active child. Product fallback now requires the active child and an active same-tenant root before loading the root credential. The regression suspends the product root and confirms its secret is no longer returned to the active business child.

Credential hierarchy tests passed 42/42, Credentials TypeScript passed, and `git diff --check` passed. The Credentials entrypoint remains unchecked overall; this closes only the product-fallback status path.

## Notifications provider response and deadline limits (2026-10-21)

Slack and Telegram success responses were parsed with unbounded `response.json()`. Replaced these with a 16 KiB streaming JSON reader. The first stress test exposed that parsing a clone and canceling the oversized tee branch can hang while the original branch remains open; the handlers now consume the response directly. Added 8-second deadlines to Slack, Discord, and Twilio sends, and 8-second APNs / 15-second Resend deadlines; Telegram and WhatsApp use the shared 8-second channel limit.

Regressions send oversized `ok: true` Slack and Telegram responses and assert the notification is rejected, the provider request carries an abort signal, and Resend also receives a deadline. Notifications tests passed 24/24, TypeScript passed, and `git diff --check` passed. No live provider timeout or response was exercised. The Notifications entrypoint and test file remain unchecked overall.

The same Notifications pass found that `sendChatMessage` returned raw fetch exception messages. A provider error can include its request URL, which contains Telegram's bot token. The route now returns only a generic channel failure; a regression injects a token-bearing exception and verifies the response does not contain the token. The full Notifications suite passed 25/25 after this fix, and TypeScript passed.

## Notifications webhook and provider log redaction (2026-10-21)

Queue logging included webhook URLs verbatim on SSRF rejection and delivery failure. These URLs can contain shared secrets in their path or query. APNs, browser-push, and queue-level provider exceptions were also logged with raw error messages; Resend failure handling logged provider response text and email recipients. Logs now retain only safe status/error-class data and no endpoint, recipient, or provider exception body. Added blocked-webhook and failed-delivery regressions with secret-bearing URLs.

The full Notifications suite passed 26/26, TypeScript passed, and `git diff --check` passed. The worker entrypoint and webhook test remain unchecked overall; the reviewed log paths are a scoped pass.

## Notifications queue batch runtime bound (2026-10-21)

The Notifications queue processes messages serially, and external provider operations can wait up to 15 seconds. A 100-message batch could therefore occupy a consumer invocation for roughly 25 minutes before database and application overhead, creating a timeout and retry risk. Reduced `max_batch_size` to 10 in development, staging, and production, bounding the provider-wait portion to about 150 seconds per batch. Added a regression that checks all three consumer blocks retain this bound and their retry/timeout settings.

Notifications tests passed 27/27 after the new config regression, the focused config test passed 1/1, Notifications TypeScript passed, Wrangler dry runs passed for development, staging, and production, and `git diff --check` passed. The first TypeScript check found a mismatch between the test's DOM `URL` and installed Node URL types; the test now uses the package working directory. Throughput under deployed queue load and provider throttling remain unmeasured; the existing maximum consumer concurrency is 50.

Refreshed the repository tree and source checklist after adding the queue-config regression: 2,026 tracked files / 1,820 source or executable-configuration files; 493 checks recorded and 1,327 source/config files remain open. The inventory reconciliation also found that the already exercised SQLite push-subscription cap test was missing from the checklist; added it as checked based on its existing 2/2 execution recorded in the prior Web Push audit.

## Agents long-running tick queue isolation (2026-10-21)

The Agents queue handles hourly ticks for connector polling, scheduled jobs, project reviews, and channel heartbeats. Each batch is processed serially, and some messages can call an Agent DO to run a planner or perform multiple network-bound steps. A configured batch size of 100 therefore creates head-of-line delay and can keep a queue invocation occupied long enough to hit duration limits. Set the agent-ticks consumer batch size to one in development, staging, and production; its existing concurrency of 50 retains parallel dispatch while isolating long-running messages. Channel-session messages were already configured as single-message batches.

The queue-config regression passed 1/1, Agents TypeScript passed, `git diff --check` passed, and Wrangler dry runs passed for development, staging, and production, including all three configured container builds in each environment. Actual queue load, planner runtime distribution, and provider throttling were not exercised. Refreshed the tracked tree and checklist: 2,027 tracked / 1,821 source-config files; 494 checks recorded and 1,327 remain open.

## Tenant erasure cleanup inventory correction (2026-10-21)

Tracing the 24-hour owner-requested erasure path found tenant-scoped data outside the explicit cleanup: `portal_domains` hostname claims, `idempotency_keys` request hashes/responses, `eval_results` inputs and outputs, and `space_provisioning_leases`. The retryable GDPR outbox also retained the request payload, including the requesting user ID and free-text reason, after dispatch. Erasure now deletes these rows by tenant, including the outbox row once destructive cleanup begins. Further schema review found tenant-owned marketplace reviews/forks, listing author and evaluation metadata, developer payout destination/profile data, and reseller relationships. Erasure now deletes tenant reviews/forks and developer profiles, archives and redacts marketplace listings while retaining purchase-linked listing rows, and terminates reseller links while clearing the erased child's owner ID. Financial ledgers and purchase records remain retained for accounting and need a documented retention policy. Updated the workflow header comment, which incorrectly still claimed the cancellation/restoration path was unwired and described R2 cleanup as intent-only.

Extended the real SQLite migration test with tenant operational, marketplace, and reseller records. Its first run caught that the generic space-scope classifier also needed to classify `portal_domains` and `space_provisioning_leases` as separately handled. Added a migration-driven classifier for every tenant-scoped table and asserted that marketplace purchase/overpayment records remain for accounting while public listing data is redacted; the root erasure suite passed 6/6. A retry review also found random IDs on audit rows inside retryable Workflow steps; request and completion audit IDs now derive from the validated request ID so `INSERT OR IGNORE` makes a retried D1 write idempotent. Workflows erasure cleanup and queue suites passed 21/21, Workflows TypeScript passed, and `git diff --check` passed. Single-Space runtime and retained audit/financial record policy still need review; the Workflow entrypoint remains unchecked overall.

The erasure step itself held every Space in one Workflow operation, so a tenant with many spaces could exceed a step's runtime and replay all completed resource deletions after a late failure. Split tenant enumeration into durable page-list steps and one durable cleanup step per Space. Replay and injected failure tests cover 205 spaces, verify completed steps are not rerun, and verify only the failed Space retries. Workflows erasure and queue tests now pass 23/23, TypeScript passes, and Wrangler dry runs pass for development, staging, and production. A very large single Space can still exceed one cleanup step because its document, Vectorize, R2, and provider resources are processed inside that Space step; per-document/resource checkpointing remains open.

## System One routing and context-bound verification (2026-10-21)

Reviewed the decision client against the active model-routing correction and the checked-in provider research. Ordinary decisions use `cloudflare/clef-flash` through OpenRouter's Decisions API; `perplexity/pplx-decider-v1.2` is the only overflow model, and the Decider Flash slug resolves to Clef Flash. The 16,000 estimated-token Clef threshold stays below the documented 24,576 context, and full Decider is capped at 200,000 estimated tokens. The client bounds retries, total request time, and response bytes, validates typed outputs, and rejects unknown models. Focused tests passed 25/25 and Agent SDK TypeScript passed. A live OpenRouter metadata check was blocked by the workspace's outbound proxy (HTTP 403), so current provider metadata was not independently refreshed. No routing change was needed.

## Provisioner saga queue isolation (2026-10-21)

The Provisioner queue serially runs up to ten messages per batch, while each provisioning or deprovisioning saga can make many service-binding, D1, KV, and R2 calls. Reduced the consumer batch size to one in development, staging, and production while retaining its concurrency of ten. This prevents one slow saga from holding later messages in the same batch.

The config regression passed 1/1, Provisioner TypeScript passed, and Wrangler dry runs passed in all three environments. Actual queue backlog, end-to-end saga latency, and external rate limiting remain unmeasured. Refreshed inventory: 2,028 tracked files / 1,822 source-config rows, 495 checks recorded and 1,327 remain open.

## Conversation history partial-page recovery (2026-10-21)

Rechecked the compaction-to-search path, current-thread authorization, transcript paging, bounded excerpt processing, and the default assistant/delegated conversation research tool surfaces. Search already pages up to 10,000 messages / 16 MiB per call and exposes older-page cursors. A later transcript service error, however, discarded matches from pages already read and removed the continuation cursor. It now returns those evidence-backed matches as explicitly incomplete, includes the service error and scanned count, and preserves the cursor for continuing older history. Queries containing only stop words now fail before transcript I/O instead of returning a misleading “not discussed” result.

Validation: conversation prebuilt tests passed 19/19, including the new partial-result/cursor and empty-query cases; compaction, virtual CLI, and skill-role targeting suites passed 21/21; Agents TypeScript passed; `git diff --check` passed. This remains mocked/local coverage: channel Durable Object SQL limits, persistence/restart behavior, and provider outages under deployed load remain unexercised. The repository inventory remains 2,028 tracked files / 1,822 source or executable-configuration files; 495 reviewed and 1,327 source/config files remain open.

## Credentials worker vault and egress boundary (2026-10-21)

Audited the Credentials worker's HMAC-gated metadata routes, signed plaintext-resolution tokens, credential tier selection, authenticated ciphertext AAD and per-Space DEK wrapping, key-version rotation, and outbound network proxy. The outbound proxy rebuilt the redacted response while preserving stale content length, digest, validator, and range headers; it also supplied an empty body for bodyless 204/205/304 statuses, which can throw during Response construction. Added `buildOutboundResponse()` to strip representation metadata invalidated by redaction and preserve null bodies for those statuses. Existing host authorization, manual redirect checks, suspension checks, write idempotency receipts, response-byte limits, and secret redaction were exercised through focused tests.

Validation: Credentials worker unit suites passed 12/12, migration-backed credential hierarchy and root vault/egress suites passed 55/55, Credentials TypeScript passed, Wrangler development dry run passed, and `git diff --check` passed. No live Workers/D1/egress provider behavior was exercised; DNS rebinding at fetch connection time remains the separately recorded controlled-egress-proxy gap. Marked five Credentials source/config checklist files complete from this scoped review; inventory now records 2,028 tracked / 1,822 source-config files, 500 checked and 1,322 open.

## RepositoryDO workspace reconciliation bounds (2026-10-21)

Audited the RepositoryDO scope routing, serialized state gate, SQLite/legacy state persistence, Git object verification, workspace publication journal/replay, and R2 reconciliation path. Reconciliation paged the entire live workspace, read every object into a map, then base64-expanded all changes into a 16 MiB internal request. It had no file-count or aggregate-byte ceiling, so a large mounted workspace could exhaust memory/CPU before the internal request limit fired. Added a 1,000-file / 8 MiB scan ceiling with early 413 responses before downloading an individually oversized R2 object and an actual-byte check after reads. Added regressions for both an oversized object and a paginated workspace exceeding the file ceiling.

Validation: RepositoryDO, storage, token, and request-boundary suites passed 13/13; Artifact TypeScript passed; Wrangler development dry run passed; `git diff --check` passed. Live R2 pagination, object-size consistency, DO SQL persistence/replay, and concurrency were not exercised. Reconciliation above these explicit per-request ceilings still requires chunked commits; the current implementation fails safely with 413 rather than processing arbitrarily large workspaces. Marked two files complete; inventory remains 2,028 tracked / 1,822 source-config files, now 502 checked and 1,320 open.

## Artifact listings, downloads, and UI pagination (2026-10-21)

Traced the artifact route from R2 through the authenticated Artifact and Agents workers, agent prebuilt, shell API, and Artifacts panel. The R2 list previously stopped after a coarse 500-row threshold without returning a cursor, and the Agent proxy/UI exposed no way to continue. Added bounded 1–200 item cursor pagination end to end, including a shell “Load more artifacts” action and the agent CLI's `limit`/`cursor` arguments. Raw artifact GETs also served user-authored HTML inline with user-controlled MIME metadata; they now force attachment, apply a restrictive sandbox CSP and `nosniff`, disable private caching, and encode filenames for safe headers. The Agent wrapper and prebuilt decode those filenames for display.

Validation: Artifact and RepositoryDO focused tests passed 16/16; the migration/worker-independent artifact route, assistant proxy, and prebuilt suites passed 58/58; Artifact, Agents, and Shell TypeScript checks passed; Artifact Wrangler development dry run passed; `git diff --check` passed. Browser behavior and Cloudflare R2 cursor guarantees still need deployed verification. Updated the tracked tree after commit `849ebb89`: 2,029 tracked files / 1,823 source or executable-configuration files. The checklist now has 505 completed scoped reviews and 1,318 open rows. RepositoryDO's broader file review remains open even though the reconciliation bounds subpass is recorded above.

## Platform assistant session ownership, scale, and storage (2026-10-21)

The platform assistant DELETE route deleted `assistant_messages` by guessed session ID before verifying ownership, allowing a cross-user/tenant transcript deletion that returned 404. Replaced it with a transactional D1 batch whose message and session deletes both require the same session, tenant, and user scope. Session detail reads also returned the full unbounded transcript; they now return at most 100 messages, in chronological order per page, with a stable row cursor and explicit `has_more`. LLM history selection uses SQLite row order so user/assistant pairs sharing a timestamp remain in insertion order.

A deeper deployment trace found no `assistant_sessions` or `assistant_messages` schema anywhere in the migration tree, and the Assistant Wrangler D1 bindings had no migrations directory, so all session APIs depended on nonexistent tables in a fresh environment. Added migration `0122_platform_assistant_sessions.sql`, indexes, role check, and message cascade; wired it into development/staging/production. The migration-driven tenant erasure classifier then caught that the new private session table also needed deletion; organization erasure now deletes assistant sessions and relies on the declared cascade for message content.

Validation: Assistant route tests passed 6/6; the all-migrations D1 erasure and migration suites passed 13/13; Workflows erasure tests passed 15/15; Assistant TypeScript passed; Wrangler dry runs passed in development, staging, and production; `git diff --check` passed. These use local SQLite/mocks and dry-run config validation; the production D1 migration has not been applied or exercised. Inventory refreshed after `4bc55f6b`: 2,030 tracked / 1,824 source or executable-configuration files, 507 scoped reviews recorded, 1,317 still open.

## Builder authentication boundaries (2026-10-21)

Continued the Auth worker pass across signup, login, reset-email dispatch, password reset, JWT revocation, and stored PBKDF2 verification. Reset email dispatch was missing the tenant header required by Notifications, so requests appeared successful while the service binding rejected delivery; it now sends the user's organization ID and the route test asserts the header contract. Auth JSON parsing now enforces a 16 KiB streamed request ceiling and object-shaped JSON, malformed stored password hashes fail as invalid credentials rather than throwing or accepting unsafe iteration parameters, and reset passwords/tokens have explicit byte limits. Signup validates and canonicalizes new email addresses while case-insensitive uniqueness blocks new variants; login and recovery prefer an exact legacy address and allow case-insensitive fallback only when it is unambiguous. Login unknown/inactive responses stay uniform, reset-token claims remain single-use under concurrent requests, each new reset request replaces older unused links, a successful reset invalidates every other outstanding link, and `/verify` checks the current token version so revoked but unexpired JWTs are rejected there as they are by Router.

Validation: Auth worker tests passed 32/32; Notifications suites passed 27/27; Auth TypeScript, Auth Wrangler production dry run, and `git diff --check` passed. The Auth route implementation remains open for the broader JWT claims, subscription/member-state, deployment-secret, and router-to-service authorization review; only the focused Auth test file is marked complete. Inventory remains 2,030 tracked / 1,824 source or executable-configuration files; 508 checklist rows are checked and 1,316 remain open. No deployed reset email, D1 race, or live login throttling was exercised.

The reset route also previously treated an invalid stored expiry as unexpired because `NaN < now` is false. It now rejects unparsable expiration values before hashing or claiming the token; the regression confirms the existing password remains usable after a malformed token row is refused. Auth tests passed 32/32.

The expiry index now indexes the exact `julianday(expires_at)` expression used by the sweeper, rather than the raw text column. SQLite `EXPLAIN QUERY PLAN` confirms the bounded expiry query uses the new expression index, and the exact forced-index query from the deployment guard executes successfully against local SQLite; Auth tests remain 32/32.

Signup JWTs were missing `tv` even though login JWTs carried it. Router skips its revocation-epoch gate when `tv` is absent, so the token returned from signup remained usable after `/revoke`. Signup now includes the initial version `0`; the revocation regression now exercises the signup-issued token and confirms it is rejected after the epoch increments. Auth tests passed 32/32.

## Phase runner startup and secret isolation (2026-10-22)

Reviewed the standalone phase runner against its safety helpers and the manual full-plan workflow. Found that `run-phase.mjs` called `realpathSync` without importing it, so every invocation failed at startup. Also found provider keys were inherited by Repomix, Git, typecheck, and test subprocesses; the Gemini key was placed in the request URL; phase workflow inputs were interpolated directly into shell commands, including a quoted PR-body heredoc; retry counts were unbounded; model names accepted arbitrary URL path characters; the workflow accepted a user-provided shell verification command; and checkout credentials were persisted while generated code ran.

The runner now imports `realpathSync`, strips known Gemini, Google, Groq, and OpenRouter secrets from child environments, sends the Gemini key in `x-goog-api-key`, bounds provider response bodies (64 KiB errors / 8 MiB successes) while streaming and cancels oversized bodies, caps retry turns at 16, bounds unique key/model rotation pools to eight each and provider attempts to 32, times out provider requests after 60 seconds, validates model identifiers, and runs fixed `pnpm typecheck` / `pnpm test` commands without shell evaluation. The workflow passes input values through environment variables (including PR title/body construction) and scopes the Gemini secret only to validation and inference. The model-generation job now has contents-read permission only; a separate publisher job receives contents and PR write permissions after generated code and tests pass, using a short-lived incremental Git bundle artifact. Empty runs skip publishing. Every action use is pinned to a full commit SHA resolved from official v4 tags. No provider request, code generation, or remote workflow run was performed.

Validation: `tests/unit/phase-runner-safety.test.ts` passed 17/17, including CLI startup, bounded retry/key/model pools, shell-metacharacter model, child-secret isolation, generated-path, and oversized-stream cancellation cases; `node --check run-phase.mjs`, workflow YAML parsing, `bash -n` on each workflow script, token/input-isolation assertions, and `git diff --check` passed. A local two-commit Git bundle round-trip into a fresh repository passed; the incremental bundle was 8,069 bytes versus 26,127,332 bytes for a full-history bundle. Workflow review covered permissions, pinned actions, artifacts, bundle transfer, and PR shell construction; a live GitHub Actions run and its artifact/push lifecycle were not exercised. After the root package manifest and workflow reviews, the source/config checklist records 512 scoped reviews and 1,313 open files. No live GitHub Actions, Gemini, or Cloudflare behavior was exercised.

## Root package manifest command graph (2026-10-22)

Reviewed root package scripts, engine/package-manager constraints, workspace patched dependency declaration, and their workflow/runtime targets. Every root script target exists; CI pins pnpm 9.12.0, matching `packageManager`, and the lockfile uses format 9. The managed shell's bare `pnpm` is 11.25.0 and warned that it ignores `package.json`'s legacy `pnpm.patchedDependencies`; running it rewrote lock metadata, which was reverted. Use `corepack pnpm` (verified 9.12.0) in this environment. The lockfile's full dependency integrity and vulnerability inventory remain open. This review closes the root manifest checklist row only.

## Turbo task graph and deployment fan-out (2026-10-22)

Reviewed `turbo.json` task dependencies against every workspace package script and CI deployment workflow. `deploy:production` is intentionally a broad manual command: Turbo's read-only dry-run resolves 24 real Workers production deploy commands plus their staging, build, test, and typecheck prerequisites. The staging/production deployment workflows use explicit service lists instead of this fan-out. The command has no confirmation gate, so it must not be used as a routine verification command; no deployment task was executed. Turbo's dry-run graph and script discovery agree with the root task dependencies. This closes the `turbo.json` checklist row; production services, external migrations, and live deployment behavior remain unverified. Current source/config checklist count is 513 reviewed and 1,312 open.

## Workspace package and lock importer inventory (2026-10-22)

Compared `pnpm-workspace.yaml` globs with actual package manifests and the pnpm lockfile importer set using the pinned pnpm 9.12.0. All 58 projects (root, apps, packages, workers, and tests) are discovered exactly once and have a lock importer; the declared patched dependency file exists. No workspace omission or orphan importer was found. The package/version/resolution integrity of the lockfile remains a separate unchecked review. This closes the `pnpm-workspace.yaml` row; the tracked source/config checklist now records 514 reviewed and 1,311 open.

## Repomix shell config input inventory (2026-10-22)

The manually used `repomix.shell.config.json` included nonexistent root `tsconfig.json` and repeated `tsconfig.base.json`. Removed the stale entry and duplicate. JSON boundary checks confirm 21 unique include patterns resolve, output stays repository-relative, clipboard copying stays disabled, and `.env*` / `.dev.vars*` patterns remain excluded with Repomix's security scan enabled. No Repomix generation was run because the executable is not a project dependency; the generated payload and actual scanner behavior remain unverified. This closes the config row and brings the checklist to 515 reviewed, 1,310 open.

## Credentials egress request shape bounds (2026-10-21)

Continued the Credentials outbound route audit. The Worker already capped inbound JSON at 1 MiB, but the privileged egress route assumed a JSON object, accepted arbitrary header maps, serialized provider bodies without a separate bound, and could attempt GET/HEAD requests with bodies. It now rejects malformed/non-object requests, requires bounded URL/credential fields, limits headers to 64 entries / 16 KiB, limits serialized upstream bodies to 512 KiB, rejects bodies on GET/HEAD, and validates the relevant optional field types before policy lookup, credential resolution, or fetch. The DNS check/fetch race remains open because Workers fetch does not expose a validated-address pinning mechanism in this path.

Validation: Credentials full focused suite passed 3 files / 13 tests; Credentials TypeScript and `git diff --check` passed. New boundary cases assert malformed input, invalid headers, GET body, and oversize provider body all stop before outbound fetch. Credential decryption and live provider behavior were not exercised in those malformed-input cases.

The write idempotency key now also requires an actual string instead of accepting a numeric JSON value through regular-expression coercion. The same 13-test Credentials suite passed with this malformed-write case included.

The Credentials token's signed `uid` was not compared with `on_behalf_of_user_id` on plaintext or outbound requests. That let a caller holding a valid actor-scoped token ask the vault to resolve a different member's personal credential. Both routes now require the requested user to equal the HMAC-signed actor and reject mismatches before credential lookup or network egress. MCP Hub and the Agents vault proxy now mint actor-bearing credential tokens whenever they request a personal scope; legacy actorless calls remain valid only for shared/space-level resolution.

Validation: Credentials Worker suites passed 3 files / 14 tests; real SQLite credential hierarchy plus MCP connector-scope suites passed 46/46; Agents vault-proxy tests passed 4/4. Credentials, MCP Hub, and Agents TypeScript checks passed; `git diff --check` passed. The test cases confirm cross-user requests stop before credential table reads and valid actor-bound resolution remains supported. No deployed service-binding caller was exercised.

## Router builder-auth ingress follow-up (2026-10-21)

Traced the public `/v1/auth/*` routes through IP-bucketed pre-auth rate limiting and streaming body forwarding. Login, registration, and reset endpoints were bounded, but authenticated `/verify` and `/revoke` were forwarded without a pre-auth rate budget; both can trigger D1 reads/writes and were exposed to avoidable request amplification. Added separate per-IP limits (30/minute for verify, 10/minute for revoke) and route regressions asserting each uses its own bucket and rejects when the RateLimitDO blocks it. The Wrangler manifest contains the RateLimitDO binding in development, staging, and production; no public request header can select a bucket key other than the edge-provided client IP in deployed Workers.

Validation: Router worker suite passed 11 files / 51 tests; Router TypeScript passed; root Router pre-auth limiter tests passed 13/13; `git diff --check` passed. The broader Router file remains a large, partially reviewed surface; this scoped follow-up does not close its checklist row or establish live RateLimitDO behavior.

The token-version follow-up also found Router accepted `claimedVersion >= currentVersion`. Although a future version is not normally issued, a valid old signed token could survive a D1 restore that rolled the stored version back. Router now requires exact equality with the current persisted epoch. A regression submits a correctly signed token with a future version and confirms Router rejects it as revoked. Router full suite passed 11 files / 51 tests, Router TypeScript passed, and `router-dispatch` passed 22/22. Router's broader route and tenant authorization audit remains open.

The Auth worker had `JWT_EXPIRY_SECONDS=3600` in all Wrangler environments but ignored it and minted 24-hour tokens in both signup and login. Token issuance now honors the configured value, defaults to one hour when omitted, and rejects unsafe configuration outside 60 seconds to 24 hours. A regression verifies the lifetime in both signed token flows; Auth tests passed 31/31, TypeScript passed, and the production Wrangler dry run confirmed the deployed binding value is 3600.

## Builder reset-token retention and required migration deployment (2026-10-21)

The builder reset-token table retained expired hashes indefinitely; the daily Sweeper did not include it. Added a 1,000-row expiry cleanup and an index-backed migration so cleanup cost stays bounded as the table grows. While tracing deployment, found migration `0122_platform_assistant_sessions.sql` was only in a best-effort loop whose failures are swallowed; the Assistant could deploy against missing tables. Staging and production now apply 0122 as a required step and validate both session tables, then apply the new 0123 expiry-index migration as a required step and force a query through the expected expiry index before deployment. Added a deployment-workflow regression and migration-backed auth assertions for the expiry index and actual SQLite query plan.

Validation: Sweeper tests passed 11/11 and TypeScript passed; Auth tests passed 32/32, including a real SQLite cleanup proving expired rows are deleted while live reset tokens remain; Auth plus data-erasure tests passed 39/39. Deployment workflow assertions ran in the Sweeper suite; `git diff --check` passed. Updated inventory includes 2,031 tracked files / 1,825 source or executable-configuration files; the scoped 0123 migration/index review is checked, leaving 509 checked and 1,316 open. The remote migration and cleanup schedule have not been exercised against deployed D1.

## Production dependency and frontend deployment findings (2026-10-22)

Resumed the audit with a production-only registry audit of the committed lockfile: 538 production dependency instances include 4 critical and 29 high advisories. Four apps use `next@14.2.18`, with critical advisories for Middleware authorization bypass and unauthenticated RCE paths in the Image Optimization API, plus high RSC denial-of-service/SSRF advisories. Source scan found no app Middleware or `next/image` use so far; deployed output and adapter reachability still need confirmation. The installed `@cloudflare/next-on-pages@1.13.16` is deprecated and declares Next support only through 15.5.2, while patched critical Next releases begin at 15.5.24/15.5.28. Shell also actively imports `xlsx@0.18.5`, which has two high advisories with no patched npm release, and `mammoth@1.12.1` pulls vulnerable `@xmldom/xmldom@0.8.14` (fixed upstream at 0.8.15).

Tracing the frontend deployment workflow exposed a separate likely broken path: CI invokes plain `next build` but uploads `.vercel/output/static`; the deprecated adapter's documented build command is `next-on-pages`, which is not the command in the workflow. I added both issues and the required follow-up work to the audit plan. This is an initial finding, not a fix: frontend adapter migration, vulnerability remediation, exact patched lockfile re-audit, hostile document tests, and live deployment verification remain open. No dependency files or deployed resources were changed in this pass. DNS rebinding remains open pending a connection-time pinning egress service and deployed fault-injection test.

## Frontend build artifact and Office parser security pass (2026-10-22)

Fixed the Pages workflow build command mismatch: dashboard, portal, and marketplace staging and production jobs now invoke the `next-on-pages` adapter that creates the `.vercel/output/static` directory they deploy. Verified local adapter builds with the repository-pinned pnpm 9.12.0; builds created the output worker and routed dynamic edge pages (dashboard 22, portal 3, marketplace 2), and the dashboard bundle contains the staging API URL. An initial local run with system pnpm 11 failed due ignored workspace overrides and lockfile mismatch; repeating through a temporary pnpm 9.12 shim matched CI and passed. This is build evidence only; no Pages deployment, public-route smoke test, or shell promotion workflow check was performed.

Removed `xlsx@0.18.5` and `mammoth` from the shell app and removed the browser-side workbook and DOCX archive/XML parsers. XLSX and DOCX binaries now use the existing download path; oversized files remain non-previewable. Root pnpm overrides pin fixed `browserslist@4.28.7`, `nanoid@3.3.18`, `postcss@8.5.18`, and `source-map-js@1.2.2`. Focused SSR boundary tests cover spreadsheet download, Word archive download, and over-limit behavior; shell test suite passed 3 files / 8 tests and shell TypeScript passed.

A fresh `corepack pnpm audit --prod` initially reported 4 critical, 13 high, 35 moderate, and 6 low advisories (58 advisory records). After the later dependency runner overrides, the current production count is 49 records: 4 critical, 11 high, 29 moderate, and 5 low. The removed `xlsx`, `mammoth`, and `@xmldom/xmldom` findings are absent. The 4 critical advisories and most remaining high findings are still the shared Next 14.2.18 frontend dependency. Cloudflare's installed Pages adapter is deprecated and caps its declared peer range at Next 15.5.2, while the critical patched floor is Next 15.5.24 / 15.5.28. A version bump would cross the adapter's supported range; moving to OpenNext changes the runtime from Pages Functions to Workers and needs custom-domain/staging route migration. This framework security finding remains open. The shell's separately promoted Pages build also needs review; malicious PDF/image browser-handling stress coverage, Vite advisory reachability, and live deployment checks remain outstanding.

## Full test failure triage and current production audit (2026-10-22)

Re-ran the full workspace suite after the dependency updates and preceding scoped fixes: the first run reported 17 failures across 7 suites, with 3,789 tests passing. Root cause analysis found outdated fake databases that lacked the active org/space migrations or matched the old unscoped scheduled-job query. Updated those fixtures to use the real `0002_orgs.sql` / `0003_spaces.sql` schemas and to recognize the current `(job_id, space_id, tenant_id, enabled)` queue read. Updated mock run responses to the current `{ result: { ok: true } }` contract. All seven formerly failing suites now pass, 79/79 focused tests.

The same failure triage exposed a real eval instrumentation defect: the safety dataset's fabricated-success pattern was rejected by the synchronous-regex safety guard, causing a valid refusal to score 7.5/10. Rewrote the dataset expression to avoid nested quantified alternations and added a validity assertion that every safety check passes on the refusal. Added regressions proving a tool trace with absent `ok` is not counted as success and cannot hide a fabricated completion. Eval trace and dataset validation pass 46/46 focused tests.

The full root suite is being rerun after these corrections. Latest production `pnpm audit` reports 49 advisory records: 4 critical, 11 high, 29 moderate, and 5 low; every critical/high advisory is for shared `next@14.2.18`. Keep the Next migration and DNS rebinding rows open. The current inventory refresh records 2,035 tracked files, 1,827 source/config files, 515 scoped reviews, and 1,312 open checklist rows.

Final verification after failure fixes: the full root `pnpm test` run passed all 54 workspace tasks, 368 test files, and 3,806 tests in 4m22s. The dependency audit still exits nonzero because 4 critical and 11 high Next.js advisories remain; this is a known open infrastructure/runtime migration item rather than a test failure. DNS rebinding in the outbound fetch path is still an unresolved connection-time address pinning gap, and no live Cloudflare deployment or external-provider test was run. The file checklist remains 515 reviewed / 1,312 open; the broad file-by-file audit is not complete.

## Shell file-preview resource stress follow-up (2026-10-22)

Reviewed the remaining `FileViewer` paths after removing Office archive parsers. Workspace file reads are capped at 2 MiB by the Spaces Worker, and PDF/image previews use browser-native rendering; however, CSV parsing eagerly materialized every row even though the table renders only 500, and it accepted unbounded columns. A maximum-size CSV with many tiny cells could create disproportionate arrays and React work. Parsing is now capped to the header plus 500 rows and 100 columns, matching what the preview can show. Added stress regressions for a 10,000-row CSV and a 2,000-column CSV.

Validation: Shell FileViewer/shell tests passed 3 files / 10 tests; shell TypeScript and `git diff --check` passed. PDF viewer native plugin behavior and real-browser image/PDF resource exhaustion were not exercised, so those browser-specific cases remain an explicit follow-up. FileViewer source and tests now have scoped review checkmarks; checklist: 517 reviewed / 1,310 open.

## Spaces R2 workspace file-read boundary (2026-10-22)

Reviewed the real workspace file read route and its R2 response tests. The route checks the R2 metadata size before reading the body, then verifies the actual byte count matches metadata and remains within the 2 MiB limit; PDF and raster-image reads are base64-labelled, while Office files are downloadable without archive parsing. Updated stale comments that still described Office preview parsers. Added route tests proving exact PDF bytes/content type are preserved and an oversized object never has its bytes read. Existing traversal, missing-file, listing, and unavailable-bucket cases remain covered.

Validation: `workspace-file-viewer.test.ts` passed 7/7. Browser-native PDF/image rendering remains untested in a real browser. The checklist records this scoped route/test review and now contains 518 reviewed / 1,309 open files.

## Space Assistant R2 file snapshot consistency (2026-10-22)

A further review of `/spaces/:spaceId/assistant/files/*` found that it called `readBytesWithHash` (which enforces the inline byte limit and verifies the published SHA-256 metadata), discarded the returned bytes, then called R2 `get()` a second time and returned that new object's body. A concurrent replacement could therefore make the delivered content differ from the integrity-checked snapshot. The route now base64-encodes or decodes the already-verified `current.bytes` and never performs the second read. Updated stale comments to document Office downloads rather than browser parsing.

Validation: `space-assistant-surface.test.ts` passed 35/35, including a simulated between-read object replacement proving one R2 body read and snapshot consistency; Agents TypeScript passed. The full Agents index remains unchecked because it contains many unrelated routes. No live R2 consistency/fault-injection was performed.

## Shell Markdown renderer boundary (2026-10-22)

Reviewed the Markdown surface used by chat, activity, and workspace previews. `react-markdown` remains configured without raw-HTML parsing, and outbound links use `noopener noreferrer`. The special workflow-receipt fast path previously trusted `JSON.parse` output after checking only `kind` and `lines`, then rendered other fields directly as React children and a navigation URL. Malformed objects could crash the preview and a protocol-relative or non-HTTPS log URL could navigate away from the trusted origin. Receipt parsing now enforces a 64 KiB payload bound and validates all rendered fields; log links allow HTTPS or same-origin absolute paths only. Added regressions for raw HTML, JavaScript URLs, malformed receipt values, protocol-relative log links, and valid receipts.

Validation: Shell suite passed 4 files / 14 tests; shell TypeScript passed. Browser navigation behavior and live malicious-content browser tests were not run. The Markdown component and new tests have scoped review checkmarks; the source checklist will be refreshed with this addition.

The generated checklist now records 520 reviewed source files and 1,308 open source files (1,828 source/config files total). The Markdown pass closed the two scoped rows for its component and test; the wider shell/app audit remains open.

## Full dependency-tree stress remediation follow-up (2026-10-22)

A full `pnpm audit` (including development/build dependencies) reported 82 advisory records: 4 critical, 26 high, 43 moderate, and 9 low. In addition to Next/Pages, high findings included vulnerable `js-yaml`, `ws`, and `sharp` versions in build tooling. Added semver-compatible workspace overrides for `js-yaml@4.3.2`, `ws@8.21.0`, and `sharp@0.35.5`; lockfile resolution removes those findings. The latest full audit reports 74 records: 4 critical, 19 high, 42 moderate, and 9 low. Production remains 49 records (4 critical, 11 high, 29 moderate, 5 low).

Remaining high build/test dependency findings include `undici@5` under the deprecated Next Pages adapter (patched advisories require v6), unpatched `extract-zip@2.0.1` and `braces@3.0.3`, and major-version updates for `basic-ftp` and `@fastify/busboy`. These remaining findings are in development/build tooling, but are retained as open risks pending adapter/toolchain migrations or compatible dependency changes. Full root tests are running against the override lock before this finding is closed.

Final dependency override validation: full root `pnpm test` passed all 54 workspace tasks, 368 test files, and 3,809 tests in 4m17s after `js-yaml`, `ws`, and `sharp` overrides. Latest full dependency audit is 74 records (4 critical, 19 high, 42 moderate, 9 low); production audit remains 49 (4 critical, 11 high, 29 moderate, 5 low). The override package manifests and lock resolution were reviewed against the advisory paths; `pnpm-lock.yaml` is checked in the scoped inventory. Recursive workspace TypeScript validation initially exposed that Sweeper, Router, and Billing runtime tsconfigs included Node-only test files; each now excludes `src/**/*.test.ts`, consistent with other workers. The complete root typecheck then passed 74/74 tasks. The source/config inventory has 524 reviewed / 1,304 open rows. Remaining high dependencies and Next/DNS infrastructure findings remain open.


The typecheck correction does not exclude tests from Vitest: all 3,809 full-suite tests passed, and worker source remains checked under Cloudflare Workers types. No deployment dry run was included in this typecheck result.

## Browser screenshot R2 integrity (2026-10-22)

Audited `BrowserSessionDO.see`: capture stored the screenshot's SHA-256 and byte count in the Durable Object observation, but reads only checked R2 metadata size and streamed the body. Added read-time length and digest verification and now returns the exact checked buffer, preventing substituted/corrupt R2 bytes from being presented as the recorded browser observation. Existing screenshot size and session ownership checks remain in force.

Validation: browser-worker scoped integration test file passed 7/7, including matching-byte retrieval and replacement-hash rejection; Browser Worker TypeScript passed. Full root `pnpm test` passed 368 files and 3,811 tests across 54 workspace tasks. The BrowserSessionDO source file remains unchecked because its other lifecycle, request-interception, action, cancellation, and persistence paths have not all been reviewed.

## Browser worker test discovery gap (2026-10-22)

The browser worker had security/lifecycle tests under `workers/browser/src`, but no package `test` script, so the standard Turbo test task did not execute them. Added a Vitest config with workspace source aliases and a package test script/dependency so they become part of `pnpm test`. After workspace execution recovered, the focused worker suite passed both test files (3 tests). The subsequent full Turbo run passed all 55 tasks, including this worker test task; the root test package reported 368 files / 3,811 tests. Browser TypeScript passed, and `wrangler deploy --dry-run` bundled the worker with its DO, R2, service, and Browser bindings. No live deployment or external Browser provider test was performed. The browser worker package/config/tests, state helper, and worker entrypoint are checked in the file checklist; `BrowserSessionDO.ts` remains open for broader lifecycle/security review.

## Browser screenshot cleanup intent (2026-10-22)

The screenshot path was written to R2 before its path entered the Durable Object record. A DO interruption between those writes could leave an untracked image that session cleanup could not delete. The upload now persists the path as a cleanup intent before the R2 write. Failed uploads attempt immediate deletion and remove the intent only after successful cleanup; if deletion fails, the tracked path remains for alarm cleanup. Later failures before the final observation commit also discard the pending artifact. Added tests for intent-before-upload ordering, successful rollback after a partial write, and retaining the intent when R2 deletion fails. An initial test caught cleanup error masking the original upload error; the helper now preserves the upload failure while leaving failed cleanup tracked.

Validation: Browser Worker suite passed 3 files / 6 tests, TypeScript passed, Wrangler dry-run build passed. The full root suite passed immediately before this change; the focused worker suite covers the changed helper. Crash timing and live R2 failure behavior remain simulated, not exercised against Cloudflare. `BrowserSessionDO.ts` remains unchecked pending broader lifecycle review; the new state-helper test and helper are checked in the file checklist.

## Browser observation traversal bounds (2026-10-22)

The BrowserSessionDO capped returned frame IDs and actionable elements, but its frame-tree traversal still visited every sibling at each level and recursively descended, while accessibility-node processing scanned the whole provider response if few nodes were actionable. Added iterative frame traversal with a 16-frame output / 64-node visit cap, plus a global 8,192 accessibility-node budget and 2,048 nodes per frame. Added synthetic 50,000-sibling, 10,000-depth, and million-node proxy stress cases proving the loops stop at configured bounds.

Validation: Browser Worker suite passed 4 files / 9 tests; Browser Worker TypeScript and Wrangler dry-run build passed. Tests exercise pure traversal helpers; they do not instantiate a live Chromium page or validate provider-side response allocation. `BrowserSessionDO.ts` remains open for lifecycle review; the bounded helper and tests are checked in the file plan.

## Gumroad connector test discovery (2026-10-22)

The Gumroad shim had `src/index.test.ts` coverage for request size, invalid product IDs, redirect behavior, and timeout setup, but the worker package had no `test` script. Added the workspace Vitest dependency, config aliases, and package test task so Turbo can include the existing tests. The same source pass reviewed the worker route/auth wrapper, request/response byte caps, fixed provider origin, and Wrangler bindings; no live Gumroad request was made.

Validation: focused Gumroad suite passed 1 file / 2 tests; TypeScript passed; Wrangler dry-run build passed. The last full Turbo suite predates this task; direct package validation covers the added task. Gumroad config and test rows are checked in the file plan.

## Whop connector test discovery (2026-10-22)

The Whop shim likewise had boundary tests but no package `test` script. Added Vitest workspace config/dependency and a test task. Reviewed the shim's REST paths, strict ID and write-payload checks, request/response limits, redirect handling, timeout, internal HMAC gate, and deployment bindings. The shim exposes two write tools, so its capability policy in MCP Hub and connector permission registry remains part of the broader review; no live Whop request was made.

Validation: focused Whop suite passed 1 file / 2 tests; TypeScript and Wrangler dry-run build passed. The latest full Turbo run predates the Gumroad and Whop task additions; both packages were validated directly. Whop package/config/test rows are now checked in the file plan.

## Knowledge worker scoped validation (2026-10-22)

Reviewed the Knowledge worker manifest, runtime type configuration, Vitest config, and the Foundry sharing regression tests. The internal document-sharing routes verify tenant/space ownership, require indexed space-wide documents, return sanitized KB chunk text under a 250 KiB cap, and do not include content in the reference-resolution route. The tests exercise direct-access denial and suspended-space denials. The larger Knowledge `index.ts` remains unchecked; retrieval, ingestion, external publication, and lifecycle routes still need file-by-file review.

Validation: Knowledge suite passed 10 files / 64 tests, TypeScript passed, and Wrangler dry-run build passed with its D1/KV/Vectorize/R2/service/AI bindings. No live D1, Vectorize, R2, AI, AutoRAG, or external-provider exercise was performed.

## Marketplace mutation and review boundaries (2026-10-22)

The Marketplace worker trusted identity headers on write routes without verifying the router's internal HMAC. Public catalog reads must remain unauthenticated, but submissions, approvals, reviews, forks, and license checkout are router-authenticated mutations. Added HMAC enforcement to non-read methods while leaving public GETs accessible. Regression tests prove unsigned forged `platform_admin` headers cannot submit or approve, ordinary members cannot approve, and unsigned public listing reads still work.

The same route review found that review comments had no independent size/type bound and review reads did not require the listing to remain published. Comments now have a 5,000-byte cap and invalid types are rejected; review reads return 404 after a listing is unpublished. Tests cover over-limit comments and review hiding after rejection.

The public serializer also spread most of a `SELECT *` row, exposing `tenant_id` and `developer_user_id`; review results exposed the authenticated reviewer ID as `author_name`. Listing responses now use an explicit public-field allowlist, reviews use a generic `Member` label, and mutation JSON is bounded to 256 KiB before parsing. Regression coverage verifies those IDs stay out of list/detail/review responses and oversized submissions receive 413.

Validation: the full Turbo suite passed 57 tasks (368 root test files / 3,811 root tests) after HMAC, review-size, and unpublished-review changes. After the public serializer and request-size changes, the migration-backed Marketplace route suite passed 3/3; Marketplace TypeScript and Wrangler dry-run build passed. No live D1 or billing-worker integration was exercised. Marketplace manifest, tsconfig, and entrypoint are checked in the inventory.

## MCP Hub request boundaries and connector routing (2026-10-22)

Reviewed the MCP Hub manifest, TypeScript config, routes, connector scope policy, Composio and Pipedream clients, and existing auth/air-gap/tenant/upstream tests. Found an unbounded cloned JSON parse on the alias-call path and unbounded `c.req.json()` parsing on direct tool calls, Composio operations, server registration/update, and alias registration. All inbound JSON routes now parse under route-specific byte caps (16 KiB, 64 KiB, or 1 MiB); malformed or non-object JSON fails with 400 and over-limit bodies with 413. Alias calls parse the bounded body once and pass that same body through to the internal call route. Direct tool-call payloads also require a nonempty tool name and object input.

Stress regressions cover 1 MiB+ direct and alias calls, oversized Composio and management mutations, invalid JSON and wrong input shape, and no provider dispatch for rejected requests. Existing upstream-size, redirect, air-gap, tenant-space, Composio, and connector-scope tests passed.

Validation: MCP Hub suite passed 5 files / 22 tests; TypeScript passed; Wrangler dry-run build passed. No live D1, Composio, Pipedream, Cloudflare deployment, or external-provider test was performed. DNS rebinding remains an infrastructure gap because the Worker fetch path cannot pin the address validated by DoH; a controlled egress proxy is still required for that guarantee.

## Notifications egress and credential bounds (2026-10-22)

Reviewed the Notifications worker routes, queue consumer, provider calls, Web Push helper, deployment configuration, and tests. Found an unbounded credential-worker JSON parse; it now uses the shared 16 KiB response reader and rejects missing/non-string credentials. APNs device tokens now require exactly 64 hex characters, APNs host configuration is restricted to Apple's production/sandbox endpoints (defaulting to production), and provider sends refuse redirects so bearer/API credentials cannot cross a redirect boundary. Added stress tests for over-limit vault responses, APNs path injection, and unapproved APNs hosts.

Validation: Notifications suite passed 7 files / 30 tests; TypeScript passed; Wrangler dry-run build passed. No live D1, APNs, Resend, chat-provider, Web Push, Cloudflare deployment, or external-provider test was performed. Webhook and provider DNS rebinding remains unresolved because Workers fetch cannot pin the validated address; a controlled egress proxy is still required.

## Provisioner external egress, rollback, and config merge (2026-10-22)

Reviewed the Provisioner entrypoint, queue contract/handler, lease/state helpers, deployment configuration, and existing route/state/tenant tests. The manifest-controlled custom lifecycle URL previously went straight to global `fetch`; it now passes SSRF validation, rejects redirects, and has a 30-second deadline. This still cannot defeat DNS rebinding between validation and Workers fetch, so this path inherits the unresolved controlled-egress-proxy requirement.

Rollback previously had one outer catch around R2, KV, D1, and SpaceDO cleanup; a failed early delete skipped unrelated orphan cleanup. Cleanup stages and individual agent removals now fail independently, response JSON is capped at 1 MiB, and agent IDs are length-checked and encoded before use in a route. Onboarding state now updates with one guarded SQLite `json_set` statement to preserve concurrent changes to other config fields instead of a read/modify/write overwrite. Added tests for private literal/private DNS custom-hook destinations, redirect/deadline settings, and cleanup continuing across failing stores.

Validation: Provisioner suite passed 9 files / 49 tests; TypeScript passed; Wrangler dry-run build passed (14.1 MiB bundle, 2.6 MiB gzip). No live D1, KV, R2, SpaceDO, Cloudflare deployment, or custom external hook was exercised. The Worker bundle is unusually large because provisioning imports agent launchpad/bootstrap code; keep this as a performance/deployment-budget review item.

## Router limits and audio decode stress pass (2026-10-22)

Reviewed the Router package/test configuration, pre-auth and authenticated rate-limit paths, RateLimitDO, extension/customer-voice/health/language tests, and bounded audio routes. Pre-auth routes claimed fail-closed behavior but returned `allowed: true` if the required RateLimitDO binding was absent; they now fail closed and have missing-binding/outage tests. RateLimitDO previously let malformed/null JSON throw and accepted string, negative, or arbitrarily large limits; request shape, 512-byte key length, and positive finite limit (maximum 10,000/minute) are now validated, including reset-key validation.

Ogg decoding checked the duration only after `decodeFile` had expanded the complete payload. Added a bounded Ogg page/granule preflight that rejects malformed pages and excessive duration before decoder allocation, including aggregate duration across logical streams; the decoder's decoded-sample cap remains as a second guard. Tests cover private/extreme granules, chained-stream duration, truncated page segments, and valid real audio. The router and provisioner test scripts also no longer use `--passWithNoTests`, so accidental loss of test discovery fails CI.

Validation: Router suite passed 12 files / 67 tests; TypeScript and Wrangler dry-run passed. Provisioner suite passed 9 files / 49 tests and TypeScript passed after its test-script adjustment. No live DO storage, Workers AI transcription, Cloudflare deploy, or external-provider call was performed. DNS rebinding remains unresolved on worker fetch paths as previously recorded.

## Auth worker JWT and test-discovery stress pass (2026-10-22)

Reviewed Auth package scripts/dependencies, TypeScript inputs, Wrangler bindings, health route test, signup/login/reset/revoke/verify flows, password hashing, and the migration-backed route suite. The package test command had used `--passWithNoTests` without a Vitest config and therefore did not include the substantial root Auth route suite. Added a worker Vitest config and dependency so package tests execute both the health test and migration-backed route suite. Inactive users were verified using their stored password hash, which could have a much lower PBKDF2 iteration count than unknown users and reveal account state through timing; inactive accounts now use the same dummy hash as unknown accounts.

`/revoke` previously incremented `token_version` for any correctly signed JWT, even after that token had already been revoked. Replaying an old JWT could repeatedly revoke newer sessions. The route now atomically increments only when the presented token version is current and rejects stale replays. Added coverage that confirms a replay is rejected and does not advance the epoch again.

Validation: Auth suite passed 2 files / 33 tests; TypeScript passed; Wrangler production dry run passed (108.07 KiB / 26.40 KiB gzip). No live D1 race, rate-limit deployment, login timing distribution, Cloudflare deploy, or email provider was exercised. Auth checklist files above are reviewed; platform-wide JWT issuance/validation callers remain subject to their own route/worker audits.

## Billing wallet bridge authentication finding (2026-10-22)

Started the Billing worker pass by tracing business wallet calls from the agent prebuilt through Billing into the owning SpaceDO. The agent caller minted a tenant HMAC, but `/billing/business-wallet/settle` and `/billing/business-wallet/withdraw` did not verify it before forwarding a tenant header and financial operation. Added the same `requireInternalHmac` tenant gate used by the neighboring internal money routes. Regression tests prove both endpoints reject unsigned requests without forwarding and accept a token scoped to the forwarded tenant. The Billing request-boundary test, package manifest, TypeScript config, Vitest config, and Wrangler manifest have scoped reviews; the 1,680-line route file and the rest of Billing remain open.

Validation: complete Billing worker suite passed 6 files / 13 tests; Billing TypeScript passed; Wrangler dry-run passed (402.48 KiB / 82.68 KiB gzip). No live Spaces DO, financial provider, deployment, or external API was exercised. This is an incremental route fix, not completion of the Billing audit.

The ongoing route review also found that `/billing/portal` followed redirects from Lemon Squeezy and parsed its response without a byte ceiling or request deadline. It now refuses redirects, times out after 10 seconds, and accepts at most 1 MiB of provider JSON. The package test selection now includes the existing migration-backed platform-plan billing suite; added assertions cover those egress bounds and oversized responses. The 1,680-line route file remains unchecked pending review of all routes and callers.

Updated validation: complete Billing worker suite passed 7 files / 24 tests; TypeScript passed. The portal maps malformed or oversized upstream JSON to the generic 500 response. No provider response or timeout was exercised outside mocks.

The revenue calculation review found platform fee basis points parsed with `parseInt` and no range check in product, seat, credit-pack, and wallet top-up checkout flows or their settlement webhook handlers. Values such as `10001` or `500bps` could silently produce fees above gross or inconsistent metadata. Added strict integer/range normalization (0–10,000 bps), safe fallback to 500 bps for invalid config/metadata, and a final cap at gross on sale settlement. Added policy edge cases and a migration-backed webhook regression with both malformed provider metadata and over-100% configuration.

Validation: Billing suite passed 8 files / 35 tests; Billing TypeScript passed; `tests/unit/billing-order-wallet-settlement.test.ts` passed 10/10. Fee policy files are reviewed. The large route and webhook implementation files remain unchecked, including review of all route paths and settlement failure modes.

Reviewed the complete Billing quota module and traced its callers in the route file. The monthly checks use KV only as a five-minute display/enforcement cache and invalidate after D1 usage writes; day/week checks use separate keys; LLM reservations use a single conditional D1 admission predicate over usage plus unexpired holds. Found no additional code change in this pass. Quota window, cache invalidation, builder-facing route, and LLM-reservation focused suites passed 35/35. `workers/billing/src/quota.ts` is now checked; its route callers and neighboring migration/test files remain open for their own file-level review.


Reviewed the marketplace settlement helper, wallet forwarding helper, and developer payout reconciliation flow with their focused tests. The exported commission helpers now reject unsafe JavaScript monetary integers and cycles. Stripe account and transfer requests now refuse redirects while retaining their 8-second deadlines, payout ID validation, bounded responses, idempotency key reuse, and the 23-hour uncertain-outcome stop. Existing migration-backed payout tests cover earning capture, retry pinning, duplicate renewal events, and long-cycle commissions; added a redirect/deadline regression.

Validation: Billing worker suite passed 8 files / 37 tests; settlement and payout migration-backed suites passed 14/14; Billing TypeScript passed. Payout/settlement/helper files are marked reviewed. Broader Whop wallet operations, Lemon Squeezy webhook processing, remaining Billing routes, and related migrations remain open.


Marketplace license settlement review found two edge cases: a different payment could race the first tenant/listing purchase between the pre-read and unique insert, making one webhook fail indefinitely instead of recording an overpayment; and a signed non-USD payment with the same numeric amount could satisfy a USD fixed-license listing. The purchase write now absorbs unique conflicts, checks for the winning purchase, and records the racing payment as refund-required overpayment. Settlement now requires USD. Added a concurrent duplicate-payment regression and a currency mismatch regression; the migration-backed test also verifies one license/earning and exact refund task counts. The marketplace license settlement test is now included in the Billing worker test project.

Validation: marketplace license migration-backed test passed; Billing TypeScript passed. The marketplace license route/webhook module and test are checked; other Billing source modules remain in progress.


Partner Portal request stress review found uncaught malformed/non-object JSON and unbounded extension arrays on template subscription creation, plus malformed auto-payout JSON returned a server error. Added object/field validation, 64-extension ceiling, safe integer price checks, and 400 responses. Organic attribution now requires an active developer profile. Added request-shape and profile-eligibility tests; the test is included in the Billing package suite. A remaining ownership issue stays open: the route accepts a valid developer profile ID but does not yet prove that profile authored `template_id` (the repository has no existing caller or unambiguous template-to-listing contract to preserve). This route source remains unchecked until that attribution binding is resolved.

Validation: Billing suite passed 10 files / 42 tests; TypeScript passed. This partial route review does not close the Partner Portal feature audit.


## Whop wallet payout safety pass (2026-10-22)

Reviewed `workers/billing/src/whop-wallet.ts`, its D1-backed test fixtures, router auth behavior, and provider request construction. Found that any authenticated Space member could request a payout through the router-minted internal HMAC path; payout initiation now requires owner/admin. Amounts and optional request fields now have safe-integer and size/type validation. Concurrent initial provisioning and retry requests now claim a D1 pending row before contacting Whop, preventing duplicate company creation under normal request overlap. Payout requests now send only the provider-issued `whop_destination_id`; a local Naelao UUID is never sent as a Whop destination.

The full billing worker suite passed 73/73 tests, TypeScript passed, and `git diff --check` passed. New regressions cover role denial, fractional/unsafe cents, concurrent provisioning, local-only destinations, and the provider destination identifier.

**Product/integration blocker:** Naelao currently has no verified route or provider workflow that creates/registers a payout destination with Whop and persists `whop_destination_id`. Network documentation lookup was unavailable and no live provider request was made. Payout requests now fail closed with `payout_destination_not_connected` until this integration exists. This feature is therefore not end-to-end complete.


### Billing plan/portal authorization boundary follow-up

The next pass through `workers/billing/src/index.ts` found that `/billing/checkout` and `/billing/portal` relied on router authentication without enforcing owner/admin at the Billing worker boundary. Both now require a verified forwarded owner/admin role before reading billing state, creating checkout sessions, or returning provider portal links. The router removes caller-provided role headers and supplies the role from verified JWT claims. A member regression proves plan checkout is rejected before provider configuration is used. The Billing worker suite passes 74/74 tests, typecheck passes, Wrangler dry-run succeeds (406.78 KiB upload / 83.67 KiB gzip), and `git diff --check` passes.

The audit of `workers/billing/src/index.ts` is still in progress. Internal routes, remaining checkout routes, webhook handling, role coverage, request bounds, provider failure semantics, and their caller graph remain to be reviewed.


## External revenue surcharge concurrency pass (2026-10-22)

Stress tests found that revenue-cut surcharge periods were marked pending only after the provider checkout had been created, and the SpaceDO update was unconditional. Concurrent requests could therefore create two payable checkout URLs for the same periods. Added a new SpaceDO migration for `pending_checkout_id`; period claims now validate a bounded unique month list and atomically claim all rows in one `transactionSync`. Same-checkout retries are idempotent, another checkout receives 409, and release only clears a matching checkout ID. Payment/refund paths clear both pending fields. The billing route claims before any provider request, returns a conflict if another checkout owns the periods, and releases only after a definite provider 4xx. It retains the claim after timeout/5xx/invalid response because the provider may have created a checkout despite the uncertain response.

Regression evidence: Spaces `external-revenue-tracking.test.ts` passes 13/13; Billing configured suite passes 85/85, including two concurrent checkout requests and provider 4xx-versus-5xx claim behavior. Spaces and Billing TypeScript checks pass; Billing dry-run passes (408.02 KiB / 83.91 KiB gzip); Spaces Wrangler dry-run passes (12,401.01 KiB / 2,041.00 KiB gzip); `git diff --check` passes. The two root-level regression files are now included in their worker Vitest configs.

Residual integration question: provider checkout URLs are not proven to expire within the 24-hour claim window. A still-payable old checkout might be used after its claim expires and a replacement is created. No provider API/deployment test was made. This remains open for provider expiry behavior or a webhook-backed checkout reconciliation design. `SpaceDO.ts` and Billing `index.ts` remain unchecked as whole files; this pass covers only the specific revenue-tracking and plan/payout slices.

## Billing checkout tenant-scope pass (2026-10-22)

Tracing internal checkout callers showed that the HMAC authenticated `x-naelao-tenant-id`, but several Billing routes independently looked up a requested `space_id` and then minted a second internal token for the space's actual tenant without checking it matched the original signed tenant. Added a tenant ownership check before space-bound commerce, seat, business subscription, credit pack, personal plan, wallet top-up, and revenue surcharge checkouts. Cross-tenant requests return a generic 404 before the Spaces service or payment provider is called. A regression covers a correctly signed tenant-A request targeting tenant-B's space and asserts no downstream request occurs.

Expanded the Billing worker test project to include its existing checkout route regression suites. The resulting Billing suite passed 111 tests across 16 files; Billing typecheck and diff check passed. These findings are scoped to the identified checkout routes; the full Billing worker remains open pending review of every handler and caller.

## Lemon Squeezy webhook delivery pass (2026-10-22)

Review of the generic webhook path found two event-loss cases. It resolved an *active* agent before running payment/refund/subscription accounting, then returned 200 for inactive spaces; accounting is now completed first, and inactive spaces return an explicit `agent_skipped` result afterward. Agent worker non-2xx/network failures were previously logged while the webhook returned 200, permanently dropping fulfillment. These now return 503 and remove the idempotency claim so the provider can retry; a failed active-space lookup follows the same retryable path. The side-effect suite relies on existing idempotent accounting operations for safe replay.

Regression suite `billing-fulfillment-project.test.ts` passes 27/27, covering order accounting on inactive spaces and an agent 503 releasing the webhook claim. The configured Billing worker suite passes 138 tests across 17 files; Billing typecheck and `git diff --check` pass. The full `workers/billing/src/lemon-squeezy.ts` review is still open; this pass covers its generic webhook dispatch path only. No live webhook/provider test was performed.

## Refund clawback retry pass (2026-10-22)

The order refund path set `launchpad_orders.status='refunded'` before its wallet debit and builder ledger reversal. If either failed, the webhook released its event claim, but a retry saw `refunded` and skipped the missing side effect. The status transition now occurs only after idempotent clawback and builder ledger operations succeed, so a retry can finish interrupted work. The non-order refund paths for wallet top-ups, credit packs, and surcharge periods also logged Space Worker failures and returned success; they now throw on failed downstream calls so the generic webhook retry path runs. Wallet-topup 402 remains an explicit non-retriable shortfall because a stored wallet cannot go negative.

Migration-backed regressions prove an order remains `paid` on the first debit 503, then retries to a successful debit and `refunded` status. Another test proves a non-order wallet-topup refund retries after a 503. Billing worker suite passes 154 tests across 19 files. The rest of refund semantics still need review, including partial-refund accounting and the behavior after a wallet 402 shortfall.

## Paid seat identity and activation pass (2026-10-22)

The seat checkout accepted an optional `user_id`, while webhook fulfillment substituted Lemon Squeezy's provider customer ID when the Naelao identity was absent. That could create a membership under a provider-scoped ID instead of a real user. Seat checkout now requires a bounded Naelao user ID, the reserved prebuilt defaults it from the host-resolved signed-in user (or accepts an explicit recipient), and webhook fulfillment never treats a provider ID as a Naelao identity. Legacy payments without the Naelao ID are still recorded but cannot auto-enroll; they need manual/agent fulfillment.

A second defect silently swallowed failed `/members` service responses. Seat activation now fails the webhook delivery on any non-2xx or network failure, releasing the idempotency claim so a retry can complete the activation. Regression covers the first 503 and successful retry. Billing passes 165 tests across 20 files and typecheck; Agents seat-operation tests pass 2/2 and Agents typecheck passes. Billing's configured test suite now also includes the internal-HMAC boundary file.

## Billing downstream binding and surcharge retry pass (2026-10-22)

A further dependency-failure review found money handlers that treated an unbound Spaces service as a benign no-op: sale/seat wallet settlement, credit-pack grants, personal-plan grants, wallet top-ups, surcharge settlement, and non-order refund clawbacks. These now fail the webhook and release its idempotency claim so a corrected deployment or retry can finish. A deliberately missing wallet project remains a permanent no-op, and wallet clawback 402 remains an explicit shortfall. Revenue-surcharge `mark-billed` failures now throw as well; previously a 503 was logged and acknowledged, leaving paid periods billable a second time. A regression verifies that a 503 while marking surcharge periods billed returns 500 and releases the event claim.

The Billing worker suite now passes 166 tests across 20 files; Billing typecheck and `git diff --check` pass. This does not resolve the 24-hour old-checkout expiry uncertainty recorded above.

## Billing webhook metadata, plan-state, and binding stress pass (2026-10-22)

Continuing the webhook path review found that recognized paid checkout kinds with missing metadata were returning `false` and being acknowledged as complete. Required identifiers, positive integer grant values, and surcharge period/charge arrays now validate; a malformed recognized event raises a retryable error and releases its idempotency claim. Missing event IDs on refunds and missing space IDs on space-bound paid/refund events fail closed. Internal Spaces request path identifiers in the reviewed webhook routes are encoded as individual path segments.

Plan-state stress cases found that `payment.failed` could map to `active`, and that refunds could re-enter the same plan upsert and restore paid access. Failed first payments now create no paid tier; failed renewals mark only an existing paid subscription `past_due`; platform-plan refunds no longer rewrite entitlements. Refund policy for platform/business plans is still undefined, and personal plans remain materially incomplete: monthly/yearly catalog intervals are granted into a tier-only ProductUserDO state with no expiry, subscription cancellation, or refund revoke. These are explicit open audit items in `docs/AUDIT_TODO.md`.

Both webhook endpoints also had an unrelated Agents-binding shortcut that returned 200 before processing money events. Platform-plan and Whop personal-plan events now run without Agents. Lemon Squeezy accounting runs before agent dispatch; an active-space event whose agent wake cannot be delivered returns retryable 503 and releases the idempotency claim. The Whop parser no longer interprets unrecognized signed events as successful payments. Enabling the Whop platform-plan suite exposed that its four owner-only route tests were stale and missing the forwarded owner role; updated them to match the current auth contract and registered the file in the Billing Vitest project, which had omitted it entirely.

Validation: Billing Worker suite passed 21 files / 183 tests; Billing Core passed 16 files / 56 tests; both package TypeScript checks passed; `git diff --check` passed. Tests use SQLite and service-binding stubs. No live Cloudflare deployment, Lemon Squeezy/Whop request, provider delivery retry, checkout expiry, or real DO concurrency was exercised. DNS rebinding remains unresolved. The inventory is still 2,051 tracked files / 1,843 source and executable-config extensions; checklist state remains 550 scoped reviews / 1,284 open rows out of 1,834, and the remaining file-by-file audit is not complete.

## Billing event identity and stale-state stress pass (2026-10-22)

The audit found two more webhook correctness defects. First, resource IDs are reused across distinct payloads, and the processed-event key previously used the resource ID plus normalized event type; repeated `subscription.updated` payloads could therefore be suppressed. Claims now use a SHA-256 fingerprint of the signed request body, while the provider resource/payment ID remains available for ledger joins and grant/clawback idempotency. A regression processes two changed `subscription.updated` payloads for one subscription and confirms an exact retry stays deduplicated.

Second, delayed payment failures could mark a newer plan delinquent. Platform plan updates now match the currently stored LS/Whop subscription ID and plan; business updates match the business, product, plan, and LS subscription ID. Whop's platform-plan parser had also used `plan_id` as a subscription ID; it now uses `membership_id` for payment events and the membership resource ID for membership lifecycle events. A paid seat/product event with a missing space row no longer gets silently acknowledged; it returns a retryable failure and releases the body claim.

Validation at that stage: full Turbo test run passed 57/57 tasks; the root shared suite passed 368 files / 3,841 tests. Billing Worker passed 21 files / 188 tests, Billing Core passed 16 files / 56 tests, and both package typechecks passed. Router's 12 files / 67 tests and typecheck passed earlier in this continuation. `git diff --check` passed. No Cloudflare deployment, provider API/webhook, external load, or real distributed concurrency test was performed.

Remaining related risks: provider event ordering is not proven and the processed webhook table has no cleanup/retention strategy; platform/business refund policy remains open; personal monthly/yearly plan entitlement still has no expiry/revocation lifecycle; surcharge checkout URL expiry is unverified. DNS rebinding remains an infrastructure gap. The refreshed file checklist records 610 scoped reviews / 1,233 open files out of 1,843; the whole audit is not complete.

The next pass traced refund attribution through `reseller_ledger` and found that the unique
`provider_event_id` stored the same order resource ID for the positive sale and negative refund.
The refund's negative calculation was silently discarded by `INSERT OR IGNORE`, leaving the
reseller margin overstated. Ledger event IDs now include the normalized event type; migration-backed
coverage records both sale and refund rows and verifies their referral margins net to zero. Billing
Worker passed 21 files / 189 tests, the focused migration-backed wallet/refund file passed 14/14,
Billing TypeScript passed, and the final Billing Wrangler dry run bundled at 415.56 KiB (85.23 KiB gzip).
The final full Turbo rerun passed 57/57 tasks and 368 files / 3,842 root tests. The broader Billing
review and repository audit remain open.

The next pass closed the indefinite-expiry path for new personal-plan purchases. Monthly/yearly
catalog interval now travels in Whop and Lemon Squeezy checkout metadata. ProductUserDO migration 5
records each paid period with provider event identity, amount, subscription identity, calendar start
and expiry, and refund/expiry status. Renewals extend from the latest paid-through timestamp;
duplicates are idempotent; cancellation and failed payment keep prepaid access through expiry; full
refunds revoke only the matching purchase when an explicit refund amount is supplied, partial refunds
retain it; and stale expiry events cannot remove a later period. Existing tier-only grants remain readable until the user makes a new paid
purchase, which clears the indefinite legacy fallback rather than silently cutting off current
users.

Stress validation passed for ProductUserDO month-end/expiry/renewal/refund scenarios, including 64
concurrent duplicate deliveries. After adding checkout-to-ledger route assertions, all five focused
personal-plan, Spaces catalog, and Lemon Squeezy parser suites passed 67 tests. Spaces/Billing typechecks
passed. The targeted workspace Vitest launcher initially attempted a dependency reinstall and was
blocked by minimum-release-age checks on three packages published on 2026-10-22; the existing lockfile
was installed frozen through pnpm directly without changing the lockfile, then the scoped suites ran.
Whop refund and explicit expiry event shapes remain unverified, the actual Lemon Squeezy partial
refund amount field/units need provider confirmation, legacy grants need reconciliation, and
entitlement-row retention is not implemented. The full repository audit is still open.

The post-change whole-workspace validation then passed: `turbo run test --concurrency=8` completed
57/57 tasks, with 368/368 root test files and 3,845/3,845 root tests passing. The Spaces suite passed
69 files / 276 tests, Billing 21 files / 189 tests, and Billing Core 16 files / 58 tests; all 57
workspace typecheck tasks passed. A preceding full run exposed a 5-second timeout on the 6 MiB
multipart-resume test only under workspace contention; it passed in isolation, so its timeout is now
15 seconds. The first full test invocation had omitted the configured Python executable from PATH,
which caused four SQLite-backed vault-plan failures; rerunning with the normal PATH passed those
tests and the entire suite.

The DNS rebinding gap is now an explicit open audit item: bounded DoH validation and per-hop or
call-time checks do not pin the address used by Workers `fetch()` or the browser connection. We must
select and validate a production-supported pinned egress transport before calling this closed. The
audit checklist still has 1,233 unchecked source/config rows; no live deployment or external provider
tests were performed.

## 2026-10-22 — pinned egress transport prototype stress pass

Added a socket-injected, bounded HTTP/1.1 fetch helper to `@naelao/security`. It resolves A/AAAA
answers, rejects any private answer, dials a literal validated IP, checks the reported peer address
when available, verifies TLS against the URL hostname, refuses redirects, and caps request/response
bodies and headers. It rejects ambiguous/unsupported transfer framing and non-identity content
encoding. The helper currently supports ports 80 and 443 only and has no Cloudflare socket adapter;
no production Worker calls it, so DNS rebinding remains unresolved. The browser worker uses
Chromium-owned sockets and will need an egress proxy or network policy.

Stress validation: the security package passed 22 files / 124 tests, including 128 concurrent
fragmented responses, byte-by-byte HTTP/chunk framing, oversized streamed request and response
bodies, mixed public/private DNS answers, peer mismatch, malformed framing, encoded responses,
redirect refusal, and pre-aborted requests. Security package TypeScript passed; the migration-backed
MCP SSRF integration suite passed 11/11. No Cloudflare socket runtime, real DNS service, outbound
provider, or deployment was exercised. The repository audit checklist remains 1,233 open source/config
rows; this is a scoped helper review, not completion of the outbound security finding or full audit.

Follow-up workspace regression validation after the helper export passed `turbo run test --concurrency=8`: 57/57 tasks, 368/368 root test files, and 3,846/3,846 root tests. The full workspace TypeScript check passed 74/74 tasks. These runs validate repository compatibility with the unused helper export; they do not establish production socket or egress behavior.

## 2026-10-22 — shared types and quiet-hours edge review

Reviewed the `@naelao/types` manifest, TypeScript config, shared exports, and quiet-hours tests/callers in Spaces, Agents, and the dashboard. `isWithinScheduledQuietHours()` passed arbitrary `now` directly into `Intl.DateTimeFormat.formatToParts()`, so NaN, infinity, or an out-of-range timestamp could throw during scheduled-job filtering. It now returns false for non-finite and invalid Date values. Added inclusive-start/exclusive-end, invalid-window, invalid-timezone, and invalid-clock regressions. The type package had wildcard TypeScript and Workers Types development dependencies; these now use the bounded repository ranges and the lockfile importer was updated without changing resolved package versions. Focused tests passed 8/8 and package TypeScript passed.

Dependency review found that other packages still have wildcard TypeScript/Workers Types ranges, and lockfile-only resolution reports Wrangler 4.149.0 expects Workers Types v5 while the repository resolves v4.20260623.1. This needs a workspace-wide compatibility pass; recorded open in `docs/AUDIT_TODO.md`. Package-local scoped review is complete, while the broader export usage and compatibility review remains open.

Final validation after the quiet-hours guard and package-range changes passed again: workspace Turbo tests completed 57/57 tasks and 3,846/3,846 root tests (368 test files); the complete workspace TypeScript run passed 74/74 tasks. `git diff --check` is clean. No Workers deployment, pinned-socket runtime test, DNS fault-injection against a live resolver, or external-provider test was performed. The exhaustive checklist and production egress gap remain open.

The tracked inventory has been refreshed at code commit `c0271948`: 2,053 tracked files, 1,845 source/config files, 616 scoped reviews, and 1,229 open checklist rows. The audit remains far from complete; the full file-by-file and runtime review continues.

## 2026-10-22 — shared UI controls scoped audit

The next package review found several accessibility and input-boundary defects: `Toggle` allowed an unnamed switch (two real shell call sites were unnamed), toast content had no live announcement, sidebar/Space switcher div controls were partly mouse-only, the modal lacked dialog labeling/Escape and focus lifecycle, and `qrSvg()` accepted negative, fractional, non-finite, or excessive quiet-zone values. Toggle now requires a label and both shell call sites provide one; toast has polite status semantics; sidebar/switcher controls respond to Enter and Space; the modal has labelled dialog semantics, Escape, initial focus, focus restoration, and Tab cycling; QR SVG quiet zones are limited to 4..32 modules. The UI package now has an explicit Vitest task/config so its component tests participate in workspace runs. Its TypeScript range was bounded to match the workspace range.

Validation: UI package suite passed 5 files / 34 tests, including QR boundary inputs, modal SSR semantics, accessible labels/live region, and keyboard helper activation; UI package and Shell TypeScript checks passed. Browser DOM keyboard/focus interaction is not available in this test environment and remains open, along with full CSS, responsive, contrast, theme and screen-reader review. Only the scoped changed UI files are being marked complete; the rest of `packages/ui` and the shell remain pending.

Final workspace validation after the UI tranche passed: Turbo tests completed 58/58 tasks, with 368 root test files / 3,853 root tests and the UI package's additional 5 files / 34 tests. Workspace TypeScript passed 74/74 tasks. The newly added UI package test target is now exercised in the normal workspace run. This still does not include browser automation or live deployment validation.

## 2026-10-22 — inventory classifier and theme edge follow-up

The file inventory classifier omitted CSS, preprocessors, HTML/templates, Dockerfile/Containerfile, Makefile-style files, and several common source/config extensions. Updated `work/refresh_naelao_inventory.py` to enumerate those tracked runtime/deployment sources; the refreshed checklist grows from 1,850 to 1,872 source/config rows before the newly added theme test is counted. New rows start unchecked. This corrects the audit scope, not the audit status.

Further UI review found `useTheme()` trusted localStorage as a ThemeMode and assumed matchMedia/storage access always works. Invalid stored values now fall back to `system`; unavailable browser storage no longer prevents the current page theme from changing; missing `matchMedia` defaults system preference to light. The UI package passed 6 files / 43 tests, the full workspace passed 58/58 tasks with 3,853 root tests plus the UI package suite, and workspace TypeScript passed 74/74 tasks. Modal/browser focus behavior and full styles/theme review remain open.

The regenerated checklist after extension expansion and scoped UI review records 2,059 tracked files / 1,873 source and executable-configuration files, with 643 checked and 1,230 open. It now includes CSS/templates and Dockerfile/Makefile-style sources that the former filter missed. The exhaustive repository audit, live egress mitigation, and browser-level UI testing remain open.

## 2026-10-22 — shared UI styles and theme tokens

Reviewed `packages/ui/src/styles.css` and `tokens.css` against the shared UI components and shell import path. The light-theme `--text3` color had 2.52:1 contrast against the page background and 2.77:1 on white surfaces; dark-theme muted text was 2.14:1 against the primary dark surface. The system-dark CSS fallback also retained the light theme's muted color. Updated muted text to meet 4.5:1 contrast in explicit light, explicit dark, and system-dark fallback themes, and added a CSS-token regression test. Added a shared `:focus-visible` indicator, reduced-motion overrides, and `100dvh` sizing with `100vh` fallback for mobile app and modal layout.

Validation: the UI package suite passed 7 files / 46 tests, including all three theme contrast cases; UI and Shell TypeScript checks passed; `git diff --check` passed. A headless Chromium style check was attempted but Chromium did not complete its `--dump-dom` run before the environment timeout. Real browser viewport, responsive overflow, focus cycle, screen-reader, and full contrast checks remain open. This CSS/token slice does not close the broader UI accessibility finding or the full repository audit.

The inventory refreshed at code commit `d5b6fd94` records 2,060 tracked files and 1,874 source/config files; the scoped checklist now records 646 reviews with 1,228 files still open. The full audit remains open.

Reviewed `apps/dashboard/next.config.mjs`: the only framework setting enables React strict mode; Cloudflare's `setupDevPlatform()` runs only when `NODE_ENV` is development. Staging and production deployment workflows invoke `next-on-pages` separately. `node --check` and the dashboard TypeScript check passed. No dashboard route behavior was included in this config-only scope; the app routes, auth client, and package/deployment setup remain open.

## 2026-10-22 — dashboard auth and API path boundaries

Dashboard JWT display decoding previously cast arbitrary JSON to claims, accepted malformed/missing expiration data as unexpired, and allowed blocked `localStorage` operations to throw during hydration and requests. The auth helpers now validate the claim shape and finite expiration, treat non-finite expiration as expired, and tolerate storage denial. Login and registration reject malformed or expired token responses before updating UI state. Client-side decoding remains display state only; the router's signature verification is authoritative.

The API wrapper also interpolated dynamic IDs into several route paths without encoding. Added one segment encoder and applied it across dynamic path identifiers; empty IDs and exact `.` / `..` path segments reject before fetch. Regression coverage verifies encoded slash/space behavior and that dot segments produce no request. Validation: dashboard auth and path suites passed 13/13, dashboard TypeScript passed, and `git diff --check` passed. The broad 77-call API wrapper, backend route/permission pairing, deployed API URL variables, and React/browser auth hydration behavior remain open.

After commit `c6aacb45`, the tracked inventory contains 2,062 files and 1,876 source/config files. The file-by-file list records 651 scoped reviews and 1,225 open rows. The API wrapper is intentionally still open for its route-by-route contract pass; no audit completion is claimed.

Reviewed the product-shell URL helper against `create-space.ts`'s server slug validator and its wizard, product-list, and product-detail callers. It previously appended the slug without validation and trusted a configured URL as an arbitrary string. It now mirrors the backend slug rule, encodes the route segment, accepts only clean HTTPS origins in deployed builds (HTTP only in development), and defaults local development to the shell's actual dev port 3100. Its tests initially exposed a trailing-slash origin normalization bug in the new check; that was corrected and the focused suite now passes 2/2. Dashboard typecheck passes. The deployment workflows do not set `NEXT_PUBLIC_SHELL_URL`, so non-production product-link destinations remain an open deployment configuration item rather than an assumed safe value.

Inventory refreshed at code commit `d73daf52`: 2,063 tracked files / 1,877 source and executable-config files, with 653 scoped reviews and 1,224 open checklist rows.

Reviewed dashboard login, reset-password, and root layout behavior. Login previously navigated from render and form labels were not programmatically attached to controls; errors were not announced. Redirect now runs in an effect, controls have associated labels, and errors use alert semantics. Newly issued reset links now place single-use credentials in URL fragments rather than query strings. The client captures the fragment and removes it from history before sending the reset POST; legacy query links continue to work during transition. Root metadata emits `no-referrer`, confirmed in the built `/login` HTML. The auth worker reset suite passed 32/32, dashboard focused suites passed 15/15, dashboard typecheck passed, and the Cloudflare Pages build completed with all 36 routes. The build required a follow-up missing `useEffect` import caught by the first build run. Vercel CLI could not fetch npm dist-tags through this environment's proxy, but completed the build with installed dependencies. Browser history and live referrer behavior remain unverified.

Dashboard subscription display review found that both the overview card and header read `plan_tier` from `NaelaoJwtClaims`, although the auth service returns the plan beside the JWT and does not sign it into claims. This made every account display `free`. Auth context now carries the login/register response's plan and refreshes mutable subscription state from the authenticated billing endpoint after hydration; the UI uses a checking label until it has a server response. Focused dashboard/auth/router tests passed 69/69, dashboard TypeScript passed, and the Cloudflare Pages production build completed. Browser session-state behavior and a live subscription API call remain untested.

Dashboard API client subpass: verified that all dynamic URL path identifiers in the client now go through the shared segment encoder; `apiFetch` previously cast `RequestInit.headers` to a plain record and added JSON Content-Type to every request. It now uses the standard `Headers` constructor, preserves caller headers, and adds JSON content type only when a string body is supplied. Authenticated cross-origin requests still preflight due to Authorization; the change only avoids a needless header and can keep unauthenticated public reads simple. Triple-checked that `createSpaceType`, `getSpaceType`, and `updateSpaceType` had no callers and targeted the removed `/spacetypes` CRUD routes; removed those methods and their orphaned input type. Corrected the stale API-key comment because `/builder/api-keys` is implemented. Dashboard client/auth/link suites passed 17/17, dashboard TypeScript passed, and the Cloudflare Pages production build passed (all 36 routes). Full route/response/error/permission mapping for the dashboard's API wrapper remains open.

Reviewed the dashboard product pause/delete flow against `workers/spaces`' owner-scoped soft-delete route and its existing deletion/reuse tests. The delete dialog previously had no alert-dialog semantics, associated input label, Escape handling, keyboard focus containment, or focus restoration. It now provides those behaviors, blocks backdrop/Escape dismissal while busy, disables typing during the request, and exposes busy state. Static-render accessibility regression passed; the existing builder dashboard API suite plus the new dialog test passed 35/35, dashboard TypeScript passed, and the Cloudflare Pages build completed. Dynamic browser focus behavior remains unverified and stays open in the UI browser checklist.

Inventory refreshed at code commit `aea6713d`: 2,064 tracked files / 1,878 source/config files; 661 scoped reviews and 1,217 open rows.

Reviewed the API-key dashboard flow against `BuilderAccountDO`'s allowed scope set, 80-character name cap, 1–3,650-day expiry range, max-key behavior, and one-time raw-key response. The client used `parseInt`, silently converting fractional days, allowed repeated create clicks (risking orphaned unviewable keys), and swallowed API/clipboard errors. It now validates whole-day bounds without truncation, serializes create/revoke actions, prevents minting another key until the last raw key is dismissed, and exposes errors with manual-copy guidance. Regression validation passed 41/41 across expiry boundary and builder API tests; dashboard TypeScript and the Pages build passed. Clipboard behavior needs a secure browser permission test.

## 2026-10-23 — reseller portfolio authorization and stress limits

Continued the dashboard-to-spaces route trace for reseller client management. Portfolio, billing statement, client detail, status, and irreversible promotion routes previously trusted a tenant header without requiring an owner/admin role; all five now reject viewer/editor roles with 403. The client list's 200-row cap silently hid additional tenants, so the API now provides deterministic 100-row pages with the full portfolio count, and the dashboard has previous/next controls. Successful promotion now closes the drawer rather than refetching a relationship it just detached. The drawer and table controls now support keyboard operation and accessible names, dialog semantics, focus containment/restoration, and stale request suppression.

Promotion had two separate D1 writes and could leave the hierarchy terminated while spaces still retained reseller lineage. They now execute in one atomic D1 batch. Malformed status/promotion JSON is validated as a client error. SQLite-backed tests verify rollback when the space update fails, successful detachment, viewer role denial across read/billing/write routes, malformed/missing confirmation, 205 clients across all pages without duplicates, and malformed page values. Focused unit suites passed 19/19 before adding the API pagination URL assertion; dashboard and spaces typechecks passed before the final client-page race guard/table semantics edits.

Validation environment issue: running `next-on-pages` delegated to Vercel, whose install failed the configured pnpm minimum-release-age policy for three already-locked browser-data packages released on 2026-10-22. The failed install removed workspace `node_modules`; I did not bypass the supply-chain age policy. The post-edit dashboard production build and the final added API URL assertion are consequently pending dependency availability. No live deployment or Cloudflare environment was exercised. The full source audit remains open.

The refreshed inventory now records 2,066 tracked files and 1,880 source/config rows; 665 scoped rows are reviewed and 1,215 remain open. `apps/dashboard/src/app/dashboard/clients/page.tsx`, `apps/dashboard/src/lib/api-key-form.ts`, and `tests/unit/dashboard-api-key-form.test.ts` are marked scoped-reviewed. The API wrapper remains open for its complete route/response/permission pass even though its reseller pagination call was covered in this subpass. No overall audit-completion claim is made.

## 2026-10-23 — builder product portfolio cap

The next dashboard source review found a second hard limit: `GET /builder/products` returned only 200 rows with no total, making older products disappear from the portfolio page. Added input validation, deterministic ordering, count/page metadata, and 200-row pages; updated the product dashboard to navigate pages, announce ranges, and discard stale overlapping list responses. The API helper used by the shared shell layout remains backward-compatible, so the product switcher still has the historical first-200 limitation; that separate navigation gap is now explicit in the audit TODO.

Added a SQLite-backed 205-product stress test for page sizes, totals, uniqueness, invalid fractional input, and out-of-range pages, plus an API URL pagination regression. These tests could not run because the previous Cloudflare Pages CLI attempt removed `node_modules`, and the current pnpm install refuses three locked browser-data package versions under its one-day minimum-release-age policy. The lockfile and policy remain untouched. `git diff --check` is still available; production build and current typechecks remain pending. The overall audit remains open.

## 2026-10-23 — product launch wizard and address reachability

The launch wizard audit found several late-failure paths: step validation accepted a slug the server would reject, numeric cents/credit/trial fields accepted fractions and unsafe values, inactive pricing mode values were still serialized, and a punctuation-only name could create a live product with no reachable address. Server slug lookup errors also degraded to slugless creation. The wizard now matches backend slug boundaries, checks printable name length and safe whole-number pricing, submits only the selected pricing mode, and requires an explicit slug when a name has no usable base. `createSpaceRecord` fails closed on missing/unavailable slug derivation and returns the actual slug; both `/spaces` and `/builder/products` responses now include it. The product POST body is bounded to 64 KiB and malformed/non-object bodies are rejected. A launch guard suppresses repeat submissions after a successful server commit. Domain configuration failures now route to domain settings with a clear retry notice, and the domain page distinguishes failed status loads from an unconfigured domain so it does not invite an unsafe overwrite. Wizard inputs/choice groups/stepper, validation errors, and template-load retry now carry accessible semantics and focus feedback.

Call-graph review also confirmed `BuilderAccountDO`'s 500-entry product index had no reader: its only writer was the create route, while `GET /builder/products` already reads authoritative tenant-owned D1 rows. Removed that redundant DO storage/API and its unused route call; existing Durable Object metadata is left in place and no longer read. Updated the stale test description that claimed the D1 list came from the DO.

Added regression coverage for wizard number/slug helpers, unreachable names, DB slug-check failure, returned derived slug, malformed/oversized create bodies to follow, and large product pagination. The relevant pre-existing test suites passed before the latest code tranche; the new and updated tests could not run because the Vercel Pages build's dependency install cleared `node_modules` and pnpm's 24-hour release-age gate blocks three committed browser-data package versions. I did not relax that supply-chain policy. This tranche remains code-reviewed but awaits typecheck, full focused tests, and production build. Open follow-ups now explicitly cover nested product-config validation and durable request idempotency. The whole audit remains open.

Inventory at this point: 2,067 tracked files / 1,881 source and executable-config rows; 678 rows have scoped reviews and 1,203 remain open. Node's built-in TypeScript parser accepted all changed `.ts` files and `git diff --check` passed. This is syntax-only evidence; React TSX typechecking, unit execution, and production build are still pending while the package manager blocks dependency installation.

## 2026-10-23 — Launchpad singleton and Spaces route regression audit

Resumed from the open whole-repository audit. The first configured Launchpad API run exposed outdated tests that still modeled the prior multi-tenant builder product-creation and reseller-dashboard UI. Updated the fixture to identify the Naelao dashboard tenant and replaced those expectations with the current team-only singleton contract: custom product creation is denied, non-team creation is denied, the root cannot be deleted, and reseller controls are unavailable for the internal Launchpad product. Added a concurrent first-launch stress case and verified two racing requests leave exactly one root (one 201, one 409).

Validation: Spaces worker suite passed 69 files / 276 tests; its TypeScript check passed. Focused builder dashboard, shared creation, hierarchy, request-boundary, and business-creation tests passed 80/80; `git diff --check` passed. The suite change repairs stale assumptions and adds concurrency coverage; it is not a complete audit of `builder-routes.ts` or related APIs.

Still open: the whole-repository source/config checklist, root-harness failure triage, route-by-route request/response and permission mapping, nested product-config validation review, remaining response/state/archive audits, DNS rebinding mitigation, package/framework advisories, full deployment wiring and live Cloudflare/provider acceptance. No live deployment or external provider was exercised. Do not treat this slice as completion of the Naelao audit.

### Follow-up — nested product configuration boundary

A field-level review of `PATCH /builder/products/:id` found that the route relied on erased TypeScript types after parsing JSON. Runtime arrays or strings could be persisted as nested product configuration objects; model-policy lists also had no explicit count or per-ID length bound. The route now rejects non-object `product_config`/`legal`, malformed `modelConfig`, invalid compliance booleans, malformed model policies, more than 100 allowed model IDs, and IDs longer than 256 characters. JSON syntax errors return 400. Tests assert malformed payloads do not mutate the saved Launchpad configuration.

Validation after the change: the focused builder API, shared creation, hierarchy, request-boundary, and business-creation suites passed 82/82; the full Spaces worker suite passed 69 files / 276 tests; Spaces TypeScript check and `git diff --check` passed. Remaining config work includes reviewing every other persisted product-config field and the UI/backend field contract; this is a bounded partial validation, not a complete schema audit.

### Workspace stress-run harness result — 2026-10-23

Attempted `corepack pnpm test` and then serialized Turbo with `corepack pnpm exec turbo run test --concurrency=1`. Both stop before a complete workspace test run: Turbo invokes the managed fallback `pnpm install`; the first run interrupted child installs and the serialized run reports `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` while trying to remove `node_modules`. This is a test harness/environment blocker, not a passing root suite. Running the Spaces worker directly still passes all 69 files / 276 tests; the database package direct run passes 3 files / 13 tests. Fix the workspace test invocation/install guard, then rerun the full matrix and triage all package failures. No dependency install or node_modules removal was performed by hand.


## 2026-10-23 — full workspace stress suite recovered and rerun

Replaced the stale workspace invocation that let Turbo call an incompatible system `pnpm` and trigger an install with a temporary `/tmp` shim that dispatches package-manager calls through the repository-pinned Corepack pnpm 9.12.0. No repository package-manager policy or lockfile was changed. The complete workspace test matrix now runs to completion: Turbo 58/58 tasks; shared tests 373 files / 3,880 tests; Agents 165 / 749; Spaces 69 / 276; Billing 21 / 189; Router 12 / 67; all other package/worker suites passed as part of the same run. Workspace TypeScript passed 74/74 tasks.

This exposed stale shared fixtures left behind by the dashboard consolidation: product-wizard tests imported a deleted generic wizard module, product tests assumed arbitrary multi-product creation, reseller tests omitted the required owner role, and two suites did not configure the singleton dashboard tenant. Updated the contract tests and removed the obsolete wizard-helper test whose source module no longer exists. The conversation-access isolation fixture now creates its second legacy space directly in SQLite after asserting the public singleton route returns 409, so the security assertion remains meaningful without reintroducing multi-product creation. Focused tests pass for all changed suites; the full workspace run above also passed.

This is a substantial test-harness and regression-coverage closure, not completion of the repository audit. The scoped file checklist is still the authority for review coverage (last refreshed: 678 scoped rows, 1,203 open of 1,881 source/config files). High-impact open audit items remain: DNS rebinding without a deployed connection-pinned egress path; verified provider refund/expiry payloads and subscription event ordering; webhook/idempotency retention that preserves replay protection; platform/business refund policy; checkout expiry reconciliation; production dependency/framework compatibility; route-by-route review of the remaining 1,203 files; and live Cloudflare/provider deployment acceptance. No external provider test or live deployment was performed.


### Additional billing ordering finding from the next code pass

While reconciling remaining webhook gaps against the current implementation, traced platform and business subscription updates beyond the prior payment-failure guard. `payment.failed` is constrained to the currently stored provider subscription ID, but ordinary `subscription.*` events upsert the lifecycle row without the same identity/version condition. A delayed `subscription.expired` or `subscription.cancelled` event from a replaced subscription can therefore overwrite current access; for platform plans an expired stale event can set `orgs.plan_tier` to `free`. Recorded this as a concrete unresolved security/correctness item in `docs/AUDIT_TODO.md`; it needs an explicit replacement policy plus a provider-guaranteed monotonic ordering key, not a guessed timestamp. No provider event-ordering guarantee or live payload has been verified.
