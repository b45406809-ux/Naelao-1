import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "infra/migrations/0219_managed_service_cost_budget_alert_delivery.sql"
MIGRATION = ROOT / "infra/migrations/0236_cost_alert_ambiguous_delivery_status.sql"


class CostAlertAmbiguousDeliveryMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("CREATE TABLE managed_service_cost_budget_alerts (id TEXT PRIMARY KEY)")
        self.db.executescript(BASE.read_text(encoding="utf-8"))
        self.db.execute("INSERT INTO managed_service_cost_budget_alerts(id) VALUES ('alert-1')")
        self.db.execute("""INSERT INTO managed_service_cost_budget_alert_deliveries (
            id,alert_id,tenant_id,space_id,user_id,status,attempts,next_at,created_at,updated_at
        ) VALUES ('delivery-1','alert-1','tenant-1','space-1','user-1','pending',2,'now','now','now')""")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_preserves_existing_delivery_and_accepts_ambiguous_terminal_state(self):
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))
        row = self.db.execute("SELECT id,alert_id,status,attempts FROM managed_service_cost_budget_alert_deliveries").fetchone()
        self.assertEqual(row, ("delivery-1", "alert-1", "pending", 2))
        self.db.execute("UPDATE managed_service_cost_budget_alert_deliveries SET status='ambiguous' WHERE id='delivery-1'")
        self.assertEqual(self.db.execute("SELECT status FROM managed_service_cost_budget_alert_deliveries").fetchone(), ("ambiguous",))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE managed_service_cost_budget_alert_deliveries SET status='unknown' WHERE id='delivery-1'")


if __name__ == "__main__":
    unittest.main()
