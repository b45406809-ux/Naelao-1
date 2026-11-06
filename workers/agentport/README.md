# AgentPort

AgentPort is an independent identity and service-account provisioning product. Its public API is hosted at `https://agentport.naelao.com`; developers have separate AgentPort sign-in, organizations, API keys, and OAuth clients. Any agent builder can connect through REST, the TypeScript SDK, CLI, or MCP. The base URL is configurable in the SDK and CLI for self-hosted deployments.

Naelao is one first-party AgentPort client. Its signup integration can create a platform-managed AgentPort principal, and its router can proxy authenticated calls to AgentPort. AgentPort's public contract does not depend on Naelao workspaces, microapps, messaging, or product records. Product builders keep those resources and customer data in their own systems.

AgentPort stores agent identities, principal ownership, provider/service registrations, opaque service-account references, scoped account grants, channel and thread references, message identifiers and trust metadata, provider event delivery intent, and activity leases. Message bodies and attachments remain with the channel provider. Credential values remain in the provider/host credential service; AgentPort records references only.

## Identity and ownership

An agent identity belongs to an AgentPort principal. Principals can represent individuals, organizations, or platforms. Agent registrations also identify the host platform and can carry an opaque `hostResourceId`; AgentPort does not interpret that resource as a Naelao workspace or as proof of legal ownership. Organization or employee authority must be represented by an explicit owner/delegation relationship and verified through an appropriate identity provider before it is treated as verified.

A new Naelao account receives a managed AgentPort principal as a first-party convenience. Developers at other platforms use the same AgentPort developer signup and API-key flow, or register an OAuth client and request authorization. A Naelao user or organization that wants its own AgentPort organization links it using AgentPort OAuth. No provider-message data is copied into AgentPort by these flows.

## API surface

- `POST /v1/services`, `GET /v1/services`: register and discover provider/service manifests, capabilities, account models, authorization requirements, and event types. Provider authentication values are kept in a separate protected store; raw secrets are rejected in manifests.
- `POST /v1/agents`, `GET /v1/agents`, `GET /v1/agents/:id/identity`: create identities owned by the API-key/OAuth principal and inspect the public identity record.
- `POST /v1/agents/:id/credentials`: issue an audience-bound, expiring AgentPort mandate after owner authorization.
- `POST /v1/accounts`, `POST /v1/accounts/:id/activate`, `POST /v1/accounts/:id/grants`: register service-account references, reflect provider-side activation, and grant scoped agent access. Actual account creation and provider actions require a configured, authorized provider adapter; registration alone does not provision an upstream account.
- `POST /v1/channels`, `/v1/channels/:id/threads`, `/v1/threads/:id/message-references`: store provider identifiers and trust metadata. Read or send message content through the channel provider using its authorized API/MCP tools.
- `POST /v1/events/subscriptions`, `POST /v1/events`, `/v1/events/pending`: store event delivery intent and opaque provider references, not message payloads.
- `POST /v1/activity/leases`: maintain expiring event-consumer leases.
- `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`: implement AgentPort's Authorization Code with PKCE flow for independent client applications.

Product-specific apps, microapps, customer records, and customer billing are intentionally outside AgentPort's API. Client platforms scope their own resources and use AgentPort identities, accounts, grants, and usage integrations as needed.

## SDK, CLI, and MCP

The TypeScript package is `@agentport/sdk` in this monorepo. It accepts an AgentPort API key or OAuth access token and supports configurable `baseUrl` and `fetch`. The CLI package is `@agentport/cli`; configure `AGENTPORT_API_URL` and `AGENTPORT_API_KEY`. The Streamable HTTP MCP endpoint is `/mcp`; it exposes provider discovery, identity registration, account registration/grants, channel references, events, and activity lease tools.

```ts
import { AgentPortClient } from "@agentport/sdk";

const port = new AgentPortClient({
  apiKey: process.env.AGENTPORT_API_KEY,
  baseUrl: process.env.AGENTPORT_API_URL,
});
const { agent } = await port.registerAgent({
  hostPlatform: "my-agent-builder",
  runtime: "external",
});
const { account } = await port.createAccount({
  serviceId: "mail-provider",
  accountModel: "delegated",
  ownerType: "organization",
  ownerId: "org_123",
  credentialRef: "vault://provider/mail/account-123",
});
await port.grantAccount(account.id, {
  agentId: agent.id,
  permissions: ["email.send"],
});
```

The developer configures provider manifests and credentials in their AgentPort organization or connected provider system. A client receives scoped references, never upstream master credentials. Managed access remains gated on provider authorization, an available adapter, and any required commercial permissions.

CLI examples:

```sh
agentport auth register --json '{"email":"dev@example.com","password":"..."}'
agentport agents register --json '{"hostPlatform":"my-agent-builder","runtime":"external"}'
agentport accounts create --json '{"serviceId":"mail-provider","accountModel":"delegated","ownerType":"organization","ownerId":"org_123","credentialRef":"vault://provider/mail/account-123"}'
agentport accounts grant --account <account-id> --json '{"agentId":"<agent-id>","permissions":["email.send"]}'
```

## Development and deployment

Run `pnpm --filter @agentport/sdk test`, `pnpm --filter @agentport/cli test`, and the AgentPort worker tests through the repository's workspace scripts. Apply migrations through `0168_agentport_client_neutral_host_resources.sql` before deployment. The migration copies existing host workspace identifiers into the new opaque host-resource field and retains the legacy column and provisioning records.

Production uses `agentport.naelao.com`; staging uses `agentport-staging.naelao.com`. These are AgentPort's current service domains, not required client-platform domains.
