# Launchpad Go-Live Audit — TODO

Findings from the end-to-end audit (branch `claude/launchpad-project-audit-1fqlpj`,
baseline: 1532/1532 tests pass, typecheck clean — all green *while these holes exist*
because tests hit workers directly and UI verification mocked the network layer).
Each item: evidence, failure scenario, fix. Status: `[ ]` open, `[x]` fixed.

## Tier 1 — Launch blockers

- [ ] **F-1: `/v1/builder/*` is not routed — the entire Builder Dashboard API 404s.**
  Evidence: `workers/spaces/src/builder-routes.ts:141+` implements `/builder/api-keys`,
  `/builder/products` (CRUD/pricing/domain/analytics/payouts), `/builder/space-types`;
  `apps/dashboard/src/lib/api.ts` calls them all through the router — but the router's
  `api` group (`workers/router/src/index.ts:589-963`) has no `/builder` route, so every
  call hits `app.notFound`. Failure: builder logs in, clicks Create in the wizard →
  `POST /v1/builder/products` → 404. All 7+ management tabs dead.
  Fix: `api.all("/builder/*", proxyTo(SPACES_WORKER, ...))` + bare `/builder`, plus a
  router↔frontend route-parity test (see F-STRUCT).

- [ ] **F-2: Lemon Squeezy webhooks have no public ingress — all money-in events undeliverable.**
  Evidence: `workers/billing/wrangler.toml:10` sets `workers_dev = false` (item 29) but no
  `routes =` exists in any wrangler.toml or Terraform (`infra/terraform/` has zero
  worker-route resources); the router neither proxies `/webhooks/*` nor has a
  `BILLING_WORKER` binding (`workers/router/src/index.ts:21-26`). Failure: buyer pays at
  LS → webhook POST to `/webhooks/lemon-squeezy` reaches nothing → orders never fulfil,
  subscriptions never activate, credit packs never grant, seats never activate.
  Customers charged; platform never learns. Fix: add `BILLING_WORKER` binding + an
  unauthenticated `app.all("/v1/webhooks/lemon-squeezy")` pass-through registered before
  the JWT group (LS signature is the auth — same precedent as connectors/channels ingress
  at router lines 251-269).

