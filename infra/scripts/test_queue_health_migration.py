import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "migrations" / "0230_queue_health_observations.sql"
PLATFORM_FAILURES = ROOT / "migrations" / "0031_platform_failures.sql"


class QueueHealthMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(PLATFORM_FAILURES.read_text(encoding="utf-8"))
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def test_persists_unknown_and_incomplete_statuses_with_required_evidence(self):
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(queue_health_checks)")}
        self.assertEqual(columns, {
            "triggered_at", "observed_at", "source", "status", "unavailable_reason",
            "metrics_json", "alert_count", "alerts_json",
        })
        self.db.execute(
            "INSERT INTO queue_health_checks VALUES(?,?,?,?,?,?,?,?)",
            ("t1", "t1", "unavailable", "unknown", "credentials_missing", "[]", 1, "[]"),
        )
        self.assertEqual(self.db.execute("SELECT status,unavailable_reason FROM queue_health_checks").fetchone(),
                         ("unknown", "credentials_missing"))

    def test_rejects_unrecognized_source_and_false_healthy_claim(self):
        for source, status in (("invented", "unknown"), ("unavailable", "healthy")):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(
                    "INSERT INTO queue_health_checks VALUES(?,?,?,?,?,?,?,?)",
                    (f"{source}-{status}", "t1", source, status, None, "[]", 0, "[]"),
                )

    def test_operator_incidents_reuse_the_existing_review_inbox(self):
        self.db.execute(
            "INSERT INTO platform_failures (id,message_type,payload_json,failure_reason,failed_at,retry_count,reviewed) "
            "VALUES(?,?,?,?,?,0,0)",
            ("queue-health:one", "queue_health.unknown", "{}", "credentials_missing", "t1"),
        )
        self.assertEqual(self.db.execute("SELECT reviewed FROM platform_failures WHERE id='queue-health:one'").fetchone(), (0,))


if __name__ == "__main__":
    unittest.main()
