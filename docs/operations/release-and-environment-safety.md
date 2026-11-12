# Release and environment safety

The source-of-truth deployment sequence is [deployment-manifest.json](../../infra/release/deployment-manifest.json).
The deployment manifest validator runs in both staging and production preflight and compares the
recorded worker order, worker inventory, phase dependencies, and required schema version with the
checked-in workflows. `schema-manifest.json` remains the ordered checksum inventory for D1 SQL.

## Current release behavior

- Staging builds from the `main` commit; production runs from a `vMAJOR.MINOR.PATCH` tag. Record the
  immutable Git commit SHA with every release so all Workers and frontend artifacts can be tied to
  their source.
- Both environments run the same local build/typecheck/test and static isolation/resource preflight.
  They require separately attested D1 baselines and fresh read-only resource receipts before remote
  migration work. These inputs are missing in the current checkout, and both preflights currently
  fail on shared D1/KV IDs. Do not bypass these checks.
- The D1 migration runner applies the lexical manifest order using a database-scoped durable ledger,
  per-file checksum receipts, a single-writer lock, and an execution owner. SQL changes and their
  applied receipt are executed together. After all migrations it checks the required schema and
  schema-specific consumer probes before Workers deploy.
- Staging deploys the primary Workers and remaining Workers before its Pages, widget, and portal
  deployment jobs can publish. Production deploys Workers before its Pages and widget job. The worker
  loops record all failures and fail their deployment job; dependent jobs do not promote frontends
  after that failure.
- There is no post-deploy Worker health probe or automatic rollback in either workflow. CI tests and
  zero-row D1 schema probes are not runtime health or customer-journey acceptance.

## Existing D1 adoption and interrupted migrations

Never create an adoption baseline from source history alone. First verify the exact environment and
database ID through a read-only account inspection. Then run `release_migrations.py --inspect-baseline`
against that exact database and have the database owner review the schema fingerprint and native D1
migration list. This report does not infer which SQL files were applied. Record the reviewed
manifest digest and each migration's applied or explicitly approved skipped status in the separate
environment baseline. Migration 0164's skip is allowed only when the inspected legacy
`agentport_messages` table is absent. A baseline is environment-specific and must not be copied
between databases.

On failure, stop promotion and inspect `naelao_release_migration_lock`,
`naelao_release_migrations`, and the error record. A failed migration retains its lock. Resume only
with that recorded execution owner after confirming the current database and migration receipt; do
not delete the lock or mark a migration applied to get the pipeline green. If the owner or outcome
is ambiguous, keep the release blocked and reconcile the actual schema with a database owner before
resuming. Re-run the validator and required schema probes after a repair.

## Compatibility and repair

Use expand/contract changes: add nullable or compatible schema first, deploy code that tolerates the
old and new shape, backfill with a bounded resumable process, and remove old fields only in a later
release after all consumers have moved. During a Worker rollout, old and new Worker versions can
coexist, so every intermediate state must be safe for both. Do not use schema rollback as a code
rollback plan.

If any migration, schema probe, or Worker deploy fails, keep the applied schema and stop dependent
promotion. Inspect exactly which components and migrations completed. Ship a reviewed forward fix or
a new release whose code is compatible with the current schema. Do not reverse an applied migration
or assume Git revert restores D1 data. If data was changed or deleted, use a separately verified
backup restore plan; the current archive/backup and live restore evidence remain partial under P04.
Record commit/tag, migration ledger state, failed and successful components, operator decision, and
follow-up checks in the release record.

## Environment inventory gate

`infra/environment/resource-map.json` is generated from checked-in Wrangler source and is not proof
that a named Cloudflare resource exists. `resource-receipts.json` must come from fresh read-only
Cloudflare inspection and match every configured D1/KV ID and required staging Queue, Workflow, R2,
and Vectorize resource. Do not invent IDs, account IDs, timestamps, evidence sources, service owners,
or receipt status. Assign different mutable D1/KV resources to staging and production. Resolve the
`naelao-calls` service target to its real Worker owner. Then obtain a separate schema baseline for
each D1 database. Keep secrets, webhook endpoints and provider resources environment-specific.

The current code validators correctly reject the source configuration until these account-owned
facts are supplied. No resources were inspected or created while writing this runbook.
