# Bounded keypad phone menu

This signed extension example provides a deterministic two-choice inbound phone menu. It is an
IVR-style keypad menu, not a conversational voice agent. It supports a greeting, one DTMF digit,
two configured responses, and a fallback response. It does not use speech recognition, an LLM,
knowledge retrieval, call transfer, outbound dialing, or provider credentials.

The extension's signed Canvas dashboard saves its six bounded text settings through the existing
per-installation settings API. Its channel handler receives the host's validated settings snapshot
and returns the versioned data-only `say`, `gather` and `hangup` response contract. The host checks
the signed installation and handler digest, validates the response, enforces number policy and
renders carrier-specific actions. A Space owner separately assigns and confirms the handler in
Assistant Phone settings. The phone number and provider connection remain under their existing
owner and provider controls.

Build the release artifact set from this manifest, `handler.ts` and `dashboard.html`, sign it with
the normal extension release process, and install the exact release in a Space before selecting it
as a handler. The source example is not a published Marketplace listing and makes no provider or
live-call availability claim. Provider billing, deployment and live acceptance remain separate.
