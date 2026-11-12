#!/usr/bin/env python3
"""Validate the checked-in SQL migration inventory against its release checksums.

This is a source-integrity check only. It does not inspect a deployed D1 database and
does not authorize adopting a legacy database baseline.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "infra" / "release" / "schema-manifest.json"
MIGRATION_DIR = ROOT / "infra" / "migrations"
FILENAME = re.compile(r"^[0-9]{4}_[a-z0-9_]+\.sql$")


class ManifestError(ValueError):
    pass


def load_manifest_from_value(manifest: object) -> dict:
    if not isinstance(manifest, dict) or manifest.get("formatVersion") != 1:
        raise ManifestError("unsupported release manifest format")
    if manifest.get("migrationDirectory") != "infra/migrations":
        raise ManifestError("migrationDirectory must be infra/migrations")
    if manifest.get("legacyBaselinePolicy") != "operator_verified_only":
        raise ManifestError("legacyBaselinePolicy must remain operator_verified_only")
    migrations = manifest.get("migrations")
    if not isinstance(migrations, list) or not migrations:
        raise ManifestError("manifest must contain a non-empty migrations list")
    names: list[str] = []
    for entry in migrations:
        if not isinstance(entry, dict):
            raise ManifestError("each migration entry must be an object")
        name, digest = entry.get("filename"), entry.get("sha256")
        if not isinstance(name, str) or not FILENAME.fullmatch(name):
            raise ManifestError(f"invalid migration filename: {name!r}")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ManifestError(f"invalid SHA-256 for {name}")
        names.append(name)
    if names != sorted(names) or len(names) != len(set(names)):
        raise ManifestError("migration filenames must be unique and lexically ordered")
    if manifest.get("requiredSchemaVersion") != Path(names[-1]).stem:
        raise ManifestError("requiredSchemaVersion must match the final migration filename")
    return manifest


def load_manifest(path: Path = MANIFEST_PATH) -> dict:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError(f"cannot read release manifest: {exc}") from exc
    return load_manifest_from_value(manifest)


def validate_manifest(manifest: dict, migration_dir: Path = MIGRATION_DIR) -> list[str]:
    errors: list[str] = []
    entries = {entry["filename"]: entry["sha256"] for entry in manifest["migrations"]}
    actual_files = sorted(path.name for path in migration_dir.glob("*.sql"))
    expected_files = sorted(entries)
    for name in sorted(set(expected_files) - set(actual_files)):
        errors.append(f"manifest migration is missing: {name}")
    for name in sorted(set(actual_files) - set(expected_files)):
        errors.append(f"migration is absent from manifest: {name}")
    for name in sorted(set(actual_files) & set(expected_files)):
        actual = hashlib.sha256((migration_dir / name).read_bytes()).hexdigest()
        if actual != entries[name]:
            errors.append(f"checksum mismatch: {name}")
    return errors


def main() -> int:
    try:
        manifest = load_manifest()
        errors = validate_manifest(manifest)
    except ManifestError as exc:
        print(f"release manifest invalid: {exc}", file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print(f"release manifest invalid: {error}", file=sys.stderr)
        return 1
    print(
        f"release migration inventory verified: {len(manifest['migrations'])} files; "
        f"required schema {manifest['requiredSchemaVersion']}"
    )
    print("legacy D1 baseline remains operator-verified; no deployed schema was inspected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
