import tempfile
import unittest
from pathlib import Path

from validate_wrangler_env_isolation import find_shared_mutable_bindings, validate


class WranglerEnvironmentIsolationTests(unittest.TestCase):
    def test_detects_shared_database_service_queue_and_bucket(self):
        config = {
            "env": {
                "staging": {
                    "d1_databases": [{"binding": "DB", "database_id": "db-shared"}],
                    "services": [{"binding": "AGENTS", "service": "agents"}],
                    "queues": {"producers": [{"binding": "EVENTS", "queue": "events"}]},
                    "r2_buckets": [{"binding": "FILES", "bucket_name": "files"}],
                },
                "production": {
                    "d1_databases": [{"binding": "DB", "database_id": "db-shared"}],
                    "services": [{"binding": "AGENTS", "service": "agents"}],
                    "queues": {"consumers": [{"queue": "events"}]},
                    "r2_buckets": [{"binding": "FILES", "bucket_name": "files"}],
                },
            }
        }
        errors = find_shared_mutable_bindings(config, "workers/example/wrangler.toml")
        self.assertEqual(len(errors), 4)
        self.assertTrue(any("d1 resource db-shared" in error for error in errors))
        self.assertTrue(any("service resource agents" in error for error in errors))
        self.assertTrue(any("queue resource events" in error for error in errors))
        self.assertTrue(any("r2 resource files" in error for error in errors))

    def test_accepts_separate_environments(self):
        config = {
            "env": {
                "staging": {"d1_databases": [{"binding": "DB", "database_id": "stage-db"}]},
                "production": {"d1_databases": [{"binding": "DB", "database_id": "prod-db"}]},
            }
        }
        self.assertEqual(find_shared_mutable_bindings(config, "workers/example/wrangler.toml"), [])

    def test_current_configs_report_known_shared_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            workers = Path(temporary)
            (workers / "eval").mkdir()
            (workers / "eval" / "wrangler.toml").write_text(
                "[env.staging]\n[[env.staging.d1_databases]]\nbinding='DB'\ndatabase_id='same'\n"
                "[[env.staging.services]]\nbinding='AGENTS'\nservice='agents'\n"
                "[env.production]\n[[env.production.d1_databases]]\nbinding='DB'\ndatabase_id='same'\n"
                "[[env.production.services]]\nbinding='AGENTS'\nservice='agents'\n",
                encoding="utf-8",
            )
            errors = validate(workers)
        self.assertEqual(len(errors), 2)


if __name__ == "__main__":
    unittest.main()