- [ ] **F-3: Builder's post-login landing page fails to load entirely.**
  Evidence: `apps/dashboard/src/app/dashboard/page.tsx:53` does
  `Promise.all([listSpaces(), listSpaceTypes()])`; `listSpaceTypes()` (`api.ts:183`) calls
  `GET /v1/spacetypes` — a route no worker implements (api.ts:845's own comment). The 404
  rejects the whole Promise.all, discarding the spaces list too → "Failed to load data"
  on every login. Fix: remove the call (or use the real `GET /builder/space-types` after
  F-1) and decouple the two fetches.

- [ ] **F-13: Staging/production deploys are broken two different ways (wrangler env
  binding non-inheritance + deploy-workflow mismatch).** Wrangler named environments do
  NOT inherit binding tables (`durable_objects`, `d1_databases`, `kv_namespaces`,
  `r2_buckets`, `queues`, `services`) — item 41 fixed only `vars` parity. Measured:
  router declares 11 binding tables top-level, **0** in `[env.staging]`/`[env.production]`;
  spaces 15 → 3; agents 20 → 6; knowledge/notifications/credentials 2-4 → 0; auth has no
  env blocks at all. Two failure modes, both verified:
  (a) `.github/workflows/deploy-staging.yml` deploys every worker with `--env=staging` →
  staging workers run with essentially no DB/DO/KV/queue/service bindings → every request
  500s. (b) `.github/workflows/deploy-prod.yml:82` deploys with **no** `--env` → production
  runs the top-level *development* config: `ENVIRONMENT="development"`,
  `CORS_ALLOWLIST=http://localhost:...` (dashboard.naelao.com is not a product domain, so
  the dynamic resolver can't save it → the builder dashboard is CORS-blocked in prod),
  and `PRODUCT_SHELL_URL=http://localhost:3100` → verification emails link to localhost.
  The `[env.production]` blocks are dead config. Fix: replicate ALL binding tables into
  every env block (or drop named envs and use per-env accounts/config files), align both
  deploy workflows on one strategy, and extend `wrangler-vars-parity.test.ts` to assert
  binding-table parity, not just vars.

- [ ] **F-14 (SECURITY): Cross-tenant read/write on the publicly-reachable agents worker —
  the item-21 hole, incompletely closed.** `workers/agents` deliberately keeps
  `workers_dev` enabled (its channel gateway needs public ingress), so ALL its routes are
  directly reachable, bypassing the router. `/agent/run` verifies
  `x-naelao-internal-token` (index.ts:245) — but many sibling routes only do
  `getCallerIdentity` + "missing tenant" check, trusting the client-supplied
  `x-naelao-tenant-id` header outright. Verified unprotected (agents/src/index.ts):
  `GET /spaces/:id/tasks` (:1101) and `/tasks/:taskId`, `GET /spaces/:id/channels/sessions`
  (:1694) + `/channels/unanswered` (:1702), `POST /channels/sessions/:id/resume` (:1790) +
  `/takeover` (:1798) — flip human-takeover on another tenant's customer bot,
  `POST /skills/promote` (:1913) + `/skills/inherit` (:2037) — write another tenant's
  template skill library, `POST /spaces/:id/projects/from-template` (:1535) — creates
  projects in a victim space and then mints REAL internal tokens downstream,
  `POST /spaces/:id/bootstrap/complete` (:1813) — runs setup scripts / wakes the
  assistant (spends the victim's LLM budget). Attacker needs only the workers.dev URL +
  victim tenant/space ids (internal but not secrets). Fix: sweep ALL 37 routes in this
  file; every non-signature-gated, non-catalog route gets `verifyInternalToken` (same
  fix as :245). Add a test asserting each `/spaces/:id/*` route 403s without the token.

## Tier 2 — Serious

- [ ] **F-4: Stream-ticket security fix is dead code; raw `nps_` tokens still land in URLs/logs.**
  Evidence: `apps/shell/src/lib/api.ts:212` POSTs `/v1/spaces/:id/sessions/stream-ticket`
  → spaces sessions catch-all (`workers/spaces/src/index.ts:458`) → SpaceDO → 404 → shell
  silently falls back to token-in-URL. The only mint endpoint,
  `POST /internal/stream-tickets/issue` (spaces index.ts:2500), requires
  `x-naelao-platform-secret` — the shell can never call it, and nothing anywhere does.
  Fix: public `POST /spaces/:spaceId/sessions/stream-ticket` on the spaces worker
  (registered before the sessions catch-all), authenticated by verified caller identity,
  calling the issue logic; one end-to-end test through the router.

- [ ] **F-5: `/billing/*` also unrouted (dead code today, loaded footgun).**
  Evidence: dashboard `api.ts:461/473` define `/billing/checkout` + `/billing/subscription`;
  billing worker implements them (`workers/billing/src/index.ts:141/203/285`); no page
  calls them yet and the router can't reach billing anyway. Fix rides with F-2's binding.

## Tier 3 — Revenue integrity (known-open from item 41, re-confirmed)

- [ ] **F-7: `business_subscriptions` is write-only** — nothing reads it to gate agent runs,
  so a churned/cancelled business keeps full access forever.
- [ ] **F-8: No monthly credit refresh** — `creditsIncludedPerMonth` grants once, ever,
  despite the name.

## Tier 4 — Operate & retain (known-open, re-confirmed)

- [ ] **F-9: No builder UI for `agent_activity_log`** (data is populated; `GET
  /spaces/:spaceId/agent-activity` exists; nothing renders it).
- [ ] **F-10: No first-run/onboarding flow for a new product.**
- [ ] **F-11: No GDPR erasure for end users** (export exists, deletion doesn't).
- [ ] **F-12: No cross-provider LLM failover** (only the Anthropic-compatible AI Gateway
  endpoint is called, not the Universal multi-provider one).

- [ ] **F-15: Business invites never email the invitee.** `workers/spaces/src/
  business-routes.ts:147-165` stores the invitee's email + hashed token but sends nothing
  (no NOTIFICATIONS_WORKER call). The shell surfaces a copyable link
  (`spaces/[businessId]/page.tsx:496`), so invites work by manual paste — "invite by
  email" collects an address it never uses. Fix: best-effort `/internal/notify` email with
  the accept link, same pattern as verification emails.

## Polish

- [ ] **F-6: CORS responses lack `Vary: Origin`** (`workers/router/src/index.ts:200`) —
  a shared cache could serve one origin's ACAO to another. One-liner.

- [ ] **F-16: Deploy workflows swallow failures.** `deploy-staging.yml:43` has `|| true`
  and `:90` marks per-worker deploy failures non-fatal — a half-deployed platform reports
  green. Make core-worker failures fatal; at minimum surface a summary.

## Deploy checklist (config-time, unverifiable in-repo — do before go-live)

- [ ] Secrets per worker: `JWT_SECRET`, `PLATFORM_SECRET` (identical everywhere),
  `ANTHROPIC_API_KEY`, `LEMON_SQUEEZY_API_KEY` + `LEMON_SQUEEZY_STORE_ID` +
  `LEMON_SQUEEZY_WEBHOOK_SECRET`, `RESEND_API_KEY` (verification/reset/invite emails are
  real Resend calls — without it, signup credits are unreachable).
- [ ] LS store webhook must point at the (post-F-2) public webhook URL.
- [ ] CF Pages env: `NEXT_PUBLIC_API_URL` set for dashboard AND shell. NOTE the two apps
  disagree: dashboard `api.ts` omits `/v1` from every path (base URL must INCLUDE `/v1`,
  per item 41), while shell `api.ts` includes `/v1` in every path (base URL must EXCLUDE
  it). Same var name, different value shape — a copy-paste between the two Pages projects
  breaks one of them. Consider normalizing in code instead.
- [ ] Replace every `REPLACE_WITH_*_ID` placeholder in wrangler.tomls (D1/KV ids).
- [ ] `PRODUCT_SUBDOMAIN_APEX` matches the real apex.

## Structural

- [ ] **F-STRUCT: Route-parity test.** Extract every path prefix `apps/dashboard` and
  `apps/shell` call and assert the router dispatches each to a real worker route — F-1,
  F-3, and F-5 are one bug class; this is the `wrangler-vars-parity.test.ts` equivalent.
- [ ] **F-HYGIENE: `.turbo/` directories are git-tracked** — every typecheck run dirties
  the tree. Add to `.gitignore` and `git rm -r --cached`.

## Plausible-but-unconfirmed (verify before fixing)

- [ ] `PRODUCT_SUBDOMAIN_APEX` must match the real production apex once domains go live
  (config-time; unverifiable in-repo).
- [ ] `nak_` agent-key approval gate's coarse action keys (`agentActionKey` collapses to
  first path segment) — deliberate, but untested against deep mutating routes.

## Disproven during audit (do NOT re-report)

- Bare `GET /templates` through the router: Hono's `app.all("/templates/*")` DOES match
  bare `/templates` (verified empirically against this repo's hono version) — the
  wizard's Template Gallery routes fine. The double registration elsewhere
  (`/spaces` + `/spaces/*`) is belt-and-suspenders, not a requirement.
- Shell router allowlist coverage: every path `apps/shell/src/lib/api.ts` calls was
  cross-checked against `PRODUCT_END_USER_PATH_PATTERNS` — all covered.
- Email delivery mechanism: notifications worker makes real Resend API calls
  (`sendEmailNow`), and spaces→notifications service binding exists in all env blocks.
  Only the secret is a deploy-time concern.
