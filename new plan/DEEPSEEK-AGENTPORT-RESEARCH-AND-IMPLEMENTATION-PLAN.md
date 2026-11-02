# DeepSeek architecture learnings and Naelao AgentPort plan

**Status:** Research and design only. Do not implement until the queued Naelao test program is complete and its results have been reviewed.

**Research checked:** 2 November 2026

## What Naelao can learn from the supplied architecture

The supplied `007-architecture.md` is an implementation guide for an agent orchestration application built around an Engine, typed domain parts, Sources, an Assessor, an Executor, Sessions, a transactional Store, a durable Effects queue, and an Outbox. It is not the DeepSeek Harness model/network architecture and it is not merely a generic plugin framework. This plan uses the attached guide as the primary architecture reference. Its most useful contribution to Naelao is the way it makes authority, state ownership, scheduling, and human follow-up explicit.

The design target remains Naelao as a general AI OS. Naelao should preserve its planner + common worker runtime, blackboards, execution ladder, and DO architecture. The attached design informs boundaries and test cases; it does not require adopting its Ticket/Thread vocabulary, DeepSeek Harness dependency, local SQLite file, two-role layout, or GitHub/Feishu Sources.

| Supplied architecture pattern | Naelao fit | Proposed adoption |
|---|---|---|
| **One writer per state kind**: Engine owns workflow aggregates; each Source owns only its own cursor/metadata; Settings, Prompts, Effects, Outbox, and Health entries each have named writers | Very strong. Naelao's state is distributed across SpaceDO, AgentDO, workflow stores, provider ledgers, blackboard/task records, and billing. Ownership is easy to blur across those boundaries | For every durable aggregate, document one authoritative writer and public command interface. Other DOs/workers send commands/events or read projections; they do not patch another subsystem's tables. Avoid creating one global Engine DO: use one writer per aggregate/scope with explicit cross-DO messages. |
| **Small domain Engine with typed ports** for repositories, policy, scope, assessor, executor, and outbox; transport glue translates inputs/results | Strong. Naelao already has a kernel, SDK contracts, typed worker commands, and extension APIs | Audit planner/worker, blackboard, channels, execution ladder, and AgentPort for narrow typed host interfaces. Keep model/provider details out of domain invariants and keep HTTP/MCP/CLI/UI as adapters over shared commands. |
| **Command vs fact vocabulary**: imperatives request a change; past-tense methods record what an adapter actually did | Strong | Make API types/events distinguish `request/authorize/dispatch` from observed facts such as `delivered`, `providerAccepted`, `workerReported`, `evidenceCollected`, `verified`, and `settled`. Do not let a proposed action or model claim masquerade as an observed fact. |
| **Atomic domain transactions; enqueue external work inside the transaction, execute it only after commit** | Very strong. Fits D1/DO SQLite transactions, durable workflow/outbox and channel side effects | Use transactional outboxes for cross-DO/provider work. Persist intent + idempotency key before network calls; acknowledge outcome after. On unknown outcome, reconcile or hold for review rather than replaying blindly. |
| **Durable Effects queue**: keyed work, coalescing, bounded concurrency, exponential retry, deferral, health, shutdown/recovery | Strong. Maps to Naelao's Queues, Workflows, per-runtime slots, blackboard orchestration and dispatch leases | Normalize the guarantees and state machine for each durable queue. Include at-least-once delivery assumptions, dedupe keys, retry classes, deadlines, capacity deferral, cancellation, and recovery. Never claim exactly-once external side effects without provider support. |
| **Outbox receipts** track channel reply state (`pending`, `sent`, `dropped`) and are the sole writer of delivery receipts | Strong | Treat message delivery and worker-input delivery as acknowledged state transitions, not fire-and-forget calls. Use scoped stable IDs and expose stuck/failed/uncertain delivery in the dashboard. |
| **Policy as a fresh versioned snapshot; mandates retain admission basis and are revalidated when policy changes** | Very strong for proactive blackboard actions and worker delegations | Persist the policy version, requester, scope, rule/grant basis, allowed operations, resource budget, and expiry with accepted work. Recheck current policy before side effects and after role/grant revocation; do not treat an old accepted plan as permanent authority. |
| **Separate inference from deterministic domain outcome**: Assessor returns a structured assessment; policy maps it to accept/stop/ignore/unavailable; Engine rechecks | Very strong and directly applies to Decisions AI verification and blackboard triage | Models may rank/assess eligible candidates, but deterministic host validation owns acceptance, verification state, budget, permissions and task completion. Store model reasoning as untrusted rationale and store the validated decision separately. |
| **Thread/Trigger → Eval → Decision → Ticket → Assignment lifecycle**, with related work, subscriptions, follow-ups and explicit “waiting for person” state | Strong conceptually, but not a schema to copy wholesale | Compare against current Naelao blackboard/task DAG. Ensure each event is classified, deduplicated, related to existing work, evaluated, routed, assigned, and acknowledged. Preserve human follow-up ownership, avoid notifying the planner for every routine event, and do not auto-close on a worker's self-reported success. Use Naelao's own nouns and records. |
| **Separate worker report from project/PR closure**: readiness only completes work if no tracked Thread remains open; human follow-up can keep the work alive | Strong | Keep “worker completed execution,” “evidence collected,” “verification passed,” and “task/goal completed” as distinct facts. External project state can block completion even when a worker says ready. |
| **Explicit worker capacity slots; prioritise wakes/follow-up over new launches; defer when full** | Strong | Apply to blackboard/container scheduling: distinguish worker slots, runtime/container capacity, workspace locks and provider rate limits. A blocked resource should defer eligible work while workers run other ready tasks; do not run overlapping tasks in one filesystem unless isolation is proven. |
| **Scoped SourceContext/role Pick types; executor can see only its ticket, related threads, relevant source records and prompts** | Strong | Use one least-privilege ctx per execution scope and declared grant. Planner, worker, extension, AgentPort client, Space assistant, project assistant, and project-bound agent receive distinct tool/data views. Cross-scope collaboration uses typed blackboard messages with policy filtering, not direct file/database access. |
| **Explicit health ownership**: one part claims and clears its own health entry | Strong | Attribute provider/queue/worker/blackboard/DO failures to their subsystem, with stable error codes, age, retries and correlation IDs; avoid a single global health bit that hides the owner. |
| **Typed, paginated, bounded model-facing resources plus “model surface” drift tests** | Strong | Add tests that system instructions, model-selected tools, worker prompts, task packets, blackboard summaries and connection descriptions match granted scopes and stay within context-size budgets. Keep PII/secrets and irrelevant projects out of prompts. |
| **Broad lifecycle/recovery tests** for concurrency, queue retries, interruption, settings races, policy changes, source outages, migration and UI projections | Very strong | Extend Naelao's layered test program to include cross-DO outbox replay, blackboard fan-out, worker hand-back, recovery, policy revoke, duplicate provider webhooks, resource contention, UI state, migration/rollback and live-provider acceptance. |

