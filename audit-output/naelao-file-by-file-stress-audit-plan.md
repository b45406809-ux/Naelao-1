# Naelao file-by-file stress and security audit plan

Inventory root: `/workspace/Naelao-1`
Inventory basis: `2067` tracked files; `1881` files with source or executable-configuration extensions, matching `naelao-repository-tree.txt` at code commit `1dbe121f`.
Status: only files with checked boxes have a completed scoped review recorded in the audit ledger. This plan and inventory are not evidence that the remaining listed files have been reviewed.

## Audit state (2026-10-22)

- The refreshed source/config checklist records **663 scoped reviews / 1,217 open files** out of 1,880. Newly included style, template, and container/build files remain unaudited unless individually checked.
- The latest full Turbo run before the current style-token slice passed 58 tasks, 368 root test files, and 3,853 root tests; the UI package added 6 test files / 43 tests. Workspace TypeScript passed 74/74 tasks. The current style-token slice separately passed the UI suite (7 files / 46 tests) and UI/Shell typechecks. Earlier Marketplace response-privacy and request-size changes passed the migration-backed route suite (3 tests), TypeScript, and Wrangler dry run. Knowledge (64 tests) and Browser Worker (4 files / 9 tests) also passed focused suites with Worker typechecks/builds.
- Latest production dependency audit: 49 advisory records (4 critical, 11 high, 29 moderate, 5 low). All critical/high production findings trace to `next@14.2.18`; Pages adapter migration remains open.
- Latest full dependency audit: 74 records (4 critical, 19 high, 42 moderate, 9 low). Remaining high build-tool findings include `undici@5`, `extract-zip@2.0.1`, `braces@3.0.3`, `basic-ftp`, and `@fastify/busboy`.
- DNS rebinding remains unresolved because the Workers fetch path cannot pin the address that passed validation. No live Cloudflare deployment or external-provider test has been performed.
- The experimental `packages/security/src/pinned-fetch.ts` helper has a bounded HTTP/1.1 socket implementation and unit stress coverage, but no Worker caller uses it yet. This is not a DNS rebinding mitigation in production; caller migration, a Cloudflare socket adapter, runtime compatibility, and all other egress surfaces remain open.
- Shared UI component code and the scoped styles/theme-token source pass are recorded. CSS token tests cover muted-text contrast in explicit light/dark and system-dark fallback; browser layout, responsive overflow, full component contrast, focus-cycle, screen-reader, and nested-modal validation remain open.

## Review contract

Use the companion [platform surface inventory](naelao-platform-surface-inventory.md) for the discovered worker manifests, Durable Object declarations, literal API route registrations, and container bindings; confirm these against deployment configuration and indirect dispatch during phase 2.

Review each checklist file with its callers, callees, owning worker, route registration, runtime bindings, and relevant tests. Record reviewer/date, exercised boundary cases, evidence, findings, and disposition in a per-file audit ledger before checking an item. Treat tests as evidence only for the cases they cover. Do not claim “no bugs” from a clean test run.

## Latest scoped validation (2026-10-21)

- `workers/spaces`: full worker suite passed, 65 test files / 255 tests; TypeScript check passed. Staging and production Wrangler dry runs passed after correcting trigger table syntax.
- `workers/router`: full worker suite passed, 10 test files / 49 tests; TypeScript check passed. Three routing tests initially lacked the `PLATFORM_DB` fixture now required by the tenant suspension gate; the fixtures were updated and the full suite passed.
- `workers/agents`: full worker suite passed, 154 test files / 705 tests; TypeScript check passed. This includes conversation pagination/compaction, tool result bounds, delegation, worker execution, and container tests.
- `workers/knowledge`: full worker suite passed, 10 test files / 62 tests; TypeScript check passed.
- Erasure and legacy space API coverage: 47 focused root tests passed across `product-user-erasure`, `builder-dashboard-api`, and `data-erasure-records`; all workflow test files passed, 3 files / 22 tests. TOML parsing and `git diff --check` passed.
- Repository-wide CI test scopes passed on 2026-10-21: the root unit/integration configuration passed 2,009 suites / 5,414 tests; the Vitest worker/package workspace passed 778 suites / 1,678 tests; native Node checks passed 27 tests; and conformance passed 4 tests. The root run exposed stale test fixtures for the active-tenant and space-suspension schema, plus an obsolete conversation-search page-size assertion. Fixtures now include the relevant current schema/tenant state, and the conversation search test now checks the 500-message bounded page contract; its explicit cursor-pagination cases remain separately covered. All 109 affected regression tests passed after these updates.
- The recursive TypeScript check passed for all 63 workspace projects with workspace concurrency limited to 2. The unconstrained parallel invocation exceeded this environment's memory limit (exit 137); rerunning at low concurrency completed cleanly. CI now uses the proven concurrency limit of 2. That pass found and fixed a Sweeper test type mismatch between the Cloudflare `URL` type and Node `readFileSync`; the Sweeper test file passed 10/10 afterward.
- Workspace build validation completed 50 tasks before stopping at the Agents worker's container dry run: Wrangler could not pull `node:22-slim` because Docker Hub DNS/network access is unavailable in this environment. The remaining Agents container image build and any downstream tasks need CI or a Docker-enabled environment. Earlier build tasks compiled and dry-ran successfully; the full build is not marked passed.
- **HTML preview XSS boundary:** repository lint identified unsafe HTML insertion in DOCX preview and inline SVG QR rendering. DOCX output now renders in a sandboxed iframe with a restrictive CSP; interactive previews allow only a random-nonce inspector script and require messages to come from a registered inspector frame with bounded fields. QR codes render as React SVG elements, so uploaded text and labels remain escaped text/data. The focused preview/inspector/QR suites passed 24 tests and the shell/UI TypeScript checks passed. A local Chromium check confirmed untrusted inline script messages are blocked, the nonce-authorized inspector script runs, and a hostile meta-refresh cannot deliver a forged click message.
- **Container base-image integrity:** `Dockerfile.toolsandbox` and `Dockerfile.media` now pin the same `node:22-slim` manifest digest already used by `Dockerfile.documents`; the floating base tags previously let rebuilds silently change their OS/runtime. The Agents container dry run remains unverified here because Docker Hub DNS is blocked.
- **Container pin regression check:** a root unit test now asserts all three Agents Node container Dockerfiles use the same pinned digest. Its focused run passed 1/1.
- **ScaleDown response stream handling:** provider error responses now have their bodies canceled before returning a status-only error; a streamed error body cannot be retained or leak provider text through logs. Oversized source rejection and oversized streamed response cancellation are covered in the ScaleDown suite.
- A follow-up root-suite run exposed an Analytics Engine trace regression: opaque run IDs were passed directly to the tracing package, which accepts only 32-character hexadecimal trace IDs and silently dropped all span writes otherwise. The writer now preserves the run ID as an attribute and generates a valid trace ID when the run ID is not W3C-compatible. Regression coverage asserts the five spans share a valid trace ID and retain the run ID; trace persistence and container pin tests passed 6/6.
- After the trace fix, the full root unit/integration configuration passed 2,017 test suites / 5,422 tests. The complete Agents worker suite passed again and, after the ScaleDown response-stream fix, passed 154 files / 708 tests; its TypeScript check and the focused ScaleDown tests passed. Those new cases cover the source byte ceiling, canceling non-success provider bodies, and canceling oversized streamed JSON responses. The broader worker/package workspace, native Node, and conformance results are recorded above from the preceding pass.
- The tenant suspension regression coverage now exercises queued agent execution, direct trigger execution, durable-script execution, resumed workflow effects, outbound business email, and OAuth credential refresh; the focused internal-token/email suites passed 50/50, OAuth coverage passed 18/18, the Agents TypeScript check passed, and the full Agents suite passed 154 files / 708 tests.
- **Attachment and internal-effect suspension gates:** attachment list/inspect, transcription, image description, email text extraction, OCR, agent approval create/consume, and document-node lease operations now check active organization and Space state before metadata reads, R2/AI/container work, or Durable Object calls. Business-email provisioning and reply-address creation also check organization state, closing prior Space-only checks. The business-email route suite passed 26/26; focused lease/approval suites passed 3/3; the complete Agents suite passed 156 files / 714 tests; Agents TypeScript and focused security lint passed. PDF.js still emits its known `standardFontDataUrl` warning; deployed runtime font coverage remains open.
- **OAuth suspension race:** OAuth start and callback routes for built-in OAuth, custom OAuth, hosted provider connections, and Slack extension connections now require an active tenant and Space. A ticket issued before suspension is consumed and redirected with an error before any provider poll, token exchange, credential write, or MCP registration. Connector regressions passed 50/50, the full Agents suite passed 156/714 again, Agents TypeScript and focused security lint passed.
- **Provider connection authorization:** shared built-in OAuth and hosted provider-connect start routes now require Space owner/admin authority before issuing consent tickets. This closes the member path to creating shared MCP/provider connections. Product-end-user role resolution is covered by a regression that rejects a member before outbound provider requests. Connector suites passed 51/51.
- **Owner voice issuance:** voice-ticket minting now checks organization and Space activity before looking up a session or issuing a hosted voice ticket. The route regression verifies a suspended organization cannot open the downstream session path; focused coverage passed 5/5, and the full Agents suite passed 156/714.
- **Agent continuation gates:** the direct `/agents/:agentId/script/run` entrypoint, interrupted-run continuation, approval action, and asynchronous approval-resume helper now check active tenant/Space state before restarting the agent or its effects. Rejection remains available to close a pending approval. Focused HMAC/approval/continuation tests passed 11/11; full Agents suite passed 156/714.
- These runs cover the exercised code paths only. The full repository audit remains open.

## Open cross-file findings

- **Organization erasure lifecycle and coverage:** an authenticated owner can now create, inspect, and cancel a request through `POST /builder/erasure`, `GET /builder/erasure/:requestId`, and `DELETE /builder/erasure/:requestId`. Request and outbox insertion commit together; bounded five-minute retries use backoff, and duplicate queue deliveries are arbitrated by the request status claim. A 24-hour hold is cancellable until an atomic `pending` → `processing` claim wins, and the claim requires the org still carry the erasure hold. Owner status/cancel requests remain reachable while suspended; admin suspensions are preserved. Product status APIs cannot clear known or legacy suspension holds. Focused tests cover the owner API, no-space organizations, duplicate requests, queue failure and retry, bounded outbox batches, repeated cancellation, status claim, admin holds, and the suspension-route exception. Staging and production Wrangler dry runs validate the scheduled-worker configuration; live cron execution and D1/Queue failure recovery still need deployment exercise. Remaining erasure gaps: RepositoryDO SQLite metadata, SpaceDO/BrowserSessionDO and other Durable Object state, repo/workspace materialization races, external provider resources beyond configured Cloudflare SaaS hostnames, provider cleanup failures, and financial/content retention policy. Runtime/storage inventory and lifecycle integration against deployed Cloudflare resources remain open, so erasure is not declared complete.
- **DNS rebinding across user-controlled outbound fetches (infrastructure blocker):** webhook, MCP Hub, browser, Notifications, Knowledge, Credentials, TaskDO, and compensation fetch paths validate DNS before making a separate Workers `fetch`; this leaves a resolution-to-connect race. Cloudflare documents that Workers subrequests use URLs rather than direct IP addresses, and `resolveOverride` is restricted to hostnames in the Worker's zone, so it cannot pin arbitrary public destinations ([Workers fetch limitations](https://developers.cloudflare.com/workers/platform/known-issues/), [`resolveOverride` constraints](https://developers.cloudflare.com/workers/runtime-apis/request/), checked 2026-10-22). Cloudflare TCP sockets do not provide a safe drop-in HTTP(S) replacement: the docs direct port 80/443 HTTP requests to `fetch` ([TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)). Close this with a controlled egress proxy that resolves and validates at connection time, dials the validated IP, preserves hostname TLS verification/SNI, applies redirect and response limits, and is the only permitted outbound path for these callers. Workers must reach it through a private/service binding and infrastructure egress must prevent bypass. No proxy binding, account network policy, or deployment control currently provides this guarantee. Keep the finding open until deployed behavior and rebinding fault injection prove the pinning path.
- **Initial production dependency baseline (superseded by the remediation and residual findings below):** registry audit of the committed production lockfile on 2026-10-22 reports 4 critical and 29 high findings across 538 production dependency instances. `next@14.2.18` is shared by dashboard, portal, marketplace-web, and shell; current advisories include unauthenticated RCE in image optimization APIs (fixed upstream at Next 15.5.24 / 15.5.28), Middleware authorization bypass (fixed at 14.2.25), and RSC/Server Actions denial of service and SSRF issues. No app middleware or `next/image` use was found in the initial source scan; confirm deployed output and routes before using that as a mitigation. The four apps depend on deprecated `@cloudflare/next-on-pages@1.13.16`, whose declared peer range ends at Next 15.5.2 and is incompatible with the patched 15.5.28 floor; Cloudflare's own package points users to OpenNext. Staging/production workflows currently run plain `next build` but upload `.vercel/output/static`, while the adapter's documented build command is `next-on-pages`; absent stale artifacts, this cannot create the deployment directory. Trace shell's separate production build/deploy path and fix adapter/deployment wiring before relying on any frontend security mitigation. Also audit active `xlsx@0.18.5` in the shell file viewer: registry advisories report prototype pollution and ReDoS with no patched release in the npm package line; replace or safely isolate the parser and add hostile workbook boundary coverage. The `mammoth` tree includes vulnerable `@xmldom/xmldom@0.8.14` (fixed at 0.8.15); resolve through a safe dependency update and bound DOCX archive/XML processing. Record package-specific fixes and exact lockfile audit results here before closing.
- **PDF extraction runtime coverage:** Agents' PDF extraction unit fixtures pass but emit PDF.js warnings that `standardFontDataUrl` is unavailable. Validate standard-font and CJK-heavy PDFs in the deployed Workers runtime and decide whether font assets need to be bundled; current fixtures do not establish coverage for those cases.
- **Lint enforcement gap (partially closed):** the previous CI `pnpm --recursive --parallel --if-present lint` step had no package-level `lint` scripts and was a no-op. CI now runs Biome's `security` rule group over the repository; that focused gate passes locally. The full root `biome check .` still has 7,600 diagnostics across 1,972 files, mostly existing style/formatting rules, so broad style/format enforcement and cleanup remain open.
- **Tenant suspension enforcement:** public router requests check org and reseller relationship status; selected agent, notification, provisioner, workflow, and Knowledge entrypoints also gate work. HMAC-protected task, trigger, script and workflow effect paths recheck tenant and Space activity. Business-email send/provision/reply-address, OAuth refresh and consent start/callback, attachment read/analysis, external approval create/consume, and document-node leases reject inactive tenant/Space scopes before provider, data, or DO access. Regression tests cover these rejection boundaries. Enforcement is still not universal across internal routes, queues, Durable Object alarms, in-flight direct script runs, or other worker paths. `spaces.suspension_reason` and `orgs.suspension_reason` now distinguish admin, reseller/product, and erasure holds in updated writers; legacy suspended rows are conservatively not reactivated through product APIs, but their original owner/control still requires reconciliation. Legacy `/spaces` creation, update, and delete now enforce writer/admin roles, including owner/admin-only status changes and deletes. Other suspension writers and all worker/DO entrypoints remain to be traced.
- **Next.js vulnerabilities and unsupported Cloudflare adapter (open):** after parser, transitive-package, and test-runner remediation, the latest production registry audit reports 4 critical and 11 high advisories across 49 advisory records (29 moderate, 5 low). `next@14.2.18` is shared by dashboard, portal, marketplace-web, and shell; findings include image-optimization RCE, Middleware authorization bypass, Windows-hosted RCE, and RSC/Server Actions DoS/SSRF. No project `middleware` or `next/image` use was found, but dynamic Next edge routes are present, so do not treat the image optimizer as unreachable without a deployed-route probe. The four apps depend on deprecated `@cloudflare/next-on-pages@1.13.16`, whose declared peer range ends at Next 15.5.2, while patched critical fixes require Next 15.5.24 / 15.5.28. Cloudflare's package directs users to OpenNext; migration requires moving these Next runtimes from Pages Functions to Workers and verifying custom-domain/staging routing, so it is not a safe version-only bump. Keep open pending a tested adapter/runtime migration and complete patched-version audit.
- **Frontend Pages build wiring (fixed locally, deployment unverified):** staging/production workflows invoked plain `next build` but uploaded `.vercel/output/static`. Updated all three Pages frontend build steps to call the documented `next-on-pages` CLI directly. Under pinned pnpm 9.12.0, local builds generate `_worker.js/index.js` and expected edge routes for dashboard (22), portal (3), and marketplace (2); the dashboard artifact contains the staging API origin. No Cloudflare Pages deploy or public route check was performed. The shell has a separate production promotion path and its workflow still needs review.
- **Office parser risk (fixed by removing inline archive parsing):** removed `xlsx@0.18.5`, `mammoth`, and both dynamic browser parsers from `apps/shell`; XLSX and DOCX binaries now use the existing download path instead of parsing untrusted ZIP/XML in the user's browser. Added SSR boundary tests for spreadsheet download, Word archive download, and `too_large` behavior. The 2 MiB server inline-file bound remains relevant for PDF/image previews; malicious PDF/image browser handling and file-serving authorization remain open.
- **Transitive dependency patch set (partially fixed):** pinned patched `browserslist@4.28.7`, `nanoid@3.3.18`, `postcss@8.5.18`, `source-map-js@1.2.2`, `js-yaml@4.3.2`, `sharp@0.35.5`, and `ws@8.21.0` through root pnpm overrides. Latest production audit reports 49 records and no longer includes the removed Office parsers; latest full audit reports 74 records. Remaining build-tool highs include `undici@5`, `extract-zip@2.0.1`, `braces@3.0.3`, `basic-ftp`, and `@fastify/busboy`; some require adapter/toolchain migration or major-version compatibility work. Keep these open pending verified replacements and a clean audit.
- **Audit scope:** the checked file list records scoped reviews only. Remaining files, workflow lifecycle coverage, deployment/provider checks, and the full surface inventory are still open.
- **SpaceType resource quota enforcement:** the old manifest accepted `maxDOsPerInstance`, `maxR2WritesPerDay`, `maxContainerHoursPerDay`, `maxLLMTokensPerDay`, `maxCronJobsPerInstance`, and `maxWorkflowsPerInstance`, but repository-wide source search found no runtime enforcement. These fields and the Provisioner `workflowTemplates`/`cronJobs` placeholders are removed from the active manifest contract so operators do not mistake declarations for protections. Actual per-tenant limits still need explicit, metered enforcement tied to platform resource usage and billing; do not restore these manifest claims until that path exists.
- **Space deprovision lifecycle:** `space_deprovision` is accepted by the queue contract, but no source producer sends it. The handler currently removes the script R2 prefix and portal/space KV entries but does not enumerate SpaceDO or D1 data. The public space/product delete paths are soft deletes, so do not wire destructive cleanup until retention and restore semantics are established. Audit the caller and all storage owners before enabling purge; separately add an idempotent durable cleanup workflow if true deletion is required.
- **Provision queue duplicate delivery:** Added a conditional D1-backed per-Space lease (30-minute expiry), owner-token release, a delayed queue retry for overlapping deliveries, and expiration recovery. SQLite tests verify one winner under 20 concurrent claims, tenant isolation, expiration, and owner-only release; queue tests verify duplicate deliveries wait through lease expiry. The source saga remains unchecked overall, and no deployed queue concurrency or hard Worker-termination test was run.

