# System One decision sentry

Naelao uses one strict `choice` / `score` / `noul` client for both hosted TypeSafe Jev and the open-source Laya server. The client validates every answer against the requested domain before it can affect routing. A network error, invalid response, or missing configuration returns control to deterministic policy.

## Hosted Jev

The default endpoint is the official TypeSafe System One API:

```text
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
```

Configure the secret on both `naelao-agents` and `naelao-spaces` (Market Radar runs in the latter):

```powershell
pnpm exec wrangler secret put TYPESAFE_API_KEY
```

`SYSTEM_ONE_MODEL` is optional and defaults to `jev-latest`. Pin a version in production after calibrating thresholds.

## Self-hosted Laya

Laya ships a Jev-compatible HTTP server. It is a non-autoregressive decision model with its own PyTorch inference runtime; it is not an Ollama chat model and must not be routed through `/api/chat` or an OpenAI-compatible completion endpoint.

```powershell
py -m pip install "laya[serve]"
$env:LAYA_PRELOAD = "1"
laya-serve
```

The local endpoint is `http://127.0.0.1:8000/v1/systemone`. For local Wrangler development, put the exact reachable endpoint in `.dev.vars`:

```dotenv
SYSTEM_ONE_ENDPOINT=http://127.0.0.1:8000/v1/systemone
SYSTEM_ONE_PROVIDER=laya
SYSTEM_ONE_MODEL=jev-latest
```

If `LAYA_API_KEY` protects the server, store the same value as `TYPESAFE_API_KEY`. A deployed Cloudflare Worker cannot reach a developer laptop's loopback address; publish Laya behind an authenticated internal HTTPS endpoint or add a dedicated service/tunnel binding before using it in production.

## Safety and observability

Run `pnpm verify:system-one` against the configured provider before calling a deployment live. The
smoke check sends the exact typed choice wire shape used by Naelao and rejects a response that has
the wrong choice domain, confidence, probability sum, model, or token usage. It uses TypeSafe Jev by
default; set `SYSTEM_ONE_ENDPOINT` to an authenticated Laya endpoint to verify the self-hosted path.

- Deterministic WriteGuard, mutation grants, moderation, and RiskGuard remain authoritative.
- System One may elevate an ambiguous command to Tier 6 but cannot downgrade a deterministic route.
- Market Radar accepts a typed ten-level Jev/Laya score only at confidence 0.75 or above; errors and low confidence preserve its bounded deterministic score.
- Air-gapped runs do not receive the remote System One binding.
- Successful decisions emit `system_one.decision` Analytics Engine points with tenant/space/project scope, provider, policy code, resolved model, latency, and input/output token counts.
- Current production call sites are native-runtime preflight, customer-message category/urgency triage, constrained multi-mention turn-holder routing, ambiguous-mutation WriteGuard review, residual financial-risk scoring, Market Radar scoring, and a post-tool loop evaluator. Mention routing can choose only an explicitly named worker. WriteGuard's sentry may require an approval grant but can never waive a deterministic destructive-command match. Risk scoring cannot override deterministic stop-loss or drawdown rejection. High-confidence loop verdicts can request one final System 2 turn; they cannot execute or merge anything.

Official contracts:

- https://docs.typesafe.ai/api
- https://github.com/typesafe-ai/typesafe-sdk-js
- https://github.com/NandhaKishorM/laya/blob/main/docs/http-api.md
