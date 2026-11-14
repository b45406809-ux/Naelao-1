#!/usr/bin/env python3
"""Validate that the checked-in release manifest matches both deployment workflows."""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "infra" / "release" / "deployment-manifest.json"
SCHEMA_MANIFEST_PATH = ROOT / "infra" / "release" / "schema-manifest.json"
HEALTH_PROBE_SCRIPT = "infra/scripts/probe_deployment_health.py"
WORKER_DIR = ROOT / "workers"
ROUTER_HEALTH_DEPENDENCIES = [
    "auth", "spaces", "knowledge", "eval", "agents", "credentials",
    "analytics", "billing", "marketplace", "portal-router", "sandboxes",
]
ENVIRONMENTS = {
    "staging": ROOT / ".github" / "workflows" / "deploy-staging.yml",
    "production": ROOT / ".github" / "workflows" / "deploy-prod.yml",
}


def validate_data(
    manifest: object,
    schema_manifest: object,
    workflows: dict[str, str],
    worker_names: set[str],
) -> list[str]:
    errors: list[str] = []
    if not isinstance(manifest, dict) or manifest.get("formatVersion") != 1:
        return ["deployment manifest must be a version 1 object"]
    if not isinstance(schema_manifest, dict):
        return ["schema manifest is missing or invalid"]

    versioning = manifest.get("versioning")
    if not isinstance(versioning, dict):
        errors.append("deployment manifest requires staging and production version sources")
    else:
        staging_version = versioning.get("staging")
        production_version = versioning.get("production")
        if not isinstance(staging_version, str) or "github.sha" not in staging_version:
            errors.append("staging version source must identify the immutable GitHub commit SHA")
        if not isinstance(production_version, str) or "github.sha" not in production_version or "tag" not in production_version.lower():
            errors.append("production version source must identify its release tag and immutable commit SHA")
        if not isinstance(versioning.get("components"), str) or not versioning["components"].strip():
            errors.append("deployment manifest must state how component versions are assigned")

    schema = manifest.get("schema")
    if not isinstance(schema, dict):
        errors.append("deployment manifest requires a schema section")
    elif schema.get("manifest") != "infra/release/schema-manifest.json":
        errors.append("deployment manifest must reference the checked-in schema manifest")
    elif schema.get("requiredSchemaVersion") != schema_manifest.get("requiredSchemaVersion"):
        errors.append("deployment manifest required schema version is stale")
    if not isinstance(schema, dict) or schema.get("compatibilityPolicy") != "expand_contract_required":
        errors.append("schema compatibility policy must require expand/contract changes")
    if not isinstance(schema, dict) or schema.get("rollbackPolicy") != "never reverse an applied schema migration; deploy compatible code or use a reviewed forward repair":
        errors.append("schema rollback policy must prohibit reversing applied migrations")

    recovery = manifest.get("recovery")
    if not isinstance(recovery, dict) or recovery.get("automaticRollback") is not False:
        errors.append("recovery must state that automatic rollback is not configured")
    elif any(not isinstance(recovery.get(key), str) or not recovery[key].strip() for key in ("codeRepair", "dataRecovery", "interruptedMigration")):
        errors.append("recovery must describe code repair, data recovery, and interrupted migration handling")

    worker_files = worker_names
    for environment in ("staging", "production"):
        env_manifest = manifest.get("environments", {}).get(environment) if isinstance(manifest.get("environments"), dict) else None
        workflow = workflows.get(environment)
        if not isinstance(env_manifest, dict) or workflow is None:
            errors.append(f"{environment} deployment workflow or manifest entry is missing")
            continue
        expected_workflow = ".github/workflows/deploy-prod.yml" if environment == "production" else ".github/workflows/deploy-staging.yml"
        if env_manifest.get("workflow") != expected_workflow:
            errors.append(f"{environment} manifest must identify {expected_workflow}")
        if not re.search(rf"^  {re.escape('preflight')}:\s*$", workflow, re.MULTILINE):
            errors.append(f"{environment} workflow has no preflight job")
        if "infra/scripts/validate_deployment_manifest.py" not in workflow:
            errors.append(f"{environment} preflight does not validate the deployment manifest")
        preflight = re.search(r"^  preflight:\s*\n(?P<body>.*?)(?=^  [A-Za-z0-9_-]+:\s*$|\Z)", workflow, re.MULTILINE | re.DOTALL)
        if not preflight or 'test_release_migrations.py' not in preflight.group("body"):
            errors.append(f"{environment} preflight does not test the durable D1 release migration runner")
        required_schema_probes = (
            "SELECT email_alerts_enabled,email_recipient_kind FROM managed_service_cost_budgets LIMIT 0",
            "SELECT id,alert_id,tenant_id,space_id,project_id,user_id,recipient_kind,status,attempts,next_at,lease_token,lease_until,last_error,created_at,updated_at,accepted_at FROM managed_service_cost_budget_email_deliveries LIMIT 0",
        )
        if not all(probe in workflow for probe in required_schema_probes):
            errors.append(f"{environment} deployment workflow is missing managed-service cost email schema probes")
        phases = env_manifest.get("phases")
        if not isinstance(phases, list) or not phases:
            errors.append(f"{environment} manifest phases must be a non-empty ordered list")
            continue

        phase_ids: list[str] = []
        phase_jobs: dict[str, str] = {}
        for phase in phases:
            if not isinstance(phase, dict):
                errors.append(f"{environment} phases must contain objects")
                continue
            phase_id = phase.get("id")
            if not isinstance(phase_id, str) or not phase_id or phase_id in phase_ids:
                errors.append(f"{environment} phase IDs must be non-empty and unique")
                continue
            phase_ids.append(phase_id)
            job = phase.get("job")
            if not isinstance(job, str) or not re.search(rf"^  {re.escape(job)}:\s*$", workflow, re.MULTILINE):
                errors.append(f"{environment} phase {phase_id} names a missing workflow job")
            else:
                phase_jobs[phase_id] = job
            dependencies = phase.get("dependsOn")
            if not isinstance(dependencies, list):
                errors.append(f"{environment} phase {phase_id} must declare dependsOn")
            elif any(dependency not in phase_ids for dependency in dependencies):
                errors.append(f"{environment} phase {phase_id} depends on a missing or later phase")
            elif isinstance(job, str):
                workflow_needs = _workflow_job_needs(workflow, job)
                for dependency in dependencies:
                    dependency_job = phase_jobs.get(dependency)
                    if dependency_job and dependency_job != job and dependency_job not in workflow_needs:
                        errors.append(
                            f"{environment} phase {phase_id} workflow job does not depend on {dependency_job}"
                        )

        if phase_ids[:2] != ["preflight", "migrations_and_schema_probes"]:
            errors.append(f"{environment} release must begin with preflight then migrations and schema probes")
        migration_job = phase_jobs.get("migrations_and_schema_probes")
        migration_body = _workflow_job_body(workflow, migration_job) if migration_job else ""
        runner = "infra/scripts/release_migrations.py"
        runner_position = migration_body.find(runner)
        if runner_position < 0:
            errors.append(f"{environment} migration phase must invoke the durable D1 release migration runner")
        else:
            runner_command = migration_body[runner_position:]
            for argument in (
                f"--environment {environment}",
                "--database-id",
                f"--baseline infra/release/baselines/{environment}.json",
                "--wrangler",
            ):
                if argument not in runner_command:
                    errors.append(f"{environment} migration runner must pass {argument}")
            schema_probe = re.search(r'npx wrangler d1 execute [^\n]*--command=[^\n]*--remote', runner_command)
            if not schema_probe:
                errors.append(f"{environment} migration phase must run remote D1 schema probes after the migration runner")
        if environment == "production":
            components = _components_for(phases, "workers")
            match = re.search(r"WORKERS=\((.*?)\)", workflow, re.DOTALL)
            actual = re.findall(r"[a-z0-9-]+", match.group(1)) if match else []
            if components != actual:
                errors.append("production manifest worker order differs from deploy-prod.yml")
        else:
            primary = _components_for(phases, "primary_workers")
            primary_calls = re.findall(r"--config=workers/([a-z0-9-]+)/wrangler\.toml", workflow)
            # The agents step has two mutually exclusive invocations depending on whether
            # EMAIL_INGRESS_DOMAIN is configured, so the same component appears twice.
            actual_primary = [
                component for index, component in enumerate(primary_calls)
                if index == 0 or component != primary_calls[index - 1]
            ]
            if primary != actual_primary:
                errors.append("staging primary worker order differs from deploy-staging.yml")
            remaining = _components_for(phases, "remaining_workers")
            match = re.search(r"for w in ([a-z0-9 -]+); do", workflow)
            actual_remaining = match.group(1).split() if match else []
            if remaining != actual_remaining:
                errors.append("staging remaining worker order differs from deploy-staging.yml")

        manifest_workers = [
            component
            for phase in phases
            if isinstance(phase, dict)
            for component in (phase.get("components", []) if isinstance(phase.get("components"), list) else [])
            if component in worker_files
        ]
        if len(manifest_workers) != len(set(manifest_workers)) or set(manifest_workers) != worker_files:
            errors.append(f"{environment} manifest must include every Worker config exactly once")

        health = env_manifest.get("healthEvidence")
        if not isinstance(health, dict) or not all(isinstance(health.get(key), str) and health[key].strip() for key in ("preflight", "postMigration", "postWorker")):
            errors.append(f"{environment} manifest must distinguish preflight, schema, and worker health evidence")
        elif "before dependent frontend publication" not in health["postWorker"].lower():
            errors.append(f"{environment} manifest must describe the post-worker health gate before frontend publication")
        probes = env_manifest.get("healthProbes")
        if not isinstance(probes, dict):
            errors.append(f"{environment} manifest requires configured post-worker health probes")
        else:
            for key in ("apiBaseUrl", "agentPortBaseUrl"):
                if not isinstance(probes.get(key), str) or not probes[key].strip():
                    errors.append(f"{environment} healthProbes requires {key}")
            if probes.get("routerPaths") != ["/health", "/health/dependencies"]:
                errors.append(f"{environment} health probe paths must cover router and dependency health")
            if probes.get("routerDependencies") != ROUTER_HEALTH_DEPENDENCIES:
                errors.append(f"{environment} health probe dependencies do not match router health inventory")
        phase_ids = [phase.get("id") for phase in phases if isinstance(phase, dict)]
        worker_phase = "workers" if environment == "production" else "remaining_workers"
        if "worker_health" not in phase_ids or worker_phase not in phase_ids or phase_ids.index("worker_health") != phase_ids.index(worker_phase) + 1:
            errors.append(f"{environment} worker_health phase must immediately follow the final Worker deploy phase")
        expected_api_variable = "API_URL_PROD" if environment == "production" else "API_URL_STAGING"
        if HEALTH_PROBE_SCRIPT not in workflow or f"API_BASE_URL: ${{{{ vars.{expected_api_variable} }}}}" not in workflow or f"--environment {environment}" not in workflow:
            errors.append(f"{environment} deployment workflow must run the post-worker health probe with its API URL")

    return errors


