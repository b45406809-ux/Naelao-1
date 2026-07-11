# Naelao — Every API Key, Secret & Env Var Needed for Launchpad Go-Live

Grounded in the actual code (each worker's `Env` interface + `validateEnv()` + wrangler.toml),
not memory. Last verified against the repo at the go-live audit (CLAUDE.md item 44).

**Three facts up front:**

1. **Tests need ZERO real keys.** The full suite (1669 tests) runs green with fake constants —
   every test stubs its env. `cd tests && npx vitest run` works today with nothing set.
2. **Secrets are per-worker.** CF Workers Secrets are scoped to one worker (and one wrangler
   environment). `PLATFORM_SECRET` must be set with the SAME value on every worker that has it.
3. **The wrangler vars trap (item 41):** `[env.staging]`/`[env.production]` `vars` blocks REPLACE
   the top-level `[vars]`, they don't merge. Any plain var you rely on must be repeated per env
   (`wrangler-vars-parity.test.ts` guards this for the known ones).

How to set: `wrangler secret put NAME` (add `--env staging` / `--env production`) from inside
that worker's directory. For local dev, create `workers/<name>/.dev.vars` (gitignored,
`KEY=value` lines) — none exist in the repo yet.

---

## Tier 0 — Generated secrets (no signup; `openssl rand -hex 32` each)

| Secret | Workers that need it | Notes |
|---|---|---|
| `PLATFORM_SECRET` | router, spaces, agents, knowledge, credentials, billing, mcp-hub, admin, notifications, portal-router — effectively ALL | **Same value everywhere.** Signs the `x-naelao-internal-token` HMAC that every internal hop verifies; a mismatch = every cross-worker call 403s. Hard-required by most `validateEnv()`s. |
| `JWT_SECRET` | auth, router | Signs/verifies builder JWTs. Same value on both. |
| `CREDENTIAL_ENCRYPTION_KEY` | credentials | Encrypts BYO space credentials at rest. Hard-required. Losing it orphans every stored credential. |
| `WEBHOOK_SIGNING_SECRET` | notifications | Signs outbound webhook deliveries. Hard-required. |
| `ADMIN_SECRET` | admin | Gates the internal admin surface. Hard-required. |

## Tier 1 — Third-party keys the product cannot run without

