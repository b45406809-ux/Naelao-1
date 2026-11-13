import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "infra/migrations/0233_dunning_notification_attempt_receipts.sql"


class DunningNotificationMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def test_creates_bounded_non_pii_provider_attempt_ledger(self):
        columns = {row[1] for row in self.db.execute("PRAGMA table_info('dunning_notification_attempts')")}
        self.assertEqual(columns, {
            "tenant_id", "notification_id", "subscription_scope", "provider", "provider_outcome",
            "attempt_count", "last_http_status", "provider_receipt_id", "first_attempt_at",
            "last_attempt_at", "accepted_at", "updated_at",
        })
        indexes = {row[1] for row in self.db.execute("PRAGMA index_list('dunning_notification_attempts')")}
        self.assertIn("idx_dunning_notification_attempts_tenant_recent", indexes)

    def test_constraints_reject_invalid_scope_outcome_and_receipt_shape(self):
        base = (
            "tenant-a", f"dunning-{'a' * 64}", "platform_subscription", "resend", "provider_accepted", 1,
            200, "receipt_123", "2026-11-13T00:00:00Z", "2026-11-13T00:00:00Z",
            "2026-11-13T00:00:00Z", "2026-11-13T00:00:00Z",
        )
        self.db.execute("""INSERT INTO dunning_notification_attempts (
            tenant_id,notification_id,subscription_scope,provider,provider_outcome,attempt_count,
            last_http_status,provider_receipt_id,first_attempt_at,last_attempt_at,accepted_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", base)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE dunning_notification_attempts SET subscription_scope='other'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE dunning_notification_attempts SET provider_outcome='delivered'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE dunning_notification_attempts SET attempt_count=0")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE dunning_notification_attempts SET provider_receipt_id=?", ("r" * 129,))

    def test_same_id_is_scoped_by_tenant(self):
        self.db.execute("""INSERT INTO dunning_notification_attempts (
            tenant_id,notification_id,subscription_scope,provider,provider_outcome,attempt_count,
            first_attempt_at,last_attempt_at,updated_at
        ) VALUES (?,?,'platform_subscription','resend','attempt_ambiguous',1,?,?,?)""",
            ("tenant-a", f"dunning-{'b' * 64}", "now", "now", "now"))
        self.db.execute("""INSERT INTO dunning_notification_attempts (
            tenant_id,notification_id,subscription_scope,provider,provider_outcome,attempt_count,
            first_attempt_at,last_attempt_at,updated_at
        ) VALUES (?,?,'platform_subscription','resend','attempt_ambiguous',1,?,?,?)""",
            ("tenant-b", f"dunning-{'b' * 64}", "now", "now", "now"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM dunning_notification_attempts").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
