# Platform completion and guided templates progress

## Latest cross-plan checkpoint — 2026-11-16 (K14/K17 language-pair evaluation; `d6f6cfb7` pushed)

The local Knowledge search route now feeds K17 through a content-free trace whitelist. The evaluator reports retrieval, citation/source-version, forbidden-scope, abstention, latency and cost metrics overall, per query language and per query/source-language pair; caller-supplied thresholds must pass at each level. It reports schema v2 and `acceptanceEligible:false`. Codes `4e3c3a7a`, `3d67805e` and `d6f6cfb7` are pushed and remote-verified. P01 source reconciliation also confirmed post-Worker health probes are already wired into both deployment workflows before frontend publication; probe tests **5/5** and the manifest validator pass locally. They have not been run against a deployed environment.

Evidence: evaluator tests **6/6**, Knowledge search-route integration **6/6**, Node syntax check and diff check. Fixtures are synthetic and local. The checked-in dataset remains English-only; reviewed Shona/Ndebele/domain corpus, provider/deployed measurement, invoice or rollout evidence is absent. K14/K17 remain in progress. Exact next action: implement owner-authorized per-conversation assistant routing for AgentMail threads, preserving account defaults, route revisions and the owner Shell caller. User-issued switch commands remain unsupported until a verifiable channel-identity contract exists.

## Previous cross-plan checkpoint — 2026-11-16 (K17 evaluator and K14 language coverage guard; `ab01086d` pushed)

K17 now has an offline evaluator for content-free retrieval traces, scoring ranking, citations/source versions, forbidden scope, abstention, latency and recorded cost. Synthetic English fixtures cover an exact identifier, stale-vs-current source and no-answer case. The evaluator requires reviewed English/Shona/Ndebele coverage and always denies acceptance until human review, thresholds and deployed/provider evidence exist. K10's source audit found no upstream file ACL identity proof caller; MCP tool aliases are not provider-file authorization. No mapping was invented.

Base code `c908c088871648aa06dcb80a0741bd94d89ed851` and the multilingual coverage guard `ab01086d651ff607450411bc66f195dfb018cf8c` are remote-verified. Tests: evaluator **3/3**; CLI smoke only checked missing-result/missing-language reporting. No live search quality, human language review, deployed retrieval, provider invoice or rollout acceptance ran.

At that checkpoint the local route trace integration and explicit threshold comparison were still open; they are implemented in the latest checkpoint above. Native/domain review, representative data and deployed/provider measurement remain separate gates.

## Latest cross-plan checkpoint — 2026-11-16 (K13 shared chunk and citation spans; `90278732` pushed)

Synchronous Knowledge creates, edits and the reachable Project Workflows queue now use the same bounded chunk contract and exact source coordinates. The `KbIngestionWorkflow` 10 KiB splitter is removed; text/Markdown chunks stay under 2,048 characters, structural PDF chunks preserve their bounded table behavior, and overlap coordinates remain correct for Unicode/repeated text/CRLF. Knowledge stores consistent source spans and resolves citations from the hash-checked chunk object. No provider path or rollout was enabled.

Code `9027873242af4243343d9f834f6dce0c40504fdf` is remote-verified. Local evidence: RAG **28/28**, Knowledge **150/150**, Workflow caller **8/8**, three typechecks and diff check. AutoRAG remains hard-disabled pending K15 isolation acceptance. No migration/deployment/live provider or citation acceptance ran; rollouts remain off and the untracked Python cache is preserved.

K10's source audit found no provider file-ACL identity proof caller; MCP connector aliases are tool grants only. K17/K14 evaluation work is tracked in the latest checkpoint above. Continue from its exact next action.

## Latest cross-plan checkpoint — 2026-11-16 (K09 owner path and robots policy; `fb6edf25` pushed)

Host website grants now persist and expose owner-configured Knowledge path prefixes. Knowledge enforces those paths, approved HTTPS origins and robots rules for requested and redirected pages, failing closed when robots policy cannot be checked. This hardens the single-page preview/refresh adapter; it does not add crawling or scheduling.

Code `fb6edf2595394add136fe474c79fd89f1b83ac02` is remote-verified. Knowledge **146/146**, Spaces connection route **14/14**, three typechecks, release inventory **273**, both manifest validators, Python migration/release tests **39/39**, SQLite default exercise and diff check pass. Full Spaces suite has four failures outside the changed route (**653/657**). Migration is unapplied; no deployed/live acceptance ran. Keep rollouts off and preserve the unstaged Python cache.

K13's reachable sync, edit and Workflow chunking/citation paths are aligned and pushed as `90278732`. Continue at K10 as recorded in the latest checkpoint above.

## Latest cross-plan checkpoint — 2026-11-16 (K08 bounded website refresh; `7732d992` pushed)

K08 now has a manual website refresh path through the Project owner preview/review caller, a migration-backed idempotent operation ledger, revision/grant fencing, two-minute abandoned-fetch recovery, bounded retry/backoff, and freshness status in Project Shell. The previous indexed content remains authoritative until its approved replacement is successfully reindexed.

Code `7732d992a471440ec6271e614705244e8bab59aa` is remote-verified. Knowledge **141/141**, Shell caller **3/3**, both typechecks, release inventory **272**, release/deployment validators and Python tests **39/39**, and diff check pass. Migration 0272 is unapplied; no browser, deployed Worker/D1, scheduler, provider or live acceptance ran. Rollouts remain disabled and `infra/scripts/__pycache__/` remains unstaged.

K08 remains partial for scheduled/incremental sync, cursors, cost and operational reporting. Exact next action: implement K09's host-owner configured path restrictions and robots checks through website preview/create/refresh and every redirect; continue the remaining K/S/U/P/PW/EP requirements afterward.

## Latest cross-plan checkpoint — 2026-11-16 (K07 owner-approved website snapshot; `99f9081c` pushed)

The Project Shell reaches a Knowledge preview/create path backed by the exact host-owned active website connection. Preview enforces owner/Project/origin and redirect-time SSRF/origin checks, bounded HTML/Markdown/plain text, sanitized content and a 15-minute HMAC receipt. The owner reviews/edits before idempotent create. Migration 0271 binds searchable website docs to the connection and caps it at 100 pages; publication/search/citation paths check live status, while host revocation blocks access and starts durable cleanup. The browser profile is still revoked when Knowledge cleanup is unavailable.

Code `99f9081ced263c219831757c2d504124050a5ff5` is remote-verified. Local evidence: Knowledge **131/131**, Spaces **11/11**, Shell API **2/2**, three typechecks, release inventory **271 migrations**, standalone SQLite trigger exercise and `git diff --check`. Migration 0271 is unapplied; tests are local mocks/SQLite. No browser, deployment, scheduled sync, provider or live acceptance ran. Keep rollouts off and preserve `infra/scripts/__pycache__/`.

This closes the K07 website preview/create caller only. A logical source registry, provider connector adapters, scheduled/incremental refresh and freshness UI remain uncoded. Exact next action: implement K08's durable provider-neutral refresh state and owner-visible freshness/retry path, fenced by source revision and active host grant; test replay/lost response, stale completion, revoke race and deletion. Continue remaining K09/K/S/U/P/PW/EP gaps.

## Latest cross-plan checkpoint — 2026-11-16 (K07 source lineage; `3bf31c66` pushed)

Knowledge migration 0270 records adapter kind, source revision/hash/state and private opaque host connection/grant references. Manual create/edit/delete and archive/restore are wired; URL excerpts remain unsupported for refresh. Connector rows require a host reference and grant revision, but no connector issuer or refresh caller is implemented. The release schema manifest now includes existing migrations 0266–0269 and new 0270; it was previously stale at 0265. Code `3bf31c665451aceb48aa047680d67309524cac00` is remote-verified. Knowledge **121/121**, typecheck, SQLite migration/backfill/connector guard/insert tests and release inventory **270 files** pass. Migration is unapplied; no provider/live acceptance ran; rollouts remain off.

Exact next action: connect host-owned website connections to a bounded Knowledge fetch/create path with exact user/Project/origin authorization, redirect revalidation, grant-revision persistence and revoke fencing. Keep provider connector support unavailable until its host grant/adapter caller is implemented; then continue K08 and remaining K/S/U/P/PW/EP gaps.

## Latest cross-plan checkpoint — 2026-11-16 (K06 attachment/channel scope verified; current code `0642ece4`)

K06 caller verification found no implicit attachment promotion or current-grant bypass. Ordinary uploads remain task-scoped and separate from Knowledge publication membership; channel reads are bound to the active task and exact installation/provider connection and only feed transient answer context. Web/WhatsApp/email share the owner-publication/revision-fenced handler. Phone extensions reject Knowledge declarations, so phone Knowledge remains unsupported and fails closed. Local evidence: Agents attachment/store/upload/selection/phone suites **29/29** and Knowledge publication suite **9/9**. No source code changed and no live channel acceptance ran; rollout remains disabled.

Exact next action: implement K07's durable, provider-neutral source record and host-held connector grant using the current `kb_documents` authority; connect manual text/URL ingestion, preserving scope, SSRF checks, idempotency and deletion lineage. Then continue K08 freshness and other K/S/U/P/PW/EP code gaps. K05 transfer/retention semantics remain unresolved product contracts.

## Latest cross-plan checkpoint — 2026-11-16 (K05 publication lifecycle audit and ID retirement; code `890b2a55` pushed)

The owner/admin `administer` endpoint and Project Shell history view now show content-free published/updated/archive/restore/delete events. Delete writes the final receipt and a scoped tombstone atomically with row removal; the stable collection ID cannot be recreated, preventing a revision reset from reactivating old grants. Source document content is not copied into the audit ledger.

Code `890b2a55a56be746a1018016e63504f536795bab` is remote-verified (`c4234acd` implementation plus test checkpoint). Local evidence: Knowledge **120/120**, Shell API **1/1**, Knowledge/Shell typechecks, diff check, and SQLite migration/API tests including forward migration preservation and deleted-ID replay denial. Migrations 0268–0269 are unapplied; no browser/deployment/live acceptance ran. K05 remains partial for generic ownership transfer and retention-policy contract; all rollouts remain off.

Exact next action: continue K06's attachment/channel scope caller audit, starting with ordinary conversation attachment promotion and the voice/web/email/WhatsApp retrieval callers. Close any reachable path that bypasses explicit Project publication or current grant revision, with source-scope tests. Then continue other K/S/U/P/PW/EP code gaps.

## Latest cross-plan checkpoint — 2026-11-16 (K05 separate discover/source-read APIs; code `0c93eade` pushed)

Project publication discovery now returns metadata/status/count without document IDs. A separate authenticated source-membership endpoint returns indexed IDs only for the exact active Project publication revision, performs a final revision check and sets `private, no-store`. Shell reads sources only when an authorized user opens Edit and checks the revision again before populating the form. Extension use remains the separate revision-pinned owner grant.

Code `0c93eade2e3c861cd7d5ff254589c7c7ded380fc` is remote-verified. Local evidence: Knowledge **119/119**, Shell API **1/1**, Knowledge/Shell typechecks, diff check and SQLite-backed scope/archive/revision tests. K05 is still partial: archive lifecycle is pushed at `1e76c55c`; ownership transfer, retention policy and admin audit view remain incomplete. Migration 0268 is unapplied; no deployment/browser/live acceptance ran.

Exact next action: add a distinct owner/admin `administer` endpoint and Shell history view for bounded, content-free archive/restore events, scoped to the exact tenant/Space/Project/collection. Test outsider/member denial and collection isolation. Keep retention and ownership semantics unresolved where the current product contract does not decide them; continue K/S/U/P/PW/EP gaps.

## Latest cross-plan checkpoint — 2026-11-16 (K05 versioned publication archive lifecycle; code `1e76c55c` pushed)

The existing Project publication API and Shell now archive or restore a collection through owner/admin-authorized expected-revision CAS. Both transitions advance the revision and record a content-free audit event; the transition detaches source membership. Archived collections are omitted from current extension-grant resolution and rejected before/during retrieval. Restore creates an empty draft, requiring explicit source republish and new grant approval. Resource descriptors and rollouts remain disabled.

Code `1e76c55cefc32df646cc49c0166cd7ea40e65a58` is remote-verified. Full Knowledge tests **119/119**, Knowledge and Shell typechecks, diff check, and SQLite-backed migration/API coverage pass. Migration 0268 is not deployed; no browser, Worker, provider or live acceptance ran. K05 remains partial; generic ownership transfer, retention policy and separated discovery/read/admin APIs are not complete.

Exact next action: separate discovery metadata from collection source reading. Restrict the collection list to name/ID/revision/status/count, add an explicitly authorized `/:publicationId/sources` read path for document IDs, and update the Shell editor to fetch that data only when requested. Preserve the separate revision-pinned extension `use` grant. Test member, owner, outsider, archive and cross-Project behavior, then continue remaining K/S/U/P/PW/EP work.

## Latest cross-plan checkpoint — 2026-11-16 (EP02 durable Project jobs broker; code `248d3838` pushed)

EP02 now has a reachable Project/install jobs broker: the signed SDK caller and WorkflowRunDO effect receipt reach owner-grant/release validation, a D1 job ledger, scoped R2 input, owner-approved Billing reservation, and the existing Agents `AGENT_TICKS` queue. Rows pin exact tenant/Space/Project/install, requirement, manifest/resource and release digests, generation, grant revision, actor, idempotency and stable child identity. Active concurrency/rate/deadline, bounded payload, retry lease, status, revocation, unknown-start reconciliation and cleanup are implemented. A duplicate tick cannot dead-letter the final start while its lease is live. Resource descriptors remain unavailable.

Code `248d3838fbfa9314eae0ae9f854f655328c8cc06` is pushed and remote-verified. Local evidence: Agents **47/47**, SDK resource tests **44/44**, Agents/SDK typechecks, `git diff --check`, and SQLite migration/admission exercise. Migration 0267 is not deployed; no live queue, Worker, browser, provider, invoice or deployed acceptance ran. No P/PW/K/S/U requirement is thereby live-accepted; all rollouts remain off.

Exact next action: continue K05 by adding a CAS-protected archive/unarchive state to the existing Project publication collection, suppress discovery while archived, invalidate active use grants, and require an explicit new publication/approval before exposure returns. Reach it through the current owner API/Shell and test authorization, stale revision/grant, retrieval exclusion and republish. Keep generic ownership-transfer and retention-period decisions explicit. Then continue uncoded K/S/U/P/PW/EP items.

## Latest cross-plan checkpoint — 2026-11-16 (EP02 signed jobs contract and owner review; code `90088bd7` pushed)

The Agent SDK now accepts only Project-scoped `jobs` requirements with bounded `enqueue`/`status` schemas, exact signed workflow targets and a non-recursive target workflow role. The Project-owner grant API/Shell show requested targets and stage/revoke operation approvals against the exact manifest and installation generation. SpaceDO applies the existing rate/concurrency operation lease. Code `90088bd79445d4b135f63cb953137fdeaeaf7f4b` is pushed and remote-verified. Local evidence: SDK **37/37**, Spaces install/grant **33/33**, SDK/Spaces/Shell typechecks and `git diff --check`; these are local SQLite/Worker stubs.

This closes only the jobs contract and owner-review surface. Durable job rows, queue dispatch/status, retries and active-job concurrency/deadline enforcement, cleanup and unknown-outcome reconciliation are uncoded; all resource capabilities remain unavailable. No deployment, browser, provider/invoice, queue/DLQ or live acceptance ran; rollout stays disabled. No P/PW/K/S/U status changed.

Exact next action: add the durable tenant/Space/Project/install jobs ledger and authenticated Agents `AGENT_TICKS` dispatcher, binding exact manifest/resource digest, install generation, grant revision, actor and idempotency. Store a bounded payload/reference and deadline, reserve through owner-approved workflow/Billing caps, dispatch only the signed non-recursive workflow with stable start identity, persist status and reconcile queue/start uncertainty without replaying job effects. Add status caller and replay/revocation/deadline/concurrency/cleanup/quota tests; keep jobs unavailable. Then continue other uncoded S/U/P/PW/K/EP requirements.

## Latest cross-plan checkpoint — 2026-11-16 (EP02 owner-approved installation budgets; code `50566cd6` pushed)

The existing Project owner resource-review flow now configures an installation's per-run and monthly Naelao-credit limits. SpaceDO persists bounded revision history for the exact installation generation and returns only the current-generation budget in workflow snapshots. WorkflowHost treats it as authority, defaults and caps each run, pins the budget revision, and thereby revokes resumed execution when policy changes. Billing includes held and settled usage for that install in monthly conditional admission, alongside the tenant quota. The Shell offers owner controls. Code `50566cd661900917682828beea368fb135531c81` is pushed and verified. Local evidence: Spaces **39/39**, Billing **19/19**, Agents **39/39**, Shell API **1/1**, four typechecks and diff check. Migrations were exercised locally in SQLite but not deployed; no browser, invoice/provider or live acceptance ran.

EP02 remains partial: byte/storage units are unpriced by explicit product decision; the jobs adapter and other EP/K/S/U/P/PW code remain open. No P/PW or K requirement status changed. All resource descriptors and rollouts stay disabled. Exact next action: trace and implement a scoped host-managed jobs adapter with signed requirement and owner-grant checks, durable idempotency/unknown receipts, bounded enqueue/retry/deadline/concurrency, tenant/per-install Billing admission and replay/revocation/cleanup/quota tests. Keep jobs unavailable until applicable deployed acceptance.

## Previous cross-plan checkpoint — 2026-11-16 (EP02 run budget admission and resource unit metering; code `15f704fe` pushed)

WorkflowRunDO reserves one canonical workflow-step credit per in-flight vertical-extension effect against the existing run budget, including concurrent holds; it rejects missing/exhausted budgets and settlement above the effect hold. Billing's existing workflow reservation retains tenant monthly quota checks and Project/installation attribution. Resource request/byte/job units are persisted in its idempotent usage ledger by Project/installation/run. Byte units measure serialized request plus response and remain unpriced pending an approved rate.

Code `15f704feee462d75a1f07a70aea36455bf4e3373` is pushed and remote-verified. Local Agent workflow/reporting suites **27/27**, Agent and Agent SDK typechecks, and diff check pass. No migration, Billing D1 integration, deployment, browser, invoice/provider or live acceptance ran; P01–P24/PW01–PW06, K01–K30 and S/U statuses did not change. Resource descriptors/install admission and all rollouts stay disabled.

The supplied run budget is not yet a durable owner-approved per-install ceiling, no approved byte/storage price exists, and EP02 jobs remain uncoded. These are ordinary code/policy gaps, not credential blockers. Exact next action: add owner-authorized per-install budget to the existing resource grant/review path; resolve it from current SpaceDO state and enforce it through Billing, with authorization/replay/concurrency/revocation/unknown-outcome tests. Continue jobs and other open requirements afterward. Preserve untracked `infra/scripts/__pycache__/`.

## Previous cross-plan checkpoint — 2026-11-16 (EP02 versioned object archive recovery; code `326779c1` pushed)

