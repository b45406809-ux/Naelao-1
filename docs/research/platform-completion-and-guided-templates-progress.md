# Platform completion and guided templates progress


## Active continuation — 2026-11-14 (template coordination defaults completed locally)

Code `a3791d51fc92b2d353d6e7b0b3bbd694f84e1f6b` is pushed to
`origin/Mcbt5s-Backup-2`. The signed optional `SpaceBlueprint.coordinationDefaults` now has Foundry
authoring/draft persistence, SDK validation, export persistence and activation preview. Owners/admins
review the current revision and must explicitly confirm; activation writes through the existing policy
API only at revision zero, preserving existing policy and facts. Local checks: Agent SDK **7/7**,
Spaces authoring/activation **32/32**, Spaces and Shell typechecks, and `git diff --check`. These are
local mocks/static checks; no browser, deployed Worker or live multi-user acceptance ran. Preserve
untracked `infra/scripts/__pycache__/`.

The platform plan §10.3 template-default slice is IMPLEMENTED_LOCAL; broader §10 coordination and P05
remain PARTIAL. P01/P02 release/environment gates, P03/P20 product decisions, and P06 streaming,
managed billing and live provider acceptance remain open as indexed below. Rollouts remain disabled.

Exact next action: continue the managed-services S5/MS08d Modal lifecycle/authentication/hosting/
region/cancellation/cost contract audit against official documentation. Implement only a reachable
adapter supported by a stable documented interface and host; record the precise gate otherwise, then
proceed through independent release/environment safety and other uncoded P01–P24 and S3–S9/U01–U12
requirements. Keep rollouts disabled.


## Previous continuation — 2026-11-14 (template coordination defaults; Modal/P06 reconciliation)

The current pushed source baseline is `57eea1aa37dbcc9db5c802544e01d7fdf945b38e` on
`autonomous-managed-services-20261111` / `origin/Mcbt5s-Backup-2`; preserve untracked
`infra/scripts/__pycache__/`.

Source reconciliation against both plans found no coordination posture field in signed
`SpaceBlueprint`, activation preview or owner activation. Space Settings already has a revisioned,
default-off member-publication policy, so templates cannot currently express the requested default.
This is an uncoded reachable contract, not an external blocker. Implement an optional signed template
default and expose it in owner activation review. Applying it must require explicit owner confirmation
and must not overwrite any Space whose policy already has a revision; use the existing policy API and
preserve current facts.

The same review confirmed Twilio phone extensions accept completed `call.speech` turns and the Shell
simulator exposes synthetic speech; Telnyx phone extensions stay DTMF-only and reject streaming. The
MeloTTS `VoiceSession` implementation is not constructed by a production caller; live OwnerVoiceAgent
uses OpenRouter, and audio attachment transcription uses Workers AI Whisper. Modal's official JS SDK
is Beta, Node 22+ and gRPC-based with a documented private/changeable gRPC API. No compatible Node
host or reachable Modal caller exists in the Agents Worker, and the current mock's `actualCredits`
does not match a documented provider usage receipt. These are host/API/usage-contract gates, not
credential blockers. Local checks: phone suites **41/41**, Agents and Shell typechecks; no browser,
deployed or live provider acceptance ran.

Exact next action: implement and test the signed Space Template coordination default through Foundry
authoring, activation preview, explicit owner confirmation, and revision-zero policy persistence.
Then continue uncoded P05/P06 and S3–S9/U01–U12 requirements. Keep rollouts disabled.


## Active continuation — 2026-11-14 (P24 installed publisher revocation notice)

Code `f3a04010077064cd569ed20933f4b4bbac957db9` threads persisted release revocation state through
the installed-package views. The member-facing Space-shared list rechecks the current publisher
registry, returns no-store, omits key IDs, and shows affected package/version and revocation time;
owner-only project installation lists carry the same trust result. The Shell disables open/resume for
untrusted packages while preserving removal. Follow-up `ad3888eb999793fd16d9f1725ea91cedeb4073e8`
closes an already-open shared app after refresh detects lost trust. Runtime and mutation paths still
recheck trust server-side. Local evidence: SpaceDO and signed package suites **48/48**, Spaces and
Shell typechecks, `git diff --check`, and a repeat Shell typecheck/diff check after the follow-up.
These are local mocks/static checks; no browser, deployed Worker, notification delivery or live
acceptance ran. Both code SHAs are pushed; preserve `infra/scripts/__pycache__/`.

P24's installed-package warning is IMPLEMENTED_LOCAL. P24 remains PARTIAL for proactive alert policy,
cross-tenant artifact rights, broader schema/data migration and rollback, scanning, retention and
deployed/live acceptance. P05 provider references remain blocked at a genuine project-vs-Space
installation scope contract, not at credentials. P06 conversational voice/customer lifecycle/managed
billing and live provider acceptance remain partial as recorded in the requirement index.

Exact next action: continue managed-services S5/MS08d against current official Modal lifecycle,
authentication, hosting, region, cancellation and cost contracts. Implement a reachable adapter only
if a stable documented interface and compatible host exist; otherwise record that exact contract and
hosting gate, then proceed to the next independent S3–S9/U01–U12 or P05/P06 implementation gap.
Keep rollouts disabled.

## Previous checkpoint — 2026-11-14 (shared-Space requests; P05 scope trace)

Code commit `e46ea4f44c64bd41bbc1a87a81867a4ea1394f83` is pushed to
`origin/Mcbt5s-Backup-2`. The owner Settings panel now shows a bounded Space coordination request
queue. Members can request contact about an active member-visible fact after confirming their account
identifier will be shared with owners/admins. Requests are deduplicated while pending, visible only to
their requester or Space owners/admins, and review uses an expected revision. Review can mark
`contacted` or `unavailable`; it never grants underlying project/service access. Local evidence: Agent
SDK coordination **4/4**, Spaces coordination/route/migration **30/30**, Agent SDK/Spaces/Shell
typechecks, SDK build and `git diff --check`. These are local/mock checks; no browser or deployed
multi-user acceptance ran. `infra/scripts/__pycache__/` remains preserved.
This fact-level contact request complements the existing published-project Blackboard request-to-use
workflow; it does not replace that flow, grant membership/access, or deliver a notification.

P05's current provider handoff remains uncoded at a scope-contract boundary. The source trace found
that UserPort aliases represent MCP tool/action capabilities through AgentPort; signed channel
requirements instead bind provider references to active project installations. Space Template
dependencies install Space-wide, so the existing reference types cannot be reused safely. Required
connections correctly block activation; optional connections remain explicitly unsupported. This is
not a credential blocker. P05 remains PARTIAL for supported provider setup, package lifecycle, verified
total cost, standalone knowledge/action semantics, unsupported media and deployed/live acceptance.
P06 remains PARTIAL for conversational streaming, customer lifecycle, managed billing/invoices and
live region/provider acceptance. S2 is locally implemented for supported lanes; S3–S9/U01–U12 retain
the managed-services ledger's exact code, contract, product-decision and live gates.

Exact next action: trace P24 publisher-revocation receipts through current installed-package owner
views and implement an owner-visible, durable compromise/revocation notice if the existing caller path
lacks one. Recheck publisher trust at display and action time; then continue the next independent P05,
P06 and S3–S9/U01–U12 implementation gaps. Keep every rollout disabled.

## Previous checkpoint — 2026-11-14 (shared-Space assistant context)

Code commits `d973388858a854f740de959e578120530a3c598c` and
`96c3da48f103c3515afe5e0ddbc8c44e6d47a166` are pushed to `origin/Mcbt5s-Backup-2`. Current
audience-filtered coordination facts are refreshed before each assistant planning decision and
passed as advisory/untrusted context with confirmation/expiry metadata and an accurate continuation
hint. Agents planner/prebuilt/baseline suites pass **35/35** and Agents `tsc --noEmit` passes; prior
Spaces route/registry tests pass **19/19**. This is local/mock evidence only. No deployed, browser,
provider or live multi-user acceptance ran. `infra/scripts/__pycache__/` remains preserved.

P05 remains PARTIAL for provider connection handoff, broader install lifecycle, verified total cost,
standalone knowledge/action authoring semantics, unsupported media and live acceptance. The existing
signed dependency preview exposes package-level permissions/actions/knowledge; it does not itself
grant runtime authority. P06 remains PARTIAL for conversational streaming, customer voice lifecycle,
managed billing/invoices and live region/provider acceptance. S2 is IMPLEMENTED_LOCAL for supported
lanes; S3–S9/U01–U12 retain the row-specific gaps in the managed-services ledger. U05 has a verifier
and coordinator caller but lacks candidate/reservation and trusted observation producers; U06's
pinned runtime write-admission/drain/flush/reconnect/handoff contract is absent. U09 registry and
generation-fencing source work is complete locally and will not be repeated without new evidence.

That recorded action is complete as a source trace; the latest checkpoint above records why current
UserPort MCP references cannot safely satisfy signed channel-provider requirements.

## Previous checkpoint — 2026-11-14 (joint mission; coordination policy pushed)

Space coordination disclosure policy commit `4c458a9e695ea6bbdcd04c083dea0ea758a51a2f` is pushed
to `origin/Mcbt5s-Backup-2`. The v2 owner/admin policy defaults off for new member-visible facts,
uses expected-revision writes, atomically gates publication/amendment, requires individual unpublish
before disabling while visible facts remain, and exposes metadata-only revision history in Settings.
Existing approvals are preserved. Verification: Agent SDK coordination **4/4**, SpaceDO/route/migration
**26/26**, SDK/Spaces/Shell typechecks, SDK build and `git diff --check`. These are local/mocked; no
browser, deployed Space/Worker, provider or live acceptance ran.

P05 remains PARTIAL for the knowledge/action SpaceBlueprint/runtime contract, complete provider setup
and lifecycle, verified rates/total cost, unsupported media access and end-to-end acceptance. P06's
bounded phone-menu dashboard already has signed per-install settings, local preview, synthetic
start/keypad handler tests, owner-scoped line/readiness and cost observations; conversational voice,
customer lifecycle, managed billing/invoices and live region/provider acceptance remain uncoded or
unverified. S2 is IMPLEMENTED_LOCAL for supported lanes; S3–S9/U01–U12 retain the specific gaps in the
managed-services ledger. Rollouts remain disabled; preserve `infra/scripts/__pycache__/`.

The earlier next action to trace P05's knowledge/action authoring gap is complete. Package-level
actions and knowledge already flow through signed dependencies and owner review; the standalone
SpaceBlueprint contract remains uncoded pending host-enforced semantics. Resume from the active
connection-reference implementation above.


## Previous checkpoint — 2026-11-14 (P05 Foundry authoring draft recovery; completed)

Code `56b23a31354519845834d4fb6b6bcf390e280cee` is pushed. Foundry now persists/restores a bounded
versioned authoring draft in its existing Space-scoped extension Gadget; this includes selected same-
Space projects, setup declarations, assistant-channel preferences, dependency IDs and conformance
inputs. Local customer-preview values are cleared. On resume, dependencies are refreshed through
the owner-only trusted candidate API and unavailable/revoked saved IDs cannot pass export. Catalog
manifest `1.2.0` adds migration 2 and the Foundry Space template has the updated exact digest.
Verification: Agent SDK **5/5**, Spaces extension runtime/install **27/27**, SDK/Spaces typechecks,
embedded script syntax and `git diff --check`. Local/mock only; no browser, deployed Space/provider,
or live acceptance ran. No credentials blocked this code.

P05 remains PARTIAL: visual setup/channel authoring and package selection exist, but knowledge/action
authoring has no matching SpaceBlueprint/runtime contract; provider setup, broad package lifecycle,
verified cost inputs/rates and end-to-end acceptance remain. Package feature summaries represent the
entire installed package and do not grant per-action authority. P06 remains PARTIAL for conversational
voice lifecycle/streaming, managed billing/invoice reconciliation and provider/region acceptance.
Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

