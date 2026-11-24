# Adaptive planner, worker coordination and memory progress

## APW01/APW02 checkpoint — exact Project decision read at planner boundary

Project planners can request one Project Journal decision by exact ID and revision through
`project_journal.read_decision` or `naelao project decision <id> --revision <n>`. The host derives
the Project from the current run, returns only the matching record, and includes its read-time
workspace freshness status. Space planners cannot invoke it. Planner `Read` and its aliases are
denied; the Bash host callback denies file resources and removes filesystem inspection commands from
the planner's virtual shell allowlist. Isolated Code Mode `storage.read` receives the same denial.
Workers retain their existing file-read path.

Four focused suites pass **49/49**; Agents typecheck and `git diff --check` pass. This is the first
host-enforced lookup slice, not completion of the planner investigation audit.

**Alias and resume audit (local):** persistent and nested planner scope is host-set in
`NaelaoAgentDO`; delegated planner identity is signed and revalidated on resume. `ScriptToolSurface.run`
checks raw operation names before dispatch; Code Mode `storage.read` maps through that same check;
virtual shell pipelines authorize each command, redirections/listings authorize file access, and
saved commands are authorized before their source is loaded. Added regressions for Bash aliases,
pipeline and input-redirection reads, saved command lookup, Code Mode tool caps and signed planner
mutation. Five focused suites pass **53/53**, Agents typecheck and `git diff --check` pass. No further
broad planner file/domain reader appeared on these paths. Pushed with tests and handoff as `c140822b`.

The exact workspace excerpt is implemented in the pushed follow-up below.

## APW01/APW02 follow-up — bounded immutable workspace excerpt (local)

Added Project-only `project_journal.read_workspace_excerpt`. The host scopes it to the current run's
Project and coordinator branch; arguments identify one normalized exact path, immutable revision,
1-based line range and a requested output-byte ceiling. It requires a checked workspace reader,
rejects missing/deleted revisions and non-text/binary content, reports current versus stale revision,
and returns at most 8 KiB per call. A host-owned per-run budget admits at most four calls and 24 KiB
of requested output cumulatively. The underlying existing revision adapter separately integrity
checks content and has a 20 MiB object ceiling; the excerpt API does not enumerate workspace files.

Three focused suites pass **31/31**; Agents typecheck and `git diff --check` pass. Pushed as
`5158d3bb`; this does not establish live coordinator/provider acceptance.

## APW01/APW02 follow-up — Project thread scope (local)

The caller audit found `thread.list`/`thread.search` accepted a caller-supplied Project ID from a
Project planner, and a broad Space listing did not filter private Project threads. Project planner
selectors now remain bound to the current Project, and `thread.read` rejects foreign Project/Space
targets before it fetches messages. SpaceDO filters broad listings against Project visibility and
the requesting member/owner role. Task blackboard stays worker-only; Goal Activity indexes by actor
and rechecks current Project access before projecting evidence, and evidence collection verifies
worker parent, tenant, Space, Project, branch and declared file paths.

The Project coordination/task blackboard/Goal DAG suites pass **69/69**; Spaces thread hierarchy
passes **2/2**; Agents and Spaces typechecks pass. Pushed as `b9a36f40`.

## APW01/APW02 follow-up — Project worker roster scope (local)

`thread.list_project_agents` previously returned every Space agent definition to a Project planner,
even when the current Project had a non-empty `allowed_agent_ids` list. The Project planner now
reads its current Project config, filters the roster to that allowlist plus its default agent, and
keeps the built-in general assistant addressable. If Project scope cannot be loaded, it fails closed.
`thread.consult` uses the same filtered roster before dispatch. A disallowed configured worker is not
returned in discovery and its consult request is rejected without calling the orchestration hook.

Project coordination, task blackboard, task integration and Goal DAG suites pass **70/70**; Agents
typecheck and `git diff --check` pass. Pushed as `3207c0bb`.

## APW01 completion review — exact reader discovery and invocation

The final allowlist review confirmed the intended surviving orchestration reads are Project-bound
thread operations, a Project-filtered worker roster, and the exact decision/excerpt readers. Planner
file/search tools, raw aliases, pipelines, saved shell commands and Code Mode storage access remain
denied; task blackboard is worker-only. Added kernel checks that the exact excerpt is visible and
invocable in Project scope but hidden and denied in Space scope, including Code Mode capability
authorization. The focused kernel suite passes **15/15**, Agents typecheck passes. APW01's local
boundary acceptance is complete; live coordinator/provider acceptance stays separate.

**Exact next action:** verify APW02's one-worker dependent follow-up contract against the goal DAG
and direct delegation callers, then implement and test the next independently verifiable gap.

## APW07 checkpoint — authorized Goal Activity route projection

Added a route-level regression proving the decision-linked distinct-path candidate is projected
through Goal Activity to its recorded owner and the route returns no goal to another actor. Together
with the bounded helper cases, the focused route and helper suites pass **9/9**; Agents and Shell
typechecks and `git diff --check` pass. This closes the local projection/access regression gap only;
it does not establish semantic conflict. **Exact next action:** implement the approved semantic and
interface classifier after APW/PW owners publish the evidence taxonomy and uncertainty contract.

## APW07 checkpoint — decision-linked distinct-path review candidates

Goal Activity now emits a bounded review candidate when at least two completed workers report
distinct modified paths under the same exact Project decision revision. The candidate is explicitly
based on untrusted worker path reports; the Shell labels it as a review signal, not proof of a
semantic conflict or permission to publish. Overlapping paths, failed/incomplete tasks, malformed
paths and differing decision revisions do not generate a candidate.

`goal-decision-change-candidates.test.ts` passes **3/3**; Agents and Shell typechecks and
`git diff --check` pass. This is a deterministic candidate heuristic only. It does not classify
incompatible interfaces or other cross-file semantic behavior. **Exact next action:** continue APW07
after owners approve the conflict taxonomy/evidence contract, then add the approved classification
mechanism and integration tests. Keep cross-DO publication acceptance separate. Pushed as
`0abb4433` to `origin/Mcbt5s-Backup-2`.

## APW07/APW08 local revalidation — 2026-11-24 (remote tip `9a1ea1a1`)

Re-ran `worker-integration-validation.test.ts`, `environments.test.ts`,
`delegation-contract.test.ts`, `worker-run-access-revalidation.test.ts`,
`delegated-worker-approval-resume.test.ts` and `delegation-admission.test.ts`: **70/70** tests pass.
Agents typecheck and `git diff --check` pass. The suites cover local conflict/publication helper,
resume fencing, current access/runtime capability and budget/scope admission behavior. They do not
exercise real DO eviction or cross-DO publication storage. No code changed; the owner contract and
staging acceptance dependencies below remain.

**Exact next action:** implement the APW07 classification mechanism after APW/PW owners approve its
evidence taxonomy; then implement APW08 deadline and reusable-definition slices after the relevant
owners approve their contracts.

## APW08 readiness review — 2026-11-24 (deadline, reusable definitions and live recovery)

Current source gives ordinary AgentDO runs a 10-minute wall-clock deadline and allows an explicit
`deadline_ms` override. The delegated-worker caller sets `long_running: true` without `deadline_ms`,
so that path receives no wall-clock deadline. Its signed delegation bounds token and step counts,
but those limits do not define elapsed-time or paused-worker expiry. The APW and PW plans require
bounded deadlines and safe recovery, but neither owner ledger defines the maximum active duration,
whether human-approval waiting time counts, expiry/cleanup behavior, or the user-visible state when
an expired worker is resumed. **Dependency:** an owner-reviewed worker deadline/expiry contract that
defines those semantics and the resume fence. After approval, wire its bounded deadline to delegated
execution and test active, suspended, expired and resumed cases. Do not infer a duration from the
ordinary interactive 10-minute deadline.

The SDK currently exposes `ExtensionWorkerRole` bindings (`principal`, invocation/execution,
entry, primitive IDs and optional Gadget actions). Its extension workflow contract lists an entry,
steps and tool names; the `@naelao/sdk` plan compiler emits a bounded static sequential list. These
contracts do not describe a reusable worker/task definition or an adaptive workflow topology. APW
§8 calls for role, capability, model, task, stage, evidence and communication declarations; PW §6
distinguishes reusable worker/workflow definitions from sessions and branches; TBR's template role
contract keeps authority host-owned. The owners do not yet define the versioned schema, how reusable
definitions bind to host-approved package/grants, or lifecycle/review rules. **Dependency:** review
and approve that cross-plan definition contract, including role-to-task/stage binding, allowed
topology bounds, model/capability declarations, evidence/communication shape, reuse/version rules,
and an explicit rule that declarations cannot grant authority or budget. Then implement its parser,
SDK/template round-trip and host binding tests against existing admission limits.