def _components_for(phases: list[Any], phase_id: str) -> list[str]:
    for phase in phases:
        if isinstance(phase, dict) and phase.get("id") == phase_id:
            components = phase.get("components")
            return components if isinstance(components, list) and all(isinstance(item, str) for item in components) else []
    return []


def _workflow_job_needs(workflow: str, job: str) -> set[str]:
    body = _workflow_job_body(workflow, job)
    for line in body.splitlines()[1:]:
        match = re.match(r"^    needs:\s*(.*)$", line)
        if match:
            value = match.group(1).strip()
            if value.startswith("[") and value.endswith("]"):
                return {item.strip().strip("\"'") for item in value[1:-1].split(",") if item.strip()}
            return {value.strip("\"'")} if value else set()
    return set()


def _workflow_job_body(workflow: str, job: str) -> str:
    lines = workflow.splitlines()
    start = next((index for index, line in enumerate(lines) if line == f"  {job}:"), None)
    if start is None:
        return ""
    end = next(
        (index for index in range(start + 1, len(lines)) if re.fullmatch(r"  [a-zA-Z0-9_-]+:", lines[index])),
        len(lines),
    )
    return "\n".join(lines[start:end])


def validate(root: Path = ROOT) -> list[str]:
    try:
        manifest = json.loads((root / MANIFEST_PATH.relative_to(ROOT)).read_text(encoding="utf-8"))
        schema_manifest = json.loads((root / SCHEMA_MANIFEST_PATH.relative_to(ROOT)).read_text(encoding="utf-8"))
        workflows = {
            environment: path.read_text(encoding="utf-8")
            for environment, original_path in ENVIRONMENTS.items()
            for path in [root / original_path.relative_to(ROOT)]
        }
        worker_names = {path.parent.name for path in (root / "workers").glob("*/wrangler.toml")}
    except (OSError, json.JSONDecodeError) as error:
        return [f"cannot read deployment release inputs: {error}"]
    errors = validate_data(manifest, schema_manifest, workflows, worker_names)
    errors.extend(validate_health_probe_sources(manifest, root))
    return errors