That next action is complete in `236a2e2b`; resume from the active checkpoint above.


## Previous checkpoint — 2026-11-14 (P05 multi-project guided setup; completed)

Code `bf55151a` is pushed to `origin/Mcbt5s-Backup-2`. Foundry Studio can select up to 64
same-Space projects and author independent bounded setup groups and local previews per project.
SpaceDO exports only the exact selected non-archived projects; the owner export route validates each
setup group against those project IDs using the existing Agent SDK schema, including real UUID project
IDs. Conformance still applies to every selected project. Local evidence: Spaces tests **35/35**, SDK
tests **13/13**, Spaces/SDK typechecks, embedded Foundry JavaScript syntax check, and
`git diff --check`. These are local/mocked checks; no browser, deployment, provider or live acceptance
ran. P05 remains PARTIAL for dependency/action authoring, broader package lifecycle and pricing; P06
remains PARTIAL for streaming, complete provider billing/invoices and live/region acceptance. No live
credentials blocked this implementation. Rollouts remain disabled; preserve
`infra/scripts/__pycache__/`.

The next action recorded here was completed in `ed924c83`; feature inventory was added in `55d67648`.
Resume from the active checkpoint above.


## Previous checkpoint — 2026-11-14 (P06 phone routing and dashboard handoff; completed)

The code checkpoints `1aff67de`, `f1a82b42`, `17683e29` and `4b8749b56db7f04208a1ca6531fc45c9a81b8af7`
are pushed to `origin/Mcbt5s-Backup-2`. P05 now authors and previews validated channel defaults,
connects the signed extension review to the target Space's extension dashboard, persists defaults at
activation, and opens Assistant settings afterward. P06 adds owner-visible keypad-routing readiness
only when an active phone line and assignment match the current trusted candidate's exact installation
ID and handler digest. Latest local evidence: Shell **36/36**, Shell typecheck and `git diff --check`.
This is local-only; no browser, deployed Space/Worker, provider, carrier or live call was exercised.
P05/P06 remain PARTIAL for broader channel/action and provider journeys, lifecycle, conversational
streaming, managed billing/invoice reconciliation, verified rates and live acceptance. Keep rollouts
disabled and preserve `infra/scripts/__pycache__/`.

The phone-to-extension-dashboard handoff was completed and pushed as `15e86a66`; see the latest
checkpoint above for the active action.


## Previous checkpoint — 2026-11-14 (guided template activation channel persistence; superseded)

P05 channel availability authoring/export is pushed as `e96cc0a1a983d64dd4e0a75e9326b67fa3669c4e`.
Foundry Studio emits validated channel availability and phone-prompt preferences. The owner export
route uses the existing Agent SDK schema and rejects malformed or provisioning directives before it
stores an artifact. Local evidence: Spaces authoring/export **6/6**, Agent SDK dogfood **3/3**, Spaces
and Agent SDK typechecks, embedded JavaScript syntax and `git diff --check`. No browser/provider,
deployed or live acceptance ran. P05 remains PARTIAL for provider connections, action authoring,
install/update/uninstall lifecycle, full cost/rate authoring and live acceptance. Activation
persistence is covered by `6693d380914d248ac7885a90a10ddfc055d665ba`: the target DO writes
`channels:template`, the owner channel-preferences endpoint resolves those values, and email stays
`none` / `provisionOnCreate:false`. Spaces activation tests pass **3/3** and Spaces typecheck passes;
no provider or deployment ran. Activation preview/review code `1aff67dee97b5d835c8e4cb55c58c44a0721b16f`
returns only channel availability and phone-prompt defaults and explicitly separates account
connections/provisioning. Spaces preview tests pass **21/21** and Spaces/Shell typechecks pass; no
browser or deployed acceptance ran. The earlier statement that no signed multi-project contract or
caller existed was incorrect. Source reconciliation found `SpaceBlueprint.projects[].setupFields` in
the SDK and per-project groups in activation preview. Visual authoring/export was therefore a
reachable implementation gap and is now closed locally in `bf55151a`; resume from the active
checkpoint above. Rollouts remain disabled.


## Active checkpoint — 2026-11-14 (U12 verification resumed after P21)

U12 fix `6ee3a16577fba9c14304aae4d4b24cb43050c254` and P10/P24 rollback `0d121ab2` are pushed to
`origin/Mcbt5s-Backup-2`. The narrow rollback path lets an owner/admin load up to 50 trusted releases, choose an exact
historical version, reviews the same publisher signature and package constraints, pauses/drains, and
applies with a durable receipt. Focused Spaces suites pass **46/46**, full build **55/55 tasks**, full
typecheck **82/82 tasks**, and `git diff --check`. Tests verify 1.2.0→1.0.0 and that the install stays
paused; stale pins, missing exact targets and revoked publisher keys fail closed. This is local
Worker/SQLite evidence only; no deployment or live acceptance ran. Broader migrations, authority and
configuration changes, compromise response, scanning, retention and live acceptance remain open.

P13 unknown/misrouted and malformed queue messages now retry to configured DLQs in Workflows, Billing, Notifications, Analytics, Provisioner and Agents (`4de53055`, `d640dbae`, pushed). Focused local suites and six affected Worker typechecks pass. DLQs are worker/environment-specific; Admin's consumer targets a separate queue and stores/logs raw payloads, so generic replay remains uncoded pending a safe retention/idempotency contract. P23 Notifications has a durable non-PII terminal status view. True backlog/age/DLQ remains unknown without supported provider evidence.

P14 code `31aac278b7962fd28bbe592abf1783a816bbd07e` is pushed. Portal and Shell Product-user clients await server generation revocation; Portal and Dashboard builder clients await `/v1/auth/revoke`; Shell also awaits the HttpOnly DeskDrop cookie endpoint. Failed revocation leaves credentials available for retry and the UI shows the error; already-revoked builder tokens (401) clear locally. Evidence: Shell **3/3**, Portal **3/3**, Spaces logout route **17/17**, Shell/Portal/Dashboard typechecks and `git diff --check`. P14 remains PARTIAL for localStorage bearer storage, cross-origin/embedded cookie and CSRF/XSS transport decisions, and deployed copied-token acceptance.

P21 builder reset-email dispatch is implemented and pushed as `814c429af84f0b5089286cf4fbd13727b252ba75`. Auth migration 0245 stores encrypted recipient/token data, atomically couples token issuance to outbox enqueue, dispatches through bounded leases/backoff with stable Notification IDs, cancels superseded tokens, persists provider acceptance receipts, and exposes tenant-HMAC-scoped metadata status. The neutral public reset response remains. Local evidence: Auth **39/39**, Auth typecheck, release/deployment manifest checks, release migration tests **15/15**, staging/production Wrangler dry runs and `git diff --check`; migration inventory is now 245. No deployment or real inbox delivery was tested. P21 remains PARTIAL for deployed/provider acceptance and unverified-user/session policy. P11 purchase snapshots `16386d95679c5c739d07b3fbcc1061f98244b3ae`, P07 local-model profiles `0da0abdbd80a9ea5dfa2ff5729be6c4cd53aaea1`, and P01 durable migration-phase validation `60c5f03b30aac5241a379b0c59bbf343ed0186b1` remain pushed. P02 stays fail-closed on 13 shared resources, unresolved `naelao-calls`, 158 missing receipts and missing account/time evidence. P03/P12 access/recovery cadence and P20 refund/author accounting require product decisions; preserve the current policy. Rollouts stay disabled; no deployed or live acceptance is claimed.

U03 Agent37 lifecycle recovery and U11 supported metering, cost, threshold/alert and owner controls are already source-to-caller audited; no independent U11 caller gap was found. U12 verification fixed an actual Lemon Squeezy test mock typing error. Frozen Corepack pnpm 9.12.0 install, Billing **52/52**, full build **55/55 tasks** and full typecheck **82/82 tasks** pass. Turbo child processes needed a temporary PATH wrapper because the global fallback is pnpm 11; the repository remains pinned to pnpm 9. Build included local image builds and Wrangler dry runs only. No CI event, deployment, provider account, or live acceptance ran. U12 is locally implemented for build wiring and remains partial for future CI execution and deployed-image parity. The managed-services matrix remains authoritative for S4–S9/U01–U12; U05/U06 runtime contracts remain unsupported rather than credential-blocked. Rollouts stay disabled.

P06 voice operations metadata is pushed as `4c42012b`. The trusted Space runtime returns the installed
signed package/version and publisher/key identity; the owner-only phone dashboard verifies the active
key is registered to that publisher, then shows the version, publisher and key fingerprint. Local
evidence: Spaces route/runtime **45/45**, Spaces and Agent SDK typechecks, inline dashboard JavaScript
syntax and `git diff --check`. No provider, carrier, deployed Worker or live call was exercised. P06
remains PARTIAL for the full customer voice-agent lifecycle, streaming, managed billing, invoices and
live/region acceptance.

P05 visual customer-form preview is pushed as `50dd1fa4`. Foundry Studio renders the existing
bounded v1/v2 data-only schema, including supported inputs, defaults, required state, localized text,
choices and earlier-field conditions. Test values remain local; DOM text/value APIs prevent authored
text from becoming markup, and host validation is unchanged. Local evidence: Agent SDK dogfood and
blueprint setup suites **13/13**, SDK typecheck and generated script syntax. No browser or deployed
Template acceptance was run. P05 remains PARTIAL for channel/action authoring, broader package
lifecycle, complete cost/rate disclosure and live acceptance.

The earlier assistant-channel authoring action is complete in pushed commit `e96cc0a1`; the exact
current continuation is recorded above.

## Previous checkpoint details

Earlier continuation (2026-11-13): code `536853b9` connects signed same-tenant dependency import to
guided Template activation; `b646ec16` rechecks publisher revocation between package review and copy;
`edf08814` resumes install review after reload using the destination's persisted signed release. All
three commits are pushed to `origin/Mcbt5s-Backup-2` after fetch and ancestry checks. The setup UI
requires explicit active source Space selection, verifies the exact required version and optional
manifest digest, shows the signed closure, imports immutable package bytes with retry, reviews
destination permissions/capabilities and explicitly installs with no shared-folder grants. It
refreshes activation readiness and reconciles an ambiguous installation response from the target's
active exact pin. Cross-tenant seller artifacts remain behind listing entitlement checks.

Local evidence: signed Space package/import tests **17/17**, Spaces/Shell typechecks and
`git diff --check`. Tests cover both Space admin boundaries, digest mismatch, revocation after review,
partial closure retry and repeat after successful import (ambiguous-response recovery). The destination
install-review route verifies the persisted release and exact pin after reload. Evidence is local
Worker/R2 mocks and typechecks; no browser, deployed DB/DO, Marketplace or live provider acceptance
ran. P24 activation import/reload resume is IMPLEMENTED_LOCAL; P24 remains PARTIAL for cross-tenant
rights, broad schema/data migration and rollback, compromise notice, scanning, retention and live
acceptance. P05 remains PARTIAL for supported customer/provider journeys, general update/uninstall
effects, verified rates and live acceptance. The §9.5 voice caller audit found the deprecated MeloTTS
constant only in an unused `VoiceSession` path; production callers use Whisper for transcription and
OpenRouter for owner calls, so no model change is warranted. §10 expiry code `f0d38035` is pushed to
`origin/Mcbt5s-Backup-2`: migration 128 stores an optional owner-selected expiry on v2 coordination
facts; the host rejects past expiry selections, audience reads omit expired facts, and owner/admin v2
reads expose expired and revoked lifecycle state. The owner Settings caller previews, sets, edits and
renews expiry and shows revocation state. No default expiry or singleton behavior was added.
Verification: SDK coordination **4/4**, Spaces coordination/route/migration **17/17**, SDK/Spaces/Shell
typechecks, and `git diff --check`. These are local SDK, SQLite and Worker checks; no deployed
multi-user or live acceptance ran. §10 remains PARTIAL for configurable posture, private-project
publication/request authority, extension ownership/dependencies, reservations, concurrency, durable
audit history and broad non-disclosure acceptance. Code `e8f77f7f` exposes persisted creator,
approver, approval role, provenance and revocation actor only to owner/admin v2 reads and the Settings
lifecycle view; member responses omit these fields. This earlier next action is complete in `d208ec02`; resume from the active checkpoint above.