EP02 now has bounded object runtime calls plus version-1 archive snapshot/restore for Project-bound install rows. Export validates exact signed release, manifest/resource digests, install generation and object bytes; coverage reports object count/bytes. Restore is additive only for an already-existing exact active/disabled install generation, preserves current data, respects per-install quotas and erasure tombstones, and skips stale or absent owners. Generic restore never replays object rows, owner grants or operation leases; legacy grant/lease rows are filtered. All resource descriptors and install admission remain unavailable.

Code `326779c1bc7fcab9ce7f66a2328ffe670a5b43da` is pushed and verified. Local archive export/restore and backup tests **30/30**, Spaces typecheck and diff check pass. No migration, deployment, browser, invoice/provider or live acceptance ran; all rollouts remain disabled. EP02 install-level cost admission/settlement and jobs remain code gaps, not credential blockers. Other P01–P24/PW01–PW06, K01–K30, S1–S9/U01–U12 and EP03–EP06 work remains active; Knowledge retrieval and AI Search selection did not change.

Exact next action: trace current Project/agent budget and settlement authority through `workers/agents/src/workflow-host.ts`, `WorkflowRunDO`, and the SpaceDO extension resource route; implement per-install request/byte cost admission and durable settled/unknown receipts with replay, concurrency, revocation and uncertain-outcome tests. Then implement jobs and continue independent open requirements. Keep resources and rollouts disabled; preserve `infra/scripts/__pycache__/`.

## Previous cross-plan checkpoint — 2026-11-16 (EP02 bounded Project object runtime; code `ee7390e8` pushed)

The EP02 workflow-to-SpaceDO object caller now implements fixed `get`/`put`/`delete` over separate Project/install SQLite rows. Calls require exact owner grant/revision, signed release, installation generation and active Project, use single-use leases, validate key/base64/MIME/output schemas, enforce 64 KiB/object and 64-object/512 KiB/install quotas, and clear content/grants on uninstall or release change. SDK/SpaceDO manifest and runtime checks keep every resource capability unavailable; the existing fail-closed catalog/install admission stays unchanged. `extension_resource_objects` is excluded from archive serialization while this data path lacks snapshot/recovery coverage.

Code `ee7390e861afd66bfcb14e551d8662c4dcb2f1be` is pushed and verified. Local suites: SDK **36/36**, Spaces **47/47**, Agents **14/14**; SDK/Spaces/Agents typechecks and diff check pass. Migrations 152/153 remain unapplied; no Worker deployment, browser, provider/invoice, archive/restore or live acceptance ran. Rollouts are disabled.

At this archive checkpoint, budget admission and jobs remained open; the later run-level admission/unit-metering slice is recorded above. Owner-approved per-install budget, byte/storage rate policy, jobs, and other EP/K/S/U/P/PW gaps remain. Keep resources unavailable and Cloudflare AI Search unselected.

## Previous cross-plan checkpoint — 2026-11-16 (EP02 Project object grant staging; code `82bbee1e` pushed)

The owner review status/approve/revoke caller now accepts Project-scoped object requirements with operation-only approvals and no table or object-path authority. Shell distinguishes object requests and warns that storage remains unavailable; staged approval cannot activate them. Code `82bbee1ecfb261a727c398978ea5c90135ef4731` is pushed. Latest local delta: Spaces **50/50**, Shell grant API **1/1**, Spaces/Shell typechecks and diff check. The preceding structured-data broker checkpoint `aa290198532b2c7a47878b69d7528c04ce5685e1` passed SDK **36/36**, Agents **21/21**, Router **75/75**, and the same affected typechecks. No migrations/deployment/browser/provider/live acceptance ran; resource descriptors remain unavailable.

EP02 object runtime, durable quotas/usage and install/project deletion cleanup remain code gaps; jobs and EP06 cross-resource admission/settlement also remain uncoded. K05 and K06–K30 plus S/U/P/PW work remain active; Knowledge retrieval is unchanged and AI Search remains unselected. Exact next action: build the bounded host R2 object service for exact Project/install grants with opaque namespace, fixed operations, limits, revoke fencing, deletion recovery and archive coverage; keep its catalog entry unavailable pending applicable acceptance.

## Previous cross-plan checkpoint — 2026-11-16 (EP02 owner-reviewed structured-data grants; code `aa290198` pushed)

The exact Project/install-bound owner grant ledger and reviewer caller now persist approved structured-data operations/tables, audit revisions and revocation. Workflow resource effects recheck signed install/current grant state, claim a bounded concurrent/rate lease, dispatch through the existing Gadget→MicroAppDO scope checks, and record hash/byte/outcome/metering receipts. Activation fails closed on a grant widened beyond its manifest. Code `aa290198532b2c7a47878b69d7528c04ce5685e1` is pushed. Local evidence: SDK **36/36**, Spaces **50/50**, Agents **21/21**, Router **75/75**, Shell grant API **1/1**; affected typechecks and diff check pass. No migration or deployment was run; capabilities remain unavailable and rollout remains disabled.

EP02 structured-data caller/grant code is implemented locally; object and job adapters and EP06 cross-resource admission/settlement remain uncoded. K05 and K06–K30 plus remaining S/U/P/PW work remain active; this checkpoint changes no Knowledge retrieval path, and Cloudflare AI Search remains unselected. No provider credentials block ordinary implementation. Exact next action: trace scoped R2 object lifecycle/retention and signed extension artifact paths, then implement opaque install-bound object grants and bounded read/write/delete with quota, revocation and cleanup tests; keep object capability unavailable until the applicable acceptance gates pass.

## Previous cross-plan checkpoint — 2026-11-16 (EP02 structured-data workflow bridge; code `66fdbd2e` pushed)

The typed workflow `ctx.resources.execute` now uses the durable effect journal and resolves each request against the signed manifest's structured-data declaration and exact worker-role Gadget/table/action grant. Agent dispatch reuses the authenticated scope-checked Gadget→MicroAppDO route and validates the bounded response schema. Local evidence: Agent SDK **36/36**, Agents workflow/scope/journal **31/31**, Spaces install/Gadget route **35/35**; all three typechecks and `git diff --check` pass. Commit `66fdbd2e3e8ebf295fcb8892de0c7338a86ab9a3` is pushed and remote-verified.

The bridge remains unavailable to installs: all capability descriptors stay unavailable and SpaceDO rejects resource-bearing packages. The durable owner-reviewed grant registry, installation-generation/revocation fence, and approve/status/revoke caller remain uncoded. No migration, deployment, browser/provider or live acceptance ran; rollouts remain disabled.

Exact next action: implement the structured-data owner grant ledger bound to exact tenant/Space/Project, signed manifest/resource digest, installation identity/generation, installer/reviewer and allowed operations/tables; expose authorized approve/status/revoke callers and recheck current grant plus installation/publisher status on every operation. Test duplicate writes, changed-payload key reuse, revocation races and cross-install denial. Then continue object/jobs and other EP/K/S/U/P/PW gaps.

## Latest cross-plan checkpoint — 2026-11-16 (EP02 Gadget operation receipts; code `27f571d0` pushed)

The durable WorkflowRunDO write-ahead journal now stores content-free structured-data receipts for the reachable Gadget bridge: installation/project/actor, Gadget/table/action, request hash/bytes, result hash/bytes, outcome and measured credits. Uncertain effects become `unknown` and are never replayed. Code `27f571d08ab40145b72977e48137daaa0318a3ad` is pushed. Local evidence: workflow journal/WorkflowRunDO tests **19/19**, Agent SDK and Agents typechecks, and `git diff --check`. This is run-scoped accounting, not a durable extension grant registry. No deployment/live acceptance occurred; capabilities remain unavailable.

Exact next action: persist an owner-reviewed grant bound to exact signed Project manifest requirements and installation generation; expose approve/status/revoke callers and connect `ctx.resources.execute` to existing scoped Gadget dispatch. Test duplicate writes, changed-key reuse, revocation races and cross-install denial before enabling any resource capability.

## Latest cross-plan checkpoint — 2026-11-16 (EP02 structured-data binding; code `6871563e` pushed)

The Agent SDK now requires structured-data declarations to bind to a PROJECT_BOUND Gadget and validates CRUD schemas, byte-bounded JSON envelopes, write idempotency, and exact workflow-role operation/table coverage. This reuses existing scoped MicroAppDO storage and grants; it does not widen Gadget authority. Code `6871563ea9e70019c42d98a88eabf6b3daf0707c` is pushed to `origin/Mcbt5s-Backup-2`. Local evidence: SDK **36/36**, SpaceDO install **32/32**, SDK/Spaces typechecks and `git diff --check`. No broker ledger, migration, deployment or live acceptance exists; all resource kinds remain unavailable and rollouts remain disabled.

Exact next action: add durable resource grant/operation receipts and connect the authenticated workflow Gadget route, with installer/release digest, installation generation, idempotency, revocation fencing and bounded usage receipts. Add a reachable owner/admin status/revoke caller and concurrency/replay tests. Keep capability availability off until complete; continue other EP/K/S/U/P/PW requirements afterward.

## Latest cross-plan checkpoint — 2026-11-16 (EP01 resource SDK contract; code 9abf5efa pushed)

EP01 now defines backward-compatible versioned object/structured-data/job requirements, scoped input/output schemas, host-grant shape, operation idempotency and metering units. SDK calls check active grant status/expiry and exact tenant/Space/Project/installation/principal scope, declared operation, schema, byte cap, concurrency and request-rate limits. The local harness labels all grants and handles `simulated`. The authenticated Space member catalog endpoint currently reports all three resource kinds unavailable. SpaceDO rejects any package requesting unavailable resource operations before creating the installation; a declaration or client-supplied capability cannot enable one.

Code `9abf5efa36231a96bf8e337a2fb7b702cf672954` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Local evidence: Agent SDK extension tests **35/35**, SpaceDO extension install suite **32/32**, Agent SDK and Spaces typechecks, and `git diff --check`. These cover SDK/harness behavior and local SpaceDO/SQLite admission only. No resource operation broker is active, no migration was deployed, and no provider/live acceptance ran. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

EP01 remains PARTIAL because grants are an SDK contract and no trusted host runtime issues them or dispatches operations. Exact next task: trace signed Project bundle install and workflow Gadget RPC against existing scope-specific MicroAppDO storage; implement the first persistent `structured_data` grant/operation ledger with owner review bound to the exact manifest resource request, idempotent mutations, revocation fencing and usage receipts. Keep the catalog unavailable until the complete authenticated caller uses that path. Then add object and job resource adapters and continue EP03–EP06 plus open K/S/U/P/PW requirements.

## Latest cross-plan checkpoint — 2026-11-16 (K05 revision-pinned collection authority; code cb0a63fb pushed)

K05 now versions owner-published collection membership and pins Space-shared channel grants to the approved revision. The Shell exposes revisions and warns when a changed publication pauses a grant; owner resave records the current revision. Agent host rechecks the active exact grant before every external reply, and Knowledge requires the pinned revision before ranking and before returning chunks. Source edit/removal bumps collection versions. This uses existing D1 publications and SpaceDO grants; no parallel collection store was added.

Code `cb0a63fb3f3fe2f9ad78b962323c4121f60b1496` is pushed and remote-verified. Evidence: Knowledge **117/117**, Spaces/SpaceDO **43/43**, Agents grant resolver **5/5**, four typechecks, release migration tests **20/20**, manifest validation, real-SQLite collection replacement/change/removal/revocation checks, and `git diff --check`. No D1 or SpaceDO migration/Worker deployment, browser, provider, invoice or live acceptance ran. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

K05 and EP03 remain PARTIAL for the broader collection lifecycle, generic host Knowledge SDK and complete owner authoring/test/publish/revoke/delete dashboard. EP01's SDK and fail-closed install/catalog slice is pushed at `9abf5efa` but remains partial until the host runtime issues and checks grants. EP02 is next: add the structured-data grant/operation ledger through existing scoped Gadget storage, then continue object/jobs and remaining S/U/P/PW/K gaps without treating missing code as a credential block.

## Latest cross-plan checkpoint — 2026-11-16 (K04 create idempotency; code 4f390061 pushed)

K04 is implemented locally with a required scope-bound request key, atomic request/document claim, canonical content+ACL conflict detection, retry-safe synchronous response, resumable large-upload staging and deterministic doc Workflow dispatch. Deletion fences now leave a minimal key tombstone. The extensible managed-resource plan was copied from planning commit `e950f02b` in docs commit `ea97179738bc967338cf23ac607d9721e5cb6dba`; its EP01–EP06 requirements remain active in §15. K04 code `4f390061c4bea4b032eaf3a205e76293a4f226a0` is pushed and remote-verified.

Local evidence: Knowledge **111/111**, Workflow queue **12/12**, Knowledge/Workflows/Shell/Dashboard typechecks, release migration **20/20** and release manifest **5/5** tests, migration and deployment manifest validators, SQLite migration/atomic insert smoke, and `git diff --check`. No migration/deploy, real billing, browser, provider or live acceptance. Rollouts stay disabled; preserve untracked `infra/scripts/__pycache__/`.

Exact next action: implement K05 collection authority using the existing external-publication and Project grant records; add versioned source membership and explicit rights at actual callers. Keep the Naelao owner-publication boundary, avoid a second collection store, and verify stale revision/revocation and cross-scope denial. EP01–EP06 and remaining K/S/U/P/PW gaps remain code work; AI Search is unselected.

## Extensible platform reconciliation — 2026-11-16 (source e950f02b copied)

Fetched `docs/research/extensible-platform-and-managed-resources-plan.md` from `plan/microapps-ui-sdk-voice` at `e950f02bdf0726f05db456a50ef29699e200d3b3`, copied it verbatim, and incorporated EP01–EP06 in platform plan §15. No planning branch switch or merge occurred. Reconciliation uses current source around `packages/agent-sdk/src/extensions.ts`, `workers/spaces/src/routes/dynamic-pages.ts`, Knowledge publication/search and workspace checked publication; a declaration or mock alone is not runtime capability proof.

| ID | Status | Existing implementation | Uncoded work / acceptance boundary |
| --- | --- | --- | --- |
| EP01 SDK and capability contracts | PARTIAL | Versioned resource requirements, scoped schemas, host grant/client contracts, authenticated catalog, simulated local harness and fail-closed SpaceDO admission. The latent structured-data workflow bridge is pushed in `66fdbd2e`. | No trusted owner-reviewed grant registry or reachable approval lifecycle is wired; all kinds remain unavailable. |
| EP02 host-managed resources | IN_PROGRESS | Existing scoped MicroAppDO storage and workflow Gadget route now have an SDK→durable journal→host dispatch bridge; run-scoped usage receipts are retained. | Durable owner grant ledger, installation-generation fence and approve/status/revoke caller remain uncoded. Then test duplicate/changed-key writes, revocation race and cross-install denial before adding object/jobs. Provider cost/live isolation remain separate acceptance gates. |
| EP03 custom Knowledge extensions | PARTIAL | Owner-published Project membership is revisioned; Space-shared grants pin the approved revision and Agent/Knowledge recheck it around retrieval. K01–K30 cover core Knowledge authority. | General parser/chunker/index/retrieval SDK, lifecycle dashboard/test/publish/revoke/delete example, retention/version APIs and provider revocation lifecycle remain uncoded. Build on EP01 and preserve ACL/tombstone authority. |
| EP04 AI/developer authoring | PARTIAL | Planner/worker isolated workspace, manifest validation, checked publication, extension install grants and owner-published settings exist. | End-to-end scoped resource proposal, immutable preview/provenance, grant and cost review, signed installation, versioned upgrade/migration and recovery workflow remain incomplete; deployed runtime isolation is unaccepted. |
| EP05 websites | PARTIAL | `dynamic-pages.ts` supplies a 1 MiB bounded publish/render/action route with owner/admin publish authorization, HMAC-protected management path, separate suffix checks, public host/origin validation and runtime leases. | This is not general static/dynamic hosting. Domain ownership/TLS/provider adapters, public-catalog authorization, abuse/takedown and deployed isolation/acceptance are open. Missing suffix configuration keeps page routes unavailable. |
| EP06 billing/safety/operations | PARTIAL | Existing payer/usage/entitlement systems, managed-service receipts, scoped lifecycle controls and audit surfaces are reused. | Cross-resource quotes/reservations, installation-level attribution/caps, inventory/dependency UI, provider outcome reconciliation and complete cleanup/export/uninstall acceptance remain. Live invoice/runtime/deployment checks are external gates only after code is complete. |

Cloudflare AI Search is not selected. K15/K16 remain its dedicated comparison: current Vectorize plus D1 FTS stays authoritative while user/role ACL filtering, update/delete lifecycle, quality, scale and total invoice cost lack accepted proof. Keep it and all new resource/site rollouts disabled. This is a source reconciliation, not live or deployed acceptance.

The K04 checkpoint is pushed at `4f390061`; K05's revision-pinned publication/grant slice is pushed at `cb0a63fb`; EP01's resource SDK contract is pushed at `9abf5efa`. K05 and EP01 remain partial. Exact next action is the EP02 structured-data grant/operation ledger using existing scoped Gadget storage and callers. Preserve `infra/scripts/__pycache__/`, keep rollouts off, and fetch before pushes.

## Latest cross-plan checkpoint — 2026-11-15 (K02/K03 PDF preview and provenance; code 08d9c509 pushed)

The builder Dashboard, Space-wide Shell and Project-private Shell now expose scope-bounded PDF preview/correction through the existing parser. A 15-minute signed receipt binds exact bytes, parser/extraction and tenant/Space/Project; the Knowledge Worker persists raw source and approved extraction hashes. Archive export/restore carries the lineage and checks raw source bytes. Migration 0263 is reflected in both release manifests without deploying or applying it.

Code `08d9c509a9ab2a9b8e66e4fa4707bc1d2e442324` is pushed and verified on `origin/Mcbt5s-Backup-2`. Local evidence: Knowledge Worker **104/104**, Shell helper **3/3**, Knowledge/Shell/Dashboard typechecks, migration DDL check, release/deployment validators, release migration tests **39/39**, and diff check. No browser, live parser, D1/Worker deployment, invoice, provider or production acceptance. Rollouts stay disabled; preserve `infra/scripts/__pycache__/`.

Exact next action: close K04 create idempotency for lost responses across sync and queued Knowledge ingestion. Persist a scope-bound request key and canonical request hash; exact retries return the existing lifecycle state, while changed content/ACL under the same key conflicts. Test concurrent/retried creation and ensure no duplicate parsing, index writes or usage reports; retain deletion fencing. Then resume remaining S/U/P/PW/K code gaps.

## Previous cross-plan checkpoint — 2026-11-15 (PW06 durable worker cancellation fences; code 79d671a3 pushed)

Worker rows now fence integration and terminal writes using the current durable `status` and monotonic `attempt`. Late child successes/failures cannot start a checked merge or overwrite `terminated`. Signed worker session callbacks include the attempt and return conflict after termination or retry supersession. The automatic validation lifecycle rechecks active state before branch operations, validation, receipts and expected-head publication.

