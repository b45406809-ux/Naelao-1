## Current K02/K03 checkpoint — 2026-11-17 (bounded PPTX table extraction; pushed as `34800a4a`)

The PPTX parser now emits bounded table cells as explicit slide/table/row/cell entries instead of
flattening them into adjacent slide paragraphs. It limits each table to 256 rows and 64 columns and
the document to 20,000 cells; table content counts against the existing extracted-text bound. Its
parser version advanced to `naelao:pptx-slide-text-table-v2`, invalidating stale preview receipts. The
owner preview warns that tables follow slide body text and merged cells, visual layout, images, notes,
charts and animation remain omitted. Knowledge PPTX/file/PDF-preview suites **13/13**, Knowledge
typecheck and `git diff --check` pass. Local tests only; no browser/deployed/provider acceptance.

This improves structured table text but does not provide visual table coordinates, scanned-image OCR,
confidence or parser-quality evidence. Task attachment OCR remains a separate host path and is not
persisted into Knowledge. Code `34800a4a` is pushed to `origin/Mcbt5s-Backup-2`. Exact next action:
continue K02/K03's
independent PDF page/table provenance and OCR requirements only through a supported reviewed Knowledge
preview path; preserve the existing Cohere Parse default and retrieval path.

## Current K02/K03 checkpoint — 2026-11-17 (bounded PPTX preview; `41904a10` pushed)

Commit `41904a1077ec88d3c9b5ab38c0aa5d4841e61f08` is pushed to `origin/Mcbt5s-Backup-2`. The new PPTX parser extracts text from numbered slide XML in slide order, generates editable slide headings, rejects unsafe XML/entities, and caps archive bytes (5 MiB), entries (512), slides (100), selected XML (4 MiB total/1 MiB per slide) and output text (1 MiB). Space and Project Knowledge forms route PPTX through signed preview, editable approval, source/parser/extraction/approved hashes, storage usage receipts and archive restore. It explicitly warns that notes, images, charts, animation and layout are omitted. Local Knowledge parser/ingestion/archive/telemetry tests **28/28**, Knowledge typecheck, Shell typecheck and file helper tests **5/5** pass. No browser, deployed or provider acceptance.

K02 remains partial: scanned image/OCR ingestion and richer presentation/table extraction are not implemented. K03 remains partial for PDF page/section/table coordinates, confidence and quality evidence; PPTX slide headings preserve basic slide identification only. No OCR or parser accuracy is claimed.

**Reminder to myself:** Continue the whole mission after this checkpoint. Do not stop at a test pass, progress update, commit or push; resume SC03 and then the next independent plan requirement.

Exact next action: continue SC03 by tracing AgentDO object addressing and existing internal routes to design a durable callable authorization check that revalidates the native caller's exact current membership/Project authority after disconnect. Add a durable job authority receipt and Billing admission link only if the callback can preserve current run policy; otherwise keep replay denied and advance to another independent plan gap.

## Previous checkpoint — 2026-11-17 (bounded DOCX and XLSX ingestion; `007b5a8f` pushed)

`0e1a0b06` adds bounded, local DOCX main-body parsing through Space/Project editable preview, scope/source/extraction/parser receipt, save, original-source persistence, workflow chunking and archive restore. `007b5a8f` adds bounded XLSX first-worksheet parsing through the same caller path, resolving shared strings and storing formulas as inert text without cached values. Both retain source/parser/extraction/approved hashes and exact original bytes through archive recovery. XLSX caps: source 5 MiB, 512 ZIP entries, 4 MiB per selected XML part, 8 MiB metadata pass, 10,000 rows, 256 columns and 1 MiB output. DOCX caps: source 5 MiB, 512 entries, 4 MiB XML and 1 MiB text. Local DOCX/PDF/XLSX ingestion/archive/telemetry and Shell preview/file suites **34/34**, Knowledge/Workflows/Shell typechecks and diff check pass. No browser/deployed/provider acceptance.

K02 remains **PARTIAL**: text/Markdown/code/CSV/URL/PDF, DOCX, XLSX and text-only PPTX previews are locally implemented; scanned-image/OCR and richer presentation extraction remain uncoded. K03 remains **PARTIAL** for PDF page/section/table coordinates, extraction confidence and parser/model quality evidence. Do not infer OCR or parser accuracy. Exact next mission action: continue SC03 durable admission/dispatch per the shared-compute ledger, then continue remaining K02/K03 and all other plan gaps. Rollouts stay disabled.

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

## Current K26 checkpoint — 2026-11-17 (source-refresh recovery telemetry; `dc73af2e` pushed)

Alongside the unpriced Billing usage-receipt `sent`/`retry` metric at `550ee028`, `dc73af2e` records fixed-label `interrupted_recovered` and `backoff_active` outcomes from the durable website source-refresh operation ledger. It includes only bounded attempt count; Analytics errors cannot alter recovery/backoff. Remote-verified; source-refresh/telemetry suites **26/26**, Knowledge typecheck and diff check pass. No deployment/live telemetry or invoice acceptance.

K26 still has other existing provider/source failure and cost-reconciliation outcomes to reconcile, plus deployed acceptance. Exact next action: add fixed-label telemetry for owner-approved website preview fetch failure using the safe recorded error category only; continue K10–K30 and other active plans. AI Search remains unselected.

## Current K26 checkpoint — 2026-11-17 (Billing usage receipt retry metrics; `550ee028` pushed)

The existing scheduled website-refresh Billing outbox now emits privacy-safe fixed labels for receipt `sent` or `retry`, with bounded duration and attempt count. Billing receipts remain unpriced and carry no inferred payer or rate; Analytics failure cannot alter delivery or retry persistence. `550ee028` is remote-verified. Focused Knowledge usage/telemetry suites **9/9**, Knowledge typecheck and diff check pass. No deployment, provider invoice, or live telemetry acceptance.

K26 remains partial for source-refresh interrupted recovery/backoff outcomes and deployed telemetry. Exact next action: add fixed-label metrics at the durable source-refresh interruption/backoff boundary, then continue K10–K30 and the other active plans. Cloudflare AI Search remains unselected.

## Current K26 checkpoint — 2026-11-17 (citation and deletion outcome metrics; `ab284ee1` pushed)

Knowledge metrics now cover retrieval, parse preview, scheduled website refresh/lag, Project-access denial, citation delivery/not-found/integrity/unavailable, and deletion pending/complete/busy/error/attempts. They use fixed labels and bounded values; omit raw identifiers/content; and fail independently of the measured operation. `ab284ee1` plus prior telemetry commits through `c9e796c7` are pushed. Relevant tests **62/62**, Knowledge typecheck and diff check pass. No deployed/live acceptance.

K26 remains partial for full source/provider retry recovery and cost/invoice reconciliation metrics. Exact next action: reconcile those paths against authoritative receipt stores, instrument supported fixed-label outcomes only, then continue K10–K30 and the remaining active plans. AI Search remains unselected.

## Current K26 checkpoint — 2026-11-17 (denial and refresh-lag metrics; `0ed5adeb` pushed)

Knowledge now records privacy-safe retrieval aggregates, PDF preview parse outcomes, scheduled website refresh selected/claimed/completed/failed/paused counts and maximum due lag, and Project-access denial categories. Metrics use fixed labels and bounded numbers; raw identities/query are omitted and telemetry failures are isolated. Latest code `0ed5adeb` is pushed; relevant tests **10/10**, Knowledge typecheck and diff check pass. No deployed/live analytics acceptance.

K26 remains partial for deletion/recovery, other denial/citation/provider-cost metrics. Exact next action: add fixed-label deletion/recovery status metrics at the durable cleanup boundary with failure isolation, then continue K10–K30 and other active plans; AI Search remains unselected.

## Current K26 checkpoint — 2026-11-17 (bounded parse/sync metrics; `9476fc1d` pushed)

Retrieval telemetry omits raw tenant/Space/Project IDs and query data; scheduled website refreshes emit fixed-label counters/duration; PDF preview parsing emits fixed-label success/failure/duration. Values are bounded and Analytics failures do not alter operation results. `9476fc1d` and prerequisite `370b99f5` are pushed; tests **9/9**, Knowledge typecheck and diff check pass. No deployed/live analytics acceptance.

K26 remains partial for authorization denials, freshness, deletion, cost and provider recovery. Exact next action: instrument bounded fixed-label authorization denial and freshness/recovery outcomes without sensitive IDs/content, then continue K10–K30 and the other active plans. AI Search remains unselected.

## Current K26 checkpoint — 2026-11-17 (retrieval telemetry excludes private IDs; `67719e1a` pushed)

