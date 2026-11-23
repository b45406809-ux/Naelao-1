# Customer-service WhatsApp extension 1.0.0

This versioned example handles general support questions from one explicitly owner-published
Project Knowledge collection. It asks the host to generate a grounded answer for routine questions
and leaves sensitive, urgent, account-specific, complaint, refund and human-request cases for the
Project inbox team.

## Package boundary

- `manifest.json` declares one WhatsApp channel handler at bundle version `1.0.0`.
- The channel primitive has no permissions or capabilities. The package declares only
  `channel.invoke`; the handler receives the restricted `channel_only` context.
- `support_articles` is the sole Knowledge collection requested, with
  `owner_published_external` access. The Project owner must publish the chosen support material and
  approve that exact collection for the installed extension. The handler cannot search other
  Project data or read Knowledge text directly.
- Session state is limited to 1 KiB with a 30-day TTL. This example stores one small counter per
  conversation and never stores the customer's text or identity.
- No settings, attachments, tools, provider secrets, workspace access, custom dashboard or direct
  provider API calls are included.

## Install and configure

1. Review and install `manifest.json` as a Project extension. Keep the installed package version
   pinned until an owner reviews a later release.
2. Publish selected FAQs and support articles into the Project collection named
   `support_articles`. Grant the external Knowledge scope only to the installation that needs it.
3. Connect WhatsApp through the host-managed Channels flow. Credentials and webhook verification
   stay in the host; this example contains no tokens. Use **Customer service only** mode when the
   connected number is dedicated to customers; this package does not grant member assistant access.
4. Review customer conversations in the Project WhatsApp inbox. The handler makes a staff-review
   handoff by producing no channel reply or answer request. Live dispatch pauses automatic handling,
   flags the conversation for human review and notifies the owner. Authorized staff can review the
   conversation and send a team reply through the host inbox.

The intent checks in `handler.ts` are a conservative example, not a complete classifier. Adjust
them for the business and verify the behavior with synthetic messages. A support question that asks
for order, payment, appointment or account-specific information should remain with staff unless the
business has separately approved a safe, authoritative integration for it.

For routine questions, `ctx.channel.answer()` asks the host for a bounded response grounded in the
declared collection. The host, not the extension, retrieves approved passages and handles delivery.
If the collection is unavailable or no approved sources can support the answer, the host sends the
conversation for human review. The example does not promise a booking, refund, delivery time or
other business outcome.

## Synthetic test and replay

The Channels panel's **Run customer simulation** invokes the active handler once with a synthetic
message and empty session state. A requested answer is shown as not run; replies are not sent;
Knowledge is not queried; and session changes are not saved. If the handler produces no channel
output, the result says live handling would route the conversation to staff review. The simulation
does not create a conversation, inbox item or notification.

The Project inbox's **Replay in isolation** runs a selected WhatsApp event in a fresh synthetic
conversation against the active installation and settings snapshot. The replay input can be edited
or redacted and is not saved. For this package there are no settings. Replay may use an optional
read-only snapshot of current session state, but it never writes session changes. Knowledge, answer
generation, attachments, tools and provider delivery are not run. A no-output result is labeled as
a proposed staff-review outcome; replay does not create a real handoff or inbox item.

Neither surface is a live end-to-end provider test. Provider availability, delivery, message quality,
owner notification and deployed behavior have not been verified by this example. Use an authorized
test account and the host's separately configured provider flow for any live acceptance.