Prior checkpoint (2026-11-13; keypad simulator path verified; next action superseded): the prior local keypad simulator gap was already implemented in
`AssistantPhonePanel`, the exact-installation Space phone-simulate route and the Agents host simulator.
It accepts synthetic `call.received` and normalized `call.digits`, validates and renders bounded
response actions, and performs no carrier request or saved-session write. Fresh local evidence:
Agents suites **46/46**, Space route suite **18/18**, Agents/Spaces/Shell typechecks. No carrier,
deployment or live test ran. The next action recorded then was P17 source/caller reconciliation; its
result is recorded below. Resume from the active P24 blueprint-import action above.

Updated 2026-11-13 after P05 visual setup authoring code `b3feecb5` was fetched and pushed to
`origin/Mcbt5s-Backup-2`. Foundry Template Studio now authors optional v1/v2 declarative setup
fields, defaults, required state, bounds, English/Spanish labels/help and simple visibility conditions.
The owner-only export route scopes fields to the selected exported project, uses the SDK validator
before storage, revalidates after sanitization, and retains the declarations in the conformance
artifact. Local evidence: Spaces helper/route tests **4/4**, SDK Canvas tests **3/3**, Spaces and SDK
typechecks, and `git diff --check`. No deployed or live acceptance ran; rollouts stay disabled.

Updated 2026-11-13 after code `c7412170` was pushed to `origin/Mcbt5s-Backup-2` following fetch. It follows P04 full-archive export `6fccacaa`, runtime-work admission/drain `15a04f7e`, and the original static Canvas receipt path `9d5a0c23`.

P10/P24 now support an owner-reviewed version-only signed release update for same-publisher Space-shared packages whose only primitives are static Canvas and channel handlers. The normalized signed manifest must be identical except release and primitive versions; settings, dependencies, permissions, capabilities, connections, storage and package configuration cannot change. The update API reads the exact installation's active runtime-work count and withholds its short-lived apply token until the installation is paused and drained. SpaceDO repeats signature, pin, pause and lease checks in the update transaction, writes the version and a durable replayable receipt, and leaves the installation paused. The Shell caller explains the supported scope and active-work count. Gadget/schema/data migrations and broader update classes remain gated.

Local evidence for `c7412170`: Spaces update-review/SpaceDO/contract suites **45/45**, Spaces and Shell typechecks, and `git diff --check`. Earlier `15a04f7e` suites cover runtime admission/drain **61/61** plus Agents phone scope **7/7**; P04 `6fccacaa` has Shell **6/6** and archive suite **11/11**. All evidence is local Worker mocks/SQLite/static checks; no deployed DO, live Marketplace/provider, call or recovery drill ran. P10/P24 remain PARTIAL for migration preview/recovery, general rollback/version selection, authority/dependency/connection/price changes, compromised-key response, scanning, retention and live acceptance. Lease expiry is 30 minutes for crash cleanup; provider timing is not measured. Keep rollouts disabled.

P06 migration `0239` pins each new Telnyx extension call to the exact active installation and handler hash with an insert-time assignment recheck; old calls remain unpinned. Owner status omits provider call IDs and Shell groups bounded provider-reported observations by pin. Release metadata covers `0238` and `0239`, requires `0239`, and probes the columns. Prior local evidence: Agents phone tests **41/41**, Agents/Shell typechecks, release migration runner **13/13**, release inventory/deployment-manifest validators. P06 remains PARTIAL for customer voice lifecycle, streaming, richer operations, cost/invoice reconciliation and carrier/region acceptance.

P04 `849bf78a` previews additive merge insert/skip counts in a rolled-back SQLite transaction, rechecks on apply, persists skipped counts and shows restore status. Code `6fccacaa` adds an owner/admin full-archive export caller with stable request-ID recovery. The panel states that archives cover supported SpaceDO rows and listed workspace/extension objects, not other services, provider data or opaque Container snapshots, and shows current fail-closed size/object limits. This is not point-in-time rollback. Archive caps, cross-service coverage, legal/key/jurisdiction policy and isolated/live recovery remain open. P01/P02 still lack actual resource separation, service ownership, 158 read-only receipts and operator-attested D1 baselines. Preserve `infra/scripts/__pycache__/`.

Exact next action: add test-only `call.received` and `call.digits` input to the existing owner phone-handler simulator, then pass output through the current host response validator and renderer without issuing carrier commands. Verify owner authorization and DTMF preview, then continue remaining S4–S9/U01–U12 and both plans' uncoded requirements. P01/P02 resource IDs, ownership, read-only receipts and operator-attested baselines remain external evidence gates; P03/P20 grace/restriction and refund/access/author-accounting policies remain undecided. Do not repeat completed caller audits or claim deployed/live acceptance from local checks.
Prior checkpoint: scoped attachment code `5e0c65019f3e0b9dc994977cfba494a1f8c8eaf9` was
pushed to `origin/Mcbt5s-Backup-2` after fetching and confirming the remote was an ancestor. Channel
packages can declare bounded text attachment access, which requires explicit owner/admin approval.
Ingress persists project/installation/provider-connection scope; dispatch returns opaque metadata for
the exact message, and the host rechecks active installation, binding, tenant, Space, project,
installation, provider, channel and expiry before reading private storage. Selected text/PDF/DOCX
excerpts are bounded untrusted sources for the existing host-grounded answer path. Provider URLs,
credentials, storage keys and raw bytes stay out of extension code; legacy non-extension attachment
IDs/object paths are preserved. Local evidence: Agents focused tests **18/18**, Spaces migration,
runtime and installer tests **36/36**, SDK extension tests **29/29**, Agents/Spaces/Shell/SDK
typechecks and `git diff --check`. No deployed DB, live provider traffic or acceptance was run.

P05/P16 remain PARTIAL for image/audio/raw binary access, richer outbound response semantics, Discord
non-ephemeral retrieval and provider/deployed acceptance. §9.5 remains PARTIAL; the keypad package is
an IVR, not a conversational voice-agent product. Exact next action: continue §9.5 voice package
dashboards from the signed keypad package and reachable owner phone status/test APIs. Implement the
next per-install customer configuration or operational view with local caller coverage; identify
simulated results and keep streaming, provider provisioning and rollout disabled.

Updated 2026-11-13 after code `b4c0100f1d5c898ddde137ebf88fea294f99d386` was pushed to
`origin/Mcbt5s-Backup-2` after fetch confirmed the remote was an ancestor. Added the signed-extension
example `packages/agent-sdk/examples/bounded-phone-menu/`: a bounded two-choice keypad IVR with a
per-installation settings schema, settings dashboard, and deterministic versioned response handler.
The existing host supplies its settings snapshot, checks the signed artifact and owner-confirmed phone
binding, validates response data and renders carrier actions. Local evidence: SDK package/response
tests **10/10**, Agents phone/Telnyx/renderer tests **42/42**, Spaces signed-install/settings tests
**29/29**, SDK/handler typechecks and `git diff --check`. This is local evidence only; no package
listing, provider, deployed DB or live call was exercised.

§9.5 remains PARTIAL. The sample is a keypad IVR, not a conversational voice agent; public speech or
streaming, provider provisioning, package publication/version/rollback, invoice reconciliation and
live acceptance remain open. Exact next action: inspect the owner phone-handler simulator API and Shell
caller, add a test-only `call.received`/`call.digits` input through the existing response validator and
renderer, and verify authorization without sending carrier commands. Continue other uncoded plan gaps
after that slice. The earlier §10.2 expected-version-fenced, audience-confirmed amendment remains
implemented and pushed in `bfc22ce6`.

Updated 2026-11-13 after code `2ef44afaeeb1100fb2a7e992b7ef297cd9ecb033` was pushed to
`origin/Mcbt5s-Backup-2` after fetch confirmed the remote was an ancestor. The owner voice-settings
API now returns the current host-approved speech/transcription model IDs, voice IDs, sample rates,
catalog languages, per-unit list prices and their 2026-11-12 source links. The Shell Assistant Voice
panel and signed Space voice microapp show an illustrative 30-second transcription plus 375-character
speech subtotal, with assumptions, costs excluded and explicit unverified-provider caveats. Local
evidence: Space settings **4/4**, Agent SDK microapp **3/3**, Agent SDK/Spaces/Shell typechecks and
`git diff --check`. No provider availability, actual billing, deployment or live call was verified.

§9.5 remains PARTIAL: the existing microapp configures Space Assistant preferences; it is not a
customer voice-agent package and does not add conversational streaming, provider provisioning,
publish/version/rollback, invoices or full call cost. Exact next action: trace signed extension
installation and phone-handler callers against the supported bounded Telnyx `say`/DTMF response
contract, then implement only a customer-facing package workflow that can run on that contract with
local tests. Keep streaming and live acceptance disabled. The expected-version-fenced, audience-
confirmed §10.2 amendment is already implemented and pushed in `bfc22ce6`.

Updated 2026-11-13 after code `7a0098ee5586d29c28cfe7bd372024a15da8eec5` was pushed to `origin/Mcbt5s-Backup-2` following fetch and
fast-forward verification. Extension settings PATCH writes now require a stamped actor and atomically
write metadata-only audit events with their optimistic revision. Migration 123 records installation,
tenant/Space/Project scope, actor/role, prior/new revision, schema, changed field IDs and timestamp,
never setting values. Owners/admins and project managers have bounded history reads in the API and
Shell. Uninstall retains entries; Space erasure clears them in the existing atomic sweep. Focused
Space settings/migration/erasure/route tests pass **27/27**, Spaces/Shell typechecks and
`git diff --check` pass. These are local mocks; no deployed DB or live test occurred.

Historical pre-`2ef44afa` state: the owner API stripped model details from its reviewed voice catalog.
That caller gap is closed locally by the current checkpoint above. Provider/model availability,
regional eligibility, billed rates and complete call costs remain unverified.

Updated 2026-11-13 after code `90b6ddd78ec8dfcafc513085deafdee6d09b4f27` was pushed to
`origin/Mcbt5s-Backup-2`; implementation branch `autonomous-managed-services-20261111` matches the
fetched remote. Code `249c7930` installs exact Space-local signed package releases with Canvas/Gadget
artifact initialization and active publisher checks. Code `90b6ddd7` adds a binding-scoped hash to
admitted Telnyx cost receipts, joins bounded totals to recent extension calls, and shows explicit
provider-reported, non-invoice labels; missing costs remain unknown. Preserve untracked
`infra/scripts/__pycache__/`.

Local/mock evidence: Agents phone and Telnyx webhook tests **40/40**, Agents/Shell typechecks, release
and deployment-manifest validators, and `git diff --check`; earlier signed package/SpaceDO/Gadget
suites **42/42**, Spaces/Shell typechecks. No provider account, deployed DB, deployment, Marketplace
acceptance or live call was exercised. U11/U12 are locally implemented for supported callers/toolchain;
invoices, billed-idle/CPU-size feeds, approved policies and live acceptance remain gates. S2 is
IMPLEMENTED_LOCAL for supported lanes; S3–S9/U01–U12 retain their row-level gaps. P01/P02 remain
fail-closed on resource separation, ownership, `naelao-calls`, missing receipts and operator-attested
D1 baselines. Rollouts remain disabled.

