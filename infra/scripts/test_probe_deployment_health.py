import json
import unittest
from pathlib import Path

from probe_deployment_health import ProbeTarget, build_targets, probe_target, run_probes


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "infra/release/deployment-manifest.json").read_text(encoding="utf-8"))


class FakeResponse:
    def __init__(self, status=200, payload=None, url="https://api.staging.naelao.com/health"):
        self.status = status
        self.payload = json.dumps(payload if payload is not None else {}).encode()
        self.url = url
        self.closed = False

    def read(self, size=-1):
        return self.payload[:size]

    def geturl(self):
        return self.url

    def close(self):
        self.closed = True


class DeploymentHealthProbeTests(unittest.TestCase):
    def test_builds_scoped_router_dependency_and_agentport_targets(self):
        targets = build_targets(MANIFEST, "staging", "https://api.staging.naelao.com/")
        self.assertEqual([(target.name, target.url) for target in targets], [
            ("router", "https://api.staging.naelao.com/health"),
            ("router-dependencies", "https://api.staging.naelao.com/health/dependencies"),
            ("agentport", "https://agentport-staging.naelao.com/health"),
        ])
        production = build_targets(MANIFEST, "production", "https://api.naelao.com")
        self.assertEqual(production[0].url, "https://api.naelao.com/health")
        self.assertEqual(production[2].url, "https://agentport.naelao.com/health")

    def test_rejects_wrong_environment_or_unconfigured_api_origin(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            build_targets(MANIFEST, "staging", "https://api.naelao.com")
        with self.assertRaisesRegex(ValueError, "environment must"):
            build_targets(MANIFEST, "preview", "https://api.staging.naelao.com")
        with self.assertRaisesRegex(ValueError, "HTTPS origin"):
            build_targets(MANIFEST, "staging", "http://api.staging.naelao.com")

    def test_retries_transient_failure_and_accepts_matching_release_identity(self):
        responses = [FakeResponse(503), FakeResponse(payload={"status": "ok", "env": "staging"})]
        waits = []

        def opener(_request, timeout):
            self.assertEqual(timeout, 4)
            return responses.pop(0)

        result = probe_target(
            ProbeTarget("router", "https://api.staging.naelao.com/health", "router"),
            "staging", opener=opener, sleeper=waits.append, attempts=2,
        )
        self.assertTrue(result.ok)
        self.assertEqual(result.attempts, 2)
        self.assertEqual(waits, [1])

    def test_fails_when_environment_or_dependency_inventory_is_wrong(self):
        bad_env = probe_target(
            ProbeTarget("router", "https://api.staging.naelao.com/health", "router"),
            "staging", opener=lambda *_args, **_kwargs: FakeResponse(payload={"status": "ok", "env": "production"}),
            sleeper=lambda _seconds: None, attempts=1,
        )
        self.assertFalse(bad_env.ok)
        self.assertIn("environment", bad_env.reason)

        bad_dependencies = probe_target(
            ProbeTarget("router-dependencies", "https://api.staging.naelao.com/health/dependencies", "dependencies"),
            "staging", opener=lambda *_args, **_kwargs: FakeResponse(
                url="https://api.staging.naelao.com/health/dependencies",
                payload={"ok": True, "checked": 1, "failed": 0},
            ),
            sleeper=lambda _seconds: None, attempts=1,
        )
        self.assertFalse(bad_dependencies.ok)
        self.assertIn("counts", bad_dependencies.reason)

    def test_all_three_targets_must_succeed(self):
        def opener(request, timeout):
            self.assertEqual(timeout, 4)
            path = request.full_url.removeprefix("https://api.staging.naelao.com")
            if path == "/health":
                return FakeResponse(payload={"status": "ok", "env": "staging"})
            if path == "/health/dependencies":
                dependencies = MANIFEST["environments"]["staging"]["healthProbes"]["routerDependencies"]
                return FakeResponse(
                    url=request.full_url,
                    payload={"ok": True, "checked": len(dependencies), "failed": 0},
                )
            return FakeResponse(payload={"status": "ok", "service": "AgentPort", "env": "staging"}, url=request.full_url)

        results = run_probes(MANIFEST, "staging", "https://api.staging.naelao.com", opener, lambda _seconds: None, attempts=1)
        self.assertEqual([result.name for result in results], ["router", "router-dependencies", "agentport"])
        self.assertTrue(all(result.ok for result in results))


if __name__ == "__main__":
    unittest.main()
