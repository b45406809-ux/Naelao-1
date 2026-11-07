# Wider Naelao platform research: applying workspace principles across the agent system

**Purpose:** a broader, codebase-specific set of design proposals following the two workspace research documents. This is documentation only. No code has been changed. It examines how ideas like durable state, explicit capability boundaries, immutable outputs, resumable work, and cost-aware execution can improve orchestration, providers, billing, user experience, and operations—not only filesystems.

**Baseline inspected:** `Mcbt5s-Backup-2` at `3737c841ffc435acde204a2f826df0c448dc9a19`. Relevant code includes Agents `AgentTaskWorkflow`, `ScriptRunWorkflow`, `WorkflowJournal`, `task-blackboard`, `TaskDO`, Spaces `SpaceDO` and provenance ledger, Billing workflow reservations/settlement, sandbox provider adapters, artifact RepositoryDO, and AgentPort. External provider/platform claims were checked against current primary docs on 2026-11-07. Vendor marketing statements are labeled as such; no live provider account was available in this research.

## Main thesis

Naelao has many of the right reliability parts already: Durable Workflows, durable task records, effect journals, budgets, branch isolation, fencing, provenance, usage accounting, and provider adapters. The broad opportunity is to make them compose through one **run envelope** and one **effect protocol** so retries, costs, permissions, artifacts, and user-visible status can be joined without trusting any single Worker or provider.

This should not become one giant orchestration service or a shared mutable “agent context.” Keep execution distributed across Workflows, DOs, Queues, Agent37, and provider workers. Standardize the identifiers and transitions that cross boundaries; keep each component’s durable state local to its owner.

## 1. Model a run as a durable envelope

### Current code pattern

The repository has distinct identifiers and records across Space task leases, `AgentTaskWorkflow`, WorkflowRunDO, `WorkflowJournal`, provider execution IDs, workspace publication IDs, billing reservations, artifact commits, and provenance entries. Many carry overlapping values (tenant, space, project, actor, run/task, branch, budget). The journal and budget types already support dimensions such as project, installation, runtime tier, used credits, artifacts, and external effects.

### Proposal

Define a versioned, immutable `RunEnvelope` passed as a reference through every subsystem. It includes tenant/space/project/installation, initiating actor and effective principal, root run/task IDs, child/attempt IDs, policy and capability snapshot versions, workspace branch/base revision, provider allocation ID/generation, model route, budget reservation, deadline, and trace correlation. Persist large inputs/results as hash-verified artifacts and put only references in Workflow payloads.

Each boundary returns a typed receipt: admitted/denied, allocated, dispatched, effect prepared/committed/uncertain, checkpoint published/conflicted, artifact committed, usage settled/reconciliation-required. The receipt includes the envelope identity and digest so a retry cannot bind an old result to a new task or project.

### Benefit and limits

This enables end-to-end audit, cost attribution, cancellation propagation, and consistent user status. It also catches scope drift between parent and child workers. The risk is an oversized universal schema and migration burden. Keep it small, versioned, allow additive optional fields, and avoid serializing secrets or full prompt/workspace content. Reject mismatched identity fields at every service boundary; do not trust a parent-supplied envelope without verifying its internal signature and resource grant.

## 2. Use one effect protocol for every external side effect

Naelao's `WorkflowJournal` already persists prepared effects and counts them; `AgentTaskWorkflow` uses durable steps and terminal task records; queue/webhook paths have idempotency keys. These should converge on a single lifecycle vocabulary:

`prepared → dispatching → committed | rejected | uncertain → reconciled`

An effect record carries effect ID, operation, canonical input digest, owner scope, provider, idempotency key, attempt, external receipt, timestamps, and reconciliation policy. An external call must have a stable idempotency key where the provider supports it. On timeout, query/reconcile by receipt or provider resource metadata before retry. If the provider offers no query or idempotency contract, surface `uncertain` for review instead of promising exactly-once execution.