Knowledge retrieval Analytics Engine and JSON logs now emit allowlisted bounded aggregate metrics with fixed mode/state labels. Raw tenant, Space, Project identifiers and query content are omitted; timings, confidence and counts are clamped and unknown keys dropped. Code `67719e1a` is pushed and remote-verified. Helper test **1/1**, Knowledge typecheck and diff check pass. No deployed/live analytics acceptance; rollouts remain disabled.

K26 remains partial for parse, sync lag, freshness, denials, deletion, cost attribution and provider recovery metrics. Exact next action: instrument current parse/sync boundaries with fixed-label outcomes and failure isolation; continue K10–K30 and all remaining active-plan code gaps. AI Search remains unselected.

# Mature knowledge platform implementation progress

## Resume pointer — 2026-11-17 (PPTX durable workflow provenance; `f2266e64` pushed)

`f2266e64666bc3c375427031074a5ed2622ade5e` is pushed to `origin/Mcbt5s-Backup-2`. Durable
workflow ingestion now applies structured chunking to PPTX and retains slide headings and source
coordinates; shared heading tracking handles skipped heading levels without sparse paths or stale
same-level headings. Local evidence: workflow provenance **1/1**, RAG **6/6**, Knowledge parser /
ingestion **11/11**, relevant package typechecks and diff hygiene pass. No deployed/browser acceptance.
K02 still lacks OCR and richer presentation parsing; K03 still lacks richer PDF coordinates,
confidence and quality evidence.

**Reminder to myself:** Keep implementing the full mission after each checkpoint. Do not stop after tests, documentation, commit or push; continue with SC03 and then the next independent unfinished plan requirement unless the user stops the mission or a real blocker prevents progress.

Exact next action: continue the shared-compute SC03 authority/Billing mapping recorded in
`shared-compute-scheduling-and-budget-progress.md`; do not repeat the TBR07 audit. Then continue
independent Knowledge gaps and the other active plans. Preserve rollout-disabled decisions.

## EP03 checkpoint — 2026-11-17 (Project workflow Knowledge caller + lease; `b3276000` pushed)

Implementation `d1eb47f915a71fec72482fc0045e2c71c0e13b52` plus lease checkpoint `b3276000a8515b5660ca70e10560df8399459640` is remote-verified on `origin/Mcbt5s-Backup-2`. The signed Project workflow can declare `knowledge.search` against explicit owner-published publication IDs; SDK validation requires one current project-member worker role and bounded query/topK/output. WorkflowRunDO pins the durable effect digest and receipt to the current publication revision. AgentDO rechecks the current PROJECT_BOUND installation, exact owner resource grant and publication/revision, then claims SpaceDO's per-resource rate/concurrency lease and releases it on every search outcome. SpaceDO and Shell include Knowledge in staged resource review; staged activation still rejects unsupported Knowledge capability, which remains `unavailable`.

Local verification: Agent SDK tests **38/38**, Spaces extension runtime/install + lease route **38/38**, Shell preview **4/4**; Agent SDK, Agents, Spaces and Shell typechecks and `git diff --check` pass. No deployed/live workflow or provider acceptance. Remaining acceptance is deployed/live validation of this caller and its publication/grant fencing. Rollout remains disabled.

Exact next action: follow the user-directed SC03 priority after the already-recorded TBR07 authority comparison—implement durable compute admission and dispatch with explicit current-authority revalidation, owner status/cancel/retry and recovery before connecting promoted capacity leases. Preserve the separate Knowledge lease gap above and continue all other active requirements.

## Current cross-plan checkpoint — 2026-11-17 (owner-approved website preview failure telemetry; local)

Knowledge website preview failures now emit fixed-label `knowledge_source_preview / owner_approved_fetch` outcomes for every authorized fetch attempt, including first-time previews and refresh previews. Error strings are mapped to a closed set; raw URL/tenant/Project details are omitted; Analytics exceptions cannot change preview status or durable refresh retry state. Local evidence: telemetry + website ingestion suites **28/28**, Knowledge typecheck, `git diff --check`. No deployed/live telemetry acceptance; scheduled Knowledge crawl and refresh rollout flags remain disabled. This slice is local and awaits a safe checkpoint push.

The queue review in the shared-compute ledger confirms automatic replay still needs a durable host invocation contract; the scheduler intentionally does not store commands or secrets. The SC04 comparison found no authoritative configured Space/Project infra-credit budget to enforce. These are separate code/policy gaps, not credential blockers. Exact next action after pushing this slice: resume the newest actionable K10–K30/EP requirement in this ledger by tracing source-to-caller authority and implement the next supported gap; keep AI Search unselected, preserve disabled rollouts, and continue all active plans.

## Cross-plan checkpoint — 2026-11-16 (TBR01 signed proposals; `9ccd7395` pushed)

The role proposal contract/validator and proposal-only owner activation preview are pushed at `9ccd739538f4e0a8751ff9d289385adc5df4661b`; SDK/Security/Spaces tests **11/11**, **6/6**, **26/26**, three typechecks and diff check pass. This does not change K01–K30 status. No deployment or live acceptance ran; rollouts remain disabled. Exact next action across the active mission: TBR02 owner-controlled role authoring via existing template tooling; then TBR04 actual installed-resource preview. Continue K/S/U/P/PW/EP code gaps afterward.

## Latest code checkpoint — 2026-11-16 (K09 bounded website crawl; `0842ac0e` pushed)

The new crawl path uses migration 0277 for owner/grant-scoped URL-only operation/page checkpoints, idempotency, lease generations, TTL cleanup and revocation triggers. It reuses the current site connection, path prefix, robots policy and SSRF-guarded redirect path; page content is sanitized only to compute a hash and is never stored or indexed. Shell selects an explicit URL for the existing one-page preview and review. Page/depth/link/redirect/bytes/time/retry/per-request and two-active-operation tenant caps are enforced. `KNOWLEDGE_WEBSITE_CRAWL_ENABLED` stays false in all Wrangler environments.

Code `0842ac0ecaac5b6e4a99e4602bfba9a96c53bdae` is pushed and remote-verified. Evidence: Knowledge **174/174**, Security **124/124**, Shell Knowledge API **5/5**, Knowledge/Shell typechecks, migration inventory **277**, release/deployment validators, Python migration/deployment/release suites **39/39**, SQLite route/migration/trigger checks, and `git diff --check`. Local tests and SQLite only; migration 0277 is unapplied. No browser, deployed Worker/D1, site-terms provider/policy validation or rollout acceptance occurred. Preserve untracked `infra/scripts/__pycache__/`.

K09 remains partial for an unresolved site-terms contract and deployed acceptance. K08 provider connectors/cursors, aggregate operations and supported provider price contract remain open. K10 upstream file-ACL identity proof remains an uncoded provider integration contract, not a credential block. The template business-role/onboarding plan was added from `28d7c460` and clarification `cdeb7def`; see its dedicated TBR ledger. No signed business-role schema or invitation lifecycle exists. SpaceDO grants Space owner/admin private-Project visibility while Knowledge clearance requires explicit Project membership; retain this as an open policy decision. Autonomous scheduled wakes do not yet have universal separately authorized service identities. Rollouts remain disabled.

Exact next action: implement TBR01's backward-compatible versioned `SpaceBlueprint` role proposal contract and strict validator; constrain symbolic references to the signed template, return proposals through activation preview, and test old-blueprint compatibility and malformed/oversized/conflicting declarations. Do not apply grants or invite users in this slice. Then proceed through TBR02–TBR12 and remaining K/S/U/P/PW/EP work.

## Latest evaluation checkpoint — 2026-11-16 (K14/K17 language-pair evaluation; `d6f6cfb7` pushed)

The existing local Knowledge search integration creates only content-free candidate/citation/source-revision traces and feeds them to the evaluator. The evaluator now reports ranking, citation, stale-version, forbidden exposure, abstention, latency and cost metrics overall, per query language, and per query/source-language pair. Explicit thresholds must pass at all three levels; no default threshold is selected. The output schema is version 2. Codes `4e3c3a7a`, `3d67805e` and `d6f6cfb7` are pushed and remote-verified.

Evidence: evaluator tests **6/6**, local Knowledge search-route integration **6/6**, Node syntax check and `git diff --check`. These are local synthetic/mock checks. The checked-in dataset remains unreviewed English only; no reviewed Shona/Ndebele/domain cases or representative provider/deployed measurement exist. `acceptanceEligible` stays false. No deployment, provider, invoice, migration or rollout ran.

K14/K17 remain `IN_PROGRESS`. Language-pair metric code does not supply actual cross-language retrieval evidence. No native/domain review is recorded. Continue K10–K30 and the managed-services S/U, platform P/PW and EP requirements; keep language rollout gates closed.

