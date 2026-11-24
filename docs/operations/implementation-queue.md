# Naelao implementation queue

This is the live checklist for one session working through one plan at a time. The latest confirmed
commit on `origin/Mcbt5s-Backup-2` is the recovery checkpoint; fetch the branch tip before resuming.
The new Tier 6 plan is active. The previous claims checkpoint at `2b80e458` had parked the
remaining functional claims workflow. Use the checklist and linked ledgers to determine readiness
and record a reason if the order changes.

## How to resume and advance

1. A new session can start with **start**. Follow the [startup instructions](../../AGENTS.md#start-or-resume)
   to recover the current checkout from `origin/Mcbt5s-Backup-2`, then use the queue entry and
   its latest checkpoint to choose exactly where to resume. Bring the AGENTS.md pointer into
   sync if it is stale.
2. When activating a plan, turn its remaining ready requirements into ordered checkboxes under that
   plan. Preserve the requirement IDs and use the linked ledger's verified status. Historical
   checkpoints can supply evidence. Use one task and one evidence entry for overlapping requirements.
3. After each finished task, check off its row and record a code commit or PR, relevant checks, and
   the level of acceptance in its linked ledger. A short queue entry can link to the ledger evidence.
   If code is ready and only live acceptance remains, track that acceptance as a distinct unchecked
   item. Keep every unfinished or blocked task unchecked.
4. Promote the next ready task from the same plan, update the single current pointer in AGENTS.md,
   and save the implementation and its handoff in the verified checkpoint history. Push authorized
   checkpoints to `Mcbt5s-Backup-2`, then continue with the task already selected. An interruption
   can resume from the same pointer without rereading the other plans.
5. Finish a plan when its tracked tasks are verified. If all remaining work in it is blocked,
   record the exact dependency and how to resume it, leave the plan unchecked, and proceed to the
   next ready plan. Clear the old active pointer when switching. Remove the Current task section
   from AGENTS.md only after the readiness review below. Recheck parked items when their recorded
   dependency changes.

## Before stopping for blockers

- Review all unchecked plan entries, including paused, parked and reconciled plans. Check the
  outstanding requirements against current source, the latest ledger evidence and the specific
  dependency. A plan label, a finished demo, or the end of the numbered list does not establish
  that its requirements are complete.
- Separate work that needs live access, external approval or an unresolved product decision
  from any independent local implementation, integration or verification. When local verification
  is authorized, a previous note that tests were not requested is historical context. Add relevant
  local checks to the queue and carry them out. Keep deployment and live acceptance open separately.
- Activate and continue the first ready item in queue order. If nothing can proceed, record the
  exact remaining dependency and resume condition for each parked plan. Report the status as
  blocked with work remaining. Mark the full queue complete only when every requirement is verified.

## Checkpoint format

Each checkpoint inside an open task should save a small, verified change and a handoff in the
same commit. Update the **Latest checkpoint** under the active plan with the task and slice,
what landed, what verification ran and its result, and the exact next action. Name a file,
function or verification command when that helps the next session pick up the work. Link
longer evidence in the task ledger, and keep older checkpoints in Git history or that ledger.
The containing commit identifies the checkpoint. Link earlier evidence commits where useful.

Keep the task unchecked between slices. Record a blocker only with the missing prerequisite,
the work already saved, and a condition for retrying. Preserve unpushed work when the checkout
survives. After local data loss, fetch the recovery branch and pick up from its latest saved
handoff. Anything that had yet to reach that branch may need to be redone.

## Active plan — Single Project Tier 6 runtime

See the [plan](../research/single-project-tier-6-runtime-plan.md). It governs S4 and related S3/U10
execution and erasure work. Reuse the managed-services ledger for overlapping evidence.

- [ ] **Active · SPR01 — Inventory and contract.** Trace all runtime starts, including attachment
  tools, extension tools, prewarm and restore, across Project and branch scopes. Map each caller
  to the main runtime, a container-free service, an explicit external tool, or historical cleanup.
  Record the first locally verifiable admission or routing gap and the existing erasure coverage.
- [ ] **SPR02 — One allocation and image profiles.** Enforce Project-wide admission across branches,
  select approved capabilities before starting, and fence image replacement and recovery.
- [ ] **SPR03 — Migrate native tool callers.** Route video audio, video frame, PDF and extension
  native processing through the Project runtime while preserving isolation and operation limits.
- [ ] **SPR04 — Retire direct specialist execution.** Stop new first-party specialist allocations
  after the replacement routes work. Preserve cleanup, reconciliation and erasure of old runtimes.
- [ ] **SPR05 — Local acceptance.** Verify concurrency, replacement, capability denial,
  explicit external tools, and erasure with safe fixtures.
- [ ] **SPR05 — Live acceptance.** Follow up when the replacement routes pass local checks
  and authorized Cloudflare lifecycle and erasure verification is available. Keep rollout gated.

**Latest checkpoint:** plan added after `2b80e458`. SPR01 is ready for local source work.
Start with the current Agents attachment and extension routes and the main runtime registry.

## Paused plan — Managed services and sidecar runtime

**Managed services and sidecar runtime.** See the [plan](../research/managed-services-and-sidecar-runtime-plan.md)
and [progress ledger](../research/managed-services-and-sidecar-implementation-progress.md).

- [x] **S/U · S1 — Reconcile current source and activate the first ready implementation gap.**
  Complete milestone S1 from the managed-services plan using this branch's current source; refresh
  coverage for plan sections 1–20 and inherited U01–U12, reusing later implementation evidence and
  marking policy/provider/deployment dependencies precisely. Keep gates disabled and preserve data.

- [x] **S/U · S3/U10 — Require registered host identity before Project runtime work.**
  `ToolSandboxDO.registerWorkspaceRuntime` now rejects a missing or mismatched host-derived name
  and fails closed if the Project runtime registry is unavailable. Agents typecheck and
  `git diff --check` pass; no tests, migration or deployment ran.

- [x] **S/U · S3/U10 — Finish the Project runtime erasure caller audit.**
  Project execution/workspace and sidecar artifact transfer/list/outcome routes register their exact
  host-derived Durable Object names. Direct Project video and scanned-PDF attachment routes now do
  the same for Media and Document sandboxes; Media identity validation matches its
  `attachment-media:…` name. D1 first-touch registration is conditional on no erasure tombstone.
  Feature-off private-state backup/restore, runtime snapshot references, cleanup namespaces,
  provider deletion queues and residual provider/historical namespace limits were reconciled in the
  progress ledger. Agents typecheck and `git diff --check` pass; no tests, migration or deployment ran.

- [ ] **Blocked · S/U · S3/U10 — Regional and deployed erasure acceptance.** The local caller audit
  is complete. Resume after jurisdiction-specific Sandboxes/D1/R2 configuration and access policy
  are approved and an authorized deployed erasure journey verifies each runtime receipt. Cloudflare
  exposes no supported physical snapshot purge in this code; provider snapshot deletion/expiry
  evidence remains separate. Historic sidecar Durable Objects created before registry registration
  cannot be enumerated through a namespace API, so inventory completeness for those objects also
  needs an accepted migration or provider-supported discovery path.

**S1 checkpoint:** the progress ledger now maps sections 1–20 to their owning implementation and
evidence records, and the U01–U12 matrix was reconciled against the current branch. U06–U08 remain
blocked on the absent supported runtime adapter/flush contract; U09's local private-state and
restart metadata remain feature-off; U11's supported cost alerts remain informational; U12's
dependency staging is wired. The source audit found one actionable U10 gap: current Project
execution/workspace callers send a host-derived object name, but `ToolSandboxDO.registerWorkspaceRuntime`
silently skips erasure registration if it is missing. Source review only; no tests, migrations,
deployment or live acceptance ran. This historical gap is fixed by the checked U10 checkpoints below.

**Latest S3/U10 checkpoint:** caller search also found direct Project video and scanned-PDF requests
to MediaSandboxDO and DocumentSandboxDO. Those routes now send the exact runtime identity, and
MediaSandboxDO validates its actual `attachment-media:…` Durable Object name. Runtime identity and
tombstone-conditional D1 registration now cover the reachable execution, workspace, artifact and
attachment paths. The source audit found no further local fix. Regional/deployed acceptance, physical
provider snapshot deletion evidence and discovery of historical unregistered sidecars remain
blocked as detailed above. **Next action:** no S/U source-only task is ready; resume this plan when
one of its recorded runtime, provider, policy or deployment dependencies changes, and recheck the
parked plans for newly ready work.

**S/U remaining-work review:** supported S2 account, grant and entitlement lanes are implemented
locally. U05/U06 still require a supported runtime transport contract; U09 backup use requires
approved key and jurisdiction bindings; U10 has only the regional/deployed/provider limits above;
U11 lacks authoritative invoice/billed-idle feeds and deployed cost measures; U12 awaits CI event
and image-parity evidence. Modal has a separately hosted, gated Node service and local journal, but
no Agents binding/caller or authoritative per-sandbox cost receipt. Its create path remains blocked
until pricing, metering and provider acceptance are defined. Other open S/U rows retain their exact
product, provider and live gates in the plan and progress ledger.

**Queue readiness:** PW worker-branch retention is blocked on owner policy. APW open work is blocked
on cost/quality, retention, task-control or staging acceptance contracts; APW07–APW09 point to
owning plans. S/U has no source-only task: regional/deployed erasure acceptance and historical
namespace discovery need jurisdiction/provider support. SC03 still lacks explicit durable native
invocation consent, alarm-safe current-authority revalidation and pre-dispatch Billing admission;
SC04 lacks owner-approved Space/Project caps. The Unified plan's current executable code work is
tracked by S/U, SC, PW, K, EP, TBR and P; its remaining workspace/runtime acceptance needs authorized
deployed/provider evidence. Preserve `infra/scripts/__pycache__/` and keep rollout defaults disabled.

## Paused plan — Mature Knowledge platform

**Mature Knowledge platform.** See the [plan](../research/mature-knowledge-platform-plan.md) and
[progress ledger](../research/mature-knowledge-platform-implementation-progress.md).

- [x] **K15 — Reconcile managed-index follow-up against scoped retrieval/deletion.** Current
  extension publication filtering and host rehydration are recorded in the K ledger and
  [follow-up](../extension-search.md#follow-up-for-managed-private-indexes). AI Search remains a
  disabled candidate; its metadata map, identifier/list limits, freshness and cleanup contract are
  not proven.
- [x] **K26 — Report actual bounded retrieval result counts.** RAG now emits hit counts on cached
  and uncached search events; Knowledge passes the count through the bounded privacy-safe telemetry
  and records it in Analytics Engine. RAG/Knowledge typechecks and `git diff --check` pass; no tests,
  deployment or live acceptance ran.
- [x] **K19 — Reconcile and fence the signed extension Knowledge search API.** The SDK result includes
  source content hash/revision and bounded citation coordinates. The Knowledge service now fails
  closed if document deletion or publication revision changes during retrieval. Knowledge typecheck
  and `git diff --check` pass; no tests, deployment or live acceptance ran.
- [x] **K18 — Add an owner-only collection-scoped search preview.** Project owners/admins can preview
  up to three passages against one exact published collection revision. The owner route and signed
  extension route share the same pre-ranked document fence, current source/chunk rehydration,
  deletion check and final publication revision fence; the Project Shell displays plain-text source
  passages and line/heading provenance. Knowledge typecheck and targeted Shell typecheck pass;
  `git diff --check` passes. Full Shell typecheck remains blocked by stale `.next/types` references
  to four missing routes. No tests, deployment or live acceptance ran.
- [x] **K20 — Fence Space-shared channel Knowledge grants at result handoff.** Channel dispatch now
  re-reads each used collection revision and the Space-shared installation grant immediately before
  passing passages to the extension runner. A changed or unavailable authority clears all retrieved
  context, records a failed dispatch, and requires human review. Agents typecheck and
  `git diff --check` pass; no tests, deployment or live acceptance ran.
- [x] **K26 — Instrument publication-scoped retrieval outcomes.** The shared extension/owner preview
  helper records fixed surface/outcome labels plus bounded latency and returned-hit count. It emits
  no query or tenant/Space/Project/publication/document/installation identifiers, and Analytics
  errors cannot alter retrieval. Knowledge typecheck and `git diff --check` pass; no tests,
  deployment or live acceptance ran.
- [x] **K21 — Add D1-backed result-cache freshness fencing.** Migration 0284 seeds and advances a
  per-tenant/Space source generation for canonical content, Space/member access, Project ACL,
  publication and website connection changes. Grounded KV and semantic-vector caches bind to the
  exact generation while preserving the separate deletion generation. Knowledge/RAG typechecks and
  `git diff --check` pass. No tests, migration apply, deployment or live acceptance ran; cache gates
  remain false.
- [ ] **Blocked · K21 — Deployed freshness acceptance.** Resume after separately authorized migration
  apply and deployed update/revocation/delete race evidence. Keep cache flags false until accepted.
- [ ] **Blocked · K20 — Agent semantic response-cache identity/effect contract.** Its caller currently
  provides only tenant/Space and query; session memory, Project/user/role and effect/extension-grant
  scope are absent. Resume when a host-owned contract can identify reusable read-only responses and
  their exact authority revisions. Keep both Agents and Knowledge cache flags false meanwhile.
- [ ] **Blocked · K15 — Implement and validate isolated managed-index adapter.** Resume after exact
  pre-retrieval scope fields and limits, current publication/source revision mapping, asynchronous
  deletion/retention and isolated cost evidence are established. Keep general user search on its
  current exact D1/Vectorize ACL paths and leave all provider gates off.

**Latest K21 checkpoint:** the D1 source-generation fence is implemented locally across current
content and D1 access/publication mutation paths. The shared Agents response cache remains disabled
because freshness does not establish safe caller/effect identity. No migration or deployment ran.
**Next action:** K21/K20 rollout acceptance remains parked. EP06's exact-install monthly credit and
unpriced resource-unit views are now complete locally; its remaining resource pricing/cap and
provider/live acceptance dependencies are recorded below.

## Paused plan — Extensible platform and managed resources

**Extensible platform and managed resources.** See the [plan](../research/extensible-platform-and-managed-resources-plan.md)
and [platform progress ledger](../research/platform-completion-and-guided-templates-progress.md).

- [x] **EP06 — Show exact-install current-month credit usage against its approved cap.** The owner
  usage route now returns the exact current installation budget revision, month-to-date settled
  `infra_credits`, unexpired held reservations and remaining cap under Billing's UTC month window.
  It uses tenant/Space/Project/install filters. Spaces typecheck and `git diff --check` pass; targeted
  Shell typecheck passes. Full Shell typecheck remains blocked by four stale `.next/types` route refs.
  No tests, deployment or live acceptance ran; resource gates remain off.
- [x] **EP06 — Show exact-install unpriced resource-unit totals.** The owner view now reports this
  UTC month's `extension_resource_requests` as invocations, `extension_resource_jobs` as job units,
  and `extension_resource_bytes` as request/response payload bytes, all scoped to the exact
  tenant/Space/Project/install. No provider cost is inferred.
- [ ] **Blocked · EP06 — Cross-resource quotes and reservations.** Workflow credits are admitted and
  settled through Billing, while resource invocations, job units and payload bytes are recorded
  separately as unpriced usage after the effect. There is no approved resource-unit price or unit-cap
  contract from which to calculate a safe cross-resource quote. Resume after the owner-approved
  resource pricing/cap contract exists; do not convert units into credits locally.
- [ ] **Blocked · EP06 — Provider cost and deployed lifecycle acceptance.** Owner inventory exposes
  declared/current provider connections, cleanup receipts and bounded job receipts. Provider invoices,
  shared-overhead reconciliation and deployed cleanup/export/uninstall outcomes need authorized
  provider and live acceptance evidence.

**Latest EP06 checkpoint:** the owner view reports exact-install UTC-month settled and held internal
credits, approved cap/revision, invocation totals, job units and request/response payload bytes. The
Spaces worker and targeted Shell typechecks plus `git diff --check` pass. The full Shell typecheck is
still blocked by stale generated `.next/types` references. No tests, migration, deployment, provider
call or live acceptance ran; resource gates remain off.
**Next action:** park EP06's remaining cross-resource pricing/cap and provider/live evidence gates;
resume the active plan shown below.

## Previous plan checkpoint — Template business roles and member onboarding

**Template business roles and member onboarding.** See the [plan](../research/template-business-roles-and-member-onboarding-plan.md)
and [progress ledger](../research/template-business-roles-and-member-onboarding-progress.md).

- [x] **TBR11 — Reconcile direct scheduled-script run-budget admission.** Source inspection found
  the script can invoke nested operations; its Project daily-cap hold is fixed at one credit and is
  created only when that cap is enabled. `settle_run` does not enforce the hold amount, while direct
  jobs cannot receive `max_run_credits` through the owner API. A run-only hold cannot bound nested
  effects, so the scheduled identity/revision alone is insufficient for a consumed per-run ceiling.
- [ ] **Blocked · TBR11 — Atomic per-effect scheduled-script ceiling.** Resume after a host contract
  can bind an owner-approved direct-job ceiling to exact current job identity/revision and consume it
  across nested effects before each effect. Reconciliation must preserve unknown outcomes and actual
  usage; do not borrow creator/owner grants or treat the current post-run usage tally as admission.
- [x] **TBR12 — Prevent duplicate member-onboarding actions.** `SpaceMemberOnboardingPanel` now
  locks concurrent invitation/proposal mutations, disables repeated submit/revoke actions, labels
  the active action, and sets `aria-busy` on the active form/button. The targeted Shell typecheck and
  `git diff --check` pass; no tests, browser, deployment or live acceptance ran.
- [x] **TBR08 — Audit acting-member assistant clamps at extension-resource dispatch.** The current
  Project effective role now gates typed workflow resource operations and direct Gadget operations
  at Agents dispatch: viewers can use only exact read operations; writes and unknown mappings deny.
  Space-only answer caches were removed from `/agent/run` and Knowledge search because they could
  return answers across Project/role scopes. The remaining grounded-result cache includes Project,
  role and user. Agents/Knowledge typechecks and `git diff --check` pass; no tests, deployment,
  provider call or live acceptance ran.

**Latest TBR08 checkpoint:** `WorkflowRunDO` revalidates its actor, membership and installation on
each effect. The Agent host then resolves the current Project role through `enforceRunGates` before
dispatch. Previously the direct `extension.resource.*` and `extension.gadget.*` branches bypassed
the viewer filter in `ScriptToolSurface`; they now allow only exact reads for viewers. The
Space-scoped semantic full-response cache also bypassed that host gate and could return another
actor's Project data; `/agent/run` no longer reads or writes that shared response cache. Knowledge
search also stopped reading its legacy tenant/Space-only answer cache, whose Vectorize filter
omitted Project, role and user. Its grounded-result cache still keys by exact Project, role-rank and
user. TBR08 remains PARTIAL for other channel, provider, cache and delegation surfaces. TBR11's
direct-script ceiling remains blocked on an owner-approved per-effect admission contract.

**Next action:** continue with P05 from the ordered platform plan: trace whether current host
authority can represent Space-shared provider connections across signed dependencies, activation,
owner selection and revocation; do not infer beneficiary, payer or shared authority.

## Parked plan — Platform completion and guided templates

**Platform completion and guided templates.** See the
[plan](../research/platform-completion-and-guided-templates-plan.md) and
[progress ledger](../research/platform-completion-and-guided-templates-progress.md).

- [x] **P05 — Trace Space-shared provider-connection scope.** Reconcile signed Blueprint
  dependencies, activation, owner connection selection and revocation against current host
  authority. **Latest checkpoint:** source trace complete; current records cannot express a safe
  Space-wide connection. See the P05 ledger entry. Keep the broader P05 requirement partial and
  the provider path gated.
- [x] **P06 — Continue the bounded customer voice-package caller.** Reconcile the installed signed
  phone package's owner dashboard and operations against current installation, line, call-pin and
  provider records. The source trace found the existing bounded scope already covers owner-published
  settings, revision history/rollback drafts, synthetic scenarios and exact-install line/call/cost
  status. P06 remains partial for first-party signed distribution/catalog, managed provisioning,
  verified cost/quality and deployed carrier acceptance; those need publisher/provider evidence.
- [x] **P07 — Fail closed on custom worker-model capability claims.** Reconcile the custom-model
  manifest and worker-selection/resume paths. A custom model has no trusted modality/context/tool
  profile today; do not infer capability from its base model or adapter ID. Enforce current private
  route and required-capability fences after saved-session model restoration. The host now rejects
  unsupported required-capability selections, prevents resumed worker settings from changing a
  local-only or BYOK route, and rechecks current model evidence after restoration. Custom-model
  capability selection itself remains unavailable.
- [x] **P08 — Reconcile bounded sampled-frame authorization and quota.** Trace current attachment
  ownership, owner opt-in, feature gate, egress, size/time limits and OCR/visual quota at the route
  and provider handoff. The route now rechecks active Space/tenant, current owner opt-in and egress,
  and the exact unexpired task attachment before media extraction, after extraction and immediately
  before model dispatch. P08 remains partial for deployed MediaSandbox/Workers AI and provider
  acceptance; no gate was enabled.
- [x] **P09 — Reconcile the disabled provider-training action.** Verify imports and every reachable
  `submit_training` caller against the current provider API/account, consent, dataset deletion,
  evaluation and billing contract. The owner lifecycle route reaches SpaceDO, which returns an
  explicit `training_unavailable` 501; import remains a separate existing-adapter path. No provider
  training API or billing call is reachable. P09 remains partial pending a verified provider/account,
  consent/data lifecycle, evaluation and billing contract.
- [x] **P10 — Reconcile signed extension update recovery.** Trace reachable Space-shared and
  Project-bound owner review/apply/status/recovery callers against exact publisher, installation,
  generation, dependency, runtime-drain and update-receipt fences. Implement a missing recovery slice
  only where current records enforce it; preserve unsupported migration/authority changes as gated.

**P10 checkpoint:** Space-shared review binds the signed source/candidate and exact installation; apply
rechecks the current paused version, publisher, candidate artifact, dependency closure and runtime
drain. Gadget migrations use deterministic operation keys and MicroApp receipts; the final pin change
and update receipt are atomic. Owner status lists durable receipts, and a retry with the same review
token returns the matching receipt. Project review/apply binds installation generation, source and
candidate manifest/artifact, publisher key, request ID and runtime drain. The reachable resume action
discovers staged receipts and revalidates the exact staged generation, both signed releases, compiled
artifacts and active publisher key before issuing a fresh token for the same request. Project recovery
is intentionally bound to the original receipt actor; another owner/admin cannot take over without a
separate authority contract. No current-record recovery slice was missing, so no code changed. P10/P24
remain partial for broader authority/connection/price changes, migration policy, cross-tenant artifact
rights, scanning/retention and deployed/live acceptance. Evidence is in the P ledger's P10 checkpoint.

**Parked requirements:** P01/P02 still need operator-attested resource separation, read-only receipts,
per-D1 baselines and deployed isolation; P03/P20 need product policy; P05/P06/P09 need verified
provider/marketplace terms, account and pricing contracts; P07 needs trusted custom-model capability
profiles; P08/P10/P24 retain provider/deployed acceptance and the broader lifecycle contracts. The
remaining P01–P24 dependencies are itemized in the linked progress ledger's current status index.
No additional local source-only P task is ready. Resume when a listed contract/evidence dependency
changes or relevant source changes.

## Reconciled plan — AgentPort managed messaging providers

See the [plan](../research/agentport-messaging-providers-managed-resale-plan.md) and [progress
ledger](../research/agentport-messaging-providers-managed-resale-progress.md).

- [x] **Reconcile current AgentPort and messaging callers.** Trace provider adapter and reachable
  channel/event/session, consent, owner credential, billing, Knowledge and deletion paths against
  the current managed-services, channel, extension and shared-compute records. Separate code gaps
  supported by current authority from provider agreement, account, pricing, jurisdiction and live
  acceptance gates. Do not provision accounts, send messages, buy service or enable a provider.

**Latest checkpoint:** current source has declaration-only generic provider metadata, a disabled
native Cloudflare Email lane, and reachable AgentMail and Telnyx-specific paths. AgentMail event
dispatch carries references and checks owner-selected routes; local unlink clears saved credentials
and revokes AgentPort access but does not erase upstream provider data. No ClawMessenger, Linq, Photon
or Sendblue adapter exists, and no current authority or records support implementing one. No tests or
typechecks ran; `git diff --check` passed. Evidence: the AgentPort messaging progress ledger.
**Next action:** reconcile AP01–AP06 against this branch's provider-neutral SDK, verified-capability
UI and AgentPhone gates. Keep AgentPhone absent and unavailable without verified provider evidence.

## Reconciled plan — AgentPhone and AgentPort adapter evaluation

See the [plan](../research/agentphone-agentport-adapter-evaluation-plan.md) and [progress
ledger](../research/agentphone-agentport-adapter-evaluation-progress.md).

- [x] **AP01–AP06 — Reconcile current capability, SDK and setup surfaces.** The generic operator-
  verified capability gate, provider-neutral typed AgentPort metadata and owner setup-scope UI are
  present. No AgentPhone adapter or current verified provider evidence exists; AP02–AP05 and live
  AP06 acceptance remain provider/API/commercial gates.

**Latest checkpoint:** current source corrects the ledger's stale AP06 generic-code-gap label.
ManagedServicesPanel shows only the newest currently verified capability and explicitly separates
scope from connection/live availability. SDK discovery is provider-declaration metadata only. No
AgentPhone support was found; Telnyx managed and streaming gates remain false. No tests or typechecks
ran; no provider action occurred. Evidence: the AP progress ledger.
**Next action:** continue with the ordered WhatsApp member-routing and extension-testing plan; trace
the actual inbound caller and current identity/extension authority before selecting code work.

## Paused plan — WhatsApp member routing and extension testing

See the [plan](../../new%20plan/WHATSAPP-MEMBER-ROUTING-AND-EXTENSION-TESTING-PLAN.md).

- [x] **Reconcile current WhatsApp member, customer and test routing.** Trace the current shared
  inbound pairing, provider webhook, contact verification, membership/Project checks, extension
  execution, simulation and replay callers. The source review and first supported inbound-routing
  fixes are recorded in the [progress ledger](../research/whatsapp-member-routing-and-extension-testing-progress.md).

- [x] **Add one-turn customer extension simulation.** The Channels panel now runs the exact active
  WhatsApp handler through the no-capability isolate for an owner/admin with project access. Reply,
  answer-request and session-update outputs are staged for display; Knowledge/model answering,
  attachment reads, provider delivery and persistent session writes are excluded. Agent and
  targeted Shell typechecks passed; the full Shell typecheck still reports stale `.next/types`
  imports for missing generated routes. No tests, provider actions or deployment ran.

- [x] **Add member grants and verified contact routing.** Requires a multi-Space/project sender
  selection model that preserves the plan's per-member identity and current membership checks; do
  not reuse executive contacts or infer ownership from pairing.

  - [x] Add admin-managed WhatsApp member grants for Space or exact Project scope, including
    revisioned audit events. This grants record is not yet used to route inbound messages.
  - [x] Add member-started, short-lived single-use contact verification and a separate hashed
    multi-Space sender map. The signed inbound code proves contact control and binds the sender to
    the requesting member and Space; it does not use pairing or executive-contact records.
  - [x] Route verified senders to the current granted Space/Project assistant. Multiple choices
    require a sender-scoped, 30-minute `USE` selection. The Agent DO rechecks the exact contact,
    grant, Space membership, channel state, Project membership and current selection before
    transcript persistence, assistant execution and reply delivery.
  - [x] Add owner/member setup and route visibility, and an explicit Customer service only versus
    Staff and customers connection mode. The Channels panel manages exact-scope grants, self
    verification/replacement/revocation, current route selection and last successful use. The
    connection mode gates member and executive routing; customer-only inbound uses the customer
    extension path or remains in human review.

- [x] **Add isolated conversation replay.** The owner/admin Project inbox now replays a selected
  WhatsApp event through the current signed installation in a fresh isolate conversation. Active
  settings and optional current session state are snapshotted; edited input is transient. Replies,
  answer requests, Knowledge and tool behavior are staged through no-op simulation adapters. No
  provider effects or session writes run. The audit retains only bounded metadata and conversation
  deletion clears linked audit rows. Agents/Spaces typechecks and `git diff --check` pass; full Shell
  typecheck reports only stale `.next/types` imports for four missing routes. No tests, migration,
  provider action or deployment ran.

- [x] **Add a customer-service WhatsApp SDK example.** Build a versioned channel-only package
  example with owner-approved scoped Knowledge, bounded session state, staff escalation through the
  host inbox and documentation of the synthetic test/replay surfaces. Do not include provider
  credentials or claim unverified live behavior.

- [ ] **Add bounded WhatsApp member phone testing.** Offer an optional, expiring single-use entry
  challenge for an authenticated member's verified sender, exact destination, Project and active
  extension installation. Keep every test turn on the customer handler before privileged routing;
  support explicit exit/revocation and show test status in the dashboard and chat.

  - [x] Implement source routing and status. Redemption runs before pairing, verification, member
    selection and executive commands. Test turns use their pinned customer handler and an isolated
    conversation/memory scope; the Agent DO rechecks current membership, grant, contact, destination,
    channel binding and installed version before handling and delivery. Explicit chat/dashboard exit,
    access-change revocation, retry receipts, inbox marking and chat labels are wired.
  - [ ] **Blocked — focused tests and accepted live phone test.** Resume after the user asks for test
    work and separately authorizes applying migration `0289` plus provider/UI acceptance with a
    configured test account. No migration, provider message or deployment has run.

**Latest checkpoint:** source implementation now redeems challenges on the signed WhatsApp platform
webhook before pairing, verification, member route selection or executive commands. Active turns
forward only to the pinned customer handler with executive routing disabled and a separate Agent DO
conversation/memory scope. The Agent DO revalidates the contact, grant, Space/Project membership,
exact channel binding, test expiry and installed package version before handling and again before
answer, delivery and state persistence. Chat shows active/exit labels, the Project inbox marks test
events, and contact/grant/mode/channel/extension changes close active sessions and consume pending
challenges. Provider retry receipts retain only HMAC event keys for seven days. Migration `0289`
remains unapplied. Agents typecheck and `git diff --check` pass; full Shell typecheck reports only the
four known stale `.next/types` imports for missing routes. No tests, provider action or deployment ran.
**Next action:** focused test coverage and authorized live phone-test acceptance remain blocked; the
queue advances to commercial cleaning template source reconciliation.

## Paused plan — Commercial cleaning Space template

See the [plan](../research/commercial-cleaning-space-template-plan.md) and [progress ledger](../research/commercial-cleaning-space-template-progress.md).

- [x] **Reconcile the existing Space Template and extension source.** The SDK has a portable,
  secret-free `SpaceBlueprint` contract and a private reference-template pattern. No commercial
  cleaning template, domain records, or operational integrations exist. Marketplace and runtime
  machinery is generic; it does not prove an installed vertical workflow. The source map and exact
  first slice are recorded in the progress ledger.
- [x] **Add the first fictional operations demo Blueprint.** Use one pilot project with synthetic
  site, scope, shift, inspection and blocked-work records plus a review packet. Keep it data-only:
  no credentials, connections, access grants, purchases, live sends or safety instructions. The SDK
  typecheck and `git diff --check` pass; no tests or activation ran.
- [ ] **Blocked — operational workflow and pilot validation.** Resume after practitioner discovery
  establishes the approved site/visit/correction records and transitions, and focused tests are
  requested. Partner contact, payment, provider setup and deployed acceptance remain separately
  unauthorized.

**Latest checkpoint:** added and exported the private `COMMERCIAL_CLEANING_OPERATIONS_SPACE_TEMPLATE`
with synthetic site, scope, shift, blocked task, inspection, exception and unsent client-update
fixtures. It has no credentials, connectors, permissions or live writes. SDK typecheck and
`git diff --check` pass. No tests, activation, partner contact, payment or provider operation ran.
**Next action:** wait for practitioner-approved operational records/transitions and requested test
coverage before extending this vertical workflow. The queue advances to the corporate-recovery
claims prototype.

## Paused plan — Corporate recovery claims prototype

See the [plan](../research/corporate-recovery-claims-prototype-plan.md) and [progress ledger](../research/corporate-recovery-claims-prototype-progress.md).

- [x] **Reconcile the current template, document and evidence source.** No vertical claims register,
  correction workflow, page-provenance store or brief generator exists. Generic Knowledge, document
  and artifact services do not establish those behaviors. The source map and partner/legal gates are
  recorded in the progress ledger.
- [x] **Add a private synthetic claims-review demo Blueprint.** Include the fictional claim/ledger
  variance, duplicate reference, missing document, ambiguous field, second currency and a review
  packet. Label legal/status conventions illustrative. Keep it data-only without real parsing,
  persistence, permissions, legal decisions, credentials or external effects. The exported SDK
  Blueprint includes source-indexed fictional fixtures, a USD 6,000 variance, explicit missing
  delivery record, duplicate candidate, unreadable invoice suffix, separate EUR claim, illustrative
  status labels and draft meeting brief. SDK typecheck and `git diff --check` pass; no tests ran.
- [ ] **Blocked — Functional claims register and evidence workflow.** The plan's import, correction
  history, role isolation, revised brief and export require a separate source design beyond the
  static data-only Blueprint. Resume after the owner selects that functional scope and practitioners
  validate the status/checklist language and access contract; request focused tests before making
  behavioral guarantees. No practitioner contact or real data is authorized.

**Latest checkpoint:** added and exported `CORPORATE_RECOVERY_CLAIMS_DEMO_SPACE_TEMPLATE` with
fictional claim and ledger records, page/excerpt references, an explicit missing delivery item,
ambiguous invoice suffix, duplicate candidate, separate-currency example and simulation-only review
packet. Ledger rows reconcile to USD 42,000; the displayed variance is USD 6,000. The SDK typecheck
and `git diff --check` pass. No tests, practitioner contact, real data, listing, payment or live
effect ran. **Next action:** hold functional workflow work until its scope, practitioner-validated
status/checklist language and access contract are approved, then request focused test coverage.

## Previous plan checkpoint — Resumable workers, durable workflows and branches

See the [plan](../research/resumable-workers-durable-workflows-and-branches-plan.md) and
[progress ledger](../research/resumable-workers-durable-workflows-and-branches-progress.md).

- [x] **PW01–PW06 — Source-to-ledger reconciliation.** Current code matches the saved summaries for
  branch/runtime routing, goal graph and signed communication, named leases, checked integration,
  per-attempt usage receipts, and exact-attempt publication permits. Remaining gaps and the source
  evidence are in the PW ledger. No runtime/deployed acceptance is inferred.
- [x] **PW06 — Direct scheduled-script pre-effect revision fence.** After policy and Project spend
  admission, the direct scheduled-script path rechecks the persisted service session and exact
  enabled job revision/script immediately before `tools.run`. A stale or unavailable authority
  attempts zero settlement for the Project spend reservation and fails closed. Agents typecheck and
  `git diff --check` pass; no tests or deployed acceptance ran. This fence cannot cancel an operation
  after it starts.
- [x] **PW06 — Scheduled direct-script outcome reconciliation.** Before direct dispatch, one D1 batch
  records the exact run identity, authorization revision and bounded attempt receipt in both the
  dispatch claim and run history with `outcome_unknown`. Later sweeps stay blocked until an
  owner/admin resolves that exact run with evidence. Ambiguous responses and script-level failures
  remain unknown; no provider rollback or completion is inferred. Agents and Spaces typechecks,
  Shell source-only typecheck and `git diff --check` pass; no tests or deployed acceptance ran.
- [x] **PW01 — Require an immutable Coordinator base for Project worker branches.** Project worker
  spawning now requires the unified-workspace flag and Coordinator binding before reserving the
  parent task branch; worker-branch reservation repeats the guard. The legacy R2 seed path cannot
  dispatch a Project worker. Agents typecheck and `git diff --check` pass; no tests or deployed
  acceptance ran.
- [ ] **Blocked · PW01 — Worker-branch retention and deletion semantics.** The current ledgers do
  not define an approved branch TTL or deletion policy. Preserve staged branch content; resume when
  the applicable owner approves retention, cleanup and recovery semantics.
- [x] **PW02 — Correlate directed help requests with durable replies.** Task-blackboard messages can
  include an authenticated reply reference. The transaction checks the original question/blocker
  was addressed to the replying worker and the reply includes the original sender; existing host
  recipient grants still apply. Original and reply messages remain separate durable records, and
  goal activity UI displays the linked request. Agents typecheck, Shell source-only typecheck and
  `git diff --check` pass; no tests or deployed acceptance ran.
- [x] **PW02 — Recheck private-Project access for goal activity messages.** The route now forwards
  the authenticated caller role and AgentDO rechecks current Project read scope before projecting
  each Project-backed goal. Revoked/denied scopes omit that complete goal; thrown authority errors
  return 503. Agents worker typecheck and `git diff --check` pass; no tests or deployed acceptance
  ran.

**PW02 checkpoint.** Goal Activity now revalidates the actor's current Project read scope inside
`NaelaoAgentDO.handleGoalActivity` before reading and returning a Project-backed journal, task
projection or blackboard messages. The authenticated route forwards the caller role for the
membership and Project authority check. A denied scope filters the entire goal; an authority
exception returns 503. Agents worker typecheck and `git diff --check` pass. No tests, deployment or
live acceptance ran.

The PW plan has no remaining ready task: worker-branch retention/deletion remains blocked pending
an approved owner policy. The APW plan remains parked because its open cost, retention and live
acceptance work has explicit dependencies, while APW07–APW09 overlaps owning plans. The next plan
in the ordered list is S/U.

## Parked plan — Adaptive planner, worker coordination and memory

**Adaptive planner, worker coordination and memory.** See the [plan](../research/adaptive-planner-worker-swarm-memory-plan.md)
and [progress ledger](../research/adaptive-planner-worker-swarm-memory-progress.md). APW01 was
reconciled in that ledger. Existing partial implementations remain recorded there.

- [x] **APW02 — Host admission for dynamic goal graph expansion.** Structured proposals can add at
  most three one-level children under the 12-task graph limit. The host derives stable child identity
  and authority, checks the parent's unused worker-token budget, actor scope, decision references and
  Billing path at admission, then rechecks authorization, decisions and Billing path at dispatch.
  It persists task membership/grants and serializes admissions against the graph limit. Expansion remains disabled
  unless explicitly enabled. See the APW ledger's 2026-11-23 checkpoint.
- [x] **APW02 — Goal-run evidence joins and report-only routing history.** Verification, queue/execution
  timing, worker model tokens/budget and internal-credit usage now join through stable task worker IDs.
  Progressive concurrency changes retain a bounded 32-entry journal history with the triggering task
  outcome and verification outcome where available. This is report-only; no routing behavior changed.
- [ ] **Blocked · APW02 — Cost-aware routing selection.** Do not tune concurrency from internal credits
  until a per-goal spend objective and a controlled quality/cost comparison baseline are defined. The
  current receipts are observable, but include unpriced events and do not represent provider invoices.
  Resume after the comparative evaluation contract supplies those inputs; keep progressive routing
  disabled meanwhile.
- [x] **APW02 — Hierarchical planner tree.** Root graphs admit at most four depth-two planners;
  nested planners can create leaf tasks only. Each graph remains capped at 12 tasks, and nested child
  task-token allocations sum within the assigned parent-task ceiling. The delegated child receives
  that assigned ceiling in its host context; signed scope and caller authorization remain inherited.
- [x] **APW02 — Safe cancellation of redundant workers.** Explicit independent `redundancy_group`s can
  stop remaining work after a completed and verified result. Dispatch cancellation is fenced in the
  durable outbox and exact-attempt child start check; late results and uncertain effects remain visible.
  `GOAL_REDUNDANT_CANCELLATION_ENABLED` is off by default.
- [x] **APW02 — Comparative protocol and deterministic fixture.** The paired protocol and local
  scheduler/evidence fixture compare one-worker, sequential and adaptive arms with synthetic tasks,
  host evidence, lost-ack recovery, latency and resource exclusion. It records no model-quality,
  provider-cost or deployed-runtime claim. See the [protocol](../benchmarks/adaptive-goal-routing-comparative-protocol.md)
  and APW ledger follow-up.
- [ ] **Blocked · APW02 — Real-runtime/provider comparative acceptance and cost-aware routing.** Resume
  after staging runtime/provider access is available, a per-goal spend ceiling and quality/latency
  thresholds are approved, a powered representative task set and blinded rubric are frozen, and
  provider usage can be reconciled to invoices. Keep progressive routing, dynamic expansion and
  redundant-worker cancellation disabled until separately accepted and authorized.
- [x] **APW03 — Goal task branch lineage projection.** Goal activity now joins the exact worker row
  only after checking parent-run, tenant, Space, actor and Project scope. It shows the branch base,
  recorded checkpoint pin, checked validation receipts and publication attempt status without
  exposing worker output. The UI labels the checkpoint as recorded and not rechecked for freshness.
  See the APW03 ledger follow-up.
- [x] **APW03 — Conflict review and owner decision controls.** The existing worker conflict receipt
  already has fresh version previews, expected-hash checks, reviewer-authored resolution and checked
  publication. Added a Project Journal decision register panel with exact-revision approve/reject,
  explicit supersession and workspace-pin rechecks. Stale proposals can be rejected, never approved.
  See the APW03 ledger follow-up.
- [x] **APW04 — Memory source provenance audit.** Knowledge source adapter,
  source revision, source hash, grant revision and chunk hash now flow through scoped search,
  citations and agent citation metadata. Project, Space and personal memory adapters expose stable
  row IDs and update/create timestamps but no content revision/hash; those exact gaps are in the APW
  ledger. Local/mock verification is recorded in the APW ledger; timestamps remain freshness
  metadata, not immutable revisions.
  See the APW ledger follow-up.
- [x] **APW04 — Retention invalidation and context privacy evaluation.** Recall validates promoted
  semantic vectors against live actor-scoped SQLite rows, so failed vector cleanup cannot restore a
  deleted note. Local tests also cover bounded actor-filtered ingress, role-gated facts, denial of
  Project Knowledge retrieval before search without membership, and isolation of fact/Fabric/Wiki
  recall between Projects. See the APW ledger follow-ups.
- [ ] **Blocked · APW04 — Retention schedule approval.** Personal and Project Fabric/Wiki plus
  promoted vectors have no approved TTL or erase schedule; current code only decays facts and caps
  unpromoted episodes. Resume after a retention owner approves per-class duration and deletion
  semantics. Do not introduce a new expiry without that policy.
- [x] **APW05 — Goal/task and runtime admission/accounting comparison.** Goal workers inherit bounded
  token budgets and ordinary model calls reserve against configured Project spend caps or plan token
  quotas; System One decisions use separate durable Billing holds. These do not define an aggregate
  per-goal credit ceiling. Dynamic extension workflows have owner-set
  run/monthly credit budgets and durable reservations; default AgentTaskWorkflow initializes its
  workflow journal without a run-credit budget. Its optional session ceiling is checked before a
  run and incremented after settlement, not atomically reserved. Shared compute enforces configured
  global/tenant limits and has hierarchical tenant/Space/Project/actor promotion, but no task
  priority weights. Exact path comparison and blockers are recorded in the APW ledger.
- [ ] **Blocked · APW05 — Aggregate goal credits and cost-aware scheduling.** No approved per-goal
  or per-task credit ceiling, cost/quality objective, or task-priority weights exist. Resume after
  those policies and their exact Billing reservation contract are approved; keep model/runtime
  cost selection and automatic thrash control disabled meanwhile.
- [ ] **Blocked · APW05 — Provider USD acceptance.** Internal credits and per-inference price
  snapshots are not invoice-reconciled provider charges. Resume with staging/provider access,
  representative controlled task runs, approved thresholds and reconciled invoices; reuse the APW02
  comparative protocol and blocker rather than duplicating its evaluation.
- [x] **APW06 — Goal decision-hold remediation.** Goal task rows map stale/missing decision reasons,
  display the exact referenced IDs/revisions and link directly to the Project Journal review panel.
  The link does not mutate or resume the task; the existing Project route rechecks current access,
  proposal revision and workspace pin. Source-only Shell typecheck and `git diff --check` pass;
  local UI evidence only, no browser/deployed acceptance.
- [x] **APW06 — Authorized conversation stop control.** The processing-task stop sends the task/run
  ID through the existing conversation-scoped cancel route. The route requires Space membership or
  access to that exact session; AgentDO persists `cancelling`, signals the active operation and the
  loop checks cancellation at step boundaries. The UI warns that in-flight work may finish or be
  interrupted, committed external effects are not undone, and the final result must be reviewed
  before retry. Project task activity remains read-only for run control.
- [ ] **Blocked · APW06 — Project task pause/cancel controls.** Project list/detail authorization
  permits status viewing, not mutation. The generic `WorkflowRunDO.cancel` path is not public and
  can terminate a workflow without reconciling `TaskDO`; goal-DAG cancellation is only for redundant
  workers. Resume after an owner/admin authority contract and a durable task/workflow cancellation
  receipt define status reconciliation and uncertain-effect review. Keep Project task controls
  read-only until then.
- [ ] **Blocked · APW06 — Topology and budget preferences.** User/admin preferences need an approved
  authority and precedence contract before changing worker count, model/runtime routing or budget.
  Resume when that contract is approved; keep existing rollout defaults unchanged.
- [ ] **Blocked · APW06 — Real-runtime/deployed acceptance.** Resume with staging runtime access and
  separately accepted pause/cancel and task-control behavior; do not treat local/mock UI evidence
  as live acceptance.
- [ ] **APW07–APW09 — Integration, recovery, and evaluation.** Track work through PW, EP, workflow,
  platform, SC and TBR entries where they own the implementation. Link back to that evidence.

**APW checkpoint history.** APW06 goal decision-hold remediation adds a status explanation with
exact decision references and revisions plus a direct link to the Project decision review panel. It
adds no review write or task-resume path; the existing Project route retains access, exact-revision
and workspace-pin checks. APW06 conversation stop semantics and Project-control limits are recorded
above and in the APW ledger.

APW05 source reconciliation confirms that goal tasks have bounded token budgets; ordinary model
calls reserve against configured Project spend caps or plan token quotas, and System One decisions
use durable per-call Billing holds. These do not define an aggregate goal credit ceiling. Dynamic
extension workflows have owner-approved per-run/monthly budgets and durable reservations; default
AgentTaskWorkflow has no run-credit hold, and its optional session ceiling is a pre-run check plus
post-run tally increment rather than an atomic reservation. Existing shared-compute capacity limits
and hierarchical promotion do not include task priority weights. Exact blockers and evidence are in
the APW ledger. APW05 remains partial and unchecked.

APW05 comparison is source inspection only, with no deployed Billing or provider acceptance. The
APW04 local test evidence remains in its ledger; no retention schedule was invented.

**APW resume conditions:** return when an approved aggregate cost/priority policy, retention
schedule, task-control authority/recovery contract, or staging acceptance access becomes available.
APW07–APW09 implementation remains owned by PW, EP, workflow, platform, SC and TBR plans.

The existing **SC03** synchronous capacity retry was reconciled as implemented in `f9a2a02a`.
Track detached dispatch separately in the [shared compute ledger](../research/shared-compute-scheduling-and-budget-progress.md).
It needs durable invocation authority, alarm-safe revalidation and fresh Billing admission.
Keep disconnected replay disabled while those prerequisites are open.

## Ordered plan list

Unchecked entries mean work or reconciliation remains, even where the linked ledgers already
contain substantial implementation. Activate one entry at a time. Copy only the missing tasks
into the active checklist. Keep finished task checkboxes and evidence in the queue or its linked
ledgers when moving to another plan.

1. [ ] **Parked.** [Adaptive planner, worker coordination and memory](../research/adaptive-planner-worker-swarm-memory-plan.md) · [APW ledger](../research/adaptive-planner-worker-swarm-memory-progress.md). Remaining tasks have explicit policy, authority or live-acceptance dependencies; APW07–APW09 overlap later plans.
2. [ ] [Resumable workers, durable workflows and branches](../research/resumable-workers-durable-workflows-and-branches-plan.md) · [PW ledger](../research/resumable-workers-durable-workflows-and-branches-progress.md). No ready tasks remain; worker-branch retention is blocked on approved policy. Use the [planner and worker isolation plan](../research/planner-worker-isolation-and-conflict-resolution-plan.md) and platform section 12 for the existing PW contracts.
3. [ ] **Paused; Project runtime changes are tracked under SPR.** [Managed services and sidecar runtime](../research/managed-services-and-sidecar-runtime-plan.md) · [S/U ledger](../research/managed-services-and-sidecar-implementation-progress.md). Resume independent work when its recorded dependencies change.
4. [ ] **Active.** [One Tier 6 container per Project](../research/single-project-tier-6-runtime-plan.md) · [SPR checklist](#active-plan--single-project-tier-6-runtime). This plan owns the new runtime constraint for S4 and the affected S3/U10 callers.
5. [ ] **Paused; no ready source task.** [Shared compute scheduling and budget](../research/shared-compute-scheduling-and-budget-plan.md) · [SC ledger](../research/shared-compute-scheduling-and-budget-progress.md). Resume SC03 when durable invocation consent, exact alarm-safe authority revalidation and pre-dispatch reservation are supported; resume SC04 when owner-approved Space/Project caps exist.
6. [ ] **Reconciled; no standalone task selected.** [Unified platform](../research/naelao-unified-platform-deep-plan.md) · [U ledger](../research/unified-platform-implementation-progress.md). Code gaps remain tracked in their owning plans; remaining checked-workspace/runtime acceptance requires authorized deployed/provider evidence.
7. [ ] **Paused; no ready source task.** [Mature Knowledge platform](../research/mature-knowledge-platform-plan.md) · [K ledger](../research/mature-knowledge-platform-implementation-progress.md). K21 deployed acceptance and the K20 response-cache identity contract remain blocked; K15 waits on exact provider scope/freshness/cleanup evidence.
8. [ ] **Paused; remaining EP06 billing-price/cap and provider/live acceptance gates have no current local rate/acceptance contract.** [Extensible platform and managed resources](../research/extensible-platform-and-managed-resources-plan.md) · EP entries in the [platform ledger](../research/platform-completion-and-guided-templates-progress.md)
9. [ ] **Paused; no current code-ready task.** [Template business roles and member onboarding](../research/template-business-roles-and-member-onboarding-plan.md) · [TBR ledger](../research/template-business-roles-and-member-onboarding-progress.md). TBR08's workflow-resource dispatch slice is locally fixed; broad channel/provider/cache/delegation acceptance remains partial. TBR11's direct-script per-effect ceiling needs an owner-approved admission contract; role-to-resource mapping and private-Project policy remain unresolved.
10. [ ] **Paused; no local source-only task is ready.** [Platform completion and guided templates](../research/platform-completion-and-guided-templates-plan.md) · [P ledger](../research/platform-completion-and-guided-templates-progress.md). Resume when one of the recorded policy, provider, resource-inventory or deployed-acceptance dependencies changes.
11. [ ] **Source reconciled; provider work remains gated by terms, API and pricing evidence.** [AgentPort managed messaging providers](../research/agentport-messaging-providers-managed-resale-plan.md) · [progress ledger](../research/agentport-messaging-providers-managed-resale-progress.md)
12. [ ] **Source reconciled; provider work remains gated by API, commercial and regional evidence.** [AgentPhone and AgentPort adapter evaluation](../research/agentphone-agentport-adapter-evaluation-plan.md) · [AP ledger](../research/agentphone-agentport-adapter-evaluation-progress.md)
13. [ ] **Paused; source implementation complete; only separate test/live acceptance remains blocked.** [WhatsApp member routing, extension testing, SDK and starter templates](../../new%20plan/WHATSAPP-MEMBER-ROUTING-AND-EXTENSION-TESTING-PLAN.md). See its acceptance blocker and handoff above.
14. [ ] **Paused; fictional static demo source is complete; operator validation is required for further workflow work.** [Commercial cleaning Space template](../research/commercial-cleaning-space-template-plan.md) · [progress ledger](../research/commercial-cleaning-space-template-progress.md)
15. [ ] **Paused; the private static Blueprint is complete; a functional workflow awaits approved scope and practitioner validation.** [Corporate recovery claims prototype](../research/corporate-recovery-claims-prototype-plan.md) · [progress ledger](../research/corporate-recovery-claims-prototype-progress.md)

## Checkpoint archive

The former AGENTS.md is preserved at [checkpoints through 3a8701a6](agents-checkpoints-through-3a8701a6.md).
Its dated pointers document prior work. Resume through the active queue above. Copies from the
planning branch are kept under [planning branch snapshots](../research/planning-branch-snapshots/).
Use the current plans and ledgers for implementation status.
