import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from validate_environment_resources import (
    _resource_conflicts,
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
        required = {(row["kind"], row["environment"]) for row in source_map["required_existence_receipts"]}
        self.assertIn(("queue", "staging"), required)
        self.assertIn(("queue", "production"), required)
        self.assertIn(("durable_object", "staging"), required)
        self.assertIn(("durable_object", "production"), required)

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

    def test_all_mutable_environment_targets_must_be_separate(self):
        rows = []
        for kind in ("r2", "queue", "workflow", "vectorize", "durable_object_script", "service"):
            rows.append({
                "kind": kind,
                "binding": f"{kind.upper()}_BINDING",
                "environments": {
                    "staging": [{"id_or_name": "shared-target", "workers": ["staging-worker"]}],
                    "production": [{"id_or_name": "shared-target", "workers": ["production-worker"]}],
                },
            })
        # A Durable Object class is the same code symbol in each Worker environment; its
        # deployed namespace IDs are checked from receipts instead of comparing class names.
        rows.append({
            "kind": "durable_object",
            "binding": "CACHE_DO",
            "environments": {
                "staging": [{"id_or_name": "CacheDO", "workers": ["staging-worker"]}],
                "production": [{"id_or_name": "CacheDO", "workers": ["production-worker"]}],
            },
        })
        errors = _resource_conflicts({"bindings": rows})
        self.assertEqual(sum("shares staging/production resource target(s)" in error for error in errors), 6)
        self.assertFalse(any(error.startswith("durable_object CACHE_DO") for error in errors))

    def test_durable_object_namespace_receipts_reject_cross_environment_id_reuse(self):
        source_map = {
            "required_existence_receipts": [
                {"kind": "durable_object", "environment": environment, "id_or_name": "CacheDO"}
                for environment in ("staging", "production")
            ]
        }
        receipts = {
            "version": 1,
            "account_id": "account-1",
            "observed_at": "2026-11-12T12:00:00Z",
            "resources": [
                {
                    "kind": "durable_object",
                    "environment": environment,
                    "id_or_name": "CacheDO",
                    "resource_id": "same-namespace-id",
                    "evidence_source": "read-only namespace inventory",
                    "observer": "operator",
                    "read_only": True,
                }
                for environment in ("staging", "production")
            ],
        }
        errors = _validate_receipts(
            source_map,
            receipts,
            datetime(2026, 11, 13, 12, tzinfo=timezone.utc),
        )
        self.assertTrue(any("durable_object observed resource ID is shared" in error for error in errors))

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

    def test_deployment_surface_inventory_records_routes_and_redacts_variable_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = root / "workers" / "example"
            worker.mkdir(parents=True)
            (worker / "wrangler.toml").write_text(
                '''name = "example"
[env.staging]
name = "example-staging"
vars = { ENVIRONMENT = "staging", CALLBACK_URL = "https://hooks.staging.example.test/callback?token=do-not-store", CORS_ALLOWLIST = "https://app.staging.example.test,https://admin.staging.example.test", SECRET_TOKEN = "never-store-this" }
[[env.staging.routes]]
pattern = "api.staging.example.test/*"
zone_name = "example.test"
[env.production]
name = "example-production"
vars = { ENVIRONMENT = "production", CALLBACK_URL = "https://hooks.example.test/callback", SECRET_TOKEN = "also-never-store" }
[[env.production.routes]]
pattern = "api.example.test/*"
zone_name = "example.test"
''',
                encoding="utf-8",
            )
            source_map = build_source_map(root / "workers")

        surfaces = source_map["deployment_surfaces"]
        self.assertEqual(len(surfaces), 2)
        staging = next(row for row in surfaces if row["environment"] == "staging")
        self.assertEqual(staging["routes"], [{"pattern": "api.staging.example.test/*", "zone_name": "example.test"}])
        endpoints = {row["name"]: row["hostnames"] for row in staging["endpoint_variables"]}
        self.assertEqual(endpoints["CALLBACK_URL"], ["hooks.staging.example.test"])
        self.assertEqual(endpoints["CORS_ALLOWLIST"], ["admin.staging.example.test", "app.staging.example.test"])
        self.assertIn("SECRET_TOKEN", staging["variable_names"])
        self.assertFalse(staging["external_secret_values_included"])
        serialized = json.dumps(source_map)
        self.assertNotIn("never-store-this", serialized)
        self.assertNotIn("do-not-store", serialized)


if __name__ == "__main__":
    unittest.main()