## Previous evaluation checkpoint — 2026-11-16 (K17 offline evaluator; `ab01086d` pushed)

The K17 evaluator accepts versioned benchmark cases and content-free ranked result traces. It measures precision/recall@K, MRR, nDCG, citation precision/recall, stale source versions, forbidden-scope exposure, abstention accuracy, p95 latency and recorded cost. It omits query text from reports, detects missing result rows and unreviewed language coverage, and always returns `acceptanceEligible: false` until a separate release gate exists. The v1 dataset is synthetic and English-only; default required coverage includes English, Shona and Ndebele. No search results were measured by the CLI smoke, no human or domain review occurred, and no quality threshold is selected.

Evaluator base code `c908c088871648aa06dcb80a0741bd94d89ed851` and K14 language coverage guard `ab01086d651ff607450411bc66f195dfb018cf8c` are remote-verified on `origin/Mcbt5s-Backup-2`. Evidence: evaluator tests **3/3**, CLI JSONL smoke confirms empty result input is ineligible and reports missing languages, and `git diff --check`. These are offline tests, not search-quality, provider, deployed or multilingual acceptance.

At that checkpoint K17 trace integration and threshold comparison were still open; they are implemented locally in the current checkpoint above. K14 still lacks reviewed representative Shona/Ndebele/domain examples. K10 remains `NOT_STARTED`: source audit found no provider file-ACL connector or verified provider-principal link. MCP connector aliases are tool authorization only and cannot supply a file-ACL identity mapping.

## Latest code checkpoint — 2026-11-16 (K13 shared chunk and citation spans; `90278732` pushed)

Synchronous creates, content edits, and the reachable Project Workflows ingestion now share the RAG package's bounded offset-aware text chunker. Text chunks retain original UTF-16 spans through CRLF normalization; one shared scan maps them to UTF-8 byte and one-based line coordinates. PDF extracted Markdown continues using the bounded structural/table chunker. The reachable workflow's old 10 KiB split is removed; its internal endpoint enforces 2,048 characters per chunk and accepts up to 12,000 indexed chunks under the unchanged 5 MiB input cap. D1 and vector metadata now carry the same absolute source spans. Citation retrieval returns the bounded stored chunk after project authorization and exact content-hash validation, rather than range-reading that chunk file with absolute offsets.

Code `9027873242af4243343d9f834f6dce0c40504fdf` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Local evidence: RAG **28/28**, Knowledge **150/150**, Workflows caller **8/8**, RAG/Knowledge/Workflows typechecks and `git diff --check`. Tests use local mocks; no migration, deploy, browser, live embedding provider, or live citation acceptance ran. `pnpm` safely aborted its automatic modules-directory rebuild after the lockfile change; local binaries were used without modifying `node_modules`. AutoRAG remains hard-disabled under K15 because its authorization/isolation contract is not accepted; it is not claimed as supported.

K13 is `IMPLEMENTED_LOCAL` for synchronous, edit and queued Project ingestion. K08/K09 remain partial for scheduled/incremental refresh, crawler queue and site-terms lifecycle. Exact next action: continue K10 source-to-caller reconciliation for third-party ACLs. Search found no upstream file-identity proof integration; MCP connector aliases grant tool access and do not prove provider file ACL. Implement only a host-verifiable source identity mapping/intersection and fail-closed freshness behavior if a supported identity source exists; otherwise preserve K10 as uncoded and proceed to independent K14/K17 evaluation work. Then continue K10–K30 and S/U/P/PW/EP gaps.

## Latest code checkpoint — 2026-11-16 (K09 owner path and robots policy; `fb6edf25` pushed)

Migration 0273 adds owner-configured Knowledge path prefixes to the host website connection. The owner connector UI and API set/read them at connection creation; existing connections receive `/` as the compatibility default. Knowledge enforces HTTPS, exact approved origins, path-prefix boundaries and robots.txt for the requested page and every redirect. Robots responses are bounded to 256 KiB, use the NaelaoKnowledge product token, honor longest-match/Allow-tie semantics, and fail closed when inaccessible, oversized or unexpected-type. Combined fetch time is bounded to 45 seconds; page fetch remains <=1 MiB, five redirects and safe MIME types.

Code `fb6edf2595394add136fe474c79fd89f1b83ac02` is remote-verified. Local evidence: Knowledge **146/146**, Spaces website-connection route **14/14**, Knowledge/Spaces/Shell typechecks, migration inventory **273**, both manifest validators, Python release/deployment/migration tests **39/39**, SQLite default/backfill exercise and diff check. The full Spaces suite ran **653/657** with four unrelated failures in migration-count, executive-contact, dynamic-page replay and Project membership expectation tests. Migration 0273 is unapplied. No crawler, browser, deployed Worker/D1, provider or live acceptance ran; rollout remains off.

K09 remains `IN_PROGRESS`: only one owner-approved page is fetched per request. A multi-page crawl queue, crawl depth/page-budget UI, site terms registry and scheduler remain uncoded. K08 remains partial for scheduled/incremental refresh and source cursors. K13's reachable sync, edit and Workflow chunking/citation paths are pushed as `90278732`; continue at K10 per the current checkpoint above.

## Latest code checkpoint — 2026-11-16 (K08 bounded website refresh; `7732d992` pushed)

Migration 0272 adds freshness timestamps, retry/error status and a durable website refresh-operation ledger. The Project owner can manually refresh an existing approved page, review/edit its new sanitized preview and commit it with a receipt bound to the exact source revision and active connection. Revision/grant checks fence stale or revoked work; failed updates keep the prior indexed source and use bounded retry/backoff. Fetches abandoned for two minutes are durably marked interrupted and recoverable. Project Shell exposes freshness and retry status.

Code `7732d992a471440ec6271e614705244e8bab59aa` is pushed and remote-verified. Local evidence: Knowledge **141/141**, Shell Knowledge API **3/3**, Knowledge/Shell typechecks, release inventory **272**, both release manifest validators, Python release/deployment/migration tests **39/39**, and diff check. Migration is unapplied; tests use local mocks/SQLite. No browser, deployed Worker/D1, scheduler, provider, or live acceptance ran. Rollouts remain off and Cloudflare AI Search remains unselected.

K08 remains `IN_PROGRESS`: there is no scheduled/incremental sync, cursor/checkpoint/change detection, source cost reporting or operational dashboard. K09's path-prefix and robots work is recorded above; bounded crawl and site terms remain open. Continue at K10 per the current checkpoint above. Keep rollout disabled.

## Latest code checkpoint — 2026-11-16 (K07 owner-approved website snapshot; `99f9081c` pushed)

Project owners can preview a single page through the exact active host-owned `website_connections` grant. Knowledge validates owner/Project/origin, checks SSRF on each of at most five redirects, bounds and sanitizes HTML/Markdown/plain text, then signs a 15-minute receipt bound to the owner, connection, URLs and preview hash. Project Shell lets the owner review/edit and create the snapshot through idempotent ingestion. Migration 0271 requires a connection reference/grant revision for current website sources and caps each connection at 100 pages. Publication, search and citations check current connection status; revoke blocks results immediately and enters durable document deletion. The Space caller also revokes browser state when Knowledge cleanup throws.

Code `99f9081ced263c219831757c2d504124050a5ff5` is pushed and remote-verified. Local evidence: Knowledge **131/131**, Spaces website-connection suite **11/11**, Shell Knowledge API **2/2**, all three typechecks, release inventory **271 migrations**, standalone SQLite trigger check, and `git diff --check`. Migration 0271 is source-only/unapplied. These are local mock/SQLite tests; no browser, deployed Worker/D1, provider, scheduled sync or live acceptance ran. Rollouts remain off; preserve the unrelated untracked `infra/scripts/__pycache__/`.

K07 remains `IN_PROGRESS`: the implemented adapter is an owner-approved manual single-page snapshot, not a logical connector registry, provider connector or scheduled refresh. K08 cursors/checkpoints/retries/freshness UI remain uncoded. K09 still lacks an approved path/robots policy and durable crawl lifecycle. Exact next action: implement K08's durable provider-neutral website refresh state and owner-visible freshness/retry status, fenced by source revision and active connection grant; test duplicate/lost replies, out-of-order completion, revoke during refresh and deletion. Then continue K09/K10–K30 and the S/U/P/PW/EP gaps. AI Search stays unselected and rollouts disabled.

## Latest code checkpoint — 2026-11-16 (K07 versioned source lineage; `3bf31c66` pushed)

