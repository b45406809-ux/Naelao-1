# Managed services acceptance handoff

This file records repeatable local checks and the live evidence required before any capability is
advertised or enabled. Local tests use fixtures, fake D1, or Durable Object mocks. They are not live
provider, Cloudflare account, billing, or deployment acceptance.

## Current rollout state

Keep `UNIFIED_WORKSPACE_ENABLED`, `DYNAMIC_CONTAINERS_ENABLED`,
`DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED`, `LIVE_WORKSPACE_ENABLED`, and
`HIGGSFIELD_BYO_ENABLED` false. `LIVE_RUNTIME_AGENT` is unbound. `AGENT37_RUNTIME_ENABLED` is not
enabled in Wrangler. Do not change these settings as part of local acceptance.

Recovery commits and fast-forward pushes to the user-selected `origin/Mcbt5s-Backup-2` branch are
authorized by the active root `AGENTS.md`; keep the implementation branch active and verify the
remote tip is an ancestor before each push. Production or staging deployment, provider purchase,
destructive remote migration, and rollout enablement are not authorized by this handoff.

## Repeatable local checks

Run from the repository root with the pinned Corepack package manager:

```sh
corepack pnpm --filter @naelao/agents-worker test
corepack pnpm --filter @naelao/agents-worker run typecheck
corepack pnpm --filter @naelao/sandboxes-worker test
corepack pnpm --filter @naelao/sandboxes-worker run typecheck
corepack pnpm --filter @agentport/api-worker test
corepack pnpm --filter @agentport/api-worker run typecheck
corepack pnpm --filter @agentport/sdk test
corepack pnpm --filter @agentport/sdk run typecheck
corepack pnpm --filter @naelao/mcp-hub-worker test
corepack pnpm --filter @naelao/mcp-hub-worker run typecheck
corepack pnpm --filter @naelao/shell test
corepack pnpm --filter @naelao/shell run typecheck
corepack pnpm exec vitest run tests/unit/db-migrations.test.ts tests/unit/usage-events-v2-migration.test.ts
```

Focused resumption checks:

```sh
corepack pnpm --filter @naelao/sandboxes-worker exec vitest run src/agent37-runtime-routes.test.ts
corepack pnpm --filter @naelao/sandboxes-worker exec vitest run src/runtime-usage.test.ts src/ops-metrics.test.ts
corepack pnpm --filter @naelao/agents-worker exec vitest run src/communications/managed-service-cost-budgets.test.ts
corepack pnpm --filter @naelao/agents-worker exec vitest run src/communications/telnyx-webhook.test.ts src/communications/telnyx-live-calls.test.ts src/communications/phones.test.ts src/voice/telnyx-telephony.test.ts
corepack pnpm --filter @naelao/agents-worker exec vitest run src/do/DynamicSandboxDO.test.ts
corepack pnpm --filter @agentport/api-worker exec vitest run src/core/routes.test.ts
git diff --check
git status --short --branch
```

For a local Worker bundle/config dry run, `corepack pnpm --filter @naelao/agents-worker run build`
stages the pinned container dependencies and invokes Wrangler's dry-run build. It may build the
Container image locally; it does not deploy. Review the output and current Wrangler configuration
before repeating it after dependency or image changes.

## Credential and deployment diagnostics

These commands inspect credentials/configuration metadata without printing secret values or
changing a remote service:

```sh
corepack pnpm --filter @naelao/agents-worker exec wrangler whoami
corepack pnpm --filter @naelao/agents-worker exec wrangler secret list --env staging
corepack pnpm --filter @naelao/agents-worker exec wrangler deployments list --env staging
corepack pnpm --filter @naelao/agents-worker exec wrangler d1 migrations list naelao-platform --remote --env staging
```

Only after separate explicit authorization for staging deployment/migrations, the configured
Agents Worker commands are:

```sh
corepack pnpm --filter @naelao/agents-worker exec wrangler d1 migrations apply naelao-platform --remote --env staging
corepack pnpm --filter @naelao/agents-worker run deploy:staging
```

The migration command is a remote mutation and the deploy command publishes code. They are listed
for a future authorized acceptance window; do not run them for this local implementation task.
Before using them, confirm the current `workers/agents/wrangler.toml` environment, target account,
database binding and approved migration order. Provider secrets are configured through the
approved secret manager and must never be placed in shell history, this runbook, or test output.

## Capability status and exact live gates

