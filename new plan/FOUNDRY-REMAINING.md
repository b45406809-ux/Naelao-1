# Remaining Foundry implementation decision

Updated: 2026-10-13
Branch: `Mcbt5s-Backup-2`

## Channel-native cross-Space worker invocation

This is the only locally identified Foundry gap left after the 2026-10-13 implementation pass. The direct Foundry UI/API invocation remains available and is source-role clamped to `viewer`; exact-document sharing is implemented with per-user acceptance and revocation.

The current inbound channel worker represents senders as `channel:<provider>:<sender>`. It does not establish that the sender is a member of the target Space. Foundry accepts exact-document grants and worker invocations for authenticated Space users. There is no existing member-to-channel identity link, accepted worker-grant lookup for an inbound message, or channel reply delivery contract for cross-Space runs. Treating an arbitrary phone/handle as a member, forwarding the target Space's owner/admin role, or passing a bearer grant through chat would bypass those boundaries.

Before implementing this bridge, choose the identity contract:

- Is it limited to an owner/admin who has explicitly linked and verified their own WhatsApp/Telegram contact to a Space account, or does it need to support external customer identities too?
- Should a worker grant be accepted in the Foundry UI and then usable from that linked channel, or should each channel invocation require a separate confirmation?
- Should a channel call wait for the worker result and reply in the same thread, or acknowledge a queued run and deliver the result later?

Once those choices are fixed, implement the accepted-grant lookup, same-actor authorization, minimal source role, bounded invocation input, audit, cancellation/expiry behavior, and reply delivery together. Do not infer consent from channel membership or expose the source worker's credentials/data beyond its explicit capabilities.

Current state: no code changes are needed to the implemented UI/API or document-sharing path while this decision is pending. Relevant source behavior and evidence are recorded in `FOUNDRY-IMPLEMENTATION-PROGRESS.md` and `CLOUD-PROGRESS.md`.
