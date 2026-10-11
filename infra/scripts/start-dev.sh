#!/usr/bin/env bash
set -euo pipefail
# The Node launcher shares topology, persistence and cleanup across all platforms.
exec node "$(dirname "${BASH_SOURCE[0]}")/start-dev.mjs" "$@"
