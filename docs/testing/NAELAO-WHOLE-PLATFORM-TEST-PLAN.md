# Naelao whole-platform test plan

**Status:** execution plan; no new tests are claimed by this document  
**Prepared:** 2026-11-03  
**Scope:** the user-visible Naelao product, its Workers and Durable Objects, persistence, extensions/templates, agent runtime, execution environments, security, billing, and deployment

This plan extends the claim-led experiments in [`NAELAO-CLAIM-LEDGER-AND-NEXT-EXPERIMENTS.md`](./NAELAO-CLAIM-LEDGER-AND-NEXT-EXPERIMENTS.md). It does not replace focused agent experiments or turn old run records into fresh evidence. Before each execution, capture the current full commit SHA and branch refs, then record new results against that exact SHA.

## What “fully tested” means here

No finite test suite can prove every possible behavior of a platform this large. The goal is to ensure every shipped surface and external boundary is inventoried, tested at the appropriate layer, and accurately labeled. Every feature must be one of:

- **Supported and passed:** required test layers passed on the recorded SHA.
- **Supported with a known limitation:** tests passed for a stated subset; limitations are visible to the user and operator.
- **Disabled:** the release configuration prevents use and tests confirm it fails closed.
- **Blocked externally:** source coverage exists, but a required account, credential, live resource, or machine is unavailable.
- **Unassessed:** no adequate evidence yet; it cannot be advertised as working.

“Green CI” is not the same as “all product behavior passed.” The final status must include each required suite result, skipped/blocked tests, the workflow conclusion, and whether an edge was mocked, locally emulated, provider-live, or Cloudflare-live.

## Evidence levels

| Level | Evidence | Examples |
|---|---|---|
| L0 | Static/schema/unit | Request validation, state transitions, SDK contracts |
| L1 | Multi-worker local integration | Wrangler Workers, real local D1/SQLite DO/R2/Queues, synthetic provider |
| L2 | Full local browser journey | Browser to local UI/API/Workers/storage with persisted results |
| L3 | External provider test | Bounded request or webhook using a provider test account/key |
| L4 | Cloudflare staging acceptance | Deployed staging Workers, real bindings, migration, logs, rollback |
| L5 | One-user observed pilot | Consented user, limited feature set, monitored outcomes and spend |

Evidence does not inherit upward. An L1 mock does not prove L3 provider behavior; L4 does not prove user outcomes at L5.

## Test subject and environment rules

1. Fetch `work` and `Mcbt5s-Backup-2`; record and compare their SHAs before a run. The SHA tested must be the SHA promoted.
2. Run deterministic and resource-heavy suites in GitHub Actions. Run Wrangler integration locally or in Actions with isolated persistence directories. Use one disposable Cloudflare staging tenant for live acceptance.
3. Never run experiments against real user or business data. Use generated tenants, synthetic documents, fake contact details, and reversible provider test objects.
4. Put credentials in local ignored `.dev.vars` or GitHub environment secrets. Artifacts may contain request IDs, hashes, counters, aggregate timing, and safe error codes; never prompts, credentials, customer data, cookies, or tokens.
5. Keep paid providers off unless a batch explicitly opts in. Every live batch has a request cap, a dollar cap, a timeout, and cleanup steps. Record zero calls as zero calls; do not label a blocked provider as passed.
6. A feature disabled by default remains disabled during unrelated tests. For a feature test, enable it only in an isolated local or staging environment and record the exact override.
7. Retired business-wallet/accounting behavior and hard-coded customer-bot behavior are not feature targets. Include a negative-route test proving retired behavior is unavailable or extension-owned.

## Platform inventory required before test batches

Generate a versioned inventory that maps product surface → route → Worker → binding/data store → feature flag → existing suite → missing suite. Reconcile it against `workers/*/wrangler.toml`, frontend route trees, package manifests, D1 migrations, `wrangler` bindings, and deployment workflows.

The initial inventory must cover at least these domains:

| Domain | Surfaces and dependencies to inventory |
|---|---|
| Product shell | Dashboard, shell, portal, marketplace web, widget; routing, auth state, responsive layouts, error/empty/loading states |
| Accounts and authority | Auth, sessions, account recovery, Space membership/roles, owner/admin/member/viewer, internal service identity, team-only tools |
| Spaces and Projects | Generic default product, Space creation, templates, Project lifecycle, assistant identity, project/assistant workspaces, VFS and deletion |
| Assistants and workers | Space Assistant, Project Assistant/Bot, task/thread workers, planner, decisions, worker pools, tools/skills/knowledge, approvals |
| Coordination | Space and worker blackboards, journals, recipient policies, delivery/wake, fixer/escalation, summaries and dashboards |
| Extensions and distribution | Extension discovery/install/grants/lifecycle, gadgets, canvases, channels, workflows, commands, templates, marketplace certification |
| Execution | Six-tier/virtual CLI, scripts, MCP, browser, managed sidecars, user-connected bridge/tunnels, container profiles, queues and concurrency |
| Data | SpaceDO/AgentDO SQLite, D1, R2/artifacts, KV/cache, Vectorize, queues/outbox, migration and retention paths |
| Knowledge and media | Ingestion, indexing, search, citations, OCR/transcription/media adapters, size and format boundaries |
| Connections and channels | MCP Hub/connectors, secrets vault, web, email, WhatsApp, SMS/voice, webhook signatures, revocation and delivery receipts |
| Platform operations | Billing/entitlements/usage, provisioner, marketplace, admin, analytics, notifications, synthetics, sweeper, workflows, eval, observability |
| Deployment | 26 configured Worker projects, service bindings, environments, Pages/frontends, D1 migration runner, secret/config parity, rollback |

For each route and event path, add a test link or a precise `unassessed/disabled/external` reason. If a surface has no observable assertion, it is not covered merely because its Worker was deployed.

## Execution batches

Run independent static suites in parallel. Keep stateful/local-runtime and live batches ordered. If one batch fails, preserve the failing artifact, diagnose the smallest reproducer, fix the cause, rerun that batch and its dependents, and continue unrelated batches when their prerequisites remain valid.

### Batch 0 — Freeze the tested build and enumerate coverage

**Work:** synchronize branches; record SHA; install from the lockfile on a clean runner; run build, typecheck, lint/security checks, conformance, unit/workspace tests, and existing full inventory. Produce the platform inventory above and map enabled flags to routes.

**Pass:** clean install/build; all required CI jobs and their recorded suite summaries pass; no silent `continue-on-error` or swallowed deploy/test failure; every production-enabled surface is assigned a later batch.

**Output:** `run-manifest.json` with SHA, branch refs, environment, suite outcomes, skipped cases, and artifacts.

### Batch 1 — Worker, binding, and route contract matrix

**Work:** for all 26 Worker configs, validate route ownership, auth middleware, method/content-type limits, service binding targets, environment-specific vars, internal HMAC identity, CORS, error format, and health/readiness behavior. Probe each binding locally where possible. Verify deploy manifests include every intended worker exactly once and that each deploy failure fails the job.

**Negative cases:** missing binding, wrong internal secret, wrong environment, malformed payload, oversized body, method mismatch, stale route, unknown service, provider timeout.

**Pass:** all in-scope routes map to a live handler or an explicit disabled response; no cross-environment binding/secret leakage; no “green” deploy after a missing Worker.

### Batch 2 — Account, Space, Project, and tenant isolation

**Work:** create two test users, two Spaces per user, multiple Projects and all roles. Verify account signup/login, session refresh/revocation, recovery, Space creation from the generic product/template, Project lifecycle, membership changes, archive, deletion, and tenant-safe identifiers.

**Abuse matrix:** cross-user Space ID, cross-Space Project ID, guessed resource IDs, viewer/member escalation, revoked owner/member access, replayed session, CSRF/origin boundaries, route called without the UI, concurrent delete/write.

**Metrics:** allowed/denied confusion matrix, unauthorized side effects, audit attribution, denial status, cleanup residue.

**Pass:** zero unauthorized reads or writes; permissions are checked by the host on every action, including delayed/retried work; deleted or revoked resources cannot be reached through cached grants.

