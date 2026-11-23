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

### One-turn WhatsApp customer simulation implementation

- Added an owner/admin-only action on the existing Channels route. It also requires current project
  membership and the exact enabled channel link bound to the requested active installation.
- The Agent Durable Object rechecks the binding, handler digest and active installation, acquires
  the installation runtime lease, and runs one synthetic `message.received` through the channel
  isolate with a fresh conversation and empty session state.
- The isolate has no RPC capabilities or ambient outbound network. The simulation does not query
  Knowledge, read attachments, invoke model answering, send a provider message, write session
  state, create a transcript or save a replay. It returns a staged reply or answer request plus any
  session updates, labelled as not delivered/not executed/not saved. The Shell shows this beside
  the active WhatsApp handler and explains the omitted context.
- `corepack pnpm@9.12.0 --filter @naelao/agents-worker run typecheck` passed. A targeted Shell
  typecheck of `ChannelConnect.tsx` and `api.ts` passed. The full Shell typecheck still reports
  stale `.next/types` imports for missing generated route pages; no changed source file was among
  those errors. `git diff --check` passed. No tests, provider actions or deployment ran.

Replay, conversation history, Knowledge snapshots and member phone testing remain separate slices.
Next, implement admin member grants and self-verified contact bindings with a separate multi-Space
identity model; do not reuse `executive_contacts` or `channel_pairings` as member proof.

### Admin-granted member access — 2026-11-23

- Added migration `0285_whatsapp_member_channel_access.sql` for WhatsApp grants scoped to one Space
  assistant or one exact Project assistant. Grant status is enabled, suspended or revoked; revisions
  and actor/time audit rows are recorded. The schema stores no phone or other contact value.
- The existing Channels API now lists grants for Space owners/admins and lets them grant, suspend or
  revoke a current Space member. Project-scoped changes also require the acting admin's Project
  access and an active target Project membership. The Shell API has typed helpers for these calls;
  there is no user-facing grant panel while member routing remains unavailable.
- Agents typecheck passed using pinned pnpm `9.12.0`; a targeted Shell API typecheck and
  `git diff --check` passed. The workspace has Node `24.19.0` while `.nvmrc` specifies Node `20`;
  the package engine allows Node `>=22.5.0`. No tests, migration apply, provider action or
  deployment ran.
- This grants slice is an intermediate checkpoint for the still-open member-routing task. Next:
  implement authenticated member-started single-use WhatsApp contact challenges, bind a sender to
  that member and Space separately from pairings, then resolve the binding before unpaired routing
  and recheck grant, Space membership and Project membership on every message. Design explicit
  selection when the same sender has verified access to multiple Spaces/projects.

### Member self-verification and contact binding — 2026-11-23

- Migration `0286_whatsapp_member_contact_verification.sql` stores active/replaced/revoked contact
  bindings, pending single-use challenges and audit events. It stores HMACs of both the configured
  platform destination and normalized sender; phone numbers are not copied into this map. A sender
  may bind independently in several Spaces, while one active sender cannot be claimed by two
  members in the same Space.
- A signed-in Space member can request a five-minute code only while they have an active member
  grant and WhatsApp is enabled. They send `VERIFY <code>` to the configured platform WhatsApp
  destination. The signed inbound handler verifies that the message reached the configured
  destination, consumes the challenge once, rechecks membership/grant/channel state, records
  replacement and verification events, and replies with a status. Duplicate delivery of the same
  webhook event is idempotent.
- Contact bindings are not yet used to select or route an assistant. Ordinary inbound messages
  still use existing pairings, so this verification checkpoint alone does not provide member
  assistant access. Route selection, per-message access checks and an explicit multi-Space/project
  chooser are the exact next code slice.
- Agents typecheck, targeted Shell API typecheck and `git diff --check` passed with pnpm `9.12.0`.
  The workspace uses Node `24.19.0` (`package.json` permits `>=22.5.0`) while `.nvmrc` says `20`.
  No tests, migration apply, provider operation or deployment ran.