**Do not confuse mechanisms:** Durable Workflow step completion prevents replay of a completed step in its own durable history; a Queue is at-least-once; a DO alarm is at-least-once and may restart on another machine. None grants exactly-once semantics to a remote payment, email, Agent37 instance create, or shell command.

**Likely bugs if done poorly:** same effect key reused with changed input; committing local success before provider acceptance; marking receipt before response body validation; retrying a timeout that actually succeeded; or settling cost from an untrusted provider estimate. Enforce key+input digest uniqueness and retain uncertain records until reconciliation.

## 3. Distinguish orchestration state from execution state

Cloudflare Workflows documents each `step.do()` as an individually retryable component. Current rules recommend keeping a step self-contained and warn against combining several service calls in one step unless needed to establish idempotency. Queue docs specify at-least-once delivery and do not guarantee global message ordering; DO alarms are at-least-once with automatic retries.

**Naelao design:** one Workflow step should own one durable transition or one idempotent external operation, and its result should be a small receipt/artifact pointer. Make multi-service effects explicit sagas with compensations or reconciliation rather than hiding them inside one opaque retryable callback. Keep task status and approval state in the actor that owns them; Workflow history schedules/resumes work but should not become a second editable task database.

**Storage limit:** current Cloudflare docs state Workflow instance persisted state is 100 MB on Free and 1 GB Paid. Streamed step outputs still count. Persist transcript chunks, command output, and large model/tool results to R2/artifact storage and checkpoint only hashes, bounded summaries, and pointers. The current workflow journal already caps retained artifact references and total tracked artifact bytes; verify each Workflow's serialized payload stays bounded too.

**Failure modes:** too many tiny steps increase durable history and latency; too few broad steps make retries repeat side effects. Establish step granularity by effects and recovery boundaries, then measure. Never place binary data, complete repository snapshots, or full model transcripts in Workflow results.

## 4. Use queues as buffers, not truth or ordering

Spaces has an outbox/retry pattern for provisioning, and the record says dual-write ambiguity was fixed by persisting intent before enqueue. Extend the same pattern wherever a D1 mutation fans out to Queue, notification, provider dispatch, or cleanup.

**Proposed outbox contract:** same database transaction writes business-state transition plus uniquely keyed outbox intent. A dispatcher sends it at least once and records delivery receipt. Consumer dedupes by stable message ID in the same transaction as its state transition. A DLQ entry remains an actionable durable record with owner, retry schedule, and alert—not a silent final state.

Cloudflare Queues explicitly allows duplicates and can redeliver; it does not guarantee ordering of messages as published. Therefore every consumer must validate the current aggregate version/lease before applying a message. For ordered per-task events, include monotonically increasing sequence numbers and ignore stale sequence numbers; do not infer ordering from timestamps.

**Cost/performance:** batch independent telemetry/usage writes and use bounded consumer concurrency. Do not batch tenant mutations if one invalid item can poison unrelated events. Measure queue age and oldest pending item, not only successful invocation counts.

## 5. Make the blackboard an event index over authoritative state

Current task blackboard, task publication, Spaces task leases, and provenance support genuine coordination. The recent local experiments show message delivery and prerequisite input matching can be tested, but the recorded next gates include real model evaluation, randomized races, multi-isolate deployment, and richer comparison against direct coordination.

**Proposal:** retain the authoritative task DAG and artifact state in Spaces/Agents owners. Treat the blackboard as an append-only, typed event/evidence index with explicit audience, project/branch/revision, sequence, provenance, expiry, and size. Workers fetch only task-relevant evidence through a bounded query, not full-board broadcast. Use content-addressed evidence references for large outputs. Indexing is rebuildable from authoritative event records.

**Risks:** the blackboard becomes a second authority; prompt injection enters as “evidence”; stale facts are presented as current; broadcast grows quadratically; or semantic retrieval leaks another project’s facts. Label untrusted evidence, enforce scope server-side, rank by relevance and freshness, preserve source/provenance, cap context by bytes/tokens, and test against direct handoff baseline. A measured reduction in duplicated work or tokens is required before claims of efficiency.

