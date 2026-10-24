# Assistant voice and worker classes implementation

Approved: OpenRouter-only new AI egress; one planner/worker runtime; separate heartbeat and voice
sessions; host-approved prebuilt voice profiles. Custom voices require a separate consent and
storage lifecycle before they can be enabled. Extensions use scoped host SDK services. No native
provider bypass.

## Delivery checklist

- [x] Shared voice preference/resource types and scope-bound SDK preference client.
- [x] Revisioned SpaceDO preference storage and authenticated Space/Project management routes.
- [x] Project inheritance cannot raise Space budgets or enable Space-disabled capabilities.
- [x] Preserve OpenRouter `speech` modality in catalog normalization.
- [ ] Host voice profile lifecycle, private consent/sample storage and erasure.
- [x] OpenRouter transcription/speech adapter with required host admission/usage callbacks, and
      restricted binary-safe vault streaming with a signed host-only audio purpose.
- [x] Bounded continuous-PCM utterance collector with silence cutoff, 20-second request cap,
      16kHz WAV framing and a single-queued-utterance memory bound. The Credentials Worker permits
      this exact transcription route to use a 900 KiB body cap (under its 1 MiB request ceiling).
- [x] Bounded OpenRouter PCM TTS adapter matching the current 16kHz mono call transport.
- [x] Durable subscription-token reservation, provider usage settlement and reconciliation helper.
- [x] Bind adapters to production host budget reservations, approved catalog selection and durable reconciliation.
- [x] Connect bounded STT/TTS to Space and Project assistant calls; transcripts still go through durable planner turns.
- [x] Host-approved speech registry with model-specific voices, PCM rates, supported language hints and conservative per-model billing estimates.
- [x] Voice settings UI for Space and Project scopes, including revisioned saves and configured call caps.
- [ ] Template activation/onboarding for voice preferences and capability/entitlement explanation.
- [ ] Scoped host extension bridge and Voice Studio dogfood extension.
- [ ] Runtime dispatch for worker kinds and host-approved model classes; preserve legacy routing.
- [ ] Controlled real-call/provider acceptance and measured cost per completed task.

## Findings that affect the next step

The generic vault proxy continues to buffer ordinary responses. A new audio response mode is
restricted to the exact OpenRouter speech POST endpoint, preserves signed scope and egress
authorization, scans reflected credentials across chunk boundaries, and finalizes action receipts
on completion. Interrupted streams become indeterminate and cannot be automatically replayed.
The audio adapter requires host admission before egress. The active `OwnerVoiceAgent` now uses the
bounded utterance collector and OpenRouter TTS through the Credentials Worker vault. The vault
resolves `llm_byok_active::openrouter` internally, so provider key plaintext never enters the voice
Durable Object. Every transcription and speech request reserves subscription token quota, journals
its state, records provider cost and reconciles known generation IDs on reconnect, call end and DO
alarm. Per-call USD admission counts settled spend plus pending estimated spend. Outcomes without a
generation ID remain held for reconciliation/expiry, never auto-released. The call setting is read
before transport start and rechecked for turns and speech; disabling voice prevents new speech/tasks.
Space and Project calls share the same planner/worker runtime; the voice layer only transcribes,
speaks and relays into durable planner turns.

The model/voice catalog is an explicit host-reviewed mapping and is served through the Space/Project
settings API. It is not a live OpenRouter catalog refresh. OpenRouter availability and rates can
change, so the catalog must be checked before deployment; unsupported or removed model/voice pairs
fail closed. The SDK's `speech` modality is discovery only, not proof of cloning or key entitlement.

The dashboard now shows only host-approved prebuilt model/voice profiles and the enable switch gates
the live Space/Project call transport. Custom voice cloning remains unavailable; requests to enable
it are rejected until the separate consent, storage, deletion and provider-entitlement lifecycle is
implemented. Voice-provider fallback is also deliberately not offered as an active preference.

Current OpenRouter docs confirm model discovery via `/models?output_modalities=transcription` and
`/models?output_modalities=speech`; the catalog's Whisper Large V3 Turbo, Grok Voice TTS 1.0 and
Microsoft MAI Voice 2.1 profiles are pinned to explicit model-specific voice IDs and PCM rates.
Current model cards quote transcription per-second and TTS per-character billing; recorded usage
reconciles against provider receipts. Prices and availability change. Collection rank reflects
recent usage, not benchmark quality. See [OpenRouter model catalog documentation](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties),
[transcription guide](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/), and
[speech guide](https://openrouter.ai/blog/tutorials/text-to-speech/).

## Verification

This integration's targeted suites passed: Agents voice (5 files / 22 tests), Spaces settings (1
file / 4 tests), Credentials (5 files / 19 tests), and Agent SDK voice (1 file / 10 tests). Agents,
Spaces, Credentials, Agent SDK and Shell TypeScript checks passed, as did `git diff --check`. No
live OpenRouter request or live telephone/provider acceptance test was performed; deployment
acceptance remains open.