Approval recovery now reuses the persisted continuation run ID and budget, with exact-attempt
fencing and idempotent run recovery covered by local fixtures. These do not prove Cloudflare DO
eviction, cross-DO scheduling or provider-effect recovery. **Live acceptance dependency:** authorized
staging AgentDO/Workflow bindings and a disposable effect fixture; interrupt a delegated worker while
approval is pending and while continuation is starting, then verify current authorization, budget,
runtime capability and exact-attempt fencing after restart, with no duplicate committed effect.
Keep this acceptance separate from the local implementation record.

The source/owner review found no additional APW08 code change that can be made without choosing the
missing duration and reusable-definition contracts. APW08's local budget, scope, route, workspace-pin,
access, runtime-capability and approval-recovery slices remain verified in the entries below.
**Exact next action:** resume APW07 when the owners approve its conflict evidence taxonomy, then
implement and test the approved classification mechanism. Implement APW08's bounded deadline and
reusable-definition contracts after their owners approve duration, expiry and schema/lifecycle rules.
Keep real DO recovery and publication acceptance separately gated on authorized staging.

## APW07 readiness review — 2026-11-24 (lineage complete, conflict taxonomy pending)

`WorkerIntegrationValidationReceipt` now pins source branch/base, source commit, target branch/commit,
target revision/manifest, candidate and validation branch revisions/manifests, command digest and
publication result. The safe Goal Activity projection validates a present source-base pin against
current workspace lineage. The local validation, lineage, route and delegation suites passed **39/39**;
the publication helper barrier test passed **16/16**. This closes the local receipt-lineage gap. The
fixtures still do not exercise parent AgentDO permit storage against a real Workspace Coordinator DO.

Current `WorkspaceCoordinatorDO` conflict reasons cover text overlap, delete/edit and path collisions,
encoding, binary, size and other deterministic content/manifest cases. The source has no detector for
incompatible interfaces or semantic conflicts across different files. The APW/PW plans require those
cases, but do not define the conflict taxonomy/evidence contract or whether classification uses
static analysis, worker-declared evidence or a budgeted model review. **Dependency:** have the APW/PW
owners approve candidate versus confirmed conflict categories, required revision/symbol/interface
evidence, uncertainty/false-positive handling, and whether any classifier may spend an existing task
budget. Suggestions must remain untrusted review signals and must never authorize publication.
Then implement the approved static checks or bounded review suggestion and receipt, with tests for
candidate/confirmed states and uncertainty handling.

**Live acceptance dependency:** authorized staging AgentDO/Artifact/Workspace Coordinator bindings and
the real parent publication-permit storage race, including cancellation before and after the permit.
No local cross-DO implementation gap is currently isolated from that runtime boundary.
**Exact next action:** resume APW07 conflict classification after the owner-reviewed evidence contract;
resume its publication-race acceptance when authorized staging bindings are available.

## APW08 follow-up — 2026-11-24 (resumed-worker budget revalidation)

`delegation-admission.test.ts` now proves resumed child dispatch recomputes the allowance from the
current parent budget and prior consumption: a saved 800-token session with 350 tokens used, resumed
under a 500-token parent ceiling and a 700-token request, receives 150 tokens. A zero remaining
allowance is rejected before child dispatch and leaves the prior attempt intact. The focused suite
passes **17/17**, Agents typecheck and `git diff --check` pass. This is local test-fixture evidence;
no real-runtime interruption/recovery acceptance ran.

**Exact next action:** test that resume rejects a saved worker session when its actor or Project scope
no longer matches the current parent request, before dispatch.

## APW08 follow-up — 2026-11-24 (resumed-worker scope revalidation)

Recovery fixtures now cover both actor and Project scope drift in the saved worker configuration.
Resume returns `worker_session_scope_mismatch`, leaves the prior failed attempt and usage intact, and
does not issue a child request. The focused delegation-admission suite passes **19/19**, Agents
typecheck and `git diff --check` pass. This tests current scope matching locally; it does not simulate
live membership or grant revocation.

**Exact next action:** verify a saved remote worker model route cannot dispatch after the current
parent runtime becomes local-only.

## APW08 follow-up — 2026-11-24 (resumed-worker runtime-route revalidation)

The delegated worker's saved model is restored on resume, then checked against the current parent
placement policy. A regression fixture with a saved remote route under the current local-only policy
now confirms the resumed session fails closed before a child request and retains prior token usage.
The focused delegation-admission suite passes **20/20**, Agents typecheck and `git diff --check` pass.
This local test does not establish provider capability or deployed route acceptance.

**Exact next action:** test that an old worker checkpoint payload is withheld when the current
workspace branch head no longer matches its immutable saved pin.

## APW08 follow-up — 2026-11-24 (resumed-worker workspace pin revalidation)

Resume now has regression coverage for a changed Coordinator revision and a changed manifest hash.
Both cases supply a different current branch head and verify the saved checkpoint payload is withheld
from the child prompt in favor of the stale/unavailable-checkpoint notice. The focused delegation
suite passes **22/22**, Agents typecheck and `git diff --check` pass. The Coordinator read is stubbed;
this is not deployed workspace acceptance.

**Exact next action:** reconcile the remaining APW08 resume authorization, deadline, runtime
capability and SDK/template topology requirements against current callers and owning ledgers. Complete
any independent local gap before recording exact external blockers.

## APW08 follow-up — 2026-11-24 (current Project access at the execution gate)

The resumed child calls `enforceRunGates` before execution, which queries the current Project
assistant-access contract. New direct gate tests prove both a current denial and an unavailable
authority fail closed: **2/2**. Agents typecheck and `git diff --check` pass. The tests do not simulate
actual child-DO dispatch, a live membership-revocation race or deployed runtime behavior.

**Exact next action:** carry the exact worker attempt/runtime capability through delegated HITL resume
and make the parent start fence accept only a verified, one-time claim for its waiting attempt.

## APW08 follow-up — 2026-11-24 (delegated approval-resume fence)

`handleResumeRun` now carries `workerAttempt` and `runtimeCapability` through the renewed delegation
context. It sets signed `resumeAuthorized` only after HITL confirms an answer. The parent start check
accepts a fresh run ID only for that signed resume, then atomically changes the exact waiting attempt
to `running`; a duplicate or stale attempt is denied. Contract reconstruction and start-fence tests
pass alongside the delegation and access suites: **30/30**. Agents typecheck and `git diff --check`
pass. These are separate local fixtures, not a real cross-DO or crash-recovery test.

**Exact next action:** reconcile remaining APW08 deadline, approval recovery, runtime capability and
SDK/template topology requirements against current callers and ledgers; implement any independent
local gap before recording blockers.

## APW08 follow-up — 2026-11-24 (runtime capability on resume)

The renewed delegation preserves the signed worker runtime recommendation. At the execution boundary,
`containerRuntimeInventory` re-resolves the currently active Project installation and deployed image;
the environment selector requires that image to still expose the preferred binary. A new regression
removes `ffmpeg` from the current inventory and proves the managed command is denied without calling
the container runner or external tunnel. The separate approval-resume fixture proves the signed
capability is forwarded in continuation context. The environment, approval-context and delegation
contract suites pass **28/28**; Agents typecheck and `git diff --check` pass. This is local fixture
evidence and does not establish deployed image/capability state.

**Exact next action:** settle the missing long-running worker deadline contract and reusable
SDK/template topology declaration against the owning plans and ledgers; record the precise policy or
contract dependencies and keep live crash-recovery acceptance separate.

## APW08 follow-up — 2026-11-24 (approval continuation recovery after DO interruption)

An approved `suspended_runs` checkpoint left at `resuming` can now be picked up after a DO restart.
Recovery retains and reuses its saved continuation run ID; a same-instance in-memory claim still
rejects concurrent resume requests. The parent `sub_agents` row records that exact resumed run ID,
so the start fence accepts an idempotent retry for the same worker attempt and rejects a different
fresh ID. Resume budget now subtracts usage from both the original suspended run and its partial
continuation. Existing `handleScriptRun` durable-run logic reattaches to an active continuation,
returns a terminal receipt, or recovers a stale run from saved step boundaries while the action
ledger keeps indeterminate effects from replay. The focused recovery, parent-admission and contract
suites pass **29/29**; Agents typecheck and `git diff --check` pass.