## 6. Cost is a control loop, not a final invoice

Naelao already reserves and settles Workflow/container budgets, tracks model usage, and has a billing worker. Improve by joining *admission estimate → reservation → actual receipt → settlement/reconciliation* under the RunEnvelope.

For each run, expose estimated and actual units separately: model input/output tokens, tool call count, Worker CPU, DO/Workflow duration, queue retries, Agent37 running minutes and retained disk, R2 stored bytes/operations, browser minutes, and external provider charges. Reconcile provider invoices/usage against internal receipts. Record uncertainty when providers report late or only aggregate data.

**Admission improvement:** before expensive allocation or model route, check tenant budget, project plan, tool-specific cap, residency, provider availability, expected output size, and deadline. Reserve maximum reasonable cost; release unused reservation after success, settle known usage, and hold uncertain charges for bounded reconciliation. Never use an estimate as actual usage. Add hard caps for run duration, retries, artifacts, bytes, concurrent allocations, and child-agent fan-out.

**Cost risks:** under-reserving causes unpaid compute; over-reserving harms UX; settling a provider estimate as exact creates ledger drift; repeated retries can multiply charges; sleep may stop compute but disk retention may still cost. Build scenario reports before changing unit prices.

## 7. Treat status as an event-derived view

There are distinct states for task, workflow, provider computer, execution, publication, budget, and artifact. Users need one understandable status but operators need all state machines.

**Proposal:** define a small normalized lifecycle event vocabulary while preserving owner-specific records. Project UI composes a view from signed/verified event receipts: queued, waiting for approval, allocating, running, checkpointing, conflict, completed, failed, uncertain/reconciling, canceled. Show provider/capability choice and workspace revision where it changes user expectations. Never show `completed` until required artifact publication and budget settlement policy reaches the defined terminal condition; alternatively show result complete with a separate usage reconciliation state.

**Delivery:** WebSocket/SSE event delivery is a notification stream, not durable truth. Give each event a sequence/cursor; clients reconnect and fetch missing range/current snapshot. Dedupe repeated events. Keep event payloads small and do not include secret-bearing provider responses.

## 8. Capabilities, tools, and permissions need a shared “why allowed” receipt

Naelao has model policy, air-gap, connector grants, container image approval, browser leases, channel scopes, and write guards across multiple paths. The architectural opportunity is one explicit admission decision record (not one global policy engine) generated by the owning host: principal, resource, requested action/capability, policy version, grant ID, residency/egress result, budget reservation, runtime choice, and expiry.

The runtime receives a minimized capability set. Every tool call revalidates authorization at the service boundary, especially after wait/approval/reconnect. Capability names should distinguish `files.read`, `files.stage_write`, `workspace.publish`, `network.fetch(host)`, `connector.invoke(alias, action)`, and `computer.exec`; a broad `workspace` or `network` capability is too coarse.

**Risk:** policy receipts can become bearer credentials if trusted blindly. Sign/attest or retrieve them by opaque ID from the owning service; bind them to run, actor, resource, and expiry. Revocation must take effect on each call, not only initial admission.

## 9. Model/tool orchestration: optimize context with evidence handles

The existing tool surface includes pagination, bounded outputs, memory/fact systems, and model routing. Connect those to artifact handles and workspace revision IDs: tools return a compact summary plus explicit `more` cursor/evidence reference; the model asks for exact ranges when needed. Reuse immutable prompt/config/tool bundles by digest. Keep long-running tool results out of context until referenced.

Track context source IDs, revisions, age, authorization scope, and token contribution. This makes stale-memory errors diagnosable and helps reduce model cost. Do not automatically include every project memory, blackboard item, or transcript chunk. Rank then budget with a deterministic cap, and report dropped/omitted sources to evaluation traces.

