# AI OS competitive platform implementation

This checklist tracks the platform work requested after the Joule comparison. Domain-specific behavior belongs in optional FDE templates and extensions. Do not interpret unchecked items as shipped.

- [x] Block Space Template activation when a required shared extension is staged or has an unknown installation state; expose the state in the preview contract.
- [ ] Generalize certified extension dependency discovery and installation beyond the first-party dogfood catalog, including explicit grant review, pinned releases, tenant entitlement and upgrade/rollback. (In progress: template activation presents requested Space-shared filesystem access, preserves and shows existing grants, applies owner-selected least-privilege changes, blocks required extension dependencies without an exact version pin, and rolls back newly installed dependencies when dependency setup or template instantiation fails. Fresh installation of portable FDE packages remains unsupported.)
- [ ] Complete SDK and host capability discovery for connections, tools, workflows, workers, knowledge, canvases and widgets, with per-operation scope and grant enforcement. (In progress: previews disclose per-primitive tools, provider events, resources, roles and exact Gadget action/table grants. Project canvases can now declare read-only Gadget/table grants; a host route binds reads to the signed canvas release, active installation, project membership and table allowlist. The SDK exposes a typed browser client for granted reads and planner actions, with no Gadget write method. Planner action responses now correlate to the originating canvas, distinguish queued/completed/failure, and preserve the durable run ID when available. Writes and external actions still go through planner/worker grants. Required provider connections on SPACE_SHARED extension dependencies remain blocked because the provider lifecycle is project-bound.)
- [ ] Deliver install previews covering supported operations, connection requirements, permissions, plan limits, costs and evaluated limitations without implying unverified readiness. (In progress: marketplace listings disclose bounded extension, credential, runtime and author-declared plan-gated feature prerequisites before Space creation; the UI explicitly says current entitlement has not been checked. Pending activation is resumable from the Spaces dashboard, and post-create previews show extension summaries and planned container slots/resources. Feature-to-plan entitlement resolution and provider/runtime cost estimation are unavailable.)
- [ ] Complete adaptive workspace assembly using approved installed components and persistent user-editable artifacts.
- [ ] Verify durable Space and Project assistant execution, blackboard policy, worker scope, progress, escalation and channel continuity end to end.
- [ ] Provide a unified task view with evidence, external action outcomes, approvals, blockers and user-controlled access. (In progress: durable tasks now retain their canonical Project scope from the authorized session, and product users can browse Project task records after membership verification using bounded keyset pagination; task status routes also allow that Project membership. Conversation views show approvals/questions, worker activity, recent task graphs, artifacts, knowledge-search citations and bounded host-observed tool-call outcomes. Processing tasks can be stopped cooperatively from their conversation; the cancellation route now verifies conversation access before acting. The UI shows elapsed wall time, explicitly noting that approval waits are included, and specific progress text for queued, running and approval-waiting tasks. Project-visible records now include content-free worker coordination counters per graph (step status totals, escalation count and fixer count); worker prompts, outputs and blackboard messages remain conversation-scoped. It also says a successful tool call does not independently prove an external service committed the change. Goal history is actor- and Space-scoped in the session Durable Object and bounded to the latest 20 graphs; a current-run fallback preserves older graphs. Provider-confirmed action receipts and detailed Project-wide worker/DAG aggregation remain unavailable.)
- [ ] Complete and verify the Foundry build, certification, clean export, fresh-Space installation, upgrade and rollback lifecycle for independent FDEs.
- [ ] Provide the private team template and scoped benchmarking APIs; measure completion, intervention, latency, cost, failure and duplicate actions.
- [ ] Create and exercise a domain-neutral reference template with simulated cross-system data, a review canvas, approval, confirmed action and interruption recovery. (In progress: added a simulation-only reference Space with linked request/order/invoice fixtures, persisted resume state and review packet, plus a project extension example that reads only an explicitly granted Gadget table and sends decisions back through the planner. The extension is not yet installable as a portable marketplace dependency; no live provider action or end-to-end exercise has been performed.)
- [ ] Perform live acceptance for each supported external provider and document the exact product, version, operations and limitations. SAP support is not implied.

Verification for the completed item: Spaces Worker blueprint activation suite passed (15 tests), including a route-level staged dependency rejection; Spaces Worker typecheck passed. Live deployment and marketplace acceptance were not performed.

## Focused test evidence (2026-11-01)

The selected competitive-platform Vitest run passed **86 tests across 14 files** in **9.61 seconds**. It covered Space Template activation previews and dependency/plan blockers, certified artifact and marketplace publication gates, extension grants and scoped runtime installation, Foundry/reference Space Template contracts and fresh-Space isolation, blackboard wake authorization, worker-message boundaries, and capability-scope validation. Command:

```sh
./node_modules/.bin/vitest run --config vitest.workspace.ts \
  workers/spaces/src/blueprint-activation.test.ts \
  workers/spaces/src/certified-blueprint.test.ts \
  workers/spaces/src/routes/marketplace.test.ts \
  workers/spaces/src/foundry-and-cross-space.test.ts \
  workers/spaces/src/do/reference-blueprint-install.test.ts \
  workers/spaces/src/do/extension-runtime-install.test.ts \
  workers/agents/src/communications/blackboard-project-bot.integration.test.ts \
  workers/agents/src/communications/blackboard-wake.test.ts \
  workers/agents/src/script-engine/task-blackboard.test.ts \
  packages/agent-sdk/src/templates/reference-spaces.test.ts \
  packages/agent-sdk/src/templates/foundry-space.test.ts \
  packages/agent-sdk/src/space-shared-extension.test.ts \
  tests/unit/capability-scope-boundary.test.ts \
  tests/unit/blueprint-conformance-workflow.test.ts
```

The local Wrangler acceptance suite passed **5/5** after applying all **154** repository D1 migration files. It runs separately configured Spaces and Agents Workers in different Wrangler processes, joined by the actual `SPACES_WORKER` local service binding, and checks:

- A duplicate blackboard request is idempotent: one request row and one event row remain.
- Reusing that request ID for different content is rejected with `409 request_id_conflict`.
- Repeating the wake sweep after its first dispatch does not dispatch a second time.
- Revoking the authorized user's actual D1 membership before the wake makes the wake `held`; the AgentDO dispatcher is not called.
- A simulated busy-assistant 409 returns the wake to pending; after the 300-second backoff is advanced in the test clock, the actual AgentDO dispatch runs once and is held by the air-gap policy.
- An expired running lease is moved to `held` without redispatch.
- A viewer represented in D1 is denied Project Bot thread creation with `403`.
- The authorized wake reaches the real local SpaceDO and AgentDO paths and persists its Project Bot heartbeat thread/session, then is rejected with `403 compliance_violation` because this fixture is air-gapped. No model/provider request or successful planner/worker task is claimed.
- Both Wrangler processes are stopped and restarted against the same local persistence directory; the SpaceDO thread/session can still be read with the same IDs and metadata.

Latest single-run measurements: migrations **45.311 s**; Spaces Worker startup **2.408 s**; Agents Worker startup **3.654 s**; both process restart and readiness **6.266 s**; instrumented harness duration **58.478 s** (Node test command **59.189 s**); original wake route **134 ms**; revoked-authority route **105 ms**; busy retry route **117 ms**; expired-lease route **64 ms**; viewer denial **7 ms**. These are local point measurements from one run, not latency percentiles, production performance, or a comparison baseline. The CI workflow uploads the runtime JSON measurements, but its post-push run was not inspected in this pass.

## What the tests establish—and do not establish

| Checklist area | Current evidence | Still not established |
|---|---|---|
| Template dependency/permission preview and activation gates | Focused activation suite covers auth, exact pins, install state, owner approval, runtime limits, and activation blockers. | Portable third-party FDE package installation, actual entitlement resolution, provider connections for Space-shared dependencies, live activation. |
| SDK/host capability grants | Focused suites cover capability-scope validation, Space-shared SDK client surface, owner-approved extension grants, and runtime scope. | Complete discovery for every primitive, all production provider lifecycle paths, end-to-end external writes; canvas-specific security tests were not part of this run. |
| Marketplace/conformance | Focused suites cover signed artifact-bound certificates and publication rejection on missing/stale/changed evidence. | A live team-tenant certificate or an independent publisher's full marketplace lifecycle. |
| Space assembly/reference templates | Reference templates instantiate in isolated test Spaces; runtime installs test grants, versions, pause, rollback and plan caps. | Adaptive assembly with persistent user-edited artifacts, and a portable reference product executed end to end. |
| Space/Project assistants and blackboard | Adapter tests plus local migrated D1 and two separate Wrangler Workers cover wake creation, persisted heartbeat thread/session, deduplication, revoked authority, busy retry, expired lease, viewer denial and SpaceDO persistence across process restart. | A completed provider-backed planner/worker task, deployed service-binding acceptance, AgentDO goal-state recovery/ambiguous-side-effect reconciliation after restart, and concurrent wake-claim races. |
| Unified task view | A prior local synthetic browser run recorded 6/6 journeys across desktop, 338px and 740px; task/coordination contracts have focused unit coverage. | Real authenticated UI-to-DO task/evidence/approval flow and full member/role lifecycle coverage. Browser journeys were not rerun in this pass. |
| Foundry/FDE lifecycle | Foundry blueprint and cross-Space grant tests pass; bespoke retired Foundry routes are tested absent. | Clean third-party export, portable install, certification and upgrade/rollback by an independent FDE. |
| Team template and benchmarks | Not tested in this focused run. | Private team template, scoped benchmarking API, and benchmark results on representative tasks. |
| Domain-neutral reference workflow | Reference Space descriptors and fresh-Space installation are tested. | Simulated request→review→approval→confirmed action→interruption recovery as one integrated user journey. |
| External providers | No live provider was called. | Provider-specific authentication, event delivery, action confirmation, rate limits, cost and operational acceptance. |

The **86-test focused suite and 5-test Wrangler suite are evidence for specific paths only**. This document remains an implementation-progress checklist; passing focused tests do not turn the unchecked marketplace, provider, benchmarking, or product-lifecycle items into shipped capabilities.
