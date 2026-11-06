# AgentPort standalone API

AgentPort is deployed as its own Worker at `https://agentport.naelao.com`; `/auth` is its developer sign-in and registration entry point. It is not a route inside the Naelao application. Naelao calls this service as one AgentPort client. AgentPort owns developer/org identities, login sessions, API credentials, agent principals, provider registrations, resource grants, channel/thread references, provider-event receipts, and activity leases. The connected channel provider (WhatsApp, Telegram, email, etc.) remains the source of truth for message content, attachments, and conversation history. AgentPort never acts as a conversation store.

## Sign in and choose how AgentPort is used

AgentPort human accounts are separate from Naelao accounts. Developers can register or sign in at `https://agentport.naelao.com/auth` and create their own organization and API credentials. Naelao signup creates a Naelao-managed AgentPort organization and principal by default, so Naelao agents can use AgentPort without a second login or user-managed API key. A user or organization can register its own AgentPort organization and authorize a host product to use it through the same generic OAuth API and SDK available to every builder. OAuth is Authorization Code with PKCE, exact registered redirect URIs, short-lived access tokens, and rotating refresh tokens when `offline_access` is requested. AgentPort acts as an identity/API provider here: it does not ingest connected provider message bodies, attachments, or service-account credentials.

## First API key

```sh
curl -X POST https://agentport.naelao.com/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com","password":"a-long-password","org_name":"Example"}'

curl -X POST https://agentport.naelao.com/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com","password":"a-long-password"}'

curl -X POST https://agentport.naelao.com/v1/keys \
  -H 'authorization: Bearer <owner JWT from login>' \
  -H 'content-type: application/json' \
  -d '{"scopes":["agentport:read","agentport:write","agentport:events"]}'
```

The API key secret is returned once. Store it as `AGENTPORT_API_KEY` in your host's secret manager. Keys support `agentport:read`, `agentport:write`, `agentport:events`, and `agentport:admin`. They can create narrower keys and revoke keys they own. Stored API-key material is one-way hashed.

Agent platforms can register an OAuth public client with `POST /v1/oauth/clients` using the developer access token. Use `createAgentPortPKCE()` to create a one-time verifier, S256 challenge, and state; save the verifier and state in the host product's user session, then redirect to `buildAgentPortAuthorizationUrl(...)`. Check the callback state before exchanging the returned code at `/oauth/token`. The resulting bearer token can initialize `AgentPortClient` with `accessToken`; refresh tokens rotate and can be revoked with `revokeAgentPortToken()`. Client redirect URIs can be listed and revoked by the registering developer. Store OAuth tokens in the host platform's encrypted secret/session store. Neither AgentPort nor OAuth receives provider account credentials or channel messages.

Developer passwords are PBKDF2-SHA256 hashed, signup/login attempts are rate-limited, and owner JWTs expire in one hour. Change a password with `POST /v1/auth/password` or clear and invalidate the browser session with `POST /v1/auth/logout`. Registration currently does not verify email ownership. `DELETE /v1/account` permanently removes the developer organization, API keys, agents, services, account records, grants, channel/thread references, provider-event receipts, and leases.

## API and interfaces

Base URL: `https://agentport.naelao.com/v1` (set `AGENTPORT_API_URL` for another domain).