Local evidence: delegated admission plus checked integration **20/20**, Agents typecheck, `git diff --check`. Code `79d671a329b056c3cd2e861aeabb3996e488de9d` is pushed and verified on `origin/Mcbt5s-Backup-2`. This is local Worker/fake-SQL evidence, not deployed cancellation acceptance. A publication already accepted at the Artifact Worker/Workspace Coordinator commit boundary may still complete after parent termination; PW06 requires a clarified or fenced cross-DO lifecycle. Real runtime isolation, compute/currency settlement, revocation, and deployed concurrency/recovery acceptance remain open. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

Exact next action: close K02/K03's reachable PDF ingest-preview gap in both Space-wide and Project-private Knowledge forms. Inspect the current parser endpoint and upload callers; add a file-hash-bound preview/correction step with bounded extraction warnings while retaining scope-specific upload limits, then add caller/API tests. Continue the open P01–P24/S/U/PW/K gaps afterward.

## Previous cross-plan checkpoint — 2026-11-15 (K01/K11 implementation and K20 cache containment; 1041cd0 pushed)

The mature Knowledge plan from `plan/microapps-ui-sdk-voice` commit `9358830e` is copied into this branch, incorporated in platform plan §14 and tracked as K01–K30 in `mature-knowledge-platform-implementation-progress.md`. The current code aligns Space/Project UTF-8 upload ceilings with the backend, adds independent scope-filtered D1 FTS5 candidates to Vectorize/RRF search, and disables full assistant-response cache reads/writes until caller scope and source/grant freshness are safe. Cloudflare AI Search was evaluated from current official docs; no adapter/provider selection or rollout was made.

Local evidence: Knowledge Worker full suite **95/95**, Knowledge/Agents/Shell typechecks, upload-limit helper **3/3**, Cloudflare filtering/hybrid/multitenancy/data-source/pricing documentation review, SQLite FTS5 syntax check, worker config parse (all new cache gates false in dev/staging/prod), and `git diff --check`. No deployed D1/Worker, browser, provider, carrier, invoice or live acceptance. All rollout flags remain off.

