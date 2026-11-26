# Naelao Managed, Providers and AgentPort — Implementation Specification

Version 2.0 · owner-approved 2026-11-26 (all §18 recommendations accepted) · 2026-11-26 · Source: [`V.md`](V.md) v1.0, reconciled against
`origin/Mcbt5s-Backup-2` at `47b67cbf`.

---

## 0. How to read this document

This replaces the narrative of `V.md` with a buildable specification. `V.md` stays as the vision
document. Where the two disagree, this document wins.

`V.md` was written without inspecting the repository (its §98 says so). Most of its core concepts
already exist here, some of them two or three times under different names. This spec therefore
**extends what exists** rather than proposing a new monorepo.

**Conventions**

- **MUST / SHOULD / MAY** have their RFC 2119 meanings.
- Requirements carry stable IDs (`MR-<area>-<n>`) so tasks, tests and reviews can cite them.
- *Exists* means present in source on the commit above. Nothing is claimed as deployed or live.
- Money: **1 credit = US$0.01** (`CREDITS_PER_USD = 100`, `packages/billing-core/src/credits.ts`).
- Error codes use the repository's existing snake_case `error_code` style, not `V.md`'s
  UPPER_CASE.
- Every new capability ships behind a flag that defaults to off, per the repository rules.

---

## 1. What changed from V.md and why

| # | V.md proposal | This spec | Reason |
|---|---|---|---|
| 1 | New monorepo layout (`services/`, `providers/`, `adapters/`) | Keep the existing `workers/*` and `packages/*`; add **one** new worker (`workers/email`) | About 30 workers and 30 packages already exist with these boundaries; moving them gains nothing. |
| 2 | Managed Commerce Core with 12 modules | **4 code boundaries:** Catalog, Resources, Commerce (billing worker) and Provider Runtime (agents worker) | One team. Boundaries live in code, not in deployables (V.md §13 agrees). |
| 3 | `Organization` as a new tenant entity | `orgs.id` = `tenant_id` is the tenant (migration 0002). AgentPort's own `agentport_organizations` (0160) maps 1:1 to it. | Three org-like notions exist today. Adding a fourth would make isolation harder to prove. |
| 4 | New `Resource` table | Evolve `managed_service_accounts` (0179+) into the canonical resource record | It already holds tenant, space, project, connection mode, provider reference, credential reference, payers and lifecycle. |
| 5 | `ProviderOffering` and `CommercialAgreement` as greenfield | `managed_service_capability_versions` stays the technical registry. Add **offerings** and **commercial agreements** tables on top of it. | Operator verification, evidence and `valid_until` already exist; commercial approval does not. |
| 6 | Double-entry ledger with prepaid balance from day one | **Phase A:** keep plan-allowance credits plus the existing reserve/settle tables. **Phase B:** a prepaid managed balance on an append-only double-entry ledger, **only after the owner's accounting/legal decision** (OD-1). | No balance, top-up or ledger exists today. A stored-value balance has accounting and regulatory weight that V.md flags (§98) but does not resolve. |
| 7 | Propose → Evaluate → Approve → Execute → Reconcile inside AgentPort | AgentPort `authorize` stays a **decision receipt**. The pipeline runs in the agents worker host, using `managed_service_operations` as the execution record. Outcomes are written back to AgentPort's hash-chained `agentport_action_receipts`. | That is where execution, approvals (`approval-decisions.ts`) and provider adapters already live. AgentPort stays runtime-agnostic and references-only. |
| 8 | Weighted provider scoring `S = 0.30C + …` | Hard eligibility filters, then an operator-set **preference order** per resource type | The weights are unvalidated (V.md says so). With 1–3 providers per category, ordering is enough and explainable. |
| 9 | Five operating models live | All five stay in the data model. **Three are enabled at launch:** `first_party`, `customer_connection` (BYOK), and `managed_master` **only** where a commercial agreement is approved. `native_subaccount` and `partner_direct` are modelled but disabled. | Avoids building unvalidated integration paths. |
| 10 | Naelao Email "first", architecture unspecified | Naelao Email is a **new independent worker** (`workers/email`). It absorbs AgentPort's gated native email code. Its first release is deliberately small (§12). | Email exists three times today; this unifies the provider. It is also the only path that needs no reseller permission. |
| 11 | Stripe | **Lemon Squeezy** (current billing vendor; Stripe was removed) | Matches the code. |
| 12 | Per-provider quote rules | Remove the hard-coded AgentMail and Workers AI quote paths in `workers/billing/src/index.ts`. "Quote required" becomes an **offering property**. | Adding a provider must not require editing billing code (V.md §91 goal). |
| 13 | Template YAML `resources:` | A typed `BlueprintResourceRequirementsV1` field on `SpaceBlueprint`, using the same propose-then-owner-approves pattern as subspace roles (MS-04–06) | Templates must never authorise spend or create grants. |
| 14 | Mock dashboards, calculators, financial simulator | Removed (pricing formula kept in §9.3) | They are not implementation content. |

---

## 2. Scope

**In scope:** the provider catalog, managed resources, commerce (quotes, reservations, charges,
renewals, reconciliation), provider adapters, execution and approvals, provider events, Naelao
Email, Naelao OS integration (resource panel, template resource requirements), security and
operations.

**Out of scope:**
- Extension host resources (`extension_resource_grants` in SpaceDO: objects, structured_data,
  jobs). These are a different model, platform-hosted and per-installation, and stay separate. The
  only shared element is the billing path, which D8/MS-16 already covers.
