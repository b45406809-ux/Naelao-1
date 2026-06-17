# Naelao Build Plan — Start Here

## What This Directory Is

Each file in `prompts/` generates ONE or a few source files for the Naelao project.
Every prompt is **100% self-contained** — paste it into any free AI (Gemini Flash recommended)
and it will output the complete TypeScript file. No extra context needed.

## Recommended Free AI

**Google Gemini 1.5 Flash** (gemini.google.com) — free, 1M token context, solid TypeScript.
**Claude.ai free** — good quality but smaller context. Fine for most files.

## Workflow

```
1. Open prompts/01_config.md
2. Copy the entire "PASTE THIS PROMPT" block
3. Paste into Gemini Flash
4. Copy the generated file
5. Save it to the path shown at the top (e.g. workers/naelao-auth/src/index.ts)
6. Move to the next prompt
7. When all files done → git add -A && git commit && git push
```

## Order Matters

Generate in **numbered order** (01 → 38). Higher-numbered files depend on types
defined by lower-numbered ones. The prompts inline the types they need, so you
never need to copy-paste between sessions — but the order ensures consistency.

## Key Architecture Rules (memorise these)

| Rule | Detail |
|------|--------|
| Runtime | Cloudflare Workers — no Node.js APIs |
| Data | SpaceDO SQLite (`this.ctx.storage.sql.exec()`) — no PostgreSQL |
| Worker comms | Service Bindings — no HTTP between internal workers |
| Router | Hono (`import { Hono } from 'hono'`) |
| Auth | JWT from naelao-auth, extracted by middleware, `c.get('jwt')` |
| Billing | Lemon Squeezy first, Stripe later via BillingProvider interface |
| Errors | Always `{ error: { code: 'SNAKE_CASE', message: '...' } }` |
| Analytics | CF Analytics Engine only — positional blobs/doubles, use AE schema |
| Transactions | `this.ctx.storage.sql.exec('BEGIN; ...; COMMIT')` — not db.query() |

## Quick Reference: Environment Variables

```
NAELAO_JWT_SECRET          32-byte secret for HMAC-SHA256 JWT signing
NAELAO_MCP_MASTER_KEY      32-byte master key for credential encryption
LEMON_SQUEEZY_API_KEY      Lemon Squeezy API key
LEMON_SQUEEZY_WEBHOOK_SECRET  LS webhook signing secret
LEMON_SQUEEZY_STORE_ID_PROD   Production store ID (integer)
LEMON_SQUEEZY_STORE_ID_TEST   Test store ID (integer)
LEMON_SQUEEZY_VARIANT_CREDITS JSON: {"12345":5000,"12346":10000,...}
BILLING_PROVIDER           'lemon_squeezy' | 'stripe'
ENVIRONMENT                'production' | 'staging' | 'development'
PLATFORM_DAILY_CREDIT_CEILING_USD  e.g. 500
```

## Quick Reference: KV Namespaces (binding names)

```
NAELAO_CONFIG_KV      General config, space-type manifests, kill switch
NAELAO_CIRCUIT_KV     Circuit breakers, rate limit counters
NAELAO_ARTIFACT_KV    Artifact metadata
NAELAO_PORTAL_ROUTES  Portal slug/host → spaceId routing
```

## Quick Reference: R2 Buckets

```
NAELAO_WORKSPACE   Agent file system (versioned)
NAELAO_ARTIFACTS   Generated artifacts
NAELAO_UPLOADS     User uploads
```

## Quick Reference: Queues

```
NAELAO_NOTIFICATIONS_QUEUE   push/email delivery (DLQ: naelao-notifications-dlq)
NAELAO_ANALYTICS_QUEUE       analytics events (DLQ: naelao-analytics-dlq, max_retries: 5)
NAELAO_WORKFLOW_DISPATCH      workflow fan-out
NAELAO_DLQ                   general dead letter queue
```

## Quick Reference: Vectorize

```
NAELAO_VECTORIZE    Single shared index 'naelao-knowledge-base'
                    Always filter: { spaceId: { $eq: spaceId } }
                    Dimensions: 768, metric: cosine
```

## Commit Strategy

After every 5 files: `git add -A && git commit -m "add [files]" && git push`
This keeps your progress safe if something goes wrong.
