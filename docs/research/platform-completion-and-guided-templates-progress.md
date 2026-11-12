# Platform completion and guided templates progress

## Active checkpoint

Updated 2026-11-12 on `autonomous-managed-services-20261111`. The platform plan at
`platform-completion-and-guided-templates-plan.md` was added by commit `9e1281ce` and is already
integrated in this branch. Findings in that plan were researched against an older checkout; the
statuses below reflect the current source where inspected. This file is additive to the managed
services progress record; reuse its U01–U12 and S1–S9 ledgers rather than duplicating their evidence.

### P01 — ordered releases and migration safety: PARTIAL, local release controls implemented

Current code already provides an ordered 229-file migration SHA-256 manifest, a Python release
runner with an atomic D1 migration ledger and concurrency lock, checksum drift checks, a resumable
execution owner after interruption, fail-closed handling for non-idempotent legacy migration 0164,
pre-deploy required-schema probes, and staging/production workflows that run migrations before
consumers. Source tests passed locally: resource receipt validator **6/6**, Wrangler environment
isolation **6/6**, migration runner **7/7**, release manifest **5/5**; the manifest reports required
schema `0229_agentport_sender_principal_refs`. These are local tests. No D1 database was inspected.

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
- `python3 -m unittest discover -s infra/scripts -p 'test_release_migrations.py'`: **7/7**.
- `python3 -m unittest discover -s infra/scripts -p 'test_validate_release_manifest.py'`: **5/5**.
- `python3 infra/scripts/validate_release_manifest.py`: 229 migration files; required schema
  `0229_agentport_sender_principal_refs`; no deployed schema inspected.
- `python3 infra/scripts/validate_environment_resources.py` and
  `python3 infra/scripts/validate_wrangler_env_isolation.py`: correctly fail closed on current
  resource sharing, missing ownership/receipts and shared mutable bindings.
- No deployment, Cloudflare API inspection, D1 access, resource creation, or live acceptance.
- P01 implementation verification: deployment-manifest tests **5/5**, manifest validator passes,
  staging frontends are job-gated on successful Worker deployment, and `git diff --check` passes.

## Requirement queue

The new plan's source findings P03–P10, P11–P24, guided templates, voice extension dashboards, and
Shared-Space coordination have not yet been reconciled in this checkout. The old-checkout claims are
not treated as evidence. Continue in the plan's dependency order:

1. Preserve the P01/P02 preflight gates until distinct Cloudflare resources, service ownership,
   read-only resource receipts, and per-database baselines are verified. Do not invent them.
2. Continue independent commercial/operator work at P03, then reconcile P11–P13, P18–P21 against Billing, queue health,
   notification, and marketplace callers; reuse the S2/S7 ledgers.
3. Reconcile P04 and P22 recovery/data lifecycle against current archive, object, index, tombstone,
   and erasure callers; preserve the U01/U10 retention limits.
4. Continue the remaining assistant quality, extension, voice/dashboard, guided-template, and
   Shared-Space requirements only after dependencies are recorded with source evidence.

Keep rollout disabled. Do not deploy, create resources, purchase services, or claim deployed/live
acceptance. Commit and push each coherent checkpoint to `origin/Mcbt5s-Backup-2` after fetching and
safely integrating any remote advances.
