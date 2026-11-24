# AgentPort credential broker and constrained provider actions

## Outcome and status

Give external agents access to approved provider operations through AgentPort while keeping long-lived provider credentials in a host-controlled store. The caller receives a scoped result or receipt. It does not receive the provider's root API key. AgentPort can provision or link provider accounts, enforce tenant and owner policy, authorize actions, route requests, meter where supported, and revoke access.

This is an AgentPort platform plan. It complements the [messaging-provider and managed resale plan](agentport-messaging-providers-managed-resale-plan.md), the [AgentPort identity and adapter evaluation](agentphone-agentport-adapter-evaluation-plan.md), and the [managed-services lifecycle ledger](managed-services-and-sidecar-implementation-progress.md). Reuse current account grants, AgentPort mandates, provider adapters, idempotent operation journals, owner consent, billing and event routing. It does not create a second identity, workspace, policy or billing authority.

[CB4A](https://datatracker.ietf.org/doc/html/draft-hartman-credential-broker-4-agents-00) is an expired individual informational Internet-Draft, not an IETF standard. Its credential-broker patterns motivate this proposal. They are not a protocol dependency or proof of security. Use established standards when they fit a verified provider contract. Implement AgentPort's existing product and threat requirements first; do not claim SPIFFE/SPIRE, DPoP, OAuth token exchange, mTLS or FIDO2 support merely because CB4A discusses them.

## Current-source baseline

Audit and update this baseline before implementation.

- AgentPort already issues a signed, short-lived `agentport_mandate_v1` scoped to an audience and a declared action list. The credential route requires owner authorization. The mandate represents AgentPort agent identity and authority, not a derivative token for an email/SMS/payment provider. It must not be presented as a provider credential.
- Account records carry a credential reference, and account grants bind an agent to permissions with status and optional expiry. The existing provider action route checks active account, service, agent, declared service capability and grant, then records an authorization receipt. Revalidate which adapters call this route and whether the actual provider effect remains behind an AgentPort executor.
- Managed AgentMail send already uses a host-held provider credential, checks account/grant and owner controls, enforces a daily limit and stores idempotent or indeterminate send outcomes. Its send route denies generic agent-role callers, so delegated agent execution needs a host-authorized path with an explicit scope rather than weakening owner authorization.
- AgentPort provider manifests are declarations. They do not prove that an adapter can execute an operation, that the provider supports limited tokens, that terms permit resale, or that a capability is deployed.
- Existing status, expiry and revoke handling is provider and adapter specific. Determine whether issued mandates are checked for revocation at the resource that consumes them, and define their bounded stale-authority window. Never imply that revoking a local grant invalidates a provider-issued token unless the provider supports it and the revocation result is verified.

Reference paths include `workers/agentport/src/core/routes.ts`, `core/identity.ts`,
`workers/agents/src/communications/agentmail.ts`, `workers/mcp-hub/src/agentport-connector-gate.ts`,
and the provider-specific communication adapters. Source names may move. Reconcile the current branch and tests at implementation time.

## Trust and credential model

Separate these records and responsibilities:

| Item | Meaning |
| --- | --- |
| Agent identity | Verified AgentPort principal and active agent registration under the current tenant and owner. |
| Owner authorization | Current account grant and any owner-approved scope, recipient, purpose, budget, expiration and policy revision. |
| AgentPort mandate | Short-lived AgentPort identity and action assertion for its exact audience. It is not automatically proof that an upstream provider will accept it. |
| Provider credential | Encrypted host-held owner credential, provider refresh token, parent credential or narrowly scoped derivative token. It is never included in agent prompts, generic tool results or logs. |
| Action request | Typed request for one operation with account, resource and operation-specific parameters. Treat agent-supplied content as untrusted. |
| Decision and effect receipt | Record authorization separately from provider dispatch, provider outcome and billing settlement. An allow receipt is not proof that an effect occurred. |

AgentPort's host control plane owns credential references, provider adapter binding, current grant checks, action validation, provider dispatch, usage capture and revocation orchestration. Agents receive only the operation inputs they need and bounded output. Separate authentication of a tenant's caller from identification of the agent. A valid agent mandate alone cannot expand the owner's consent or infer a user's intention.

## Select a mediation mode per capability

1. **Host proxy / brokered operation.** Agent sends an AgentPort operation request. The host rechecks identity, tenant, account, current grant, allowed operation, validated resource/recipient, consent, limits and idempotency; it uses a provider credential held by the host and returns a bounded result. Prefer this for email, messages, calendar changes, CRM updates and payments where typed operations permit meaningful restrictions. Model-specific endpoint translation stays in the verified provider adapter.
2. **Provider-minted derivative.** Where a verified API issues short-lived, sufficiently scoped, audience-bound credentials, AgentPort may mint one for a particular task or client. The host validates provider, scopes, TTL, intended audience, tenant isolation, revocation and audit semantics. A provider token still grants authority to its holder. Keep it out of model-visible context unless the reviewed integration requires delivery to a separately isolated client, and record that trust transition.
3. **Legacy credential wrapping.** Passing a long-lived credential to an agent with scheduled revocation has the largest exposure and failure risk. It is not an acceptable default and is excluded from new production integrations. A future exception would need a separately reviewed threat model, provider-supported rotation/revocation, narrow isolated execution, explicit owner acceptance and an expiry/reconciliation test. Do not add this mode merely to call an API without an adapter.

Select the mode per operation and supported provider contract, not by provider name alone. If no safe mode is implemented, report that operation unavailable. Never silently fall back from host proxy to raw credential exposure.

## Request and execution contract

For every operation:

1. Authenticate the platform or developer caller. Resolve tenant, actor and registered agent from trusted server-side bindings. Do not accept caller-supplied identity headers from public clients as authority.
2. Resolve an active provider account binding and owner. Check account and agent status, provider service status, current unexpired grant, required permission, exact connection revision, installation/Project/Space scope, current policy revision and permitted region. Recheck authorization immediately before dispatch.
3. Parse the operation against a provider-neutral, versioned schema with strict bounds. Reject unknown parameters. Validate recipient, resource, amount, currency, destination and content according to the operation contract. Do not permit an arbitrary URL, arbitrary HTTP method, path override or credential reference to turn a proxy into a general-purpose tunnel.
4. Apply owner controls, user confirmation, allowed recipients, usage limits, wallet/credit admission, provider rate limits and any required step-up approval before dispatch. A model's statement that approval occurred is not approval.
5. Write a durable operation intent with an idempotency identity before an external effect. Repeated same-key requests must match the same agent, account, provider, operation and normalized resource/input digest. A mismatched replay is rejected. Reconcile indeterminate provider outcomes before retry. Do not double-send or double-charge.
6. Dispatch only through the adapter bound to the verified provider account. Never return auth headers, token responses, refresh tokens, raw secrets or unnecessary personal/provider payloads to the agent.
7. Record authorization, dispatch attempt, provider response reference, outcome, usage and later settlement as distinct events. Redact secrets and sensitive message content. An authorization record alone never marks delivery, payment, provisioning or success complete.
8. Revalidate on retry, resume, queued dispatch and callback. Revocation, expiry, tenant/owner change, account unlink, policy change or stale session fences new effects. Reconcile effects already in flight and report unknown status honestly.

Minimize what actions reveal and what they can affect. For example, expose `reply_to_thread(thread_id, body)` with a server-resolved original recipient rather than `send_email(to, body)` when the workflow only needs a reply. For payments, bind human approval to the exact payee, amount, currency, account and expiry. For unknown or newly added destinations, require the configured owner review. A safe prompt is not an authorization check.

## Tenant isolation, revocation and audit

- Bind every credential row, encrypted material, grant, provider account, adapter invocation, idempotency key, usage record and effect receipt to tenant and exact owner/account/agent scope. Use tenant-keyed encryption and audited key rotation according to the existing secret-storage plan. Keep credentials out of general agent databases and durable conversation/checkpoint payloads.
- Prevent confused-deputy use. The caller cannot choose a different tenant, account, owner, provider, callback or credential reference. Derive these from the authenticated principal and current host record. Verify the authenticated registered agent is the grant recipient.
- Minimize token lifetime and scope for provider-minted credentials. Do not assume audience alone binds possession. Use DPoP, mTLS, OAuth token exchange or workload identity only where the exact token endpoint, verifier and deployment support it and threat testing confirms the binding.
- Revocation first prevents new host-authorized actions and scheduled work. Then revoke provider tokens/refresh credentials and unlink or rotate provider state where supported. Persist each result. If provider revocation cannot be confirmed, expose the residual expiry and containment state to the operator and owner.
- Maintain an append-only, access-controlled audit trail with identity, tenant, account, grant/policy revision, operation, normalized resource reference, decision, approval reference, idempotency digest, provider effect reference, outcome, timestamps and usage. Do not log secrets, full credentials, raw authorization headers, unnecessary content or hidden model reasoning.
- Keep clear statuses for requested, held for approval, denied, admitted, dispatching, completed, failed, indeterminate, revocation pending and revoked. Do not convert an unknown provider result to success or failure without evidence.

## Implementation sequence and acceptance

1. **CB01 — Source and threat-model audit.** Trace credentials from connect through encryption, storage, adapter calls, extension/MCP/SDK exposure, provider response, revoke and deletion. For each reachable operation record caller authentication, actor/tenant derivation, grant enforcement point, provider credential location, raw data returned, idempotency, retries, spend, revocation and tests. Threat-model prompt injection, confused deputy, compromised worker, cross-tenant IDOR, replay, token theft, malicious provider manifest, stale grants, webhook forgery, log leakage and uncertain external effects. Reuse security and lifecycle requirements in the AgentPort and managed-services ledgers.
2. **CB02 — Typed host-proxy MVP.** Select a single existing operation with a real host-held credential and a bounded schema, preferably an existing AgentMail reply/send path after fixing its intentional agent-role restriction through a scoped host execution identity. Add operation-bound authorization, owner recipient/autonomy rules, current-grant check, durable idempotency, bounded response, audit receipt and explicit indeterminate recovery. Preserve the owner's existing connection and provider billing contract. No generic HTTP proxy.
3. **CB03 — Credential vault and lifecycle.** Verify encryption/key separation, no credential in public SDK/agent result/log, rotation, reauthorization, unlink, owner deletion and provider deletion behavior. Exercise old/missing data compatibility and cleanup failures. Keep account credential references opaque and non-authoritative.
4. **CB04 — Provider-minted temporary credentials.** Inventory candidate providers and verify exact API support for token exchange or temporary credentials, scope granularity, audience/holder binding, TTL, refresh, revocation, terms, regions and payer. Implement one only if it reduces risk without giving the task more authority than intended. Keep provider-specific availability explicit.
5. **CB05 — Unified adapter and developer contract.** Define typed action schemas and SDK/MCP behavior for adapters already authorized. Ensure provider manifests cannot create grants or claim unverified operations. Extension and template declarations request symbolic capabilities; the host maps them to installed adapters and owner grants. Round-trip schemas and reject attempted authority escalation.
6. **CB06 — Controls, accounting and acceptance.** Integrate existing approval, budget, billing, idempotency and operation-recovery authorities. Test cross-tenant isolation, revoked/expired grants, malicious recipient/tool input, parameter substitution, stale policy, duplicate/unknown dispatch, provider timeout, callback replay, token leakage scan, log redaction and revocation race. Use local fixtures first, then separately authorized disposable provider credentials and live acceptance. Distinguish successful tests from executed provider contracts and deployment evidence.

A rollout requires verified provider terms and API behavior for each operation, current security review, explicit customer consent, data retention and regional disclosures, invoice/usage evidence where billed, and operator recovery procedures. A CB4A-inspired implementation must not be described as CB4A compliant or standardized without an applicable conformance specification and independent review.
