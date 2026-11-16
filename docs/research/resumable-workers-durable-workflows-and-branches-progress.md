# Resumable workers, durable workflows and branches progress

## Source and reconciliation — 2026-11-16

Fetched `docs/research/resumable-workers-durable-workflows-and-branches-plan.md` from `origin/plan/microapps-ui-sdk-voice` commit `ccca618f6c79be4f422f58e12408313e1b69622a`; copied SHA-256 `ccb7a388f6e3fc073c683d284c976ea45a74b0760ad1bbe22e5d518787acb384`. No checkout or merge of the planning branch.

The new plan extends, and does not replace, PW01–PW06. Current code/ledger evidence already covers logical task/worker branches, branch-parent checks, durable worker attempts/status, approval resume reconstruction, workflow/effect journals, bounded merges/manual conflict review, exact-revision check evidence in some paths, and the PW06 parent-DO cancellation/publication permit. PW01–PW06 remain partial: branch identity is not runtime isolation; process/filesystem/package/cache/port isolation is unproven; restart does not restore unsaved model/process memory; durable worker transcript/checkpoint lineage and user-visible recovery/loss semantics are incomplete; workflow steps/artifacts and parallel orchestration are partial; full runtime/provider cost settlement, branch/Git synchronization contracts, cross-service cancellation races, recovery UX and deployed acceptance remain open. See platform progress PW matrix for exact prior test evidence; do not repeat it without code changes.

| Area | Status | Next evidence/gap |
| --- | --- | --- |
| Multiple logical branches and coordinator publication | PARTIAL | Audit simultaneous branch callers and branch lifecycle/retention; do not equate logical branch with process isolation. |
| Runtime isolation and branch mount | CODE_GAP | Prove exact branch/revision mounts and isolate process, filesystem, dependencies, caches, ports, env and credentials; fail closed/queue when unsupported. |
| Durable worker checkpoints/recovery | CODE_GAP | Persist bounded versioned checkpoint lineage and recovery states; resume only verified durable state, disclose missing unsaved memory, fence attempts and recheck authority/budget. |
| Durable workflow steps/artifacts | PARTIAL | Reconcile WorkflowRunDO step receipts, pinned inputs/code, retry/idempotency and artifact retention with interruption/recovery cases. |
| Effects, billing, cancellation | PARTIAL | Preserve unknown outcomes; no replay of indeterminate effects; close per-run compute/currency settlement and cross-DO cancellation/publication races. |
| UI/operations/acceptance | CODE_GAP + LIVE_GATE | Show last durable checkpoint and known loss window; real Workflow/DO/R2/runtime/provider recovery tests remain deployment gates. |

No rollout, deployment, provider call or migration occurred for this plan. These are mostly ordinary code and runtime-contract gaps, not credential blockers. Distinguish logical branches, actual runtime isolation, durable checkpoint recovery and unsaved process memory. Never claim the latter is recovered.

Exact next action: trace the current `WorkflowRunDO` step/artifact journal and worker recovery/approval-resume callers against PW01–PW06, then implement the smallest missing durable checkpoint/recovery-state transition with a focused interruption/replay test. Continue runtime isolation and branch mount independently; keep rollout disabled.
