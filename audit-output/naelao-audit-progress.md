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

## Broader validation

| Check | Result | Evidence / limitation |
|---|---|---|
| Configured package/worker Vitest workspace | Passed: 217 test files, 884 tests | `node_modules/.bin/vitest run --workspace vitest.workspace.ts` |
| Root TypeScript projects | Passed | `tsc --noEmit -p packages/agent-sdk/tsconfig.json` and `tsc --noEmit -p workers/agents/tsconfig.json` |
| Follow-up TypeScript projects | Passed | `packages/auth`, `packages/security`, and `workers/knowledge` |
| Follow-up focused Biome check | Passed: 6 files | JWT/SSRF source and their focused tests/route fixtures |
| Root Vitest config (`tests/vitest.config.ts`) | Incomplete; surfaced failures, then stalled during shutdown and was interrupted without aggregate totals | Failures included stale R2 `bucket.head` stubs, incomplete SQLite schemas, test fixtures returning 403/500, outdated runtime assertions, and several prompt/loop expectations. These were not triaged as a complete baseline comparison, so treat them as open audit findings rather than proven pre-existing defects. |
| Biome on changed files | Failed with 124 diagnostics across 19 files; the three new worker-capability/transcript files pass a focused check after formatting | Remaining diagnostics include non-null assertions, formatting, and other style issues across the changed files. They were not mass-fixed because this would reformat unrelated surrounding code. |

Before validation, the pnpm 11 install tool rewrote lockfile patch metadata and added an ignored-build policy block. Both repository files were restored to their original committed contents after dependencies installed. `node_modules` is ignored. `git diff --check` is run before commit.

## Not yet reviewed

This is still a partial audit. DNS verification and the later Workers `fetch()` are separate resolutions, so a hostile hostname can theoretically rebind between the SSRF check and socket connection. Preventing that race needs an egress proxy or a runtime API that pins the verified address; this pass does not claim to eliminate it. Other SSRF consumers (including browser and MCP call-time networking), shared foundations, non-focused worker routes/DOs/container paths, runtime deployment wiring, and indirect/dynamic dispatch remain to be reviewed. The root Vitest failures need triage by owner and a clean baseline run. No legacy file deletion has been authorized by evidence; none was deleted in this pass.