The fixture does not simulate Cloudflare DO eviction, cross-DO scheduling or a real provider effect.
No process/model memory is restored. **Exact next action:** reconcile the uncapped
`long_running` worker deadline and reusable SDK/template topology contract against their owners, then
record separate deployed interruption acceptance.

## APW07 follow-up — 2026-11-24 (source-base validation lineage)

`WorkerIntegrationValidationReceipt` now includes the actual source branch base parent, Coordinator
revision and manifest hash. The Goal Activity lineage projection validates a present pin against the
current workspace lineage and omits malformed or stale receipts; historical receipts without the
optional pin remain readable. Focused validation, lineage, route and delegation-admission suites pass
**39/39**; Agents typecheck and `git diff --check` pass. A pre-existing delegation test fixture was
corrected to use its declared local worker model so the test reaches the intended admission path.

This is local source/fixture evidence. No real multi-DO publication test or deployed Coordinator
acceptance ran. APW07's semantic/interface conflict classification and broader integrated evidence
remain in the PW/EP plans.

**Exact next action:** add APW08 recovery coverage proving a resumed worker uses no more than the
current parent budget less prior token use and cannot dispatch when the remaining budget is exhausted.

## APW07 follow-up — 2026-11-24 (cancellation during pending publication)

The checked integration helper now has a barrier-driven local regression for cancellation after
`authorizePublication` succeeds but while the simulated Artifact Worker request is pending. The test
releases the request after cancellation, then asserts the observed published result is retained in
the validation receipt without claiming rollback or replay. The focused
`worker-integration-validation.test.ts` suite passes **16/16**, Agents typecheck and `git diff --check`
pass.

This verifies the helper's host contract only. The Node fixture does not exercise the parent Agent
DO's durable publication-permit SQL or an actual Artifact/Workspace Coordinator DO race. Keep that
multi-DO/deployed acceptance separate; it needs authorized staging bindings and a real runtime
receipt.

**Exact next action:** add the source branch's immutable base parent/revision/manifest hash to the
durable `WorkerIntegrationValidationReceipt` and the safe Goal Activity lineage projection, then
test both valid projection and invalid/stale omission.

## APW06 follow-up — 2026-11-23 (authorized conversation stop; Project controls remain blocked)

The existing `StopDurableTaskButton` passes the task ID to `cancelRun` only for processing tasks
opened from a conversation. The route verifies Space ownership and requires either Space membership
or access to that exact session before forwarding the stop to its AgentDO. AgentDO stores the
`cancelling` state in durable `run_state`, aborts the execution signal and the script loop checks the
request at step boundaries. Since an active operation may be aborted, the Shell now says it may
finish or be interrupted, committed external effects are not undone, and the final result should be
reviewed before retry.

Project-scoped task listing and detail routes support authorized status viewing but expose no
cancel/pause/resume mutation. A Project viewer is not automatically authorized for the task's
conversation. The internal generic `WorkflowRunDO.cancel(actorId)` method is not used: its cleanup
can terminate the static AgentTaskWorkflow without persisting a matching terminal TaskDO status.
The goal-DAG redundant-worker cancellation contract is separate and does not authorize stopping an
entire user task. Project controls remain blocked pending approved owner/admin authority plus a
durable TaskDO/workflow status and uncertain-effect recovery receipt. No new public endpoint or
mutation was added.

Verification: source-only Shell TypeScript check and `git diff --check` pass. The normal Shell
typecheck still fails only on stale generated `.next/types` imports to absent route files. No tests,
browser/deployed acceptance or provider operation was run.

APW06's supported conversation stop slice is complete. APW remains partial: aggregate cost policy,
retention approval, Project task-control authority/recovery and real-runtime acceptance remain
blocked; APW07–APW09 work stays with its owning plans.

**Exact next action:** reconcile PW01–PW06 source and ledger evidence; identify the first ready PW
code requirement and the explicit resume condition for each blocked requirement.

## APW06 follow-up — 2026-11-23 (goal decision-hold remediation link)

Goal activity already projected the host's bounded `decision_review_reason` and exact referenced
Project decision IDs/revisions, but the task panel only displayed the raw hold code. Both the
conversation task graph and Assistant worker panel now translate known host hold reasons into plain
status text, show the pinned references and link to the Project's decision-review panel. The link is
only navigation: it adds no review mutation or task resume. The destination's existing API checks
current Project access and reviewer role, then rechecks the exact proposal revision and current
workspace pin; stale or unavailable pins still block approval.

Verification: `git diff --check` and source-only Shell typecheck pass. The ordinary Shell typecheck
remains blocked by stale generated `.next/types` imports for missing route files. Local UI/source
evidence only; no browser/deployed acceptance. No component-specific tests exist and none were added.

This checkpoint's next action was completed in the following APW06 conversation-stop follow-up above.

## APW05 follow-up — 2026-11-23 (goal/task and runtime admission reconciliation)

The current goal path admits at most 12 tasks, bounds nested planner depth/count, and assigns child
workers token budgets within their parent task's remaining token ceiling. Ordinary AgentDO model
calls reserve against the configured Project spend cap or plan token quota where that payer
authority applies. System One decision calls use a separate durable Billing reservation with a
pinned model price snapshot and maximum credits before provider dispatch; confirmed outcomes settle
from provider token/cost receipts, while ambiguous outcomes retain holds and reconcile against
Billing status and generation usage, with manual review after bounded retries. These per-call and
per-inference holds do not form a cumulative goal/task credit reservation.

Runtime paths have distinct configured authorities. Durable extension workflows can carry an
owner-approved per-run and monthly credit budget into `WorkflowRunDO`; it reserves before launch,
settles measured usage, and settles the reserved ceiling when effects remain uncertain. The default
`AgentTaskWorkflow` initializes the same journal without a run-credit budget. Its optional session
ceiling is currently a read/check before a run followed by a post-run tally increment in SpaceDO;
there is no atomic run hold or per-run credit ceiling. Managed runtime admission uses its existing
Billing reservation path, while ConcurrencyDO applies configured global/tenant caps and hierarchical
tenant/Space/Project/actor queue promotion. The scheduler has no approved task priority weights.

No new aggregate credit cap or priority policy can be derived from token budgets, per-inference
reservations, internal credits or the session tally. APW05 remains partial until an owner approves
per-goal/per-task spend ceilings and a cost/quality objective; provider USD acceptance separately
needs controlled staging runs and invoice-reconciled usage. No rollout behavior changed.

Evidence: source reconciliation across `goal-dag.ts`, `NaelaoAgentDO.ts`, `AgentTaskWorkflow.ts`,
`WorkflowRunDO.ts`, `ToolSandboxDO.ts`, `report-infra-usage.ts`, and the shared-compute/TBR ledgers.
No code changed and no tests were run for this documentation-only audit; evidence is local/source
inspection, not deployed billing or provider acceptance.

**Exact next action:** continue APW06 by tracing actor-scoped goal activity and Project decision
review routes for task-specific decision-hold remediation. Preserve current membership, exact
revision and workspace-pin checks, with review actions remaining on the Project Journal authority.

## APW04 follow-up — 2026-11-23 (semantic-vector deletion invalidation)

Deleting an actor-owned episodic record removes its SQLite source row and attempts best-effort
Vectorize cleanup. Recall previously trusted matching vector IDs even if cleanup failed, so an old
semantic copy could return after deletion. Recall now checks only its bounded vector candidates
against the live `episodic_log` rows using the exact candidate IDs and current `(actor, unscoped)`
scope, requires `promoted=1`, and takes actor ownership from SQLite instead of vector metadata. A
deleted or cross-actor row cannot re-enter recall from a stale vector. The ordinary score/relevance
gate and bounded ingress renderer remain unchanged.

Verification: memory scope/invalidation, ingress context and Space Assistant memory suites **9/9**,
Agents typecheck and `git diff --check`; local/mock only. No deployed deletion acceptance ran. No
expiry duration or retention cap was added without an approved retention policy. APW04 remains open
for remaining retention/deletion reconciliation and private-project/selective-context evaluation.

The lifecycle inventory confirms the limited existing policy surface: personal structured facts
decay after a day of inactivity and are removed below the trust floor; only unpromoted episodic
notes have a 500-row cap. Promoted semantic copies, personal Fabric/Wiki and SpaceDO Project
facts/Fabric/Wiki have no TTL or equivalent retention cap in their schemas. Knowledge uses an
explicit tombstone and retryable, cache-invalidating deletion workflow rather than a memory TTL.
Do not add expiry to the stores without an approved retention duration and corresponding erase
contract.

