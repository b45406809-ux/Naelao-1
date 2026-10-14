# Foundry channel invocation

Updated: 2026-10-14
Branch: `Mcbt5s-Backup-2`

Status: implemented locally. The bridge is limited to a WhatsApp or Telegram contact that is currently linked to an owner/admin member of the destination Space. A member accepts the exact source worker grant in Foundry UI; the source grant must still be active each time a channel command is used. External customer contacts are not supported by this path.

The command is `FOUNDRY RUN <source-space-id> <worker-id>` on the first line, followed by a prompt of at most 10,000 characters. Capability tokens are never sent in chat. Provider event IDs are claimed durably for 30 days so webhook replay cannot start a duplicate run. The ingress immediately acknowledges the request; the background run sends a bounded result (or a failure notice) to the same channel contact after completion. The source run receives the linked user's attribution and `viewer` role only. The source grant, verified contact mapping, worker ID, and user acceptance are all checked at invocation; successful authorization is audited in the source Space. Removing the channel link, membership, acceptance, or source grant blocks subsequent calls.

Implementation is in migration 69 and the Spaces/Agents/Shell paths recorded in `FOUNDRY-IMPLEMENTATION-PROGRESS.md`. Local tests cover migration replay, exact-user acceptance/revocation, contact/grant denial, minimal source role, and bounded parser input. The background same-channel notification is wired but is not directly exercised end to end. Tests use local worker/DO stubs; no live provider delivery or Cloudflare deployment was tested. Long-running background completion depends on the deployed Workers runtime honoring the Durable Object `waitUntil` lifetime and is not live-verified.
