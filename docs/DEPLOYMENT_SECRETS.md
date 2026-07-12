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

> **Vendor model (this deployment):** Billing is **Lemon Squeezy only** (Stripe removed). LLM
> inference goes through the **Cloudflare AI Gateway**, which holds the Anthropic key itself —
> so **no `ANTHROPIC_API_KEY` on any worker**. Both are reflected below.

## Tier 1 — Third-party keys the product cannot run without

| Key | Worker(s) | Where to get it |
|---|---|---|
| Cloudflare account: `CF_ACCOUNT_ID` + `CF_API_TOKEN` | deploy-time (wrangler/Terraform/CI), analytics, spaces, agents | [dash.cloudflare.com](https://dash.cloudflare.com) → account ID is in the URL/sidebar; token at My Profile → API Tokens. Deploy token needs Workers/D1/KV/R2/Queues/Vectorize/Pages edit. Additional scoped uses below. |
| **CF AI Gateway** — `NAELAO_ACCOUNT_ID`, `NAELAO_GATEWAY_ID`, `NAELAO_AIG_TOKEN` | agents | CF dashboard → AI → AI Gateway → create a gateway (e.g. `naelao-gateway`). In the gateway settings, **store your Anthropic key** (BYOK / provider keys) and **enable Authentication**; copy the gateway token. Then: `wrangler secret put NAELAO_ACCOUNT_ID`, `NAELAO_GATEWAY_ID`, `NAELAO_AIG_TOKEN`. This is the LLM brain — the gateway injects the provider key, so the worker never holds `ANTHROPIC_API_KEY`. Get the Anthropic key at [console.anthropic.com](https://console.anthropic.com) and paste it into the gateway, not into a worker secret. |
| `LEMON_SQUEEZY_API_KEY`, `LEMON_SQUEEZY_STORE_ID`, `LEMON_SQUEEZY_WEBHOOK_SECRET`, `LEMON_SQUEEZY_GROWTH_VARIANT_ID`, `LEMON_SQUEEZY_BUSINESS_VARIANT_ID` | billing | [app.lemonsqueezy.com](https://app.lemonsqueezy.com) → Settings → API (key), Settings → Stores (ID), Settings → Webhooks (create one pointing at `https://<router>/v1/webhooks/lemon-squeezy`, copy its signing secret). Create two **subscription** products for the builder Growth + Business plans and copy their variant IDs. The ONLY billing provider: builder platform plans AND product/seat/credit-pack/business-subscription checkouts and all money-in webhooks. |
| `RESEND_API_KEY` (+ `RESEND_API_URL` = `https://api.resend.com`) | notifications (hard-required) | [resend.com](https://resend.com) → API Keys. Also verify your sending domain there (DNS records). Powers email verification, password resets, approval-request emails, agent notifications — signup is functionally broken without it (credits are only granted on email verification). |
| `TOGETHER_API_KEY` (+ `TOGETHER_API_URL` = `https://api.together.xyz`) | together-ai (hard-required) | [api.together.ai](https://api.together.ai) → Settings → API Keys. Open-model inference the `together-ai` prebuilt exposes to agents. |

> **No `ANTHROPIC_API_KEY` worker secret.** The agents worker's `validateEnv` no longer requires
> it; the CF AI Gateway holds it. You *may* still set `ANTHROPIC_API_KEY` on the agents worker as
> a fallback for when the gateway isn't configured, but the intended production path is the gateway
> token. If neither the gateway token nor a key is set, LLM calls fail honestly (`no_llm_credentials`).

> **No Stripe.** `validateEnv` on the billing worker requires only `PLATFORM_SECRET`. The four
> `STRIPE_*` secrets are gone; `/webhooks/stripe` is removed.

## Tier 2 — Cloudflare-side setup (same account, extra provisioning)

| Item | Worker | How |
|---|---|---|
| `CF_SAAS_ZONE_ID` + a **zone-scoped** `CF_API_TOKEN` (SSL and Certificates: Edit) | spaces | CF dashboard → the naelao.com zone → Overview (zone ID); create a second, narrower token for CF-for-SaaS. Powers builder custom domains (`createCustomHostname` + DCV). Degrades honestly if absent — domains just can't be connected. |
| `CF_API_TOKEN` (agents, optional) | agents | Enables the AI Gateway Universal Endpoint's Workers AI *fallback* provider (cross-provider failover). Not needed for the primary Anthropic path. |
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
| `STRIPE_PLATFORM_SECRET_KEY` | billing | [dashboard.stripe.com](https://dashboard.stripe.com) → Developers → API keys (`sk_...`), with Connect enabled on the account. Wallet Connect's Stripe rail (§A1.29): creates Express connected accounts + direct-charge checkouts ONLY — platform billing stays Lemon Squeezy (item 45). Stripe wallet connect returns `stripe_not_configured` until set; a space with an already-ACTIVE Stripe connection fails CLOSED on checkout rather than falling back to Naelao's store. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | billing | Stripe Dashboard → Webhooks → add a **Connect** endpoint pointed at `/v1/webhooks/stripe` (listen to events on connected accounts: `checkout.session.completed`, `charge.refunded`, subscription events) → signing secret (`whsec_...`). Without it, Connect events 503 and orders don't sync. |
| `PUBLIC_WEBHOOK_BASE_URL` (var, not secret) | billing | Public base URL webhooks are reachable at (e.g. `https://api.naelao.com`). Used to auto-create per-connection Lemon Squeezy webhooks on a builder's OWN store; a connection still activates without it, surfaced as `webhook_created:false`. |

## NOT env vars — per-builder credentials entered in-product

These are the builder's OWN accounts, stored per-space via the credentials worker / connect
flows. Never platform secrets:

- **WhatsApp** (Meta Cloud API token + app secret for `X-Hub-Signature-256`), **Slack** signing
  secret, **Discord** public key, inbound **email** — via `POST /channels/:channel/connect`.
- **Whop / Gumroad** keys (`revenue-tracker`, connector catalogue's `WHOP_API_KEY`
  `credential_name`), any BYO MCP server auth — via space credentials.
- **Wallet Connect Lemon Squeezy** (§A1.29): the builder's own LS store API key + the generated
  per-connection webhook signing secret — vault-encrypted via the connect flow
  (`POST /billing/wallet/connect/lemon-squeezy`), only credential NAMES in D1.

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
3. CF AI Gateway: create the gateway, store your Anthropic key in it, enable Authentication, and
   set `NAELAO_ACCOUNT_ID` / `NAELAO_GATEWAY_ID` / `NAELAO_AIG_TOKEN` on agents. (No
   `ANTHROPIC_API_KEY` worker secret.)
4. Lemon Squeezy: key + store + webhook + the two plan variant IDs on billing (the ONLY billing
   provider — no Stripe).
5. Resend: key + verified domain on notifications.
6. `TOGETHER_API_KEY` on together-ai.
7. Deploy all workers (`--env production` — secrets are set PER environment), deploy Pages apps
   with `NEXT_PUBLIC_API_URL` including `/v1`.
8. Optional but recommended before real traffic: `TAVILY_API_KEY` (agents advertise web search),
   CF-for-SaaS zone token (custom domains).
