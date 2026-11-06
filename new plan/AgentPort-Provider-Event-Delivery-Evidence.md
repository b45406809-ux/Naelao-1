# Provider event notification delivery

## Requirement and implementation

- The user's channel and provider clarification calls for AgentPort to deliver events to any compatible runtime, while each runtime chooses how to wake sessions and use provider tools. AgentPort subscription webhooks now deliver signed, metadata-only event notifications; polling and MCP clients continue using the event inbox. Naelao is not a special destination in AgentPort.
- Subscription owners configure a public HTTPS callback, get a per-subscription verification secret, inspect or revoke the subscription through REST, SDK, CLI, or MCP, and verify the raw bytes and timestamp with the SDK helper. Callback responses confirm receipt of the notification; event claims and acknowledgments remain separate operations.
- Migration 0171 adds durable notification attempt state without changing existing events or storing provider content. The scheduled dispatcher claims attempts, retries with bounded backoff, honors active service/account/grant/agent/subscription state, and recovers expired processing claims. Individual delivery IDs allow independent subscriptions to claim and acknowledge the same event.
- Generic event and channel-event ingestion now repair missing delivery records on a repeated provider event instead of treating every insert failure as a duplicate. Email ingress reuses the actual stored event ID when a provider retries.
- Revoking a subscription closes its pending deliveries and activity leases. A developer may subsequently reactivate the same subscription group with a new callback; previously closed events do not become new wakeups.

## Verification and boundaries

- Local AgentPort, SDK, and migration tests passed; tests exercise signed notification bytes, failed delivery retry, event claim/retry/acknowledgment, independent subscriptions, and revoked grants. CLI tests and AgentPort/SDK TypeScript checks passed. Wrangler production dry-run built the Worker.
- GitHub Actions inventory run 42185689753 tested code commit 614ded32. Its recorded Node, conformance, typecheck, security-lint, runtime-acceptance, and connected worker suites passed. Repository (7 failures), workspace (4 failures), and browser-journey (6 failures) suites failed in existing agent-template, credential, Desk-Drop, Product session, router CORS, language preference, and browser journey tests outside the event-delivery changes. These are recorded suite outcomes; the job wrappers themselves reported success before the summary failed the run.
- Webhook notifications are at-least-once wake signals. A receiver must deduplicate delivery IDs, return a 2xx only after durable acceptance, and claim and acknowledge the event separately. Failed notification delivery eventually becomes a visible dead letter while the event remains available for authorized polling.
- The current Naelao email wake changes were already present as uncommitted work before this AgentPort delivery task and are not included in the AgentPort commit. A provider-backed inbox and the Naelao runtime adapter remain separate work; generic notifications alone do not grant access to provider content.
- Live callback delivery requires deployment of migration 0171 and the scheduled Worker, a configured AgentPort signing secret, and a reachable client-owned HTTPS receiver. No live production delivery was attempted in this workspace.
