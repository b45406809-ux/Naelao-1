#!/usr/bin/env python3
"""Probe the public router and AgentPort after a Worker deployment."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "infra" / "release" / "deployment-manifest.json"
MAX_RESPONSE_BYTES = 64 * 1024
REQUIRED_DEPENDENCIES = (
    "auth", "spaces", "knowledge", "eval", "agents", "credentials",
    "analytics", "billing", "marketplace", "portal-router", "sandboxes",
)


class Response(Protocol):
    status: int

    def read(self, size: int = -1) -> bytes: ...
    def geturl(self) -> str: ...
    def close(self) -> None: ...


Opener = Callable[..., Response]


@dataclass(frozen=True)
class ProbeTarget:
    name: str
    url: str
    kind: str


@dataclass(frozen=True)
class ProbeResult:
    name: str
    ok: bool
    attempts: int
    latency_ms: int
    reason: str | None = None


def _origin(raw: str, name: str, allow_path: bool = False) -> str:
    if not isinstance(raw, str) or not raw:
        raise ValueError(f"{name} must be configured")
    parsed = urllib.parse.urlsplit(raw)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or (not allow_path and parsed.path not in ("", "/"))
        or parsed.port not in (None, 443)
    ):
        raise ValueError(f"{name} must be an HTTPS origin without credentials, path, query, or fragment")
    return f"https://{parsed.hostname.lower()}"


def build_targets(manifest: dict, environment: str, api_base_url: str) -> list[ProbeTarget]:
    if environment not in ("staging", "production"):
        raise ValueError("environment must be staging or production")
    probes = manifest.get("environments", {}).get(environment, {}).get("healthProbes")
    if not isinstance(probes, dict):
        raise ValueError(f"{environment} health probe configuration is missing")
    configured_api = probes.get("apiBaseUrl")
    api_origin = _origin(api_base_url, "API_BASE_URL")
    if api_origin != _origin(configured_api, "manifest apiBaseUrl"):
        raise ValueError("API_BASE_URL does not match the checked-in environment probe origin")
    agentport_origin = _origin(probes.get("agentPortBaseUrl"), "manifest agentPortBaseUrl")
    router_paths = probes.get("routerPaths")
    dependencies = probes.get("routerDependencies")
    if router_paths != ["/health", "/health/dependencies"]:
        raise ValueError("router health paths must include the router and dependency checks")
    if dependencies != list(REQUIRED_DEPENDENCIES):
        raise ValueError("router dependency probe inventory is stale")
    return [
        ProbeTarget("router", f"{api_origin}/health", "router"),
        ProbeTarget("router-dependencies", f"{api_origin}/health/dependencies", "dependencies"),
        ProbeTarget("agentport", f"{agentport_origin}/health", "agentport"),
    ]


def validate_payload(kind: str, environment: str, payload: object) -> str | None:
    if not isinstance(payload, dict):
        return "response JSON is not an object"
    if kind == "router":
        if payload.get("status") != "ok" or payload.get("env") != environment:
            return "router status or environment does not match the release"
    elif kind == "dependencies":
        if payload.get("ok") is not True:
            return "router dependency check is not healthy"
        if payload.get("checked") != len(REQUIRED_DEPENDENCIES) or payload.get("failed") != 0:
            return "router dependency counts do not match the configured release inventory"
    elif kind == "agentport":
        if payload.get("status") != "ok" or payload.get("service") != "AgentPort" or payload.get("env") != environment:
            return "AgentPort health identity is invalid"
    else:
        return "unknown health probe type"
    return None


def probe_target(
    target: ProbeTarget,
    environment: str,
    opener: Opener = urllib.request.urlopen,
    sleeper: Callable[[float], None] = time.sleep,
    attempts: int = 4,
    timeout_seconds: float = 4,
) -> ProbeResult:
    if attempts < 1:
        raise ValueError("attempts must be at least one")
    started = time.monotonic()
    last_reason = "probe did not run"
    for attempt in range(1, attempts + 1):
        response: Response | None = None
        try:
            request = urllib.request.Request(target.url, headers={"Accept": "application/json", "User-Agent": "naelao-release-health/1"})
            response = opener(request, timeout=timeout_seconds)
            if response.status != 200:
                last_reason = f"HTTP {response.status}"
            elif _origin(response.geturl(), "response URL", allow_path=True) != _origin(target.url, "probe URL", allow_path=True):
                last_reason = "health endpoint redirected to a different origin"
            else:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    last_reason = "response exceeded the health payload limit"
                else:
                    try:
                        payload = json.loads(raw)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        last_reason = "response was not valid JSON"
                    else:
                        last_reason = validate_payload(target.kind, environment, payload) or ""
                        if not last_reason:
                            latency = int((time.monotonic() - started) * 1000)
                            return ProbeResult(target.name, True, attempt, latency)
        except urllib.error.HTTPError as error:
            last_reason = f"HTTP {error.code}"
            error.close()
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError, ValueError) as error:
            last_reason = "network error" if not isinstance(error, ValueError) else str(error)
        finally:
            if response is not None:
                response.close()
        if attempt < attempts:
            sleeper(min(2 ** (attempt - 1), 4))
    latency = int((time.monotonic() - started) * 1000)
    return ProbeResult(target.name, False, attempts, latency, last_reason)


def run_probes(
    manifest: dict,
    environment: str,
    api_base_url: str,
    opener: Opener = urllib.request.urlopen,
    sleeper: Callable[[float], None] = time.sleep,
    attempts: int = 4,
) -> list[ProbeResult]:
    targets = build_targets(manifest, environment, api_base_url)
    return [probe_target(target, environment, opener, sleeper, attempts) for target in targets]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=("staging", "production"), required=True)
    parser.add_argument("--api-base-url", default=os.environ.get("API_BASE_URL", ""))
    args = parser.parse_args()
    if not args.api_base_url:
        print("API_BASE_URL is required", file=sys.stderr)
        return 2
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        results = run_probes(manifest, args.environment, args.api_base_url)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"deployment health probe configuration invalid: {error}", file=sys.stderr)
        return 2

    failed = [result for result in results if not result.ok]
    for result in results:
        message = f"{result.name}: {'ok' if result.ok else 'failed'} ({result.attempts} attempt(s), {result.latency_ms} ms)"
        if result.reason:
            message += f" — {result.reason}"
        print(message)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as summary:
            summary.write(f"\n### {args.environment.title()} Worker health probes\n\n")
            summary.writelines(f"- {'✅' if result.ok else '❌'} {result.name}: {'healthy' if result.ok else result.reason}\n" for result in results)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
