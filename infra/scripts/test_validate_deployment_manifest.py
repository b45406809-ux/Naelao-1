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

    def test_health_probe_domains_must_match_current_worker_configuration(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        changed = copy.deepcopy(manifest)
        changed["environments"]["staging"]["healthProbes"]["agentPortBaseUrl"] = "https://other.example.test"
        errors = validate_health_probe_sources(changed)
        self.assertIn("staging AgentPort health URL differs from its configured issuer", errors)


if __name__ == "__main__":
    unittest.main()