Migration 0270 adds adapter kind, source revision/hash/state and opaque host connection/grant references to canonical `kb_documents`. Existing sources backfill; manual creation persists a content hash and version; content edits advance both; deletion revokes/clears the private source lineage; archive export/restore preserves it. URL-backed entries are marked unsupported for refresh until a scoped website adapter exists. Public document responses omit hashes and connector references. Code `3bf31c665451aceb48aa047680d67309524cac00` is remote-verified. Knowledge **121/121**, typecheck, SQLite backfill/connector guard/idempotent insert/archive insert checks, `git diff --check`, and release migration inventory (**270** files through 0270) pass. Migration is source-only/unapplied; no live acceptance ran.

K07 remains `IN_PROGRESS`: there is no logical source registry, host connector-grant issuer/verification caller or durable website refresh path. Exact next action: connect the existing host-owned `website_connections` grants to a bounded, redirect-revalidated Knowledge fetch/create caller; persist its approved connection reference/revision only after owner, Project and origin authorization. Test cross-origin denial, redirects, revoke, retry and deletion. Continue K08/K09 and K10–K30 plus remaining S/U/P/PW/EP gaps. Keep rollouts off; Cloudflare AI Search remains unselected.

## Latest verified checkpoint — 2026-11-16 (K06 attachment/channel scope; current code `0642ece4`)

Ordinary chat uploads remain task-scoped and are not written into Knowledge/publication membership. Extension attachment listing and reads require the exact active tenant/Space/task/channel/Project/install/provider-connection scope, declared limits, and active binding; answer generation consumes them only as transient current-message context. Web, WhatsApp and email share the same channel path, which re-reads active Project publication revisions, checks the exact Space-shared owner grant when relevant, and calls revision-fenced Knowledge search. Phone extensions reject nonempty Knowledge declarations, so voice Knowledge remains unsupported and fails closed. Local evidence: Agents attachment/store/upload/selection/phone tests **29/29**; Knowledge publication suite **9/9**. No code changed in this audit, no browser/provider/live acceptance ran.

K06 is locally satisfied for scope enforcement; voice Knowledge availability is an unsupported capability gap, not a grant bypass. K05 remains `IN_PROGRESS` for generic collection ownership transfer and retention semantics. Exact next action: implement K07's provider-neutral versioned source record and host-held connector grant on the existing `kb_documents` authority; wire manual text/URL creation to that lineage and add scope, retry/idempotency and deletion coverage. Then continue K08 and K09–K30 plus S/U/P/PW/EP gaps. Cloudflare AI Search remains unselected; all rollouts remain off.

## Latest cross-plan pointer — 2026-11-16 (K05 publication lifecycle audit and ID retirement; code `890b2a55` pushed)

K05's Project collection API and Shell now expose owner/admin content-free lifecycle events for publish, source update, archive, restore-as-draft and delete. Delete preserves a scoped tombstone, permanently retires that collection ID and prevents stale revision-pinned grants from reviving after delete/recreate. Code `890b2a55a56be746a1018016e63504f536795bab` is remote-verified. Local Knowledge **120/120**, Shell API **1/1**, both typechecks, diff check and SQLite migration/API tests pass. Migrations 0268–0269 are not deployed.

K05 remains `IN_PROGRESS`: collection authority follows its Project; generic transfer semantics and a retention schedule have no settled product contract. The admin history view covers collection lifecycle only; extension-sharing grant history remains in its existing SpaceDO ledger. Exact next action: continue K06 by tracing ordinary conversation attachments and voice/web/email/WhatsApp Knowledge callers; prevent implicit attachment promotion and close any caller that fails the current scoped-grant/revision fence. Continue K07–K30 and the S/U/P/PW/EP gaps afterward. Cloudflare AI Search remains unselected.

## Latest cross-plan pointer — 2026-11-16 (K05 separate discover/source-read APIs; code `0c93eade` pushed)

Project collection discovery no longer returns source document IDs. A distinct authenticated, no-store `/sources` read route validates Project membership, active collection revision and indexed source scope before and after loading IDs. The Shell retrieves those IDs only when editing and verifies the version. Extension `use` remains a separate revision-pinned grant. Code `0c93eade2e3c861cd7d5ff254589c7c7ded380fc` is remote-verified; Knowledge **119/119**, Shell API **1/1**, both typechecks and SQLite-backed member/cross-Project/archive/revision tests pass. No deployment or live acceptance ran.

K05 remains `IN_PROGRESS`: archive/restore-as-draft is pushed at `1e76c55c`; generic ownership transfer, retention policy and owner/admin audit history are open. Exact next action: add a separately authorized `administer` events API and Shell view for bounded content-free lifecycle events. Then continue generic ownership/retention contract resolution and K06–K30 plus remaining S/U/P/PW/EP requirements. Cloudflare AI Search remains unselected.

## Latest cross-plan pointer — 2026-11-16 (K05 versioned publication archive lifecycle; code `1e76c55c` pushed)

Project Knowledge collections now have owner/admin archive and restore-as-empty-draft operations with expected-revision CAS. Archive advances revision, stores a content-free actor/action receipt, detaches source membership and excludes the collection from active extension-grant lookup and retrieval. Restore does not republish or restore old grants. The Project Shell exposes both actions. Code `1e76c55cefc32df646cc49c0166cd7ea40e65a58` is remote-verified; Knowledge **119/119**, Knowledge/Shell typechecks, SQLite-backed migration/API tests and diff check pass. Migration 0268 is unapplied; no live/deployment acceptance ran.

K05 remains `IN_PROGRESS`: ownership transfer, retention schedule and distinct discovery/source-read/admin API boundaries remain open. Exact next action: return metadata only from the collection-discovery list and add an explicitly authorized source-membership read endpoint used by the Shell editor. Keep extension `use` separate and revision-pinned; test role/scope/archive boundaries. K06–K30 and remaining S/U/P/PW/EP requirements remain open. Cloudflare AI Search is unselected.

## Latest cross-plan pointer — 2026-11-16 (EP02 durable Project jobs broker; code `248d3838` pushed)

EP02's signed Project/install `jobs` requirement now reaches the WorkflowRunDO journal, exact owner grant/release fence, durable D1 ledger, scoped R2 payload, owner-approved Billing reservation and Agents `AGENT_TICKS` dispatcher. Stable idempotency and child identity, bounded payload/deadline/retries, active concurrency/rate, grant revision, status, lost-start reconciliation and cleanup are locally implemented. Code `248d3838fbfa9314eae0ae9f854f655328c8cc06` is remote-verified. Agents **47/47**, SDK **44/44**, both typechecks and diff check pass; migration/conditional admission was exercised in SQLite. Migration remains unapplied, no live/deployed acceptance ran, and job/resources/retrieval rollouts stay disabled.

K05 remains `IN_PROGRESS`; this EP02 code does not change any K01–K30 status. Exact next action: add versioned archive/unarchive to the current Project collection publication authority, suppress archived collections from discovery/retrieval, invalidate use grants, and require explicit republish/reapproval before exposing content again. Add reachable owner caller and CAS/authorization/stale-grant/retrieval tests. Generic ownership transfer, retention policy, K06–K30 and remaining S/U/P/PW/EP work remain open; Cloudflare AI Search is unselected.

## Latest cross-plan pointer — 2026-11-16 (EP02 signed jobs contract and owner review; code `90088bd7` pushed)

EP02 adds a Project-scoped, signed-workflow jobs requirement plus exact install-generation owner grant review; local SDK **37/37**, Spaces **33/33**, SDK/Spaces/Shell typechecks and diff check pass. Code `90088bd79445d4b135f63cb953137fdeaeaf7f4b` is remote-verified. The host dispatcher, durable job status, bounded active concurrency/deadline/retry and uncertainty cleanup are still uncoded; no K01–K30, retrieval, ACL or AI Search status changed. Resource and retrieval rollouts remain disabled.

Exact next cross-plan action: continue EP02 with durable job persistence/dispatch/status through the existing Agents queue and owner-approved budget, then resume K05 lifecycle and K06–K30. Keep AI Search unselected and distinguish code from deployed/provider acceptance.

## Latest cross-plan pointer — 2026-11-16 (EP02 owner-approved installation budgets; code `50566cd6` pushed)

EP02 now has owner-authorized per-install run/monthly credit caps wired through SpaceDO resource review, the Shell, WorkflowHost and Billing's tenant/per-install held-plus-settled admission. The owner policy is generation/revision pinned and changes invalidate resumed workflow authorization. Code `50566cd661900917682828beea368fb135531c81` is remote-verified. Local evidence: Spaces **39/39**, Billing **19/19**, Agents **39/39**, Shell API **1/1**, four typechecks and diff check. No K01–K30, Knowledge retrieval/ACL/provider status changed; AI Search remains unselected. No deployed migrations, Worker, browser, provider/invoice or live acceptance ran; resource descriptors remain unavailable.

