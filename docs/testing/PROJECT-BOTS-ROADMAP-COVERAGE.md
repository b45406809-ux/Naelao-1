# Project Bots roadmap test coverage

**Audit date:** 2026-10-31  
**Reference:** [`new plan/PROJECT-BOTS-UNIVERSAL-AGENT-OS-ROADMAP.md`](../../new%20plan/PROJECT-BOTS-UNIVERSAL-AGENT-OS-ROADMAP.md)

This is a coverage map, not a feature-completion claim. “Covered” means repository tests exercise the stated code path; mocked tests do not prove deployed reliability.

## Identity and runtime boundary

| Area | Current code/test evidence | Status and proof limit |
|---|---|---|
| Space Assistant vs Project Bot scope | `workers/agents/src/script-engine/assistant-swarm-architecture.test.ts`, `tests/unit/project-assistant-mode.test.ts`, `tests/unit/project-coordination.test.ts` | **Partial.** The tests exercise explicit project scope and a common planner/worker path. They do not yet test every identity and workspace boundary through a browser and deployed runtime. |
| Project Bot vs task/thread worker | `workers/agents/src/script-engine/goal-dag.test.ts`, `workers/agents/src/script-engine/task-blackboard.test.ts`, `workers/agents/src/do/task-blackboard-route.test.ts` | **Partial.** Delegated worker IDs and recipient grants are tested separately from project planner invocation. Add a joined run trace that proves attribution for all three roles. |
| External channel principal isolation | `workers/agents/src/workflows/workflow-extension-scope.test.ts`, `workers/agents/src/launchpad/whatsapp-extension-webhook.test.ts`, `workers/agents/src/communications/verification.test.ts` | **Covered at unit/route level; live provider ingress remains untested.** |

## Collaboration, verification, and reliability

| Area | Current code/test evidence | Status and proof limit |
|---|---|---|
| Space-shared blackboard grants and request policy | `workers/spaces/src/blackboard-sharing.test.ts`, `workers/agents/src/communications/blackboard-domain.test.ts`, `tests/plan/runtime/space-do-acceptance.test.mjs` | **Local route acceptance covered.** The Wrangler harness applies repository migrations, publishes both project cards, enables the target wake policy, and creates a real cross-project request through the Spaces Worker. The project/viewer membership gate is also exercised against D1. |
| Blackboard event → authorized Project Bot wake → project thread/session → planner dispatch | `workers/agents/src/communications/blackboard-project-bot.integration.test.ts`; `tests/plan/runtime/space-do-acceptance.test.mjs` | **Locally integrated through the AgentDO boundary.** The runtime acceptance calls the real blackboard request routes, D1 wake sweep, `wakeAgentGoal`, actual `SpaceDO`, and actual `NaelaoAgentDO`; it confirms the Project Bot heartbeat thread/session is persisted. Wrangler routes `SPACES_WORKER` through a local service binding to the test Worker, which delegates to the real Spaces Worker module. This validates the binding contract in one local Worker harness, not a separately deployed Agents/Spaces service topology. The Space is air-gapped so the real AgentDO rejects cloud-model execution and the wake stays held; this does not prove a successful worker run. |
| Blackboard delivery, retries, leases, and worker-to-worker messages | `workers/agents/src/communications/blackboard-delivery.test.ts`, `workers/agents/src/communications/blackboard-wake.test.ts`, `workers/agents/src/script-engine/task-blackboard.test.ts` | **Partial.** Individual rules pass with test doubles; queue redelivery, concurrent claims, and restart recovery need service-level failure-injection runs. |
| Worker success separate from verification; dependent task gating | `workers/agents/src/script-engine/goal-dag.test.ts`, `workers/agents/src/script-engine/goal-evidence.test.ts`, `workers/agents/src/script-engine/assistant-swarm-architecture.test.ts` | **Covered in deterministic unit/synthetic flows.** Semantic correctness and evaluator calibration need held-out tasks and human labels. |
| Budgets, retries, and uncertain effects | `tests/unit/infra-usage-quota-gate.test.ts`, `workers/agents/src/workflows/agent-task-checkpoints.test.ts`, `workers/agents/src/script-engine/goal-architecture-benchmark.test.ts` | **Partial.** Atomic reservation and fail-closed handling are covered; broad concurrent billing races and provider-side uncertainty remain separate acceptance work. |

## Product journeys and deployment

| Area | Current code/test evidence | Status and proof limit |
|---|---|---|
| Bots roster → open project-scoped conversation | `tests/plan/browser/02-project-bot-journey.spec.ts` | **Synthetic browser journey.** It uses a local fake API, seeded test session, and Chromium; it verifies scoped thread creation and URL navigation, not backend identity verification. |
| Narrow viewports | `tests/playwright.plan.config.ts` | **Locally passed.** Shell and Project Bot journeys pass at desktop, 338px, and 740px. The full matrix is included in the browser CI suite. |
| Bot navigation, roles, refresh/history, archive/restore, member visibility | `apps/shell/src/app/p/[slug]/(shell)/bots/page.tsx`, `tests/plan/browser/02-project-bot-journey.spec.ts` | **Partial.** One owner journey is covered. Member/role and lifecycle browser flows remain open. |
| Durable Cloudflare deployment, live providers, user data | Full-test GHA and connected checks | **Not established by local tests.** Wrangler acceptance is local, not deployed. A deployed test tenant, provider configuration, and explicit live acceptance are still required. |

## Current local test evidence

On commit `68922e7e` before the new integration/browser additions, repository tests passed (317 files / 3,135 tests), workspace package and Worker tests passed (467 / 2,426; one skipped), Agents passed (209 / 1,061; one skipped), Spaces passed (82 / 361), and Shell passed (5 / 15). Those suites overlap; their counts must not be summed. The added blackboard-to-Project-Bot adapter integration passed (2/2); Agents passed after that addition (210 files / 1,063 passed / 1 skipped); browser journeys passed locally across three viewport sizes (6/6); and the Wrangler runtime acceptance passed (2/2) using the real migrated local D1, Spaces Worker, and SpaceDO. This is genuine local Cloudflare-runtime evidence, but it does not prove the Agents Worker service-binding path or deployed behavior.

The latest Wrangler run applied **154 repository D1 migration files** in **45.509 seconds**, started the local Worker in **300 ms**, and completed the test process in **48.982 seconds**. Eight post-bootstrap route calls took **4–141 ms** each; the 77 ms blackboard-wake call includes actual D1 policy/request writes, local service-binding delivery, wake dispatch, and both real DOs. The 403 viewer denial took 7 ms. This is one local loopback run, not a stable latency benchmark or production comparison. The air-gapped AgentDO returned `compliance_violation` (403) before provider I/O, and the wake remained held. The CI runtime suite writes route and dispatch measurements as a JSON artifact.

## Immediate uncovered acceptance criteria

1. Add member/editor/viewer and archived-project UI journeys; assert hidden or disabled actions match backend authorization.
2. Expand from the local self-bound Wrangler harness to separately configured Agents and Spaces Workers with an actual local inter-worker service binding; preserve the no-provider air-gapped guard.
3. Inject duplicate events, expired leases, busy assistant responses, revoked grants, and worker restart between durable session creation and script dispatch.
4. Persist one correlated audit trace distinguishing Space Assistant, Project Assistant invocation, and task/thread worker actions while demonstrating shared planner/worker execution.
5. Add a separate opt-in accepted worker run using a local/mock reasoning adapter; keep no-model and live-provider acceptance results distinct.
6. Run deployed acceptance against an isolated test Space and report provider-free tests separately from live model/provider tests.