### Batch 3 — Storage, migrations, workspace, and lifecycle durability

**Work:** exercise SpaceDO/AgentDO SQLite, D1, R2, KV, queue/outbox, cache, and search-index references used by the release. Apply migrations from empty state and each supported predecessor; rerun idempotent migration paths; test index/query assumptions and data compatibility.

**Recovery cases:** restart each Worker/DO around a write, duplicate an event, expire an alarm/lease, interrupt an R2 multipart upload, lose a response after commit, restore a backup, and delete a Space/Project with active work and credentials.

**Pass:** no lost acknowledged writes, no duplicate effects, no dangling active grants/jobs, artifacts retain their digest/ownership, retention and deletion finish across all stores, and tested restore/rollback instructions work.

### Batch 4 — Real browser-to-backend journeys

**Journeys:** fresh account → Space → install template → Project → open Space Assistant and Project Assistant → task → worker/CLI → artifact → verification/approval → refresh/reopen → same final state. Include a failed task, retry, cancellation, notification, disconnected/reconnected browser, and role-based denial.

Run at desktop, 338px, and 740px viewports. Assert accessible names, keyboard operation, visible loading/error/empty states, and no success state before durable completion. Use real local API routes and local Wrangler, not seeded fake API responses for the acceptance path.

**Pass:** UI, API, and persistent state agree; trace IDs link screen activity to worker/task/artifact; status visibly distinguishes succeeded, verified, review, uncertain, blocked, failed, and cancelled.

### Batch 5 — Assistant architecture and task lifecycle

**Actors:** Space Assistant, Project Assistant/Bot, task/thread worker, planner, decisions model, and leaf worker must remain distinguishable identities sharing the intended runtime contracts.

**Journeys:** each assistant receives a goal, planner forms valid DAG, host validates it, eligible worker is selected, worker executes scoped tools, evidence is collected independently, verifier evaluates criteria, dependent work waits for required verification, and UI/blackboard shows the final state.

**Failure cases:** invalid/cyclic plans, planner overreach, model timeout/malformed JSON, worker narrative without artifact, stale/wrong-branch/wrong-attempt artifact, changed digest, tool denial, uncertain evidence, reviewer decision, repeated dispatch, task cancel, worker/DO restart.

**Metrics:** valid plans, verified outcomes, false completion/acceptance, review rate, duplicate effects, task recovery, model requests/tokens/actual cost, first response and time to verified result.

**Pass:** zero unauthorized tools, zero false verification in the held-out set, no dependent execution before required evidence passes, and all uncertainty remains reviewable. Decision-model scoring may advise only within host-created eligible options.

### Batch 6 — Blackboard, journals, worker communication, and fixer

**Work:** compare no-board, targeted board, and broadcast across identical seeded tasks. Test project discovery/search pagination, ACL changes, recipient policy, message delivery, wake behavior, summaries, task graph visibility, deterministic fixers, escalation, and prioritization.

**Faults:** duplicate/out-of-order message, expired lease, recipient removed, source Project deleted, blocked assistant, stale journal, fixer crash, ambiguous failure, repeated fix spawning, prompt injection in shared notes.

**Metrics:** verified completion, duplicated work/effects, irrelevant messages, discovery recall, provider calls/tokens/cost, wake latency, fixer resolution/rework, escalation and scope denials.

**Pass:** no cross-scope disclosure, exactly-once committed dispatch/effects, bounded fixer depth/retries, no autonomous repair of ambiguous/high-impact errors, unresolved items visible to an owner. Cost/speed benefit is claimed only if paired measurements support it.

### Batch 7 — Templates, extensions, marketplace, and UI widgets

**Work:** fresh-Space install, extension discovery and dependency resolution, activation preview, permissions/grants, storage isolation, extension events/subscriptions/widgets, chat rendering, connection setup, upgrades, rollback, uninstall, certification and marketplace listing lifecycle.

**Cases:** missing/changed dependency, incompatible extension version, revoked grant, malicious/oversized event, duplicate delivery, disabled capability, failed partial install, downgrade, template plan limit.

