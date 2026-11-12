# D1 release migration baseline adoption

`infra/scripts/release_migrations.py` is the only migration path in the staging and
production deployment workflows. It refuses to touch D1 until a reviewed baseline
exists at `infra/release/baselines/staging.json` or `production.json`.

## First adoption

1. Use an authorized, read-only Cloudflare token and the exact D1 ID configured for
   the target environment. Do not run the deployment workflow to discover schema.
2. Capture the runner's inspection output:

   ```sh
   python3 infra/scripts/release_migrations.py \
     --environment staging \
     --database-id "$D1_DATABASE_ID_STAGING" \
     --inspect-baseline
   ```

   Use `production` and the production D1 ID for that environment. This mode only
   reads `sqlite_master`, the native `d1_migrations` history when present, and the
   legacy `agentport_messages` table marker. It prints a schema fingerprint; it does
   not infer which SQL files were applied.
3. Compare the actual schema and data effects with the ordered migration source and
   any deployment records. Do not infer that a migration ran only because its number
   is lower than another applied file. Account for every source migration from the
   beginning through the verified baseline version. Record only the explicit
   AgentPort 0164 skip when its source condition is proven; all other skips are
   rejected.
4. Create the environment baseline JSON with these fields:

   - `formatVersion: 1`, `environment`, exact `databaseId`;
   - `manifestSha256` copied from the inspection output, `verifiedAt` with timezone,
     `verifiedBy`, and a durable `evidenceRef` such as a change record;
   - `schemaFingerprint`, `nativeMigrationNames`, and `attestedSchemaVersion` from the
     inspected database and verified source history;
   - ordered `migrations`, one entry per source migration through the baseline version,
     with the checked-in filename and SHA-256 plus `status: "applied"` or the
     narrowly allowed `status: "skipped"` and exact reason
     `legacy table agentport_messages was absent` for migration 0164.

   An empty D1 database uses an empty `migrations` list, `nativeMigrationNames: []`,
   and `attestedSchemaVersion: null`, after its empty schema fingerprint is reviewed.
5. Review and commit the environment baseline before enabling any deployment. The
   release runner rechecks the exact D1 ID, schema fingerprint, native migration
   names, migration hashes and order before adopting it. It writes its own durable
   checksum ledger and lock only after those checks pass.

The schema fingerprint is an identity check for database structure, not proof that a
particular historical data migration ran. The human review and linked evidence must
cover data-only migration effects and any historical `wrangler d1 execute` records.
No baseline currently exists in this checkout, so both deployment migration steps
stop before contacting Cloudflare.

## Retry and lock recovery

Each migration SQL file and its checksum-ledger receipt are submitted together as one
D1 file transaction. A failed file leaves no receipt, so the next attempt starts with
that migration. The durable lock has no timeout and is not stolen automatically.
Re-running the same failed GitHub Actions run retains its stable owner ID and resumes
the sequence. If an operator must resume from a new workflow run, first confirm the old
run is no longer active and inspect:

```sql
SELECT * FROM naelao_release_migration_lock;
SELECT * FROM naelao_release_migrations ORDER BY filename;
```

Then set the environment-scoped `D1_MIGRATION_RESUME_OWNER` variable to the exact
stored owner for one retry. Remove it after the lock is released. A different owner,
modified historical checksum, schema mismatch, consumer probe failure, or missing
required version stops deployment. Do not delete the lock or ledger to make a release
proceed; reconcile the database and preserve the audit record first.