Exact next cross-plan action: implement the scoped EP02 jobs adapter and durable receipts using the new owner-approved budget path. Continue K05 lifecycle and K06–K30 after that; byte/storage pricing remains an unresolved product decision, not a credential blocker. Keep retrieval and resource rollouts disabled.

## Previous cross-plan pointer — 2026-11-16 (EP02 run budget admission and resource unit metering; code `15f704fe` pushed)

Vertical-extension external effects now reserve one canonical workflow-step credit per in-flight action against the existing workflow run budget. The journal rejects missing/exhausted budgets, accounts for concurrency and preserves completed/unknown receipts; Billing's workflow reservation remains the tenant quota authority with Project/installation attribution. Request/byte/job quantities are persisted idempotently. Byte usage is explicitly unpriced because no approved byte/storage rate exists. Code `15f704feee462d75a1f07a70aea36455bf4e3373` is pushed; local Agent suites **27/27**, Agent/SDK typechecks and diff check pass. No migration, Billing integration, deployment or live acceptance ran. No K01–K30 or Knowledge retrieval/ACL/provider requirement changed; AI Search remains unselected.

Exact next cross-plan action: add owner-authorized per-install budget configuration to the current resource review path and make workflow execution resolve that authority rather than accept a caller-selected ceiling. Test revocation, replay, concurrent reservations and unknown outcomes; then continue EP02 jobs and open Knowledge/platform requirements. Byte/storage pricing remains an explicit product decision, not a credential blocker. Keep all resource capabilities and rollouts disabled.

## Previous cross-plan pointer — 2026-11-16 (EP02 versioned object archive recovery; code `326779c1` pushed)

The Project object path now has bounded operation calls and a version-1 Space archive snapshot/restore. Restore checks the existing signed installation, exact generation and resource digest, preserves current values, respects quotas/tombstones and never restores owner grants or active leases. Code `326779c1bc7fcab9ce7f66a2328ffe670a5b43da` is pushed and verified; local archive/backup tests **30/30**, Spaces typecheck and diff check pass. No Knowledge retrieval/ACL/collection/provider requirement or K01–K30 status changed; Cloudflare AI Search remains unselected. No migration/deployment or live recovery acceptance ran, and all resource capabilities remain unavailable.

At this archive checkpoint, budget tracing and admission remained open; the later run-level admission and unit-metering slice is recorded above. Owner-approved per-install budget and byte/storage rate policy remain open, followed by EP02 jobs and K05 lifecycle/K06–K30 plus other plan gaps.

## Previous cross-plan pointer — 2026-11-16 (EP02 bounded Project object runtime; code `ee7390e8` pushed)

The object workflow now reaches a separately scoped SpaceDO table through exact signed Project install/grant checks, single-use leases and bounded per-install quotas. Object rows are deliberately excluded from Space archives while snapshot/restore is uncoded. No Knowledge retrieval, ACL, collection authority, AI Search evaluation or K01–K30 status changed. Local SDK/Spaces/Agents suites pass **36/36**, **47/47**, **14/14**; affected typechecks and diff check pass. Commit `ee7390e861afd66bfcb14e551d8662c4dcb2f1be` is pushed. No migration/deployment, archive/live/provider acceptance ran; all resource capabilities remain unavailable.

Exact next cross-plan action: add versioned object snapshot/restore with Project/install generation checks and archive coverage tests. K05 broader lifecycle and K06–K30 remain code work; AI Search remains unselected.

## Previous cross-plan pointer — 2026-11-16 (EP02 Project object grant staging; code `82bbee1e` pushed)

The Project owner review caller can now record operation-only approvals for staged Project-scoped object requirements without granting bucket paths or activating runtime access. Code `82bbee1ecfb261a727c398978ea5c90135ef4731` is pushed. Latest delta evidence: Spaces **50/50**, Shell API **1/1**, affected Spaces/Shell typechecks and diff check. No Knowledge retrieval, provider, collection authority, D1/SpaceDO migration or live acceptance changed. All resource capabilities remain unavailable.

Exact next action is the separate EP02 scoped R2 object operation/lifecycle adapter and cleanup. K05's broader collection lifecycle and K06–K30 remain code work; AI Search stays unselected. Preserve Naelao's ACL, tombstone, publication and retention authority.

## Previous cross-plan pointer — 2026-11-16 (EP02 owner-reviewed structured-data grants; code `aa290198` pushed)

The structured-data resource grant ledger and Project owner review caller are implemented through the existing Gadget/MicroApp route, with current grant/install checks, serialized bounded operation leases and content-free usage receipts. Code `aa290198532b2c7a47878b69d7528c04ce5685e1` is pushed. Local SDK/Spaces/Agents/Router/Shell suites passed **36/36**, **50/50**, **21/21**, **75/75**, **1/1**; affected typechecks and diff check passed. No Knowledge retrieval/provider implementation changed; no D1/SpaceDO migration, deployment, browser, provider or live acceptance ran. All resource capabilities remain unavailable and rollout is disabled.

Exact next action remains the independent EP02 object-resource adapter against scoped R2 ownership and lifecycle. K05's broader collection lifecycle and K06–K30 remain code work; AI Search stays unselected. Preserve the current ACL, tombstone, publication and retention authority.

## Cross-plan pointer — 2026-11-16 (EP02 structured-data workflow bridge; code `66fdbd2e` pushed)

The latent structured-data workflow call now resolves the signed manifest and worker-role grant, uses the durable WorkflowRunDO effect journal and dispatches through the existing scoped Gadget route. Local SDK/Agents/Spaces suites passed **36/36**, **31/31**, **35/35**, with all three typechecks and diff check. Commit `66fdbd2e3e8ebf295fcb8892de0c7338a86ab9a3` is remote-verified. No resource grant issuer/owner lifecycle is complete; all resource kinds remain unavailable and no Knowledge retrieval/provider path changed. Exact next task: owner grant persistence/revoke fencing and reachable approval callers, then return to K05 lifecycle and K06–K30. Keep AI Search unselected and rollouts disabled.

## Cross-plan pointer — 2026-11-16 (EP02 run-scoped receipts; code `27f571d0` pushed)

Existing workflow Gadget effects now carry content-free input/result hashes, byte counts, installation/project/actor identity, outcome and measured credits in the durable run journal. This adds no Knowledge grant or retrieval path. Workflow tests **19/19**, SDK/Agents typechecks and diff check pass. Grant registry, resource SDK caller and live acceptance remain open; resource kinds stay unavailable.

Exact next action: continue EP02 with exact-manifest owner grant persistence and runtime resource dispatch, then resume K05 lifecycle and K06–K30. Keep AI Search unselected and rollouts disabled.

## Cross-plan pointer — 2026-11-16 (EP02 contract slice; code `6871563e` pushed)

Structured-data resource declarations are now restricted to a bound PROJECT_BOUND Gadget and the signed workflow role's exact operations/tables. This does not change Knowledge backend selection or retrieval authority. Code `6871563ea9e70019c42d98a88eabf6b3daf0707c` is pushed; SDK **36/36**, SpaceDO install **32/32**, SDK/Spaces typechecks, and diff check pass. Resource kinds remain unavailable; no broker, grant/usage ledger, deployment or live acceptance exists.

Exact next action: continue EP02 by implementing durable grant/operation receipts around scoped MicroAppDO calls, then return to open K05 lifecycle and K06–K30 work. Keep Cloudflare AI Search unselected and all rollouts disabled.

## Latest cross-plan checkpoint — 2026-11-16 (EP01 SDK/resource admission; code 9abf5efa pushed)

EP01's versioned resource requirements, host-grant/client types, scoped schemas, idempotency, quotas, status and metering units are implemented in the Agent SDK. A labeled simulated harness supports local authoring. Spaces exposes an authenticated capability catalog; SpaceDO denies resource-bearing installs while the host broker is absent. The `objects`, `structured_data` and `jobs` kinds remain unavailable, so this adds no Knowledge retrieval provider or authority path.

Code `9abf5efa36231a96bf8e337a2fb7b702cf672954` is pushed and remote-verified. Local evidence: SDK tests **35/35**, SpaceDO extension install tests **32/32**, SDK/Spaces typechecks and `git diff --check`. No deployment or live acceptance. Rollouts stay disabled.

Exact next action: trace Project bundle install and workflow Gadget RPC to existing scoped MicroAppDO storage and implement the first EP02 durable structured-data grant/operation ledger, including exact owner review, idempotent writes, revocation fencing and usage receipts. Keep catalog support unavailable until the trusted runtime caller is complete. K05 lifecycle and K06–K30 plus S/U/P/PW gaps remain active; Cloudflare AI Search stays unselected.

## Latest checkpoint — 2026-11-16 (K05 revision-pinned collection authority; code cb0a63fb pushed)

