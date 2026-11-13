# Notification delivery receipt and webhook retry contract

Notifications are sent at least once when their caller or queue retries. Provider acceptance is
not evidence of inbox delivery, device display, or a human reading the message.

## Email

Callers should provide a stable `notification_id`. The Notifications worker forwards it to Resend
as `Idempotency-Key` and returns the provider's bounded `id` as `provider_receipt_id` when the
provider includes one. Synchronous email responses retain the existing `delivered` field for
compatibility and add `accepted: true` plus `outcome: "provider_accepted"`; consumers must interpret
that as request acceptance only.

## Synchronous notifications

`POST /internal/notify` claims `(tenant_id, notification_id, channel, provider)` in
`notification_delivery_attempts` before provider egress. The row contains bounded status, HTTP code,
provider receipt ID and safe failure code only; it does not retain recipient, endpoint, message,
device token or provider credential. A repeated ID returns its stored result and does not send again.
Callers should use an ID tied to their durable operation. When no ID is supplied, the worker returns
a random ID for this attempt; the caller cannot use that fallback to deduplicate a later request.

The route records `not_sent`, `provider_rejected`, `provider_accepted` and `attempt_ambiguous` for
email, web push and the implemented Slack, Discord, WhatsApp and Telegram senders. Safe provider
message IDs are retained when returned. APNs, FCM, webhook, in-app and other channels have no
synchronous sender here and are recorded as `not_sent`; this does not add provider support. A lost
response, transport exception or HTTP 5xx is `attempt_ambiguous`. An accepted provider response is
not proof of recipient delivery, display or reading.

Accepted, rejected and ambiguous IDs are never automatically dispatched again. In particular,
ambiguous outcomes require reconciliation before an operator creates a new intentional send. The
tenant-scoped owner/admin `GET /billing/notification-deliveries` view exposes these outcomes without
content or recipient data. It is not an audited replay interface. General outcome retention and an
actor-scoped, audited replay workflow remain open work; queue dead-letter handling is a separate
contract below.

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

Queue exhaustion and manual replay remain open platform work; no delivery claim should be made from a
queue acknowledgement alone. No provider acceptance or live-delivery claim is made from local mocks.
