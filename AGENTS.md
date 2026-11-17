# Active mission: continue the full implementation

The user has authorized an ongoing autonomous implementation of **all active plans and their
requirements**, not a single slice or a documentation update. This section is the authoritative
continuation instruction; historical checkpoints and their "next action" paragraphs below describe
past work and do not override the current progress records or require repeating completed work.

- Start or resume from the newest verified progress records and actual code/worktree. Continue the
  latest actionable gap, including the staged Project extension update recovery recorded below,
  then implement the next unfinished requirement across **all** active S/U/P/PW/K/EP/AP/TBR and
  other incorporated plan ledgers. Follow dependencies, preserve completed work and recheck current
  authorization, security and billing boundaries.
- A milestone, local test pass, documentation refresh, status update, user status request, plan
  incorporation, compaction, commit or push is **not mission completion**. After each coherent
  verified checkpoint, update the relevant durable ledger and this runbook's current pointer, commit
  and push to the authorized recovery branch under the existing safe fast-forward rules, then
  immediately continue independent implementation. Share brief progress in commentary without
  ending the turn. A user status question should be answered briefly while work continues unless
  the user explicitly changes or stops the mission.
- If a requirement needs provider credentials, live tests, deployment or a genuinely unresolved
  contract or policy, record the precise blocker and the independent work already completed; move
  to another actionable requirement. Do not label unwritten independent code as externally blocked
  or repeatedly re-audit unchanged work. A push rejected because the remote advanced requires
  preserving both histories and avoiding force; continue independent safe local work if possible.
- End the turn only when all authorized independent implementation has been completed and audited,
  the user explicitly stops or redirects it, or a genuine environment/tool/authority blocker
  prevents **all** further independent work. If execution must end, preserve and push any safe
  verified checkpoint when possible; report precisely what remains and the next action. Keep rollout
  disabled until its documented live acceptance gates pass; do not deploy, buy resources, contact
  people or perform other unauthorized external effects.
- The execution platform can interrupt a turn or end a session despite this instruction. A pushed
  checkpoint makes recovery possible; it cannot keep a session alive, automatically restart it or
  override platform/system instructions. After any restart or compaction, inspect the latest actual
  worktree and current ledger pointers, resume the current requirement and continue the full mission.

## Current cross-plan checkpoint — 2026-11-17 (EP03 Knowledge workflow caller; local, pending push)

The signed Project workflow now has a bounded read-only Knowledge search requirement bound to explicit owner publications. WorkflowRunDO binds durable effect identity to the active publication revision; AgentDO rechecks the exact PROJECT_BOUND install, owner resource grant, publication and revision; SpaceDO/Shell expose the staged owner review. SDK test **38/38**, Spaces install/resource grant **35/35**, Shell preview **4/4**, and Agent SDK/Agents/Spaces/Shell typechecks pass. The capability remains `unavailable`, so stage/owner approval cannot activate runtime; no deployed or live acceptance. A required follow-up is to acquire/release SpaceDO's per-resource rate/concurrency lease from this workflow caller before any future capability enablement. The current resource receipt records hashes and pins, not raw query/result.