**§5 — PARTIAL.** Signed source/provenance, encrypted draft/resume, localized/conditional fields,
expected usage, owner forms, installation settings/status, setup-only schema migration, and Foundry
visual field authoring through validated export/conformance (`b3feecb5`) are local.
Permission/price changes, general upgrade/rollback/uninstall, project/provider-resource/license
lifecycle, verified rates and live acceptance remain uncoded or lack approved contracts.

**§9.5 — PARTIAL.** Per-installation settings with durable metadata-only actor audit, signed handler
discovery, masked owner call history, a non-persistent owner simulator for synthetic call-start,
DTMF and supported speech events, generic installation of
Space-local signed packages, provider-reported cost joins, and host catalog details/list-rate
estimates are local. The reference microapp configures Space Assistant preferences only. A customer
voice-agent package/microapp, verified rates, publish/version/rollback, richer operations and
composition remain. Streaming is unavailable; bounded keypad behavior remains. No provider/account
acceptance is claimed.

**§10 — PARTIAL.** Audience-filtered facts, disclosure previews, owner/admin publication, expected-
version-fenced audience-confirmed amendments, optional owner-selected v2 expiry, audience read
filtering, owner/admin expiry/revocation review, published cards/proposals and access rechecks have
local code. Configurable posture/defaults, private-project publication/request authority, delegated
extension ownership, reservations/singleton enforcement, concurrency, historical actor audit and
broad non-disclosure/deployed acceptance remain. No expiry default or singleton policy is active.

Exact next action: expose persisted creator, approver, provenance and revocation actor metadata only to
owner/admin lifecycle reads and Settings; keep those fields absent from member responses. Continue
§10.1–§10.6 caller checks and the remaining uncoded S2–S9/U01–U12 and platform requirements. After
compaction, interruption or a new session, read both plans, both progress records and AGENTS.md; inspect
the actual worktree and branch; resume from this action.

Updated 2026-11-13 after public-read code `82e36d16` was pushed, following bounded-list fix `fb988c26`.
Space members can read published public-project cards and submit a collaboration proposal; accepting
it does not grant project membership or card-edit authority. An outsider receives no public card
summary. Codes `1b9146f1`, `6d5f442c`, `307c8445` retire state on unpublish/archive and `52f52e16`
tests immediate project ACL revocation. The focused four-file suite passes **10/10**, Spaces
typecheck and `git diff --check` pass. These are local SQLite/Worker results, not deployed D1 or live
acceptance. §10 remains PARTIAL for policy, private publication, lifecycle links, reservations,
expiry, concurrency and non-disclosure. The historical owner/admin expected-version-fenced amendment
with audience disclosure was implemented in `bfc22ce6`, including SDK, Router, SpaceDO and owner
settings callers. Do not repeat that work; leave expiry and singleton defaults undecided pending policy.

Updated 2026-11-13 after project coordination lifecycle codes `1b9146f1`, `6d5f442c`, `307c8445` and
access test `52f52e16` were pushed. Request creation requires a still-published target card in the D1
batch; unpublishing withdraws pending incoming proposals/events and policy state while retaining
accepted requests. Both project DELETE and generic `PATCH status=archived` retire all linked
blackboard state, with retryable failure after archival. Local SQLite confirms event deletion cascades
receipts, deliveries and wakes. A Worker-to-SpaceDO test confirms removed project members immediately
lose card/request/event reads and request creation/transition/unpublish access without response leaks.
The focused suite passes **10/10**, Spaces typecheck and `git diff --check` pass. No deployed D1 or
live multi-user acceptance occurred. §10 remains PARTIAL for broader policy, privacy, extension
dependency/ownership lifecycle, reservations, expiry, concurrency and non-disclosure. Exact next task:
verify accepted proposals remain advisory and do not grant project membership or extension authority;
then continue configurable §10 policy gaps without inventing defaults.

Updated 2026-11-13 after §9.5 signed phone-handler candidate discovery code `881c1d1a` was pushed to
`origin/Mcbt5s-Backup-2`. The owner phone dashboard now selects a handler only from active,
correctly scoped installations whose publisher signature and complete package bytes match the release
receipt. It fills the handler digest and still requires owner confirmation; the runtime admission
check runs again before binding. SpaceDO and its internal listing support Project and SPACE_SHARED
channels. Local/mock evidence: Agents phone **34/34**, Spaces extension runtime **22/22**,
Agents/Spaces/Shell typechecks and `git diff --check`. No deployed installation or live provider call
was exercised. This closes phone-handler discovery only; §9.5 remains PARTIAL for customer voice
dashboard/runtime, catalogs and rates, test/publish/operations, package composition and live
acceptance. Exact next task: continue §10.2 by tracing private-project visibility, publication and
request-to-use callers against the existing audience-filtered coordination registry; implement the
next independently supported lifecycle gap and preserve unresolved sharing/uniqueness policy.

Updated 2026-11-13 after signed-template lifecycle review code `9d0c2da7` was pushed, following
update-availability code `f725fa2c`, to `origin/Mcbt5s-Backup-2`. Owner/admin status verifies the
installed receipt against the buyer's certified fork and checks the newest published, host-certified
listing from the same publisher. It reports changed artifact, setup schema, required extensions and
versions, and listing terms. It does not apply an update or alter licenses, permissions or customer
configuration. Local evidence: Spaces activation/status suite **19/19**, Spaces/Shell typechecks and
`git diff --check`. No Marketplace, provider, deployed database or live installation was accessed.
The §9.5 caller review found one supported dashboard gap: owners had to hand-copy a phone extension's
installation ID and handler digest. The new candidate path verifies current signed package bytes but
does not establish a customer voice-agent runtime, streaming, or voice catalogs. A targeted P03 caller
review confirmed provider outcomes reach Dashboard through Router; no independent code gap was found,
and provider acceptance is not inbox delivery. P03/P20 policy and independent
operator identity remain unresolved. P04 restore safety is implemented locally (`b6c408c8`); archive
limits, merge semantics, legal/key policy and isolated/live drills remain open. P01/P02 still lack
separated resources, read-only receipts, operator-attested migration baselines and isolated/deployed
acceptance. Exact next task: continue §10 lifecycle/policy work from private-project publication and
request-to-use; do not repeat the completed §9.5 handler-discovery audit.

Prior §10 audience code `9ec259ba` is pushed to `origin/Mcbt5s-Backup-2`. Migration 119 preserves the
legacy member audience and the v2 flow supports an explicit member or owners/admins audience, with
SQL filtering before pagination and audience-class-bound cursors. Local/mock evidence and remaining
§10 policy/lifecycle/concurrency/non-disclosure limits are in the managed-services progress record.

Updated 2026-11-13 after §5 installation receipt/status code `5c7ba416` was pushed to
`origin/Mcbt5s-Backup-2`. Migration 118 pins selected Marketplace listing and setup schema version
for new installs; activation forwards the exact listing ID. Owner/admin-only status reads show pinned
artifact hash, listing, schema revision, extension dependencies, generated projects and terminal
failure code without returning setup values. The Shell marks unknown legacy listing provenance and
states that latest update availability was not checked. Local/mock evidence: Spaces activation,
setup-runtime and migration suites **25/25**, Router product-path suite **42/42**, Spaces/Shell
typechecks and `git diff --check`. No deployed DO, Marketplace payment or provider was exercised.
§5 remains PARTIAL for update/schema migration, changed permission/pricing review, rollback,
revocation/uninstall, full provider/runtime rates, visual authoring and live acceptance. No update or
uninstall policy for generated projects or retained provider resources is encoded. Next task: inspect
§9.5's signed voice-dashboard and extension-settings source against the shared declarative contract;
implement per-installation configuration only where the current host API can validate and persist it,
and keep unsupported voice-runtime/provider actions unavailable.

Updated 2026-11-13 after §5 setup conditions and usage assumptions code `b9ad2c83` was pushed to
`origin/Mcbt5s-Backup-2`. Setup schema v2 now supports one equality condition bound to an earlier
field and bounded localized labels, help and select labels. The host validator enforces schema
version, locale/text bounds, source field/value compatibility, no backward/cyclic references, no
credential-like wording and a 64 KiB schema cap; the owner form hides and localizes fields. The
server accepts bounded monthly conversation/interaction assumptions and projects interaction volume,
but leaves estimated dollars unknown because verified usage rates are absent. Local/mock evidence:
SDK tests **8/8**, Spaces cost/activation **22/22**, SDK/Spaces/Shell typechecks and `git diff --check`.
No deployed DB, payment, provider or live test was run. §5 remains PARTIAL for complete provider and
runtime rates, update/version migration, permission/pricing changes, rollback, revocation/uninstall,
visual authoring and end-to-end acceptance. Exact next task: trace current package lifecycle callers
and implement an independently verifiable owner-facing update/uninstall gap, leaving external effect
reconciliation and price policy explicit.

Updated 2026-11-13 after guided-template draft/resume code `f5050258` was pushed to
`origin/Mcbt5s-Backup-2`. Migration 117 stores owner setup drafts as AES-GCM ciphertext, bound to the
Space tenant, listing, signed artifact digest, setup-schema version and digest. The host requires the
exact pending blueprint and fork, checks owner/admin access, validates incomplete values, enforces
optimistic revisions, and requires explicit replacement after a binding change. The Shell restores
matching drafts in the owner review flow; successful activation clears them. Local/mock evidence:
Spaces draft/activation/migration **25/25**, Agent SDK setup-schema **6/6**, Router product-path
**41/41**, Shell template **1/1**, Spaces and Shell typechecks and `git diff --check`. The pnpm wrapper
attempted a dependency reinstall and aborted without a TTY, so checks used installed binaries. No
deployed DO, payment or live provider behavior was tested. §5 remains PARTIAL for conditional and
localized fields, expected-usage inputs and complete rates, package lifecycle/update/uninstall, and
end-to-end acceptance. Exact next task: add a bounded signed conditional/localization vocabulary
with host validation, then add expected-usage inputs to the existing estimate while retaining unknown
rates as unknown.

Updated 2026-11-13 after P04 restore-safety code `b6c408c8` was pushed to
`origin/Mcbt5s-Backup-2`. Migration 116 persists safety actions with restore receipts. Preview shows
archived active event triggers; missing triggers are inserted disabled, while existing destination
state is preserved. Owner/admin Settings now lists archives and restores, shows merge-only restore
previews, and can resume partial restores. A separate owner/admin, project-authorized route re-enables
a reviewed trigger only if its project remains active, recording actor and time. Local/mock evidence:
SpaceDO archive/migration/automation/route tests **21/21**, Spaces and Shell typechecks, and
`git diff --check`. No deployed D1/R2, isolated restore, provider reconnection or RPO/RTO drill was
run. P04 remains PARTIAL for archive caps, merge semantics, cross-service coverage, key/legal/
jurisdiction policy and live acceptance.

P03 code `51defd9f` records scope-bound Resend accepted/rejected/ambiguous outcomes; local provider
outcomes do not establish inbox delivery. Grace/restriction/escalation, refund/dispute/manual
intervention and live acceptance remain open. P20 identity and accounting policy remain partial.
P01/P02 remain blocked on actual resource separation/receipts and operator-attested migration
baselines. Historical next task was browser draft/resume, now closed in `f5050258`.

P01/P02 code `3e456061` and `a1827a05` remains pushed. The source map contains **28** Wrangler
configs, **100** binding rows, **56** Worker/environment surfaces, **2** routes and **30** endpoint
host entries. Preflight detects mutable D1/KV/R2/Vectorize/Queue/Workflow/DO/service target sharing,
requires **158** read-only receipts and rejects shared observed DO namespace IDs. It remains fail
closed on one shared D1, eleven shared KV IDs, unresolved `naelao-calls` ownership and missing
receipts. Secret presence, provider callbacks, jurisdiction and actual resources require external
read-only evidence. P01 lacks operator-attested D1 baselines and isolated/live release acceptance.
Historical next task: prevent P04 restore from reactivating external-effect event triggers. This was
closed in `b6c408c8`; current next action is the §5 browser draft/resume work above. Keep
implementation, mocked, deployed and live evidence distinct.

