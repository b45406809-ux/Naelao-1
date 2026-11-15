# Platform completion and guided templates plan

Status: active implementation plan. The original plan arrived on `Mcbt5s-Backup-2` in commit `9e1281ce` and is integrated into `autonomous-managed-services-20261111`. The 70 lines added by `origin/plan/microapps-ui-sdk-voice` commit `df3386257262a88888d647daa4d10f3af2ff9596` are already copied into sections 9 and 11, covering Fish Live 3, business microapps, UI SDK, and voice. Planner/worker isolation and conflict-resolution requirements from that branch's commit `45575a39` are copied into section 12; no planning branch was merged. The active plan retains newer P04 recovery evidence than the source summaries. Implementation and evidence are tracked in [platform progress](platform-completion-and-guided-templates-progress.md); the rows below reconcile historical findings against current source and must not be read as live acceptance.

The original review used `02a0cf78` on 2026-11-11. Its findings and later design sections are research inputs, not current-code claims. Before changing a row, compare its actual caller, persistence, configuration and tests with the current branch; reuse the existing S1–S9/U01–U12 ledgers and implementations. Push authorized coherent checkpoints to `Mcbt5s-Backup-2` after fetching and safely integrating remote advances.

## Outcome

Close platform-wide gaps beyond the existing managed-services and sidecar mission (S1–S9), make developer-built templates and extensions easy for nontechnical customers to configure and install, and complete the incorporated planner/worker requirements in section 12. S1–S9 remains governed by [the existing plan](managed-services-and-sidecar-runtime-plan.md); this plan complements it and may overlap its requirements. Map overlapping work to one owner and one evidence record instead of building duplicate systems.

Do not assume that every capability below is required for the first launch. Release safety, commercial integrity, data recovery, and the safety of enabled customer journeys are launch gates. Voice streaming, video understanding, provider-run training, and visual authoring are separately selectable product capabilities; advertise each only when implemented and accepted.

## Evidence and reconciliation

The following observations were made on the stated older checkout. Current implementation status, local evidence, named blockers and the next action are recorded in the progress ledger:

| ID | Finding | Evidence and limit |
| --- | --- | --- |
| P01 | Production's general migration loop suppresses failures. Some explicit checks follow, but they do not demonstrate all migrations succeeded. | `.github/workflows/deploy-prod.yml`, migration step. |
| P02 | Evaluation Worker development, staging, and production configuration names the same D1 database ID; staging and production name the same Agents service. Actual deployed bindings were not inspected. | `workers/eval/wrangler.toml`. |
| P03 | The billing queue's dunning handler logs and acknowledges work without executing the described recovery workflow. Existing D1 entitlement enforcement is separate. | `workers/billing/src/index.ts`, `handleQueue`. |
| P04 | At research, archives capped capture and omitted bytes; current implementation has bounded encrypted Space archives and canonical Knowledge recovery. Product-user archive scope, account erasure and uninstall are exact-user scoped with retry fences. Product-user export v3 contains the authenticated profile, ProductUserDO state, bounded Billing status, exact-user chat across related Product Spaces, signed USER_PRIVATE/SPACE_USER snapshots, and minimized purchase history (`1bbe8ab6`; prior `b91a0795`, `a4958c70`, `7c765c21`, `2bec4bc8`). Billing purchase rows are exact tenant/product/user scoped, capped at ten, and the export rejects `has_more`; provider identifiers and raw receipts are excluded. Local verification: Billing **5/5** and typecheck; Spaces export **13/13** and typecheck. Other service/provider stores, PROJECT_USER and reinstall identity, retention/key/jurisdiction, cross-store consistency, measured RPO/RTO and deployed/isolated recovery remain open. | `docs/space-data-retention-and-backup.md`; `workers/spaces/src/do/SpaceDO.ts`; `workers/spaces/src/do/ProductUserDO.ts`; `workers/spaces/src/do/MicroAppDO.ts`; `workers/knowledge/src/knowledge-archive.ts`; platform progress P04 ledger. |
| P05 | The restricted customer channel extension receives bounded text and knowledge and supports one reply or grounded answer. Existing channel media ingestion does not establish media access through this extension contract. | `workers/agents/src/do/NaelaoAgentDO.ts`, channel dispatch; `new plan/FOUNDRY-REMAINING.md`. |
| P06 | Telnyx public extensions support bounded prompt/keypad interactions; streaming is rejected. Managed extension voice billing has an explicit unavailable path. | `workers/agents/src/communications/telnyx-live-calls.ts`. |
| P07 | Private/local/custom model routes exit worker-pool selection early. This preserves privacy but limits independent worker-model selection. | `workers/agents/src/script-engine/worker-model-routing.ts`. |
| P08 | The original research checkout supported audio-track transcription only. Current code adds a separate, owner-enabled sampled-frame question path: up to three task-owned frames at 0/10/20 seconds, limited to the first 30 seconds and shared with the OCR/visual-analysis quota. It does not provide full-video or motion understanding; deployed Container and Workers AI acceptance remain. | `workers/agents/src/script-engine/prebuilt/attachments.ts`; `workers/agents/src/index.ts`; `workers/agents/src/channels/attachment-transcription-route.test.ts`. |
| P09 | Provider training submission is disabled pending a verified contract. Imported adapter lifecycle features exist. | `workers/spaces/src/do/SpaceDO.ts`, `submit_training`. |
| P10 | Extension connection declarations and provider connection flows exist; the inspected channel installer still accepts pasted manifests/source. A general declarative onboarding schema was not found in the inspected extension contract. | `packages/agent-sdk/src/extensions.ts`; `apps/shell/src/components/ChannelConnect.tsx`. Broader UI audit remains necessary. |

Existing records and tests are historical evidence, not proof of the current candidate or deployed production. In particular, existing media adapters, rollback, signed installation, and bounded phone interactions must not be described as absent. Maintain an evidence matrix with requirement, current implementation, caller, owner, status, test, candidate commit, and remaining acceptance.

## 1. Safe release and isolated environments

- Replace best-effort production migration handling with an ordered, durable migration ledger, checksums, concurrency exclusion, resumable execution, explicit failures, and a verified required schema version before deploying consumers. Handle non-idempotent legacy migrations and already-applied installations explicitly; never assume rerunning every SQL file is safe.
- Inventory all Workers, service bindings, DO namespaces, D1 databases, queues, R2 buckets, secrets, webhooks, callbacks, and domains by environment and jurisdiction. Separate staging from production, including the eval Worker and its Agents service. Validate rendered deployment configuration and reject unexpected resource sharing; document intentionally shared read-only resources.
- Provide a release manifest with component versions, migration prerequisites, deployment order, health checks, compatibility during rollout, and a realistic rollback/forward repair procedure. A schema rollback must not imply that lost data can be recovered.
- Acceptance: migration failure stops dependent deployment; retry after an interrupted migration is safe; configuration checks detect cross-environment bindings; isolated staging exercises deployment and rollback using representative data. Inspect actual Cloudflare bindings and deployment receipts before acceptance.

## 2. Commercial integrity and operator controls

- Build a durable, idempotent payment-failure lifecycle: receive and reconcile provider events, identify the affected payer and subscription, record attempts, notify through authorized channels, apply configured grace periods, restrict the appropriate activities, and restore access after confirmed payment. Handle duplicate, delayed, out-of-order and ambiguous events. Respect existing credits, reservations, entitlements, and provider mandates.
- Define policy and user-visible state for plan changes, cancellations, refunds, disputes, failed renewals, partial payments, and manual intervention. Reconcile receipts and balances without claiming external metering is already implemented. Coordinate with S2/S7 rather than creating a parallel ledger.
- Provide private in-app notice retrieval and read state at each identity boundary: builder/platform rows in `PLATFORM_DB.notifications` use the verified platform JWT's exact tenant and user; Product-user notices use ProductUserDO and the exact product session; Space notices remain in SpaceDO. Never join these identities by email or expose one inbox through another session type.
- Add scoped, audited operations for uncertain payments, stuck provisioning, delivery ambiguity, failed jobs, and support access. Privileged actions require appropriate authorization, time bounds, and a recorded reason.
- Acceptance: local and deployed provider test journeys cover duplicates, recovery and access transitions; ledger, provider receipts and user-visible balances reconcile. Credentials and actual payment-provider acceptance are separate live gates.

## 3. Disaster recovery and data lifecycle

- Inventory canonical data, indexes, object bytes, secrets/key versions, queues, provider references, configuration, and tombstones across D1, DOs, R2, runtime storage, and third parties. Identify authoritative stores and dependency order.
- Decide retention and hold policy, recovery point and recovery time targets, and costs. Implement scalable, encrypted, versioned backup and restoration appropriate to each store, including objects rather than references alone, integrity checks, access control, key rotation, and jurisdiction. Explicitly document current archive limits and merge-only semantics until alternatives are accepted.
- Restore into an isolated environment; replay erasure tombstones before reads, reconnect providers safely, and prevent old queues or restored state from repeating external side effects. Preserve partial restore status, reconcile missing objects, and provide operator runbooks.
- Audit knowledge revocation across source documents, indexes, published collections, caches, summaries, and active sessions. Audit suspension and revocation across queued jobs, active sessions, providers, channels, extensions, and spending. These are audit targets until source and tests establish actual gaps.
- Acceptance: fault-injection and restore drills prove selected objectives, integrity, tenant isolation, deletion replay, and safe resumption. Record what remains dependent on provider retention, regional configuration, and live Cloudflare behaviour.

## 4. Reliable assistant operation and measurable quality

- Trace representative customer tasks across session, planner, workers, workflow, approvals, tools, provider effects, payment, and notification. Identify authoritative state and receipts for every transition. Add missing idempotency, recovery, cancellation, deadlines, uncertain-outcome handling, and user-visible status; do not replay an indeterminate external action blindly.
- Audit limits and abuse containment across tenants, assistants, provider accounts, shared channels, model calls, queues, and runtime resources. Make quotas, cost reservations, failure and escalation visible to the affected user and operator.
- Develop versioned task and safety evaluations, including prompt injection, revoked authorization, failures and human review. Run scheduled evaluations if useful, using real agent paths, independent evidence and recorded model/version. Measure end-to-end success, intervention, latency, retries and total cost; do not treat synthetic tests as proof of production quality.
- For private/local/custom worker models, design capability-aware selection within the authorized privacy and residency boundary. Preserve the current fail-closed behaviour when no valid model is available; do not silently route private requests externally.
- Acceptance: cross-service crash and retry journeys show no unauthorized or duplicated committed effects; held-out quality evaluation reports outcomes and uncertainty; usage and real invoices reconcile for bounded staging runs.

## 5. Developer-authored guided template installation

### Product journey

An installer selects a template, then configures it through a guided UI. For a customer-service bot, provide channel choices such as web, WhatsApp, email and Telegram, including multiple channels; connect existing accounts, bring their own credentials, or select Naelao Managed where available. Let the installer add knowledge, choose supported languages and hours, set escalation rules, review allowed actions, select a model and budget, review costs and permissions, try a preview, and activate. Only show options supported by the template, user authorization, plan, region, provider contracts and actual runtime capabilities.

Show separate states for selected, connecting, connected, configured, awaiting external approval, ready, active, degraded and failed. Setup can be saved and resumed. Provider approval, verified identity and actual delivery may be necessary before a channel is ready. Configuration is scoped per installation so two customers can use the same package independently.

