import copy
import json
import unittest

from validate_deployment_manifest import (
    MANIFEST_PATH, ROOT, SCHEMA_MANIFEST_PATH, validate, validate_data,
    validate_health_probe_sources,
)


class DeploymentManifestTests(unittest.TestCase):
    def test_current_release_manifest_matches_both_workflows_and_all_worker_configs(self):
        self.assertEqual(validate(), [])

    def test_rejects_stale_schema_prerequisite(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA_MANIFEST_PATH.read_text(encoding="utf-8"))
        workflows = {
            "staging": (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8"),
            "production": (ROOT / ".github/workflows/deploy-prod.yml").read_text(encoding="utf-8"),
        }
        workers = {path.parent.name for path in (ROOT / "workers").glob("*/wrangler.toml")}
        changed = copy.deepcopy(manifest)
        changed["schema"]["requiredSchemaVersion"] = "0000_stale"
        errors = validate_data(changed, schema, workflows, workers)
        self.assertIn("deployment manifest required schema version is stale", errors)

    def test_requires_immutable_commit_versions_for_both_environments(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA_MANIFEST_PATH.read_text(encoding="utf-8"))
        workflows = {
            "staging": (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8"),
            "production": (ROOT / ".github/workflows/deploy-prod.yml").read_text(encoding="utf-8"),
        }
        workers = {path.parent.name for path in (ROOT / "workers").glob("*/wrangler.toml")}
        changed = copy.deepcopy(manifest)
        changed["versioning"]["production"] = "mutable tag only"
        errors = validate_data(changed, schema, workflows, workers)
        self.assertIn("production version source must identify its release tag and immutable commit SHA", errors)

    def test_rejects_production_worker_order_drift(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA_MANIFEST_PATH.read_text(encoding="utf-8"))
        workflows = {
            "staging": (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8"),
            "production": (ROOT / ".github/workflows/deploy-prod.yml").read_text(encoding="utf-8"),
        }
        workers = {path.parent.name for path in (ROOT / "workers").glob("*/wrangler.toml")}
        changed = copy.deepcopy(manifest)
        changed["environments"]["production"]["phases"][2]["components"].reverse()
        errors = validate_data(changed, schema, workflows, workers)
        self.assertIn("production manifest worker order differs from deploy-prod.yml", errors)

    def test_rejects_staging_frontend_that_can_publish_after_worker_failure(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA_MANIFEST_PATH.read_text(encoding="utf-8"))
        workflows = {
            "staging": (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8"),
            "production": (ROOT / ".github/workflows/deploy-prod.yml").read_text(encoding="utf-8"),
        }
        workers = {path.parent.name for path in (ROOT / "workers").glob("*/wrangler.toml")}
        workflows["staging"] = workflows["staging"].replace(
            "concurrency: deploy-staging-pages\n    needs: [deploy-workers-staging]",
            "concurrency: deploy-staging-pages\n    needs: [preflight]",
        )
        errors = validate_data(manifest, schema, workflows, workers)
        self.assertIn("staging phase dashboard workflow job does not depend on deploy-workers-staging", errors)

    def test_rejects_missing_post_worker_probe_step(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA_MANIFEST_PATH.read_text(encoding="utf-8"))
        workflows = {
            "staging": (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8"),
            "production": (ROOT / ".github/workflows/deploy-prod.yml").read_text(encoding="utf-8"),
        }
        workers = {path.parent.name for path in (ROOT / "workers").glob("*/wrangler.toml")}
        workflows["production"] = workflows["production"].replace(
            "python3 infra/scripts/probe_deployment_health.py --environment production",
            "echo worker deploy complete",
        )
        errors = validate_data(manifest, schema, workflows, workers)
        self.assertTrue(any("production deployment workflow must run the post-worker health probe" in error for error in errors))

    def test_requires_durable_migration_runner_tests_in_both_release_preflights(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA_MANIFEST_PATH.read_text(encoding="utf-8"))
        workflows = {
            "staging": (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8"),
            "production": (ROOT / ".github/workflows/deploy-prod.yml").read_text(encoding="utf-8"),
        }
        workers = {path.parent.name for path in (ROOT / "workers").glob("*/wrangler.toml")}
        for environment in ("staging", "production"):
            with self.subTest(environment=environment):
                changed_workflows = dict(workflows)
                changed_workflows[environment] = changed_workflows[environment].replace(
                    'python3 -m unittest discover -s infra/scripts -p "test_release_migrations.py"',
                    "echo skipped migration recovery tests",
                )
                errors = validate_data(manifest, schema, changed_workflows, workers)
                self.assertIn(f"{environment} preflight does not test the durable D1 release migration runner", errors)

        out_of_preflight = dict(workflows)
        out_of_preflight["production"] = out_of_preflight["production"].replace(
            '      - name: Test durable D1 release migration runner\n        run: python3 -m unittest discover -s infra/scripts -p "test_release_migrations.py"\n',
            "",
        )
        out_of_preflight["production"] = out_of_preflight["production"].replace(
            "  deploy-workers-prod:\n", '  migration-test-only-after-preflight:\n    name: misplaced test\n    steps:\n      - run: python3 -m unittest discover -s infra/scripts -p "test_release_migrations.py"\n\n  deploy-workers-prod:\n',
        )
        errors = validate_data(manifest, schema, out_of_preflight, workers)
        self.assertIn("production preflight does not test the durable D1 release migration runner", errors)

    def test_requires_managed_cost_email_schema_probes_in_both_deployment_workflows(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA_MANIFEST_PATH.read_text(encoding="utf-8"))
        workflows = {
            "staging": (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8"),
            "production": (ROOT / ".github/workflows/deploy-prod.yml").read_text(encoding="utf-8"),
        }
        workers = {path.parent.name for path in (ROOT / "workers").glob("*/wrangler.toml")}
        workflows["production"] = workflows["production"].replace(
            "FROM managed_service_cost_budget_email_deliveries LIMIT 0",
            "FROM missing_email_deliveries LIMIT 0",
        )
        errors = validate_data(manifest, schema, workflows, workers)
        self.assertIn("production deployment workflow is missing managed-service cost email schema probes", errors)

    def test_requires_agentport_sender_principal_schema_probe_in_both_deployment_workflows(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA_MANIFEST_PATH.read_text(encoding="utf-8"))
        workflows = {
            "staging": (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8"),
            "production": (ROOT / ".github/workflows/deploy-prod.yml").read_text(encoding="utf-8"),
        }
        workers = {path.parent.name for path in (ROOT / "workers").glob("*/wrangler.toml")}
        workflows["production"] = workflows["production"].replace(
            "SELECT id,sender_principal_id FROM agentport_channel_message_refs LIMIT 0",
            "SELECT id FROM agentport_channel_message_refs LIMIT 0",
        )
        errors = validate_data(manifest, schema, workflows, workers)
        self.assertIn("production deployment workflow is missing the AgentPort sender-principal schema probe", errors)

    def test_requires_the_deployment_phase_to_invoke_the_durable_migration_runner(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA_MANIFEST_PATH.read_text(encoding="utf-8"))
        workflows = {
            "staging": (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8"),
            "production": (ROOT / ".github/workflows/deploy-prod.yml").read_text(encoding="utf-8"),
        }
        workers = {path.parent.name for path in (ROOT / "workers").glob("*/wrangler.toml")}
        workflows["production"] = workflows["production"].replace(
            "python3 infra/scripts/release_migrations.py \\",
            "echo skipped production migrations",
        )
        errors = validate_data(manifest, schema, workflows, workers)
        self.assertIn("production migration phase must invoke the durable D1 release migration runner", errors)

    def test_migration_runner_must_use_its_environment_baseline_before_schema_probes(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA_MANIFEST_PATH.read_text(encoding="utf-8"))
        workflows = {
            "staging": (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8"),
            "production": (ROOT / ".github/workflows/deploy-prod.yml").read_text(encoding="utf-8"),
        }
        workers = {path.parent.name for path in (ROOT / "workers").glob("*/wrangler.toml")}
        workflows["staging"] = workflows["staging"].replace(
            "--baseline infra/release/baselines/staging.json",
            "--baseline infra/release/baselines/production.json",
        )
        errors = validate_data(manifest, schema, workflows, workers)
        self.assertIn("staging migration runner must pass --baseline infra/release/baselines/staging.json", errors)

    def test_health_probe_domains_must_match_current_worker_configuration(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        changed = copy.deepcopy(manifest)
        changed["environments"]["staging"]["healthProbes"]["agentPortBaseUrl"] = "https://other.example.test"
        errors = validate_health_probe_sources(changed)
        self.assertIn("staging AgentPort health URL differs from its configured issuer", errors)


if __name__ == "__main__":
    unittest.main()