Owner-published Project collections now have durable monotonic revisions. Membership rows carry the exact revision; owner edits use expected-revision compare-and-swap and atomically replace membership behind a mutation token. Content reindex and document removal bump each affected collection and update surviving membership under the new revision, invalidating prior extension approvals. SpaceDO grants store/audit the exact publication revision. The reachable Shell displays revision and stale grants and requires owner resave to approve changed membership. Before every external channel search the Agent host rereads the current publication and, for Space-shared installations, the active installation grant; Knowledge checks the expected revision before vector ranking and again before returning chunks. Stale, revoked, replaced or cross-scope publications fail closed.

Code `cb0a63fb3f3fe2f9ad78b962323c4121f60b1496` is pushed and verified on `origin/Mcbt5s-Backup-2`. Local evidence: Knowledge **117/117**, Spaces/SpaceDO **43/43**, Agents grant resolver **5/5**; Knowledge, Spaces, Agents and Shell typechecks; release migration tests **20/20**; schema/deployment manifest validators; real-SQLite migration, replacement, source-change, source-removal, stale-grant and post-ranking revocation tests; and `git diff --check`. No D1/SpaceDO migration or Worker deployment, browser, provider, invoice or live acceptance ran. Keep rollouts disabled and preserve untracked `infra/scripts/__pycache__/`.

K05 remains `IN_PROGRESS`: the existing owner publication and grant paths now have explicit discover/manage/share/delete/use boundaries and revision pinning, but generic collection ownership transfer, full lifecycle/retention APIs and the broader separate read/discover/admin contract remain incomplete. K18 gained revision/stale-grant recovery UI. K20/K21 now fence channel use and source changes at the collection revision boundary; response caches remain disabled. No provider credential blocks this code.

Exact next action: implement EP01's versioned resource/capability contract in `packages/agent-sdk`, then connect it to real install/runtime gatekeeper callers. Support backward-compatible manifest adapters, declared resource requirements, effective host grants, actual runtime support, scoped operation schemas, idempotency, quotas/status/metering and harness fixtures. Add package and caller tests. Continue EP02 resource broker; retain the K05 lifecycle/K06–K30 and S/U/P/PW gaps in the queue, and keep EP03 behind current owner-published collection and grant checks. Cloudflare AI Search remains unselected.

## Latest checkpoint — 2026-11-16 (K04 create idempotency; code 4f390061 pushed)

Every Knowledge document-create request now requires a 16–128 character URL-safe client key. The Worker stores only its SHA-256 under tenant/Space/Project scope and atomically claims the key with the document row; a canonical request digest binds source bytes, title/source metadata, PDF parser/extraction/approved text and ACL. Exact retries return the same document state; changed content or ACL conflicts. Large Project uploads persist `claimed`/`dispatching` state, can restage after a pre-dispatch failure, retain staged bytes after uncertain Queue acknowledgement, and retry with stable storage-usage keys. KB Workflows use `docId` as deterministic instance ID. Final deletion atomically tombstones the key and clears the request digest under the deletion lease. Shell and Dashboard preserve the same key across form retries and clear it only on success, changed input or a failed prior attempt.

Code `4f390061c4bea4b032eaf3a205e76293a4f226a0` is pushed and verified on `origin/Mcbt5s-Backup-2`. Local evidence: Knowledge suite **111/111**, Workflows queue suite **12/12**, Knowledge/Workflows/Shell/Dashboard typechecks, release migration tests **20/20**, release manifest tests **5/5**, both release/deployment manifest validators, migration 0264 DDL plus exact atomic claim/conditional document insert SQLite smoke, and `git diff --check`. No D1 migration was applied, no Worker/Queue/Workflow was deployed, and no billing/provider/browser/live acceptance ran. The untracked `infra/scripts/__pycache__/` remains untouched; all rollouts are off.

K04 is `IMPLEMENTED_LOCAL`, not live accepted. A synchronous process crash before completion can still leave the existing `processing` row for reconciliation; this change deliberately returns the same state and does not re-embed on an exact retry. Deployed D1 transaction/concurrency and real billing deduplication remain acceptance gates. K05–K30 and EP01–EP06 remain active code/reconciliation work.

Exact next action: close K05's uncoded general collection authority by tracing and extending the existing `kb_external_publications` plus `extension_project_knowledge_grants` model, not creating a parallel collection store. Add versioned collection/source membership and explicit discover/read/use/manage/share/delete/admin capability checks at the real API and extension callers, while keeping owner publication and Naelao tombstone/ACL authority. Add cross-scope, revocation, replacement and stale-revision tests. Then continue K06–K30 and EP01–EP06. Keep Cloudflare AI Search unselected and disabled.

## Related-plan reconciliation — extensible resources (2026-11-16; source e950f02b)

The plan at `plan/microapps-ui-sdk-voice:e950f02bdf0726f05db456a50ef29699e200d3b3` is copied to `extensible-platform-and-managed-resources-plan.md` and its requirements are in platform §15/EP01–EP06. Current code already provides owner-published Project Knowledge subsets and restricted channel retrieval, but not the generic parser/index/retrieval extension API, host resource broker, or complete dashboard/test/publish/revoke lifecycle. Reuse K01–K30 rather than duplicate those requirements. Cloudflare AI Search remains an unselected, disabled candidate under K15/K16; Vectorize plus D1 FTS is unchanged pending ACL, lifecycle, quality and cost acceptance. This is local source reconciliation only.

## Latest checkpoint — 2026-11-15 (K02/K03 PDF preview and provenance; 08d9c509 pushed)

Code `08d9c509a9ab2a9b8e66e4fa4707bc1d2e442324` is pushed and verified on `origin/Mcbt5s-Backup-2`. All three reachable Space/Project Knowledge upload forms now offer bounded PDF parse preview, warnings, explicit editable approval and source-file binding. Knowledge Worker uses a short-lived HMAC receipt scoped to tenant/Space/Project and exact source/extraction hashes; it stores the original PDF, parser version, extraction hash and approved-content hash. Archive export/restore preserves these fields and checks the raw PDF hash. Migration 0263 is included in release schema/deployment manifests; nothing was applied or deployed.

Local evidence: Knowledge suite **104/104**, Shell PDF selection helper **3/3**, Knowledge/Shell/Dashboard typechecks, SQLite DDL smoke, release/deployment manifest validators, release migration tests **39/39**, and `git diff --check`. These are local Worker/SQLite and mocked Cohere checks. No browser, live parser, D1/Worker deployment, invoice or production acceptance. AI Search remains unselected and disabled. Keep rollouts off and preserve `infra/scripts/__pycache__/`.

K02 is implemented locally for supported text/code/CSV, existing URL support and PDF. K03 remains partial for rich page/section/table provenance and parser/model quality evidence. Office/image/OCR formats remain uncoded. K29/K30 live provider/invoice/deployed acceptance remain external gates, but no credential gate blocks the independent code work.

Exact next action: implement K04 durable idempotency for create requests. Bind an explicit client request key to tenant/Space/Project, source bytes/text, approved extraction and ACL. Replayed identical requests must return the same document status and avoid reparse, duplicate index writes or duplicate storage billing; key reuse with a different canonical request must conflict. Cover both synchronous and queued ingestion, lost response and concurrency, without bypassing deletion fences. Then continue K05–K30 and other S/U/P/PW gaps.

## Previous checkpoint — 2026-11-15 (PW06 worker cancellation fenced; 79d671a3 pushed)

Code `79d671a329b056c3cd2e861aeabb3996e488de9d` fences late worker responses and signed session updates by durable status and attempt. Local cancellation/integration tests **20/20**, Agents typecheck and `git diff --check` passed. The cross-DO race after publication is already accepted by Artifact Worker/Workspace Coordinator remains a lifecycle contract gap; no deployed acceptance. Preserve untracked `infra/scripts/__pycache__/` and keep rollouts disabled.

Exact next action: close K02/K03 by adding a file-hash-bound, bounded PDF parse preview and correction step to both reachable Knowledge add forms using the current PDF parser. Preserve Space/Project size and scope limits, display extraction warnings, and cover the real caller/API lifecycle. Continue K04–K30 and other active-plan gaps afterward.

## Previous checkpoint — 2026-11-15 (K01 limits, K11 independent FTS and K20 cache containment; 1041cd0 pushed)

