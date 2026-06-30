# Deploy-time secrets & config

Everything below is supplied at deploy time via `wrangler secret put` (never committed). The
code paths that use them are already built and degrade to a safe dev path when a secret is
absent — so the full flow is testable end-to-end locally without any of these.

## Lemon Squeezy — the single money-in processor (all three payer classes)

`api.lemonsqueezy.com` is reserved to Naelao's store (reserved-capability guard). Set these
on **`naelao-billing`**:

| Secret | What it is | Used by |
|---|---|---|
| `LEMON_SQUEEZY_API_KEY` | LS API key for Naelao's store | checkout creation (`/internal/commerce/checkout`, `/internal/seats/checkout`) |
| `LEMON_SQUEEZY_STORE_ID` | Naelao's LS store id | checkout creation |
| `LEMON_SQUEEZY_WEBHOOK_SECRET` | LS webhook signing secret | `POST /webhooks/lemon-squeezy` signature verification |
| `LAUNCHPAD_FEE_BPS` *(var, optional)* | platform fee in basis points (default `500` = 5%) | order + seat fee capture |

### Variant ids (per product / per seat)
LS checkouts target a **variant**. Two ways to map them:

- **Products**: set `ls_variant_id` on the product row — `PATCH /spaces/:id/products/:productId { ls_variant_id }` (dashboard publish flow). Until set (or when LS creds are absent) the checkout endpoint returns a dev placeholder URL so the flow is testable.
- **Seats**: set `productConfig.memberBilling.lsVariantId` in the SpaceType manifest (or per-space `config_json.productConfig` override).

> A future enhancement can auto-create the LS product/variant on publish via the LS API; today the variant id is supplied by the builder/admin. The reserved-capability guarantee holds either way — checkout only ever runs through `naelao-billing`.

## Cloudflare for SaaS — storefront custom domains