### Patterns to adapt carefully or avoid

- Do not build a single global Engine/Durable Object for every Space or project. The reference guide's synchronous transactional Engine relies on one local SQLite Store; Naelao is distributed. Preserve per-Space/per-project isolation and use durable outboxes across boundaries.
- Do not copy its fixed Ticket/Thread/Trigger domain model literally. Map the lifecycle to Naelao's existing tasks, DAG, runs, blackboards, assistants, project scopes and verification records; add a new record only for a demonstrated gap.
- Do not make model assessment enforce permissions. The assessor can select among candidates that deterministic code already declared eligible; current authorization and resource checks run again before effects.
- Do not interpret an event log as permission to persist secrets or all source payloads forever. Keep provider credentials in Vault, minimize and redact PII, and apply retention/deletion rules.
- Do not replay arbitrary commands on restart. External side effects need idempotency or reconciliation; unknown outcomes remain uncertain.
- Do not add DeepSeek Harness as a required runtime dependency. The attached document describes integration with that host, but Naelao's planner/worker system remains the runtime.

## AgentPort: product definition

**AgentPort is Naelao’s provider-neutral identity and authorized-service access layer for agents.** It gives an assistant or external agent a stable, scoped identity plus approved communication channels and service credentials. It is not a business wallet, an anti-bot bypass, or a universal guarantee that every website permits automated accounts.