Source plan `mature-knowledge-platform-plan.md` was fetched from `plan/microapps-ui-sdk-voice` commit `9358830e` and copied verbatim to this branch (SHA-256 `2b36b7483040b8e62836eadc66f8d14bf83825b761b7436a919a66e69f71ebb2`). No branch switch or merge occurred. Requirements K01–K30 are incorporated into platform plan §14. Code `1041cd0ffe58b212d11329a9ea0f4d155c4d3780` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`; source baseline inspected at `89b428f8`.

### Source reconciliation matrix

Statuses describe local code, not deployment or live acceptance. `IN_PROGRESS` means code or evidence is still being added; `IMPLEMENTED_LOCAL` means source and a reachable caller exist; `BLOCKED_EXTERNAL` is reserved for an actual external acceptance gate. A code gap is never called credential-blocked.

| ID | Status | Current source evidence and remaining action |
| --- | --- | --- |
| K01 Scope-specific ingestion limits | IMPLEMENTED_LOCAL | Shared UTF-8 byte helper and `createKbDocument` guard match backend's 1 MiB Space-wide and 5 MiB Project workflow limits. Both add forms check pasted text and selected text files and display the scope limit. Helper tests 3/3; Shell typecheck passed. |
| K02 Supported formats and preview | PARTIAL_LOCAL + PROVIDER/LIVE GATE | Text/Markdown/code/CSV/URL, scoped reviewed PDF, bounded DOCX, first-sheet XLSX, text/table PPTX and a reviewed PNG/JPEG OCR caller are wired with source/parser/approval lineage and archive restore. Image parsing defaults off in all Wrangler environments pending provider contract, privacy, quality, cost and live acceptance. Scanned-PDF OCR and richer visual presentation extraction remain uncoded. |
| K03 Parser safety and provenance | PARTIAL | PDF/DOCX/XLSX/PPTX parser output and human-approved text have distinct hashes; parser version, original source and archive lineage persist. CSV/XLSX preserve table text under explicit display bounds; PPTX labels slide number and bounded table row/cell indices. PDF page geometry, visual table coordinates, confidence and parser/model quality evidence remain open. |
| K04 Idempotent durable ingestion | IMPLEMENTED_LOCAL | Required scope-bound request key and canonical request hash are atomically claimed with the row; sync and queued same-key retries converge, altered content/ACL conflict, Queue dispatch is deterministic/recoverable, usage keys are stable, and final delete preserves a request tombstone. Knowledge 111/111, Workflows queue 12/12, four package typechecks and migration/release checks pass. Deployed D1 concurrency, billing dedupe and synchronous crash recovery remain unaccepted/open. |
| K05 Collection authority model | IN_PROGRESS | Project publications have monotonic revisions, versioned membership, CAS edits, revision-pinned grants, archive/restore-as-draft, metadata-only discovery, separate source reads, and owner/admin lifecycle history. Delete writes a content-free receipt and scoped tombstone so IDs cannot reset to an old grant revision. Extension-sharing grants now expose the last 20 content-free changes (selection IDs/revisions, actor, timestamp) to the owner/admin Shell. Generic ownership transfer, retention schedule and post-uninstall historical view still need policy/lifecycle decisions; deployed acceptance remains open. |
| K06 Attachment and channel scope | IMPLEMENTED_LOCAL | Chat uploads remain task-scoped and never enter Knowledge publication membership. Extension attachment reads are exact-message/install/provider-bound and transient. Web/WhatsApp/email share the current publication/revision grant fence; phone extension Knowledge declarations are rejected. Agents **29/29**, Knowledge publication **9/9**. No live channel acceptance; voice Knowledge remains unavailable. |
| K07 Manual/site/connector source adapters | IN_PROGRESS | Migration 0270 lineage and owner-approved single-page website snapshot/refresh are implemented. The page receipt binds tenant/Space/Project/user/connection/URLs/hash; source create persists the active host connection reference and grant revision; retrieval/citations/publications check live connection status, and revoke starts durable deletion. Provider connector adapters and a general source registry remain open; local implementation is not deployed acceptance. |
| K08 Incremental sync and freshness | IN_PROGRESS | Migrations 0272/0275 implement manual and owner-opted daily/weekly one-page refresh with leases, missed-tick recovery, current owner/grant checks, revision-fenced indexing and unchanged-hash detection. Migration 0276 adds a durable unpriced invocation outbox; Billing v2 idempotency and Project usage summary expose unassigned/unpriced receipts without subscription metering. Project Shell exposes freshness, next run and last schedule result/error. Knowledge 166/166, Billing receipt/summary 20/20, affected typechecks and release/migration tests 39/39; inventory 276. Migrations 0275/0276 are unapplied and schedule activation remains false in every Wrangler environment. Provider connectors/cursors, aggregate operations and a supported price contract remain uncoded/unaccepted. |
| K09 Website refresh security | IN_PROGRESS | Migration 0273 retains owner-configured path prefixes; manual/scheduled one-page refresh and the new migration 0277 crawl preview enforce HTTPS, same origin/path, robots and SSRF at each redirect. Crawl caps 8 pages/depth 2/100 links per page/5 redirects/512 KiB per page/2 MiB total/20 seconds/two active operations per tenant; durable owner/grant-scoped URL/hash checkpoints expire after 7 days and are deleted on connection policy change or owner demotion. Text is not stored or indexed; selected URLs use the existing one-page review flow. Knowledge 174/174, Security 124/124, Shell API 5/5, typechecks, release inventory 277, release/deployment validators, Python suites 39/39 and SQLite route/trigger tests pass. Migration 0277 is unapplied and crawl flags are false. Applicable site-terms policy and deployed acceptance remain open. |
| K10 Third-party ACL synchronization | NOT_STARTED | Source-to-caller audit found no provider file ACL connector or verified upstream-principal link in Knowledge; existing supported sources are manual and owner-approved website snapshots. MCP aliases grant tool use, not file identity. Do not invent a provider/Naelao mapping. A provider identity-proof and freshness contract plus a reachable adapter remain uncoded; there is no credential blocker. |
| K11 Independent lexical candidate retrieval | IMPLEMENTED_LOCAL | `queryScopedFtsCandidates` queries migration `0074` FTS5 independently of Vectorize. SQL filters tenant/Space/Project, role, indexed document state, deletion tombstones and exact document user allowlist before returning BM25 candidates; token/phrase query and 200-candidate cap are bounded. Errors return the permissioned dense path with `lexical_search: unavailable`; full Knowledge suite 95/95. Deployed D1 support/performance is unverified. |
| K12 Dense/lexical fusion | IMPLEMENTED_LOCAL | Existing `googleModeSearch` RRF now receives independent FTS candidates alongside Vectorize; compatibility dense path remains on FTS failure and the response exposes lexical availability. Local Knowledge suite 95/95; no deployed quality comparison. |
| K13 Chunking and citation integrity | IMPLEMENTED_LOCAL | Shared bounded text chunking/source spans now reach sync create, edits, and queued Project Workflows; PDF Markdown retains structural/table chunks. UTF-8/line coordinates survive overlap, repeated text, Unicode, long sentences and CRLF; D1/vector records agree and citation resolution validates the exact bounded chunk hash. RAG 28/28, Knowledge 150/150, Workflow caller 8/8 and three typechecks. AutoRAG remains hard-disabled under K15; no AutoRAG/live provider acceptance is claimed. |
| K14 Multilingual quality | IN_PROGRESS | K17 report schema v2 reports ranking/citation/safety/latency/cost metrics per query language and query/source-language pair and checks configured thresholds at both levels and aggregate. Checked-in data remain synthetic English only; no representative cross-language results or native-speaker/domain review exist. No language support claim is made. |
| K15 Cloudflare AI Search isolated evaluation | IN_PROGRESS | Current AutoRAG path is hard-disabled because it lacks metadata filtering. No AI Search adapter exists. Official docs checked 2026-11-15: AI Search supports parallel vector+keyword hybrid, pre-retrieval metadata filters, optional reranking, R2/built-in sources and per-tenant instances/shared filtered indexes. Filters index only the first 64 UTF-8 bytes of strings; stored string arrays are not filterable. User-allowlist arrays therefore cannot be trusted as provider ACL. Implement only a disabled adapter after exact scalar/partition and deletion semantics are tested. |
| K16 Alternative retrieval/parser evaluation | IN_PROGRESS | Current Vectorize + D1 and existing D1 FTS migration are closest low-migration options; FTS retrieval is uncoded and deployed module/scale evidence is open. Dify/RAGFlow/Docling are candidate isolated parsing services, not Workers-compatible assumptions. Compare verified licensing, isolation, region, limits and total cost before selecting. |
| K17 Search quality and cost benchmark | IN_PROGRESS | `infra/scripts/knowledge-retrieval-eval.mjs` validates versioned benchmark cases/content-free traces and reports precision/recall, MRR/nDCG, citation/source-version accuracy, forbidden exposure, abstention, p95 latency and recorded cost. Metrics and configured thresholds are stratified overall, by query language, and by query/source-language pair. Version 1 data contain three synthetic English cases for exact ID, current-vs-stale version and no-answer/forbidden scope. Evaluator tests 6/6; the local Knowledge route integration passes 6/6. Human review, representative domain/language data and provider/deployed measurements remain. Evaluator always returns `acceptanceEligible:false`. |
| K18 No-code Knowledge dashboard | IN_PROGRESS | Space-wide and Project Shell plus builder Dashboard list/add/delete/search; all now offer scoped PDF preview/correction. Named collections, source refresh, test/publish lifecycle, accessibility review and cost view remain. |
| K19 SDK and extension integration | IN_PROGRESS | Host-mediated APIs and owner-reviewed Project Knowledge selection exist. Versioned generic collection discovery/search/citation SDK, settings migration and broad template handoff remain. |
| K20 Assistant/delegated/channel authorization | IN_PROGRESS | Extension grants and scoped search exist. Caller trace found full Agents response cache keys only tenant/Space, omitting principal/project/role and source/grant revision. Response/retrieval cache reads/writes are now disabled by explicit false gates in Agents and Knowledge configs/callers until exact scope and freshness are implemented. Tests cover disabled internal reads/writes. External channel trace remains. |
| K21 Deletion/revocation fencing | IN_PROGRESS | Durable tombstones, leases, Vectorize/R2 cleanup and citation hash checks exist. Cache generations rotate on deletion; content/grant changes are not fully covered. Cache remains off, but generation/version invalidation is still required before any future enablement. |
| K22 Backup/restore and provider exit | IN_PROGRESS | Bounded Knowledge archive, restore and explicit reindex exist; deployed isolated restore, grant reauthorization, RPO/RTO drills and external mirror reconciliation remain. |
| K23 Sensitive data and human handoff | IN_PROGRESS | Prompt-injection handling and air-gap policy exist. Classification/retention policy and pharmacy escalation/human review are not established as a complete workflow. |
| K24 Metering and usage attribution | IN_PROGRESS | Storage write attribution and authoritative billing components exist. Parsing/OCR/sync/retrieval/provider full-stack attribution and invoice reconciliation remain. |
| K25 Budgets and limits | NOT_STARTED | Document quota exists; no complete per-Space/project/installation maximum-cost and pause policy found. |
| K26 Bounded observability | IN_PROGRESS | Retrieval latency/quality and deletion receipts exist. Add parse/sync/freshness/denial/citation/cost/recovery measures without content or private identifiers. |
| K27 Acceptance benchmark and rollout gates | IN_PROGRESS | Numerous local ACL/deletion tests exist; no unified release gate spanning two-tenant ACL, sources, sync races, citations, cost and recovery. Keep every rollout off. |
| K28 Deployed isolation/revocation | BLOCKED_EXTERNAL | No deployed multi-tenant or cross-user acceptance evidence in this session. Code/test fixtures remain actionable independently. |
| K29 Live parser/search-provider and invoice tests | BLOCKED_EXTERNAL | No live account/credential or invoice acceptance was exercised. Ordinary adapter and local test gaps remain code work, not a credentials excuse. |
| K30 Rollout acceptance | BLOCKED_EXTERNAL | No deployed quality/safety/cost acceptance. All new search/parser/provider rollouts remain off. |

### Backend option assessment (official-source snapshot: 2026-11-15)

## K05 checkpoint — `986a27a5` pushed, 2026-11-17 (extension grant history)

The existing owner/admin extension Knowledge grant list now includes a bounded, content-free history projection (up to 20 events) with selection IDs, publication revisions, actor and timestamp. The Project Shell renders it in a disclosure control beside the current grant, clearly separating history from active access. It reads the existing SpaceDO event ledger and adds no new grant path, migration or retrieval authority. Uninstalled installations are omitted by the active-installation listing, so their history is not currently owner-visible.

Evidence: SpaceDO extension runtime suite and focused Spaces grant-route suite pass **38/38** combined, Spaces typecheck, Shell typecheck, and `git diff --check` pass locally. No browser, deployed DO/D1, migration apply or live acceptance. Generic collection ownership transfer, retention/legal-hold semantics and post-uninstall audit availability remain product/lifecycle decisions; collection history is local implementation only.

Exact next action: record ownership-transfer, retention and post-uninstall audit as policy requirements without inventing semantics; continue the next independent code gap, prioritizing SC03 wake-on-release or K25 scoped budget pause/admission. Keep collection use/retrieval unchanged and all rollouts disabled.

- **Naelao Vectorize + D1:** current dense retrieval applies tenant/Space/Project/user/role metadata filtering before result ranking. Its weakness is lexical search independence. Migration 0074 already creates FTS5 and triggers, so a Naelao-owned FTS candidate adapter is the first option to implement; the deployed D1 extension/runtime and realistic scope-scale must still be verified. This option preserves canonical D1 policy and avoids a second provider index.
- **Cloudflare AI Search:** official docs report parallel vector and keyword search, hybrid fusion, optional reranking, pre-retrieval metadata filters, OCR, and tenant isolation by separate instances or shared filtering. The filter docs state string filters use at most the first 64 UTF-8 bytes and stored string arrays cannot be searched. That prevents mapping current `allowed_user_ids` arrays as a security filter. A per-user/security-cohort instance may be technically possible but must be checked against instance quotas, sync/deletion, membership churn, operational cost and limits. Never post-filter broad results. The API is not currently used and AutoRAG stays hard-disabled.
- **Published AI Search price snapshot:** billing begins 2026-12-01; account-wide monthly included usage lists 5M ingestion tokens, 10 GB-month storage, 1,000 semantic queries and 1,000 full-text queries. Published prices: base ingestion $0.75/M tokens; image processing additional $0.50/M; storage $2/GB-month; semantic/vector/hybrid $0.75/1,000; full-text $0.10/1,000; 5,000 instances included then $0.10/instance/month. Cloudflare says Workers AI embedding/reranking is counted inside AI Search charges, while generation/query rewriting/external models remain separately charged. These account allowances are shared, not per Naelao customer. Refresh before any launch and compare invoice-level R2/Worker/egress/generation cost.
- **Docling/RAGFlow/Dify:** parsing/orchestration candidates only; no dependency selected. Require licensed model/dependency review, isolated bounded runtime, no source-document credentials/network, jurisdiction, retention, migration and operations cost before adoption.

Official sources reviewed: Cloudflare [filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/), [hybrid search](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/), [multitenancy](https://developers.cloudflare.com/ai-search/how-to/multitenancy/), [data sources](https://developers.cloudflare.com/ai-search/configuration/data-source/), [limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/). No provider was selected, configured or advertised.

### Verification and exact next action

Current local evidence and rollout limits are in the latest K14/K17 checkpoint above. No deployed D1/Worker, browser, live provider/invoice or production acceptance ran; do not infer deployed FTS, model behavior, multilingual quality, or real scale. AI Search remains unselected and rollout flags remain false.

K14's local evaluator dimensions are implemented; they do not establish cross-language quality. K10 has no file-ACL provider identity caller; preserve it as uncoded until a supported identity-proof integration exists. Resume with the next cross-plan action in AGENTS.md: owner-authorized per-conversation AgentMail assistant routing, then continue the remaining S/U/P/PW/EP and K10–K30 gaps.
## Latest K02 implementation checkpoint — 2026-11-17 (reviewed raster OCR path, rollout disabled)

Knowledge now accepts bounded PNG/JPEG sources through the same signed preview, editable human
approval, save, lineage, source-byte storage, storage-usage and archive path used by binary documents.
Backend validation checks image signatures, JPEG/PNG dimensions, <=1 MiB bytes and <=20 megapixels;
the parser version is `cohere:parse-v5.0-image-ocr-v1`. Both Space and Project Shell upload callers
expose the path and show OCR review warnings. Development, staging and production explicitly set
`KNOWLEDGE_IMAGE_PARSE_ENABLED=false`; this code does not run against a provider in those environments.
Enabling it still requires current Cohere image-format contract, privacy/egress, quality, billing and
live acceptance. No OCR accuracy is claimed. Local verification: Knowledge ingestion/image/archive
tests **21/21**, Knowledge typecheck, Shell upload tests **6/6**, Shell typecheck and diff hygiene. Code
`8a6d50264a756a87e514a1cb05c478acf6cf074a` is pushed to `origin/Mcbt5s-Backup-2`.

K02 remains partial for scanned-PDF OCR, PDF/page and richer visual coordinates, and richer presentation
extraction. K03 remains partial for PDF coordinates, extraction confidence and parser-quality evidence.
Exact next action: continue K03 PDF/page provenance through the existing signed preview contract, and
continue the full active mission after that checkpoint. Keep image parsing and rollouts disabled.
