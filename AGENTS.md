# Autonomous managed-services and workspace implementation runbook

## Active mission and checkpoint

Both plans are active and jointly govern this mission:

- [Managed services and sidecar runtime plan](docs/research/managed-services-and-sidecar-runtime-plan.md), including S1–S9 and inherited U01–U12.
- [Platform completion and guided templates plan](docs/research/platform-completion-and-guided-templates-plan.md), including release/environment safety, commercial integrity and recovery, guided templates and microapp setup, voice, and shared-Space coordination.

Reuse the existing requirement IDs and progress ledgers when plans overlap. Do not restart completed
work or claim a requirement complete from historical notes alone. After compaction, interruption, or
a new session, read `docs/research/managed-services-and-sidecar-runtime-plan.md`,
`docs/research/platform-completion-and-guided-templates-plan.md`,
`docs/research/managed-services-and-sidecar-implementation-progress.md`,
`docs/research/platform-completion-and-guided-templates-progress.md`, and this runbook; inspect the
actual branch, worktree and uncommitted changes; then resume from the exact next unfinished action in
the records.

## Latest checkpoint — 2026-11-14 (S5/MS08d Modal contract reconciliation)

P05's Space-shared provider connection gap is source-reconciled and recorded below: the current
project-installation authority model cannot safely serve a Space-shared runtime without an explicit
authorizer, beneficiary set, payer, and revocation/drain contract. This is not a credential blocker.