Prior S4/MS03c-d continuation (2026-11-13, code `ebe98120`):

Updated 2026-11-13 after S4/MS03c-d code commit `ebe98120` was pushed to
`origin/Mcbt5s-Backup-2`. Sidecar import failures/conflicts now receive durable terminal outcomes;
export receipts bind workspace path/revision and track immutable artifact staging separately from
checked publication. A bounded owner/admin status route and Shell review list expose the last 50
receipts per installation/branch, with no automatic conflict publication. Agents sidecar DO/prebuilt/
route suites pass **40/40**, Shell API test **1/1**, Agents/Shell typechecks and `git diff --check`.
These are local R2/DO/Worker mocks, not deployed or provider acceptance.

Prior code commit `99a036cd` was pushed to
`origin/Mcbt5s-Backup-2`. SpaceDO migration 115 persists versioned setup schema plus optimistic
revision with each new activation. The `/api/template-setup` host path returns one project group to
the exact active, required SPACE_SHARED extension and revalidates declared read/configure grants,
schema, values and revisions. Owner/admin writes use compare-and-set; provider credentials and other
project groups are not returned. The signed-installation path, Space gateway membership check,
Router product-session path, Shell RPC and typed Agent SDK consumer are connected. Local evidence:
Agent SDK **40/40**, Spaces **25/25**, Router **40/40**, SDK/Spaces/Router/Shell typechecks and
`git diff --check`. These are local mocks/static checks; no deployed template microapp or live
acceptance occurred.

U05 remains partial. Current Sandboxes creation stores `snapshot_diff`, and its only allocated
provider caller is Agent37; Cloudflare computers can be configured but are not allocated. The live
verifier requires an active Cloudflare `live_mount` allocation, held reservations and fresh attested
capabilities. The producer remains blocked by the unsupported pinned Cloudflare runtime contract
recorded under U06, not by credentials. No trusted producer or operator evidence was fabricated.

§5 remains PARTIAL: browser draft/resume, conditional/localized fields, expected usage and a complete
provider/runtime cost calculator remain uncoded, alongside package update/uninstall lifecycle and
end-to-end acceptance. No template field provides provider-secret access. The separate owner-managed
customer phone-extension controls are available through the existing phone ledgers, while the retired
`/customer-voice/*` route remains closed and public extension streaming remains unavailable.

The managed-services matrix still contains PARTIAL rows for the unsupported U05/U06 writer/runtime
contract, policy/product decisions, external evidence and deployed/live acceptance; this S4 code did
not change those classifications. The traced MS03c/d caller gap is closed locally. The later P01/P02
source-isolation checkpoint and exact next task are recorded at the top of this progress file. Keep
rollout and local/mock/deployed/live evidence distinct.

Prior checkpoint — updated 2026-11-13 after code commit `36ff9179` was pushed to `origin/Mcbt5s-Backup-2`. Initial §10.2
coordination-registry code is IMPLEMENTED_LOCAL: migration 114 persists bounded Space-owned facts,
approval actor/role, fixed `space_members` audience, advisory-only status, timestamps and revocation
version. A Spaces gateway checks active tenant-owned Space and current membership on each read;
owner/admin writes require an explicit disclosure confirmation. The list is capped at 50 per page
with stable keyset continuation; revocation compares the expected version. Member responses omit
author/approver IDs. SDK contracts and Shell Settings now list facts, preview their exact label,
description, audience/effect, require explicit confirmation, and allow administrators to unpublish.
The registry is separate from project Blackboard and does not query or link private projects.
Focused local evidence: SDK tests **2/2**, Spaces gateway/DO/migration tests **11/11**, Router
product-session route tests **39/39**, SDK build, Spaces/Shell/Router typechecks and `git diff
--check`. These are local SQLite/Worker mocks and static checks; no deployed multi-user,
non-disclosure, or live acceptance occurred.

§10 remains PARTIAL. Implemented scope is the fixed-audience advisory fact subset above. No configurable
collaboration posture/audience, private-project publication workflow, delegation or project/extension
linkage, request-to-use authority, role-filtered assistant discovery, expiry/refresh policy, lifecycle
reconciliation, resource reservation/singleton enforcement, concurrent provisioning test, or broad
side-channel test exists. Duplicate keys are allowed intentionally; no uniqueness policy is active.
Do not infer facts from project content, expose actor metadata to ordinary members, or claim that
advisory entries grant access.

The earlier extension-settings and voice-dashboard commits `07af44c2` and `9919963e` remain pushed.
The voice microapp edits Space Assistant preferences only; it is not a customer voice-agent package.
§9.5's package-owned customer dashboard, test/publish/monitor flow, custom voice lifecycle, voice
preview, supported public streaming and provider acceptance remain open.

§5 remains PARTIAL. Space Template setup values are now exposed to the exact active required shared
extension through a host API that rechecks the signed installation, declared capabilities, schema,
normalized values and optimistic revision. Browser draft/resume, conditional/localized fields,
visual authoring, expected-usage inputs, complete provider/runtime rate coverage, package
update/uninstall lifecycle and end-to-end acceptance remain open. The separate extension settings
store is still not a Template runtime consumer. Fields cannot collect provider secrets; use
host-managed connections.

The managed-services source/caller ledger continues to track S2–S9/U01–U12. Its PARTIAL rows retain
their named product policy, unsupported runtime/platform contract, external resource evidence or
deployed/live acceptance gap. P01/P02 remain fail-closed on environment IDs, ownership receipts and
operator-attested migration baselines; P03/P20 retain the grace/restriction,
refund/dispute/author-accounting and independent operator-identity gaps. After P01/P02 and commercial
integrity/recovery, continue guided-template lifecycle before returning to §9.5 customer voice-package
setup, the current retired `/customer-voice/*` routes, installed phone extensions, line assignments,
phone settings and cost/status surfaces. Do not resurrect retired customer call behavior or public
streaming. Then continue the remaining §9 package/runtime/cost gaps and §10 policy, lifecycle,
concurrency and privacy work; keep implementation, mocked, deployed and live evidence distinct.

Updated 2026-11-13 after guided-template code commit `46f38eea` was pushed to
`origin/Mcbt5s-Backup-2`. Space creation retains the exact Marketplace listing selected with a
template; preview and activation bind to that same tenant fork/listing. Owner review reports an
actual recorded license purchase or a verified current zero-price listing as a known one-time cost,
while keeping total operating cost null and listing model/tool, channel/provider, runtime/storage,
tax, regional and account-specific costs as not estimated. Local evidence: focused Spaces blueprint,
cost-estimate and create-record tests **63/63**, Spaces and Shell typechecks, and `git diff --check`.
No deployed install, Marketplace payment or provider call was exercised. There are no expected-usage
inputs or complete provider/runtime rates; §5 remains PARTIAL for authored setup fields, host-side
value validation/persistence, dynamic estimates and full lifecycle acceptance. Exact next task:
define a bounded, versioned declarative setup-field contract in the signed template package, validate
schema and values on the host, persist per installation, and render only supported fields. Exclude
arbitrary executable form logic and implicit provider-secret access.

Prior checkpoint — updated 2026-11-13 after P03/P20 independent caller code commit `41996f29` was pushed to
`origin/Mcbt5s-Backup-2`. Dashboard Settings presents the provider-reported subscription status and
a validated provider portal action for eligible owners/admins. Marketplace listing pages show
buyer/creator refund-case state from the existing durable review journal through the signed Router
route; tenant/listing scope and audit are covered, and provider order identifiers are not returned.
Local evidence: Marketplace routes **5/5**, Router proxy **4/4**, four affected TypeScript projects
and `git diff --check`. These are local checks; no deployment, payment or provider delivery was
exercised. P03 remains PARTIAL for grace/restriction/escalation policy and live delivery. P20 remains
PARTIAL for refund/dispute/access and author-accounting policy and independently authenticated
operator resolution; the existing list API uses a shared secret and caller-supplied ID, and no safe
operator UI exists without an identity contract. The managed-services matrix already reconciles
S2–S9/U01–U12, including completed U11/U12 caller audits; see that ledger instead of repeating them.
Do not repeat those audits absent new evidence.

Prior checkpoint — updated 2026-11-13 after P04 code commit `937fbdd5` was pushed to
`origin/Mcbt5s-Backup-2`. New full archives place
bounded workspace object bytes and SHA-256 checksums inside the existing encrypted archive; restore
can conditionally recreate missing objects, verifies read-back checksums, and records partial
progress in migration 111 so a retry can complete after R2 or SQLite failure. Per-object capture is
capped at 2 MiB, aggregate object bytes at 4 MiB, and full plaintext archive remains capped at 8 MiB.
Local evidence: `space-data-ops.test.ts` **9/9**, Spaces typecheck, and `git diff --check`. These are
SQLite/R2-mock checks; no deployed R2, isolated recovery, provider reconnection or RPO/RTO drill was
exercised. P04 remains PARTIAL for these bounded size/row limits, merge-only relational restore,
legal/key/jurisdiction policy, safe external side-effect reconnection, and live/isolated recovery
evidence. P24 remains PARTIAL for dependency closure, cross-Space artifact restoration, lost-response
acceptance across the full Worker/R2 path, key compromise notice, removal/retention policy and
supply-chain scanning. The drain receipt gap from this checkpoint was later closed locally in
`f5b3c1dd`, and owner readback followed in `0ba70840`. P01/P02 protections
remain fail-closed on shared resources, missing ownership/receipts and operator-attested migration
baselines. P03/P20 caller work is recorded in the subsequent `41996f29` checkpoint; policy and
operator-identity gaps remain open.

### Prior checkpoint — P24 publisher/package trust (`415ba199`)

Publisher trust fails closed for incomplete publisher metadata, applies the current D1 publisher-key
registry to installation views, template paths and rollback, and fences rollback to one exact
tenant/Space/project installation with an expected current release. Rollback and supported package
upgrades require explicit approval when the selected install gains permissions or capabilities.
Local evidence at that checkpoint: six focused Spaces suites **67/67**, Spaces/Shell typechecks and
`git diff --check`. No deployed R2, publisher registry, runtime or live provider acceptance was
exercised. P24 remains PARTIAL for dependency closure, cross-Space artifact restoration, full
Worker/R2 lost-response acceptance, key compromise notice, removal/retention policy and
supply-chain scanning. The revocation/drain receipt code gap was subsequently closed in `f5b3c1dd`,
with owner readback in `0ba70840`; see the active checkpoint for current evidence.

## Prior checkpoints

Updated 2026-11-13 after P16 code commit `1056a322` was pushed to
`origin/Mcbt5s-Backup-2`. `channel-media-capabilities.ts` is the shared versioned source for
Discord's ephemeral-reference-only ingress, five-file, 5 MiB/file and 15 MiB aggregate Naelao
limits, private retention up to 30 days, MIME behavior and lack of extension file handles. The
downloader validates all references and declared aggregate size before fetching; storage and the
verified no-store capability route use the same limits. Router allows the product session through,
and Shell setup reports the current support and restrictions. Focused Agents tests **10/10**, Router
path tests **35/35**, Agents/Shell/Router typechecks and `git diff --check` pass locally. No provider
live acceptance or deployment was exercised. P16 remains PARTIAL: scoped media handles are uncoded,
ordinary non-ephemeral retrieval remains unsupported pending a permitted isolated design, and
provider acceptance has not run.

At that checkpoint, the next action was P17: trace catalog selection, listing identity/freshness, license and purchase/
refund settlement, and onboarding against current callers; implement remaining independent
identity/availability gaps using the existing durable license and refund ledgers. Then audit P24
installed-package provenance/revocation before guided installation, voice-extension dashboards and
Shared-Space coordination.