**Pass:** extensions receive only declared host-scoped capabilities; output is escaped and schema-validated; no partial active residue after failed install; installed release/version and grants are visible; unsupported requirements are clearly blocked.

### Batch 8 — CLI, SDK, MCP, and execution ladder

**Work:** exercise worker-created commands, dynamic workflows/scripts, SDK `ctx` scopes, MCP auth and permitted connectors, artifact exchange, shell/file APIs, browser/KiteSurf/full browser, managed sidecars, and named-machine tunnels. Test both project and Space workspaces.

**Environment scenarios:** dependent commands on one environment; two tasks needing different containers simultaneously; two tasks contending for the same runtime; crash and restart; cold/warm prewarm; quota limit; no managed runtime; tunnel last-resort selection; tunnel offline/reconnect; host grant revoked mid-command; import/export with resumable chunks.

**Pass:** no workspace or credential/profile crossover; deterministic environment affinity or explicit content-addressed handoff for dependencies; no unsafe retry after uncertain side effect; no tunnel used without policy and owner grant; capacity limits are honored. Where a runtime is unavailable or disabled, assert a clear fail-closed status.

### Batch 9 — Knowledge, files, OCR/media, and browser behavior

**Work:** ingest supported file types, run OCR/transcription only where configured, index and retrieve source-linked content, test freshness/deletion, document limits, malformed files, encoding, extraction failures, and prompt injection in retrieved material. Exercise browser navigation, downloads/uploads, login profile boundaries, timeouts, and approval checkpoints.

**Pass:** source provenance is preserved; wrong or deleted tenant documents never appear; unsupported media is reported honestly; malicious content cannot expand tool authority; browser credentials/profile are isolated by owner and workspace.

### Batch 10 — Connectors, channels, and external providers

First use provider simulators/contract fixtures for connector OAuth, MCP discovery/calls, webhook signature/replay, retries, idempotency, and credential revocation. Then separately opt into live test accounts for each channel actually enabled in the pilot: OpenRouter, email, WhatsApp, Telnyx/Twilio, WebRTC, OAuth providers, or MCP connectors.

For each live provider, test one bounded success and the provider-specific failure/uncertain path, receipt/usage reconciliation, duplicate webhook, timeout, revoke, and cleanup. Do not infer one provider’s acceptance from another’s.

**Pass:** credentials stay in the vault; callbacks are authenticated; retries are safe; usage/cost reconciles or remains explicitly uncertain; disabled channels cannot be activated accidentally.

### Batch 11 — Billing, entitlements, quotas, and cost safety

**Work:** test subscription state, plan entitlements, per-Space/Project/assistant limits, concurrency reservations, model budgets, container reservations, refunds/credits if applicable, webhook reconciliation, suspension, and user-visible limit explanations.

**Cases:** concurrent requests at last credit, duplicated provider receipt, usage delayed, failed reservation, model returns cost higher than reserve, cancellation before/after provider accepted, account suspension during work, billing provider unavailable.

**Pass:** no spend beyond configured ceiling; reservations precede provider attempts; settlement is idempotent and evidence-backed; uncertain spend is held rather than silently refunded or zeroed; UI and ledger agree. Do not test retired business-wallet/accounting behavior as a product feature.

### Batch 12 — Security and privacy review

Run automated dependency/code scans and targeted threat tests for tenant IDOR, auth bypass, prompt injection, SSRF/DNS rebinding, file/path traversal, archive bombs, secret leakage, extension supply chain, webhook spoof/replay, WebSocket auth, unsafe HTML/widgets, token logging, and data retention/deletion.

**Pass:** zero known critical/high release-blocking findings in enabled paths; no unauthorized effects in the held-out matrix; security events are logged without exposing secrets; high-impact uncertainty requires approval. Record accepted residual risks by owner and mitigation.

### Batch 13 — Load, latency, and unit economics

Use generated realistic mixes, first at one user then increasing users/tasks: 1, 2, 5, 10, then stop or increase based on configured quotas. Measure fresh/warm, low/high context, failures, multiple active Spaces, queue contention, blackboard volume, uploads, and background sweeps.