Follow-up evaluation: Agents memory/context scope suites **16/16**, Spaces Project memory scope and
deletion **4/4**, and Knowledge search/deletion boundaries **18/18**. This includes actor-filtered
ingress, effective-role gates, Project Knowledge search denial before retrieval without membership,
foreign-tenant denial, connector-source invalidation, Knowledge deletion/cache cleanup and direct
ProjectDO isolation for facts, Fabric and Wiki. All are local/mock evidence; no deployed/private-
project acceptance ran. Per-class TTL/erasure policy remains blocked pending retention-owner approval;
no new retention duration was introduced.

**Exact next action:** continue APW05 by comparing current goal/task and runtime admission paths with
Billing reservations, settlement and shared-compute ledgers. Implement only where an existing
configured authority can be rechecked; keep missing quota policy and provider USD evidence explicit.

## APW04 follow-up — 2026-11-23 (Knowledge source provenance propagation)

The ordinary scoped Knowledge search path previously returned only `source_revision` even though
canonical source rows also carried `source_adapter`, `source_content_sha256` and optional
`source_grant_revision`; the exact indexed chunk also had `content_hash`. Dense and FTS results now
carry all five fields to the search response and canonical citation resolver. Search citations label
the canonical source hash separately from the exact chunk hash. Agent answer and durable task
citations preserve validated source provenance from the successful `knowledge.search` trace.
Grounded-search cache keys use a new version prefix, preventing old cached hit records from silently
omitting the new fields. Search authorization predicates and result bounds were unchanged.

The memory adapter audit found these exact versioning gaps: SpaceDO Project facts use stable row IDs
but update the same `(project_id, entity, relation)` row and expose only `updated_at`; Project Wiki
upserts the same `(project_id, concept)` row and exposes only `updated_at`; Project Fabric inserts
rows with stable IDs and `created_at` but stores no content hash. The personal/local Memory OS has
the same pattern: structured facts update the same `(user_id, entity, relation)` row and expose
`updated_at`; episodic notes and Fabric entries use stable row IDs and creation timestamps; Wiki
overwrites `(user_id, concept)` with `updated_at`; promoted semantic vectors retain the episodic ID
and text plus `sourceUpdatedAt`, but no content hash or source revision. These timestamps are
freshness signals, not immutable revisions; row IDs identify records, not their changing content.
Actor scope and the bounded ingress memory renderer were not changed.

Verification: Knowledge sparse-search tests **5/5**, scoped search provenance route **1/1**,
canonical citation resolver **1/1**, Agents citation metadata **2/2**, Knowledge and Agents
typechecks, exact Shell source typecheck and `git diff --check`; local/mock only. The broader
Knowledge focused run passed **61/64**; three unrelated restored-chunk reindex cases returned 404
instead of expected 200/409/410. No deployed/live acceptance. APW04 remains partial for retention,
invalidation, selective-context evaluation and private-project leakage checks.

**Exact next action:** reconcile retention and deletion/invalidation across the personal, Project,
Space and Knowledge adapters; then evaluate bounded selective context and private-project isolation.

## APW03 follow-up — 2026-11-23 (Project decision review caller and UI)

The Project page now includes the missing owner-facing Project Journal decision register. The
authenticated Agents routes reuse the existing `project_journal.read_decisions` and
`project_journal.review_decision` operations; they check current Project membership and permit
review only for a current Project owner or Space administrator. The panel shows proposed and active
decision freshness, exact revision, rationale and interfaces, and requires an explicit same-topic
supersession selection. The server rechecks the current workspace pin and exact proposal revision
before approval. A stale proposal can be rejected, but cannot be approved or activated; this review
does not rewrite goal-task decision references. The existing worker conflict receipt already had
fresh target/worker version previews, expected-hash checks, reviewer-authored manual resolution,
validation and checked Coordinator publication, so no alternate canonical write path was added.

Verification: Project Journal and decision-review route suites **12/12**, router routing suite
**1/1**, Agents typecheck, exact Shell source typecheck and `git diff --check`. The Router package
typecheck was attempted and remains blocked by missing `@naelao/http` exports used at existing
`RateLimitDO.ts` and `index.ts` imports; its focused routing test passes. Local/mock only; no browser,
deployment or live Project acceptance. APW03's owner-review slice is complete; goal-level decision
hold remediation, semantic conflict classification, fresh checkpoint rechecks and live integrated
acceptance remain partial under APW03/APW07.

**Exact next action:** continue APW04 by tracing immutable source identity, revision and hash
availability through actor-scoped memory adapters and Knowledge source records. Add revision-bearing
provenance where the authoritative store supports it; otherwise record the adapter contract that
prevents it, then continue retention and selective-context evaluation.

## APW03 follow-up — 2026-11-23 (goal task branch lineage projection)

The actor-scoped goal activity projection now joins only each task's exact generated worker ID to
its `sub_agents` row and checks tenant, Space, actor, Project and parent-run scope before exposing
lineage. It projects the worker branch base from the stored branch-origin receipt, the last
recorded checkpoint pin, bounded checked-integration validation receipts and bounded publication
attempt outcomes. It never includes worker output or checkpoint payload. The UI displays full
manifest/commit identities and explicitly says the saved pin was not rechecked for freshness.

Verification: lineage projector and goal-activity route suites **7/7**, Agents typecheck, Shell
source typecheck excluding stale generated `.next/types`, and `git diff --check`; local/mock only.
No live Coordinator lookup, DO restart or deployed UI/privacy acceptance ran. Older goal metadata
without parent-run/Project identity safely omits lineage.

**Exact next action:** inspect the existing worker conflict receipt and Project decision-review
callers, then implement the next missing owner-facing APW03 conflict/review action without changing
the checked-publication authority or auto-approving stale decisions.

## APW02 follow-up — 2026-11-23 (comparative protocol and deterministic fixture)

Added the [adaptive goal-routing comparative protocol](../benchmarks/adaptive-goal-routing-comparative-protocol.md)
and a local paired scheduler fixture in
`workers/agents/src/script-engine/goal-routing-comparative-benchmark.test.ts`. The fixture runs six
fixed synthetic workloads (small/medium/large code and non-code), two repeats and three arms for 36
runs. Each arm host-verified all 48 expected artifacts and had matching synthetic token totals per
paired workload. Every run recovers one injected lost acknowledgement; each arm reports 12/12
recoveries, zero redispatches, duplicate dispatches, resource overlaps and incomplete runs. The
fixture reports p50/p95 local wall time but labels it test-runner timing; it records no provider
calls, no external writes and `providerSpendUsd: null`.

Verification: routing comparison, goal architecture and evidence-quality suites **6 passed, 2
provider/live tests skipped**, Agents typecheck, and `git diff --check`. The 480-case evidence suite
and architecture scenarios remain synthetic/local. Fixture artifact verification is not model or
customer task quality; lost-ack recovery does not measure failed-worker retries; synthetic token
counts are not spend; resource-key checks are not real workspace conflict acceptance. No live
provider, durable runtime, invoice or checked-publication experiment ran. Progressive routing,
dynamic expansion and redundant-worker cancellation remain disabled by default.

**Exact next action:** continue APW03 by tracing whether the goal activity/result path retains exact
worker-branch base/result revisions and checked publication validation receipts; implement the
smallest missing lineage link and test the host projection. Real-runtime/provider comparison and
cost-aware routing remain blocked as described in the protocol.

## APW02 follow-up — 2026-11-23 (safe redundant-worker cancellation; local verification)

Goal tasks may explicitly declare a `redundancy_group`; validation requires at least two independent
members with no dependency ancestry between them. When the host safety flag is enabled, only a
completed and verified member cancels its unfinished peers. The default-off
`GOAL_REDUNDANT_CANCELLATION_ENABLED` flag keeps rollout disabled.

The stop path records a winner and cancellation timestamp in `goal_dispatch_outbox`, checks that
marker before and during worker-session admission, fences the exact `sub_agents` attempt before
calling the child runtime, and gates goal-worker execution through a parent-side start check. A
completion crossing the fence is kept in a bounded late-result receipt without overwriting terminal
worker state; callback and HTTP races count its tokens once. Existing checked-workspace publication
receipts remain available, and cancellation/effects are exposed to the task UI with explicit wording
that effects may already have committed. A stop request is not treated as rollback. Runtime/task
projections distinguish `cancelling`, `cancelled` and uncertain effects.