Prior P15 checkpoint (2026-11-13, code commit `1f0a428e`, still pushed to
`origin/Mcbt5s-Backup-2`). SpaceDO migration 110 adds an indexed `(space_id,id)` keyset page capped
at 90; the authoritative DO filters current project/Space ACLs on every page, and the Spaces Worker
reads summaries only for that page. Archived and subspace-bound projects retain the previous
listing semantics. Local evidence: focused Spaces migration/page tests **9/9**, AgentPort search
caller tests **10/10**, Spaces typecheck, and the selected local Wrangler/D1/SpaceDO/
ScriptToolSurface test **1/1**. First/middle/last exact-reference queries at 100, 1,000 and 10,000
synthetic cards found all targets; at 10,000 the three traversals took **512–565 ms**, page p95
**6–8 ms**, and the assistant found the last target in **536 ms** over 12 bounded searches/29 loop
steps. Zero provider calls. Detailed evidence:
`new plan/validation-results/2026-11-13/blackboard-indexed-pagination-local-wrangler.json`.
These are single-run local emulation results. P15 remains PARTIAL for realistic private-member
density, independent relevance/task-quality evidence, repeat-run latency distribution and deployed
acceptance. The full 18-test runtime attempt passed 13 and failed five unrelated Project Bot
planner fixtures at the direct-write delegation boundary.

Updated 2026-11-12 after code checkpoint `7b6942e8` was pushed to
`origin/Mcbt5s-Backup-2`. Migration 0232 and Knowledge/Workflow/Spaces changes now provide durable
semantic-cache entry deletion for document and whole-Space erasure, preserve in-flight erasures
through the migration-before-Worker rollout window, and expose owner-visible cleanup status. Local
evidence: Knowledge **79/79**, Workflows **38/38**, Spaces erasure routes **3/3**, Python
release/migration tests **47/47**, affected typechecks, release/deployment validators, and
`git diff --check`. No deployed D1, Vectorize, KV, provider-index deletion, or live acceptance was
tested. The code gaps in P22 are closed; AutoRAG provider-index deletion and deployed acceptance
remain unverified. The immediately prior P23 checkpoint `f676408a` remains pushed and locally
verified as described below.

Updated 2026-11-12 on `autonomous-managed-services-20261111`. The platform plan at
`platform-completion-and-guided-templates-plan.md` was added by commit `9e1281ce` and is already
integrated in this branch. Findings in that plan were researched against an older checkout; the
statuses below reflect the current source where inspected. This file is additive to the managed
services progress record; reuse its U01–U12 and S1–S9 ledgers rather than duplicating their evidence.
The P01 deployment manifest, staging dependency gate, tests and runbook are pushed to
`origin/Mcbt5s-Backup-2` as `749f9c95`. P03/P11–P13 code, tests, schema updates and this source
reconciliation are pushed in code commit `2625ea3426d5ee1bc7d7dce3776553073843640d`; the current
progress refresh is pushed as docs commit `def77078` immediately after that code checkpoint.
Latest pre-P22 code checkpoint `f676408a` is pushed: stable signed webhook event identifiers, explicit
Resend acceptance receipts persisted on the existing Product auth-email outbox, migration 0231,
and a release schema probe for the receipt column. Local evidence: Notifications **33/33**, Product
auth recovery **17/17**, release runner **9/9**, manifest tests **5/5**, affected typechecks, both
release validators and `git diff --check`. No live provider or D1 was exercised. P23 remains partial
on general channel exhaustion and audited operator replay.

### P01 — ordered releases and migration safety: PARTIAL, local release controls implemented

Current code pins SHA-256 for **234** exact migration files and requires schema
`0234_notification_delivery_outcomes`. The Python release runner has an atomic D1 migration ledger,
concurrency lock, drift checks, resumable owner, fail-closed handling for legacy migration 0164,
required-schema/column probes and ordered consumer checks. Deployment manifests and post-worker
health gates run before frontend publication. Latest local checkpoint `e967eaa3` records the affected
migration/release/environment suites **25/25**, manifest validators, typechecks and staging/production
Wrangler dry runs. These are local/mock/static checks; no remote D1 or deployed endpoint was queried.

Latest local P01/P02 verification: release migration tests **12/12**, environment-resource tests
**10/10**, Wrangler isolation **6/6**, release-manifest tests **5/5**, deployment-manifest tests
**8/8**, both manifest validators. The release validator confirms 234 migration files and required
schema `0234_notification_delivery_outcomes`. Environment preflight remains fail-closed on one shared
D1, eleven shared KV IDs, unresolved `naelao-calls` ownership, missing account/time observations and
**158** resource receipts. No Cloudflare account or remote D1 was inspected.

Neither staging nor production has an operator-attested baseline file or verified applied-history/data
inspection. The release runner therefore stops before mutation. There is no isolated migration
rehearsal, automatic rollback or live health acceptance. No independent P01/P02 code gap was found in
the current runner and map; do not create a baseline from source-only evidence. The earlier P23
synchronous `/internal/notify` handoff is already implemented in code `27683db1`, which records stable
operation IDs and accepted/rejected/ambiguous/not-sent outcomes; do not repeat it. P03/P12/P20 retain
the policy, identity, retention and provider acceptance gaps recorded in their sections. Continue
independent recovery work only where current source shows a codeable caller gap; do not invent business
policy.

### P02 — isolated environments: PARTIAL, fail-closed

The source-hash-validated map covers **28** Wrangler TOMLs, **100** binding rows, **56**
Worker/environment surfaces, **2** routes and **30** endpoint-variable entries. Preflight checks
mutable D1/KV/R2/Vectorize/Queue/Workflow/DO/service targets and requires current read-only receipts,
including distinct observed DO namespace IDs. The current map requires **158** receipts. It still
fails closed on one shared D1, eleven shared KV IDs, and shared/unresolved `naelao-calls` ownership
with no named Worker owner. Staging events/workflows queues and DLQs are separately named from
production in checked-in configuration, including the production Notifications DLQ; this source-level
separation does not establish deployed resource identity. Account, credentials, provider callbacks,
DO namespace IDs, jurisdiction and actual ownership remain uninspected. No IDs or receipts are
invented.

### Verification recorded at the initial P01/P02 source reconciliation

- `python3 -m unittest discover -s infra/scripts -p 'test_validate_environment_resources.py'`: **6/6**.
- `python3 -m unittest discover -s infra/scripts -p 'test_validate_wrangler_env_isolation.py'`: **6/6**.
- `python3 -m unittest discover -s infra/scripts -p 'test_release_migrations.py'`: **8/8**.
- `python3 -m unittest discover -s infra/scripts -p 'test_validate_release_manifest.py'`: **5/5**.
- `python3 infra/scripts/validate_release_manifest.py`: 230 migration files; required schema
  `0230_queue_health_observations`; no deployed schema inspected.
- `python3 infra/scripts/validate_environment_resources.py` and
  `python3 infra/scripts/validate_wrangler_env_isolation.py`: correctly fail closed on current
  resource sharing, missing ownership/receipts and shared mutable bindings.
- No deployment, Cloudflare API inspection, D1 access, resource creation, or live acceptance.
- P01 implementation verification: deployment-manifest tests **5/5**, manifest validator passes,
  staging frontends are job-gated on successful Worker deployment, and `git diff --check` passes.

### P03 — payment failure lifecycle: PARTIAL, durable notification path present; policy unresolved

Current Lemon Squeezy and Whop `payment.failed` handling updates the exact subscription to
`past_due` and records a stable dunning event in `billing_dunning_outbox`. Billing lease/retry
dispatches it to the `DUNNING_EVENTS` queue. The Workflows consumer validates the common v1 event,
creates a stable `DunningWorkflow`, and confirms an existing instance after ambiguous create
responses before acknowledging redelivery. The workflow rechecks the exact current subscription and
event timestamp before queueing a notice to the verified product email or current organization
owner/admin. Payment recovery and expiry are handled by provider subscription transitions.

There is no approved grace-period length, activity restriction matrix, escalation policy, or manual
intervention contract. Paid access remains until the provider reports expiry; this is current
behavior, not a policy claim. Provider retries and actual Notifications delivery are not verified.
The owner/admin Settings page now displays this provider-reported status, period end and cancellation
state, and routes eligible users to the existing provider portal (code `41996f29`). This improves
recovery visibility without selecting a grace/restriction policy; it does not claim that payment
recovery or email delivery succeeded.

### P04 — encrypted archive object recovery: PARTIAL

New full archive exports capture the listed `spaces/{space}/projects/` and
`spaces/{space}/space-workspace/` object bytes into the encrypted archive, with each object bound to
its key, listed ETag, size and SHA-256 checksum. Capture is limited to 2 MiB per object and 4 MiB in
total and preserves R2 HTTP/custom metadata; the existing archive plaintext cap remains 8 MiB, so larger snapshots fail closed. Restore
validates complete snapshot coverage and checksums, accepts an existing object only when its content
matches, conditionally writes missing objects without overwriting collisions, and verifies the bytes
after the write. Migration 111 records `restoring`/`partial`/`completed`, verified object count and
last error. SQLite rows still restore as an idempotent merge, and R2 writes cannot participate in the
SQLite transaction. A failed SQL apply may leave captured bytes restored, but durable partial state
allows retry with the same preview.

Local evidence: `workers/spaces/src/do/space-data-ops.test.ts` **9/9**, Spaces TypeScript check, and
`git diff --check`, including conflicting-object non-overwrite and interrupted two-object recovery.
P04 remains PARTIAL: archive capture limits and point-in-time semantics are unchanged; there is no
isolated restore drill, measured RPO/RTO, live R2 durability/retention evidence, provider reconnection
reconciliation, or approved key/legal/jurisdiction retention policy.

### P11/P12 — checkout and dunning contracts: local behavior reconciled

P11's current `checkout-policy` limits simulated checkout to explicit local/development/test config.
Staging/production config disables it, and tests cover missing providers, upstream failure and
production/staging rejection. Provider success, webhook delivery, and entitlement application still
need authorized staging acceptance.

P12's duplicated permissive payload checks were consolidated in
`packages/types/src/managed-billing-events.ts` as strict versioned `DunningEventV1`. Billing writes
version 1; Billing dispatch, compatibility queue handling and Workflow queue consumption share the
validator. Legacy pending payloads without a version remain readable as v1 for recovery; explicit
unknown versions are rejected. The durable outbox retries dispatch with bounded exponential delay;
the workflow rechecks the current subscription before enqueueing a stable-ID notice, and Notifications
persists provider-accepted/rejected/ambiguous receipts using the Resend idempotency key. Prior
Billing/workflow dunning, checkout and queue evidence is **31/31**; this checkpoint reran Billing
dunning/Product-user **8/8** and checkout-policy/fallback/Product-user **10/10**, plus Billing
typecheck. Reminder cadence and access restriction are policy decisions; live email delivery remains
unverified.

### P13 — queue health: PARTIAL, honest telemetry and durable alerts implemented

The old behavior used interval queue totals as current depth, reported oldest age as zero, treated
interval dead-letter totals as current DLQ depth, fell back to unrelated `usage_events`, and swallowed
history-write failures. The current workflow explicitly represents current backlog, age and DLQ
depth as unavailable; missing credentials, GraphQL errors and no rows produce `unknown`, while
partial interval evidence is `incomplete` and a high measured interval error rate is `degraded`.
Migration `0230_queue_health_observations.sql` persists every report; alert rows use the existing
operator-visible `platform_failures` review inbox, written atomically with the report. The migration
is required by release schema probes. Local evidence: model suite **7/7**, SQLite migration
constraints **3/3**, release runner **8/8**, both manifests validate. No Cloudflare account was
queried. Current depth/age/DLQ and live telemetry acceptance still need a supported provider API or
operator inspector.

