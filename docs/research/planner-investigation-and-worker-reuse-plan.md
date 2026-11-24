# Planner investigation and worker reuse

## Outcome and ownership

Space and Project planners own the conversation and orchestrate work. They reason over the user's
brief, existing authorized context and returned evidence, choose an execution shape, ask follow-up
questions, reconcile findings and present the answer. A worker performs investigations that require
discovering files, querying the web, searching connectors or logs, or iterating on tool results.
Use a narrow host lookup for an exact authorized reference and a single worker for a connected
investigation. Add parallel workers when the questions can be answered independently and the extra
work is justified. Every worker uses the existing NaelaoAgent runtime.

This plan specifies the planner boundary and investigation routing under [APW01 and APW02](adaptive-planner-worker-swarm-memory-plan.md),
reusable definitions under APW08, and comparison under APW02/APW09. It uses
[PW's session, attempt and recovery contracts](resumable-workers-durable-workflows-and-branches-plan.md)
and the [planner/worker isolation plan](planner-worker-isolation-and-conflict-resolution-plan.md).
Template embedding uses the [TBR host binding rules](template-business-roles-and-member-onboarding-plan.md).
Record implementation and evidence under the existing IDs in the
[APW ledger](adaptive-planner-worker-swarm-memory-progress.md). The
[implementation queue](../operations/implementation-queue.md) holds the current task and handoff.
This plan authorizes no deployment, rollout enablement, spend-policy change or external effects.

## Source and research baseline

At `003f79d7`, [agent-topology.ts](../../workers/agents/src/script-engine/agent-topology.ts)
allows planner `Read` and `Bash`. [ToolSurface](../../workers/agents/src/script-engine/tool-surface.ts)
removes planner writes, denies native execution and filters virtual shell commands, but still permits
content inspection with commands such as `cat`, `grep` and `find`. The Space cabinet route can
delegate a bounded operation. Preserve that host-mediated worker path after checking its authority and
caller. Inspect planner-first prompts, tool discovery and dispatch separately. A prompt change alone
leaves the existing operation surface available.

[The goal planner](../../workers/agents/src/script-engine/prebuilt/goal-planner.ts) accepts structured
task specs, role, dependencies, evidence and optional configured agent identity.
[NaelaoAgentDO](../../workers/agents/src/do/NaelaoAgentDO.ts) starts child sessions with host-selected
capabilities and a signed delegation contract. It stores job-specific configuration for continuation.
[Sub-agent output handling](../../workers/agents/src/script-engine/sub-agent-output.ts) bounds and marks
returned text as untrusted. Configured agents, skills, coordination patterns and resumable sessions
are useful inputs to build on. None of those is the proposed versioned worker-definition library.

[Anthropic's multi-agent Research report](https://www.anthropic.com/research/multi-agent-research-system)
reports a 90.2% relative improvement on its internal evaluation against single-agent Opus 4. The
comparison used an Opus lead with Sonnet workers, and gains were strongest for independent avenues of
research. Anthropic observed duplicate searches with vague assignments, and recommends one agent for
simple fact-finding. [Kim et al.'s revised scaling study](https://arxiv.org/abs/2512.08296) reports
260 configurations with standardized tools, prompts and compute. Reported extremes span +80.8%
relative performance on decomposable financial reasoning to −70.0% on sequential planning.
[Claude Code](https://code.claude.com/docs/en/sub-agents#choose-between-subagents-and-main-conversation)
uses separate contexts for verbose exploration and retains tightly iterative work in one conversation.
These results motivate routing hypotheses. They supply neither Naelao routing thresholds nor
performance, latency or savings estimates.

## Route by what the task needs

| Request shape | Execution and result |
| --- | --- |
| The user's message and already loaded context answer the question | Planner answers directly. No new tool or worker run. |
| An exact, authorized source identifier is already known | The host returns a bounded decision, task/evidence receipt, or an exact workspace excerpt when a supported reader can enforce the pin and bounds. No model chooses where to search. |
| One investigation needs discovery or its next step depends on its previous finding | One scoped NaelaoAgent worker owns the loop. Keep related steps and clarifications in that worker session where the current contract allows. |
| A goal has independent questions with verifiable boundaries | Ask distinct workers for separate outcomes using the existing DAG and concurrency admission. The planner combines answers and can request targeted follow-up. |
| A large goal has genuinely independent subtrees | The existing bounded subplanner mechanism may split the goal further. Each subplanner has the same tool boundary and host admission as the root. |

For an unknown or ambiguous task, start with one focused discovery worker and use the first result
to refine the plan. Parallelize by claim, source set or outcome rather than by arbitrary file count.
Record each task's question, scope and expected evidence so duplicate assignments are visible.
When a later step needs the full reasoning context or tool state from an earlier step, keep both
with the same worker. A material change in capabilities, authority or task ownership requires a new
admission, even if the follow-up uses the same worker definition. A standalone investigation can
eventually take a direct-to-worker path if the normal product entry point can preserve caller
identity, user-facing results, controls and billing. The initial implementation can use the existing
single-worker delegation path.

Examples include fetching an exact Tier 6 decision revision, assigning one worker to trace media
sandbox startup from caller to runtime, and assigning independent workers to compare three providers
against the same criteria. For the comparison, give each worker one provider and ask it to return
the applicable primary sources, date, evidence, conflicting claims and gaps.

## Enforce the planner boundary at the host

- Keep orchestration operations for scoped task, decision, worker and goal status, task assignment,
  bounded follow-up and control through existing authorized paths. Audit Project, Space, nested
  planners and cabinet calls. Tool discovery and invocation must agree. Trace direct calls,
  virtual CLI aliases and pipelines, skills, code-mode proxy/tool dispatch, raw connector tools,
  thread operations and saved session recovery. Planner-visible search over orchestration state
  must remain scoped to the actor and target. File, web and connector exploration belongs to workers.
- Replace general planner file reads and filesystem-discovery commands with an exact lookup.
  The initial contract takes a typed source kind and scoped ID, or one exact workspace path plus
  immutable revision and bounded range. It returns the source reference, exact revision, bounded
  content and truncation or freshness status. It accepts no globs, traversal, arbitrary URLs,
  full-text query, enumeration, batching, recursion or redirected storage path. Avoid an indirect
  shell or adapter path that can rebuild general search by composing lookups. Bind per-call and
  per-run limits to trusted host policy and cover cumulative reads, including retries.
- Recheck actor, tenant, Space, Project, visibility, current grant and exact revision on reads and
  new attempts. Resolve file pins through the authoritative checked workspace read path. If a
  source kind has no safe exact reader, send the investigation to an authorized worker. On stale,
  absent, forbidden or oversized content, return a bounded status and disclose only permitted
  information. Never replace a denied lookup with a more privileged worker. An authorized worker
  may investigate a stale or unavailable reference with fresh evidence where the scope permits.
- Enforce the boundary where requests execute, even when a skill, saved context, model output,
  hidden operation, tool alias or host helper asks to cross it. Keep worker role admission separate
  from planner behavior. Preserve current extension, public-room and cabinet authority controls.
- Persist a bounded route reason and actual outcome in existing task/goal receipts when applicable.
  Show source references, evidence limits and partial status in authorized UI. Keep raw prompts,
  customer content and secret values out of routing telemetry. Use existing admission, cost and
  task-control mechanisms. Launch the worker on the least costly authorized capable execution tier.
  Worker creation alone does not require a container. Any Tier 6 work uses the
  [one-allocation-per-Project runtime contract](single-project-tier-6-runtime-plan.md).

## Dynamic workers and reusable definitions

The planner proposes a task by stating the objective, role, required capabilities, supplied source
or decision references, dependency constraints, acceptance criteria and requested result shape. It
can request an eligible configured agent, reference an applicable saved definition or supply an
ephemeral task brief. The host binds actual tools, model and skills from current policy. The task spec
may express a model requirement or preference supported by its entry point. A goal task's raw model
ID does not override host selection. A normally scoped read-only investigation has no write/effect
capabilities. If findings justify an action, create a separately authorized task with explicit intent.

Treat the following as separate records:

| Record | Contract |
| --- | --- |
| Worker definition | Reusable instructions and capability requirements, referenced by an immutable version. |
| Workflow definition | Bounded task and stage graph with symbolic role bindings, dependencies, inputs, outputs and communication rules. |
| Task and worker session | Current actor, objective, pinned definition version and effective configuration after admission, deadline where supported, task budget, runtime and scoped session identity. |
| Attempt and result | Fenced execution identity, checkpoint lineage, exact evidence references, status, usage and approved artifact refs. |

For the APW08 version-one design, a worker definition contains a schema version, stable definition
ID and immutable revision, owner and trusted scope, purpose and matching criteria, role and
instructions, symbolic inputs, requested capabilities and skill references, optional model
requirements, output schema and evidence expectations, supported communication, and provenance or
review status. A workflow role can bind to an exact installed definition version. The validator
rejects unknown or unsupported schema versions, unresolved bindings and graphs exceeding present host
depth, fan-out or admission limits. Resolve referenced package/grant revisions at admission and
store the pins needed for revalidation. The definition never carries live credentials, actor grants,
budget allocations, raw session history or private evidence payloads.

Prefer matching by fit and access. Start with a bounded lookup of eligible reviewed definitions in the
current scope. A built-in, installed template or reviewed Project definition can supply the same
contract. If no match fits, create a fresh task configuration from the available capabilities.
Adaptations are run-local unless explicitly saved as a reviewed new revision. Persist a reusable
definition separately from runnable attempts. Make publication and retirement explicit via existing
scope/owner authority. For a past successful worker, propose reusable instructions only with scoped
provenance such as a verified task outcome and safe evidence reference. Keep task data out of the
definition, and never promote raw worker output or grant authority from success history. Older
configured agents and extension role declarations retain their supported behavior and can be bound
through adapters only after compatibility checks. SDK export and template import round-trip
declarations without carrying permissions or budget.

Fresh runs and resumes both resolve effective permission, entitlements, current model/runtime,
workspace fences and budget through the existing host checks. Preserve the exact version pinned to
an admitted session. A retired or revoked version is ineligible for new admission. On resume,
validate the pinned version against current authority and lifecycle policy, then hold unavailable
or unauthorized work with an explicit reason. Do not silently substitute another revision. Reuse an
active worker for a dependent follow-up only with its original scope, remaining budget and current
attempt authorization. Reusing a definition creates fresh session state unless there is an explicit
authorized continuation. Reuse of completed results remains subject to existing evidence, freshness
and cache policy. The APW08 wall-clock and pause/expiry policy remains a separate requirement. Do
not infer a time limit from unrelated runs.

## Evidence contract

Let a worker keep its search context and operational detail. Return a bounded result with task and
attempt identity, completion/partial/blocked outcome, findings, exact source references or scoped
artifact pointers, known gaps or conflicts, and any recommended follow-up. Accept file paths and
revision/line or range references, URLs and retrieval dates, or authorized operation receipts, as
appropriate. Host-owned verification, budget and effect receipts remain distinct from worker claims.
Only expose evidence the viewer may access. Bound item count and size under existing task budgets
and output limits. Keep retrieved excerpts and worker text marked as untrusted. The planner can
request missing evidence or ask for a bounded independent check, and must communicate when evidence
is incomplete. A completed task alone cannot authorize publication or an external action.

## Implementation order and acceptance

1. **APW01/APW02 — Planner boundary audit and exact lookup.** Trace currently reachable planner
   routes from prompts/discovery through permission gates to tool execution, starting at
   `agent-topology.ts`, `tool-surface.ts` and the ToolSurface setup in `NaelaoAgentDO.ts`. Record
   caller, scope, existing tests and exact working replacement for each legitimate planner use.
   First deliver one independently verifiable host boundary slice around an existing exact Project
   decision or goal/evidence lookup. Then replace planner workspace discovery with delegation,
   narrow exact excerpt reads where supported and verify both denied and surviving callers. Separate
   prompt/display changes from invocation enforcement in the evidence.
2. **APW02 — One investigation worker and adaptive fan-out.** Use the normal goal and direct
   delegation entry points with bounded read-only investigation briefs, result validation and
   resume-aware follow-ups. Test known-reference routing, one worker following dependencies, distinct
   concurrent research, queued capacity, duplicate dispatch, low budget and partial results. Reuse
   existing scheduling and control surfaces. Keep cost-tuned routing and speculative expansion under
   existing gates.
3. **APW08 — Versions and reuse.** Implement the internal strict parser, scoped discovery, immutable
   versions and host binding with fixtures, then add compatible SDK/template declarations under
   APW/PW/TBR review. Test a saved and ephemeral definition for the same task, revision pinning,
   duplicate and concurrent saves, retirement, missing packages, removed capabilities, cross-scope
   access, fresh billing admission, version revalidation on resume, and rejection of authority or
   budget fields. Keep public compatibility, shared publication scope and live acceptance visible
   as separate dependencies. Run reachable SDK/template and agent caller tests.
4. **APW02/APW09 — Compare and verify.** Extend the existing
   [comparative protocol](../benchmarks/adaptive-goal-routing-comparative-protocol.md). Use paired
   examples for exact reads, sequential investigations, parallel research and mixed goals. Compare
   planner-led inspection as the existing baseline, the same task with one worker, and parallel
   workers where applicable. Use matched total budget, tool scope and model for architecture
   comparisons, and report practical cost/latency comparisons separately. Measure correctness,
   citation support, completeness, total tokens and billable usage, wall time, repeated reads and
   queries, denied operations, and recovery. Include an authorized local fixture that proves
   planner shell/raw-domain denial, bounded lookup behavior, harmless untrusted result handling and
   worker access revalidation. Provider pricing, live recovery, rollout and numerical cost-aware
   defaults remain subject to the existing acceptance gates.

Begin with the local boundary slice and preserve the existing gates on public contracts and live
acceptance. Record verified checkpoints in the queue and APW ledger. Keep a live task open until the
relevant real service evidence exists.