The user’s YC framing—“Stripe for AI agent identities”—is a useful product hypothesis: a developer can provision and manage an agent principal, then attach authorized service identities through one API, MCP server, or CLI. In Naelao, AgentPort should be available through the default product and SDK, while most domain-specific behavior and provider integrations remain extensions. External developers may call a separately authenticated AgentPort API/MCP/CLI without running the full Naelao planner.

Keep these concepts distinct in the data model and UI:

1. **Naelao agent principal:** stable Naelao-issued ID, owner, assistant/worker type, Space/project scope, lifecycle, and audit lineage.
2. **Communication endpoints:** email identity, phone number, SMS/MMS/call capability, and WhatsApp channel binding. Endpoints are provider-backed and region/consent/plan constrained.
3. **Connected service accounts:** OAuth/API connections or explicitly approved service accounts such as a CRM, cloud account, or merchant service. Credentials remain in the host vault and are exposed to a call only as an operation, never as raw secrets.
4. **Payment identity/authority:** an optional adapter-backed wallet or payment authorization with a separate budget and approval policy. It is not a Naelao stored-value balance or business wallet.

AgentPort handles **identity, authorization, and lifecycle**. Extensions decide domain behavior and expose narrow tasks such as “read order status” or “create a draft purchase request.” Connectors implement vendor-specific auth/API behavior. The agent’s normal planner/worker architecture remains responsible for work selection; AgentPort is a capability provider, not another autonomous agent runtime.

## Verified provider facts and current Naelao position

### Email