- AgentPort OSS licensing.
- Third-party provider self-publishing (V.md Part XXIII). Deferred to after Phase 4.
- First-party providers other than Email.

---

## 3. Product boundaries

| Product | Boundary in this repo | Independent of Naelao OS? |
|---|---|---|
| Naelao OS | `apps/shell`, `apps/dashboard`, `workers/spaces`, `workers/agents` (assistants, projects, workflows) | — |
| Naelao Managed | Catalog and resources (agents worker `communications/managed-service-*`) plus commerce (`workers/billing`) | Yes, through AgentPort |
| AgentPort | `workers/agentport` (`agentport-api`), `packages/agentport-*` | **MUST** stay usable without Naelao OS (MR-AP-1) |
| Providers by Naelao | `workers/email` (new). Future: browser, compute | **MUST** expose their own API and API keys (MR-FP-1) |

**MR-AP-1** AgentPort MUST NOT import from or require `workers/spaces` or `workers/agents` at runtime.
Naelao OS reaches AgentPort only through its service binding and public API.

**MR-AP-2** AgentPort stores references only: no message bodies, no credential values (existing
rule, now normative).

**MR-FP-1** A first-party provider MUST be usable through its own API without Naelao OS or AgentPort.

---

## 4. Current-state map

| V.md concept | Exists today | Gap | Decision |
|---|---|---|---|
| Organization / tenant | `orgs` (0002), `tenant_id` everywhere; `agentport_organizations` (0160); `usage_events.payer_kind='space_wallet'` | Three org notions | **MD-1** |
| Workspace / Project | Space (D1 `spaces`, SpaceDO); Project inside SpaceDO | — | Keep. Resources are owned by the tenant and *assigned* to a Space or Project. |
| AgentIdentity | `agentport_agents`, sealed Ed25519 identity keys (0162), `agentport_mandate_v1` credentials (≤900 s) | — | Keep. Creating an identity MUST NOT create accounts (already true). |
| Resource | `managed_service_accounts` (lifecycle_state, provider_resource_ref, credential_ref, payers) | No category or type, offering, access mode, strategy, sharing class or version | **MD-2** |
| ResourceAllocation | `provider_resource_ref` on the account row; Telnyx registry triggers (0202) | No uniqueness guarantee across tenants | MR-RES-4 |
| Provider / Offering / Capability | `managed_service_capability_versions` (draft→verified→disabled, evidence, valid_until); `agentport_services` and manifests; `@agentport/provider-sdk` typed capability schemas (CB05) | No offering entity, no customer-facing catalog | **MD-3** |
| CommercialAgreement | Only `managed_telnyx_rate_agreements` (0222), `reseller_accounts` (0033) | Missing | **MD-3** |
| RateCard / Quote | `managed_service_plan_entitlements` (price_version, credits_per_operation); `managed_service_operation_quotes` (0220/0221); `BILLING_CORE_RATE_CARD_VERSION` (models) | Quote rules hard-coded per provider in Billing | **MD-6** |
| Reservation | `managed_service_credit_reservations` (held/uncertain/settled/released), `llm_token_reservations`, `workflow_budget_reservations`, `decision_call_reservations` | — | Keep. Unify the reporting view only. |
| Ledger / balance | None. `usage_events` (0007, 0109 v2) is the charge record; quota is a sum over the plan allowance. | No balance, top-up, promotions or double-entry | **MD-5** |
| Payer consent | `managed_service_payer_mandates` (0181, 0194) + audit | Billing only accepts `payer_type='organization'` | Keep. Mandates are consent, not balance. |
| AccessGrant | `agentport_account_grants`; also `extension_resource_grants`, `cross_space_grants`, payer mandates | Four grant systems | **MD-4** |
| Execution pipeline | AgentPort `/accounts/:id/actions/authorize` (receipt only); `approval-decisions.ts`; adapters execute in the agents worker; `managed_service_operations` (idempotent, `uncertain`) | Approvals not uniformly bound to a payload hash; receipts never updated past `allowed` | **MD-7** |
| Credential vault | `workers/credentials` (per-Space wrapped DEK); `sealCommunication` (tenant-derived KEK); AgentPort sealed keys; master keys in Worker secrets | Two customer vaults | **MD-8** |
| Event gateway | Per-provider verifiers (Telnyx ed25519, Meta HMAC, AgentMail svix); `processed_webhook_events_v2`; AgentPort events (references-only); only AgentMail wakes assistants | No common gateway | **MD-9** |
| Naelao Email | (a) agents `email()` alias routing (`agent_email_addresses`); (b) AgentPort native email (Cloudflare Email Service, `EMAIL_PROVISIONING_ENABLED=false`); (c) managed AgentMail | Not a provider; three paths | **MD-10** |
| Subscriptions / renewals | AgentMail rentals sweep (`sweepManagedAgentMailRentals`) | Provider-specific | MR-COM-9 |
| Reconciliation | `reconcileManagedServiceOperations` (5-minute cron), provider cost receipts (0192) and observations (0207) | No inventory reconciliation; no invoice matching | MR-REC-* |
| Capacity pools | None | Missing | Deferred (MD-12) |
| Admin console | `workers/admin` API, no UI | No UI | MR-OPS-1 |
| Template resources | `BlueprintExtensionRequirements` = {knowledge, actions} only | No provider resources | **MD-11** |

---

## 5. Decisions

Each decision is binding for implementation unless the owner overrides it in §18.