## Work sequence

1. **Freeze and classify the inventory.** Confirm branch/commit, generated and ignored directories, runtime entrypoints, package ownership, deployed workers, routes, Durable Objects, containers, queues, cron/alarm triggers, migrations, secrets, and environment bindings. Keep the tree attached to the commit it describes.
2. **Build the runtime graph.** For every worker, record public/internal API routes, auth middleware, Durable Object namespaces and storage, service bindings, queues, workflows, R2/SQL/Vectorize resources, containers, and outbound providers. Trace dynamic imports, string-dispatched operations, manifests, Wrangler config, CI/deploy workflows, generated bundles, and tests.
3. **Audit shared foundations first.** Review auth/tenant isolation, IDs and permission resolution, HTTP utilities, billing/usage limits, validation/schema parsers, cryptography, logging/redaction, database helpers, SDK contracts, script/tool dispatch, and common RAG/document processing. A defect here can affect every worker.
4. **Review one service boundary at a time.** For each worker: entrypoint and middleware → every route → service/binding calls → each Durable Object → storage schema/migrations → retries/idempotency/alarms/concurrency → container lifecycle and network/filesystem boundaries → tests/deployment config. Include all listed code files, not only obvious handlers.
5. **Review application surfaces and integrations.** Cover each app route, server action, client-to-server boundary, session/cookie/CORS/CSRF behavior, extension/MCP provider, webhook, external API, upload/download, and browser/container execution path. Verify auth at the receiving boundary.
6. **Stress each feature with adversarial inputs.** Use boundary matrices: missing/null/wrong-type/oversized values; Unicode and normalization; duplicates and ordering; empty, one-item, maximum and over-maximum collections; stale, repeated, forged and cross-tenant IDs; timeouts, retries, partial failures, 429/5xx, malformed provider data, storage exhaustion, and concurrent requests. Include long conversations, compaction/retrieval cursor continuity, and context/tool-result budget caps.
7. **Exercise durable and distributed behavior.** Simulate DO eviction/restart, transaction rollback, storage quota, concurrent updates, duplicate delivery, retry after uncertain success, alarm/workflow resumption, queue redelivery, container cold starts, stale mounts, process termination, and provider outage. Verify idempotency and honest partial-result labeling.
8. **Security pass.** Check tenant/space/project/thread scoping on every read/write; role and approval gates; SSRF and URL parsing; path traversal/symlink/archive expansion; shell/code injection; prompt injection from transcripts/RAG/files; XSS/HTML sanitization; secret exposure in logs/errors/artifacts; token audience/expiry/replay; rate/cost limits; and fail-closed behavior on auth/policy/dependency failures.
9. **Repair and prove.** For each confirmed defect, add a focused regression test reproducing it, make the smallest safe fix, run targeted tests and relevant package/type/build checks, and record any suite that did not run plus why. Then run the broader configured suite and deployment/bundle checks where available. Tests and live external load tests are separate evidence types.
10. **Delete legacy code only after three independent reference checks.** (a) static references: imports, exports, symbols, tests, scripts, docs, codegen, and dynamic string lookups; (b) runtime/build wiring: package exports, manifests, router/registry tables, Wrangler, workflow, bundler, migration history, feature flags, and deployment artifacts; (c) reachability proof: import/call graph plus clean build/test with the candidate removed in an isolated change. Check external consumers/public package APIs and migration compatibility. If any edge is uncertain, retain it for owner review. Never delete persisted-data migrations or compatibility aliases solely because current source has no direct import.
11. **Closeout.** Publish findings with severity, affected versions/tenants, exploitability, repro, fix, regression evidence, residual risk, and owners. Track untested files and unavailable infrastructure explicitly; do not turn “not reproduced” into “safe.”

## Stress-test matrix required for every feature/API/DO/container

| Dimension | Required cases |
|---|---|
| Input | empty, minimal, normal, boundary, oversized, malformed, wrong type, Unicode, control chars, duplicate keys/IDs |
| Identity | anonymous, each role, revoked membership, wrong tenant/space/project/thread, expired/replayed internal token |
| State | new, existing, deleted, stale cursor/version, concurrent writer, duplicate request, restart/replay |
| Failure | dependency timeout, disconnect after commit, 4xx/429/5xx, malformed response, storage failure, partial batch |
| Limits | request/body, pagination, result size, memory, CPU/time, retries, concurrency, provider spend, retention |
| Output | no secret leakage, correct citations/IDs/order, bounded result, explicit truncation/incomplete/unavailable status |
| Abuse | injection, traversal, SSRF, privilege escalation, cross-tenant probing, denial-of-service amplification |

## Suggested per-file ledger columns

`path | owner/runtime | entrypoints/callers | trust boundaries | limits/invariants | cases exercised | tests/evidence | findings/severity | fix/commit | status |`

## File-by-file checklist

Check each file only after its behavior and runtime relationships are traced and recorded. Config, schema, and deployment files are included because they affect runtime behavior and security.

### `(repository root)`

- [x] `ai_studio_code (2).sh`
- [x] `ai_studio_code.sh`
- [x] `biome.json`
- [ ] `naelao_expanded_gaps_resolved.html`
- [ ] `naelao_whop_businesses_spec.html`
- [x] `package.json`
- [x] `pnpm-lock.yaml`
- [x] `pnpm-workspace.yaml`
- [ ] `prompts.xml`
- [ ] `repomix-output.xml`
- [x] `repomix.shell.config.json`
- [x] `run-phase.mjs`
- [x] `tsconfig.base.json`
- [x] `turbo.json`
- [x] `vitest.workspace.ts`
- [ ] `work-root-vitest.json`

### `.github/workflows`

- [ ] `.github/workflows/apply-gemini-batch.yml`
- [x] `.github/workflows/bundle-check.yml`
- [x] `.github/workflows/ci.yml`
- [x] `.github/workflows/deploy-prod.yml`
- [x] `.github/workflows/deploy-staging.yml`
- [ ] `.github/workflows/generate-repomix-batch.yml`
- [x] `.github/workflows/implement-full-plan.yml`
- [ ] `.github/workflows/manual-cmd.yml`
- [x] `.github/workflows/pr-checks.yml`

### `_BUILD_PLAN`

- [ ] `_BUILD_PLAN/AVOS Master Architectural Blueprint 1.json`
- [ ] `_BUILD_PLAN/avos1.json`

### `apps/dashboard`

- [x] `apps/dashboard/next.config.mjs`
- [ ] `apps/dashboard/package.json`
- [ ] `apps/dashboard/postcss.config.js`
- [ ] `apps/dashboard/tailwind.config.ts`
- [ ] `apps/dashboard/tsconfig.json`

### `apps/dashboard/src/app`

- [ ] `apps/dashboard/src/app/globals.css`
- [x] `apps/dashboard/src/app/layout.tsx`
- [ ] `apps/dashboard/src/app/page.tsx`

### `apps/dashboard/src/app/catalog`

- [ ] `apps/dashboard/src/app/catalog/page.tsx`

### `apps/dashboard/src/app/dashboard`

- [x] `apps/dashboard/src/app/dashboard/layout.tsx`
- [x] `apps/dashboard/src/app/dashboard/page.tsx`

### `apps/dashboard/src/app/dashboard/api-keys`

- [x] `apps/dashboard/src/app/dashboard/api-keys/page.tsx`

### `apps/dashboard/src/app/dashboard/clients`

- [x] `apps/dashboard/src/app/dashboard/clients/page.tsx`

### `apps/dashboard/src/app/dashboard/products`

- [x] `apps/dashboard/src/app/dashboard/products/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/OnboardingChecklist.tsx`
- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/layout.tsx`
- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/page.tsx`
- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/productContext.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/activity`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/activity/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/agents`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/agents/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/analytics`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/analytics/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/billing`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/billing/PaymentsAccountCard.tsx`
- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/billing/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/configuration`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/configuration/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/danger-zone`

- [x] `apps/dashboard/src/app/dashboard/products/[productId]/danger-zone/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/domain`

- [x] `apps/dashboard/src/app/dashboard/products/[productId]/domain/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/feature-flags`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/feature-flags/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/legal`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/legal/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/local-machine`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/local-machine/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/pricing`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/pricing/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/users`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/users/page.tsx`

### `apps/dashboard/src/app/dashboard/products/[productId]/wallet`

- [ ] `apps/dashboard/src/app/dashboard/products/[productId]/wallet/page.tsx`

### `apps/dashboard/src/app/dashboard/products/new`

- [x] `apps/dashboard/src/app/dashboard/products/new/page.tsx`
- [x] `apps/dashboard/src/app/dashboard/products/new/wizardTypes.ts`

### `apps/dashboard/src/app/dashboard/products/new/steps`

- [x] `apps/dashboard/src/app/dashboard/products/new/steps/AuthConfigStep.tsx`
- [x] `apps/dashboard/src/app/dashboard/products/new/steps/DomainStep.tsx`
- [x] `apps/dashboard/src/app/dashboard/products/new/steps/IdentityStep.tsx`
- [x] `apps/dashboard/src/app/dashboard/products/new/steps/PricingStep.tsx`
- [x] `apps/dashboard/src/app/dashboard/products/new/steps/ReviewStep.tsx`
- [x] `apps/dashboard/src/app/dashboard/products/new/steps/SpaceTypeStep.tsx`

### `apps/dashboard/src/app/dashboard/settings`

- [ ] `apps/dashboard/src/app/dashboard/settings/page.tsx`

### `apps/dashboard/src/app/dashboard/spaces`

- [ ] `apps/dashboard/src/app/dashboard/spaces/page.tsx`

### `apps/dashboard/src/app/dashboard/spaces/[spaceId]/commerce`

- [ ] `apps/dashboard/src/app/dashboard/spaces/[spaceId]/commerce/page.tsx`

### `apps/dashboard/src/app/dashboard/spaces/[spaceId]/connectors`

- [ ] `apps/dashboard/src/app/dashboard/spaces/[spaceId]/connectors/page.tsx`

### `apps/dashboard/src/app/dashboard/spaces/[spaceId]/credentials`

- [ ] `apps/dashboard/src/app/dashboard/spaces/[spaceId]/credentials/page.tsx`

### `apps/dashboard/src/app/dashboard/spaces/[spaceId]/eval`

- [ ] `apps/dashboard/src/app/dashboard/spaces/[spaceId]/eval/page.tsx`

### `apps/dashboard/src/app/dashboard/spaces/[spaceId]/kb`

- [ ] `apps/dashboard/src/app/dashboard/spaces/[spaceId]/kb/page.tsx`

### `apps/dashboard/src/app/dashboard/spaces/[spaceId]/onboarding`

- [ ] `apps/dashboard/src/app/dashboard/spaces/[spaceId]/onboarding/page.tsx`

### `apps/dashboard/src/app/dashboard/spaces/[spaceId]/sessions`

- [ ] `apps/dashboard/src/app/dashboard/spaces/[spaceId]/sessions/page.tsx`

### `apps/dashboard/src/app/dashboard/spaces/[spaceId]/webhooks`

- [ ] `apps/dashboard/src/app/dashboard/spaces/[spaceId]/webhooks/page.tsx`

### `apps/dashboard/src/app/login`

- [x] `apps/dashboard/src/app/login/page.tsx`

### `apps/dashboard/src/app/reset-password`

- [x] `apps/dashboard/src/app/reset-password/page.tsx`

### `apps/dashboard/src/components`

- [ ] `apps/dashboard/src/components/ByokKeysPanel.tsx`
- [x] `apps/dashboard/src/components/ConfirmByTypingDialog.tsx`

### `apps/dashboard/src/lib`

- [x] `apps/dashboard/src/lib/api-key-form.ts`
- [ ] `apps/dashboard/src/lib/api.ts`
- [x] `apps/dashboard/src/lib/auth-provider.tsx`
- [x] `apps/dashboard/src/lib/auth.ts`
- [x] `apps/dashboard/src/lib/product-url.ts`
- [ ] `apps/dashboard/src/lib/temples.ts`

### `apps/launchpad/src`

- [ ] `apps/launchpad/src/index.html`

### `apps/marketplace-web`

- [ ] `apps/marketplace-web/next.config.mjs`
- [ ] `apps/marketplace-web/package.json`
- [ ] `apps/marketplace-web/postcss.config.js`
- [ ] `apps/marketplace-web/tailwind.config.ts`
- [ ] `apps/marketplace-web/tsconfig.json`

### `apps/marketplace-web/src/app`

- [ ] `apps/marketplace-web/src/app/globals.css`
- [ ] `apps/marketplace-web/src/app/layout.tsx`
- [ ] `apps/marketplace-web/src/app/page.tsx`

### `apps/marketplace-web/src/app/categories/[category]`

- [ ] `apps/marketplace-web/src/app/categories/[category]/page.tsx`

### `apps/marketplace-web/src/app/listing/[id]`

- [ ] `apps/marketplace-web/src/app/listing/[id]/page.tsx`

### `apps/marketplace-web/src/lib`

- [ ] `apps/marketplace-web/src/lib/api.ts`

### `apps/portal`

- [ ] `apps/portal/next.config.mjs`
- [ ] `apps/portal/package.json`
- [ ] `apps/portal/postcss.config.js`
- [ ] `apps/portal/tailwind.config.ts`
- [ ] `apps/portal/tsconfig.json`
- [ ] `apps/portal/wrangler.toml`

### `apps/portal/src/app`

- [ ] `apps/portal/src/app/globals.css`
- [ ] `apps/portal/src/app/layout.tsx`
- [ ] `apps/portal/src/app/page.tsx`

### `apps/portal/src/app/[spaceId]`

- [ ] `apps/portal/src/app/[spaceId]/layout.tsx`
- [ ] `apps/portal/src/app/[spaceId]/page.tsx`

### `apps/portal/src/app/[spaceId]/auth`

- [ ] `apps/portal/src/app/[spaceId]/auth/page.tsx`

### `apps/portal/src/app/catalog`

- [ ] `apps/portal/src/app/catalog/page.tsx`

### `apps/portal/src/app/embed/[spaceId]`

- [ ] `apps/portal/src/app/embed/[spaceId]/page.tsx`

### `apps/portal/src/app/launch`

- [ ] `apps/portal/src/app/launch/page.tsx`

### `apps/portal/src/app/login`

- [ ] `apps/portal/src/app/login/page.tsx`

### `apps/portal/src/lib`

- [ ] `apps/portal/src/lib/account.ts`
- [ ] `apps/portal/src/lib/api.ts`
- [ ] `apps/portal/src/lib/i18n.ts`
- [ ] `apps/portal/src/lib/productAccount.ts`
- [ ] `apps/portal/src/lib/session.ts`

### `apps/shell`

- [ ] `apps/shell/next.config.mjs`
- [ ] `apps/shell/package.json`
- [ ] `apps/shell/tsconfig.json`
- [ ] `apps/shell/vitest.config.ts`

### `apps/shell/public`

- [ ] `apps/shell/public/sw.js`

### `apps/shell/src/app`

- [ ] `apps/shell/src/app/globals.css`
- [ ] `apps/shell/src/app/layout.tsx`
- [ ] `apps/shell/src/app/page.tsx`

### `apps/shell/src/app/api/naelao/[...path]`

- [ ] `apps/shell/src/app/api/naelao/[...path]/route.ts`

### `apps/shell/src/app/p`

- [ ] `apps/shell/src/app/p/error.tsx`

### `apps/shell/src/app/p/[slug]`

- [ ] `apps/shell/src/app/p/[slug]/layout.tsx`