### Authoring contract

- Extend the versioned SDK and signed template/extension package contract with declarative setup steps, fields, labels, help, localization, defaults, validation, optional/required inputs, conditional visibility and dependencies. Validate the same schema and values on the server. Bound schema complexity and avoid arbitrary executable form logic.
- Declare supported channel capabilities, account choices, connection purposes and permissions, knowledge sources, workflows, UI components, runtime needs, and resource consumption. Support Space templates composing several extensions into one coherent onboarding flow. Preserve extension and tenant boundaries and reconcile with S1–S9 UserPort and AgentPort designs.
- Use host-managed OAuth, credential vault and connection references. Template-authored code receives scoped authorized capabilities, not raw secrets by default. Display requested authority and consequential actions before activation; recheck authorization and entitlements on use.
- Install through a durable state machine with idempotent provisioning, verified prerequisites, progress, retry, cleanup and compensation where possible. An uncertain external request requires reconciliation rather than blind replay. Save drafts securely and resume without creating duplicate paid resources.
- Support configuration updates, version migrations, permission and pricing changes, explicit approval where needed, rollback compatibility, revocation and uninstall. Surface retained provider resources and recurring charges accurately.

### Cost calculator

- Update a server-validated estimate as options and expected usage change. Show fixed recurring and setup fees, metered AI/channel/runtime usage, plan allowances, credits, direct provider charges and estimated totals. Include currency, time period, assumptions, rates and timestamp; mark unknown values and expiry. Never present a template author's arbitrary price as an authoritative provider quote.
- Separate an estimate from an enforceable budget or a binding provider quote. Show which charges the platform can stop and which external charges continue. Recalculate and request confirmation if the applicable price or subscription changes before paid provisioning.
- Preserve shared/dedicated channel choices and assistant routing where supported, including shared-number limitations and verified sender identity. Avoid implying provider eligibility, personal-account support or automatic approval.

### Visual authoring

After guided installation works, add a visual template editor for supported building blocks, conditional steps, channel connections, actions, knowledge, pricing inputs and preview. Generate the same versioned, validated package contract as the code SDK. Provide a code escape hatch without allowing it to bypass signing, permissions or host validation. Export/import and round-trip changes without silently discarding unsupported fields.

### Acceptance

An end user can install a signed example customer-service package, select multiple supported channels, connect a provider, set knowledge and policy, view an explainable estimate, preview, activate, update and uninstall without editing code. Test conditional fields, invalid/malicious manifests, secret handling, cross-tenant access, price changes, provider rejection, interrupted setup, duplicate requests and accessibility. Test actual provider connections separately with authorized accounts and record their costs.

## 6. Additional customer-facing capabilities

- **Extensions:** design bounded attachment handles, media access, multiple outbound messages, handler dependencies and richer response types, preserving restricted channel authority and safe delivery semantics. Assess whether the existing channel model can be extended or needs a versioned contract. S6 channel transport is not by itself proof of extension support.
- **Voice:** if selected, implement a public extension streaming voice lifecycle with explicit scope, consent, budgets, bounded concurrency, interruption, transport authentication, recovery and human takeover. Preserve existing keypad calls and owner voice isolation. Verify carrier capabilities and billing before enabling.
- **Video:** if selected, provide authorized, bounded frame extraction and visual analysis with timestamps, cost controls and clear provenance. Continue to label audio-only transcription accurately.
- **Training:** if selected, verify provider APIs and contracts before enabling submission. Include consent, dataset provenance, deletion, model compatibility, evaluation, activation and rollback. Existing imported model lifecycle remains usable within its current limits.
- Acceptance is per feature: code, reachable product flow, authorization, meaningful local coverage, provider capability evidence and real runtime validation. Unsupported options remain accurately unavailable.

## 7. Additional findings from a deeper code review

These observations are from the same `02a0cf78` checkout, not the other session's worktree. They describe specific paths; investigate surrounding callers and deployment configuration before extrapolating to the entire platform. No tests or deployed checks were run for this review.

### P11. Checkout can return a development URL in a production configuration

`workers/billing/src/index.ts` `POST /billing/checkout` attempts Whop, then Lemon Squeezy. If Lemon Squeezy configuration is missing, it returns a `dev: true` URL without checking `ENVIRONMENT`. The Whop error handler can reach that fallback after an upstream failure. This establishes the route's behavior under those conditions, not that production is actually misconfigured or that an unpaid user gets access.

- Require an explicit local/test-only setting for simulated checkout. In production, return a clear provider-configuration or provider-unavailable error and alert operators. Preserve authorized provider fallback only where its commercial terms and product configuration allow it.
- Audit success redirects, webhook verification, payment-to-entitlement state, duplicate events, and client handling of `dev` responses across platform, product and marketplace checkout. Pin an actual purchased plan/price snapshot to the transaction.
- Acceptance: production with missing configuration and failed upstream never produces a simulated checkout; test mode is explicitly gated; real webhook and entitlement transitions are verified under authorized staging credentials.

### P12. Dunning has two incomplete paths and mismatched contracts to reconcile

Besides P03's log-only billing consumer, `workers/workflows/src/workflows/DunningWorkflow.ts` contains a separately registered workflow. Its email step logs an intent, and retries are enqueued immediately despite a comment describing a future delay. `workers/workflows/src/queue-consumer.ts` starts the workflow from `dunning` messages, while the billing handler consumes a differently shaped `dunning` message. Queue configuration and actual producers must be traced before assuming either path runs for a given invoice.

- Inventory producers, consumers, bindings, payload names, workflow IDs and invoice/subscription schemas. Consolidate ownership on one versioned contract and durable invoice-level state; use scheduled retries and real delivery receipts, recheck payment before each side effect, and reconcile delayed/duplicate webhooks. Use configured notification channels and respect approved payment policies.
- Acceptance: a realistic failed-payment journey demonstrates delayed attempts, actual notification or explicit delivery failure, recovery on payment, correct restrictions, and no duplicate actions after queue redelivery.

### P13. Queue health can report healthy with incomplete information

`workers/workflows/src/workflows/QueueHealthWorkflow.ts` sets queue oldest age to zero on its GraphQL path, treats a time-window dead-lettered count as `dlqDepth`, and estimates metrics from `usage_events` when API credentials are unavailable. The fallback returns an empty list on query error, while the caller logs all queues healthy if it finds no alerts. Its audit insert is also best-effort. These are properties of this workflow; other monitoring may exist.

- Obtain supported queue backlog, age, dead-letter depth and delivery/error signals from current Cloudflare APIs or explicit application instrumentation. Label unavailable or estimated metrics as unknown and identify data source, freshness and jurisdiction. Do not infer a current DLQ depth from an interval count.
- Alert on missing telemetry and failed health-record persistence; add durable, actionable incident routing and an authenticated DLQ inspection/replay workflow with idempotency and operator audit. Trace queue producers and consumers, unknown-message acknowledgements, retention and poison messages without assuming all queues share identical semantics.
- Acceptance: injected telemetry failure is visible as unknown, stale backlog and DLQ conditions alert, replay does not repeat side effects, and live metrics are compared with the provider console or supported API.

### P14. Customer sessions need a complete logout and browser-security review

`apps/shell/src/lib/productAccount.ts` stores the product `session_token` in `localStorage`, and its `logOut` function only clears local state. The portal has a similar product-account client. `apps/portal/src/lib/account.ts` also stores an account token in `localStorage`. These facts warrant review; storage alone does not establish an exploitable vulnerability, and other server-side revocation paths may exist.

- Trace each token from creation through storage, use, expiry, logout, reset, membership removal and server verification. Implement server-side session revocation for logout and account security events where absent, ensure multi-session behaviour is explicit, and evaluate secure HttpOnly cookies against cross-origin and embedded use cases. Review XSS, CSP, CSRF, token rotation and exposure in logs. Prevent anonymous browser IDs from being treated as authentication.
- Acceptance: stolen or copied tokens cease working after the intended revocation event, other authorized sessions behave according to policy, and browser/embed journeys work with the selected transport. Include negative cross-product and cross-tenant cases.

### P15. Large-Space discovery has a measured scaling concern

`workers/spaces/src/index.ts` resolves visible projects and returns pages of 90 cards; `workers/agents/src/script-engine/prebuilt/space-blackboard.ts` scans at most ten pages per call and exposes a continuation cursor. The existing claim ledger records one local last-position 10,000-card search taking 112 pages and 8,790 ms; this is one historical fixture, not a production latency distribution. A test-only comparator materially improved that fixture but materialized all cards and was not proposed for shipping.

- Prototype bounded host-side indexed discovery that respects project visibility, cursor stability and revocation throughout pagination. Preserve relevant-result ranking and explicit continuation; measure query costs, memory, provider calls, recall and latency under realistic membership changes.
- Acceptance: reproduce and expand the benchmark on the current candidate with multiple query distributions; test ACL changes between pages, inaccessible cards and limits. Compare end-to-end performance and verified task quality rather than assuming fewer queries alone improves outcomes.

### P16. Discord attachment capability has a concrete restriction

`workers/agents/src/launchpad/discord-media.ts` rejects attachments whose provider reference is not ephemeral; it also limits individual files to 5 MiB, total to 15 MiB, and count to five. Existing Discord text or ephemeral attachment handling does not imply all Discord files work. Provider and platform behavior must be rechecked against current official contracts before changing the implementation.

- Reflect supported attachment types and limits in channel capability discovery and setup. Investigate a permitted, isolated retrieval mechanism if ordinary Discord attachments are required, including signed URL expiry, provider authorization, size/content checks, abuse controls, retention and cost. Do not bypass provider restrictions.
- Acceptance: real supported attachment journeys and unsupported/error cases are accurately reported; media is available to extensions only through the scoped contract in section 6.

### P17. Catalog and marketplace user journey needs product-wide reconciliation

`apps/portal/src/app/catalog/page.tsx` renders a static fallback that labels some Whop-oriented entries live if the API fails, and every live card routes to the same launch path. This is a specific portal surface, not proof that the main marketplace lacks listings or purchases. The marketplace has fixed-license purchase and earnings code in `workers/billing/src/marketplace-licenses.ts`; broader publishing, refunds, payouts and upgrade journeys need a caller-by-caller audit.

- Map the intended catalog surfaces to the authoritative template registry, certified versions, availability, pricing, installation and licenses. When catalog freshness is unknown, indicate that state and revalidate availability before purchase or installation. Pass the chosen template identity through onboarding.
- Trace signed publisher identity, review, listing updates, paid purchase, duplicate payment, refund/dispute, license revocation, author earnings and payout reconciliation. Use existing settlement records rather than replacing them; identify actual gaps before building. Align the guided installer and cost calculator with the verified listing and release.
- Acceptance: two distinct templates survive selection through installation with correct pricing and permissions; stale/unavailable listings cannot silently launch another product; provider test events and user-visible license state reconcile.

## 8. Further cross-service findings

The following source observations were added in a second pass on `02a0cf78`. Recheck them against the completed autonomous branch and actual deployed configuration. Paths identify the observed code, not an assertion that all equivalent paths behave alike. None of these findings has been validated against live services.

### P18. Password reset can finish before all sessions are revoked

