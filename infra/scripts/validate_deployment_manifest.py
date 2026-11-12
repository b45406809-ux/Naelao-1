#!/usr/bin/env python3
"""Validate that the checked-in release manifest matches both deployment workflows."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "infra" / "release" / "deployment-manifest.json"
SCHEMA_MANIFEST_PATH = ROOT / "infra" / "release" / "schema-manifest.json"
WORKER_DIR = ROOT / "workers"
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
        elif not re.search(r"healthcheck|health check|smoke test|\bcurl\b", workflow, re.IGNORECASE) and "No deployed worker health probe" not in health["postWorker"]:
            errors.append(f"{environment} manifest must disclose that deployed worker probes are not configured")

    return errors


def _components_for(phases: list[Any], phase_id: str) -> list[str]:
    for phase in phases:
        if isinstance(phase, dict) and phase.get("id") == phase_id:
            components = phase.get("components")
            return components if isinstance(components, list) and all(isinstance(item, str) for item in components) else []
    return []


def _workflow_job_needs(workflow: str, job: str) -> set[str]:
    lines = workflow.splitlines()
    start = next((index for index, line in enumerate(lines) if line == f"  {job}:"), None)
    if start is None:
        return set()
    end = next(
        (index for index in range(start + 1, len(lines)) if re.fullmatch(r"  [a-zA-Z0-9_-]+:", lines[index])),
        len(lines),
    )
    for line in lines[start + 1 : end]:
        match = re.match(r"^    needs:\s*(.*)$", line)
        if match:
            value = match.group(1).strip()
            if value.startswith("[") and value.endswith("]"):
                return {item.strip().strip("\"'") for item in value[1:-1].split(",") if item.strip()}
            return {value.strip("\"'")} if value else set()
    return set()


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
    return validate_data(manifest, schema_manifest, workflows, worker_names)


def main() -> int:
    errors = validate()
    if errors:
        print("deployment manifest invalid:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("deployment manifest matches staging and production workflow order; deployed health evidence remains separate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
