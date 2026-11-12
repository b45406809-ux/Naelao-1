import tempfile
import tomllib
import unittest
from pathlib import Path

from validate_wrangler_env_isolation import ROOT, find_shared_mutable_bindings, validate


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

    def test_current_worker_to_worker_targets_are_environment_scoped(self):
        errors = []
        for path in sorted((ROOT / "workers").glob("*/wrangler.toml")):
            config = tomllib.loads(path.read_text(encoding="utf-8"))
            errors.extend(find_shared_mutable_bindings(config, str(path.relative_to(ROOT))))
        unscoped = [
            error
            for error in errors
            if any(f"share mutable {kind} resource" in error for kind in ("service", "queue", "workflow", "durable_object_script"))
        ]
        self.assertEqual(len(unscoped), 1)
        self.assertIn("service resource naelao-calls", unscoped[0])

    def test_eval_targets_named_agents_worker_environments(self):
        config = tomllib.loads((ROOT / "workers/eval/wrangler.toml").read_text(encoding="utf-8"))
        staging = config["env"]["staging"]["services"]
        production = config["env"]["production"]["services"]
        self.assertEqual(staging[0]["service"], "naelao-agents-staging")
        self.assertEqual(production[0]["service"], "naelao-agents-production")

    def test_named_service_targets_resolve_or_are_explicitly_external(self):
        configs = {}
        for path in sorted((ROOT / "workers").glob("*/wrangler.toml")):
            config = tomllib.loads(path.read_text(encoding="utf-8"))
            name = config.get("name")
            if isinstance(name, str):
                configs[name] = config
        known_targets = set()
        for name, config in configs.items():
            for environment in ("staging", "production"):
                target = config.get("env", {}).get(environment)
                if isinstance(target, dict):
                    known_targets.add(target.get("name", f"{name}-{environment}"))
        unresolved = set()
        for config in configs.values():
            for environment in ("staging", "production"):
                for service in config.get("env", {}).get(environment, {}).get("services", []):
                    name = service.get("service")
                    if name not in known_targets:
                        unresolved.add(name)
        self.assertEqual(unresolved, {"naelao-calls"})


if __name__ == "__main__":
    unittest.main()