**Evaluation idea:** maintain a fixed task set with required evidence and expected action. Compare baseline vs selective retrieval for success, unsupported claims, cross-project leakage, tokens, latency, and cost. Optimize quality per dollar, not token reduction alone.

## 10. Provider economics and failure domains

Agent37 publicly advertises isolated sandboxes, file APIs, shell, signed URLs, gVisor, quotas, TLS ingress, and internet-only egress. Its public pricing describes compute while running and disk while retained. These vendor statements are useful but need account verification. They imply Naelao can avoid adding a Cloudflare Container just to execute a sandbox request; Cloudflare can still host the control plane, queues, journals, and revision service while Agent37 provides the guest runtime.

Design provider policy with separate states for configured, verified, degraded, unavailable, and revoked. Health probes should be bounded and avoid allocating billable instances. Schedule only on actual verified capability evidence and allowed region. Provider failover is safe only before dispatch or when the operation is idempotent/reconciled; never transparently fail over a command that may have executed.

Cost comparison must account for Agent37 retained disk during sleep, provider startup and API charges, Cloudflare storage/operations, R2 cache retention, egress, and retries. A warm pool may improve startup but retain disk charges and complicate tenant/cache isolation. Start with per-template opt-in warm policy, hard capacity cap, per-tenant budget, and eviction metrics; use only after measured total cost improvement.

## Feasibility and limits from current external docs

