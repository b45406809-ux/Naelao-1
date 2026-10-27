# Telephony provider migration

## Current state

Twilio remains the active assistant phone provider. Meta Direct WhatsApp is separate.
`voice/telnyx-telephony.ts` implements a Telnyx transport boundary: authenticated
webhook parsing, answer/hangup with stable command IDs, SMS submission and message inspection.
It does not provision numbers, mount ingress routes, dispatch assistant tasks, or switch carriers.
The phone settings panel now supports owner-controlled Telnyx account preparation for Space
and Project assistants. Setup verifies an exact number ID via the official phone-number
resource before storing API/public keys in a separate identity-specific Vault credential.
Status returns sanitized metadata and explicitly reports `transport_active: false`.
Owners can remove that credential even after disabling the phone channel. This does not
release the carrier number or change the active Twilio binding.

## Verified contracts

Official Telnyx SDK source was read on 2026-10-26:

- https://github.com/team-telnyx/telnyx-node/blob/master/src/lib/webhooks.ts
- https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/calls/actions.ts
- https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/messages/messages.ts
- https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/phone-numbers/phone-numbers.ts

The signature is Ed25519 over `timestamp|rawBody`, using a base64 raw 32-byte public
key, a 64-byte signature and 300-second timestamp tolerance. Authentication precedes
JSON parsing. Persistent event-ID deduplication is still required at ingress.
Call actions POST to `/v2/calls/{callControlId}/actions/{action}` with `command_id`.
SMS POSTs to `/v2/messages`; inspection GETs `/v2/messages/{id}`.
Provider mutations never retry automatically. Timeout, malformed successful receipt and
server errors preserve uncertain outcomes. No error text includes credentials or provider bodies.

The documentation website was inaccessible under this environment's network policy.
The official SDK source establishes the wire contract; it does not establish live account
entitlement, country availability, prices, or deployed webhook delivery.

## Remaining integration

- Migration 0136 persists a carrier discriminator on bindings and quotes, defaulting existing
  records to Twilio and preserving their IDs/callbacks. Number resource uniqueness is now
  carrier-specific; active E.164 addresses remain globally unique. APIs expose provider and
  opaque number ID. Twilio credential resolution, lifecycle, callbacks, quote purchases and
  live-call admission reject other carriers. Deployment checks require the new columns.
  Existing legacy SID-named storage columns remain for compatibility; Telnyx active binding
  callback configuration remains a manual provider action.
- Verified account preparation and scoped Vault storage/removal are implemented. Quoted
  purchase, automatic callback migration and provider number release remain open.
  A human owner can now stage a verified Telnyx number in an assistant binding after a fresh
  provider lookup. The binding remains `configuring`, reserves the assistant slot and address,
  and does not modify Telnyx callbacks. Owners configure the messaging profile webhook at
  Telnyx; Naelao verifies the exact URL, enabled status and API version before activating
  SMS. Calls and MMS remain disabled. Owners can detach locally after pending actions and
  ingress are reconciled; the provider webhook and rental continue.
- Signed Telnyx SMS ingress is wired for active extension bindings: signature, exact bound
  destination, owner scope, phone preferences, egress policy, handler and daily quota are
  checked before dispatch. Migration 0137 and `telnyx-ingress-journal.ts` provide atomic
  binding/event claims, payload conflict detection and explicit indeterminate outcomes.
  Extension replies are stored as approval-required drafts. Owner-authorized phone actions
  can approve and send a draft through an active Telnyx binding; a lost response remains
  indeterminate and is not retried. The phone UI can reconcile an uncertain SMS against
  an account-scoped Telnyx receipt matching its ID, direction, sender, recipient and body;
  an absent receipt does not establish non-submission. Actual provider cost ingestion,
  carrier billing reconciliation and calls remain open. Signed assistant
  SMS ingress now records paired-sender requests as pending commands requiring authenticated
  review; unknown senders gain no command authority and verification codes stay private.
- Normalize usage receipts using actual currency and provider identifiers; keep uncertain
  usage pending reconciliation. A transport submission is not proof of final billable usage.
- Connect Telnyx media to authorized durable call sessions and enforce existing duration,
  spend, concurrency, approval and cancellation limits.
- Implement Cloudflare Realtime SFU signaling with authenticated session ownership, SDP/track
  limits, backend credential isolation and a server-side audio bridge. Creating an SFU session
  alone does not connect it to the Naelao audio engine.
- Exercise provider and media acceptance before changing the default carrier.

Carrier fallback requires a separately provisioned eligible line. Never replay a possibly
accepted call, message or purchase on another carrier. An inbound Telnyx number cannot
silently become a Twilio number. Carrier switching and number porting are distinct operations.

## Local evidence

Five focused tests passed: genuine signatures, altered payloads, stale/future timestamps,
signed malformed events, uncertain mutations, missing receipts and path injection.
Agents Worker TypeScript check passed. No live provider or SFU acceptance was run.

2026-10-27 continuation: account preparation tests cover verify-before-store, mismatched
number rejection, secret-free status, worker/nonowner denial and scope-specific credential
removal. The complete assistant-phone regression group is included in local verification.
