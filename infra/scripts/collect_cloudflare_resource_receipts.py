#!/usr/bin/env python3
"""Collect source-matched Cloudflare resource existence receipts using GET requests only.

This records observed existence, not environment ownership, resource isolation, or deployment
acceptance. Those facts must still be reviewed independently before a release can proceed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[2]
WORKERS = ROOT / "workers"
MAP_PATH = ROOT / "infra" / "environment" / "resource-map.json"
API_BASE = "https://api.cloudflare.com/client/v4"
ACCOUNT_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{32}$")
MAX_PAGES = 100


class ReceiptCollectionError(RuntimeError):
    pass


class CloudflareReadOnlyApi:
    """Small GET-only API client. The token is held in memory and never included in errors."""

    def __init__(self, account_id: str, token: str, *, base_url: str = API_BASE,
                 opener: Callable[..., Any] | None = None) -> None:
        if not ACCOUNT_ID_PATTERN.fullmatch(account_id) or not token.strip():
            raise ReceiptCollectionError("cloudflare_account_or_token_invalid")
        self.account_id = account_id
        self._token = token
        self.base_url = base_url.rstrip("/")
        self._opener = opener or urllib.request.urlopen

    def get(self, path: str, params: dict[str, str | int] | None = None) -> tuple[dict[str, Any], str]:
        if not path.startswith("/") or path.startswith("//"):
            raise ReceiptCollectionError("cloudflare_api_path_invalid")
        query = urllib.parse.urlencode(params or {})
        url = f"{self.base_url}{path}" + (f"?{query}" if query else "")
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {self._token}",
                                                       "Accept": "application/json"}, method="GET")
        try:
            with self._opener(request, timeout=20) as response:
                if not str(response.geturl()).startswith(self.base_url + "/"):
                    raise ReceiptCollectionError("cloudflare_api_redirect_rejected")
                payload = json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise ReceiptCollectionError(f"cloudflare_api_http_{error.code}:{path}") from None
        except urllib.error.URLError:
            raise ReceiptCollectionError(f"cloudflare_api_unavailable:{path}") from None
        except (TimeoutError, OSError, json.JSONDecodeError):
            raise ReceiptCollectionError(f"cloudflare_api_response_invalid:{path}") from None
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise ReceiptCollectionError(f"cloudflare_api_unsuccessful:{path}")
        return payload, url

    def pages(self, path: str, *, result_key: str | None = None) -> tuple[list[dict[str, Any]], list[str]]:
        rows: list[dict[str, Any]] = []
        sources: list[str] = []
        for page in range(1, MAX_PAGES + 1):
            payload, source = self.get(path, {"page": page, "per_page": 100})
            sources.append(source)
            result = payload.get("result")
            items = result.get(result_key) if result_key and isinstance(result, dict) else result
            if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                raise ReceiptCollectionError(f"cloudflare_api_list_invalid:{path}")
            rows.extend(items)
            info = payload.get("result_info")
            if isinstance(info, dict) and isinstance(info.get("total_pages"), int):
                if page >= info["total_pages"]:
                    return rows, sources
            elif len(items) < 100:
                return rows, sources
        raise ReceiptCollectionError(f"cloudflare_api_pagination_limit:{path}")

    def r2_buckets(self, name: str) -> tuple[list[dict[str, Any]], list[str]]:
        buckets: list[dict[str, Any]] = []
        sources: list[str] = []
        cursor: str | None = None
        for _ in range(MAX_PAGES):
            params: dict[str, str | int] = {"name_contains": name, "per_page": 1000}
            if cursor:
                params["cursor"] = cursor
            payload, source = self.get(f"/accounts/{self.account_id}/r2/buckets", params)
            sources.append(source)
            result = payload.get("result")
            items = result.get("buckets") if isinstance(result, dict) else None
            if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                raise ReceiptCollectionError("cloudflare_api_list_invalid:/r2/buckets")
            buckets.extend(items)
            info = payload.get("result_info")
            next_cursor = info.get("cursor") if isinstance(info, dict) else None
            if not next_cursor:
                return buckets, sources
            if not isinstance(next_cursor, str) or next_cursor == cursor:
                raise ReceiptCollectionError("cloudflare_api_cursor_invalid:/r2/buckets")
            cursor = next_cursor
        raise ReceiptCollectionError("cloudflare_api_pagination_limit:/r2/buckets")


def _account_path(account_id: str, suffix: str) -> str:
    return f"/accounts/{urllib.parse.quote(account_id, safe='')}/{suffix}"


def durable_object_namespace_owners(workers_dir: Path, environment: str) -> dict[str, str]:
    owners: dict[str, set[str]] = {}
    for path in sorted(workers_dir.glob("*/wrangler.toml")):
        parsed = tomllib.loads(path.read_text(encoding="utf-8"))
        env = parsed.get("env", {}).get(environment)
        if not isinstance(env, dict):
            continue
        local_script = str(env.get("name") or f"{parsed.get('name', path.parent.name)}-{environment}")
        durable_objects = env.get("durable_objects")
        bindings = durable_objects.get("bindings", []) if isinstance(durable_objects, dict) else []
        for binding in bindings if isinstance(bindings, list) else []:
            if not isinstance(binding, dict) or not isinstance(binding.get("class_name"), str):
                continue
            script = binding.get("script_name")
            owners.setdefault(binding["class_name"], set()).add(script if isinstance(script, str) and script else local_script)
    ambiguous = {name: sorted(scripts) for name, scripts in owners.items() if len(scripts) != 1}
    if ambiguous:
        names = ",".join(sorted(ambiguous))
        raise ReceiptCollectionError(f"durable_object_namespace_owner_ambiguous:{environment}:{names}")
    return {name: next(iter(scripts)) for name, scripts in owners.items()}


def _result(payload: dict[str, Any], path: str) -> dict[str, Any]:
    result = payload.get("result")
    if not isinstance(result, dict):
        raise ReceiptCollectionError(f"cloudflare_api_resource_invalid:{path}")
    return result


def _exactly_one(rows: list[dict[str, Any]], predicate: Callable[[dict[str, Any]], bool], label: str) -> dict[str, Any]:
    matches = [row for row in rows if predicate(row)]
    if len(matches) != 1:
        raise ReceiptCollectionError(f"cloudflare_resource_match_count_{len(matches)}:{label}")
    return matches[0]


def collect_receipts(api: CloudflareReadOnlyApi, source_map: dict[str, Any], observer: str,
                     workers_dir: Path = WORKERS) -> dict[str, Any]:
    if not observer.strip() or len(observer.strip()) > 160:
        raise ReceiptCollectionError("resource_receipt_observer_invalid")
    required = source_map.get("required_existence_receipts")
    if not isinstance(required, list) or not required:
        raise ReceiptCollectionError("resource_receipt_requirements_missing")
    rows: list[dict[str, Any]] = []

    def add(kind: str, environment: str, name: str, resource_id: str, source: str) -> None:
        if not resource_id.strip():
            raise ReceiptCollectionError(f"cloudflare_resource_id_missing:{kind}:{environment}:{name}")
        rows.append({"kind": kind, "environment": environment, "id_or_name": name,
                     "resource_id": resource_id, "evidence_source": source, "observer": observer.strip(),
                     "read_only": True})

    required_pairs = sorted({(row["kind"], row["environment"], row["id_or_name"]) for row in required})
    for kind, environment, name in required_pairs:
        if environment not in {"staging", "production"}:
            raise ReceiptCollectionError(f"resource_receipt_environment_invalid:{environment}")
        encoded_name = urllib.parse.quote(name, safe="")
        if kind == "d1":
            path = _account_path(api.account_id, f"d1/database/{encoded_name}")
            payload, source = api.get(path)
            resource = _result(payload, path)
            if resource.get("uuid") != name:
                raise ReceiptCollectionError(f"cloudflare_resource_identity_mismatch:d1:{environment}:{name}")
            add(kind, environment, name, str(resource["uuid"]), source)
        elif kind == "kv":
            path = _account_path(api.account_id, f"storage/kv/namespaces/{encoded_name}")
            payload, source = api.get(path)
            resource = _result(payload, path)
            if resource.get("id") != name:
                raise ReceiptCollectionError(f"cloudflare_resource_identity_mismatch:kv:{environment}:{name}")
            add(kind, environment, name, str(resource["id"]), source)
        elif kind == "r2":
            buckets, sources = api.r2_buckets(name)
            bucket = _exactly_one(buckets, lambda item: item.get("name") == name, f"r2:{environment}:{name}")
            add(kind, environment, name, str(bucket["name"]), sources[-1])
        elif kind == "vectorize":
            path = _account_path(api.account_id, f"vectorize/v2/indexes/{encoded_name}")
            payload, source = api.get(path)
            resource = _result(payload, path)
            if resource.get("name") != name:
                raise ReceiptCollectionError(f"cloudflare_resource_identity_mismatch:vectorize:{environment}:{name}")
            add(kind, environment, name, str(resource["name"]), source)
        elif kind == "queue":
            path = _account_path(api.account_id, "queues")
            queues, sources = api.pages(path)
            queue = _exactly_one(queues, lambda item: item.get("queue_name") == name, f"queue:{environment}:{name}")
            resource_id = queue.get("queue_id")
            if not isinstance(resource_id, str) or not resource_id:
                raise ReceiptCollectionError(f"cloudflare_resource_id_missing:queue:{environment}:{name}")
            add(kind, environment, name, resource_id, sources[-1])
        elif kind == "workflow":
            path = _account_path(api.account_id, f"workflows/{encoded_name}")
            payload, source = api.get(path)
            resource = _result(payload, path)
            workflow_name = resource.get("name") or resource.get("workflow_name")
            if workflow_name is not None and workflow_name != name:
                raise ReceiptCollectionError(f"cloudflare_resource_identity_mismatch:workflow:{environment}:{name}")
            resource_id = resource.get("id")
            if not isinstance(resource_id, str) or not resource_id:
                raise ReceiptCollectionError(f"cloudflare_resource_id_missing:workflow:{environment}:{name}")
            add(kind, environment, name, resource_id, source)
        elif kind == "durable_object":
            owners = durable_object_namespace_owners(workers_dir, environment)
            expected_script = owners.get(name)
            if not expected_script:
                raise ReceiptCollectionError(f"durable_object_namespace_owner_missing:{environment}:{name}")
            path = _account_path(api.account_id, "workers/durable_objects/namespaces")
            namespaces, sources = api.pages(path)
            namespace = _exactly_one(namespaces, lambda item: item.get("class") == name and item.get("script") == expected_script,
                                     f"durable_object:{environment}:{expected_script}:{name}")
            namespace_id = namespace.get("id")
            if not isinstance(namespace_id, str) or not namespace_id:
                raise ReceiptCollectionError(f"cloudflare_resource_id_missing:durable_object:{environment}:{name}")
            add(kind, environment, name, namespace_id, sources[-1])
        else:
            raise ReceiptCollectionError(f"resource_receipt_kind_unsupported:{kind}")

    return {"version": 1, "account_id": api.account_id, "observed_at": datetime.now(timezone.utc).isoformat(),
            "resources": sorted(rows, key=lambda row: (row["kind"], row["environment"], row["id_or_name"]))}


def _load_source_map(path: Path) -> dict[str, Any]:
    try:
        source_map = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise ReceiptCollectionError("resource_map_unavailable_or_invalid") from None
    if not isinstance(source_map, dict) or source_map.get("status") != "source_inventory_only":
        raise ReceiptCollectionError("resource_map_invalid")
    return source_map


def _load_current_source_map(resource_map_path: Path, workers_dir: Path) -> dict[str, Any]:
    source_map = _load_source_map(resource_map_path)
    from validate_environment_resources import build_source_map

    source_now = build_source_map(workers_dir)
    if source_now != source_map:
        raise ReceiptCollectionError("resource_map_stale_regenerate_source_map_first")
    return source_now


def _write_output(path: Path, payload: dict[str, Any], replace_existing: bool) -> None:
    if path.exists() and not replace_existing:
        raise ReceiptCollectionError("output_exists_use_replace_existing")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.",
                                         suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            handle.write(json.dumps(payload, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError:
        if temporary:
            Path(temporary).unlink(missing_ok=True)
        raise ReceiptCollectionError("resource_receipt_write_failed") from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", default=os.environ.get("CLOUDFLARE_ACCOUNT_ID"))
    parser.add_argument("--observer", required=True, help="Person or approved inventory process performing the read-only check")
    parser.add_argument("--resource-map", type=Path, default=MAP_PATH)
    parser.add_argument("--workers-dir", type=Path, default=WORKERS)
    parser.add_argument("--output", type=Path, help="Write receipts to a new file; omit to print JSON to stdout")
    parser.add_argument("--replace-existing", action="store_true", help="Allow replacing the explicit --output file")
    args = parser.parse_args()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not args.account_id or not ACCOUNT_ID_PATTERN.fullmatch(args.account_id):
        parser.error("set CLOUDFLARE_ACCOUNT_ID or pass a 32-character hexadecimal --account-id")
    try:
        source_map = _load_current_source_map(args.resource_map, args.workers_dir)
        api = CloudflareReadOnlyApi(args.account_id, token)
        payload = collect_receipts(api, source_map, args.observer, args.workers_dir)
        if args.output:
            _write_output(args.output, payload, args.replace_existing)
            print(f"Wrote {len(payload['resources'])} read-only resource receipts to {args.output}")
        else:
            print(json.dumps(payload, indent=2))
    except ReceiptCollectionError as error:
        print(f"Resource receipt collection stopped: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