Verification: goal DAG, goal planner and delegation admission suites **83/83**, Agents typecheck,
Shell source typecheck excluding stale generated `.next/types`, and `git diff --check`; local/mock
only. The regular Shell typecheck still stops on stale `.next/types` references to absent route
files. No live DO restart/cancellation, provider call or deployment was exercised. The cancellation,
progressive-routing and dynamic-expansion flags remain off by default.

**Exact next action:** define a controlled comparison of one-worker, sequential and adaptive execution
with fixed task/model/time/quality constraints and complete spend, latency, retry, conflict and
customer-visible correctness evidence. Separate local/mock measurements from provider invoices and
deployed acceptance; keep rollout disabled.

## APW02 follow-up — 2026-11-23 (bounded planner hierarchy; local verification)

The goal planner now allows at most four planner-marked children in a root goal graph and rejects
planner children from a depth-two planner, leaving depth-three workers as leaves. Each goal graph
still validates at most 12 tasks. Nested planner graphs allocate a shared child-task token pool no
larger than the parent task's assigned worker-token ceiling; omitted child budgets divide the
remaining pool. The host now passes the actual assigned `budgetTokens` as the nested worker's
`worker_token_budget`, preventing it from inheriting the caller's broader per-worker ceiling.
Delegation tokens continue binding actor, tenant, Space/Project, caller role, depth, planner bit,
model, file paths, and token limits; the child run gate rechecks the caller's current authority.

Verification: goal planner, goal DAG/kernel, delegation admission/contract and assistant-swarm
suites **38/38**, Agents typecheck and `git diff --check`; local/mock only. This bounds planned child
tokens, not all actual descendant model usage or provider charges, which remain subject to the
existing per-inference billing path. It does not enable deeper than the current three levels.
Progressive routing and dynamic expansion remain disabled by default.

**Exact next action:** trace durable worker dispatch acknowledgement, cancellation and late result/
workspace effects before changing redundant-worker cancellation semantics.

## APW02 follow-up — 2026-11-23 (report-only routing history; local verification)

Progressive routing now keeps a maximum of 32 concurrency-history records in the durable goal
journal. The records capture the previous and new concurrency, reason and timestamp; task-completion
changes also capture the triggering task ID, task outcome and verification outcome (`not_required`
or `unavailable` are explicit). The goal activity route bounds and validates this projection and
only exposes a trigger task that exists in the current journal. The Shell renders the history beside
the existing topology and per-task verification/runtime/token/internal-credit values. This adds
observation only; the selection algorithm and rollout flags are unchanged.

Verification: goal DAG suite **60/60**, goal activity route suite **5/5**, Agents typecheck,
Shell source typecheck excluding stale generated `.next/types`, and `git diff --check`; local/mock
only. The normal Shell typecheck remains blocked by stale `.next/types` references to absent route
files. No controlled cost/quality comparison or savings claim is established. Automatic cost-aware
selection remains blocked pending an explicit per-goal spend objective and the comparative baseline;
internal credits can be unpriced and do not represent provider invoices.

**Exact next action:** reconcile nested planner limits, authority inheritance and budget accounting
across `goal-planner.ts`, goal expansion and delegated worker contracts before implementing deeper
decomposition.

## APW02 follow-up — 2026-11-23 (goal usage joins; local verification)

Goal activity already projects each task's stable worker ID, verification result, queue wait and
execution duration. The corresponding `sub_agents` row stores reported model tokens and allocated
token budget, while Billing aggregates exact worker and `:attempt:` usage-event run IDs into
internal credits plus an unpriced-event count. The Shell joins these values by worker ID beside the
goal topology and task status. A route-validation mismatch had prevented this join for goal IDs:
the host derives IDs as a 64-character goal hash, colon, and a task ID up to 64 characters, while
the Agents and Billing usage selectors rejected colons and lengths above 128. Selectors now admit
the bounded namespaced IDs. Billing escapes `_` in the attempt prefix so `task_1` cannot match a
neighboring `taskX1`; the regression exercises the actual usage-summary route.

Verification: worker selector suite **2/2**, Billing worker-usage suite **25/25**, Agents typecheck
and `git diff --check`; local/mock only. These receipts can now be observed together for a goal
task, but they do not constitute a controlled quality/cost comparison. Queue/execution durations
are worker runtime measurements; credits are internal accounting and may include unpriced events;
provider invoices are not reported. No savings claim is supported. Progressive routing and dynamic
expansion remain disabled by default.

The report-only routing history follow-up above completes this next action.

## APW02 follow-up — 2026-11-23 (staged persistence replay; local verification)

The cross-DO expansion persistence path is now isolated in `goal-expansion-admission.ts`. It
prechecks actor-scoped goal metadata and blackboard scope before remote task creation, writes a
durable pending intent, replays immutable SpaceDO task IDs, and commits goal metadata, updated
recipient projection, blackboard membership/grants and intent completion in one AgentDO transaction.
The regression test injects an AgentDO transaction failure after remote task creation, confirms the
pending intent survives without local membership/grants, then retries and proves remote task IDs do
not duplicate while local state converges. A separate wrong-scope case rejects before the remote
write. Verification: goal expansion/admission/DAG suites **65/65**, Agents typecheck and
`git diff --check`; local/mock only. This exercises the contract through a transaction shim, not a
live Durable Object restart. The underlying boundary remains staged across two DOs.

The core expansion implementation is pushed in `139c6654`; this follow-up adds the replay coverage
and queue/pointer transition in this checkpoint. APW02 host admission is checked off in the queue.
**Exact next action:** trace current goal verification, latency, worker-token and internal
credit receipts to a single goal/task before implementing measured routing; keep progressive routing
and expansion disabled.

## APW02 checkpoint — 2026-11-23 (host-owned bounded expansion; local verification)

The durable goal DAG now accepts only an explicit structured worker result as an expansion proposal.
The host derives deterministic 96-bit namespaced task IDs, allows at most three children at one
additional depth, enforces the shared 12-task ceiling and confines child file paths and worker
authority to the completed parent. Child budgets must fit the parent's unused worker-token budget.
Expansion admissions serialize so concurrent completions cannot each pass the graph limit against
the same old task count. Invalid or refused proposals get durable rejection receipts while completed
parent work remains completed; admitted task definitions and receipts resume from the DAG journal.

`NaelaoAgentDO` keeps expansion off unless `GOAL_DYNAMIC_EXPANSION_ENABLED=true`. Admission checks
the durable parent worker's run/tenant/space/project/actor scope, current actor authorization,
current Project decision references and the configured Billing path. It creates explicit stable
SpaceDO task IDs behind a durable pending intent, then commits matching goal metadata and blackboard
membership/grants in the AgentDO transaction. Dispatch rechecks current authorization, decision
references and Billing path readiness. Verification: goal expansion and DAG suites **63/63**,
Agents typecheck and `git diff --check`; local/mock only, with no deployed acceptance. The SpaceDO
write and AgentDO transaction are a replayable staged boundary rather than one distributed atomic
transaction, so a failed local commit can leave a visible pending SpaceDO row until replay. Existing
per-inference quota/project-spend reservations remain in force where configured; this slice adds no
aggregate USD/credit reservation for all proposed children. Rollout remains disabled.

**Exact next action:** add host-boundary fault/replay coverage for the SpaceDO-write/AgentDO-commit
gap, then continue APW02's remaining routing, cancellation and evaluation requirements. Preserve
`infra/scripts/__pycache__/`.

## APW04 checkpoint — 2026-11-18 (actor-owned memory deletion; local verification)

The member-facing Space Assistant memory route now exposes a delete action only for personal
structured facts and episodic rows owned by the authenticated actor. Reads include stable row IDs
and a `deletable` bit only when `user_id` exactly matches that actor; shared Project facts,
explicitly unscoped rows and legacy entries remain non-deletable in this panel. DELETE requires
current Space membership and an actor identity, then Memory OS uses exact `(id, user_id)` predicates;
semantic vector cleanup is best-effort after an owned episode is removed. AgentDO projection/delete
suite **2/2**, Agents and Shell typechecks, and `git diff --check` pass. Local/mock only; no deployed
privacy acceptance. Rollout remains disabled. The follow-up route-to-store suite is **2/2**:
membership is checked before the DO call, actor identity comes from the authenticated request, and
exact row identity is preserved. Agents typecheck passes after adding the caller test.

Implementation commit `63e01415`, ledger/runbook commits `82c78b15` and `8d97b66e`, and route test
commit `2161e627` are pushed to `origin/Mcbt5s-Backup-2`. This remains local/mock verification
only, with no deployed privacy acceptance.