Codes `4de53055` and `d640dbae` now route unknown/misrouted and malformed poison messages to the
configured DLQs across Workflows, Billing, Notifications, Analytics, Provisioner and Agents; known
stale messages still ACK. Focused local evidence: Workflows **11/11**, Notifications **10/10**,
platform-plan queue/webhook **23/23**, Analytics **2/2**, Provisioner **4/4**, Agents session queues
**3/3**, plus all six affected Worker typechecks. Configured DLQ queues are per worker/environment.
The Admin DLQ consumer reads a different queue and stores/logs raw payloads; wiring sensitive DLQs to
it would lack a safe retention/redaction/replay contract. Notifications has its own durable non-PII
terminal-status view under P23. Generic authenticated replay remains uncoded until payload retention,
idempotency and operator audit semantics are defined. Provider backlog, age and true DLQ depth remain
unknown; no Cloudflare account was queried.

### P22 — Knowledge deletion and indexing: PARTIAL, local cache cleanup gaps closed

Code `7b6942e8` and migration 0232 extend the existing deletion journal rather than creating a
parallel cache ledger. Each bounded Vectorize result page is persisted before both Vectorize IDs and
matching `sc:<id>` KV payloads are deleted. Document deletion rotates the generation first; whole-
Space erasure uses a request-scoped wildcard purge operation and retains pending work through Space
D1 deletion. Migration seeds operations for in-flight erasures so an old Worker finishing during
schema-first rollout cannot lose the physical cleanup; the scheduled reconciler reopens completed
rows whose cache status remains pending. Air-gapped Spaces rotate the generation but defer external
Vectorize cleanup until the erasure request is completed, when deletion-only cleanup can resume even
if the Space row is gone. Owner erasure status includes `cache_cleanup_status`. Local evidence:
Knowledge **79/79**, Workflows **38/38**, Spaces erasure route tests **3/3**, Python release/migration
tests **47/47**, affected typechecks and both release validators. These are local mocks/SQLite/static
checks. AutoRAG provider-index deletion, deployed data-store behavior and live acceptance remain
unverified; retrieval remains disabled.

### P23 — notification outcomes and retry safety: PARTIAL, durable async outcomes implemented locally

Code `e967eaa3` and migration 0234 add a tenant-scoped, non-PII outcome ledger for general
Notifications queue work: provider accepted/rejected/ambiguous, not sent, in-app persisted and
terminal dead-lettered. Dunning provider attempts remain in `dunning_notification_attempts`; only
terminal dunning DLQ state is recorded in the general table. An owner/admin-only no-store read is
reachable through Billing and Router and rendered in Dashboard settings. Production Notifications
uses a distinct configured DLQ. Earlier webhook event IDs/signatures and Product auth-email Resend
acceptance receipts remain on their existing paths. Local/mock evidence at `e967eaa3`: Notifications
**40/40**, Billing **4/4**, Router **2/2**, notification/release/environment Python suites **25/25**,
affected typechecks, release/deployment manifest validation and staging/production Wrangler dry runs.
No deployed D1 or provider delivery was exercised.

Code `27683db1` plus migrations 0235/0236 adds synchronous `/internal/notify` operation IDs and
non-PII accepted/rejected/ambiguous/not-sent outcomes; callers supply stable IDs where source event
identity exists, and ambiguous operations are not automatically resent. Local evidence: Notifications
**44/44**, Agents **1,481 passed / 7 skipped**, Auth **34/34**, affected typechecks, migration/release
**18/18** and release validators. Provider request acceptance does not prove inbox delivery or reading.
P23 remains PARTIAL for approved retention, audited operator replay, incomplete identity/receipt
coverage in other paths, and provider/deployed live acceptance.

### P15 — large-Space Blackboard discovery: PARTIAL, indexed bounded path implemented locally

Commit `1f0a428e` adds migration 110 with the `(space_id,id)` index and a SpaceDO keyset endpoint
that returns at most 90 currently visible top-level project IDs. The SpaceDO applies public,
project-member, Space owner/admin and inherited parent-owner rules in SQL on every page; it excludes
archived and subspace-bound rows to preserve the old `/projects` semantics. The Spaces Worker
validates ascending unique cursor pages before querying D1 for only those card summaries. It does
not materialize/sort every project ID for each page. Local unit evidence covers ACL revocation
between pages, private and archived exclusion, subspace exclusion, inherited parent owner access,
limits, response validation and index selection. Focused suites pass Spaces **9/9**, AgentPort
**10/10**, and Spaces typecheck.

The selected real local Wrangler/D1/SpaceDO/ScriptToolSurface acceptance passes **1/1**. With
synthetic public cards it found exact-reference targets at first/middle/last positions at 100, 1,000
and 10,000 cards. At 10,000, cursor traversal took **512–565 ms** over 112 pages, page p95
**6–8 ms**, and the assistant fixture found the final card in **536 ms** over 12 search calls and
29 loop steps. Zero provider calls. This is one local run, not a production distribution or
relevance-quality result; prior 8.79 s measurements came from a different run and are not a
controlled A/B. The single-snapshot comparator remains test-only because it materializes all cards.
Private-membership density and independently labeled task quality still need measurements, so P15
is not fully accepted. The full runtime attempt passed 13/18; five unrelated Project Bot planner
tests failed after deterministic direct-write attempts were rejected at the delegation boundary.
No deploy or live acceptance occurred.

### P18/P20/P21 — current-source reconciliation

P18 reset consumes a one-time token and atomically applies the password, advances account
`security_generation`, and journals session cleanup via migration 0227 triggers. Protected requests
compare the persisted generation before accepting a ProductUserDO session; the scheduled dispatcher
retries downstream DO cleanup. Product and builder P21 reset/verification email use encrypted,
bounded outboxes with neutral public responses, retry, token supersession and HMAC-scoped metadata
diagnostics. Auth migration 0245 (`814c429a`) atomically couples encrypted builder reset payload
enqueue to token issuance, uses stable Notification IDs, retains provider acceptance receipts, and
schedules bounded retries. Signup currently issues a Product session before verification; policy for
unverified users and actual inbox delivery remain open. Local builder verification: Auth tests
**39/39**, Auth typecheck, release/deployment manifest checks, release migration tests **15/15**,
staging/production Wrangler dry runs and `git diff --check`. These do not establish deployment or
inbox delivery.
The follow-on `f676408a` slice parses Resend's accepted-request receipt, persists it to the same
Product auth-email outbox operation, and exposes it only through the existing HMAC-protected
operation list. This is a provider acceptance receipt, not inbox delivery. Product auth recovery
tests pass **17/17**; live email acceptance remains unverified.

P20 handles signed Lemon Squeezy marketplace refund events in a durable idempotent review journal,
matches them against observed purchases, validates currency/amount/tenant, reconciles late-arriving
purchase matches, and exposes scoped review listing. Exact refund/access reversal, author earnings
clawback, payout recovery, dispute ingestion and case resolution are not implemented because the
product/accounting policy is not decided. Local settlement/refund tests pass **6/6**. No provider
sandbox or live transaction was used. Code `41996f29` adds a private, no-store buyer/creator case
status view on the selected Marketplace listing, proxied through Router and audited by the Worker;
the response omits provider order IDs and explicitly leaves access/earnings unchanged. The operator
list route still authenticates only a shared secret and accepts a caller-supplied actor ID. No
independent platform-operator identity issuer or safe first-party operator UI is present, so operator
resolution remains an identity/product contract rather than a provider credential blocker.

### P17 — marketplace identity, freshness and installation: PARTIAL

The stale Portal Whop fallback is removed and the page identifies the retired catalog. Marketplace
listing responses carry the listing/template identity and current pricing; public cards show the
actual fixed-license price. A same-origin Naelao login/register entry stores the session used by the
Marketplace API, and the selected listing page reads a private, no-store license/fork status. The
Worker rechecks published listing state and certification on checkout/fork, and returns payment to
that exact listing. Billing validates and forwards only the trusted HTTPS return URL. The Shell
template picker previously queried the nonexistent `vertical-saas` category; it now lists actual
Marketplace categories using fresh pagination, then carries `listing_id` through its existing
fork, Space creation, dependency preview and activation flow. The durable purchase, fork, earning
and refund-case ledgers remain authoritative; no duplicate settlement journal was added.

Local evidence for code `91f17842`: Marketplace/Billing focused tests **12/12**, Router license and
product path tests **38/38**, Shell catalog test **1/1**, Marketplace web/Portal/Shell/Marketplace
Worker/Router/Billing typechecks, environment resource tests **6/6**, deployment manifest tests
**7/7**, Wrangler isolation tests **6/6**, regenerated source inventory and `git diff --check`.
These checks use local mocks/static config. No provider checkout, live account, deployment or user
journey acceptance was exercised.

P17 remains PARTIAL. Marketplace and Shell use different origins and the current session has no
verified one-time handoff into a selected customer's product/Space; library state alone does not
complete installation. Refund-to-license revocation, author earning/payout recovery and dispute
policy remain unresolved under P20, and provider/live acceptance remains separate. Do not represent
the listing as installed merely because checkout returned or a fork row exists.

### §5 — developer-authored guided template installation: PARTIAL (current source reconciliation)

The old-checkout research described this customer journey as missing. Current source already has a
Marketplace-backed Space Template picker, listing identity through Space creation, signed/certified
blueprint preview, server-side dependency/runtime readiness, human approval, shared-filesystem
permission selection, resumable pending-template review, and idempotent activation/retry through
Space and extension journals. Managed AgentMail is a separately quoted owner action; template
selection does not provision it. Publisher trust and exact installed-release checks are recorded
under P24.

Codes `f5050258`, `b9ad2c83`, `5c7ba416`, `f725fa2c` and `9d0c2da7` add the bounded declarative setup
schema, owner value collection, conditional/localized fields, encrypted draft/resume, expected-usage
inputs, setup provenance/status, same-publisher update availability and host-certified fork checks.
Code `2901377e`, after `08c9e4b9`, makes the same installation-scoped host settings form reachable
from project extension management when an active package has no Canvas dashboard. Preview exposes
verified listing/permission/known-cost changes but does not apply them or provision provider
resources. Code `0f07a512` adds a separate setup-only migration preview/apply path: the Worker resolves
the newest same-publisher signed artifact; the owner/admin caller rechecks exact artifact/listing/schema
and setup-revision fences; the runtime package, dependencies and price must stay unchanged; SpaceDO
persists migrated setup values and an actor-attributed event. Drop operations require explicit
confirmation. Automatic rollback is not available.

Codes `536853b9` and `b646ec16` connect an unavailable exact-pinned required extension to the
owner-reviewed same-tenant cross-Space package import. The installer selects the source Space,
reviews every signed package/digest, copies the immutable closure, then separately reviews destination
authority and installs the exact root pin without folder grants. Source and destination admins and
active publisher trust are rechecked; publisher revocation after review prevents copy. Partial and
ambiguous imports can retry. The Shell currently keeps the import/install stage in page state, so
after reload the owner can query the persisted destination release through the read-only install
review and continue without repeating the source copy (`edf08814`).

Code `b3feecb5` adds visual authoring of bounded fields; `bf55151a` extends it to multiple selected
projects and separate validated setup groups, reusing the signed SDK schema and activation preview.
The editor still does not author dependencies/actions or prices.

§5 remains PARTIAL. This does not implement general package updates, changed-permission/pricing
approval, rollback, revocation/uninstall effects on generated projects/extensions/provider
resources/licenses and retained receipts, complete usage/provider/runtime rates, broader visual
authoring, or end-to-end live acceptance. Unknown rates remain unknown; these are not credential-only
gaps. No deployed Marketplace, DB, payment or provider acceptance is claimed.

### Prior P24 checkpoint (before `5f94c924`): scoped rollback and key-registry checks implemented

