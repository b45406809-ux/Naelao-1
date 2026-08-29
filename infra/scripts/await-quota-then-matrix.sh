#!/usr/bin/env bash
# Wait for the Workers AI rolling-24h allocation to free up, then run the capability matrix.
#
# The allocation is a rolling window, not a daily reset (see run-model-matrix.sh). Capacity returns
# gradually as the previous day's heaviest hours age out, so the useful thing is not "retry at
# midnight" but "retry when the real limiter says yes". Probing costs ~1 neuron, so polling every
# 10 minutes is free in practice; guessing the moment wrongly is not, because a matrix started 5
# minutes early fails every case and records zeros that read as model failures.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SPACE="$1"; TOKEN_FILE="$2"; DATASET="$3"; shift 3
OUT="${OUT:-/tmp/matrix-result.log}"
MAX_WAIT_MIN="${MAX_WAIT_MIN:-420}"

# shellcheck disable=SC1091
source "$ROOT/.cf-credentials.local"

probe_ok() {
  ! curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
      -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' 2>/dev/null | grep -q '"code":4006'
}

{
  echo "=== awaiting Workers AI capacity (max ${MAX_WAIT_MIN}m) — started $(date -u +%H:%MZ) ==="
  waited=0
  until probe_ok; do
    if [ "$waited" -ge "$MAX_WAIT_MIN" ]; then
      echo "!! gave up after ${waited}m — allocation never freed. Nothing measured; no zeros recorded."
      exit 4
    fi
    sleep 600
    waited=$((waited + 10))
    [ $((waited % 30)) -eq 0 ] && echo "  … still capped after ${waited}m ($(date -u +%H:%MZ))"
  done
  echo "=== capacity available at $(date -u +%H:%MZ) after ${waited}m — running matrix ==="
  "$ROOT/infra/scripts/run-model-matrix.sh" "$SPACE" "$TOKEN_FILE" "$DATASET" "$@"
  echo "=== matrix finished $(date -u +%H:%MZ) ==="
} >> "$OUT" 2>&1