### `apps/shell/src/app/p/[slug]/(shell)`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/layout.tsx`
- [ ] `apps/shell/src/app/p/[slug]/(shell)/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/agents`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/agents/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/agents/[agentId]`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/agents/[agentId]/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/analytics`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/analytics/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/approvals`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/approvals/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/bots`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/bots/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/connectors`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/connectors/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/dashboard`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/dashboard/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/dashboard/assistant`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/dashboard/assistant/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/foundry`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/foundry/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/knowledge`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/knowledge/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/new`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/new/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/notifications`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/notifications/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/plugins`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/plugins/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/projects`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/projects/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/projects/[projectId]`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/projects/[projectId]/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/projects/[projectId]/threads/[threadId]`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/projects/[projectId]/threads/[threadId]/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/projects/all`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/projects/all/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/sessions`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/sessions/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/sessions/[sessionId]`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/sessions/[sessionId]/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/settings`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/settings/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/spaces`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/spaces/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/spaces/[businessId]`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/spaces/[businessId]/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/spaces/[businessId]/accept-invite/[token]`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/spaces/[businessId]/accept-invite/[token]/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/spaces/[businessId]/departments/[departmentId]`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/spaces/[businessId]/departments/[departmentId]/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/spaces/[businessId]/onboarding`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/spaces/[businessId]/onboarding/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/threads`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/threads/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/threads/[threadId]`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/threads/[threadId]/page.tsx`

### `apps/shell/src/app/p/[slug]/(shell)/workflows`

- [ ] `apps/shell/src/app/p/[slug]/(shell)/workflows/page.tsx`

### `apps/shell/src/app/p/[slug]/login`

- [ ] `apps/shell/src/app/p/[slug]/login/page.tsx`

### `apps/shell/src/app/p/[slug]/signup`

- [ ] `apps/shell/src/app/p/[slug]/signup/page.tsx`

### `apps/shell/src/app/p/[slug]/verify-email`

- [ ] `apps/shell/src/app/p/[slug]/verify-email/page.tsx`

### `apps/shell/src/components`

- [ ] `apps/shell/src/components/ActivityFeed.tsx`
- [ ] `apps/shell/src/components/AgentPolicyPanel.tsx`
- [ ] `apps/shell/src/components/AppCard.tsx`
- [ ] `apps/shell/src/components/ApprovedActionsEditor.tsx`
- [ ] `apps/shell/src/components/ArchiveKeyRotationPanel.tsx`
- [ ] `apps/shell/src/components/AssistantDelegationCard.tsx`
- [ ] `apps/shell/src/components/AssistantSidePanels.tsx`
- [ ] `apps/shell/src/components/AttachmentOcrSettings.tsx`
- [ ] `apps/shell/src/components/ByokKeysPanel.tsx`
- [ ] `apps/shell/src/components/CanvasContainer.tsx`
- [ ] `apps/shell/src/components/ChannelConnect.tsx`
- [ ] `apps/shell/src/components/Chat.tsx`
- [ ] `apps/shell/src/components/CitationBadge.tsx`
- [ ] `apps/shell/src/components/ComingSoon.tsx`
- [ ] `apps/shell/src/components/ComposerDock.tsx`
- [ ] `apps/shell/src/components/ConnectorAliases.tsx`
- [ ] `apps/shell/src/components/ContextUsageMeter.tsx`
- [ ] `apps/shell/src/components/CustomerBotAutomation.tsx`
- [ ] `apps/shell/src/components/CustomerTelephonySettings.tsx`
- [ ] `apps/shell/src/components/DeskDropLogin.tsx`
- [ ] `apps/shell/src/components/DiscoverMarketRadar.tsx`
- [ ] `apps/shell/src/components/DomainGlossaryPanel.tsx`
- [x] `apps/shell/src/components/FileViewer.test.tsx`
- [x] `apps/shell/src/components/FileViewer.tsx`
- [ ] `apps/shell/src/components/HtmlPreviewFrame.test.ts`
- [ ] `apps/shell/src/components/HtmlPreviewFrame.tsx`
- [ ] `apps/shell/src/components/InlineApprovalCard.tsx`
- [ ] `apps/shell/src/components/InlineArtifactCard.tsx`
- [ ] `apps/shell/src/components/InlineConnectorCard.tsx`
- [ ] `apps/shell/src/components/InlinePullRequestCard.tsx`
- [ ] `apps/shell/src/components/InlineQuestionCard.tsx`
- [ ] `apps/shell/src/components/InterruptedRunCard.tsx`
- [x] `apps/shell/src/components/Markdown.test.tsx`
- [x] `apps/shell/src/components/Markdown.tsx`
- [ ] `apps/shell/src/components/MessageActions.tsx`
- [ ] `apps/shell/src/components/ModelSelector.tsx`
- [ ] `apps/shell/src/components/OwnerVoiceCall.tsx`
- [ ] `apps/shell/src/components/PartnerFoundry.tsx`
- [ ] `apps/shell/src/components/PrivateScratchpad.tsx`
- [ ] `apps/shell/src/components/ProjectCanvas.tsx`
- [ ] `apps/shell/src/components/ProjectKindPanel.tsx`
- [ ] `apps/shell/src/components/ProjectPullRequestPanel.tsx`
- [ ] `apps/shell/src/components/SecurityBoundaryCard.tsx`
- [ ] `apps/shell/src/components/SettingsSection.tsx`
- [ ] `apps/shell/src/components/SubagentStudio.tsx`
- [ ] `apps/shell/src/components/SubthreadPanel.tsx`
- [ ] `apps/shell/src/components/TerminalStreamBlock.tsx`
- [ ] `apps/shell/src/components/UpgradeDialog.tsx`
- [ ] `apps/shell/src/components/WorkflowPlanComposer.tsx`

### `apps/shell/src/components/viewports`

- [ ] `apps/shell/src/components/viewports/ContainerTerminalCanvas.tsx`
- [ ] `apps/shell/src/components/viewports/DocumentRedlineCanvas.tsx`
- [ ] `apps/shell/src/components/viewports/DomainCanvases.tsx`
- [ ] `apps/shell/src/components/viewports/MicroAppCanvas.tsx`
- [ ] `apps/shell/src/components/viewports/SpreadsheetFormulaGrid.tsx`
- [ ] `apps/shell/src/components/viewports/VirtualDesktopGuiCanvas.tsx`

### `apps/shell/src/components/widgets`

- [ ] `apps/shell/src/components/widgets/GeneratedWidget.tsx`

### `apps/shell/src/lib`

- [ ] `apps/shell/src/lib/active-space-context.tsx`
- [ ] `apps/shell/src/lib/api.ts`
- [ ] `apps/shell/src/lib/auth-provider.tsx`
- [ ] `apps/shell/src/lib/chatSession.ts`
- [ ] `apps/shell/src/lib/connectorActions.ts`
- [ ] `apps/shell/src/lib/display-mode.ts`
- [ ] `apps/shell/src/lib/dom-inspector-message.test.ts`
- [ ] `apps/shell/src/lib/dom-inspector-message.ts`
- [ ] `apps/shell/src/lib/modelPreference.ts`
- [ ] `apps/shell/src/lib/product-context.tsx`
- [ ] `apps/shell/src/lib/productAccount.ts`
- [ ] `apps/shell/src/lib/relativeTime.ts`
- [ ] `apps/shell/src/lib/request.ts`
- [ ] `apps/shell/src/lib/roles.ts`
- [ ] `apps/shell/src/lib/terminal-output.ts`
- [ ] `apps/shell/src/lib/user-facing-errors.ts`

### `apps/widget`

- [ ] `apps/widget/package.json`
- [ ] `apps/widget/tsconfig.json`

### `apps/widget/src`

- [ ] `apps/widget/src/naelao-chat.ts`

### `harness/conformance`

- [ ] `harness/conformance/air-gap-conformance.test.ts`
- [ ] `harness/conformance/conformance.test.ts`
- [ ] `harness/conformance/index.ts`
- [ ] `harness/conformance/vitest.config.ts`

### `infra`

- [ ] `infra/gen-spec-index.py`

### `infra/deployment`

- [ ] `infra/deployment/eu-residency-manifest.example.json`
- [ ] `infra/deployment/unit-economics-input.example.json`

### `infra/migrations`

- [ ] `infra/migrations/0001_users.sql`
- [ ] `infra/migrations/0002_orgs.sql`
- [ ] `infra/migrations/0003_spaces.sql`
- [ ] `infra/migrations/0004_billing.sql`
- [ ] `infra/migrations/0005_audit.sql`
- [ ] `infra/migrations/0006_kb_documents.sql`
- [ ] `infra/migrations/0007_billing_meters.sql`
- [ ] `infra/migrations/0008_events_queue_log.sql`
- [ ] `infra/migrations/0009_audit_log_v2.sql`
- [ ] `infra/migrations/0010_notifications.sql`
- [ ] `infra/migrations/0011_triggers.sql`
- [ ] `infra/migrations/0012_mcp_servers.sql`
- [ ] `infra/migrations/0013_space_type_tools.sql`
- [ ] `infra/migrations/0014_eval.sql`
- [ ] `infra/migrations/0015_artifacts.sql`
- [x] `infra/migrations/0016_webhook_subscriptions.sql`
- [x] `infra/migrations/0017_idempotency_keys.sql`
- [ ] `infra/migrations/0018_active_sessions.sql`
- [ ] `infra/migrations/0019_oauth_providers.sql`
- [ ] `infra/migrations/0020_service_accounts.sql`
- [ ] `infra/migrations/0021_space_members.sql`
- [ ] `infra/migrations/0022_api_key_scopes.sql`
- [ ] `infra/migrations/0023_feature_flags.sql`
- [ ] `infra/migrations/0024_do_registry.sql`
- [ ] `infra/migrations/0025_gdpr_requests.sql`
- [ ] `infra/migrations/0026_marketplace.sql`
- [ ] `infra/migrations/0027_threads.sql`
- [ ] `infra/migrations/0028_agi_runs.sql`
- [ ] `infra/migrations/0029_thread_sessions.sql`
- [ ] `infra/migrations/0030_token_version.sql`
- [ ] `infra/migrations/0031_platform_failures.sql`
- [ ] `infra/migrations/0032_usage_events_idempotency.sql`
- [ ] `infra/migrations/0033_reseller_accounts.sql`
- [ ] `infra/migrations/0034_space_hierarchy.sql`
- [ ] `infra/migrations/0035_commerce.sql`
- [ ] `infra/migrations/0036_ls_product_id.sql`
- [ ] `infra/migrations/0037_mcp_servers_auth.sql`
- [ ] `infra/migrations/0038_channel_links.sql`
- [ ] `infra/migrations/0039_channel_links_project.sql`
- [ ] `infra/migrations/0040_space_credentials.sql`
- [ ] `infra/migrations/0041_scheduled_jobs.sql`
- [ ] `infra/migrations/0042_scheduled_jobs_failures.sql`
- [ ] `infra/migrations/0043_scheduled_jobs_agent_goal.sql`
- [ ] `infra/migrations/0044_naelao_product.sql`
- [ ] `infra/migrations/0045_builder_dashboard_api.sql`
- [ ] `infra/migrations/0046_product_end_user_credentials.sql`
- [ ] `infra/migrations/0047_business_memberships.sql`
- [ ] `infra/migrations/0048_admin_schema_fixes.sql`
- [ ] `infra/migrations/0049_business_subscriptions.sql`
- [ ] `infra/migrations/0050_webhook_idempotency.sql`
- [ ] `infra/migrations/0051_kb_documents_project.sql`
- [ ] `infra/migrations/0052_webhook_idempotency_event_type.sql`
- [ ] `infra/migrations/0053_payout_requests.sql`
- [ ] `infra/migrations/0054_password_reset_tokens.sql`
- [ ] `infra/migrations/0055_email_verification.sql`
- [ ] `infra/migrations/0056_bizsvc_custom_domain_index.sql`
- [ ] `infra/migrations/0057_builder_password_reset_tokens.sql`
- [ ] `infra/migrations/0058_product_end_users_deleted_at.sql`
- [ ] `infra/migrations/0059_spaces_last_digest_sent_at.sql`
- [ ] `infra/migrations/0060_mcp_server_connector_provider.sql`
- [ ] `infra/migrations/0061_reseller_ledger_kind.sql`
- [ ] `infra/migrations/0062_subscriptions_lemon_squeezy.sql`
- [ ] `infra/migrations/0063_payment_connections.sql`
- [ ] `infra/migrations/0064_whop_sub_merchants.sql`
- [ ] `infra/migrations/0065_whop_kyc_onboarding.sql`
- [ ] `infra/migrations/0066_payout_request_expiry.sql`
- [ ] `infra/migrations/0067_subscriptions_whop_platform_plan.sql`
- [ ] `infra/migrations/0068_eval_run_model.sql`
- [ ] `infra/migrations/0069_credential_sharing_and_product_tier.sql`
- [ ] `infra/migrations/0070_channel_pairings.sql`
- [ ] `infra/migrations/0071_scheduled_job_runs.sql`
- [ ] `infra/migrations/0072_org_quota_overage.sql`
- [ ] `infra/migrations/0073_project_scoped_automation.sql`
- [ ] `infra/migrations/0074_items_45_87_security_models.sql`
- [ ] `infra/migrations/0075_phase1_runtime_security.sql`
- [ ] `infra/migrations/0076_connector_alias_hardening.sql`
- [ ] `infra/migrations/0077_three_tier_connector_scopes.sql`
- [ ] `infra/migrations/0078_template_subscriptions.sql`
- [ ] `infra/migrations/0079_fde_graduation.sql`
- [ ] `infra/migrations/0080_whatsapp_passwordless_auth.sql`
- [ ] `infra/migrations/0081_workflow_budget_reservations.sql`
- [ ] `infra/migrations/0082_project_bound_credentials.sql`
- [ ] `infra/migrations/0083_marketplace_conformance_receipts.sql`
- [ ] `infra/migrations/0084_marketplace_forks.sql`
- [ ] `infra/migrations/0085_desk_drop.sql`
- [ ] `infra/migrations/0086_developer_settlement.sql`
- [ ] `infra/migrations/0087_blueprint_export_jobs.sql`
- [ ] `infra/migrations/0088_fde_royalty_events.sql`
- [ ] `infra/migrations/0089_marketplace_license_sales.sql`
- [ ] `infra/migrations/0090_marketplace_license_overpayments.sql`
- [ ] `infra/migrations/0091_template_royalty_provider_refs.sql`
- [ ] `infra/migrations/0092_mcp_connector_provider_pin.sql`
- [ ] `infra/migrations/0093_email_reply_routes.sql`
- [ ] `infra/migrations/0094_agent_email_addresses.sql`
- [ ] `infra/migrations/0095_web_push_subscriptions.sql`
- [ ] `infra/migrations/0096_product_end_user_language.sql`
- [ ] `infra/migrations/0097_customer_voice_telephony.sql`
- [ ] `infra/migrations/0098_llm_token_reservations.sql`
- [ ] `infra/migrations/0099_channel_model_overrides.sql`
- [ ] `infra/migrations/0100_email_attachment_ocr_usage.sql`
- [ ] `infra/migrations/0101_customer_voice_purchase_quotes.sql`
- [ ] `infra/migrations/0102_channel_attachments.sql`
- [ ] `infra/migrations/0103_channel_extension_bindings.sql`
- [ ] `infra/migrations/0104_kb_external_publications.sql`
- [ ] `infra/migrations/0105_scheduled_job_dispatch_claims.sql`
- [ ] `infra/migrations/0106_scheduled_job_quiet_hours.sql`
- [ ] `infra/migrations/0107_project_steward_daily_runs.sql`
- [ ] `infra/migrations/0108_project_steward_decisions.sql`
- [ ] `infra/migrations/0109_usage_events_v2.sql`
- [ ] `infra/migrations/0110_workflow_usage_dimensions.sql`
- [ ] `infra/migrations/0111_extension_publisher_keys.sql`
- [ ] `infra/migrations/0112_extension_provider_connections.sql`
- [ ] `infra/migrations/0113_whatsapp_extension_phone_routing.sql`
- [x] `infra/migrations/0114_thread_last_active_at.sql`
- [x] `infra/migrations/0115_sweeper_fairness_cursors.sql`
- [x] `infra/migrations/0116_space_suspension_reason.sql`
- [ ] `infra/migrations/0117_org_suspension_reason.sql`
- [ ] `infra/migrations/0118_gdpr_erasure_outbox.sql`
- [ ] `infra/migrations/0119_portal_domains.sql`
- [x] `infra/migrations/0120_synthetics_storage.sql`
- [x] `infra/migrations/0121_space_provisioning_leases.sql`
- [x] `infra/migrations/0122_platform_assistant_sessions.sql`
- [x] `infra/migrations/0123_builder_reset_token_expiry_index.sql`

### `infra/scripts`

- [ ] `infra/scripts/audit-ui.mjs`
- [ ] `infra/scripts/await-quota-then-matrix.sh`
- [ ] `infra/scripts/capture-runtime-economics.mjs`
- [ ] `infra/scripts/capture-runtime-economics.test.mjs`
- [ ] `infra/scripts/dev-topology.mjs`
- [ ] `infra/scripts/evaluate-runtime-economics.mjs`
- [ ] `infra/scripts/evaluate-runtime-economics.test.mjs`
- [ ] `infra/scripts/evaluate-scaledown-pipeline.mjs`
- [ ] `infra/scripts/evaluate-scaledown-pipeline.test.mjs`
- [ ] `infra/scripts/evaluate-unit-economics.mjs`
- [ ] `infra/scripts/evaluate-unit-economics.test.mjs`
- [ ] `infra/scripts/matrix-results-to-benchmarks.mjs`
- [x] `infra/scripts/phase-runner-safety.mjs`
- [ ] `infra/scripts/pin-workflow-build.mjs`
- [ ] `infra/scripts/plan-preflight.mjs`
- [ ] `infra/scripts/protected-preview.mjs`
- [ ] `infra/scripts/run-eval-suite.mjs`
- [ ] `infra/scripts/run-model-matrix.sh`
- [ ] `infra/scripts/shell-interact.mjs`
- [ ] `infra/scripts/shell-mobile-check.mjs`
- [ ] `infra/scripts/shell-screenshot.mjs`
- [ ] `infra/scripts/smoke-conformance-local.mjs`
- [ ] `infra/scripts/start-dev.mjs`
- [ ] `infra/scripts/start-dev.sh`
- [ ] `infra/scripts/verify-eu-residency.mjs`
- [ ] `infra/scripts/verify-eu-residency.test.mjs`
- [ ] `infra/scripts/verify-system-one.mjs`
- [ ] `infra/scripts/verify-system-one.test.mjs`

### `infra/terraform`

- [ ] `infra/terraform/main.tf`
- [ ] `infra/terraform/outputs.tf`
- [ ] `infra/terraform/providers.tf`
- [ ] `infra/terraform/variables.tf`

### `new plan`

- [ ] `new plan/extract_ai_studio_messages.py`
- [ ] `new plan/test_extract_ai_studio_messages.py`

### `packages/agent-sdk`

- [x] `packages/agent-sdk/package.json`
- [x] `packages/agent-sdk/tsconfig.json`
- [x] `packages/agent-sdk/vitest.config.ts`

### `packages/agent-sdk/examples/trading-mentor-channel`

- [ ] `packages/agent-sdk/examples/trading-mentor-channel/console.html`
- [ ] `packages/agent-sdk/examples/trading-mentor-channel/manifest.json`
- [ ] `packages/agent-sdk/examples/trading-mentor-channel/place-order.ts`
- [ ] `packages/agent-sdk/examples/trading-mentor-channel/student-answer.ts`

### `packages/agent-sdk/src`

- [x] `packages/agent-sdk/src/artifact-client.test.ts`
- [x] `packages/agent-sdk/src/artifact-client.ts`
- [x] `packages/agent-sdk/src/artifact-linters.test.ts`
- [x] `packages/agent-sdk/src/artifact-linters.ts`
- [ ] `packages/agent-sdk/src/autonomy-policy.test.ts`
- [ ] `packages/agent-sdk/src/autonomy-policy.ts`
- [ ] `packages/agent-sdk/src/avos-features.ts`
- [ ] `packages/agent-sdk/src/blueprint.test.ts`
- [ ] `packages/agent-sdk/src/blueprint.ts`
- [ ] `packages/agent-sdk/src/browser-runtime.ts`
- [ ] `packages/agent-sdk/src/canvas-runtime.test.ts`
- [ ] `packages/agent-sdk/src/canvas-runtime.ts`
- [x] `packages/agent-sdk/src/channel-envelope.test.ts`
- [x] `packages/agent-sdk/src/channel-envelope.ts`
- [ ] `packages/agent-sdk/src/cockpit-promotion.test.ts`
- [ ] `packages/agent-sdk/src/cockpit-promotion.ts`
- [ ] `packages/agent-sdk/src/connector-provider.test.ts`
- [ ] `packages/agent-sdk/src/connector-provider.ts`
- [x] `packages/agent-sdk/src/customer-bot-context.test.ts`
- [x] `packages/agent-sdk/src/customer-bot-context.ts`
- [ ] `packages/agent-sdk/src/display-mode.ts`
- [ ] `packages/agent-sdk/src/document-node.ts`
- [x] `packages/agent-sdk/src/document-processing.test.ts`
- [x] `packages/agent-sdk/src/document-processing.ts`
- [ ] `packages/agent-sdk/src/extension-publisher-signatures.test.ts`
- [ ] `packages/agent-sdk/src/extension-publisher-signatures.ts`
- [x] `packages/agent-sdk/src/extensions.test.ts`
- [x] `packages/agent-sdk/src/extensions.ts`
- [x] `packages/agent-sdk/src/fast-decision.test.ts`
- [x] `packages/agent-sdk/src/fast-decision.ts`
- [ ] `packages/agent-sdk/src/index.ts`
- [ ] `packages/agent-sdk/src/launchpad-runtime.test.ts`
- [ ] `packages/agent-sdk/src/launchpad-runtime.ts`
- [ ] `packages/agent-sdk/src/mode-dispatch.test.ts`
- [ ] `packages/agent-sdk/src/mode-dispatch.ts`
- [x] `packages/agent-sdk/src/no-code-subagent.test.ts`
- [x] `packages/agent-sdk/src/no-code-subagent.ts`
- [ ] `packages/agent-sdk/src/project-fact-relevance.test.ts`
- [ ] `packages/agent-sdk/src/project-fact-relevance.ts`
- [ ] `packages/agent-sdk/src/project-kinds.ts`
- [ ] `packages/agent-sdk/src/project-templates.test.ts`
- [ ] `packages/agent-sdk/src/project-templates.ts`
- [ ] `packages/agent-sdk/src/receipt-card.ts`
- [ ] `packages/agent-sdk/src/recipes.ts`
- [ ] `packages/agent-sdk/src/runtime-context.test.ts`
- [ ] `packages/agent-sdk/src/runtime-context.ts`
- [x] `packages/agent-sdk/src/scratchpad.test.ts`
- [x] `packages/agent-sdk/src/scratchpad.ts`
- [x] `packages/agent-sdk/src/subagent-context.test.ts`
- [x] `packages/agent-sdk/src/subagent-context.ts`
- [x] `packages/agent-sdk/src/token-accounting.test.ts`
- [x] `packages/agent-sdk/src/token-accounting.ts`
- [ ] `packages/agent-sdk/src/tunnel-protocol.ts`
- [ ] `packages/agent-sdk/src/types.ts`
- [ ] `packages/agent-sdk/src/widgets.test.ts`
- [ ] `packages/agent-sdk/src/widgets.ts`
- [ ] `packages/agent-sdk/src/workflow-taxonomy.test.ts`
- [ ] `packages/agent-sdk/src/workflow-taxonomy.ts`
- [ ] `packages/agent-sdk/src/write-guard-sentry.test.ts`

### `packages/agent-sdk/src/dogfood-extensions`

- [ ] `packages/agent-sdk/src/dogfood-extensions/index.test.ts`
- [ ] `packages/agent-sdk/src/dogfood-extensions/index.ts`

### `packages/agent-sdk/src/templates`

- [ ] `packages/agent-sdk/src/templates/dev-foundry.test.ts`
- [ ] `packages/agent-sdk/src/templates/dev-foundry.ts`

### `packages/analytics-schema`

- [ ] `packages/analytics-schema/package.json`
- [ ] `packages/analytics-schema/tsconfig.json`

### `packages/analytics-schema/src`

- [ ] `packages/analytics-schema/src/index.ts`

### `packages/auth`

- [x] `packages/auth/package.json`
- [x] `packages/auth/tsconfig.json`
- [x] `packages/auth/vitest.config.ts`

### `packages/auth/src`

- [x] `packages/auth/src/index.ts`
- [x] `packages/auth/src/jwt.ts`
- [x] `packages/auth/src/rbac.test.ts`
- [x] `packages/auth/src/rbac.ts`

### `packages/billing-core`

- [ ] `packages/billing-core/package.json`
- [ ] `packages/billing-core/tsconfig.json`

### `packages/billing-core/src`

- [ ] `packages/billing-core/src/credits.test.ts`
- [ ] `packages/billing-core/src/credits.ts`
- [ ] `packages/billing-core/src/effort.ts`
- [x] `packages/billing-core/src/index-stripe.test.ts`
- [ ] `packages/billing-core/src/index.ts`
- [ ] `packages/billing-core/src/marketplace-policy.test.ts`
- [ ] `packages/billing-core/src/marketplace-policy.ts`
- [ ] `packages/billing-core/src/model-benchmarks.ts`
- [x] `packages/billing-core/src/models.ts`
- [ ] `packages/billing-core/src/personal-plan.ts`
- [ ] `packages/billing-core/src/plans.test.ts`
- [ ] `packages/billing-core/src/plans.ts`
- [ ] `packages/billing-core/src/price-floor.test.ts`
- [ ] `packages/billing-core/src/price-floor.ts`
- [ ] `packages/billing-core/src/reseller.ts`

### `packages/billing-core/src/providers`

- [ ] `packages/billing-core/src/providers/index.ts`
- [x] `packages/billing-core/src/providers/lemon-squeezy.test.ts`
- [ ] `packages/billing-core/src/providers/lemon-squeezy.ts`
- [ ] `packages/billing-core/src/providers/types.ts`
- [x] `packages/billing-core/src/providers/whop-oauth-checkout.test.ts`
- [ ] `packages/billing-core/src/providers/whop-oauth-checkout.ts`
- [ ] `packages/billing-core/src/providers/whop-platform-plan.ts`
- [x] `packages/billing-core/src/providers/whop-provider-boundaries.test.ts`
- [ ] `packages/billing-core/src/providers/whop.ts`

### `packages/bridge`

- [ ] `packages/bridge/package.json`
- [ ] `packages/bridge/tsconfig.json`

### `packages/bridge/services`

- [ ] `packages/bridge/services/start-windows.ps1`

### `packages/bridge/src`

- [ ] `packages/bridge/src/cli.ts`
- [ ] `packages/bridge/src/index.ts`
- [ ] `packages/bridge/src/runtime.mjs`

### `packages/bridge/test`

- [ ] `packages/bridge/test/model-discovery.test.mjs`

### `packages/client-sdk`

- [ ] `packages/client-sdk/package.json`
- [ ] `packages/client-sdk/tsconfig.json`

### `packages/client-sdk/src`

- [ ] `packages/client-sdk/src/index.ts`

### `packages/config`

- [ ] `packages/config/package.json`
- [ ] `packages/config/tsconfig.json`

### `packages/config/src`

- [ ] `packages/config/src/index.ts`

### `packages/crypto`

- [x] `packages/crypto/package.json`
- [x] `packages/crypto/tsconfig.json`
- [x] `packages/crypto/vitest.config.ts`

### `packages/crypto/src`

- [x] `packages/crypto/src/index.test.ts`
- [x] `packages/crypto/src/index.ts`

### `packages/db`

- [x] `packages/db/package.json`
- [x] `packages/db/tsconfig.json`
- [x] `packages/db/vitest.config.ts`

### `packages/db/src`

- [x] `packages/db/src/index.ts`
- [x] `packages/db/src/migrate.test.ts`
- [x] `packages/db/src/migrate.ts`
- [x] `packages/db/src/sql.test.ts`
- [x] `packages/db/src/sql.ts`

### `packages/entitlements`

- [x] `packages/entitlements/package.json`
- [x] `packages/entitlements/tsconfig.json`

### `packages/entitlements/src`

- [x] `packages/entitlements/src/index.test.ts`
- [x] `packages/entitlements/src/index.ts`

### `packages/events`

- [x] `packages/events/package.json`
- [x] `packages/events/tsconfig.json`

### `packages/events/src`

- [x] `packages/events/src/business-feature-kinds.ts`
- [x] `packages/events/src/failure-classification.ts`
- [x] `packages/events/src/index.ts`

### `packages/http`

- [x] `packages/http/package.json`
- [x] `packages/http/tsconfig.json`
- [x] `packages/http/vitest.config.ts`

### `packages/http/src`

- [x] `packages/http/src/bounded-response.test.ts`
- [x] `packages/http/src/bounded-response.ts`
- [x] `packages/http/src/cors.test.ts`
- [x] `packages/http/src/cors.ts`
- [x] `packages/http/src/desk-drop-cookie.test.ts`
- [x] `packages/http/src/desk-drop-cookie.ts`
- [x] `packages/http/src/errors.test.ts`
- [x] `packages/http/src/errors.ts`
- [x] `packages/http/src/index.test.ts`
- [x] `packages/http/src/index.ts`
- [x] `packages/http/src/kv.test.ts`
- [x] `packages/http/src/kv.ts`
- [x] `packages/http/src/middleware.test.ts`
- [x] `packages/http/src/middleware.ts`
- [x] `packages/http/src/pagination.test.ts`
- [x] `packages/http/src/pagination.ts`
- [x] `packages/http/src/realtime.test.ts`
- [x] `packages/http/src/realtime.ts`

### `packages/idempotency`

- [x] `packages/idempotency/package.json`
- [x] `packages/idempotency/tsconfig.json`
- [x] `packages/idempotency/vitest.config.ts`

### `packages/idempotency/src`

- [x] `packages/idempotency/src/index.test.ts`
- [x] `packages/idempotency/src/index.ts`

### `packages/llm-gateway`

- [x] `packages/llm-gateway/package.json`
- [x] `packages/llm-gateway/tsconfig.json`
- [x] `packages/llm-gateway/vitest.config.ts`

### `packages/llm-gateway/src`

- [x] `packages/llm-gateway/src/gateway.test.ts`
- [x] `packages/llm-gateway/src/gateway.ts`
- [x] `packages/llm-gateway/src/index.ts`
- [x] `packages/llm-gateway/src/types.ts`

### `packages/logger`

- [x] `packages/logger/package.json`
- [x] `packages/logger/tsconfig.json`
- [x] `packages/logger/vitest.config.ts`

### `packages/logger/src`

- [x] `packages/logger/src/index.test.ts`
- [x] `packages/logger/src/index.ts`

### `packages/moderation`

- [x] `packages/moderation/package.json`
- [x] `packages/moderation/tsconfig.json`
- [x] `packages/moderation/vitest.config.ts`

### `packages/moderation/src`

- [x] `packages/moderation/src/index.test.ts`
- [x] `packages/moderation/src/index.ts`

### `packages/rag`

- [x] `packages/rag/package.json`
- [x] `packages/rag/tsconfig.json`
- [x] `packages/rag/vitest.config.ts`

### `packages/rag/src`

- [x] `packages/rag/src/batch05-permissions.test.ts`
- [x] `packages/rag/src/batch05-phase2.test.ts`
- [x] `packages/rag/src/batch05-stress.test.ts`
- [x] `packages/rag/src/chunk.ts`
- [x] `packages/rag/src/chunking.ts`
- [x] `packages/rag/src/citations.ts`
- [x] `packages/rag/src/embed.ts`
- [x] `packages/rag/src/envelope.ts`
- [x] `packages/rag/src/hybrid.ts`
- [x] `packages/rag/src/index.ts`
- [x] `packages/rag/src/semantic-cache.ts`
- [x] `packages/rag/src/vectorize.ts`

### `packages/sdk`

- [x] `packages/sdk/package.json`
- [x] `packages/sdk/tsconfig.json`
- [x] `packages/sdk/vitest.config.ts`

### `packages/sdk/src`

- [x] `packages/sdk/src/canvas.test.ts`
- [x] `packages/sdk/src/canvas.ts`
- [x] `packages/sdk/src/channel.ts`
- [x] `packages/sdk/src/index.ts`
- [x] `packages/sdk/src/testing.test.ts`
- [x] `packages/sdk/src/testing.ts`
- [x] `packages/sdk/src/workflow.test.ts`
- [x] `packages/sdk/src/workflow.ts`

### `packages/security`

- [x] `packages/security/package.json`
- [x] `packages/security/tsconfig.json`
- [x] `packages/security/vitest.config.ts`

### `packages/security/src`

- [x] `packages/security/src/air-gap.test.ts`
- [x] `packages/security/src/air-gap.ts`
- [x] `packages/security/src/audit-blueprint-bounds.test.ts`
- [x] `packages/security/src/audit.ts`
- [x] `packages/security/src/blueprint-scrubber.ts`
- [x] `packages/security/src/blueprint-security.test.ts`
- [x] `packages/security/src/blueprint-validator.ts`
- [x] `packages/security/src/bounded-recursion.test.ts`
- [x] `packages/security/src/capability-policy.ts`
- [x] `packages/security/src/circuit-breaker.test.ts`
- [x] `packages/security/src/circuit-breaker.ts`
- [x] `packages/security/src/control-boundaries.test.ts`
- [x] `packages/security/src/data-residency.test.ts`
- [x] `packages/security/src/data-residency.ts`
- [x] `packages/security/src/delegation.test.ts`
- [x] `packages/security/src/delegation.ts`
- [x] `packages/security/src/dlp.ts`
- [x] `packages/security/src/egress-policy.test.ts`
- [x] `packages/security/src/egress-policy.ts`
- [x] `packages/security/src/ephemeral-grant.ts`
- [x] `packages/security/src/headers.test.ts`
- [x] `packages/security/src/headers.ts`
- [x] `packages/security/src/index.ts`
- [x] `packages/security/src/knowledge-permissions.test.ts`
- [x] `packages/security/src/knowledge-permissions.ts`
- [x] `packages/security/src/marketplace-conformance.test.ts`
- [x] `packages/security/src/marketplace-conformance.ts`
- [x] `packages/security/src/pinned-fetch.test.ts`
- [x] `packages/security/src/pinned-fetch.ts`
- [x] `packages/security/src/rate-limit-do.ts`
- [x] `packages/security/src/rate-limit-policy.test.ts`
- [x] `packages/security/src/rate-limit-policy.ts`
- [x] `packages/security/src/request-body.test.ts`
- [x] `packages/security/src/request-body.ts`
- [x] `packages/security/src/secrets.ts`
- [x] `packages/security/src/security-phase4.test.ts`
- [x] `packages/security/src/ssrf-guard.ts`
- [x] `packages/security/src/ssrf-stress.test.ts`
- [x] `packages/security/src/ssrf.ts`
- [x] `packages/security/src/waf-stress.test.ts`
- [x] `packages/security/src/waf.ts`
- [x] `packages/security/src/write-guard-stress.test.ts`
- [x] `packages/security/src/write-guard.ts`

### `packages/testing`

- [x] `packages/testing/package.json`
- [x] `packages/testing/tsconfig.json`
- [x] `packages/testing/vitest.config.ts`

### `packages/testing/src`

- [x] `packages/testing/src/index.test.ts`
- [x] `packages/testing/src/index.ts`

### `packages/tool-runtime`

- [x] `packages/tool-runtime/package.json`
- [x] `packages/tool-runtime/tsconfig.json`
- [x] `packages/tool-runtime/vitest.config.ts`

### `packages/tool-runtime/src`

- [x] `packages/tool-runtime/src/index.test.ts`
- [x] `packages/tool-runtime/src/index.ts`

### `packages/tracing`

- [x] `packages/tracing/package.json`
- [x] `packages/tracing/tsconfig.json`
- [x] `packages/tracing/vitest.config.ts`

### `packages/tracing/src`

- [x] `packages/tracing/src/index.test.ts`
- [x] `packages/tracing/src/index.ts`

### `packages/types`

- [x] `packages/types/package.json`
- [x] `packages/types/tsconfig.json`

### `packages/types/src`

- [x] `packages/types/src/index.ts`
- [x] `packages/types/src/scheduled-quiet-hours.test.ts`

### `packages/ui`

- [x] `packages/ui/package.json`
- [x] `packages/ui/tsconfig.json`
- [x] `packages/ui/vitest.config.ts`

### `packages/ui/src`

- [x] `packages/ui/src/index.ts`
- [x] `packages/ui/src/keyboard.test.ts`
- [x] `packages/ui/src/keyboard.ts`
- [x] `packages/ui/src/qr.ts`
- [x] `packages/ui/src/styles.css`
- [x] `packages/ui/src/tokens.css`
- [x] `packages/ui/src/tokens.test.js`
- [x] `packages/ui/src/useTheme.test.ts`
- [x] `packages/ui/src/useTheme.ts`

### `packages/ui/src/components`

- [x] `packages/ui/src/components/Accessibility.test.tsx`
- [x] `packages/ui/src/components/Avatar.tsx`
- [x] `packages/ui/src/components/Badge.tsx`
- [x] `packages/ui/src/components/Button.tsx`
- [x] `packages/ui/src/components/Card.tsx`
- [x] `packages/ui/src/components/Form.tsx`
- [x] `packages/ui/src/components/Modal.test.tsx`
- [x] `packages/ui/src/components/Modal.tsx`
- [x] `packages/ui/src/components/NavItem.tsx`
- [x] `packages/ui/src/components/PageView.tsx`
- [x] `packages/ui/src/components/QrCode.test.ts`
- [x] `packages/ui/src/components/QrCode.tsx`
- [x] `packages/ui/src/components/Sidebar.tsx`
- [x] `packages/ui/src/components/SpaceSwitcher.tsx`
- [x] `packages/ui/src/components/Toast.tsx`
- [x] `packages/ui/src/components/TopBar.tsx`
- [x] `packages/ui/src/components/icons.tsx`

### `packages/webhooks`

- [x] `packages/webhooks/package.json`
- [x] `packages/webhooks/tsconfig.json`
- [x] `packages/webhooks/vitest.config.ts`

### `packages/webhooks/src`

- [x] `packages/webhooks/src/index.test.ts`
- [x] `packages/webhooks/src/index.ts`
- [x] `packages/webhooks/src/ingress.test.ts`
- [x] `packages/webhooks/src/ingress.ts`
- [x] `packages/webhooks/src/lenient-zod.test.ts`
- [x] `packages/webhooks/src/lenient-zod.ts`
- [x] `packages/webhooks/src/replay-lake.test.ts`
- [x] `packages/webhooks/src/replay-lake.ts`
- [x] `packages/webhooks/src/schema-repair.test.ts`
- [x] `packages/webhooks/src/schema-repair.ts`

### `repomix`

- [ ] `repomix/apply-batch-patch.mjs`
- [ ] `repomix/batch-01-foundation-storage.json`
- [ ] `repomix/batch-02-runtime-vault-cli.json`
- [ ] `repomix/batch-03-connectors-delegation.json`
- [ ] `repomix/batch-04-agent-memory-context.json`
- [ ] `repomix/batch-05-retrieval-citations-mcp.json`
- [ ] `repomix/batch-06-threads-artifact-concurrency.json`
- [ ] `repomix/batch-07-task-provenance-presence.json`
- [ ] `repomix/batch-08-model-policy-airgap-sleep.json`
- [ ] `repomix/batch-09-canvas-extensions-widgets.json`
- [ ] `repomix/batch-10-workflows-webhooks-scheduling.json`
- [ ] `repomix/batch-11-voice-customer-channels.json`
- [ ] `repomix/batch-12-billing-export.json`
- [ ] `repomix/batch-13-marketplace-distribution.json`
- [ ] `repomix/build-prompts.mjs`
- [ ] `repomix/prepare-authority-context.mjs`
- [ ] `repomix/verify-configs.mjs`

### `repomix/outputs`

- [ ] `repomix/outputs/batch-01-context.xml`
- [ ] `repomix/outputs/batch-02-context.xml`

### `scripts`

- [ ] `scripts/codex-goals.sh`
- [ ] `scripts/plan-syntax-check.cjs`

### `tests`

- [ ] `tests/package.json`
- [ ] `tests/playwright.plan.config.ts`
- [ ] `tests/vitest.config.ts`
- [ ] `tests/vitest.plan.config.ts`

### `tests/contract`

- [ ] `tests/contract/api-schema.test.ts`

### `tests/integration`

- [ ] `tests/integration/auth-flow.test.ts`
- [ ] `tests/integration/phase-01-sovereign-runtime.test.ts`
- [ ] `tests/integration/spacedo.test.ts`
- [ ] `tests/integration/whop-end-to-end.test.ts`

### `tests/isolation`

- [ ] `tests/isolation/tenant-isolation.test.ts`

### `tests/load`

- [ ] `tests/load/platform-health.js`

### `tests/plan`

- [ ] `tests/plan/01-baseline.test.ts`
- [ ] `tests/plan/02-contracts.test.ts`
- [ ] `tests/plan/03-tenancy.test.ts`
- [x] `tests/plan/04-authorization.test.ts`
- [x] `tests/plan/05-vault.test.ts`
- [ ] `tests/plan/06-egress-receipts.test.ts`
- [ ] `tests/plan/07-git-mesh.test.ts`
- [ ] `tests/plan/08-concurrency.test.ts`
- [ ] `tests/plan/09-artifactfs.test.ts`
- [ ] `tests/plan/10-virtual-shell.test.ts`
- [ ] `tests/plan/11-dynamic-compute.test.ts`
- [ ] `tests/plan/12-durable-workflows.test.ts`
- [ ] `tests/plan/13-browser-runtime.test.ts`
- [ ] `tests/plan/14-containers.test.ts`
- [ ] `tests/plan/15-tunnel-mesh.test.ts`

### `tests/plan/browser`

- [ ] `tests/plan/browser/01-shell.spec.ts`

### `tests/plan/support`

- [ ] `tests/plan/support/browser-fixtures.mjs`
- [ ] `tests/plan/support/runtime.ts`

### `tests/stubs`

- [ ] `tests/stubs/agents-voice.ts`
- [ ] `tests/stubs/agents.ts`
- [ ] `tests/stubs/cloudflare-workers.ts`
- [ ] `tests/stubs/d1-sqlite.ts`

### `tests/unit`

- [ ] `tests/unit/action-ledger.test.ts`
- [ ] `tests/unit/admin-worker-schema.test.ts`
- [ ] `tests/unit/agent-api-keys.test.ts`
- [ ] `tests/unit/agent-config-self-heal.test.ts`
- [ ] `tests/unit/agent-conversation-pagination.test.ts`
- [ ] `tests/unit/agent-diagnostics-rollup.test.ts`
- [ ] `tests/unit/agent-loop-unbounded.test.ts`
- [x] `tests/unit/agent-run-content-moderation.test.ts`
- [ ] `tests/unit/agent-run-durable-default.test.ts`
- [x] `tests/unit/agent-run-model-override.test.ts`
- [x] `tests/unit/agent-run-script-native-dispatch.test.ts`
- [x] `tests/unit/agent-run-trace-endpoint.test.ts`
- [ ] `tests/unit/agent-signals-and-session-spend.test.ts`
- [x] `tests/unit/agent-task-workflow-failure-handling.test.ts`
- [ ] `tests/unit/agent-templates.test.ts`
- [ ] `tests/unit/agentmail-client.test.ts`
- [ ] `tests/unit/agents-worker-internal-token-gate.test.ts`
- [ ] `tests/unit/ai-gateway-stored-keys.test.ts`
- [ ] `tests/unit/analytics-space-metrics-isolation.test.ts`
- [x] `tests/unit/approval-authority.test.ts`
- [ ] `tests/unit/approval-gates-structural.test.ts`
- [ ] `tests/unit/approvals-prebuilt.test.ts`
- [ ] `tests/unit/artifact-worker.test.ts`
- [x] `tests/unit/artifacts-prebuilt.test.ts`
- [ ] `tests/unit/assistant-delegation-grouping.test.ts`
- [ ] `tests/unit/assistant-permission-clamp.test.ts`
- [ ] `tests/unit/assistant-policy-and-model-config-business-membership.test.ts`
- [ ] `tests/unit/assistant-policy-cache.test.ts`
- [x] `tests/unit/auth-worker.test.ts`
- [ ] `tests/unit/avos-features.test.ts`
- [ ] `tests/unit/batch1-presentation.test.ts`
- [ ] `tests/unit/billing-fulfillment-project.test.ts`
- [ ] `tests/unit/billing-internal-hmac.test.ts`
- [ ] `tests/unit/billing-order-wallet-settlement.test.ts`
- [ ] `tests/unit/billing-refund-clawback.test.ts`
- [ ] `tests/unit/billing-usage-summary.test.ts`
- [ ] `tests/unit/blueprint-conformance-workflow.test.ts`
- [ ] `tests/unit/bootstrap-complete-agent-projects.test.ts`
- [ ] `tests/unit/browser-code-exec-prebuilt.test.ts`
- [x] `tests/unit/browser-worker-kitesurf.test.ts`
- [x] `tests/unit/builder-account-do.test.ts`
- [x] `tests/unit/builder-dashboard-api.test.ts`
- [x] `tests/unit/builder-payout-requests.test.ts`
- [ ] `tests/unit/builder-revenue-share.test.ts`
- [ ] `tests/unit/builder-tier-usage-gate.test.ts`
- [ ] `tests/unit/builder-usage-quota-route.test.ts`
- [ ] `tests/unit/business-auth.test.ts`
- [ ] `tests/unit/business-commerce-membership.test.ts`
- [ ] `tests/unit/business-context.test.ts`
- [x] `tests/unit/business-create.test.ts`
- [ ] `tests/unit/business-diagnostics-prebuilt.test.ts`
- [x] `tests/unit/business-email-agentmail-routes.test.ts`
- [x] `tests/unit/business-feature-kinds.test.ts`
- [x] `tests/unit/business-membership-role.test.ts`
- [ ] `tests/unit/business-onboarding-flow.test.ts`
- [ ] `tests/unit/business-role-cache.test.ts`
- [x] `tests/unit/business-routes.test.ts`
- [ ] `tests/unit/business-subscription-gate.test.ts`
- [ ] `tests/unit/business-subscription-status.test.ts`
- [ ] `tests/unit/business-subscriptions-billing.test.ts`
- [ ] `tests/unit/canvas-extension-security.test.ts`
- [x] `tests/unit/capability-scope-boundary.test.ts`
- [ ] `tests/unit/channel-connect-business-gate.test.ts`
- [ ] `tests/unit/channel-external-quota.test.ts`
- [ ] `tests/unit/channel-heartbeat-wallet-gate.test.ts`
- [ ] `tests/unit/channel-inbound-immediate-drain.test.ts`
- [ ] `tests/unit/channel-inbound-no-anthropic-key.test.ts`
- [ ] `tests/unit/channel-outbound-delivery.test.ts`
- [x] `tests/unit/channel-pairing.test.ts`
- [ ] `tests/unit/channel-replay-dedup-drain.test.ts`
- [x] `tests/unit/chat-uploads.test.ts`
- [ ] `tests/unit/code-runner.test.ts`
- [ ] `tests/unit/commerce-prebuilt-hmac.test.ts`
- [ ] `tests/unit/compact-conversation.test.ts`
- [ ] `tests/unit/composio-connector-connect.test.ts`
- [ ] `tests/unit/composio-tool-execution.test.ts`
- [x] `tests/unit/concurrency-do.test.ts`
- [x] `tests/unit/connector-catalogue.test.ts`
- [ ] `tests/unit/connector-channel-vault-write.test.ts`
- [ ] `tests/unit/connector-directory.test.ts`
- [ ] `tests/unit/connector-gumroad-shim.test.ts`
- [ ] `tests/unit/connector-whop-shim.test.ts`
- [ ] `tests/unit/consult-agent-orchestration-hook.test.ts`
- [ ] `tests/unit/container-image-pin.test.ts`
- [ ] `tests/unit/container-marketplace-slots.test.ts`
- [ ] `tests/unit/container-per-project.test.ts`
- [ ] `tests/unit/context-window-usage-endpoint.test.ts`
- [x] `tests/unit/conversation-access-gate.test.ts`
- [ ] `tests/unit/conversation-context.test.ts`
- [ ] `tests/unit/conversation-search.test.ts`
- [x] `tests/unit/create-space-record.test.ts`
- [x] `tests/unit/credential-hierarchy.test.ts`
- [ ] `tests/unit/credits-monthly-refresh.test.ts`
- [ ] `tests/unit/cron-next-run.test.ts`
- [ ] `tests/unit/cross-project-handoff.test.ts`
- [ ] `tests/unit/customer-bot-rules-business-membership.test.ts`
- [ ] `tests/unit/daily-digest.test.ts`
- [x] `tests/unit/dashboard-api-key-form.test.ts`
- [x] `tests/unit/dashboard-api-path.test.ts`
- [x] `tests/unit/dashboard-auth.test.ts`
- [x] `tests/unit/dashboard-confirm-dialog.test.ts`
- [x] `tests/unit/dashboard-product-url.test.ts`
- [x] `tests/unit/data-erasure-records.test.ts`
- [x] `tests/unit/db-migrations.test.ts`
- [ ] `tests/unit/deposit-personal-credits.test.ts`
- [ ] `tests/unit/desk-drop.test.ts`
- [x] `tests/unit/developer-payout-reconciliation.test.ts`
- [ ] `tests/unit/durable-approvals.test.ts`
- [ ] `tests/unit/durable-run-stream.test.ts`
- [ ] `tests/unit/end-user-credit-debit.test.ts`
- [ ] `tests/unit/end-user-prerun-credit-gate.test.ts`
- [x] `tests/unit/entitlements-expiry.test.ts`
- [ ] `tests/unit/entitlements-schema.test.ts`
- [ ] `tests/unit/eval-dataset-validity.test.ts`
- [ ] `tests/unit/eval-trace-checks.test.ts`
- [ ] `tests/unit/eval-worker-agent-mode.test.ts`
- [ ] `tests/unit/execution-ceiling.test.ts`
- [x] `tests/unit/external-revenue-tracking.test.ts`
- [ ] `tests/unit/fail-closed-lock-and-rules.test.ts`
- [x] `tests/unit/failure-classification.test.ts`
- [ ] `tests/unit/feature-kinds-route.test.ts`
- [ ] `tests/unit/federation.test.ts`
- [ ] `tests/unit/file-and-schedule-tools.test.ts`
- [x] `tests/unit/file-manager-paths.test.ts`
- [x] `tests/unit/free-tier-template-gating.test.ts`
- [ ] `tests/unit/gateway-reasoner-failover.test.ts`
- [ ] `tests/unit/gemini-provider-routing.test.ts`
- [ ] `tests/unit/grounded-search-contract.test.ts`
- [ ] `tests/unit/handlescriptrun-spend-cap.test.ts`
- [ ] `tests/unit/hitl-approval-consume.test.ts`
- [ ] `tests/unit/implicit-signals.test.ts`
- [ ] `tests/unit/infra-usage-metering.test.ts`
- [ ] `tests/unit/infra-usage-quota-gate.test.ts`
- [ ] `tests/unit/interactive-run-end-user-credit-gate.test.ts`
- [ ] `tests/unit/interactive-run-project-wallet-gate.test.ts`
- [ ] `tests/unit/internal-scripts-run-durable.test.ts`
- [ ] `tests/unit/internal-task-run-forwards-runid.test.ts`
- [ ] `tests/unit/internal-triggers-fire.test.ts`
- [ ] `tests/unit/interrupted-run-continue.test.ts`
- [ ] `tests/unit/kb-autorag-retrieval.test.ts`
- [x] `tests/unit/kb-ingestion-workflow.test.ts`
- [ ] `tests/unit/kb-per-project-isolation.test.ts`
- [ ] `tests/unit/kb-search-tenant-isolation.test.ts`
- [ ] `tests/unit/kb-tenant-isolation-all-routes.test.ts`
- [ ] `tests/unit/knowledge-base-prebuilt.test.ts`
- [ ] `tests/unit/language-preferences.test.ts`
- [ ] `tests/unit/launchpad-assistant-profile.test.ts`
- [ ] `tests/unit/launchpad-channels.test.ts`
- [ ] `tests/unit/launchpad-runtime.test.ts`
- [ ] `tests/unit/launchpad-spacetype.test.ts`
- [ ] `tests/unit/layer3-backstop-routes.test.ts`
- [ ] `tests/unit/live-activity-feed.test.ts`
- [ ] `tests/unit/live-partial-progress.test.ts`
- [ ] `tests/unit/llm-byok-routes.test.ts`
- [ ] `tests/unit/llm-gateway-tool-caching.test.ts`
- [ ] `tests/unit/llm-reservation-settlement-v2.test.ts`
- [ ] `tests/unit/local-agent-client.node.test.mjs`
- [ ] `tests/unit/local-grants-business-membership.test.ts`
- [ ] `tests/unit/local-grants.test.ts`
- [ ] `tests/unit/local-machine-prebuilt.test.ts`
- [ ] `tests/unit/local-tunnel-token.test.ts`
- [ ] `tests/unit/lock-prebuilt.test.ts`
- [ ] `tests/unit/long-running-agent-runs.test.ts`
- [ ] `tests/unit/loop-multi-step-observation.test.ts`
- [ ] `tests/unit/marketplace-conformance-routes.test.ts`
- [x] `tests/unit/marketplace-license-settlement.test.ts`
- [ ] `tests/unit/mcp-connector-hmac.test.ts`
- [ ] `tests/unit/mcp-hub-connector-scope.test.ts`
- [ ] `tests/unit/mcp-hub-hmac.test.ts`
- [ ] `tests/unit/mcp-hub-platform-provider-keys.test.ts`
- [ ] `tests/unit/mcp-hub-ssrf.test.ts`
- [ ] `tests/unit/member-seat-reseller-billing.test.ts`
- [x] `tests/unit/memory-os-end-to-end.test.ts`
- [ ] `tests/unit/memory-os-fabric-wiki.test.ts`
- [x] `tests/unit/memory-os-layer5-user-scoping.test.ts`
- [ ] `tests/unit/memory-os-wiki-autorag.test.ts`
- [ ] `tests/unit/memory-os.test.ts`
- [ ] `tests/unit/memory-panel-reads-memory-os.test.ts`
- [ ] `tests/unit/memory-prebuilt.test.ts`
- [ ] `tests/unit/mention-dispatch.test.ts`
- [ ] `tests/unit/message-idempotency.test.ts`
- [ ] `tests/unit/message-list-tail.test.ts`
- [ ] `tests/unit/message-truncate-on-edit.test.ts`
- [ ] `tests/unit/model-placement.test.ts`
- [x] `tests/unit/model-switcher-config-resolution.test.ts`
- [ ] `tests/unit/naelao-product-migration.test.ts`
- [ ] `tests/unit/naelaoagentdo-activity-logging.test.ts`
- [ ] `tests/unit/naelaoagentdo-customer-bot-heartbeat.test.ts`
- [ ] `tests/unit/new-business-wallet-gate.test.ts`
- [ ] `tests/unit/notifications-internal-notify.test.ts`
- [x] `tests/unit/notifications-push-subscription-cap.test.ts`
- [ ] `tests/unit/onboarding-business-membership.test.ts`
- [ ] `tests/unit/onboarding-oauth-availability.test.ts`
- [x] `tests/unit/owner-voice-ticket-route.test.ts`
- [ ] `tests/unit/parse-bounded-integer.test.ts`
- [ ] `tests/unit/personal-plan-whop-checkout.test.ts`
- [x] `tests/unit/phase-runner-safety.test.ts`
- [x] `tests/unit/pipedream-connector-connect.test.ts`
- [ ] `tests/unit/plan-tool.test.ts`
- [ ] `tests/unit/platform-plan-billing.test.ts`
- [ ] `tests/unit/platform-safety.test.ts`
- [ ] `tests/unit/pricing-catalog.test.ts`
- [ ] `tests/unit/product-end-user-auth.test.ts`
- [ ] `tests/unit/product-sessions-verify.test.ts`
- [ ] `tests/unit/product-shell-manifest.test.ts`
- [ ] `tests/unit/product-user-do.test.ts`
- [ ] `tests/unit/product-user-erasure.test.ts`
- [x] `tests/unit/product-wizard-api.test.ts`
- [x] `tests/unit/product-wizard-validation.test.ts`
- [ ] `tests/unit/progressive-tool-disclosure.test.ts`
- [ ] `tests/unit/project-assistant-mode.test.ts`
- [ ] `tests/unit/project-collaboration-t1-t3.test.ts`
- [ ] `tests/unit/project-config-fail-closed.test.ts`
- [ ] `tests/unit/project-coordination-prebuilt.test.ts`
- [ ] `tests/unit/project-journal-prebuilt.test.ts`
- [ ] `tests/unit/project-journal.test.ts`
- [ ] `tests/unit/project-memory-client.test.ts`
- [ ] `tests/unit/project-memory-spacedo.test.ts`
- [ ] `tests/unit/project-scoped-automation.test.ts`
- [ ] `tests/unit/project-steward-dispatch.test.ts`
- [ ] `tests/unit/project-steward-review-route.test.ts`
- [ ] `tests/unit/project-templates.test.ts`
- [ ] `tests/unit/project-wallet-payer-gate.test.ts`
- [ ] `tests/unit/projects-from-template.test.ts`
- [ ] `tests/unit/protected-preview.test.ts`
- [ ] `tests/unit/provisioner-agent-triggers.test.ts`
- [ ] `tests/unit/provisioner-business-email-seed.test.ts`
- [ ] `tests/unit/provisioner-default-revenue-review.test.ts`
- [ ] `tests/unit/provisioner-owner-member.test.ts`
- [ ] `tests/unit/provisioner-rollback-gc.test.ts`
- [ ] `tests/unit/provisioner-seed-wallet.test.ts`
- [x] `tests/unit/provisioning-lease.test.ts`
- [x] `tests/unit/qr-encoder.test.ts`
- [ ] `tests/unit/quota-atomic.test.ts`
- [ ] `tests/unit/quota-windowed.test.ts`
- [x] `tests/unit/r2-workspace-file-size.test.ts`
- [ ] `tests/unit/rag-embed-shape.test.ts`
- [ ] `tests/unit/rate-limit-do.test.ts`
- [ ] `tests/unit/reasoner-agent-prompt.test.ts`
- [ ] `tests/unit/reasoner-streaming.test.ts`
- [ ] `tests/unit/reasoner-tool-calling.test.ts`
- [ ] `tests/unit/reasoner-transient-retry.test.ts`
- [x] `tests/unit/repl-primitives.test.ts`
- [ ] `tests/unit/requirements-trace-matrix.test.ts`
- [ ] `tests/unit/reseller-attribution.test.ts`
- [x] `tests/unit/reseller-suspension.test.ts`
- [ ] `tests/unit/reserved-capabilities.test.ts`
- [ ] `tests/unit/resume-run-continuation.test.ts`
- [x] `tests/unit/revenue-cut-surcharge.test.ts`
- [ ] `tests/unit/revenue-reporting-lapse-gate.test.ts`
- [ ] `tests/unit/revenue-tracker-prebuilt.test.ts`
- [ ] `tests/unit/router-agent-key-gate.test.ts`
- [ ] `tests/unit/router-assistant-panel-allowlist.test.ts`
- [ ] `tests/unit/router-cors-allowlist.test.ts`
- [x] `tests/unit/router-dispatch.test.ts`
- [ ] `tests/unit/router-dynamic-cors.test.ts`
- [ ] `tests/unit/router-preauth-rate-limit.test.ts`
- [ ] `tests/unit/router-product-end-user-auth.test.ts`
- [ ] `tests/unit/router-rate-limit-sharding.test.ts`
- [ ] `tests/unit/run-cancellation.test.ts`
- [ ] `tests/unit/run-status-pending-approval.test.ts`
- [ ] `tests/unit/run-trace-persistence.test.ts`
- [ ] `tests/unit/runtime-watchdog.test.ts`
- [ ] `tests/unit/scaling-skills.test.ts`
- [ ] `tests/unit/scheduled-job-dispatch-claims.test.ts`
- [ ] `tests/unit/scheduled-job-pending-run-awareness.test.ts`
- [ ] `tests/unit/scheduled-job-run-history.test.ts`
- [ ] `tests/unit/scheduled-job-timestamp.test.ts`
- [ ] `tests/unit/scheduled-jobs-business-membership.test.ts`
- [ ] `tests/unit/scheduled-jobs-fires-events.test.ts`
- [ ] `tests/unit/scheduled-jobs.test.ts`
- [ ] `tests/unit/script-engine.test.ts`
- [ ] `tests/unit/script-name-recoverable.test.ts`
- [x] `tests/unit/script-run-hmac-gate.test.ts`
- [ ] `tests/unit/seed-general-project.test.ts`
- [ ] `tests/unit/send-to-thread-orchestration-hook.test.ts`
- [ ] `tests/unit/session-budget-guard.test.ts`
- [ ] `tests/unit/shell-request.test.ts`
- [ ] `tests/unit/shell-role-gate.test.ts`
- [ ] `tests/unit/skill-manager-prebuilt.test.ts`
- [ ] `tests/unit/skill-self-improvement.test.ts`
- [ ] `tests/unit/skills-directory-route.test.ts`
- [ ] `tests/unit/space-assistant-surface.test.ts`
- [ ] `tests/unit/space-collaboration.test.ts`
- [ ] `tests/unit/space-fire-external-event.test.ts`
- [ ] `tests/unit/space-hierarchy-policy.test.ts`
- [ ] `tests/unit/space-members-scoping.test.ts`
- [x] `tests/unit/space-tenancy.test.ts`
- [ ] `tests/unit/spacedo-agent-activity-log.test.ts`
- [ ] `tests/unit/spacedo-customer-bot-projects.test.ts`
- [ ] `tests/unit/spacedo-notifications.test.ts`
- [ ] `tests/unit/spacedo-project-configurability.test.ts`
- [ ] `tests/unit/spacedo-project-spend.test.ts`
- [ ] `tests/unit/spacedo-realtime-broadcast.test.ts`
- [ ] `tests/unit/spacedo-tasks.test.ts`
- [ ] `tests/unit/spacedo-threads.test.ts`
- [x] `tests/unit/storefront-serving.test.ts`
- [ ] `tests/unit/streaming-real-deltas.test.ts`
- [ ] `tests/unit/sub-agent-effort-escalation.test.ts`
- [ ] `tests/unit/sub-agent-output.test.ts`
- [ ] `tests/unit/sub-agents-panel-do-addressing.test.ts`
- [x] `tests/unit/sweeper-thread-session-retention.test.ts`
- [ ] `tests/unit/tasks-prebuilt.test.ts`
- [ ] `tests/unit/template-bootstrap-execution.test.ts`
- [ ] `tests/unit/template-royalty-webhook.test.ts`
- [x] `tests/unit/tenant-continuation-gate.test.ts`
- [ ] `tests/unit/tenant-custom-oauth.test.ts`
- [ ] `tests/unit/terminal-output.test.ts`
- [x] `tests/unit/thread-last-active-migration.test.ts`
- [ ] `tests/unit/tool-addressing-robustness.test.ts`
- [ ] `tests/unit/usage-events-v2-migration.test.ts`
- [ ] `tests/unit/wake-up-brief.test.ts`
- [ ] `tests/unit/wallet-ledger.test.ts`
- [ ] `tests/unit/wallet-prebuilt.test.ts`
- [ ] `tests/unit/wallet-root-access.test.ts`
- [ ] `tests/unit/wallet-topups-billing.test.ts`
- [ ] `tests/unit/web-download-binary-route.test.ts`
- [ ] `tests/unit/web-search-grounded-answer.test.ts`
- [x] `tests/unit/web-search-platform.test.ts`
- [ ] `tests/unit/webdev-agency-template.test.ts`
- [ ] `tests/unit/webhook-idempotency.test.ts`
- [ ] `tests/unit/webhook-normalizer.test.ts`
- [ ] `tests/unit/whop-oauth-business-billing.test.ts`
- [ ] `tests/unit/whop-oauth-checkout.test.ts`
- [x] `tests/unit/whop-oauth-connect.test.ts`
- [ ] `tests/unit/whop-platform-plan-billing.test.ts`
- [x] `tests/unit/whop-wallet.test.ts`
- [x] `tests/unit/worker-deployment-coverage.test.ts`
- [ ] `tests/unit/workflow-budget-settlement-v2.test.ts`
- [ ] `tests/unit/workflow-tier-routing.test.ts`
- [ ] `tests/unit/workspace-admin-prebuilt.test.ts`
- [x] `tests/unit/workspace-file-viewer.test.ts`
- [x] `tests/unit/workspace-prebuilt.test.ts`
- [ ] `tests/unit/workspace-scoping.test.ts`
- [x] `tests/unit/wrangler-binding-parity.test.ts`
- [ ] `tests/unit/wrangler-vars-parity.test.ts`

### `tests/unit/helpers`

- [x] `tests/unit/helpers/active-tenant-db.ts`
- [ ] `tests/unit/helpers/fake-do-namespace.ts`
- [ ] `tests/unit/helpers/r2-bucket.ts`
- [ ] `tests/unit/helpers/sqlite-do-shim.ts`

### `tests/unit/packages`

- [ ] `tests/unit/packages/analytics-schema.test.ts`
- [x] `tests/unit/packages/auth.test.ts`
- [x] `tests/unit/packages/billing-core.test.ts`
- [x] `tests/unit/packages/crypto.test.ts`
- [ ] `tests/unit/packages/entitlements.test.ts`
- [ ] `tests/unit/packages/events-cron.test.ts`
- [ ] `tests/unit/packages/events.test.ts`
- [ ] `tests/unit/packages/http-internal-hmac.test.ts`
- [x] `tests/unit/packages/idempotency.test.ts`
- [ ] `tests/unit/packages/llm-gateway-native-web-search.test.ts`
- [x] `tests/unit/packages/llm-gateway.test.ts`
- [ ] `tests/unit/packages/mentions.test.ts`
- [ ] `tests/unit/packages/model-benchmarks-and-effort.test.ts`
- [x] `tests/unit/packages/moderation.test.ts`
- [ ] `tests/unit/packages/rag.test.ts`
- [ ] `tests/unit/packages/realtime-broadcast.test.ts`
- [x] `tests/unit/packages/security.test.ts`
- [x] `tests/unit/packages/webhooks.test.ts`

### `work`

- [ ] `work/builder-vitest.config.ts`
- [ ] `work/current-workspace-vitest.json`
- [ ] `work/refresh_naelao_inventory.py`

### `workers/admin`

- [ ] `workers/admin/package.json`
- [ ] `workers/admin/tsconfig.json`
- [x] `workers/admin/wrangler.toml`

### `workers/admin/src`

- [ ] `workers/admin/src/index.ts`
- [x] `workers/admin/src/queue.test.ts`

### `workers/agents`

- [ ] `workers/agents/Dockerfile.documents`
- [ ] `workers/agents/Dockerfile.media`
- [ ] `workers/agents/Dockerfile.toolsandbox`
- [ ] `workers/agents/package.json`
- [ ] `workers/agents/tsconfig.json`
- [ ] `workers/agents/vitest.config.ts`
- [x] `workers/agents/wrangler.toml`

### `workers/agents/container`

- [ ] `workers/agents/container/artifact-fs.mjs`
- [ ] `workers/agents/container/artifact-fs.test.mjs`
- [ ] `workers/agents/container/binary-bridge.mjs`
- [ ] `workers/agents/container/child-runner.mjs`
- [ ] `workers/agents/container/compile-runner.mjs`
- [ ] `workers/agents/container/process-supervisor.mjs`
- [ ] `workers/agents/container/server.mjs`
- [ ] `workers/agents/container/start.sh`

### `workers/agents/local-agent`

- [ ] `workers/agents/local-agent/naelao-local-agent.mjs`

### `workers/agents/src`

- [x] `workers/agents/src/agent-approval-routes.test.ts`
- [x] `workers/agents/src/agent-run-session-scope.test.ts`
- [ ] `workers/agents/src/agent-templates.test.ts`
- [ ] `workers/agents/src/agent-templates.ts`
- [x] `workers/agents/src/agent-ticks-queue-config.test.ts`
- [ ] `workers/agents/src/batch09-foundations.test.ts`
- [ ] `workers/agents/src/batch10-workflows.test.ts`
- [ ] `workers/agents/src/batch11-phase2.test.ts`
- [ ] `workers/agents/src/channel-extension-session-route.test.ts`
- [ ] `workers/agents/src/channel-extension-source-validation.test.ts`
- [ ] `workers/agents/src/channel-external-quota.ts`
- [x] `workers/agents/src/cloudflare-email-suspension.test.ts`
- [x] `workers/agents/src/connector-poll-cursor.test.ts`
- [x] `workers/agents/src/daily-digest-prerequisites.test.ts`
- [ ] `workers/agents/src/env.ts`
- [x] `workers/agents/src/extension-provider-auth.test.ts`
- [ ] `workers/agents/src/index.ts`
- [x] `workers/agents/src/internal-scope-routes.test.ts`
- [ ] `workers/agents/src/model-policy.test.ts`
- [ ] `workers/agents/src/model-policy.ts`
- [ ] `workers/agents/src/project-steward-dispatch.ts`
- [x] `workers/agents/src/prompt-injection-quarantine.test.ts`
- [ ] `workers/agents/src/pull-request-review.test.ts`
- [ ] `workers/agents/src/reconciliation-b2.test.ts`
- [ ] `workers/agents/src/request-body-boundaries.test.ts`
- [ ] `workers/agents/src/safety.ts`
- [ ] `workers/agents/src/scheduled-air-gap.test.ts`
- [ ] `workers/agents/src/scheduled-job-dispatch.test.ts`
- [ ] `workers/agents/src/scheduled-job-dispatch.ts`
- [x] `workers/agents/src/scheduled-job-tenant-scope.test.ts`

### `workers/agents/src/channels`

- [x] `workers/agents/src/channels/agentmail.test.ts`
- [ ] `workers/agents/src/channels/agentmail.ts`
- [x] `workers/agents/src/channels/attachment-copy-route.test.ts`
- [x] `workers/agents/src/channels/attachment-index-route.test.ts`
- [x] `workers/agents/src/channels/attachment-transcription-route.test.ts`
- [ ] `workers/agents/src/channels/channel-attachment-store.test.ts`
- [ ] `workers/agents/src/channels/channel-attachment-store.ts`
- [ ] `workers/agents/src/channels/channel-extension-session.test.ts`
- [ ] `workers/agents/src/channels/channel-extension-session.ts`
- [ ] `workers/agents/src/channels/channel-session-usage.test.ts`
- [ ] `workers/agents/src/channels/channel-session-usage.ts`
- [x] `workers/agents/src/channels/chat-upload-attachments.test.ts`
- [x] `workers/agents/src/channels/chat-upload-attachments.ts`
- [x] `workers/agents/src/channels/chat-upload-route.test.ts`
- [x] `workers/agents/src/channels/chat-upload-scope.test.ts`
- [x] `workers/agents/src/channels/chat-upload-scope.ts`
- [x] `workers/agents/src/channels/cloudflare-email.test.ts`
- [ ] `workers/agents/src/channels/cloudflare-email.ts`
- [x] `workers/agents/src/channels/email-attachment-route.test.ts`
- [x] `workers/agents/src/channels/email-docx.test.ts`
- [ ] `workers/agents/src/channels/email-docx.ts`
- [ ] `workers/agents/src/channels/email-ocr-settings-route.test.ts`
- [x] `workers/agents/src/channels/email-ocr.test.ts`
- [ ] `workers/agents/src/channels/email-ocr.ts`
- [x] `workers/agents/src/channels/email-pdf.test.ts`
- [ ] `workers/agents/src/channels/email-pdf.ts`
- [ ] `workers/agents/src/channels/executive-channel.ts`
- [ ] `workers/agents/src/channels/foundry-command.test.ts`
- [ ] `workers/agents/src/channels/foundry-command.ts`
- [x] `workers/agents/src/channels/session-queue.test.ts`
- [x] `workers/agents/src/channels/session-queue.ts`

### `workers/agents/src/connectors`

- [ ] `workers/agents/src/connectors/calendar-connector.ts`
- [ ] `workers/agents/src/connectors/catalogue.ts`
- [ ] `workers/agents/src/connectors/composio.ts`
- [ ] `workers/agents/src/connectors/directory.ts`
- [ ] `workers/agents/src/connectors/oauth-ticket.test.ts`
- [x] `workers/agents/src/connectors/oauth.test.ts`
- [ ] `workers/agents/src/connectors/oauth.ts`
- [ ] `workers/agents/src/connectors/pipedream.ts`
- [ ] `workers/agents/src/connectors/webhook-normalizer.ts`

### `workers/agents/src/container-bridge`

- [ ] `workers/agents/src/container-bridge/framing.test.ts`
- [ ] `workers/agents/src/container-bridge/framing.ts`

### `workers/agents/src/do`

- [x] `workers/agents/src/do/ConcurrencyDO.test.ts`
- [x] `workers/agents/src/do/ConcurrencyDO.ts`
- [x] `workers/agents/src/do/HITLApprovalDO.ts`
- [x] `workers/agents/src/do/LocalTunnelDO.test.ts`
- [x] `workers/agents/src/do/LocalTunnelDO.ts`
- [ ] `workers/agents/src/do/NaelaoAgentDO.ts`
- [ ] `workers/agents/src/do/RiskGuardDO.ts`
- [x] `workers/agents/src/do/TaskDO.ts`
- [ ] `workers/agents/src/do/ToolSandboxDO.test.ts`
- [ ] `workers/agents/src/do/ToolSandboxDO.ts`
- [x] `workers/agents/src/do/WorkflowRunDO.test.ts`
- [ ] `workers/agents/src/do/WorkflowRunDO.ts`
- [ ] `workers/agents/src/do/additional-do-request-boundaries.test.ts`
- [x] `workers/agents/src/do/channel-conversation-transcript.test.ts`
- [ ] `workers/agents/src/do/channel-extension-inbox.test.ts`
- [x] `workers/agents/src/do/channel-heartbeat-suspension.test.ts`
- [ ] `workers/agents/src/do/citation-metadata.test.ts`
- [ ] `workers/agents/src/do/conversation-compaction.test.ts`
- [ ] `workers/agents/src/do/delegation-admission.test.ts`
- [x] `workers/agents/src/do/direct-do-request-boundaries.test.ts`
- [ ] `workers/agents/src/do/external-channel-spend.test.ts`
- [ ] `workers/agents/src/do/external-channel-spend.ts`
- [x] `workers/agents/src/do/hitl-approval-boundaries.test.ts`
- [ ] `workers/agents/src/do/ingress-memory.test.ts`
- [x] `workers/agents/src/do/memory-maintenance-route.test.ts`
- [ ] `workers/agents/src/do/project-llm-usage.test.ts`
- [ ] `workers/agents/src/do/project-llm-usage.ts`
- [ ] `workers/agents/src/do/specialized-workspaces.test.ts`
- [ ] `workers/agents/src/do/usage-event-outbox.test.ts`
- [ ] `workers/agents/src/do/usage-event-outbox.ts`

### `workers/agents/src/launchpad`

- [ ] `workers/agents/src/launchpad/autonomy-policy.test.ts`
- [ ] `workers/agents/src/launchpad/autonomy-policy.ts`
- [ ] `workers/agents/src/launchpad/bootstrap.ts`
- [ ] `workers/agents/src/launchpad/bounded-provider-json.test.ts`
- [ ] `workers/agents/src/launchpad/bounded-provider-json.ts`
- [ ] `workers/agents/src/launchpad/business-context.ts`
- [ ] `workers/agents/src/launchpad/channel-pairing.ts`
- [ ] `workers/agents/src/launchpad/channels.ts`
- [ ] `workers/agents/src/launchpad/discord-media.test.ts`
- [ ] `workers/agents/src/launchpad/discord-media.ts`
- [ ] `workers/agents/src/launchpad/growth-skills.ts`
- [ ] `workers/agents/src/launchpad/interactive-channel.test.ts`
- [ ] `workers/agents/src/launchpad/project-templates.ts`
- [ ] `workers/agents/src/launchpad/scaling-skills.ts`
- [ ] `workers/agents/src/launchpad/slack-media.test.ts`
- [ ] `workers/agents/src/launchpad/slack-media.ts`
- [ ] `workers/agents/src/launchpad/spacetype.ts`
- [ ] `workers/agents/src/launchpad/telegram-media.test.ts`
- [ ] `workers/agents/src/launchpad/telegram-media.ts`
- [ ] `workers/agents/src/launchpad/webdev-skills.ts`
- [ ] `workers/agents/src/launchpad/whatsapp-extension-webhook.test.ts`
- [ ] `workers/agents/src/launchpad/whatsapp-extension-webhook.ts`
- [ ] `workers/agents/src/launchpad/whatsapp-media.test.ts`
- [ ] `workers/agents/src/launchpad/whatsapp-media.ts`

### `workers/agents/src/media`

- [ ] `workers/agents/src/media/attachment-capabilities.test.ts`
- [ ] `workers/agents/src/media/attachment-capabilities.ts`
- [ ] `workers/agents/src/media/modality-task.test.ts`
- [ ] `workers/agents/src/media/modality-task.ts`

### `workers/agents/src/script-engine`

- [ ] `workers/agents/src/script-engine/agent-archetypes.ts`
- [ ] `workers/agents/src/script-engine/agent-config.test.ts`
- [ ] `workers/agents/src/script-engine/agent-config.ts`
- [ ] `workers/agents/src/script-engine/agent-firewall.ts`
- [ ] `workers/agents/src/script-engine/agent-topology.ts`
- [ ] `workers/agents/src/script-engine/assistant-access.ts`
- [ ] `workers/agents/src/script-engine/batch04-kernel.test.ts`
- [ ] `workers/agents/src/script-engine/batch04-phase2-memory.test.ts`
- [ ] `workers/agents/src/script-engine/browser-perception.test.ts`
- [ ] `workers/agents/src/script-engine/browser-perception.ts`
- [ ] `workers/agents/src/script-engine/code-rpc-broker.ts`
- [ ] `workers/agents/src/script-engine/code-runner.ts`
- [ ] `workers/agents/src/script-engine/container-catalogue.ts`
- [ ] `workers/agents/src/script-engine/container-policy.test.ts`
- [ ] `workers/agents/src/script-engine/container-policy.ts`
- [ ] `workers/agents/src/script-engine/conversation-context.ts`
- [ ] `workers/agents/src/script-engine/customer-triage.test.ts`
- [ ] `workers/agents/src/script-engine/customer-triage.ts`
- [ ] `workers/agents/src/script-engine/delegation-contract.test.ts`
- [ ] `workers/agents/src/script-engine/delegation-contract.ts`
- [ ] `workers/agents/src/script-engine/delegation.test.ts`
- [ ] `workers/agents/src/script-engine/deliberation-state.test.ts`
- [ ] `workers/agents/src/script-engine/deliberation-state.ts`
- [ ] `workers/agents/src/script-engine/distill.test.ts`
- [ ] `workers/agents/src/script-engine/distill.ts`
- [ ] `workers/agents/src/script-engine/dynamic-code.test.ts`
- [ ] `workers/agents/src/script-engine/dynamic-code.ts`
- [ ] `workers/agents/src/script-engine/execution-ladder.test.ts`
- [ ] `workers/agents/src/script-engine/execution-ladder.ts`
- [ ] `workers/agents/src/script-engine/federation.ts`
- [ ] `workers/agents/src/script-engine/fingerprint.ts`
- [ ] `workers/agents/src/script-engine/goal-dag.test.ts`
- [ ] `workers/agents/src/script-engine/goal-dag.ts`
- [ ] `workers/agents/src/script-engine/index.ts`
- [ ] `workers/agents/src/script-engine/isolated-runtime.ts`
- [ ] `workers/agents/src/script-engine/loop-budget.ts`
- [ ] `workers/agents/src/script-engine/loop-evaluator.test.ts`
- [ ] `workers/agents/src/script-engine/loop-evaluator.ts`
- [ ] `workers/agents/src/script-engine/loop.ts`
- [ ] `workers/agents/src/script-engine/memory-os.ts`
- [ ] `workers/agents/src/script-engine/mention-router.ts`
- [ ] `workers/agents/src/script-engine/observe.ts`
- [ ] `workers/agents/src/script-engine/package-egress.test.ts`
- [ ] `workers/agents/src/script-engine/package-egress.ts`
- [ ] `workers/agents/src/script-engine/perception.test.ts`
- [ ] `workers/agents/src/script-engine/perception.ts`
- [ ] `workers/agents/src/script-engine/phase4-security.test.ts`
- [ ] `workers/agents/src/script-engine/planner-first.ts`
- [ ] `workers/agents/src/script-engine/profiles.ts`
- [ ] `workers/agents/src/script-engine/project-journal-hibernation.test.ts`
- [ ] `workers/agents/src/script-engine/project-journal.ts`
- [ ] `workers/agents/src/script-engine/project-memory-client.test.ts`
- [ ] `workers/agents/src/script-engine/project-memory-client.ts`
- [ ] `workers/agents/src/script-engine/prompt-assembly.ts`
- [ ] `workers/agents/src/script-engine/r2-cas.test.ts`
- [ ] `workers/agents/src/script-engine/r2-cas.ts`
- [ ] `workers/agents/src/script-engine/r2-workspace-cas.test.ts`
- [ ] `workers/agents/src/script-engine/r2-workspace.test.ts`
- [ ] `workers/agents/src/script-engine/r2-workspace.ts`
- [x] `workers/agents/src/script-engine/reasoner-depth.test.ts`
- [ ] `workers/agents/src/script-engine/reasoner.ts`
- [x] `workers/agents/src/script-engine/request-context-budget.test.ts`
- [x] `workers/agents/src/script-engine/request-context-budget.ts`
- [ ] `workers/agents/src/script-engine/reserved-capabilities.ts`
- [ ] `workers/agents/src/script-engine/runtime-context.test.ts`
- [ ] `workers/agents/src/script-engine/script-find.ts`
- [ ] `workers/agents/src/script-engine/shell-parser.ts`
- [ ] `workers/agents/src/script-engine/skill-health.ts`
- [ ] `workers/agents/src/script-engine/skill-library-boundaries.test.ts`
- [ ] `workers/agents/src/script-engine/skill-library.ts`
- [ ] `workers/agents/src/script-engine/skill-markdown.test.ts`
- [ ] `workers/agents/src/script-engine/skill-markdown.ts`
- [ ] `workers/agents/src/script-engine/skill-role-targeting.test.ts`
- [ ] `workers/agents/src/script-engine/ssrf.test.ts`
- [ ] `workers/agents/src/script-engine/step-context.test.ts`
- [ ] `workers/agents/src/script-engine/step-context.ts`
- [ ] `workers/agents/src/script-engine/step-pipeline.ts`
- [ ] `workers/agents/src/script-engine/sub-agent-output.ts`
- [ ] `workers/agents/src/script-engine/task-publication.test.ts`
- [ ] `workers/agents/src/script-engine/task-publication.ts`
- [ ] `workers/agents/src/script-engine/terminal-stream.test.ts`
- [ ] `workers/agents/src/script-engine/tool-output-expiry.test.ts`
- [ ] `workers/agents/src/script-engine/tool-output-expiry.ts`
- [x] `workers/agents/src/script-engine/tool-output.test.ts`
- [ ] `workers/agents/src/script-engine/tool-output.ts`
- [x] `workers/agents/src/script-engine/tool-result-pagination.test.ts`
- [ ] `workers/agents/src/script-engine/tool-surface.ts`
- [ ] `workers/agents/src/script-engine/transcript-loader.test.ts`
- [ ] `workers/agents/src/script-engine/transcript-loader.ts`
- [ ] `workers/agents/src/script-engine/types.ts`
- [ ] `workers/agents/src/script-engine/typescript-runtime.ts`
- [x] `workers/agents/src/script-engine/vault-proxy.test.ts`
- [ ] `workers/agents/src/script-engine/vault-proxy.ts`
- [ ] `workers/agents/src/script-engine/video-distill.ts`
- [x] `workers/agents/src/script-engine/virtual-cli.test.ts`
- [ ] `workers/agents/src/script-engine/virtual-cli.ts`
- [ ] `workers/agents/src/script-engine/virtual-posix.test.ts`
- [ ] `workers/agents/src/script-engine/virtual-posix.ts`
- [x] `workers/agents/src/script-engine/worker-capabilities.test.ts`
- [x] `workers/agents/src/script-engine/worker-capabilities.ts`
- [ ] `workers/agents/src/script-engine/worker-model-routing.test.ts`
- [ ] `workers/agents/src/script-engine/worker-model-routing.ts`
- [ ] `workers/agents/src/script-engine/workspace-paths.ts`
- [ ] `workers/agents/src/script-engine/write-guard.test.ts`

### `workers/agents/src/script-engine/daemons`

- [ ] `workers/agents/src/script-engine/daemons/daemon-mcp.test.ts`
- [ ] `workers/agents/src/script-engine/daemons/daemon-mcp.ts`
- [ ] `workers/agents/src/script-engine/daemons/daemons.test.ts`
- [ ] `workers/agents/src/script-engine/daemons/durable-daemon.ts`
- [ ] `workers/agents/src/script-engine/daemons/tree-sitter-indexer.ts`

### `workers/agents/src/script-engine/memory`

- [ ] `workers/agents/src/script-engine/memory/gate-memory.ts`

### `workers/agents/src/script-engine/prebuilt`

- [ ] `workers/agents/src/script-engine/prebuilt/approvals.ts`
- [x] `workers/agents/src/script-engine/prebuilt/artifacts.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/attachments.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/attachments.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/browser-use.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/business-diagnostics.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/business-email.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/business-email.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/business-wallet.ts`
- [x] `workers/agents/src/script-engine/prebuilt/code-exec-fetch.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/code-exec-lsp.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/code-exec-python.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/code-exec.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/commerce.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/commerce.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/computer-use.ts`
- [x] `workers/agents/src/script-engine/prebuilt/conversation.test.ts`
- [x] `workers/agents/src/script-engine/prebuilt/conversation.ts`
- [x] `workers/agents/src/script-engine/prebuilt/customer-attachments.test.ts`
- [x] `workers/agents/src/script-engine/prebuilt/customer-attachments.ts`
- [x] `workers/agents/src/script-engine/prebuilt/customer-bot.test.ts`
- [x] `workers/agents/src/script-engine/prebuilt/customer-bot.ts`
- [x] `workers/agents/src/script-engine/prebuilt/document-processing.test.ts`
- [x] `workers/agents/src/script-engine/prebuilt/document-processing.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/dynamic-workflow.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/executive-cabinet.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/executive-cabinet.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/fabric.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/file-manager.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/foundry-inbox.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/foundry-inbox.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/goal-planner.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/index.ts`
- [x] `workers/agents/src/script-engine/prebuilt/knowledge-base.test.ts`
- [x] `workers/agents/src/script-engine/prebuilt/knowledge-base.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/language-detection.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/language-detection.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/language-glossary.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/language-glossary.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/language-translation.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/language-translation.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/local-machine.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/lock.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/mcp-connector.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/memory.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/model-race-script.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/model-race-script.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/model-race.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/model-race.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/notifications.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/notifications.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/plan.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/plan.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/project-coordination-capabilities.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/project-coordination.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/project-journal.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/r2-workspace-boundaries.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/r2-workspace.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/revenue-tracker.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/runtime-discovery.test.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/runtime-discovery.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/schedule.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/skill-manager.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/storefront.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/sub-agent.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/tasks.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/voice-desk.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/wallet.ts`
- [x] `workers/agents/src/script-engine/prebuilt/web-search.test.ts`
- [x] `workers/agents/src/script-engine/prebuilt/web-search.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/wiki.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/workspace-admin.ts`
- [ ] `workers/agents/src/script-engine/prebuilt/workspace.ts`

### `workers/agents/src/shared`

- [ ] `workers/agents/src/shared/ai-client.test.ts`
- [ ] `workers/agents/src/shared/ai-client.ts`
- [ ] `workers/agents/src/shared/bounded-response-text.test.ts`
- [ ] `workers/agents/src/shared/bounded-response-text.ts`
- [x] `workers/agents/src/shared/document-files.test.ts`
- [x] `workers/agents/src/shared/document-files.ts`
- [ ] `workers/agents/src/shared/openrouter-entitlement.test.ts`
- [ ] `workers/agents/src/shared/openrouter-entitlement.ts`
- [ ] `workers/agents/src/shared/openrouter-model-catalog.test.ts`
- [ ] `workers/agents/src/shared/openrouter-model-catalog.ts`
- [ ] `workers/agents/src/shared/openrouter-model-recommendations.test.ts`
- [ ] `workers/agents/src/shared/openrouter-model-recommendations.ts`
- [x] `workers/agents/src/shared/scaledown.test.ts`
- [x] `workers/agents/src/shared/scaledown.ts`

### `workers/agents/src/telemetry`

- [ ] `workers/agents/src/telemetry/customer-telemetry.ts`

### `workers/agents/src/tunnels`

- [x] `workers/agents/src/tunnels/host.test.ts`
- [x] `workers/agents/src/tunnels/host.ts`
- [x] `workers/agents/src/tunnels/request-journal.ts`

### `workers/agents/src/voice`

- [ ] `workers/agents/src/voice/call-reconciliation.test.ts`
- [ ] `workers/agents/src/voice/call-reconciliation.ts`
- [ ] `workers/agents/src/voice/customer-telephony.test.ts`
- [ ] `workers/agents/src/voice/customer-telephony.ts`
- [x] `workers/agents/src/voice/customer-voice-agent-suspension.test.ts`
- [ ] `workers/agents/src/voice/customer-voice-agent.ts`
- [ ] `workers/agents/src/voice/owner-voice-agent.ts`
- [ ] `workers/agents/src/voice/planner-turn.test.ts`
- [ ] `workers/agents/src/voice/planner-turn.ts`
- [ ] `workers/agents/src/voice/twilio-number-pricing.test.ts`
- [ ] `workers/agents/src/voice/twilio-number-pricing.ts`
- [ ] `workers/agents/src/voice/twilio-number-purchase-route.test.ts`
- [ ] `workers/agents/src/voice/twilio-number-search.test.ts`
- [ ] `workers/agents/src/voice/twilio-number-search.ts`
- [ ] `workers/agents/src/voice/voice-pipeline.ts`
- [ ] `workers/agents/src/voice/voice-ticket.test.ts`
- [ ] `workers/agents/src/voice/voice-ticket.ts`
- [ ] `workers/agents/src/voice/voice.test.ts`

### `workers/agents/src/workflows`

- [ ] `workers/agents/src/workflows/AgentTaskWorkflow.ts`
- [ ] `workers/agents/src/workflows/ScriptRunWorkflow.ts`
- [ ] `workers/agents/src/workflows/agent-task-checkpoints.test.ts`
- [ ] `workers/agents/src/workflows/agent-task-checkpoints.ts`
- [ ] `workers/agents/src/workflows/chunked-subagent-workflow.ts`
- [ ] `workers/agents/src/workflows/company-automation-workflow.ts`
- [ ] `workers/agents/src/workflows/customer-analytics-workflow.ts`
- [ ] `workers/agents/src/workflows/document-processing-workflow.test.ts`
- [ ] `workers/agents/src/workflows/dynamic-script-workflow.ts`
- [ ] `workers/agents/src/workflows/generic-subagent-workflow.ts`
- [ ] `workers/agents/src/workflows/outbound-reminder-workflow.ts`
- [ ] `workers/agents/src/workflows/reconciliation-a2.test.ts`
- [ ] `workers/agents/src/workflows/report-infra-usage.test.ts`
- [ ] `workers/agents/src/workflows/report-infra-usage.ts`
- [ ] `workers/agents/src/workflows/workflow-compiler.ts`
- [ ] `workers/agents/src/workflows/workflow-control.ts`
- [ ] `workers/agents/src/workflows/workflow-extension-scope.test.ts`
- [ ] `workers/agents/src/workflows/workflow-harness.ts`
- [ ] `workers/agents/src/workflows/workflow-host.ts`
- [ ] `workers/agents/src/workflows/workflow-orchestration.test.ts`
- [ ] `workers/agents/src/workflows/workflow-orchestration.ts`
- [ ] `workers/agents/src/workflows/workflow-state.test.ts`
- [ ] `workers/agents/src/workflows/workflow-state.ts`

### `workers/analytics`

- [ ] `workers/analytics/package.json`
- [ ] `workers/analytics/tsconfig.json`
- [ ] `workers/analytics/vitest.config.ts`
- [x] `workers/analytics/wrangler.toml`

### `workers/analytics/src`

- [ ] `workers/analytics/src/events.ts`
- [x] `workers/analytics/src/index.test.ts`
- [x] `workers/analytics/src/index.ts`
- [ ] `workers/analytics/src/query.test.ts`
- [ ] `workers/analytics/src/query.ts`
- [x] `workers/analytics/src/queue.test.ts`

### `workers/artifact`

- [ ] `workers/artifact/package.json`
- [ ] `workers/artifact/tsconfig.json`
- [ ] `workers/artifact/vitest.config.ts`
- [x] `workers/artifact/wrangler.toml`

### `workers/artifact/src`

- [x] `workers/artifact/src/RepositoryDO-boundaries.test.ts`
- [ ] `workers/artifact/src/RepositoryDO.ts`
- [x] `workers/artifact/src/index.test.ts`
- [x] `workers/artifact/src/index.ts`
- [ ] `workers/artifact/src/repository-token.test.ts`
- [ ] `workers/artifact/src/repository-token.ts`
- [ ] `workers/artifact/src/repository.test.ts`
- [ ] `workers/artifact/src/repository.ts`
- [ ] `workers/artifact/src/request-body-boundaries.test.ts`

### `workers/assistant`

- [ ] `workers/assistant/package.json`
- [ ] `workers/assistant/tsconfig.json`
- [x] `workers/assistant/wrangler.toml`

### `workers/assistant/src`

- [x] `workers/assistant/src/index.test.ts`
- [x] `workers/assistant/src/index.ts`

### `workers/auth`

- [x] `workers/auth/package.json`
- [x] `workers/auth/tsconfig.json`
- [x] `workers/auth/vitest.config.ts`
- [x] `workers/auth/wrangler.toml`

### `workers/auth/src`

- [x] `workers/auth/src/health.test.ts`
- [x] `workers/auth/src/index.ts`

### `workers/billing`

- [x] `workers/billing/package.json`
- [x] `workers/billing/tsconfig.json`
- [x] `workers/billing/vitest.config.ts`
- [x] `workers/billing/wrangler.toml`

### `workers/billing/src`

- [x] `workers/billing/src/fee-policy.test.ts`
- [x] `workers/billing/src/fee-policy.ts`
- [ ] `workers/billing/src/index.ts`
- [ ] `workers/billing/src/lemon-squeezy.ts`
- [x] `workers/billing/src/llm-quota-reservations.test.ts`
- [x] `workers/billing/src/ls-products.test.ts`
- [ ] `workers/billing/src/ls-products.ts`
- [x] `workers/billing/src/marketplace-licenses.ts`
- [x] `workers/billing/src/partner-portal.test.ts`
- [ ] `workers/billing/src/partner-portal.ts`
- [x] `workers/billing/src/payout-reconciliation.test.ts`
- [x] `workers/billing/src/payout-reconciliation.ts`
- [x] `workers/billing/src/quota.ts`
- [x] `workers/billing/src/request-body-boundaries.test.ts`
- [x] `workers/billing/src/settlement.test.ts`
- [x] `workers/billing/src/settlement.ts`
- [x] `workers/billing/src/wallet-checkout.ts`
- [ ] `workers/billing/src/whop-oauth-billing.ts`
- [x] `workers/billing/src/whop-wallet.ts`

### `workers/browser`

- [x] `workers/browser/package.json`
- [x] `workers/browser/tsconfig.json`
- [x] `workers/browser/vitest.config.ts`
- [x] `workers/browser/wrangler.local.toml`
- [x] `workers/browser/wrangler.toml`

### `workers/browser/src`

- [x] `workers/browser/src/BrowserSessionDO-boundaries.test.ts`
- [x] `workers/browser/src/BrowserSessionDO.test.ts`
- [ ] `workers/browser/src/BrowserSessionDO.ts`
- [x] `workers/browser/src/browser-observation-bounds.test.ts`
- [x] `workers/browser/src/browser-observation-bounds.ts`
- [x] `workers/browser/src/browser-session-state.test.ts`
- [x] `workers/browser/src/browser-session-state.ts`
- [x] `workers/browser/src/index.ts`

### `workers/connector-gumroad`

- [x] `workers/connector-gumroad/package.json`
- [x] `workers/connector-gumroad/tsconfig.json`
- [x] `workers/connector-gumroad/vitest.config.ts`
- [x] `workers/connector-gumroad/wrangler.toml`

### `workers/connector-gumroad/src`

- [x] `workers/connector-gumroad/src/index.test.ts`
- [x] `workers/connector-gumroad/src/index.ts`

### `workers/connector-whop`

- [x] `workers/connector-whop/package.json`
- [x] `workers/connector-whop/tsconfig.json`
- [x] `workers/connector-whop/vitest.config.ts`
- [x] `workers/connector-whop/wrangler.toml`

### `workers/connector-whop/src`

- [x] `workers/connector-whop/src/index.test.ts`
- [x] `workers/connector-whop/src/index.ts`

### `workers/credentials`

- [x] `workers/credentials/package.json`
- [x] `workers/credentials/tsconfig.json`
- [x] `workers/credentials/vitest.config.ts`
- [x] `workers/credentials/wrangler.toml`

### `workers/credentials/src`

- [x] `workers/credentials/src/air-gap.test.ts`
- [x] `workers/credentials/src/index.ts`
- [x] `workers/credentials/src/outbound-auth.test.ts`
- [x] `workers/credentials/src/request-body-boundaries.test.ts`

### `workers/eval`

- [x] `workers/eval/package.json`
- [x] `workers/eval/tsconfig.json`
- [x] `workers/eval/wrangler.toml`

### `workers/eval/src`

- [x] `workers/eval/src/index.test.ts`
- [x] `workers/eval/src/index.ts`
- [x] `workers/eval/src/trace-checks.test.ts`
- [x] `workers/eval/src/trace-checks.ts`

### `workers/knowledge`

- [x] `workers/knowledge/package.json`
- [x] `workers/knowledge/tsconfig.json`
- [x] `workers/knowledge/vitest.config.ts`
- [x] `workers/knowledge/wrangler.toml`

### `workers/knowledge/src`

- [x] `workers/knowledge/src/air-gap.test.ts`
- [x] `workers/knowledge/src/document-lifecycle.test.ts`
- [x] `workers/knowledge/src/external-publications.test.ts`
- [x] `workers/knowledge/src/foundry-sharing.test.ts`
- [ ] `workers/knowledge/src/index.ts`
- [x] `workers/knowledge/src/kb-search-boundaries.test.ts`
- [x] `workers/knowledge/src/parse-v5.test.ts`
- [x] `workers/knowledge/src/parse-v5.ts`
- [x] `workers/knowledge/src/search.test.ts`
- [x] `workers/knowledge/src/search.ts`
- [x] `workers/knowledge/src/semantic-cache-boundaries.test.ts`
- [x] `workers/knowledge/src/storage-usage.test.ts`
- [x] `workers/knowledge/src/storage-usage.ts`
- [x] `workers/knowledge/src/web-fetch.test.ts`

### `workers/marketplace`

- [x] `workers/marketplace/package.json`
- [x] `workers/marketplace/tsconfig.json`
- [x] `workers/marketplace/wrangler.toml`

### `workers/marketplace/src`

- [x] `workers/marketplace/src/index.ts`

### `workers/mcp-hub`

- [x] `workers/mcp-hub/package.json`
- [x] `workers/mcp-hub/tsconfig.json`
- [x] `workers/mcp-hub/wrangler.toml`

### `workers/mcp-hub/src`

- [x] `workers/mcp-hub/src/air-gap.test.ts`
- [x] `workers/mcp-hub/src/composio.test.ts`
- [x] `workers/mcp-hub/src/composio.ts`
- [x] `workers/mcp-hub/src/connector-policy.test.ts`
- [x] `workers/mcp-hub/src/connector-policy.ts`
- [x] `workers/mcp-hub/src/index.ts`
- [x] `workers/mcp-hub/src/pipedream.ts`
- [x] `workers/mcp-hub/src/tenant-space-boundary.test.ts`
- [x] `workers/mcp-hub/src/upstream-response-boundaries.test.ts`

### `workers/notifications`

- [x] `workers/notifications/package.json`
- [x] `workers/notifications/tsconfig.json`
- [x] `workers/notifications/vitest.config.ts`
- [x] `workers/notifications/wrangler.toml`

### `workers/notifications/src`

- [x] `workers/notifications/src/air-gap.test.ts`
- [x] `workers/notifications/src/apns-boundaries.test.ts`
- [x] `workers/notifications/src/index.ts`
- [x] `workers/notifications/src/interactive.test.ts`
- [x] `workers/notifications/src/queue-config.test.ts`
- [x] `workers/notifications/src/queue-idempotency.test.ts`
- [x] `workers/notifications/src/web-push.test.ts`
- [x] `workers/notifications/src/web-push.ts`
- [x] `workers/notifications/src/webhook-egress.test.ts`

### `workers/portal-router`

- [x] `workers/portal-router/package.json`
- [x] `workers/portal-router/tsconfig.json`
- [x] `workers/portal-router/wrangler.toml`

### `workers/portal-router/src`

- [x] `workers/portal-router/src/index.ts`

### `workers/provisioner`

- [x] `workers/provisioner/package.json`
- [x] `workers/provisioner/tsconfig.json`
- [x] `workers/provisioner/vitest.config.ts`
- [x] `workers/provisioner/wrangler.toml`

### `workers/provisioner/src`

- [x] `workers/provisioner/src/custom-provisioner-egress.test.ts`
- [x] `workers/provisioner/src/index.ts`
- [x] `workers/provisioner/src/manifest-contract.test.ts`
- [x] `workers/provisioner/src/manifest-contract.ts`
- [x] `workers/provisioner/src/message-contract.test.ts`
- [x] `workers/provisioner/src/message-contract.ts`
- [x] `workers/provisioner/src/provisioning-lease.ts`
- [x] `workers/provisioner/src/provisioning-required-routes.test.ts`
- [x] `workers/provisioner/src/provisioning-state.test.ts`
- [x] `workers/provisioner/src/provisioning-state.ts`
- [x] `workers/provisioner/src/queue-config.test.ts`
- [x] `workers/provisioner/src/queue-message-handler.test.ts`
- [x] `workers/provisioner/src/queue-message-handler.ts`
- [x] `workers/provisioner/src/rollback-cleanup.test.ts`
- [x] `workers/provisioner/src/tenant-suspension.test.ts`

### `workers/router`

- [x] `workers/router/package.json`
- [x] `workers/router/tsconfig.json`
- [x] `workers/router/vitest.config.ts`
- [x] `workers/router/wrangler.toml`

### `workers/router/src`

- [x] `workers/router/src/RateLimitDO-boundaries.test.ts`
- [x] `workers/router/src/RateLimitDO.ts`
- [x] `workers/router/src/customer-voice-routing.test.ts`
- [x] `workers/router/src/extension-product-paths.test.ts`
- [x] `workers/router/src/extension-provider-routing.test.ts`
- [x] `workers/router/src/health.test.ts`
- [x] `workers/router/src/index.ts`
- [x] `workers/router/src/portal-domain-routing.test.ts`
- [x] `workers/router/src/preauth-rate-limit.test.ts`
- [x] `workers/router/src/preferred-language.test.ts`
- [x] `workers/router/src/preferred-language.ts`
- [x] `workers/router/src/tenant-status.test.ts`
- [x] `workers/router/src/tenant-status.ts`

### `workers/router/src/routes`

- [x] `workers/router/src/routes/bounded-ingress.test.ts`
- [x] `workers/router/src/routes/bounded-request-body.ts`
- [x] `workers/router/src/routes/ogg-opus.test.ts`
- [x] `workers/router/src/routes/ogg-opus.ts`
- [x] `workers/router/src/routes/transcribe.test.ts`
- [x] `workers/router/src/routes/transcribe.ts`

### `workers/security-gateway`

- [x] `workers/security-gateway/package.json`
- [x] `workers/security-gateway/tsconfig.json`
- [x] `workers/security-gateway/vitest.config.ts`
- [x] `workers/security-gateway/wrangler.toml`

### `workers/security-gateway/src`

- [x] `workers/security-gateway/src/index.test.ts`
- [x] `workers/security-gateway/src/index.ts`

### `workers/spaces`

- [ ] `workers/spaces/package.json`
- [ ] `workers/spaces/tsconfig.json`
- [x] `workers/spaces/vitest.config.ts`
- [x] `workers/spaces/wrangler.toml`

### `workers/spaces/src`

- [ ] `workers/spaces/src/BlueprintConformanceWorkflow.ts`
- [x] `workers/spaces/src/builder-routes.ts`
- [x] `workers/spaces/src/business-auth.ts`
- [ ] `workers/spaces/src/business-create.test.ts`
- [x] `workers/spaces/src/business-create.ts`
- [ ] `workers/spaces/src/business-erasure.ts`
- [x] `workers/spaces/src/business-routes.test.ts`
- [x] `workers/spaces/src/business-routes.ts`
- [x] `workers/spaces/src/business-services.test.ts`
- [x] `workers/spaces/src/cf-saas.test.ts`
- [x] `workers/spaces/src/cf-saas.ts`
- [ ] `workers/spaces/src/conformance-state.test.ts`
- [ ] `workers/spaces/src/conformance-state.ts`
- [x] `workers/spaces/src/create-space.ts`
- [ ] `workers/spaces/src/customer-voice-bridge.test.ts`
- [ ] `workers/spaces/src/domain-glossary-routes.test.ts`
- [ ] `workers/spaces/src/domain-glossary.test.ts`
- [ ] `workers/spaces/src/domain-glossary.ts`
- [ ] `workers/spaces/src/erasure-request-state.ts`
- [ ] `workers/spaces/src/extension-storage-usage.test.ts`
- [ ] `workers/spaces/src/extension-storage-usage.ts`
- [x] `workers/spaces/src/extensions-gadgets.test.ts`
- [ ] `workers/spaces/src/foundry-and-cross-space.test.ts`
- [ ] `workers/spaces/src/health.test.ts`
- [x] `workers/spaces/src/index.ts`
- [ ] `workers/spaces/src/infra-migrations.test.ts`
- [x] `workers/spaces/src/language-preference-routes.test.ts`
- [x] `workers/spaces/src/launchpad-manifest.ts`
- [x] `workers/spaces/src/members-suspension.test.ts`
- [ ] `workers/spaces/src/private-scratchpad.test.ts`
- [x] `workers/spaces/src/product-end-user-air-gap.test.ts`
- [x] `workers/spaces/src/product-end-user-routes.test.ts`
- [x] `workers/spaces/src/product-end-user-routes.ts`
- [ ] `workers/spaces/src/product-user-erasure.ts`
- [ ] `workers/spaces/src/project-automation.test.ts`
- [ ] `workers/spaces/src/project-external-quota.ts`
- [ ] `workers/spaces/src/project-steward-decisions.test.ts`
- [ ] `workers/spaces/src/project-steward-decisions.ts`
- [ ] `workers/spaces/src/project-steward-extension.ts`
- [x] `workers/spaces/src/project-steward-suspension.test.ts`
- [ ] `workers/spaces/src/project-steward.test.ts`
- [ ] `workers/spaces/src/project-steward.ts`
- [ ] `workers/spaces/src/remediation-pass-2.test.ts`
- [x] `workers/spaces/src/request-body-boundaries.test.ts`
- [ ] `workers/spaces/src/space-hierarchy-policy.test.ts`
- [ ] `workers/spaces/src/state-delta-conformance.ts`
- [ ] `workers/spaces/src/task-coordination.test.ts`
- [x] `workers/spaces/src/template-catalog.test.ts`
- [x] `workers/spaces/src/template-catalog.ts`
- [x] `workers/spaces/src/tenancy.ts`
- [ ] `workers/spaces/src/thread-hierarchy.test.ts`
- [x] `workers/spaces/src/tunnel-authority-suspension.test.ts`
- [ ] `workers/spaces/src/webhook-defense.test.ts`
- [ ] `workers/spaces/src/workflow-plan-authoring.test.ts`

### `workers/spaces/src/do`

- [x] `workers/spaces/src/do/BuilderAccountDO.ts`
- [x] `workers/spaces/src/do/FeatureFlagDO.test.ts`
- [x] `workers/spaces/src/do/FeatureFlagDO.ts`
- [x] `workers/spaces/src/do/LockDO.test.ts`
- [x] `workers/spaces/src/do/LockDO.ts`
- [x] `workers/spaces/src/do/MicroAppDO.ts`
- [x] `workers/spaces/src/do/ProductUserDO-credit-reservations.test.ts`
- [x] `workers/spaces/src/do/ProductUserDO.ts`
- [ ] `workers/spaces/src/do/SpaceDO-migrations.test.ts`
- [ ] `workers/spaces/src/do/SpaceDO.ts`
- [x] `workers/spaces/src/do/SpaceTypeRegistryDO.test.ts`
- [x] `workers/spaces/src/do/SpaceTypeRegistryDO.ts`
- [x] `workers/spaces/src/do/TransactionCoordinatorDO.test.ts`
- [x] `workers/spaces/src/do/TransactionCoordinatorDO.ts`
- [ ] `workers/spaces/src/do/additional-space-do-request-boundaries.test.ts`
- [ ] `workers/spaces/src/do/artifact-linter.test.ts`
- [ ] `workers/spaces/src/do/custom-model-lifecycle-do.test.ts`
- [ ] `workers/spaces/src/do/custom-model-lifecycle.test.ts`
- [ ] `workers/spaces/src/do/custom-model-lifecycle.ts`
- [ ] `workers/spaces/src/do/custom-model-test-vault.test.ts`
- [ ] `workers/spaces/src/do/custom-model-test-vault.ts`
- [ ] `workers/spaces/src/do/customer-voice-calls.test.ts`
- [ ] `workers/spaces/src/do/domain-glossary.test.ts`
- [ ] `workers/spaces/src/do/executive-contacts.test.ts`
- [ ] `workers/spaces/src/do/extension-runtime-install.test.ts`
- [x] `workers/spaces/src/do/gadget-mcp-crud.test.ts`
- [ ] `workers/spaces/src/do/project-spend-reservations.test.ts`
- [ ] `workers/spaces/src/do/project-subspace-migration-preflight.test.ts`
- [ ] `workers/spaces/src/do/provenance-ledger.test.ts`
- [ ] `workers/spaces/src/do/public-dynamic-pages.test.ts`
- [ ] `workers/spaces/src/do/pull-request-cards.test.ts`
- [ ] `workers/spaces/src/do/session-compact-scope.test.ts`
- [x] `workers/spaces/src/do/session-create-idempotency.test.ts`
- [ ] `workers/spaces/src/do/session-message-pagination.test.ts`
- [ ] `workers/spaces/src/do/space-backup.test.ts`
- [ ] `workers/spaces/src/do/space-backup.ts`
- [ ] `workers/spaces/src/do/space-data-ops.test.ts`
- [ ] `workers/spaces/src/do/space-do-request-boundaries.test.ts`
- [ ] `workers/spaces/src/do/space-retention.test.ts`
- [ ] `workers/spaces/src/do/space-retention.ts`

### `workers/spaces/src/routes`

- [ ] `workers/spaces/src/routes/channel-extensions.test.ts`
- [ ] `workers/spaces/src/routes/desk-drop.ts`
- [x] `workers/spaces/src/routes/dynamic-pages.test.ts`
- [x] `workers/spaces/src/routes/dynamic-pages.ts`
- [x] `workers/spaces/src/routes/extension-gadget.test.ts`
- [x] `workers/spaces/src/routes/extension-gadget.ts`
- [x] `workers/spaces/src/routes/gadget-mcp.test.ts`
- [x] `workers/spaces/src/routes/gadget-mcp.ts`
- [ ] `workers/spaces/src/routes/graduation.ts`
- [ ] `workers/spaces/src/routes/market-radar.test.ts`
- [ ] `workers/spaces/src/routes/market-radar.ts`
- [ ] `workers/spaces/src/routes/marketplace.test.ts`
- [ ] `workers/spaces/src/routes/marketplace.ts`
- [ ] `workers/spaces/src/routes/mcp.test.ts`
- [ ] `workers/spaces/src/routes/mcp.ts`
- [ ] `workers/spaces/src/routes/project-subspaces.test.ts`
- [ ] `workers/spaces/src/routes/recipes.test.ts`
- [ ] `workers/spaces/src/routes/recipes.ts`

### `workers/sweeper`

- [x] `workers/sweeper/package.json`
- [x] `workers/sweeper/tsconfig.json`
- [x] `workers/sweeper/vitest.config.ts`
- [x] `workers/sweeper/wrangler.toml`

### `workers/sweeper/src`

- [x] `workers/sweeper/src/index.test.ts`
- [x] `workers/sweeper/src/index.ts`

### `workers/synthetics`

- [x] `workers/synthetics/package.json`
- [x] `workers/synthetics/tsconfig.json`
- [x] `workers/synthetics/wrangler.toml`

### `workers/synthetics/src`

- [x] `workers/synthetics/src/index.test.ts`
- [x] `workers/synthetics/src/index.ts`

### `workers/threads`

- [ ] `workers/threads/package.json`
- [ ] `workers/threads/tsconfig.json`
- [x] `workers/threads/wrangler.toml`

### `workers/threads/src`

- [x] `workers/threads/src/index.test.ts`
- [ ] `workers/threads/src/index.ts`

### `workers/workflows`

- [ ] `workers/workflows/package.json`
- [ ] `workers/workflows/tsconfig.json`
- [x] `workers/workflows/wrangler.toml`

### `workers/workflows/src`

- [ ] `workers/workflows/src/env.ts`
- [ ] `workers/workflows/src/index.ts`
- [x] `workers/workflows/src/queue-consumer.test.ts`
- [ ] `workers/workflows/src/queue-consumer.ts`

### `workers/workflows/src/workflows`

- [ ] `workers/workflows/src/workflows/DataErasureWorkflow.ts`
- [ ] `workers/workflows/src/workflows/DunningWorkflow.ts`
- [ ] `workers/workflows/src/workflows/KbIngestionWorkflow.ts`
- [ ] `workers/workflows/src/workflows/QueueHealthWorkflow.ts`
- [ ] `workers/workflows/src/workflows/SpaceProvisioningWorkflow.ts`
- [x] `workers/workflows/src/workflows/erasure-cleanup.test.ts`
- [x] `workers/workflows/src/workflows/erasure-cleanup.ts`
- [ ] `workers/workflows/src/workflows/space-provisioning-state.test.ts`
- [ ] `workers/workflows/src/workflows/space-provisioning-state.ts`

### `workers/ws-gateway`

- [ ] `workers/ws-gateway/package.json`
- [ ] `workers/ws-gateway/tsconfig.json`
- [x] `workers/ws-gateway/wrangler.toml`

### `workers/ws-gateway/src`

- [ ] `workers/ws-gateway/src/index.ts`
- [ ] `workers/ws-gateway/src/node-lease-gate.test.ts`
- [ ] `workers/ws-gateway/src/node-lease-gate.ts`
- [ ] `workers/ws-gateway/src/session-meta.test.ts`
- [ ] `workers/ws-gateway/src/session-meta.ts`
- [ ] `workers/ws-gateway/src/ui-action-delegation.test.ts`
