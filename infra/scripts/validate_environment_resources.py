#!/usr/bin/env python3
"""Validate the checked-in environment map and read-only resource receipts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[2]
WORKERS = ROOT / "workers"
MAP_PATH = ROOT / "infra/environment/resource-map.json"
RECEIPTS_PATH = ROOT / "infra/environment/resource-receipts.json"
RECEIPT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
CF_ACCOUNT_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{32}$")
ENVIRONMENTS = ("staging", "production")
RECEIPT_KINDS = {"queue", "workflow", "r2", "vectorize", "durable_object"}
MUTABLE_RESOURCE_KINDS = {
    "d1",
    "kv",
    "r2",
    "vectorize",
    "queue",
    "workflow",
    "durable_object_script",
    "service",
}
REQUIRED_ENVIRONMENT_RESOURCE_KINDS = MUTABLE_RESOURCE_KINDS | {"durable_object"}


def _rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _resource_rows(environment: dict[str, Any]) -> list[tuple[str, str, str]]:
    resources: list[tuple[str, str, str]] = []

    def add(kind: str, values: Any, key: str) -> None:
        for row in _rows(values):
            value = row.get(key)
            if isinstance(value, str) and value.strip():
                binding = row.get("binding") or row.get("name") or key
                resources.append((kind, str(binding), value.strip()))

    add("d1", environment.get("d1_databases"), "database_id")
    add("kv", environment.get("kv_namespaces"), "id")
    add("r2", environment.get("r2_buckets"), "bucket_name")
    add("vectorize", environment.get("vectorize"), "index_name")
    add("service", environment.get("services"), "service")
    queues = environment.get("queues")
    if isinstance(queues, dict):
        add("queue", queues.get("producers"), "queue")
        add("queue", queues.get("consumers"), "queue")
        add("queue", queues.get("consumers"), "dead_letter_queue")
    add("workflow", environment.get("workflows"), "name")
    durable_objects = environment.get("durable_objects")
    if isinstance(durable_objects, dict):
        for row in _rows(durable_objects.get("bindings")):
            binding = row.get("name") or row.get("binding") or "durable_object"
            class_name = row.get("class_name")
            if isinstance(class_name, str) and class_name.strip():
                resources.append(("durable_object", str(binding), class_name.strip()))
            script_name = row.get("script_name")
            if isinstance(script_name, str) and script_name.strip():
                resources.append(("durable_object_script", str(binding), script_name.strip()))
    return resources


def _hostnames(value: Any) -> list[str]:
    if not isinstance(value, str):
        return []
    hosts: set[str] = set()
    for candidate in value.split(","):
        candidate = candidate.strip()
        if not candidate:
            continue
        try:
            parsed = urlsplit(candidate if "://" in candidate else f"https://{candidate}")
            hostname = (parsed.hostname or "").lower().removeprefix("*.").rstrip(".")
        except ValueError:
            continue
        if hostname and "." in hostname and all(part and re.fullmatch(r"[a-z0-9-]+", part) for part in hostname.split(".")):
            hosts.add(hostname)
    return sorted(hosts)


def _deployment_surface(path: Path, worker_name: str, parsed: dict[str, Any], environment_name: str) -> dict[str, Any] | None:
    environment = parsed.get("env", {}).get(environment_name)
    if not isinstance(environment, dict):
        return None
    routes: list[dict[str, str]] = []
    raw_routes = environment.get("routes")
    for route in _rows(raw_routes):
        item: dict[str, str] = {}
        for key in ("pattern", "zone_name", "custom_domain"):
            value = route.get(key)
            if isinstance(value, str) and value.strip():
                item[key] = value.strip()
        if item:
            routes.append(item)
    if isinstance(raw_routes, list):
        routes.extend({"pattern": route.strip()} for route in raw_routes if isinstance(route, str) and route.strip())

    variables = environment.get("vars")
    var_names = sorted(variables) if isinstance(variables, dict) else []
    endpoint_names = re.compile(r"(?:URL|DOMAIN|HOST|ORIGIN|ISSUER|ALLOWLIST|CALLBACK|WEBHOOK)$", re.IGNORECASE)
    endpoint_variables = []
    if isinstance(variables, dict):
        for name, value in sorted(variables.items()):
            if endpoint_names.search(str(name)):
                endpoint_variables.append({"name": str(name), "hostnames": _hostnames(value)})

    d1 = _rows(environment.get("d1_databases"))
    d1_jurisdictions = [
        {"binding": str(row.get("binding") or "D1"), "jurisdiction": row.get("jurisdiction")}
        for row in d1
    ]
    jurisdiction = environment.get("jurisdiction", parsed.get("jurisdiction"))
    return {
        "worker": worker_name,
        "environment": environment_name,
        "worker_target": str(environment.get("name") or f"{worker_name}-{environment_name}"),
        "source": path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.name,
        "routes": sorted(routes, key=lambda row: (row.get("pattern", ""), row.get("zone_name", ""), row.get("custom_domain", ""))),
        "variable_names": var_names,
        "endpoint_variables": endpoint_variables,
        "jurisdiction": jurisdiction if isinstance(jurisdiction, str) else None,
        "d1_jurisdictions": d1_jurisdictions,
        "external_secret_values_included": False,
        "provider_callbacks_verified": False,
    }


def build_source_map(workers_dir: Path = WORKERS) -> dict[str, Any]:
    files = sorted(workers_dir.glob("*/wrangler.toml"))
    by_binding: dict[tuple[str, str], dict[str, dict[str, set[str]]]] = {}
    receipt_requirements: set[tuple[str, str, str]] = set()
    service_targets: dict[str, set[str]] = {environment: set() for environment in ENVIRONMENTS}
    durable_object_script_targets: dict[str, set[str]] = {environment: set() for environment in ENVIRONMENTS}
    known_targets: dict[str, set[str]] = {environment: set() for environment in ENVIRONMENTS}
    deployment_surfaces: list[dict[str, Any]] = []

    for path in files:
        parsed = tomllib.loads(path.read_text(encoding="utf-8"))
        worker_name = str(parsed.get("name") or path.parent.name)
        relative = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.name
        for environment_name in ENVIRONMENTS:
            environment = parsed.get("env", {}).get(environment_name)
            if not isinstance(environment, dict):
                continue
            surface = _deployment_surface(path, worker_name, parsed, environment_name)
            if surface is not None:
                deployment_surfaces.append(surface)
            target_name = environment.get("name")
            known_targets[environment_name].add(str(target_name or f"{worker_name}-{environment_name}"))
            for kind, binding, resource in _resource_rows(environment):
                target = by_binding.setdefault((kind, binding), {})
                environment_resources = target.setdefault(environment_name, {})
                environment_resources.setdefault(resource, set()).add(relative)
                if kind == "service":
                    service_targets[environment_name].add(resource)
                if kind == "durable_object_script":
                    durable_object_script_targets[environment_name].add(resource)
                if kind in RECEIPT_KINDS:
                    receipt_requirements.add((kind, environment_name, resource))
                if kind in {"d1", "kv"}:
                    receipt_requirements.add((kind, environment_name, resource))

    mapped_bindings: list[dict[str, Any]] = []
    for (kind, binding), environments in sorted(by_binding.items()):
        environment_map: dict[str, list[dict[str, Any]]] = {}
        for environment_name in ENVIRONMENTS:
            rows = environments.get(environment_name, {})
            environment_map[environment_name] = [
                {"id_or_name": resource, "workers": sorted(workers)}
                for resource, workers in sorted(rows.items())
            ]
        mapped_bindings.append({"kind": kind, "binding": binding, "environments": environment_map})

    source_hashes = []
    for path in files:
        relative = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.name
        source_hashes.append({"path": relative, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})

    return {
        "version": 1,
        "status": "source_inventory_only",
        "source_files": source_hashes,
        "bindings": mapped_bindings,
        "deployment_surfaces": sorted(deployment_surfaces, key=lambda row: (row["worker"], row["environment"])),
        "external_inventory_limits": {
            "secret_values": "never collected",
            "provider_secret_presence": "requires a separate read-only provider inventory",
            "provider_webhook_callback_registration": "not verifiable from Wrangler source",
            "cloudflare_jurisdiction_receipts": "requires read-only account observation when not explicitly configured",
        },
        "unresolved_service_targets": sorted(
            set.union(*(service_targets[name] - known_targets[name] for name in ENVIRONMENTS))
        ),
        "unresolved_durable_object_script_targets": sorted(
            set.union(*(durable_object_script_targets[name] - known_targets[name] for name in ENVIRONMENTS))
        ),
        "required_existence_receipts": [
            {"kind": kind, "environment": environment_name, "id_or_name": name, "status": "unverified"}
            for kind, environment_name, name in sorted(receipt_requirements)
        ],
    }


def _read_json(path: Path, label: str) -> tuple[Any | None, list[str]]:
    try:
        return json.loads(path.read_text(encoding="utf-8")), []
    except FileNotFoundError:
        return None, [f"{label} is missing: {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}"]
    except (OSError, json.JSONDecodeError) as error:
        return None, [f"{label} is unreadable or invalid JSON: {error}"]


def _resource_conflicts(source_map: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    by_kind_environment: dict[str, dict[str, set[str]]] = {
        kind: {"staging": set(), "production": set()} for kind in MUTABLE_RESOURCE_KINDS
    }
    for binding in source_map["bindings"]:
        kind = binding["kind"]
        name = binding["binding"]
        staging = {row["id_or_name"] for row in binding["environments"].get("staging", [])}
        production = {row["id_or_name"] for row in binding["environments"].get("production", [])}
        if kind in REQUIRED_ENVIRONMENT_RESOURCE_KINDS:
            if not staging or not production:
                errors.append(f"{kind} {name} must have explicit staging and production resource targets")
            elif kind in MUTABLE_RESOURCE_KINDS and staging & production:
                shared = ", ".join(sorted(staging & production))
                errors.append(f"{kind} {name} shares staging/production resource target(s): {shared}")
            if kind in MUTABLE_RESOURCE_KINDS:
                by_kind_environment[kind]["staging"].update(staging)
                by_kind_environment[kind]["production"].update(production)
            if kind in {"d1", "kv"}:
                id_pattern = re.compile(
                    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
                    if kind == "d1"
                    else r"^[0-9a-fA-F]{32}$"
                )
                for environment_name, values in (("staging", staging), ("production", production)):
                    for value in values:
                        if not id_pattern.fullmatch(value):
                            errors.append(f"{kind} {name} {environment_name} resource ID is not a real-format ID: {value}")
    for kind, environments in by_kind_environment.items():
        shared_across_bindings = environments["staging"] & environments["production"]
        for resource in sorted(shared_across_bindings):
            if not any(f"resource target(s): {resource}" in error for error in errors):
                errors.append(f"{kind} resource target is shared across staging and production bindings: {resource}")
    return errors


def _validate_receipts(
    source_map: dict[str, Any], receipts: Any, now: datetime | None = None
) -> list[str]:
    errors: list[str] = []
    if not isinstance(receipts, dict) or receipts.get("version") != 1:
        return ["resource receipts must be a version 1 JSON object"]
    rows = receipts.get("resources")
    if not isinstance(rows, list):
        return ["resource receipts must contain a resources array"]
    required = {
        (row["kind"], row["environment"], row["id_or_name"])
        for row in source_map["required_existence_receipts"]
    }
    observed: dict[tuple[str, str, str], dict[str, Any]] = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            errors.append(f"receipt resources[{index}] must be an object")
            continue
        key = (row.get("kind"), row.get("environment"), row.get("id_or_name"))
        if key not in required:
            errors.append(f"receipt resources[{index}] does not match a required environment resource")
            continue
        if key in observed:
            errors.append(f"duplicate staging receipt for {key[0]} {key[1]}")
            continue
        observed[key] = row

    account_id = receipts.get("account_id")
    if not isinstance(account_id, str) or not CF_ACCOUNT_ID_PATTERN.fullmatch(account_id):
        errors.append("resource receipts require the observed 32-character hexadecimal Cloudflare account_id")
    try:
        observed_at = datetime.fromisoformat(str(receipts.get("observed_at", "")).replace("Z", "+00:00"))
        if observed_at.tzinfo is None:
            raise ValueError("timezone is required")
        current = now or datetime.now(timezone.utc)
        age = (current - observed_at.astimezone(timezone.utc)).total_seconds()
        if age < 0 or age > RECEIPT_MAX_AGE_SECONDS:
            errors.append("resource receipt observed_at must be no more than seven days old and not in the future")
    except (TypeError, ValueError):
        errors.append("resource receipts require an ISO-8601 observed_at timestamp with timezone")

    for key in sorted(required):
        row = observed.get(key)
        if row is None:
            errors.append(f"missing read-only {key[1]} existence receipt for {key[0]} {key[2]}")
            continue
        for field in ("resource_id", "evidence_source", "observer"):
            value = row.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"receipt for {key[0]} {key[1]} requires {field}")
        if row.get("environment") != key[1]:
            errors.append(f"receipt for {key[0]} {key[2]} must identify {key[1]}")
        if row.get("read_only") is not True:
            errors.append(f"receipt for {key[0]} {key[2]} must be from a read-only inventory")
        if key[0] in {"d1", "kv"} and row.get("resource_id") != key[2]:
            errors.append(f"receipt for {key[0]} {key[2]} must confirm the exact configured resource ID")
    observed_ids: dict[str, dict[str, set[str]]] = {
        kind: {"staging": set(), "production": set()} for kind in RECEIPT_KINDS
    }
    for key, row in observed.items():
        kind, environment, _ = key
        resource_id = row.get("resource_id")
        if kind in observed_ids and isinstance(resource_id, str) and resource_id.strip():
            observed_ids[kind][environment].add(resource_id.strip())
    for kind, environments in observed_ids.items():
        shared = environments["staging"] & environments["production"]
        for resource_id in sorted(shared):
            errors.append(f"{kind} observed resource ID is shared across staging and production: {resource_id}")
    return errors


def validate(
    workers_dir: Path = WORKERS,
    map_path: Path = MAP_PATH,
    receipts_path: Path = RECEIPTS_PATH,
    now: datetime | None = None,
) -> list[str]:
    errors: list[str] = []
    try:
        source_map = build_source_map(workers_dir)
    except (OSError, tomllib.TOMLDecodeError) as error:
        return [f"could not build source environment map: {error}"]
    if not source_map["source_files"]:
        return [f"no worker Wrangler TOMLs found under {workers_dir}"]

    checked_in_map, map_errors = _read_json(map_path, "resource map")
    errors.extend(map_errors)
    if checked_in_map is not None and checked_in_map != source_map:
        errors.append("resource map is stale; regenerate it from the current Worker Wrangler TOMLs")

    errors.extend(_resource_conflicts(source_map))
    unresolved = source_map["unresolved_service_targets"]
    if unresolved:
        errors.append("service targets have no named Worker owner: " + ", ".join(unresolved))
    unresolved_do_scripts = source_map["unresolved_durable_object_script_targets"]
    if unresolved_do_scripts:
        errors.append("Durable Object script targets have no named Worker owner in the same environment: " + ", ".join(unresolved_do_scripts))

    receipts, receipt_errors = _read_json(receipts_path, "resource receipts")
    errors.extend(receipt_errors)
    if receipts is not None:
        errors.extend(_validate_receipts(source_map, receipts, now))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-source-map", action="store_true", help="write the source-derived inventory")
    args = parser.parse_args()
    if args.write_source_map:
        MAP_PATH.parent.mkdir(parents=True, exist_ok=True)
        MAP_PATH.write_text(json.dumps(build_source_map(), indent=2) + "\n", encoding="utf-8")
        print(f"Wrote source-derived environment map to {MAP_PATH.relative_to(ROOT)}")
        return 0

    errors = validate()
    if errors:
        print("Environment resource preflight failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Environment resource preflight passed: source map and staging receipts are current.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