**MD-1 Tenant.** The tenant is `orgs.id`, carried as `tenant_id` and used as Billing's `org_id`.
- A Space is an operating context, never a billing account.
- `agentport_organizations` MUST map 1:1 to `orgs`, either for Naelao OS customers or as a standalone AgentPort tenant that has an `orgs` row created for it.
- `payer_kind='space_wallet'` is legacy; no new code may write it.

**MD-2 Resource.** `managed_service_accounts` is the canonical Resource table, extended in place
(§6.1). A view `managed_resources` exposes the V.md field names. No parallel resource table may be
created.

**MD-3 Catalog.** Three layers:
1. **Capability versions** (exist): what a provider can technically do, operator-verified.
2. **Offerings** (new): a purchasable configuration — resource type, access modes, strategies, regions, configuration schema, charge components, quote policy and status.
3. **Commercial agreements** (new): what Naelao may legally resell.

Managed provisioning MUST fail closed unless all three are valid for the requested
offering, region and strategy (MR-CAT-3).

**MD-4 Grants.** An agent's authority over a managed resource is an `agentport_account_grants`
row. The other three grant systems keep their existing purposes:
- `extension_resource_grants`: extension host resources.
- `cross_space_grants`: document sharing.
- Payer mandates: spend consent.

None of them can stand in for another.

**MD-5 Money.**
- **Phase A (now):** managed charges post as `usage_events` (v2) rows with `cost_credits` and `rate_card_version`. They are admitted through the existing reservations against the plan allowance plus the per-install and per-goal caps (D8).
- **Phase B (after OD-1):** add an append-only double-entry ledger in `workers/billing` for a **prepaid managed balance**.
  - Integer amounts in **micro-credits** (1 credit = 1,000,000 µcr), so sub-cent usage can be rated exactly.
  - The customer is charged whole credits, rounded up per settlement (D8 rounding).
  - Accounts: `customer_credit_liability`, `promotional_credit_liability`, `earned_revenue`, `provider_payable`, `cash_clearing`.
  - Top-ups go through Lemon Squeezy one-time products.
  - A top-up credits a liability, never revenue.

**MD-6 Pricing is data.**
- The price for an operation comes from `managed_service_plan_entitlements` (Phase A) or the offering's charge components (Phase B).
- Whether a quote is required is an offering property (`quote_policy: none | required_for_recurring | always`).
- Billing MUST NOT contain provider-specific branches (MR-COM-1).

**MD-7 Execution.** The host pipeline is: authorize (AgentPort receipt) → policy and budget →
approval if required (bound to the payload hash) → reserve → execute (temporary credential) →
settle, release or mark uncertain → append the outcome receipt to AgentPort. Details are in §10.

**MD-8 Credentials.**
- Customer BYOK provider keys for managed-resource operations use the `sealCommunication` path, with AAD bound to tenant, resource and purpose.
- `workers/credentials` remains for Space and user connector secrets.
- Platform master-account keys stay in Worker secrets, readable only by provider-runtime code paths.
- Merging the two customer vaults is deferred, and is not needed for launch.

**MD-9 Events.** One provider-event module in the agents worker:
- Every provider adapter supplies `verifyWebhook` and `normalizeWebhook`.
- Dedup uses `processed_webhook_events_v2`.
- Fan-out goes to AgentPort events (references only) and the existing assistant wake path.
- Telnyx and Meta verifiers are migrated into this module.

**MD-10 Naelao Email** is a new `workers/email` worker.
- It owns its own D1 tables (prefix `nemail_`), API keys, `email()` ingress for Naelao Email domains, and Cloudflare Email Service sending.
- AgentPort's native email code moves into it.
- AgentPort calls Naelao Email through an adapter like any other provider.
- The agents worker's `agent_email_addresses` alias routing remains an OS feature for assistant addresses on the existing domain. It is not a provider and is not sold.

**MD-11 Templates.**
- `SpaceBlueprint` gains an optional `resourceRequirements: BlueprintResourceRequirementV1[]`.
- Activation proposes resources: reuse an existing one, create Managed, connect BYOK, or skip if optional.
- Nothing is provisioned or granted until the owner approves each line with a visible price.

**MD-12 Deferred.**
- Capacity pools, until a capacity-priced agreement exists.
- `native_subaccount` and `partner_direct`, until a provider requires them.
- Wholesale and transfer pricing (V.md §41), which is reporting only and not needed for launch.
- Platform-shared endpoints across organizations (V.md §25).

---

## 6. Data model

All tables are in the shared D1 `PLATFORM_DB`. Migrations append after **0290**. Every tenant-owned
row carries `tenant_id`. Timestamps are integer milliseconds.

### 6.1 Resources (ALTER `managed_service_accounts`)

```sql
ALTER TABLE managed_service_accounts ADD COLUMN category TEXT;            -- email | phone | messaging | model | browser | compute | storage | search
ALTER TABLE managed_service_accounts ADD COLUMN resource_type TEXT;       -- e.g. email.inbox, phone.number
ALTER TABLE managed_service_accounts ADD COLUMN offering_id TEXT;         -- FK managed_service_offerings.id (NULL only for legacy rows)
ALTER TABLE managed_service_accounts ADD COLUMN access_mode TEXT;         -- managed | byok (derived from connection_mode for legacy rows)
ALTER TABLE managed_service_accounts ADD COLUMN provisioning_strategy TEXT; -- first_party | managed_master | native_subaccount | customer_connection | partner_direct
ALTER TABLE managed_service_accounts ADD COLUMN sharing_class TEXT NOT NULL DEFAULT 'dedicated'; -- dedicated | organization_shared
ALTER TABLE managed_service_accounts ADD COLUMN display_name TEXT;
ALTER TABLE managed_service_accounts ADD COLUMN subscription_id TEXT;
ALTER TABLE managed_service_accounts ADD COLUMN ownership_json TEXT;      -- V.md §16 dimensions: operator, upstream holder, controller, transfer rights
ALTER TABLE managed_service_accounts ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS ux_msa_provider_ref
  ON managed_service_accounts(provider, provider_resource_ref) WHERE provider_resource_ref IS NOT NULL;
```