- `POST /agents`, `GET /agents`: register and list persistent agent identities.
- `POST /services`, `GET /services`: register and discover existing API, MCP, A2A, channel, or managed services. Manifests declare supported account models, capabilities, events, and partnership status.
- `POST /accounts`, `GET /accounts`, `POST /accounts/:id/activate`, `POST /accounts/:id/grants`, `DELETE /grants/:id`: record provisioned resources and grant/revoke agent access.
- `POST /apps`, `GET /apps`, `GET /apps/:id`: create and inspect isolated microapp identities with managed, BYOK, or customer billing mode and a monthly budget.
- `POST /apps/:id/capabilities/provision`: request a scoped capability handle at build time or runtime, with optional provider/account selection, customer limits, and budget. Handles are references to an already-authorized provider connector; they never contain provider credentials.
- `POST /apps/:id/capabilities/:handleId/usage`, `GET /apps/:id/usage`: record idempotent app-reported consumption and enforce configured per-customer and monthly limits. Customer references are hashed. The returned totals are app-reported estimates, not provider-confirmed settlement.
- `GET /services?capability=...&accountModel=...`, `GET /services/:serviceId`: discover and inspect only provider-declared capabilities, account models, provisioning and billing metadata.
- `POST /channels`, `GET /channels`: associate provider channels with active AgentPort accounts and list available channels. Trusted sender records classify provider-authenticated sender IDs; message text or model claims cannot assign sender roles.
- `POST /channels/:channelId/threads`, `GET /channels/:channelId/threads`, `GET /threads/:threadId/message-references`: retain provider conversation and thread IDs separately from runtime sessions. An optional `sessionBinding` is opaque; AgentPort does not create or own sessions. Reference listings contain metadata only; call the provider directly to read or send messages.
- `POST /threads/:threadId/actions/authorize`: check an agent's `messages.read` or `messages.send` grant and return provider resource references. The agent/runtime then fetches or sends the actual content through the provider's authorized API/MCP connector. This endpoint does not issue provider credentials or perform the action.
- `POST /channels/:channelId/message-events/inbound`: provider adapters post authenticated provider message/thread/sender IDs and timestamp only. AgentPort derives `owner`, `delegate`, or `external` from its trusted-sender registry and creates a `message.received` event for subscribers. The event's `dataRef` points to the provider message; content and attachments stay with the provider.
- `POST /accounts/:id/dependencies`: record resource dependencies and reject unresolved provisioning cycles.
- `POST /events/subscriptions`, `POST /events`, `GET /events/pending`, `POST /events/:id/claim`, `POST /events/:id/ack`: persist subscriptions and event deliveries with retry and dead-letter handling.
- `POST /activity/leases`, `POST /activity/leases/:id/renew`, `DELETE /activity/leases/:id`: maintain expiring event-consumer leases. A lease applies to its subscription; it does not lock the account or define the agent's Naelao session.
- `POST /keys`, `GET /keys`, `DELETE /keys/:id`: create scoped child keys, list, and revoke.
- `DELETE /account`: erase the current AgentPort organization and its tenant data.
- `POST /mcp`: MCP Streamable HTTP; initialize protocol negotiation, list tools, and call AgentPort tools with the same API key.

Provisioning stays honest about provider readiness. `managed` handles require an independently approved AgentPort partnership and a provider declaration that permits self-service provisioning. Because no managed provider execution adapter is deployed yet, those handles remain `adapter_unavailable` even after provider approval; they cannot be used to imply working managed service. `byok` and `customer_oauth` handles require an active account created after the user's authorized provider flow. If authorization is missing, the capability request is saved with `authorization_required`; unapproved managed providers remain `provider_approval_required`. AgentPort returns no credentials and does not execute the provider API; the app/runtime calls the authorized provider connector. Provider-reported settlement is not available until that provider supplies a verified adapter.

Naelao-hosted agents can create or request capabilities only for the individual principal that owns the agent. A ready request is held as `owner_approval_required` until its owner approves it through the AgentPort API, CLI, or MCP tool. An agent cannot approve or revoke its own handles. Every app must set its own monthly budget regardless of who pays upstream. `provider: "auto"` chooses an eligible registered service deterministically, preferring an already authorized account and then an available authorization/provisioning path; this is availability-based selection, not an unverified price optimizer.

Apps should report usage before or immediately after each provider operation. AgentPort enforces configured limits when it receives a report, but it cannot prevent an operation already sent directly to a provider and cannot verify app-reported cost. Reported totals are estimates, not settlement. Consumers should use a provider-confirmed adapter for billable managed usage.

Channel event receipts expose a provider pointer as `dataRef`, alongside `threadRef` and event metadata. For example, a `message.received` event can point to a provider message ID. The runtime uses the provider's own authorized connector to read that message. It sends replies through that connector after checking the agent's grant with `POST /threads/:threadId/actions/authorize`; message text and attachments are never passed to AgentPort.

