import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from validate_environment_resources import (
    _validate_receipts,
    build_source_map,
    validate,
)


class EnvironmentResourceMapTests(unittest.TestCase):
    def test_current_source_inventory_is_explicit_and_unverified(self):
        source_map = build_source_map()
        self.assertEqual(len(source_map["source_files"]), 28)
        self.assertEqual(source_map["status"], "source_inventory_only")
        self.assertEqual(source_map["unresolved_service_targets"], ["naelao-calls"])
        self.assertGreater(len(source_map["required_existence_receipts"]), 0)
        self.assertTrue(all(row["status"] == "unverified" for row in source_map["required_existence_receipts"]))

    def test_current_worktree_fails_closed_for_shared_ids_unresolved_service_and_missing_receipts(self):
        errors = validate()
        self.assertTrue(any("d1 PLATFORM_DB shares" in error for error in errors))
        self.assertTrue(any("kv " in error and "shares" in error for error in errors))
        self.assertTrue(any("naelao-calls" in error for error in errors))
        self.assertTrue(any("missing read-only staging existence receipt" in error for error in errors))

    def test_accepts_fresh_complete_read_only_receipts(self):
        source_map = {
            "required_existence_receipts": [
                {"kind": "queue", "environment": "staging", "id_or_name": "events-staging"},
                {"kind": "r2", "environment": "staging", "id_or_name": "artifacts-staging"},
            ]
        }
        receipts = {
            "version": 1,
            "account_id": "account-1",
            "observed_at": "2026-11-12T12:00:00Z",
            "resources": [
                {
                    "kind": "queue",
                    "environment": "staging",
                    "id_or_name": "events-staging",
                    "resource_id": "queue-1",
                    "environment": "staging",
                    "read_only": True,
                    "evidence_source": "Cloudflare read-only inventory command",
                    "observer": "operator",
                },
                {
                    "kind": "r2",
                    "environment": "staging",
                    "id_or_name": "artifacts-staging",
                    "resource_id": "bucket-1",
                    "environment": "staging",
                    "read_only": True,
                    "evidence_source": "Cloudflare read-only inventory command",
                    "observer": "operator",
                },
            ],
        }
        errors = _validate_receipts(
            source_map,
            receipts,
            datetime(2026, 11, 13, 12, tzinfo=timezone.utc),
        )
        self.assertEqual(errors, [])

    def test_rejects_stale_or_write_capable_receipts(self):
        source_map = {"required_existence_receipts": [{"kind": "workflow", "environment": "staging", "id_or_name": "sync-staging"}]}
        receipts = {
            "version": 1,
            "account_id": "account-1",
            "observed_at": "2026-11-01T12:00:00Z",
            "resources": [
                {
                    "kind": "workflow",
                    "environment": "staging",
                    "id_or_name": "sync-staging",
                    "resource_id": "workflow-1",
                    "environment": "staging",
                    "read_only": False,
                    "evidence_source": "inventory",
                    "observer": "operator",
                }
            ],
        }
        errors = _validate_receipts(source_map, receipts, datetime(2026, 11, 13, 12, tzinfo=timezone.utc))
        self.assertTrue(any("no more than seven days" in error for error in errors))
        self.assertTrue(any("read-only inventory" in error for error in errors))

    def test_database_and_kv_receipts_must_confirm_each_exact_environment_id(self):
        source_map = {
            "required_existence_receipts": [
                {"kind": "d1", "environment": "staging", "id_or_name": "stage-db"},
                {"kind": "d1", "environment": "production", "id_or_name": "prod-db"},
                {"kind": "kv", "environment": "staging", "id_or_name": "stage-kv"},
                {"kind": "kv", "environment": "production", "id_or_name": "prod-kv"},
            ]
        }
        receipts = {
            "version": 1,
            "account_id": "account-1",
            "observed_at": "2026-11-12T12:00:00Z",
            "resources": [
                {
                    "kind": kind,
                    "environment": environment,
                    "id_or_name": resource,
                    "resource_id": resource if environment == "staging" else "wrong-id",
                    "read_only": True,
                    "evidence_source": "read-only inventory",
                    "observer": "operator",
                }
                for kind, environment, resource in (
                    ("d1", "staging", "stage-db"),
                    ("d1", "production", "prod-db"),
                    ("kv", "staging", "stage-kv"),
                    ("kv", "production", "prod-kv"),
                )
            ],
        }
        errors = _validate_receipts(
            source_map,
            receipts,
            datetime(2026, 11, 13, 12, tzinfo=timezone.utc),
        )
        self.assertEqual(sum("exact configured resource ID" in error for error in errors), 2)

    def test_rejects_map_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workers = root / "workers"
            worker = workers / "example"
            worker.mkdir(parents=True)
            (worker / "wrangler.toml").write_text(
                'name="example"\n[env.staging]\n[[env.staging.d1_databases]]\nbinding="DB"\ndatabase_id="stage"\n'
                '[env.production]\n[[env.production.d1_databases]]\nbinding="DB"\ndatabase_id="prod"\n',
                encoding="utf-8",
            )
            source_map = build_source_map(workers)
            map_path = root / "map.json"
            map_path.write_text(json.dumps({"version": 1}), encoding="utf-8")
            receipts_path = root / "receipts.json"
            receipts_path.write_text(json.dumps({"version": 1, "resources": [], "account_id": "a", "observed_at": "2026-11-12T12:00:00Z"}), encoding="utf-8")
            errors = validate(workers, map_path, receipts_path)
        self.assertIn("resource map is stale; regenerate it from the current Worker Wrangler TOMLs", errors)


if __name__ == "__main__":
    unittest.main()
