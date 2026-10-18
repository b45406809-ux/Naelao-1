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

## Broader validation

| Check | Result | Evidence / limitation |
|---|---|---|
| Configured package/worker Vitest workspace | Passed: 226 test files, 960 tests, with webhook, idempotency, sweeper, and auth projects registered | `node_modules/.bin/vitest run --workspace vitest.workspace.ts` |
| Root TypeScript projects | Passed | `tsc --noEmit -p packages/agent-sdk/tsconfig.json` and `tsc --noEmit -p workers/agents/tsconfig.json` |
| Follow-up TypeScript projects | Passed | `packages/auth`, `packages/security`, and `workers/knowledge` |
| Follow-up focused Biome check | Passed: 6 files | JWT/SSRF source and their focused tests/route fixtures |
| Root Vitest config (`tests/vitest.config.ts`) | Incomplete; surfaced failures, then stalled during shutdown and was interrupted without aggregate totals | Failures included stale R2 `bucket.head` stubs, incomplete SQLite schemas, test fixtures returning 403/500, outdated runtime assertions, and several prompt/loop expectations. These were not triaged as a complete baseline comparison, so treat them as open audit findings rather than proven pre-existing defects. |
| Biome on changed files | Failed with 124 diagnostics across 19 files; the three new worker-capability/transcript files pass a focused check after formatting | Remaining diagnostics include non-null assertions, formatting, and other style issues across the changed files. They were not mass-fixed because this would reformat unrelated surrounding code. |

Before validation, the pnpm 11 install tool rewrote lockfile patch metadata and added an ignored-build policy block. Both repository files were restored to their original committed contents after dependencies installed. `node_modules` is ignored. `git diff --check` is run before commit.

## Not yet reviewed

This is still a partial audit. DNS verification and the later Workers `fetch()` are separate resolutions, so a hostile hostname can theoretically rebind between the SSRF check and socket connection. Preventing that race needs an egress proxy or a runtime API that pins the verified address; this pass does not claim to eliminate it. Other SSRF consumers (including browser and MCP call-time networking), shared foundations, non-focused worker routes/DOs/container paths, runtime deployment wiring, and indirect/dynamic dispatch remain to be reviewed. The root Vitest failures need triage by owner and a clean baseline run. No legacy file deletion has been authorized by evidence; none was deleted in this pass.
