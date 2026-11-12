# Notification delivery receipt and webhook retry contract

Notifications are sent at least once when their caller or queue retries. Provider acceptance is
not evidence of inbox delivery, device display, or a human reading the message.

## Email

Callers should provide a stable `notification_id`. The Notifications worker forwards it to Resend
as `Idempotency-Key` and returns the provider's bounded `id` as `provider_receipt_id` when the
provider includes one. Synchronous email responses retain the existing `delivered` field for
compatibility and add `accepted: true` plus `outcome: "provider_accepted"`; consumers must interpret
that as request acceptance only.

Product account reset and verification sends persist the provider receipt on the existing
`product_auth_email_outbox` operation. Its protected status API reports the receipt with the
operation's existing `accepted`, `pending`, `failed`, or `cancelled` state. The receipt does not
prove that the destination mailbox accepted or displayed the message.

## Webhooks

Supply a stable `notificationId` on the queued message. Recipients receive it as
`X-Naelao-Event-Id` and `Idempotency-Key`. If a caller omits it, the worker uses the queue message
ID. Delivery is at least once: recipients should deduplicate side effects by event ID and retain
the dedupe record for the sender's retry and replay window.

New requests include `X-Naelao-Sent-At` (UTC ISO timestamp),
`X-Naelao-Signature-Version: 2`, and `X-Naelao-Signature-V2: v1=<hex>`. The signature is HMAC-SHA256
over the UTF-8 bytes of `timestamp + "." + eventId + "." + rawBody`, using the configured webhook
secret. Receivers should verify the signature, enforce a short timestamp window, and use the event
ID for deduplication. `X-Naelao-Signature` remains the legacy body-only HMAC for receiver
compatibility; it should be retired only after consumers migrate.

This contract does not add a general operator replay endpoint or a durable receipt for every
notification channel. Queue exhaustion and manual replay remain open platform work; no delivery
claim should be made from a queue acknowledgement alone.
