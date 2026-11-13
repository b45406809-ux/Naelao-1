import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "infra/migrations/0234_notification_delivery_outcomes.sql"


class NotificationDeliveryMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def test_creates_non_pii_delivery_attempt_ledger_and_index(self):
        columns = {row[1] for row in self.db.execute("PRAGMA table_info('notification_delivery_attempts')")}
        self.assertEqual(columns, {
            "tenant_id", "notification_id", "channel", "provider", "outcome", "attempt_count",
            "queue_attempts", "last_http_status", "provider_receipt_id", "failure_code",
            "first_attempt_at", "last_attempt_at", "accepted_at", "updated_at",
        })
        indexes = {row[1] for row in self.db.execute("PRAGMA index_list('notification_delivery_attempts')")}
        self.assertIn("idx_notification_delivery_tenant_recent", indexes)

    def test_constraints_bound_channels_outcomes_counts_and_receipt(self):
        base = (
            "tenant-a", "email:queue-1", "email", "resend", "provider_accepted", 1, 1,
            200, "receipt_123", None, "now", "now", "now", "now",
        )
        self.db.execute("""INSERT INTO notification_delivery_attempts (
            tenant_id,notification_id,channel,provider,outcome,attempt_count,queue_attempts,last_http_status,
            provider_receipt_id,failure_code,first_attempt_at,last_attempt_at,accepted_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", base)
        self.db.execute("UPDATE notification_delivery_attempts SET outcome='persisted'")
        self.db.execute("UPDATE notification_delivery_attempts SET outcome='provider_accepted'")
        for statement, args in [
            ("UPDATE notification_delivery_attempts SET channel='voice'", ()),
            ("UPDATE notification_delivery_attempts SET outcome='delivered'", ()),
            ("UPDATE notification_delivery_attempts SET attempt_count=0", ()),
            ("UPDATE notification_delivery_attempts SET queue_attempts=0", ()),
            ("UPDATE notification_delivery_attempts SET provider_receipt_id=?", ("r" * 129,)),
        ]:
            with self.subTest(statement=statement), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(statement, args)

    def test_same_notification_is_isolated_by_tenant_and_channel(self):
        rows = [
            ("tenant-a", "event-1", "email", "resend", "attempt_ambiguous", 1, 1, "now", "now", "now"),
            ("tenant-b", "event-1", "email", "resend", "attempt_ambiguous", 1, 1, "now", "now", "now"),
            ("tenant-a", "event-1", "webhook", "webhook", "attempt_ambiguous", 1, 1, "now", "now", "now"),
        ]
        self.db.executemany("""INSERT INTO notification_delivery_attempts (
            tenant_id,notification_id,channel,provider,outcome,attempt_count,queue_attempts,
            first_attempt_at,last_attempt_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)""", rows)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM notification_delivery_attempts").fetchone()[0], 3)


if __name__ == "__main__":
    unittest.main()
