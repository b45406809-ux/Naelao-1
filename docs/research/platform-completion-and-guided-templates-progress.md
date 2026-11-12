# Platform completion and guided templates progress

## Active checkpoint

Updated 2026-11-12 on `autonomous-managed-services-20261111`. The platform plan at
`platform-completion-and-guided-templates-plan.md` was added by commit `9e1281ce` and is already
integrated in this branch. Findings in that plan were researched against an older checkout; the
statuses below reflect the current source where inspected. This file is additive to the managed
services progress record; reuse its U01–U12 and S1–S9 ledgers rather than duplicating their evidence.
The P01 deployment manifest, staging dependency gate, tests and runbook are pushed to
`origin/Mcbt5s-Backup-2` as `749f9c95`. P03/P11–P13 code, tests, schema updates and this source
reconciliation are pushed in code commit `2625ea3426d5ee1bc7d7dce3776553073843640d`; the current
progress refresh is pushed as docs commit `def77078` immediately after that code checkpoint.

### P01 — ordered releases and migration safety: PARTIAL, local release controls implemented

Current code already provides an ordered 230-file migration SHA-256 manifest, a Python release
runner with an atomic D1 migration ledger and concurrency lock, checksum drift checks, a resumable
execution owner after interruption, fail-closed handling for non-idempotent legacy migration 0164,
pre-deploy required-schema probes, and staging/production workflows that run migrations before
consumers. Source tests passed locally: resource receipt validator **6/6**, Wrangler environment
isolation **6/6**, migration runner **8/8**, release manifest **5/5**; the manifest now reports
required schema `0230_queue_health_observations`. These are local tests. No D1 database was
inspected.

Added `infra/release/deployment-manifest.json`, a validator wired into both preflights, and
`docs/operations/release-and-environment-safety.md`. The validator checks tag/commit versioning,
required schema, Worker inventory and order, phase/job dependencies, and disclosures that no
post-deployment health probes or automatic rollback exist. It confirms the current workflow
matches this manifest. Staging dashboard, portal, marketplace, and widget publication now depends
on successful Worker deployment; previously three jobs could publish after Worker deployment
failed. The manifest distinguishes static preflight and schema probes from deployed health evidence.

Neither `infra/release/baselines/staging.json` nor `production.json` exists. The runner therefore
cannot contact an existing D1 or adopt its non-idempotent migration history. Do not create a baseline
without a read-only inspection and operator attestation of the exact database. The workflows have no
post-deploy runtime probes and no automatic rollback. Restore procedures still depend on the
separate P04 backup gap.

### P02 — isolated environments: PARTIAL, fail-closed

Current code has a source-derived inventory generator, exact configured-resource receipt checks,
staging/production D1 and KV cross-binding detectors, and these checks run in both deployment
preflights. The stale source inventory was regenerated from the current Wrangler TOMLs. Current
source still assigns staging and production the same `PLATFORM_DB` D1 and **11** mutable KV IDs;
both validators reject these bindings. The resource receipt file contains no observed account,
timestamp, or resource rows, so all required existence receipts are absent. `naelao-calls` is a
service target with no named Worker owner. Evaluation Worker source points staging to
`naelao-agents-staging` and production to `naelao-agents-production`; these are distinct in the
checked-in TOML, though deployed bindings have not been inspected.

The distinct D1/KV IDs, actual Cloudflare resource existence/account, service owner for
`naelao-calls`, and read-only receipts require verified environment configuration/evidence. Do not
substitute guessed IDs, account names, timestamps, or ownership. Deployment preflight remains
blocked until source configuration and operator-observed receipts satisfy the validators.

### Verification recorded for this checkpoint

- `python3 -m unittest discover -s infra/scripts -p 'test_validate_environment_resources.py'`: **6/6**.
- `python3 -m unittest discover -s infra/scripts -p 'test_validate_wrangler_env_isolation.py'`: **6/6**.
- `python3 -m unittest discover -s infra/scripts -p 'test_release_migrations.py'`: **8/8**.
- `python3 -m unittest discover -s infra/scripts -p 'test_validate_release_manifest.py'`: **5/5**.
- `python3 infra/scripts/validate_release_manifest.py`: 230 migration files; required schema
  `0230_queue_health_observations`; no deployed schema inspected.
- `python3 infra/scripts/validate_environment_resources.py` and
  `python3 infra/scripts/validate_wrangler_env_isolation.py`: correctly fail closed on current
  resource sharing, missing ownership/receipts and shared mutable bindings.
- No deployment, Cloudflare API inspection, D1 access, resource creation, or live acceptance.
- P01 implementation verification: deployment-manifest tests **5/5**, manifest validator passes,
  staging frontends are job-gated on successful Worker deployment, and `git diff --check` passes.

### P03 — payment failure lifecycle: PARTIAL, durable notification path present; policy unresolved