Run at least 30 samples per critical route for p50/p95/p99; use at least 100 tasks per task class before comparing task success. Record request/queue latency, time to first response, time to verified result, CPU, memory, D1 rows, DO requests/duration, R2 operations/storage, container time, model tokens and billed USD, retries, and cost per verified outcome.

**Pass:** no runaway polling/retries, no quota bypass or noisy-neighbor leak, costs reconcile to provider evidence, overload is back-pressured with visible status, and observed saturation is reported. Do not set a fabricated SLO after seeing results; pre-register the target and explain any revision.

### Batch 14 — Cloudflare staging canary and one-user pilot

Only after local gates pass, deploy the exact SHA to isolated staging. Confirm all migrations, service bindings, secrets, D1/DO/R2/queues/alarms, health probes, logs, alerts, and rollback. Run the complete narrow demo path: sign-in → Space/Project → assistant task → authorized CLI action → artifact → verified result → browser refresh/reconnect. Then one bounded model call and one failure/recovery case under a dollar cap.

For a first user, enable only the tested web path; use test data, disclose prototype limitations, cap provider usage, monitor the session, and keep user data export/deletion available. Add email, containers, telephony, WhatsApp, or marketplace distribution only after their individual gates pass.

**Pass:** no migration/deployment drift; all advertised pilot actions pass on the deployed SHA; usage is visible; backup/restore and rollback are demonstrated; cleanup is complete; no open critical blocker remains in the enabled scope.

## GitHub Actions execution design

- Run static/package/component suites as a matrix with explicit result artifacts per suite.
- Run Wrangler multi-worker suites as separate, isolated jobs with bounded concurrency and unique temp state/ports.
- Let independent jobs finish after one suite fails so the run yields a useful failure map, but make the final summary fail if any required suite failed, timed out, was missing, or produced an invalid report.
- Keep provider-live and Cloudflare-live jobs manual, environment-protected, opt-in, with request/time/spend caps. Never make test providers a production routing fallback.
- Upload machine-readable JSON and sanitized logs even on failure. The final summary reports `PASS`, `FAIL`, `BLOCKED_EXTERNAL`, or `NOT_RUN`; a job-level green result alone is insufficient.
- Rerun only after identifying whether the failure was product, fixture, platform, quota, or runner capacity. Preserve the first failing artifact and link the fix run.

## Required result record

Each batch writes a JSON summary and a short readable report with:

```json
{
  "schemaVersion": 1,
  "sourceCommit": "<full SHA>",
  "branchRefs": {"work": "<SHA>", "Mcbt5s-Backup-2": "<SHA>"},
  "batch": "<id/name>",
  "evidenceLevel": "L0|L1|L2|L3|L4|L5",
  "state": "PASS|FAIL|BLOCKED_EXTERNAL|NOT_RUN",
  "startedAt": "<UTC>",
  "durationMs": 0,
  "counts": {"passed": 0, "failed": 0, "skipped": 0, "blocked": 0},
  "metrics": {},
  "providerCalls": {"count": 0, "actualUsd": null},
  "failureIds": [],
  "artifacts": [],
  "limitations": []
}
```

Do not put prompts, user content, credentials, cookies, or live customer identifiers in this file.

## First execution after adopting this plan

1. Capture fresh branch SHAs and clean-install/full-CI results; do not reuse old success as current evidence.
2. Generate the inventory/coverage map and mark unsupported or disabled bindings.
3. Fix release-blocking coverage holes in batches 1–4: route/binding, tenant security, persistence, real browser-to-backend path.
4. Run batches 5–9 for core assistant, coordination, extension, execution, and knowledge paths, marking disabled/external capabilities honestly.
5. Run billing/security/load batches 11–13 before inviting the pilot user.
6. Run batch 10/14 only for the providers and feature flags included in that pilot.

The pilot is ready only for the subset that passed. A complete platform test map may still list blocked capabilities; those must remain disabled or clearly labeled until their own acceptance is done.
