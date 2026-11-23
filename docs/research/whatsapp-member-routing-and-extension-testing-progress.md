# WhatsApp member routing and extension testing — progress

Status: open. Source review is in progress on `Mcbt5s-Backup-2`; provider behavior, deployment,
member enrollment, isolated customer simulation and replay acceptance remain unverified.

## Current-source reconciliation — 2026-11-23

### Pairing and shared inbound route

- `workers/agents/src/index.ts` verifies the shared provider webhook signature, normalizes the
  sender, consumes the single-use pairing token, and resolves subsequent messages through
  `channel_pairings`.
- `infra/migrations/0070_channel_pairings.sql` keys a sender by `(channel, external_id)`. It
  represents one Space/project binding per provider sender. Before this checkpoint, both the QR
  pairing and Slack/Discord OAuth callback used `ON CONFLICT ... DO UPDATE`, so a second pairing
  silently redirected the existing sender.
- The pairing write now claims the exact existing scope with `ON CONFLICT DO NOTHING` and checks
  Space, tenant and project before activating the link. A collision reports that multi-Space or
  multi-project pairing is unsupported and leaves the original route intact. Same-scope retries
  remain idempotent. OAuth claims the binding before saving its Slack file token, so a competing
  callback cannot save credentials into a losing Space. If credential storage fails after claim,
  the pairing remains inert until a same-scope retry activates its `channel_links` row.
- Shared inbound now requires an enabled `channel_links` row whose project matches the pairing.
  Turning the channel off therefore stops paired sender dispatch; a missing or stale link fails
  closed.
- No test was run per repository instruction. `git diff --check` passed. No provider action or
  deployment occurred.

### Identity and extension authority found

- Pairing a sender does not prove that sender's identity as a Space member. The agent's existing
  executive-contact path checks the registered contact against current owner/admin membership;
  member-specific grants, self-verification challenges and member route selection are not present
  in the reviewed path.
- The WhatsApp extension webhook is a separate destination-number route. Its reviewed path verifies
  Meta's signature, resolves the phone-number ID to an active scoped installation, checks the
  pinned handler and forwards into project-bound extension handling.
- Customer extension dispatch can use ordinary delivery tools. A customer test or replay must not
  call the live inbound/delivery path without isolated simulated adapters.
- `channel_pairings` still cannot represent one sender independently paired to multiple Spaces or
  projects. This checkpoint fails closed rather than designing that product/data model.

### Simulation and replay callers

- No WhatsApp/customer extension test or replay route was found in the reviewed Agent, Space or
  Shell source. The existing reachable extension handler dispatch is the live path.
- Phone simulation is a useful bounded pattern but is provider-specific: its authenticated project
  route selects one active phone binding, pins the handler/settings and creates synthetic phone
  events. The Agent Durable Object invokes `runChannel` without a provider request or event receipt,
  rejects `channel.answer`, returns the reply, and does not save session updates.
- The channel isolate has no RPC capability binding or ambient outbound network. Its bounded host
  surface stages `reply`, `answer`, and session updates as outputs. For customer extensions, the live
  host additionally reads approved Knowledge/attachments, executes `channel.answer` through the
  Gateway reasoner, delivers via `deliveryTools.notify`, and persists session state. A customer
  simulation must stop at the isolate output boundary and label answer requests and session changes
  as proposals; it must not enter those live host steps.
- Member routing remains unimplemented: only the current owner/admin executive-contact path is
  established, and the shared provider identity row still has one Space/project target. Do not use
  admin-supplied phone numbers as member proof or infer member routing from pairing.

## Checkpoint and next action

The source reconciliation task is complete at code commit `8b2dcb5642027ea021c5039587cc7e784e5f74bd`.
`git diff --check` passed; no tests, typechecks, provider actions or deployment ran. Next, add a
single-turn, project-admin-scoped customer extension simulation that stages reply/answer/session
outputs without live model, provider, knowledge mutation or session-persistence effects. Replay,
conversation history, Knowledge snapshots and member phone testing remain separate later slices.
