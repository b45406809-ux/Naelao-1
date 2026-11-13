# Bounded keypad phone menu

This signed extension example provides a deterministic two-choice inbound phone menu. It is an
IVR-style keypad menu, not a conversational voice agent. It supports a greeting, one DTMF digit,
two configured responses, and a fallback response. It does not use speech recognition, an LLM,
knowledge retrieval, call transfer, outbound dialing, or provider credentials.

The extension's signed Canvas dashboard saves its six bounded text settings through the existing
per-installation settings API. Its channel handler receives the host's validated settings snapshot
and returns the versioned data-only `say`, `gather` and `hangup` response contract. The host checks
the signed installation and handler digest, validates the response, enforces number policy and
renders carrier-specific actions. The dashboard previews call-start and keypad responses from the
current draft in the browser; this is explicitly simulated and does not invoke a carrier, publish
the draft, or save a call session. A Space owner separately assigns and confirms the handler in
Assistant Phone settings. Its read-only Phone connection view requires the declared
`assistant.phone.read` capability, resolves only this exact active signed installation, masks number
and caller IDs, and shows at most 50 matching Telnyx calls from the last 7 days. Provider cost reports
are labeled as API observations, not invoices or customer charges. The separate
`assistant.phone.simulate` capability enables an owner-only server-backed test of the exact installed
handler on its single active assigned line. It uses synthetic `call.received` or `call.digits` input
and saved settings; it creates no carrier call or call session. The browser preview remains available
for unsaved draft settings. The dashboard cannot buy, release, configure or call a number. Phone number
and provider connection changes remain under their existing owner and provider controls.

Build the release artifact set from this manifest, `handler.ts` and `dashboard.html`, sign it with
the normal extension release process, and install the exact release in a Space before selecting it
as a handler. The source example is not a published Marketplace listing and makes no provider or
live-call availability claim. Provider billing, deployment and live acceptance remain separate.
