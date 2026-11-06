# Email channel and wakeup evidence

Scope: complete the email portion of `Replace_AgentMail_Cloudflare.txt` using the later channel/session and AgentPort product-boundary corrections in that same transcript.

## Requirements and source context

| Requirement from the conversation | Implementation | Verification / remaining constraint |
| --- | --- | --- |
| Around lines 5997–6653: channels are long-lived resources; threads, sessions, and runs are separate; channel access is independent of event wake subscriptions. | AgentPort provisions native email as an `agentport_channels` resource and makes `message.received` discoverable through the existing service event registry. Migration 0170 promotes older mailboxes while preserving account and owner relationships. Naelao receives assistant email through `naelao-channel-sessions`; the consumer creates/uses an email channel session and, for project assistants, an idempotent project channel thread linked by `channel_session_id`. | AgentPort route tests assert channel, event, reference, and delivery creation. Migration tests verify mailbox address, account owner, and status remain intact. Naelao communication and queue tests assert email is queued and deduplicated. Project queue metadata is validated. |
| Around lines 6657–7255: runtimes own session policy; event delivery supports direct/coordinator/parallel choices and activity leases are optional, expiring, subscription-scoped primitives. | AgentPort reuses its existing REST/MCP/SDK/CLI event subscription, claim, acknowledgment, and activity lease contracts. Email events feed those contracts; AgentPort does not create Naelao sessions. Naelao's email delivery uses the existing durable wake queue and existing channel-session policy. | Relevant unit tests and typechecks pass. The Naelao path currently uses the established direct channel wake behavior; coordinator batching and custom session resolvers remain runtime configuration work outside this email slice. |
| User correction in the transcript and follow-up: AgentPort must not store channel message bodies or attachments; Naelao is one client; email should behave like other supported channels. | AgentPort only persists account/channel/thread/message references, sender trust metadata, event IDs, and provider message references. Signed raw mail continues to the configured callback. Naelao persists content in its existing encrypted communication storage and channel session. | Inbound event test checks `payload_ref` is the provider message ID and delivery metadata contains no body. Live provider delivery is not enabled in the current deployment configuration. |
| Latest request: include email in channel wakeups for Space and project assistants. | `receiveAssistantEmail` enqueues ordinary inbound messages with provider ID, sender, trust, subject, attachment references, and optional project ID. Queue dispatch scopes stable sessions by project and sender, stores the message in Naelao's session, and invokes the assistant. Approved owner commands retain their existing direct path and do not trigger a second wake. | `communications.test.ts`, `session-queue.test.ts`, and AgentPort route tests pass. Live email ingress cannot be exercised because production/staging domains and provisioning flag are unset and provider credentials are unavailable. |

## Conflicts and decisions

- Earlier assistant text in the transcript proposed storing message bodies in AgentPort. The user's later explicit correction supersedes that suggestion. This implementation keeps message bodies out of AgentPort.
- AgentPort's webhook carries the raw inbound message to the endpoint selected by the account owner. AgentPort records only references and event state. The endpoint/runtime is responsible for storing content and interpreting events.
- Naelao's managed assistant mail is a Naelao feature and is not hardcoded into AgentPort. It enters Naelao's channel wake queue directly. External AgentPort clients use the generic event API and select their own runtime callback/poll/MCP behavior.
- Cloudflare email delivery remains gated by the existing explicit configuration checks. Tests verify local event and queue behavior, not production provider acceptance or DNS/domain setup.

## Verification record

- `vitest run workers/agents/src/communications/communications.test.ts workers/agents/src/channels/session-queue.test.ts workers/agentport/src/core/routes.test.ts workers/spaces/src/infra-migrations.test.ts`: 4 files, 18 tests passed.
- TypeScript checks passed for `workers/agents/tsconfig.json` and `workers/agentport/tsconfig.json`.
- TypeScript check passed for `packages/agentport-sdk/tsconfig.json`; `git diff --check` passed.
- AgentPort Wrangler dry-run passed and confirmed the email binding. The Agents Wrangler dry-run began building its existing ToolSandbox Docker image, which installs a full browser/desktop toolchain; it was stopped before Worker bundling completed. No production deploy was attempted.
- The broader local communications/AgentPort suite reported 126 passing and 2 skipped tests; one unrelated integration file could not load the Cloudflare-only `cloudflare:workers` module in Vitest. The focused changed-path suite and migration test pass.
- `biome check` over touched files reported pre-existing formatting and lint violations in the repository's compact AgentPort files and SDK; it did not modify files. No repository-wide formatting was applied.
- GitHub Actions run `42177011431` on commit `ee0de951`: repository, workspace, Node, conformance, runtime acceptance, typecheck, security lint, router dependency, binding probe, and agent authorization jobs passed. The browser journey job was still running at last inspection; GitHub had not published its suite result/artifact yet.
- Earlier assistant claims and examples in the source transcript were treated as proposals; the implementation follows the user's explicit later corrections and existing repository contracts.
