# Autonomous managed-services and workspace implementation runbook

## Active mission and checkpoint

Current continuation checkpoint (2026-11-13): guided-template draft/resume code `f5050258` is
pushed to `origin/Mcbt5s-Backup-2` from `autonomous-managed-services-20261111`. Migration 117 stores
owner setup drafts encrypted with tenant/Space-derived AES-GCM keys and binds them to the selected
Marketplace listing, signed artifact digest and setup-schema version/digest. The Spaces host verifies
the pending template and exact fork, restricts reads/writes to owners/admins, validates incomplete
values, and enforces optimistic revisions and explicit replacement after context changes. Shell
resumes drafts in the owner review flow; successful activation deletes the draft. Local/mock evidence:
Spaces draft/activation/migration tests **25/25**, Agent SDK schema tests **6/6**, Router product-path
tests **41/41**, Shell template test **1/1**, Spaces and Shell typechecks and `git diff --check`. The
pnpm workspace command attempted a dependency reinstall and aborted without a TTY; these checks used
already-installed binaries directly. No deployed database, marketplace payment or live provider was
exercised. §5 remains PARTIAL for conditional/localized fields, usage estimates/rate completeness and
package lifecycle/update/uninstall acceptance. Exact next task: extend the declarative setup-field
contract only with bounded, signed conditional/localization metadata and host-side validation, then
use the existing cost-estimate ledger to add explicit expected-usage inputs without inventing rates.

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
evidence. P24 remains PARTIAL for dependency closure, cross-Space artifact restoration, package
retention/compromise notices and drain receipts for already-admitted work. Preserve the unrelated
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

- Read the plan and progress before resuming. Reconcile earlier status with current source and
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