`workers/spaces/src/product-end-user-routes.ts` consumes the reset token, changes the password, then attempts to revoke sessions in a ProductUser Durable Object. The revocation is best-effort: exceptions are ignored and the HTTP response status is not checked. Thus a failed revoke can coexist with a successful reset response; actual continued access depends on the session verifier. The token consumption and password update are separate D1 statements, so interruption between them also needs recovery analysis.

- Use a durable account security generation or equivalent authoritative revocation mechanism, and ensure every protected request enforces it. Make reset token consumption, password update and generation advancement atomic within their authority; reconcile downstream session cleanup with durable retry. Define behaviour during partial failure and concurrent login/reset, and maintain non-enumerating responses.
- Extend P14 to cover builder and product accounts, logout, suspension, password change, one-time tokens, and sessions created concurrently with a reset. Do not assume existing logout or reset flows are absent.
- Acceptance: deliberately fail and time out session-store revocation, interrupt after every durable boundary, use copied tokens and concurrent resets; old sessions must be denied under the chosen policy and users receive a recoverable result. Cover actual deployed DO/D1 boundaries separately.

### P19. Workflow environments reuse queue names in checked-in configuration

`workers/workflows/wrangler.toml` names `naelao-events`, `naelao-analytics`, and `naelao-events-dlq` in both staging and production queue configuration. Whether deployed bindings actually resolve to the same Cloudflare queues has not been checked. Shared work queues could cause cross-environment consumption and interfere with testing, billing, or deletion if enabled with incompatible bindings.

- Expand P02's inventory to queue producers, consumers, DLQs, workflow bindings, scheduled triggers and third-party webhooks. Use environment-specific resources and credentials; prohibit consumer startup or deployment when protected environments share mutable resources without an explicitly reviewed exception. Plan safe draining and migration of existing queued messages with environment identity.
- Acceptance: inspect rendered and deployed resource IDs, inject a staging message and prove production does not consume it, exercise DLQ and replay isolation, and ensure CI rejects a known shared-resource configuration. Do not run destructive tests against shared resources.

### P20. Marketplace license refunds have an unhandled settlement path

The marketplace-license branch in `workers/billing/src/lemon-squeezy.ts` calls `settleMarketplaceLicenseEvent` and acknowledges the event. `workers/billing/src/marketplace-licenses.ts` returns `false` for any event other than `payment.success`; the caller does not inspect that return value. On this path, a refund event carrying the marketplace metadata is therefore acknowledged without that function changing license or author earnings. This does not establish that another provider or operator path never handles the refund.

- Trace event normalization and all providers, refunds, partial refunds, disputes, payout holds and creator balances. Define the product's license and author-earning policy for each event. Implement a durable idempotent refund/dispute record tied to the original payment, with explicit partial amounts, reversals and recoverable overpayment handling; preserve accounting history and avoid negative-balance surprises.
- Handle race conditions between payment, refund, provisioning and payout; display state to buyer, author and operations. Investigate separately whether template-subscription refund events have equivalent omissions; do not assume their desired outcome matches a one-time license.
- Acceptance: reordered and duplicate payment/refund/chargeback events reconcile once, including partial refunds and refunds after payout; published license/access follows documented policy and manual exceptions remain visible. Use provider sandbox events before a live transaction.

### P21. Recovery and verification email delivery can fail invisibly

`workers/spaces/src/product-end-user-routes.ts` deliberately returns the same reset response regardless of account existence. Its `sendEmail` helper catches errors and ignores the notification response, and signup catches verification issuance failure. This reduces enumeration risk, but provides no delivery guarantee in the observed path; check for separate monitoring before asserting none exists.

- Retain neutral public responses while persisting a bounded, privacy-preserving delivery operation and retry status for verification and reset mail. Prevent repeated requests from leaving uncontrolled valid tokens, protect token contents from logs and URLs where feasible, and provide safe resend and operator diagnosis without exposing account existence. Define what unverified sessions can access; signup currently issues a session before verification.
- Acceptance: simulate missing notification binding, rejected email, lost response and retry; confirm the public response remains neutral, no raw tokens enter logs, delivery failure is observable to authorized operations, and verification rules hold across all protected routes.

### P22. Knowledge deletion and indexing cross several non-atomic stores

The document delete path in `workers/knowledge/src/index.ts` deletes vectors, paginated R2 objects and D1 records in sequence. An AutoRAG mirror deletion is best-effort and is followed by successful response even if that mirror delete fails. AutoRAG retrieval is currently explicitly disabled on this search route for lack of suitable scope filtering, so do not claim this creates a demonstrated current search leak. Reindexing can mark a document failed after modifying its index, and the workflow performs raw-object cleanup after publishing indexed status; verify failure and retry behavior for each path.

- Establish a durable document generation and deletion tombstone before asynchronous cleanup; ensure retrieval and citations consult current scope and state. Reconcile D1, vectors, citation objects, source uploads, semantic caches and any provider mirrors; record pending and failed cleanup rather than claiming complete deletion. Preserve legal holds and avoid deleting shared or replaced data.
- Protect against delete-versus-ingest, concurrent update, partial vector batches, stale cache and crash-after-index races. Keep AutoRAG disabled until a verified authorization-preserving retrieval design is available, and prove provider deletion semantics before representing physical purge.
- Acceptance: inject failure at every store boundary, replay cleanup and indexing, verify no deleted/revoked document is returned by any enabled path, and validate provider-index propagation and R2 listing in a real isolated environment.

### P23. Notification delivery needs explicit outcomes and safe retry semantics

`workers/notifications/src/index.ts` retries email failures using an idempotency key derived from the queue message ID, and retries failed webhooks without an equivalent recipient-visible idempotency identifier in the shown headers. It acknowledges some malformed, policy-blocked, and unconfigured push messages; synchronous sends return a boolean. Provider acceptance is not proof of delivery or reading. This is an analysis of these paths, not evidence that every notification fails or lacks another receipt mechanism.

- Map each class of notification to required delivery guarantees and policy. Persist operation IDs, provider request/receipt identifiers, failure and retry states, and exhaustion; expose a safe status to callers. For webhooks send a stable event ID, signed timestamp and documented at-least-once contract, with receiver deduplication guidance and replay controls. Reconcile ambiguous sends instead of assuming exactly-once delivery.
- Distinguish policy denial, invalid request, unconfigured provider, accepted, delivered when supported, failed and unknown. Define retry backoff, expiry, dead-letter handling, escalation and user-visible remediation. Avoid logging addresses, message contents or secrets unnecessarily.
- Acceptance: provider-accepted/lost-response and duplicate redelivery tests show correct idempotency or explicit uncertainty; failed critical messages remain observable and operator replay is scoped and audited. Live evidence is required for provider delivery claims.

### P24. Publisher and package trust must span the installed lifecycle

Existing extension code supports signed releases, publisher revocation and rollback; these capabilities must be reused. Audit the full path from package publication through signature verification, dependency installation, runtime execution, updates and revocation rather than assuming signing alone proves installed code is safe.

- Verify the exact installed release, dependency closure, artifacts and runtime image against trusted attestations at execution and after restore. Define key custody, rotation, compromised publisher response, package removal, installation upgrades, permission expansion, dependency conflicts, supply-chain scanning and owner notification. Make publisher and Naelao responsibilities visible in the guided installer.
- Acceptance: revoked keys and tampered artifacts block applicable new operations; already-running work follows a documented drain/revocation policy; rollback cannot silently restore revoked code or expanded permissions. Include multi-tenant and lost-response installation recovery cases.

## 9. Voice platform, managed calling and extension dashboards

### Objective and evidence boundary

Provide Space and Project Assistant voice, in-app calling, managed and bring-your-own phone service, and customer-facing voice extensions. Developers must be able to ship a complete voice-agent product as a signed extension package that includes its own configuration microapp. Nontechnical customers can configure, test, publish, monitor, and operate the product in the UI.

This section records the 12 November 2026 research and design discussion. Prices are USD list prices at research time, are not contract quotes, and must be refreshed from authoritative provider/account data. The current source inspection was against `02a0cf78`; the separate S2–S9 implementation worktree was unavailable. Reconcile every claim and avoid duplicating S2, S5–S8, section 5, P06/P16/P23/P24, and the existing AgentPort plan.

Current evidence: `apps/shell/src/components/OwnerVoiceCall.tsx` uses `agents/voice/client`, a short-lived ticket and the owner voice agent for a Space/Project session. `workers/agents/src/voice/owner-voice-agent.ts` uses the existing planner/worker runtime, OpenRouter audio adapters, preferences and audio admission. `packages/agent-sdk/src/assistant-voice-catalog.ts` currently selects OpenRouter Whisper Large v3 Turbo for transcription and Grok or Microsoft voices for speech. The transcriber groups PCM into completed WAV utterances with a 650 ms silence threshold and a 20-second bound (`openrouter-live-transcriber.ts`). `telnyx-media-bridge.ts` bridges Telnyx phone audio to the same scoped voice agent. These are source observations, not live acceptance, and do not establish that the full phone flow is already provisioned through AgentPort.

The public phone-extension path in `communications/telnyx-live-calls.ts` supports bounded prompts and keypad interaction while explicitly rejecting streaming. A separate `voice-pipeline.ts` refers to Workers AI Whisper and MeloTTS; direct searches did not establish that this component powers the current owner-call path. Cloudflare says MeloTTS will stop responding on **20 November 2026**; inventory reachable consumers and migrate applicable paths to a verified supported model rather than replacing the active OpenRouter stack based on an unrelated reference. [Cloudflare deprecation notice](https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/).

### 9.1 Provider and transport research