`8dce285a7e3c50d70951fe602e9904d30be04da9` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`; it adds fixed-label, privacy-safe metrics for owner-approved website preview failures, including first-time previews, and isolates Analytics failure from results. Focused Knowledge telemetry + website source ingestion suites pass **28/28**, Knowledge typecheck and `git diff --check` pass. No deployed/live telemetry acceptance; scheduled Knowledge crawl/refresh flags remain disabled. Also verified the stale PW06 cancellation pointer is already closed by pushed `79d671a329b056c3cd2e861aeabb3996e488de9d`; focused delegation suite **9/9**, Agents typecheck and diff hygiene pass. Preserve the pre-existing untracked `infra/scripts/__pycache__/`.

SC03 remains partial. Admission requests persist exact scope and payload hash, not command bodies or secrets. Promotion grants a fenced queue lease, but there is no safe server-side wake/replay caller after the original caller disappears; automatic wake needs a durable invocation/job contract that can revalidate current authority, payload and budget. Do not persist arbitrary execution payload merely to claim recovery. SC04 has an atomic monthly tenant infra hold and exact extension-install monthly cap; source has no authoritative configurable Space/Project infra-credit cap to intersect, and provider invoices remain external. SC05's bounded main-runtime receipt UI is pushed with `ce73718f`; sidecar/non-Project reservations, reliable ETA and invoice view remain open. TBR07's authority comparison remains recorded; same-Space owner/admin vs Knowledge explicit-membership policy is unresolved.

The requested TBR07 authority comparison is already recorded at the top of `docs/research/template-business-roles-and-member-onboarding-progress.md` and in the shared-compute ledger: no shared Project/Knowledge/extension ACL authority exists, and the same-Space owner/admin private-Project policy remains unresolved. Do not repeat that audit or widen access. Exact next action: implement SC03 durable compute admission/dispatch and owner status/cancel/retry/recovery, reusing an existing encrypted request artifact store if present, binding exact caller and authorization revision plus budget and fenced lease, and revalidating them before dispatch. Keep commands/secrets out of ConcurrencyDO and do not block the synchronous invocation. Continue remaining K/P/PW/S/U/AP/TBR gaps after every pushed checkpoint; do not stop at a push.

## Previous cross-plan checkpoint — 2026-11-17 (Knowledge preview telemetry; `8dce285a` pushed)

## Latest cross-plan checkpoint — 2026-11-17 (SC03 hierarchical fair promotion; `24ddc2d4` local, pending ledger push)

The TBR07 source comparison is recorded in `docs/research/template-business-roles-and-member-onboarding-progress.md`: SpaceDO Project/assistant clamps, Knowledge D1 `project_access`, and installation-bound extension grants remain distinct authorities, with no shared resolver/ACL writer found. Same-Space owner/admin private-Project access remains a product/security decision; no policy was widened.

Pushed code `d314f4c16a377443a51c6715f3d82c897f36e97a` exposes the tenant-fair queue from Project Shell through an owner/admin Product route. ConcurrencyDO returns only scoped execution/actor IDs, state, timestamps and queue position; it includes active reservations and the bounded tenant wait list, and owners can refresh status. Waiting cancellation writes an exact tenant/Space/Project/execution tombstone for 24 hours, so a late same-ID retry cannot re-enqueue the cancelled execution. Pushed code `bed140342327950e794df9048b21d918616cb2c8` makes hard-cap overflow an explicit not-queued `capacity_queue_full` result with a same-ID retry receipt; the code runner does not automatically retry it. New local code `24ddc2d41f9aafd8d283c92ccae3976072e088c3` round-robins eligible tenant→Space→Project→actor partitions and preserves FIFO within a leaf. No command text or secret is stored/exposed. Evidence: Agents suites **65/65**, Agents typecheck and diff check. Previous `d314f4c1` evidence also includes Spaces suites **39/39**, Shell API test **1/1**, and Spaces/Shell typechecks. No deployed Worker/DO, browser, or live acceptance.

This remains polling/retry dispatch, not a push wake. A hard-cap request is refused rather than queued, so the owner UI shows admitted reservations/waiters only; the caller must retry the exact refused invocation. No configured Space/Project/member concurrency thresholds or priority weights exist: current limits are global deployment configuration and subscription-plan tenant concurrency. The scheduler uses equal hierarchical round-robin without claiming product-defined weights. Missing code/contract: automatic wake, priority aging/heterogeneous scheduling, configurable hierarchical quota policy and integrated quota windows/budget controls; no reliable ETA. Exact next action: continue SC04 by connecting runtime capacity reservations to supported plan/Project budget windows and owner-visible reservation status where existing billing contracts allow it; record any missing window policy separately and continue other active-plan requirements. Keep rollout disabled and preserve `infra/scripts/__pycache__/`.

## Previous cross-plan checkpoint — 2026-11-17 (K05 extension Knowledge grant history; `986a27a5` pushed)

The owner/admin Project Shell now shows up to 20 content-free extension Knowledge grant events from the existing SpaceDO ledger: selection IDs/revisions, actor and timestamp. This is a read-only history projection; it does not affect grants or retrieval. SpaceDO extension-runtime + Spaces grant-route suites **38/38**, Spaces and Shell typechecks, and `git diff --check` pass. No browser, deployed migration/Worker or live acceptance. Uninstalled extension history is still omitted. Generic ownership transfer, retention/legal-hold semantics and post-uninstall audit availability remain unresolved product/lifecycle decisions.

## Previous cross-plan checkpoint — 2026-11-17 (SC03 retryable capacity receipt; `fa17d910` pushed)

DynamicSandbox capacity denial now persists an exact scope/payload-bound `waiting_capacity` receipt instead of poisoning the execution as indeterminate. A matching retry atomically claims it once; the code runner retries only the structured capacity 429 with the same immutable request. Current authorization and budget are rechecked before any start; no guest execution or hold occurs while waiting. Local checks: DynamicSandbox **36/36** plus code-runner capacity test, Agents typecheck and `git diff --check`. `pnpm` attempted a workspace install and aborted because it could not remove modules without a TTY; equivalent local Vitest/tsc binaries passed. No deployment/live acceptance.

This does not yet provide automatic wake-on-release, a durable fenced queue lease for containers, owner-visible status/cancel, or hierarchical fairness. After five caller retries, work can still remain waiting; no arbitrary request body or secret is queued. Exact next action: build a durable waiter plus wake-on-release dispatcher on the existing ConcurrencyDO lease primitive, revalidating authority/budget before dispatch and identifying an authorized owner status/cancel caller. Then continue SC04/SC05 and all remaining active-plan gaps. Rollout remains disabled; preserve `infra/scripts/__pycache__/`.

## Cross-plan checkpoint — 2026-11-17 (member sees current Space role beside template proposals; `1368fc20` pushed)

`1368fc20e7bcd593d4ecb4d2fcf5f7a2a61e5855` is pushed to `origin/Mcbt5s-Backup-2`. The self-scoped `/my-business-roles` response now includes the member's exact active generic Space role alongside still-proposal-only template roles. Shell labels these separately and says Project/resource access and assistant limits use their own current policies. This avoids presenting a template role proposal as effective access. It does **not** calculate Project, Knowledge, extension, provider or assistant effective permissions, and applies no grants. Focused Spaces route tests **6/6**, Shell component tests **3/3**, Spaces/Shell typechecks and `git diff --check` pass; no deployment or live acceptance.

Exact next action: continue TBR07 from existing authority stores by checking only concrete current Project membership/assistant-clamp mappings and the already documented Space-owner/admin versus Knowledge private-Project inconsistency. Implement a non-granting effective view only where exact authorization records align; keep unresolved private-Project and symbolic template-resource cases unavailable. Then proceed to other uncoded TBR/S/U/P/PW/K/EP/AP/SC requirements. The direct DynamicSandbox-to-ConcurrencyDO queue integration is not safe as a synchronous wait: runtime admission has no durable owner-visible job status/cancel/resume caller, so SC03 needs a durable admission record/dispatcher that composes with the existing fenced queue. Rollout remains disabled; preserve `infra/scripts/__pycache__/`.

## Current cross-plan checkpoint — 2026-11-17 (scheduled-job effect grants; `15b48e03` pushed)

`15b48e039716b96d82dc86dab13ef2cb066810bb` is pushed to `origin/Mcbt5s-Backup-2`. It implements migration 0282 and owner/admin configuration for exact per-job autonomous operation grants and a per-run credit ceiling. Goal-job dispatch carries the ceiling as advisory input, while AgentDO reloads the current enabled job row and exact revision from D1, clamps the run ceiling against the existing session cap, and intersects approved operations with currently enabled agent operations. Legacy/unspecified grants remain read-safe only; direct-script jobs cannot receive broad action grants. This is local code only; migration 0282 is unapplied and no deployed acceptance occurred. Focused checks: security **2/2**, scheduled authorization/approval **13/13**, migration **3/3**, Agents/Spaces/Shell typechecks, `git diff --check`; repo tooling was restored with pinned pnpm 9.12.0 after the environment's pnpm 11 auto-setup rejected its lockfile configuration. The source plan and progress ledger for shared compute are now copied locally and reconcile the larger fair-scheduler gap.

Exact next action: replace DynamicSandbox global/tenant fail-fast capacity admission with a durable fenced waiting path built on the existing ConcurrencyDO queue, preserving caps and adding cleanup/renewal/retry tests; then continue scheduler fairness across Space/Project, quota windows, queue UX, and all other active-plan gaps. Existing queues still do not provide one platform-wide fair scheduler. Keep rollout disabled, do not apply migration, and preserve `infra/scripts/__pycache__/`.

## Current cross-plan checkpoint — 2026-11-17 (Project extension staged-update recovery; `d83bc20c` pushed)

Implementation `d83bc20c` and recovery test checkpoint `ff8a94c0` are pushed to `origin/Mcbt5s-Backup-2`. Owner/admin Shell controls can discover staged receipts and resume one through the API. Recovery requires the original receipt actor, verifies current staged install generation/version/manifest, source and candidate release pins, exact compiled artifact digest, retained publisher-signed source, deterministic workflow compilation and a currently active publisher key; it issues a short token for the same request ID. New extension uploads retain signed source separately from host-compiled runtime artifacts. Spaces and Shell typechecks, focused Project review/receipt-route tests **5/5**, recovery/apply route tests **5/5**, and `git diff --check` pass. Local mocks only; no deployed migration or live acceptance. Rollout remains disabled; `infra/scripts/__pycache__/` is preserved.

Exact next action: trace scheduled-job owner configuration through AgentDO dispatch and tool/resource admission, then implement a durable owner-approved per-job effect scope/budget with unsupported effects denied; after that continue every other uncoded requirement in all active plan ledgers. The recovery route directly verifies original request-token replay identity, changed stored artifact rejection and publisher revocation. Preserve untracked `infra/scripts/__pycache__/`.

## Current cross-plan checkpoint — 2026-11-17 (viewer capability disclosure and egress; `5fb3cfb4` pushed)

The implementation commits `9bdf06eb1d7483ad5f76dfb5a86cce315e509649` and `5fb3cfb422f11fc6bc5665f0ea019818806d025f` are pushed to `origin/Mcbt5s-Backup-2`; ledger reconciliation is pushed at `e64f0686869529a1a39162f6d5f56501a3284e08`. `9bdf06eb` hides non-read-safe operation names/details from viewer discovery; `5fb3cfb4` removes provider-backed document summarize/extract/compress from the viewer read-safe allowlist. Focused Agents tests **28/28**, Agents typecheck and diff hygiene pass. Fetch and push initially had a transient invalid-token failure, then succeeded on retry. `infra/scripts/__pycache__/` remains untracked and preserved.

Prior pushed checkpoint `62ce248e2e1d1d4431e2ea76bfeb1b4f62d54f1f` binds scheduled identity/revision to Project spend holds and settlements; SpaceDO **12/12**, Spaces/Agents typechecks pass locally. Source reconciliation shows EP04 already persists Project update receipts, exposes owner status reads, verifies the signed review pins in SpaceDO, and retries a staged receipt when the same owner request/token is replayed; Shell callers also retry ambiguous same-session network outcomes. Still missing: a reachable recovery journey after the owner loses the in-memory review token or browser session, plus end-to-end interruption/revocation tests. Exact next action: add a safe owner recovery caller from a staged receipt that revalidates current install/candidate/publisher pins and recovers only the same request; then continue remaining S2–S9/U01–U12, TBR07–TBR12, P/PW/K/EP/AP code gaps. Per-job owner-approved effect grants/budget and in-flight cancellation remain absent. Keep rollouts disabled; after interruption read both plans and all seven progress ledgers, inspect the worktree, and resume this action.

## Current cross-plan checkpoint — 2026-11-17 (scheduled-service Billing attribution; `019853ef` pushed)

`019853ef981b01c4c29060f35bb5a39a1d75fffc` is pushed to `origin/Mcbt5s-Backup-2`. Migration 0281 adds internal-only scheduled identity and authorization-revision fields to LLM holds and usage receipts. Goal runs bind the current scheduled job/revision to the LLM quota hold; settlement copies the saved identity into usage history. Direct scheduled scripts add the same fields to their internal usage receipt. Changed-revision retries conflict; malformed/partial attribution is rejected. The fields are not forwarded to external subscription metering. Billing tests **22/22**, scheduled identity tests **14/14**, Billing/Agents typechecks, release/deployment manifest validators and diff check pass. Local SQLite/Worker mocks only; migration 0281 is unapplied; no deployed Billing acceptance.

Project spend holds are not yet identity/revision-bound, and no per-job owner-approved effects/budget or in-flight cancellation exists. Exact next action: add scheduled identity/revision to the durable Project spend reservation and settlement receipt path with stale-revision, retry and uncertain-outcome tests; then continue independent TBR07–TBR12, S2–S9/U01–U12, and all remaining platform, Knowledge, unified-platform, planner/worker, extensible-resource and AgentPort code gaps. Keep rollouts disabled; preserve `infra/scripts/__pycache__/`.

## Previous cross-plan checkpoint — 2026-11-17 (Project update receipt persists through activation; `53d07a16` pushed)

After `a17ba936`, SpaceDO now re-verifies the review claims and source/candidate pins inside the install transaction. Migration 156 persists `project_extension_update_receipts` with tenant/Space/Project, actor, instance, source/applied generations, source/candidate manifest/artifact and publisher pins. Staging creates a receipt; successful activation marks it active; abort records aborted. Tampered signatures leave no receipt. Focused SpaceDO install/runtime, migration and review suites **49/49**, Spaces typecheck and `git diff --check` pass. Local SQLite/DO mocks only; no deployed apply/live acceptance.

The receipt is not yet exposed to a recovery caller, staged apply cannot resume after process interruption, and Project-bound additive migrations remain outside the version-only token contract. Exact next action: implement idempotent apply recovery keyed by the persisted request receipt, including candidate staged-state revalidation and safe actor initialization; then support additive Gadget migration through the Project-bound actor receipt and recover after activation failure. Add interruption/replay/revocation tests. Continue all other uncoded EP/K/P/PW/S/U/AP/TBR work afterward. Keep rollout disabled and preserve untracked `infra/scripts/__pycache__/`.

## Current cross-plan checkpoint — 2026-11-17 (Project Gadget migration recovery; `51a70c34` pushed)

`51a70c34` is remote-verified after contract checkpoint `95161eec`. `workers/spaces/src/do/MicroAppDO.ts` now accepts a distinct signed Project-bound migration purpose. It requires the actor's persisted tenant/Space/Project/install identity and exact installation generation, rechecks Project and generation inside the schema transaction, and records scope, Project ID and generation in the durable migration receipt. Exact receipt replay remains recoverable after actor initialization advances the install generation, while a new stale-generation migration is rejected. The prior `SPACE_SHARED` purpose remains separate and retains its existing tier-3 check. Focused `extension-schema-update.test.ts` **7/7**, Spaces typecheck and `git diff --check` pass. Local Durable Object shim only; no migration was executed against a deployed actor.

This contract has no reachable owner apply caller yet. The Project update-review route is currently read-only and does not issue a signed apply token; the existing upload upgrade route uses current install CAS but does not consume that review. Exact next action: add a Project-bound owner review/apply token and apply route that revalidates the trusted candidate, publisher key, current generation/version/manifest, paused/drained installation and token before calling this actor contract; then persist/recover the installation update receipt and cover interruption/replay. Keep rollout disabled. Preserve untracked `infra/scripts/__pycache__/`.

## Previous cross-plan checkpoint — 2026-11-17 (Project Gadget actor install identity; `bf00d57f` pushed)

`bf00d57f2862946b32c7a91033c8253a26c7d394` is remote-verified on `origin/Mcbt5s-Backup-2`, after PROJECT_BOUND upgrade CAS `67b9f4c5`. Staged project installs now return their generation; project Canvas/Gadget initialization binds tenant, Space, Project, exact extension installation and generation into MicroAppDO metadata. The actor refuses cross-Project reinitialization and generation rollback. This is identity persistence only; it does not yet authorize a Project-bound schema migration or provide end-to-end update recovery. Focused Spaces suites **74/74**, Spaces typecheck and diff hygiene pass. No deployment or rollout.

Exact next action: add a separate Project-bound additive Gadget migration contract with a durable receipt bound to project ID, install ID and generation; keep the existing `SPACE_SHARED` contract unchanged. Wire it only through the owner update workflow after persisted signed review-token validation and exact installation CAS; recover migration success if later activation fails. Test cross-Project, stale-generation, revoked-key, interruption and replay. Then continue EP/K/P/PW/S/U/AP/TBR remaining work. Preserve `infra/scripts/__pycache__/` and keep rollout disabled.

## Current cross-plan checkpoint — 2026-11-17 (PROJECT_BOUND update review and install CAS; `67b9f4c5` pushed)

`67b9f4c585784ef3daa8c91ab2317fae297d4c84` is remote-verified on `origin/Mcbt5s-Backup-2`, after project update review `5e1acc33` and route coverage `0f8f7c1f`. Owners/admins can review exact active install generation/version/manifest pins against current trusted candidate releases; the review returns permission, capability, resource, dependency and primitive deltas and leaves costs unknown. Separately, the existing signed-upload `upgrade` caller now captures the current generation/version/manifest during preflight, and SpaceDO rechecks all three, plus the stored manifest JSON, inside its transaction after requiring pause and drained work. Stale generation or manifest requests conflict. Focused Spaces tests: project review route/helper/trust **8/8** and runtime install **34/34**; Shell API/provenance **7/7**; Spaces/Shell typechecks and diff hygiene pass. Local evidence only; no deployment/live acceptance, rollout or provider action.

Remaining code gaps: the existing upload path does not consume the review token, project-bound Gadget migration still uses an executor whose actor check is explicitly `SPACE_SHARED`, and no durable project update receipt recovers a failure between installation CAS and runtime initialization. Exact next action: close the migration/apply recovery gap by implementing a project-bound gadget actor identity and durable update receipt with installation generation, then bind the update apply to the signed review token; test stale pins, retries and migration failures. Continue all other uncoded EP/K/P/PW/S/U/AP/TBR requirements immediately afterward. Keep rollout disabled; after interruption read every active plan and progress ledger, inspect the actual worktree, and resume this exact action. Preserve untracked `infra/scripts/__pycache__/`.

## Current cross-plan checkpoint — 2026-11-17 (jobs-only resource approval UI; `ce7e01c5` pushed)

`ce7e01c54bdef5660f1bfbd6113a02f14d328011` is remote-verified on `origin/Mcbt5s-Backup-2`. Shell now labels a staged installation with only a `jobs` resource declaration as “resource approval required,” matching the existing jobs grant-review flow; previously this branch checked only objects and structured data. Shell focused resource API tests **4/4**, Shell typecheck and diff check pass.

EP03 now has scoped/versioned RAG contracts and host-authorized query/revoke/deletion fences through `b4a06736`. Source trace confirms channel extensions invoke only the existing host Knowledge search against explicitly granted/published collections; custom parser/index invocation and persisted extension-index lifecycle remain unwired. Existing host grants, publication revisions, source lineage and tombstones are reusable; do not create parallel authority. EP04 owner review already shows install-bound requirements, grant/revoke, budget and usage; byte/storage price remains unapproved. No deployment, provider action, live acceptance or rollout. Preserve untracked `infra/scripts/__pycache__/`.

Exact next action: reconcile EP04's planner/worker-generated artifact and checked publication through the signed manifest/install preview, focusing on whether resource declarations, exact artifact/provenance pins and known/unknown costs reach the owner review before installation. Implement a concrete missing caller/UI/API field if found, then continue other uncoded EP04/EP05, K/P/PW/S/U/AP/TBR requirements. After interruption, read all eight plans and seven ledgers, inspect the worktree and resume here; do not stop at a checkpoint.

## Current cross-plan checkpoint — 2026-11-17 (EP03 scoped retrieval fences; `b4a06736` pushed)

`b4a06736e708102f6f4bbfcc4ab23b1d0116727f` is remote-verified on `origin/Mcbt5s-Backup-2`, following EP03 contract code `d99f40cb` and query-egress fence `14db839d`. `@naelao/rag` now validates exact host-supplied source, parser, chunker, index and retrieval lineage; verifies chunk hashes and bounded citation coordinates/bytes; strips extension-supplied authority fields; authorizes chunk references before ranking; requires host query-egress admission; and removes candidates revoked during the adapter call. Synthetic lifecycle tests cover owner approval, publication, revoke and deletion-generation invalidation. RAG tests **7/7**, RAG and Knowledge typechecks and diff hygiene pass. These are package/local checks; no persistent custom parser/search runtime caller or deployed extension adapter exists.

The host already persists Knowledge grants, indexed document/source lineage, owner-controlled external publications and tombstones; the remaining EP03 gap is wiring a specific installed extension identity/revision to an invocation and durable run/index lifecycle under those authorities. Avoid a second grant/publication ledger. EP06 exact-install provider lifecycle receipts remain at `86579537`; owner verified-capability setup scope at `41e01624`. U07's first-party live path still requires the unsupported U06 writer/flush/reconnect adapter; rollouts remain false. No deployment/provider activity/live acceptance. Preserve `infra/scripts/__pycache__/`.

Exact next action: reconcile the current signed MicroApp runtime's reachable Knowledge caller against the persisted extension grant/publication and document lineage APIs; implement the narrow host invocation/persistence bridge only if it can use those current authority records without exposing raw host stores. Otherwise record the exact runtime contract gap and continue EP04's scoped resource preview/provenance caller, then all remaining K/EP/P/PW/S/U/AP/TBR requirements. Read all eight plans and seven progress ledgers after interruption; inspect the actual worktree and resume here. Do not stop at a checkpoint.

## Current cross-plan checkpoint — 2026-11-17 (custom Knowledge extension contract; `d99f40cb` pushed)

`d99f40cb6dcbe3f26c9d4729b2bb6e1b10e1f4f0` is remote-verified on `origin/Mcbt5s-Backup-2`. `@naelao/rag` now exports versioned scoped Knowledge extension input/output contracts. Chunk validation binds tenant/Space/Project/collection/installation/source identity, source version/hash, parser/chunker versions, deletion generation and byte/line citation bounds; chunk text hash, count and byte budgets are checked, and unknown fields are stripped. Retrieval candidates contain references only, are limited to host-authorized current chunk IDs, and must match source/deletion/index/retrieval revisions. These checks validate lineage and shape only; host authorization, publication, retention and deletion remain authoritative. Focused tests **3/3**, RAG typecheck and diff hygiene pass. No live parser/search extension adapter or persistence caller has been wired yet.

`41e01624` presents verified setup scope in the owner Managed Services UI; `86579537` adds read-only exact-install provider lifecycle receipts. U07 remains dependent on U06's unsupported writer/flush/reconnect runtime adapter; rollout remains disabled. No deployment, provider activity, invoice, or live acceptance. Preserve untracked `infra/scripts/__pycache__/`.

Exact next action: connect the validated EP03 contract to a host-owned synthetic parser/search lifecycle example with explicit owner grant and status/publish/revoke/delete boundaries, testing revocation, stale source version and deletion-generation invalidation. Do not allow extension output to set authorization/publication. Then continue all other uncoded K01–K30/EP01–EP06/P/PW/S/U/AP/TBR requirements. After compaction, interruption or a new session, read all eight active plans and all seven ledgers, inspect the actual worktree and resume here. Do not stop at checkpoints.

## Current cross-plan checkpoint — 2026-11-17 (verified capability setup scope and U07 audit; `41e01624` pushed)

`41e016244275f64c6ad14dfb10f8d83006a1de96` is remote-verified on `origin/Mcbt5s-Backup-2`. The owner Managed Services panel now presents generic setup scope only when the latest capability record is operator-verified and current: declared operations, account modes, regions and expiry, with a clear statement that this is not proof of account connection, provider health, entitlement or runtime authorization. Dashboard tests **3/3**, Agents and Shell typechecks, and diff hygiene pass. No AgentPhone record or support was added.

U07 source reconciliation confirms bounded durable checkpoint jobs and recovery in `WorkspaceCoordinatorDO`, but no first-party public caller exists; `/v1/live-checkpoint/request` is Coordinator-internal. A live caller remains dependent on U06's unsupported runtime writer/flush/reconnect adapter. `LIVE_WORKSPACE_ENABLED` remains false and `LIVE_RUNTIME_AGENT` is unbound. This is an implementation/platform contract dependency, not a credential-only gate; no caller was fabricated. EP06 exact-install provider setup/cleanup receipts remain read-only at `86579537`. No deployment, provider activity, live acceptance or rollout. Preserve `infra/scripts/__pycache__/`.

Exact next action: implement EP03's first provider-neutral, versioned custom-Knowledge extension contract in the existing RAG package, carrying source/content lineage, scope, parser/chunker/index/retrieval versions and citation coordinates; validate untrusted extension output while leaving authorization, publication, retention and tombstone authority with the host. Then add focused contract tests and continue the remaining EP03 lifecycle example, K01–K30 and all other independent active-plan gaps. Do not stop after a checkpoint.

## Prior cross-plan checkpoint — 2026-11-17 (extension object storage inventory; `3b867de4` pushed)

`3b867de4` is pushed and remote-verified. The owner-only signed-install resource snapshot now includes host-object count and bytes from the exact tenant/Space/Project/installation rows; Shell labels these as recorded storage, not cost. The inventory combines install generation, current grants/budget, bounded operation/job receipts and object usage. Tests: Shell resource API **3/3**, Spaces route/install suites **41/41**; added install object-usage assertion passes in the focused **34/34** suite; Shell/Spaces typechecks and diff check pass. No provider invoice, deployment, live acceptance or rollout occurred. Preserve `infra/scripts/__pycache__/`.

EP06 remains partial for structured-data resource totals, broader provider dependencies, invoice-backed cost and lifecycle cleanup/export state. K26 has privacy-safe retrieval/parse/refresh/authorization/citation/deletion metrics through `ab284ee1`, all local-only. TBR06 remains proposal-only because no host grant mapping/outbox exists. Exact next action: trace the existing scoped Gadget/MicroAppDO structured-data store for a safe per-install row/byte inventory contract; implement a read-only summary only if exact installation identity can be checked at the storage boundary. Then continue other independent S/U/P/PW/K/EP/AP/TBR work. Keep rollout disabled; do not stop at a checkpoint.

## Current cross-plan checkpoint — 2026-11-17 (Knowledge citation and deletion telemetry; `ab284ee1` pushed)

`ab284ee1` is pushed and remote-verified following `c9e796c7` and `0ed5adeb`. K26 now records privacy-safe retrieval aggregates, PDF parse outcomes, scheduled refresh counts/duration/lag, Project-access denial, citation delivered/not-found/integrity/unavailable outcomes, and durable deletion pending/complete/busy/error plus attempts. All telemetry labels are fixed; values are bounded; no raw tenant/Space/Project IDs, documents, queries, citations or payloads are written. Telemetry failures are isolated from authorization, citation delivery and cleanup. Relevant Knowledge suites **62/62**, Knowledge typecheck and diff check pass. No deployed/live telemetry acceptance; rollouts disabled. Preserve `infra/scripts/__pycache__/`.

EP06 remains partial after `39b284bc`; TBR06 remains proposal-only because no safe role-to-host-grant mapping/outbox is currently specified. Exact next action: reconcile remaining K26 source/provider retry and cost-attribution paths against current code; add only fixed-label metrics for existing authoritative outcomes, then continue independent uncoded S/U/P/PW/K/EP/AP/TBR requirements. Do not stop at a checkpoint.

## Current cross-plan checkpoint — 2026-11-17 (Knowledge authorization and refresh-lag telemetry; `0ed5adeb` pushed)

`0ed5adeb` is pushed and remote-verified following `3c4242b7` (fixed-label Project-access denial metrics), `9476fc1d` (PDF preview parse outcomes), `370b99f5` (scheduled refresh outcomes), and `67719e1a` (retrieval telemetry privacy). Scheduled Knowledge refresh now reports bounded maximum due lag along with counts/duration. Authorization denials use fixed categories and no caller/resource identifiers. Tests across the relevant Knowledge telemetry/scheduler suites **10/10**, Knowledge typecheck and diff check pass. No deployed/live analytics acceptance; rollout disabled. Preserve `infra/scripts/__pycache__/`.

EP06 remains partial after `39b284bc`; TBR06 remains proposal-only because there is no supported current role-to-host-grant mapping/outbox. Exact next action: continue K26 by adding fixed-label deletion/recovery status metrics at the durable Knowledge cleanup boundary, ensuring telemetry errors never affect cleanup; then continue other uncoded S/U/P/PW/K/EP/AP/TBR requirements. Do not stop after a checkpoint.

## Current cross-plan checkpoint — 2026-11-17 (bounded Knowledge parse/sync telemetry; `9476fc1d` pushed)

`9476fc1d` is pushed and remote-verified, following retrieval privacy cleanup `67719e1a` and scheduled refresh metrics `370b99f5`. Retrieval logs/Analytics now omit tenant, Space, Project and query data; scheduled website refreshes emit fixed-label selected/claimed/completed/failed/paused counts and duration; PDF preview parsing emits fixed-label success/failure and duration. Metric values are bounded and Analytics failures do not change refresh/parse behavior. Knowledge telemetry + scheduler suites **9/9**, Knowledge typecheck and `git diff --check` pass. No deployed/live analytics acceptance; rollout remains disabled. Preserve `infra/scripts/__pycache__/`.

EP06 remains partial after `39b284bc`: owner-only exact-generation job and operation usage is visible, but provider-resource inventory, complete dependencies, invoice-backed costs and lifecycle receipts remain. TBR06 remains proposal-only: role review is schema-constrained to `grants_applied=0`; no safe current role-to-effective-host-grant mapping/outbox exists. Exact next action: continue K26 with fixed-label authorization denial, freshness, deletion and recovery outcomes at Knowledge boundaries, preserving failure isolation and never logging content/private IDs; then proceed through other independent S/U/P/PW/K/EP/AP/TBR code gaps. Do not stop at a checkpoint; keep rollouts disabled.

## Current cross-plan checkpoint — 2026-11-17 (privacy-safe Knowledge retrieval telemetry; `67719e1a` pushed)

`67719e1a` is pushed and remote-verified. Knowledge retrieval Analytics Engine and JSON logs now emit only allowlisted aggregate metrics and fixed retrieval-mode/lexical-state labels; raw tenant, Space, Project identifiers and query contents are omitted. Latency/timings, confidence and result count are clamped, and unknown timing keys are dropped. The helper test passes **1/1**, Knowledge typecheck and `git diff --check` pass. No deployment or live analytics acceptance occurred; rollout remains disabled. Preserve `infra/scripts/__pycache__/`.

Other latest code checkpoint `39b284bc` provides owner-only signed-install resource job/operation usage receipts; EP06 remains partial for complete provider-resource inventory, dependency graph, invoice-backed costs and lifecycle receipts. TBR06 remains non-granting: current reviews are constrained to `grants_applied=0`, and no current role-to-effective-host-grant mapping/outbox exists across separate Project, Knowledge, extension and provider authorities. This is an uncoded contract gap, not a credential blocker.

Exact next action: continue K26 with privacy-safe fixed-label parse/sync/freshness/denial/recovery metrics at the existing Knowledge operation boundaries, covering failure isolation so telemetry errors never affect jobs or authorization. Then move to the next independent uncoded S/U/P/PW/K/EP/AP/TBR requirement; preserve the TBR06 no-grant boundary until an authoritative mapping exists. Do not stop after a slice/checkpoint; keep rollouts disabled.

## Current cross-plan checkpoint — 2026-11-17 (connector-poll resume integration coverage; `9ecac47f` pushed)

Code `9ecac47f5ea00989f0cd3df356574bb80d3a0a6d` adds AgentDO approval-resume integration coverage for edited/disabled connector state and transient D1 authority outage; the implementation is at `8a7203c1`, queue admission fence at `0628662b`, and broad-yolo clamp at `503a9d22`. The current connector revision is checked at queue admission, AgentDO ingress, each step and before approval resume. Local evidence: Agents focused suites **31/31**, Agents typecheck, `git diff --check`. This does not prove cancellation of an effect already in flight, connector-specific action grant/budget, or deployed acceptance. No provider action, migration, deployment, live acceptance, or rollout occurred. Existing S3/U03/U04/U11/U12 caller audits found no additional safe local gap; do not repeat them. U05/U06 producer/writer/runtime contracts and other recorded provider/live gates remain. Exact next action: implement EP06's owner-facing Project/install resource inventory and dependency/usage view using the existing exact signed installation, resource grants, budget and operation/job receipts; keep it read-only and owner-authorized, do not synthesize provider cost, and add API/UI scope tests. Then continue TBR06 only for host grant mappings supported by current authority and the remaining S/U/P/PW/K/EP/AP code gaps. Preserve `infra/scripts/__pycache__/`.

## Previous cross-plan checkpoint — 2026-11-17 (scheduled approval identity survives resume; `688f69e4` pushed)

Code `688f69e4c9cae6c29986efb17d65a507779134e9` is pushed and remote-verified. HITL-suspended scheduled goal runs now persist their exact service trigger/id/revision; resume reconciles that checkpoint with authenticated heartbeat-session metadata (including recovery of older rows), rechecks the live enabled goal/job/Project/agent revision, and remains retryable if session authority is unavailable. Scheduled goal actions also recheck the exact current revision between steps. Local scheduled authorization, heartbeat-scope, scheduled approval-policy and kernel suites **28/28**, Agents typecheck and diff check pass. This narrows approval/resume revocation races but does not cancel an external effect already underway or add durable per-job budgets/action-grant administration. No migration, deployment, live acceptance, provider action or rollout. Exact next action: inspect `managed_service_operations`/Billing effect receipts for an existing job-scoped budget and cancellation contract; implement only supported persistence/authorization, and continue independent S/U/P/PW/K/EP/AP gaps if product scope is absent.

## Current cross-plan checkpoint — 2026-11-17 (scheduled goal effects require explicit action approval; `2bb067d3` pushed)

Code `2bb067d3f0251c274eef1e559f233152e3fc77f7` is pushed and remote-verified. Scheduled goal wakes no longer inherit broad Space `yolo` auto-approval: only currently enabled operations explicitly classified read-safe remain autonomous; other actions use the existing exact-action HITL approval flow, with the same restriction reapplied after each fresh policy read. Tests **25/25**, Agents typecheck and diff check pass. The previous direct-script identity/revision fence is at `93568569`. This remains partial: no durable owner-reviewed per-job action grant or budget ledger, cancellation of effects after start, explicit Project Steward opt-in, or generic no-user channel principals. No deploy/migration/provider/live acceptance; rollout remains disabled. Exact next action: trace HITL resume receipts and Billing reservations for scheduled jobs to prove the service identity/revision stays bound across approval and cost settlement; implement any missing identity fence that current contracts support, then continue independent S/U/P/PW/K/EP/AP gaps.

## Current cross-plan checkpoint — 2026-11-17 (direct scheduled-script identity and revision fence; `93568569` pushed)

Code `93568569878ca356132a105ba206b4a77d35ff93` is pushed and remote-verified. The direct `script_name` scheduled-job path now creates a persisted heartbeat session with `scheduled_job:<id>` and exact `updated_at` revision, passes that receipt to AgentDO, verifies session identity/scope, and rechecks the current enabled job, tenant/Space/Project, revision and script target immediately before direct execution. Local scheduled-direct, dispatch and heartbeat-scope suites **14/14**, Agents typecheck and diff check pass. This closes the direct-path gap only; scheduled action-level grants, owner-visible per-job budget, in-flight effect cancellation, and Project Steward explicit opt-in remain open. No deployment/provider/migration/live acceptance ran; rollouts stay disabled. Exact next action: trace current owner-configurable approval and Billing gates for scheduled goal/script operations and implement only an existing enforceable per-effect scope/budget contract; do not infer that a job label itself grants authority. If no safe existing contract exists, retain fail-closed scopes and proceed to the next independent P04/P05/S/U/K/PW/EP/AP requirement.

## Current cross-plan checkpoint — 2026-11-17 (revocable Project Steward service capability; `cc2ab164` pushed)

Code `cc2ab16402e87ddc7e4f0eceb8f3b0e3dd4f8168` is pushed and remote-verified. The Project Steward scheduler now resolves an exact Space-shared installation identity (instance ID, generation, status and manifest capabilities). It reuses an active install only when `space.project_steward.read_summary` is present; disabled/removed instances are not automatically reactivated. The summary caller supplies the expected install/generation, and the SpaceDO checks the live status/generation/capability again at the fact-read boundary. The durable advisory report records identity and generation. Local Spaces routes/SpaceDO tests **40/40**, Spaces and Agents typechecks and `git diff --check` pass. This is a narrow read-only platform service identity, not an owner-granted general principal; automatic initial provisioning, explicit owner opt-in, a universal service-grant ledger, per-job budgets, in-flight cancellation and the final cross-store revocation/persist race remain open. No migration/deployment/live acceptance ran. Exact next action: add owner-authorized, job-scoped action and budget grants to scheduled execution (or deny effects without one), and resolve explicit Project Steward opt-in before treating its platform service as customer-authorized; continue other independent S/U/P/PW/K/EP/AP/TBR gaps. Rollouts stay disabled.

## Current cross-plan checkpoint — 2026-11-17 (scheduled identity bound to persisted session; local pending)

The Agents Worker now carries the derived scheduled-job service identity and exact job revision into the persisted heartbeat session and run context. `NaelaoAgentDO` requires this identity for `scheduled_job` runs and checks that identity/revision against the persisted session; missing or mismatched receipts are rejected. Direct-script calls carry a deterministic per-sweep run ID. Blackboard-triggered wakes now have their own `blackboard_wake` trigger label, remain tied to their existing authorized-user policy, and are not misclassified as scheduled jobs. The full row recheck occurs after wake-brief preparation and before dispatch; unknown active-run state fails closed. Tests across five focused suites **22/22**, Agents typecheck and diff check pass. This is host-internal identity correlation plus boundary validation, not a complete per-effect service grant: no durable independently revocable grant set, job budget, or cancellation of already-running external effects exists. Exact next action: persist/revoke the narrowest owner-approved scheduled service grant and make action/Billing gates consume it; then continue independent S/U/P/PW/K/EP/AP/TBR gaps. Rollouts remain disabled.

## Current cross-plan checkpoint — 2026-11-17 (scheduled-job identity and receipt correlation; local pending)

Owner-configured scheduled jobs now derive a stable `scheduled_job:<job-id>` execution identity, bind it to the exact current `scheduled_jobs.updated_at` revision, and use a deterministic `scheduled-job:<job-id>:<sweep>` run ID for direct-script and goal-based execution. Goal wakes persist the identity/revision in the heartbeat session metadata and run context; direct scripts receive the stable run ID for billing/effect receipt correlation. Together with the snapshot recheck and fail-closed idle guard, this closes several queue admission and attribution gaps. Local focused suites **13/13**, Agents typecheck and diff check pass. Identity metadata is not itself a grant: durable exact action grants, owner-visible per-job budget, effect-level authorization receipts and in-flight cancellation remain uncoded. No deployment or live test ran. Exact next action: trace use of this identity inside AgentDO action gates and billing, persist a revocable service grant for the narrowest current owner-configured scope without borrowing user/owner permissions, then continue remaining S/U/P/PW/K/EP/AP/TBR gaps. Rollouts disabled.

## Current cross-plan checkpoint — 2026-11-17 (autonomous wake conflict guard; local pending)

The `wakeAgentGoal` admission gate now dispatches only when the AgentDO active-run endpoint returns a valid `{active:false}` receipt. An active run remains a 409 with its run ID; endpoint errors, malformed JSON or missing status return retryable 503 and do not dispatch. This removes the prior fail-open overlap path. Local focused wake/dispatch/tenant-scope tests **12/12**, Agents typecheck and `git diff --check` pass. No deployment or live Workflow/DO acceptance ran. Exact next action: add durable per-job service-principal identity and authorization revision to scheduled run receipts, then enforce exact effect scope/budget or deny unsupported effects; continue remaining PW/TBR/S/U/K/EP/AP requirements. Rollouts stay disabled.

## Current cross-plan checkpoint — 2026-11-17 (scheduled wake revocation recheck; local pending)

The AgentPort SDK metadata-disclosure slice from `20db3bf9553605b82f6f686d388027452dc4aca9` is pushed and remote-verified: `listServices`/`discoverServices` return typed provider-authored metadata, and `getServiceMetadata` is available. Documentation explicitly says declarations do not prove Naelao capability, entitlement, authorization, region, or live success. SDK tests **15/15**, SDK/Agents typechecks, AgentPort route tests **14/14**, and `git diff --check` pass. This does not register or support AgentPhone.

Scheduled `AGENT_TICKS` now rechecks the exact owner-configured scheduled-job snapshot after acquiring the dispatch lease and immediately before invoking a planner/script. A pause, delete, target/params edit, or other relevant config change observed in that interval is recorded as `authorization_changed_before_dispatch` and skipped. Focused dispatch/tenant-scope tests **6/6**, Agents typecheck and diff check pass. This narrows the stale-authorization window only: it does not cancel an effect already in flight, provide a distinct revocable service principal, or supply per-job scope/budget grants. Project Steward remains a narrow advisory-only read path whose durable run claim is not bound to a revocable principal. No migration, deployment, browser, provider call, or live acceptance ran.

No full TBR11 service-identity completion is claimed. Exact next action: trace the scheduled-job execution authority from owner create/edit through AgentDO tool authorization, project scope, billing and run receipts; implement a durable service principal bound to the exact job revision and an existing host-enforceable scope/budget if the contract supports it. If the effect surface cannot be narrowed without a product grant mapping, fail closed for that effect and continue other independent S/U/P/PW/K/EP/AP requirements. Preserve untracked `infra/scripts/__pycache__/`; all rollouts remain disabled.

## Current cross-plan checkpoint — 2026-11-17 (Space invitation and role onboarding UI; `579d03f0` pushed)

Code `579d03f0d2a97bf4f3464615dc7b1df3367fe0a1` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Shell now has owner/admin invitation creation/status/revoke, a catalog of only active signed template roles, role-proposal review/revoke, and an invitee acceptance page. Tokens are handed off in a URL fragment (not HTTP request/query), held in component memory, and removed from history after authenticated capture. The invitee must use the same verified Product email. The UI explicitly says delivery is not sent and the role remains non-granting. Local evidence: Spaces **6/6**, Router identity paths **84/84**, Shell **4/4**, Spaces/Router/Shell typechecks, previous migration inventory **280**, and diff check. No browser, deployed D1, migration apply, delivery or live multi-user acceptance occurred; migration 0280 remains unapplied.

TBR05 is partial for one role per invitation, no delivery and incomplete multi-role changes; TBR06 remains partial because the host grant issuers have distinct authorities and the TBR03 action/shared-data mapping plus TBR10 private-Project policy do not define a safe role-to-grant outbox. No grants are applied. TBR12 advances from API-only to local UI/acceptance code, but multi-resource onboarding, accessibility/browser and deployed acceptance remain open. AgentPhone remains unsupported; all vendor API/auth/event/voice/region/term/price claims remain unverified.

Exact next action: continue TBR11 by tracing `scheduled_job`, `connector_poll`, heartbeat and extension-job execution context from queue producer to effect caller; implement a separately authorized, revocable service identity for the narrowest currently unscoped scheduled path, with exact scope and budget checks and no borrowed creator/owner grant. Keep other uncovered wakes fail-closed, then continue remaining S/U/P/PW/K/EP/AP requirements. Rollouts remain disabled.

## Current cross-plan checkpoint — 2026-11-17 (business-role-bound invitation redemption; `ae011049` pushed and remote-verified)

Implementation `2daeb0378b39d5243b3383fda325c1639fe58cbe` and replay/constraint coverage `ae0110495b6e5f92b13eae1155ac4bb77b1d4820` are pushed and remote-verified. Migration 0280 adds nullable exact-blueprint/artifact/role binding to Product-member invitations. Owners/admins may select only a role declared by the currently installed, active, signed blueprint. Redemption revalidates that exact artifact before accepting; a changed/unavailable artifact leaves the invite pending. Successful redemption creates the generic membership and a TBR06 `proposal_only` review tied to the membership epoch in the same D1 batch. Every response says `grants_applied: false`; no resource permission is applied, no email/SMS is sent, and SpaceDO collaborator identity remains separate. Migration and deployment manifests now require 0280. Local evidence: invitation/role route **6/6**, Router identity paths **82/82**, Spaces/Router typechecks, release manifest tests **5/5**, migration release tests **20/20**, migration inventory **280**, deployment manifest validation and diff check pass. Migration 0280 is unapplied; no browser, deployed D1, email/SMS, or multi-user live acceptance ran.

AgentPhone plan provenance was re-fetched from remote commit `3ef84165546a781ebcde6867d62e563f022385b9`; its source SHA-256 matches the already copied plan. AP01–AP06 remain reconciled in platform section 18 and its ledger. AgentPhone API/auth/events/voice/regions/terms/prices remain unverified vendor claims; no account, number, call, message, or charge action occurred.

Exact next action: continue TBR06 by tracing every current Space/Project/extension/Knowledge grant issuer and revocation caller against `space_business_role_reviews`; implement a durable host grant outbox only for independently specified capabilities, retaining proposal-only behavior for unresolved action/shared-data and private-Project policy. Add idempotent partial-failure/revocation coverage. If the TBR03/TBR10 contract blocks a grant class, keep it unavailable and continue TBR07–TBR12 and remaining S/U/P/PW/K/EP/AP code gaps. Rollouts remain disabled.

# Autonomous managed-services and workspace implementation runbook

## Active mission and checkpoint

## Latest cross-plan checkpoint — 2026-11-17 (EP04 Gadget/schema preview; `88f3c34d` pushed)

Code `88f3c34deb8ea4cbc49681a65c7527bc18eaa19e` is pushed and remote-verified. The signed package summary now shows bundled and legacy Gadget scope, schema presence, bounded migration version/description summaries, declared business-action IDs, and workflow tool names before installation. It omits raw SQL and does not imply effective grants. Focused Shell suites **13/13**, Shell typecheck and diff check pass. No browser/deployment or rollout. Preserve untracked `infra/scripts/__pycache__/`.

Exact next action: implement the project-bound signed update review only on the existing project release/DO authorities. The shared-package inspector is too restrictive for PROJECT_BOUND workflow/Gadget/channel artifacts; adapt its signature/artifact verification with explicit project scope or write a separate verifier, return current/candidate hashes, generation and bounded migration/resource/authority deltas, and keep the preview non-mutating. Then proceed across remaining K/P/PW/S/U/AP/TBR code gaps. Rollouts stay disabled.

## Latest cross-plan checkpoint — 2026-11-17 (EP04 rollback requires complete publisher pin; `cc03889f` pushed)

`cc03889fc1b5f6dba7584323e32c94f1eddd5335` is remote-verified. Rollback review now also fails closed unless the candidate has a valid artifact digest, publisher ID, and 64-character publisher key fingerprint; the UI explains the missing pin and disables the action. This closes the legacy/incomplete-publisher edge of `79bdc2ef`. Rollback review test **2/2**, Shell typecheck and diff check pass. No rollback, deployment or rollout. Exact next action remains project-bound update review: reuse the signed release inspector only after adjusting for project scope/capabilities, and produce a read-only current/candidate pin and migration/resource diff; don't send project packages through the Space-shared contract. Continue other active requirements afterward.

## Latest cross-plan checkpoint — 2026-11-17 (EP04 signed rollback-candidate review; `79bdc2ef` pushed)

Code `79bdc2ef76521c492dbb984c2d7a08bc54c17685` is pushed and remote-verified. Project extension rollback candidates now show the exact signed host artifact SHA-256, publisher/key identity, signature and current key revocation state, plus permission/capability expansion before confirmation. Invalid receipts and revoked publishers cannot be selected for rollback. Focused Shell suites **13/13**, Shell typecheck and `git diff --check` pass. Local only; no browser/deployment/rollback execution or rollout. Preserve untracked `infra/scripts/__pycache__/`.

Exact next action: continue EP04 by determining whether the existing server-side shared-package update review contract can be safely extended to PROJECT_BOUND releases. Bind any preview to the exact installation generation/current version/current artifact and candidate manifest/artifact/publisher/dependency digests, return non-mutating migration/resource/cost deltas, and require owner CAS at apply. If no supported project-bound package candidate feed exists, keep update unavailable and implement an honest reason in UI; then continue other active-plan code gaps. Rollouts remain disabled.

## Latest cross-plan checkpoint — 2026-11-17 (EP04 verified staged-release provenance; `d7ae34f4` pushed)

`d7ae34f459e9aa2625613f17f82613151c5efe8d` is pushed and remote-verified. The owner-authorized staged-install listing now projects the DO's exact manifest, host-built artifact, and publisher signing-payload SHA-256 values, release version, and publisher key fingerprint only when the host release attestation validates. Current key trust is separate from signature validity, so a revoked key remains visibly revoked. The raw publisher signature is not rendered. Local checks: four focused Shell suites **11/11**, Shell typecheck, and `git diff --check`; no browser/deployment/live acceptance or rollout. Preserve untracked `infra/scripts/__pycache__/`.

EP04 now has preinstall declaration/source fingerprint review and post-stage host receipt visibility. Upgrade migration/rollback review, durable interrupted-setup recovery UX, and approved cost quote/unknown-cost presentation remain partial. Exact next action: trace `ExtensionReleaseControls` and the project-bound install API against the existing signed release/rollback routes; add a current-version-pinned owner review for a candidate update only if the server has a safe project-bound review contract. If absent, implement a fail-closed review API by reusing release attestation/dependency resolution, keeping migration approval non-mutating until commit. Then continue other independent requirements. Rollouts remain disabled.

## Latest cross-plan checkpoint — 2026-11-17 (EP04 install resource and provenance review; `83d81107` pushed)

`c04361e916bb72d5de9331cf9b44a001e5203fe8` and `83d811072110b0f19dbb7f319419abb60bff11a4` are pushed and verified on `origin/Mcbt5s-Backup-2`. The signed Canvas/Gadget install preview now shows validated resource kind/scope, operations, binding targets and bounded request limits before install, explicitly marking them as declarations (not grants/runtime availability) and limits (not prices). It also displays a SHA-256 fingerprint, file count and UTF-8 bytes for the exact canonical manifest/source signing payload; this is not the host-built runtime artifact digest, which is created after server validation. Local verification: Shell focused suites **9/9**, Shell typecheck and `git diff --check` pass. No browser, deployment, provider call, paid provisioning or rollout occurred. Preserve untracked `infra/scripts/__pycache__/`.

EP04 remains partial: signed install and preinstall declaration/provenance review are improved, but installer-state recovery, full immutable build/provenance receipt review, explainable known/unknown cost estimates, and upgrade migration/recovery review remain. EP03 still has no installed-extension-bound persistent parser/index runtime invocation. Other K/P/PW/S/U/AP/TBR items remain governed by their ledgers; do not treat live/deployment gates as code completion. Exact next action: inspect and implement the closest independent EP04 install/upgrade review gap by tracing the current signed release and staged-install API through the owner caller; surface exact server-validated publisher/artifact/dependency pins and unsupported/unknown price before confirmation, without inventing a quote. Then continue the next uncoded requirement across the other active plans. Rollouts remain disabled.

The following plan sources are active and jointly govern this mission:

- [Managed services and sidecar runtime plan](docs/research/managed-services-and-sidecar-runtime-plan.md), including S1–S9 and inherited U01–U12.
- [Platform completion and guided templates plan](docs/research/platform-completion-and-guided-templates-plan.md), including release/environment safety, commercial integrity and recovery, guided templates and microapp setup, voice, shared-Space coordination, and the incorporated planner/worker requirements in section 12.
- [Mature knowledge platform plan](docs/research/mature-knowledge-platform-plan.md), incorporated in platform plan section 14 and tracked as K01–K30 in [knowledge platform progress](docs/research/mature-knowledge-platform-implementation-progress.md). The source was fetched from `plan/microapps-ui-sdk-voice` commit `9358830e`; it was copied into this branch without switching or merging the planning branch.
- [Extensible platform and managed resources plan](docs/research/extensible-platform-and-managed-resources-plan.md), fetched from `plan/microapps-ui-sdk-voice` commit `e950f02b` and copied into this branch without switching or merging the planning branch. Its EP01–EP06 requirements are incorporated in platform plan section 15 and reconciled in the platform progress ledger; overlaps reuse K01–K30, P01–P24, PW01–PW06 and S/U records.
- [Template-defined business roles and member onboarding plan](docs/research/template-business-roles-and-member-onboarding-plan.md), fetched from `plan/microapps-ui-sdk-voice` commit `28d7c460` and copied into this branch with the explicit builder-defined-role clarification from `cdeb7def`. TBR01–TBR12 are incorporated in platform plan section 16 and tracked in [the dedicated progress ledger](docs/research/template-business-roles-and-member-onboarding-progress.md).
- [Resumable workers, durable workflows and branches plan](docs/research/resumable-workers-durable-workflows-and-branches-plan.md), fetched from `plan/microapps-ui-sdk-voice` commit `ccca618f` and copied without switching or merging. It extends PW01–PW06 in platform section 17 and is tracked in [its dedicated progress ledger](docs/research/resumable-workers-durable-workflows-and-branches-progress.md).
- [Shared compute scheduling and budget plan](docs/research/shared-compute-scheduling-and-budget-plan.md), fetched from `plan/microapps-ui-sdk-voice` commit `3770193d` without switching or merging. Reconciled requirements SC01–SC06 are tracked in [shared compute progress](docs/research/shared-compute-scheduling-and-budget-progress.md); overlaps reuse S/U/PW/TBR/Billing identifiers and ledgers. Existing cron dispatch, runtime concurrency admission, workflow queueing and billing holds remain separate authorities; no complete fair shared-capacity queue is claimed.
- [AgentPhone and AgentPort adapter evaluation plan](docs/research/agentphone-agentport-adapter-evaluation-plan.md), fetched from `plan/microapps-ui-sdk-voice` commit `3ef84165546a781ebcde6867d62e563f022385b9` and copied without switching or merging. AP01–AP06 are incorporated in platform section 18 and tracked in [its dedicated progress ledger](docs/research/agentphone-agentport-adapter-evaluation-progress.md). Provider capabilities, API behavior, regions and prices remain unverified claims.

The requirements from `docs/research/planner-worker-isolation-and-conflict-resolution-plan.md` at commit `45575a395df9571eb075f0a479c65144e767be7c` are incorporated into platform section 12 and managed section 20; PW01–PW06 track the reconciled requirements, extended by the new resumable-worker plan. No planning branch was checked out or merged. Reuse existing requirement IDs and progress ledgers when plans overlap. Do not restart completed work or claim completion from historical notes alone. After compaction, interruption, or a new session, read every active plan source and all durable progress records (managed services, platform completion, mature Knowledge, unified workspace, template roles/onboarding, resumable workers, AgentPhone/AgentPort, and shared compute; EP is tracked in platform progress), and this runbook; inspect the actual branch, worktree and uncommitted changes; then resume from the exact next unfinished action in the records.

## Recovery checkpoint discipline

For every coherent source, configuration or documentation change, verify it, commit it, then fetch and push it to `origin/Mcbt5s-Backup-2` before moving to the next change. Record the pushed SHA, evidence, remaining uncoded work, separate live/deployment gates and exact next action in this runbook and the relevant progress ledgers. Fetch immediately before each push; preserve concurrent remote commits and integrate them without force-pushing. Never stage unrelated untracked files such as `infra/scripts/__pycache__/`.

## Previous cross-plan checkpoint — 2026-11-17 (TBR05 copy-only verified Product-member invitation; `743c2284` pushed)

The D1 invitation ledger (migration 0278) is separate from SpaceDO's platform-collaborator membership. A Product Space owner/admin can create a seven-day copy-only invite for a normalized email; only keyed hashes persist, at most 100 pending invitations are admitted, duplicate pending recipients are fenced, owners alone may invite admins, and invitation status can be listed/revoked. Redemption is reachable through authenticated Product-session routing and requires the same active Product account, current verified email, matching tenant/Space/Product, unused unexpired token, and the inviter's current owner/admin membership; the membership insert and invite acceptance run in one D1 batch. No invite email/SMS is sent.

Code `743c22844bd194499a61da00ca76d45ce19ba313` is pushed and remote-verified. Evidence: Spaces invitation lifecycle tests **3/3**, Router Product-session path tests **79/79**, Spaces/Router typechecks, release manifest tests **5/5**, migration inventory **278**, SQLite migration/Space-deletion trigger exercise, and `git diff --check`. This is local Worker/D1 mock coverage only; migration 0278 is unapplied. No browser, deployed D1, message delivery or live multi-user acceptance occurred. TBR05 is partial: the route assigns only a generic Space role and has no builder-defined role assignment/onboarding UI. TBR06 has no cross-service resource-grant application/recovery. Rollout stays disabled; preserve untracked `infra/scripts/__pycache__/`.

Exact next action: bind connector-poll execution to the current enabled connector authorization/configuration revision and durable service session; recheck before each effect and after HITL resume. Preserve existing exact-action approval and deny effects where the host has no connector grant contract. Then continue TBR06 only for host grant classes with a specified mapping, plus remaining S/U/P/PW/K/EP/AP code gaps. After interruption, read every active plan and progress record, inspect the actual branch/worktree, and resume from this exact action.

## Previous cross-plan checkpoint — 2026-11-16 (PW exact worker branch revision pin; `c17b6e01` pushed)

The owner/admin activation preview resolves role proposal symbols against the target Space's current trusted extension pin: planned Projects, installed extensions/microapps, catalog-only dependencies, undeclared resources and unsupported shared-data are distinct. It shows requested versus package-declared actions, but role-effective actions stay empty because proposals create no grants; Knowledge symbols say `declared_only` because package declarations do not prove a published target collection. Cost is explicitly unavailable without a role pricing contract. Shell displays these limits. TBR04 remains partial: independent current grants, role conflict/composition, published Knowledge state and an actionable cost model are not fully resolved, and no grant writes exist.

Delegated worker execution now pins the exact Coordinator branch revision and manifest hash from the host through the authenticated runtime invocation. Coordinator branch creation checks the expected source revision/hash inside its transaction; ToolSandbox validates current head before and after pending checkpoint replay, then verifies the runtime `runs/...` branch base and materialized head. Stale/wrong pins fail closed. Code `c17b6e01709d16cfa8ea01eaf57f37abc52dc0ce` is remote-verified. Evidence: Agents sandbox/coordinator/container-policy/execution-ladder suites **155/155**, Agents typecheck, `git diff --check`. Local DO/function mocks only; no deployed Container, cross-tenant environment/cache/credential/network isolation, or live acceptance. Worker isolation is therefore partial, not provider-proven.

Prior TBR04 preview commits `9fc1930d`, `f9596f4a`, `889bc42b` remain remote-verified: owner/admin preview resolves trusted extension/microapp pins, distinguishes declared-only Knowledge, scopes action declaration matches, and applies no grants. Spaces tests **27/27** and Spaces/Shell typechecks pass; no browser or deployment. TBR04 remains partial for effective independent grants, role composition/conflicts, published Knowledge source and cost. AgentPhone remains provider-unsupported pending verified API/auth/event/voice/commercial contracts; no number, call, message or spend action occurred. Preserve untracked `infra/scripts/__pycache__/`; rollout remains disabled.

Exact next action: continue TBR05 by tracing current tenant/Space membership and authenticated Product-user identity paths; implement owner-reviewed single-use, audience/Space-bound invitation persistence and redemption only on an existing identity authority, with simulated delivery only. If no stable invitee identity contract exists, implement the independent durable owner-review intent and redemption fence, record the exact identity/product gate, and continue. Then TBR06–TBR12 and remaining S/U/P/PW/K/EP/AP code gaps. The `shared_data` reference remains unsupported until a signed ID-to-host-resource/ACL mapping is specified. After interruption read all seven plan sources and all seven progress ledgers, inspect this worktree, and continue from this exact action.

## Latest code checkpoint — 2026-11-16 (AgentTask recovery status in task API/Shell; `fc3318bb` pushed)

The already-authorized Space/session or Project task list and task detail now include a content-free checkpoint summary after task-scope authorization. It exposes the latest completed step, sequence, timestamp, digest prefix and byte count, detects a journal update after that checkpoint, and never returns the R2 key or result body. Scope mismatch and unavailable/no-checkpoint states fail closed. Shell shows the last verified step and explicitly warns that later work may be unsaved and process memory is not recoverable. This does not implement runtime isolation or restore unsaved memory.

Code `fc3318bb702d355a21998b22651761edd591d307` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Local evidence: recovery summary tests plus AgentTask checkpoint, WorkflowJournal and WorkflowRunDO tests **28/28**; Agents and Shell typechecks; `git diff --check`. A package-manager wrapper attempted an automatic workspace install and safely stopped because it could not remove modules without a TTY; direct checked-in Vitest/TypeScript binaries were used successfully and dependencies were not modified. No deployed DO/Workflow/R2, browser, runtime isolation or live acceptance ran. Preserve untracked `infra/scripts/__pycache__/`.

The AgentPhone evaluation plan from planning commit `3ef84165546a781ebcde6867d62e563f022385b9` was copied and incorporated in docs checkpoint `9a4450d17d4c9612431499769a67b107f35b7dfe`; AP01–AP06 are in platform section 18 and the dedicated ledger. All AgentPhone capabilities, API behavior, terms, regions, and prices remain unverified provider claims. No account, number, call, message or spend action occurred.

Exact next action: continue PW runtime branch mount/isolation audit at the actual allocation and worker launch callers, then implement the smallest independently supportable exact branch/revision binding and isolation fence with focused tests. Continue TBR02 builder authoring and all other S/U/P/PW/K/EP/AP code gaps afterward. Keep rollouts disabled.

## Latest code checkpoint — 2026-11-16 (delegated worker runtime object isolation; `21de8512` pushed)

Delegated `workers/...` branches now route to distinct exact-branch ToolSandbox/DynamicSandbox Durable Object names, separating their warm runtime process and private `/workspace` disk. The project main and ordinary feature branches keep their existing stable shared route; model-race branches remain isolated. Evidence: sandbox routing and execution-ladder tests **27/27**, Agents typecheck and diff check. Code `21de85123e85ead3aa1f7c2b107c0aa6ce890973` is pushed and remote-verified. This does not yet pin a workspace revision/head into runtime mounts, prove cache/credentials/network isolation across provider deployment, or restore unsaved process state. No deployed runtime test or rollout ran.

Exact next action: trace delegated worker branch creation and runtime launch back to the WorkspaceCoordinator branch head; pass and validate the exact authorized base/head revision for each `workers/...` runtime, ensuring mount/copy only reads that pinned immutable head and that publication still uses checked CAS. Add stale-head, wrong-branch, retry and concurrency tests. Then continue TBR02 and remaining S/U/P/PW/K/EP/AP code gaps. AP01's generic evidence-backed catalog already exists; do not duplicate it or claim AgentPhone support without contract evidence. Preserve `infra/scripts/__pycache__/`; rollouts remain disabled.

## Latest code checkpoint — 2026-11-16 (TBR02 business-role builder authoring; `1f4945aa` pushed)

Foundry Template Studio now saves/restores builder-authored business-role proposals in its bounded durable authoring draft, previews them as `ownerReviewRequired` with `grantsApplied:false`, and includes them in the owner-only template export. An SDK authoring helper canonicalizes the schema against exported Projects, selected extension IDs and declared Knowledge references; export accepts only the matching v1 schema and places the proposals in the normal signed blueprint/conformance artifact path. The Foundry package release is `1.4.0`. This path neither invites members nor grants access.

Code `1f4945aac8656320fae5f1fa10c6ae4cdae7a81f` is pushed and remote-verified. Local evidence: SDK business-role + dogfood Studio tests **8/8**, Spaces template authoring/export tests **17/17**, SDK and Spaces typechecks, and diff check. No browser, marketplace release, deployment or membership/grant mutation ran. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

Exact next action: implement TBR04's owner review resolution against the target Space's current installed resources and permission state. Report available/unavailable symbolic references and requested-versus-effective actions without writing grants; recheck exact package digest and Project/private policy. Add owner-only route/UI, stale package/revocation tests, then continue TBR03/TBR05–TBR12 and remaining S/U/P/PW/K/EP/AP code gaps. Resume runtime branch head/revision binding afterward; AP01 generic verified catalog exists, but AgentPhone remains unsupported pending verified contract/evidence.

## Latest code checkpoint — 2026-11-16 (durable AgentTask step checkpoints; `1dd54057` pushed)

`WorkflowJournal` now stores a bounded ordered lineage of completed AgentTask workflow steps, each tied to its already-registered, scope-validated immutable artifact pointer. The static AgentTask wrapper records a checkpoint only after the native durable step returns; exact replay is idempotent and a changed pointer for the same step conflicts. This establishes last verified step output, not full assistant transcript recovery, process memory, or runtime isolation. Evidence: workflow state, WorkflowRunDO and AgentTask checkpoint tests **26/26**, Agents typecheck, and diff check. Local tests only; no deployed Workflow/DO/R2 recovery acceptance ran. Code `1dd540579b8af79c5dcbfcc638c0a384d5b3502c` is pushed and remote-verified.

Exact next action: expose the last verified checkpoint and explicit recovery limitations through the existing authorized worker/task status API and Shell view; test exact-user/private-Project access and stale checkpoint reporting. Then continue runtime branch mount/isolation and TBR02 builder authoring. Keep rollouts disabled and preserve untracked `infra/scripts/__pycache__/`.

## Previous code checkpoint — 2026-11-16 (TBR01 signed role proposals; `9ccd7395` pushed)

The Agent SDK adds an optional, backward-compatible v1 business-role proposal contract to signed `SpaceBlueprint`s. It covers localized arbitrary role IDs/names, descriptions, generic Space-role recommendations, symbolic Project/extension/microapp/Knowledge/collection/shared-data/action requests, assistant mode/instructions, onboarding steps and non-binding spend/approval suggestions. Strict validation rejects unknown fields, duplicate or ambiguous references, undeclared Project/extension/Knowledge references, invalid bounds and oversized declarations. Security scanning covers role text and rejects injection/script payloads. The owner/admin activation preview surfaces only `proposal_requires_owner_review` data with `grants_applied: false`; it does not resolve installed-resource permissions or apply grants.

Code `9ccd739538f4e0a8751ff9d289385adc5df4661b` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Local evidence: Agent SDK role/compiler **11/11**, Security blueprint **6/6**, Spaces activation preview **26/26**, Agent SDK/Security/Spaces typechecks, and diff check. No invite, membership/grant write, migration, deployment, browser, provider or multi-user acceptance ran. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

TBR01 is `IMPLEMENTED_LOCAL`. TBR03 is partial because installed microapp/shared-data declaration resolution, role-combination conflict policy and a product action catalog remain open. TBR04 is partial: the preview does not calculate actual availability, effective access or costs. TBR02 builder authoring, TBR05–TBR09 grant/authorization/shared-data callers, TBR11 universal service identities and TBR12 onboarding UI/acceptance remain open. TBR10's private-Project owner/admin policy remains a product/security decision. These code gaps are not credential blockers.

The newly incorporated resumable-workers plan takes the next slot because it extends the active PW lifecycle. Exact next action: trace `WorkflowRunDO` step/artifact persistence and worker recovery/approval-resume callers against PW01–PW06; then implement the smallest missing durable checkpoint/recovery transition with focused interruption/replay coverage. Keep runtime isolation distinct from logical branches and unsaved process memory, and keep rollout disabled. TBR02 remains the next role-plan action after this trace/slice.

## Latest code checkpoint — 2026-11-16 (K09 bounded website crawl; `0842ac0e` pushed)

Migration 0277 adds content-free crawl operations/pages with tenant/Space/Project/owner/connection scope, idempotency and request hashes, generation leases, seven-day cleanup and grant/Project-owner deletion triggers. The Project owner can discover same-origin/path-approved pages only while the explicit rollout flag is true; Knowledge rechecks Project owner and active connection/policy before and after fetches. Each target and redirect rechecks HTTPS/origin/path, robots and SSRF. Depth, pages, links, redirects, page/total bytes, request time, retries, per-request pages, and two active operations per tenant are bounded. Only URLs, state, bytes and sanitized-content hashes persist; page text is not returned or indexed. Shell exposes an owner terms attestation and explicit page selection into the existing one-page preview/review flow. The crawl flag remains false in dev/staging/prod.

Code `0842ac0ecaac5b6e4a99e4602bfba9a96c53bdae` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Evidence: Knowledge **174/174**, Security **124/124**, Shell Knowledge API **5/5**, Knowledge/Shell typechecks, release inventory **277**, release/deployment validators, Python release/deployment/migration suites **39/39**, SQLite route/migration/trigger exercises, and `git diff --check`. These are local tests/mocks/SQLite only; no browser, deployed Worker/D1, live site-terms verification, provider or rollout acceptance ran. Migration 0277 is unapplied. Preserve all untracked `infra/scripts/__pycache__/` files; none were staged.

K09 is `IN_PROGRESS`: bounded crawl code is implemented locally, but applicable site-terms policy is not resolved; an owner attestation is not a site-terms registry or legal acceptance. Deployed crawl and redirect/revocation acceptance remain open. K08 provider connectors/cursors, aggregate operations and a supported price contract remain partial. K10 has no upstream ACL identity-proof connector. The new template-role audit found no role schema or invitation/redemption flow, and it records a private-Project owner/admin policy mismatch plus missing universal no-user service identities. Keep all rollouts disabled.

At this earlier K09 checkpoint, the new template-defined roles plan had just been fetched from `28d7c460` plus clarification `cdeb7def`. Its TBR01 action is now complete in `9ccd7395` above. The owner/admin private-Project rule and role/policy precedence remain explicit product/security decisions; autonomous jobs need separately scoped identities, not borrowed owner authority.

## Previous code checkpoint — 2026-11-16 (PW06 cancellation/publication fence; `73e3fcc4` pushed)

PW06 now has a parent-DO SQLite permit that atomically checks the exact worker attempt is still active and binds publication to the validated candidate, target branch/head and manifest hash. Cancellation before that transaction blocks publication. A permit is the cancellation linearization point: a checked publication already authorized by the permit may finish after the worker becomes `terminated`; the host then stores and exposes the exact outcome through the scope-checked worker view without changing the worker's terminal status. Current Project write access is rechecked immediately before the Artifact Worker call. Unresolved attempts remain `outcome_unknown`; no uncertain publication is replayed.

Code `73e3fcc4b27d24065c4ef26a0a5430c152685c18` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Verification: worker integration/delegation tests **24/24**, Agents typecheck, `git diff --check`, and an in-memory SQLite transaction exercise for permit-before-cancel, cancel-before-permit and terminal outcome retention. These are local checks, not a real Durable Object, Artifact Worker, Workspace Coordinator or deployment race test. Worker/runtime isolation, cost settlement, revocation across the full lifecycle and deployed concurrency/recovery acceptance remain open. Keep rollout disabled and preserve untracked `infra/scripts/__pycache__/`.

Reconciliation correction: EP02's plan requires a host-managed bounded object service but does not require R2. Current SpaceDO code already provides the signed Project/install object caller using scoped SQLite, owner grant and generation/release fences, one-use leases, 64 KiB/object and 64-object/512 KiB/install quotas, cleanup on uninstall/release change, and versioned archive recovery. Do not add an R2 mirror without a complete retention, cleanup, archive and billing design. Object/job/structured-data capability descriptors remain unavailable pending applicable acceptance; no rollout is enabled.

Exact next action: implement K08 owner-opt-in scheduled/incremental refresh for existing owner-approved single-page website sources by reusing the source revision, active website grant, K09 path/robots checks and durable refresh ledger. Add duplicate/missed schedule, stale completion and revoke-during-refresh coverage. Keep crawler/provider-sync and Knowledge rollout disabled until their source-consent and deployed acceptance gates pass; continue remaining S/U/P/PW/K/EP code gaps afterward.

## Previous code checkpoint — 2026-11-16 (AgentMail per-conversation routing; `3ee64def` pushed)

Owner-authorized AgentMail thread overrides now sit above the existing account-level route. The owner Shell lists up to 100 active conversations using hashed thread keys and timestamps only, validates the selected provisioned assistant, verifies the exact AgentPort subscription/channel/thread, and can save, pause or reset an override. Dispatch prefers a matching conversation route, keeps the account default as fallback, and persists route kind, hash and revision before wake; stale revisions are dropped and a paused override does not fall through. Migration 0274 persists the scoped route and dispatch pin. No user-issued switch command or sender identity is added.

Code `3ee64defbc429f66a16d5a26070eadc85a42a431` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Local evidence: AgentMail and AgentPort dispatch tests **22/22**, Agents and Shell typechecks, migration inventory **274**, release/deployment manifest checks, release migration tests **20/20**, manifest tests **5/5**, and `git diff --check`. These are local tests and Worker/SQLite mocks. Migration 0274 is unapplied; no browser, Worker deployment, live AgentMail/AgentPort acceptance, identity verification, or rollout ran. Keep rollouts disabled and preserve `infra/scripts/__pycache__/`.

S6 remains `IN_PROGRESS`: only the owner-authorized AgentMail per-conversation path is implemented locally. Generic provider routing, verified external identity and user-issued assistant switching remain unsupported pending a verifiable channel-identity contract and consumer persistence behavior. S3/U05 also remains blocked by the missing supported main-runtime allocation lane, selectable immutable image digest and trusted runtime observation producers; this is a platform contract gap, not a credential blocker. The EP02 object action was later reconciled as already implemented in local scoped SQLite plus archive recovery; the R2-specific suggestion was not required by the plan and is superseded by the current checkpoint above.

## Previous code checkpoint — 2026-11-16 (K14/K17 language-pair evaluation; `d6f6cfb7` pushed)

The local Knowledge search route now feeds K17 through a content-free trace whitelist. The evaluator reports ranking, citation/source-version, forbidden-scope, abstention, latency and cost metrics overall, per query language, and per query/source-language pair. Caller-supplied thresholds must pass at each level, so a strong aggregate cannot hide a weak language or cross-language direction. Report schema is version 2. It always reports `acceptanceEligible: false`; no default business thresholds were selected. These are synthetic/local evaluation features, not evidence of multilingual quality.

Codes `4e3c3a7a`, `3d67805e` and `d6f6cfb7` are pushed to and remote-verified on `origin/Mcbt5s-Backup-2`. Verification: evaluator tests **6/6**, actual local Knowledge search-route integration tests **6/6**, Node syntax check and `git diff --check`. Shona/Ndebele/cross-language cases remain synthetic or absent; no human domain review, provider search, deployed measurement, invoice, migration or rollout ran. Keep rollout disabled and preserve `infra/scripts/__pycache__/`.

K14/K17 remain `IN_PROGRESS`: current data are synthetic English only, and reviewed Shona/Ndebele/domain examples, representative provider/deployed measurements and release approval remain absent. The evaluator and route-threshold code gaps are closed above; native/domain quality review and deployed evidence remain open.

## Previous code checkpoint — 2026-11-16 (K17 evaluator and K14 language review guard; `ab01086d` pushed)

The K17 offline evaluator in `infra/scripts/knowledge-retrieval-eval.mjs` scores Recall/Precision@K, MRR, nDCG, citation precision/recall, stale source versions, forbidden candidate/citation exposure, abstention accuracy, p95 latency and recorded cost. Its versioned JSONL fixture is synthetic and English-only. Reports omit query text, identify incomplete cases/language review, require English/Shona/Ndebele by default, and always keep `acceptanceEligible` false until reviewed data, thresholds and deployed/provider evidence exist. K10 source audit found only manual and owner-approved website sources; no upstream file ACL identity proof connector exists. MCP connector aliases are tool-call grants, not provider file-ACL evidence; K10 remains uncoded pending a supported identity proof contract.

Evaluator base code `c908c088871648aa06dcb80a0741bd94d89ed851` and language coverage guard `ab01086d651ff607450411bc66f195dfb018cf8c` are pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Verification: evaluator tests **3/3**, JSONL CLI smoke and `git diff --check`. The smoke used no retrieval results and confirmed acceptance remains false with missing Shona/Ndebele coverage; it is not a quality measurement. No provider search, deployed route, human language review, cost invoice, migration or rollout ran. Preserve `infra/scripts/__pycache__/`; rollouts remain disabled.

K17 is `IN_PROGRESS`; at this checkpoint trace-to-search integration and threshold comparison had not yet been added. K14 had no reviewed language corpus or quality results. These code gaps are addressed in the latest checkpoint above; human and deployed acceptance remain open.

## Previous code checkpoint — 2026-11-16 (K13 shared chunk and citation spans; `90278732` pushed)

Knowledge text ingestion now uses one bounded offset-aware chunk contract across synchronous create, content edits, and the reachable Project Workflows queue. Text chunks retain original UTF-16 source offsets through CRLF normalization; citations convert those spans to UTF-8 bytes and one-based lines. Plain text chunks stay at the existing 512-token approximation with 50-token overlap and a 2,048-character ceiling; PDF extracted Markdown keeps the bounded structural/table chunker. The workflow's old 10 KiB split is removed; internal batches allow up to 12,000 indexed chunks (the 5 MiB source limit remains the practical bound). D1/vector records now persist source spans consistently, and citation retrieval reads the exact bounded chunk object and verifies its content hash instead of treating source offsets as offsets into that chunk file.

Code `9027873242af4243343d9f834f6dce0c40504fdf` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Evidence: RAG **28/28**, Knowledge **150/150**, reachable Workflows test **8/8**, RAG/Knowledge/Workflows typechecks, and `git diff --check`. The tests are local Worker/provider mocks. No migration, deployment, browser, provider or live acceptance ran. `pnpm` attempted an automatic workspace module-directory rebuild after the lockfile change and safely aborted without touching `node_modules`; verification used the existing local binaries. Rollouts remain disabled and untracked `infra/scripts/__pycache__/` remains untouched. AutoRAG remains hard-disabled pending K15 authorization/isolation acceptance; no AutoRAG or live embedding citation support is claimed.

K13's reachable synchronous, edit and queued ingestion paths are `IMPLEMENTED_LOCAL`; deployed embedding behavior and live citation acceptance remain unverified. K08/K09 remain partial for scheduled/incremental sync, crawl queue, terms and freshness operations. The K10 audit and K17/K14 evaluator guard are recorded in the latest checkpoint above.

## Previous code checkpoint — 2026-11-16 (K08 bounded website refresh; `7732d992` pushed)

Migration 0272 adds website-source freshness fields and a private refresh-operation ledger with one-active-operation fencing, source revision/connection binding, idempotency hashes, safe error codes, retries and backoff. Existing owner-approved website snapshots can be manually refreshed through the same Project owner preview/review flow. Refresh receipts bind the operation, document revision, connection, URL and sanitized preview hash; the update uses revision/grant CAS and advances the source only after successful reindex. Interrupted fetch leases recover after two minutes and surface a bounded retry time. Project Shell shows last attempt/success, failure and next retry. URL query strings and fragments remain rejected to avoid persisting source credentials.

Code `7732d992a471440ec6271e614705244e8bab59aa` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Local evidence: Knowledge **141/141**, Shell Knowledge API **3/3**, Knowledge/Shell typechecks, release inventory **272 migrations**, release/deployment manifest validators, release/deployment/migration Python tests **39/39**, and `git diff --check`. Migration 0272 is source-only and unapplied. Tests are local mocks/SQLite; no browser, deployed Worker/D1, scheduled sync, provider, or live acceptance ran. Rollouts stay disabled, AI Search remains unselected, and `infra/scripts/__pycache__/` remains unstaged.

K08 is `IN_PROGRESS`: the manual refresh/retry lifecycle is implemented, but scheduled or incremental sync, source cursors/checkpoints, change detection, costs and operational reporting remain uncoded. K09's owner-configured path prefixes and robots checks have since been implemented in `fb6edf25`; bounded crawl, site terms and scheduling remain open. Resume from the exact K10 action in the latest K13 checkpoint above.

## Latest code checkpoint — 2026-11-16 (K09 owner path and robots policy; `fb6edf25` pushed)

Migration 0273 adds `knowledge_path_prefixes_json` to host `website_connections`, defaulting existing connections to `/`. The owner connector screen configures bounded canonical path prefixes; the host API validates and persists them, and the owner list caller returns them. Knowledge checks HTTPS, origin, path prefix and robots.txt before every page fetch and every redirect. Robots is bounded to 256 KiB and evaluated using the NaelaoKnowledge agent token; the most specific rule wins and Allow wins ties. Missing robots.txt (404/410) is allowed; inaccessible, oversized or unexpected-type policies fail closed. The total robots-plus-page fetch deadline is 45 seconds; the page remains capped at 1 MiB with five redirects and safe MIME types.

Code `fb6edf2595394add136fe474c79fd89f1b83ac02` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Evidence: Knowledge **146/146**, website-connection route tests **14/14**, Knowledge/Spaces/Shell typechecks, release inventory **273 migrations**, release/deployment validators, Python release/deployment/migration tests **39/39**, SQLite migration/default exercise, and `git diff --check`. The full Spaces suite ran **653/657**: four failures outside the changed route concern a stale migration-count expectation, executive-contact data, dynamic-page replay status and an extra Project membership read expectation. Migration 0273 is source-only/unapplied. No browser, deployed Worker/D1, crawler, provider, or live acceptance ran; rollout stays disabled and AI Search stays unselected.

K09 remains `IN_PROGRESS`: path and robots checks protect manual one-page create/refresh, but there is no multi-page crawler, crawl queue, consent/site-terms registry or scheduler. K13's reachable sync, edit and Workflow paths are now aligned and pushed as `90278732`. Continue at K10 as recorded in the latest checkpoint above.

## Latest code checkpoint — 2026-11-16 (K07 owner-approved website snapshot; `99f9081c` pushed)

Project owners can preview a page through their exact active host-owned `website_connections` grant. Knowledge rechecks tenant/Space/user/Project and approved origin, follows at most five redirects while applying both origin and SSRF checks at every hop, accepts bounded HTML/Markdown/plain text, sanitizes it, and issues a 15-minute HMAC receipt bound to the preview hash, requested/final URLs, connection and owner. Project Shell lets the owner review/edit and save that snapshot through the idempotent Knowledge create path. Migration 0271 requires a host connection reference/grant revision for current website sources and caps each connection at 100 pages. Publication, retrieval and citations check the live connection; revocation immediately blocks reads and starts the existing durable deletion pipeline. If Knowledge cleanup is unavailable, the host still revokes the browser profile and returns retryable status.

Code `99f9081ced263c219831757c2d504124050a5ff5` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Local evidence: Knowledge **131/131**, Spaces website-connection tests **11/11**, Shell Knowledge API **2/2**, Knowledge/Spaces/Shell typechecks, release manifest inventory **271 migrations**, standalone SQLite grant/100-page-trigger check, and `git diff --check`. Migration 0271 is source-only and unapplied. Tests use local mocks/SQLite; no browser, deployed Worker/D1, scheduled crawler, provider or live acceptance ran. Rollouts stay disabled, AI Search remains unselected, and untracked `infra/scripts/__pycache__/` remains untouched.

K07 remains `IN_PROGRESS`: this is an owner-approved single-page snapshot with manual refresh, not a logical connector registry, scheduled sync or provider connector. K08 incremental cursors/checkpoints/retries/freshness UI remain uncoded; K09 still needs an approved path/robots policy and durable crawl/refresh lifecycle. Exact next action: implement K08's durable provider-neutral refresh state and owner-visible freshness/retry status for the existing website source, fencing updates by source revision and connection grant; test duplicate/lost responses, out-of-order completion, revoke-during-refresh and deletion. Then continue the remaining K/S/U/P/PW/EP gaps. Keep rollout disabled.

## Latest code checkpoint — 2026-11-16 (K07 versioned Knowledge source lineage; `3bf31c66` pushed)

Migration 0270 adds versioned source lineage to canonical `kb_documents`: adapter kind, source revision, private content hash, opaque host connection reference/grant revision and source state. Existing manual sources backfill as current; URL-backed entries are marked `unsupported` for refresh rather than implying they are synced. New manual creates persist a hash/version; content edits advance the version and hash; deletion advances/revokes the source and clears private references. Archive export/restore preserves the fields. Public document responses omit content hashes and connector references. Connector rows cannot be written without a bounded opaque host reference and grant revision.

The release `schema-manifest.json` was stale at 0265 and omitted already-present migrations 0266–0269; it now includes their verified hashes and migration 0270. Code `3bf31c665451aceb48aa047680d67309524cac00` is pushed and remote-verified. Verification: Knowledge **121/121**, Knowledge typecheck, release migration inventory **270 files**, `git diff --check`, and SQLite migration backfill, connector-row rejection, idempotent insert and archive-insert exercises. Migration 0270 is source-only/unapplied; no deployment, browser, provider or live acceptance ran. Rollouts remain disabled; preserve `infra/scripts/__pycache__/`.

K07 remains `IN_PROGRESS`: the new fields are document-bound lineage, not a complete logical source registry. No host connector-grant issuer/verification caller or durable website refresh adapter exists; URL content remains unsupported until that caller is implemented. Exact next action: connect approved website sources to the existing host-owned `website_connections` authorization record and a bounded, redirect-revalidated Knowledge fetch/create path; persist the approved connection reference and source revision only after owner/Project/origin checks. Add revoke, cross-origin, redirect, retry and deletion tests. Do not treat this as a credential blocker; continue K08 and the other K/S/U/P/PW/EP gaps afterward.

## Latest mission checkpoint — 2026-11-16 (K06 attachment/channel scope verified; current code `0642ece4`)

The K06 caller trace is complete against the current source. Ordinary conversation uploads become task-scoped `channel_attachments`; they are never inserted into Knowledge or external-publication membership. Extension attachment metadata and reads require the exact active tenant/Space/task/channel/Project/installation/provider-connection tuple, a declared bounded capability, and an active channel binding. Attachments reach an answer only as transient current-message context. Web, WhatsApp and email use the common channel handler; before searching it re-reads the active owner-published Project collection directory, checks the current shared-install revision grant where applicable, and sends the expected revision to Knowledge for its own pre-rank/result-edge checks. The separate phone extension caller rejects handlers with nonempty Knowledge declarations, so voice Knowledge is unsupported and fails closed rather than bypassing the grant path.

Verification: Agents attachment/store/upload/selection/phone caller suites **29/29** and Knowledge external-publication suite **9/9**. This is local test evidence, no production/live voice or channel acceptance. No source code changed in this audit. K06 is locally satisfied for scope enforcement; phone Knowledge availability remains unsupported. Keep all rollouts off and preserve `infra/scripts/__pycache__/`.

K06 scope enforcement is locally verified; K07 source lineage is the current code checkpoint above. K05 ownership-transfer and retention semantics remain unresolved product contracts.

## Latest code checkpoint — 2026-11-16 (K05 publication lifecycle audit and ID retirement; `890b2a55` pushed)

The Knowledge API now exposes bounded `published`, `updated`, `archived`, `restored_as_draft`, and `deleted` receipts through the owner/admin `administer` boundary and the Project Shell history view. Delete writes an exact-scope tombstone and event before the publication disappears; a tombstoned collection ID cannot be reused, so its revision cannot reset and revive an old extension grant. The lifecycle receipt is content-free and remains inspectable after deletion by an authorized Project administrator.

Code `890b2a55a56be746a1018016e63504f536795bab` (implementation `c4234acd`) is pushed and remote-verified. Local evidence: Knowledge suite **120/120**, Shell API caller **1/1**, Knowledge/Shell typechecks, `git diff --check`, and SQLite-backed migration/API tests for migration preservation, revision conflicts, archive replay, owner/admin denial, audit history, deletion and ID non-reuse, archived/cross-Project source denial, and explicit republish. Migrations 0268–0269 are source-only and unapplied; no browser, deployment, provider or live acceptance ran. Resource catalogs and rollouts stay disabled. `infra/scripts/__pycache__/` remains unstaged.

K05 remains `IN_PROGRESS`: collection ownership follows the Project scope, but generic transfer and any retention schedule still need explicit product policy. K06's attachment/channel caller trace and K07's partial source lineage are recorded in the latest checkpoints above. Exact next action is the scoped website fetch/create caller described in the K07 checkpoint, followed by K08 and remaining K/S/U/P/PW/EP code gaps. Keep rollouts disabled.

## Previous code checkpoint — 2026-11-16 (K05 separate discover/source-read APIs; `0c93eade` pushed)

The existing Project collection API now supports owner/admin archive and restore-as-draft with exact expected-revision CAS. Each transition advances the publication revision, records a content-free actor/action/revision event, detaches the current published document membership and invalidates owner-approved installation revisions. Archived collections leave the host's current publication directory and Knowledge retrieval; restoring only creates an empty draft, so source selection and installation approval must be performed again. The Project Shell lists archived state and exposes Archive/Restore draft controls.

Code `1e76c55cefc32df646cc49c0166cd7ea40e65a58` is pushed and remote-verified. Local evidence: the full Knowledge suite **119/119**, Knowledge and Shell typechecks, `git diff --check`, and SQLite-backed migration/API tests covering archive replay, stale revision, owner authorization, grant-directory exclusion, search denial, restore-as-empty-draft, audit receipt and explicit republish. Migration 0268 is source-only and unapplied; no deployment, browser, provider or live acceptance ran. Resource catalogs and all rollouts remain disabled. `infra/scripts/__pycache__/` remains unstaged.

K05 remains `IN_PROGRESS`; generic ownership transfer, retention schedule and a complete discover/read/use/manage/share/delete/administer contract are open. Exact next action: separate collection discovery metadata from source-membership reading on the existing Knowledge API: the list must return only discoverable collection metadata, while an explicit scope-checked source-read endpoint returns document IDs only to authorized Project readers. Update Shell to fetch sources for editing, preserve the extension-only revision-pinned `use` grant, and test member/owner/outsider, archived and cross-Project boundaries. Continue the other K/S/U/P/PW/EP code gaps after this.

## Previous code checkpoint — 2026-11-16 (EP02 durable Project jobs broker; `248d3838` pushed)

The Project/install jobs path now reaches the Agent SDK, signed workflow caller, WorkflowRunDO receipt journal, current owner grant/release checks, D1 ledger, scoped R2 payload, Billing reservation, and Agents `AGENT_TICKS` dispatcher. Durable rows bind tenant/Space/Project/install, requirement, signed manifest/resource hashes, release version/artifact digest, install generation, grant revision, actor, caller/parent/effect and idempotency/request hashes. Payloads are bounded and remain in R2; Queue sends only scoped IDs. Admission enforces owner-approved run/monthly credits, per-requirement active concurrency and request rate. Stable child start identity reconciles lost replies; dispatch attempts, live leases, deadlines, revocation, status and payload cleanup are covered. A final review fixed the race where a duplicate tick could dead-letter the fifth attempt before its live start lease expired.

Code `248d3838fbfa9314eae0ae9f854f655328c8cc06` is pushed and remote-verified. Local evidence: Agents **47/47**, SDK extension/taxonomy **44/44**, Agents and SDK typechecks, `git diff --check`, and a real SQLite migration/conditional-admission exercise. The D1 migration is source-only and unapplied; no queue/DLQ, Worker, browser, Billing-provider/invoice or live acceptance ran. Resource descriptors stay unavailable and rollouts remain disabled. `infra/scripts/__pycache__/` is preserved and unstaged.

EP02's bounded Project `jobs` broker is implemented locally, not released or live-accepted. No S1–S9/U01–U12, P/PW or K statuses are implied complete by this slice. Exact next action: continue K05 with a versioned archive/unarchive transition on the existing Project publication collection. Make archive suppress discovery and invalidate active collection-use grants, require explicit republish/reapproval before exposure returns, and wire the current owner API/Shell caller with CAS, authorization, stale-grant and retrieval-exclusion coverage. Keep retention periods and generic ownership-transfer semantics open unless existing product authority supplies them; then continue the remaining K/S/U/P/PW/EP gaps. Fetch before each push; never force-push or enable rollout.

## Previous code checkpoint — 2026-11-16 (EP02 signed jobs contract and owner review; `90088bd7` pushed)

The SDK now accepts only Project-scoped `jobs` requirements with bounded `enqueue`/`status` schemas, exact signed workflow targets and a non-recursive target role. The owner grant snapshot/API and Shell review surface show those workflow targets and can approve or revoke the exact signed requirement for the current installation generation. SpaceDO applies the existing operation rate/concurrency lease to the grant. This is review and admission staging only: the host jobs dispatcher, durable job ledger/status, retries/deadlines over active work, cleanup and outcome reconciliation are still uncoded. Job capabilities remain unavailable.

Code `90088bd79445d4b135f63cb953137fdeaeaf7f4b` is committed, pushed and verified on `origin/Mcbt5s-Backup-2`. Local evidence: Agent SDK **37/37**, Spaces extension install/grant **33/33**, SDK/Spaces/Shell typechecks, and `git diff --check`. The Spaces test uses local SQLite/Worker stubs. No deployed migration, queue/DLQ, Worker, browser, provider/invoice or live acceptance ran. All resource descriptors and rollouts remain disabled. Preserve untracked `infra/scripts/__pycache__/`.

Exact next action: implement the durable Project/install jobs ledger and authenticated dispatcher through the existing Agents `AGENT_TICKS` queue. Bind each row to tenant/Space/Project/install, signed manifest/resource digest, generation, grant revision, actor and idempotency hash; bound payload, deadline and active concurrency; dispatch only the signed non-recursive target using `startDurableWorkflow` and the owner-approved Billing budget; persist queued/running/succeeded/failed/unknown/dead-letter states and reconcile lost queue/start replies without repeating job effects. Add status caller plus replay, revocation, deadline, concurrency, cleanup and quota tests. Keep `jobs` unavailable and rollouts disabled, then resume remaining S/U/P/PW/K/EP code gaps.

## Previous code checkpoint — 2026-11-16 (EP02 owner-approved installation budgets; `50566cd6` pushed)

Project owners can set and revise per-installation maximum run and monthly credit caps through the existing resource review panel. SpaceDO persists the policy and bounded audit events against the exact install generation; the workflow installation snapshot carries it to WorkflowHost. WorkflowHost requires the current owner approval for resource-bearing installations, defaults each run to the approved max, rejects caller widening and pins the approved monthly amount/revision. Billing reserves run capacity against both tenant and exact-install monthly usage, including concurrent holds and settled usage. Budget revisions change the durable workflow grant fingerprint; install cleanup removes the active budget row. Resource kinds remain unavailable.

Code `50566cd661900917682828beea368fb135531c81` is pushed and remote-verified. Local evidence: Spaces **39/39**, Billing **19/19**, Agents **39/39**, Shell resource API **1/1**; all four package typechecks and `git diff --check` pass. Billing tests exercise real SQLite migrations 0110/0266 and conditional monthly admission; Spaces tests exercise migration 154, owner authorization, review/replay/revision and worker snapshot. No production migration, deployment, browser, invoice/provider or live acceptance ran. Byte/storage units still have no approved price; jobs adapter remains uncoded; S1–S9/U01–U12/P/PW/K status is unchanged. Keep resource descriptors and rollout flags disabled; preserve untracked `infra/scripts/__pycache__/`.

Exact next action: trace the existing scheduled-job enqueue/receipt path and implement EP02's host-owned Project/install-scoped `jobs` operation through the signed resource requirement, owner grant, durable idempotency/unknown-outcome journal and existing Billing caps. Bound payload, deadline, retries and concurrency; tests must cover replay, revocation, cleanup and quota exhaustion. Keep `jobs` unavailable and rollouts disabled, then continue remaining S/U/P/PW/K/EP code gaps. No provider credentials block this implementation.

## Previous code checkpoint — 2026-11-16 (EP02 run budget admission and resource metering; `15f704fe` pushed)

The workflow journal reserves one canonical `workflow_step` credit for each in-flight vertical-extension effect before dispatch, rejects missing/insufficient run budgets, accounts for concurrent holds, and prevents settlement above the per-effect hold. The existing Billing Worker run reservation retains Project/installation dimensions and checks the tenant monthly infra-credit quota. Resource effects report idempotent request, byte, and job units to Billing's durable usage ledger by Project/installation/run. Byte units measure serialized request plus response bytes and remain unpriced because no approved byte/storage rate exists. Existing `completed` and `unknown` WorkflowRunDO receipts remain authoritative; an unknown outcome settles conservatively at the reserved run ceiling.

Code `15f704feee462d75a1f07a70aea36455bf4e3373` is pushed and remote-verified. Local evidence: Agent workflow journal/reporting/WorkflowRunDO suites **27/27**, Agent typecheck, Agent SDK typecheck, and `git diff --check`. No migration, Billing D1 integration test, deployment, browser, invoice/provider or live acceptance ran. No S1–S9/U01–U12 status changes. All rollouts and resource catalog/install admission remain disabled; preserve untracked `infra/scripts/__pycache__/`.

This closes run-level workflow-step budget admission and durable unit metering only. The caller-supplied run ceiling is not yet a durable owner-approved per-install budget, no approved byte/storage price exists, and the job adapter remains uncoded; these are code/policy gaps, not credential blockers. Exact next action: add an owner-authorized per-install budget to the existing resource review/install path, have the workflow host resolve it from current SpaceDO state (never from extension or agent input), reserve and settle against that authority, and test authorization, replay, concurrency, revocation and uncertain outcomes. Keep all resource capabilities unavailable until the per-install budget contract, byte/storage price decision and applicable deployed acceptance are complete; then continue EP02 jobs and remaining S/U/P/PW/K/EP work.

## Previous code checkpoint — 2026-11-16 (EP02 versioned object archive recovery; `326779c1` pushed)

Space archives now carry a bounded version-1 snapshot set for Project-bound extension object rows. Export validates the signed release, exact installation generation, resource digest, key, content type, canonical bytes and stored hash; coverage reports object count and bytes. Restore validates both archived and current ownership, only merges into a pre-existing active/disabled exact install generation, preserves current values, applies per-install quotas, and skips absent, newer, removed, revoked or tombstoned owners. Object rows remain outside generic table restore. Owner resource grants and active operation leases are excluded from new archives and filtered from legacy archives; neither is reactivated by restore.

Code `326779c1bc7fcab9ce7f66a2328ffe670a5b43da` is pushed and verified on `origin/Mcbt5s-Backup-2`. Local evidence: Space archive export/restore and backup suites **30/30**, Spaces typecheck and `git diff --check`. Tests cover bytes/hash validation, exact restore, preserving newer current data, quota exhaustion, generation change, absent install, Space erasure tombstone and legacy grant/lease filtering. No migration was added; migrations 152/153 remain unapplied. No Worker deployment, browser, provider, invoice or live recovery acceptance ran. Preserve untracked `infra/scripts/__pycache__/`.

At that archive checkpoint the next action was tracing Project/Agent budget authority. That trace and a run-budget admission/unit-metering slice are now recorded in the latest checkpoint above. The archive path remains local code only; resource catalog/install admission and rollouts remain disabled.

## Previous code checkpoint — 2026-11-16 (EP02 bounded object operation path; `ee7390e8` pushed)

The signed Project workflow caller now dispatches fixed `get`/`put`/`delete` object operations through an internal Spaces route into SpaceDO SQLite. Owner grants bind the exact manifest/resource digest, installation generation, operation subset and empty table authority. The host uses a single-use persisted lease, validates logical keys, canonical base64 and MIME essence, caps objects at 64 KiB, an installation at 64 objects/512 KiB, and rechecks active Project/install/grant state on use. The durable workflow journal records a content-free object-key hash and bounded request/result accounting. Uninstall and release changes clear object rows and active grant rows. `extension_resource_objects` is excluded from archives until a versioned snapshot/restore path exists.

Code `ee7390e861afd66bfcb14e551d8662c4dcb2f1be` is pushed and verified on `origin/Mcbt5s-Backup-2`. Local evidence: SDK **36/36**, Spaces **47/47** across object helper, route, install and migration suites, Agents **14/14**; SDK/Spaces/Agents typechecks and `git diff --check` passed. SpaceDO migrations 152/153 are source-only and unapplied. No deployment, browser, provider, billing/invoice, backup/restore or live acceptance ran. No rollout is enabled; preserve untracked `infra/scripts/__pycache__/`.

This is local code only and the object capability catalog/install admission remain unavailable. Archive snapshot/restore and recovery-point coverage are uncoded; per-install monetary cost admission/settlement, job resources, other EP/K/S/U/P/PW gaps remain open. No provider credentials block this code. Exact next action: add versioned Project-install object snapshot/restore to the Space archive, include data counts/bytes and validate exact ownership/generation on restore, add tombstone/fresh-install protections and archive/export/restore tests, then re-evaluate when the capability may be safely advertised. Keep object/jobs unavailable and all rollouts disabled.

## Previous code checkpoint — 2026-11-16 (EP02 resource review staging for objects; `82bbee1e` pushed)

The exact Project owner grant ledger/revocation fence from `aa290198` also stages signed Project-bound `objects` declarations for review. The status API and Shell caller show requested operations without fabricated table/path authority, and state that no object adapter is active. Activation still checks exact signed manifest/resource digests, install generation, unique operation subsets and empty object table selections; all capability descriptors remain unavailable.

Code `82bbee1ecfb261a727c398978ea5c90135ef4731` is pushed and verified. At that checkpoint Spaces passed **50/50**, Shell grant API **1/1**, Spaces/Shell typechecks and diff check; no migrations/deployments/browser/provider/invoice/live acceptance ran. Rollouts remained disabled.

That checkpoint's next action was the object service now recorded above; archive recovery remains its current follow-up.

## Previous code checkpoint — 2026-11-16 (EP02 owner-reviewed structured-data grants; `aa290198` pushed)

The owner grant registry is now durable and reachable through the Project owner grant API and Shell review panel. Grants bind tenant/Space/Project, installation ID and generation, exact signed manifest/resource digests, installer/reviewer, allowed operations/tables and revision; audit events and revocation are retained. The workflow resource call rechecks the active grant and signed installation, claims a persisted per-operation lease with concurrency/rate limits, then uses the existing scope-checked Gadget→MicroAppDO route and WorkflowRunDO effect journal. Operation receipts include bounded hashes/bytes/outcome and metering. Activation rejects malformed or widened grant operations/tables, but all capability descriptors remain unavailable and resource-bearing installs remain staged.

Code `aa290198532b2c7a47878b69d7528c04ce5685e1` is pushed and verified on `origin/Mcbt5s-Backup-2`. Local evidence: SDK **36/36**, Spaces **50/50**, Agents **21/21**, Router **75/75**, Shell resource-grant API **1/1**; Spaces, Agents, Router and Shell typechecks; `git diff --check`. These are local tests/typechecks. Migration 150/151, Workers/DO deployment, browser acceptance, provider/invoice acceptance and live revocation/concurrency acceptance have not run. No rollout is enabled. Preserve untracked `infra/scripts/__pycache__/`.

Structured-data broker code is implemented locally but remains unavailable pending the applicable deployment/security acceptance and a reviewed capability enablement. Object and job adapters, installation-level cross-resource admission/settlement, and the remaining K/S/U/P/PW/EP code gaps are still uncoded or partial; no provider credentials block this ordinary implementation. Exact next action: trace the existing scoped R2 object lifecycle and extension artifact boundaries, then implement EP02 object grants/operations under opaque install-bound handles with bounded size/type, read/write/delete, revocation and cleanup semantics. Keep `objects` unavailable and rollout disabled while that code and acceptance remain incomplete; then continue jobs and other open requirements.

## Latest code checkpoint — 2026-11-16 (EP02 structured-data workflow bridge; `66fdbd2e` pushed)

`ctx.resources.execute(stepKey, requirementId, operation, input)` now reaches the durable WorkflowRunDO effect journal, resolves against the signed structured-data manifest and worker role, and dispatches through the existing authenticated, scope-checked Gadget→MicroAppDO route. Results are bounded and checked against the declared output schema. The durable step key prevents replay after uncertain external effects; changed inputs conflict. The Agent SDK, Agents workflow/scope/journal suites and Spaces installation/Gadget-route suites passed **36/36**, **31/31**, and **35/35**; SDK, Agents and Spaces typechecks plus `git diff --check` passed. Commit `66fdbd2e3e8ebf295fcb8892de0c7338a86ab9a3` is fetched, pushed and verified on `origin/Mcbt5s-Backup-2`.

This is a latent dispatch path only. SpaceDO still rejects every resource-bearing install and the catalog still reports all resource kinds unavailable. No owner-approved resource grant registry, approval/status/revoke caller, installation-generation fence or capability activation exists. No migration, deployment, browser, provider or live acceptance ran; rollouts remain disabled. Preserve untracked `infra/scripts/__pycache__/`.

Exact next action: implement the durable owner-reviewed grant ledger for structured-data requirements, bound to tenant/Space/Project, exact signed manifest/resource digest, installation ID and generation, installer, reviewer and allowed tables/actions. Add a reachable owner/admin approve/status/revoke caller and fence every operation against grant revision, install generation and publisher/install revocation. Then test duplicate writes, changed-payload key reuse, revocation races and cross-install denial before any catalog availability change. Continue object/jobs and remaining EP/K/S/U/P/PW requirements afterward.

## Latest code checkpoint — 2026-11-16 (EP02 run-scoped operation receipts; `27f571d0` pushed)

The durable WorkflowRunDO write-ahead journal now records content-free structured-data receipts for the reachable Gadget bridge: installation/project/actor, Gadget/table/action, request hash/bytes, result hash/bytes, outcome and measured credits. Uncertain work becomes `unknown` and is never replayed. Code `27f571d08ab40145b72977e48137daaa0318a3ad` is pushed to `origin/Mcbt5s-Backup-2`. Local evidence: workflow journal/WorkflowRunDO tests **19/19**, Agent SDK and Agents typechecks, and `git diff --check`. This is run-scoped accounting only, not the durable extension grant registry or owner-facing grant manager. No deployment/live acceptance; resources remain unavailable.

Exact next action: implement an owner-reviewed grant record bound to the exact signed Project manifest resource digest and installation generation, plus a reachable approve/status/revoke caller. Then wire `ctx.resources.execute` through the durable effect journal into the current scope-checked Gadget route, validating request/response schemas and installation/publisher status on every use. Test duplicate writes, changed-payload key reuse, revocation races and cross-install denial. Keep all capability descriptors unavailable and rollout flags false until the broker path is complete. Continue object/jobs, EP03–EP06, and open K/S/U/P/PW requirements afterward.

## Previous code checkpoint — 2026-11-16 (EP02 structured-data binding; `6871563e` pushed)

The SDK now requires structured-data declarations to bind to an existing `PROJECT_BOUND` Gadget, name bounded tables, declare bounded CRUD input/output schemas, and require idempotency for mutations. Manifest validation verifies that the exact Gadget operations and every table are already authorized by a signed project-member workflow role. The existing authenticated catalog and SpaceDO install admission still report/reject every resource kind as unavailable; this contract does not issue grants or activate a runtime. Code `6871563ea9e70019c42d98a88eabf6b3daf0707c` is pushed to `origin/Mcbt5s-Backup-2`. Local evidence: SDK tests **36/36**, SpaceDO extension-install tests **32/32**, Agent SDK and Spaces typechecks, and `git diff --check`. No migration, deployment, browser, provider or live acceptance ran. Preserve the pre-existing `infra/scripts/__pycache__/` and keep rollouts disabled.

Exact next action: add the durable EP02 grant and operation-receipt ledger around the authenticated workflow Gadget→MicroAppDO path. Bind each grant to tenant/Space/Project/installation, exact signed manifest/resource digest, installer actor, approval revision, allowed tables/actions and current installation generation. Claim idempotency keys before writes, preserve uncertain outcomes without replay, persist bounded usage receipts without record contents, and fence every call on install/publisher revocation. Add a reachable admin grant/status caller plus tests for concurrent duplicate writes, changed-payload key reuse, revocation races and install identity. Keep all capability descriptors unavailable until that caller is complete. Then continue object/jobs, EP03–EP06, and the open K/S/U/P/PW requirements; no live/deployment gate substitutes for uncoded work.

## Latest plan reconciliation — 2026-11-16 (extensible platform and managed resources; source e950f02b)

Fetched `docs/research/extensible-platform-and-managed-resources-plan.md` from `plan/microapps-ui-sdk-voice` commit `e950f02bdf0726f05db456a50ef29699e200d3b3` and copied it verbatim here in docs commit `ea97179738bc967338cf23ac607d9721e5cb6dba`; no planning branch switch or merge occurred. Its requirements are incorporated as EP01–EP06 in platform plan §15. K04 durable Knowledge create idempotency is implemented locally and pushed in `4f390061c4bea4b032eaf3a205e76293a4f226a0`. Source reconciliation found: a versioned extension SDK and gatekeeper capability checks exist but not the complete host resource/grant broker; a bounded microapp-backed dynamic page route exists but is not a general static/dynamic site deployment adapter; owner-published Knowledge collections and scope checks exist but not a general custom Knowledge extension contract/dashboard lifecycle; workspace authoring, checked publication and billing primitives exist but not the complete install/upgrade/resource lifecycle. Existing K01–K30/P/PW/S/U work is reused.

EP01–EP06 remain partial or not started pending caller-level implementation; uncoded work is not a provider credential block. Preserve Naelao authorization, payer and publication authority. Do not silently replace Vectorize+D1 FTS with Cloudflare AI Search: its current ACL/indexing, lifecycle, quality and cost evidence stays under K15/K16 and no adapter is selected. Keep all resource, knowledge, authoring and website rollout flags disabled.

K05's revision-pinned publication slice is implemented and pushed as `cb0a63fb3f3fe2f9ad78b962323c4121f60b1496`. D1 publication and membership revisions, optimistic owner edits, current-version-only retrieval, content-change/deletion fencing, SpaceDO grant revision receipts, Shell stale-grant display, and a fresh Space-shared grant check before every channel search now use the existing store and callers. Local evidence: Knowledge **117/117**, SpaceDO/Spaces **43/43**, Agents grant helper **5/5**, Knowledge/Spaces/Agents/Shell typechecks, release migration tests **20/20**, schema/deployment manifest validation, real-SQLite publication lifecycle/revocation tests, and `git diff --check`. K05 remains PARTIAL for the broader collection lifecycle and complete read/discover/admin rights model; K06–K30 also remain active. No D1/SpaceDO migration or Worker was deployed, no browser/provider/live acceptance ran, and rollout stays disabled.

EP01 code checkpoint `9abf5efa36231a96bf8e337a2fb7b702cf672954` is pushed and remote-verified. The versioned SDK resource contract, exact-scope/operation/schema/idempotency/quota checks, simulated local harness, authenticated capability catalog and fail-closed install admission are present. Object, structured-data and job capabilities all remain unavailable because a trusted runtime broker does not issue grants or dispatch operations. Local evidence: Agent SDK extension tests **35/35**, SpaceDO extension install tests **32/32**, Agent SDK and Spaces typechecks, and `git diff --check`. No migration, deployment, provider or live acceptance ran.

The signed Project bundle→workflow Gadget→MicroAppDO path is traced. SDK validation now binds any structured-data requirement to a PROJECT_BOUND Gadget and a subset of its exact signed worker-role operation/table grants; this code checkpoint is `6871563ea9e70019c42d98a88eabf6b3daf0707c`. Local evidence is Agent SDK **36/36**, SpaceDO install **32/32**, both typechecks, and diff check. This is contract validation only: no durable resource grant/operation ledger or broker is wired, all resource capabilities remain unavailable, and no migration/deployment/live acceptance ran.

Historical next action superseded by the run-scoped receipts above: implement the EP02 durable owner-approved grant registry and resource SDK caller. All object/structured-data/job capabilities remain unavailable pending that work.

## Latest checkpoint — 2026-11-15 (K02/K03 PDF preview and source lineage; code 08d9c509 pushed)

K02 now offers bounded PDF upload preview and correction in all three reachable Knowledge forms: Space-wide and Project-private product Shell, plus the builder Dashboard. Preview requests preserve the 1 MiB Space and 5 MiB Project source/extraction limits, authorize Project scope, and return parser warnings and sizes. A 15-minute HMAC receipt binds tenant, Space, Project, source bytes, extraction hash and parser version; ingestion requires it and stores the original PDF plus parser/extraction/approved-text hashes. Archive export and restore preserve the lineage and verify original source bytes. Migration 0263 is inventoried in both release manifests; no migration or deployment was run.

Code `08d9c509a9ab2a9b8e66e4fa4707bc1d2e442324` is pushed and verified on `origin/Mcbt5s-Backup-2`. Local evidence: Knowledge suite **104/104**, Shell PDF helper **3/3**, Knowledge/Shell/Dashboard typechecks, SQLite migration DDL smoke check, release and deployment manifest validators, release migration tests (**39/39**), and `git diff --check`. These are local tests and mocks; no browser, live Cohere, deployed D1/Worker, invoice or production acceptance. Preserve untracked `infra/scripts/__pycache__/`; keep all rollouts disabled.

K02 is implemented locally for paste/text/code/CSV, URL where already supported, and PDF. Rich Office/image/OCR formats remain uncoded. K03 is partial: reviewed parser lineage and archival source hash are durable, while richer page/section coordinates and model/version quality evidence are open. K04 is the exact next code task: add durable scope-bound create idempotency so a lost response/retry returns the same document without duplicate indexing/billing; reject reuse of a key with changed content or ACL. Cover synchronous and queued ingestion and preserve the existing deletion fences. Then continue K05–K30 and remaining S/U/P/PW requirements. No live provider gate substitutes for ordinary code work.

## Previous checkpoint — 2026-11-15 (PW06 durable worker cancellation fences; code 79d671a3 pushed)

Worker cancellation now fences checked integration, test execution, publication requests and completion writes against the durable worker `status` and monotonic `attempt`. Late success/failure responses cannot start a merge or replace `terminated`; signed child session updates carry the attempt and are rejected after termination or supersession. The checked-integration helper rechecks active state around validation and before receipt/publication.

Local evidence: delegated admission and checked integration suites **20/20**, Agents typecheck, and `git diff --check`. Code `79d671a329b056c3cd2e861aeabb3996e488de9d` is pushed and verified on `origin/Mcbt5s-Backup-2`. This does not atomically cancel a publication already accepted by Artifact Worker/Workspace Coordinator before termination; close that commit-boundary contract or define/review its lifecycle semantics. No deployed Worker, real Container, browser, or live acceptance. Keep rollouts disabled and preserve untracked `infra/scripts/__pycache__/`.

PW06 remains PARTIAL for in-flight publication cancellation semantics, broader revocation, currency/compute reservation and settlement, real runtime isolation, and deployed concurrency/recovery acceptance. P06 remains PARTIAL for signed distribution, managed provisioning and live provider/carrier evidence. U05/U06 remain unsupported runtime-contract gates. These are code/product/runtime gaps, not credentials-only blockers.

Exact next action: implement K02/K03 reachable PDF ingestion preview in both Space-wide and Project-private Knowledge forms. Trace the existing PDF parser API and lifecycle first; add a scope-correct bounded PDF selection, preview/correction step that displays extraction limits and parser warnings before ingestion, preserve existing upload ceilings, bind preview to the submitted file hash, and add API/UI tests. Then record parser/version lineage and continue remaining independent S2–S9/U01–U12/P/PW/K work.

## Previous checkpoint — 2026-11-15 (K01 upload limits, K11 independent lexical retrieval, K20 cache containment; code 1041cd0 pushed)

K01 now enforces the API's 1 MiB Space-wide and 5 MiB Project-private UTF-8 upload limits in both reachable Knowledge forms. K11 adds independent permissioned FTS5 lexical candidates to the existing Vectorize/RRF search. K20 gates full assistant-response cache reads/writes off in all environments until caller scope and source/grant freshness are implemented; this closes the existing tenant/Space cache boundary without silently changing retrieval providers.

Knowledge checkpoint `1041cd0ffe58b212d11329a9ea0f4d155c4d3780` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Knowledge suite **95/95**, upload helper **3/3**, Knowledge/Agents/Shell typechecks, SQLite FTS5 syntax smoke check, config parse with new cache gate false in all environments, and `git diff --check` passed. No deployed D1/Worker, browser, provider, invoice, workspace/runtime, carrier or billing acceptance. Prior voice fixes remain pushed at `8233788bc1656bac2ca9cf914e91da198d8f3780` and `75fc1b877fd99481e0bee67d22780201699e6d26`. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

PW06 remains PARTIAL for cancellation/revocation lifecycle, currency/compute reservation and settlement, real runtime isolation and deployed concurrency/recovery acceptance. P06 remains PARTIAL for signed distribution, managed provisioning and live provider/carrier evidence. U05/U06 are unsupported runtime-contract gates, not credentials-only blockers.

This checkpoint's next action was completed in code `79d671a3`; continue from K02/K03 above. The in-flight publication contract and other PW06/managed-services acceptance gaps remain open.

## Knowledge-platform reconciliation — 2026-11-15 (source plan 9358830e fetched; code 1041cd0 pushed)

The current source already has scoped Knowledge documents, signed host-mediated access, project/user/role grants, tombstones and deletion leases, PDF parsing, hash-checked citations, archive/reindex behavior and Vectorize authorization. The uploader/API now agree on 1 MiB Space-wide and 5 MiB Project-private UTF-8 limits; existing FTS5 produces independent scoped lexical candidates that are fused with Vectorize results. Full assistant-response cache reads and writes are gated off in Agent and Knowledge callers/config because the old tenant/Space key omitted caller scope and source/grant freshness. The new plan is copied locally and mapped to K01–K30 in platform §14. Reconciliation status and Cloudflare evaluation are in the knowledge progress ledger.

Code `1041cd0ffe58b212d11329a9ea0f4d155c4d3780` is pushed and remote-verified. Local evidence: Knowledge Worker full suite **95/95**, Knowledge typecheck, Agents typecheck, Shell typecheck, upload-limit helper **3/3**, Cloudflare AI Search filtering/hybrid/multitenancy/data-source/pricing documentation reviewed, FTS5 syntax checked with local SQLite, dev/staging/production TOML parsed with response cache false, and `git diff --check`. No deployed D1/Worker, provider, browser, invoice or live acceptance. All new rollouts remain off.

Exact next action: close the observed PW06 cancellation race. A terminated parent worker can still return late, merge its branch and overwrite terminal status. Gate checked merge/validation on durable non-terminated state, preserve cancellation on completion, and test late success/failure and cancel-during-validation. Then continue K02/K03 (reachable PDF preview and parser lineage) and remaining S2–S9/U01–U12/P/PW gaps.

## Previous checkpoint — 2026-11-15 (P06 voice interruption and PW06 bounded merge telemetry; code 8233788b pushed)

PW06 Coordinator merge telemetry uses fixed event/outcome/conflict categories, bounded counts and best-effort Analytics writes; tests verify dimensions and that Analytics failure cannot change merge results. P06 owner-call TTS forwards abort through provider startup and cancels an in-flight audio read. The Telnyx extension stream treats barge-in as an intentional cancellation and discards buffered PCM after `clear`, without ending the call.

Local evidence: Coordinator merge telemetry **82/82** and Agents typecheck at `448196a36e985e05e919d62df43c3ac00c013b06`; extension voice runtime **6/6**, Telnyx call routing **8/8**, TTS adapter **4/4**, Agents typecheck and `git diff --check` at `8233788bc1656bac2ca9cf914e91da198d8f3780`. A combined concurrent invocation hit a 3-second wait timeout in one extension scenario; the full extension suite passed when rerun alone. These are local Worker/SQLite and mocked provider tests, not deployed, carrier, billing or live acceptance. Both code commits are pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

The planner/worker source plan at `45575a395df9571eb075f0a479c65144e767be7c` remains incorporated into platform §12 and managed §20 as PW01–PW06; no branch switch or planning merge occurred. PW06 remains PARTIAL for validation/run lifecycle metrics, worker cancellation/revocation, per-run currency/compute reservation and settlement, runtime isolation, and deployed concurrency/recovery acceptance. P06 remains PARTIAL for signed extension distribution, managed provisioning, full cost/quality evidence and live carrier acceptance. U05/U06 remain unsupported runtime-contract gates.

Exact next action: add fixed-label, privacy-safe Analytics events for automatic integrated worker validation outcomes (`published`, `blocked`, `conflicted`, `uncertain`) and duration. Verify telemetry failure cannot change durable receipts or publication; then continue the next uncoded S3–S9/U01–U12/P01–P24 requirement. Fetch before each push; never force-push or enable rollouts.

## Previous checkpoint — 2026-11-15 (PW04 bounded large exact-copy review; code 89cb0a8f pushed)

Manual conflict review keeps text rendering/reviewer-authored text at 256 KiB, while a separate backend-only exact-side-copy path supports at most 2 MiB per file and per review set. The copy is read from the hash-addressed scoped R2 object, size and SHA-256 are checked immediately before it is base64 staged through the checked Coordinator, and Shell sees only hash/status metadata. The payload remains well below the Coordinator's existing 30 MiB bounded request reader. Content is never guessed or auto-merged.

Local evidence: Agents Coordinator/manual-resolution/route suites **108/108**, a 2 MiB exact-copy publication test, Shell API tests **3/3**, Agents and Shell typechecks, and `git diff --check`. The Coordinator function and route bindings are local mocks/SQLite; no real Worker, deployed, Container/runtime or live acceptance. Code `89cb0a8fb18699466fd8845d5d6b8bbe3d7bf5d8` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. PW04 remains partial for artifacts above 2 MiB and unavailable/corrupt object recovery; PW06 runtime/concurrency acceptance also remains. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

The planner/worker source plan at `45575a395df9571eb075f0a479c65144e767be7c` was fetched/read; all requirements are incorporated in platform §12 and managed plan §20 as PW01–PW06. No branch switch or planning merge occurred.

Exact next action: implement PW06's uncoded bounded Coordinator merge telemetry: count validated merge attempts, final published/noop/conflicted outcomes and conflict categories through the existing Analytics Engine binding. Use fixed categories only; never add tenant, Space, Project, path, actor or file contents to metric labels. Keep telemetry best-effort so Analytics failure cannot affect publication, and test emitted dimensions and failure isolation. Then continue the next uncoded S3–S9/U01–U12/P01–P24 requirement. U05/U06 remain unsupported runtime-contract gates. Fetch before each push; never force-push or enable rollouts.

## Previous checkpoint — 2026-11-15 (P03 builder/platform private inbox; code c40d0421 pushed)

The authenticated Dashboard now reads and marks only the signed platform user's own `PLATFORM_DB.notifications` rows, scoped by both JWT tenant and subject. The Router rejects Product-user and agent identities, returns bounded keyset-paginated data without action URLs, uses no-store responses, and returns the same not-found result for missing or out-of-scope IDs. Dashboard has an unread/read toggle, load-older caller, and retryable mark-read UI. This inbox remains distinct from SpaceDO notifications and the ProductUserDO inbox.

Local evidence: Router platform-notification helper and route suites **7/7**, Router typecheck, Dashboard typecheck, and `git diff --check`. Tests use local SQLite and signed test JWTs; no deployed database, browser, provider or live acceptance ran. Code `c40d0421` is pushed and verified on `origin/Mcbt5s-Backup-2`. P03 remains PARTIAL for grace/restriction/escalation and retry-cadence policy and provider/deployed delivery acceptance. U05's proposed candidate-allocation task was reconciled against current source and is superseded: the project-main Container registry and Cloudflare Computer live-mount verifier have different allocation, image, reservation and observation authorities. No trusted bridge exists, so do not fabricate a candidate or attestation. U06's authenticated writer/drain/flush/reconnect/handoff contract is unsupported. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

This checkpoint's Canvas caller gap was completed in `5d08d7f1`; see the latest checkpoint above.

## Previous checkpoint — 2026-11-15 (PW04 bounded binary conflict choice and receipt; code bac46733 pushed)

The reachable Shell conflict editor can keep the exact current-target or retained-worker bytes for a bounded unsupported-text/binary version without sending bytes to Shell. Preview and staging verify the scoped R2 key, size and SHA-256; the request binds the selected side and hash; paired case-collision resolution remains one checked Coordinator change set. Durable receipts and Shell summaries identify the copied path, side and hash. Oversized, missing and corrupt objects remain blocked. Code `bac4673352c18ee631068069a6484a73226992c3` is pushed and verified on `origin/Mcbt5s-Backup-2` (`f1a949bf` implements the path; `bac46733` records the copied-version receipt).

Local evidence at that checkpoint: Agents manual-resolution/Coordinator/route suites **97/97**; Shell API/result parser **6/6**; Agents/Shell typechecks and `git diff --check`. Coordinator tests verify exact binary bytes, metadata, paired deletion atomicity and retry. Route tests mock the publisher; no browser, real ToolSandbox, deployed Worker, or live acceptance. Automatic candidate validation is implemented in the newer checkpoint above. Per-run infrastructure settlement, runtime isolation and deployed acceptance remain open. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

Both active plans and their ledgers remain governing records: managed services S1–S9/U01–U12 and platform P01–P24 plus planner/worker PW01–PW06. Fetch and verify the recovery branch before every push; preserve all uncommitted work and the unrelated untracked `infra/scripts/__pycache__/`.

## Previous checkpoint — 2026-11-15 (PW05 worker review status; code cb485279 pushed)

The Shell worker panel now shows the workspace branch, model-token use against the allocated token budget, attempt number, worker-reported changed paths, and explicitly states that no integrated-test receipt is recorded. It labels paths as worker-reported and the branch as logical, without implying a verified diff, runtime isolation, or currency cost. Local verification: Shell worker-merge-result tests **3/3**, Shell typecheck, and `git diff --check`. Code `cb4852791e1129b7fbc5c869f5ee49b1e0678f73` is pushed and verified on `origin/Mcbt5s-Backup-2`; no deployed/runtime acceptance. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

PW04 runner trace: `buildScriptEngineEnv` and `code-runner.ts` pass workspace branches to Tier 6, and `ToolSandboxDO` hydrates coordinator revisions. However, `sandbox-routing.ts` isolates a project runtime by branch only for `race/` branches; the resolver's `manual/` branch maps to the shared project sandbox. The existing race oracle is not wired to manual-resolution validation and stores no exact-review validation receipt. Safe completion still needs a checked fork of the exact review manifest into an isolated runtime, current Code grant and budget admission, a bounded project-owned test command, deterministic execution identity, and durable passed/failed/uncertain receipt handling before canonical merge. This is uncoded implementation, not a credentials blocker. Keep rollout disabled.

Exact next action: implement the manual-resolution validation lifecycle against a coordinator-pinned review manifest using a `race/` runtime fork, with Code grant checks, bounded test command, deterministic execution ID and a durable receipt; fail closed on stale or uncertain execution and do not merge on failed checks. First add execution-ID replay support to the Tier 6 CodeRunner if required, then add endpoint/caller coverage. If the exact branch projection cannot be proved, retain the fail-closed gate and proceed to the independent paired-path resolver.

## Previous checkpoint — 2026-11-15 (P03 private Product-user dunning inbox; code 9a46241f)

Notifications now creates a stable, generic in-app dunning notice for the exact active Product-user, independently of verified-email delivery. The queue rechecks tenant, product, user, current subscription state and provider event version before routing through an HMAC-authenticated Spaces bridge. ProductUserDO persists bounded inbox state, pagination and read status; account export and erasure include it. Product-user API routes derive identity from session claims, Router allows only the exact inbox path, and Shell Personal settings lists and marks notices read.

Local verification: ProductUserDO/Spaces inbox, authorization, export and erasure **20/20**; Notifications dunning queue/SQL **2/2**; Workflow recovery **3/3**; Router route patterns **71/71**; Shell API client **3/3**; all five affected package typechecks; Wrangler dry runs for default/staging/production; Wrangler variable parity **82/82**; `git diff --check`. These are local mocks/typechecks and dry runs, not deployed or live provider acceptance. A broader existing binding-parity suite had 8 unrelated environment/resource expectation failures (127/135 passed); the repository environment-isolation validator still reports previously recorded shared resource IDs and unresolved `naelao-calls`. New service bindings resolve distinctly in all three environments. Code SHA `9a46241f` and docs checkpoint `cacfa17d` are pushed and verified at `origin/Mcbt5s-Backup-2`. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

P03 remains PARTIAL: the builder/platform `PLATFORM_DB.notifications` table has `read_at` from migration `0010_notifications.sql`, but no reachable user-facing exact-user API/caller is wired to it. Grace/restriction/escalation and retry cadence require a product decision. Provider delivery acceptance and deployed acceptance remain untested. P04’s authenticated Product-user download caller (`c1eb6c4e`) and code `9a46241f` are pushed with docs checkpoint `21e7763e`. The Fish Live 3, business MicroApp, UI SDK and voice requirements from `origin/plan/microapps-ui-sdk-voice` (`df3386257262a88888d647daa4d10f3af2ff9596`) remain in sections 9 and 11; planner/worker requirements from `45575a39` are now copied into section 12.

Exact next action: trace the builder/platform notification table through auth, Router, and the existing Dashboard notification surfaces. Add an exact-user private read/mark-read API and caller only if the established builder identity contract safely scopes the table; otherwise record the precise contract and proceed to the next uncoded P05 guided-template requirement. Then continue remaining P05–P24 and S3–S9/U01–U12 gaps.

## Previous checkpoint — 2026-11-15 (P04 authenticated data download; code c1eb6c4e)

The Product-user Personal settings now call the authenticated, `no-store` portability endpoint and download the complete bounded JSON response locally. A 413 explicitly reports that no partial export was returned; authorization failures ask the user to sign in again. This closes the reachable Shell caller gap for the existing Product-user export. The user-private export remains partial for unsupported stores/contracts and recovery acceptance.

Local verification: focused Shell client tests **2/2**, Shell TypeScript check, and `git diff --check` pass. The direct installed binaries were used because pnpm 11.25.0 (repository pins 9.12.0) tried to replace `node_modules` before executing; no dependency tree was removed or changed. This is local evidence, not deployment/browser acceptance. Code SHA `c1eb6c4e` is pushed with `9a46241f` and this record. Preserve untracked `infra/scripts/__pycache__/`; rollout remains disabled.

The fetched plan branch is `origin/plan/microapps-ui-sdk-voice` at `df3386257262a88888d647daa4d10f3af2ff9596`; its Fish Live 3, business MicroApp, UI SDK and voice additions are already copied into active plan sections 9 and 11. No plan branch was merged.

Exact next action: trace P03 dunning delivery from Billing's durable dispatch and Notifications provider outcomes into the Product-user inbox, distinguishing the existing Space notification inbox from email-queue state. Implement the missing authenticated, exact-user inbox path only through supported notification contracts, with persistence, erasure/export handling, and caller tests; keep grace/restriction/escalation decisions explicit. Then continue remaining P05–P24 and S3–S9/U01–U12 requirements.

## Previous checkpoint — 2026-11-15 (P04 exact-user purchase history; pushed 1bbe8ab66479c2f2960cfbbd854f89eaa1a57e0d)

The authenticated Product-user export now includes a bounded purchase-history summary from Billing's immutable `product_user_plan` receipts. Billing returns only provider, plan tier, amount/currency and purchase timestamp, scopes rows to the exact active tenant/product/user, and returns at most ten with an explicit `has_more`. Spaces validates the strict shape and returns 413 rather than silently exporting a truncated history. Provider event, subscription and variant IDs, customer IDs and raw receipts stay private.

Verification: Billing status tests **5/5**, Billing typecheck; Spaces export route tests **13/13**, Spaces typecheck, and `git diff --check`. These are local Worker mocks/typechecks, not deployment or live provider acceptance. Code `1bbe8ab66479c2f2960cfbbd854f89eaa1a57e0d` is pushed and verified on `origin/Mcbt5s-Backup-2`. Preserve untracked `infra/scripts/__pycache__/`; rollouts remain disabled.

P17 trace found that Marketplace/Shell builder JWTs identify a platform user and organization, while product-user sessions use a separate issuer with the end-user ID, tenant and `product_end_user` role; there is no persisted cross-issuer identity link or handoff authority. Email equality and browser state do not prove the same account. A Marketplace-to-Shell SSO handoff remains a product/identity contract gate, not a credentials blocker. P04 remains PARTIAL for other stores, policy, cross-service consistency and recovery acceptance. The microapp/UI SDK/voice plan copy remains in platform-plan sections 9 and 11 from `origin/plan/microapps-ui-sdk-voice`; no branch merge occurred.

Exact next action: continue P05 §11.5 with one real signed MicroApp Canvas dashboard path in the installed Shell view, reusing the scoped host business-action/settings APIs. Keep synthetic POC fixtures out of embedded frames, preserve release/install scope checks, and add caller-level authorization and failure coverage. Then continue the remaining S3–S9/U01–U12 and P01–P24 gaps in dependency order; keep rollout flags false.

## Previous checkpoint — 2026-11-15 (P04 exact-user chat portability; pushed b91a07953d33918c526307635d0412c72f6ff9e2)

Authenticated Product-user export version 3 now includes exact-user chat sessions/messages from the Product's related Spaces alongside existing profile, ProductUserDO, Billing and user-scoped MicroApp data. SpaceDO requires tenant HMAC, exact tenant/Space/user scope, and caps a complete Space response at 1,000 sessions, 2,000 messages and 4 MiB; Product aggregation caps transcripts at 16 MiB and fails closed on missing, malformed or oversized data. The shared bounded-response reader now starts stream cancellation without waiting for an untrusted cancellation promise.

Local verification: Spaces route and SpaceDO tests **15/15**, Spaces typecheck, bounded-response tests **7/7**, HTTP package typecheck, and `git diff --check`. These are local Worker/SQLite mocks only; no deployment, live provider or recovery acceptance. Code SHA `b91a07953d33918c526307635d0412c72f6ff9e2` is pushed and remote-verified. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

P04 remains PARTIAL for other service/provider stores, retention/key/jurisdiction policy, cross-service point-in-time consistency, isolated recovery and measured/deployed RPO/RTO. `PROJECT_USER` and same-identity app reinstall still lack supported contracts. The `origin/plan/microapps-ui-sdk-voice` plan text remains copied into platform plan sections 9 and 11; no source-branch merge occurred. U05's Container-to-Computer trusted-observation bridge is uncoded and mismatched to the present runtime contract, not blocked by credentials; U06 remains unsupported.

Exact next action: continue commercial integrity at P17 by tracing Marketplace-to-Shell identity handoff from current purchase/listing claims through product-session issuance. Add an exact-listing, short-lived, single-use handoff only if existing authorities prove the same account; otherwise record the precise identity-contract gate and move to the next independent code gap. Then continue S3–S9/U01–U12 and P01–P24 without repeating completed audits.

## Previous checkpoint — 2026-11-15 (S2 UserPort owner-link unlink recovery; code 70c2e2d34daa99f254c598234885b0332629460b)

Owner-link revocation no longer aborts before cleaning already-bound AgentPort accounts when one held sync journal cannot be safely replayed. It persists the owner-link fence, schedules only recoverable held operations, marks irrecoverable records held with `userport_connector_sync_recovery_unavailable`, independently revokes exact account IDs from the persisted binding, and returns `cleanupBlocked`/`cleanupPending` so the caller cannot mistake partial cleanup for completion. The normal alias-unlink path still refuses to replay an unapproved held operation.

Verification: UserPort↔AgentPort lifecycle suite **17/17**, Agents typecheck, and `git diff --check`. Route-level local SQLite/Worker mocks only; no live AgentPort/provider or deployed acceptance. S2 remains IMPLEMENTED_LOCAL only for supported lanes. The earlier proposed U05 candidate reservation was superseded by source reconciliation: the Container allocation, Computer live-mount verifier, credit holds and trusted observations do not share an identity or producer contract. Do not fabricate a candidate or attestation. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

## Previous checkpoint — 2026-11-15 (P04 product-user billing portability; pushed 2bec4bc861c33e0f272b9c5f11ed79120e12ccf2)

Product-user `/export` now includes the safe subscription summary, up to ten scoped dunning notification outcomes, and up to ten dispatch states from the authenticated Billing status endpoint. The caller derives product and user IDs from the active session, uses the existing tenant HMAC service binding, bounds the response to 16 KiB, validates the complete allowlisted shape, and fails closed when Billing is missing, failing, or malformed. The export response is `private, no-store`; provider subscription IDs, recipient addresses, and provider receipt IDs are not exposed. The existing default/staging/production Billing service bindings are present.

Verification: Spaces product-user route suite **11/11**, Spaces typecheck, and `git diff --check`. Local Worker mocks only; no deployment or live Billing/provider acceptance. The code is pushed and verified at `origin/Mcbt5s-Backup-2` SHA `2bec4bc861c33e0f272b9c5f11ed79120e12ccf2`. Rollouts remain disabled; preserve the unrelated untracked `infra/scripts/__pycache__/`.

Plan-source check: fetched `origin/plan/microapps-ui-sdk-voice` at `df3386257262a88888d647daa4d10f3af2ff9596`. Its only changed file is the active platform plan; all 70 added lines are already copied into sections 9 and 11. No requirement text is missing, the active P04 recovery evidence is newer than the source branch's P04 summary, and no merge or duplicate appendix is needed.

P04 remains PARTIAL for other service stores, retention/key/jurisdiction policy, cross-service point-in-time consistency, isolated recovery and measured/deployed RPO/RTO. `PROJECT_USER` remains unsupported; same-identity app reinstallation still lacks an actor-generation contract. Provider and deployed acceptance remains separate from the local evidence.

Exact next action: resume S2/MS01/MS02 at `workers/agents/src/communications/userport-agentport-sync.ts`. Trace alias and owner-link disconnect, reauthorization, and scheduled cleanup against current persisted rows and operation journals; close the next reachable sync/revoke/relink gap with failure and replay coverage. Then continue S3–S9/U01–U12 and remaining P03–P24 requirements in dependency order.

## Previous checkpoint — 2026-11-15 (S2 expired UserPort operation recovery; pushed 317c6c8cbce6dbc3e29903b139a98e207d63c11b)

Code `317c6c8cbce6dbc3e29903b139a98e207d63c11b` is pushed and verified on
`origin/Mcbt5s-Backup-2`. The scheduled UserPort↔AgentPort reconciler now promotes expired `running`
sync/revoke leases to immediately due `uncertain` operations, then resumes through the existing exact
alias, account-set, action and owner-link checks. Internal AgentPort requests have a 10-second bound;
migration 0262 adds the partial expired-lease index. The combined sweep honors its work limit.

Local evidence: focused UserPort suite **16/16**, Agents typecheck, release manifest inventory **262**,
release-manifest tests **5/5**, and `git diff --check`. The mocks do not establish live AgentPort or
provider acceptance. Rollouts remain disabled. Only the preserved untracked
`infra/scripts/__pycache__/` remains in the worktree after this code push.

Exact next action: continue the platform plan's P03 commercial-integrity queue. Trace current Billing
dunning producers, queue consumer, entitlement enforcement, notification and operator paths against
the recorded P03/P12 contract; identify and implement the next ordinary reachable recovery gap with
failure/retry coverage. Do not repeat the already reconciled P01/P02 code audits. Then resume S3–S9,
U01–U12 and P03–P24 in the existing progress ledgers, starting with independent code even where
provider or product gates remain.

## Latest checkpoint — 2026-11-15 (P04 product-user portability and erasure; pushed 7c765c219406adb455156e3364e4b40451f44572)

Code `7c765c219406adb455156e3364e4b40451f44572` is pushed and `ls-remote` verified on
`origin/Mcbt5s-Backup-2`. ProductUserDO export v2 now includes its durable notification queue, and
account erasure deletes those notifications and reports the count. The self-service DELETE now
requires a successful, well-formed ProductUserDO erasure receipt before deleting recovery tokens or
anonymizing the account row. A non-2xx, malformed, or unavailable response leaves the erasure fence
and PII intact for retry. Code `a4958c701f4da4cbc5bad8196b84fd88e6ac69b7` immediately before it adds
per-app USER_PRIVATE/SPACE_USER uninstall: migration 148, runtime-work drain, actor erasure before
install removal, durable retries, archive fencing and owner-install preservation.

Local evidence for the latest code: ProductUserDO, account route and MicroApp erasure suites **17/17**;
Spaces `tsc --noEmit`; `git diff --check`. The preceding uninstall checkpoint passed focused Spaces
migration/erasure/archive/route **37/37**, Router **6/6**, both typechecks. These are local Worker/
SQLite mocks only; no deployment, browser or live acceptance. Rollouts remain disabled. Preserve
untracked `infra/scripts/__pycache__/`.

Fetched `origin/plan/microapps-ui-sdk-voice` at `df3386257262a88888d647daa4d10f3af2ff9596`; its
Fish Live 3 and business MicroApp/UI SDK/voice requirements are already copied into active platform
plan sections 9 and 11. No substantive plan text was missing; only stale metadata/P04 source wording
differs, so no branch merge or duplicate appendix was added.

P04 remains PARTIAL for other service stores, retention/key/jurisdiction choices, cross-service
consistency, isolated recovery and measured/deployed RPO/RTO. `PROJECT_USER` remains unsupported.
Same-identity app reinstallation is unsupported because the erased actor key has no install generation;
this is an unresolved product/identity contract. P01's runner and P02's source preflight already fail
closed; their open gates are operator-attested D1 baselines, actual resource separation, named service
ownership, resource receipts and deployed acceptance. U05's Container-to-Computer trusted-observation
bridge remains uncoded, not a credential blocker.

Exact next action: resume S2/MS01/MS02's recorded provider lifecycle caller pass at
`workers/agents/src/communications/userport-agentport-sync.ts`. Trace UserPort alias/owner-link
disconnect, reauthorization and scheduled AgentPort cleanup against the live row and operation journal;
close the next reachable sync/revoke/relink gap with failure/replay coverage. Do not repeat the already
completed P01 runner or P02 resource-map audit. Then continue S3–S9/U01–U12 and the platform plan's
remaining P04/P03–P24 work in dependency order.

## Previous checkpoint — 2026-11-15 (P04 product-user actor and chat erasure; pushed c20d13003be80befa7bb7cd45c18f2f5ee424cc2)

Code `c20d13003be80befa7bb7cd45c18f2f5ee424cc2` is pushed and `ls-remote` verified on
`origin/Mcbt5s-Backup-2`. Self-service account deletion now fans out exact-user MicroApp actor cleanup
and the existing G-AO31 SpaceDO session/message/agent-state deletion across every Product Space. It
keeps the durable Product-user erasure marker until all Spaces finish, so retry resumes idempotently.
The Router blocks all authenticated product-session routes and stream-ticket use once that marker is
set while allowing the exact self-service account DELETE to retry. Space membership authorization
also denies members whose Product-user erasure marker is set. Invalid stream tickets do not disclose
erasure state.

Local evidence: product-user MicroApp erasure, route and account cleanup suites **15/15**; Router
product-user identity/erasure/stream-ticket suite **5/5**; Spaces and Router `tsc --noEmit`; `git diff
--check`; and an SQLite membership-fence check (active before erasure, denied after). Local mocks and
SQLite only; no deployment, live provider, browser, or production acceptance. Rollouts remain disabled.
Preserve the preexisting untracked `infra/scripts/__pycache__/`.

P04 remains PARTIAL: supported product-user actor and chat cleanup now has retryable callers, but
per-app user uninstall, other service stores, legal/retention/key/jurisdiction choices, cross-service
consistency, isolated recovery drills and measured RPO/RTO remain open. `PROJECT_USER` remains
unsupported. S2 is locally implemented for its supported provider lanes; S3–S9/U01–U12 and P01–P24
remain open only to the extent shown in their ledgers. U05's Container-versus-Computer trusted
observation bridge is uncoded, not a credentials blocker. The microapp/UI SDK/voice plan copy remains
in platform-plan sections 9 and 11 from `origin/plan/microapps-ui-sdk-voice` at
`df3386257262a88888d647daa4d10f3af2ff9596`; no merge occurred.

Exact next action: implement authenticated per-app uninstall for the product user's own
USER_PRIVATE/SPACE_USER installation. Persist a removal tombstone/receipt, erase that actor's data,
remove its install row only after cleanup is confirmed, retry safely after partial failure, and deny
replay/reinitialization. Keep owner-shared installation untouched. Add Router reachability and
cross-user, retry, partial-failure and post-uninstall-call coverage; then continue other P04 stores
and the next independent requirement in plan dependency order.

## Previous checkpoint — 2026-11-15 (P04 signed product-user MicroApp lifecycle; pushed fbaeeea8ba19a0c9fb73f48209acd1368776dd87)

Code `fbaeeea8ba19a0c9fb73f48209acd1368776dd87` is pushed to
`origin/Mcbt5s-Backup-2`; fetch and `ls-remote` verified the tip. The owner-approved signed bundle
installer now admits low-capability `USER_PRIVATE`/`SPACE_USER` Tier 1 gadgets. The exact product
user can list, explicitly activate, and use the isolated gadget app/data/storage/MCP routes after
current Space membership, owner installation/release pin, publisher key and complete R2 artifact
digest checks. Initialization is lazy and binds the user's actor to the signed release and canvas
proof; per-user activation is separate from the owner's shared package installation. Router exposes
only exact app paths. `PROJECT_USER`, per-user uninstall, and user-actor erasure are not implemented.

Local verification: focused Spaces tests **72/72**, Router allowlist tests **69/69**, Spaces and
Router `tsc --noEmit`, and `git diff --check`. These are local Worker/SQLite mocks; no browser,
deployed Worker, provider, or live acceptance ran. Rollouts remain disabled. Preserve the preexisting
untracked `infra/scripts/__pycache__/`.

P04 remains PARTIAL: product-user MicroApp export/preview/restore and the supported
`USER_PRIVATE`/`SPACE_USER` runtime now have reachable callers. Account deletion still leaves their
actor storage/install rows; archive/update/revocation lifecycle needs further audit, other service
stores, legal/key/jurisdiction policy, cross-service consistency and measured RPO/RTO remain. The
active platform plan already contains the copied microapp/UI SDK/voice text from
`origin/plan/microapps-ui-sdk-voice` at `df3386257262a88888d647daa4d10f3af2ff9596`; no branch merge
occurred. U05's Container-versus-Computer trusted-observation adapter remains uncoded, not blocked by
credentials.

Exact next action: make self-service product-user account erasure delete that user's SPACE_USER and
USER_PRIVATE MicroApp install rows and actor data with durable retry semantics; gate runtime on the
erasure tombstone and cover replay/partial failure. Then continue independent P04 stores and the
remaining S2–S9/U01–U12/P01–P24 gaps.

## Previous checkpoint — 2026-11-15 (U05 runtime-contract trace; P04 user-private MicroApp archive foundation; remote checkpoint 6f6ec9020a8808141a1919f7ffb226ea60e78e71)

Implementation `4a8dd06d2f8407e1272ab0e5c0d71f7b4ba50826` and its owner-archive rejection regression `6f6ec9020a8808141a1919f7ffb226ea60e78e71` are pushed to `origin/Mcbt5s-Backup-2`; the remote tip was fetched and verified at the latter SHA. User-scope MicroApp snapshots require a persisted exact `userId`, matching actor metadata, a signed release and a declared signed gadget scope. Space-owner archive restore rejects user scopes. Router now permits the exact product-user `/export` suffix and rejects neighboring paths. The source plan `origin/plan/microapps-ui-sdk-voice` (`df3386257262a88888d647daa4d10f3af2ff9596`) is already copied into sections 9 and 11 of the active platform plan; only stale provenance/P04 wording differs. No merge occurred.

Local verification: Router route suite **55/55** and Router typecheck; Spaces MicroApp/archive/remediation suites **33/33**, Spaces typecheck, and `git diff --check`. Local only; no routed browser, deployed Worker, or live provider acceptance. Preserve untracked `infra/scripts/__pycache__/`; rollouts remain disabled. P04 remains PARTIAL: the routed product-user account export does not include MicroApp snapshots, and no authenticated current-installation MicroApp archive/restore caller exists.

U05 source trace: `project_main_runtime_registry` identifies a Cloudflare Container project runtime using workflow budget reservations. The candidate verifier reads a separate Cloudflare Computer `live_mount` allocation with exact template/image and region, managed-service credit reservation, and trusted runtime observation. No bridge binds these identities or produces trusted observations. This is an uncoded runtime contract/adapter gap, not unavailable credentials; do not create a mismatched reservation or positive attestation.

Exact next action: implement the reachable exact-user MicroApp archive caller. Derive the active user installation and declared gadget IDs for the verified product-session user; initialize the user-keyed actor with its installation and signed release identity; export a bounded self-service snapshot; add same-user/same-install preview and additive restore with durable replay/audit checks. Keep personal snapshots outside Space-owner archives. Add cross-user, cross-install, removed-install, replay, and malformed-scope coverage. Then continue remaining P04 stores and S3–S9/U01–U12/P01–P24.

## Previous checkpoint — 2026-11-15 (§5 guided-template expected-usage authoring; code checkpoint d9d3138388be16b16dda5859c1884b0445dc5ff4)

Code `d9d3138388be16b16dda5859c1884b0445dc5ff4` is pushed to `origin/Mcbt5s-Backup-2` and
remote-verified. Foundry Studio now edits, previews and saves bounded expected monthly conversations,
interactions, and optional managed-model calls in its authoring draft and signed export. The Agent SDK
and Spaces export/activation paths validate the exact fields; prices and customer budgets are rejected.
Activation preview returns the signed defaults and recalculates with current verified managed-model
rates. The Shell labels author assumptions and lets the customer copy them into editable inputs. USD
total remains unknown and no spend limit/access is created.

Local verification: SDK/Foundry suites **10/10**, Spaces guided-authoring/cost/activation suites
**49/49**, Agent SDK/Spaces/Shell TypeScript checks and `git diff --check` pass. The first root-level
Spaces test command lacked the package `cloudflare:workers` alias; rerunning with `workers/spaces/`
Vitest config passed. Local tests only; no browser, deployed Worker, Marketplace, or provider acceptance
ran. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`. The copied
microapp/UI SDK/voice plan remains in the platform plan from `df3386257262a88888d647daa4d10f3af2ff9596`;
no merge occurred. §5 and P05 remain PARTIAL for cost completeness, lifecycle, provider/payer policy and
live acceptance.

