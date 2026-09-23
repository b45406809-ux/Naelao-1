# Naelao Staging Smoke-Test Checklist

Run this end-to-end against a real staging deployment (real Cloudflare Workers + D1 + R2 + Lemon Squeezy test mode) before any public launch.  
Expected total time: ~60 minutes for one person executing each step.

---

## Pre-flight: confirm secrets are set

```bash
# All workers must have these — wrangler.toml [env.staging] vars must NOT drop top-level vars.
# Verify with the wrangler-vars-parity test (tests/unit/wrangler-vars-parity.test.ts).
pnpm vitest run tests/unit/wrangler-vars-parity.test.ts
```

Minimum required secrets (CF Workers Secrets, set via `wrangler secret put`):  
`PLATFORM_SECRET`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `LEMON_SQUEEZY_API_KEY`,  
`LEMON_SQUEEZY_WEBHOOK_SECRET`, `NAELAO_ACCOUNT_ID`, `NAELAO_GATEWAY_ID`

---

## 1. Builder signs up + email flows

| Step | Expected |
|------|----------|
| `POST /v1/auth/register` with a fresh email | 200, `user_id` returned |
| `POST /v1/auth/login` with the same credentials | 200, JWT returned |
| `POST /v1/auth/request-password-reset` | 200 (constant response regardless of email) |
| Check the email inbox | Password-reset email arrives with a link |
| Follow the link → `POST /v1/auth/reset-password` | 200, can then log in with new password |
| Check pre-auth rate limiter: 10 rapid `POST /v1/auth/login` with wrong password | 429 on the 7th+ attempt |

---

## 2. Create a Launchpad product

| Step | Expected |
|------|----------|
| `POST /v1/spaces` with `spacetype_id: "launchpad"`, `product_slug: "smoke-test-1"` | 201, space_id returned |
| Wait ~5s, `GET /v1/spaces/:id` | `status: "active"`, `product_slug: "smoke-test-1"` |
| `POST /v1/spaces` with `product_slug: "login"` (reserved word) | 400 `product_slug '…' is reserved` |
| `POST /v1/spaces` with `product_slug: "smoke-test-1"` again | 409 conflict |
| `GET /v1/spaces/:id/shell/manifest` | 200 with `space_name`, `ui`, `membership_model` |

---

## 3. End-user signup + email verification

| Step | Expected |
|------|----------|
| `POST /v1/spaces/:id/end-users/signup` with email + password | 201, `end_user_id` returned |
| `GET /v1/spaces/:id/product-users/me` with `nps_...` session token | `email_verified: false`, `credits_balance: 0` |
| Check inbox: verification email arrives with a link | Link format: `https://{slug}.naelao.com/p/{slug}/verify-email?token=...` |
| `POST /v1/spaces/:id/end-users/verify-email` with the token | 200, credits granted |
| Re-check `product-users/me` | `email_verified: true`, `credits_balance > 0` |
| Try to re-use the same token | 400 (single-use) |
| Attempt 10 rapid signups with different emails from the same IP | 429 on 7th+ (pre-auth limiter) |

---

## 4. Chat / SSE (the core product loop)

| Step | Expected |
|------|----------|
| `POST /v1/spaces/:id/sessions` with end-user session token | 201, `session_id` |
| `POST /v1/spaces/:id/sessions/:session_id/messages` with `{role:"user", content:"Hello"}` | 200 |
| `POST /v1/spaces/:id/agent/run` with `{session_id, goal:"Say hello back"}` | 202 `{run_id}` |
| `GET /v1/spaces/:id/agent/run/:run_id` polling until `status:"completed"` | `final_answer` populated; check CF AI Gateway dashboard — the call must show up there (confirms NAELAO_GATEWAY_ID is wired) |
| Check that the response went through the real Anthropic API (not the dev stub) | Response is a real language model reply, not `"[dev-mode stub]"` |

---

## 5. Business creation + subscription flow

| Step | Expected |
|------|----------|
| `POST /v1/spaces/:productSpaceId/businesses` as end-user | 201, new `space_id` for the business |
| `GET /v1/spaces/:productSpaceId/pricing` | Lists plans + credit packs from builder config |
| `POST /v1/internal/business-subscriptions/checkout` (via billing worker) in LS test mode | 200, checkout URL returned |
| Simulate LS `subscription.activated` webhook (use LS test mode) | Business gets `subscription_status: active` |
| `POST /v1/spaces/:productSpaceId/agent/run` as an end-user of an **unsubscribed** business | 402 (subscription gate, if builder has enabled it) |

---

## 6. Lemon Squeezy webhook replay protection

| Step | Expected |
|------|----------|
| Send the same LS webhook payload twice (same `meta.event_name` + `data.id`) | First → 200; second → 200 idempotent (no duplicate side-effect: check `processed_webhook_events`) |
| Send a webhook with a bad signature | 403 |

---

## 7. Custom domain + CF-for-SaaS

| Step | Expected |
|------|----------|
| Builder sets custom domain via `PATCH /v1/builder/products/:id` `{domain:"smoke.example.com"}` | 200; CF custom hostname created |
| `GET /v1/builder/products/:id/domain` | `status: "pending_dns"`, CNAME + TXT DCV records shown |
| Add the CNAME record in DNS, wait 60–120s, then `POST /v1/builder/products/:id/domain/check` | Status transitions to `active` |

---

## 8. Content-policy blocking

| Step | Expected |
|------|----------|
| `POST /v1/spaces/:id/agent/run` with `goal` containing a hard policy violation (CSAM text, weapon synthesis) | 400 `policy_violation` before any LLM call |
| Same with a clear legitimate goal | 202, run proceeds normally |

---

## 9. Notifications

| Step | Expected |
|------|----------|
| Trigger an agent approval request (set `always_ask` policy, run the agent) | Approval-request email arrives at the space-owner address |
| `GET /v1/spaces/:id/agent-activity` as the builder | Shows the pending approval event |

---

## 10. Rate-limiter sharding

| Step | Expected |
|------|----------|
| From two different client IPs: both can make authenticated requests up to their own limits | Limits don't bleed between tenants or IPs |
| Simulate a single IP hitting 100 requests/min | 429 after threshold; rate-limiter clears after its window |

---

## Sign-off

- [ ] All 10 sections pass
- [ ] CF AI Gateway dashboard shows real LLM calls in section 4
- [ ] No uncaught 500s in CF Workers tail logs during the run
- [ ] LS test-mode webhook log shows all expected events with correct idempotency
# Batches 1–4 connector alias smoke test

1. Connect an app in a staging business and create the `primary_inbox` logical alias.
2. Run a script calling `ctx.connectors.call("primary_inbox", "list", {})` and confirm the MCP
   receipt contains no credential value.
3. Repeat with a missing OAuth scope and confirm an incremental reauthorization card is returned.
4. Replay the call with another tenant's session and confirm `404`/denial without connector data.
5. Send a nested SSN/private-key payload and confirm `egress_dlp_blocked` before upstream egress.