| Option | Published rate or observation | Design implication |
| --- | --- | --- |
| Telnyx Voice API | $0.002/min plus destination-specific SIP; published US example inbound SIP $0.0032/min. Raw WebSocket media streaming $0.0035/min. Browser/app calling is listed at $0.002/min; confirm number of billed legs and scenario. | Separate API, carrier, media, number rental and optional charges; do not assume these rates apply to Zimbabwe. [Rate card](https://telnyx.com/pricing/voice-api). |
| Telnyx standalone Parakeet STT | $0.0015/min. Telnyx documents use with Call Control `transcription_start` and other interfaces. | Candidate for real-time phone transcription. Verify billable interval, partial results, language, interruption, availability, and compatibility with selected TTS. [Provider release](https://telnyx.com/release-notes/nvidia-parakeet-stt-voice-ai). |
| Telnyx TTS | $0.000003/character Telnyx standard; $0.0000055/character Inworld Mini. | Potentially cheaper speech output than the observed OpenRouter voices; evaluate quality, language coverage, latency and available call-control operations. [Rate card](https://telnyx.com/pricing/voice-api). |
| OpenRouter Whisper Large v3 Turbo | From $0.000003/second, with provider-specific prices and routing. | This is the current catalog STT and is less expensive at its listed starting rate than the researched Qwen ASR rate. Provider fallback can cost more; verify invoice and account admission. [Model](https://openrouter.ai/openai/whisper-large-v3-turbo). |
| OpenRouter Qwen3 ASR 1.7B | $0.000008/second. | Alternative for evaluation; model-level streaming claims do not alone prove the OpenRouter endpoint offers the required low-latency streaming contract. [Model](https://openrouter.ai/qwen/qwen3-asr-1.7b); [STT API](https://openrouter.ai/docs/guides/overview/multimodal/stt). |
| OpenRouter Grok TTS / MAI Voice 2.1 Flash | $15 per million input characters on published model pages. | Existing selectable voices; compare voice quality and cost with Telnyx. [Grok](https://openrouter.ai/x-ai/grok-voice-tts-1.0), [MAI](https://openrouter.ai/microsoft/mai-voice-2.1-flash). |
| Telnyx bundled Voice AI Agent | Advertised $0.05/min voice engine including orchestration, STT and TTS; LLM and telephony additional, with per-call rounding. | Distinct product from individual Voice API primitives. Do not include its orchestration in standalone pricing assumptions. [Pricing](https://telnyx.com/pricing/voice-ai-agents). |
| Cloudflare Realtime SFU/TURN | $0.05/GB egress, with first 1,000 GB/month shared across SFU and TURN; Workers and AI separately billed. | Candidate for WebRTC or media bridging. Current Agents voice client has not been shown to use this SFU. RealtimeKit has its own pricing. [Pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/). |
| Fish Audio Live 3 | Fish advertises a Voice Agent rate including Live 3, speech recognition, a base LLM and voice: $0.035/min promotional through 31 December 2026, displayed normal price $0.07/min; premium LLM tokens and phone calls are extra. | Optional full-duplex premium provider to evaluate, not a replacement for the existing voice path. Confirm standalone API versus bundled pricing, eligibility, included model, billable units, regional and commercial terms. [Fish product and pricing](https://fish.audio/live3/). |

Do not treat claims that every model listed in the source discussion is available on OpenRouter, that native audio halves latency, that an HTTP request adds a fixed 300–700 ms, or that any stack costs a fixed all-in amount as established facts. Check model endpoints, audio formats, provider routing, current rates, regional availability, retention and actual latency before enabling a profile. Some OpenRouter model pages state EU in-region routing is unavailable; enforce applicable residency and fail closed. Benchmark native audio-in/audio-out separately from chained speech services. Confirm actual provider contract and permission before using customer voice or cloned voices.

#### Optional Fish Live 3 provider

Research snapshot, 13 November 2026: Fish describes Live 3 as listening while speaking and handling pauses, acknowledgements and interruptions. Its stated “as little as 186 ms” is a decision time for short reactions, not a measured guarantee of complete response latency or tool-call completion. Fish says Live 3 speaks English at launch; the general Fish voice library's broader language count does not establish Shona or Ndebele support. Fish describes API availability and enterprise on-premises deployment; open model weights or a general self-host license for Live 3 have not been established. [Fish announcement](https://fish.audio/blog/introducing-live-3/).

Fish's product page lists phone calls at +$0.01/min, a dedicated number at $1.20/month and premium LLM tokens as additional; it advertises a $5 trial credit with no card. Verify actual terms, rounding, trial eligibility, provider-account spend cap, regional service and phone-number availability before testing or quoting. At an illustrative 300 billed minutes/month, the posted bundled rate gives $10.50 in-app promotional or $21 at the stated normal rate; adding the listed phone fee and one listed number gives $14.70 or $25.20 respectively. Excludes premium models and other applicable charges; not a Zimbabwe phone quote. The earlier OpenRouter in-app speech subtotal excludes LLM and infrastructure while Fish states a base LLM is included, so the totals are not directly comparable. [Fish product and pricing](https://fish.audio/live3/).

- Add Fish as a capability-gated option in the voice-provider registry and section 9.5 dashboard only after verifying exact API, audio transport, custom reasoning/tool and callback contracts. Preserve Naelao's authoritative tenant/Space/Project scope, caller authorization, provider connection, tool grants, budget, credit reservations, receipts, and explicit payer choice. Fish-hosted agents must not receive unrestricted workspace credentials or authority.
- Before enabling, establish recording and transcript controls, data processing/retention and deletion, region, consent, supported voices and languages, cancellation, interruption, provider errors, quota, billing and exact telephony integration. Fish's site markets zero retention as an enterprise feature; do not promise it for an ordinary account. Represent on-premises deployment and free trial only where contractually available.
- Offer a clearly priced optional natural-conversation profile alongside the existing economy and BYO options; never silently substitute Fish or exceed the customer's authorized budget. Retain the current path while comparison is pending.
- In the section 9.8 experiment run equivalent scripted and unscripted conversations through existing OpenRouter voice and Fish Live 3, including pauses, corrections, overlapping speech, interrupted output, knowledge/tool use, Zimbabwean English accents, pharmacy terms and graceful failure. Measure time to first meaningful answer, interruption accuracy, task success, full provider invoice and total cost, with consent and strict spending limits. Distinguish local mocks from real provider and deployed acceptance.

### 9.2 Reproducible cost model

Illustrative US inbound example only: 30-day month, 30 seconds of STT input and 375 TTS characters per call minute; $0.0052/min Voice API plus example US inbound SIP; $0.0035/min media stream when used. Current-style OpenRouter uses Whisper at $0.000003/second and TTS at $15/million characters. Native Telnyx candidate uses Parakeet for a full minute and Inworld Mini for 375 characters, assuming the call-control flow can avoid a separate raw media stream; verify that assumption in live tests and invoices. Existing-style in-app subtotal uses the same OpenRouter speech and excludes a phone leg.

| Per-minute component | OpenRouter phone | Telnyx native candidate | OpenRouter in-app |
| --- | ---: | ---: | ---: |
| US inbound API + SIP | $0.005200 | $0.005200 | $0 |
| Telnyx raw media | $0.003500 | $0 assumed | $0 |
| STT | $0.000090 | $0.001500 | $0.000090 |
| TTS | $0.005625 | $0.0020625 | $0.005625 |
| **Subtotal/min** | **$0.014415** | **$0.0087625** | **$0.005715** |

| Minutes/day | Minutes/month | OpenRouter phone | Telnyx native candidate | OpenRouter in-app |
| ---: | ---: | ---: | ---: | ---: |
| 5 | 150 | $2.16 | $1.31 | $0.86 |
| 10 | 300 | $4.32 | $2.63 | $1.71 |
| 30 | 900 | $12.97 | $7.89 | $5.14 |
| 60 | 1,800 | $25.95 | $15.77 | $10.29 |
| 120 | 3,600 | $51.89 | $31.55 | $20.57 |

These are selected speech and transport subtotals. Add planner and worker LLM tokens, tools, retrieval, Cloudflare compute and networking, number rental, tax, provider minimums, carrier pass-through, recording, human transfers, outgoing calls, retries, abandoned calls, and any rounding. Example only: $0.001/min in additional processing adds $0.30 at 300 minutes and $1.80 at 1,800; this is an assumption, not measured cost. Account for speech discarded after interruption and models/provider fallbacks with higher rates. Naelao's calculator must version its source rates and assumptions and distinguish estimates from binding quotes and actual invoices.

Zimbabwe number availability, regulations, setup, carrier routing, outgoing rates and the caller's own charges require a current Telnyx account quote and local validation. A US shared number may cost a Zimbabwean caller an international call even when Naelao's inbound price seems low. Prefer an in-app demo until country-specific evidence exists. [Telnyx Zimbabwe](https://telnyx.com/phone-numbers/zimbabwe).

### 9.3 Phone routing and shared numbers

- Support personal assistant calls and customer-service calls as distinct scoped journeys, while sharing transport infrastructure. Offer Naelao-managed shared numbers, project/assistant dedicated numbers where available, bring-your-own connections, and in-app voice. Never promise a number or provider approval before provisioning and policy checks.
- Personal shared number: use called number and caller ID as routing hints, resolve potentially multiple accounts and assistants, offer a default, keypad or spoken selection, then bind the call to the correct authorized tenant, Space, Project, session and payer. Caller ID alone does not authenticate a person; require an appropriate verified challenge, one-time code or app approval for private data and consequential actions. Handle number reassignment, withheld numbers, shared numbers, multiple linked identities and mid-call assistant switching.
- Customer-service shared number: the caller may be unknown and caller ID does not identify their intended business. Support a business code, disambiguated name with keypad fallback, a short-lived callback context, or a dedicated number. In-app calling already supplies business context when authorized. Route only after the intended business is resolved. Avoid mixing conversations, context, knowledge, billing or recordings across customers and tenants.
- Record a durable call identity, provider call control ID, operation journal, signed webhook verification, event deduplication, call state, concurrency limits, deadlines, consent and handoff. Handle abuse, blocked/spam calls, charges incurred before routing, rejected challenges, unallocated calls, emergency-call limitations and allocation ownership. Attribute routed usage to the correct payer; treat unrouteable calls as platform cost under an explicit policy.
- Evaluate existing client transport as baseline, Cloudflare SFU where WebRTC/media functionality is needed, and Telnyx browser calling when interoperating with telephony. Validate leg billing and network behavior; do not impose an unverified SFU or Telnyx charge on the existing client.

### 9.4 Voice extension SDK and runtime

- Introduce versioned, capability-scoped contracts for call started, transcript partial/final, keypad input, interruption, tool results, transfer and hangup; host actions for speak, listen, end, transfer, approved knowledge retrieval and approved business tools. Provide schemas, SDK types, examples, local simulator, event replay, structured errors, version compatibility and developer documentation. Support Naelao-hosted sessions and external AgentPort consumers with their own wake-up/runtime mechanisms.
- The host retains provider credentials, authorization, call state, identity, media transport, budget reservation, safety policy and authoritative operation records. Guest extension code receives only granted scope and opaque handles. Caller content is untrusted and cannot grant permissions. Validate allowed destinations, resource limits, policy and current consent at every privileged effect.
- Support incremental transcripts where the actual provider interface supports them, barge-in and speech cancellation, codec/sample-rate conversion, silence/noise handling, backpressure, timeouts, reconnect and crash recovery, without duplicate external actions. Provide a human takeover and a clear failure or voicemail path. Define whether a call continues under a published configuration version when the owner edits settings.
- The existing public keypad extension must remain functional; enable conversational streaming only after the extension runtime, billing, provider contract, isolation and live checks are complete. Test cross-tenant calls, unauthenticated callers, spoofed callback, stale authority, and unknown provider outcomes.

### 9.5 Package-owned microapp dashboards for noncoders

**Fixed product requirement:** an extension package may include a separate microapp extension as its dashboard, with configuration declarations, screens and workflows tailored to its product. Installing a voice-customer-agent package should give the customer an experience comparable in completeness to a dedicated voice-agent platform, within the capabilities actually supported. This must work for other extension categories as well. The guided setup schema in section 5 and the microapp use the same versioned, server-validated configuration contract; a basic host-rendered form remains available when a package does not ship a dashboard.

Research inspiration, not a claim of feature parity: Vapi documents model/transcriber/voice presets, first messages, publish and web test calls; its documentation also describes tools and knowledge. HeyGen documents a voice library with previews and adjustable voice settings. [Vapi assistant setup](https://docs.vapi.ai/assistants/quickstart), [Vapi tools](https://docs.vapi.ai/tools), [Vapi knowledge](https://docs.vapi.ai/knowledge-base), [HeyGen voice library](https://help.heygen.com/en/articles/9834925-how-to-get-started-with-voices).

Dashboard requirements:

1. **Overview and onboarding:** describe the product, requirements and provider status; create and select agents, show draft/published/ready/degraded status, and resume setup.
2. **Voice and languages:** searchable voice library, provider/model/language, example playback and custom test phrase; speed and supported delivery settings, pronunciation hints, compatible STT and TTS languages, locale and accessibility. Indicate availability, provider cost, restrictions and actual latency observations; voice cloning requires supported provider flows and recorded consent. No unverified language or voice-quality promise.
3. **Behaviour and calls:** name, greeting, concise editable instructions, conversation goals, turn-taking, interruption, silence, max duration, business hours/timezone, fallback and handoff. Offer cost/quality/speed presets plus advanced configuration, subject to plan and provider capability.
4. **Channels and accounts:** configure in-app, shared number, dedicated number or approved BYO connection, inbound/outbound policy, identity verification, provider approval and connection health. Show provisioning progress, ownership, recurring fees, permissions and action-specific authority.
5. **Knowledge and tools:** upload documents, select existing Space/Project collections and approved external subset; display ingestion and access state, test retrieval with citations, configure calendar/ticket/order actions and permissions. Edit and revoke safely.
6. **Try, evaluate and publish:** interactive browser call and text simulation, test caller and safe demo data, observable transcript/status, scenario tests, draft versus published version, explicit activation, version history and rollback. Provider calls and billable previews show estimated cost and respect budgets; never present a simulated call as a real phone connection.
7. **Operations:** call history, usage and spend, provider receipts, status, alerts, failures, retries, transcript/recording availability, redaction, retention and deletion, human escalation and uncertainty. Scope views to authorized roles and avoid exposing raw provider secrets or another tenant's data.
8. **Live estimates:** show fixed fees, assumptions for minutes/characters/tokens, model/provider, included allowances, direct third-party charges, number type, destination, limits and unknown costs. Update as controls change, identify source and rate timestamp, and obtain a fresh authoritative quote before committing to a paid external operation. Show which spending limit is actually enforceable.

SDK and host requirements:

- Define how a package declares dashboard/microapp entrypoints, configuration schema and defaults, navigation, routes, lifecycle, data contracts, requested host capabilities and compatible extension versions. Support reusable components, localization, keyboard/accessibility, responsive mobile design, errors, validation, saved drafts and per-installation scope.
- Provide typed host APIs for reading/writing scoped settings using optimistic concurrency, retrieving approved provider/voice/model catalogs and rates, secure connection handoff, cost estimates, knowledge selection, test sessions, published configuration, usage and authorized receipts. Offer webhooks/events for changes where appropriate. Publish stable contracts and examples for code-authored dashboards and a visual builder that emits the same format.
- Run package UI in the existing isolated Canvas/Gadget/microapp model where suitable; verify signed release and pin its artifacts. Apply strict content security policy, sandboxing, bounded resources, scoped tokens and host-mediated egress. A microapp cannot access raw vault secrets, mint grants, alter billing records, cross project boundaries, or assert arbitrary provider capabilities. Revalidate all writes and permissions on the server. Reuse existing publisher signature, installation, staging, activation and rollback machinery.
- Support upgrades with configuration schema migrations, compatibility checks, version pins and a preview of changed authority/charges. Handle failed migrations, rollback and revocation without losing customer configuration. Multiple installed instances cannot overwrite one another. Provide audit events, diagnostics, reproducible builds and a local preview/simulator for developers.
- Enable package composition: a voice extension, its microapp dashboard, channel and knowledge requirements, optional tool connectors, and workflow/runtime components can be installed together as a signed bundle. A Space template can compose several such packages. Setup, provider provisioning and billing use durable operations with idempotent recovery; no duplicate paid numbers after lost responses.

### 9.6 Five prebuilt voice extension packages

Each package includes its own configurable dashboard/microapp, setup declaration, scoped permissions, sample data, test scenarios, provenance and onboarding cost estimate. Offer these as generic reusable products; a vertical Space template may compose them.

| Package | Core behavior | Customer configuration |
| --- | --- | --- |
| FAQ receptionist | Answer from approved knowledge; escalate uncertainty. | Knowledge, greeting, languages, hours, voice and handoff. |
| Appointment assistant | Explain availability and propose or book appointments with authorized calendar actions. | Calendar, services, duration, time zone, approvals and confirmations. |
| Support triage | Collect an issue, create or update a ticket and transfer when needed. | Categories, ticket connection, urgency, fields and escalation. |
| Order/delivery assistant | Look up permitted order information after suitable identity checks. | Store, authentication, data access and permitted actions. |
| After-hours message taker | Capture a bounded message, summarize and notify staff. | Schedule, message fields, notification destination and retention. |

For a pharmacy composition, use only approved information and scope; make uncertainty and escalation explicit. Do not advertise medical advice, regulatory compliance, product availability, or safe clinical operation without corresponding domain review and actual evidence.

### 9.7 Scoped managed knowledge and Cloudflare resources

Expose Cloudflare-backed services through Naelao's host-mediated SDK, not broad account credentials. Reuse the existing Knowledge Worker, workspace, provider registry, entitlement and billing authorities. Authorize tenant, Space, Project, installation, principal and grant on each call; support Space-wide collections, project-private collections, installation-private data and an explicitly published external subset. Caller/extension access must not imply member access. Bind secrets, R2 keys, vector metadata and quotas to authoritative scope.

Use appropriately scoped R2 for source content, D1/DO metadata and policy, Vectorize or supported retrieval for indexes, and approved embedding/LLM services. Control region, encryption, lifecycle, retained backups, document and chunk references, publication, revocation, deletion, versioning, indexing status and recovery. Recheck authorization on retrieval and citations; protect stale cache, delete-versus-ingest and tombstone races as in P22. Prevent a microapp or extension from choosing another tenant's resource IDs.

Track bytes stored, documents/pages/chunks processed, embedding and model usage, query count and vector dimensions. Cloudflare's published Vectorize page provides a 25,000-vector/50,000-query example of $0.59/month before included allowances; embedding, storage, Workers and answer generation are additional. [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/). Show estimates, actual allocation and quotas by Space/Project/installation without billing shared storage multiple times. Customer-owned Cloudflare resources are a separately authorized connector, not assumed available through managed billing.

### 9.8 Voice billing, experiments and acceptance

- Reuse the existing authoritative ledger, plan entitlement, credit and reservation systems. Reserve a bounded amount before calls or billable tests; incrementally account for call seconds, provider legs, STT audio, TTS characters, LLM tokens, tools, knowledge, number rental and optional services. Reconcile provider receipts and invoices, unknown outcomes, retries, refunds and late charges. Keep Naelao-managed and BYO charges distinct and identify costs Naelao cannot cap. Attribute shared-number costs after routing; define unrouteable and abuse cost policy.
- Show users per-call details, included plan credits, remaining budget, warning thresholds, estimated next charges, and an understandable cap response. Price actual measured traffic including silence, failures, interruptions, pre-routing costs, concurrency and rounding; choose commercial prices only after evidence.
- Compare (1) existing OpenRouter Whisper + Grok/MAI, (2) Telnyx standalone Parakeet + native/Inworld TTS, (3) existing in-app client, and optionally (4) Cloudflare SFU using the same agent and tasks. Record provider/region/model/version, time to first response, turn latency, interruption, audio quality, accuracy for Zimbabwean accents and relevant languages, dropped calls, task success, actual receipt, and full cost per successful call. Keep synthetic, local, provider-live and deployed results separate.
- Gate each advertised channel/provider/profile on real authorized runtime checks, country-specific availability, scope/isolation tests, fraud controls, billing reconciliation, provisioning and cancellation behavior, and tested accessibility. A mock, provider catalog listing, or unbuilt dashboard does not satisfy acceptance.

## 10. Shared-Space coordination, private projects and extension ownership

### Outcome and current baseline

A Space may support collaborative business-wide resources, independent member work, or a mixture. Its owner and authorized administrators choose the coordination policy in a Space template and Space settings. Individual users and projects retain their configured visibility. Every member's Space Assistant and Project Assistants act within that member's current authority; the Space can also publish deliberately limited coordination facts that help avoid duplicate work.

Source observations at `02a0cf78`: `workers/spaces/src/index.ts` checks readable/manageable project access for blackboard cards, and list access derives visible project IDs through `visibleAutomationProjectIds`. Cards contain summaries, capabilities and evidence and are not a general right to access their source projects. `packages/agent-sdk/src/extensions.ts` declares multiple extension/gadget scopes, and Spaces installation paths include `PROJECT_BOUND`, `PROJECT_SHARED`, and `SPACE_SHARED`; their exact execution, storage and authority differ by primitive and path. Public customer channel extensions use a restricted runner; installation in a Project does not mean all project agents can edit, invoke or manage the installation. Reconcile latest code and permissions after the other session; do not assume a universal per-user blackboard or private-project coordination registry already exists.

### 10.1 Extension ownership, execution and management

- Preserve separate decisions for package publisher, installation owner, resource scope, runtime location, execution identity, data access, and people/agents authorized to operate or change it. A `PROJECT_BOUND` installation belongs to its project for lifecycle and scoped data; its handler may execute in an isolated host/Worker and need not run in the project's main container. A linter or other tool may have a different runtime from a customer channel handler. Show actual runtime, instance, version, scope, status and dependencies in authorized views.
- Project agents may discover, propose changes to, invoke, configure, update or retire an extension only under the acting user's membership, project permissions, installation grants, package policy, publisher integrity, budget and any required approval. Installing the extension does not automatically confer edit rights to every agent or make it Space-wide. Allow an owner to delegate narrowly scoped maintenance without granting unrelated project secrets or direct publisher control. Signed package updates use existing release and review mechanisms.
- Support project-only extensions such as linters and context-dependent customer-service bots, project-shared installations where supported, and deliberately Space-shared services. Provide scoped knowledge and file access by explicit grants; a Space-shared service does not automatically see every Project. Promotion, sharing, transfer, uninstallation or moving a service must preserve data boundaries, version ownership, caller grants and billing; require an authorized lifecycle action and document what moves or remains.
- Expose an extension inventory to each assistant and human filtered by their actual permissions. A Project Assistant can help maintain its authorized installations, including creating a reviewable proposed change and updating through the appropriate host workflow. External channel contacts get the restricted external authority rather than a member or project agent identity. Other projects may use a service only after explicit authorized discovery and connection.

### 10.2 Separate project knowledge from coordination facts

Introduce a **Space coordination registry** complementary to the existing permission-filtered blackboard. It is a host-governed set of explicit, minimal declarations, not unrestricted access to private projects or agent-created summaries. A coordination entry describes an approved capability or policy such as “the Space has an official company website” or “customer-service phone number is centrally managed.” It may have an optional link to an authorized service, a responsible role/contact or an approval route. The system must never infer an entry from private content and publish it without the configured authorization.

The relevant surfaces are:

| Surface | Audience and content | Purpose |
| --- | --- | --- |
| Project and user context | Authorized users and their assistants; private working data. | Do the project work. |
| Existing project blackboard | Users who can read each published project's card; its existing checks still apply. | Discover relevant permitted work and ask to collaborate. |
| Space coordination registry | The audience explicitly selected for each approved fact, potentially all Space members. Minimal, curated fields. | Tell assistants what official capability exists or which action needs review. |
| Host-only ownership/uniqueness record | Service admission authority and authorized administrators; no project metadata returned to others. | Enforce an explicitly configured singleton rule or reservation. |

Publishing a fact that “an official website exists” **reveals that fact**, even if no project name or owner is shown. Generic messages, denial codes, timing, search results and quota counts can also reveal existence. Provide clear per-entry disclosure previews and audience controls; anonymous or aggregated summaries still need review for indirect identification. Never imply a private project is invisible if a policy intentionally announces its capability.

For a highly private project, allow publication to be disabled. A hidden project cannot both remain completely undisclosed and cause the system to explain to every member that the exact resource already exists. Where an owner requires uniqueness without disclosure, use an opaque policy response such as “this action requires Space approval” consistently for all covered attempts, including when no hidden project exists. An authorized reviewer gets the context needed to decide; the requester receives no hidden identifiers, names, counts or status. Document residual side channels and test them. If no such rule is enabled, duplicate creation is possible by design.

### 10.3 Configurable collaboration policies

Space templates propose initial settings; Space owners/admins can review and configure them, subject to project privacy and governance rules. These are independent controls, not one global switch:

| Setting | Example choices |
| --- | --- |
| Collaboration posture | Independent members; opt-in coordination; coordinated organization. |
| Blackboard audience | Project-authorized users only; explicitly shared project cards; existing Space-access rules. |
| Coordination facts | Disabled; approved public-project facts; explicitly approved facts from selected private projects. |
| Private publication | Project owner can opt out or propose a minimal fact; Space administrators cannot silently publish project contents. Clearly disclose any mandatory organization policy at project creation. |
| Resource rules | Allow duplicates; show advisory; require approval; enforce a designated singleton for a defined resource key and scope. |
| Creation and management rights | Roles/grants for creating projects, websites, public bots, phone numbers, paid resources, extensions and changing organization-wide services. |
| User control | Choose project visibility and explicit sharing among the options allowed by Space policy; review and revoke previously approved publication. |

For independent Spaces, default to no cross-user discovery or sharing unless deliberately configured; a member can create their own site or bot if their grants allow it. For a coordinated pharmacy, the owner may publish an official medicine-catalog capability, delegate its maintenance to a project, restrict creation of public customer bots, and require approval for an official website. These are example presets, not assumptions about existing defaults or employer rights. A project marked public within a Space is not automatically public on the internet.

Define which authority can impose a mandatory policy, what notice users see, which settings are inheritable or overridable, and who approves publication of a private project's facts. If the product permits a Space owner to set an organization-wide control that overrides an individual preference, disclose that explicitly; never quietly treat private content as shareable. Invitation, role change, removal and project transfer immediately change what the affected user and their assistants can see or do.

### 10.4 Duplicate prevention and concurrent work

- Use typed, scoped capability keys such as `official.website`, `customer_service.public_channel`, or `inventory.medicines`. Keys have owner-configured cardinality, audience, business unit/project scope, aliases and lifecycle. Do not use a model-generated similarity score as the authorization decision; similar names can mean legitimately different websites, locations, customer groups or staging environments.
- For advisory coordination, a search returns only permitted registry facts and appropriately filtered blackboard cards, with freshness and continuation. Provide an option to request collaboration or suggest a new service; advisory entries do not grant a right to edit, call or read existing resources.
- For enforced singleton/approval policies, all creation and activation paths—including UI, SDK, templates, agents, connectors, provider provisioning and retries—must consult the same host-side authority. Reserve the exact business key atomically before external provisioning; give reservations an owner, expiration, monotonic generation/fence and idempotency key. Check authority again on activation and reconciliation. Concurrent attempts must not produce two committed official resources. Handle abandoned reservations, lost provider responses, policy changes, rollback and deletion without unsafe blind replay or permanent deadlocks.
- Decide whether a rule covers creation, activation, paid provisioning or public exposure; support scoped exceptions and independent personal experiments where policy allows. An inaccessible hidden record must never be returned as a searchable conflict. Denials and reviews should use uniform messages and avoid leaking identifiers, content, contact details or whether a private project exists.
- A Space Assistant may receive a relevant approved fact before planning and again before a side effect. Treat facts as advisory evidence with provenance and freshness; only the host's explicit permission/policy can authorize or block a tool call. Revocation must invalidate cached guidance and prevent unauthorized access on the next operation.

### 10.5 SDK, dashboard and lifecycle

Add versioned APIs and SDK contracts for configuration policy, approval, explicit publication, audience, discoverable capabilities, request-to-use, ownership, exceptions, resource reservations and receipts. Provide separate permission-checked operations for a human user, assistant and administrator. UI must show users what a selected entry reveals, who can see it, who can use the underlying service, whether it is advisory or enforced, and how to revoke it. An entry should link to the project only for those already authorized. Support templates configuring defaults, owners updating settings, and project owners reviewing proposed publications. Keep coordination information separate from template/extension dashboard capabilities in section 9; neither microapp code nor assistant text can mint authority.

Track entry version, author, approving authority, audience, provenance, created/expiry/revoked time, dependencies and last confirmation without exposing hidden fields to readers. When a project or extension is retired, disabled, transferred, deleted, access is revoked, or a service changes ownership, invalidate or transition its facts and reservations atomically where possible; show stale/pending status rather than asserting that a capability is still available. Reconcile partial cross-service failures and audit changes without storing private project content in public records.

### 10.6 Acceptance scenarios

1. **Collaborative pharmacy:** owner publishes an approved inventory capability; an employee's authorized assistant discovers the fact and can request access, without automatically gaining the inventory project's private files. A project agent with a specific maintenance grant can maintain a customer-service extension; one without it is denied.
2. **Private official website:** owner chooses whether to reveal a minimal website fact. With publication disabled, another employee cannot infer project identity from search or action responses. If an organization-wide approval rule covers official website creation, the requester receives the same generic approval flow whether or not the private project exists.
3. **Independent Space:** two members independently create permitted sites and customer bots without cross-user blackboard visibility or unexpected singleton enforcement. Their data, assistants, extensions and billing remain scoped.
4. **Concurrent singleton:** two authorized agents attempt to create the same official service at once; exactly one obtains the relevant reservation or approval, and interrupted provisioning/retry cannot create two committed official bindings. Explicitly authorized exceptions and different business units continue to work.
5. **Revocation and lifecycle:** remove a member, revoke an extension grant, unpublish an entry, delete a project or retire a service while searches and calls are in progress. Subsequent reads and mutations honor current authorization; registry state and reservations are reconciled.
6. **Non-disclosure:** test private names, identifiers, counts, timing, result ordering, pagination, error codes, logs and tool outputs for information leaks. Use paired fixtures with and without a private project; document limits rather than claiming perfect noninterference from a few tests.
7. **Template and UI:** owners can select the coordination posture at template creation and change it in settings; project owners see the actual disclosure and override policy. SDK, no-code dashboard, human and assistant operations enforce identical host-side rules.

These requirements need source reconciliation, meaningful local authorization/concurrency coverage and deployed multi-user validation. They do not imply that all members can see every project or that a Space-shared extension has authority over every project.

## 11. Business microapps and Cloudflare OS Gadget lessons

### 11.1 Outcome and source baseline

Make microapps useful as complete, installable business applications: a nontechnical customer can configure and operate them through a responsive UI, and authorized assistants can discover and perform the same meaningful business actions. A Space or Project template can compose multiple microapps, extensions, channels and workflows. This section extends sections 5, 9.5 and 10; it does not establish that the features below are already implemented or approved for rollout.

Source review on 13 November 2026 compared Naelao remote `Mcbt5s-Backup-2` at `19a59bdb82970026aa66d19256fb0417ab41962c` with [Cloudflare OS at `a3a20e1abe33579b06e057e482834ab5367855ed`](https://github.com/cloudflare/cloudflare-os/blob/a3a20e1abe33579b06e057e482834ab5367855ed/README.md). Reconcile with the latest code before implementation: the concurrent implementation mission can advance the branch. These are source observations, not live acceptance evidence.

| Concern | Cloudflare OS | Naelao source observation and direction |
| --- | --- | --- |
| Application model | A Gadget is an individually sandboxed app; AI can create and modify its code. | [MicroAppDO](https://github.com/b45406809-ux/Naelao-1/blob/19a59bdb82970026aa66d19256fb0417ab41962c/workers/spaces/src/do/MicroAppDO.ts) is a host-controlled scoped app/data runtime. Do not assume arbitrary per-instance AI editing is equivalent to Cloudflare's Gadget Workshop. |
| Runtime and UI | A Dynamic Worker executes Gadget server code; its client runs in a sandboxed iframe and communicates through Cap'n Web RPC. | The [Canvas host](https://github.com/b45406809-ux/Naelao-1/blob/19a59bdb82970026aa66d19256fb0417ab41962c/apps/shell/src/components/viewports/MicroAppCanvas.tsx) hosts a sandboxed iframe and mediates bounded requests; other extension primitives may have different runtimes. Verify each actual execution path and never equate an iframe with complete isolation. |
| Persistence and scope | Gadget instances use Durable Object-backed state and can be shared. | The actor identifies Space-shared, Project-shared and user-specific scopes, among others; SQLite backs app data. Scope selection is a foundation, not proof that all routes enforce the same authorization. |
| Assistant actions | The Gadget's exposed RPC API can also be used by the agent through Code Mode. | The inspected host exposes generated MCP list/get/insert/update/delete operations for Gadget records. Add typed business operations with domain rules rather than relying exclusively on generic CRUD. |
| External access | Gatekeepers mediate specific external resources and side effects. | Naelao has [capability/permission declarations](https://github.com/b45406809-ux/Naelao-1/blob/19a59bdb82970026aa66d19256fb0417ab41962c/packages/agent-sdk/src/extensions.ts), installation and host-bridge checks; verify effective enforcement and provider-specific operations end to end. |
| Reuse | Share a Gadget instance for collaboration, or share a Blueprint so others can create a separate instance from its code. | Versioned extension and template composition can support equivalent installation and reuse, subject to completed packaging, migration, isolation and lifecycle work. |

### 11.2 Shared business actions and trusted execution

- Add a versioned SDK contract for named, typed business actions, their input/output schemas, descriptions, installation and data scopes, permissions, side effects, idempotency and approval requirements. Examples: `receiveStock`, `recordSale` and `adjustStock`. The UI, authorized human API and assistant call the same host-authorized operation; an extension, model or UI cannot grant itself authority. Generic CRUD can remain available under explicit authorization, but must not bypass protected business invariants.
- Validate inputs and outputs server-side; enforce per-action roles, tenant/Space/Project/installation and actor scope, current grants, budgets and resource limits on every call. Support transactions for related records within a supported transactional boundary; use durable operations, idempotency and reconciliation for cross-service side effects. Record provenance and audit outcomes without exposing sensitive data. Distinguish read, write, irreversible and paid operations.
- Discover only installed, active and authorized actions. Check permissions again at execution so revocation and role changes take effect; do not expose private project names or data through tool descriptions, errors, search or caches. Treat app content, tool results and customer messages as untrusted input. Establish safe behavior for concurrent actions, retries, crashes, unsupported schema versions and conflicting updates.
- Provide provider-specific, least-privilege resource grants and host-mediated egress. External actions requiring approval must be represented as **proposed**, **simulated**, **approved**, **completed**, **failed** or **outcome unknown**, as appropriate. Never tell a user that a simulated message, purchase, inventory adjustment or provider action happened. Preserve the actual result and reconcile uncertain outcomes without blind replay.

### 11.3 Creation, customization, sharing and lifecycle

- Offer a fast AI-assisted creation and editing experience for isolated personal or sandbox apps. For a business installation, create a versioned proposal and preview, test the changed package and business rules, show data, capability, cost and permission implications, and require the appropriate owner's approval before activation. Record provenance, staged versions and recoverable prior releases; do not claim unsupported migration or rollback capabilities.
- Separate sharing an existing instance and its data from publishing a code/template blueprint for another customer to install with independent state. Support a developer-created fork and independently scoped customer configuration. Installation, publication and fork permissions must not grant access to the original customer's records, credentials, private files or provider accounts. Clearly specify version ownership and support when customers customize their copy.
- Scope app instances intentionally: a Space-shared pharmacy stock app, a Project-shared team app or a user-private app. Template and settings UI must show who can view, operate, administer and modify each instance. Preserve project privacy, explicit grants and coordination rules in section 10. An app being discoverable does not itself grant access, and installation in a Project does not authorize every project agent to administer it.
- Preserve the existing signed release and publisher trust model; review new permissions, dependencies, data migration, pricing and provider connections before updating. The [progress record](https://github.com/b45406809-ux/Naelao-1/blob/19a59bdb82970026aa66d19256fb0417ab41962c/docs/research/platform-completion-and-guided-templates-progress.md) describes a narrow same-publisher version-only update for certain Space-shared static Canvas/channel packages; Gadget schema/data migration and general rollback remained gated at the review baseline. Implement and verify broader lifecycle support without claiming that narrow path covers it.

### 11.4 Storage, collaboration and operational controls

- Select and display a storage tier appropriate to the app's data. At the reviewed baseline, tier 1 has a 25 MiB application limit and deletes its state after 14 days of inactivity; tiers 2 and 3 have configured limits of 100 and 250 MiB. These are implementation limits, not provider pricing or a backup guarantee. Essential pharmacy, inventory, sales and customer records must never be silently placed in an ephemeral tier. Check current code, provider limits and exact idle semantics before adoption.
- Define durable retention, backup coverage, export, restoration, deletion, portability, quotas, migration, audit history and recovery-point objectives per installation and data class. Verify actual supported transaction boundaries and prevent readers from seeing partially applied business operations. Separate test/sample data from customer records and protect sensitive data in logs and exports.
- Make collaboration and freshness explicit: authorized users can work on shared instances where supported, while private data remains inaccessible. Reconcile existing presence/event code with UI and assistant paths; test concurrent edits, reconnect, missed updates, authorization changes and conflict resolution. Do not infer production multiplayer or a fixed latency merely from Durable Objects or the existence of event tables.
- Expose usage and costs, accessibility, mobile layouts, localization, loading and offline/failure states, lifecycle status and administrative controls in the app and host. A channel-to-assistant-to-business-action journey must enforce the same permissions, approval and budget checks as the UI; do not claim a WhatsApp integration is live or approved without actual provider and deployment evidence.

### 11.5 Evaluate Vercel UI SDK for microapps

Evaluate [Vercel UI SDK](https://github.com/vercel-labs/ui) as an optional foundation for accessible microapp interfaces and agent-assisted UI configuration. Its headless behaviors cover focus, keyboard navigation, selection, popups and related interface interactions; its agent bridge may expose component state and actions. It is a beta dependency, not an already adopted Naelao capability or a replacement for the host's business-action API. Review its current version, Apache-2.0 license, transitive dependencies, security and accessibility before adoption.

- Build an isolated proof of concept for a mobile-friendly extension configuration microapp: let an authorized assistant populate a draft voice, greeting and business-hours form; let the owner inspect the exact changes and cost implications before confirming. Separately evaluate an inventory filter that an assistant can set visibly while a server-authorized business action retrieves the data. These examples must use synthetic data until explicitly approved for live use.
- The agent may propose and manipulate UI state only within the selected installation, user and session. The iframe and host bridge must validate message source, schemas, scoped grants, allowed actions and current authority. Do not expose secrets, unrestricted browser state or other installations' component state. Treat extension UI, page content and model output as untrusted; apply size, rate and duration limits and defend against prompt injection and forged or replayed actions.
- Keep authoritative reads and writes behind the existing host-mediated, versioned business operations in section 11.2. UI callbacks, WebMCP registration or SDK `allow` hooks do not grant authority. The server rechecks tenant, Space, Project, installation, actor, permissions, approval, expected version, billing and budget as applicable. Show draft, submitted, approved, completed, failed and unknown outcomes accurately; clicking Save is not evidence of provider completion. Revocation must stop subsequent actions.
- At source review on 14 November 2026, the Naelao Shell uses React 18 and the cited SDK React adapter requires React 19+. Verify the exact pinned package's peer dependencies and current repository state before integration. Compare a separately bundled React 19 microapp, supported framework-independent/core or web-component use, a separately planned Shell upgrade, and implementing compatible ideas without the dependency. Do not upgrade the whole Shell or assert an unsupported adapter works merely to run the experiment. Pin tested versions and define upgrade and rollback ownership if adopted.
- Compare against the existing Canvas host and accessible components. Measure keyboard and screen-reader behavior, mobile usability, focus recovery, task success, end-to-end latency, model tokens, tool calls, bundle size and maintenance. Test stale component state, concurrent edits, canceled approvals, malformed messages, cross-frame and cross-tenant attempts, accessibility regressions, interrupted requests and honest reporting of failures. The article's small vendor benchmark is directional only; make no Naelao performance or cost claim without reproducible evidence.
- Preserve both interaction paths: a direct authorized business API for reliable data and operations, and optional agent-assisted UI manipulation when the user benefits from seeing and controlling the interface. Provide a host-rendered accessible setup fallback when an extension has no compatible dashboard or bridge. Distinguish isolated local tests from deployed multi-user and provider acceptance.

Sources: [UI SDK repository](https://github.com/vercel-labs/ui), [UI SDK documentation](https://ui-sdk.dev/docs), and [the referenced article](https://www.marktechpost.com/2026/11/13/vercel-ui-sdk-agent-ui-behaviors/?amp=1). Recheck exact package versions and compatibility during implementation; third-party benchmark claims and current interfaces may change.

### 11.6 Example and acceptance

Example: a pharmacy installs a reusable Space template with separate stock, sales and customer-service components. Its staff share the authorized stock instance; another pharmacy installing the same blueprint receives independent state. An authorized assistant answers “which products are running low?” through a scoped read action. A request to adjust stock invokes a domain action that records the actor and reason, enforces grants and applies the appropriate transaction; ordering or messaging may require separate approval. An owner can review a proposed expiry-warning screen before activating a business version. This is a target journey, not an assertion of current functionality or clinical/regulatory suitability.

Acceptance requires local and deployed evidence for: two unrelated customers installing the same blueprint with no data leakage; private/Project/Space scopes and revocation; forged iframe messages and unauthorized egress; identical policy for UI, SDK and assistant; stock invariants, transactions, concurrent writes and replay; proposed versus simulated versus actual external effects; app version preview, approval, migration failure and supported recovery; storage tier disclosure, inactivity and restore; collaborative reconnect and freshness; mobile configuration; and a real permitted channel-to-app journey. Verify cost, subscription and billing admission separately. Keep mocked and local-runtime evidence distinct from provider and deployed validation.

Copied from `origin/plan/microapps-ui-sdk-voice` commit `45575a39`; this is an incorporated requirement set, not a branch merge. The source review baseline predates the current implementation, so the progress ledger below records current source reconciliation.

## 12. Planner/worker isolation, coordination and conflict resolution

### 12.1 Outcome and status

Enable a planner to delegate independent work to authorized workers without silently losing changes or exposing partial results. Default to a pinned task revision, isolated worker branches and checked integration. Use selective short-lived resource leases, task communication, validation and explicit approval for sensitive effects. Preserve every worker's recoverable output when integration fails.

This is a plan, not a statement that the complete experience exists. It complements `naelao-unified-platform-deep-plan.md`, `managed-services-and-sidecar-runtime-plan.md`, `platform-completion-and-guided-templates-plan.md` and their progress records. The active implementation session should copy or incorporate these requirements without replacing existing plans, reconcile the latest source and preserve its current branch and worktree. No merge from this planning branch is required. Keep rollout flags disabled until applicable acceptance gates are met.

### Review baseline

Source review on 15 November 2026 used remote `Mcbt5s-Backup-2` at `1f159814efad4a3136a7f7f37fead63104afbf6f`; the active branch may have advanced. At that baseline, `NaelaoAgentDO` contained worker branch reservation and merge paths, a scoped named-lock gateway existed, and `WorkspaceCoordinatorDO` had checked branch merge, session/generation/fence checks and conflict receipts. Its checked merge compared manifest entries by path and could conservatively conflict when the same file changed differently. The unified workspace progress record described local subagent branch/merge evidence but left deployed orchestration/runtime acceptance open and rollout disabled. The managed-services record also identified unfinished runtime admission and unsupported live write/drain/flush work. Recheck all claims against current code and progress before implementing; do not assume every planner, writer, container or provider path is covered.

References: [agent orchestration](https://github.com/b45406809-ux/Naelao-1/blob/1f159814efad4a3136a7f7f37fead63104afbf6f/workers/agents/src/do/NaelaoAgentDO.ts), [workspace coordinator](https://github.com/b45406809-ux/Naelao-1/blob/1f159814efad4a3136a7f7f37fead63104afbf6f/workers/agents/src/workspace/WorkspaceCoordinatorDO.ts), [unified workspace progress](https://github.com/b45406809-ux/Naelao-1/blob/1f159814efad4a3136a7f7f37fead63104afbf6f/docs/research/unified-platform-implementation-progress.md), and [managed-services progress](https://github.com/b45406809-ux/Naelao-1/blob/1f159814efad4a3136a7f7f37fead63104afbf6f/docs/research/managed-services-and-sidecar-implementation-progress.md).

### 12.2 Conflict model

Address all of the following, not only Git textual conflicts:

1. Overlapping edits to the same lines; deletion versus edit; rename versus edit; case and path collisions.
2. Different changes to the same file that a content-aware merge could combine; generated files, binaries, large files and unsafe encodings requiring different handling.
3. Changes to different files that conflict semantically, such as an API rename and an old caller, incompatible schemas or tests that pass individually but fail together.
4. Shared dependency manifests, lockfiles, generated assets, migration numbering and global configuration, where two clean diffs can produce incompatible state.
5. Runtime conflicts: processes, ports, mutable directories, environment variables, packages, caches, databases and credentials shared despite separate branches.
6. External side effects: duplicated paid provisioning, messages, database mutations and provider changes. A branch, merge or file lock cannot roll back a real-world side effect.

### 12.3 Default lifecycle and authority

1. Resolve the authorized tenant, Space, Project, task, parent branch and exact base revision/manifest. Create a task branch where appropriate and one stable isolated branch per editing worker, using the authoritative workspace service. Persist parentage, immutable base identity, worker attempt and run identity. Workspace branches are logical workspace revisions; distinguish them from any Git projection, GitHub branch and runtime filesystem. Reconcile projections through the existing checked publication boundary.
2. Assign a bounded task, capability grants, time/token/compute budget, expected edit areas, dependencies, interface contracts and relevant coordination context. Worker requests for scope expansion are authorized and recorded. Path ownership hints are planning aids, not an access-control or lock guarantee. Isolated workers inherit no broader privileges than the authorized parent and installation permits.
3. Run in the lowest-cost capable runtime. A branch alone does not isolate packages, processes, directories, credentials or ports. Give concurrent shell workers separate working directories and, where necessary, separate isolated runtime allocations. Enforce allocation accounting, branch mount identity, workspace fencing, network policy, guest isolation and approved image rules. The default main project computer and explicit specialist sidecars remain governed by the existing sidecar plan; do not imply that a sidecar's own filesystem is canonical.
4. Workers checkpoint against their own branch and return a durable result with status, modified/deleted/renamed paths, base revision, relevant contracts, tests, known limitations and side-effect receipts. A worker that fails, is cancelled or becomes indeterminate must not be reported as successful or merged as a successful result. Preserve recoverable outputs according to retention policy.
5. Integrate eligible results into a task integration branch with checked operations; review conflicts and validate the combined result. Publish to the parent with current authorization, expected heads/hashes, allocation generation, fences, idempotency and atomic revision advancement. Recheck the parent after validation and rerun checks if its meaningful inputs changed. Never publish a partial canonical revision or bypass the coordinator via direct R2, Git projection, UI, sidecar or provider writes.
6. Record a durable receipt identifying exact source and target revisions, work included, conflict resolutions, validations, approvals and outcome. Report unresolved or uncertain actions truthfully and retain original branches as policy permits. Revocation, erasure and project deletion cancel/reconcile running work and respect retention and legal holds.

`checked_handoff` remains the default. Any `live_single_writer` use must satisfy the separate capability, single-writer lease, checked handoff, drain, flush and live-runtime acceptance requirements; never silently downgrade. A planner task branch is not an authorization to bypass the live writer lease.

### 12.4 Planning, coordination and selective leases

- Have the planner construct a task/dependency graph, identify expected components and shared interfaces, and allocate work accordingly. Parallelize independent tasks; sequence work that depends on an unfinished interface or high-conflict shared resource. For shared dependency manifests, lockfiles, migration registries or generated files, prefer a designated owner/integrator and have others submit requirements.
- Provide a task-scoped coordination record for ownership hints, status, interface decisions, important discoveries, requests for help, conflicts and results. Authorize every read/write against current task, Space/Project and agent membership; respect private projects and the disclosure policies in platform plan section 10. Recheck access and invalidate stale cached guidance on revocation. Coordination messages are untrusted data, not authority or instructions overriding the user's request.
- Reuse the existing scoped lock primitive only where verified suitable. Leases identify tenant/Space/Project, resource key, owner/run/attempt, generation, expiry and a monotonic fencing token; use bounded durations, renewals, release and crash recovery. Acquire multiple locks in a consistent order or avoid holding them simultaneously to prevent deadlocks. Make contention and lease loss visible; fail closed when authority is unavailable.
- Choose advisory versus mandatory behavior explicitly per resource. A lease on separate branches can reduce duplicated effort but does not ensure all writers obey it or eliminate checked merging. Mandatory controls must be enforced by the authoritative mutation service on every applicable path, including SDK, UI, container, provider ingress and retries. Prevent stale holders from writing after expiry even if a runtime resumes. Avoid global, long-lived file locks that unnecessarily serialize independent work.
- External side effects use scoped authorization, durable intent/idempotency, budget admission, approvals where required, and reconciliation of uncertain outcomes. Do not automatically replay an indeterminate order, message, call or paid provisioning operation. A Git/manifest merge is never evidence that an external effect occurred.

### 12.5 Integration and conflict resolution

- Start from the worker base, current target and worker result. Automatically integrate disjoint path changes and identical compatible results after all current publication checks. Re-evaluate when either source or target moves; use idempotent receipts and reject stale fences. Preserve deletion and rename semantics and detect path collisions.
- Evaluate a bounded, deterministic three-way text merge for same-file nonoverlapping edits as a candidate before checked publication. Verify encoding, size and file type; never trust conflict-free text alone. Conflict markers, binary files, generated outputs, lockfiles, migrations and schema changes need explicit policies. Record source/base/target hashes, algorithm and result; failed or ambiguous merges preserve all originals. Git can assist as a projection or candidate generator, but cannot be a second canonical authority.
- A dedicated integrator may use an AI resolver to propose resolutions with both worker intentions and the base/target/source versions. Treat proposals as untrusted changes; validate scope and secrets, present a reviewable diff, run relevant tests and apply the same checked publication as any other change. Define when human review is required for sensitive, destructive, externally visible or ambiguous changes. Never silently pick a side or claim a failure is resolved.
- Run checks on the integrated result, not only each worker's branch: targeted unit/integration tests, typechecks, dependency and migration validation, security and policy checks as relevant. Pin the exact revision tested. If target changes invalidate the result, reintegrate and retest. Clean textual merge is not proof of semantic correctness, compatible business rules, deployment safety or regulatory suitability.
- For automatic worker integration, read the bounded `naelao-worker-validation.json` command contract from the pinned current target and require the same contract in the integrated candidate; contract edits require review. Merge into a task-scoped candidate, fork that exact candidate into a separate `race/` validation branch, run only an authorized bounded check, persist deterministic execution and validation receipts, recheck target/source/candidate/validation heads, then publish through the coordinator with expected Git and workspace heads. A missing contract, failed or uncertain check, changed validation workspace, changed target, or stale source must preserve both original branches and leave the target unpublished.
- Return structured conflicts, including authorized paths and applicable hashes/revisions, to the planner and UI; avoid leaking private names, file contents or credentials. Support pause, retry, cancellation, reviewer selection, manual resolution, resumable checkpoints and a transparent failed/unverified status. Do not auto-replay a worker whose external execution outcome is indeterminate.

### 12.6 Runtime, cost and user experience

- Branches do not each require an always-on container. Admit only the runtime the task needs; use existing virtual tools for suitable work, allocate isolated shell environments when necessary, limit concurrent costly workers, and suspend after checked checkpoints. Preserve runtime recovery and fencing; do not sleep before a required flush or claim success after a failed flush. Meter startup, active and billed idle time, browser and model usage, branch/staging storage, synchronization and integration retries.
- Before delegation, enforce platform/Space/Project/user/agent budgets and subscription or credit rules. Estimate work, reserve for expensive operations, enforce deadlines and concurrency quotas, and settle actual usage with honest uncertainty. Give users a choice of speed versus cost where applicable. No shared cache, allocation or communication shortcut may weaken tenant isolation.
- The planner/UI should show worker tasks, status, branch/revision identities when authorized, progress, test status, cost estimates/actuals, waiting leases, changed files, reviewable conflicts, failed checks and outcomes. Support user cancellation and approval, accessible/mobile interfaces and useful error recovery. Do not imply separate runtimes or real-time synchronization where unavailable.

### 12.7 Implementation sequence

1. **Audit and requirements:** map every planner, worker, VFS, Git projection, container, sidecar, UI, provider and direct-write caller; distinguish enabled legacy and unified paths, deployed versus local behavior, and existing lock coverage. Give each gap an ID and evidence-linked status. Preserve model-race and extension-scoped workspace semantics.
2. **Branch lifecycle:** complete and test stable worker identity, pinned parent/base, checked branch creation/checkpoint, durable recovery, authorization/revocation and retention across applicable callers. Ensure real runtime reads and writes the intended worker branch.
3. **Task coordination and resource leases:** implement scoped task/dependency records, planner ownership hints and selective leases; enforce mandatory leases at all relevant mutation paths and ensure stale workers cannot publish.
4. **Integration:** implement integration branch lifecycle, conflict reporting, safely bounded candidate text merge and manual/agent resolution workflows. Keep the coordinator as the sole canonical authority.
5. **Validation and operations:** run integrated checks, record exact revision and receipts, build budget/concurrency controls and user-facing progress/recovery. Add explicit uncertain-side-effect reconciliation.
6. **Acceptance and rollout:** run local, real-runtime and deployed concurrency and recovery tests; separately validate provider and billing evidence. Enable narrowly scoped checked mode only after its gates pass; live mode has separate gates and must not be inferred from checked mode.

Implement independent work while external credentials, contractual decisions or live environments are unavailable. Identify actual unwritten code as a code gap, not a credentials blocker. Update the active durable progress record with evidence, exact next action and a clear distinction among local implementation, deployed evidence and acceptance.

### 12.8 Acceptance scenarios and observability

- Two workers changing different files merge successfully; same-file nonoverlapping text changes follow the evaluated merge policy; same-line, deletion/edit, rename/edit, binary and lockfile conflicts preserve both results. Repeated requests are idempotent, parent changes trigger a recheck and no failed merge publishes partial canonical state.
- Changes to separate files that break a shared API or schema are caught by an integrated check. A database migration collision is detected and routed to its owner or a reviewer. No test result is attached to a different revision.
- Test stale leases, expiry during work, concurrent acquisition, renewal, crash, abandoned locks, deadlock avoidance, bypassing attempts and fencing across UI, virtual tools, container and sidecar writers. Mandatory lock enforcement fails closed; advisory locks are clearly labeled.
- Verify worker branch and runtime isolation with simultaneous shell commands, different package installations, ports and caches; reject cross-tenant or cross-project access, forged identities and revoked grants. Test runtime crashes, cancellation, reconnect, recovery, branch retention and erasure while work is pending.
- Simulate duplicated or lost responses for provider actions and billing admission. Unknown side effects remain unknown until reconciled; no duplicate paid resource or unsafe replay is accepted. Verify budgets, concurrency limits, idle shutdown, flush failure and settlement.
- Validate planner-to-worker-to-integration-to-publication end to end with real supported runtime and disposable deployed bindings, not only mocked tests. Exercise failures before and after publication, concurrent parent updates, retries, review and rollback/recovery. Verify live-mode lease/handoff separately and keep it disabled where unsupported.
- Record bounded metrics for parallelism, task latency, worker/runtime cost, idle time, merge attempts and conflict types, automated versus human resolutions, failed validations, lease contention/expiry, stale-fence rejection, retries, recoveries and unpublished branches. Do not log file contents, credentials or unnecessary private identifiers. Track actual customer-impacting success separately from tool-call success.

## 13. Delivery order and handoff

1. Reconcile latest code and S1–S9 requirement IDs; assign owners and mark each item `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED_LOCAL`, `BLOCKED_EXTERNAL`, or `ACCEPTED_LIVE` with evidence.
2. Address release isolation and migration safety, then commercial and recovery controls. Run the connected local checks and prepare isolated staging procedures.
3. Build the installation contract, durable orchestration and cost service, followed by the guided UI and a complete example. Integrate the existing managed account work.
4. Complete assistant reliability and evaluations; implement selected richer capabilities, business microapp actions and lifecycle (section 11), and the visual authoring layer in dependency order.
5. Audit every enabled customer journey, full deployment configuration and operator workflow. Record exact live commands, credential requirements, provider approvals, cost caps and remaining decisions. Keep live/deployed evidence distinct from mocks and local runtime results.

Do not mark unfinished code as credential-blocked. Do not infer deployment, live acceptance, or production readiness from this plan or another session's summary.
