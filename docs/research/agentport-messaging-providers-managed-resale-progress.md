# AgentPort messaging providers and managed resale progress

## Current reconciliation — 2026-11-23

### Provider and caller inventory

| Surface | Current source state | Boundary |
| --- | --- | --- |
| AgentPort provider registry and provider SDK | `workers/agentport/src/core/routes.ts` stores and returns provider-declared manifests. `packages/agentport-provider-sdk/src/index.ts` validates and publishes those declarations; its comment leaves provider actions/account creation to an authorized provider API or connector. | Registry metadata is not an executable adapter, Naelao operator approval, regional availability, entitlement, or live evidence. |
| ClawMessenger, Linq, Photon and Sendblue | No matching adapter or caller exists under `workers/`, `apps/`, or `packages/`; these remain evaluation candidates in the plan only. | Do not create provider records, advertise BYO support, or implement against marketing descriptions. Contracts, supported API/auth/event contracts, account scope, regions and rates are absent. |
| Native AgentPort email | `workers/agentport/README.md` documents the Cloudflare Email path, but `workers/agentport/wrangler.toml` sets `EMAIL_PROVISIONING_ENABLED` to false in default, staging and production, with empty sending/ingress domains in deployed environments. | The native service is not an available substitute for a messaging adapter; no enablement or delivery acceptance was made. |
| AgentMail first-party integration | `workers/agents/src/communications/agentmail.ts` connects a provider inbox, registers its AgentPort account/channel/subscription, checks AgentPort grants before provider operations, applies owner autonomy/recipient/daily limits to sends, and persists idempotent/indeterminate send outcomes. `ManagedServicesPanel.tsx` exposes owner connection, unlink, event routing and thread routing. | This is a specific AgentMail path with its own provider credential, account, renewal and billing handling. It does not establish a generic AgentPort messaging adapter or resale rights for other providers. |
| Telnyx AgentPort sharing | `workers/agents/src/communications/telnyx-agentport.ts` exposes an owner-confirmed BYO SMS share and scoped action grant for an existing Telnyx binding. | It is not a Naelao-managed messaging account or a ClawMessenger/Linq/Photon adapter. Existing Telnyx terms, billing and deployment gates remain separate. |
| UserPort and other managed services | Current UserPort sync is tied to exact owner links, connector identity/digest, scopes and selected tools; Higgsfield, Agent37 and Telnyx have separate owner-selected paths. | Generic connector discovery does not create upstream messaging accounts, provider terms, or universal account lifecycle support. |

### Events, consent, content, Knowledge and runtime

- AgentPort stores provider event/message references and subscription/delivery state. Generic SDK consumers can poll or receive signed reference-only notifications, claim a delivery, persist their work and acknowledge/retry/dead-letter it. AgentPort does not accept provider message bodies or attachments on its generic channel routes.
- The reachable Naelao event-to-assistant caller is AgentMail: its owner-linked webhook verifies the provider signature and inbox identity, deduplicates the event, and submits only event/thread/message references. `workers/agents/src/index.ts` rechecks the current subscription and owner-selected account or per-thread route before waking the selected assistant. No owner route means no assistant wake. The session receives a provider reference; content is fetched separately through the exact authorized AgentMail tools.
- The first-party dispatch code labels its session/channel as AgentMail and only the AgentMail notification path currently enqueues this Naelao queue type. Do not generalize it to a different provider until that provider has an accepted event, identity, signature/replay and data contract.
- AgentMail owner-link unlink immediately retires the local connected inbox, clears its encrypted API credential and webhook secrets, and revokes its exact AgentPort account(s), grants and subscriptions. It does not delete the upstream AgentMail inbox or provider-held messages. Provider-side deletion, retention, export and jurisdiction remain provider-specific acceptance work. The UI describes local credential removal; it does not provide an upstream data-erasure receipt.
- No current AgentPort messaging event path indexes provider message content into Knowledge. Event references are not Knowledge documents. Provider content can enter an assistant's runtime context only through a separately authorized provider read; the existing Knowledge publication, scope and deletion authorities continue to govern Knowledge sources.
- Assistant wake uses the existing Agents/session and Space/Project route. AgentPort does not create a separate runtime, workspace, or checked publication path. Event authorization and normal host runtime gates remain independent of a provider manifest.

### Billing and authorization

- AgentPort's channel/action receipts are authorization decisions and provider resource references, not proof that a provider dispatched a message and not Billing settlement receipts.
- The existing AgentMail managed inbox flow has its own owner quote, recurring credit/rental, operation-recovery and usage records. AgentMail sends separately enforce the connection's consent/autonomy policy, allowed recipients, daily limit, provider idempotency key and uncertain-outcome recovery. These records do not supply a ClawMessenger/Linq/Photon rate card, subaccount payer model, message-cost invoice feed or Naelao Managed resale quote.
- Current commercial snapshots in the provider plans are research, not approved quote inputs. No provider signup, account creation, message, purchase, invoice lookup, or rollout occurred in this reconciliation.

### Status and resume conditions

The AgentPort source-to-caller reconciliation is complete for the current branch; no local provider-adapter change is supported by current authority or records. The plan remains open for provider-specific work. Resume a candidate only after its applicable executed terms and authorized use mode, current API/auth/event and account lifecycle contract, supported territory, exact pricing/payer/invoice evidence, retention/deletion duties and security acceptance are established. Then implement one capability-gated adapter using the existing AgentPort grants, durable operations, Billing and owner consent records; keep unverified capabilities unavailable.

No tests or typechecks were run. `git diff --check` is the documentation checkpoint hygiene check. No provider, migration, deployment, purchase, external message or rollout was used.