This next action was superseded by the U05 source trace and P04 user-private archive work in the latest checkpoint.

## Previous checkpoint — 2026-11-15 (P06 Telnyx extension voice-profile pin; code checkpoint 2742c3554588e4147eacf352a5ad12e65746b0d6)

Code checkpoint `2742c3554588e4147eacf352a5ad12e65746b0d6` is pushed to `origin/Mcbt5s-Backup-2`;
`ls-remote` confirmed. It adds an owner-selected host-approved economy voice profile to Telnyx extension-line
settings. Migration 0260 pins the selected catalog ID to each admitted extension call and consented
stream session. The media runtime resolves only an exact approved catalog ID; changing line policy
leaves an active call on its original profile. The phone dashboard shows the current list-rate source
and date, consent/cost gates, and the pinned profile in recent call history. The profile remains
separate from the carrier charge. Streaming rollout flags remain disabled.

Local verification: Agents phone/call/session/runtime suites **57/57**; direct Agents, Shell and Agent
SDK TypeScript checks; release migration inventory **260/260**, release tests **20/20**, release
manifest tests **5/5**, deployment manifest tests **14/14**, both manifest validators, and
`git diff --check`. A first parallel run hit one time-sensitive runtime wait; an isolated rerun and
the complete focused rerun passed. These are local tests and mocked credentials/Billing/Telnyx paths.
No deployment, live provider availability/rate/quality check or production acceptance ran. P06 remains
PARTIAL for provider and price verification, first-party package/catalog signing and full dashboard
acceptance. The ordinary pnpm wrapper again tried to purge shared modules and aborted; verification
used existing direct binaries. Preserve untracked `infra/scripts/__pycache__/`.

