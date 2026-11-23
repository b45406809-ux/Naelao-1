# WhatsApp member routing and extension testing — progress

Status: open. Member routing, the one-turn customer simulation and isolated conversation replay now
have local source implementations on `Mcbt5s-Backup-2`. Migration apply, tests, provider behavior,
deployment, authenticated UI and live acceptance remain unverified.

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

### Verified member route resolution — 2026-11-23

- Migration `0287_whatsapp_member_route_selection.sql` stores an expiring explicit selection keyed
  by the HMAC sender and destination; selected/cleared events include a unique provider event id so
  webhook redelivery cannot extend a selection or duplicate its audit event.
- Signed platform inbound resolves active contact bindings to enabled WhatsApp grants, current
  Space membership, active Space/channel state and exact current Project membership. It supports
  the Space assistant or exact Project assistant. A sender with multiple routes receives a
  deterministic ID-based chooser and selects with `USE <space-id> [project-id]`; selection expires
  after 30 minutes and can be cleared with `USE RESET`. A known contact with no current route fails
  closed instead of falling back to customer pairing.
- The exact active contact id and selected-route expiry/scope are passed to the Agent Durable Object.
  It rechecks the binding, grant, membership, channel and Project roster before transcript write,
  assistant run and outbound reply. Executive-only commands and approval tokens are not enabled
  through a member grant, even when the same phone also has a legacy executive contact.
- Agents typecheck and `git diff --check` passed. No tests, migration apply, provider operation or
  deployment ran. Admin/member UI, route visibility and explicit customer-only/staff-and-customer
  mode remain the exact next code slice; rollout gates remain off.

### Owner/member setup, routing mode and route-use visibility — 2026-11-23

- Added migration `0288_whatsapp_member_routing_mode.sql`. Each WhatsApp connection has an explicit
  `customer_service_only` or `staff_and_customers` mode with a revisioned admin audit. Member route
  candidates and the Agent DO now require the staff mode at dispatch. The paired inbound path also
  suppresses executive approvals, desktop/review commands and executive-contact routing in
  customer-service-only mode. The generic signed WhatsApp endpoint checks its exact connection
  mode and skips disabled/unconfigured links before dispatch.
- The Channels panel now provides owner/admin grant, suspend, restore and revoke controls for the
  Space assistant or exact Project roster. Members see their own grants, verification status,
  currently selected routes and last successful use. Eligible members can start or replace their
  own five-minute contact challenge and revoke all their own active contacts; revocation records an
  audit event, consumes pending challenges and clears route selections. Neither UI path exposes a
  phone value.
- Member inbound now reserves the HMAC provider-event identity before dispatch and records
  dispatched, rejected or uncertain state. A duplicate event cannot be rerouted after the member
  changes their selected assistant. The Channels API exposes last successful use and the current
  selection expiry without storing raw provider event IDs or senders.
- Agents typecheck passed with pnpm `9.12.0`; targeted Shell typecheck for `ChannelConnect.tsx`,
  `WhatsAppMemberAccessPanel.tsx` and `api.ts` passed; `git diff --check` passed. Full Shell
  typecheck remains blocked only by four existing stale `.next/types` imports to missing routes.
  No tests, migration apply, provider action or deployment ran; provider and rollout behavior remain
  unverified.
- This completes the source implementation and UI portion of member routing. Next: implement the
  separate isolated conversation replay path with pinned installation/settings and simulated
  Knowledge/tool adapters, avoiding live delivery, side effects and session writes.

### Isolated WhatsApp conversation replay — 2026-11-23

- The owner/admin Project inbox now accepts a selected WhatsApp event, an editable/redactable copy
  of its text, and an explicit starting state (`empty` or `current`). Replay requires current Space
  owner/admin and Project access, and the selected event must still belong to the exact Project and
  installation. The input copy is not persisted.
- The Agent DO creates fresh synthetic event and conversation IDs, revalidates the exact current
  channel binding and signed active installation, and runs only the channel isolate. It pins the
  active package version, handler hash and active settings revision/hash for that invocation. The
  original handler hash and source outcome are shown alongside the simulated result.
- Optional current session state is copied through a new SELECT-only reader that does not expire or
  delete source rows. The isolate receives this copied snapshot under a new conversation ID; staged
  session changes are displayed but never saved. Replies and answer requests are staged. Knowledge,
  tools, attachments and outbound delivery use explicit no-op simulation adapters; no provider,
  Knowledge query, model answer, tool effect or live conversation/session mutation is called.
- A bounded per-installation audit stores only actor, source event, outcome, package/handler/settings
  hashes and state-source/hash metadata. It stores no message, reply, settings or state values and
  keeps at most 500 rows per installation. Existing stored-conversation deletion also removes audit
  entries linked to that conversation.
