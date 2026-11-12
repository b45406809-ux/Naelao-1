import sqlite3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations"


class SemanticCacheCleanupMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript((MIGRATIONS / "0228_kb_document_deletion_tombstones.sql").read_text(encoding="utf-8"))
        self.db.executescript("""
            CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
            INSERT INTO spaces VALUES('space-a','tenant-a');
            CREATE TABLE gdpr_requests (
              id TEXT PRIMARY KEY,
              tenant_id TEXT NOT NULL,
              request_type TEXT NOT NULL,
              status TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            INSERT INTO gdpr_requests VALUES('request-a','tenant-a','erasure','processing','t0');
        """)
        self.db.execute("""
            INSERT INTO kb_document_deletion_operations
              (document_id,tenant_id,space_id,chunk_count,state,next_attempt_at,
               cache_generation_rotated_at,created_at,updated_at)
            VALUES('doc-a','tenant-a','space-a',0,'complete','t0','t1','t0','t1')
        """)
        self.db.executescript((MIGRATIONS / "0232_semantic_cache_cleanup_operations.sql").read_text(encoding="utf-8"))

    def tearDown(self):
        self.db.close()

    def test_backfills_prior_generation_rotations_for_scoped_rescan(self):
        row = self.db.execute("""
            SELECT operation_kind,cache_generation_to_purge,cache_cleanup_status,state,lease_token,lease_until
            FROM kb_document_deletion_operations WHERE document_id='doc-a'
        """).fetchone()
        self.assertEqual(row, ("document", "*", "pending", "pending", None, None))
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(gdpr_requests)")}
        self.assertIn("cache_cleanup_status", columns)
        self.assertEqual(self.db.execute("SELECT cache_cleanup_status FROM gdpr_requests").fetchone(), ("pending",))
        in_flight = self.db.execute("""
            SELECT operation_kind,erasure_request_id,cache_generation_to_purge,cache_generation_next,cache_cleanup_status
            FROM kb_document_deletion_operations WHERE document_id='spacecache_backfill_request-a_space-a'
        """).fetchone()
        self.assertEqual(in_flight[:3], ("space_cache", "request-a", "*"))
        self.assertTrue(in_flight[3].startswith("cache-"))
        self.assertEqual(in_flight[4], "pending")

    def test_cleanup_receipts_are_validated_and_request_scoped(self):
        self.db.execute("""
            INSERT INTO kb_document_deletion_operations
              (document_id,tenant_id,space_id,chunk_count,state,next_attempt_at,created_at,updated_at,
               operation_kind,erasure_request_id,cache_generation_to_purge,cache_cleanup_status)
            VALUES('spacecache-b','tenant-a','space-b',0,'pending','t0','t0','t0',
                   'space_cache','request-a','*','pending')
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE kb_document_deletion_operations SET cache_cleanup_ids_json='not-json' WHERE document_id='spacecache-b'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE kb_document_deletion_operations SET operation_kind='other' WHERE document_id='spacecache-b'")


if __name__ == "__main__":
    unittest.main()
