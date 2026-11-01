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
| Blackboard event → authorized Project Bot wake → project thread/session → planner dispatch | `workers/agents/src/communications/blackboard-project-bot.integration.test.ts`; `tests/plan/runtime/space-do-acceptance.test.mjs` | **Locally integrated across two Workers.** Separate Wrangler processes run the actual Spaces Worker and an Agents test wrapper around the actual Agents Worker; `SPACES_WORKER` connects through Wrangler's local service-binding registry. The real D1 wake sweep and `wakeAgentGoal` reach actual `SpaceDO` and `NaelaoAgentDO` instances, and the Project Bot heartbeat thread/session is persisted. The Space is air-gapped, so AgentDO rejects cloud-model execution and the wake stays held; this does not prove a successful provider-backed worker run. |
| Blackboard delivery, retries, leases, and worker-to-worker messages | `workers/agents/src/communications/blackboard-delivery.test.ts`, `workers/agents/src/communications/blackboard-wake.test.ts`, `workers/agents/src/script-engine/task-blackboard.test.ts`, `tests/plan/runtime/space-do-acceptance.test.mjs` | **Partial.** Local two-Worker/D1 acceptance covers duplicate request idempotence/conflict, repeat-sweep deduplication, revoked authority before dispatch, viewer denial, busy-assistant backoff/retry, expired-lease hold, and SpaceDO thread/session persistence across process restart. It does not test concurrent wake-claim races, AgentDO goal-state recovery after restart, blackboard-message recovery, or external side-effect reconciliation. |
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

On commit `68922e7e` before the new integration/browser additions, repository tests passed (317 files / 3,135 tests), workspace package and Worker tests passed (467 / 2,426; one skipped), Agents passed (209 / 1,061; one skipped), Spaces passed (82 / 361), and Shell passed (5 / 15). Those suites overlap; their counts must not be summed. The blackboard-to-Project-Bot adapter integration passed (2/2); Agents passed after that addition (210 files / 1,063 passed / 1 skipped); browser journeys passed locally across three viewport sizes (6/6). Current focused checks additionally pass 86 tests across 14 platform/agent files and 5 local Wrangler runtime tests over separate Agents and Spaces Worker processes. These are local acceptance results, not deployed behavior.

The latest Wrangler run applied **154 repository D1 migration files** in **45.311 seconds**, started separate Spaces and Agents Workers in **2.408 s** and **3.654 s** respectively, and took **58.478 seconds** by harness instrumentation (**59.189 seconds** as reported by Node's test runner). The main blackboard request route took **134 ms**; the revoked-authority path took **105 ms** and made zero AgentDO dispatches; the busy retry route took **117 ms**; the expired-lease route took **64 ms**; and viewer denial returned 403 in **7 ms**. Restarting both Workers and re-reading the persisted SpaceDO thread/session took **6.266 s**. These are one-run local point measurements, not latency percentiles or production comparisons. The air-gapped AgentDO returned `compliance_violation` (403) before provider I/O. The CI runtime suite writes route, dispatch, and restart measurements as a JSON artifact.

## Immediate uncovered acceptance criteria

1. Add member/editor/viewer and archived-project UI journeys; assert hidden or disabled actions match backend authorization.
2. **Complete for local service topology:** separate Agents/Spaces Wrangler processes now communicate through the local service-binding registry. Deployed binding behavior remains untested.
3. Inject duplicate events, concurrent wake-claim races, AgentDO restart during dispatch, and ambiguous external side effects; busy responses, expired leases, revoked grants, duplicate request/event creation, and SpaceDO session recovery are already covered locally.
4. Persist one correlated audit trace distinguishing Space Assistant, Project Assistant invocation, and task/thread worker actions while demonstrating shared planner/worker execution.
5. Add a separate opt-in accepted worker run using a local/mock reasoning adapter; keep no-model and live-provider acceptance results distinct.
6. Run deployed acceptance against an isolated test Space and report provider-free tests separately from live model/provider tests.