Code `1041cd0ffe58b212d11329a9ea0f4d155c4d3780` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`.

This checkpoint's next action was completed in code `79d671a3`; continue K02/K03 above. Other P01–P24/S/U/PW/K gaps remain open.

## Previous checkpoint — 2026-11-15 (PW06 integrated-validation telemetry; code 276aa6a9 pushed)

Automatic worker validation now records privacy-safe fixed outcome/status categories, bounded duration and count only. Analytics writes run after the durable receipt is saved and are best-effort; an exception cannot change publication. Local validation suite **11/11**, Agents typecheck and diff hygiene pass; the tests cover exact dimensions, bounds and failure isolation. Code `276aa6a908e7e6521b8adccde56e52736082ac8c` is pushed and remote-verified. Voice fixes remain pushed at `75fc1b877fd99481e0bee67d22780201699e6d26` and `8233788bc1656bac2ca9cf914e91da198d8f3780`; no deployed/provider/carrier acceptance ran.

The current caller trace identifies a concrete PW06 code gap: after `terminateSubAgent` stores `terminated`, a late `spawnSubAgentBatch` response can still merge its worker branch and overwrite terminal status. Exact next action: gate worker merge/validation on the durable non-terminated worker state, preserve cancellation in completion writes, and cover late success/failure and cancellation during validation. Continue the other uncoded S3–S9/U01–U12/P01–P24 requirements. Keep rollout flags disabled.

## Previous checkpoint — 2026-11-15 (P06 voice interruption and PW06 telemetry; code 8233788b pushed)

PW06 Coordinator merge telemetry now records only bounded events, outcomes and fixed conflict categories; tests verify label privacy and Analytics failure isolation. P06 owner-call TTS forwards abort to provider startup and cancels an in-flight read. Public Telnyx extension barge-in now discards buffered PCM after the clear event and suppresses intentional cancellation errors so caller interruption does not end the call.

Local evidence: Coordinator telemetry **82/82** and Agents typecheck at `448196a36e985e05e919d62df43c3ac00c013b06`; extension voice runtime **6/6**, Telnyx call routing **8/8**, TTS **4/4**, Agents typecheck and `git diff --check` at `8233788bc1656bac2ca9cf914e91da198d8f3780`. A combined concurrent test invocation timed out one 3-second wait; the full affected suite passed in isolation. Local Worker/SQLite and mocked-provider checks only; no deployed, carrier or billing acceptance. Both commits are pushed and remote-verified. Rollouts stay disabled; preserve `infra/scripts/__pycache__/`.

P06 remains PARTIAL for signed extension distribution, managed provisioning, full cost/quality evidence and live carrier acceptance. PW06 remains PARTIAL for validation outcome metrics, cancellation/revocation, per-run currency/compute settlement, runtime isolation and deployed concurrency/recovery acceptance.

Exact next action: add privacy-safe fixed-label telemetry for automatic integrated worker validation outcomes and duration, with a test proving Analytics failure cannot alter durable receipts or publication. Then continue remaining uncoded S3–S9/U01–U12/P01–P24 requirements.

## Previous checkpoint — 2026-11-15 (PW04 bounded large exact-copy review; code 89cb0a8f pushed)

Manual conflict review retains a 256 KiB rendered-text/reviewer-authored-text bound and supports exact server-side copies up to 2 MiB per file and per review set. Large objects remain hash-only in Shell. Before the checked Coordinator stages a copy, Agents reads the scoped immutable R2 object, checks its exact size and SHA-256 against the current branch manifest, and fails without publication on mismatch or unavailability. A local 2 MiB copy exercises the exact upper bound; Coordinator's existing body parser caps requests at 30 MiB, substantially above this encoded payload. These checks do not establish real Worker memory/body or deployed runtime acceptance.

Local evidence: Agents Coordinator/manual-resolution/route suites **108/108**, Shell API tests **3/3**, Agents and Shell typechecks, and `git diff --check`. Local Workers/SQLite and mocked route bindings only; no real Worker, browser, deployed or live acceptance. Code `89cb0a8fb18699466fd8845d5d6b8bbe3d7bf5d8` is pushed and remote-verified at `origin/Mcbt5s-Backup-2`. Planner/worker plan commit `45575a395df9571eb075f0a479c65144e767be7c` is incorporated into platform §12 and managed §20 as PW01–PW06. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

PW04 remains PARTIAL for >2 MiB and unavailable/corrupt artifacts, ambiguous/content-edited rename identity, full route/runtime integration coverage and deployed acceptance. Exact next action: implement PW06's bounded Coordinator merge telemetry for validated attempts, final published/noop/conflicted outcomes and finite conflict categories. Do not include tenant/Space/Project, actor, paths or contents in labels; telemetry failures must not alter checked publication. Add local tests for labels, counts and Analytics failure, then continue independent S3–S9/U01–U12/P01–P24 gaps. U05/U06 remain unsupported runtime-contract gates.
## Latest checkpoint — 2026-11-15 (P03 builder/platform private inbox; code c40d0421)

The signed Dashboard caller now lists and marks only the current platform user's `PLATFORM_DB.notifications` rows, scoped by both JWT tenant and subject. Router rejects Product-user and agent identities, returns bounded keyset-paginated data without action URLs, uses `private, no-store`, and hides cross-user/tenant IDs behind the same not-found result. The Dashboard provides unread/all filtering, load-older, and retryable mark-read behavior. This platform inbox remains separate from ProductUserDO and SpaceDO notifications.

Local verification: Router inbox/helper and route tests **7/7**, Router typecheck, Dashboard typecheck, and `git diff --check`. Tests use local SQLite and signed test JWTs; no browser, deployed database, provider or live acceptance ran. Code `c40d0421` is the recovery checkpoint to push to `origin/Mcbt5s-Backup-2`; verify the fetched remote before pushing. Preserve untracked `infra/scripts/__pycache__/` and keep all rollouts disabled.

P03 remains PARTIAL for grace/restriction/escalation and retry-cadence policy and deployed/provider delivery acceptance. U05's proposed candidate allocation does not fit the current source: the project-main Container registry and Cloudflare Computer live-mount verifier have different allocation, image, reservation and observation authorities. No trusted bridge exists; do not fabricate a candidate or attestation. U06's authenticated writer/drain/flush/reconnect/handoff contract is unsupported.

Exact next action after pushing this checkpoint: continue P05 §11.5 by reconciling the installed Shell's signed MicroApp Canvas/dashboard path against current host-owned typed business-action APIs. Implement the next real authorized caller gap, keep synthetic fixtures out of embedded frames, and add caller authorization/failure coverage. Then continue remaining independent S3–S9/U01–U12/P01–P24 gaps without repeating closed audits.

## Latest checkpoint — 2026-11-15 (PW04 automatic integrated-candidate validation; code e73c1289 pushed)

`mergeWorkerWorkspace()` now merges to a task-scoped candidate instead of publishing the worker branch directly. The worker's immutable Coordinator fork base is captured at reservation (legacy branches recover it only from their immutable Coordinator base and recorded root). Candidate and operation identities bind the pinned target and source Git/Coordinator heads, so a changed target gets a fresh candidate on a later attempt. The project-owned root contract is `naelao-worker-validation.json`, schema version 1 with a bounded existing package test command; it is read from the pinned target, and candidate changes to that contract require review. An exact candidate is forked to a separate `race/` validation branch, admitted through current Code/Tier 6 gates, and run under a deterministic execution ID and durable journal. Source, target, candidate, validation branch and validator contract are rechecked before a checked Repository merge with expected Git and Coordinator heads. Failed, uncertain, stale or workspace-mutating validation never publishes. Interrupted publication is confirmed only when the exact candidate is at target; a moved target with an ambiguous result is recorded uncertain. Original worker output and branches remain available.

Local evidence: Agents integration/report suites **11/11**, Artifact Repository **15/15**, Shell result parser **4/4**; Agents, Artifact and Shell TypeScript checks; `git diff --check`. These are unit/Worker mocks and static checks. No real ToolSandbox execution, deployed Worker, browser, concurrency drill or live provider acceptance ran. Code `e73c1289d9265591c6b7348f3e8cd4dfacfa4532` is pushed and verified at `origin/Mcbt5s-Backup-2`. Rollout flags remain disabled; preserve untracked `infra/scripts/__pycache__/`.

PW04/PW06 remain PARTIAL: paired rename/edit and files above the bounded manual binary limit still require supported review workflows; worker cancellation/revocation, actual compute/currency settlement, runtime isolation proof, observability and deployed planner/worker concurrency/recovery acceptance remain open. These are uncoded work or separate live gates, not credential-only blockers.

Exact next action: continue S3/U05 by implementing the missing product-side Cloudflare candidate allocation/reservation caller against the existing owner-authorized runtime lifecycle. Bind each durable unqualified candidate to exact tenant/Space/Project, current main allocation generation, selected template/image digest, current authorization and budget reservation; reject caller-fabricated trusted observations and cover stale/concurrent allocation and retry. Then continue S3–S9/U01–U12/P01–P24 in dependency order.

## Previous checkpoint — 2026-11-15 (PW04 bounded binary resolution; code bac46733 pushed)

The reachable Shell conflict editor can preserve exact target or worker bytes for verified unsupported-text/binary objects up to 256 KiB without exposing bytes to Shell. Agents binds side/hash into idempotency, rechecks scoped R2 bytes and stages through the checked Coordinator; paired path-collision resolution stays atomic. Durable receipts and Shell summaries record copied paths, sides and hashes. Oversized, unavailable and corrupt objects remain blocked. Code `bac4673352c18ee631068069a6484a73226992c3` is pushed and verified at `origin/Mcbt5s-Backup-2`.

Local evidence: Agents manual-resolution/Coordinator/route tests **97/97**, Shell API/result parser **6/6**, Agents/Shell typechecks and `git diff --check`. Coordinator integration checks prove exact binary bytes, paired deletion atomicity and replay. The route harness still mocks the Coordinator adapter; no browser, real ToolSandbox, deployed Worker or live acceptance. Route recovery remains covered at `d3ad78b1`; paired path resolution at `80cc4e83`.

PW04 remains PARTIAL: objects over 256 KiB, unavailable/corrupt objects, rename/edit handling, and semantic API/schema checks need separate supported paths. Crucially, `NaelaoAgentDO.mergeWorkerWorkspace()` calls Artifact Repository merge directly into its target without a pinned integrated-check receipt; this remains uncoded work. PW06 deployed/runtime acceptance, per-run cost settlement and runtime isolation are also open. These are code or live-acceptance gates, not credential blockers. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

This checkpoint's next action was completed in code `e73c1289`; see the latest checkpoint above. Remaining PW04/PW06 acceptance and the next S3/U05 implementation are recorded there.

## Previous checkpoint — 2026-11-15 (PW05 worker review status; code cb485279 pushed)

The Shell worker activity view exposes the logical workspace branch, model-token use against the allocated token budget, attempt number, and worker-reported changed paths. The conflict panel explicitly says that integrated tests have no receipt, and labels path reports as unverified. It does not claim runtime isolation or currency cost. Local verification: worker-merge-result **3/3**, Shell typecheck, and `git diff --check`. Code `cb4852791e1129b7fbc5c869f5ee49b1e0678f73` is pushed and `ls-remote` verified on `origin/Mcbt5s-Backup-2`; no deployed/runtime acceptance. Preserve `infra/scripts/__pycache__/`; rollouts remain disabled.

PW04 runner trace: Tier 6 accepts branch scope, but only `race/` gets a separate project ToolSandbox identity; manual-resolution branches use the shared project sandbox. The existing race oracle is not connected to manual review and does not persist an exact-revision validation receipt. To validate safely, the resolver needs an exact coordinator manifest fork under an isolated runtime, current Code grant/budget admission, a bounded project-owned test command, deterministic execution identity, and durable passed/failed/uncertain receipt handling before checked merge. This is an uncoded implementation gap, not a credentials blocker.

PW04/PW05 remain PARTIAL: binary/oversized and paired-path review, isolated exact-revision integrated validation, runtime/resource isolation proof, cancellation/revocation, actual cost receipts and deployed acceptance remain. Exact next action: implement validation on a coordinator-pinned `race/` fork, add deterministic Tier 6 execution replay support and a durable receipt, and prevent canonical merge on failed or uncertain validation. Add focused route, retry, stale-head and runtime-identity checks; keep rollout disabled.

## Continuation checkpoint — 2026-11-15 (PW04 checked manual resolution; code 4d33cf29 pushed)

The full requirements from `docs/research/planner-worker-isolation-and-conflict-resolution-plan.md` at `45575a395df9571eb075f0a479c65144e767be7c` are incorporated in platform §12 and managed plan §20 and tracked as PW01–PW06. The source branch is fetched at that exact commit; it was not checked out or merged.

PW04 now provides reviewer-authored UTF-8 text and deletion resolution through a deterministic retained branch and checked Coordinator publication. Shell previews current target and retained worker versions, disables publication when either recorded hash is stale or either existing file cannot be safely previewed as text, and shows a before/after resolution view. Public routes are product-session reachable through a narrow Router pattern; Agents rechecks current Project access before branch/checkpoint/merge mutations, binds both source and target conflict hashes, rejects mismatched idempotency reuse, keeps the original worker branch, and records bounded completion receipts. A retry after Coordinator publication can recover from the deterministic review branch and receipt.

Local evidence: WorkspaceCoordinator/manual preview **72/72**, Agents typecheck; Shell conflict/API **5/5** and typecheck; Router route patterns **74/74** and typecheck; `git diff --check`. Code SHA `4d33cf29f2b54be0416a0e2219fce4af9594be33` is pushed and `ls-remote` verified at `origin/Mcbt5s-Backup-2`. These are local mocks/typechecks only; no deployed, runtime, or live acceptance. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

PW04 remains PARTIAL: paired rename/path conflicts and binary/oversized/unsupported-text resolution need separate workflows; integrated semantic tests tied to an exact reviewed revision are not wired; runtime isolation, cancellation/revocation, costs and deployed concurrency acceptance remain open. These are code/contract or live-acceptance gaps, not credential blockers. Exact next action: trace current project test execution and workspace branch mounting, then implement an authorized validation receipt tied to the exact reviewer branch revision before canonical publication where a supported runner exists. If no safe runner can validate that branch, record the precise runtime contract and continue PW05/PW06's independent code gaps.

## Planner/worker requirement reconciliation (PW01–PW06)

| ID | Status | Reconciled current implementation | Remaining code or acceptance gap |
| --- | --- | --- | --- |
| PW01 branch lifecycle | PARTIAL | `NaelaoAgentDO` persists task/worker branch identities and manifest base revision/hash; `RepositoryDO` creates coordinator-backed worker branches; replay checks branch parent; durable goal dispatch records attempts/outcomes; failed worker results do not merge. Existing local evidence: unified-platform ledger reports coordinator/delegation **26 passed**, Artifact **20 passed**, and affected typechecks. | Branch identity in a logical workspace does not by itself prove a separate process/filesystem; branch retention, cancellation/revocation, erasure and actual runtime branch mount need the current caller acceptance matrix. Deployed worker/runtime lifecycle remains untested. |
| PW02 task graph and communication | PARTIAL | Goal DAG records dependencies, assigned role, file paths, context affinity, resource keys, budget and verification state. `TaskDO` persists a bounded coordination summary. `task-blackboard` uses a goal-bound DO store, signed delegation scope and host-granted directed recipient edges; messages are untrusted and idempotent. | Ownership/interface decisions, help/conflict/result receipts and user-visible worker progress must be reconciled caller by caller; advisory file/path hints do not enforce access. Recheck revocation and private project disclosure in all UI/API readers. |
| PW03 selective resource leases | PARTIAL | `ConcurrencyDO` provides bounded named leases with fencing; Agents lock gateway fails closed without the binding. WorkspaceCoordinator checks expected hashes, sessions, generations and fences; migration mutation barriers serialize legacy writers. | Named locks are cooperative and are not a mandatory global path lock. Identify each shared mutable resource and enforce any mandatory lease at its authoritative writer; avoid unnecessary global serialization. Deployed expiry/stale-holder acceptance remains open. |
| PW04 integration and conflict resolution | PARTIAL | `RepositoryDO` and `WorkspaceCoordinatorDO` merge eligible disjoint same-file line edits using bounded `bounded-lcs-lines-v1`; checked receipts bind source/target revisions and hashes. Shell supports paired path-collision and rename/edit review. Text display/reviewer input is capped at 256 KiB; exact backend-only side copies are hash-checked up to 2 MiB per file and review set, with a local upper-bound test. Exact-content rename candidates are hints only; generic delete/edit conflicts allow reviewer-selected second paths displayed with both versions and published in one hash-pinned checked change set. Automatic worker merge validates an exact task-scoped candidate using target-owned `naelao-worker-validation.json`, a separate `race/` validation branch, immutable source-base pin, deterministic receipt, head/contract rechecks and expected Git/Coordinator publication heads. | >2 MiB and unavailable/corrupt object handling, ambiguous/content-edited rename identity, complete route/runtime integration coverage, and deployed acceptance remain. Failed, uncertain and stale validation leave canonical target unchanged. |
| PW05 runtime, cost and UI | PARTIAL | Shell shows logical branch, model-token use versus allocated budget, attempt, worker-reported paths and manual/automatic validation receipts with tested branch and target identities. Automatic validation uses a branch-scoped Tier 6 runtime path. | No actual currency/compute usage receipt or per-run reservation/settlement is wired. Do not infer process/package/cache/port isolation from branch naming. Real runtime identity and canonical-write isolation, cancellation/revocation, recovery UI and deployed acceptance remain. |
| PW06 validation and operations | PARTIAL | Manual and automatic integration bind checks/receipts to exact retained revisions; automatic outcomes use fixed-label best-effort metrics. Durable worker status and signed callback attempt now fence late results and completion writes; local cancellation/integration suites **20/20**. | A publication already accepted by Artifact Worker/Workspace Coordinator may complete after parent termination; define or implement an authoritative cross-DO cancellation fence. Real Container isolation, per-run currency/compute settlement, broader revocation and deployed concurrency/recovery acceptance remain open. |

The focused local evidence above is a fresh run; the broader matrix remains a source reconciliation. The task plan is not credentials-blocked: paired-path review and route-level tests are ordinary implementation. Real Container/FUSE/runtime behavior, deployment and actual provider acceptance remain separate external gates.

## Continuation checkpoint — 2026-11-15 (P03 exact Product-user inbox; code 9a46241f)

Billing dunning now queues a stable generic private in-app notice for the exact active Product-user; verified email remains a separate optional delivery. Notifications rechecks tenant/product/user/current subscription/provider event version, then routes under tenant HMAC to Spaces. ProductUserDO provides bounded persistent inbox pagination and read state; export and account erasure include the notices. Product-user API derives the exact actor from claims, Router exposes only the exact inbox path, and Shell Personal settings lists and marks notices read.

Local verification: Spaces/ProductUserDO inbox, auth, export and erasure **20/20**; Notifications queue/SQL **2/2**; Workflow recovery **3/3**; Router path patterns **71/71**; Shell API client **3/3**; five affected package typechecks; Wrangler dry runs in default/staging/production; Wrangler variable parity **82/82**; `git diff --check`. These are local mocks/typechecks/config dry runs only. The broader existing binding-parity suite failed 8 unrelated resource/queue expectations (127/135 passed); the repository isolation validator retains the documented shared IDs/unresolved `naelao-calls`. The new service binding resolves distinctly in all three environments. Code SHA `9a46241f` and docs checkpoint `cacfa17d` are pushed and verified at `origin/Mcbt5s-Backup-2`. Rollout remains disabled; preserve `infra/scripts/__pycache__/`.

P03 remains PARTIAL: migration `0010_notifications.sql` already provides `notifications.read_at`, but the builder/platform notification table has no reachable exact-user API/caller. Grace/restriction/escalation and retry cadence remain product decisions; provider and deployed acceptance are untested. P04’s Shell download caller (`c1eb6c4e`) and P03 inbox code (`9a46241f`) are pushed and verified through docs checkpoint `21e7763e`. Fish Live 3, business MicroApp, UI SDK and voice additions remain in sections 9 and 11; planner/worker requirements from `45575a39` are now copied into section 12.

Exact next action: trace the builder/platform notification table through its authenticated identity, Router, and existing Dashboard notification UI. Implement exact-user private read/mark-read routes and a caller only if current authorization proves the `user_id` scope; otherwise record the specific missing identity/route contract and move to the next uncoded P05 guided-template requirement. Continue remaining P05–P24 and S3–S9/U01–U12 gaps.

## Continuation checkpoint — 2026-11-15 (P04 authenticated data download; code c1eb6c4e)

Product-user Personal settings now expose the existing bounded portability export as a private JSON download. The Shell client uses the exact product scope and authenticated Product-user session with browser caching disabled. It reports 413 as a complete refusal (no partial export), handles expired/unauthorized sessions, and performs no server-side account mutation.

Verification: focused Shell client tests **2/2**, Shell TypeScript check, and `git diff --check` pass through installed local binaries. Pinned pnpm 9.12.0 was unavailable; installed pnpm 11.25.0 attempted to replace `node_modules` before running, so it was not allowed to proceed. No dependency tree changed. Local checks do not establish deployed or browser acceptance. Code commit `c1eb6c4e` is pushed with `9a46241f` and this record.

Plan source confirmation: fetched all advertised origin heads; `origin/plan/microapps-ui-sdk-voice` remains at `df3386257262a88888d647daa4d10f3af2ff9596`. The source additions are already in sections 9 and 11 of the active plan. No merge occurred.

P04 remains PARTIAL for other service/provider/inbound stores, unsupported identity/reinstall contracts, retention/key/jurisdiction policy, cross-service consistency, isolated recovery and measured/deployed RPO/RTO. Exact next action: trace the P03 Billing/Notifications dunning path into the existing Product-user inbox and implement the missing authenticated, exact-user in-app delivery only where a supported notification contract exists; include persistence, export/erasure and retry/failure coverage. Keep grace/restriction/escalation policy unresolved pending its product decision.

## Continuation checkpoint — 2026-11-15 (P04 exact-user purchase history; pushed 1bbe8ab66479c2f2960cfbbd854f89eaa1a57e0d)

The authenticated Product-user export now includes a bounded purchase-history summary from Billing's immutable `product_user_plan` receipts. Billing scopes rows to the active tenant/product and exact end user, returns only provider, tier, amount/currency and timestamp, and reports when more than ten exist. Spaces validates the strict shape and returns 413 rather than silently exporting truncated history. No provider event/subscription/variant IDs, customer IDs or raw receipt is exposed.

Verification: Billing tests **5/5**, Billing typecheck; Spaces export tests **13/13**, Spaces typecheck and `git diff --check`. Local Worker mocks only; no deployment or live Billing/provider acceptance. Code `1bbe8ab66479c2f2960cfbbd854f89eaa1a57e0d` is pushed and remote-verified. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

P17 trace: product-user sessions and builder sessions have separate issuers and identities. Product-user sessions carry end-user `sub`, tenant and `product_end_user` role; builder JWTs carry platform-user `sub`, organization and email. There is no persisted cross-issuer identity link or handoff authority. Do not infer identity from matching email or browser state. Marketplace-to-Shell SSO remains a product/identity contract gate, not a credential blocker.

P04 remains PARTIAL for other service/provider stores, retention/key/jurisdiction choices, cross-service consistency, isolated recovery, and measured/deployed RPO/RTO. The Fish Live 3, business MicroApp, UI SDK and voice plan text remains copied into active platform-plan sections 9 and 11; no source branch merge occurred. U05/U06 retain their incompatible/unsupported runtime contracts.

Exact next action: continue P05 §11.5 with one real signed MicroApp Canvas dashboard path in the installed Shell view, using existing scoped host business-action/settings APIs. Keep synthetic fixtures out of embedded frames and add authorization/failure coverage through the actual caller. Continue S3–S9/U01–U12 and P01–P24 afterward without repeating closed audits.

## Previous checkpoint — 2026-11-15 (P04 exact-user chat portability; pushed b91a07953d33918c526307635d0412c72f6ff9e2)

Product-user export v3 now includes exact-user chat sessions/messages from each related Product Space alongside existing profile, ProductUserDO, Billing and bounded signed MicroApp snapshots. SpaceDO enforces tenant HMAC and exact user/Space/tenant scope; the route rejects malformed, unavailable or oversized responses rather than returning partial chat data. Limits are 1,000 sessions, 2,000 messages and 4 MiB per Space, plus 16 MiB across the Product. The bounded-response helper starts cancellation asynchronously after detecting an oversized response so a source cannot hang the export.

Verification: Spaces route and direct SpaceDO suites **15/15**, Spaces typecheck, bounded-response suite **7/7**, HTTP typecheck and `git diff --check`. This is local Worker/SQLite evidence only; no deployment, live provider or recovery acceptance. Code `b91a07953d33918c526307635d0412c72f6ff9e2` is pushed and remote-verified. Rollouts remain disabled; preserve `infra/scripts/__pycache__/`.

The active platform plan retains the copied Fish Live 3, business MicroApp, UI SDK and voice text from `origin/plan/microapps-ui-sdk-voice`; there is no branch merge. P04 remains partial for other service/provider stores, retention/key/jurisdiction decisions, cross-service point-in-time consistency, isolated recovery and measured/deployed RPO/RTO. `PROJECT_USER` and same-identity app reinstall lack supported contracts. U05's Container-to-Computer trusted-observation bridge is uncoded and is not a credentials-only blocker; U06 remains unsupported.

Exact next action: trace P17 Marketplace-to-Shell identity handoff from listing/purchase claims to product-session issuance. Implement a short-lived single-use listing-bound handoff only if current authorities establish the same account; otherwise record the precise identity contract gap and move to an independent uncoded requirement. Continue S3–S9/U01–U12 and P01–P24 without repeating completed audits.

## Previous checkpoint — 2026-11-15 (S2 UserPort owner-link unlink recovery; code 70c2e2d34daa99f254c598234885b0332629460b)

The S2 UserPort↔AgentPort caller now completes cleanup of independently persisted account IDs even when a related held sync journal is malformed. It preserves that operation as blocked for review, reports `cleanupBlocked` and `cleanupPending`, and continues recoverable cleanup without replaying the malformed request. Focused lifecycle/route suite **17/17**, Agents typecheck, and diff hygiene pass. Local mocks only; no live AgentPort or deployed acceptance. S2 remains local-only for supported lanes.

The previously recorded U05 candidate allocation/reservation path is superseded by the current runtime evidence: project-main uses a Cloudflare Container allocation, while the verifier requires a distinct Cloudflare Computer live mount, immutable template/image, managed-service credit hold and trusted runtime observation. No producer binds those identities. Do not create a fabricated candidate or observation; U06 remains unsupported.

## Continuation checkpoint — 2026-11-15 (P04 product-user billing portability; pushed 2bec4bc861c33e0f272b9c5f11ed79120e12ccf2)

The authenticated Product-user export now carries a bounded summary of subscription, dunning outcomes, and dispatch states from Billing. Spaces sends the exact session-derived product/user pair under tenant HMAC, validates an allowlisted response capped at 16 KiB and ten rows per list, and refuses partial exports if Billing is unavailable, failing, malformed, or excessive. Exports are `private, no-store`; provider subscription IDs, recipient addresses, and provider receipt IDs stay private. Existing default/staging/production Billing bindings are wired.

Verification: Spaces product-user route **11/11**, Spaces typecheck, and `git diff --check`; mocked local evidence only. No deploy or live Billing/provider acceptance. Code SHA `2bec4bc861c33e0f272b9c5f11ed79120e12ccf2` is pushed and remote-verified. Rollouts remain disabled; preserve `infra/scripts/__pycache__/`.

Source-plan reconciliation: `origin/plan/microapps-ui-sdk-voice` at `df3386257262a88888d647daa4d10f3af2ff9596` changes only this platform plan. Its 70 new lines are already copied into sections 9 and 11; no uncopied microapp, UI SDK, or voice requirement remains. The active P04 recovery row is intentionally newer; no merge or duplicate appendix was added.

P04 remains partial for other stores, retention/key/jurisdiction decisions, cross-service consistency, isolated recovery, and measured/deployed RPO/RTO. Exact next action: resume S2/MS01/MS02 at `workers/agents/src/communications/userport-agentport-sync.ts`; inspect alias/owner-link disconnect, reauthorization, and scheduled cleanup, then implement the next reachable sync/revoke/relink gap with failure/replay coverage.

## Continuation checkpoint — 2026-11-15 (S2 expired UserPort operation recovery; pushed 317c6c8cbce6dbc3e29903b139a98e207d63c11b)

Code `317c6c8cbce6dbc3e29903b139a98e207d63c11b` is pushed and remote-verified. The scheduled
UserPort↔AgentPort reconciler recovers expired running connector sync/revoke leases through existing
exact-scope recovery checks. AgentPort internal requests have a 10-second timeout; migration 0262
indexes expired operation leases; the combined scheduler limit is covered. Focused UserPort tests
**16/16**, Agents typecheck, release inventory **262**, release validator tests **5/5**, and
`git diff --check` pass. Evidence is local Worker/D1/AgentPort mocks only; no live or deployed
acceptance. Rollouts remain disabled. Preserve untracked `infra/scripts/__pycache__/`.

S2 supported lanes remain IMPLEMENTED_LOCAL with provider and commercial gates open. Continue the
platform dependency order at P03: inspect current dunning/payment producers, consumers, entitlement,
notification and operator recovery callers against P03/P12, then implement a reachable independent
gap and test retries/failures. P01/P02 source code audits are complete; operator resource/baseline and
deployed acceptance evidence remains external. Then continue other S3–S9/U01–U12 and P03–P24 gaps.

## Continuation checkpoint — 2026-11-15 (P04 ProductUserDO notification store; pushed 7c765c219406adb455156e3364e4b40451f44572)

Code `7c765c219406adb455156e3364e4b40451f44572` is pushed and remote-verified. ProductUserDO
portability export v2 includes its persisted notification queue; account erasure deletes that queue and
reports a count. The account route now holds the D1 erasure marker and PII until ProductUserDO returns
a successful, valid cleanup receipt, preventing a provider error response from being ignored.
Verification: ProductUserDO/account-route/MicroApp erasure suites **17/17**, Spaces typecheck and
`git diff --check`. Local mocks/SQLite only; no deployment or live acceptance.

Preceding pushed code `a4958c70` adds durable authenticated per-app user uninstall, retry, archive
fencing, actor erasure before install removal and owner-install preservation. Same-identity reinstall
remains unsupported under the current actor key contract. `origin/plan/microapps-ui-sdk-voice`
(`df3386257262a88888d647daa4d10f3af2ff9596`) has no uncopied plan requirements; its microapp/UI
SDK/voice sections are already copied into sections 9 and 11. P01/P02 code preflights remain
fail-closed, pending actual operator/resource evidence.

Exact next action: continue S2/MS01/MS02 provider lifecycle at the UserPort alias-to-AgentPort
sync/revoke/owner-link code path and implement its next reachable caller gap. Then resume remaining
S3–S9/U01–U12 and P03–P24. Keep rollouts disabled.

## Previous checkpoint — 2026-11-15 (P04 per-app product-user uninstall; pushed a4958c701f4da4cbc5bad8196b84fd88e6ac69b7)

Code `a4958c701f4da4cbc5bad8196b84fd88e6ac69b7` is pushed and remote-verified on
`origin/Mcbt5s-Backup-2`. Migration 148 persists retryable exact-user uninstall state. Product-user
DELETE drains extension work, erases only the user's actor, then removes/anonymizes their install row;
owner-shared install remains active. Replays use the receipt. Activation, app calls, actor
re-registration and archive preview/restore fail closed after tombstoning; export returns 409 while
uninstall is pending.

Local verification: Spaces migration/erasure/archive/route suites **37/37**, Router routing suite
**6/6**, Spaces/Router TypeScript checks and `git diff --check`. Local mocks/SQLite only; no deployed,
browser or live acceptance. Rollouts remain disabled. Preserve untracked
`infra/scripts/__pycache__/`.

The fetched source branch `origin/plan/microapps-ui-sdk-voice` (`df3386257262a88888d647daa4d10f3af2ff9596`)
has no uncopied Fish Live 3 or business MicroApp/UI SDK/voice requirements: those sections are already
in this active plan. No merge or duplicated appendix was needed. Only stale metadata/P04 wording differs.

P04 remains partial for other service stores, policy, cross-service consistency, isolated recovery
and deployed RPO/RTO. Same-identity reinstallation remains unsupported under the current actor key
contract; `PROJECT_USER` remains unsupported. Exact next action: trace and close P01's production
migration failure-handling gap, then continue P02 and remaining P04/S2–S9/U01–U12/P03–P24 gaps.

## Previous checkpoint — 2026-11-15 (P04 account erasure fence; pushed c20d13003be80befa7bb7cd45c18f2f5ee424cc2)

Code `c20d13003be80befa7bb7cd45c18f2f5ee424cc2` is pushed and remote-verified on
`origin/Mcbt5s-Backup-2`. The self-service product account DELETE now deletes exact-user MicroApp
actor state plus G-AO31 SpaceDO sessions/messages/agent state across all linked Product Spaces,
keeping the durable account fence active until cleanup succeeds. Retries resume idempotently. The
Router blocks product-session API and stream-ticket access while erasure is pending and preserves the
exact account DELETE retry; Space membership checks also consult the marker. Invalid tickets receive
the usual auth failure without disclosing account state.

Local evidence: Spaces erasure, product-user route and account cleanup suites **15/15**; Router
product-user auth/erasure/stream-ticket **5/5**; Spaces and Router typechecks; `git diff --check`; and
SQLite membership-fence behavior. These are local mocks/SQLite, not browser, deployed or live
acceptance. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

P04 remains PARTIAL for per-app uninstall, other stores, retention/legal/key/jurisdiction choices,
cross-service consistency, isolated restore drills and measured RPO/RTO. `PROJECT_USER` remains
unsupported. Plan text from `origin/plan/microapps-ui-sdk-voice` (`df3386257262a88888d647daa4d10f3af2ff9596`)
is copied into sections 9 and 11; there was no branch merge. S2 remains locally implemented for its
supported provider lanes; S3–S9/U01–U12 and P01–P24 continue per their ledgers. U05's trusted
Container-to-Computer observation bridge remains uncoded, not credential-blocked.

Exact next action: implement product-user uninstall for one's own USER_PRIVATE/SPACE_USER MicroApp.
Persist a durable removal receipt/tombstone, erase actor state before removing the user's install row,
support retry after partial failure, and reject later activation/calls. Preserve the owner-shared
installation. Verify the reachable Router/API path plus cross-user, retry, partial-failure and
post-uninstall denial; then continue the next independent plan gap.

## Previous checkpoint — 2026-11-15 (P04 signed product-user MicroApp lifecycle; pushed fbaeeea8ba19a0c9fb73f48209acd1368776dd87)

The pushed code checkpoint `fbaeeea8ba19a0c9fb73f48209acd1368776dd87` adds owner-approved
USER_PRIVATE/SPACE_USER Tier 1 package declarations and a product-session caller for discovery,
explicit activation, isolated app/data/storage/MCP access. It verifies exact owner installation and
release, signed publisher key, all R2 artifact bytes, active Space membership and the caller's user
identity before initialization or use. User actor state is initialized lazily from the signed release
and canvas proof, with a per-user installation. `PROJECT_USER`, account erasure of MicroApp actors,
and per-app uninstall are uncoded.

Local evidence: Spaces **72/72**, Router **69/69**, Spaces/Router typechecks and diff hygiene pass.
These are local mocks, not browser/deployed/live-provider acceptance. Rollouts remain disabled. The
source plan branch `origin/plan/microapps-ui-sdk-voice` is fetched at
`df3386257262a88888d647daa4d10f3af2ff9596`; its Fish Live 3 and business MicroApp/UI SDK/voice text
is already copied into active sections 9 and 11. No branch merge occurred.

P04 remains PARTIAL for other service stores, user-actor deletion, legal/key/jurisdiction and retention
policy, cross-service consistency, and measured/deployed recovery. P01–P24 and S2–S9/U01–U12 remain
open where their indexed evidence says so.

Exact next action: complete retryable exact-user MicroApp actor and installation erasure in the
existing self-service account deletion path, and prove erased actors cannot be reactivated or called.
Then continue other P04 stores and the next independent plan requirements.

## Previous checkpoint — 2026-11-15 (U05 runtime-contract trace; P04 user-private MicroApp archive foundation; pushed verification checkpoint 6f6ec9020a8808141a1919f7ffb226ea60e78e71)

Implementation `4a8dd06d2f8407e1272ab0e5c0d71f7b4ba50826` and owner-archive rejection regression `6f6ec9020a8808141a1919f7ffb226ea60e78e71` are pushed to `origin/Mcbt5s-Backup-2`; fetch and remote verification confirmed the latter as tip. MicroApp snapshots now accept user scopes only when the exact user identity, actor metadata and signed gadget-scope declaration agree. Space-owner archive restore rejects user scopes. Router now exposes the existing exact product-user `/export` endpoint; it still does not contain MicroApp snapshots.

The fetched `origin/plan/microapps-ui-sdk-voice` plan (`df3386257262a88888d647daa4d10f3af2ff9596`) adds no new requirements beyond sections 9 and 11 already copied into the active platform plan. Its only differences are stale provenance and older P04 wording; no merge occurred.

U05 source reconciliation found an identity mismatch: `project_main_runtime_registry` stores a Cloudflare Container allocation using workflow budget reservations, while candidate verification requires a separate Cloudflare Computer `live_mount`, immutable template/image and region, managed-service credit reservation, and trusted runtime observation. No bridge or trusted producer exists. This is uncoded runtime integration, not missing credentials; do not fabricate reservations or observations.

Local verification: Router **55/55** and typecheck; Spaces MicroApp/archive/remediation **33/33** and typecheck; `git diff --check`. No browser, deployed Worker, or live provider acceptance. Rollouts remain disabled; preserve untracked `infra/scripts/__pycache__/`.

P04 remains PARTIAL. Exact product-user identity exists and the account export is router-reachable, but it does not include user-private MicroApp data. The current-installation listing and authenticated archive caller remain uncoded. Exact next action: implement that listing and caller, bind each actor/archive to the verified user and current signed installation, add bounded export plus same-user/install preview and additive restore with replay/audit protection, and test cross-user/install, removal and replay. Keep personal state outside owner archives. Then continue remaining P04 and S3–S9/U01–U12/P01–P24.

## Previous checkpoint — 2026-11-15 (§5 guided-template expected-usage authoring; code checkpoint d9d3138388be16b16dda5859c1884b0445dc5ff4)

Code `d9d3138388be16b16dda5859c1884b0445dc5ff4` is pushed to `origin/Mcbt5s-Backup-2` and
`ls-remote` verified. Foundry Studio now edits, previews and saves bounded expected monthly
conversations, interactions and optional managed-model calls in the authoring draft and signed export.
The Agent SDK and Spaces validate the contract and reject author prices/customer budgets. Activation
preview returns the signed defaults and recalculates model credits using current verified rates; Shell
labels author assumptions and lets customers copy them into editable estimate inputs. Total USD stays
unknown; assumptions do not grant model access or enforce spend.

Local verification: Agent SDK/Foundry **10/10**, Spaces guided-authoring/cost/activation **49/49**,
SDK/Spaces/Shell typechecks and `git diff --check` pass. A root-level Spaces test invocation lacked its
`cloudflare:workers` alias; the configured package rerun passed. No browser, deployed Worker,
Marketplace or live provider acceptance ran. P05 and §5 remain PARTIAL for cost completeness, lifecycle,
provider/payer/revocation policy, and live acceptance. Rollouts remain disabled; preserve untracked
`infra/scripts/__pycache__/`. The microapp/UI SDK/voice plan text remains copied into the active plan;
no branch merge occurred.

This next action was superseded by the U05 source trace and P04 user-private archive work recorded above.

## Previous checkpoint — 2026-11-15 (P06 Telnyx extension voice-profile pin; code checkpoint 2742c3554588e4147eacf352a5ad12e65746b0d6)

The owner can select a host-approved 16 kHz economy profile for new Telnyx extension calls. Migration
0260 stores the selected profile on the admitted call and consented stream session; runtime resolves
the exact pinned catalog entry. Changing the line policy does not change active calls. The reachable
phone dashboard shows profile selection, catalog list-rate provenance/date, existing consent/cost
limits and pinned call-history profile. Rollout flags remain disabled.

Local evidence: Agents phone/call/session/runtime suites **57/57**; direct Agents, Shell and Agent SDK
TypeScript checks; migration inventory **260/260**; release tests **20/20**, release manifest tests
**5/5**, deployment manifest tests **14/14**, validators and `git diff --check`. Mocked local evidence
only: no Telnyx/OpenRouter account availability, live price, quality, deployment or production
acceptance was checked. One initial parallel run hit a runtime timing wait; isolated and full reruns
passed. P06 remains PARTIAL for provider/model/price verification, first-party signed package/catalog
publication and complete dashboard acceptance. Code checkpoint `2742c3554588e4147eacf352a5ad12e65746b0d6` is pushed to `origin/Mcbt5s-Backup-2`; `ls-remote` confirmed the remote tip.

The microapp/UI SDK/voice plan copy remains from `origin/plan/microapps-ui-sdk-voice` commit
`df3386257262a88888d647daa4d10f3af2ff9596`; no merge occurred. Rollouts stay disabled.

Exact next action: implement the independent S3/U05 product-side candidate allocation/reservation
caller bound to exact project scope, current main allocation generation, selected template/image digest,
current authorization and budget reservation. Add persistence and authorization, stale/concurrent
allocation, and fabricated-attestation rejection checks. Candidates remain unqualified without a
trusted runtime observation. Then continue the plans in dependency order; do not claim live, deployed
or U06 sync/flush acceptance.

## Latest checkpoint — 2026-11-15 (§10.1 delegated settings drafts and owner publication; pushed)

Code `26ceb675176e37d7ace7c10013c65be44f50fb5c` is pushed to
`origin/Mcbt5s-Backup-2`; `ls-remote` confirmed the same SHA. Migration 145 adds revisioned,
per-Project/per-installation `settings.propose` grants and an audit ledger. Space owners/admins and
the exact Project owner may grant one active project-eligible agent access to one active signed
installation. The proposal route rechecks the caller's workflow membership, exact installation,
agent identity, current Project agent allowlist, current grant, owner-publish policy and signed field
schema. Durable writes create only a validated draft and audit changed field IDs; active settings
stay untouched. Revision fences protect both active and draft state, and uninstall revokes grants.

The Shell now lists eligible agents and grant revisions, supports grant/revoke and shows delegated
audit attribution. The settings form loads agent drafts for owners, shows active-to-draft field
changes, saves edits as drafts, and requires a separate browser confirmation to publish. Space
owners/admins and exact Project owners can review/publish; project editors cannot read the draft or
publish it. Package updates, publisher controls and provider connections remain outside this grant.

Local verification passed: Spaces suites **18/18**, Agents workflow/prebuilt suites **28/28**,
Router product-session path tests **52/52**, Shell grant API test **1/1**; direct `tsc --noEmit`
passed in all four workspaces, as did `git diff --check`. The ordinary `pnpm typecheck` wrapper
aborted while trying to purge/reinstall the shared modules without a TTY; direct workspace compilers
were run. These are local tests, not deployment, live provider or production acceptance. Rollouts
remain disabled; preserve untracked `infra/scripts/__pycache__/`.

Fetched `origin/plan/microapps-ui-sdk-voice` at `df3386257262a88888d647daa4d10f3af2ff9596` and
compared its plan file with the active platform plan. Microapp, UI SDK and voice requirements are
already copied; only stale provenance and older P04 wording differ. No requirement was missing and
no branch merge occurred. P17's direct catalog, listing and license work remains partial at the
cross-origin identity bridge: Marketplace uses builder JWT identity; Shell uses ProductUserDO-backed
`nps_` product sessions. No persisted identity-link or safe single-use cross-origin handoff exists.
Email equality and browser/library state do not establish the link. P20 refund/access/creator
accounting decisions remain separately unresolved.

Exact next action: trace the signed Project extension version-update review/apply path from Shell
through Spaces and SpaceDO. Verify exact installation/release/publisher checks, pause/drain fences,
and which actor may submit versus approve. Add an agent proposal caller only if the existing signed
update contract can preserve exact-install scope and owner approval; otherwise record the precise
gap and continue the next independent P01–P24/S2–S9/U01–U12 item.

## Previous checkpoint — 2026-11-15 (P16 Discord contract/source-to-caller audit; no code change)

The P16 path is locally bounded end to end: authenticated/paired event and active-Space checks,
ephemeral-only exact Discord CDN host/path, signed-query shape and expiry, no redirects, timeout,
declared/streamed size caps, task-scoped R2 retention, and owner-approved exact-install/provider-
bound `read_text` or `read_image` access. `read_image` permits one PNG/JPEG/WebP up to 480 KiB and
validates bytes before extension use. The versioned capability endpoint and channel setup view disclose
ephemeral-only support, limits, retention and ordinary-attachment unavailability.

The pinned official [Discord Cloudflare Workers tutorial](https://github.com/discord/discord-api-docs/blob/37148620d2324292b76047541d5f8331f81ea77a/developers/tutorials/hosting-on-cloudflare-workers.mdx)
documents 403 for ordinary CDN media from Workers and access to ephemeral CDN media. The current
[Discord message schema](https://docs.discord.com/developers/resources/message) documents attachment
URLs and ephemeral lifetime but not the `ex`/`is`/`hm` URL-signature format used by the local validator.
That format is still unverified against authorized provider events; the implementation remains
fail-closed. Focused local Agents tests pass **9/9**. No live provider, Worker or deployed acceptance
ran. No retrieval relay or provider bypass was added. P16 remains PARTIAL for ordinary attachments,
audio/arbitrary binary and live acceptance.

Exact next action: reconcile P17's missing Marketplace-to-Shell identity handoff against actual
session issuers and purchase/listing scope. Implement a short-lived single-use exact-listing handoff
with replay, expiry and cross-account tests only if existing authorities can prove one identity safely;
otherwise record the precise identity-contract gap and continue another independent implementation
item. Keep rollouts disabled and preserve `infra/scripts/__pycache__/`.

## Latest checkpoint — 2026-11-15 (§11.2 bounded read action and §11.5 host-connected UI SDK POC; pushed)

Added the signed `inventory.listLowStock.v1` read-only action through MicroApp host execution. It shares
owner/admin, tenant/Space/Project, installation and exact-release checks with the existing business
actions. Inputs and outputs are schema-validated; reads return one bounded ordered page, are audited,
and do not create write receipts/events or mutate Gadget rows. Authenticated HTTP and assistant/MCP
callers reach the same host implementation. Signed Space-shared packages must grant exact `read`
authority for the read-only action; writes still require exact `write` authority. The owner/admin Shell
panel previews and confirms the bounded read.

The isolated UI SDK POC uses the Agent SDK bridge and the current `MicroAppCanvas` source/origin-checked
host message path. Its standalone mode stays synthetic, and embedded mode never falls back to fixtures.
The browser exercise used a local fake parent, so it does not establish deployed host authorization.
§11.5 remains PARTIAL and the UI SDK is not adopted into Shell.

Local verification: SDK **7/7**, Spaces **70/70**, Shell **5/5**, POC bridge **3/3**; SDK/Spaces/Shell
typechecks; Vite production build **117.70 kB JS / 41.34 kB gzip**; Chromium owner-confirmation and
sandboxed frame checks at 390px/320px, no horizontal overflow or browser errors. No deployment, live
provider, real multi-user, screen-reader or performance acceptance ran. Rollouts remain disabled;
preserve `infra/scripts/__pycache__/`.

Fetched and compared `origin/plan/microapps-ui-sdk-voice` (`df3386257262a88888d647daa4d10f3af2ff9596`).
The microapp, UI SDK and voice requirements are already copied into the active platform plan. Its only
remaining differences are stale metadata and older P04 wording; no content was missing and no merge
was performed. The active P04 evidence is retained. Code `a50e1c6d14f41987ec310e0b8c1aea748c0e7bd6`
is pushed to `origin/Mcbt5s-Backup-2` as a fast-forward; `ls-remote` confirmed the remote tip matches.

Source reconciliation found owner-controlled Project Knowledge selection is implemented and pushed in
`6d189f450ee61fa9dc74227dab7f95c12b12670d`. Revisioned policy, grant and event tables bind tenant,
Space, Project and Space-shared installation. Authenticated owner/admin routes recheck current published
collections and exact signed declaration; Project Settings provides grant/revoke; the Agents host
intersects grants with the active signed manifest before external Knowledge search. Defaults are no
access and uninstall revokes grants. Local revalidation passed Spaces **71/71**, Agents resolver **3/3**,
Knowledge publication/search **6/6**, and Spaces/Agents/Knowledge/Shell typechecks. No deployed or live
multi-user acceptance ran. This closes the Project Knowledge selection slice; broader shared provider
beneficiary, payer and revocation policy remains unresolved.

Exact next action: continue P16 by tracing the Discord attachment path from provider event through
storage to the owner-approved `read_image` handler. Verify current official CDN authorization and expiry;
implement only if the host's active provider binding can authorize bounded retrieval. Otherwise record
the exact provider restriction and proceed to another uncoded P01–P24/S2–S9/U01–U12 requirement.

## Earlier checkpoint — 2026-11-15 (P04 Knowledge archive and §11 plan reconciliation; pushed)

Code `e475eb6b45e9ef6b219385c4ee2a55ef39f6b895` is pushed to `origin/Mcbt5s-Backup-2`. Space archives
now include a bounded tenant/Space/Project snapshot of canonical Knowledge documents/chunks, ACL
metadata and required KB_BUCKET bytes through the authenticated Knowledge Worker bridge. Deletion
leases/tombstones fence export and additive restore; restored docs require explicit hash-checked
reindexing. Vectorize, AutoRAG and provider effects are not restored. Old SpaceDO mirror rows are
excluded. The owner preview/status/apply path and Shell reindex caller are wired.

Verification: Knowledge archive/document lifecycle **36/36**, Spaces archive/data-ops **19/19**, Shell
archive panel **2/2**, Knowledge/Spaces/Shell typechecks, release manifest tests **5/5**, manifest
validators, SQLite migration constraints and `git diff --check`. These are local mocks/SQLite checks;
no browser, deployed D1/DO/R2, isolated recovery drill or provider acceptance ran. P04 remains PARTIAL
for other service/inbound stores, user-private MicroApp state, legal-hold/retention and key/jurisdiction
policy, cross-DO consistency, RPO/RTO and deployed recovery.

The fetched branch `origin/plan/microapps-ui-sdk-voice` at
`df3386257262a88888d647daa4d10f3af2ff9596` adds no further plan material beyond the Fish Live 3 and
business microapp/UI SDK sections 9–11 already copied into this active plan. Its plan file contains an
older P04 row; current Knowledge reconciliation is retained. No branch merge occurred. User-keyed
MicroApp scopes exist, but reachable routes have no exact-user authenticated archive caller. Keep
personal app data outside Space-owner archives until that identity/runtime contract exists; it is not a
provider credential blocker.

All rollout gates remain false. Preserve untracked `infra/scripts/__pycache__/`. Exact next action: add a
host-rendered owner/admin business-action UI to the active Extension view, using the existing scoped
Shell API and signed action schema. Preview and explicitly confirm the input; reuse the same
idempotency key after an uncertain response. Test the real UI/API caller path and then continue the
remaining P01–P24 and S2–S9/U01–U12 work.

## Previous checkpoint — 2026-11-15 (P05 cleanup resumes after reload; §11.2 reconciled)

Code `c2963702f6795b0c126f4f7fa769f67f35ee22c7` adds exact generated-Project archive/cleanup preview
and explicit owner/admin confirmation. Code `0a4021bacd999ba502b65d19704c44108c42abff` lets the
template status view reload durable cleanup phase/page/provider-count metadata by exact bounded
Project IDs. The owner/admin Spaces endpoint omits raw erasure cursors and tombstone IDs. Project
workspace provider cleanup is reported separately; shared extensions, tenant connections, licenses
and external charges are untouched. P05 remains PARTIAL for full uninstall and unresolved
payer/revocation/resource semantics.

Verification: Shell cleanup/status caller **2/2**, Spaces deletion/status **5/5**, Router forwarding
**1/1**, Shell/Spaces/Router typechecks and `git diff --check` passed locally. No browser, deployed
Worker/R2 or live provider acceptance ran. All rollout gates remain false.

Section 11.2 is not uncoded: pushed `ad20fc8f` implements one signed, typed `receiveStock` action through
the same transactional host function for Canvas HTTP and assistant MCP. Exact install/release and
owner/admin checks, input/output schemas, CAS, idempotency, audit, durable events and generic-CRUD
protection have focused local coverage (Spaces/routes **24/24**, SDK **5/5**, Spaces/SDK typechecks).
General action extensibility, approval flows and external side effects remain partial; this does not
claim deployed acceptance.

P07 source reconciliation: pushed `0da0abdb` already selects local worker models from the authorized
machine's owner-declared profile without cloud catalog discovery on a private route. `CustomModelManifest`
only binds a base model and LoRA adapter; no trusted source supplies tool, modality or context evidence
for custom worker selection. No capability routing was added from an unsupported assertion. P07 remains
PARTIAL for that capability-evidence contract and provider/deployed acceptance, not missing credentials.

Exact next action: continue P04's uncoded MicroApp user-private archive scope. Trace the user-private
actor key and reachable authenticated callers, then add exact-user-bound export/preview/additive restore
only where verified identity proves ownership. Keep user data out of a Space-owner archive without
user authorization; if a supported caller is absent, document the identity contract gap and advance to
another independent P04 store.

## Previous checkpoint — 2026-11-15 (P05 generated Project cleanup caller; pushed)

Code commit `c2963702f6795b0c126f4f7fa769f67f35ee22c7` is pushed to
`origin/Mcbt5s-Backup-2`; fetch confirmed the prior remote tip was an ancestor and the remote now
matches this SHA. Template status exposes a preview and explicit confirmation for every validated
generated Project ID, then calls the existing owner/admin DELETE route to archive the exact Project
and begin bounded workspace cleanup. UI status supports continuation/retry and shows provider cleanup
receipts. Space-shared extensions, tenant provider connections, licenses and external charges are
explicitly out of scope. P05 remains PARTIAL for full package uninstall and unresolved payer, revocation
and provider-resource semantics.

Verification: Shell caller test **1/1**, Spaces deletion route **4/4**, Shell typecheck and
`git diff --check` passed locally. No browser, deployed worker/R2 or live provider acceptance ran.
Rollouts remain disabled.

Exact next action: implement section 11.2's named typed business-action contract through a single
host-authorized operation shared by UI and assistant/MCP callers; enforce installation/actor scope,
current permissions and revocation, input/output schemas, version fencing, audit and idempotent effects.
Add a concrete action and local authorization/replay tests, then continue voice dashboard and shared-
Space requirements.

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

## Previous checkpoint — 2026-11-15 (P06 host voice runtime; section 11 source added; pushed)

Joint code checkpoint `b39d2da47211bc1b743064e2df9fc020905d16d3` is pushed to
`origin/Mcbt5s-Backup-2`; pre-push fetch confirmed `0c249321` as an ancestor. The separate BYO Telnyx
extension path now has caller consent, host STT/TTS with Billing reservations and a configured estimated
speech ceiling, bounded audio conversion/output, interruption, deadlines, cleanup and a five-minute
reconciliation sweep. Owner status reports consent, runtime, estimated speech usage and unresolved
receipts separately from carrier cost. The transcript path does not persist audio/text in D1 or the
handler's durable session state; duplicate transcript events return outcome-unknown without replay.
Migration 0258 is release-pinned. Rollout and external acceptance flags remain false.

Focused Agents voice/call/session/media/phone/SpaceDO tests **75/75**, Agents/Shell typechecks, release
migration tests **39/39**, release/deployment manifest validators and `git diff --check` passed locally.
All provider and Billing interactions were mocked. No browser, Telnyx/OpenRouter live call, invoice,
deployed Worker/D1 or production acceptance ran. P06 remains PARTIAL for Telnyx/OpenRouter contract,
pricing/quality and media behavior acceptance, plus publisher signing/catalog/provisioning. Unknown
provider outcomes without a resolvable generation receipt remain pending for operator/provider
reconciliation, not silently released.

The fetched plan branch `plan/microapps-ui-sdk-voice` at `df3386257262a8882a10e0f7b10fe297cefd17d3` added
Fish Live 3 research and business microapp/UI SDK section 11; the text was copied into this active plan
without merging the branch. Current `MicroAppDO` provides scoped app storage and schema-column MCP CRUD,
with Canvas integration, but no shared typed domain-action API that enforces the same rules for UI and
assistant callers. Fish Live 3 integration and Vercel UI SDK use remain uncoded and contract/evaluation
gated. The plan is not a support or availability claim.

Exact next action: implement section 11.2's typed named business-action contract from the current
`MicroAppDO`, `gadget-mcp` routes, extension declarations and UI callers. Start with one concrete action
that both UI and assistant/MCP invoke through the same host-authorized function; enforce actor and
installation permissions, current revocation, schemas, expected versions, audit and idempotent effects.
Then continue release, commercial/recovery, guided setup, voice dashboard and shared-Space gaps without
repeating closed audits.

## Previous checkpoint — 2026-11-15 (P06 consent caller and media boundary; P20 reconciled; pushed)

Joint code `1f429ee9d970449e3e5d875e3adab0b811e1ac7e` is pushed to
`origin/Mcbt5s-Backup-2`; fetch confirmed `fb145a18` as an ancestor. Telnyx extension lines now expose
an owner-controlled, default-false voice preference. A separate default-off runtime gate preserves
existing DTMF. When both settings are enabled, call admission creates the exact handler/settings-pinned
consent session, asks the caller to press 1 or 2, records grant/deny, issues the one-use media ticket
only after consent, and surfaces consent status to owners. Hangup and expiry revoke pending grants. A
dedicated extension media boundary verifies the one-use ticket, provider `start.call_control_id`, media
format and current pin, then refuses media with `voice_stream_runtime_unavailable`. It does not use
OwnerVoice and no Telnyx `streaming_start` is called. Development/staging/production remain false.

P20 source reconciliation: this refund receipt and authenticated buyer/creator status code were already
pushed in `5a462626` with migration 0251; no duplicate code was added. The signed-body hash binds each
review-only receipt to provider invoice/subscription evidence. Existing policy still does not change
access, paid cycles, earnings or payouts. P20 remains PARTIAL for access/creator accounting/disputes and
provider/deployed acceptance.

Verification: Agents call/session/media/phone suites **52/52**; Agents/Shell typechecks; P20 receipt,
normalization, buyer/creator and operator suites **25/25**; package-configured Router path **4/4**;
`git diff --check`. An initial Router run without its package config failed module setup; the configured
run passed. No browser, provider, deployment or live acceptance ran. Public STT/TTS, speech budget,
interruption, deadline, media start and complete cleanup are uncoded runtime work, not credential
blockers. Keep rollouts disabled and preserve all other S/U/P gates in their requirement ledgers.

Exact next action: implement host-owned STT/TTS admission, bounded per-call speech budget, interruption,
deadline and cleanup for the separate extension media path. Keep `streaming_start` and the global flag
off until these controls have local verification and external acceptance; then continue the next
independent requirement.

## Previous checkpoint — 2026-11-15 (S5/MS08d Modal host; P06 durable consent ticket; pushed)

Joint mission code `aa0f6b7b`, call cap `3b1059a4`, stream contract `ed426ee1`, Shell/SpaceDO
transcript simulator `f2d1f28d` and migration-backed session/ticket primitive `e4ebd7bd` are pushed to
`origin/Mcbt5s-Backup-2`; records `20171141`, `2f365d13`, `9c4e8851`, `e3b9072f` are pushed too.
Fetch-before-push preserved the remote ancestor. Migration `0257` stores exact tenant/Space/Project,
Telnyx BYO binding/call, extension installation, handler digest, published settings revision, consent
state and expiry. Grant issues a random 60-second one-time media ticket stored only by hash. Claim
atomically verifies the active line/call/handler and immutable pin; replay, stale handler, expiry,
wrong scope and unconsented session fail. No live caller uses these functions yet.

Local evidence: ticket/session migration tests **3/3**; phone route/SpaceDO/Shell tests **52/52**; SDK
stream tests **6/6**; Telnyx call tests **6/6**; Agents and Shell typechecks; release/deployment
manifest validation; Modal host **8/8**, Agents client **3/3**, build/typechecks and `git diff --check`.
Docker build stopped on Corepack TLS (`SELF_SIGNED_CERT_IN_CHAIN`); no image/CI container result. No
browser, provider, deployment or live acceptance. Modal remains disabled pending Beta/private-gRPC,
usage receipts and approved pricing. Preserve `infra/scripts/__pycache__/`.

P06 remains partial. The Shell phone panel supports explicitly synthetic final-transcript testing and
the extension voice-stream contract is SDK-only; migration-backed consent/ticket storage exists but is
not wired to webhooks or media. No STT/TTS audio adapter, speech budget, interruption, public stream or
complete operations. Existing media bridge is exclusively OwnerVoice. These are code/runtime tasks,
not credential blockers. Signed keypad microapp/dashboard, settings pinning, call status and call cap
are already implemented. Publisher identity/signing/catalog/provisioning and live cost/quality/carrier
evidence remain open.

Exact next action: build a default-off public Telnyx extension consent caller around migration `0257`.
Preserve DTMF when disabled. When the global gate and owner speech policy allow it, create the exact
pinned pending session, ask caller consent by keypad, persist deny/grant, and issue/claim a one-use ticket
only for consented calls. Add an extension-only WebSocket route that validates the Telnyx call identity
and exact pinned handler/settings without using OwnerVoice. Keep streaming_start disabled until host
speech budgets, STT/TTS, interruption, timeout and cleanup exist; continue other uncoded requirements.
## Previous checkpoint — 2026-11-14 (P05 guided setup lifecycle; pushed)

Code `c0daaf86a2c8c05b2e211eccc360367c3c9adf44` is pushed to `origin/Mcbt5s-Backup-2`. Space Template
owners/admins can preview, detach and reattach setup-management association with exact artifact/setup-
revision fencing. Detach removes pending draft data while preserving published values, generated
Projects, required extensions and Project Knowledge grants. Owner status shows a bounded durable
actor/action history. This is not package uninstall or provider/license/recurring-charge cancellation.
Spaces lifecycle/activation/migration suites **36/36**, Spaces and Shell typechecks, and
`git diff --check` passed. No browser, provider, deployment or live acceptance ran. P05 remains PARTIAL for wider
cleanup, provider/license/charge reconciliation and the Space-wide provider authority/payer/revocation
contract.

## Previous checkpoint — 2026-11-14 (P04 safe Project runtime settings archive; pushed)

Joint-mission code `e747b62d15da7f62405159595636726652de9153` is pushed to `origin/Mcbt5s-Backup-2`; pre-push fetch showed no remote
advance. Full Space archives now carry a bounded, versioned Agent-owned Project main-runtime profile
and inert restart recipes through an authenticated tenant/Space/Project-bound Agents bridge. Restore
validates exact scope and recipes, previews current-value conflicts, inserts only into missing
destination settings, writes restore-actor audit rows, and persists restored/preserved counts. The
archive excludes runtime allocations, live observations and provider snapshots; recipes do not execute.
Shell disclosure covers these boundaries.

Local evidence: Agents helper/internal-route tests **9/9**, Space codec/schema tests **7/7**, Space
data-ops **17/17** plus the focused project archive/restore rerun, Shell archive panel **2/2**, Agents/
Spaces/Shell typechecks and `git diff --check`. No browser, deployed Worker, R2 recovery drill,
provider call or live acceptance ran. P04 remains PARTIAL for other service stores/private inbound
data, retention/key/jurisdiction policy, RPO/RTO and isolated/deployed recovery. Rollouts remain off;
preserve untracked `infra/scripts/__pycache__/`.

The prior proposed U05 candidate allocator action was superseded by source reconciliation: this
project-main runtime has no selectable immutable image digest or trusted observation producer, and the
current verifier schema is for a separate sandbox-computer lane. See the latest U05 gate above; do not
infer candidate support from a caller assertion. Continue with independent S3–S9/U01–U12/P01–P24 work.

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

Code `c7b8b45ac21badaf7719f48d56a490fd537c1f75` is pushed to `origin/Mcbt5s-Backup-2`; pre-push
fetch confirmed remote tip `bafa3d9c` with no advance. The signed phone-menu package dashboard now
shows each validated synthetic handler response beside the preview built from saved settings. It uses
text-only DOM output and advances the package, bundle and primitive versions to **1.0.7**. Combined
with `7f6f4591`, it supports exact active-line call-start/DTMF and eligible Twilio speech checks without
carrier calls or saved call sessions. Telnyx remains DTMF-only; this is a bounded IVR.

Local evidence: SDK package/dashboard suite **6/6**, SDK typecheck and `git diff --check`; the prior
checkpoint's Agents simulation tests **2/2** and typecheck remain applicable. No browser, deployment,
provider or live acceptance ran. P06 remains partial for configuration publication, publisher identity/
catalog/provisioning, conversational streaming, complete cost/quality evidence and live acceptance.
The P05/§10.3 collaboration-posture task is already implemented in current source (`a3791d51`,
`06250151`): authoring, signed review, explicit owner confirmation, revision-0 policy fencing and
existing-policy preservation; focused tests pass **37/37**. P01/P02 resource/baseline evidence, P03/P20
policy decisions, P04 retention/jurisdiction/RPO-RTO and isolated recovery, and U06's upstream
writer/drain/flush/handoff contract remain open. Rollouts remain disabled; preserve untracked
`infra/scripts/__pycache__/`.

Exact next action: add draft-versus-published configuration to the bounded phone menu. Its current
generic settings `PATCH` replaces values read by live calls; create schema-validated exact-installation
draft persistence and owner/admin publication with optimistic revision fences. Keep the handler on the
active row until explicit publish, enable synthetic draft preview without carrier effects, and audit
only actor/role/revisions/changed field IDs. Add authorization, conflict and failed-publication tests so
active behavior cannot change on draft save.

## Previous checkpoint — 2026-11-14 (P05 guided Project Knowledge selection handoff)

Code `502618ca` is pushed to `origin/Mcbt5s-Backup-2`; immediately before pushing, fetch confirmed
remote tip `ac444bf8` with no concurrent change. Signed SpaceBlueprint activation records explicit
owner/admin choices of external Knowledge IDs per blueprint Project and extension, rejects undeclared
IDs before dependency-install side effects, and persists normalized intent in the existing retry
receipt. Owner/admin installation status maps the intent to the created Project ID. Project settings
show pending selections and prefill only currently published declared IDs. Activation never grants
access; a human must save the intent through the existing migration-137 path, which rechecks the
current publication and active signed declaration. Omission remains empty; retry with changed choices
conflicts.

Local evidence: Spaces activation/setup/grant suites **57/57**, Spaces and Shell typechecks, and
`git diff --check`. No browser, deployment, multi-user, provider or live acceptance ran. The P05
activation handoff slice is locally implemented; broader guided lifecycle/cost work and the Space-wide
provider-connection authorizer/beneficiary/payer/revocation contract remain PARTIAL. P20's review-only
subscription refund evidence remains pushed; its access/accounting/dispute policy remains unresolved.
Rollouts remain disabled.

Exact next action: start P01 release/environment safety. Reconcile the current production migration
workflow and required-schema verifiers against the full pinned manifest. Remove any failure-suppressing
migration path and add failure injection proving release cannot pass after a migration failure. Then
reconcile P02 resource identity/receipt gaps; continue S3–S9/U01–U12 independent code after the active
release-safety action. Fetch before every push; preserve remote history, keep rollouts disabled and do
not deploy.

## Previous checkpoint — 2026-11-14 (P06 owner-selected Twilio voice style)

Code `7e218ae2932fbd3c2f67df9c70e11d5b7d4a36d9` is pushed to `origin/Mcbt5s-Backup-2` after fetch
confirmed no remote advance from `de27aea7`. Signed bounded phone-menu release 1.0.5 adds persisted
per-installation speech style `default`/`man`/`woman`. The SDK and host validate the bounded enum;
Twilio receives the style in host-rendered `<Say voice>`, and the local synthetic preview reflects the
setting. Telnyx retains provider-default DTMF behavior and rejects style keys. UI and README explicitly
avoid promises about voice availability, language, quality or rate.

Local verification: SDK voice/package suites **15/15**, SDK manifest/signature suites **36/36**,
Agents renderer/phone/Telnyx suites **47/47**, SDK/Agents typechecks and `git diff --check`. No browser,
deployment, provider, carrier or live acceptance ran. P06 remains PARTIAL for first-party publisher
identity/catalog, provisioning, a full conversational voice agent/streaming, complete costs and live
acceptance. P04's grant-resurrection safety code is already present in pushed `75feeabb` and covered
through the archive panel and legacy-restore tests; that earlier exact task is complete.

Exact next action: implement the reachable P20 template-subscription refund receipt path. Current
Lemon Squeezy official event documentation includes `subscription_payment_refunded`; local SDK mapping
omits it, so Billing's template-subscription webhook path can acknowledge it without recording refund
evidence. Persist an idempotent review-only receipt bound to the exact subscription, invoice identity
and signed webhook-body hash, and add bounded buyer/author status through existing authenticated
callers where their identity models support it. Do not change subscription/access/earnings/payout policy
or interpret a cumulative provider amount as an incremental refund. Then continue the next independent
P01–P24 and S3–S9/U01–U12 code gap. Fetch before every push and safely integrate remote changes.

## Previous checkpoint — 2026-11-14 (P05 Project Knowledge activation handoff)

Handoff commits `e9be8aee` and `38f50b41` are pushed to `origin/Mcbt5s-Backup-2`. For a signed
SpaceBlueprint requiring owner-published external Knowledge, successful activation now opens links
to each validated created Project. The Project page guides the owner to publish a collection declared
by the active package and explicitly grant that current publication. Missing/invalid Project IDs get
a recovery message without constructing unsafe links. Activation does not create access grants.

Local evidence: Shell `tsc --noEmit` passed; Spaces `blueprint-activation.test.ts` **24/24** passed;
`git diff --check` passed. The global pnpm wrapper attempted dependency reconciliation and aborted
without a TTY; existing local binaries were used. These checks do not establish browser, deployment,
provider or live multi-user acceptance. P05 remains PARTIAL for the other setup/cost/lifecycle gaps,
Space-wide provider connection authority/payer/revocation contract, and live acceptance. All rollouts
remain disabled; preserve `infra/scripts/__pycache__/`.

Exact next action: close a P04 recovery safety issue found by comparing migration 137 to the current
archive code: full archives currently contain `extension_project_knowledge_grants`, so additive restore
could reinsert a revoked grant. Exclude that table from new exports, reject it in restore payloads,
disclose that Knowledge grants require reapproval after restore, and add focused export/restore
regression coverage. Then resume the next independent implementation gap in dependency order.

## Previous checkpoint — 2026-11-14 (P05 Project Knowledge grants)

Code `6d189f450ee61fa9dc74227dab7f95c12b12670d` is pushed to `origin/Mcbt5s-Backup-2`.
Space-shared channel extensions receive no Project Knowledge by default. Space owners/admins can
select only collections both declared by the active signed installation and currently published in
that Project. Migration 137 stores revisioned Space/Project/installation selections and bounded
actor-attributed history. Empty selections revoke access; uninstall clears grants and records a
revocation event. The Project page is wired to the owner-only list/update routes. Before external
search, the Agents host requires a Project ID, reads internal policy and intersects grants with the
active signed manifest; malformed or unavailable state fails closed. Project-scoped behavior is
unchanged.

Local evidence: Spaces runtime/migration/authorization suites **38/38**, Agents selection/attachment
routes **12/12**, Spaces/Agents/Shell typechecks and `git diff --check`. These are local tests only; no
browser, deployment, live multi-user, Knowledge provider or channel acceptance ran. P05 remains
PARTIAL for guided-template-to-Project grant handoff, Space-shared provider connection authority,
payer/beneficiary/revocation semantics, other setup/cost requirements and live acceptance. The provider
connection gap is a product contract, not a credential blocker. Keep rollouts disabled and preserve
`infra/scripts/__pycache__/`.

Exact next action: trace signed SpaceBlueprint activation and resumable setup to map each created
Project, Space-shared installation and owner-published collection. Carry explicit per-Project
Knowledge selections from activation review into migration 137, revalidating current publication and
active signed declaration at commit and retry; omitted selections remain empty. Add focused
authorization, retry and revocation checks without adding a second grant ledger. Keep shared provider
connections gated. Fetch and safely integrate before every push.

## Previous checkpoint — 2026-11-14 (P16 Discord attachment bounds; P13 queue coverage)

Code `db56ee37` (P16) and `da6245fe` (P13) are pushed to `origin/Mcbt5s-Backup-2`. P16 validates a
current Discord-signed ephemeral URL, exact event channel and attachment path IDs, size declaration,
response length, streamed byte cap, timeout and no redirects. Official Discord guidance says
ordinary CDN media is blocked from Cloudflare Workers; ordinary attachments need a separately
operated supported retrieval host/relay. This is a provider/platform contract gate, not missing
credentials. No provider or deployed acceptance ran. P16 remains PARTIAL for ordinary media and live
acceptance.

P13 detects the Cloudflare GraphQL query's 100-row ceiling and persists a possible-truncation alert;
the report stays incomplete. Current backlog/age/DLQ still have no supported source. The Admin DLQ
consumer's queue mismatch, lack of a reachable route/`platform_admin` identity, and replay retention,
redaction and duplicate-effect contracts remain open. P13 remains PARTIAL.

Local evidence: Agents Discord media and attachment routes **12/12**, Agents typecheck; Workflows
queue-health model **8/8**, Workflows typecheck, and `git diff --check`. Release manifest now pins
**249** migrations through `0249_project_main_runtime_budget_reservations`; full-manifest SQLite
rehearsal **20/20**, release/deployment manifest validators **18/18**. These are local checks only.
P01/P02 remote baselines, distinct resource IDs/ownership, missing read-only receipts, rollback and
deployed isolation remain external evidence gates. No rollout or deployment occurred.

Current P05 gap: owner-controlled Project Knowledge selection for Space-shared channel extensions is
uncoded. Exact next action: add durable selection keyed by Space, Project, installation and exact
owner-published collection; expose owner/admin list and grant/revoke callers constrained to current
published IDs; and have the Agents host intersect that selection with the active signed manifest
before external search. Preserve existing project-scoped behavior and do not create grants by default.
The separate Space-wide provider connection still lacks authorizer, beneficiary, payer/account sharing,
and revocation/drain semantics; keep it gated as a product contract. Fetch and integrate before each
push; rollouts remain disabled.

## Previous continuation — 2026-11-14 (P05 model-credit planning budget)

Code `d4b1652ef12cea0b2a45970342c5093dd38965a2` follows model-cost scenario
`d3044a665d16038ad54d4396d6a23b304849090e`. The owner-only activation preview accepts a bounded
monthly Naelao-credit budget and compares it with a verified model projection. It marks that comparison
not enforced and does not persist the customer assumption. Billing's verified monthly operation cap
remains a separate admission rule; direct provider charges and full USD total remain unknown. Local
evidence for both changes: SQLite-backed Spaces estimate/activation **32/32**, Shell parser **4/4**,
Spaces/Shell typechecks and `git diff --check`; no browser, deployment, purchase, or live provider
acceptance ran.

Current managed Workers AI execution is not connected to a template runtime: `managed-model-quote/run`
is owner-only and its Billing mandate is scoped to one operation, with the quoted operation credits as
the period maximum, revoked at completion. A hard template budget needs a defined template/
installation versus project/Space scope and a reachable runtime caller. Keep P05 PARTIAL.

Exact next action: trace P16 from a Discord attachment event through storage to the existing
owner-approved `read_image` handler. Verify current official CDN authorization and expiry behavior;
implement exact-message host retrieval with bounded bytes/MIME/expiry only if the active binding can
authorize it. Otherwise record the restriction and continue to another independent code gap. Keep
provider URLs and credentials outside the isolated package, rollouts disabled, and fetch/integrate
before each push.

## Previous continuation — 2026-11-14 (P05 guided-template model-cost scenario)

Code `d3044a665d16038ad54d4396d6a23b304849090e` is pushed to
`origin/Mcbt5s-Backup-2`. The owner-only activation preview lists only active operator-verified
Workers AI model rates bound to the tenant's current plan and latest verified capability manifest.
The route validates the model and customer-entered operation assumptions, then projects the exact
Naelao-credit price/version, per-operation ceiling, monthly operation cap and expiry. The Shell preview
caller is wired end to end; stale/unavailable rates fail closed, Billing's monthly operation cap is
identified as enforced at admission, and direct provider charges/full USD total remain explicitly
unknown. Local evidence: SQLite-backed Spaces estimate/activation **32/32**, Shell parser **4/4**,
Spaces and Shell typechecks, and `git diff --check`. No browser, deploy, purchase, or live provider
acceptance ran. This closes one local P05 cost-calculator slice; a customer-selected enforceable budget,
provider costs/quotes and total operating cost remain uncoded or unavailable.

The next concrete action is to add an optional bounded customer-entered monthly Naelao-credit planning
budget to this same preview. Compare it with the model scenario while clearly stating it is an
unpersisted assumption and does not enforce spending; keep the separately enforced Billing operation
cap and uncontrolled provider costs distinct. Then continue P05/P06 and independent S3–S9/U01–U12/
P01–P24 code gaps. Preserve rollouts disabled and fetch/integrate before each push.

## Previous continuation — 2026-11-14 (S5/MS08d Modal contract reconciliation)

Current official sources: the [JavaScript/Go SDK guide](https://modal.com/docs/guide/sdk-javascript-go)
marks the SDK Beta; the official [JS package README](https://github.com/modal-labs/modal-client/blob/main/js/README.md)
requires a server-side Node 22+ or Deno/Bun host. The official [Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox)
provides create/exec/terminate and declares CPU/memory/GPU, timeout/idle limit, volume, and region
options. Official [client source](https://github.com/modal-labs/modal-client/blob/main/js/src/client.ts)
states the gRPC API is not public and may change without warning. Official [billing docs](https://modal.com/docs/guide/billing)
limit programmatic reports to Team/Enterprise and warn of collection delays and report totals that
exclude credits/reservations/network-egress adjustments; they do not provide the per-sandbox
`actualCredits` receipt assumed by the generic scaffold. Agents is a Cloudflare Worker, and this repo
has no separately hosted Node/Deno/Bun adapter, service binding, reachable Modal caller, or durable
provider journal. Thus the scaffold is not provider support. Adopting Modal requires an explicit
compatible host and Beta/private-API product decision. This is not a credentials blocker. No tests or
live provider checks ran; MS08d and P06 remain PARTIAL.

P05's Space-shared provider connection gap remains source-reconciled: migration 0112 requires a
project installation; OAuth/setup/status/revoke all bind to that installation. The signed activation
preview blocks required Space-shared provider connections. Before implementation, define authorizer,
beneficiaries, payer/account-sharing and revocation/drain semantics. This is an uncoded product/host
contract, not missing credentials. UserPort MCP aliases are not provider credentials.

Branch code remains pushed through `76756aca`; no deployment or purchase occurred. Exact next action:
implement a reachable P05 guided-template cost-scenario slice using only current, operator-verified
`managed_service_model_entitlements`: server-validate the active model and expected operation count,
project its pinned Naelao-credit price/version/expiry, and keep direct provider charges/full operating
total explicitly unknown. Connect the controls to the activation-preview Shell caller. Keep rollout
flags disabled and fetch before every push.


## Active continuation — 2026-11-14 (U05 main-runtime budget reservation linkage)

Cross-plan code checkpoint `bbf9186c7ded715065b9aebd7e132f1bac9c1c7d` is pushed to
`origin/Mcbt5s-Backup-2`. The project-main runtime generation claim now stores its exact authoritative
Billing budget reservation ID, verifies that the held D1 row matches tenant and Space before runtime
start, and reuses that same ID during lost-ack recovery. The existing owner profile displays only the
reservation state/expiry and says it is an internal credit hold, not a provider invoice. Migration 0249
is registered in both release manifests. Local evidence: DynamicSandboxDO/profile tests **36/36**,
Agents/Shell typechecks, release/deployment manifest validation and `git diff --check`. No browser,
deployment, provider or live runtime acceptance ran; all rollouts remain disabled.

P03/P12's durable outbox → queue → deterministic workflow → retry/receipt path is already covered by
the `ee41d123` source/caller record and focused local tests; no independent caller mismatch was found.
The P06 exact-line selection is already implemented in `ce252033`. Grace/restriction/escalation and live
delivery remain product/acceptance gates. U05 now has a candidate generation/internal budget link, but
trusted mount/sync/flush observations remain uncoded. U06 still lacks a supported writer/drain/flush/
reconnect/handoff contract. P01/P02 remain fail-closed on actual Cloudflare resource ownership,
separation, receipts and operator-attested baselines. No platform requirement is live-accepted.

Exact next action: continue P05's uncoded Space-shared provider-connection scope contract across signed
Blueprint dependencies, activation, owner connection selection and revocation. Reuse the current vault
and authorization services and validate the Space-shared binding server-side; if the current host
cannot express its scope safely, record that exact contract as a product decision and advance to the
next independent code requirement. Do not treat UserPort MCP aliases as provider credentials. Fetch
before every push and integrate remote advances without overwriting history.
## Previous continuation — 2026-11-14 (signed template coordination-default handoff)

Code `06250151d426a4a1d15e4b81314f81d2a0b7737b` is pushed. The signed SpaceBlueprint carries optional
member-fact and exact singleton-key suggestions; Foundry authoring persists/restores them; activation
preview presents the suggestion beside current policy. Applying requires owner/admin confirmation and
revision zero, preserving existing rules. This extends the prior advisory coordination registry; it
does not reserve external provider resources or grant project/service access. Local evidence: SDK
blueprint/coordination/Foundry tests **15/15**, Spaces authoring/activation **37/37**, SDK/Spaces/Shell
typechecks and `git diff --check`. No browser, deployed or live multi-user/provider acceptance ran.

Reconciled source against stale queue entries: P04's jurisdiction-bound WorkspaceCoordinatorDO
archive/restore bridge exists and is covered by `space-data-ops.test.ts`; P08 bounded sampled-frame
analysis exists with separate owner opt-in and task-owned attachment checks; the signed phone-menu
dashboard already has synthetic call-start, DTMF and supported Twilio speech preview/installed tests.
These are local code/test paths, not deployed or live acceptance. P04 remains partial for other stores,
retention/key/jurisdiction policy and recovery drills. P08 remains partial for provider/deployed
acceptance. P06 remains partial for a full conversational voice-agent product, streaming, provider
provisioning, invoice reconciliation and the Naelao publisher/signing/distribution/catalog contract.
Rollouts stay disabled; preserve the untracked Python cache.

Exact next action: let an owner select the exact active phone binding in the signed package dashboard
when one installation serves multiple active lines. Carry its opaque binding ID in the synthetic test
request; revalidate exact tenant/Space/install/provider/status in the Space route before invoking the
handler. Preserve single-line behavior and keep speech limited to an eligible Twilio line. Then
continue uncoded P05/P10 and S3–S9/U01–U12 gaps; fetch and safely integrate before each push.

## Previous continuation — 2026-11-14 (shared-Space exact-key registry reservation)

Code `4f634205a4f92d7132c5530092d4d73f05fff142` is pushed to `origin/Mcbt5s-Backup-2`. The
shared-Space coordination registry now supports an optional owner/admin singleton set (up to 32
canonical keys), revisioned private history, and atomically maintained reservations. Direct fact
publication/amendment, private-project proposal approval, revoke and project retirement use the same
SpaceDO authority; expiration permits replacement. SDK, authenticated no-store owner/admin routes,
Shell editor, reservation display and history are wired. Local checks: SDK **6/6**; Spaces registry,
gateway, proposal and migration suites **40/40**; Agent SDK, Spaces and Shell typechecks; diff check.
No deployed or live multi-user acceptance ran.

This closes only the registry-level subset of §10.2/§10.5. It does not reserve provider resources or
gate template/project/provider provisioning and activation. Full §10.4 side-effect reservations,
non-disclosure scenario coverage and live concurrency remain open; no project access is granted by a
reservation. P06 first-party phone listing still requires publisher identity, key custody/signing,
canonical artifact distribution and catalog policy. P01/P02 and the remaining plan matrices retain
their recorded external gates and uncoded work. Rollouts stay disabled; preserve the untracked Python
cache.

Exact next action: add the optional singleton-key suggestion to signed SpaceBlueprint authoring and
owner activation review; apply only with explicit confirmation when the owner policy revision is still
zero, preserving any configured policy. Test authoring, persistence, authorization and replay, then
continue other uncoded requirements in dependency order. Fetch before each push and never overwrite
remote history.

## Previous continuation — 2026-11-14 (P16 owner-approved image attachment mode)

Code `c697b8f93ea9976132c58b733f6d0387feb331ed` is pushed to `origin/Mcbt5s-Backup-2`. P05/P16
now support a distinct owner-approved `read_image` channel grant: one PNG/JPEG/WebP image up to 480
KiB, limited to the active installation/provider binding and exact unexpired message. The public
metadata route remains key-free; the host verifies MIME signature, package byte cap and stored bytes
before passing base64 to the isolated handler. SDK, Space persistence, Agents route/dispatch and Shell
approval/disclosure are connected. Local evidence: SDK **31/31**, Agents **10/10**, Spaces **13/13**,
Agents/Spaces/Shell/SDK typechecks and `git diff --check`; no deployed or live provider acceptance.

P16 remains PARTIAL for ordinary non-ephemeral Discord retrieval, audio/arbitrary binaries and live
provider acceptance. P05 remains PARTIAL for broader guided lifecycle, scoped provider/collection
authority and deployment acceptance. P06 first-party catalog listing is a genuine publisher contract
gate: `bounded-phone-menu` is a source example, not a centrally signed/distributed release. Required
decision/evidence: Naelao publisher identity, key custody/signing authority, canonical signed artifact
and distribution contract, and catalog policy. Do not fabricate listing or bypass signature/owner
review. P01/P02 resource separation and operator receipts remain external evidence gates. Rollouts
remain disabled; preserve `infra/scripts/__pycache__/`.

Exact next action: implement §10.2's host-only coordination reservation as an optional owner/admin
singleton rule per approved `capability_key`; persist the rule, enforce it atomically for active
entries and publication proposals, keep it off by default, and restrict rule details to authorized
owners/admins. Add contention, rule-change and retirement tests. Then wire the Space Template policy
handoff and continue remaining guided-template, S3–S9/U01–U12/P01–P24 code gaps.

## Previous continuation — 2026-11-14 (P02 Wrangler-resolved release inventory)

Code `6040847ea8967728f8ffb41df25231a939a61f62` is pushed to
`origin/Mcbt5s-Backup-2`. Both deployment preflights resolve all 28 Worker Wrangler TOMLs for
staging and production and compare Wrangler's resolved mutable-resource bindings to the source
receipt inventory. The check verifies source hashes, emits binding identities only, and makes no
Cloudflare calls. Each preflight runs the validator and its Node regression suite; the deployment
manifest validator enforces both steps. Local evidence: Wrangler inventory **5/5** and full
56-environment comparison; environment resource map **12/12**, receipt collector **4/4**, isolation
**6/6**, deployment-manifest tests **13/13**, deployment manifest validation and `git diff --check`.
No Cloudflare account, deployed resource, remote D1 or live acceptance was inspected.

P02 remains PARTIAL/fail-closed: one D1 and eleven KV IDs are shared across staging/production,
`naelao-calls` has no named Worker owner, 158 read-only receipts and account/time evidence are absent,
and staging/production have no operator-attested D1 baselines. This source check does not resolve
those external inventory gates. P01 remains local-only for release code; no staging rehearsal or
deployment ran. Rollouts remain disabled; preserve `infra/scripts/__pycache__/`.

Exact next action: add first-party catalog discovery for the signed `bounded-phone-menu` package via
the existing extension listing/install flow. Preserve release-signature, owner-review and active
installation checks; disclose DTMF limits, Twilio-only speech, synthetic tests and provider-cost
limits. Do not add carrier provisioning or streaming. Then proceed through remaining P05/P06 and
S3–S9/U01–U12/P01–P24 code gaps.

## Previous continuation — 2026-11-14 (P06 signed phone package caller verification)

Test checkpoint `bfc00ae4b836c0a9409a070ff0836289b2304b9e` is pushed to
`origin/Mcbt5s-Backup-2`. The current source already contains the signed bounded keypad package,
per-install settings, package-owned dashboard, owner-only call status and synthetic test callers, and
host-side provider/event enforcement. Focused local evidence: SDK **5/5**, Spaces route/package
**40/40**, Agents phone **49/49**, Agent SDK typecheck and `git diff --check`. Two outdated assertions
were corrected to match current public disclosures. This is local-only; no signed listing was
published, no carrier was contacted, and no deployed/live acceptance ran. P06/§9.5 stays PARTIAL: the
package is a bounded IVR rather than a conversational voice agent; first-party catalog
listing/discovery is uncoded, provider provisioning is not integrated, and streaming is unsupported by
the current runtime contract. Broader lifecycle, cost evidence and live acceptance also remain.
Rollouts remain disabled; preserve `infra/scripts/__pycache__/`.

Historical next action, completed by `8a0972c7`: implement §10's project-owner disclosure proposal
workflow with requester/admin-only pending reads, exact owner-confirmed publication, revision fencing,
withdrawal, source-project lifecycle handling and a reachable Project Settings caller. The latest
proposal checkpoint above records the implementation and its local evidence.

## Previous continuation — 2026-11-14 (P02 receipt CI caller; P03/P12 reconciliation)

CI source commit `ee41d1233659e4d3b7db7c8b1952298463337fb5` is pushed. Both deployment preflights now
run the GET-only resource receipt collector suite, including custom-map freshness coverage. Local
evidence: resource inventory/preflight **12/12**, collector **4/4**, Billing dunning dispatch/outbox/
status **12/12**, Workflows queue dispatch **11/11**, dunning recovery **10/10**, and `git diff
--check`. P03/P12 source reconciliation found both platform and Product-user failure paths use a
versioned durable outbox and deterministic Dunning workflow, recheck current subscription/recovery
before notification, and persist provider outcomes under stable Notification IDs. No independent code
gap was found in this path. Grace/restriction/escalation, retry cadence and provider delivery acceptance
remain policy/live gates. P02 still awaits actual Cloudflare resources/ownership, account/time
observations, 158 read-only receipts and operator-attested D1 baselines. No deployment/live provider
test ran; rollout remains disabled.

Exact next action: build a customer-facing signed keypad-extension microapp on the existing installation
settings, owner phone-dashboard and test-only simulation contracts. Keep simulations visibly synthetic,
retain Twilio-only speech and Telnyx DTMF bounds, and leave provider provisioning/streaming unavailable.
Then continue remaining §9.5/P05 and S3–S9/U01–U12/P01–P24 gaps.

## Previous continuation — 2026-11-14 (P20 refund conflict reconciliation)

Code `aa877154d5a808da03ec6d6d07a485dabd6d8994` is pushed. Refund evidence with an invalid explicit
amount previously remained in conflict but was not linked to a later matching captured purchase.
Settlement now attaches that purchase provenance while preserving `policy_conflict`; tenant and
purchase-identity mismatches remain unattached. This makes the durable review record more complete
without deciding license access or creator-earning reversal. SQLite-backed Marketplace settlement and
operator-review suites pass **12/12**, Billing typecheck passes, and `git diff --check` passes. These
are local tests; provider/deployed/live acceptance was not run. P20 remains PARTIAL for access,
clawback, dispute and payout policy plus live reconciliation. P02 remains PARTIAL for actual Cloudflare
resource separation/ownership, fresh receipts and operator-attested D1 baselines. Rollouts stay
disabled; preserve `infra/scripts/__pycache__/`.

Exact next action: trace P03/P12 from the durable billing outbox and queue producers through workflow
creation, retry scheduling and notification receipts. Close one concrete reachable contract or
idempotency gap without selecting grace/restriction/retry-cadence policy, then continue independent
S3–S9/U01–U12/P01–P24 code gaps without repeating completed audits.

## Previous continuation — 2026-11-14 (P02 receipt identity and source freshness)

P02 fixes `fe8b31216c6c6049c7c3519dea0744e2f58e00e6` and
`6f5ded73c48be8a5d44644ce694ea2a43dbdbdd1` are pushed. The preflight now requires exact R2 bucket
and Vectorize index names in read-only receipts, and the collector rejects stale source maps at both
default and custom paths before making Cloudflare API calls. Environment-resource and collector
suites pass **16/16** and `git diff --check` passes. The local preflight still rejects one shared D1,
eleven shared KV IDs, unresolved `naelao-calls`, absent account/time evidence and 158 missing
read-only receipts; no Cloudflare account, deployed resources or remote D1 was inspected. P02 remains
PARTIAL for real resource separation/ownership, receipts and operator-attested baselines. Rollouts
remain disabled; preserve the intentionally untracked `infra/scripts/__pycache__/`.

Exact next action: continue P20's refund settlement path from webhook normalization through durable
refund cases and buyer/author status callers. Close a concrete identity, idempotency or persistence gap
without deciding license access, author clawback, dispute or payout policy, then continue independent
P03/P12 and S3–S9/U01–U12/P01–P24 gaps without repeating completed audits.

## Previous continuation — 2026-11-14 (P04 chunked Space archive objects)

Source `c3b2936a6a33e6b31e49ec360e017e7d1ed0b6ee` is pushed to `origin/Mcbt5s-Backup-2`. Existing v1
archives remain readable and are still written within 2 MiB/object and 4 MiB aggregate. Larger captures
use v2 authenticated 512 KiB AES-GCM chunks under tenant/Space/archive/key-version scoped R2 keys, with
16 MiB/object and 64 MiB aggregate bounds. The encrypted manifest stays capped at 8 MiB, rows at
10,000/table and object references at 5,000. Same-request retries recheck source ETags and rewrite stable
chunk keys; restore authenticates chunks and verifies checksums before preview. Rotation writes new-key
chunks alongside old ones, verifies the replacement manifest, switches the record pointer, then removes
old-version chunks. The owner panel and backup runbook expose the current limits and scope exclusions.

Local evidence: Space archive codec/data-ops suites **20/20**, Shell archive panel **2/2**,
Spaces/Shell typechecks and `git diff --check`. Local fixtures cover v1 compatibility, chunk corruption,
interrupted export/retry, restore and rotation cleanup. No deployed R2 or isolated recovery drill ran.
P04 remains PARTIAL for other stores, private inbound data, approved retention/key/jurisdiction policy,
RPO/RTO and isolated/deployed acceptance. P01/P02 resource separation and operator receipts remain
external evidence gates. Keep rollout flags disabled; preserve untracked `infra/scripts/__pycache__/`.

Exact next action: continue P02 at the rendered-resource receipt/preflight boundary. Inspect that exact
contract and close a concrete local validator or reachable-caller gap if present; preserve fail-closed
behavior for actual Cloudflare IDs, service ownership, fresh read-only receipts and operator-attested
D1 baselines. Then proceed through commercial integrity/recovery and remaining P01–P24 plus S3–S9/
U01–U12 requirements without repeating completed audits.

## Previous continuation — 2026-11-14 (P06 inbound Twilio extension cost observations)

Code `6cb043fb56492ecaaffb6fc7e8eb785d09ebfb60` is pushed. The owner dashboard can explicitly read an
admitted inbound Twilio extension Call SID, validating tenant/account/line/caller/direction and the
stored installation/handler pin. Only final valid price/time/currency/duration enter the hashed
provider-cost ledger; missing/pending remains unknown. Twilio says delayed `price` covers connectivity,
not every call feature or a customer invoice. Local evidence was Agents **49/49**, Spaces **18/18**, SDK
**5/5**, typechecks and syntax; no live API read, browser, deployment or acceptance ran. P06 remains
partial for streaming, managed calling, lifecycle, full cost/quality and provider acceptance.

## Previous continuation — 2026-11-14 (template coordination defaults completed locally)

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

Current SpaceDO archives preserve format-v1 reads and use format v1 for captures within 2 MiB per
object/4 MiB total. Larger bounded captures use v2: the encrypted manifest stores chunk descriptors,
while 512 KiB AES-GCM chunks are written under tenant/Space/archive/key-version scoped R2 keys. V2 is
limited to 16 MiB per object and 64 MiB aggregate; the encrypted manifest remains capped at 8 MiB,
rows at 10,000 per table, and object references at 5,000. Source ETags are rechecked and same-request
retries rewrite stable chunk keys before the final manifest is uploaded through the existing resumable
multipart path. Restore authenticates every chunk and checks per-chunk/full-object checksums before
preview, then recreates missing objects without overwriting conflicting bytes. Key rotation writes
new-version chunks alongside old chunks, verifies the replacement manifest, switches the durable
pointer, and then removes old-key chunks. Partial relational restore remains an additive merge; R2
writes and SQLite cannot be atomic together.

Local evidence: format-v1/v2 codec, corruption, interrupted upload/retry, missing-object restore,
key rotation and archive tests are recorded in the historical checkpoints. The current archive suite
passes **17/17**, including revoked-grant omission, extension uninstall preservation, and active-task
replay prevention; task coordination **5/5**, Shell archive panel **2/2**, Spaces/Shell typechecks and
`git diff --check` pass. Restore preserves current destination rows and terminal task statuses, while
newly inserted pending/in-progress tasks are blocked, leases cleared and counts persisted. These are
local Worker/SQLite/R2 mocks; no deployed recovery drill or live R2 durability/retention acceptance
ran. P04 remains PARTIAL for other service stores, private inbound data, approved retention/key/
jurisdiction policy, RPO/RTO, and isolated/deployed recovery.

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
Code `d9d31383` adds bounded expected monthly usage assumptions to the saved Foundry draft and signed
export, with host-side verified-rate recalculation and an explicit author-assumption label. Authors
still cannot set prices or customer budgets, and the editor does not author dependencies/actions.

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
| P01 | PARTIAL | Release runner, ordered fail-closed migration phase, schema probes, manifest gates, and post-Worker `/health`, `/health/dependencies`, and AgentPort health probes before dependent frontend publication are local. `infra/scripts/probe_deployment_health.py`, both deployment workflows, and `infra/scripts/test_probe_deployment_health.py` implement the probe contract; probe tests pass **5/5** and the manifest validator passes. | Operator-attested D1 baselines, isolated staging/production rehearsal, rollback/data recovery and deployed/live acceptance remain. The workflow probes have not been run against a deployment; no migration was applied remotely. |
| P02 | PARTIAL | Resource inventory/preflight is local and fail-closed. Code `174f092c` verifies cross-script Durable Object targets have a named Worker owner in the same environment; `368a2f23` adds the GET-only exact-resource receipt collector; `6040847e` resolves all 56 Worker/environment configurations through Wrangler and compares the resolved resource bindings to the receipt inventory. The checks pass locally but preflight still rejects one shared D1, eleven shared KV IDs, unresolved `naelao-calls`, absent account/time evidence and 158 missing read-only receipts. Actual resource separation/ownership, operator-attested per-D1 baselines and deployed isolation remain external inventory/evidence gates. |
| P03 | PARTIAL | Versioned platform/Product-user outboxes and deterministic Workflow dispatch remain. Migration 0252 scopes Product-user dunning provider outcomes to the exact product/end user/subscription; Notifications rechecks active tenancy, current `past_due` status, provider event version and verified recipient before sending. The authenticated Spaces/Router/Shell caller exposes current subscription, durable outbox status and non-PII provider outcomes (`c4d9b6ca`). Code `9a46241f` adds the stable Product-user in-app notice, exact-actor ProductUserDO storage/read state, authenticated inbox API, Router allowlist, Shell caller, export/erasure handling and queue freshness checks. Code `c40d0421` separately adds a signed builder/platform inbox over `PLATFORM_DB.notifications`, scoped by tenant and platform subject, with bounded pagination, read state and Dashboard caller. Local evidence for the latter is Router **7/7**, Router typecheck and Dashboard typecheck; all inbox stores remain distinct. | Grace/restriction/escalation and retry-cadence policy need product decisions. Provider delivery and deployed/browser acceptance remain external; current implementation evidence is local mocks/SQLite and typechecks. |
| P04 | PARTIAL | Bounded encrypted Space archives include canonical Knowledge state, scoped project/runtime settings, MicroApp data and recovery receipts. Product-user export v3 adds the authenticated profile, ProductUserDO, safe Billing status, exact-user chat from related Product Spaces, bounded signed USER_PRIVATE/SPACE_USER MicroApp snapshots, minimized purchase history (`1bbe8ab6`; earlier `b91a0795`, account erasure `c20d1300`, app uninstall `a4958c70`, notification-store export/deletion `7c765c21`, Billing export `2bec4bc8`). Code `c1eb6c4e` adds a reachable Personal-settings JSON download using the exact Product-user session and no-store request; 413 refuses partial data. Focused client tests **2/2**, Shell typecheck and diff hygiene pass locally. Purchase rows are exact tenant/product/user scoped, capped at ten, and truncation fails closed. Account erasure stays fenced through service cleanup. | Other service/provider/inbound stores; PROJECT_USER and same-identity reinstall contracts; retention/key/jurisdiction decisions; cross-service point-in-time consistency; isolated recovery and measured/deployed RPO/RTO remain. All code evidence is local mocks/SQLite; no deployed restore drill, browser acceptance or live acceptance. |
| P05 | PARTIAL | Signed SpaceBlueprint requirements/review, setup drafts, durable activation/recovery and cost disclosure are local. Knowledge intent flows to created Projects; migration 137 grants are owner-approved and default-empty; 75feeabb prevents grant resurrection. c2963702 adds exact generated-Project cleanup preview/confirmation; 0a4021ba adds bounded durable status. Code `d9d31383` adds signed author-provided workload assumptions, validated export/preview, current verified model-rate recalculation and Shell reuse; this creates no author price, budget or access grant, and total USD remains unknown. Code `5d08d7f1` closes the installed Canvas caller gap for signed business actions: the host shows exact input and requires confirmation, retains same-key retry on uncertain writes, and scopes action lookup to the current allowed Gadget. | Broader uninstall/update effects, complete fixed/metered/provider/runtime rates, license/provider payer and revocation policy, and deployed/live acceptance remain. Space-shared provider links cannot be represented safely: connection rows/routes require project_id, Space-level install currently supports phone only, and signed declarations lack beneficiary, payer, shared-authority and drain/revoke semantics. |
| P06 | PARTIAL | Owner voice dashboards, bounded keypad handlers, signed handler discovery/readiness, per-installation history, synthetic call/DTMF and Twilio speech tests, draft/publish revisions and rollback drafts are local. Twilio and Telnyx calls pin admitted signed installation, handler digest and published settings revision (`7e9d3c2b`). Code `1f429ee9` adds owner Telnyx voice preference, default-off caller consent, durable grant/deny, one-use ticket and a separate WebSocket start-pin validator. Bounded STT/TTS, speech admission, interruption, settlement reconciliation and Telnyx media stream code now exist behind independent default-off rollout and external-acceptance gates; barge-in cancellation preserves call liveness and drops the buffered tail (`8233788b`). | Naelao publisher/key custody, signed catalog/distribution policy, managed provisioning, complete cost/quality evidence, operator controls and deployed provider/carrier acceptance remain. Delayed Twilio connectivity prices are not invoices. |
| P07 | PARTIAL | Code `0da0abdb` adds local-machine owner-declared modality/context/tool profiles, exact authorized-machine lookup and capability-aware private model selection with no cloud discovery/fallback. Profiles are not independent quality evidence. Custom-model capability selection and deployed/provider acceptance remain. |
| P08 | PARTIAL | Audio-track transcription and bounded, separately owner-enabled sampled-frame questions are implemented locally in `87374fc2`. The route verifies task-owned attachment scope, egress, provider enablement, bounded timestamps/dimensions and shared quota, and discloses that motion and video beyond the first 30 seconds may be missed. Deployed Container and Workers AI/provider acceptance remain. |
| P09 | PARTIAL | Imported model lifecycle exists; provider training submission remains disabled pending a verified product/provider contract. |
| P10 | PARTIAL | Signed setup, encrypted drafts, setup-only migrations, paused same-publisher code updates, exact historical rollback, runtime drain, retryable additive Gadget upgrades, owner-approved authority expansion and sequential current-schema pins are local. Code `0866ca38` adds owner-confirmed Gadget code rollback only for an exact prefix of unchanged additive migration histories; receipts retain the schema summary and Shell states schema/data remain forward. Focused migration/update/receipt tests **70/70**, Spaces/Shell typechecks, diff check. Same-Space exact dependency-pin updates are now local (`414ec622`); provider connections, price approval, broader data migration, scanning/retention and deployed/live acceptance remain. |
| P11 | PARTIAL | Development checkout is explicitly gated. `16386d95` adds signed, idempotent platform/Product-user price receipts and Marketplace provider/variant/amount/currency snapshots; live provider-to-entitlement acceptance remains. |
| P12 | PARTIAL | Versioned dunning queue/workflow and provider outcomes exist. Product-user messages now carry exact product/end-user/provider-subscription/version scope; Notifications rejects stale subscription/user/email state before external send and stores exact-scope non-PII provider outcomes. Product users can view their own latest outcomes through the authenticated account path. Retry cadence and grace/restriction/escalation policy, inbox delivery, and deployed/provider acceptance remain. |
| P13 | PARTIAL | Honest interval-health observations/alerts persist; `4de53055`/`d640dbae` route unknown and malformed messages to their configured DLQs. `da6245fe` detects when the Cloudflare GraphQL query hits its 100-row limit and persists a `queue_analytics_row_limit_reached` alert; status remains incomplete. Current backlog/age/DLQ lack a supported source. Admin's consumer targets a different queue, retains raw payload, and has no reachable Router/service-binding path or supported `platform_admin` identity issuance. Generic replay remains uncoded pending those scope, retention/redaction and duplicate-side-effect contracts. |
| P14 | PARTIAL | `product-end-user/logout` generation revocation and builder `/auth/revoke` are now awaited by reachable Portal/Shell/Dashboard callers; failures retain state and show retry. Product reset generation and DO cleanup are durable. localStorage bearer storage, cookie/CSRF/XSS transport decision and deployed copied-token acceptance remain. |
| P15 | PARTIAL | Indexed bounded Blackboard paging has local scale evidence; representative relevance, membership density and deployed acceptance remain. |
| P16 | PARTIAL | Discord event ingress, ephemeral-only exact CDN retrieval, task-scoped storage, capability/setup disclosure, and owner-granted exact-message `read_text`/`read_image` are locally implemented. Image access is limited to one PNG/JPEG/WebP up to 480 KiB and rechecks active install/provider/message and byte signature. Official [Discord Cloudflare Workers tutorial](https://github.com/discord/discord-api-docs/blob/37148620d2324292b76047541d5f8331f81ea77a/developers/tutorials/hosting-on-cloudflare-workers.mdx) documents 403 for ordinary CDN media from Workers and access to ephemeral media. The current attachment schema does not specify the local `ex`/`is`/`hm` signature format, and no authorized real event has verified it. Ordinary media, audio/arbitrary binary, and live provider acceptance remain open; no relay or bypass is implemented. |
| P17 | PARTIAL | Listing identity, freshness, purchase and install handoff are improved. Current trace confirms builder JWTs and Product-user sessions have distinct issuers and subject domains, with no persisted cross-issuer identity link or handoff authority; matching email/browser state cannot safely establish identity. Cross-origin Marketplace-to-Shell SSO remains a product/identity contract gate; accounting policy also remains. |
| P18 | PARTIAL | Product password reset advances security generation atomically; builder/device token and deployed acceptance gaps remain. |
| P19 | PARTIAL | Checked staging queue/workflow names and DLQs are separated from production; actual account resource identities and isolation receipts remain external. |
| P20 | PARTIAL | Fixed-license refunds retain their existing idempotent review ledger. Code `5a462626` and migration 0251 add an evidence-only `subscription_payment_refunded` receipt, exact matching Space/subscription linkage, missing/invalid amount review states, buyer/author status, and an audited operator read. Tests prove duplicate deliveries do not duplicate receipts and refunds do not alter access, paid cycles or earnings. Fixed-license/template access and creator accounting/payout policy, disputes, provider/deployed reconciliation and live acceptance remain unresolved. |
| P21 | PARTIAL | Product-user and builder reset email use encrypted bounded outboxes, retry/cancellation, stable Notification IDs, provider acceptance receipts and HMAC-scoped metadata status. Builder Auth outbox is migration 0245 (`814c429a`); local Auth suite **39/39** and typecheck pass. Unverified-user/session policy, provider/inbox and deployed acceptance remain. |
| P22 | PARTIAL | Document/Space cleanup and semantic-cache deletion status are durable locally; AutoRAG provider-index deletion and deployed store acceptance remain unverified. |
| P23 | PARTIAL | Async and synchronous operation outcomes are persisted locally; approved retention, audited operator replay, remaining receipt coverage and provider/deployed live acceptance remain. |
| P24 | PARTIAL | Exact signed dependency review/install recovery, same-Space archive restore, owner-authorized cross-Space package import and retry, revoked-key rechecks, paused code updates/rollback, runtime drain, durable revocation receipts and installed-package trust warnings are local. Code `0866ca38` adds a bounded owner-confirmed Gadget code rollback with exact additive-history prefix and durable schema-retention receipt. `414ec622` adds exact same-Space dependency pin changes; `00e9f0b2` adds an atomic, idempotent publisher-revocation inbox alert. Cross-tenant artifact rights, broader migrations, scanning/retention and live acceptance remain. |

## S4 source-to-caller correction

`11251168` closes a concrete Router gap found during the active checkpoint: authenticated Shell paths for main runtime profiles, sidecar profile/reset/execution settings, artifact-transfer receipts and workspace retention now reach their Agents-owned handlers before the generic Spaces catch-all. Local Router routing tests pass **4/4**; this establishes only mocked local reachability. Runtime execution and provider acceptance remain disabled/unverified. Code `e747b62d15da7f62405159595636726652de9153` now carries the existing versioned inert restart-recipe settings and main runtime profile through full Space archive recovery. The next joint action is S3/U05 candidate allocation/reservation recorded at the top of this ledger; it must remain unqualified until trusted runtime observations exist.

## Requirement queue

The platform plan's P01–P03, P11–P13, P17, P18/P20/P21 and P23 have now been reconciled against current source.
P02 remains fail-closed as recorded above. Continue in dependency order:

1. Preserve the P01/P02 preflight gates until distinct Cloudflare resources, service ownership,
   read-only resource receipts, and per-database baselines are verified. Do not invent them.
2. Preserve the explicit P03 grace/restriction and P20 refund/author-accounting decisions as open
   product contracts; advance only independent code while they are unresolved.
3. P04's bounded object-byte capture, checksum restore and durable partial retry path are implemented
   in pushed code `937fbdd5`; `c310ae03` adds the currently omitted durable Space assistant workspace,
   learned skills and agent config prefixes, with focused SQLite/R2-mock coverage **11/11**. The
   P04 already includes the jurisdiction-bound WorkspaceCoordinatorDO committed-state archive and
   restore path: current SpaceDO source calls authenticated coordinator export/restore routes, scopes
   referenced objects under the matching jurisdiction prefix, and the focused test covers conflict,
   interruption and retry. No P04 archive-bridge code gap remains from that older queue entry. P03/P20 independent
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
   `96c3da48`. The P05 signed requirement/review slice in `3007890d` is complete; `6d189f45` closes
   direct default-empty per-Project collection grants for Space-shared channels. The guided activation
   handoff now carries the choices to the created Projects as pending intent; the owner still saves a
   grant through the publication-checked migration-137 API. Space-wide provider scope remains a genuine
   authority-contract gap. P22's
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
