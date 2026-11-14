# Bounded phone menu

This signed extension example provides a deterministic two-choice inbound phone menu. DTMF works
with supported phone lines. On Twilio, an owner can enable completed speech input in the existing
phone policy; the handler then matches one option-label phrase to a configured response. Ambiguous
and unmatched phrases use the fallback. On Twilio, owners may also choose the documented `man` or
`woman` `<Say>` style; Telnyx remains DTMF-only and uses its provider default. The Twilio style
selection does not establish voice availability, language support, quality or rate. This is not a
streaming or AI voice agent. It does not call an LLM, retrieve knowledge, transfer calls, dial
outbound, or hold provider credentials.

The extension's signed Canvas dashboard saves its six bounded text settings and one voice-style
selection as an owner-reviewed draft through the existing per-installation settings API. An owner
or admin explicitly publishes a revision; the handler keeps reading the published row until then.
The dashboard retains the latest 20 published configurations for review. Preparing a rollback
copies a schema-compatible revision into a new draft and still requires explicit publication;
uninstall removes draft and version data. Twilio and Telnyx calls pin the handler and published
settings revision admitted at call start, so later edits apply to new calls. A later turn fails
closed if its pinned handler or settings revision is no longer available. Its channel handler
receives the host's validated settings snapshot
and returns the versioned data-only `say`, `gather` and `hangup` response contract. The host checks
the signed installation and handler digest, validates the response, enforces number policy and
renders carrier-specific actions. The dashboard previews call-start, keypad, and completed-transcript
responses from the current draft in the browser. An owner-triggered scenario suite also sends
synthetic call-start, valid/invalid DTMF and, only on an owner-enabled Twilio line, unambiguous and
ambiguous speech through the exact-installed-handler test path, then compares host-validated output
with the saved-settings preview. These checks do not invoke a carrier, create a call session or
establish voice quality. Speech matching is not speech recognition or a language-quality claim. A
Space owner separately assigns and confirms the handler in
Assistant Phone settings. Its read-only Phone connection view requires the declared
`assistant.phone.read` capability, resolves only this exact active signed installation, masks number
and caller IDs, and shows at most 50 matching Telnyx calls from the last 7 days. Provider cost reports
are labeled as API observations, not invoices or customer charges. The separate
`assistant.phone.simulate` capability enables an owner-only server-backed test of the exact installed
handler on its single active assigned line. It uses synthetic `call.received`, `call.digits`, or
`call.speech` input and saved settings; speech simulation is available only on an active Twilio line
whose owner policy enables speech input. It creates no carrier call or call session. The browser preview remains available
for unsaved draft settings. The dashboard cannot buy, release, configure or call a number. Phone number
and provider connection changes remain under their existing owner and provider controls.

Twilio contract checked 2026-11-14: [TwiML `<Say>`](https://www.twilio.com/docs/voice/twiml/say)
documents `man` and `woman` values for the `voice` attribute. This example exposes only those two
styles and does not expose arbitrary TwiML, provider voice names, locale or language controls.

Build the release artifact set from this manifest, `handler.ts` and `dashboard.html`, sign it with
the normal extension release process, and install the exact release in a Space before selecting it
as a handler. The source example is not a published Marketplace listing and makes no provider or
live-call availability claim. Provider billing, deployment and live acceptance remain separate.
