# AgentPort registry API (internal integration notes)

AgentPort is a standalone service at `https://agentport.naelao.com` with independent developer registration, API keys, REST, SDK, CLI, and MCP access. External developers use that public AgentPort API directly. Naelao also exposes a protected `/spaces/:spaceId/agentport/...` client proxy: the router authenticates the Naelao user or hosted agent, and the worker verifies the tenant-bound internal signature. The proxy is one first-party integration path, not the product boundary.

Naelao-hosted agents receive a managed AgentPort identity during agent creation, before the agent definition is published. This is the no-extra-login default, scoped under the Naelao tenant and creator principal. A user or organization that wants to use its independently owned AgentPort workspace can authorize a platform OAuth client using Authorization Code + PKCE; this is an explicit link with separate grants and revocation. OAuth access tokens authorize AgentPort API operations only, and the external provider remains responsible for provider accounts and channel data.

## Resource model

- A principal is a person, organization, or platform that controls resources.
- An agent has an AgentPort canonical ID, creator, host platform/space, and optional runtime/key-set references.
- A service manifest lists its endpoint type (`api`, `mcp`, `a2a`, `channel`, or `managed`), declared capabilities/events, connection purpose, partnership status, and supported account models.
- An account is a service resource owned by a person, organization, AgentPort, or provider. It is created pending and must be activated after a supported provider workflow succeeds.
- Grants connect accounts to agents with explicit permissions and optional expiry. Multiple agents may share one account; revoking a grant does not delete that account.
- Dependencies distinguish provisioning cycles (blocked) from operational cycles (returned as warnings).
- Events are durable references/metadata, not message bodies. Channel providers retain message content, attachments, and history; AgentPort keeps provider-native message/thread IDs plus routing and trust metadata. Each matching subscription gets an independent delivery row. Account-scoped subscriptions require an active, non-expired grant.
- Event consumers claim with an expiring lease, then acknowledge `delivered`, `retry`, or `dead_letter`. Retry is delayed five seconds and exhausted deliveries dead-letter after eight claims. Activity leases expire after a bounded TTL.

## Routes

All routes are tenant-bound by the authenticated Space proxy.

```text
POST   /services
GET    /services
POST   /agents
POST   /accounts
POST   /accounts/:accountId/activate
POST   /accounts/:accountId/grants
DELETE /grants/:grantId
POST   /accounts/:accountId/dependencies
POST   /events/subscriptions
POST   /events
GET    /events/pending?agentId=...
POST   /events/:eventId/claim
POST   /events/:eventId/ack
POST   /activity/leases
POST   /activity/leases/:leaseId/renew
DELETE /activity/leases/:leaseId
```

Example service manifest:

```json
{
  "id": "provider.mail",
  "name": "Mail provider",
  "type": "managed",
  "accountModels": ["agent_native", "agentport_parent"],
  "capabilities": ["mail.read", "mail.send"],
  "events": ["message.received"],
  "connectionPurpose": "agent_resource",
  "partnershipStatus": "unaffiliated"
}
```

`unaffiliated` is the default: a manifest never claims provider approval. Registering a service does not authorize AgentPort to call or resell it. Provider actions, credentials, mailbox message storage, KYA credential issuance/verification, approvals, budgets, provider webhook/poll delivery and external-runtime wake-up adapters are not implemented by this API yet. See [`REPLACE-AGENTPORT-IMPLEMENTATION-RECORD.md`](../../../new%20plan/REPLACE-AGENTPORT-IMPLEMENTATION-RECORD.md) for the requirement/evidence ledger and open work.

For channel reads and sends, AgentPort's authorization endpoint checks grants and returns provider resource references only. The runtime or developer's authorized provider API/MCP connector performs the actual operation. Message content must never be submitted to AgentPort.