| Capability | Local code and reachable caller | Status and live acceptance still required |
| --- | --- | --- |
| AgentMail connected inbox | Owner connect, region-pinned US/EU API operations, inbox search/read/attachment/usage, AgentPort link and event routes; owner Shell caller | Local implementation exists. Verify authorized US and EU accounts, webhook authenticity/deduplication, deletion/retention, actual provider terms, and deployed D1/R2 behavior before availability. Usage endpoint reports cumulative quantities, not money. |
| Telnyx customer-owned number | Owner inventory search, exact account price quote, confirmed single-number order, GET-only recovery, SMS/voice setup and explicit detach; signed message/call callbacks; cost observations from finalized message reads and signed `call.cost` events correlated to an admitted call leg; owner Shell check for the call-cost setting | Local BYO implementation exists. Telnyx's OpenAPI defines `call_cost_in_webhooks` with a default of false, so a Telnyx account owner must enable it for call cost events to arrive; the owner read-only check does not change the setting. API observations are not invoices. Live order/release requires an explicitly authorized test account and number, disclosed recurring/usage/regulatory fees, and provider account/country eligibility. Do not make a purchase without separate instruction. |
| Telnyx Naelao-managed number | Can stage an already assigned number after webhook/profile checks; managed rental/SMS/voice billing and number release are present | Managed inventory ordering is unavailable. It needs an approved per-number price, payer/credit cap, recurring renewal and plan entitlement before an order caller can be enabled. No managed number purchase is authorized. |
| Managed-service cost alerts | Owner-configured source/currency thresholds persist durable dashboard crossings and acknowledgements. A leased migration 0219 outbox sends browser push through the existing Notifications worker to the threshold author's existing subscription, retries transient failures, suppresses removed users and shows delivery status in Shell. | Local mocked tests verify dispatch, retry/backoff, missing-subscription handling and access-revocation suppression. Delivery is at-least-once when a push succeeds but its response is lost; no email notification or provider-action blocking is implemented. |
| Agent37 customer-owned computer | Owner credential verification, template-gated create/start/sleep/exec, operation recovery, selected-path artifact transfer, usage read, AgentPort actions and confirmed cleanup; Shell Project Computers | Local code is behind the disabled `AGENT37_RUNTIME_ENABLED` gate. Live acceptance needs an authorized customer account, exact operator-reviewed template digest and region, provider limits/funding, create/start/sleep/exec/recovery, artifact integrity and deletion receipts. No full project hydration or provider availability is claimed. |
| Naelao runtime credits | Project Computers reads settled Tier 5 charges from the tenant/Space/project-scoped Billing ledger. The result is labeled as Naelao credits, not provider cost or invoice. | Sandboxes and Shell local tests/typechecks pass. Provider API observations and operator-imported receipts remain separate from these credits; no provider-billed idle feed or invoice source is claimed. |
| Higgsfield customer-owned generation | Owner API-key setup, quote, confirmed idempotent generation, status/cancel/delete/reconciliation and Shell caller | Local code is behind `HIGGSFIELD_BYO_ENABLED=false`; capability remains draft. Review current account terms, end-user flowdown, age/likeness consent, job isolation, retention/deletion, pricing and live callback behavior before enabling. Shared managed-account/resale support is not claimed. |
| Managed Workers AI text | Owner-only exact-model caller through the existing Cloudflare AI binding, fixed-price Billing reservation/settlement and encrypted result storage | Caller code exists, but no model entitlement or price is active. Verify current Cloudflare model availability, terms, region, commercial price and plan limits; operator verification and an authorized deployed test are required before activation. |
| Cloudflare project main computer / live single writer | D1 project-main generation claim, checked workspace path, authority-verifier boundary, snapshot inventory and coordinator protocol tests | Live mode is unavailable. Before binding a runtime adapter, establish an accepted daemon/API contract for authenticated writer admission, generation-bound reconnect, process drain/fsync, durable handoff receipts and read-only operation recovery. Build and sign/publish the exact pinned image; verify FUSE, sync, crash/reconnect, billing and stale-writer fencing in staging. |
| Cloudflare specialist sidecars | Isolated installation-owned workspace, explicit artifact import/export and checked publication; owner duration control | Local paths exist. Validate deployed R2/DO durability, quotas, conflict recovery, cross-tenant isolation and cleanup. There is no automatic main workspace mount or implicit writeback. |
| AgentPort external consumer SDK | Bounded sequential poll/claim/handler/ack helper carries only the matching opaque consumer session reference | SDK contract is implemented locally. A real consumer must supply authenticated provider-content fetch, consumer-specific durable session storage, idempotent acceptance, replay ordering and ack-after-commit evidence. No universal external consumer host is claimed. |
| Modal GPU | Generic lifecycle mock only | Unavailable: no SDK adapter, supported host binding or reachable product caller. The documented JS SDK/private gRPC and host choice require an accepted platform/product contract before implementation or availability. |
| Wallet, Coinbase or independently funded agent balance | Existing Billing organization quota and scoped parent-funded AgentPort-agent mandates | Unavailable. Requires an approved funding/custody/settlement product, eligibility, fees, refunds/transfers, accounting and legal policy. No wallet or Coinbase support is claimed. |
| Physical Cloudflare Container snapshot purge | Snapshot inventory, local reference-drop receipt, expiry tracking and `ttl_elapsed_unverified` state | Unsupported by the currently available provider interface. Do not equate reference removal or TTL passage with physical deletion. Obtain provider deletion evidence/API and retention policy before claiming purge. |

## Staging acceptance sequence after separate authorization

Only after a new explicit instruction authorizes deployment or paid provider use:

1. Record the exact branch and commit, Wrangler environment, D1 migration head, R2/DO bindings,
   provider account type, region, image/template digest, budget and rollback owner. Do not copy
   secret values into logs or this document.
2. Apply migrations only through the approved environment-specific migration process. Confirm
   idempotency, required regional bindings, and rollback/forward-fix instructions before traffic.
3. Exercise one disposable owner-controlled resource per provider. Capture the provider operation
   ID, read-only recovery result, billing receipt or explicit absence of a monetary source, and
   deletion/retention receipt. Do not repeat an order or generation after an unknown result.
4. For live workspace mode, test two competing allocations, stale reconnect, writer drain and
   flush, sleep/crash recovery, tombstone-aware restore, snapshot failure, explicit sidecar transfer,
   and actual provider cost. Keep checked handoff as the default and do not silently downgrade a
   request for live single-writer guarantees.
5. Record separate local, provider-account, staging, and production evidence. Enable an individual
   capability only after its own entitlement, provider terms, budget, support and rollback review.

The current managed-services progress record contains the requirement-level status, exact test
results, and unresolved contract/product decisions. Refresh this handoff whenever that record
changes materially.