- Agents and Spaces typechecks passed with pnpm `9.12.0`; `git diff --check` passed. Full Shell
  typecheck still reports only the known stale `.next/types` imports for four missing routes, with no
  diagnostics in changed Shell sources. No tests, migration apply, provider action or deployment ran.
- This completes the replay source/UI slice. Next: add a customer-service WhatsApp SDK example that
  demonstrates only the channel-only context, owner-approved scoped Knowledge, bounded session
  state, host inbox escalation, and synthetic test/replay surfaces.

### Synthetic staff-review handoff — 2026-11-23

- The live customer handler already routes an invocation with no reply or answer request to human
  review. The isolated customer simulation and replay had instead returned an invalid-output error
  for this intentional handoff shape.
- Both synthetic routes now accept zero handler outputs as a proposed `staff_review` outcome and
  display that live dispatch would pause automation for staff handling. The simulation creates no
  conversation, inbox item or notification. Multiple outputs remain invalid; one reply or answer
  request continues to be staged without delivery or execution.
- Agents typecheck and `git diff --check` passed with pnpm `9.12.0`. Full Shell typecheck still
  reports only four stale `.next/types` imports for missing generated routes and no diagnostics in
  changed Shell sources. No tests, migration apply, provider operation or deployment ran.
- Next: add the versioned customer-service WhatsApp SDK example and document the handoff plus the
  active test/replay boundaries accurately.

### Customer-service WhatsApp SDK example — 2026-11-23

- Added `packages/agent-sdk/examples/customer-service-whatsapp/` as release and bundle version
  `1.0.0`. Its channel-only manifest declares one WhatsApp connection, the exact
  owner-published-external `support_articles` collection, and per-conversation session state capped
  at 1 KiB with a 30-day TTL. It requests no tools, settings, attachment reads or credentials.
- The handler asks the host for grounded responses only to general questions, stores only a bounded
  counter, and produces no channel output for personal order/account requests, complaints, refunds,
  safety cases or direct human requests. Current live dispatch routes zero-output cases to review.
- The README documents owner approval of the exact Knowledge collection, the host inbox handoff,
  synthetic one-turn test and replay boundaries, customer-only mode, and the lack of live provider
  acceptance. SDK typecheck, standalone strict handler typecheck, manifest JSON parsing and
  `git diff --check` passed using pnpm `9.12.0`. No tests, provider action or deployment ran.
- Next: implement the plan's optional member phone-test mode. Existing verified member contacts,
  project route checks and customer-only mode provide prerequisites, but the WhatsApp webhook has no
  challenge-bound active test-session override yet.

### Phone-test challenge control plane — 2026-11-23

- Migration `0289_whatsapp_member_customer_test.sql` adds hashed, five-minute entry challenges and
  bounded active test-session records. The records bind tenant, Space, member, verified contact,
  HMAC sender and destination keys, exact Project, and exact extension installation. They store no
  provider number or plaintext challenge.
- Authenticated begin/status/end operations now require current Space and Project membership. Begin
  also rechecks the enabled exact Project grant, active verified contact for the configured
  destination, `staff_and_customers` mode, exact current channel binding and active installed
  WhatsApp handler. A partial unique index and a route-level check prevent simultaneous test
  sessions for the same verified sender/destination.
- Codes expire in five minutes; a redeemed test will have a 30-minute lifetime. This checkpoint
  only creates and revokes the challenge/session records; no webhook consumes them yet.
- Agents typecheck and `git diff --check` passed with pnpm `9.12.0`. No tests, migration apply,
  provider action or deployment ran.
- Next: intercept challenge redemption and active test turns before pairing, verification, member
  route selection or executive commands; forward valid turns only to the pinned Project handler
  with executive routing disabled, then revalidate that same test identity at Agent DO dispatch.

### Phone-test issuance UI and exact release pin — 2026-11-23

- The Project Channels panel now lets an eligible member request a code for the currently bound
  WhatsApp customer handler, displays the five-minute code expiry, polls active status, and ends an
  active test. UI eligibility requires a verified contact and an enabled grant for that Project.
- Challenges and eventual test sessions now also pin the active extension's package version and
  handler hash. Replacing or updating the handler will invalidate the challenge/session rather than
  silently switching the customer's test behavior.
- Agents typecheck and `git diff --check` passed with pnpm `9.12.0`. Full Shell typecheck reports
  only the known four missing generated `.next/types` route imports and no errors in changed Shell
  sources. No tests, migration apply, provider operation or deployment ran.
- Next: implement signed platform-webhook redemption, explicit `TEST EXIT`, customer-only forwarding
  ahead of internal command/member routing, and Agent DO session revalidation.
