#!/usr/bin/env python3
"""Apply D1 migrations with an attested baseline, durable lock and checksum ledger.

This utility is intentionally fail-closed. Existing databases must first have a
reviewed baseline document under infra/release/baselines/<environment>.json.
The document is based on a read-only inspection of that exact database and includes
its schema fingerprint and every migration known to have been applied or explicitly
skipped. No database operation is attempted when that adoption record is missing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Protocol

from validate_release_manifest import (
    MANIFEST_PATH,
    MIGRATION_DIR,
    ManifestError,
    load_manifest,
    validate_manifest,
)


ROOT = Path(__file__).resolve().parents[2]
BASELINE_DIR = ROOT / "infra" / "release" / "baselines"
MIGRATION_TABLE = "naelao_release_migrations"
LOCK_TABLE = "naelao_release_migration_lock"
META_TABLE = "naelao_release_migration_meta"
SPECIAL_SKIP = {
    "0164_agentport_channel_message_refs.sql": "agentport_messages",
}


class ReleaseError(RuntimeError):
    pass


class D1(Protocol):
    def query(self, sql: str) -> list[dict[str, Any]]: ...

    def execute_file(self, sql: str) -> None: ...


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def validate_baseline_document(
    baseline: object,
    *,
    environment: str,
    database_id: str,
    manifest: dict,
) -> dict:
    if not isinstance(baseline, dict) or baseline.get("formatVersion") != 1:
        raise ReleaseError("legacy baseline attestation is missing or has an unsupported format")
    required_text = ("verifiedAt", "verifiedBy", "evidenceRef", "schemaFingerprint")
    if any(not isinstance(baseline.get(key), str) or not baseline[key].strip() for key in required_text):
        raise ReleaseError("baseline requires verifiedAt, verifiedBy, evidenceRef, and schemaFingerprint")
    if baseline.get("environment") != environment or baseline.get("databaseId") != database_id:
        raise ReleaseError("baseline environment or D1 database ID does not match this deployment")
    if not isinstance(baseline.get("manifestSha256"), str) or not re.fullmatch(
        r"[a-f0-9]{64}", baseline["manifestSha256"]
    ):
        raise ReleaseError("baseline manifestSha256 must be a lowercase SHA-256 digest")
    try:
        verified_at = datetime.fromisoformat(baseline["verifiedAt"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise ReleaseError("baseline verifiedAt must be an ISO-8601 timestamp") from exc
    if verified_at.tzinfo is None:
        raise ReleaseError("baseline verifiedAt must include a timezone")

    native_names = baseline.get("nativeMigrationNames")
    if not isinstance(native_names, list) or any(not isinstance(name, str) for name in native_names):
        raise ReleaseError("baseline nativeMigrationNames must be a list")
    if native_names != sorted(native_names) or len(native_names) != len(set(native_names)):
        raise ReleaseError("native D1 migration names in the baseline must be unique and ordered")
    if any(name not in {entry["filename"] for entry in manifest["migrations"]} for name in native_names):
        raise ReleaseError("native D1 migration history contains a filename absent from the manifest")

    entries = {entry["filename"]: entry["sha256"] for entry in manifest["migrations"]}
    records = baseline.get("migrations")
    if not isinstance(records, list):
        raise ReleaseError("baseline migrations must be an ordered list")
    names: list[str] = []
    for record in records:
        if not isinstance(record, dict):
            raise ReleaseError("each baseline migration must be an object")
        name, digest, status = record.get("filename"), record.get("sha256"), record.get("status")
        if name not in entries or digest != entries[name]:
            raise ReleaseError(f"baseline migration is absent from the manifest or has a different checksum: {name}")
        if status not in ("applied", "skipped"):
            raise ReleaseError(f"invalid baseline state for {name}; expected applied or skipped")
        if status == "skipped":
            if name not in SPECIAL_SKIP or record.get("reason") != f"legacy table {SPECIAL_SKIP[name]} was absent":
                raise ReleaseError(f"unapproved migration skip in baseline: {name}")
        elif record.get("reason") not in (None, ""):
            raise ReleaseError(f"applied migration must not have a skip reason: {name}")
        names.append(name)
    if names != sorted(names) or len(names) != len(set(names)):
        raise ReleaseError("baseline migrations must be unique and lexically ordered")
    if names and names != [entry["filename"] for entry in manifest["migrations"][: len(names)]]:
        raise ReleaseError("baseline must account for every migration through its last recorded migration")
    expected_baseline_version = Path(names[-1]).stem if names else None
    if baseline.get("attestedSchemaVersion") != expected_baseline_version:
        raise ReleaseError("baseline attestedSchemaVersion must match its last recorded migration")
    return baseline


def schema_fingerprint(rows: list[dict[str, Any]]) -> str:
    canonical = [
        {key: row.get(key) for key in ("type", "name", "tbl_name", "sql")}
        for row in sorted(rows, key=lambda item: (str(item.get("type")), str(item.get("name"))))
    ]
    return sha256_bytes(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode())


def validate_ledger(rows: list[dict[str, Any]], manifest: dict) -> dict[str, dict[str, Any]]:
    entries = {entry["filename"]: entry["sha256"] for entry in manifest["migrations"]}
    ledger: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = row.get("filename")
        if name not in entries:
            raise ReleaseError(f"database release ledger contains unknown migration: {name}")
        if row.get("sha256") != entries[name]:
            raise ReleaseError(f"applied migration checksum drift: {name}")
        status = row.get("status")
        if status not in ("applied", "skipped"):
            raise ReleaseError(f"database release ledger has an incomplete migration record: {name}")
        if status == "skipped":
            expected = f"legacy table {SPECIAL_SKIP.get(name, '')} was absent"
            if name not in SPECIAL_SKIP or row.get("reason") != expected:
                raise ReleaseError(f"database release ledger has an unapproved skipped migration: {name}")
        ledger[name] = row
    recorded = list(ledger)
    if recorded != sorted(recorded) or recorded != [entry["filename"] for entry in manifest["migrations"][: len(recorded)]]:
        raise ReleaseError("database release ledger is not a contiguous migration prefix")
    return ledger


def _extract_json(output: str) -> Any:
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        for start, char in enumerate(output):
            if char not in "[{":
                continue
            try:
                return json.loads(output[start:])
            except json.JSONDecodeError:
                continue
    raise ReleaseError("Wrangler did not return parseable JSON for the D1 query")


def _result_rows(payload: Any) -> list[dict[str, Any]]:
    responses = payload if isinstance(payload, list) else [payload]
    rows: list[dict[str, Any]] = []
    for response in responses:
        if not isinstance(response, dict) or response.get("success") is False:
            raise ReleaseError("Wrangler reported a failed D1 statement")
        result_rows = response.get("results", [])
        if isinstance(result_rows, list):
            rows.extend(row for row in result_rows if isinstance(row, dict))
    return rows


@dataclass
class WranglerD1:
    database_id: str
    wrangler: list[str]
    environment: str
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run

    def _execute(self, args: list[str]) -> Any:
        command = [*self.wrangler, "d1", "execute", self.database_id, "--remote", "--json", *args]
        result = self.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
        if result.returncode:
            raise ReleaseError(result.stderr.strip() or f"Wrangler exited {result.returncode}")
        return _extract_json(result.stdout)

    def query(self, sql: str) -> list[dict[str, Any]]:
        return _result_rows(self._execute(["--command", sql]))

    def execute_file(self, sql: str) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".sql", encoding="utf-8", delete=False) as handle:
            handle.write(sql)
            path = Path(handle.name)
        try:
            self._execute(["--file", str(path)])
        finally:
            path.unlink(missing_ok=True)


def _metadata(d1: D1) -> dict[str, str]:
    rows = d1.query(
        "SELECT name FROM sqlite_master WHERE type='table' "
        f"AND name IN ('{MIGRATION_TABLE}','{LOCK_TABLE}','{META_TABLE}') ORDER BY name"
    )
    return {row["name"]: "present" for row in rows if isinstance(row.get("name"), str)}


def _table_rows(d1: D1, table: str) -> list[dict[str, Any]]:
    if table not in (MIGRATION_TABLE, LOCK_TABLE, META_TABLE):
        raise ReleaseError("refusing to query a non-release table through _table_rows")
    return d1.query(f"SELECT * FROM {table}")


def bootstrap_ledger(d1: D1, baseline: dict, manifest: dict) -> None:
    native_table = d1.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'"
    )
    actual_native_names = []
    if native_table:
        actual_native_names = [
            row.get("name") for row in d1.query("SELECT name FROM d1_migrations ORDER BY id")
        ]
    if actual_native_names != baseline["nativeMigrationNames"]:
        raise ReleaseError("live d1_migrations history differs from the operator-attested baseline")
    schema_rows = d1.query(
        "SELECT type,name,tbl_name,sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
    )
    actual_fingerprint = schema_fingerprint(schema_rows)
    if actual_fingerprint != baseline["schemaFingerprint"]:
        raise ReleaseError("live D1 schema fingerprint differs from the operator-attested legacy baseline")

    statements = [
        f"CREATE TABLE IF NOT EXISTS {MIGRATION_TABLE} ("
        "filename TEXT PRIMARY KEY, sha256 TEXT NOT NULL, status TEXT NOT NULL "
        "CHECK(status IN ('applied','skipped')), reason TEXT, execution_id TEXT NOT NULL, "
        "applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        f"CREATE TABLE IF NOT EXISTS {LOCK_TABLE} ("
        "lock_id TEXT PRIMARY KEY CHECK(lock_id='schema'), owner TEXT NOT NULL, "
        "acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_migration TEXT, last_error TEXT)",
        f"CREATE TABLE IF NOT EXISTS {META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        f"INSERT INTO {META_TABLE}(key,value) VALUES('environment',{sql_quote(baseline['environment'])}) "
        "ON CONFLICT(key) DO NOTHING",
        f"INSERT INTO {META_TABLE}(key,value) VALUES('database_id',{sql_quote(baseline['databaseId'])}) "
        "ON CONFLICT(key) DO NOTHING",
        f"INSERT INTO {META_TABLE}(key,value) VALUES('baseline_schema_fingerprint',{sql_quote(baseline['schemaFingerprint'])}) "
        "ON CONFLICT(key) DO NOTHING",
        f"INSERT INTO {META_TABLE}(key,value) VALUES('baseline_evidence',{sql_quote(baseline['evidenceRef'])}) "
        "ON CONFLICT(key) DO NOTHING",
        f"INSERT INTO {META_TABLE}(key,value) VALUES('baseline_verified_at',{sql_quote(baseline['verifiedAt'])}) "
        "ON CONFLICT(key) DO NOTHING",
        f"INSERT INTO {META_TABLE}(key,value) VALUES('baseline_verified_by',{sql_quote(baseline['verifiedBy'])}) "
        "ON CONFLICT(key) DO NOTHING",
        f"INSERT INTO {META_TABLE}(key,value) VALUES('baseline_manifest_sha256',{sql_quote(baseline['manifestSha256'])}) "
        "ON CONFLICT(key) DO NOTHING",
    ]
    for record in baseline["migrations"]:
        statements.append(
            f"INSERT INTO {MIGRATION_TABLE}(filename,sha256,status,reason,execution_id) VALUES("
            f"{sql_quote(record['filename'])},{sql_quote(record['sha256'])},{sql_quote(record['status'])},"
            f"{sql_quote(record.get('reason') or '')},'baseline-adoption') ON CONFLICT(filename) DO NOTHING"
        )
    d1.execute_file(";\n".join(statements) + ";\n")


def verify_meta(d1: D1, environment: str, database_id: str) -> None:
    rows = _table_rows(d1, META_TABLE)
    metadata = {row.get("key"): row.get("value") for row in rows}
    if metadata.get("environment") != environment or metadata.get("database_id") != database_id:
        raise ReleaseError("release ledger belongs to a different environment or D1 database")


def acquire_lock(d1: D1, execution_id: str) -> None:
    d1.execute_file(
        f"INSERT INTO {LOCK_TABLE}(lock_id,owner) VALUES('schema',{sql_quote(execution_id)}) "
        "ON CONFLICT(lock_id) DO NOTHING;\n"
    )
    rows = d1.query(f"SELECT owner,last_migration FROM {LOCK_TABLE} WHERE lock_id='schema'")
    if not rows or rows[0].get("owner") != execution_id:
        owner = rows[0].get("owner") if rows else "unknown"
        raise ReleaseError(f"D1 migration lock is owned by {owner}; inspect the durable ledger before resuming")


def _touch_lock(d1: D1, execution_id: str, migration: str) -> None:
    d1.execute_file(
        f"UPDATE {LOCK_TABLE} SET last_migration={sql_quote(migration)},last_error=NULL "
        f"WHERE lock_id='schema' AND owner={sql_quote(execution_id)};\n"
    )


def _record_error(d1: D1, execution_id: str, error: str) -> None:
    safe_error = error[:1000]
    try:
        d1.execute_file(
            f"UPDATE {LOCK_TABLE} SET last_error={sql_quote(safe_error)} "
            f"WHERE lock_id='schema' AND owner={sql_quote(execution_id)};\n"
        )
    except Exception:
        pass


def _record_skipped(d1: D1, entry: dict, execution_id: str, reason: str) -> None:
    d1.execute_file(
        f"INSERT INTO {MIGRATION_TABLE}(filename,sha256,status,reason,execution_id) VALUES("
        f"{sql_quote(entry['filename'])},{sql_quote(entry['sha256'])},'skipped',{sql_quote(reason)},"
        f"{sql_quote(execution_id)});\n"
    )


def _required_schema_check(d1: D1, manifest: dict, ledger: dict[str, dict[str, Any]]) -> None:
    required = manifest["requiredSchemaVersion"] + ".sql"
    record = ledger.get(required)
    if not record or record.get("status") != "applied":
        raise ReleaseError(f"required schema version {manifest['requiredSchemaVersion']} is not recorded as applied")
    columns = {
        row.get("name")
        for row in d1.query("PRAGMA table_info('billing_dunning_outbox')")
        if isinstance(row.get("name"), str)
    }
    expected = {"workflow_id", "tenant_id", "status", "next_attempt_at", "updated_at"}
    if not expected.issubset(columns):
        raise ReleaseError("required schema check failed for billing_dunning_outbox")
    queue_columns = {
        row.get("name")
        for row in d1.query("PRAGMA table_info('queue_health_checks')")
        if isinstance(row.get("name"), str)
    }
    queue_expected = {"triggered_at", "observed_at", "source", "status", "unavailable_reason", "metrics_json", "alert_count", "alerts_json"}
    if not queue_expected.issubset(queue_columns):
        raise ReleaseError("required schema check failed for queue_health_checks")
    auth_email_columns = {
        row.get("name")
        for row in d1.query("PRAGMA table_info('product_auth_email_outbox')")
        if isinstance(row.get("name"), str)
    }
    if "provider_receipt_id" not in auth_email_columns:
        raise ReleaseError("required schema check failed for product_auth_email_outbox")
    d1.execute_file(
        f"INSERT INTO {META_TABLE}(key,value) VALUES('current_schema_version',{sql_quote(manifest['requiredSchemaVersion'])}) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value;\n"
    )


def run_migrations(
    d1: D1,
    *,
    environment: str,
    database_id: str,
    execution_id: str,
    manifest: dict,
    baseline: dict | None,
    schema_probe: bool = True,
) -> str:
    if not execution_id or len(execution_id) > 160:
        raise ReleaseError("execution ID must be a non-empty value of at most 160 characters")
    metadata = _metadata(d1)
    if MIGRATION_TABLE not in metadata:
        if baseline is None:
            raise ReleaseError(
                f"legacy baseline adoption is required; create {BASELINE_DIR / (environment + '.json')} "
                "from a read-only inspection of this exact D1 database"
            )
        bootstrap_ledger(d1, baseline, manifest)
    verify_meta(d1, environment, database_id)
    acquire_lock(d1, execution_id)
    try:
        entries = manifest["migrations"]
        ledger = validate_ledger(_table_rows(d1, MIGRATION_TABLE), manifest)
        for entry in entries[len(ledger) :]:
            name = entry["filename"]
            _touch_lock(d1, execution_id, name)
            if name in SPECIAL_SKIP:
                table = SPECIAL_SKIP[name]
                present = d1.query(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=" + sql_quote(table)
                )
                if not present:
                    reason = f"legacy table {table} was absent"
                    _record_skipped(d1, entry, execution_id, reason)
                    ledger[name] = {**entry, "status": "skipped", "reason": reason}
                    continue
            migration_sql = (MIGRATION_DIR / name).read_text(encoding="utf-8")
            applied_record = (
                f"INSERT INTO {MIGRATION_TABLE}(filename,sha256,status,reason,execution_id) VALUES("
                f"{sql_quote(name)},{sql_quote(entry['sha256'])},'applied','',{sql_quote(execution_id)});"
            )
            # D1 file execution rolls the entire script back on failure, so the schema
            # mutation and checksum receipt are atomic and a retry begins at this migration.
            d1.execute_file(migration_sql.rstrip() + "\n" + applied_record + "\n")
            ledger[name] = {**entry, "status": "applied", "reason": ""}

        if schema_probe:
            _required_schema_check(d1, manifest, ledger)
        d1.execute_file(
            f"DELETE FROM {LOCK_TABLE} WHERE lock_id='schema' AND owner={sql_quote(execution_id)};\n"
        )
        return manifest["requiredSchemaVersion"]
    except Exception as exc:
        _record_error(d1, execution_id, str(exc))
        raise


def _load_baseline(path: Path, environment: str, database_id: str, manifest: dict) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ReleaseError(f"legacy baseline adoption is required: cannot read {path}") from exc
    except json.JSONDecodeError as exc:
        raise ReleaseError(f"invalid legacy baseline JSON: {path}") from exc
    return validate_baseline_document(
        payload,
        environment=environment,
        database_id=database_id,
        manifest=manifest,
    )


def inspect_baseline(d1: D1, *, environment: str, database_id: str, manifest: dict) -> dict:
    """Collect read-only facts for an operator-authored baseline; never infers applied SQL."""
    schema_rows = d1.query(
        "SELECT type,name,tbl_name,sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
    )
    native_table = d1.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'"
    )
    native_names = []
    if native_table:
        native_names = [row.get("name") for row in d1.query("SELECT name FROM d1_migrations ORDER BY id")]
    legacy_message_table = d1.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agentport_messages'"
    )
    return {
        "environment": environment,
        "databaseId": database_id,
        "manifestSha256": sha256_bytes(MANIFEST_PATH.read_bytes()),
        "requiredSchemaVersion": manifest["requiredSchemaVersion"],
        "schemaFingerprint": schema_fingerprint(schema_rows),
        "schemaObjectCount": len(schema_rows),
        "nativeMigrationNames": native_names,
        "agentportMessagesTablePresent": bool(legacy_message_table),
        "warning": "This read-only report does not infer which legacy SQL migrations were applied.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=("staging", "production"), required=True)
    parser.add_argument("--database-id", required=True)
    parser.add_argument("--execution-id", default=os.environ.get("GITHUB_RUN_ID", ""))
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--wrangler", nargs="+", default=["npx", "wrangler"])
    parser.add_argument(
        "--inspect-baseline",
        action="store_true",
        help="read schema fingerprint and native D1 migration names without changing the database",
    )
    args = parser.parse_args()
    try:
        manifest = load_manifest()
        errors = validate_manifest(manifest)
        if errors:
            raise ReleaseError("; ".join(errors))
        d1 = WranglerD1(args.database_id, args.wrangler, args.environment)
        if args.inspect_baseline:
            print(json.dumps(inspect_baseline(
                d1,
                environment=args.environment,
                database_id=args.database_id,
                manifest=manifest,
            ), indent=2, sort_keys=True))
            return 0
        baseline_path = args.baseline or (BASELINE_DIR / f"{args.environment}.json")
        # Do not contact Cloudflare until source integrity and the explicit first-run
        # adoption artifact have both been checked locally.
        if not baseline_path.exists():
            raise ReleaseError(
                f"legacy baseline adoption is required; missing {baseline_path}. "
                "No remote D1 migration was attempted."
            )
        baseline = _load_baseline(baseline_path, args.environment, args.database_id, manifest)
        schema_version = run_migrations(
            d1,
            environment=args.environment,
            database_id=args.database_id,
            execution_id=args.execution_id,
            manifest=manifest,
            baseline=baseline,
        )
    except (ManifestError, ReleaseError, OSError) as exc:
        print(f"release migration failed closed: {exc}", file=sys.stderr)
        return 1
    print(f"D1 release migration ledger verified through {schema_version} in {args.environment}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
