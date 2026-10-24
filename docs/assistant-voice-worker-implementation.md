# Assistant voice and worker classes implementation

Approved: OpenRouter-only new AI egress; one planner/worker runtime; separate heartbeat and voice
sessions; optional metered custom voices enabled by an owner or template onboarding; extensions
use scoped host SDK services. Voice cloning requires consent. No native provider bypass.

## Delivery checklist

- [x] Shared voice preference/resource types and scope-bound SDK preference client.
- [x] Revisioned SpaceDO preference storage and authenticated Space/Project management routes.
- [x] Project inheritance cannot raise Space budgets or enable Space-disabled capabilities.
- [x] Preserve OpenRouter `speech` modality in catalog normalization.
- [ ] Host voice profile lifecycle, private consent/sample storage and erasure.
- [x] OpenRouter transcription/speech adapter with required host admission/usage callbacks, and
      restricted binary-safe vault streaming with a signed host-only audio purpose.
- [ ] Bind adapters to production host budget reservations, catalog selection and durable reconciliation.
- [ ] Connect interactive cascade to both assistant transports and durable planner turns.
- [ ] Voice model/endpoint discovery with codecs, billing units and custom voice compatibility.
- [ ] Voice settings UI, Project overrides and template activation/onboarding.
- [ ] Scoped host extension bridge and Voice Studio dogfood extension.
- [ ] Runtime dispatch for worker kinds and host-approved model classes; preserve legacy routing.
- [ ] Controlled real-call/provider acceptance and measured cost per completed task.

## Findings that affect the next step

The generic vault proxy continues to buffer ordinary responses. A new audio response mode is
restricted to the exact OpenRouter speech POST endpoint, preserves signed scope and egress
authorization, scans reflected credentials across chunk boundaries, and finalizes action receipts
on completion. Interrupted streams become indeterminate and cannot be automatically replayed.
The audio adapter requires host admission before egress and retains unresolved usage reservations
for reconciliation. Production budget/discovery binding and call transport integration remain open.

The SDK catalog previously recognized `audio` but dropped `speech` during normalization.
Recognizing the modality is discovery only, not proof of streaming, cloning or key entitlement.

Preference storage currently rejects non-null voice profile references until the host resource
lifecycle is implemented. Saving preferences does not activate a new audio adapter. Existing
voice transport remains unchanged until the OpenRouter path has metering and acceptance evidence.

## Verification

Combined full Spaces/Credentials source suites: 82 files / 315 tests passed. Focused SDK,
preferences, gateway authorization, catalog, audio adapter, vault and owner-voice regressions:
10 files / 48 tests passed. Signed audio-purpose/forgery, air-gap and proxy tests: 12 passed.
Router source suite: 12 files / 73 tests passed. SDK, Spaces, Credentials, Agents and Router
TypeScript checks passed; `git diff --check` passed. No provider request, production voice
activation or live telephone acceptance has been performed.