def validate_health_probe_sources(manifest: object, root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    if not isinstance(manifest, dict) or not isinstance(manifest.get("environments"), dict):
        return ["deployment manifest has no environment health probe inventory"]
    try:
        router = tomllib.loads((root / "workers/router/wrangler.toml").read_text(encoding="utf-8"))
        synthetics = tomllib.loads((root / "workers/synthetics/wrangler.toml").read_text(encoding="utf-8"))
        agentport = tomllib.loads((root / "workers/agentport/wrangler.toml").read_text(encoding="utf-8"))
        router_source = (root / "workers/router/src/index.ts").read_text(encoding="utf-8")
        agentport_source = (root / "workers/agentport/src/index.ts").read_text(encoding="utf-8")
    except (OSError, tomllib.TOMLDecodeError) as error:
        return [f"cannot read health probe source configuration: {error}"]

    expected_router_bindings = {
        "auth": "AUTH_WORKER", "spaces": "SPACES_WORKER", "knowledge": "KNOWLEDGE_WORKER",
        "eval": "EVAL_WORKER", "agents": "AGENTS_WORKER", "credentials": "CREDENTIALS_WORKER",
        "analytics": "ANALYTICS_WORKER", "billing": "BILLING_WORKER", "marketplace": "MARKETPLACE_WORKER",
        "portal-router": "PORTAL_ROUTER", "sandboxes": "SANDBOXES_WORKER",
    }
    if not re.search(r'app\.get\(["\']\/health["\']', router_source):
        errors.append("router has no local /health route")
    if not all(fragment in agentport_source for fragment in ('app.get("/health"', 'service: "AgentPort"', 'status: "ok"', 'env: c.env.ENVIRONMENT')):
        errors.append("AgentPort /health route must identify its service, environment, and ready status")
    top_services = router.get("services", [])
    for environment in ("staging", "production"):
        env_config = router.get("env", {}).get(environment, {})
        env_services = env_config.get("services", [])
        binding_names = {service.get("binding") for service in top_services + env_services if isinstance(service, dict)}
        if binding_names != set(expected_router_bindings.values()):
            errors.append(f"{environment} router service binding inventory differs from the health check inventory")
        for service, binding in expected_router_bindings.items():
            if f'["{service}", c.env.{binding}]' not in router_source:
                errors.append(f"router dependency health route does not check {service}")
            worker_entry = root / "workers" / service / "src" / "index.ts"
            worker_source = worker_entry.read_text(encoding="utf-8") if worker_entry.is_file() else ""
            if not re.search(r'app\.get\(["\']\/health["\']', worker_source):
                errors.append(f"{environment} health dependency {service} has no local /health route")
            if not all(fragment in worker_source for fragment in (f'service: "{service}"', 'status: "ok"', "ENVIRONMENT")):
                errors.append(f"{environment} health dependency {service} does not expose the release health contract")

        probes = manifest["environments"].get(environment, {}).get("healthProbes", {})
        if not isinstance(probes, dict):
            continue
        api_url = synthetics.get("env", {}).get(environment, {}).get("vars", {}).get("PLATFORM_API_URL")
        agentport_url = agentport.get("env", {}).get(environment, {}).get("vars", {}).get("AGENTPORT_ISSUER")
        if probes.get("apiBaseUrl") != api_url:
            errors.append(f"{environment} API health URL differs from the synthetic monitor configuration")
        if probes.get("agentPortBaseUrl") != agentport_url:
            errors.append(f"{environment} AgentPort health URL differs from its configured issuer")
        if not isinstance(probes.get("apiBaseUrl"), str) or not isinstance(probes.get("agentPortBaseUrl"), str):
            continue
        if not probes["apiBaseUrl"].startswith("https://") or not probes["agentPortBaseUrl"].startswith("https://"):
            errors.append(f"{environment} health probe targets must use HTTPS")
    return errors


def main() -> int:
    errors = validate()
    if errors:
        print("deployment manifest invalid:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("deployment manifest matches both workflows and health probe sources; live probes remain unrun")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