The requested platform plan text remains copied from `origin/plan/microapps-ui-sdk-voice` commit
`df3386257262a88888d647daa4d10f3af2ff9596`; this is not a branch merge. Rollouts remain disabled.

Exact next action: continue S3/U05 by implementing the missing reachable product-side candidate
allocation/reservation path against the existing owner-authorized workspace runtime lifecycle. Bind a
candidate reservation to the exact tenant/Space/Project, main allocation generation, selected
template/image digest, current authorization and budget reservation; keep candidates unqualified until
trusted runtime observations exist. Add persistence, caller authorization, stale/concurrent allocation
and no-fabricated-attestation tests. Do not claim a live mount, trusted observation, or U06
writer/drain/flush behavior. Then continue P01–P24 and remaining S2–S9/U01–U12 gaps.

## Previous checkpoint — 2026-11-15 (P16 Discord attachment contract reconciled; pushed)

P16 source tracing confirms the active path checks the authenticated event, pairing, active Space and
egress policy before downloading; it accepts only ephemeral CDN references and validates exact CDN
host, event channel/attachment IDs, `ex`/`is`/`hm` query shape, expiry, no redirects, timeout, declared
and streamed size. It stores task-scoped media in R2, then exposes only exact-message metadata/bytes
after the active installation, provider binding and owner-declared `read_text` or `read_image` grant
are rechecked. `read_image` is limited to one PNG/JPEG/WebP up to 480 KiB and validates bytes before
the isolated handler. The channel setup UI and versioned capability API disclose ephemeral-only
support, limits, retention and the ordinary-attachment restriction.

