# Assistant coordination implementation

Scope: the same Naelao planner/worker runtime for Space and Project assistants.
Public customer extensions never inherit internal assistant identities or channels.

- [x] Cooperative worker steering with scoped commands and acknowledgement at execution boundaries.
- [x] Interactive voice follow-up turns while durable work continues; audio interruption is not rollback.
- [x] Enforced separation of heartbeat and human conversation sessions.
- [x] Verified, explicit cross-channel conversation binding.
- [x] Host-controlled notification preferences, quiet hours, bounded delivery and no uncertain-send retries.
- [x] Recipient-bound expiring approval decisions over verified WhatsApp/Telegram, resuming the original task.
- [x] Voice/task continuation follows the actual resumed approval run.
- [x] Operation receipts remain stable across calls; unknown outcomes are held, not compensated blindly.
- [x] Tests, production bundle checks, commit and synchronize work/backup branches.

Live carrier/provider acceptance depends on deployment credentials, not offline fixtures.

## Deployment and remaining acceptance

Apply D1 migration `0135_assistant_coordination.sql` before deploying this checkpoint.
It adds private delivery/conversation records and separates internal/external phone bindings.
Existing active extension-handler lines are classified as external without changing their
carrier number, account, SID or callbacks. Provision a different number for internal calling.

The voice transport uses the existing Flux transcription/Aura PCM speech path and the same
configured planner/workers. It does not introduce unverified OpenRouter realtime APIs, caller-ID
or biometric authentication, a fixed reasoning model, guaranteed latency, or flat carrier pricing.
Internal callers authorize through an authenticated app and a short-lived call code. Project
members use their own conversation and permissions; a shared Project identity does not elevate them.

- [ ] Apply migration and deploy with real tenant/provider credentials.
- [ ] Live Space and Project calls: reconnect, interruption, worker steering, approval hold/resume,
      revoked membership and an interrupted side effect requiring reconciliation.
- [ ] Live recipient-bound WhatsApp/Telegram approval buttons and private cross-channel continuation.
- [ ] Measure actual end-to-end latency, call quality, provider charges and duplicate-action rate.

Current messaging executive contacts remain restricted to verified Space owners/admins; this
checkpoint does not grant ordinary members privileged WhatsApp approval authority. App-authorized
Project-member calls retain their existing permissions. Proactive outbound calls deliver approved
updates; unrestricted conversational third-party calling is not enabled. The legacy customer
voice class remains for staged number migration, while new external lines invoke scoped handlers.
Managed carrier billing and broader demonstration/video-learning rollout remain separately tracked
in `assistant-implementation-progress.md`; this coordination checkpoint does not certify them.