Set on **`naelao-spaces`** (only needed for the opt-in custom-domain feature; `{slug}.naelao.com` subdomains need nothing — they're covered by the zone wildcard cert):

| Secret | What it is |
|---|---|
| `CF_API_TOKEN` | zone-scoped token with **SSL and Certificates: Edit** on the SaaS zone |
| `CF_SAAS_ZONE_ID` | the `naelao.com` SaaS zone id (the fallback-origin zone) |

When set, `POST /internal/business-services { kind: "custom_domain" }` calls
`POST /zones/{zone}/custom_hostnames` (TXT DCV) and returns the validation records; poll
`GET /internal/business-services/custom-domain-status` until `status: active`. When unset, the
domain is recorded as `pending_dns` with CNAME instructions (no live API call).

The customer CNAMEs their domain → the fallback origin (the `naelao-portal-router` Worker),
which resolves the Host against `business_services` and serves their storefront.

## Service-binding topology (wrangler `[[services]]`, already declared)

```
naelao-portal-router ── BILLING_WORKER ──▶ naelao-billing      (storefront checkout)
naelao-billing       ── SPACES_WORKER  ──▶ naelao-spaces       (seat → member activation)
naelao-billing       ── AGENTS_WORKER  ──▶ naelao-agents       (wake fulfilment agent)
naelao-agents        ── BILLING_WORKER ──▶ naelao-billing      (commerce script money-in)
naelao-agents        ── SPACES_WORKER  ──▶ naelao-spaces       (business-services, products)
```

## Connectors — external-platform integrations

A connector is reached over MCP through `naelao-mcp-hub`. The builder's platform key is stored in
the **credentials** vault (`{PLATFORM}_API_KEY`); the hub resolves it at call time, so the agent
never sees it. Connecting is `POST /connectors/:platform/connect { space_id, api_key }`.

### Whop (live connector — needs its MCP shim deployed)

The Whop connector points at `https://mcp.naelao.com/connectors/whop` (catalogue `mcp_endpoint`).
Deploy the **`naelao-connector-whop`** worker (`workers/connector-whop/`) behind that route:

- `wrangler deploy --env production`, then map `mcp.naelao.com/connectors/whop*` to it (route or
  custom domain). mcp-hub calls `${mcp_endpoint}/mcp` with the builder's Whop key as a Bearer token.
- The shim holds **no secrets** — the key arrives per request from the vault via mcp-hub.
- Exposes read tools (memberships/members/products/payments/plans) + write tools
  (send_message/post_announcement). **No money-in tool** — Whop processes payments (model A).
- Webhooks: the builder points their Whop webhook at
  `https://<router>/v1/connectors/whop/webhook/{spaceId}` and stores the signing secret as the
  `WHOP_WEBHOOK_SECRET` credential (collected by the Whop-seller onboarding wizard).

### Gumroad (live connector — connector #2)

Same pattern: deploy **`naelao-connector-gumroad`** (`workers/connector-gumroad/`) behind
`mcp.naelao.com/connectors/gumroad`. Builders store their token as the `GUMROAD_ACCESS_TOKEN`
credential; the shim accepts it via the Bearer header mcp-hub sends and appends it as Gumroad's
`access_token` query param. Read-only tools (products/sales/subscribers). Gumroad's Ping webhook
isn't HMAC-signed, so there's no webhook ingress — the agent polls sales on a cron instead.

Adding the next connector after this is, again, a catalogue row + a sibling shim worker.

## Execution ladder Tiers 2-5 (script-engine/code-runner.ts)

| Binding | What it is | Tier |
|---|---|---|
| `LOADER` (`[[worker_loaders]]`) | CF Worker Loader — dynamically spins up a fresh V8 isolate per `script.run` call. Beta CF primitive; without it Tiers 2-4 report "unavailable" (Tier 1 R2 ops and Tier 5 container are unaffected). | 2, 3, 4 |
| `BROWSER_WORKER` (`[[services]]` → `naelao-browser`) | The pre-existing CF Browser Rendering proxy, now reachable from inside a Tier-4 isolate via an injected `ctx.browser.navigate(...)` capability. | 4 |
| `TOOL_SANDBOX` (`durable_objects.bindings` → `ToolSandboxDO`) | Already declared — its container harness gained a generic `POST /exec` route alongside the legacy `/build` route. | 5 |

No new secrets — these are bindings, not credentials.

## Memory OS (script-engine/memory-os.ts)

| Binding | What it is |
|---|---|
| `MEMORY_VECTORIZE` (`[[vectorize]]` index `naelao-agent-memory`) | The semantic (Layer 5) recall index. Optional — Layer 3 (structured facts) works with no Vectorize binding at all; without it, episodic notes are simply never promoted to long-term semantic memory (decay/pruning still run). |

## Multi-channel gateway (launchpad/channels.ts + the /v1/channels/:channel/inbound/:spaceId route)

Same vault pattern as connectors — `POST /channels/:channel/connect { space_id, secret }`
stores the channel's signing secret/public key under a fixed credential name, and the public
webhook route resolves it at verification time:

| Channel | Credential name | What `secret` is |
|---|---|---|
| `slack` | `SLACK_SIGNING_SECRET` | Slack app's Signing Secret (HMAC-SHA256) |
| `discord` | `DISCORD_PUBLIC_KEY` | Discord app's Public Key, hex (Ed25519 — asymmetric, not a shared secret) |
| `email` | `EMAIL_SIGNING_SECRET` | Inbound-parse provider's signing key (Mailgun-style HMAC) |

Point the provider's webhook console at `https://<router>/v1/channels/:channel/inbound/:spaceId`
(returned by the connect endpoint). Slack's Events API URL-verification handshake is answered
automatically once the signature checks out. The hourly cron drains each connected space's
unanswered queue (`channel_links` table, `0038_channel_links.sql`) through the agent's
script-first loop.

## Other platform secrets (pre-existing)

`PLATFORM_SECRET`, `JWT_SECRET` (router/auth), `ANTHROPIC_API_KEY` (agents), Stripe keys
(builder-plan billing alternative) — unchanged by this work.
