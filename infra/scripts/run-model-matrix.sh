#!/usr/bin/env bash
# Run the agent-capability matrix across candidate models, ONE FRESH SESSION PER MODEL.
#
# Why not just `run-eval-suite.mjs --models a,b,c`: that reuses a single --session-id for every
# model, so the second model starts its run already able to read the FIRST model's conversation
# history. That is not a fair comparison — it is measuring model B's ability to read model A's
# homework. Each model gets its own clean session here, and the same space, dataset and ordering,
# so the only thing that varies between passes is the model.
#
# Also reports real neuron spend per model from Cloudflare's own billing, since on a capped free
# tier "what did this measurement cost" is part of the result, not an afterthought.
#
# Usage: run-model-matrix.sh <space-id> <token-file> <dataset> <model> [<model> ...]
set -uo pipefail

SPACE="$1"; shift
TOKEN_FILE="$1"; shift
DATASET="$1"; shift
BASE="${NAELAO_API_BASE:-https://naelao-router.crzzphillip.workers.dev/v1}"
TOKEN="$(cat "$TOKEN_FILE")"

# The ONLY authoritative answer to "is there budget left". The GraphQL analytics aggregate is not:
# a request rejected by the quota limiter consumes no neurons, so on a capped day analytics happily
# reports 0 used / 10,000 remaining while every real call fails. Worse, the free allocation is a
# ROLLING 24-HOUR window, not a calendar day — measured 2026-08-07 at 13,540 and 08-08 at 11,068
# neurons, both above the nominal 10,000 daily cap, which a per-day counter cannot explain.
#
# Trusting the aggregate produced a full matrix pass of avg_score=0.00 for two models that had in
# fact never run — precisely the instrument-failure-as-result mistake the trace grader exists to
# prevent, arriving from a direction nobody was watching. So: probe the real thing, and refuse to
# start rather than emit zeros that look like model failures.
quota_exhausted() {
  # shellcheck disable=SC1091
  source "$(git rev-parse --show-toplevel)/.cf-credentials.local"
  curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' 2>/dev/null | grep -q '"code":4006'
}

neurons_today() {
  # shellcheck disable=SC1091
  source "$(git rev-parse --show-toplevel)/.cf-credentials.local"
  local today; today=$(date -u +%Y-%m-%d)
  curl -s -X POST "https://api.cloudflare.com/client/v4/graphql" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    -d "{\"query\":\"query { viewer { accounts(filter: {accountTag: \\\"$CLOUDFLARE_ACCOUNT_ID\\\"}) { aiInferenceAdaptiveGroups(filter: {date_geq: \\\"$today\\\"}, limit: 100) { sum { totalNeurons } } } } }\"}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(int(sum(r['sum']['totalNeurons'] for r in d['data']['viewer']['accounts'][0]['aiInferenceAdaptiveGroups'])))" 2>/dev/null || echo 0
}

if quota_exhausted; then
  echo "REFUSING TO START: the Workers AI free allocation is currently exhausted."
  echo "Every run would fail with 4006 and be recorded as avg_score=0.00 — a quota wall that reads"
  echo "as 'these models are bad'. The allocation is a rolling 24h window, so it frees up gradually"
  echo "as the previous day's spend ages out; re-run then."
  exit 3
fi

for MODEL in "$@"; do
  SHORT="${MODEL##*/}"
  echo ""
  echo "############ $MODEL ############"
  # Re-check between models: a long matrix can cross the limit partway through, and half a pass is
  # not a cheaper measurement, it is a misleading one.
  if quota_exhausted; then
    echo "  !! allocation exhausted before this model ran — stopping rather than recording zeros."
    break
  fi

  SID=$(curl -s -X POST "$BASE/spaces/$SPACE/sessions" -H 'content-type: application/json' \
        -H "authorization: Bearer $TOKEN" -d '{}' \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('data') or d).get('id',''))")
  if [ -z "$SID" ]; then echo "  !! could not create a session; skipping"; continue; fi
  echo "  session: $SID"

  BEFORE=$(neurons_today)
  NAELAO_API_BASE="$BASE" NAELAO_TENANT_TOKEN="$TOKEN" \
    timeout 900 node "$(git rev-parse --show-toplevel)/infra/scripts/run-eval-suite.mjs" \
      --dataset "$DATASET" \
      --name "capability-matrix-$SHORT" \
      --space-id "$SPACE" \
      --session-id "$SID" \
      --trace-only 2>&1 | sed 's/^/  /'
  AFTER=$(neurons_today)

  echo "  >> neurons spent on $SHORT: $((AFTER - BEFORE))   (running total today: $AFTER / 10000)"
  if [ "$AFTER" -gt 8800 ]; then
    echo "  !! approaching the daily 10,000-neuron cap — stopping before the next model rather than"
    echo "     producing a half-measured pass that would read as a model failure."
    break
  fi
done
