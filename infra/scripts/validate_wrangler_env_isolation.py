#!/usr/bin/env python3
"""Fail closed when staging and production resolve a binding to the same mutable resource."""

from __future__ import annotations

import sys
import tomllib
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
WORKERS = ROOT / "workers"


def _rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _collect(env: dict[str, Any]) -> list[tuple[str, str, str]]:
    found: list[tuple[str, str, str]] = []

    def add(kind: str, values: Any, resource_key: str, name_key: str = "binding") -> None:
        for row in _rows(values):
            resource = row.get(resource_key)
            if isinstance(resource, str) and resource.strip():
                name = row.get(name_key) or row.get("name") or row.get(resource_key)
                found.append((kind, resource.strip(), str(name)))

    add("d1", env.get("d1_databases"), "database_id")
    add("kv", env.get("kv_namespaces"), "id")
    add("r2", env.get("r2_buckets"), "bucket_name")
    add("vectorize", env.get("vectorize"), "index_name")
    add("service", env.get("services"), "service")
    add("queue", env.get("queues", {}).get("producers") if isinstance(env.get("queues"), dict) else None, "queue")
    add("queue", env.get("queues", {}).get("consumers") if isinstance(env.get("queues"), dict) else None, "queue")
    add("queue", env.get("queues", {}).get("consumers") if isinstance(env.get("queues"), dict) else None, "dead_letter_queue")
    add("workflow", env.get("workflows"), "name")

    durable = env.get("durable_objects")
    if isinstance(durable, dict):
        add("durable_object_script", durable.get("bindings"), "script_name")

    return found


def find_shared_mutable_bindings(config: dict[str, Any], filename: str) -> list[str]:
    environments = config.get("env")
    if not isinstance(environments, dict):
        return []
    staging = environments.get("staging")
    production = environments.get("production")
    if not isinstance(staging, dict) or not isinstance(production, dict):
        return []

    staging_bindings = _collect(staging)
    production_bindings = _collect(production)
    production_by_resource: dict[tuple[str, str], list[str]] = {}
    for kind, resource, name in production_bindings:
        production_by_resource.setdefault((kind, resource), []).append(name)

    conflicts: list[str] = []
    seen: set[tuple[str, str]] = set()
    for kind, resource, staging_name in staging_bindings:
        key = (kind, resource)
        if key in seen or key not in production_by_resource:
            continue
        seen.add(key)
        production_names = ", ".join(sorted(set(production_by_resource[key])))
        conflicts.append(
            f"{filename}: staging binding {staging_name} and production binding "
            f"{production_names} share mutable {kind} resource {resource}"
        )
    return conflicts


def validate(workers_dir: Path = WORKERS) -> list[str]:
    errors: list[str] = []
    configs = sorted(workers_dir.glob("*/wrangler.toml"))
    for path in configs:
        try:
            parsed = tomllib.loads(path.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError) as error:
            display_path = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
            errors.append(f"{display_path}: invalid TOML: {error}")
            continue
        display_path = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
        errors.extend(find_shared_mutable_bindings(parsed, str(display_path)))
    if not configs:
        errors.append(f"no worker wrangler.toml files found under {workers_dir}")
    return errors


def main() -> int:
    errors = validate()
    if errors:
        print("Environment isolation check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        print("Assign distinct mutable resources to staging and production.", file=sys.stderr)
        return 1
    print("Environment isolation check passed: no shared mutable staging/production bindings found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
