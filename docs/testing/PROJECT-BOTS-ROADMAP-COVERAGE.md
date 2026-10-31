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
| Space-shared blackboard grants and request policy | `workers/spaces/src/blackboard-sharing.test.ts`, `workers/agents/src/communications/blackboard-domain.test.ts` | **Covered at domain level.** Real database and multi-tenant service acceptance still needed. |
| Blackboard event → authorized Project Bot wake → project thread/session → planner dispatch | `workers/agents/src/communications/blackboard-project-bot.integration.test.ts` | **Locally integrated.** Uses real in-memory SQLite for wake state and the real wake/session-dispatch functions; Spaces and Agent Durable Object bindings are adapters. This is not a deployed Durable Object test. |
| Blackboard delivery, retries, leases, and worker-to-worker messages | `workers/agents/src/communications/blackboard-delivery.test.ts`, `workers/agents/src/communications/blackboard-wake.test.ts`, `workers/agents/src/script-engine/task-blackboard.test.ts` | **Partial.** Individual rules pass with test doubles; queue redelivery, concurrent claims, and restart recovery need service-level failure-injection runs. |
| Worker success separate from verification; dependent task gating | `workers/agents/src/script-engine/goal-dag.test.ts`, `workers/agents/src/script-engine/goal-evidence.test.ts`, `workers/agents/src/script-engine/assistant-swarm-architecture.test.ts` | **Covered in deterministic unit/synthetic flows.** Semantic correctness and evaluator calibration need held-out tasks and human labels. |
| Budgets, retries, and uncertain effects | `tests/unit/infra-usage-quota-gate.test.ts`, `workers/agents/src/workflows/agent-task-checkpoints.test.ts`, `workers/agents/src/script-engine/goal-architecture-benchmark.test.ts` | **Partial.** Atomic reservation and fail-closed handling are covered; broad concurrent billing races and provider-side uncertainty remain separate acceptance work. |

## Product journeys and deployment

| Area | Current code/test evidence | Status and proof limit |
|---|---|---|
| Bots roster → open project-scoped conversation | `tests/plan/browser/02-project-bot-journey.spec.ts` | **Synthetic browser journey.** It uses a local fake API, seeded test session, and Chromium; it verifies scoped thread creation and URL navigation, not backend identity verification. |
| Narrow viewports | `tests/playwright.plan.config.ts` | **Locally passed.** Shell and Project Bot journeys pass at desktop, 338px, and 740px. The full matrix is included in the browser CI suite. |
| Bot navigation, roles, refresh/history, archive/restore, member visibility | `apps/shell/src/app/p/[slug]/(shell)/bots/page.tsx`, `tests/plan/browser/02-project-bot-journey.spec.ts` | **Partial.** One owner journey is covered. Member/role and lifecycle browser flows remain open. |
| Durable Cloudflare deployment, live providers, user data | Full-test GHA and connected checks | **Not established by local tests.** Requires a deployed test tenant, provider configuration, and explicit live acceptance. |

## Current local test evidence

On commit `68922e7e` before the new integration/browser additions, repository tests passed (317 files / 3,135 tests), workspace package and Worker tests passed (467 / 2,426; one skipped), Agents passed (209 / 1,061; one skipped), Spaces passed (82 / 361), and Shell passed (5 / 15). Those suites overlap; their counts must not be summed. The added blackboard-to-Project-Bot integration tests passed (2/2), the Agents suite passed after the integration was added (210 files / 1,063 passed / 1 skipped), and the browser Shell/Project Bot journeys passed locally at all three viewport sizes (6/6). These are local synthetic acceptance results, not real Durable Object or deployed Space acceptance.

## Immediate uncovered acceptance criteria

1. Add member/editor/viewer isolation and archived-project UI journeys; assert hidden or disabled actions match backend authorization.
2. Run the blackboard journey with actual local Wrangler/Miniflare Durable Objects and a D1 migration, not only SQLite plus binding adapters.
3. Inject duplicate events, expired leases, busy assistant responses, revoked grants, and worker restart between durable session creation and script dispatch.
4. Persist one correlated audit trace distinguishing Space Assistant, Project Assistant invocation, and task/thread worker actions while demonstrating shared planner/worker execution.
5. Run deployed acceptance against an isolated test Space and report provider-free tests separately from live model/provider tests.