| Key | Worker(s) | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | agents (hard-required) | [console.anthropic.com](https://console.anthropic.com) → API Keys. The reasoning loop's brain — nothing agentic works without it. |
| Cloudflare account: `CF_ACCOUNT_ID` + `CF_API_TOKEN` | deploy-time (wrangler/Terraform/CI), analytics, spaces, agents | [dash.cloudflare.com](https://dash.cloudflare.com) → account ID is in the URL/sidebar; token at My Profile → API Tokens. Deploy token needs Workers/D1/KV/R2/Queues/Vectorize/Pages edit. Two additional scoped uses below. |
| `LEMON_SQUEEZY_API_KEY`, `LEMON_SQUEEZY_STORE_ID`, `LEMON_SQUEEZY_WEBHOOK_SECRET` | billing | [app.lemonsqueezy.com](https://app.lemonsqueezy.com) → Settings → API (key), Settings → Stores (ID), Settings → Webhooks (create one pointing at `https://<router>/v1/webhooks/lemon-squeezy`, copy its signing secret). PRIMARY commerce rail: product/seat/credit-pack/business-subscription checkouts and all money-in webhooks. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_GROWTH_PRICE_ID`, `STRIPE_BUSINESS_PRICE_ID` | billing (ALL FOUR hard-required by `validateEnv`) | [dashboard.stripe.com](https://dashboard.stripe.com) → Developers → API keys; Developers → Webhooks (endpoint → signing secret); create two recurring Prices (Growth + Business plans) and copy their `price_...` IDs. This is the BUILDER's own platform-plan upgrade rail (`POST /billing/checkout`) — distinct from Lemon Squeezy, which handles the builders' end-user commerce. The worker won't boot without these. |
| `RESEND_API_KEY` (+ `RESEND_API_URL` = `https://api.resend.com`) | notifications (hard-required) | [resend.com](https://resend.com) → API Keys. Also verify your sending domain there (DNS records). Powers email verification, password resets, approval-request emails, agent notifications — signup is functionally broken without it (credits are only granted on email verification). |
| `TOGETHER_API_KEY` (+ `TOGETHER_API_URL` = `https://api.together.xyz`) | together-ai (hard-required) | [api.together.ai](https://api.together.ai) → Settings → API Keys. Open-model inference the `together-ai` prebuilt exposes to agents. |

## Tier 2 — Cloudflare-side setup (same account, extra provisioning)

| Item | Worker | How |
|---|---|---|
| `CF_SAAS_ZONE_ID` + a **zone-scoped** `CF_API_TOKEN` (SSL and Certificates: Edit) | spaces | CF dashboard → the naelao.com zone → Overview (zone ID); create a second, narrower token for CF-for-SaaS. Powers builder custom domains (`createCustomHostname` + DCV). Degrades honestly if absent — domains just can't be connected. |
| `NAELAO_ACCOUNT_ID` + `NAELAO_GATEWAY_ID` | agents | CF dashboard → AI → AI Gateway → create a gateway named `naelao-gateway`. Set the account ID via `wrangler secret put NAELAO_ACCOUNT_ID --env <env>` (defaults to `"placeholder"` = direct-Anthropic fallback, which works but loses gateway caching/retries/analytics). |
| `CF_ANALYTICS_API_TOKEN` | analytics | CF API token with Account Analytics: Read — lets the analytics worker query Analytics Engine's SQL API. |
| `CF_PAGES_TOKEN` (CI secret) | GitHub Actions | CF token with Pages: Edit. CI also needs `CF_ACCOUNT_ID` + `CF_API_TOKEN` as GitHub repo secrets (Settings → Secrets → Actions) — the only three CI secrets the workflows reference. |
| D1/KV/R2/Queues/Vectorize resources | all | Provisioned by `infra/terraform` (`terraform.tfvars` from the example file) or manually; wrangler.tomls reference them by binding. |

## Tier 3 — Optional platform keys (code degrades honestly without them)

| Key | Worker | Where / what breaks without it |
|---|---|---|
| `TAVILY_API_KEY` | knowledge | [app.tavily.com](https://app.tavily.com) → free API key. Agent `web-search` prebuilt's search/extract ops return `configured:false` until set (keyless SSRF-guarded `fetch` still works). |
| `COMPOSIO_API_KEY` | mcp-hub | [app.composio.dev](https://app.composio.dev) → Settings → API Keys. Platform-provided connector inventory (G-GRW01) — BYO credentials still work without it. |
| `PIPEDREAM_API_KEY` | mcp-hub | [pipedream.com](https://pipedream.com) → Settings → API. Same model as Composio. |
| `OPENAI_API_KEY` (+ `LLM_FALLBACK_MODEL`/`OPENAI_FALLBACK_MODEL`) | agents (NaelaoAgentDO) | [platform.openai.com](https://platform.openai.com) → API keys. Cross-provider LLM failover; Anthropic-only without it. |
| `CF_API_TOKEN` (agents) | agents | Workers AI fallback provider through the AI Gateway Universal Endpoint. Anthropic-only without it. |
| `EVAL_LLM_KEY` + `EVAL_LLM_URL` | eval | Any OpenAI-compatible endpoint used as the eval judge. Eval suites only. |
| `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY_BASE64`, `APNS_BUNDLE_ID`, `APNS_HOST` | notifications | Apple Developer account → Keys → APNs auth key (.p8, base64 it). Only for iOS push; email/webhooks work without. |

## NOT env vars — per-builder credentials entered in-product

These are the builder's OWN accounts, stored per-space via the credentials worker / connect
flows. Never platform secrets:

- **WhatsApp** (Meta Cloud API token + app secret for `X-Hub-Signature-256`), **Slack** signing
  secret, **Discord** public key, inbound **email** — via `POST /channels/:channel/connect`.
- **Whop / Gumroad** keys (`revenue-tracker`, connector catalogue's `WHOP_API_KEY`
  `credential_name`), any BYO MCP server auth — via space credentials.

## Plain config vars (wrangler `[vars]`, not secrets)

`ENVIRONMENT`, `CORS_ALLOWLIST`, `ALLOWED_ORIGINS`, `PORTAL_ORIGIN` (portal-router),
`PRODUCT_SHELL_URL` (spaces — makes verification emails carry a clickable link),
`PRODUCT_SUBDOMAIN_APEX` (e.g. `naelao.com`), `STOREFRONT_ROOT`, `PLATFORM_API_URL`,
`LLM_GATEWAY_URL`, `AGENTS_WORKER_URL`, `BUILDER_DASHBOARD_URL`, `LAUNCHPAD_FEE_BPS`
(platform fee, basis points), `RATE_LIMIT_*` (router). Remember the vars-replacement trap.

**Frontends (CF Pages build-time env):**
- `NEXT_PUBLIC_API_URL` — dashboard + shell. **Must include the `/v1` prefix**
  (e.g. `https://api.naelao.com/v1`) — every client call path omits it (item 41's finding).
- `NEXT_PUBLIC_DASHBOARD_URL` — shell → dashboard links.

## Minimum viable go-live checklist (in order)

1. Generate the five Tier-0 secrets; set `PLATFORM_SECRET` identically on every worker.
2. Cloudflare: account + deploy token; run Terraform (or create D1/KV/R2/Queues/Vectorize by
   hand); apply D1 migrations `infra/migrations/0001..`.
3. `ANTHROPIC_API_KEY` on agents.
4. Stripe: key + webhook + 2 price IDs on billing (worker won't boot without them).
5. Lemon Squeezy: key + store + webhook on billing.
6. Resend: key + verified domain on notifications.
7. `TOGETHER_API_KEY` on together-ai.
8. Deploy all workers (`--env production` — check secrets are set PER environment), deploy
   Pages apps with `NEXT_PUBLIC_API_URL` including `/v1`.
9. Optional but recommended before real traffic: `TAVILY_API_KEY` (agents advertise web
   search), CF-for-SaaS zone token (custom domains), AI Gateway IDs.