The pinned official [Discord Cloudflare Workers tutorial](https://github.com/discord/discord-api-docs/blob/37148620d2324292b76047541d5f8331f81ea77a/developers/tutorials/hosting-on-cloudflare-workers.mdx)
says ordinary Discord CDN media returns 403 from Workers and ephemeral CDN media is fetchable. The
current [Discord message attachment schema](https://docs.discord.com/developers/resources/message)
documents attachment URLs and `ephemeral` lifetime, but not the `ex`/`is`/`hm` signing format. Keep
that query validation fail-closed and treat its shape as unverified until authorized provider events
confirm it. No relay or provider bypass was added. P16 remains PARTIAL for ordinary media, audio/raw
binary support, query-contract verification and live acceptance.

Local verification: `workers/agents` Discord media and capability suites **9/9**. The existing wider
P16 route/image authorization evidence remains local mock evidence; no live Discord event, deployment
or provider acceptance ran. Rollouts remain disabled and `infra/scripts/__pycache__/` remains
untouched.

Exact next action: continue P17's remaining Marketplace-to-Shell identity handoff. Trace the current
Marketplace session claims, selected listing/purchase scope and Shell session issuer; implement a
short-lived, single-use, exact-listing handoff only if both sides can verify the same identity without
putting bearer credentials in a redirect URL, then add caller, replay, expiry and cross-account tests.
If the identities cannot be linked safely from existing authority, record that exact contract gap and
continue the next independent code requirement. Keep all rollouts disabled.

## Previous checkpoint — 2026-11-15 (§11.2 bounded read action and §11.5 host-connected UI SDK POC; pushed)

Added the signed, bounded, read-only `inventory.listLowStock.v1` action to the MicroApp contract and
host runtime. It reuses the same owner/admin actor, Space/Project scope, active installation and exact
release-pin checks as the existing write actions. The host validates its input/output schema, reads
only one ordered page of at most 100 rows, writes a read audit, and creates no write receipt, event, or
business-data mutation. Space HTTP and assistant/MCP calls use the same execution path. Signed
Space-shared package checks require the exact `read` grant for a read-only action and retain the exact
`write` grant for write actions. The Shell action panel now reviews and explicitly confirms bounded
read payloads and labels them as non-mutating.

The §11.5 POC now uses the Agent SDK client and the existing `MicroAppCanvas` host message handler.
Standalone mode remains synthetic; embedded mode only renders validated host results and has no
synthetic fallback. Browser simulation used a local fake parent, not a deployed authenticated host.
The POC remains isolated and is not adopted into the React 18 Shell.

Local evidence: SDK focused tests **7/7** and typecheck; Spaces business-action/manifest/package
suites **70/70** and typecheck; Shell action-panel tests **5/5** and typecheck; POC bridge tests
**3/3**; Vite production build **117.70 kB JS / 41.34 kB gzip**. Chromium local checks passed at
390px and 320px with owner-confirmed filtering; a sandboxed opaque iframe requested only `list` then
`listLowStock`, rendered two fake host rows, showed no synthetic rows and reported no page errors.
These results are local tests and a mocked host bridge, not deployed identity, live data, multi-user,
screen-reader, provider, or production acceptance. Rollouts stay disabled. Preserve the pre-existing
untracked `infra/scripts/__pycache__/`.

Fetched `origin/plan/microapps-ui-sdk-voice` at `df3386257262a88888d647daa4d10f3af2ff9596` and
compared both active plan files. Its microapp, UI SDK and voice requirements are already present in
the active platform plan; the only plan-file differences are stale metadata and an older P04 summary.
No plan content needed copying and no branch merge occurred. The active plan's newer P04 evidence is
retained. Code `a50e1c6d14f41987ec310e0b8c1aea748c0e7bd6` was pushed as a fast-forward to `origin/Mcbt5s-Backup-2`; `ls-remote` confirmed the branch tip is this SHA.

Source reconciliation found that owner-controlled Project Knowledge selection is already implemented
and pushed in `6d189f450ee61fa9dc74227dab7f95c12b12670d`: migration 137 persists per-tenant/Space/
Project/installation revisioned grants and audit events; authenticated owner/admin routes validate
current publications and exact signed declarations; Project Settings exposes grant/revoke; the Agents
host fetches the current grant and intersects it with the active signed manifest before Knowledge
search. Access defaults to none and uninstall revokes the grants. The broader P05 provider connection
beneficiary/payer/sharing/revocation contract remains partial.

Revalidation passed Spaces Knowledge route/DO/migration/template/activation tests **71/71**, Agents
resolver **3/3**, Knowledge publication/search **6/6**, and Spaces/Agents/Knowledge/Shell typechecks.
These are local Worker/D1 mocks; no deployed multi-user or live Knowledge acceptance ran.

Exact next action: trace the P16 Discord attachment path from provider event through storage to the
owner-approved extension `read_image` handler. Check current official CDN authorization and expiry. If
the active provider binding can authorize ordinary attachments, implement host-mediated retrieval with
strict size/MIME/expiry bounds and tests; otherwise record the precise contract restriction and move to
the next independent P01–P24/S2–S9/U01–U12 gap. Never pass a provider URL or credential to an isolated
package.

## Earlier checkpoint — 2026-11-15 (P04 Knowledge archive and §11 plan reconciliation; pushed)

Code `e475eb6b45e9ef6b219385c4ee2a55ef39f6b895` is pushed to `origin/Mcbt5s-Backup-2`. The bounded,
tenant/Space/Project-scoped Knowledge archive bridge includes canonical document/chunk rows, ACL and
required KB_BUCKET source bytes; deletion leases/tombstones fence export and additive restore. Restored
documents require explicit hash-checked reindexing. Restore does not recreate Vectorize/AutoRAG state or
replay provider effects. The archive excludes the obsolete SpaceDO Knowledge mirror. Knowledge and
Spaces wire the preview/status/apply path; the Shell reports reindex work. P04 remains PARTIAL for other
service/inbound stores, exact-user MicroApp state, retention/legal hold, key/jurisdiction, cross-DO
point-in-time consistency, RPO/RTO and deployed recovery.

Local evidence: Knowledge archive/document lifecycle **36/36**, Spaces archive/data-ops **19/19**,
Shell archive panel **2/2**, Knowledge/Spaces/Shell typechecks, release manifest tests **5/5**,
manifest validators, SQLite migration constraints, and `git diff --check`. These are local mocks and
SQLite checks; no browser, deployed D1/DO/R2, isolated restore drill or provider acceptance ran.

The fetched `origin/plan/microapps-ui-sdk-voice` remains at
`df3386257262a88888d647daa4d10f3af2ff9596`. Its Fish Live 3 and business microapp/UI SDK sections
9–11 are already copied into the active platform plan. Reinspection found no additional plan document
or requirement text on that branch; its plan file carries an older P04/source note. Only the plan
material is used here; no branch merge occurred. The user-private trace confirms that user-keyed scopes
exist but reachable gadget routes construct Space-wide or project-bound actors; no authenticated
exact-user archive caller exists. Keep personal data out of Space-owner archives until that identity
contract exists; this is not a credential gate.

Preserve untracked `infra/scripts/__pycache__/`; all rollout gates stay disabled. Exact next action:
implement a host-rendered owner/admin UI for signed MicroApp business actions in the active Extension
view, using the existing scoped Shell API, Canvas and assistant/MCP host contract. Render validated
schemas, preview the exact payload, require an explicit confirmation, reuse an idempotency key for
uncertain outcomes, and add focused UI/API caller checks. Then continue S2–S9/U01–U12 and P01–P24.

## Previous checkpoint — 2026-11-15 (P05 cleanup resumes after reload; §11.2 reconciled; pushed)

Code `c2963702f6795b0c126f4f7fa769f67f35ee22c7` adds owner/admin preview and confirmation for cleanup
of the exact validated generated Project. Code `0a4021bacd999ba502b65d19704c44108c42abff` adds
owner/admin-scoped cleanup receipts so the Shell rehydrates pending/partial/complete status after
reopening. Spaces reads durable tombstones only for bounded requested IDs and omits raw R2 cursors and
tombstone identifiers. Provider deletion counts remain separate; shared extensions, tenant connections,
licenses and charges are not cancelled. P05 remains PARTIAL for full uninstall and unresolved
payer/revocation/resource policy.

Local evidence: Shell cleanup/status API **2/2**, Spaces cleanup/status **5/5**, Router status forwarding
**1/1**; Shell/Spaces/Router typechecks and `git diff --check` passed. No browser, deployed Worker/R2 or
provider acceptance ran. Preserve untracked `infra/scripts/__pycache__/`; rollouts stay disabled.

Source reconciliation: §11.2 is not uncoded. Pushed `ad20fc8f` defines a signed v1 `receiveStock` action
with server schemas and the same transactional host operation for Canvas HTTP and assistant MCP, exact
installation/release pin, owner/admin actor checks, compare-and-set, idempotent receipts, event/audit,
and generic-CRUD protection. Local tests passed Spaces/routes **24/24**, SDK **5/5**, and Spaces/SDK
typechecks. This is one local action, not general approval or external-side-effect support; do not
duplicate it or claim the whole section live.

P07 source reconciliation confirms local-machine profile selection already exists in `0da0abdb`; current
`CustomModelManifest` only binds a base model and LoRA adapter, with no capability evidence for tools,
modalities or context. No capability-based custom worker selection was added because current source has
no trusted profile to filter against. Keep P07 PARTIAL; this is an evidence-contract gap, not missing
credentials.

Exact next action: continue P04's uncoded MicroApp user-private archive scope. Trace the current
user-private actor key and reachable authenticated callers, then add exact-user-bound snapshot/export/
preview/additive-restore only where verified identity can prove ownership. Keep those records out of
Space-owner archives absent user authorization; if no supported caller exists, record the precise
identity contract gap and advance to another independent P04 store.

## Previous checkpoint — 2026-11-15 (P05 generated Project cleanup caller; pushed)

Code commit `c2963702f6795b0c126f4f7fa769f67f35ee22c7` is pushed to
`origin/Mcbt5s-Backup-2`; a fresh fetch confirmed the prior remote tip was its ancestor, and the
remote now points at this SHA. Template status exposes a reviewed cleanup action for each validated
generated Project ID. Owner/admin confirmation calls the existing DELETE route, archives that exact
Project, and reports bounded progress/retry and project-scoped provider deletion status. It clearly
leaves Space-shared installs, tenant connections, licenses and outside charges alone. P05 remains
PARTIAL for broader uninstall, payer/revocation and provider reconciliation semantics.

Local evidence: Shell cleanup API caller **1/1**, existing Spaces project deletion route **4/4**, Shell
typecheck and `git diff --check` passed. These are local code tests; no browser, deployed Worker/R2 or
provider acceptance ran. Preserve the pre-existing untracked `infra/scripts/__pycache__/`; rollouts
remain disabled.

Exact next action: implement platform-plan §11.2's typed named business-action contract through one
host-authorized action shared by UI and assistant/MCP. Reconcile the existing MicroAppDO, gadget-MCP
routes and callers; enforce installation/actor scope, permission and current revocation, input/output
schemas, expected-version fencing, audit and idempotent side effects, then add one concrete action and
local authorization/replay tests. Continue other P/S/U gaps after this slice.

## Previous checkpoint — 2026-11-15 (P04 archive and P03 billing status; pushed)

Pushed code checkpoints `c46592dad1cfa7eb10228ec41a11d70c7335a872` and
`e90ccab71cac7af34d076ede31521fe6198a00f5` add bounded, owner-authorized MicroApp business-data
archive export/preview/restore to the existing Space archive lifecycle. Snapshots bind exact
tenant/Space/Project, installation, release, artifact, manifest, app and scope identity. They include
supported business tables, action receipts/events and audit, use additive conflict-safe restore, and
retain retry receipts. Preview and apply both reject foreign-key violations. Private/user, legacy
unsigned/unsupported stores remain excluded and are reported; restore installs or activates no code.

Pushed code `c4d9b6ca8a91f8499f2e74a3833db9dd4ebeb6ca` adds scoped Product-user dunning dispatch status
from the durable Billing outbox to the existing authenticated status route and Shell. It distinguishes
pending/leased/queue handoff from email provider acceptance and inbox delivery. The lookup is constrained
to tenant, provider, subscription, product and authenticated end user, and exposes no provider IDs or
receipts. It changes no retry, access, grace or payment policy.

Fresh local evidence: archive suites **30/30**, Shell archive **2/2**, Billing dunning/status **13/13**,
Spaces status caller **2/2**, Spaces/Billing/Shell typechecks, SQLite scope check and `git diff --check`
passed. These use SQLite/local mocks, fake DO namespaces and fake R2. No browser, deployed DO/R2,
provider, invoice, isolated recovery drill or live acceptance ran. P04 remains PARTIAL for other service
stores, user-private and legacy/unsigned stores, retention/legal hold, regional key/R2 provisioning,
cross-DO point-in-time consistency, RPO/RTO and deployed recovery. P03 remains PARTIAL for grace,
restriction/escalation and retry policy decisions, inbox-delivery evidence and provider/live acceptance.
P01 local release automation is implemented; D1 baselines, resource separation, isolated staging and live
promotion remain account-owned gates. Both plan files remain separately active. Keep all rollout gates
false and preserve untracked `infra/scripts/__pycache__/`.

Exact next action: continue platform P05 guided-template lifecycle. The current owner status links
validated generated Projects and required extensions; setup detachment is reversible and explicitly
preserves them. Implement the next safe template-generated Project cleanup caller by reusing the existing
owner/admin project archive-and-workspace-cleanup API, with exact generated-project scope, preview,
confirmation and resumable status. Do not uninstall shared extensions, cancel provider resources or stop
external charges implicitly; keep their ownership and payer/revocation semantics separate. Then proceed
to the next independent voice, shared-Space, section 11, and S2–S9/U01–U12/P01–P24 code gaps. Fetch
before every push; never force-push or enable rollout.

## Previous checkpoint — 2026-11-15 (P06 bounded extension voice runtime; microapp plan copied; pushed)

Code `b39d2da47211bc1b743064e2df9fc020905d16d3` is pushed to `origin/Mcbt5s-Backup-2`; the pre-push
fetch confirmed `0c249321` was an ancestor. P06 now has a separate BYO Telnyx extension runtime with
OpenRouter STT/TTS admission, per-call estimated budget, PCMU/PCM conversion, paced 20 ms output,
barge-in cancellation/clear, bounded queues and payloads, per-turn and session deadlines, exact pinned
handler/settings rechecks, no blind replay after unknown outcomes, and close/hangup cleanup. D1 stores
session-scoped usage receipts, not audio or transcripts; transcript events do not read/write durable
extension session state or retain their response in replay receipts. The five-minute scheduler retries
eligible durable Billing/generation receipts and reports old unresolved usage. Owner status separates
estimated speech admission/cost from carrier charges. Migration `0258` is pinned in release and
deployment manifests. `TELNYX_EXTENSION_STREAMING_ENABLED` and the separate external-acceptance gate are
false in development, staging and production; rollout stays disabled.

The pushed platform plan at `origin/plan/microapps-ui-sdk-voice` (`df3386257262a8882a10e0f7b10fe297cefd17d3`)
was fetched and its Fish Live 3 research plus section 11 business microapp and UI SDK requirements were
copied into the active platform plan. No branch merge or checkout occurred. Current `MicroAppDO` already
has scoped instance storage, a sandboxed Canvas integration and generic schema-column MCP CRUD. That is
not a domain business-action API, unified UI/assistant authorization, arbitrary AI app editing, or
Vercel UI SDK adoption. Those section 11 requirements remain uncoded or partial.

Local evidence: focused Agents voice/call/session/media/phone/SpaceDO suites **75/75**; Agents and Shell
typechecks; release migration/manifest/deployment tests **39/39** and validators; `git diff --check`.
These are local SQLite and mocked provider/Billing tests. No browser, Telnyx, OpenRouter, live invoice,
deployed D1, deployment, or external acceptance ran. Provider audio format/`clear` behavior, actual
STT/TTS prices and generation receipts remain unverified; provider receipts without a usable generation
ID stay unresolved. P06 remains PARTIAL for external acceptance and signed catalog/publisher,
provisioning and quality evidence. Preserve `infra/scripts/__pycache__/` and the remaining S2–S9/U01–U12/
P01–P24 gates.

Exact next action: implement section 11.2's typed, named microapp business-action contract. Reconcile
current `MicroAppDO`, `gadget-mcp` routes and UI callers; make UI and authorized assistant calls execute
the same host-validated operation with installation/actor scope, permissions, current revocation,
input/output schemas, audit, idempotency for effects and expected-version checks. Add one local example
action with authorization and replay tests. Continue remaining independent work afterward; do not stop
at this action's test checkpoint.

## Previous checkpoint — 2026-11-15 (P06 consent caller; P20 source reconciliation; pushed)

Code commit `1f429ee9d970449e3e5d875e3adab0b811e1ac7e` is pushed to
`origin/Mcbt5s-Backup-2`. Immediately before push, fetch confirmed remote `fb145a18` was an ancestor;
no remote history was overwritten. Existing owner/admin settings now include a default-false Telnyx
extension voice preference and explicit UI confirmation. Only when that preference and
`TELNYX_EXTENSION_STREAMING_ENABLED` are both true does an admitted, exactly pinned BYO call create a
consent-pending session and ask the caller to press 1 or 2. Grant/deny, hangup and expiry are persisted;
accepted calls continue through the existing keypad handler. Recent owner status shows consent state.
The new extension-only WebSocket boundary claims a consent ticket, checks the exact Telnyx
`start.call_control_id`, PCMU format and current installation/settings pin, then closes as runtime
unavailable. No `streaming_start` is issued and no media/audio is processed. The streaming flag is
false in development, staging and production; all rollouts remain disabled.

P20 was already implemented in pushed code `5a462626` and migration `0251`; this checkpoint made no
duplicate commercial changes. It records `subscription_payment_refunded` by signed-body hash, keeps
exact invoice/subscription matching and review-only buyer/creator/operator status. Access, earning and
payout policy remains unresolved, so P20 is still PARTIAL overall.

Local evidence: Agents call/session/media/phone suites **52/52**; Agents and Shell typechecks;
P20 normalization/receipt/status/operator suites **25/25**; Router refund-status route **4/4**;
`git diff --check`. A direct Router Vitest invocation without its package config failed module setup;
the correctly configured package run passed. No browser, provider, deployment or live acceptance ran.
The extension media handler intentionally refuses processing while its runtime is unavailable. STT/TTS,
host audio admission and speech budget, interruption, timeouts, stream startup and full cleanup remain
uncoded. These are code gaps, not credential blockers. Preserve `infra/scripts/__pycache__/`, and retain
all S2–S9/U01–U12/P01–P24 gates from both ledgers.

Exact next action: implement and integrate host-owned STT/TTS admission, bounded speech budget and
interruption/deadline/cleanup handling for the separate extension media route. Do not call Telnyx
`streaming_start` or enable the flag until those controls have meaningful verification and acceptance.
Then continue the next independent S/U/P code gap; do not stop after this slice's tests.

## Previous checkpoint — 2026-11-15 (S5/MS08d Modal boundary; P06 durable consent ticket; pushed)

Pushed code checkpoints: Modal request boundary `aa0f6b7b`, public-call cap `3b1059a4`, SDK stream
contract `ed426ee1`, transcript simulator `f2d1f28d`, and durable session/ticket ledger `e4ebd7bd`.
Progress records at `20171141`, `2f365d13`, `9c4e8851` and `e3b9072f` are pushed too. Each push
fetched and confirmed the remote ancestor. Migration `0257` persists exact tenant/Space/Project, BYO
Telnyx binding/call, installation, handler digest and settings revision; the session begins
`consent_pending`. Only an explicit consent transition can issue a random 60-second ticket, stored as a
hash; claim rechecks the active binding/call/handler and is one-use. No webhook or media WebSocket
calls these functions yet. Shell has synthetic transcript simulation, not live streaming. Five-call
admission is atomic and uncertain calls hold capacity. U09 routes are reachable.

Local evidence: stream-session migration tests **3/3**; phone route/Agents DO/Shell tests **52/52**;
SDK tests **6/6**; Telnyx call tests **6/6**; Agents/Shell typechecks; release and deployment manifest
validation; Modal host **8/8**, Agents client **3/3**, Modal/Agents builds/typechecks and `git diff
--check`. Docker build stopped at Corepack (`SELF_SIGNED_CERT_IN_CHAIN`); no image or CI Docker result.
No browser, provider, deployment or live acceptance. Modal remains gated on Beta/private-gRPC, supported
usage receipt and approved prices. Keep all rollout flags disabled; preserve
`infra/scripts/__pycache__/`.

P06 remains partial: no reachable public media caller, caller-consent prompt/state transition, STT/TTS
adapter, speech budget, interruption or full customer live operations. The ticket/session functions are
not a live call path. Existing PCMU bridge is OwnerVoice-only and must not be reused. Stream runtime
work is uncoded, not credential-blocked. The signed bounded-phone-menu dashboard is already implemented.
First-party publisher identity/signing/catalog/provisioning, complete voice lifecycle/cost evidence and
live carrier acceptance remain open.

Exact next action: wire the existing ticket functions into a separate Telnyx extension call flow:
when the global flag is false, preserve current DTMF unchanged; when a future default-off flag and
owner speech setting are both enabled, create a pinned consent-pending session, ask for explicit caller
consent, persist accept/deny, and issue/claim a one-time media ticket only on consent. Add a dedicated
WebSocket caller that authenticates the exact provider call and pinned extension without OwnerVoice.
Do not start streaming until host STT/TTS admission, speech budget, interruption, timeout and cleanup
are implemented. Keep flags false.
## Previous checkpoint — 2026-11-15 (U09 encrypted private-state recovery and cleanup; pushed)

Code `ef77e19375b134c724be5fec95ba771573e1ba10` is pushed to `origin/Mcbt5s-Backup-2`; pre-push fetch
confirmed the remote at `7e9d3c2b` with no advance. Migration 0255 adds a default-empty owner-selected
private-path manifest, metadata-only revision audit and encrypted backup ledger. Owner/admin APIs and
Project Settings manage bounded UTF-8 paths below `.naelao/private/`, outside canonical workspace sync.
Capture filters secret-named/shared/browser/cache paths and common credential material. AES-GCM/HKDF
binds tenant/Space/Project/jurisdiction, request, generation, configured image/toolchain fingerprints,
key version and expiry. Restore checks tombstone, generation, jurisdiction, expiry, selection and
provenance, then writes only missing files. Retention runs every five minutes in bounded batches;
expired and project-erased records stay `delete_pending` until R2 acknowledges deletion, and erasure
waits for pending private-state objects. All flags remain false.

Evidence: five focused Agents suites **66/66**, Agents and Shell typechecks, release migration tests
**20/20**, release/deployment validators confirm **255** migrations and required schema 0255, and
`git diff --check`. These are local SQLite/fake-R2/fake-Container checks. Dedicated global/EU R2
bindings and the encryption key are absent, so the feature is unavailable in every environment. No
deployed D1/R2/Container, browser, provider, deployment or live acceptance ran. U09 remains PARTIAL for
provider snapshot deletion, restart execution, old-process reconnect fencing, trusted immutable image/
toolchain evidence and deployed recovery acceptance. U10's runtime/browser notification ledgers and
retry path exist; dormant unregistered objects and provider physical purge remain unproven. U05 image
selection and trusted mount/sync/flush/region producers remain unsupported platform contracts, not
credential blockers. Preserve untracked `infra/scripts/__pycache__/` and keep rollouts disabled.

Historical next action superseded by `aa0f6b7b`: the Node host and durable journal exist, but no Modal create caller is enabled. Pricing, usage reconciliation and Beta/private-gRPC acceptance remain gates.

## Previous checkpoint — 2026-11-14 (P05 guided setup lifecycle; U05 runtime contract gate; pushed)

Code `c0daaf86a2c8c05b2e211eccc360367c3c9adf44` is pushed to `origin/Mcbt5s-Backup-2`; fetch before
push confirmed no remote advance. Space Template owners/admins can preview, detach, and reattach the
setup-management association with exact artifact/setup-revision fencing. Detach deletes a pending setup
draft and preserves published setup values, generated Projects, required extensions and Project
Knowledge grants. A bounded durable actor/action history is exposed in owner status. Activation retries
and setup migrations fail closed while detached. The Shell states that provider resources, licenses,
recurring charges and extension grants are not changed; this is setup detachment, not full uninstall or
billing cancellation.

Local evidence: Spaces template lifecycle/activation/migration suites **36/36**, Spaces and Shell
typechecks, and `git diff --check`. No browser, provider, deployment, package uninstall, or live
acceptance ran. P05 remains PARTIAL for project/extension cleanup semantics, provider/license/charge
reconciliation, Space-wide provider authority/payer/revocation policy and live acceptance.

U05 source reconciliation: no project-main candidate allocator was added because the existing
`project_main_runtime_registry` has no selectable immutable image digest, and the main Cloudflare
Container has no trusted mount/sync/flush/region observation producer. The verifier's current
live-mount candidates are a separate `sandbox_computers`/provider-allocation model and require those
observations. An operator assertion or setup record cannot prove them. This is a missing runtime
platform contract/producer, not a credential blocker; keep live workspace rollout false. Preserve
untracked `infra/scripts/__pycache__/`.

Exact next action: continue P06 voice integration at the supported Telnyx DTMF call path. Pin each
admitted call to its exact extension installation/handler and the published settings revision used at
call start; pass that pin through later DTMF turns and resolve only the matching published version.
Fail closed if the pinned release/version is unavailable; do not silently use newer settings. Add
bounded persistence, stale-update/retry/cleanup coverage and owner-facing revision evidence. Then
continue P06 dashboards/voice and §10 shared-Space caller gaps, plus remaining S3–S9/U01–U12/P01–P24.
Keep rollout disabled.

## Previous checkpoint — 2026-11-14 (P04 safe Project runtime settings archive; pushed)

Code `e747b62d15da7f62405159595636726652de9153` is pushed to `origin/Mcbt5s-Backup-2`. Full Space
archives include a bounded, versioned Agent-owned Project main-runtime profile and inert restart
recipes. The authenticated Agents bridge binds tenant/Space/Project, validates schema and size, previews
conflicts and additively restores only missing settings with actor audit. Allocations, observations and
provider snapshots remain excluded; recipes stay inert. Local Agents **9/9**, Space codec/schema **7/7**,
data-ops **17/17** plus project archive integration rerun, Shell **2/2**, affected typechecks and
`git diff --check` passed. No browser, deployment, R2 drill, provider call or live acceptance ran. P04
remains PARTIAL for other service stores/private inbound data, retention/key/jurisdiction, RPO/RTO and
isolated/deployed recovery.

## Previous checkpoint — 2026-11-14 (U05 exact project hold check; P04 next; pushed)

Code `b5b0514068c96f711de60d54a4bd2e1fd93ca5cf` is pushed to `origin/Mcbt5s-Backup-2`; pre-push fetch confirmed `36dfb191` with no advance. Project-main runtime generation admission now requires its Billing hold to match the exact tenant, Space and Project, remain held, and remain unexpired before the container can start. The regression proves a different Project's hold does not claim an allocation generation or start the runtime.

Local evidence: `corepack pnpm --filter @naelao/agents-worker exec vitest run src/do/DynamicSandboxDO.test.ts` **34/34**, Agents typecheck, and `git diff --check`. The global pnpm 11 wrapper attempted dependency reconciliation and aborted without a TTY; repository-pinned Corepack pnpm **9.12.0** ran the suite without changing the lockfile or worktree dependencies. No deployment, Cloudflare live runtime, provider, or live acceptance ran.

U05 remains PARTIAL: the exact project budget binding is closed locally; the live candidate/observation path is still absent. Current `project_main_runtime_registry` is a checked Container execution identity, not a live FUSE mount. The observation write route is operator-gated, and there is no trusted runtime producer for mount readiness, filesystem drain/flush, authenticated reconnect or region evidence. This is an unsupported runtime/platform contract, not missing credentials. Do not fabricate a positive observation or enable rollout. P01 local runner/failure checks remain closed; P02 resource ownership/separation and read-only receipts remain external. Preserve untracked `infra/scripts/__pycache__/`.

Exact next action: continue P04 by archiving the small Agent-owned Project main runtime profile and inert restart-recipe configuration alongside each full Space archive. Add a versioned, tenant/Space/Project-bound authenticated Agents export/restore bridge; validate profile/recipe schemas, merge only when the destination has no current value, write restore-actor audit records, and never restore runtime allocations, live observations or provider snapshots. Include the snapshot in archive preview/status and add retry, conflict, authorization and migration-backed tests. Then continue remaining P04 stores and P05 lifecycle gaps.

## Previous checkpoint — 2026-11-14 (P06 published settings and next U05 action; pushed)

Code `6bf8de58716ac473913e5b305fe8ac97b8f19bba` is pushed to `origin/Mcbt5s-Backup-2`; the pre-push fetch showed `c73a1810` with no advance. The signed bounded phone menu now keeps schema-validated per-installation drafts separate from active settings, requires owner/admin confirmation to publish with revision fences, retains the latest 20 published versions, and can create a rollback draft only when its schema still matches. Active calls read published values; only an owner-triggered synthetic scenario may select the draft. Audit records retain actor/revision/field IDs, not setting values. Package version is 1.0.8.

Local evidence: SDK package tests **38/38** and typecheck; Spaces selected settings/migration/route tests **34/34** and typecheck; Agents phone/simulation/scope tests **49/49** and typecheck; `git diff --check`. No browser, signed catalog installation, provider/carrier, deployment or live acceptance ran. P06 remains PARTIAL for first-party signing/catalog/provisioning, conversational streaming, complete cost/quality evidence and live acceptance. Current handler invocations use the latest published settings; there is no per-call configuration snapshot.

P01's fail-closed migration runner and failure-injection path are already locally implemented and verified in the current platform ledger; do not repeat the stale recorded task. P02 still requires real Cloudflare resource ownership/separation, per-D1 operator baselines and read-only receipts. Current §10 source has the host-only Space singleton reservation implementation; preserve the fact that it reserves/discloses a capability and does not grant access. Policy, retention, jurisdiction, provider and deployed gates remain distinct. Rollouts remain disabled. Preserve untracked `infra/scripts/__pycache__/`.

Exact next action: continue S3/U05 by implementing the missing reachable product-side candidate allocation/reservation path against the existing owner-authorized workspace runtime lifecycle. Bind reservations to exact tenant/Space/project, main allocation generation, selected template/image digest, current authorization and budget reservation; keep candidates unqualified until trusted runtime observations exist. Add persistence, caller authorization, stale/concurrent allocation and no-fabricated-attestation tests. Do not claim a live mount, trusted observation, or U06 writer/drain/flush behavior. Then continue P04/P05 and remaining S3–S9/U01–U12/P01–P24 gaps.

## Previous checkpoint — 2026-11-14 (P06 synthetic scenario response comparison; pushed)

Code `c7b8b45ac21badaf7719f48d56a490fd537c1f75` is pushed to `origin/Mcbt5s-Backup-2`; the
pre-push fetch confirmed remote tip `bafa3d9c` with no advance. The bounded phone-menu dashboard now
shows each host-validated synthetic response beside the preview generated from saved settings. Results
are rendered as text, and the package is version 1.0.7 so changed signed artifact content cannot reuse
1.0.6. The prior `7f6f4591` scenario suite is still binding-scoped, owner-triggered, Twilio-policy
limited and simulation-only; the bounded sample is not a conversational agent.

Local verification: SDK dashboard/handler suite **6/6**, SDK typecheck and `git diff --check`. The
underlying host simulation tests passed **2/2** in the previous pushed checkpoint. No browser, carrier,
provider, deployment or live acceptance ran. P06 remains PARTIAL for config publication lifecycle,
first-party catalog/provisioning, conversational streaming, complete cost evidence and live acceptance.
The first-party listing has a real publisher identity/key custody/artifact distribution contract gate,
not a credential blocker. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

The stale coordination-posture next action was checked against current source and is already complete:
`a3791d51` attaches a validated advisory coordination default, `06250151` applies reviewed singleton
defaults, and activation shows the signed choices, requires owner/admin confirmation, writes only at
expected revision 0, and preserves existing policies. Focused activation and authoring tests pass
**37/37**. No duplicate implementation is needed.

Exact next action: implement explicit draft-versus-published configuration for the bounded phone menu.
Today its generic installation settings `PATCH` replaces the settings row that the live handler reads,
so saving a menu immediately changes runtime behavior. Add durable, schema-validated per-installation
draft state and owner/admin publication with optimistic revision fencing; keep runtime reads on the
active published row, expose an owner preview/simulation of the draft, audit revisions without values,
and verify failed/conflicting publication never changes active settings. Reuse exact signed install and
existing settings authorization. Then continue independent P05/P06/shared-Space/S3–S9/U01–U12/P01–P24
gaps. Fetch and integrate before every push; no deploy or rollout enablement.

## Previous checkpoint — 2026-11-14 (P06 owner-selected Twilio voice style)

Code `7e218ae2932fbd3c2f67df9c70e11d5b7d4a36d9` is pushed to `origin/Mcbt5s-Backup-2` from
`autonomous-managed-services-20261111`. Before pushing, fetch showed the remote at `de27aea7` with no
concurrent advance. The signed bounded phone-menu release is now 1.0.5 and adds a persisted
per-installation `speech_style` setting: provider default, Twilio `man`, or Twilio `woman`. The SDK
and host accept only the documented enum, Twilio renders it as a `<Say voice>` attribute, and the
synthetic preview uses the same selection. Telnyx stays on its provider default and its DTMF host
parser rejects Twilio style fields. UI/README disclosure makes no availability, language, quality or
rate guarantee.

Local verification: SDK voice/package suites **15/15**, SDK manifest/signature suites **36/36**,
Agents renderer/phone/Telnyx suites **47/47**, Agent SDK and Agents typechecks, and `git diff --check`.
These are local tests; no browser, deployment, provider, carrier or live acceptance ran. P06 remains
PARTIAL for the conversational voice-agent lifecycle, first-party package identity/catalog,
provisioning, streaming, full cost and live acceptance. P04's archive-grant recovery gap was already
closed in pushed code `75feeabb`; it is not the next task. S2–S9/U01–U12 and P01–P24 remain at their
row-specific statuses. Rollouts stay disabled; preserve untracked `infra/scripts/__pycache__/`.

Exact next action: close the P20 template-subscription refund receipt gap. Lemon Squeezy's current
event catalogue includes `subscription_payment_refunded`, while the local SDK maps no such event and
the template-subscription webhook branch records neither refund evidence nor a review state. Add a
versioned normalized event and durable idempotent review-only receipt tied to the exact subscription
and provider invoice/body; add permission-checked buyer/author status callers where the existing
identity model supports them. Do not change subscription access, paid-cycle totals, developer
earnings, refunds or payout policy; preserve unknown amount semantics. Then continue other independent
requirements. Fetch and safely integrate remote advances before each push; push coherent checkpoints
to `Mcbt5s-Backup-2` without force-pushing. No deployment, purchase or rollout enablement.

## Previous checkpoint — 2026-11-14 (P05 guided Project Knowledge handoff)

Guided activation handoff code `e9be8aee` and its missing-Project-ID recovery fix `38f50b41` are
pushed to `origin/Mcbt5s-Backup-2`. When the signed activation preview requires owner-published
external Knowledge, activation now opens a handoff to every validated created Project. Each Project
page points owners to publish/index a collection declared by the active package and then explicitly
grant the current publication in the Project controls. The handoff switches to the target Space
before navigation. Missing or malformed Project IDs show a safe recovery path; they never create a
grant. No Knowledge access is automatic.

Local evidence: Shell `tsc --noEmit` passes; Spaces blueprint activation tests pass **24/24**; the
focused diff passes `git diff --check`. The direct local binaries were used because the global pnpm
wrapper tried a dependency reconciliation and aborted when no TTY was available. No browser,
deployment, live multi-user or provider acceptance ran. P05 remains PARTIAL for broad guided setup and
cost/lifecycle coverage, the Space-wide provider connection authority/payer/revocation contract, and
live acceptance. Keep all rollouts disabled and preserve the untracked
`infra/scripts/__pycache__/`.

Exact next action: close the P04/P05 recovery interaction found while reconciling migration 137 with
Space archives. Full archive export currently includes `extension_project_knowledge_grants`, and
additive restore can reinsert a grant that was revoked after export. Exclude this permission table
from full archive export, reject it in archive restore (including older crafted/stored archives),
disclose that Knowledge grants require reapproval after restore, and add focused export/restore
regression coverage. Fetch and safely integrate remote advances before every push; then continue the
next independent uncoded requirement in both plans.

## Previous checkpoint — 2026-11-14 (P05 owner-controlled Project Knowledge grants)

Code `6d189f450ee61fa9dc74227dab7f95c12b12670d` is pushed to `origin/Mcbt5s-Backup-2`.
Space-shared channel extensions now receive no Project Knowledge by default. Space owners/admins can
select only collections that are both declared by the active signed installation and currently
published in that Project. Migration 137 stores revisioned Space/Project/installation selections and
bounded actor-attributed history; an empty selection revokes access, and uninstall clears grants with
a revocation event. The Project page exposes the selection. Before every extension search, the Agents
host requires a Project ID, reads the internal policy, and intersects grants with the active signed
manifest; malformed or unavailable state fails closed. Project-scoped extension behavior is unchanged.

Local evidence: Spaces runtime/migration/authorization suites **38/38**, Agents selection/attachment
routes **12/12**, Spaces/Agents/Shell typechecks, and `git diff --check`. These are local tests only;
no browser, deployment, live multi-user, Knowledge provider, or channel acceptance ran. P05 remains
PARTIAL for guided-template-to-Project grant handoff, shared provider-connection authority/payer/
beneficiary/revocation semantics, broader setup/cost requirements, and live acceptance. The provider
connection gap is a product contract, not a credential blocker. Keep all rollouts disabled and preserve
the untracked `infra/scripts/__pycache__/`.

Exact next action: trace signed SpaceBlueprint activation and resumable setup to map each created
Project, Space-shared installation, and owner-published collection. Carry explicit per-Project
Knowledge selections from activation review into the existing migration-137 grant ledger, validating
current publication and active signed declaration at commit/retry; omitted selections must stay empty.
Add focused retry, revocation, and authorization coverage without creating a second grant store. Keep
Space-wide provider connections separately gated. Fetch and safely integrate before every push.

## Previous checkpoint — 2026-11-14 (P16 Discord attachment bounds; P13 queue coverage)

P16 code `db56ee37` and P13 code `da6245fe` are pushed to `origin/Mcbt5s-Backup-2`. P16 now requires
a current Discord-signed ephemeral URL (`ex`, `is`, `hm`), exact event channel/attachment path
binding, declared and streamed byte caps, response-length checks, timeout, and no redirects. Agents
maps expired bearer URLs to a non-retryable unsupported-media response. Official Discord docs state
ordinary CDN media is blocked from Cloudflare Workers; ordinary attachments still need a separately
operated supported retrieval host/relay and remain unsupported here. Do not bypass the provider or
pass URLs/credentials to extensions. P16 remains partial for that host gate and live acceptance.

P13 now detects when Cloudflare GraphQL returns the full 100-row limit and persists a
`queue_analytics_row_limit_reached` alert; reports remain incomplete. Current backlog/age/DLQ still lack
a supported API source. Admin's consumer targets a different queue, retains raw payloads, and has no
reachable Router/service-binding path or supported `platform_admin` identity issuance; generic replay
still needs scope, retention/redaction, and duplicate-side-effect contracts.

Local evidence: Discord media/attachment routes **12/12**, Agents typecheck; queue-health model **8/8**,
Workflows typecheck, and `git diff --check`. P01 current manifest pins **249** migrations through
`0249_project_main_runtime_budget_reservations`; fresh SQLite rehearsal **20/20** applies the full
manifest and manifest validators pass **18/18**. These are local tests only; no remote D1 baseline,
deployment, provider call, or live acceptance ran. P01/P02 remain fail-closed on verified baselines,
separate resources, ownership, and read-only receipts. Keep every rollout disabled; preserve the
untracked `infra/scripts/__pycache__/`.

P05 shared provider-connection scope still lacks an authorizer, beneficiary runtime set, payer/account
sharing, and revocation/drain contract; template-to-Project Knowledge binding is uncoded. These are
not credential blockers. S2 supported lanes and U01–U12 records remain as reconciled in the ledgers;
U05 trusted mount/sync/flush observations and U06 writer/drain/handoff contract remain unsupported.

Exact next action: implement owner-controlled, per-Project Knowledge selection for Space-shared
channel extensions using existing owner-published collections. Persist selection by Space, Project,
installation and exact publication; allow owner/admin callers to list and grant/revoke only current
published IDs; have the Agents host intersect the current active signed manifest with that selection
before external search. Default to no new grants and preserve existing project-scoped behavior. Keep
provider-connection sharing separately gated. Fetch and safely integrate before every push.

## Previous checkpoint — 2026-11-14 (P05 model-credit planning budget)

Code `d4b1652ef12cea0b2a45970342c5093dd38965a2` is pushed after cost-scenario code
`d3044a665d16038ad54d4396d6a23b304849090e`; both are on `origin/Mcbt5s-Backup-2`. The guided
activation preview accepts a bounded customer-entered monthly Naelao-credit budget and compares it
with a verified model projection. Its response marks the comparison `not_enforced`; the assumption is
not persisted and does not alter Billing. The Shell says so explicitly and keeps the separate
operator-verified monthly operation cap and uncontrolled provider costs distinct. Local verification
for the current code: SQLite-backed Spaces estimate/activation **32/32**, Shell parser **4/4**, Spaces
and Shell typechecks, and `git diff --check`. No browser, deployment, purchase, or live provider
acceptance ran. The P05 calculator remains partial: no enforceable template budget, provider-cost
quote, or total USD operating estimate exists.

Source evidence for that limit: the current managed Workers AI `managed-model-quote/run` route is
owner-only; `runManagedModelOperation` creates a separate mandate keyed to the exact operation with
the quote's single-operation credit amount as its period maximum, then revokes it after completion.
There is no generic template/runtime caller that can bind an installer budget to model operations.
Do not reinterpret this one-operation consent or warning thresholds as a template spending cap.
P05 Space-shared provider scope, Modal host/API acceptance, P06 publisher trust, and the P01/P02/P03/
P20 policy/inventory gates remain separate from missing credentials.

Preserve untracked `infra/scripts/__pycache__/`; keep all rollouts disabled.

Exact next action: trace the P16 Discord attachment path from provider event through storage to the
owner-approved extension `read_image` handler. Check the current official CDN authorization/expiry
contract. If the existing active provider binding can authorize an exact ordinary attachment, add a
host-mediated retrieval path with strict byte/MIME/expiry bounds and tests; otherwise record the
specific contract restriction and proceed to the next independent S3–S9/U01–U12/P01–P24 code gap.
Never pass a provider URL or credential to the isolated package. Fetch and safely integrate before
every push.

## Previous checkpoint — 2026-11-14 (P05 guided-template model-cost scenario)

Code commit `d3044a665d16038ad54d4396d6a23b304849090e` is pushed to
`origin/Mcbt5s-Backup-2`. The owner-only guided-template activation preview now lists only active,
operator-verified Workers AI model rates for the tenant plan and latest verified capability version.
It validates the customer-selected model and operation multiplier, projects the pinned Naelao credits,
price version, per-operation ceiling, monthly operation cap and expiry, and reports unavailable/stale
rates without inventing a price. The Shell caller connects those controls to the preview and states
that Billing enforces the monthly operation cap while direct provider charges remain excluded and
uncontrolled by it. The full USD operating total remains null. Local verification: SQLite-backed
Spaces estimate/activation suites **32/32**, Shell estimate parser **4/4**, Spaces and Shell typechecks,
and `git diff --check`. These are local tests only; no browser, deployment, purchase or live provider
acceptance ran. P05's cost calculator remains partial; no customer-selected enforceable template budget
or provider/total-cost quote is implemented. S2–S9/U01–U12 states otherwise remain as recorded.

Preserve untracked `infra/scripts/__pycache__/`; keep rollouts disabled. The P05 Space-shared provider
connection contract and MS08d Modal compatible-host/Beta-API decision remain genuine product/platform
gates, not credential blockers.

Exact next action: extend this activation-preview scenario with an optional customer-entered monthly
Naelao-credit planning budget. Compare it with the verified model projection, bound and validate it on
the server, and label it as an unpersisted planning assumption that does not enforce a spending cap.
Keep the separately verified Billing operation cap distinct, and disclose provider costs remain
uncontrolled/unknown. Add route, SQLite, parser and caller coverage; then continue P05/P06 and the next
independent S3–S9/U01–U12/P01–P24 implementation gap. Fetch and safely integrate before every push.

## Previous checkpoint — 2026-11-14 (S5/MS08d Modal contract reconciliation)

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
After compaction, interruption or a new session, read all seven active plan sources, all seven durable progress records and this
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
product, policy, runtime contract and live acceptance gates remain in all four progress records.

Historical next action: continue §9.5 through the signed extension and bounded Telnyx `say`/DTMF
callers. Its phone simulator/package work is recorded in later checkpoints; resume from the active
P24 action at the top. Keep public streaming and provider/live acceptance gated.
The earlier §10.2 expected-version-fenced, audience-confirmed amendment is already implemented and
pushed as `bfc22ce6`; do not repeat it. After compaction, interruption or a new session, read all four
active plan sources and all four durable progress records and this runbook; inspect the actual worktree, branch and dirty state;
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

- After compaction, interruption or a new session, read all seven active plan sources and all seven progress records
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