Code `415ba199` applies the current D1 publisher-key registry to installed pins, release listing,
blueprint export/preview/activation, workflow/channel execution admission and rollback. SpaceDO
rejects partial publisher attestation fields rather than treating them as a first-party release.
Rollback now identifies one installation by tenant, Space, project and instance ID, compares its
expected current release version, and changes only that installation pin. The Space-wide manifest
is left as the install catalog. The Shell release picker shows added permissions/capabilities; the
Worker re-computes the difference and requires an explicit approval. The supported channel and
Canvas/Gadget update callers use the same approval check.

The existing path still verifies P-256 publisher signatures during upload, stores immutable release
manifests/artifact digests and host attestations, checks exact artifacts at runtime, pins each
installation version and rechecks active publisher keys before applicable execution. Existing
publisher keys can be manually rotated by adding a new Space key and revoking the old one. Local
evidence: focused Spaces suites **67/67**, including exact rollback pin isolation, stale-version and
cross-tenant rejection, publisher metadata/revocation, access expansion acknowledgement, and lost
install retry returning the same installation ID; Spaces and Shell typechecks pass. These are
mocked/local checks only. No deployed Worker, R2 artifact, D1 key registry or provider acceptance was
tested.

At that checkpoint P24 remained partial: extension manifests had no transitive dependency resolver,
cross-Space restore, end-to-end Worker/R2 lost-response recovery, compromise notice, scanning,
retention or active-work drain. The current state and the dependency/retry work since then are recorded
at the top of this ledger; this section is retained as historical evidence, not current status.

## Current status index for P01–P24

The findings were researched against an older checkout. This index is the current source/caller
reconciliation; details and evidence remain in the corresponding sections above and the managed
S/U ledgers. `PARTIAL` means some current code is locally verified but an implementation, contract,
policy or acceptance gap remains. There is no live-accepted P requirement.

| Requirement | Current status | Reconciled state |
| --- | --- | --- |
| P01 | PARTIAL | Release runner, manifest and promotion health gates are local. Code `60c5f03b` makes validation require the manifest-selected migration phase to invoke the environment-specific runner/baseline and remote D1 probe. Operator-attested D1 baselines, isolated rehearsal, rollback/data recovery and deployed/live acceptance remain. |
| P02 | PARTIAL | Resource inventory/preflight is local and fail-closed. Code `174f092c` also verifies cross-script Durable Object targets have a named Worker owner in the same environment; all current targets resolve. Tests pass 11/11. The preflight still rejects 13 shared-resource findings, one unresolved `naelao-calls` owner and 158 missing read-only receipts; actual resource separation/ownership and deployed isolation remain external evidence gates. |
| P03 | PARTIAL | Durable dunning/outcomes exist; grace, restriction, escalation and live delivery policy remain undecided. |
| P04 | PARTIAL | Bounded encrypted archives include Space-local extension artifacts with checksum-checked partial retry; cross-Space signed package closure import is implemented under P24. Code `849bf78a` adds rolled-back per-table merge preview counts and durable applied skip counts; `6fccacaa` adds the owner/admin full-export caller with session-stored request-ID recovery. Archive caps, cross-service coverage, key/legal/jurisdiction policy and isolated/live recovery remain; archive envelopes stay bound to the original tenant/Space. |
| P05 | PARTIAL | `50dd1fa4` adds customer-form preview; `bf55151a` multi-project setup groups; `ed924c83`/`55d67648` trusted dependency selection and package feature disclosure; `56b23a31` persists/restores bounded Space-scoped authoring drafts; `236a2e2b` refreshes the activation usage projection while total cost stays unknown. Foundry `1.3.0` persists conformance/publication lifecycle: `34c7da23` host request/job/listing idempotency and owner status recovery, `64669caf` reload repair, `cf2d28f7` terminal status correction. `5e0c6501` adds owner-approved scoped text handles. `536853b9`/`b646ec16` connect activation to exact-pin dependency import; `edf08814` resumes install after reload; `a75c0862` provider cleanup; `c1c5e0d4` Telegram/WhatsApp setup compensation. Knowledge/action authoring has no matching SpaceBlueprint/runtime contract; complete provider setup, broader lifecycle, verified rates/total cost, image/audio/binary extension access and deployed/live acceptance remain. |
| P06 | PARTIAL | Owner voice, bounded keypad paths, signed handler discovery/readiness, cost observations and dated host-catalog list-rate estimates are local. The signed bounded-phone-menu example has per-installation settings, browser preview and a synthetic `call.received`/`call.digits` test through the host response validator/renderer; `b2d4ac0f` pins calls to the admitted installation/handler, and `4c42012b` exposes its exact signed release/key identity. This is keypad IVR support, not conversational streaming. Customer voice lifecycle, public streaming, managed billing, invoice reconciliation and live provider/region acceptance remain unavailable. |
| P07 | PARTIAL | Code `0da0abdb` adds local-machine owner-declared modality/context/tool profiles, exact authorized-machine lookup and capability-aware private model selection with no cloud discovery/fallback. Profiles are not independent quality evidence. Custom-model capability selection and deployed/provider acceptance remain. |
| P08 | PARTIAL | Audio-track transcription and bounded, task-authorized video-frame questions are implemented locally in `87374fc2`; deployed Container and Workers AI/provider acceptance remain. |
| P09 | PARTIAL | Imported model lifecycle exists; provider training submission remains disabled pending a verified product/provider contract. |
| P10 | PARTIAL | Signed Marketplace setup, validated setup forms/drafts and setup-only schema migrations are local. `c7412170` adds owner-approved paused version-only static Canvas/channel-code updates; `15a04f7e` adds runtime-work admission/drain; `0d121ab2` adds exact historical signed-release rollback for that bounded package class. `a75c0862` adds durable provider cleanup for direct disconnect and channel-package uninstall. Gadget/schema/data migration recovery, authority/dependency expansion, connection/price changes, scanning/retention and live acceptance remain. |
| P11 | PARTIAL | Development checkout is explicitly gated. `16386d95` adds signed, idempotent platform/Product-user price receipts and Marketplace provider/variant/amount/currency snapshots; live provider-to-entitlement acceptance remains. |
| P12 | PARTIAL | Versioned dunning contract, queue and workflow paths exist; business recovery policy and provider delivery acceptance remain. |
| P13 | PARTIAL | Honest interval-health observations/alerts persist; `4de53055`/`d640dbae` route unknown and malformed messages to their configured DLQs. Admin is not safely bound to those DLQs and generic replay remains uncoded; true provider depth/age/DLQ lacks a supported source. |
| P14 | PARTIAL | `product-end-user/logout` generation revocation and builder `/auth/revoke` are now awaited by reachable Portal/Shell/Dashboard callers; failures retain state and show retry. Product reset generation and DO cleanup are durable. localStorage bearer storage, cookie/CSRF/XSS transport decision and deployed copied-token acceptance remain. |
| P15 | PARTIAL | Indexed bounded Blackboard paging has local scale evidence; representative relevance, membership density and deployed acceptance remain. |
| P16 | PARTIAL | Shared Discord media bounds/disclosure plus P05's scoped text-only extension handles exist locally. Discord non-ephemeral ingress, image/audio/raw binary extension access and provider/live acceptance remain unsupported or unverified. |
| P17 | PARTIAL | Listing identity, freshness, purchase and install handoff are improved; cross-origin identity handoff and accounting policy remain. |
| P18 | PARTIAL | Product password reset advances security generation atomically; builder/device token and deployed acceptance gaps remain. |
| P19 | PARTIAL | Checked staging queue/workflow names and DLQs are separated from production; actual account resource identities and isolation receipts remain external. |
| P20 | PARTIAL | Idempotent refund review ledger and buyer/creator status exist; dispute, access reversal, author accounting and independent operator identity remain unresolved. |
| P21 | PARTIAL | Product-user and builder reset email use encrypted bounded outboxes, retry/cancellation, stable Notification IDs, provider acceptance receipts and HMAC-scoped metadata status. Builder Auth outbox is migration 0245 (`814c429a`); local Auth suite **39/39** and typecheck pass. Unverified-user/session policy, provider/inbox and deployed acceptance remain. |
| P22 | PARTIAL | Document/Space cleanup and semantic-cache deletion status are durable locally; AutoRAG provider-index deletion and deployed store acceptance remain unverified. |
| P23 | PARTIAL | Async and synchronous operation outcomes are persisted locally; approved retention, audited operator replay, remaining receipt coverage and provider/deployed live acceptance remain. |
| P24 | PARTIAL | Exact signed dependency review/install recovery, same-Space archive artifact restore, owner-authorized cross-Space package import (`b4cf5214`) connected to guided activation (`536853b9`), revoked-key recheck before copy (`b646ec16`), reload resume via destination install review (`edf08814`), paused static Canvas/channel-code update and exact historical rollback receipts (`c7412170`, `0d121ab2`), runtime-work admission/drain (`15a04f7e`), authenticated revocation receipts/readback (`f5b3c1dd`, `0ba70840`), and installed-package trust warning/revocation-aware Shell actions (`f3a04010`, `ad3888eb`) are local. Cross-tenant artifact rights, broader schema/data migration and rollback, proactive alert policy, scanning, retention and live acceptance remain. |

## Requirement queue

The platform plan's P01–P03, P11–P13, P17, P18/P20/P21 and P23 have now been reconciled against current source.
P02 remains fail-closed as recorded above. Continue in dependency order:

1. Preserve the P01/P02 preflight gates until distinct Cloudflare resources, service ownership,
   read-only resource receipts, and per-database baselines are verified. Do not invent them.
2. Preserve the explicit P03 grace/restriction and P20 refund/author-accounting decisions as open
   product contracts; advance only independent code while they are unresolved.
3. P04's bounded object-byte capture, checksum restore and durable partial retry path are implemented
   in pushed code `937fbdd5`; the focused SQLite/R2-mock suite passes **9/9**. P03/P20 independent
   customer/creator status callers are implemented in pushed code `41996f29`; grace/restriction and
   refund/dispute/payout policies plus authenticated operator identity remain unresolved. The
   managed-services ledger reconciles S2–S9/U01–U12, including supported U11/U12 caller audits; do not
   repeat those without new evidence. §5's bounded setup schema, draft/resume, installation status and
   per-installation extension settings migration are implemented locally. Code `c7412170` closes the
   current P10/P24 same-publisher version-only static Canvas/channel-code update receipt slice; runtime
   work admission/drain is in `15a04f7e`, and P04's owner export caller is in `6fccacaa`. Keep Gadget/
   data migration, authority, dependency, connection and price changes gated until their own
   review/migration/recovery paths exist. Foundry visual setup and durable conformance/publication
   recovery are implemented locally. §10.3's owner/admin policy gate is complete in `4c458a9e`; the
   assistant read caller and fresh pre-planning context are complete in `a6c3233a`, `d9733888` and
   `96c3da48`. Implement the active P05 connection-reference action from the top of this ledger. P22's
   independent local cache-entry purge and whole-Space cleanup status gaps are closed in `7b6942e8`;
   retain the exact provider/deployed evidence boundary and keep AutoRAG retrieval disabled.
4. P16's capability/limit disclosure code is committed, while scoped extension handles, ordinary
   non-ephemeral retrieval and live provider acceptance remain partial. P17's direct catalog, license
   status, return URL and Shell category-selection gaps are committed; preserve its cross-origin
   identity/install handoff and P20 accounting policy as open. P24's exact dependency closure, owner review, resumable receipt-gated install and same-Space archive artifact restore are in `61642261`; owner-authorized cross-Space package import is pushed in `b4cf5214`. Update/schema migration, active-work drain, key compromise notice, scanning, package retention and live acceptance remain open. P15's indexed path is
   implemented; realistic private-member density and task-quality evidence remain open. Reuse the
   S/U ledgers for overlapping requirements and do not repeat completed audits without a source
   change or specific evidence need.

Keep rollout disabled. Do not deploy, create resources, purchase services, or claim deployed/live
acceptance. Commit and push each coherent checkpoint to `origin/Mcbt5s-Backup-2` after fetching and
safely integrating any remote advances.
