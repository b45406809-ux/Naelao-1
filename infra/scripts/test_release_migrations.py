import hashlib
import json
import re
import unittest
from pathlib import Path

import release_migrations as release
from validate_release_manifest import MANIFEST_PATH, load_manifest


class MemoryD1:
    """Small atomic D1 substitute used only for release-runner unit tests."""

    def __init__(self, fail_on_migration=None):
        self.tables = set()
        self.meta = {}
        self.ledger = {}
        self.lock = None
        self.schema_rows = []
        self.fail_on_migration = fail_on_migration
        self.failed = False
        self.applied_sql = []
        self.queue_health_columns = ("triggered_at", "observed_at", "source", "status", "unavailable_reason", "metrics_json", "alert_count", "alerts_json")
        self.auth_email_columns = ("operation_id", "status", "provider_receipt_id")
        self.dunning_attempt_columns = (
            "tenant_id", "notification_id", "subscription_scope", "provider", "provider_outcome",
            "attempt_count", "last_http_status", "provider_receipt_id", "first_attempt_at",
            "last_attempt_at", "accepted_at", "updated_at",
        )
        self.notification_delivery_columns = (
            "tenant_id", "notification_id", "channel", "provider", "outcome", "attempt_count",
            "queue_attempts", "last_http_status", "provider_receipt_id", "failure_code",
            "first_attempt_at", "last_attempt_at", "accepted_at", "updated_at",
        )
        self.knowledge_deletion_columns = (
            "operation_kind", "erasure_request_id", "cache_generation_to_purge",
            "cache_generation_next", "cache_cleanup_ids_json", "cache_cleanup_status",
        )
        self.gdpr_request_columns = ("id", "tenant_id", "request_type", "cache_cleanup_status")
        self.extension_call_columns = ("extension_installation_id", "handler_sha256")

    def query(self, sql):
        if "name IN (" in sql:
            return [{"name": name} for name in sorted(self.tables)]
        if "name NOT LIKE 'sqlite_%'" in sql:
            return self.schema_rows
        if "SELECT * FROM naelao_release_migration_meta" in sql:
            return [{"key": key, "value": value} for key, value in self.meta.items()]
        if "SELECT * FROM naelao_release_migrations" in sql:
            return list(self.ledger.values())
        if "SELECT owner,last_migration FROM naelao_release_migration_lock" in sql:
            return [self.lock.copy()] if self.lock else []
        if "SELECT name FROM sqlite_master WHERE type='table' AND name=" in sql:
            match = re.search(r"name='([^']+)'", sql)
            return [{"name": match.group(1)}] if match and match.group(1) in self.tables else []
        if sql.startswith("PRAGMA table_info('billing_dunning_outbox')"):
            return [{"name": name} for name in ("workflow_id", "tenant_id", "status", "next_attempt_at", "updated_at")]
        if sql.startswith("PRAGMA table_info('queue_health_checks')"):
            return [{"name": name} for name in self.queue_health_columns]
        if sql.startswith("PRAGMA table_info('product_auth_email_outbox')"):
            return [{"name": name} for name in self.auth_email_columns]
        if sql.startswith("PRAGMA table_info('dunning_notification_attempts')"):
            return [{"name": name} for name in self.dunning_attempt_columns]
        if sql.startswith("PRAGMA table_info('notification_delivery_attempts')"):
            return [{"name": name} for name in self.notification_delivery_columns]
        if sql.startswith("PRAGMA table_info('kb_document_deletion_operations')"):
            return [{"name": name} for name in self.knowledge_deletion_columns]
        if sql.startswith("PRAGMA table_info('gdpr_requests')"):
            return [{"name": name} for name in self.gdpr_request_columns]
        if sql.startswith("PRAGMA table_info('assistant_telnyx_extension_calls')"):
            return [{"name": name} for name in self.extension_call_columns]
        return []

    def execute_file(self, sql):
        if self.fail_on_migration and self.fail_on_migration in sql and not self.failed:
            self.failed = True
            raise release.ReleaseError("simulated D1 interruption")
        self.applied_sql.append(sql)
        for table in (release.MIGRATION_TABLE, release.LOCK_TABLE, release.META_TABLE):
            if f"CREATE TABLE IF NOT EXISTS {table}" in sql:
                self.tables.add(table)
        for key, value in re.findall(
            r"INSERT INTO naelao_release_migration_meta\(key,value\) VALUES\('([^']+)','((?:''|[^'])*)'\)", sql
        ):
            self.meta[key] = value.replace("''", "'")
        migration_match = re.search(
            r"INSERT INTO naelao_release_migrations\(filename,sha256,status,reason,execution_id\) VALUES\('([^']+)',\s*'([a-f0-9]{64})',\s*'(applied|skipped)',\s*'((?:''|[^'])*)',\s*'((?:''|[^'])*)'\)",
            sql,
        )
        if migration_match:
            name, digest, status, reason, execution_id = migration_match.groups()
            self.ledger[name] = {
                "filename": name,
                "sha256": digest,
                "status": status,
                "reason": reason.replace("''", "'"),
                "execution_id": execution_id.replace("''", "'"),
            }
        lock_match = re.search(r"VALUES\('schema','((?:''|[^'])*)'\)", sql)
        if lock_match and "INSERT INTO naelao_release_migration_lock" in sql and not self.lock:
            self.lock = {"owner": lock_match.group(1).replace("''", "'"), "last_migration": None}
        owner_match = re.search(r"owner='((?:''|[^'])*)'", sql)
        if self.lock and owner_match and owner_match.group(1).replace("''", "'") == self.lock["owner"]:
            last_migration = re.search(r"last_migration='([^']*)'", sql)
            if last_migration:
                self.lock["last_migration"] = last_migration.group(1)
        if self.lock and "DELETE FROM naelao_release_migration_lock" in sql:
            self.lock = None


class ReleaseMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = load_manifest()
        cls.entries = cls.manifest["migrations"]

    def baseline(self, entries, environment="staging", database_id="db-1", fingerprint=None):
        return {
            "formatVersion": 1,
            "environment": environment,
            "databaseId": database_id,
            "manifestSha256": hashlib.sha256(MANIFEST_PATH.read_bytes()).hexdigest(),
            "verifiedAt": "2026-11-12T12:00:00Z",
            "verifiedBy": "release-operator",
            "evidenceRef": "change-record-123",
            "schemaFingerprint": fingerprint or release.schema_fingerprint([]),
            "attestedSchemaVersion": Path(entries[-1]["filename"]).stem if entries else None,
            "nativeMigrationNames": [],
            "migrations": entries,
        }

    def test_requires_exact_environment_and_database_for_baseline(self):
        baseline = self.baseline([])
        with self.assertRaisesRegex(release.ReleaseError, "environment or D1 database ID"):
            release.validate_baseline_document(
                baseline,
                environment="production",
                database_id="db-1",
                manifest=self.manifest,
            )

    def test_rejects_baseline_checksum_drift(self):
        first = dict(self.entries[0], sha256="0" * 64, status="applied")
        with self.assertRaisesRegex(release.ReleaseError, "different checksum"):
            release.validate_baseline_document(
                self.baseline([first]),
                environment="staging",
                database_id="db-1",
                manifest=self.manifest,
            )

    def test_baseline_requires_an_ordered_contiguous_prefix(self):
        second = dict(self.entries[1], status="applied")
        with self.assertRaisesRegex(release.ReleaseError, "account for every migration"):
            release.validate_baseline_document(
                self.baseline([second]),
                environment="staging",
                database_id="db-1",
                manifest=self.manifest,
            )

    def test_only_the_reviewed_legacy_agentport_skip_is_allowed(self):
        through_0164 = next(i for i, item in enumerate(self.entries) if item["filename"].startswith("0164_"))
        baseline_entries = [dict(item, status="applied") for item in self.entries[: through_0164 + 1]]
        baseline_entries[-1]["status"] = "skipped"
        baseline_entries[-1]["reason"] = "legacy table agentport_messages was absent"
        release.validate_baseline_document(
            self.baseline(baseline_entries),
            environment="staging",
            database_id="db-1",
            manifest=self.manifest,
        )
        baseline_entries[-1]["reason"] = "we skipped it"
        with self.assertRaisesRegex(release.ReleaseError, "unapproved migration skip"):
            release.validate_baseline_document(
                self.baseline(baseline_entries),
                environment="staging",
                database_id="db-1",
                manifest=self.manifest,
            )

    def test_database_ledger_rejects_modified_historical_sql(self):
        first = self.entries[0]
        row = {**first, "status": "applied", "reason": ""}
        altered = dict(self.manifest)
        altered["migrations"] = [dict(first, sha256="f" * 64), *self.entries[1:]]
        with self.assertRaisesRegex(release.ReleaseError, "checksum drift"):
            release.validate_ledger([row], altered)

    def test_required_schema_probe_checks_provider_receipt_storage(self):
        required = self.entries[-1]["filename"]
        ledger = {required: {**self.entries[-1], "status": "applied"}}
        d1 = MemoryD1()
        d1.auth_email_columns = ("operation_id", "status")
        with self.assertRaisesRegex(release.ReleaseError, "product_auth_email_outbox"):
            release._required_schema_check(d1, {**self.manifest, "requiredSchemaVersion": Path(required).stem}, ledger)

    def test_required_schema_probe_checks_dunning_provider_outcome_storage(self):
        required = self.entries[-1]["filename"]
        ledger = {required: {**self.entries[-1], "status": "applied"}}
        incomplete = MemoryD1()
        incomplete.dunning_attempt_columns = ("tenant_id", "notification_id", "provider_outcome")
        with self.assertRaisesRegex(release.ReleaseError, "dunning_notification_attempts"):
            release._required_schema_check(incomplete, {**self.manifest, "requiredSchemaVersion": Path(required).stem}, ledger)

    def test_required_schema_probe_checks_general_notification_delivery_outcomes(self):
        required = self.entries[-1]["filename"]
        ledger = {required: {**self.entries[-1], "status": "applied"}}
        incomplete = MemoryD1()
        incomplete.notification_delivery_columns = ("tenant_id", "notification_id", "outcome")
        with self.assertRaisesRegex(release.ReleaseError, "notification_delivery_attempts"):
            release._required_schema_check(incomplete, {**self.manifest, "requiredSchemaVersion": Path(required).stem}, ledger)

    def test_required_schema_probe_checks_durable_queue_health_history(self):
        required = self.entries[-1]["filename"]
        ledger = {required: {**self.entries[-1], "status": "applied"}}
        d1 = MemoryD1()
        release._required_schema_check(d1, {**self.manifest, "requiredSchemaVersion": Path(required).stem}, ledger)
        self.assertIn("current_schema_version", d1.meta)

        incomplete = MemoryD1()
        incomplete.queue_health_columns = ("triggered_at", "status")
        with self.assertRaisesRegex(release.ReleaseError, "queue_health_checks"):
            release._required_schema_check(incomplete, {**self.manifest, "requiredSchemaVersion": Path(required).stem}, ledger)

    def test_required_schema_probe_checks_durable_cache_erasure_state(self):
        required = self.entries[-1]["filename"]
        ledger = {required: {**self.entries[-1], "status": "applied"}}
        incomplete = MemoryD1()
        incomplete.knowledge_deletion_columns = ("operation_kind", "cache_cleanup_status")
        with self.assertRaisesRegex(release.ReleaseError, "kb_document_deletion_operations"):
            release._required_schema_check(incomplete, {**self.manifest, "requiredSchemaVersion": Path(required).stem}, ledger)

        incomplete = MemoryD1()
        incomplete.gdpr_request_columns = ("id", "status")
        with self.assertRaisesRegex(release.ReleaseError, "gdpr_requests"):
            release._required_schema_check(incomplete, {**self.manifest, "requiredSchemaVersion": Path(required).stem}, ledger)

    def test_required_schema_probe_checks_phone_extension_installation_attribution(self):
        required = self.entries[-1]["filename"]
        ledger = {required: {**self.entries[-1], "status": "applied"}}
        incomplete = MemoryD1()
        incomplete.extension_call_columns = ("id", "binding_id")
        with self.assertRaisesRegex(release.ReleaseError, "assistant_telnyx_extension_calls"):
            release._required_schema_check(incomplete, {**self.manifest, "requiredSchemaVersion": Path(required).stem}, ledger)

    def test_interrupted_run_resumes_from_next_atomic_migration(self):
        small = {
            **self.manifest,
            "migrations": self.entries[:2],
            "requiredSchemaVersion": Path(self.entries[1]["filename"]).stem,
        }
        d1 = MemoryD1(fail_on_migration="CREATE TABLE IF NOT EXISTS orgs")
        baseline = self.baseline([], fingerprint=release.schema_fingerprint([]))
        with self.assertRaisesRegex(release.ReleaseError, "simulated D1 interruption"):
            release.run_migrations(
                d1,
                environment="staging",
                database_id="db-1",
                execution_id="run-77",
                manifest=small,
                baseline=baseline,
                schema_probe=False,
            )
        self.assertIn(self.entries[0]["filename"], d1.ledger)
        self.assertNotIn(self.entries[1]["filename"], d1.ledger)
        self.assertEqual(d1.lock["owner"], "run-77")

        version = release.run_migrations(
            d1,
            environment="staging",
            database_id="db-1",
            execution_id="run-77",
            manifest=small,
            baseline=baseline,
            schema_probe=False,
        )
        self.assertEqual(version, Path(self.entries[1]["filename"]).stem)
        self.assertEqual(len(d1.ledger), 2)
        self.assertIsNone(d1.lock)

    def test_lock_held_by_another_run_blocks_mutation(self):
        d1 = MemoryD1()
        d1.tables.update({release.MIGRATION_TABLE, release.LOCK_TABLE, release.META_TABLE})
        d1.meta = {"environment": "staging", "database_id": "db-1"}
        d1.lock = {"owner": "older-run", "last_migration": "0001_users.sql"}
        with self.assertRaisesRegex(release.ReleaseError, "owned by older-run"):
            release.acquire_lock(d1, "new-run")


if __name__ == "__main__":
    unittest.main()