A provider service registration declares an existing provider/client integration. It does not itself provision an external account. The provider must allow the requested model and an existing authorized API/MCP/Composio connection must perform the provider action. AgentPort records the resulting account, grants, dependencies, costs metadata, event subscriptions, and provider-native resource references. Provider-side scopes and terms remain authoritative. AgentPort does not store message bodies, attachment data, or a message outbox; provider API/MCP execution and outbound webhook delivery still require an authorized adapter.

### TypeScript SDK

```ts
import { registerDeveloper, createDeveloperApiKey, AgentPortClient } from "@agentport/sdk";
const session = await registerDeveloper({ email, password, org_name: "Example" });
const { apiKey } = await createDeveloperApiKey({ userToken: session.token, scopes: ["agentport:read", "agentport:write", "agentport:events"] });
const port = new AgentPortClient({ apiKey });
const { agent } = await port.registerAgent({ hostPlatform: "openclaw", runtime: "external" });
const threadId = "thread_123"; // obtained from listThreads()
// Fetch messageReferences, then use the provider connector to fetch their contents.
const { decision, providerChannelId, providerThreadId } = await port.authorizeChannelAction(threadId, {
  agentId: agent.id, action: "messages.send", idempotencyKey: crypto.randomUUID(),
});
if (decision === "allow") {
  // Send the reply with the provider's authorized API/MCP connector.
}
```

### Provider onboarding SDK

Institutions can validate and publish a provider manifest with `@agentport/provider-sdk`:

```ts
import { publishProvider } from "@agentport/provider-sdk";
await publishProvider(port, {
  id: "example-bank", name: "Example Bank", type: "api", endpoint: "https://api.example.com",
  accountModels: ["user_parent", "agent_native"], capabilities: ["balance.read"], events: ["account.updated"],
  connectionPurpose: "parent_provisioning", auth: { type: "oauth2", scopes: ["balances:read"] },
  provisioning: { mode: "approval_required", requires: ["verified_organization", "bank_approval"] },
  billing: { model: "provider_defined" },
});
```

This SDK publishes a declaration only. It does not run the provider's account creation or capability handlers; those still execute through the institution's authorized API or an approved adapter. A provider cannot self-assert AgentPort partnership approval.

### CLI

```sh
agentport auth register --json '{"email":"dev@example.com","password":"a-long-password","org_name":"Example"}'
# Export data.token from the response as AGENTPORT_USER_TOKEN.
agentport keys create --json '{"scopes":["agentport:read","agentport:write","agentport:events"]}'
# Store returned apiKey as AGENTPORT_API_KEY.
agentport agents register --host openclaw --runtime external
agentport services list
agentport apps create --json '{"name":"RestaurantReels","ownerType":"organization","ownerId":"org_123","billing":"byok","budget":{"monthlyUSD":100}}'
agentport apps provision --app <app-id> --json '{"capability":"ai.video.generate","serviceId":"video-provider","authorization":"byok","phase":"build_time","limits":{"perCustomer":20}}'
agentport apps report-usage --app <app-id> --capability <handle-id> --json '{"idempotencyKey":"job_123","customerRef":"customer_456","quantity":1,"reportedCostUSD":0.04}'
agentport events pending --agent <agent-id>
agentport messages references --thread <thread-id> --agent <agent-id>
```

MCP/CLI/SDK/API share the same REST core and scope checks. Event subscriptions with `webhook` delivery are stored as intent only; no outbound webhook dispatcher is deployed yet. Runtimes can poll/claim/ack the persistent inbox. Session creation, event batching, thread-to-session resolution, heartbeat scheduling, and context rotation remain runtime responsibilities. A channel-use lease is scoped to an event subscription; tool use does not globally lock a channel.

## Deployment setup

Deploy `workers/agentport/wrangler.toml` to the `agentport.naelao.com` route. Configure `AGENTPORT_JWT_SECRET` and `PLATFORM_SECRET` with Wrangler secrets. Deployment applies migrations 0158–0167 before deploying this Worker. The AgentPort account and authentication store are independent of Naelao's developer accounts. Staging uses `agentport-staging.naelao.com`.