**Exact next action:** continue APW02 with a host-owned expansion/admission contract for dynamic
goal graphs. SC03's bounded synchronous waiter retry is already implemented and recorded in the
shared-compute ledger; only detached dispatch after caller disconnect remains open without explicit
durable invocation authority and fresh Billing. Preserve `infra/scripts/__pycache__/`.

## APW04 refinement — 2026-11-18 (category-qualified exact deletion; local verification)

The member-facing delete contract now includes both category (`fact` or `episodic`) and row ID. The
DO deletes only the corresponding table row under exact `(id, actor)` scope; a defensive same-ID
collision across tables no longer deletes both. Vector cleanup is limited to an owned episodic row.
AgentDO deletion suite **2/2** includes a cross-table ID collision regression; authenticated
route-to-store suite **2/2** proves membership gate, actor forwarding and exact target. Agents/Shell
typechecks and diff hygiene pass. Code commit `cba38ee9` and ledger/runbook commit `f58133a3` are
pushed to `origin/Mcbt5s-Backup-2`. Local/mock only; no deployed acceptance.

**Exact next action:** continue APW02 graph-expansion design across stable IDs, blackboard authority,
worker grant resolution and billing admission. Do not wire model-supplied additions until all these
host boundaries can be revalidated at expansion and dispatch.

## APW04 checkpoint — 2026-11-18 (Space Assistant memory scope; `89764820` pushed)

The member-facing Space Assistant memory projection now sends the authenticated actor and effective
Space role to AgentDO. Local structured/episodic memory reads include only that actor's rows and
explicitly unscoped rows; legacy entries without actor scope are owner/admin-only. Shared Assistant
facts are listed through an explicit read-only list mode, with required-role filtering derived from
the caller's current role. Verification: Agent memory projection/ingress suites **5/5**, Spaces
Project memory suites **3/3**, Agents/Spaces typechecks and `git diff --check`. Code
`89764820231025acd92395dd2e1f9c7fc9f49505` is pushed to `origin/Mcbt5s-Backup-2`. Local/mock only;
no deployed privacy acceptance. APW04 remains partial for retention/deletion semantics across stores,
immutable source revisions, selective-context evaluation and private-project leakage testing.

**Exact next action:** implement owner-visible deletion for the current actor's personal memory rows
with exact row identity, then continue APW02 bounded replanning or another independent gap. Keep
rollout flags disabled and preserve the untracked Python cache.

## APW02 checkpoint — 2026-11-18 (progressive concurrency controller; `796182c7` pushed)

The durable goal DAG now supports an opt-in `progressive-v1` admission policy. Independent work
starts with one worker, successful progress ramps concurrency up to the current host/task ceiling,
ready-frontier narrowing lowers it, and failure/review contracts future admission. Existing
in-flight workers are not cancelled. AgentDO wires the policy only when
`GOAL_ADAPTIVE_CONCURRENCY_ENABLED=true`; the flag is absent by default, so rollout remains disabled.
The goal activity API and Shell display current concurrency and the adjustment reason. Verification:
goal DAG/architecture suites **59/59**, Agents/Shell typechecks and `git diff --check`; local only.
APW02 remains partial: no mid-run task insertion, evidence/cost-calibrated routing, safe cancellation,
or deployed evaluation. Code `796182c785f18a69c0624d93acee1385cf7201e5` is pushed; rollout gate is off.

**Exact next action:** continue bounded dynamic replanning with stable task identity and host
revalidation, or move to another independent active-plan gap if planner inference would lack durable
billing/admission.

## Checkpoint — 2026-11-18 (`5aca9a29` pushed; APW02 next)

APW03 task decision references are pushed in `41c3b886b089d741441bc0d7fb7daf6072decb16` to
`origin/Mcbt5s-Backup-2`. PW03 writes v2 bounded checkpoint lineage (eight attempt
receipts) and pins progress to the Coordinator worker-branch revision/manifest hash when available.
Resume and the internal worker-result reader include that payload only if the same branch head still
matches; stale, legacy or unavailable branch checkpoints are withheld from both resume and internal
result reads, and the worker is told to recover from current workspace and disclose missing process
memory. Verification: checkpoint/delegation suites **18/18**, Agents typecheck and `git diff --check`.
Local/mock only; no deployed interruption acceptance. Legacy/R2 branches have no Coordinator pin;
full result revision lineage remains open. Code `5aca9a29746307dd60d840b320c39200f83cf67d` is pushed.

**Exact next action:** implement APW02 bounded dynamic host replanning in the durable goal DAG, then
continue the next independent gap. Keep rollouts disabled and preserve `infra/scripts/__pycache__/`.

## Checkpoint — 2026-11-18 (task-level Project decision dependencies; local verification)

Goal tasks now accept up to four validated `{id, revision}` references to the Project decision register. The host loads the scoped CAS Journal and rechecks that every referenced decision remains active at the exact revision and that any workspace pin still matches before dispatch, immediately before the external dispatch boundary, after successful worker completion/verification and when resuming saved completed tasks. A missing/stale/unavailable reference holds work as `needs_review`; DAG dependents become blocked. Dispatch race holds are marked in the durable outbox. References/reasons are stored in actor-scoped goal metadata and shown in the authenticated task UI; worker prompts carry the bounded references and tell workers to reread the current register. Verification: goal DAG/Project Journal/goal activity route suites **69/69**, Agents and Shell typechecks, `git diff --check`. Local/mock only; no browser/deployed acceptance. APW03 still lacks full base/result workspace revision linkage, semantic conflict mapping, integration evidence UX and owner review actions.

**Exact next action:** safely push this checkpoint to `origin/Mcbt5s-Backup-2`, then continue APW02's uncoded dynamic graph expansion/contraction only through a bounded host replan contract; otherwise continue the next independent active-plan requirement. Preserve the Python cache and rollout-disabled boundary.

## Latest pushed checkpoint — 2026-11-18 (`4b982864`)

The prior Project field-guide deletion and actor-filtered, bounded ingress memory checkpoint is `2b16d9f7f191619ff23e78378a9008f5b5546c3a`. This checkpoint adds store freshness timestamps from local structured/episodic records, Vectorize metadata when present, and authoritative Project fact `updated_at` through the Spaces route/client. Agent prompt context displays these as timestamps alongside bounded record IDs and layer. Do not describe timestamps as immutable content revisions. Legacy vectors may lack timestamps. Verification: Agents memory client/ingress/scope **13/13**, Spaces Project fact route **2/2**, Agents/Spaces typechecks and diff hygiene; local/mock only, no deployment/live acceptance. `4b9828643d1daa550ad96ce181e8d408e72954a8` is pushed to `origin/Mcbt5s-Backup-2`.

**Exact next action:** continue the next independent active-plan code gap. APW03 still needs task-level decision references and invalidation; APW04 still needs canonical source versions where the store can supply them and broader retention/leakage checks. Reconcile latest Knowledge and resumable-workflow callers before selecting the implementation slice.

## Checkpoint — 2026-11-18 (memory source freshness metadata; local verification)

Local structured facts now carry their `updated_at`, episodic and promoted semantic memories carry their creation timestamp when Vectorize metadata is present, and the Project fact endpoint/client passes through the authoritative row `updated_at`. The prompt renderer exposes this bounded freshness timestamp with layer/record identity. This is an update timestamp, not a content revision or hash; legacy vectors without metadata remain unversioned. Verification: Agents memory client/ingress/scope **13/13**, Spaces Project memory route **2/2**, both worker typechecks and `git diff --check` pass. Local/mock only; no deployed acceptance. APW04 exact source revisions, source hashes, retention/deletion policy across all stores and quality/leakage evaluation remain open.

**Exact next action:** safely push this checkpoint to `origin/Mcbt5s-Backup-2`, then continue the next independent requirement. For APW04, add immutable source revision/hash links only where the authoritative store provides them; otherwise keep the gap explicit and move to an independent planner, workflow, shared-compute, Knowledge or extensible-platform code gap. Preserve the Python cache and rollout-disabled boundary.

## Checkpoint — 2026-11-18 (memory prompt scope and guide deletion; local verification)

The Project field-guide register now has an admin/owner-only deletion operation requiring the exact entry revision; deleting removes both content and source pointers from the shared journal. The ingress memory prompt renderer independently filters actor-attributed recall to the current authenticated actor (and excludes it when there is no actor), retains bounded layer/record IDs for provenance, and limits selected rows to about 900 estimated tokens. This is a second privacy boundary; underlying store authorization remains required. Local ingress and Project Journal tests **12/12**, Agents typecheck and `git diff --check` pass. The renderer does not yet receive canonical source revisions or expiry/retention metadata; shared Project/Space and personal memory review/deletion rules still need reconciliation. No deployed/live acceptance.

