# Telephony provider migration

## Current state

Twilio remains the active assistant phone provider. Meta Direct WhatsApp is separate.
`voice/telnyx-telephony.ts` implements an inactive Telnyx transport boundary: authenticated
webhook parsing, answer/hangup with stable command IDs, SMS submission and message inspection.
It does not provision numbers, mount ingress routes, dispatch assistant tasks, or switch carriers.

## Verified contracts

Official Telnyx SDK source was read on 2026-10-26:

- https://github.com/team-telnyx/telnyx-node/blob/master/src/lib/webhooks.ts
- https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/calls/actions.ts
- https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/messages/messages.ts

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

- Persist provider discriminator and provider-specific account/number identities without
  reinterpreting existing Twilio SIDs. Preserve existing callbacks during migration.
- Owner-scoped Vault binding, verified number import, quoted purchase, detach and release.
- Signed Telnyx ingress with durable event claims, binding/destination checks and assistant
  membership verification before entering the existing planner/worker runtime.
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