- **Cloudflare Workflows:** retry policy is per step; each step is a self-contained retry unit. Current limits page says sleeping/waiting steps do not count toward concurrency but instance state is capped (100 MB Free/1 GB Paid). Large outputs belong in R2/artifact references. Sources: [Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/), [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/), [retry configuration](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).
- **Queues:** delivery is at least once and ordering is not guaranteed. Use unique IDs/idempotency and aggregate sequence/version checks. Sources: [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [how Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/).
- **DO alarms:** at least once; failing handlers are retried with backoff (current docs: six automatic retries beginning at two seconds). An alarm handler may restart on another machine. Persist cursor/effect state before doing work. Source: [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).
- **DO lifecycle:** DOs can reset/evict and their in-memory state is not durable. Current rules advise scheduling alarms only when work exists because frequent alarms cost; do not poll every project every few seconds. Source: [DO rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
- **Agent37:** public [Cloud API](https://www.agent37.com/cloud), [pricing](https://www.agent37.com/pricing), and [lifecycle/cost article](https://www.agent37.com/blog/ai-sandbox) state that compute and retained disk have different lifecycle billing, and provider inactivity is not equivalent to completion of a background task. Treat as vendor-documented claims and confirm with API docs/account usage.
- **R2:** per-object conditional writes are atomic and strong consistency is documented; multi-object transaction is not promised. Keep manifest/head protocol as described in the workspace design note. Source: [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

All external docs above were accessed 2026-11-07. Product limits/pricing can change; recheck before implementation or spend decisions.

## Current code-specific risks to investigate (not declared defects)

1. **Completion versus settlement:** determine exactly when `AgentTaskWorkflow` marks the task terminal relative to artifact publication, Workflow budget settlement, provider usage arrival, and cleanup. If usage settlement retries after the user sees “complete,” reflect reconciliation separately; do not block customer-visible result indefinitely on a provider's late invoice.
2. **Remote effect uncertainty:** map all `prepareExternalEffect` call sites to provider idempotency/query support. Some providers may have no query-by-idempotency. Those operations need human reconciliation or at-most-once dispatch semantics, not automatic retries.
3. **Workflow retries around multi-service code:** inspect each `step.do` callback for multiple network effects, and ensure each step's returned value is small. A callback that creates an external allocation then writes D1 can succeed remotely but be retried after local persistence failure.
4. **Outbox completeness:** Spaces has documented provisioning outbox work. Inventory each D1+Queue, D1+DO, billing+provider, and artifact+notification dual-write. Distinguish already-journaled paths from gaps with fault injection.
5. **Blackboard quality claims:** current synthetic tests prove system invariants, not higher task success/quality than direct orchestration. Keep effectiveness claims gated on matched workload/model evaluation and real cost/latency measurements.
6. **Provider status freshness:** sandbox `/providers` is currently fail-closed/unavailable. When provider enablement is implemented, status must reflect credential verification time, template digest, region, and a staleness window. A green control API health response is not an execution health check.
7. **Metrics scope:** avoid per-run high-cardinality dimensions in expensive analytics storage. Keep detailed receipts in bounded durable records; export sampled aggregates with pseudonymous keys and retention controls.

These are audit targets, not findings that every listed path currently fails.

## Proposed experiments before broad refactors

| Experiment | Hypothesis | Metrics / falsification |
|---|---|---|
| End-to-end run envelope trace on one task path | Join task, child run, allocation, artifact, and charge without adding prompt/content data | Require 100% linkage, zero scope mismatch; falsify if IDs cannot be propagated without breaking public contracts |
| Fault-inject provider allocate/exec timeout at each boundary | Existing journals recover without duplicate resources or external actions | Count duplicate allocations/effects, uncertain outcomes, manual reconciliations; any duplicate charge is fail |
| Workflow step output audit | Workflow history contains pointers/summaries, not large payloads | Max persisted result size, state quota, replay duration; cap based on official current platform limits |
| Queue duplicate/out-of-order simulation | Consumers dedupe and reject stale aggregate versions | Duplicate side effect count must be zero; stale event mutation count zero |
| Context retrieval ablation | Evidence handles lower token cost without lowering task correctness | Quality, unsupported assertions, leakage, tokens, latency, total cost |
| Allocation warm/cold policy | Selective warm reduces p95 at acceptable actual disk/compute spend | Actual invoice cost per successful task and startup distribution; discard if total cost rises above user objective |
| User status event replay | Reconnect reconstructs exact task state from cursor/snapshot | Missing/duplicate client event effects zero; status convergence time and payload sizes |

## Priority order suggested by evidence

1. Fix/verify the current full test and browser journey failures documented in the branch's evidence records; all later evidence must be tied to the exact candidate commit.
2. Complete Agent37 live acceptance and preserve disabled scheduling until actual provider capabilities, operation receipts, billing, and cancellation have been verified.
3. Improve effect journal coverage and reconcile duplicate/uncertain operations across providers, billing, and queues.
4. Adopt atomic revision head publication from the workspace research proposal; use artifact references for large Workflow/model/tool outputs.
5. Add versioned RunEnvelope and lifecycle receipt propagation in a single vertical slice; measure trace/cost completeness before broad migration.
6. Test selective context/evidence retrieval and blackboard against controlled baselines.
7. Only after measurements, optimize warm pools, chunking, runtime selection, cache scope, and checkpoint cadence.

## References in addition to the workspace feasibility document

- Cloudflare [Workflow step design rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/), [limits](https://developers.cloudflare.com/workflows/reference/limits/), and [retry behavior](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).
- Cloudflare Queues [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [ordering and redelivery model](https://developers.cloudflare.com/queues/reference/how-queues-works/), and [retry configuration](https://developers.cloudflare.com/queues/configuration/batching-retries/).
- Cloudflare DO [alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/) and [DO lifecycle/cost rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
- Cloudflare Agents [Durable Workflows concepts](https://developers.cloudflare.com/agents/concepts/workflows/).
- Agent37 [API overview](https://www.agent37.com/cloud), [pricing](https://www.agent37.com/pricing), [runtime, state, and cost](https://www.agent37.com/blog/ai-sandbox), [privacy/retention](https://www.agent37.com/privacy), and [DPA](https://www.agent37.com/dpa).

## Scope note

This file proposes system-level improvements and verification. It does not claim that the entire Naelao product should be collapsed into this architecture, that every feature should use a Workflow, or that Cloudflare/Agent37 semantics are interchangeable. Each proposal should first be applied to one bounded vertical slice, measured, and retained only if correctness and total cost improve.