**Exact next action:** safely push this checkpoint to `origin/Mcbt5s-Backup-2`, then implement revision-bearing memory provenance from existing stores or record the exact adapter contracts that prevent it, and continue auditing selective context assembly and Knowledge retention. Keep rollout disabled and preserve `infra/scripts/__pycache__/`.

## Checkpoint — 2026-11-18 (reviewed Project field guide; local verification)

APW04 now reuses the existing scoped Project Journal for a bounded field-guide register: one-line entries up to 400 chars, up to four source pointers, max 40 retained entries and the Journal's 16 KiB cap. Authenticated Project members can propose; current admin/owner must approve/reject the exact revision. Approval pins the current workspace head when available; reads report `current`, `stale`, `unavailable`, `unpinned` or `not_active`. Tool results and descriptions explicitly identify content as untrusted, non-authoritative guidance that is not auto-injected and cannot grant capabilities or budget. Round-trip/staleness/review/validation and planner kernel tests **22/22**, Agents typecheck and `git diff --check` pass. Local/mock only, not deployed. This covers Project guidance only; personal/Space guides, deletion/retention controls, selective token-aware context assembly and memory evaluation remain uncoded or partial.

**Exact next action:** safely push this checkpoint to `origin/Mcbt5s-Backup-2`, then implement a scoped owner/admin field-guide deletion/retention path and continue the APW04 context assembly trace. Preserve `infra/scripts/__pycache__/`; keep rollout disabled.

## Checkpoint — 2026-11-18 (cross-thread Project decision staleness; local verification)

`project_journal.read_decisions` now compares each active pinned decision with the current canonical workspace head and returns `workspaceStatus` (`current`, `stale`, `unavailable`, `unpinned`, or `not_active`). This is read-time advisory metadata: it does not mutate or revoke approval. The operation guidance tells later threads to revalidate stale/unavailable decisions against current Project code. The regression test proves a second actor sees a stale decision after the workspace advances and the persisted reviewed record remains unchanged. Focused Project Journal suites **20/20**, Agents typecheck and `git diff --check` pass. Local/mock only; no deployed acceptance. APW03 remains partial: tasks do not yet persist explicit decision ID/revision dependencies or automatically become `needs_review` when one changes.

**Exact next action:** safely push this checkpoint to `origin/Mcbt5s-Backup-2`, then implement the next APW04 scoped memory/context gap using existing Knowledge and Project stores, starting by tracing current context assembly and retention callers. Keep rollouts disabled and preserve `infra/scripts/__pycache__/`.

Source plan copied from `origin/plan/microapps-ui-sdk-voice` commit
`f991071dbb955423a359dba4cdf3ea2054ce9efc`; copied SHA-256
`8845f496b399408592d45670f04ce88e12176d61940cb8e16356a949ae6d3edf`. This plan extends the
planner/worker isolation, resumable workflow, shared compute, workspace, Knowledge and platform
plans; it does not replace their IDs or authorities.

## Requirement map

| ID | Requirement | Status and evidence | Remaining work / gate |
| --- | --- | --- | --- |
| APW01 | Reconcile planner, DAG, model routing, task memory, branches, recovery, callers and billing against current source. | PARTIAL AUDIT: planner-first protocol is in `workers/agents/src/script-engine/planner-first.ts`; bounded DAG dispatch and recovery are in `goal-dag.ts`; directed scoped task messages use `task-blackboard.ts`; runtime and token limits already apply. Existing ledgers cover PW01–PW06, SC01–SC05, K01–K30 and platform P/AP requirements. | Continue current-source comparisons when implementation reaches a requirement; no baseline task-quality/cost benchmark is recorded. |
| APW02 | Choose direct, one-worker, sequential or parallel execution; adapt within limits and explain the choice. | PARTIAL: planner-first routing is in `script-engine/planner-first.ts`; the bounded topology controller and durable receipt are in `script-engine/goal-dag.ts`. Opt-in `progressive-v1` begins independent graphs at one worker, ramps on verified progress, contracts after failure/review and narrows to the ready frontier (`796182c7`); a bounded 32-entry report-only history now records task/verification evidence. A gated host path supports structured one-level expansion, deterministic namespaced IDs, a 12-task ceiling, parent-budget inheritance, scoped metadata/blackboard updates, authorization/Billing-path checks and staged persistence replay (`139c6654` plus 2026-11-23 follow-ups). Goal plans admit at most four depth-two planners with bounded nested child-task allocations. Explicit alternative groups now have a default-off cancellation gate, durable dispatch fence, exact-attempt start check and bounded late-result/effects receipts (2026-11-23 follow-up above). Goal verification/runtime, token and internal-credit receipts join by stable worker ID. The paired local protocol/fixture is recorded above. | Cost-aware selection remains blocked pending a per-goal spend objective and representative controlled quality/cost evidence; internal credits may be unpriced and do not represent provider invoices. Real-runtime/provider comparative acceptance remains blocked under the protocol. Progressive routing, expansion and redundant-worker cancellation stay disabled by default. No savings claims or aggregate USD/credit escrow for expansions; per-inference quota/project-spend admission remains authoritative where configured. |
| APW03 | Durable task tree, ownership, decisions, dependency/revision links, scoped blackboard and conflict coordination. | PARTIAL/OVERLAP: goal tasks can carry up to four exact Project decision refs. Host rechecks active status, proposal revision and canonical workspace pin before dispatch, again at dispatch/result/resume; stale work becomes `needs_review` and blocks dependents. Actor-scoped task UI displays refs, hold reasons and bounded exact worker-branch base/checkpoint pins, validation receipts and publication outcomes. The Project page now supports scoped owner decision proposal/review with exact revisions, explicit supersession and stale-pin refusal; the worker conflict panel supports version preview and checked manual publication. | Task-specific decision-hold remediation UX, fresh checkpoint rechecks and live integrated acceptance remain partial; saved checkpoint pins in goal activity are historical and not rechecked for currentness; Project Journal is bounded at 16 KiB. APW07's cross-file semantic/interface taxonomy is tracked separately below. |
| APW04 | Scoped memory layers, provenance, context assembly, safe compaction, field guide, privacy and invalidation. | PARTIAL/OVERLAP: ingress rendering rechecks actor and token bounds; Space Assistant reads actor-scoped rows and restricts legacy entries to owner/admin; personal fact/episode deletion is exact on category, row ID and actor (`cba38ee9`); Project facts/Fabric/Wiki now have a direct cross-Project recall regression; Knowledge search citations carry source pins and Project membership gates run before retrieval. A deleted semantic copy is filtered at recall against the authoritative actor-scoped episodic row. | Canonical revisions/hashes remain absent for some adapters. No approved TTL/erase schedule exists for personal or Project Fabric/Wiki and promoted vectors; wait for per-class policy approval before adding one. No deployed privacy acceptance. |
| APW05 | Hierarchical cost accounting, pre-admission reservations, model/runtime selection, thrash control and fair scheduling. | PARTIAL/OVERLAP: bounded token budgets and per-inference Billing/Project holds cover goal model calls, including uncertain-outcome reconciliation; approved extension run/monthly budgets and durable workflow reservations cover declared extension authority; runtime capacity limits and hierarchical queue promotion are in SC. Owner usage displays internal credits plus unpriced or pending states. | No aggregate goal/task credit ceiling; the optional static task session ceiling is read/check-before plus tally-after, not an atomic run reservation. No approved cost/quality objective or task priority weights. Provider USD remains unverified without invoice reconciliation; do not infer a credit cap or priority from token budgets. |
| APW06 | SDK/template controls, authorized task UI, safe pause/cancel/resume, operations and evaluation. | PARTIAL/OVERLAP: actor-scoped task UI shows topology, role, token budget, acceptance criteria, runtime recommendation, per-task internal-credit usage, status and verification; goal decision holds now show a mapped reason, exact referenced revisions and a navigation link to the Project Journal review panel. The Project route retains membership, exact-revision and workspace-pin rechecks. Worker checkpoint/recovery disclosures exist. | Safe conversation/Project pause-cancel-status controls and user/admin topology/budget preferences remain partial; preference authority is not approved. Real-runtime/deployed comparative acceptance remains. |
| APW07 | Exact-revision workspace integration, conflict classification, neutral resolution proposals and checked publication. | PARTIAL/OVERLAP: PW03/EP04 provide isolated worker branches, pinned checked publication, Project decision revision guards and conflict preview/resolve callers. Validation receipts now link source base/commit, target revision/manifest, candidate and validation revisions/manifests, command digest and publication status; Goal Activity validates the source-base pin against current lineage. | Cross-file semantic/interface conflict classification needs an owner-reviewed evidence taxonomy and safe candidate/uncertainty contract; cross-DO publication-permit races still need authorized staging acceptance. Existing local receipts/helper tests do not prove real Coordinator concurrency. |
| APW08 | Durable resume, scoped user-visible task state and SDK/template orchestration declarations. | PARTIAL/OVERLAP: PW01–PW06 persist bounded workflow/checkpoint state; authenticated goal activity exposes topology, decisions, budgets and status; template/business-role and extensible SDK requirements are tracked in their ledgers. | Full user pause/resume/approval controls, stale authorization/budget recovery coverage, adaptive topology declarations for templates/SDK and real interruption acceptance remain. Never claim process-memory restoration. |
| APW09 | Evaluation, comprehensive economics and runaway/thrash controls before rollout. | PARTIAL/OVERLAP: SC/TBR ledgers cover internal credit admission, usage receipts and concurrency; the APW02 local comparison protocol/fixture is in the benchmark ledger; progressive routing and redundant-worker cancellation are opt-in and absent by default. | Representative model/customer task-quality and actual spend evidence, complete planner/integration/reviewer/provider metering, fair scheduling and real-runtime/live acceptance remain; no savings claims. |

