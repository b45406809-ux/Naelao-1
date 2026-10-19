# System One decision sentry

Naelao sends typed `choice`, `score`, and `noul` decisions through OpenRouter's Decisions API. The client validates each answer against the requested domain before it can affect routing. A network error, invalid response, or missing configuration leaves the call site on its deterministic fallback.

## OpenRouter configuration

The shared client uses the OpenRouter Decisions API directly; it does not send decisions through chat completions or Cloudflare's Workers AI binding.

```text
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer <OPENROUTER_API_KEY>
```

Configure `OPENROUTER_API_KEY` as a Worker secret for `naelao-agents` and `naelao-spaces` (Market Radar runs in the latter):

```powershell
pnpm exec wrangler secret put OPENROUTER_API_KEY
```

Supported models are intentionally allowlisted:

| Model ID | Use |
| --- | --- |
| `perplexity/pplx-decider-v1.2` | Default model and former Jev route |
| `perplexity/pplx-decider-flash-v1.2` | Former Clef Flash route |

Set `SYSTEM_ONE_MODEL` to one of those IDs to pin the model. For migration, the old `SYSTEM_ONE_PROVIDER=clef` setting still selects Decider Flash; old Jev or Laya selectors map to Decider V1.2. Old Jev and Clef model IDs are also translated to their mapped Decider IDs. Requests to any other model are rejected.

## Safety and observability

Run `pnpm verify:system-one` with `OPENROUTER_API_KEY` set before calling a deployment live. The smoke check sends the typed choice request used by Naelao and validates its choice domain, confidence, probability sum, resolved model, and token usage.

- Deterministic WriteGuard, mutation grants, moderation, and RiskGuard remain authoritative.
- System One may elevate an ambiguous command to Tier 6 but cannot downgrade a deterministic route.
- Market Radar accepts a typed ten-level Decider score only at confidence 0.75 or above; errors and low confidence preserve its bounded deterministic score.
- Air-gapped runs do not receive the remote decision client.
- Successful decisions emit `system_one.decision` Analytics Engine points with tenant/space/project scope, OpenRouter as provider, policy code, resolved model, latency, and input/output token counts.
- Current production call sites include native-runtime preflight, customer-message category/urgency triage, constrained multi-mention turn-holder routing, ambiguous-mutation WriteGuard review, residual financial-risk scoring, Market Radar scoring, worker capability selection, and the post-tool loop evaluator. Mention routing can choose only an explicitly named worker. WriteGuard's sentry may require an approval grant but can never waive a deterministic destructive-command match. Risk scoring cannot override deterministic stop-loss or drawdown rejection. High-confidence loop verdicts can request one final System 2 turn; they cannot execute or merge anything.

OpenRouter references:

- [Decisions API example](https://openrouter.ai/blog/insights/what-is-jev/)
- [Decider V1.2](https://openrouter.ai/perplexity/pplx-decider-v1.2)
- [Decider Flash V1.2](https://openrouter.ai/perplexity/pplx-decider-flash-v1.2)
