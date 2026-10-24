# Telephony production rollout

## Current decision

Keep Twilio Media Streams as the production candidate. Browser voice remains available without
renting a number. Numbers are optional and require explicit human provisioning/usage authorization.
Internal Space/Project assistant lines and public extension bot lines remain separate.
Managed resale remains disabled until renewal, usage settlement, cancellation, suspension and
provider account/regulatory requirements are implemented and accepted. Do not substitute an
existing WhatsApp account for a paid telephone account.

## Pricing research — 2026-10-24

Official source retrieved: https://www.twilio.com/en-us/voice/pricing/us
The US page lists local inbound $0.0085/min, local outbound $0.0140/min, local numbers $1.15/month
and Media Streams $0.0044/min. These are advertised component rates, not a quote or all-in cost.
At 200 inbound minutes the advertised number + voice + streaming subtotal is $3.73, before speech,
inference, compute, tax, surcharges and any extra call legs. Confirm account-specific charges.

Telnyx source to verify: https://telnyx.com/pricing/call-control
Telnyx hosts are not allowed by this environment's network policy. No current Telnyx price or
eligibility claim is verified. No carrier/deployment credentials are configured. Consequently no
live call, deployment or account-specific quote has been performed.

Use `node scripts/telephony/compare-costs.mjs quote.json` for like-for-like estimates. Input:
`minutes`, `platformMonthlyUsd`, and a `quotes` array. Each quote requires `provider`, `currency`
(USD), `market`, `direction`, `source` (HTTPS), `observedAt` (within 30 days), and all of:
`numberMonthlyUsd`, `carrierPerMinuteUsd`, `mediaPerMinuteUsd`, `speechPerMinuteUsd`,
`inferencePerMinuteUsd`, `computePerMinuteUsd`, `otherMonthlyUsd`.
There are no default provider rates. Zero must be an explicit researched assumption. Fold taxes,
surcharges and extra legs into the applicable costs. The estimator is not a billing ledger.

Only add a Telnyx adapter if comparable verified quotes and measured traffic justify its ongoing
cost. It needs provisioning, signature/replay checks, bidirectional audio format conversion,
call control, number lifecycle, usage reconciliation and the existing scope/approval boundaries.
A Cloudflare WebRTC SFU is not an automatically provisioned SIP endpoint.

## Live acceptance — execute separately for Space and Project assistants

1. Apply migrations through 0135 in the target tenant and deploy the tested Workers/Shell.
2. Verify speech bindings, durable task bindings, configured public HTTPS/WSS origin and scoped
   Twilio credentials. Import a number owned by the test account and authorize callback changes.
3. Open an authenticated private conversation; obtain its short-lived phone code. Call the number
   manually, enter the code, and request a harmless read-only task. Record call/task/session IDs.
4. Check transcript and result in that same conversation. Make a follow-up while work is pending;
   list/steer its existing worker without starting replacement work or changing its branch.
5. Interrupt speech; verify audio stops and the task is not duplicated. Disconnect/redial with
   renewed authorization and verify continuity. Close the browser while durable work runs.
6. Trigger an action requiring approval against a nonproduction fixture. Approve through the
   authorized app or verified messaging contact. Confirm exact-action binding, expiry, one resume
   and a return to the call. Reject/replay as well; neither may execute the action again.
7. Revoke membership/channel access and confirm continued execution/speech is denied. An unknown
   caller without a code and a public extension line must never gain internal assistant access.
8. Simulate a lost action receipt; confirm reconciliation is required instead of a retry. Inspect
   carrier usage for both legs/streaming and compare with task/speech spend. Test opt-in proactive
   notification delivery, quiet hours and limits to the verified owner's test destination only.
9. Detach the BYO test number and verify original callbacks are restored. Do not release it unless
   explicitly authorized. Record actual latency, duplicate actions, charges and failure evidence.

Status: all live steps are pending. Offline tests do not count as completed live acceptance.