The new plan was fetched from `origin/plan/microapps-ui-sdk-voice` at
`f991071dbb955423a359dba4cdf3ea2054ce9efc` and copied into this worktree. SHA-256:
`8845f496b399408592d45670f04ce88e12176d61940cb8e16356a949ae6d3edf`. APW07–APW09 explicitly
reuse PW/EP, workflow/template/SDK and SC/TBR authorities rather than duplicating them.

## Latest code checkpoint — 2026-11-17 (adaptive DAG topology receipt)

`goal-dag.ts` now computes topology from validated dependency reachability. A single task records
`single_worker`; a total dependency order records `sequential` and uses one active worker; a graph
with independent tasks records `parallel` and uses no more than current host concurrency or task
count. The journal is recomputed against live host limits on each resume, preventing a saved choice
from raising the current ceiling. The normal scheduler expands when its ready frontier has capacity
and contracts as tasks/dependencies exhaust it. It does not dynamically add tasks or make live model
quality/cost claims.

Local verification: `corepack pnpm --filter @naelao/agents-worker exec vitest run
src/script-engine/goal-dag.test.ts` **51/51**; Agents typecheck; `git diff --check`. No deployment,
provider call, migration or live acceptance. Rollouts remain disabled. At this entry the source,
tests, AGENTS.md and this ledger are uncommitted; preserve `infra/scripts/__pycache__/`.

**Exact next action:** fetch `origin/Mcbt5s-Backup-2`, verify no divergence, commit and push this
coherent checkpoint without rewriting remote history. Then continue SC03 durable admission only if
exact invocation authority and fresh Billing can be revalidated; otherwise proceed to the next
independent code gap in the active ledgers.

## Cross-plan checkpoint — 2026-11-17 (planner topology guidance; `c0c0f0fb` pushed)

`PLANNER_FIRST_PROTOCOL` now instructs the planner to use direct answers only for self-contained
requests and otherwise choose the smallest useful worker topology: one coherent worker, sequential
dependencies, or independent DAG work. It prohibits unnecessary workers and topology-based bypasses
of specialists, permissions, approvals or requested capabilities. Existing host controls continue to
select models/runtimes and enforce depth, attempts, concurrency and billing. Focused planner/DAG
tests **66/66**, Agents typecheck and diff hygiene pass. `c0c0f0fb` (including the topology receipt
and copied plan/ledger) is pushed to `origin/Mcbt5s-Backup-2`.

This guides model planning; it is not measured adaptive quality/cost, dynamic task insertion during a
running DAG, a new memory store, or live/deployed evidence. Exact next action: reconcile APW03 durable
task ownership/revisions and APW04 memory provenance with existing workflow journals, project memory,
Knowledge ACLs and private-Project policy, then implement the next missing reachable boundary.
SC03 remains independently blocked from disconnected replay because the host cannot yet revalidate
the exact invocation authority and fresh Billing admission; keep it fail-closed and continue other
code work. Rollouts remain disabled.

## Cross-plan checkpoint — 2026-11-17 (durable task contract in owner view; implementation pending push)

The persisted actor-scoped goal metadata now keeps each task's role, bounded model-token budget,
acceptance criteria and host-approved runtime recommendation. The authenticated activity route
validates/bounds these optional fields while retaining compatibility with older records; the Shell
shows them beside dependencies, verification and status. The runtime recommendation is descriptive
and does not grant capability. Local AgentDO route tests **5/5**, Agents/Shell typechecks and diff
hygiene pass. No browser/deployed acceptance. Exact next action: fetch and safely push this checkpoint,
then continue APW03 revision/ownership lineage or APW04 scoped memory and privacy gaps from their
existing records. SC03 remains fail-closed pending exact disconnected invocation authorization and
Billing admission. Keep rollout disabled and preserve the Python cache.

## Cross-plan checkpoint — 2026-11-17 (owner task topology receipt; implementation pending push)

The authenticated goal-activity projection now includes only a validated topology receipt from the
actor-scoped durable journal. The Shell task and worker panels display its mode and selected
concurrency relative to the host ceiling. This makes the actual persisted decision visible without
exposing worker transcripts beyond the existing actor/message scope. Local verification: AgentDO
goal-activity route **5/5**, Agents and Shell typechecks, `git diff --check`. No browser/deployed
acceptance. Exact next action: fetch and push this caller/UI checkpoint safely, then continue
APW03/APW04 lineage and memory authorization gaps; keep rollout disabled and preserve the Python
cache artifact.

## Cross-plan checkpoint — 2026-11-17 (personal-memory isolation and deletion authorization; pending push)

The memory prebuilt now rejects an explicit `user_id` that differs from the authenticated run actor
and cannot select a personal namespace when no actor exists. `MemoryStore.forget` carries the current
actor; local structured facts and episodic rows delete only under that user scope, and semantic
Vectorize deletion occurs only when an owned episode exists. Shared Project-fact deletion sends the
current effective role rank, and SpaceDO deletes only rows whose `required_role_rank` is no greater.
Local tests: Agents memory/client **14/14**, Spaces fact deletion **1/1**, Agents/Spaces typechecks,
diff hygiene. No migration, deployment or live acceptance. Exact next action: fetch and safely push;
then continue Knowledge/Project memory retention/review and APW03 decision/revision lineage across
the existing ledgers. Shared-memory policy for other layers and private-Project visibility remains
open; do not widen scope or infer product policy. Rollouts remain disabled.

## Cross-plan checkpoint — 2026-11-17 (per-task internal usage in worker panel; implementation pending push)

The worker panel now joins each goal task's persisted worker ID with the existing owner/admin usage
response and displays settled internal credits, unpriced-event count, or pending/unavailable state.
It labels the unit as internal credits and does not infer USD provider cost. Shell typecheck and
`git diff --check` pass; no browser/deployed acceptance. Exact next action: fetch and push, then
continue APW03 durable decision/revision lineage and APW04 scoped memory lifecycle. Hierarchical
atomic reservations and exact provider charges remain open under the existing billing/shared-compute
contracts. Rollouts remain disabled.

## Cross-plan checkpoint — 2026-11-18 (reviewed project decision register; implementation pending push)

The existing CAS-backed Project Journal now stores a bounded, versioned decision register with topic
key, proposal, rationale, interface references, proposer, reviewer, status, revision, timestamps and
explicit supersession. Project members with an authenticated actor may propose; current Project
admin/owner rank (>=2) is required to approve/reject. Review uses exact expected revision; another
active decision on the topic requires naming the exact superseded ID. Legacy `active_decisions` are
read-only through the old update operation and are explicitly labelled unreviewed. The planner is
instructed to read this register before creating project contracts. When the canonical workspace
manifest is available, proposals pin branch, revision and manifest hash; review rechecks that exact
head and refuses stale/unavailable revisions. Legacy workspaces without a manifest hash remain
unpinned. Verification: journal round-trip/hostile-data, decision proposal/review/supersession/
stale-head and planner tests **21/21**, Agents typecheck, diff hygiene. No browser/deployed
acceptance. Exact next action: fetch and push safely, then continue APW03 cross-thread decision
invalidation and APW04 field-guide/context gaps without duplicating the Journal or Knowledge
authority. Rollout remains disabled.