- **MR-RES-1** Backfill `access_mode` and `provisioning_strategy` from `connection_mode`:
  - `naelao_managed` → `managed` / `managed_master`
  - `user_connected` → `byok` / `customer_connection`
  - `provider_managed` → `managed` / `native_subaccount`
- **MR-RES-2** `configuration` MUST validate against the offering's JSON schema. Client input MUST NOT set `tenant_id`, `provider`, `provider_resource_ref`, payers, `credential_ref` or `offering_id` directly.
- **MR-RES-3** `tenant_id` is derived from the authenticated context, never from the request body.
- **MR-RES-4** One upstream resource MUST map to at most one tenant (the unique index above). A violation is an incident, never an overwrite.
- **MR-RES-5** Mutations use optimistic concurrency on `row_version`. A mismatch returns 409 `resource_version_conflict`.
- **MR-RES-6** Deleting a resource sets `lifecycle_state='deleted'` and keeps the row. Financial and audit rows are never cascaded.

### 6.2 Offerings (new)

```sql
CREATE TABLE managed_service_offerings (
  id TEXT PRIMARY KEY,                       -- e.g. off_naelao_email_inbox_v1
  provider TEXT NOT NULL,
  service_id TEXT NOT NULL,
  capability_version TEXT NOT NULL,          -- FK to managed_service_capability_versions(provider, service_id, version)
  resource_type TEXT NOT NULL,
  category TEXT NOT NULL,
  display_name TEXT NOT NULL,
  access_modes_json TEXT NOT NULL,           -- ["managed","byok"]
  strategies_json TEXT NOT NULL,             -- subset of provisioning strategies
  regions_json TEXT NOT NULL,
  configuration_schema_json TEXT NOT NULL,
  charge_components_json TEXT NOT NULL,      -- §9.2
  quote_policy TEXT NOT NULL,                -- none | required_for_recurring | always
  data_handling_json TEXT NOT NULL,          -- operator, subprocessors, regions, retention (V.md §78)
  preference_rank INTEGER NOT NULL DEFAULT 100, -- lower = preferred within resource_type (see §1 row 8, MR-OS-2)
  status TEXT NOT NULL,                      -- draft | testing | available | restricted | deprecated | disabled
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE managed_service_offering_audit (id TEXT PRIMARY KEY, offering_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  before_json TEXT, after_json TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
```

### 6.3 Commercial agreements (new)

```sql
CREATE TABLE managed_service_commercial_agreements (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  agreement_type TEXT NOT NULL,              -- standard_terms | reseller | wholesale | platform_partner | referral | first_party
  permitted_offering_ids_json TEXT NOT NULL,
  permits_managed_provisioning INTEGER NOT NULL,
  permits_master_account_distribution INTEGER NOT NULL,
  permits_subaccount_distribution INTEGER NOT NULL,
  permits_shared_resources INTEGER NOT NULL,
  permitted_regions_json TEXT NOT NULL,
  minimum_commitment_credits INTEGER,
  effective_from INTEGER NOT NULL, expires_at INTEGER,
  verification_status TEXT NOT NULL,         -- unverified | under_review | approved | expired | revoked
  evidence_sha256 TEXT,                      -- hash of the stored evidence document; never the document itself
  approved_by TEXT, approved_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE managed_service_commercial_agreement_audit (...same shape as offering audit...);
```

`first_party` agreements are seeded for Naelao providers. They still need explicit approval,
so that a first-party offering cannot go live by accident.

### 6.4 Subscriptions (new, Phase 2)

```sql
CREATE TABLE managed_service_subscriptions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource_id TEXT NOT NULL,
  offering_id TEXT NOT NULL, price_version TEXT NOT NULL,
  interval TEXT NOT NULL,                    -- month
  current_period_start INTEGER NOT NULL, current_period_end INTEGER NOT NULL,
  renewal_state TEXT NOT NULL,               -- active | renewing | grace | suspended | cancelled
  grace_days INTEGER NOT NULL, cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  upstream_commitment_json TEXT,             -- what the provider bills us and when
  last_renewal_operation_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

The existing AgentMail rental sweep is re-expressed as the first subscription type (MR-COM-9).

### 6.5 Ledger (Phase B only, gated by OD-1)

```sql
CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, tenant_id TEXT, kind TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'credit', created_at INTEGER NOT NULL);
CREATE TABLE ledger_transactions (id TEXT PRIMARY KEY, tenant_id TEXT, kind TEXT NOT NULL,  -- topup | reserve | release | charge | subscription | refund | promo | adjustment | chargeback
  idempotency_key TEXT NOT NULL UNIQUE, source_ref TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, account_id TEXT NOT NULL,
  amount_ucr INTEGER NOT NULL,               -- signed micro-credits
  created_at INTEGER NOT NULL);
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT,'ledger_immutable'); END;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT,'ledger_immutable'); END;
```

- **MR-LED-1** Every transaction's entries MUST sum to zero, checked in the same D1 batch that inserts them.
- **MR-LED-2** Corrections are new `adjustment` transactions, never edits.
- **MR-LED-3** The available balance MUST NOT be derived from one mutable counter alone. A cached balance is allowed, but a nightly job MUST recompute it from entries and alert on any difference.

---

## 7. State machines

### 7.1 Resource (`lifecycle_state`)

```
requested → provisioning → active ⇄ suspended → deprovisioning → deleted
                ↘ pending_verification → provisioning
                ↘ failed            (no upstream effect; reservation released)
                ↘ unknown → (reconcile) → active | failed
