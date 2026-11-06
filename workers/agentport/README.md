# AgentPort standalone API

AgentPort is deployed as its own Worker at `https://agentport.naelao.com`; `/auth` is its developer sign-in and registration entry point. It is not a route inside the Naelao application. Naelao calls this service as one AgentPort client. AgentPort owns developer/org records, login sessions, API keys, agent principals, provider registrations, account grants, channels, threads, messages, event inboxes, and activity leases.

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

Developer passwords are PBKDF2-SHA256 hashed, signup/login attempts are rate-limited, and owner JWTs expire in one hour. Change a password with `POST /v1/auth/password`; it revokes earlier login tokens. Registration currently does not verify email ownership. `DELETE /v1/account` permanently removes the developer organization, API keys, agents, services, accounts, grants, channels, threads, messages, events, receipts, and leases.

## API and interfaces

Base URL: `https://agentport.naelao.com/v1` (set `AGENTPORT_API_URL` for another domain).

- `POST /agents`, `GET /agents`: register and list persistent agent identities.
- `POST /services`, `GET /services`: register and discover existing API, MCP, A2A, channel, or managed services. Manifests declare supported account models, capabilities, events, and partnership status.
- `POST /accounts`, `GET /accounts`, `POST /accounts/:id/activate`, `POST /accounts/:id/grants`, `DELETE /grants/:id`: record provisioned resources and grant/revoke agent access.
- `GET /services?capability=...&accountModel=...`, `GET /services/:serviceId`: discover and inspect only provider-declared capabilities, account models, provisioning and billing metadata.
- `POST /channels`, `GET /channels`: associate provider channels with active AgentPort accounts and list available channels. Trusted sender records classify provider-authenticated sender IDs; message text or model claims cannot assign sender roles.
- `POST /channels/:channelId/threads`, `GET /channels/:channelId/threads`, `GET /threads/:threadId/messages`: persist provider conversation threads separately from runtime sessions. An optional `sessionBinding` is opaque; AgentPort does not create or own sessions.
- `POST /threads/:threadId/messages`: authorize against the account grant and place an idempotent outbound message in the durable outbox. The API returns `queued`; it does not say `sent` until a provider adapter acknowledges it. `/outbox` and `/outbox/:messageId/ack` are provider-adapter endpoints.
- `POST /channels/:channelId/messages/inbound`: provider adapters post authenticated inbound messages. AgentPort derives `owner`, `delegate`, or `external` from its trusted-sender registry and creates `message.received` events for subscribers.
- `POST /accounts/:id/dependencies`: record resource dependencies and reject unresolved provisioning cycles.
- `POST /events/subscriptions`, `POST /events`, `GET /events/pending`, `POST /events/:id/claim`, `POST /events/:id/ack`: persist subscriptions and event deliveries with retry and dead-letter handling.
- `POST /activity/leases`, `POST /activity/leases/:id/renew`, `DELETE /activity/leases/:id`: maintain expiring event-consumer leases. A lease applies to its subscription; it does not lock the account or define the agent's Naelao session.
- `POST /keys`, `GET /keys`, `DELETE /keys/:id`: create scoped child keys, list, and revoke.
- `DELETE /account`: erase the current AgentPort organization and its tenant data.
- `POST /mcp`: MCP Streamable HTTP; initialize protocol negotiation, list tools, and call AgentPort tools with the same API key.

A provider service registration declares an existing provider/client integration. It does not itself provision an external account. The provider must allow the requested model and an existing authorized API/MCP/Composio connection must perform the provider action. AgentPort records the resulting account, grants, dependencies, costs metadata and event subscriptions. Provider-side scopes and terms remain authoritative. The registry does not yet execute provider APIs or dispatch outbound webhooks; queued channel messages remain pending until an authorized adapter is configured.

### TypeScript SDK

```ts
import { registerDeveloper, createDeveloperApiKey, AgentPortClient } from "@agentport/sdk";
const session = await registerDeveloper({ email, password, org_name: "Example" });
const { apiKey } = await createDeveloperApiKey({ userToken: session.token, scopes: ["agentport:read", "agentport:write", "agentport:events"] });
const port = new AgentPortClient({ apiKey });
const { agent } = await port.registerAgent({ hostPlatform: "openclaw", runtime: "external" });
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
agentport events pending --agent <agent-id>
```

MCP/CLI/SDK/API share the same REST core and scope checks. Event subscriptions with `webhook` delivery are stored as intent only; no outbound webhook dispatcher is deployed yet. Runtimes can poll/claim/ack the persistent inbox. Session creation, event batching, thread-to-session resolution, heartbeat scheduling, and context rotation remain runtime responsibilities. A channel-use lease is scoped to an event subscription; tool use does not globally lock a channel.

## Deployment setup

Deploy `workers/agentport/wrangler.toml` to the `agentport.naelao.com` route. Configure `AGENTPORT_JWT_SECRET` and `PLATFORM_SECRET` with Wrangler secrets. Deployment applies migrations 0158–0163 before deploying this Worker. The AgentPort account and authentication store are independent of Naelao's developer accounts. Staging uses `agentport-staging.naelao.com`.
