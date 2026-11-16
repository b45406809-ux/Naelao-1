# AgentPhone and AgentPort adapter evaluation progress

## Current reconciliation — 2026-11-16

Fetched the source plan from `origin/plan/microapps-ui-sdk-voice` commit `3ef84165546a781ebcde6867d62e563f022385b9`; copied it into this branch without switching or merging. SHA-256: `9d457136974d65ac5252123bfc2b67c6aa779c0604a5d845337026e7b63ae83d`. Its requirements are incorporated as AP01–AP06 in platform plan section 18.

| ID | Status | Current source reconciliation / remaining work |
| --- | --- | --- |
| AP01 capability evidence | CODE_GAP | AgentPort proxy/subscriptions and provider-specific Telnyx/AgentMail paths exist. No AgentPhone adapter or provider-neutral evidence-versioned capability catalog was found. Build the catalog fail-closed; do not infer capability from existing routes. |
| AP02 account lifecycle | CODE_GAP + PROVIDER_GATE | Existing Telnyx/AgentMail lifecycle and managed account/operation/billing ledgers are reusable, but no AgentPhone connection, verified auth contract, signatures, API or commercial agreement exists in source. Implement only a generic contract-backed adapter boundary; keep AgentPhone unavailable until docs/terms are independently verified. |
| AP03 events and routing | PARTIAL + PROVIDER_GATE | Existing AgentPort event subscriptions have durable dedupe/dispatch and owner-authorized AgentMail routing; Telnyx webhook validation exists. No AgentPhone event schema/signature contract is verified. Provider-neutral normalization and identity/consent cases need code only after contract shape is supplied; never treat caller ID as identity. |
| AP04 voice/privacy | PARTIAL + PROVIDER_GATE | Telnyx voice/media bridges and managed call billing exist, with separate rollout gates. AgentPhone hosted/webhook modes, media/interruptions/signing, recording and retention behavior are unverified. No voice mode may be claimed or routed to an assistant based on plan-site statements. |
| AP05 payer, budget and receipts | PARTIAL | Managed Telnyx paths reserve/settle usage and rental charges against configured Naelao schedules; AgentPort/AgentMail operations have separate account/usage records. No AgentPhone-specific verified rate card, payer/subaccount semantics, quote or invoice ingestion is present. Integrate only verified receipts/rates; unknown costs stay unknown. |
| AP06 SDK/UI/acceptance | CODE_GAP + LIVE_GATE | Existing standalone AgentPort proxy is independent of Naelao assistant wake and existing Shell provider surfaces can be extended. No AgentPhone setup SDK/UI or equivalent benchmark exists. Zimbabwe, iMessage, WhatsApp, RCS and SIP availability/pricing are unverified. No provider registration, number provisioning, messages, calls or spend were performed. |

All advertised AgentPhone features, regions, APIs, event/signature behavior, subaccounts, commercial rights, terms and price figures in the source plan remain provider claims, not supported Naelao capabilities or quote inputs. The plan's illustrative $46/$73 totals must not be used for pricing. Do not sign up, disclose credentials/OTP, provision a number, send, call or incur a charge without explicit authorization. Do not replace Telnyx, AgentMail, Cloudflare email or independent AgentPort behavior. Keep rollout disabled.

## Code checkpoint and next action

The current pre-change implementation branch is `autonomous-managed-services-20261111`, synced to `origin/Mcbt5s-Backup-2`. Existing AgentPort event proxy/dispatch, Telnyx webhook/media and managed billing paths are local implementations; no live/deployed provider acceptance has been asserted. The only unrelated untracked item observed is `infra/scripts/__pycache__/`, which remains untouched and unstaged.

Exact next code action from the resumable-workflow ledger: surface the last verified AgentTask durable checkpoint and explicit unsaved-memory limitation through the already authorized task-status API and Shell, with private-project/session authorization and stale-state coverage. Then continue PW runtime isolation and other uncoded S/U/P/PW/K/EP/TBR requirements. AgentPhone's first independent implementation after this is a disabled-by-default provider-neutral capability/evidence catalog, not a speculative vendor adapter. No live/provider actions are authorized or required for that local code.