active → degraded → active          (provider health; no customer action)
```

- **MR-LIFE-1** `unknown` is entered on any timeout after the upstream call started. Only reconciliation may leave it (existing `uncertain` rule).
- **MR-LIFE-2** `suspended → deprovisioning` for an identity resource (email address, phone number) requires a grace period of at least 30 days and two notices: at suspension, and 7 days before release. A transient payment failure only moves the resource to the subscription `grace` state.
- **MR-LIFE-3** Every transition writes an audit row: actor, from, to, reason and operation_id.

### 7.2 Operation (`managed_service_operations.status`, exists)

`pending → running → complete | failed | held | uncertain | cancelled`, with the existing
idempotency rule `UNIQUE(tenant, provider, idempotency_key)` and `request_sha256`.

- **MR-OP-1** The same key with a different request hash returns 409 `idempotency_conflict`.
- **MR-OP-2** The same key with the same hash returns the original result, and never calls upstream again.

### 7.3 Reservation (exists)

`held → settled | released | uncertain`. An uncertain reservation never expires on a timer.

---

## 8. Provider adapter contract

Adapters live in `workers/agents/src/communications/providers/<provider>.ts`. The existing
`agentmail.ts`, `telnyx-*.ts` and others are migrated one at a time. Each adapter is registered in one map.

```ts
interface ProviderAdapterV1 {
  provider: string;
  capabilities(): CapabilityDescriptor[];                       // must match the verified capability version
  validateConnection?(ctx: ConnectionCtx): Promise<Validation>; // BYOK
  quote?(req: QuoteReq): Promise<ProviderQuote>;                // upstream cost estimate
  provision?(req: ProvisionReq, op: OperationCtx): Promise<ProvisionResult>;
  lookup(req: LookupReq): Promise<ProviderResource | null>;     // REQUIRED: reconciliation depends on it
  suspend?(…); resume?(…); deprovision?(…);
  execute(req: AuthorizedExecution, op: OperationCtx): Promise<ExecutionResult>;
  usage?(q: UsageQuery): Promise<ProviderUsage[]>;              // normalised meters (§9.4)
  verifyWebhook?(req: Request): Promise<VerifiedWebhook | null>;
  normalizeWebhook?(w: VerifiedWebhook): Promise<NormalizedEvent[]>;
  listUpstreamResources?(cursor?: string): Promise<Page<ProviderResource>>; // inventory reconciliation
}
```

- **MR-ADP-1** An unsupported operation throws `capability_unsupported`. It MUST NOT succeed without doing anything.
- **MR-ADP-2** `OperationCtx` carries `operation_id` and the idempotency key. Adapters MUST pass a provider idempotency key upstream whenever the provider supports one. Where it doesn't, a create MUST NOT be retried after an ambiguous outcome. Use `lookup` instead.
- **MR-ADP-3** Adapters never receive a long-lived customer credential when the provider supports scoped, short-lived credentials (the CB04 pattern). Otherwise the credential is opened only inside `execute`, and never returned or logged.
- **MR-ADP-4** Adapter conformance tests (one shared suite, run per adapter) cover: capability parity with the verified version, idempotent replay, ambiguous-timeout handling, secret redaction and webhook forgery and replay.

---

## 9. Commerce

### 9.1 Boundaries

- **MR-COM-1** `workers/billing` MUST NOT contain provider-specific branches. The current AgentMail and Workers AI quote checks move to the offering's `quote_policy`.
- **MR-COM-2** Every managed charge is admitted by a reservation before the upstream effect, then settled at or below the hold (existing invariant, now normative for all providers).
- **MR-COM-3** The payer is the tenant (`payer_type='organization'`, `payer_id = tenant_id`), with an active payer mandate whose scope covers `provider:service:operation`.

### 9.2 Charge components (per offering)

```json
[{"kind":"setup","credits":0},
 {"kind":"rental","interval":"month","credits":100},
 {"kind":"usage","meter":"email.message.sent","included":1000,"unit_credits_per":{"qty":1000,"credits":10}},
 {"kind":"storage","meter":"email.storage.gb_month","unit_credits_per":{"qty":1,"credits":5}}]
