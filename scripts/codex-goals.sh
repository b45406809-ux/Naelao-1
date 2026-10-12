#!/usr/bin/env bash
set -euo pipefail

# Start Codex CLI with the stable Goals feature enabled for this process.
# `run` is the script's non-interactive agent-loop entry point. This CLI has no
# `task run` subcommand; `codex exec` reads a prompt argument or stdin.
export CODEX_FEATURES_GOALS=true

if [[ "${1-}" == "run" ]]; then
  shift
  exec codex exec "$@"
fi

exec codex "$@"
