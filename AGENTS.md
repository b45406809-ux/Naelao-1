# Autonomous managed-services and workspace implementation runbook

## Active mission and checkpoint

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
`171a3471`, `064efff8`, `fcc26543`, `e9df3da4`, `504a488e`, `daca80bd`, `6046eebc`, `f6abe44b`, `80cf3893`, `e3afe6a2`, `965aeb41`, `70c4fd05`, `e8aa765c`, `144c02f5`, `3d6edc9c`, `46d61a70`, `b62bb9ed`, `01326eca`, `91d12419` and `87a9be02`, plus docs checkpoints `8f9c0c15`,
`7e401225`, `1c32ef26`, `ece794ec`, `69fdb152` and `e2fadf8d` and `f5749bea`, are pushed there. Code checkpoints `b8399b4c` and `894ec60f` add fail-closed environment resource evidence and durable marketplace refund review cases. The recovery branch also contains requested plan commit `9e1281ce`. AgentMail provision/renewal and Cloudflare model replay
preserve consumed quote terms in their covered recovery paths. Managed Telnyx now persists the
owner-confirmed line rate version and exact rental/SMS/call prices, binds reservations and cost
receipts to those terms, and retries release of unused call holds. Telnyx/Higgsfield AgentPort share
revocations now persist exact account references and retry on the scheduled path; exact checks and
next task are recorded in the progress source.
Checkpoint (2026-11-12): **S0/S1 complete locally; S2/S3 IN_PROGRESS; S4–S9 and U01–U12 remain IN_PROGRESS.** Platform plan commit `9e1281ce` is integrated. P01/P02 remain partial: the migration runner validates 227 source hashes and stops before mutation without operator-attested legacy baselines; staging/production still share one D1 and eleven KV IDs, `naelao-calls` remains unresolved, and 62 resource receipts are missing. P20 `894ec60f` journals signed marketplace refund reviews but dispute ingestion, refund/author-clawback policy and resolution UX remain open. P18/P21 product-account recovery is implemented in code commit `6209569d`: authoritative Product account generations fence reset/logout/suspension sessions and stream tickets, D1 journals DO cleanup retry, and encrypted recovery-email outboxes keep public responses neutral and expose scoped safe status. Product pre-verification access remains per migration 0055's credit-grant gate. Fresh local checks: auth/session/DeskDrop integration **80/80**, Spaces **394/394**, Notifications **32/32**, affected typechecks, 227 migration hashes, and diff check pass. These are local mocks, not deployment, inbox delivery or live acceptance. Builder reset email remains best-effort and browser bearer tokens remain in localStorage. Exact next task: continue managed-services S3/U05–U07 and U01–U12 caller review, implement the next independent reachable gap, then proceed S4–S9 before P22. Preserve the pinned runtime's missing writer-admission/drain/handoff contract as an external gate. `infra/scripts/__pycache__/` remains untracked and preserved. Keep rollouts disabled; do not deploy or purchase.
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