```

- **MR-COM-4** The catalog and every quote MUST show all mandatory components, and the minimum monthly cost including them (V.md §40).
- **MR-COM-5** Usage is rated once per settlement and rounded up to whole credits per settlement (D8). Phase B rates in micro-credits.
- **MR-COM-6** Historical charges keep their `price_version`. A price change creates a new version; it never edits an old one.

### 9.3 Price setting (operator guidance, not code)

The retail price is `P = C / (1 − M)`:
- `C` = upstream cost + infrastructure + support allocation + risk allowance;
- `M` = target margin.

The default target margin is 30% for resale. First-party prices are set from measured cost (OD-3).
Prices are stored as data, never hard-coded.

### 9.4 Meters

These are canonical meter names. Adapters convert provider units into them.

| Meter | Unit |
|---|---|
| `email.message.sent` | message |
| `email.storage` | byte-day |
| `sms.segment` | segment |
| `voice.duration` | second |
| `browser.session` | second |
| `compute.cpu` | ms |
| `model.tokens.input` | token |
| `model.tokens.output` | token |
| `storage.bytes` | byte-day |
| `search.request` | request |

### 9.5 Quotes and reservations

- **MR-COM-7** A quote is bound to: tenant, offering, region, configuration hash, price_version and an expiry of at most 15 minutes.
- **MR-COM-8** Provisioning with an expired quote returns `quote_expired`. A changed price requires a new quote, and a new approval if one was required.

### 9.6 Renewals

**MR-COM-9** Renewal runs from one generic sweep over `managed_service_subscriptions`:
1. It reserves and charges before the upstream commitment renews.
2. On failure the subscription moves to `grace` for the offering's `grace_days` and notifies the owner.
3. After grace it moves to `suspended`. Release follows MR-LIFE-2.

### 9.7 Spending limits

- **MR-COM-10** The effective limit is the minimum of every applicable limit:
  - plan allowance (Phase A) or available balance (Phase B);
  - payer mandate period and per-operation limits;
  - per-install cap (D8);
  - per-goal cap (D8);
  - Project spend cap;
  - grant `maxSpend`.
  All are checked within the same reservation admission, so concurrent requests cannot overspend.
- **MR-COM-11** Long-running usage (voice, browser, compute) reserves incrementally, in chunks of at most 5 minutes or 100 credits, whichever is smaller. It terminates the session when the next chunk cannot be reserved.

---

## 10. Execution and approvals

**MR-EXE-1** Every external action on a managed or BYOK resource follows this order, and no step may be skipped:

1. **Authenticate** the caller and derive the tenant.
2. **AgentPort authorize:** the agent, the account, a declared capability and an active, unexpired grant all match. This writes an `allowed` or `denied` receipt.
3. **Policy:** the grant conditions (recipients, domains, rate per hour, max spend), the offering's status, the commercial agreement, and the resource being `active`.
4. **Approval**, if the policy requires it. The approval binds `sha256(canonical payload)`, the resource, the principal, an expiry and the authenticated approver. A different payload hash means `approval_invalidated`. An approver can never be the proposing agent.
5. **Reserve** credits (§9).
6. **Execute** through the adapter, using a temporary credential where supported.
7. **Settle**, **release** or mark **uncertain**.
8. **Receipt:** append an outcome receipt (`succeeded`, `failed` or `uncertain`) to `agentport_action_receipts`, chained by `previous_hash`.

- **MR-EXE-2** Model output and external content (email, SMS, web pages, provider responses) MUST NOT satisfy steps 2–4. An LLM risk score may only *add* an approval requirement, never remove one.
- **MR-EXE-3** A tool shown to an agent (MCP or built-in) is generated from its grants. Hiding a tool is not a security control; the server-side checks in steps 2–4 always run.

---

## 11. Provider events

- **MR-EVT-1** Each provider webhook route verifies authenticity before parsing the body. Rejected requests return 401 and are logged without the body.
- **MR-EVT-2** Dedup key = `provider + upstream event id` (or a body hash if there is no id), stored in `processed_webhook_events_v2` before any side effect.
- **MR-EVT-3** Tenant resolution comes from `provider_resource_ref → managed_service_accounts.tenant_id`. An unknown resource is dead-lettered, never guessed.
- **MR-EVT-4** The canonical envelope is `{id, type, version, tenant_id, resource_id, provider, occurred_at, data}`. `data` carries references, not message bodies.
- **MR-EVT-5** Delivery to agents is at-least-once. Before a wake, the agent's grant is re-checked at delivery time; a revoked grant stops delivery.
- **MR-EVT-6** Telnyx and Meta verifiers move into this module, keeping behaviour identical (their existing tests must pass unchanged).

---

## 12. Naelao Email (first-party provider)

### 12.1 Release 1 scope

| Capability | Release 1 |
|---|---|
| Inbox on a Naelao-managed domain | Yes |
| Inbound (Cloudflare Email Routing → `email()`) | Yes |
| Outbound (Cloudflare Email Service) | Yes, plain text and HTML |
| Threading (Message-ID / In-Reply-To / References) | Yes |
| Attachments (R2) | Yes; ≤ 10 MB each, ≤ 20 MB per message |
| Webhooks (signed) | Yes |
| Scoped API keys | Yes |
| Drafts | Yes |
| Search | Subject, sender and date only |
| Custom domains | **No** (Release 2, after deliverability review) |
| IMAP/SMTP, human client | No |

### 12.2 Data (D1, prefix `nemail_`)

| Table | Purpose |
|---|---|
| `nemail_tenants` | Provider-level customer. Maps to `orgs.id` when sold through Managed, or standalone. |
| `nemail_domains` | Managed domains |
| `nemail_inboxes` | Mailboxes |
| `nemail_addresses` | Addresses and aliases |
| `nemail_threads` | Conversation grouping |
| `nemail_messages` | Metadata plus an R2 key for the raw MIME |
| `nemail_attachments` | Stored attachment metadata |
| `nemail_drafts` | Unsent email |
| `nemail_deliveries` | Outbound delivery state |
| `nemail_webhooks` | Customer event subscriptions |
| `nemail_suppressions` | Bounces, complaints and blocked recipients |
| `nemail_api_keys` | Hashed keys, with scopes |

### 12.3 API (`/v1`, own keys)

```
POST   /v1/inboxes
GET    /v1/inboxes
GET    /v1/inboxes/:id
DELETE /v1/inboxes/:id
GET    /v1/inboxes/:id/messages
GET    /v1/messages/:id
POST   /v1/inboxes/:id/messages/send
POST   /v1/inboxes/:id/drafts
PATCH  /v1/drafts/:id
POST   /v1/drafts/:id/send
GET    /v1/inboxes/:id/threads
GET    /v1/threads/:id
POST   /v1/webhooks
DELETE /v1/webhooks/:id
GET    /v1/usage
```

Every mutating call accepts `Idempotency-Key`.

### 12.4 Requirements

- **MR-EM-1** Inbound mail resolves the recipient to an active inbox, then stores the raw MIME in R2 before parsing. Unknown recipients are rejected at SMTP time where possible.
- **MR-EM-2** Duplicates are dropped by Message-ID plus the inbox ID, falling back to a hash of the raw MIME.
- **MR-EM-3** Inbound content is untrusted (MR-EXE-2). HTML is never rendered server-side, and attachments are never executed.
- **MR-EM-4** Outbound sending checks, in order:
  1. API key scope, then inbox status;
  2. the suppression list;
  3. recipient count ≤ 50;
  4. new-tenant limits: **100 messages/day for the first 14 days, then 1,000/day**. Configurable per tenant only by an operator.
  5. Then it reserves the usage charge, sends, and records the delivery.
- **MR-EM-5** A hard bounce or a complaint adds the recipient to the suppression list. A tenant whose complaint rate is above 0.3% over 7 days, or whose bounce rate is above 5%, has sending paused automatically pending operator review.
- **MR-EM-6** Each webhook delivery is signed with an HMAC and a timestamp, retried with backoff for 24 hours, then dead-lettered.
- **MR-EM-7** The AgentPort adapter for Naelao Email uses the public API with a per-tenant key held in the AgentPort-side sealed store. Naelao Email itself never sees AgentPort agent identities.
- **MR-EM-8** The existing `EMAIL_PROVISIONING_ENABLED` code in `workers/agentport` is moved, not duplicated. Its limits (10 mailboxes/tenant, 50 sends/mailbox/day) become the Release 1 default plan limits until OD-3 sets prices.

---

## 13. Naelao OS integration

- **MR-OS-1 Resources panel.** It extends `ManagedServicesPanel` into a provider-agnostic list driven by `managed_resources`. For each resource it shows the provider, mode, assigned agents, current usage, price and renewal date, and offers suspend and export or release. It never shows internal strategy names.
- **MR-OS-2 Add resource.** The flow is: choose a resource type, choose Managed or Bring your own, choose Automatic or a provider, see the quote (all components), approve. Automatic = every offering of that type that passes all hard filters, ordered by `preference_rank` and then price. The choice is shown with its reason.
  - **Hard filters:** capability, region, commercial approval, status `available`, provider health, the tenant's limits.
- **MR-OS-3 Persistent resources are never migrated automatically** between providers (V.md §37).
- **MR-OS-4 Template resource requirements:**

```ts
interface BlueprintResourceRequirementV1 {
  key: string;                       // unique in blueprint
  resourceType: string;              // e.g. "email.inbox"
  required: boolean;
  capabilities?: string[];
  preferredAccessMode?: "managed" | "byok";
  grants?: { roleKey: string; actions: string[] }[]; // proposed, never auto-applied
}
```

Activation lists each requirement with the following options:
- reuse an existing compatible resource;
- create a Managed one, showing the price;
- connect Bring your own;
- skip, if optional.

The owner's approval creates the operations and grants. A template can never create spend or
grants by itself (same rule as D3).

- **MR-OS-5** Microapps and extensions never receive provider credentials. They act through granted operations only.

---

## 14. Security requirements

| ID | Requirement |
|---|---|
| MR-SEC-1 | Tenant isolation is enforced in every query: `tenant_id` from context, never from input. Random IDs are not authorization. |
| MR-SEC-2 | Every authorization failure returns the not-found shape for resources the caller cannot see. |
| MR-SEC-3 | Secrets never appear in logs, usage events, audit payloads, API responses or agent-visible tool results. A shared redaction test runs over every adapter. |
| MR-SEC-4 | Master-account credentials are readable only by provider-runtime code. Admin and operator APIs can rotate them but never read them. |
| MR-SEC-5 | Operator access to customer resources needs a reason, is time-boxed (≤ 4 h) and is audited. |
| MR-SEC-6 | Managed sign-up risk: free tiers get **no** managed recurring resources, only usage-based ones within the plan allowance. The first managed purchase requires a verified email and an active paid plan. |
| MR-SEC-7 | Regulated resources (telecom numbers, payments, WhatsApp) require the provider's end-customer verification. Naelao's own verification never substitutes for it. Payments use connected or customer-owned accounts only. |
| MR-SEC-8 | Provider enforcement is never evaded: a suspended upstream account's resources are not moved to another account automatically. |

---

## 15. Reconciliation and operations

- **MR-REC-1 Operation reconciliation** (exists, 5-minute cron): extend it to every adapter with `lookup`.
- **MR-REC-2 Inventory reconciliation** (daily): `listUpstreamResources` is compared with `managed_service_accounts`. The output is `orphaned_upstream`, `missing_upstream` or `state_mismatch` rows in a new `managed_service_reconciliation_findings` table. Nothing is auto-deleted upstream.
- **MR-REC-3 Cost reconciliation** (monthly): imported provider cost receipts (exists) are compared with settled charges per provider and offering. Margin and discrepancy findings feed the operator queue.
- **MR-OPS-1 Operator console**, a minimal UI over the `workers/admin` API, provides:
  - an offerings and agreements editor (with audit);
  - a reconciliation findings queue;
  - a failed and uncertain operations list;
  - tenant suspension;
  - provider health.
  - Read-only by default; writes require `ADMIN_SECRET` plus an operator identity.
- **MR-OPS-2** Every operation carries one correlation ID through the router, operation, adapter, reservation, usage event and receipt.
- **MR-OPS-3 Metrics:**
  - provisioning success and latency per offering;
  - adapter error rate;
  - event lag;
  - reconciliation backlog;
  - gross margin per offering (from MR-REC-3);
  - abuse pauses.

---

## 16. Error codes

New codes use snake_case and are added to the existing taxonomy:

```
capability_unsupported   provider_unavailable     provider_not_approved   offering_unavailable
insufficient_allowance   budget_exceeded          approval_required       approval_invalidated
verification_required    quote_expired            idempotency_conflict    resource_version_conflict
operation_pending        operation_outcome_unknown rate_limit_exceeded    sending_paused
```

`insufficient_balance` is reserved for Phase B.

---

## 17. Phases and exit criteria

Each phase lands behind flags that default to off. "Exit" means local tests plus the stated
evidence. A live rollout always needs separate owner authorization.

| Phase | Builds | Exit criteria |
|---|---|---|
| **P0 Consolidate** | Migrations for §6.1–6.3; `managed_resources` view; backfill; offering and agreement admin routes with audit; remove the provider branches from Billing (MR-COM-1) behind `MANAGED_OFFERINGS_ENABLED` | Existing AgentMail managed tests pass unchanged through the offering path; Billing has no provider string literals in its reserve path; isolation tests for the new tables |
| **P1 Naelao Email R1** | `workers/email` (§12), the AgentPort native email code moved, the Naelao Email adapter, offering `off_naelao_email_inbox_v1` (status `testing`) | API conformance tests; inbound dedup; suppression and limits; webhook signing; adapter conformance suite; one inbox creatable directly, through AgentPort, and through Managed **in local tests** |
| **P2 Commerce** | Subscriptions and the generic renewal sweep (AgentMail migrated onto it); quotes per `quote_policy`; inventory and cost reconciliation; spending-limit composition (MR-COM-10) | Concurrency tests (no overspend under parallel reserves); duplicate-event no-double-charge; renewal failure → grace → suspend; reconciliation finds seeded orphans |
| **P3 OS experience** | Resources panel, Add-resource flow, `BlueprintResourceRequirementV1` and activation | Shell tests; a template cannot create spend or grants without approval; reuse is offered first |
| **P4 Execution unification** | MR-EXE-1 pipeline for all adapters; outcome receipts; event module (MR-EVT-*) with Telnyx and Meta migrated | Approval invalidation on payload change; forged and replayed webhooks rejected; revoked grant stops wake |
| **P5 Balance (gated by OD-1)** | §6.5 ledger, Lemon Squeezy top-ups, balance view | Ledger invariants (MR-LED-*) under concurrency; nightly recompute matches |
| **P6+ Providers** | Third-party providers, each = adapter + offering + agreement + rate rows + conformance tests | No changes in `workers/billing` per provider |

---

## 18. Owner decisions

On 2026-11-26 the owner accepted every recommendation below. Each is now binding until the owner changes it. Live rollout of anything still needs separate authorization.

| ID | Decision | Blocks | Approved decision |
|---|---|---|---|
| OD-1 | Prepaid managed balance (stored value) vs plan allowance only | P5 | Stay on allowance + caps until an accountant confirms how credits are treated (liability, refundability, expiry) |
| OD-2 | Naelao Email managed domain name(s) and sending reputation setup (SPF/DKIM/DMARC owner) | P1 live | Use a dedicated subdomain, separate from product mail |
| OD-3 | Release 1 Naelao Email price | P1 `available` | Start at $1/inbox/month including 1,000 sends; revisit after 30 days of measured cost |
| OD-4 | AgentMail resale permission | AgentMail `managed_master` as `available` | Keep BYOK and the existing gated managed path until written permission is stored as an agreement |
| OD-5 | Telnyx managed model (platform account vs subaccounts; 10DLC obligations) | Telecom phase | `native_subaccount` if Telnyx managed accounts allow it, otherwise BYOK only |
| OD-6 | Free-tier managed access (MR-SEC-6) | P3 | No managed recurring resources on Free |
| OD-7 | AgentPort standalone tenants: create an `orgs` row, or keep a separate `agentport_organizations` tenant | P0 | Create an `orgs` row (MD-1) |
| OD-8 | Merge the two customer vaults | Not blocking | Defer |

---

## 19. Deferred or dropped from V.md

| V.md section | Status | Why |
|---|---|---|
| §6 full marketplace categories | Data model supports them; only email at launch | Focus |
| §25 platform-shared cross-org endpoints | Deferred | Needs provider permission and isolation design |
| §26 capacity pools | Deferred | No capacity agreement exists |
| §36 weighted scoring | Replaced by filters + rank | Unvalidated weights |
| §39 AgentPort plan prices | Not in this spec | Commercial decision, separate from implementation |
| §41 wholesale and transfer pricing | Reporting-only, later | Not needed to operate |
| §55 other first-party providers | Deferred | V.md agrees: Email first |
| §83 financial simulator, §42 calculator, mock dashboards | Dropped | Not implementation content |
| §85 monorepo restructure | Dropped | Existing boundaries suffice |
| §94–95 provider self-publishing | Deferred past P6 | Needs contract and security review process |