- Cloudflare Email Service combines outbound sending and inbound Email Routing/Worker processing. Current Cloudflare pricing documentation says inbound Email Routing is unlimited on Free and Paid Workers plans; outbound arbitrary-recipient sending requires Workers Paid, includes 3,000 emails/month per account, then costs $0.35 per 1,000 accepted emails. Sending to verified account destinations is free. Email Routing Worker execution is billed at Workers rates. See [Cloudflare Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/) and the [Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
- Cloudflare’s Agent email guide documents inbound messages routed to an agent session and outbound replies through Email Service. A Cloudflare zone/domain, DNS/MX configuration, sender verification, Worker bindings, and deliverability controls are still required; this is not automatically a hosted mailbox per agent. See [Cloudflare Agents email channel](https://developers.cloudflare.com/agents/agent-class/communication-channels/email/) and [routing email](https://developers.cloudflare.com/email-service/get-started/route-emails/).
- AgentMail provides API-managed inboxes, sending/receiving, webhooks, SDKs, and MCP. Its current pricing page advertises Free: 3 inboxes/3,000 emails per month/100 per day; Developer: $20/month for 10 inboxes/10,000 emails; and extra inboxes at $2/month plus $2/month per additional 1,000 monthly emails. See [AgentMail pricing](https://www.agentmail.to/pricing) and its [API introduction](https://www.agentmail.to/docs/introduction).
- This is not a direct price-equivalent comparison: Cloudflare is attractive when Naelao already has a configured domain, Cloudflare Workers account, and can own its routing/deliverability setup; AgentMail offers a more turnkey agent-inbox service and domain/inbox abstraction, with priced capacity and provider dependence. Cloudflare has lower marginal send cost on a paid Workers plan at the stated volume; AgentMail reduces setup and inbox operations. Naelao should keep both behind one email adapter and choose by deployment/tenant policy rather than removing a working provider.
- Repository evidence: Naelao already has Cloudflare inbound parsing/routing and outbound Email Service code, per-agent/task address identity work, and an AgentMail REST client path. Email rollout depends on `EMAIL_INGRESS_DOMAIN`, sending-domain/binding configuration and/or AgentMail API credentials; code presence does not mean the domains or production delivery have been accepted live. Current code evidence is recorded in `new plan/CONTINUATION-IMPLEMENTATION-PROGRESS.md` under Tasks 31–32 and the channel/email implementation entries.

### Wallets and x402

- The correct name is **Cloudflare Wallets**; **x402** is the HTTP payment protocol (not “x404”). Cloudflare’s Wallets documentation, last updated 19 August 2026, says only a per-account handle reservation is currently available; that handle does not send, receive, or hold funds. Account Wallets and agent Virtual Wallets with allowance/allow-list/transaction-size limits are described as planned functionality. See [Cloudflare Wallets docs](https://developers.cloudflare.com/wallets/) and [Cloudflare’s announcement](https://blog.cloudflare.com/wallets/).
- Cloudflare’s Monetization Gateway is a separate product for sellers and was announced as closed beta on 30 September 2026. It uses x402 and Coinbase’s facilitator for verification/settlement. Its availability must not be confused with a generally available buyer wallet for every Naelao user. See [Monetization Gateway beta](https://blog.cloudflare.com/monetization-gateway-beta/) and [x402 protocol docs](https://developers.cloudflare.com/monetization-gateway/x402/).
- Plan an **optional AgentPort payment adapter** only after Cloudflare publishes working Wallet/Virtual Wallet API access and supported policies are verified. Until then, x402 can be prototyped against testnet/public protocol fixtures or connected user-controlled wallets only under explicit opt-in, strict spend ceiling, recipient/network allowlist, approval thresholds, idempotency, and reconciliation. Do not add wallet balances, financial settlement, or wallet authority to Naelao kernel. Do not represent Cloudflare’s handle reservation as an active wallet.

### Third-party accounts and Amazon

- AgentPort can provision identities and connect service accounts only where the third-party provider permits the account type and automation method. Prefer official OAuth, APIs, delegated seats/subaccounts, passkeys or provider-approved service accounts. Use browser automation as a constrained fallback only where the user/provider terms allow it; do not bypass CAPTCHA, bot detection, rate limits, identity verification, purchase controls, or site restrictions.
- Amazon has published an Agent Policy for agents accessing Amazon Services; the indexed official policy text requires agents to identify themselves and says not to circumvent controls that limit agent access. Before offering Amazon account creation or shopping actions, obtain written integration/partner authorization or use Amazon-supported developer/business APIs and confirm the current policy/terms. AgentPort must not promise that Naelao can create Amazon accounts for autonomous agents or defeat Amazon’s blocks. See [Amazon’s Agent Policy](https://sellercentral.amazon.com/help/hub/reference/external/GS83KH2MA7HM69PH?locale=en-u).
- AgentPort’s commercial value is the neutral authorization and identity lifecycle across approved services, not a claim that every site will accept an agent as an independent legal person. The human/account owner remains the accountable principal unless the service explicitly supports an agent principal.

## Proposed architecture

```text
Naelao planner/worker OR external agent
             │
             ├── Naelao SDK / CLI (`ctx.agentPort.*`)
             ├── AgentPort API (external, authenticated client credentials/OAuth)
             └── AgentPort MCP server (same operations and grants)
                           │
                  Host capability gateway
                  ├─ authenticates agent + owner + scope
                  ├─ checks grant, policy, plan quota, approval and idempotency
                  ├─ reserves usage / records audit event
                  └─ invokes provider adapter using vault-held credentials
                           │
       ┌───────────────────┼──────────────────────┐
       Email adapter     Telecom adapter      Service-account adapters
    Cloudflare/AgentMail Twilio/Telnyx/WA       OAuth/API/approved browser
                           │
              Optional payment adapter (future)
                  x402 / Cloudflare Wallets when GA
```

### Host/kernel responsibilities

- Maintain agent principal IDs and scoped grants with lifecycle state, owner, Space/project scope, data classification, and revocation timestamp.
- Store provider secrets and refresh tokens only in the existing encrypted credential vault. Never pass raw credentials into prompts, extension `ctx`, blackboard messages, logs, event payloads, or model context.
- Enforce user consent, provider policy, caller identity, explicit capabilities, spend/usage quota, human approval, idempotency, rate limits, lifecycle cleanup, audit events, data retention, and revocation before any provider side effect.
- Expose only typed operations and opaque handles to extensions and workers. Keep provider API tokens and transport credentials host-side.
- Preserve scope separation for Space assistant, project assistant, project worker, Space-shared extension, and external AgentPort client. No inherited permissions on fork or project clone without a new grant.
- Support data export/deletion and ownership transfer without orphaned live numbers, domains, or external accounts; show irreversible provider operations for explicit confirmation.

### Extension / provider adapter responsibilities

- Define supported account/channel operations and exact schemas: create/reserve, verify, send, receive/event, list, rotate, suspend, release, and status, as applicable.
- Provide provider capability metadata, regional availability, pricing/limits, required user verification, OAuth scopes, retention/consent terms, and whether an action is reversible.
- Implement vendor-specific API/OAuth and webhooks; provide signed-event verification and duplicate/replay handling; never claim unsupported account creation or actions.
- For vertical systems (Amazon, CRM, banking, email, commerce, etc.), ship separate template/extension packages that use AgentPort grants rather than encoding the vertical’s workflows in the kernel.

## Implementation plan — gated behind the current test program

Do not start these implementation phases until the current broad Naelao experiments/tests are complete and the measured results are reviewed. Tests must establish the existing contracts before architecture changes begin.

### Phase 0 — baseline and test-gated design

- Inventory current assistant email/phone identities, AgentMail and Cloudflare email routes, phone provider bindings, credential vault, project/Space scope, existing `ctx.connector`, MCP, API and CLI patterns.
- Draw state and data-flow maps for: provision → verify → attach → send/receive → approval → disable/revoke → retention/delete.
- Measure provider cost, first-provision latency, webhook delivery/retry behavior, and provider-call failure/uncertain-outcome recovery using mocked and opt-in live accounts.
- Exit gate: no duplicate identity stores without a documented ownership reason; tests establish tenant isolation, revoked-token behavior, replay safety and credential non-disclosure for existing paths.

### Phase 1 — AgentPort protocol and principal registry

- Define versioned schemas for `AgentPrincipal`, `IdentityEndpoint`, `ServiceConnection`, `CapabilityGrant`, `ApprovalPolicy`, `UsageReservation`, `ProviderEvent`, and `AuditEvent`.
- Model endpoint and service connection separately; provider account IDs are opaque references. Each record binds to owner + scope + agent; no provider token is serialized into these records.
- Define status machines (`pending`, `active`, `suspended`, `revocation_pending`, `revoked`, `failed`, `indeterminate`) and idempotency keys for every create/change/revoke operation.
- Migration must preserve current assistant email/phone identifiers and callback bindings, with reversible backfill and no eager external release.
- Exit gate: schema/property tests, migration replay/backward-compatibility tests, duplicate/retry and cross-tenant denial tests.

### Phase 2 — host gateway, authorization and credential lifecycle

- Add one host-side AgentPort gateway that accepts typed intent from planner workers, scripts, workflows, dynamic workers, extensions, API/MCP/CLI callers.
- Resolve scope and authorize exact operations by grants; require owner confirmation for new providers, account creation, irreversible release, money movement, sensitive scopes, and exceptional access.
- Use existing vault and connection records; build missing OAuth lifecycle only as a generic provider capability (PKCE/state validation, least scope, token refresh/revoke, reconnect state), not bespoke business login fields.
- Add admission quota reservations before billable sends/calls/account creation; reconcile usage and keep ambiguous outcomes held for review.
- Exit gate: security tests prove a compromised extension cannot read another identity, obtain credentials, bypass grant/approval, overspend, or replay an external mutation.

### Phase 3 — unify current email and phone under adapters

- Define provider-neutral email and telecom interfaces; wrap existing Cloudflare Email Service, AgentMail, Twilio, Telnyx and WhatsApp implementations rather than replacing them.
- Email selection: Cloudflare-native path for configured Cloudflare domains and cost-sensitive platform-managed routing; AgentMail for turnkey hosted inbox/domain requirements or customer-selected provider. Surface quotas, pricing, verification prerequisites, and domain ownership explicitly.
- Make lifecycle UI operate on AgentPort endpoint records: provision/attach, status, test, policy, pause, detach/release, cost/usage, audit. Reuse current Assistant Mailbox/Phone UI components but label endpoints by agent/scope.
- Keep owner assistant calls and extension-owned customer calls separate identities and execution contexts. Continue to require customer-facing behavior to come from template-installed extensions.
- Exit gate: provider mock contract suite plus opt-in end-to-end inbound/outbound email and phone tests; preserve existing production callbacks through migration.

### Phase 4 — service account connections and “agent gets an account” flow

- Start with services that have official OAuth/API or clearly authorized service-account/delegated-member APIs. Require provider allowlist and requested-scope explanation before connect.
- Add controlled signup flow only where provider terms permit it: user-initiated consent, per-provider rate/quotas, scoped verification relay, data minimization, and owner takeover for legal name, payment, identity checks, CAPTCHA, or ambiguous terms.
- No stealth human impersonation, CAPTCHA bypass, anti-bot circumvention, shared credential scraping, or automated creation of accounts the provider does not permit.
- Treat Amazon as blocked from autonomous signup/browse/buy until documented provider authorization/current policy and supported integration are confirmed; test an approved API path first.
- Exit gate: provider-by-provider permission matrix with legal/product owner signoff; acceptance tests cover revocation, deprovisioning, account lockout and account-owner alerts.

### Phase 5 — external AgentPort developer surfaces

- Publish an authenticated, tenant-scoped API for agent provisioning, grants, connection status, authorized operation invocation, webhook subscriptions, audit access, and revocation.
- Add an MCP server exposing the exact same operation catalog and grant checks. MCP is a transport/auth integration, not permission to call every provider.
- Add a CLI (`naelao agentport`) for create/list/grant/connect/revoke/test and local external-agent setup, with machine-readable JSON output and safe secret handoff. Avoid printing credentials in shell history/stdout.
- Issue scoped, rotatable client credentials tied to an owner-created external-agent principal. Support OAuth or signed client credentials; set expiry, audience, operation grants, usage cap, and emergency revocation. Do not make API keys equivalent to a human owner session.
- Exit gate: external-agent isolation test, token rotation/revocation test, API/MCP/CLI parity test, rate-limit and abuse test, audit completeness and SDK docs.

### Phase 6 — payment adapter (future, separately approved)

- Do not implement stored-value balances or a kernel wallet.
- First evaluate x402 using testnet fixtures and a user-controlled wallet, with per-agent allow-listed merchant/resource, chain, token, exact or maximum amount, daily/monthly cap, and approvals. No production spend by default.
- Integrate Cloudflare Wallets only when Account/Virtual Wallet funds and APIs are generally usable for Naelao’s target accounts; verify supported geography, chains/assets, custody/key model, spend policies, fees, compliance, webhook/reconciliation, and ToS at that time.
- Distinguish buying an x402-paid API/content resource from using card/ACH purchasing accounts at a retail service. x402 does not create an Amazon account or authorize arbitrary commerce.
- Exit gate: threat model, financial/legal review, testnet replay/reconciliation suite, strict capability UI, and separate explicit release approval.

### Phase 7 — observability, evaluation and rollout

- Add an AgentPort dashboard for identities, channels, connections, policy grants, approvals, provider health, delivery/latency, usage/cost, uncertain side effects, failed verification, and revocation state.
- Keep private PII and account identifiers redacted; show stable opaque identifiers and disclose data retention and provider.
- Run shadow mode and canary rollout per provider; feature flags default off for new provisioning until migration and acceptance are green. Preserve rollback and existing routing callbacks.
- Evaluate workflows with task fixtures for legitimate authorization, denied scope, prompt injection in email/web content, OTP handling, duplicate webhook, provider outage, rate limits, token rotation/revoke, budget exhaustion, identity deletion, and cross-project isolation.
- Exit gate: complete test and live-provider evidence with per-provider support matrix. No blanket “works with every website” product claim.

## Required metrics and acceptance criteria

Measure and report separately by provider and operation:

- provision/attach success rate; median/p95 completion latency; verification time; delivery latency; webhook duplicate/loss/retry rate;
- cost per active identity and per message/call/API operation; provider/model fees separated from Workers/DO/R2/storage costs;
- successful auth/reconnect/revocation; grant-denial correctness; budget reservation/settlement/reconciliation accuracy;
- unknown outcome rate and age of unresolved external side effects; account lockout/suppression/bounce/abuse outcomes;
- support for each channel and action: API/OAuth, authorized browser, human approval, unavailable/unsupported.

Do not aggregate Cloudflare email routing as “a mailbox” if only an alias/event route exists. Do not report an account as provisioned until the provider confirms it. Do not claim an external service account is an agent-owned legal identity unless the provider contract says so.

## Open decisions to resolve after tests

1. Which Naelao principal owns an identity: Space assistant, project assistant, a specific worker, or a separate external agent? Recommended default: assistant principal; workers use delegated short-lived grants from their parent and never own persistent third-party credentials by default.
2. Whether AgentPort becomes a team-maintained first-party extension with a small host protocol, or a native dashboard surface backed by SDK methods. Recommended: host primitives + team-owned extension/UI, avoiding a hard-coded provider catalog in the kernel.
3. Whether Naelao manages a shared Cloudflare email domain or requires tenant/FDE-owned domains. Decide after domain, reputation, abuse, and unit-cost tests.
4. Whether direct AgentMail should be a selectable first-party adapter or an optional Composio/MCP connector. Current direct REST client exists; keep it behind adapter either way.
5. Cloudflare Wallets API availability and x402 support are moving targets; re-check official docs and account eligibility before payment implementation.
6. Which external service providers have an approved agent signup / delegated-account path. Amazon is not assumed eligible.

## Sources

- User-provided reference: `007-architecture.md` (DeepSeek-based agent orchestration implementation guide; attachment supplied in this conversation)
- [Cloudflare Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
- [Cloudflare Email Service send API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Cloudflare Agents email channel](https://developers.cloudflare.com/agents/agent-class/communication-channels/email/)
- [AgentMail pricing](https://www.agentmail.to/pricing)
- [AgentMail introduction](https://www.agentmail.to/docs/introduction)
- [Cloudflare Wallets docs](https://developers.cloudflare.com/wallets/)
- [Cloudflare Wallets announcement](https://blog.cloudflare.com/wallets/)
- [Cloudflare Monetization Gateway beta](https://blog.cloudflare.com/monetization-gateway-beta/)
- [Cloudflare x402 protocol docs](https://developers.cloudflare.com/monetization-gateway/x402/)
- [Amazon Agent Policy](https://sellercentral.amazon.com/help/hub/reference/external/GS83KH2MA7HM69PH?locale=en-u)