Current Lemon Squeezy and Whop `payment.failed` handling updates the exact subscription to
`past_due` and records a stable dunning event in `billing_dunning_outbox`. Billing lease/retry
dispatches it to the `DUNNING_EVENTS` queue. The Workflows consumer validates the common v1 event,
creates a stable `DunningWorkflow`, and confirms an existing instance after ambiguous create
responses before acknowledging redelivery. The workflow rechecks the exact current subscription and
event timestamp before queueing a notice to the verified product email or current organization
owner/admin. Payment recovery and expiry are handled by provider subscription transitions.

There is no approved grace-period length, activity restriction matrix, escalation policy, or manual
intervention contract. Paid access remains until the provider reports expiry; this is current
behavior, not a policy claim. Provider retries and actual Notifications delivery are not verified.

### P11/P12 — checkout and dunning contracts: local behavior reconciled

P11's current `checkout-policy` limits simulated checkout to explicit local/development/test config.
Staging/production config disables it, and tests cover missing providers, upstream failure and
production/staging rejection. Provider success, webhook delivery, and entitlement application still
need authorized staging acceptance.

P12's duplicated permissive payload checks were consolidated in
`packages/types/src/managed-billing-events.ts` as strict versioned `DunningEventV1`. Billing writes
version 1; Billing dispatch, compatibility queue handling and Workflow queue consumption share the
validator. Legacy pending payloads without a version remain readable as v1 for recovery; explicit
unknown versions are rejected. Local evidence: Billing/workflow dunning, checkout and queue suites
**31/31**; Billing, Workflows and shared-types typechecks. Email/provider delivery and platform
access restrictions remain separate acceptance/policy gates.

### P13 — queue health: PARTIAL, honest telemetry and durable alerts implemented

The old behavior used interval queue totals as current depth, reported oldest age as zero, treated
interval dead-letter totals as current DLQ depth, fell back to unrelated `usage_events`, and swallowed
history-write failures. The current workflow explicitly represents current backlog, age and DLQ
depth as unavailable; missing credentials, GraphQL errors and no rows produce `unknown`, while
partial interval evidence is `incomplete` and a high measured interval error rate is `degraded`.
Migration `0230_queue_health_observations.sql` persists every report; alert rows use the existing
operator-visible `platform_failures` review inbox, written atomically with the report. The migration
is required by release schema probes. Local evidence: model suite **7/7**, SQLite migration
constraints **3/3**, release runner **8/8**, both manifests validate. No Cloudflare account was
queried. Current depth/age/DLQ and live telemetry acceptance still need a supported provider API or
operator inspector.

### P18/P20/P21 — current-source reconciliation

P18 reset consumes a one-time token and atomically applies the password, advances account
`security_generation`, and journals session cleanup via migration 0227 triggers. Protected requests
compare the persisted generation before accepting a ProductUserDO session; the scheduled dispatcher
retries downstream DO cleanup. P21 email delivery stores encrypted token/recipient payloads in a
bounded outbox, keeps public responses neutral, retries using a stable notification ID, cancels
superseded reset tokens, and exposes HMAC-scoped tenant diagnostics. Signup currently issues a
session before verification; access policy for unverified users and real email delivery remain open.
Current local verification: Spaces auth/reset/security/email suites **24/24** and Spaces typecheck.

P20 handles signed Lemon Squeezy marketplace refund events in a durable idempotent review journal,
matches them against observed purchases, validates currency/amount/tenant, reconciles late-arriving
purchase matches, and exposes scoped review listing. Exact refund/access reversal, author earnings
clawback, payout recovery, dispute ingestion and case resolution are not implemented because the
product/accounting policy is not decided. Local settlement/refund tests pass **6/6**. No provider
sandbox or live transaction was used.

## Requirement queue

The platform plan's P01–P03, P11–P13 and P18/P20/P21 have now been reconciled against current source.
P02 remains fail-closed as recorded above. Continue in dependency order:

1. Preserve the P01/P02 preflight gates until distinct Cloudflare resources, service ownership,
   read-only resource receipts, and per-database baselines are verified. Do not invent them.
2. Preserve the explicit P03 grace/restriction and P20 refund/author-accounting decisions as open
   product contracts; advance only independent code while they are unresolved.
3. Reconcile P04 and P22 recovery/data lifecycle against current archive, object, index, tombstone,
   and erasure callers; preserve the U01/U10 retention limits.
4. Reconcile P14–P19 and P23–P24 against current sessions, queues, notifications and package
   lifecycle, then continue P05–P10 and guided template authoring, voice dashboards, and Shared-Space
   requirements in their dependency order. Maintain one owner/evidence record for overlapping S/U
   requirements rather than building parallel ledgers.

Keep rollout disabled. Do not deploy, create resources, purchase services, or claim deployed/live
acceptance. Commit and push each coherent checkpoint to `origin/Mcbt5s-Backup-2` after fetching and
safely integrating any remote advances.
