# AgentPort host integration notes

AgentPort's public API, developer accounts, OAuth clients, REST, SDK, CLI, and MCP interfaces are product-neutral. Host platforms authenticate their own users and may proxy calls to AgentPort's private registry routes using tenant-bound internal signatures and generic `x-agentport-*` identity headers. AgentPort treats host platform IDs and resource IDs as opaque strings; it does not query a host's workspace, user, message, or product database.

A host can bootstrap a platform-managed principal for a new user and register host-owned agents. The host remains responsible for authenticating the user, validating its own workspace membership, and passing the correct tenant, actor, and role context. Independently owned AgentPort organizations link through AgentPort OAuth and retain their own API keys and grants.

The internal registry route is `/internal/agentport`. It accepts only tenant-bound signatures. Do not expose it as a public client endpoint; public clients use the scoped `/v1` API, OAuth, CLI, SDK, or MCP transport.
