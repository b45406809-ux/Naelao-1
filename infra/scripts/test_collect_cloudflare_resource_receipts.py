from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from collect_cloudflare_resource_receipts import (
    CloudflareReadOnlyApi,
    ReceiptCollectionError,
    _load_current_source_map,
    _write_output,
    collect_receipts,
)
from validate_environment_resources import build_source_map


class FakeApi(CloudflareReadOnlyApi):
    def __init__(self) -> None:
        super().__init__("a" * 32, "test-token", base_url="https://api.example.test")
        self.calls: list[tuple[str, dict[str, str | int] | None]] = []

    def get(self, path: str, params: dict[str, str | int] | None = None) -> tuple[dict[str, Any], str]:
        self.calls.append((path, params))
        if path.endswith("/d1/database/d1-id"):
            result: Any = {"uuid": "d1-id"}
        elif path.endswith("/storage/kv/namespaces/kv-id"):
            result = {"id": "kv-id"}
        elif path.endswith("/vectorize/v2/indexes/vector-index"):
            result = {"name": "vector-index"}
        elif path.endswith("/workflows/workflow-name"):
            result = {"id": "workflow-id", "name": "workflow-name"}
        elif path.endswith("/queues"):
            result = [{"queue_name": "queue-name", "queue_id": "queue-id"}]
            return {"success": True, "result": result, "result_info": {"total_pages": 1}}, f"{self.base_url}{path}?page=1&per_page=100"
        elif path.endswith("/workers/durable_objects/namespaces"):
            result = [{"id": "do-namespace-id", "class": "ExampleDO", "script": "test-staging"}]
            return {"success": True, "result": result, "result_info": {"total_pages": 1}}, f"{self.base_url}{path}?page=1&per_page=100"
        else:
            raise AssertionError(f"unexpected API path: {path}")
        return {"success": True, "result": result}, f"{self.base_url}{path}"

    def r2_buckets(self, name: str) -> tuple[list[dict[str, Any]], list[str]]:
        self.calls.append(("/r2/buckets", {"name_contains": name, "per_page": 1000}))
        return ([{"name": name}], [f"{self.base_url}/accounts/{self.account_id}/r2/buckets?name_contains={name}&per_page=1000"])


class CloudflareReceiptCollectorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        worker_dir = self.root / "workers" / "test"
        worker_dir.mkdir(parents=True)
        (worker_dir / "wrangler.toml").write_text('''name = "test"
[env.staging]
name = "test-staging"
[[env.staging.durable_objects.bindings]]
name = "EXAMPLE_DO"
class_name = "ExampleDO"
''', encoding="utf-8")
        self.workers_dir = self.root / "workers"
        self.source_map = {"required_existence_receipts": [
            {"kind": "d1", "environment": "staging", "id_or_name": "d1-id"},
            {"kind": "kv", "environment": "staging", "id_or_name": "kv-id"},
            {"kind": "r2", "environment": "staging", "id_or_name": "bucket-name"},
            {"kind": "vectorize", "environment": "staging", "id_or_name": "vector-index"},
            {"kind": "queue", "environment": "staging", "id_or_name": "queue-name"},
            {"kind": "workflow", "environment": "staging", "id_or_name": "workflow-name"},
            {"kind": "durable_object", "environment": "staging", "id_or_name": "ExampleDO"},
        ]}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_collects_exact_source_mapped_resources_with_get_only_evidence(self) -> None:
        api = FakeApi()
        receipts = collect_receipts(api, self.source_map, "release operator", self.workers_dir)
        self.assertEqual(len(receipts["resources"]), 7)
        by_kind = {row["kind"]: row for row in receipts["resources"]}
        self.assertEqual(by_kind["d1"]["resource_id"], "d1-id")
        self.assertEqual(by_kind["kv"]["resource_id"], "kv-id")
        self.assertEqual(by_kind["queue"]["resource_id"], "queue-id")
        self.assertEqual(by_kind["workflow"]["resource_id"], "workflow-id")
        self.assertEqual(by_kind["durable_object"]["resource_id"], "do-namespace-id")
        self.assertTrue(all(row["read_only"] is True and row["observer"] == "release operator" for row in receipts["resources"]))
        self.assertEqual([params for _, params in api.calls if params and "page" in params][0], {"page": 1, "per_page": 100})

    def test_rejects_a_provider_resource_that_does_not_match_configured_identity(self) -> None:
        api = FakeApi()
        api.get = lambda path, params=None: ({"success": True, "result": {"uuid": "other-id"}}, f"{api.base_url}{path}")
        with self.assertRaisesRegex(ReceiptCollectionError, "identity_mismatch:d1"):
            collect_receipts(api, {"required_existence_receipts": [self.source_map["required_existence_receipts"][0]]},
                             "release operator", self.workers_dir)

    def test_output_requires_explicit_overwrite_and_preserves_valid_json(self) -> None:
        path = self.root / "receipts.json"
        original = {"version": 1, "resources": []}
        path.write_text(json.dumps(original), encoding="utf-8")
        with self.assertRaisesRegex(ReceiptCollectionError, "output_exists"):
            _write_output(path, {"version": 1, "resources": [1]}, False)
        _write_output(path, {"version": 1, "resources": [1]}, True)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"version": 1, "resources": [1]})

    def test_custom_resource_map_must_match_current_worker_source(self) -> None:
        source_map = build_source_map(self.workers_dir)
        path = self.root / "custom-resource-map.json"
        path.write_text(json.dumps(source_map), encoding="utf-8")
        self.assertEqual(_load_current_source_map(path, self.workers_dir), source_map)

        stale_source_map = {**source_map, "deployment_surfaces": []}
        path.write_text(json.dumps(stale_source_map), encoding="utf-8")
        with self.assertRaisesRegex(ReceiptCollectionError, "resource_map_stale"):
            _load_current_source_map(path, self.workers_dir)


if __name__ == "__main__":
    unittest.main()