Current official Modal sources still establish a product/host contract gap. The [JavaScript/Go SDK
guide](https://modal.com/docs/guide/sdk-javascript-go) marks the SDK Beta; the official [JS package
README](https://github.com/modal-labs/modal-client/blob/main/js/README.md) requires server-side Node
22+ or Deno/Bun. The official [Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox) documents
create/exec/terminate, CPU/memory/GPU, timeout/idle limits, volumes, and region selection. The current
official [client source](https://github.com/modal-labs/modal-client/blob/main/js/src/client.ts) says
its gRPC API is not public and may change without warning. [Billing documentation](https://modal.com/docs/guide/billing)
describes programmatic reports only for Team/Enterprise Workspaces, potentially delayed, and before
credits/reservations/network-egress adjustments; it is not a per-sandbox actual-cost settlement
receipt. Agents currently runs as a Cloudflare Worker with `nodejs_compat`; there is no separate Node
22/Deno/Bun host, binding, adapter caller, or durable Modal operation store. The existing
`modal-lifecycle.ts` is a provider-neutral scaffold with mocked tests, not a provider integration.
Therefore no Modal adapter is reachable or safe to wire until Naelao selects and operates a compatible
host and accepts dependence on the Beta/private API. No credentials were checked or required for this
code/host review. No tests, deployment, purchase, or live provider acceptance ran.

P05 and MS08d remain PARTIAL; branch source is still pushed through `76756aca`. Preserve the untracked
`infra/scripts/__pycache__/` and keep every rollout disabled.

Exact next action: implement a reachable guided-template cost-scenario slice using only current,
operator-verified `managed_service_model_entitlements`: server-validate the selected active model and
expected model-operation count, project its pinned Naelao-credit price/version/expiry, and keep direct
provider charges and the full operating total explicitly unknown. Connect the scenario controls to
the activation-preview Shell caller. Then continue remaining S3–S9/U01–U12/P01–P24 code gaps. Fetch,
integrate concurrent remote work safely, and push each coherent checkpoint without force.
## Previous checkpoint — 2026-11-14 (signed template coordination-default handoff)

Code `06250151d426a4a1d15e4b81314f81d2a0b7737b` is pushed to `origin/Mcbt5s-Backup-2` from
`autonomous-managed-services-20261111`. Signed `SpaceBlueprint` coordination defaults now support
member-fact visibility and up to 32 canonical singleton keys; Foundry authoring persists/restores the
suggestion; activation preview shows it beside current policy; owners/admins must opt in explicitly.
Application is revision-zero only, so configured owner policy is preserved. Local evidence: SDK
**15/15**, Spaces activation/authoring **37/37**, SDK/Spaces/Shell typechecks and `git diff --check`.
No browser, deployed Worker, live multi-user or provider acceptance ran. The singleton policy governs
only the advisory registry; it does not reserve external provider resources or grant project/service
access.

Current source also corrects stale P04/P08/voice entries in the ledgers: the jurisdiction-bound
WorkspaceCoordinatorDO archive/restore bridge exists with a focused retry/conflict test; bounded
sampled-frame analysis is implemented beside video audio transcription; and the signed phone-menu
dashboard already supports synthetic call-start/DTMF plus Twilio-only speech. These are local code
paths, not deployed/live acceptance. Keep P04 partial for other stores and policy/recovery gates, P08
partial for provider/deployed acceptance, and S6 partial for external identity/content/command caller
contracts. Keep all rollouts disabled and preserve `infra/scripts/__pycache__/`.

Exact next action: extend the bounded phone-menu dashboard's synthetic installed-handler test to select
one exact active line when the same signed installation is assigned to multiple lines. Carry the
selected binding ID through the owner-only Space route and revalidate it against current active
installation/provider state; preserve single-line behavior, Twilio-only speech, and no carrier request
or call-session write. Add focused route/dashboard checks, then continue the next uncoded S3–S9/U01–U12/
P01–P24 item. Fetch and safely integrate remote changes before each checkpoint push.

## Previous checkpoint — 2026-11-14 (§10.2 exact-key registry singleton rules)

Code `4f634205a4f92d7132c5530092d4d73f05fff142` is pushed to `origin/Mcbt5s-Backup-2`. The optional
default-off owner/admin singleton policy for Space coordination facts now has migration-backed
revision/history, atomic reservation enforcement for fact publish/amend/proposal approval, release on
revoke/project retirement and replacement after expiry. The authenticated no-store routes, SDK/API,
and Shell editor/history are connected. Local evidence: SDK **6/6**; Spaces registry/gateway/proposal/
migration suites **40/40**; SDK, Spaces and Shell typechecks; `git diff --check`. These are local
Worker/SQLite mocks and static checks only; no deployed/live multi-user acceptance ran.

Scope is deliberately registry-only. Provider resource creation/activation, template/project creation,
end-to-end side-effect fencing and broader non-disclosure tests do not yet consult this policy; a
reservation grants no service access. §10.2/§10.4/§10.5 remain PARTIAL. Other S1–S9/U01–U12 and P01–P24
requirements retain their row-level states. P06 publisher/signing/distribution contract and P01/P02
real resource receipts remain external gates. Keep rollouts disabled and preserve the untracked
`infra/scripts/__pycache__/`.

Exact next action: add the optional singleton-key suggestion to signed SpaceBlueprint/template
persistence and owner activation review. Apply it only after explicit confirmation and only when the
owner policy revision is zero; preserve configured owner rules. Add authoring/activation tests, then
continue remaining uncoded plan requirements without repeating completed audits. Fetch and safely
integrate before each push.

## Previous checkpoint — 2026-11-14 (P16 owner-approved image attachment mode)

Code `c697b8f93ea9976132c58b733f6d0387feb331ed` is pushed to `origin/Mcbt5s-Backup-2`. Channel
extensions may declare an owner-approved one-image `read_image` grant, bounded to PNG/JPEG/WebP and
480 KiB. SDK validation, explicit installation approval and Shell disclosure, Space installation
metadata, exact active install/provider/message checks, stored-byte MIME signature/size validation,
and isolated-handler dispatch are connected. Local evidence: SDK **31/31**, Agents **10/10**, Spaces
**13/13**, four package typechecks and `git diff --check`. These are local checks; no deployment or
live provider acceptance ran. P16 remains partial for audio/arbitrary binaries, ordinary
non-ephemeral retrieval and live acceptance. P06's first-party phone package listing is gated by the
missing Naelao publisher identity, signing/key-custody authority and canonical artifact distribution
contract; do not add a fake listing. P01/P02 external resource/receipt gates remain fail-closed.
Rollouts stay disabled; preserve `infra/scripts/__pycache__/`.

Exact next action: implement §10.2's optional host-only coordination singleton reservation per
approved capability key, configured by Space owners/admins and off by default. Persist and enforce it
atomically during fact approval, expose only to authorized owners/admins, and test concurrent
approval, rule changes and retirement. Then wire the Space Template policy handoff and continue
remaining guided-template, S3–S9/U01–U12/P01–P24 gaps. Fetch and safely integrate before the next push.

## Previous checkpoint — 2026-11-14 (P02 Wrangler-resolved resource preflight)

Source `6040847ea8967728f8ffb41df25231a939a61f62` is pushed to
`origin/Mcbt5s-Backup-2`. The release path now resolves all 28 Worker TOMLs in both staging and
production through Wrangler and compares mutable resource bindings to the source receipt inventory.
The check verifies the source hashes and reports only binding identities; it makes no Cloudflare
calls. Both deployment preflights run it and its regression suite, and the deployment-manifest
validator requires those steps. Local verification: Wrangler-resolved inventory **5/5** and full
56-environment comparison passed; environment map **12/12**, receipt collector **4/4**, isolation
**6/6**, release-manifest **13/13**, deployment-manifest validator and `git diff --check` passed.
These are local config/mock checks. No Cloudflare account, deployed resource, remote D1 or live
acceptance was inspected. Keep rollouts disabled and preserve the intentionally untracked
`infra/scripts/__pycache__/`.

P02 remains PARTIAL: current source still shares one D1 and eleven KV IDs between staging and
production, `naelao-calls` has no named Worker owner, 158 read-only existence receipts are absent,
and neither account/time observations nor operator-attested per-D1 baselines exist. P01/P02 remain
fail-closed. The private §10 proposal lifecycle in `8a0972c7` is locally implemented; shared-Space
uniqueness/reservation policy and deployed multi-user non-disclosure remain. P05's project-vs-Space
provider scope is a product/API contract gap; P06 lacks first-party catalog discovery, provider
provisioning, streaming, full costs and live acceptance. S2 remains local for supported lanes; S3–S9,
U01–U12 and P01–P24 remain governed by their matrices.

Exact next action: implement first-party discovery for the signed `bounded-phone-menu` example through
the existing package/catalog install path. Display its keypad-only and Twilio-only speech limits,
simulated-test status and provider-cost caveats; reuse signed-release trust and owner approval, and do
not provision a carrier or enable streaming. Then continue remaining guided-template, S3–S9/U01–U12
and P01–P24 code gaps without repeating completed source traces. Fetch and safely integrate before
the next push.

## Previous checkpoint — 2026-11-14 (§10 project-owner publication proposals)

Source `8a0972c7` is pushed to `origin/Mcbt5s-Backup-2`. Migration 133 adds a durable private proposal
ledger and revision history, source-project links and lifecycle audit. Project owners/editors can
submit a bounded explicit fact through Project Settings; pending text is returned only to its
requester and Space owner/admin reviewers. Review confirms the exact audience/draft, reuses current
schema and member-audience policy checks, and atomically creates the advisory registry entry without
granting access. Requesters can withdraw pending proposals; archiving the source project retires
pending/approved proposals and revokes linked facts. SDK and Shell APIs/callers are wired.
Verification: Agent SDK contract **5/5**; Spaces route/registry/proposal suites **29/29**; Spaces and
Shell `tsc --noEmit`; `git diff --check`. These are local SQLite/mock checks. No browser, deployed,
provider or live multi-user acceptance ran. Keep rollouts disabled and preserve the intentionally
untracked `infra/scripts/__pycache__/`.

§10 proposal lifecycle is now IMPLEMENTED_LOCAL; wider shared-Space uniqueness/reservation policy,
template acceptance and deployed multi-user non-disclosure remain open. P05 still has a genuine
provider/collection scope contract gap; P06 remains partial for catalog listing, managed provisioning,
streaming, full costs and live acceptance. Preserve all S2–S9/U01–U12 and P01–P24 gates in their
requirement matrices.

Historical next action, completed by `6040847e`: compare the receipt collector and release preflights
with Wrangler-resolved bindings. Remaining real-resource separation, ownership, account/time receipts
and operator-attested per-D1 baselines remain fail-closed as recorded in the latest checkpoint.

## Previous checkpoint — 2026-11-14 (P02 receipt CI caller; P03/P12 reconciliation)

Source `ee41d1233659e4d3b7db7c8b1952298463337fb5` is pushed to
`origin/Mcbt5s-Backup-2`. Both staging and production preflights now run the GET-only resource receipt
collector regression suite, including custom source-map freshness checks, before deployment jobs.
Local evidence: environment-resource **12/12**, receipt-collector **4/4**, Billing dunning
dispatch/outbox/status **12/12**, Workflows queue dispatch **11/11**, dunning recovery **10/10**, and
`git diff --check`. The current P03/P12 source trace found both subscription scopes use a durable
versioned outbox, stable workflow IDs, current-subscription/recovery checks, Notification IDs and
provider-outcome receipts; no independent code gap was found in that path. Grace/restriction/escalation,
retry cadence and provider delivery acceptance remain policy/live gates. P02 still blocks on real
separated Cloudflare resources, `naelao-calls` ownership, account/time receipts, 158 read-only resource
receipts and operator-attested D1 baselines. No deployment or live provider acceptance ran.

Exact next action: implement a customer-facing, signed keypad-extension microapp using the existing
per-installation settings, owner phone dashboard and synthetic-call APIs. Keep simulated runs labeled,
preserve Twilio-only speech and Telnyx DTMF bounds, and do not add carrier provisioning or streaming.
Then continue remaining §9.5/P05 and S3–S9/U01–U12/P01–P24 gaps.

## Previous checkpoint — 2026-11-14 (P20 refund conflict reconciliation)

Source `aa877154d5a808da03ec6d6d07a485dabd6d8994` is pushed to
`origin/Mcbt5s-Backup-2`. If an invalid-amount refund arrives before its captured payment, its case
remains `policy_conflict` but now receives the later exact purchase link during settlement, preserving
the review evidence. Tenant and purchase-identity mismatches remain unlinked. Local SQLite-backed
Marketplace settlement plus operator-review suites pass **12/12**, Billing typecheck passes, and
`git diff --check` passes. No access, creator-clawback, dispute or payout policy changed; no provider,
deployed or live acceptance ran. P20 remains PARTIAL for those product decisions and live reconciliation.
P02 code `fe8b3121`/`6f5ded73` is also pushed; actual Cloudflare resource ownership, separated bindings,
fresh account receipts and operator-attested D1 baselines remain external evidence gates. Preserve the
intentionally untracked `infra/scripts/__pycache__/`; keep all rollouts disabled.

Exact next action: trace P03/P12 dunning from both billing outbox and queue producer through workflow
creation, retry scheduling and notification receipts. Close one concrete reachable contract/idempotency
gap if present; preserve unresolved grace/restriction and retry-cadence policy. Then proceed to the next
independent S3–S9/U01–U12/P01–P24 implementation gap without repeating finished audits.

## Previous checkpoint — 2026-11-14 (P02 receipt identity and source freshness)

P02 validator/collector fixes `fe8b31216c6c6049c7c3519dea0744e2f58e00e6` and
`6f5ded73c48be8a5d44644ce694ea2a43dbdbdd1` are pushed to `origin/Mcbt5s-Backup-2` from
`autonomous-managed-services-20261111`. Receipt validation now binds R2 and Vectorize observations to
their configured provider names, and the GET-only receipt collector compares every supplied source map
(including custom paths) to the current selected Wrangler inventory before making provider calls.
Local evidence: environment-resource and receipt-collector suites **16/16**; `git diff --check`.
The current local preflight correctly remains fail-closed on one shared D1, eleven shared KV IDs,
unresolved `naelao-calls`, missing Cloudflare account/time observations, and 158 missing resource
receipts. No Cloudflare account, deployed resource, or remote D1 was inspected. P02 remains PARTIAL for
actual resource separation/ownership, receipts and operator-attested D1 baselines. Preserve the
intentionally untracked `infra/scripts/__pycache__/`; keep rollouts disabled.

Exact next action: continue P20's license-refund settlement path from provider webhook normalization
through the existing durable refund-case review and buyer/author status callers. Close a concrete
policy-independent identity, idempotency, or persistence gap if present; do not decide license access,
author clawback, dispute or payout policy. Then continue independent P03/P12 and S3–S9/U01–U12/P01–P24
gaps without repeating completed audits.

## Previous checkpoint — 2026-11-14 (P04 chunked Space archive objects)

Source `c3b2936a6a33e6b31e49ec360e017e7d1ed0b6ee` is pushed to `origin/Mcbt5s-Backup-2` from
`autonomous-managed-services-20261111`. Existing archive v1 reads remain supported; exports within
2 MiB/object and 4 MiB aggregate keep the old v1 payload. Larger captures use v2 with independent
512 KiB AES-GCM chunks in tenant/Space/archive/key-version-scoped R2 keys. Limits are 16 MiB/object,
64 MiB aggregate, 8 MiB encrypted-manifest plaintext, 10,000 rows/table, and 5,000 object references.
Same-request retries recheck source ETags and rewrite stable chunk keys before publishing the
authenticated manifest. Restore verifies all chunks and checksums before preview; key rotation writes
new-version chunks, verifies and switches the manifest pointer, then removes old-version chunks. The
owner panel and [backup runbook](docs/space-data-retention-and-backup.md) state the current limits and
the separate-service/data exclusions.

Local evidence: Space archive codec and SpaceDO data-ops suites **20/20**, Shell archive panel **2/2**,
Spaces/Shell typechecks, and `git diff --check`. Coverage includes v1 decoding, v2 corruption,
interrupted chunk upload/retry, missing-object restore, and key rotation/old-chunk cleanup. These are
local Worker/SQLite/R2 mocks; no deployed or live R2 recovery drill ran. P04 remains PARTIAL for other
service stores, private inbound data, approved retention/key/jurisdiction policy, RPO/RTO, and isolated
recovery acceptance. P01/P02 actual resource separation and operator receipts remain external evidence
gates. Preserve untracked `infra/scripts/__pycache__/`; keep every rollout disabled.

Exact next action: continue P02 at the rendered-resource receipt/preflight boundary. Inspect that
specific current contract and close a concrete local validator or reachable-caller gap if present;
preserve fail-closed behavior for actual Cloudflare IDs, service ownership, fresh read-only receipts,
and operator-attested D1 baselines. Then proceed through commercial integrity/recovery and the remaining
S3–S9/U01–U12 and P01–P24 requirements without repeating completed source audits.

## Previous checkpoint — 2026-11-14 (P06 inbound Twilio extension cost observations)

Code `6cb043fb56492ecaaffb6fc7e8eb785d09ebfb60` is pushed. Owner/admins can explicitly read an admitted
inbound extension Call SID through the signed phone-menu dashboard. The lookup binds tenant, account,
exact binding/line, caller, inbound direction, and stored installation/handler digest. Only final API
prices with valid currency/time/duration enter the hashed provider-cost ledger; pending or missing
prices remain unknown. Twilio documents that `price` may be delayed and covers connectivity rather than
all call features; the display is not an invoice or Naelao charge. Local evidence was Agents **49/49**,
Spaces **18/18**, SDK **5/5**, typechecks, dashboard syntax and diff check. No live Twilio read,
deployment or acceptance ran; P06 and U02 retain their distinct remaining gates.

## Previous checkpoint — 2026-11-14 (signed template coordination defaults)

Code `a3791d51fc92b2d353d6e7b0b3bbd694f84e1f6b` is pushed to
`origin/Mcbt5s-Backup-2` from `autonomous-managed-services-20261111`. The optional coordination
default is part of the signed `SpaceBlueprint`; Foundry authoring saves/restores it, SDK validation
rejects malformed fields, and owner activation review shows the suggestion and current policy. Only
explicit owner/admin confirmation calls the existing revisioned policy API with `expected_revision: 0`;
existing policy revisions are preserved, and no access to projects or services is granted. Local
verification: Agent SDK **7/7**, Spaces authoring/activation **32/32**, Spaces and Shell typechecks,
and `git diff --check`. No browser, deployed Worker or live multi-user acceptance ran. Preserve the
intentionally untracked `infra/scripts/__pycache__/`.

The §10.3 template-default handoff is IMPLEMENTED_LOCAL; P05 and shared-Space coordination remain
PARTIAL for their other scoped requirements and live acceptance. S2 remains local only for supported
lanes; S3–S9/U01–U12 and P01–P24 retain their row-specific code, policy, contract and acceptance gaps
in the ledgers. No rollout was enabled.

Exact next action: continue S5/MS08d by checking official Modal lifecycle, authentication, compatible
hosting, region, cancellation and cost/usage contracts against the provider-neutral scaffold. Add a
reachable adapter only if the documented contract and host support it; otherwise record the precise
gate and continue the next independent code gap, prioritizing release/environment safety and other
P01/P02 work without repeating completed audits. Keep rollouts disabled.

## Previous checkpoint — 2026-11-14 (Modal host contract; P06 voice caller reconciliation)

The pushed source baseline is `57eea1aa37dbcc9db5c802544e01d7fdf945b38e` on
`autonomous-managed-services-20261111`, tracking `origin/Mcbt5s-Backup-2`. The only untracked path is
the intentionally preserved `infra/scripts/__pycache__/`.

The Modal audit checked the official [JS/Go SDK guide](https://modal.com/docs/guide/sdk-javascript-go),
[Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox), SDK README and client source as of
2026-11-14. The SDK is Beta, requires Node 22+ (or Deno/Bun), and its official client uses Node built-
ins plus `nice-grpc`; Modal documents the gRPC API as private and subject to change. Sandbox create
supports GPU, region and time limits and exposes termination, but the reviewed public SDK contract
does not expose the `actualCredits` field assumed by the local mock. Agents runs in Cloudflare
Workers, has no Modal package, Node host binding or reachable caller. Do not claim Modal support or
map mock credits to provider charges. This is a missing host/caller plus a platform/API and usage
receipt contract gate, not a credential blocker.

P06 source reconciliation found Twilio extension calls can use completed `call.speech` turns through
the signed handler and owner simulator; Telnyx remains keypad-only and rejects streaming. The
`VoiceSession` class that defaults to Cloudflare MeloTTS has no production constructor/caller.
Reachable attachment transcription uses Workers AI Whisper; the reachable OwnerVoiceAgent uses its
OpenRouter audio adapters. Do not switch that active OpenRouter path based on the unused class.
Focused local phone suites pass **41/41** and Agents/Shell typechecks pass. These are local mocks and
static checks; no live provider, browser or deployed acceptance ran.

Exact next action: implement the missing shared-Space template coordination posture contract. Add an
optional signed blueprint default, expose it in owner activation review, and apply it through the
existing revisioned policy API only after explicit owner confirmation and only when no owner policy
revision already exists. Add authoring, persistence, authorization and regression coverage; preserve
default-off behavior and existing approved facts. Then continue the remaining S3–S9/U01–U12 and
platform-plan code gaps. Keep rollouts disabled.

## Previous checkpoint — 2026-11-14 (P24 installed publisher revocation notices)

Code `f3a04010077064cd569ed20933f4b4bbac957db9` adds current-trust status to the installed
Space-shared and owner-only project extension views. A revoked or missing publisher key identifies
the affected installed package, shows the persisted revocation time where available, disables
resume/open in the Shell and closes an already-open shared app after a refreshed trust result. The
host still rechecks signer trust for runtime, install, update and lifecycle actions. Follow-up UI fix
`ad3888eb999793fd16d9f1725ea91cedeb4073e8` closes stale active views on refresh. Local verification:
SpaceDO and signed-package suites **48/48**, Spaces and Shell typechecks, and `git diff --check`; the
Shell typecheck and diff check passed again after the stale-view fix. These are local Worker/SQLite
mocks and static checks; no browser, deployed Worker, notification delivery or live acceptance ran.
Both commits are pushed to `origin/Mcbt5s-Backup-2`. The only untracked path remains the preserved
`infra/scripts/__pycache__/`.

P24's installed-package owner warning is now implemented locally; P24 remains PARTIAL for
cross-tenant transfer rights, broader migration/rollback, scanning, retention, proactive alert policy
and deployed/live acceptance. P05's signed provider references still cannot safely bind to the
Space-wide Template installation scope; required unsupported references block activation and
optional ones are explicit. S2 is IMPLEMENTED_LOCAL only for supported lanes; S3–S9/U01–U12 retain
their row-specific code, contract, policy and acceptance gates in the ledgers. Do not repeat U09,
the supported U11 caller audit or completed U12 verification without new source evidence.

Exact next action: continue S5/MS08d by checking current official Modal lifecycle/authentication,
hosting, region, cancellation and cost contracts against the existing provider-neutral scaffold.
Implement a reachable adapter only if a stable documented interface and compatible host can be
supported; record the precise platform/contract gate otherwise, then proceed to the next independent
S3–S9/U01–U12 or P05/P06 code gap. Keep all rollouts disabled.

## Previous checkpoint — 2026-11-14 (shared-Space collaboration requests)

Code `e46ea4f44c64bd41bbc1a87a81867a4ea1394f83` is pushed to `origin/Mcbt5s-Backup-2` on
`autonomous-managed-services-20261111`. Members can request contact about an active, member-visible
coordination fact after confirming that owners/admins will see their account identifier. The SpaceDO
stores one pending request per requester/fact, scopes member reads to the requester, provides a
bounded admin queue, fences owner/admin resolution by revision, and returns `access_granted: false`;
this workflow never grants project or service access. Local evidence: SDK coordination **4/4**,
Spaces coordination/route/migration **30/30**, Agent SDK/Spaces/Shell typechecks, SDK build, and
`git diff --check`. These are local/mock checks; no browser or deployed multi-user acceptance ran.
The untracked `infra/scripts/__pycache__/` is preserved.

P05 connection handoff was traced across signed channel requirements, activation preview, UserPort,
AgentPort and provider runtime callers. Current UserPort aliases authorize MCP tools/actions; signed
channel requirements reference provider connections bound to active project installations. Space
Template dependencies install `SPACE_SHARED` and have no compatible provider-connection lifecycle.
Required connection dependencies remain explicit activation blockers and optional ones remain
unsupported. This is an uncoded scope/runtime contract, not a credentials blocker. Do not reinterpret
MCP alias IDs as provider connections, accept secrets in template fields, or loosen project isolation.
P05/P06 remain partial; S2 remains local for supported lanes; S3–S9/U01–U12 remain at the row-specific
gaps in the progress ledgers. U05 candidate/observation producers and U06's runtime adapter contract
remain absent; U09's source work is already present. All rollouts remain disabled.

Exact next action: trace P24's current publisher-revocation receipt through the installed-package
owner views and implement a scoped, durable owner-visible compromise/revocation notice if the current
callers lack one. Recheck publisher trust at display and action time; do not repeat U09 or the completed
Space coordination audit. Then continue independent P05, P06 and S3–S9/U01–U12 code gaps.

## Previous checkpoint — 2026-11-14 (shared-Space assistant context)

Code commits `d973388858a854f740de959e578120530a3c598c` and
`96c3da48f103c3515afe5e0ddbc8c44e6d47a166` are pushed to `origin/Mcbt5s-Backup-2` on
`autonomous-managed-services-20261111`. The first adds current audience-filtered registry facts
before every assistant planning decision; the second preserves each fact's `last_confirmed_at`,
marks bounded context as having more entries when it truncates, and tells the model to treat facts as
untrusted, advisory and freshness-bound. Local Agents checks: **35/35** focused tests and `tsc
--noEmit`; earlier Spaces route/registry suites passed **19/19**. No browser, deployment or live
multi-user acceptance ran. P05's signed package dependency review and P06 keypad voice work remain
partial as described in the ledgers. U05's verifier/caller exists; candidate/reservation and trusted
runtime-observation producers remain absent. U06 remains gated on undocumented writer/drain/flush/
reconnect/handoff semantics. U09's project-main registry and branch/generation fencing are already
source-present; do not repeat that audit. Preserve `infra/scripts/__pycache__/`.

That recorded next action has been completed as a source trace and corrected in the latest checkpoint
above: current UserPort MCP aliases cannot satisfy signed channel-provider connection requirements.
The mismatch remains uncoded pending a safe provider/installation scope contract.

## Prior checkpoint — 2026-11-14 (Space coordination disclosure policy)

Code commit `4c458a9e695ea6bbdcd04c083dea0ea758a51a2f` is pushed to
`origin/Mcbt5s-Backup-2` on `autonomous-managed-services-20261111`. Space coordination now has a
revisioned owner/admin policy for new member-visible facts, default-off behavior, transactional
publish/amend enforcement, explicit unpublish-before-disable, metadata-only paginated policy history,
and a Settings control. Existing approved facts remain visible; member reads still omit actor details.
Verification: Agent SDK coordination **4/4**, SpaceDO/route/migration **26/26**, SDK/Spaces/Shell
typechecks, SDK build and `git diff --check`. These are local SDK/SQLite/Worker mocks; no deployed
multi-user acceptance ran. The intentionally untracked `infra/scripts/__pycache__/` remains.

Exact next action: trace the current `SpaceBlueprint` schema, Foundry signed export/validation,
activation review and runtime consumers for the recorded P05 knowledge/action authoring gap. Reuse
existing signed package and host authority; implement only declarations that have a complete
runtime-enforced contract, and record any genuine missing product/authority decision without
pretending it is credential-blocked. Continue §10 lifecycle and S3–S9/U01–U12 afterward. Keep
rollouts disabled.

## Prior checkpoint — 2026-11-14 (Foundry lifecycle recovery)

P05 recovery is committed and pushed to `origin/Mcbt5s-Backup-2` through `cf2d28f704ae207c0eed20f62f7e06237821d563` (`34c7da23` host recovery; `64669caf` reload repair; `cf2d28f7` terminal-state correction). Foundry persists the exact export request/fingerprint before dispatch, recovers the host conformance job through owner-authorized status, saves the listing only after signed graduation succeeds, and reconciles retries without duplicate export/listing effects. Reload restores lifecycle and product state; completed but uncertified jobs no longer remain labeled `building`. Focused Agent SDK dogfood tests pass **3/3**, Agent SDK typecheck passes, and `git diff --check` passes. Earlier `34c7da23` evidence covers Spaces recovery/graduation/migration **15/15**, Shell status caller **1/1**, and related typechecks. All are local mocks/SQLite; no browser, deployed Worker/D1, provider, or live acceptance ran.

P06's existing keypad simulator already exercises synthetic `call.received` and `call.digits` through the host response validator/renderer; the bounded phone-menu dashboard shows those simulations as synthetic and its signed per-installation configuration and read-only operations view. Do not repeat that task. P05 knowledge/action authoring still lacks a matching SpaceBlueprint/runtime contract; image/audio/raw binary extension media is not authorized by the text-only attachment contract. P06 conversational streaming, customer voice lifecycle, managed billing/invoices and provider/region acceptance remain unavailable or unverified. S2 is IMPLEMENTED_LOCAL for supported lanes; S3–S9/U01–U12 retain their documented row-specific contracts, policies, feeds and acceptance gates. Keep rollouts disabled and preserve untracked `infra/scripts/__pycache__/`.

Exact next action: implement an explicit owner/admin policy gate for new Space-member-visible coordination facts, defaulting to disabled until configured. Persist a revisioned setting, enforce it transactionally in publish/amend, require explicit unpublish before disabling while member facts remain, expose it in Space Settings, and cover races/authorization with DO and route tests. Preserve existing published entries and the current per-entry disclosure confirmation. Then continue the remaining §10 coordination policy/lifecycle rows and other uncoded requirements in both active plans.

## Previous checkpoint — 2026-11-14 (phone dashboard handoff; completed)

P05 signed-template onboarding now reviews validated channel defaults before install (`1aff67de`),
links the extension review to the target Space dashboard (`f1a82b42`), and after activation opens the
target Space Assistant settings to resolve and adjust those defaults (`17683e29`). P06 adds an
owner-phone-panel routing-readiness state in `4b8749b56db7f04208a1ca6531fc45c9a81b8af7`: a line is
called ready only if it is active, its assignment is active, the handler digest is valid, and the
current trusted candidate list matches both the exact installation ID and digest. The wording is
limited to supported keypad events. All four code commits are pushed to `origin/Mcbt5s-Backup-2`.
Latest local evidence: Shell **36/36** and Shell typecheck pass; `git diff --check` passes. No browser,
deployed Space/Worker, carrier or live-call acceptance ran. P05 and P06 remain PARTIAL for the wider
journeys in the progress ledger. S2 remains locally implemented for supported lanes; S3–S9/U01–U12
retain the specific gaps and external contracts recorded there. Keep rollouts disabled and preserve
the intentionally untracked `infra/scripts/__pycache__/`.

This phone-to-dashboard handoff was completed in pushed commit `15e86a66`; the active next action is
the multi-project guided-setup follow-up above.

## Previous checkpoint — 2026-11-14 (activation channel defaults; completed)

Latest guided-template checkpoint: Foundry Studio now authors validated `assistantChannels`
availability and phone-prompt defaults. The owner export route reuses the Agent SDK validator and
rejects email provisioning directives, so this authoring path cannot connect accounts or spend.
Code `e96cc0a1a983d64dd4e0a75e9326b67fa3669c4e` is pushed to `origin/Mcbt5s-Backup-2`.
Local evidence: Spaces authoring/export tests **6/6**, Agent SDK dogfood test **3/3**, Spaces and
Agent SDK typechecks, embedded Foundry JavaScript syntax, and `git diff --check`. These are mocked
local checks; no browser, deployment, provider, or live acceptance ran. P05 remains partial for
channel connection, action authoring, package lifecycle, rates and live acceptance. Preserve the
untracked `infra/scripts/__pycache__/` directory.

Activation persistence is verified in pushed test commit `6693d380914d248ac7885a90a10ddfc055d665ba`:
the target DO stores `channels:template`, the owner preference endpoint resolves it, and email remains
`none` / `provisionOnCreate:false`. Spaces activation test passes **3/3** and Spaces typecheck passes;
no provider is invoked. Exact next action: include these validated defaults in the activation-preview
API and render an explicit pre-install review in Shell, clearly separating preferences from account
connections/provisioning. Then continue the next uncoded guided-template lifecycle item and S3–S9 /
U01–U12. Keep rollouts disabled.

The activation-preview API and owner review were implemented in pushed commit
`1aff67dee97b5d835c8e4cb55c58c44a0721b16f`. The preview exposes only channel availability and phone
prompt defaults; the Shell says connections/provisioning are separate. Spaces activation preview
tests pass **21/21**, Spaces and Shell typechecks pass, and `git diff --check` passes. No browser,
deployed or live acceptance ran. Its follow-up is complete in `bf55151a`; the SDK setup schema and
activation review already supported per-project groups, which corrects the earlier source
reconciliation note below. Continue from the latest checkpoint above. Keep rollouts disabled.

The U12 typing fix is pushed to `origin/Mcbt5s-Backup-2` as
`6ee3a16577fba9c14304aae4d4b24cb43050c254`.

P21 builder reset-email dispatch is implemented and pushed as `814c429af84f0b5089286cf4fbd13727b252ba75`.
Auth stores the encrypted reset payload atomically with its token in migration 0245, uses bounded
leased retries with stable Notification IDs and superseded-token cancellation, preserves the neutral
reset response, and exposes tenant-HMAC-scoped metadata diagnostics. Auth tests pass **39/39**, Auth
typecheck, release/deployment manifest checks, release-migration tests **15/15**, staging/production
Wrangler dry runs and `git diff --check` pass. Migration inventory is 245. This is local/mocked
evidence; no deployment, provider acceptance or inbox delivery was exercised. P21 remains PARTIAL for
real delivery, unverified-user/session policy and deployed acceptance.

U03 Agent37 lifecycle recovery and U11's supported settlement, provider-cost, threshold/alert and
owner-control callers were already audited; no independent U11 caller gap was found. Do not repeat
those audits absent new source evidence. U12's current toolchain checks found and fixed a real
`fetchMock` call-argument type error in the Lemon Squeezy provider test. With the pinned pnpm 9.12.0
invoked for Turbo child processes, the focused Billing suite passes **52/52**, the full workspace
build passes **55/55 tasks**, and the full workspace typecheck passes **82/82 tasks**. A bare global
pnpm 11 invocation still fails in this non-TTY workspace; the repository remains pinned to pnpm 9.
Build included local image builds and Wrangler dry runs only. No deploy, CI event, provider call or
live acceptance ran; U12 remains PARTIAL for future CI execution and deployed image parity.

P10/P24 rollback to an earlier signed Space-shared static Canvas/channel-code release is pushed as
`0d121ab2` to `origin/Mcbt5s-Backup-2`. The authenticated Space-admin release-history route limits results to 50
and rechecks publisher trust; the Shell selects an exact historical release and reuses signed review,
pause/drain and durable apply receipts. Tests cover a 1.2.0→1.0.0 rollback that remains paused, stale
pins, unavailable exact releases, revoked keys and release-list bounds. Focused Spaces suites pass
**46/46**, full workspace build **55/55 tasks**, full workspace typecheck **82/82 tasks**, and
`git diff --check`. These are local Worker/SQLite/build checks only; nothing deployed or live was
exercised. P10/P24 remain PARTIAL for data/schema migration recovery, authority/config changes, key
compromise response, scanning, retention and live acceptance.

P06 voice operations metadata is pushed as `4c42012b`. The trusted Space runtime returns the exact
signed package/version and publisher/key identity; the owner-only phone dashboard verifies the active
key is registered to that publisher, then shows the version, publisher and key fingerprint. Local
evidence: Spaces route/runtime suites **45/45**, Spaces and Agent SDK typechecks, inline dashboard
JavaScript syntax check and `git diff --check`. No provider, carrier, deployed Worker or live call was
exercised. P06 remains PARTIAL for customer voice lifecycle, streaming, managed billing, invoices and
live/region acceptance.

P05 visual customer-form preview is pushed as `50dd1fa4`. It renders the current bounded v1/v2 field
types, defaults, required flags, localization and earlier-field conditions; preview values remain in
the page and are never sent to the host. Labels, help and options are written with DOM `textContent`.
Local evidence: Agent SDK dogfood/blueprint setup suites **13/13**, SDK typecheck and generated
script syntax check. No browser session or deployed Template was exercised. P05 remains PARTIAL for
channel/action authoring, package lifecycle effects, full cost/rate support and live acceptance.

The earlier assistant-channel authoring action was completed and pushed as `e96cc0a1`; see the latest
checkpoint for its evidence and the exact next task.

P13 queue routing fixes are pushed as `4de53055` and `d640dbae` to `origin/Mcbt5s-Backup-2`. Unknown/misrouted and malformed poison messages in Workflows, Billing, Notifications, Analytics, Provisioner and Agents now retry into their configured DLQs; known stale messages still ACK. Local suites and six affected Worker typechecks pass. Queue bindings are worker-specific; the Admin DLQ consumer is bound to a separate queue and stores/logs raw payloads, so no generic replay was added. P23 Notification terminal status is durable, but other DLQs lack a safe payload-retention/idempotency contract. Queue depth/age/DLQ remain unknown without a supported API or operator evidence.

P14 browser logout is pushed as `31aac278b7962fd28bbe592abf1783a816bbd07e`. Portal and Shell Product-user clients await account-generation revocation; Portal and Dashboard builder clients await `/v1/auth/revoke`; Shell also awaits HttpOnly DeskDrop cookie revocation. Callers retain credentials and show a retryable error when revocation fails, treating an already-revoked builder token (401) as success. Local evidence: Shell **3/3**, Portal **3/3**, Spaces logout route **17/17**, Shell/Portal/Dashboard typechecks and `git diff --check`. P14 remains PARTIAL because bearer tokens still use localStorage and cookie/CSRF/XSS transport and cross-product browser acceptance remain unresolved. No deployment or live test ran.

P11 code `16386d95679c5c739d07b3fbcc1061f98244b3ae`, P07 `0da0abdbd80a9ea5dfa2ff5729be6c4cd53aaea1` and P01 `60c5f03b30aac5241a379b0c59bbf343ed0186b1` remain pushed. Migrations 0243–0244 persist immutable provider-event purchase terms; P07 private local-model routing uses exact machine and grant checks; P01 requires a durable environment-specific migration runner plus remote D1 probe. Setup recovery `c1c5e0d4`, U11 alert delivery `88457f40`, P08 default-off video frames `87374fc2`, U12 build staging and MS07 combined Assistant/AgentMail search remain as previously recorded. Preserve `infra/scripts/__pycache__/`; rollouts stay disabled.

P12 recovery cadence/access policy and live delivery remain undecided or unverified. P02 remains fail-closed on 13 shared resources, unresolved `naelao-calls` ownership, 158 missing receipts and missing account/timestamp evidence. U05 has no trusted runtime observation/candidate producer; U06 lacks a supported writer admission/drain/flush/handoff contract and adapter. The exact next action is U11 as stated in the active checkpoint above; Agent37 U03 lifecycle has been re-audited and must not be restarted without new evidence.

## Recent completed-work record

Earlier completed-work checkpoint: P24 template dependency import is pushed to
`origin/Mcbt5s-Backup-2` as `536853b9`; revocation recheck/status correction is pushed as
`b646ec16`; reload recovery is pushed as `edf08814`. The owner-facing Template setup UI now
selects an active same-tenant source Space,
reviews the signed dependency closure against the exact required version and optional manifest
digest, imports immutable artifacts with retry, reviews destination permissions/capabilities, and
installs the exact pin with no shared-folder grants. It refreshes activation readiness and reconciles
an ambiguous install response from the exact active pin. Both import review and copy recheck the
manifest digest; both source/destination admin authorization and publisher trust are rechecked. A key
revoked after review blocks copy with 403 and no destination writes. Cross-tenant seller packages
remain behind existing listing entitlement checks.

After reload, the owner can query the destination's existing signed-install review directly without
repeating the source copy. The destination endpoint rechecks exact package pins and publisher trust.
Local evidence: signed Space package/import suite **17/17**, Spaces and Shell typechecks, and
`git diff --check`. Tests cover source/destination authorization, exact-digest mismatch, revoked key
after review, partial and post-success retry. These are local Worker/R2 mocks and typechecks; no
browser, deployed DO, Marketplace, provider or live acceptance ran. P24 remains PARTIAL for
cross-tenant artifact rights, general migration/rollback, compromise notice, scanning, retention and
deployed/live acceptance. P05 remains PARTIAL for supported customer channels/provider journeys,
broader update/uninstall effects, rates and live acceptance. §9.5 caller audit is complete: the
deprecated MeloTTS constant is confined to an unused `VoiceSession` module path; no production source
constructs that class. Reachable transcription uses the separate Cloudflare Whisper adapter, and owner
calls use OpenRouter. No model migration is warranted. Coordination lifecycle code `f0d38035` is now
pushed: v2 facts have owner-selected optional expiry in SpaceDO migration 128; expired facts are
filtered from audience reads, owners/admins can review expired/revoked records, and Settings can renew
an expired fact through the confirmed expected-version edit. No default expiry or singleton policy was
introduced. Local verification: SDK coordination **4/4**, Spaces coordination/route/migration
**17/17**, SDK/Spaces/Shell typechecks, and `git diff --check`. These are local SQLite/Worker checks;
no deployed multi-user or live acceptance ran. Code `e8f77f7f` is pushed and exposes the persisted
creator, approver, approval role, provenance and revocation actor only in authenticated owner/admin v2
responses and the Settings lifecycle view. Member list responses continue to omit actor metadata.
Verification remains SDK coordination **4/4**, Spaces coordination/route/migration **17/17**, and
SDK/Spaces/Shell typechecks; local mocks only. This earlier next action is complete in `d208ec02`; resume from the active checkpoint above. Keep cross-tenant seller
artifacts gated, rollouts disabled, and preserve `infra/scripts/__pycache__/`.

Earlier current checkpoint (2026-11-13): P10/P24 code commit `c7412170` is pushed to
`origin/Mcbt5s-Backup-2` on branch `autonomous-managed-services-20261111`;
runtime-work admission/drain is in `15a04f7e`. P10/P24 now
allow an owner-reviewed same-publisher release update for version-only manifest changes to static
Canvas and channel-handler code packages with unchanged authority/configuration. The host verifies
the signed artifact; review reads active runtime-work leases for active or paused installs and withholds
the apply token until the install is paused and drained. SpaceDO rechecks signature, version, pause and
leases transactionally, then updates the pin with a durable replayable receipt. The Shell describes
the exact scope and shows remaining operation count. Focused Spaces suites pass **45/45**; Spaces and
Shell typechecks and `git diff --check` pass. This is local Worker/SQLite evidence only; no deployed
DO, Marketplace, live provider or live acceptance ran. P10/P24 remain PARTIAL for Gadget/schema/data
migrations, recovery/rollback, broader authority/dependency/connection/price changes, compromise
response, scanning, retention and live acceptance. Preserve the untracked
`infra/scripts/__pycache__/`; rollouts stay disabled.

P04 now has an owner/admin full-archive export control in Shell. It calls the existing resumable API,
retains a Space-and-actor-scoped request ID in session storage through ambiguous responses, and shows
the current limits/exclusions. P04 remains PARTIAL for archive caps, cross-service coverage, approved
retention/key/jurisdiction policy and isolated/deployed recovery evidence. P10/P24 remain PARTIAL:
general update review receipts, runtime/data migration preview and recovery, wider rollback/version
selection, authority/dependency expansion, provider connection and price changes, compromise response,
scanning/retention and live acceptance remain uncoded or unverified. A project-scoped rollback picker
exists in ChannelConnect; it is not a general rollback path. The 30-minute lease expiry is crash cleanup;
provider/deployed timing is not verified. P01/P02 still require actual resource separation, ownership,
158 read-only receipts and operator-attested D1 baselines. No live or deployed acceptance is claimed.

The managed-services ledger reconciles current S2–S9/U01–U12 code and callers. S2 is local for supported
lanes. S4–S9 remain partial at the row-level gaps in the ledger. U05's missing trusted candidate and
runtime-observation producer and U06's missing authenticated admission/drain/flush/handoff contract are
runtime/platform gaps, not credential blockers; do not synthesize observations or invent an adapter.
U11/U12 supported callers/build wiring are locally implemented, while invoices, billed-idle/CPU-size
feeds and live evidence remain open. P01/P02 still require real resource separation, ownership, 158
read-only receipts and operator-attested D1 baselines. P03/P20 grace/restriction and refund/access/
author-accounting policies remain unresolved and must not be guessed. Do not repeat completed audits
without new evidence. The previously recorded local keypad simulator task is already implemented in
the current owner phone panel, exact-installation Space route and Agents host validator/renderer.
Focused Agents tests pass **46/46**, the Space route tests **18/18**, and Agents/Spaces/Shell typechecks
pass. These are local tests only; no carrier call occurred. The prior P17 and simulator next-action
notes are historical; current source reconciliation is already recorded in the two progress files.
After compaction, interruption or a new session, read both plans, both progress records and this
runbook; inspect the actual branch and worktree; resume from the exact current action at the top. Do not deploy,
purchase, reset, clean, switch branches or force-push.
The user authorized normal commits and pushes of each coherent checkpoint to `Mcbt5s-Backup-2`:
fetch before each push, safely incorporate remote advances, and never rewrite remote history.

Earlier code `5e0c65019f3e0b9dc994977cfba494a1f8c8eaf9` adds P05 scoped text attachment access.
Channel packages may opt into text extraction with owner/admin approval; opaque handles are tied to
the exact tenant, Space, project, installation, provider connection, channel, provider message and
expiry. The host rechecks the active signed installation/binding before list/read, enforces file/byte/
MIME limits, reads private R2 objects and passes selected text to grounded answers as untrusted
sources. No provider URL, credential, object key or raw bytes reach extension code. Legacy
non-extension IDs and object paths remain stable. P05/P16 remain PARTIAL for binary/image/audio media,
richer responses, remaining provider journeys and live acceptance. Local evidence: Agents focused
suites **18/18**, Spaces migration/runtime/install-route suites **36/36**, SDK extension suite **29/29**;
Agents, Spaces, Shell and SDK typechecks. No deployed DB, provider traffic or live acceptance occurred.

Historical next action: add an owner-authorized phone operations view for the signed keypad package.
That work was completed in later pushed checkpoints recorded below; resume from the active P24 action
at the top. Do not invoke carriers, expose credentials, or enable streaming/provisioning/rollout.

Prior keypad-package checkpoint (2026-11-13): code `b4c0100f1d5c898ddde137ebf88fea294f99d386` is pushed to
`origin/Mcbt5s-Backup-2` after fetching and confirming the remote was an ancestor. Preserve the
untracked `infra/scripts/__pycache__/`. The new signed-extension example
`packages/agent-sdk/examples/bounded-phone-menu/` defines a two-choice keypad menu, per-installation
settings schema and dashboard, and a deterministic handler using the host's versioned `say`/DTMF/
`hangup` contract. It does not use speech recognition, an LLM, call transfer, or outbound dialing.
Local evidence: SDK package/response tests **10/10**, Agents phone/Telnyx/response tests **42/42**,
Spaces extension settings/install tests **29/29**, SDK typecheck, standalone handler typecheck, and
`git diff --check`. No package was published, provider account or deployed database was exercised,
and no live call was made. §9.5 remains PARTIAL: this bounded keypad IVR is not a conversational
voice-agent product; provider provisioning, speech/streaming, full lifecycle, invoice reconciliation
and live acceptance remain open.

At that checkpoint, the exact next action was to trace and extend the owner `phone-handler-test` API
and Shell caller for call-start and DTMF simulation. That work is closed in `c31a8640`.

Prior voice-catalog checkpoint (2026-11-13): code `2ef44afaeeb1100fb2a7e992b7ef297cd9ecb033` is pushed to
`origin/Mcbt5s-Backup-2` after fetching and confirming the remote was an ancestor. Preserve the only
untracked work, `infra/scripts/__pycache__/`. Code `2ef44afa` exposes host-approved speech and
transcription models, sample rates, supported catalog languages, per-unit published list rates and
dated source links through the owner voice-settings API. The Shell Assistant Voice panel and signed
Space voice microapp show the rates with a reproducible 30-second transcription/375-character speech
subtotal and explicit exclusions; both say availability and billed rates are unverified. Local checks:
Space voice-settings tests **4/4**, Agent SDK dogfood microapp test **3/3**, Agent SDK/Spaces/Shell
typechecks and `git diff --check`. These are local tests only; no provider availability, rate, deployed
or live-call acceptance was exercised. The prior `7a0098ee` extension-settings audit checkpoint adds
metadata-only extension-settings
audit events in SpaceDO migration 123, atomically with optimistic revision writes, plus owner/project-
manager history APIs and Shell views. Events record installation/scope, actor/role, old/new revision,
schema, changed field IDs and time; no setting values. Uninstall preserves the audit trail and the
existing Space-erasure sweep removes it. Focused Space settings/migration/erasure/route tests pass
**27/27**, Spaces/Shell typechecks pass, and `git diff --check` passes. These are local SQLite/Worker
mocks; no deployed DB or live acceptance was exercised.

Prior code checkpoint `90b6ddd78ec8dfcafc513085deafdee6d09b4f27` is pushed to
`origin/Mcbt5s-Backup-2`; local branch `autonomous-managed-services-20261111` matches the fetched
remote. Code `249c7930` added generic Space-local installation of exact host-attested signed extension
packages with Canvas/Gadget actor initialization and runtime publisher rechecks. Code `90b6ddd7` added
a binding-scoped hash to admitted Telnyx call-cost receipts, joined bounded provider-reported totals to
recent extension calls, and labels them as provider observations rather than invoices; absent receipts
remain unknown. Its Agents phone/webhook suites passed **40/40**, Agents/Shell typechecks, release and
deployment-manifest validators, and `git diff --check`. The signed-package suites passed **42/42**,
with Spaces/Shell typechecks. No provider account, deployment or live acceptance was exercised.

The detailed S2–S9/U01–U12 ledger already reconciles U11/U12 for supported local callers/toolchain;
actual invoices, billed-idle/CPU-size feeds, approved policies and live evidence remain. Do not repeat
that audit without new source evidence. S2 remains IMPLEMENTED_LOCAL for supported lanes; S3–S9 and
U01–U12 keep their row-level status and gaps. §5, §9.5 and §10 remain PARTIAL. P01/P02 fail closed on
actual environment separation, ownership/resource receipts and operator-attested D1 baselines; other
product, policy, runtime contract and live acceptance gates remain in both progress records.

Historical next action: continue §9.5 through the signed extension and bounded Telnyx `say`/DTMF
callers. Its phone simulator/package work is recorded in later checkpoints; resume from the active
P24 action at the top. Keep public streaming and provider/live acceptance gated.
The earlier §10.2 expected-version-fenced, audience-confirmed amendment is already implemented and
pushed as `bfc22ce6`; do not repeat it. After compaction, interruption or a new session, read both
plans, both progress records and this runbook; inspect the actual worktree, branch and dirty state;
resume from that exact action. Older next-action notes below are historical; this checkpoint and the
two progress records govern.

Safety and fixed decisions remain in force: keep rollouts disabled; do not deploy, purchase services,
reset, clean, switch branches, or force-push. Preserve uncommitted work and the existing
`infra/scripts/__pycache__/`. The user has authorized normal commits and pushes to `Mcbt5s-Backup-2`:
fetch before every push, safely integrate remote advances, and never rewrite remote history.

Previous code checkpoint `881c1d1a` added signed phone-handler candidate discovery. Owner phone status
lists only active, correctly scoped phone installations whose publisher signature and complete
artifact set still verify; the panel selects and fills the exact handler digest, then requests explicit
owner confirmation. SpaceDO listing supports Project and SPACE_SHARED installations, and assignment
repeats the runtime admission check. Local evidence: Agents phone suite **34/34**, Spaces extension
runtime suite **22/22**, Agents/Spaces/Shell typechecks, `git diff --check`. These are local mocks; no
deployed Space or real provider call ran.

P01/P02 remain PARTIAL: distinct D1/KV resources, resolved `naelao-calls` ownership, read-only resource
existence receipts, per-environment operator-attested migration baselines and isolated/deployed
acceptance remain missing. Do not invent receipts or change live configuration.

The prior §10 audience code `9ec259ba` is also pushed. Migration 119 preserves prior facts as schema
v1 with `space_members`; v2 SDK, gateway, Router and Shell support explicit `space_members` or narrower
`space_admins` visibility. SQL filters before keyset limits and v2 cursors bind to audience class.
Local evidence: SDK **4/4**, Spaces registry/migration/gateway **15/15**, Router **45/45**, SDK/Spaces/
Router/Shell typechecks. §10 remains PARTIAL for broader collaboration policy, project publication/
request-to-use, ownership/lifecycle links, singleton reservations, concurrency and broad side-channel
acceptance. No deployed multi-user privacy test or live acceptance ran.

The S2–S9/U01–U12 source/caller matrix is reconciled, not declared fully complete or accepted live.
S2 is IMPLEMENTED_LOCAL for currently supported lanes; partial rows retain their named unsupported
runtime/provider contracts, missing external feeds, product/legal decisions, external evidence or
deployed/live acceptance. Keep U05/U06 live runtime disabled; their trusted allocation/observation
producer and pinned writer-admission/drain/handoff contract are not credential blockers. Preserve the
untracked `infra/scripts/__pycache__/`. Continue with §10 lifecycle and policy gaps, while revisiting
remaining S2–S9/U01–U12 rows only where the ledger identifies an ordinary uncoded caller. Keep
provider/runtime constraints and acceptance gates explicit.
Do not deploy, buy services, reset, clean, switch branches or force-push.
P04 recovery-safety code `b6c408c8` remains pushed. Restore previews disclose archived active event
triggers; missing rows are inserted disabled, existing destination state is preserved, and durable
receipts track that action. Owner/admin Settings lists archives/restore records and can resume partial
restores; a project-authorized owner/admin API re-enables reviewed triggers while the project remains
active. No deployed D1/R2, isolated restore, provider reconnection or RPO/RTO drill was exercised.
P04 remains PARTIAL for bounded archive limits, merge-only semantics, cross-service recovery,
key/legal/jurisdiction policy and live acceptance.

P03 code `51defd9f` adds scope-bound durable Resend accepted/rejected/ambiguous outcomes and a
tenant-scoped owner/admin status list. Local/mock evidence and limits are in the managed-services
ledger; grace/restriction/escalation and refund/dispute policy plus live provider acceptance remain
open.

P01/P02 code `3e456061` and `a1827a05` remains pushed. The preflight checks mutable cross-environment
D1, KV, R2, Vectorize, Queue, Workflow, Durable Object script and service targets; requires 158
read-only resource receipts and distinct observed DO namespace IDs. The redacted Wrangler map covers
28 config files, 100 binding rows, 56 Worker/environment surfaces, two routes and 30 endpoint-host
entries. Local evidence was resource validator 9/9, Wrangler isolation 6/6 and release manifest 5/5.
Preflight still fails closed on one shared D1, eleven shared KV IDs, the shared/unresolved
`naelao-calls` target and absent receipts. P01 also lacks operator-attested D1 baselines and isolated
or live release acceptance. No Cloudflare account or provider was inspected.

The prior code `99a036cd` also exposes persisted Template setup values to the exact active required
SPACE_SHARED extension through host validation, capability checks and optimistic revisions.

S2–S9/U01–U12 remains the source of truth; do not claim the managed-services mission complete while
its named partial rows remain. U05 still lacks a candidate allocator and trusted runtime observation
producer. Sandboxes stores new computers as `snapshot_diff`; the supported allocation caller is
Agent37, and Cloudflare computer creation is configuration-only and unallocated. The live verifier
requires a current Cloudflare `live_mount` allocation, reservations and fresh attested capability
observations. This producer is coupled to U06's unsupported pinned-runtime writer admission,
drain/flush and generation-bound handoff contract. This is not a credential blocker. Keep live
runtime disabled and do not synthesize trusted records.

S2–S9/U01–U12 remains reconciled in the implementation-progress matrix; do not claim the managed
services mission fully complete. Its recorded partial requirements still include the unsupported
U05/U06 live-writer contract, product/payment and retention decisions, missing provider evidence,
external consumer durability, and deployed/live acceptance. P01 is partial for absent operator-attested
D1 baselines and live release acceptance. P02 is partial for shared configured IDs, the unresolved
`naelao-calls` owner, 158 missing receipts, and external secret/callback/jurisdiction inventory. Exact
next task: continue P03/P20 commercial recovery by adding durable notification-provider acceptance
outcomes linked to the existing stable dunning notification IDs; keep provider acceptance distinct
from inbox delivery and do not invent grace/restriction, refund/dispute, payout or operator-identity
policy. Then continue P04 recovery requirements and guided-template lifecycle, voice dashboards and
Shared-Space coordination in dependency order. Preserve all rollout flags, local/mock/deployed/live
distinctions and `infra/scripts/__pycache__/`; do not deploy, buy services, reset, clean, switch branches
or force-push.

Earlier code commits `07af44c2` and `9919963e` add per-install extension settings and a reference
Assistant Voice preferences microapp. The dashboard edits Space Assistant preferences only; a
customer-agent package, call preview, custom voices, streaming, provider tests and deployed behavior
remain open. The Template setup runtime reader is implemented locally; browser draft/resume,
conditional/localized fields, expected-usage estimates, complete rates and full lifecycle remain open.

Managed-services S2–S9/U01–U12 remains reconciled in the progress ledger, with named policy,
unsupported runtime/platform contract, external evidence and live acceptance gaps kept distinct.
P01/P02 remain fail-closed on environment-resource separation, ownership receipts and
operator-attested migration baselines. P03/P20 still need approved grace/restriction and
refund/dispute/author-accounting policies plus an independently authenticated operator identity.
Continue the managed-services ledger alongside the platform plan; do not call the full mission complete
while any named requirement remains uncoded or gated. The active platform order is release/environment
safety, commercial integrity/recovery, guided-template lifecycle and cost, voice-extension dashboards,
then Shared-Space policy/lifecycle. The retired `/customer-voice/*` route stays closed and public
extension streaming stays unavailable. Do not repeat completed audits without new source evidence.
Historical next task: implement §5 browser draft/resume. This closed in `f5050258`; continue with the
new exact next action above. Preserve the S2–S9/U01–U12 ledger and do not label unsupported U05/U06
runtime contracts, product policy, missing external receipts, or untested live behavior as complete.

P04 bounded object capture and restore code commit `937fbdd5` remains pushed to
`origin/Mcbt5s-Backup-2`, based on P24 code `415ba199`.
New full archives capture at most 2 MiB per workspace object and 4 MiB total inside the existing
8 MiB encrypted archive. Restore verifies object checksums, conditionally recreates missing objects,
never overwrites conflicting content, and records partial progress in migration 111. The focused
Space data-operations suite passes **9/9**, Spaces typecheck passes, and `git diff --check` passes.
These are local SQLite/R2-mock results; no deployment, isolated restore, live R2 check, or measured
RPO/RTO drill was performed. P04 remains PARTIAL for archive size/row limits, merge-only relational
restore, legal/key/jurisdiction policy, provider reconnection safety, and isolated/live recovery
evidence. P24 remains PARTIAL for dependency closure, template-activation artifact transfer and
package retention/compromise notices. Revocation/drain receipt and owner readback are implemented
locally in `f5b3c1dd` and `0ba70840`. Preserve the unrelated
`infra/scripts/__pycache__/`.

P16 code commit `1056a322` remains pushed. One shared versioned capability definition supplies
Discord's attachment bounds and 30-day retention; the verified no-store Agents route, Router
product-session allowlist and Shell setup UI consume it. Ordinary non-ephemeral attachments remain
unsupported, and extensions still receive no media handles. P16 remains PARTIAL for scoped media
handles and live acceptance.

P15 code commit `1f0a428e` is also pushed to `origin/Mcbt5s-Backup-2`. Space Blackboard discovery now uses an indexed, 90-ID
keyset page inside SpaceDO; project ACLs are reevaluated for every page, subspace-bound projects
remain excluded as before, and card summaries are read only after the bounded page returns. Local
evidence: focused Spaces pagination/migration **9/9**, AgentPort caller **10/10**, Spaces typecheck,
and a targeted real local Wrangler/D1/SpaceDO/ScriptToolSurface search **1/1**. The 100/1,000/10,000
card fixture found exact targets at first/middle/last positions; the 10,000-card traversal took
512–565 ms across those cases, with 4–8 ms page p95 and zero provider calls. Raw summary is in
`new plan/validation-results/2026-11-13/blackboard-indexed-pagination-local-wrangler.json`. These
are synthetic local measurements, not production performance or live relevance evidence. A full
18-test runtime attempt passed 13 and failed 5 unrelated Project Bot planner fixtures, all around
direct-write attempts being rejected at the delegation boundary. P15 remains PARTIAL for realistic
membership-distribution performance, independently labeled relevance/task quality and deployed
acceptance. Preserve the unrelated untracked `infra/scripts/__pycache__/`.

P04 remains PARTIAL: archives remain capped at 8 MiB plaintext, 10,000 rows per table, 5,000 object
references and captured object bytes of 2 MiB per object/4 MiB total. New archives include those
bounded bytes and restore missing objects with checksum verification and durable partial progress;
relational restore still merges missing rows, and no isolated restore/RPO/RTO drill or live store
verification exists. The newly integrated plan commit
`9e1281ce` is in branch history. Current P01/P02 preflights still fail closed on one shared D1, 11
shared KV namespaces, unresolved `naelao-calls` ownership and 62 missing read-only resource receipts;
the D1 release runner requires absent operator-attested migration baselines before any remote
mutation. P03/P12/P13, P20, P18/P21 and P22 status plus exact evidence/gaps are in the managed
progress matrix. P22's independent semantic-cache cleanup/status code gaps are closed locally; P22
remains partial for provider-index deletion and deployed/live evidence. The S2–S9/U01–U12 source/caller audit is reconciled there; PARTIAL rows remain
partial for their specific missing implementation, unsupported contract, product decision or live
evidence, and no row is accepted live. Managed-services requirements are reconciled, with the
unsupported U05/U06 runtime contracts and other gaps kept open. P20 now has a local operator list
API, but independent identity, operator UI, refund/dispute policy and author payout handling remain
open. P01/P02 protections fail closed on the recorded unconfigured IDs/receipts; no D1/KV ownership
or credentials will be guessed. P01 now has a source-validated post-worker health gate, but no live
probe or D1 migration has run. P02 resource IDs/ownership/receipts and P01 legacy baseline
attestations remain external evidence gates. P03 remains partial on unapproved grace/restriction
policy and live provider delivery. P23 remains partial on general channel exhaustion/replay auditing
and receipt coverage outside the Product auth outbox; see
`docs/operations/notification-delivery-contract.md`. P24 local code `415ba199` is pushed; its
remaining dependency, package-retention, live-running-work and deployed acceptance gaps are listed
in the two progress ledgers. The managed-services progress source already reconciles S2–S9/U01–U12;
in particular, U11 and U12 were audited and have no remaining ordinary caller/toolchain gap. Exact
next task: define a bounded, versioned declarative setup-field contract for a real template; validate
schema and submitted values on the host, persist approved values per installation, and render only
supported field types. Do not add arbitrary executable form logic or treat template fields as
permission to handle provider secrets. P01/P02 remain fail-closed on recorded external resource and
baseline evidence gates. P17 remains partial for the
Marketplace-to-Shell identity/install handoff, refund/license policy and live provider acceptance.
P01/P02
remain fail-closed on actual
resource separation, ownership/receipts, and operator-attested D1 baselines; these are evidence and
configuration gates. Keep all rollouts disabled. Fetch before every push and safely integrate remote
advances; never reset, clean, switch away, overwrite history, deploy or purchase.

Historical checkpoint (2026-11-12, code `4b5990b6`, superseded by the current checkpoint above): S2 is IMPLEMENTED_LOCAL for currently supported
provider lanes; account-specific provider enablement, approved commercial terms and unsupported
wallet/Coinbase product remain separate gates. U02's owner-cost trace found that settled OpenRouter
generation receipts were displayed but absent from the existing rolling threshold/alert evaluator.
They now feed its provider-observed USD budget directly from `decision_call_reservations`, without a
duplicate cost ledger. Focused Agents cost/dashboard tests pass **11/11**, Agents and Shell typechecks
pass, Shell tests pass **18/18**, and the release manifest validates **229** migration files. These
are local/mocked checks only. U03's current runtime caller audit found no additional code gap;
start/sleep/execute, allocation and execution journals, scheduled read-only allocation recovery,
owner-confirmed transition inspection, and prebuilt execution/artifact reconciliation are reachable.
Exact next task: continue S3 at U04 by auditing MIME and byte-preservation across the current
remaining readable/writable callers, implement any concrete local gap, then continue S3/U04–U12.
The U04 audit confirmed existing caller coverage; focused Agents/Artifact/Spaces MIME and file-response
tests pass **42/42** locally. U05's coordinator reaches the configured internal candidate verifier
when live single-writer mode is requested; operator observation/revocation routes are separately
reachable with the operator secret. Focused verifier/route/runtime-control/coordinator suites pass
**72/72**, Agents typecheck passes, and disposable smoke-worker isolation tests pass **3/3**. The
verifier is bound in default, staging and production config; live workspace rollout is false in all
three. No product caller creates a trusted runtime allocation/reservation or emits mount/sync/flush
observations, so U05 remains PARTIAL. U06's coordinator journal is implemented, but
`LIVE_RUNTIME_AGENT` has no configured binding and the pinned experimental Container/daemon contract
does not promise authenticated writer admission, drain/flush receipts, generation-fenced reconnect or
handoff receipts. That is an unsupported platform contract, not a credential blocker. U07's persisted
checkpoint scheduler passes **58/58** coordinator tests; no UI, SDK, template or provider-ingress
caller requests live checkpoints, and rollout/adapter gates keep that path unavailable. U08's pinned
source build, SBOM and signed provenance exist in CI, but it deliberately publishes no image and no
runtime adapter can be accepted against the unsupported contract. U09 now exposes the project-main
registry's last recorded state in the owner settings API; it explicitly does not claim provider
health. U10 now atomically marks the project-main registry erased alongside its runtime erasure
receipt, and only after the exact main DynamicSandbox confirms local state purge. Cleanup tests pass
**15/15**, the profile/status test passes **3/3**, and Agents typecheck passes. Exact next task:
continue U11 by tracing metering, cost alerts, notification delivery and missing provider feeds into
their owner/operator callers; close independent code gaps, then finish U12 and the S4–S9 audit.
Preserve `infra/scripts/__pycache__/`; keep all rollouts disabled.

The active mission supersedes the historical transcript-batch task. Finish
`docs/research/managed-services-and-sidecar-runtime-plan.md`, including inherited first-plan code
gaps U01–U12, then continue through `docs/research/platform-completion-and-guided-templates-plan.md`.
The platform plan was added by remote commit `9e1281ce` and fast-forwarded onto the active
implementation branch at the user's direction. Preserve completed managed-service work and reuse
its ledgers, operation journals, UI and provider adapters; reconcile each new finding against current
source before changing it. Continue autonomously through both missions.

Progress source of truth:
`docs/research/managed-services-and-sidecar-implementation-progress.md`.
Bootstrap and next-session prompt:
`docs/operations/managed-services-autonomous-session.md`.
Local verification commands and future gated acceptance matrix:
`docs/operations/managed-services-acceptance.md`.

Implementation is on branch `autonomous-managed-services-20261111` in
`/workspace/Naelao-1-managed-services`; preserve this original worktree and do not reset, clean,
replace or switch branches. The user selected `origin/Mcbt5s-Backup-2` as the recovery branch and
authorized coherent checkpoint commits/pushes there. Fetch before each push. If the remote is ahead
and its tip is an ancestor of the implementation branch, fast-forward safely before continuing. If
the active branch is an ancestor of a newly requested remote plan commit, fast-forward the active
branch to integrate it. If histories diverge, preserve both histories and resolve with a non-force
integration; never reset, rebase away work or force-push. Code checkpoints
`171a3471`, `064efff8`, `fcc26543`, `e9df3da4`, `504a488e`, `daca80bd`, `6046eebc`, `f6abe44b`, `80cf3893`, `e3afe6a2`, `965aeb41`, `70c4fd05`, `e8aa765c`, `144c02f5`, `3d6edc9c`, `46d61a70`, `b62bb9ed`, `01326eca`, `91d12419`, `87a9be02`, `3ba99c69`, `b508b1e1`, `115b3997`, `39aa0370`, `26a1e67e`, `3aa1bf43`, `21b7d2e2`, `79145e89`, `a7aa7ec8`, `eea1212a` and `804656cd`, plus docs checkpoints `8f9c0c15`,
`7e401225`, `1c32ef26`, `ece794ec`, `69fdb152`, `e2fadf8d`, `f5749bea`, `1c289a10` and `40b11134`, are pushed there. Code checkpoints `b8399b4c` and `894ec60f` add fail-closed environment resource evidence and durable marketplace refund review cases. The recovery branch also contains requested plan commit `9e1281ce`. AgentMail provision/renewal and Cloudflare model replay
preserve consumed quote terms in their covered recovery paths. Managed Telnyx now persists the
owner-confirmed line rate version and exact rental/SMS/call prices, binds reservations and cost
receipts to those terms, and retries release of unused call holds. Telnyx/Higgsfield AgentPort share
revocations now persist exact account references and retry on the scheduled path; exact checks and
next task are recorded in the progress source.
Historical checkpoint (2026-11-12, superseded by the latest continuation checkpoint above): **S0/S1 complete locally; S2/S3 and S4–S9/U01–U12 remained IN_PROGRESS.** Remote plan commit `9e1281ce` is integrated. P22's deletion/tombstone implementation is pushed as `3aa1bf43` and remains PARTIAL pending durable physical cache cleanup coverage and provider/deployed evidence. Fresh P22 local verification: Knowledge **75/75**, workflow erasure **18/18**, Agents knowledge/runtime **42/42**, migrations **8/8**, release manifest **5/5**, release runner **7/7**, affected Knowledge/Workflow/Agents/Shell/Dashboard typechecks, and 228-migration manifest validation. Latest S5 code `21b7d2e2` adds an owner-only, message-scoped Cloudflare assistant-email attachment download route and Shell/command-review caller. Fresh local evidence: communications route tests **10/10**, Shell **18/18**, Agents/Shell typechecks and `git diff --check`; project membership is the grant for shared project mailbox reads, while private verification fields are redacted and command control stays owner-only. S6 code `a7aa7ec8` adds owner/host-only session binding for existing inbound-created AgentPort threads through REST, SDK and MCP; `eea1212a` adds migration 0229 and carries owner-configured sender principal references through metadata-only message references. Latest S6 code `804656cd` adds owner/host-only trusted-sender revocation and explicit relinking, with historical message references retaining their original principal and new events becoming untrusted until relinked. Fresh local evidence: AgentPort API route/index tests **21/21**, SDK tests **15/15**, AgentPort API/SDK typechecks, release manifest validation and its 12 unit tests, and `git diff --check`; event delivery still filters session bindings to the matching consumer group. The sender link is owner-configured and revocable but has no independent provider identity challenge. These are mocked/local checks and do not establish deployed storage, email-provider delivery, or live acceptance. S4 caller audit confirms `snapshotContainer()` returns an opaque `{id,size}` handle and restore passes that ID; the current Container interface has no filesystem-byte export/import or provider snapshot deletion API. MS12b remains a named external contract gap, not a credential blocker. P01/P02 remain partial: operator-attested legacy baselines are absent; staging/production still share one D1 and eleven KV IDs, `naelao-calls` ownership is unresolved, and 62 resource receipts are missing. P20 refund review is journaled, while dispute ingestion, refund/author-clawback policy and operator resolution UX remain open. Builder reset email remains best-effort; browser bearer tokens remain in localStorage. U05 lacks a candidate/observation producer; U06 lacks supported writer-admission/drain/handoff contracts. Exact next task: finish S6's scoped audit by checking for any reachable first-party consumer gap after the trusted-sender and session-binding additions; keep shared-channel provider identity proof, default/list/switch/one-message assistant selection, and deterministic per-conversation routing open where no supported content/command caller exists. Then continue S7–S9/U01–U12: verify there is no ordinary payer-selection or funded-agent admission code gap before treating wallets/Coinbase as product/payment gates, and advance to the next guided platform requirement only after the managed-services code audit is closed. Preserve unenumerable legacy race-branch and pre-registry Browser populations and client-local storage limits. Preserve `infra/scripts/__pycache__/` untracked. Keep rollouts disabled; do not deploy or purchase.
The worktree contains Agent37 lifecycle, selected artifact transfer and revocation fencing; shared
managed-service records, parent-funded scoped AgentPort-agent reservations on the existing
organization quota, owner-authorized AgentMail link repair/revocation and capability-specific provider action receipts,
Telnyx order and managed-number release reconciliation, a durable Billing meter outbox, Higgsfield
customer-owned generation, project-main D1 allocation fencing/lost-ack recovery, private sidecar
artifact paths, hold-aware project erasure/retention controls, operator-imported cost receipts, capability
verification, MIME fallbacks across workspace/artifact/email plus Discord, Slack and Telegram attachments, artifact JSON, web-search downloads and text previews,
local SBOM/provenance and shared build staging. Browser project erasure
now has persistent project-scoped profile and session inventories, cancellable session cleanup and
exact screenshot-prefix deletion. Migration 0206 adds a project-main provider snapshot retention
inventory with hashed provider/object identifiers, retryable receipt persistence, erasure/reset
state and an explicitly unverified post-TTL status; the owner runtime profile reports its latest
receipt without claiming provider deletion. Migration 0211 adds owner-scoped source-separated
rolling 30-day provider-cost thresholds; migration 0217 persists threshold-crossing dashboard
alerts with owner acknowledgement; migration 0219 adds a retryable push outbox to the existing
Notifications worker for the threshold author's opted-in browser subscription. Access revocation is
checked before egress; email delivery and dispatch blocking are not claimed.
AgentPort signed-webhook and poll/claim
event paths carry the bounded thread session reference only to the matching consumer group. The
AgentPort SDK now includes a sequential poll/claim/handler/ack helper that expects durable consumer
acceptance; provider-content fetch and consumer session storage remain in the external adapter. S2
also has migration 0220 for durable fixed-price model quotes. An owner-only Shell caller previews the
exact active entitlement, confirms separately, and passes a one-use quote through the managed model
operation and Billing reservation; no active model price is currently configured. Migration 0221 adds
exact operation prices separate from maximum caps and request-hash-bound quotes. Managed AgentMail
provisioning now has an owner quote/confirmation flow; recurring renewal is shown before activation,
and each scheduled renewal is bound to a one-use quote and the active exact rate. Neither AgentMail nor
model pricing is active in this environment. The milestone also
includes provider-neutral UserPort connector discovery/sync, owner-selected Agent37 computer actions,
customer-owned Higgsfield generation actions and Telnyx BYO SMS grants through AgentPort. UserPort
revocation has a durable uncertain-outcome journal; held sync operations can be cleaned after
alias/owner unlink, with local access blocked until exact-account revocation completes. These
user-owned provider references use AgentPort's parentless `agent_native` model; actual registry
routes require an active parent for `user_parent`. AgentMail connection region is persisted as US/EU
and used for provider operations. Its owner usage route stores cumulative storage/message/thread
quantities only; it does not report money. Agent37 workspace usage, Telnyx finalized message GETs,
exact Twilio Message/Call GETs, and signed Telnyx `call.cost` events correlated to persisted call legs
produce API-observed costs, separate from invoices and Naelao credits. Telnyx call-cost events only
arrive when `call_cost_in_webhooks` is enabled in the provider Call Control Application; the owner
can inspect that setting, and this local implementation did not change it. Agent37 start/sleep operations with ambiguous provider outcomes now have an owner-only,
read-only inspect-and-reconcile route and Shell caller; the action is never replayed. Fresh local
evidence before the Telnyx call-cost caller: full Agents **1,421 passed / 7 skipped across 262 files**; after
the call-cost change: Telnyx webhook/lifecycle/phone/telephony suites **42/42** and Agents/Shell typechecks pass. Twilio
cost/phone action suite **30/30**; AgentMail/Telnyx cost suites **17/17**; Agent37 usage/connection
routes **21/21**; migration and usage snapshots **3/3**; Sandboxes **59/59**; AgentPort **28/28**;
AgentPort SDK **13/13**; MCP Hub **10/10**; Shell **18/18** after bounded AgentMail attachment-link
presentation; UserPort sync/reconciliation **15/15**;
execution ladder **22/22**; recovered project-main registry **28/28**. Agents, Sandboxes, MCP Hub,
AgentPort, AgentPort SDK and Shell typechecks pass. These are fixtures and mocks, not live provider
or deployment evidence. `git diff --check` passed after the progress edits.
The hold-aware
workspace coordinator/cleanup/client suites passed 76/76 after U01 changes. Prior local evidence
includes
Billing 80/80, Sandboxes 56/56, Agents,
Shell, Billing and AgentPort typechecks, and the connected Telnyx/phone/live-verifier suite 36/36.
Latest targeted browser/cleanup and AgentMail caller results are recorded in the progress source.
Migrations 0207 and 0214/0215 persist hash-only, idempotent provider cost/usage observations;
migration 0218 adds one hash-only Telnyx voice-cost receipt per admitted call leg, and migration
0219 adds the U11 browser-push delivery outbox. Twilio's
owner-triggered exact message/call reads use the same provider-cost observation table. The owner dashboard displays cost observations separately from
operator imports and customer credits. None is invoice reconciliation or makes AgentMail usage a
monetary cost. A local whole-command capability
ceiling rejects unsupported native/runtime command unions with structured errors. Composed JS
discovery is bounded to host tools and RPC reauthorizes every declared capability per call.
Native command manifests are deployment-pinned, actor-scoped and exposed through `runtime.find/list`;
a pipeline runs only when every stage maps to the same approved installation. Nested shell
substitutions remain fail closed before execution. The focused execution-ladder suite passes
22/22 and the latest full Agents suite is 1,437 passed / 7 skipped across 265 files; Spaces passes 388/388 across 89 files; Artifact Worker passes 26/26; Discord/Slack/Telegram attachment MIME suites pass 15/15; Sandboxes passes 59/59; SDK consumer tests pass 13/13;
AgentPort route tests pass 14/14 and its full package 28/28, MCP Hub gate/revocation passes 10/10, and the recovered
project-main registry passes 28/28. The Agent37 prebuilt now has matching-task capability routing.
The managed cost alert/outbox suite passes 7/7, including overlapping sweeps, consistent
Space/project scope, push retry, missing subscriptions and revoked-access suppression; migration
validation passes 13/13. Agent37 runtime transition routes pass 12/12. Continue S2–S9 and U01–U12. U05's trusted runtime observation producer, U06's writer-admission/drain/
handoff contract, encrypted private-state export/restart recipes, actual provider invoice
reconciliation, additional verified monetary cost sources, external-consumer durable session stores,
and wallet/funding decisions remain open. The full Agents suite and migration validator were rerun
after the latest Telnyx call-cost and U11 alert-delivery changes. Do not invent these contracts or provider support. Rollout
config remains disabled and `LIVE_RUNTIME_AGENT` unbound.
Resume verification on 2026-11-12 reran the complete AgentPort API package **28/28**, AgentPort SDK
**13/13**, Shell **18/18**, Discord/Slack/Telegram attachment MIME suites **15/15**, Artifact Worker
**26/26**, the Agents full suite **1,437 passed / 7 skipped across 265 files**, Spaces **388/388
across 89 files**, and the recovered DynamicSandbox project-main registry test **28/28**;
Agents/Spaces/Artifact/shared types/AgentPort API/SDK and Shell typechecks passed. The current
worktree audit found 120 tracked modifications plus 121 untracked paths, with no deletions. The
reflog records a reset to the same `02a0cf78` HEAD; it cannot establish whether earlier uncommitted
content was lost. The remote task branch was absent. The user selected `origin/Mcbt5s-Backup-2` as
the recovery destination. Catch-up commit `df8074a0119489f9077fa064a89d6d2f3bf956e5`, docs follow-up `02a2617e`, and
S2 quote checkpoint `0d40fb05` are pushed there as fast-forwards; the working branch remains
`autonomous-managed-services-20261111`. The current S2 quote slice passed managed-model tests 6/6,
Billing reservation tests 16/16, migration tests 8/8, Agents/Billing/Shell typechecks, and
`git diff --check`. Exact next task: extend durable quotes to managed AgentMail `provision` and
`renew`, adding an operator-approved exact credit price distinct from the existing maximum and
requiring the quote at Billing admission. Keep provisioning unavailable without an exact configured
rate; do not infer one from the current 300-credit reservation. Then continue remaining S2–S9 and
U01–U12 gaps. Record subsequent checkpoints and exact pushed SHAs in the progress source.
Keep every rollout flag disabled. Do not deploy or purchase services.

Latest continuation: AgentMail provision and scheduled renewal recovery reuse the consumed quote's
original credit amount after repricing and a newer active capability version, when the exact pinned
version remains verified, valid and authorized. Billing admission validates the pinned version for
that bound running operation. Cloudflare model completed/uncertain operations replay from their
persisted quote after repricing/capability updates; pending inference remains gated by active ceilings
and capability. Fresh AgentMail/model tests pass 22/22 across 2 files, Billing reservation tests
17/17, and Agents/Billing typechecks pass. Exact next task: review remaining exact-price provider
callers and quote/reservation consistency, then continue S2–S9 and U01–U12. Rollout remains disabled.

Migration 0209 adds exact fixed model prices and output-token caps; migration 0210 adds a draft
Cloudflare Workers AI capability and encrypted seven-day model results. The owner-authenticated
model caller reaches the existing AI binding and Billing reserve/settle path with a per-request
mandate and uncertain-outcome fencing. Managed-model caller tests pass 5/5; Billing passes 81/81;
the full Agents suite passes 1,386/7 skipped; AgentPort passes 27/27; Sandboxes 56/56; Shell
15/15; the recovered runtime registry 28/28; migration validator 1/1. Agents, Billing, AgentPort,
Sandboxes and Shell typechecks pass. Shell Project Computers now exposes owner-scoped Agent37
credential connect, control-plane verify and confirmed revoke/cleanup through existing Sandboxes
routes. These are local mock/fixture checks. No model entitlement is active: current Cloudflare
docs returned HTTP 403, so terms, geography and price remain unverified; rollout stays disabled.
Continue from provider-neutral UserPort discovery/sync and AgentPort registration/grant/revocation
adapters beyond AgentMail and Telnyx, then proceed through remaining S3–S9/U01–U12 code gaps.
See the durable progress record.

Latest local checkpoint (2026-11-12): S6 source-to-caller review found no supported generic first-party shared-channel router or consumer contract beyond AgentMail's account-scoped subscription; identity proof, generic selection commands and consumer-owned per-conversation ordering remain explicit partial requirements. S7's payer audit confirmed every supported reservation uses the existing organization quota and mandate; wallet/funding/Coinbase are payment/product gates rather than missing ordinary code. Fixed a reachable S8 AgentMail caller in Shell's assistant side panel: it now fetches and displays an exact expiring quote, shows renewal/cap/quota terms and submits the quote ID only after owner confirmation. Removed stale $3/300-credit claims from the side panel, template settings and Space creation review; choosing managed email does not provision or charge during installation. Fresh local evidence: Shell tests **18/18**, Shell typecheck, AgentMail route/lifecycle suite **16/16**, `git diff --check`; all mocks/local. Exact next task: audit U01 backup/retention/legal-hold callers against current enumerated data inventories and implement the next independent reachable cleanup or recovery gap. Preserve `infra/scripts/__pycache__/`; keep rollouts disabled and do not deploy or purchase.

Latest continuation (2026-11-12): U01 code `afc0c4fe` is pushed to `origin/Mcbt5s-Backup-2`. It adds owner/admin-only project settings for staging retention and audited legal holds; policy reads/writes are restricted because reasons and actor metadata are private. The UI discloses that opaque Container snapshots and third-party backups are outside this hold, and no physical purge/extension is claimed. Local evidence: Agents route/coordinator checks **5/5**, Shell **18/18**, Agents/Shell typechecks, `git diff --check`. U01 remains partial for backup/export and provider retention/legal policy. Exact next task: trace U02 provider API usage/cost producers into owner dashboards/thresholds, implement any reachable source/presentation gap, then identify unsupported invoice/billed-idle/CPU-size feeds. Preserve `infra/scripts/__pycache__/`; keep rollouts disabled and do not deploy or purchase.

## Environment and branch bootstrap

- Discover the actual repository; do not assume `/workspace/Naelao-1`, installed dependencies,
  tools, credentials or running services exist in a new session. Read nested AGENTS.md files
  before modifying their paths.
- Inspect `git remote -v`, `git branch --show-current`, and `git status --short --branch`.
  Fetch `origin/Mcbt5s-Backup-2` before integrating or pushing. Preserve this active implementation
  worktree and branch. If the remote tip is an ancestor of local HEAD, push normally; if local HEAD
  is an ancestor, fast-forward the local branch before continuing; if histories diverge, preserve
  both sides and create a non-force merge integration after reviewing conflicts. Never reset, clean,
  rebase away work, overwrite the remote, or force-push.
- Read root packageManager and engines. At this baseline use Node >=22.5.0 and pnpm 9.12.0.
  Install with the pinned manager and frozen lockfile; build workspace dependencies before
  dependent checks. Diagnose stale packages separately from code errors. Do not weaken checks
  or delete user dependency trees to manufacture a pass.
- Implementation authorization covers local, reversible code work and relevant tests. Paid
  purchases, production deployment, destructive remote migrations, rollout enablement and
  messages to external people require separate authorization. Do not print credentials.
- For this autonomous implementation mission, commit and push every coherent verified checkpoint
  to the user-selected recovery branch `origin/Mcbt5s-Backup-2`; this workflow is authorized, so do
  not ask again. Keep the local branch `autonomous-managed-services-20261111` active. Review and test
  the intended changes, then push with the explicit fast-forward refspec
  `HEAD:refs/heads/Mcbt5s-Backup-2`, never force. Fetch before every push, confirm the remote tip
  is an ancestor of local HEAD, and safely integrate any new remote commits before pushing. Use a
  fast-forward when possible or a merge commit when histories diverged; preserve all work on both
  sides and resolve conflicts without resetting, cleaning, rebasing away or overwriting history.

## Fixed decisions

- Cloudflare DynamicSandboxDO is the main runtime candidate. One logical main computer per
  project spans runs/branches; enforce one authorized main allocation and fenced replacement.
- Only the main computer automatically participates in default workspace execution and sync.
  Specialist sidecars are explicit tools with independent filesystems and authorized artifact
  transfers. Preserve tunnel consent. A shell invocation stays on its selected runtime.
- WorkspaceCoordinatorDO checked publication alone advances canonical project state. Upstream
  sync and restored disks target staging. Default to `checked_handoff`; never silently downgrade
  requested `live_single_writer` or enable it without actual runtime capability evidence.
- Keep AgentPort independently usable and preserve explicit identity, parent/agent ownership,
  grants, entitlements, payer mandates, existing ledgers, billing admission and jurisdiction.
- Preserve guest isolation, expected hashes, generation/fences, template/extension boundaries.
  Record operations before external dispatch and reconcile unknown outcomes without blind replay.
- Keep rollout flags disabled until acceptance. Do not invent provider APIs, prices, capabilities,
  commercial approval, credentials, passing tests or image digests. Use current primary sources.
- Preserve approved retention. Build configurable policy/hold controls without enabling destructive
  defaults pending missing product/legal decisions. Unsupported provider purge remains explicitly
  retained/expiry/manual status, never fabricated deletion success.

## Autonomous continuation and verification

- After compaction, interruption or a new session, read both active plans, both progress records
  and this runbook, inspect the actual worktree/branch/dirty files, and resume the exact next action.
  Reconcile earlier status with current source and
  newer evidence. Preserve original transcripts. Historical guidance is archived at
  `docs/operations/agents-historical-runbook.md`; its older mission and commit policy are superseded.
- Give each requirement an ID and track `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED_LOCAL`,
  `BLOCKED_EXTERNAL` or `ACCEPTED_LIVE`. Local implementation requires actual caller wiring and
  meaningful evidence, not only interfaces, mocks, unavailable responses or scaffolds.
- A blocker must identify the precise dependency, completed independent implementation and the
  exact remaining journey/command. Do not label ordinary unwritten code as credential-blocked.
  Continue independent work when one provider is blocked; resolve routine choices autonomously.
- After each meaningful milestone update the progress matrix, command results, dirty files,
  unresolved issues, and exact next action; update relevant first-plan records and this checkpoint.
- Run meaningful tests for authorization, state, concurrency, recovery, idempotency, billing and
  integration, plus affected typechecks/config/migration checks. Fix relevant failures and clearly
  identify unrelated failures. Distinguish mocks, local workerd, real Container and live evidence.
- Before concluding, audit all requirements and reachable callers, close implementation and
  contract gaps, and report code completeness separately from deployment acceptance. If an actual
  external contract or product decision prevents code, record the specific limit honestly and
  complete everything independent. Never claim completion to hide remaining code.

Repository instructions persist after Git sync; machine setup, credentials and execution do not.
These checkpoints support resumption and do not guarantee uninterrupted autonomous execution.
