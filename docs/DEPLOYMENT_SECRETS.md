# Naelao — Every API Key, Secret & Env Var Needed for Launchpad Go-Live

Grounded in the actual code (each worker's `Env` interface + `validateEnv()` + wrangler.toml),
not memory. Last verified against the repo at the Whop autonomous-wallet rebuild (CLAUDE.md item 50).

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
| `LEMON_SQUEEZY_API_KEY`, `LEMON_SQUEEZY_STORE_ID`, `LEMON_SQUEEZY_WEBHOOK_SECRET`, `LEMON_SQUEEZY_GROWTH_VARIANT_ID`, `LEMON_SQUEEZY_BUSINESS_VARIANT_ID` | billing | [app.lemonsqueezy.com](https://app.lemonsqueezy.com) → Settings → API (key), Settings → Stores (ID), Settings → Webhooks (create one pointing at `https://<router>/v1/webhooks/lemon-squeezy`, copy its signing secret). Create two **subscription** products for the builder Growth + Business plans and copy their variant IDs. A fallback platform billing provider — Whop (below) is tried first when configured; LS is used when Whop isn't, and always for product/seat/credit-pack/business-subscription checkouts a business hasn't connected its own Whop account for. |
| **Whop as a second PLATFORM billing provider** — `WHOP_API_KEY`, `WHOP_GROWTH_PLAN_ID`, `WHOP_BUSINESS_PLAN_ID`, `WHOP_PLATFORM_PLAN_WEBHOOK_SECRET` | billing | Added because Lemon Squeezy's own onboarding requires a Stripe-linked payout path unavailable in some sellers' countries (AUDIT_TODO.md AI-7). This is Naelao's OWN **normal** Whop seller/company account — sign up at [whop.com](https://whop.com) like any creator, no invite needed (a completely different relationship than `WHOP_PLATFORM_API_KEY` below, which needs Whop's invite-only Platforms API). In your Whop company dashboard: **Settings → API** for `WHOP_API_KEY`; create two recurring **Plans** for the Growth/Business tiers and copy their plan ids; **Settings → Webhooks** → create one pointing at `https://<billing-worker>/webhooks/whop-platform-plan` and copy its signing secret into `WHOP_PLATFORM_PLAN_WEBHOOK_SECRET` (a DIFFERENT secret than `WHOP_WEBHOOK_SECRET` below — that one verifies a BUSINESS's own sub-merchant company's webhook, this verifies Naelao's own company's). `/billing/checkout` tries Whop first, falls back to Lemon Squeezy, then a dev placeholder. `/billing/portal` returns Whop's fixed self-serve orders page (`whop.com/orders/` — Whop has no per-customer-mintable portal session) when the org's subscription is Whop-backed. |
| **Whop OAuth-delegated checkout** (end-user subscriptions/credit-packs settling into a BUSINESS's own connected Whop company) | billing, agents | No new secret — reuses the "Connect with Whop" OAuth flow's existing `WHOP_OAUTH_CLIENT_ID`/`WHOP_OAUTH_CLIENT_SECRET` (see the WHOP connector row further down) and its vaulted `WHOP_OAUTH_TOKENS` credential per business. Scopes were widened to include `checkout_configuration:create`, `plan:create`, `access_pass:create`/`update`, `checkout_configuration:basic:read` — a business that connected Whop BEFORE this change must reconnect once to grant the new scopes. `/internal/business-subscriptions/checkout` and `/internal/credit-packs/checkout` try this path first (settles 100% into that business's own Whop balance — Naelao's cut is NOT auto-split here; it reaches the ledger via the existing revenue-tracker prebuilt's periodic poll of that same account), falling back to Lemon Squeezy/dev placeholder when the business has no Whop connection. |
| `RESEND_API_KEY` (+ `RESEND_API_URL` = `https://api.resend.com`) | notifications (hard-required) | [resend.com](https://resend.com) → API Keys. Also verify your sending domain there (DNS records). Powers email verification, password resets, approval-request emails, agent notifications — signup is functionally broken without it (credits are only granted on email verification). |
| `TOGETHER_API_KEY` (+ `TOGETHER_API_URL` = `https://api.together.xyz`) | together-ai (hard-required) | [api.together.ai](https://api.together.ai) → Settings → API Keys. Open-model inference the `together-ai` prebuilt exposes to agents. |

> **No `ANTHROPIC_API_KEY` worker secret.** The agents worker's `validateEnv` no longer requires
> it; the CF AI Gateway holds it. You *may* still set `ANTHROPIC_API_KEY` on the agents worker as
> a fallback for when the gateway isn't configured, but the intended production path is the gateway
> token. If neither the gateway token nor a key is set, LLM calls fail honestly (`no_llm_credentials`).

> **No Stripe.** `validateEnv` on the billing worker requires only `PLATFORM_SECRET`. The four
> `STRIPE_*` secrets are gone; `/webhooks/stripe` is removed. Wallet Connect (the Stripe/LS
> per-business connected-account rail) is also gone entirely — every business's OWN revenue
> custody now runs through the Whop sub-merchant wallet model (`WHOP_PLATFORM_API_KEY` below),
> auto-provisioned at business creation, no builder action required.

## Tier 2 — Cloudflare-side setup (same account, extra provisioning)

| Item | Worker | How |
|---|---|---|
| `CF_SAAS_ZONE_ID` + a **zone-scoped** `CF_API_TOKEN` (SSL and Certificates: Edit) | spaces | CF dashboard → the naelao.com zone → Overview (zone ID); create a second, narrower token for CF-for-SaaS. Powers builder custom domains (`createCustomHostname` + DCV). Degrades honestly if absent — domains just can't be connected. |
| `CF_API_TOKEN` (agents, optional) | agents | Enables the AI Gateway Universal Endpoint's Workers AI *fallback* provider (cross-provider failover). Not needed for the primary Anthropic path. |
| `CF_ANALYTICS_API_TOKEN` | analytics | CF API token with Account Analytics: Read — lets the analytics worker query Analytics Engine's SQL API. |
| `CF_PAGES_TOKEN` (CI secret) | GitHub Actions | CF token with Pages: Edit. Deployment workflows also need `CF_ACCOUNT_ID` + `CF_API_TOKEN` as GitHub repository secrets (Settings → Secrets → Actions). |
| `GEMINI_API_KEYS` (CI secret) | GitHub Actions, full-plan implementation workflow only | One Google AI Studio key or a comma-separated rotation of free-tier keys. `run-phase.mjs` sends full Repomix packs to the configured Gemini models and rotates keys/models on quota or transient provider failure. This secret is never exposed to Workers or packed into Repomix. Missing configuration fails before any model call or branch mutation. Rotate by replacing compromised keys in the repository secret; test with a single dry phase before running all 13. |
| D1/KV/R2/Queues/Vectorize resources | all | Provisioned by `infra/terraform` (`terraform.tfvars` from the example file) or manually; wrangler.tomls reference them by binding. |

## Tier 3 — Optional platform keys (code degrades honestly without them)

| Key | Worker | Where / what breaks without it |
|---|---|---|
| `TAVILY_API_KEY` | knowledge | [app.tavily.com](https://app.tavily.com) → free API key. Agent `web-search` prebuilt's search/extract ops return `configured:false` until set (keyless SSRF-guarded `fetch` still works). |
| `COHERE_API_KEY` | knowledge | Cohere production API key used only by `parse-v5.0` document ingestion. Required for PDF/layout-sensitive uploads; that ingestion fails closed with an honest unavailable/provider error when missing or rejected. Rotate in Cohere, update staging, verify ingestion, then production. |
| `AGENTMAIL_API_KEY` | agents | **SET and live-verified 2026-07-30** ([agentmail.to](https://www.agentmail.to) console → API key). Auto-provisions a REAL, inbound-capable business mailbox per business (AgentMail hosts the domain, so no Naelao DNS zone is needed — this is what unblocks inbound business email). Without it, `business-email` provision reports `inbound:false` and send falls back to Resend (outbound-only); the provisioner's auto-seed no-ops. The inbound webhook is registered at `{PUBLIC_AGENTS_URL}/channels/email/agentmail-inbound/{spaceId}` (Svix-verified) — `PUBLIC_AGENTS_URL` must be set for inbound to wire. NOTE: usernames are unique across AgentMail's WHOLE customer base, not per-account — `uniqueInboxUsername()` appends a spaceId-derived suffix to avoid collisions (a real one was hit live provisioning the platform's own `launchpad` business before this fix). |
| `COMPOSIO_API_KEY` | mcp-hub | [app.composio.dev](https://app.composio.dev) → Settings → API Keys. Platform-provided connector inventory (G-GRW01) — BYO credentials still work without it. |
| `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET` | mcp-hub, agents | [pipedream.com](https://pipedream.com) workspace → Settings → API → create an OAuth client. **Not a simple API key** — Pipedream's REST API (including Connect) is OAuth `client_credentials`-only (verified against Pipedream's own docs); both workers exchange these for a short-lived (1hr) access token themselves (mcp-hub for the tool-call proxy side, agents for starting/polling a connection — same "two workers, one secret" split as `COMPOSIO_API_KEY`/`WHOP_OAUTH_CLIENT_*`). Same doctrine as Composio: BYO credentials still work without it. |
| `PIPEDREAM_PROJECT_ID` (agents only) | agents | [pipedream.com](https://pipedream.com) → your Connect project → Settings. Scopes every Connect token/account call to one project. Without it, the pipedream-routed connect flow returns `provider_not_configured`. |
| `PIPEDREAM_ENVIRONMENT` (var, not secret — mcp-hub + agents) | mcp-hub, agents | `"development"` or `"production"`, sent as `x-pd-environment` on every Pipedream Connect call. Defaults to `"development"` when unset — set to `"production"` on the production environment so Connect resolves live (not test) app credentials. |
| `COMPOSIO_API_KEY` (agents, a SEPARATE copy of the same value) | agents | Needed on the agents worker too (not just mcp-hub) to INITIATE a Composio "Connect Link" hosted-auth flow (`POST /connectors/:platform/provider-connect/start` — CLAUDE.md item 56); mcp-hub's own copy only handles the tool-call proxy side. Without it, provider-connect routes return `provider_not_configured`. |
| `COMPOSIO_TWITTER_AUTH_CONFIG_ID`, `COMPOSIO_LINKEDIN_AUTH_CONFIG_ID`, `COMPOSIO_INSTAGRAM_AUTH_CONFIG_ID`, `COMPOSIO_TIKTOK_AUTH_CONFIG_ID` (+ `COMPOSIO_HUBSPOT_AUTH_CONFIG_ID`/`COMPOSIO_GOOGLE_ADS_AUTH_CONFIG_ID`/`COMPOSIO_META_ADS_AUTH_CONFIG_ID`/`COMPOSIO_AGENTMAIL_AUTH_CONFIG_ID` once those flip to `available`) | agents | [app.composio.dev](https://app.composio.dev) → Auth Configs → create one per app (this is where the app's own OAuth client id/secret/scopes are registered, once, in Composio's dashboard — never in Naelao's code). Copy the resulting Auth Config id into this env var. One per connector; without it, that specific app's Connect button returns `provider_not_configured` while every other connector keeps working. |
| `HIGGSFIELD_API_KEY` | *(not a platform secret — a per-space BYO credential)* | This is the ONE growth-layer connector that is NOT platform-keyed: Higgsfield ships its own hosted MCP server and a business connects with their OWN Higgsfield account key (same manual-paste flow as Whop's `WHOP_API_KEY`), vaulted per-space via the normal connect flow — nothing to configure platform-wide. |
| `OPENAI_API_KEY` (+ `LLM_FALLBACK_MODEL`/`OPENAI_FALLBACK_MODEL`) | agents (NaelaoAgentDO) | [platform.openai.com](https://platform.openai.com) → API keys. Cross-provider LLM failover; Anthropic-only without it. |
| `CF_API_TOKEN` (agents) | agents | Workers AI fallback provider through the AI Gateway Universal Endpoint. Anthropic-only without it. |
| `NAELAO_AIG_TOKEN` (eval, a SEPARATE copy of the same value as every other worker's) | eval | §A1 Harness Excellence Phase HX3: the eval worker's judge call now routes through the CF AI Gateway (`NAELAO_ACCOUNT_ID`/`NAELAO_GATEWAY_ID` vars already set in `wrangler.toml`) exactly like every other LLM call site since item 45's vendor cutover — this worker was the one missed spot. `EVAL_LLM_KEY` (optional) is a fallback direct Anthropic key for local/offline testing without a gateway; with `NAELAO_AIG_TOKEN` set, neither `EVAL_LLM_KEY` nor a per-worker Anthropic key is needed. |
| `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY_BASE64`, `APNS_BUNDLE_ID`, `APNS_HOST` | notifications | Apple Developer account → Keys → APNs auth key (.p8, base64 it). Only for iOS push; email/webhooks work without. |
| `WHOP_PLATFORM_API_KEY` | billing | **Access to this API is invite-only** — Whop calls the feature "Platforms" / "connected accounts" (the sub-merchant model this wallet system uses). Apply via `sales@whop.com` (or your Whop account rep) describing the use case: "our platform provisions an isolated payment account per business created on it." Once approved: [dev.whop.com](https://dev.whop.com) → your Whop Platform account → API keys. Naelao's ONE master Whop Platform key (universal-tools doctrine, like `COMPOSIO_API_KEY`) — auto-provisions an isolated connected-account company per business, reads balances, creates checkouts, issues withdrawals. Without it (or before approval), every business's wallet stays `status: "error"` (never fabricates a company id) — the rest of the platform works normally; only the wallet feature is unavailable. |
| `WHOP_WEBHOOK_SECRET` | billing | Whop dashboard → your Platform account → Webhooks → add an endpoint pointed at `/v1/webhooks/whop` → signing secret. Without it, `/webhooks/whop` returns `whop_not_configured` and revenue events never sync. |
| `WHOP_OAUTH_CLIENT_ID`, `WHOP_OAUTH_CLIENT_SECRET` (+ `PUBLIC_AGENTS_URL` var) | agents, billing | **Self-serve, no invite needed** — a completely separate mechanism from `WHOP_PLATFORM_API_KEY` above (Whop's normal, generally-available OAuth2+PKCE "Sign in with Whop" app model). Whop Developer Dashboard → create an app → OAuth section → add redirect URI `{PUBLIC_AGENTS_URL}/connectors/whop/oauth/callback` (exact match required) → copy `client_id`/`client_secret`, and grant the checkout-creation scopes (`checkout_configuration:create`, `plan:create`, `access_pass:create`/`update`, `checkout_configuration:basic:read`) alongside the original read scopes. Powers the "Connect with Whop" button (a business owner's OWN account: read-only mcp-connector ops, AND — since the AI-7 billing pivot — creating checkout links for that business's own end-user subscriptions/credit-packs, see `whop-oauth-billing.ts`; Naelao's platform-subscription cut is billed via the existing revenue-tracker surcharge, not auto-split at checkout). Without these, the OAuth start route returns `oauth_not_configured` — the manual-API-key-paste connect flow still works regardless. A business connected BEFORE the AI-7 scope widening must reconnect once. |

> **Two separate Whop concepts, don't conflate them:** the business-wallet rail above (invite-only
> Platforms API, per-business connected accounts) is entirely separate from Naelao's OWN platform
> billing (builder plans, seat/credit-pack/business-subscription checkouts), which stays Lemon
> Squeezy only — see item 45/the `LEMON_SQUEEZY_*` row above, untouched by the wallet feature.
> Whop's normal (non-Platforms) product API — a single business selling its own subscriptions
> directly, no invite required — is a real alternative worth considering for Naelao's OWN plan
> billing someday, but that would be a separate, deliberate integration decision, not something
> this build does implicitly.
>
> **Connected accounts have two readiness states, not one:** enrolling a business (`POST
> /v5/platforms/sub_merchants`) creates the company record instantly, but per Whop's own docs a
> recipient with no prior Whop account must ALSO complete an emailed KYC/onboarding link before
> that account can receive transfers — `whop_sub_merchants.status` models this as `awaiting_kyc`
> (revenue can still arrive; payouts are held until KYC completes). Exact response field names for
> the onboarding link are unverified against live Whop docs (`docs.whop.com` blocks unauthenticated
> fetches) — confirm them once Platforms API access is granted (see `packages/billing-core/src/
> providers/whop.ts`'s `createSubMerchant` header).
| `PUBLIC_WEBHOOK_BASE_URL` (var, not secret) | billing | Public base URL webhooks are reachable at (e.g. `https://api.naelao.com`). Used to build the one-time payout-approval email link (`/v1/webhooks/whop-wallet/payouts/:id/approve`); a payout request still exists in the dashboard/shell without it, just with no emailed link. |

## NOT env vars — per-builder credentials entered in-product

These are the builder's OWN accounts, stored per-space via the credentials worker / connect
flows. Never platform secrets:

- **WhatsApp** (Meta Cloud API token + app secret for `X-Hub-Signature-256`), **Slack** signing
  secret, **Discord** public key, inbound **email** — via `POST /channels/:channel/connect`.
- **Gumroad** keys (connector catalogue), any BYO MCP server auth — via space credentials. (A
  business's OWN Whop connection for Autopilot/CRM reads is separate from the platform-managed
  business-wallet rail above — see `whop-tool-lifecycle`.)
- **Payout destinations** (bank/crypto/Venmo/CashApp account details a business owner adds for
  their own wallet's payouts) — vault-encrypted via `POST /billing/whop-wallet/destinations`,
  only credential NAMES in D1, never the platform's own key.

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

### Free-model implementation runner

The optional implementation workflow accepts `GEMINI_API_KEYS`, `GROQ_API_KEYS`, and `OPENROUTER_API_KEYS` as comma-separated repository secrets. At least one provider must be configured. The runner orders eligible models by capability, rejects a request that exceeds its recorded context/TPM guard, rotates on quota/transient failures, and treats live provider response headers and catalogs as authoritative because free quotas change without repository releases. These keys are CI-only and must never enter Worker environments or Repomix output.
