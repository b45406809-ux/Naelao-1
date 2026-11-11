# Managed services and sidecar implementation progress

## Current checkpoint

- Mission: implement the entire [second plan](managed-services-and-sidecar-runtime-plan.md), sections 1–19, including first-plan gaps U01–U12. The user's immediate request is **handoff setup only**; product implementation begins in the next authorized run.
- Target branch: `Mcbt5s-Backup-2`.
- Last remote baseline inspected: `700c3fe0` on 2026-11-11, fast-forwarded from `4be3f0e2` with a clean worktree.
- Status: S0 documentation prepared. **S1–S9 NOT_STARTED by this mission.** Existing prior implementation is not counted as newly verified work.
- Exact next action: after implementation authorization, follow [bootstrap](../operations/managed-services-autonomous-session.md), inspect current source and latest first-plan records, and expand the requirement matrix below into atomic IDs with actual caller paths, dependency and migration owners. Then implement S2 onward autonomously.
- Current preparation changes: root AGENTS.md, historical runbook archive, second-plan sections 18–19, this progress record, and the new-session prompt. No product code, configuration, lockfile or source transcripts changed.
- Verification for preparation: documentation/link/ID/whitespace checks only; no product tests or live provider calls are implied.

## Resumption procedure

Read AGENTS.md, this checkpoint, the primary plan and the first plan's latest progress/status sections. Inspect branch, commit and dirty files before touching anything. Existing local user work survives the bootstrap. A different environment must rediscover the repository, Node/pnpm/Vitest versions, package builds and credentials; none are guaranteed by this file. Record the new baseline and current failures, then continue the next unfinished requirement. Historical test counts are evidence from their original run, not fresh test results.

## Status meanings and completion evidence

- `NOT_STARTED`: this mission has not yet assessed or implemented the item.
- `IN_PROGRESS`: assessed, with ordinary implementation or verification still pending.
- `IMPLEMENTED_LOCAL`: code and actual caller wiring, persistence/configuration, migration and relevant local evidence are present. Record concrete files and commands.
- `BLOCKED_EXTERNAL`: state the missing credential, contract, product decision or platform facility precisely; identify any missing code and finish independent work before classifying it. A missing service implementation is not a live-test gate.
- `ACCEPTED_LIVE`: record exact candidate commit, provider/template/region, environment, receipt and date. No current row claims this status.

For every row add atomic child IDs as needed, evidence paths, exact checks/results and the next unfinished action. Mark completed work only after inspection; do not rewrite implemented prior fixes as missing because an older note says so.

## Requirement inventory to expand in S1

| ID | Plan coverage | Initial state / next action |
| --- | --- | --- |
| MS01 | §§1–4 identity, ownership, connector capability manifests and isolation | NOT_STARTED: inventory current UserPort routes, AgentPort principals/grants and managed integrations. |
| MS02 | §§5,12,14 entitlement, subscription/model limits, parent/agent payers and shared credits | NOT_STARTED: map existing authoritative ledgers, quote and reservation contracts; avoid duplicate balances. |
| MS03 | §§6–7,17 Cloudflare main computer, independent sidecars and artifacts | NOT_STARTED: inspect updated snapshot/runtime code and map remaining project registry, fences and recovery. |
| MS04 | §8 provisioning/revocation/cleanup and operation reconciliation | NOT_STARTED: inventory current account and resource lifecycle callers and independent external gates. |
| MS05 | §§9–11 verification, rollout, telemetry, economics and decisions | NOT_STARTED: map every Phase A–G and open decision; preserve admission gates and identify missing local instrumentation. |
| MS06 | §12 external provider dashboard, consented AgentPort discovery/linking, direct/extended providers | NOT_STARTED: define actual API and deployment boundaries, backend and UI integration requirements. |
| MS07 | §13 Cloudflare email provider and full Naelao inbox | NOT_STARTED: inventory native AgentPort email and Naelao ingress/storage; implement missing inbox, threading/search, attachment and deletion paths. |
| MS08 | §§4,9,12,15 AgentMail, Telnyx, Higgsfield, Agent37, Modal and channel adapters | NOT_STARTED: verify provider contracts, reuse existing integrations and map every planned adapter's production caller. |
| MS09 | §14 wallet-funded credits and AgentPort Coinbase candidate | NOT_STARTED: inspect existing payment rails, choose documented product contract and implement quote/settlement/mandate flows where possible. |
| MS10 | §§12,15–16 channel tools, SDK/MCP, grants, sessions, shared and dedicated routing | NOT_STARTED: audit existing event/wake/attachment paths and implement routing identity/selection/revocation with external consumers. |
| MS11 | §§6,12,17 dashboard/UserPort settings, template defaults and profile controls | NOT_STARTED: map existing shell/UI and API contracts; complete real UI-to-backend journeys. |
| MS12 | §17 private filesystem fallback, browser profiles, restart recipes and snapshot lifecycle | NOT_STARTED: retain latest prior snapshot hardening; map independent durability, erasure, quotas and process semantics. |
| U01–U12 | §18 inherited first-plan implementation inventory | NOT_STARTED: inspect each row and split into actual atomic gaps, existing local implementation, and external acceptance. |

## Milestone checklist

| Milestone | State | Evidence / next step |
| --- | --- | --- |
| S0 | IMPLEMENTED_LOCAL (documentation only) | Runbook, archive, plan additions, progress record and bootstrap prompt prepared; finish documentation checks. |
| S1 | NOT_STARTED | Baseline/toolchain/code/provider-contract audit and atomic requirements map. |
| S2 | NOT_STARTED | Shared managed accounts, entitlement and billing contracts/implementation. |
| S3 | NOT_STARTED | Inherited gaps, verifier/runtime adapter, build and provenance. |
| S4 | NOT_STARTED | Cloudflare main computer, persistence/recovery, live capability, explicit sidecars. |
| S5 | NOT_STARTED | Managed-provider backend and complete provider adapter callers. |
| S6 | NOT_STARTED | Channels, shared routing and external-developer tool/event interfaces. |
| S7 | NOT_STARTED | Shared managed credits and agent wallet/payment flows. |
| S8 | NOT_STARTED | Dashboard/UserPort, defaults/settings and integrated user journeys. |
| S9 | NOT_STARTED | Whole-plan audit, code-gap closure, verification and acceptance handoff. |

## Known baseline corrections

- `700c3fe0` preserves MCP AST patch MIME and moves shared extension inference into `packages/types`; Agent37 uses it. Unknown extensions deliberately remain opaque. Verify all caller journeys instead of rewriting the same fix.
- `4be3f0e2` added per-execution byte/checkpoint/staging-age/internal rate metrics. Real provider-billed idle ingestion and actual cost observations remain separate.
- `6d4903a0` added LiveRuntimeControlDO and its coordinator-facing journal/erasure boundary. The Cloudflare runtime adapter, authority verifier and actual live sync are still missing.
- Snapshot restore/save hardening and project runtime tombstone checks exist locally; project-wide registry, independent private-state recovery, explicit runtime erasure notifications and restart recipes remain to audit/implement.
- Independent global/EU erasure export/restore code and migration 0178 exist; account-specific regional bindings and deployed drills are still external gates.

## External gates and decisions (initial inventory)

Cloudflare account/deploy/registry permissions; approved image and real daemon digest; actual Container/FUSE/snapshot behavior; provider credentials, templates, regions and invoices; exact iMessage/WhatsApp/other provider eligibility; Coinbase/payment product and settlement access; approved retention, pricing, fee schedules and budgets. Inventory each missing item with a precise requirement ID during S1. No credentials were added or tested by this setup. Do not reclassify missing code as an external gate merely because its final acceptance needs credentials.

## Work log

### 2026-11-11 — S0 preparation

Fetched and fast-forwarded `Mcbt5s-Backup-2` from `4be3f0e2` to `700c3fe0`. Read the root runbook, current package/toolchain declarations, second plan and updated first-plan evidence. Source inspection confirmed the absent runtime adapter binding and Agent37 product unavailable routes. Archived the previous transcript-task runbook rather than deleting its historical context. Added inherited gap inventory, sequential milestones, evidence statuses and a new-environment bootstrap prompt. No implementation milestone or production gate was closed by this documentation work.

Preparation verification passed: `git diff --check`; existence and relative-link checks for all five handoff documents; presence of all inherited IDs U01–U12 and milestones S0–S9; baseline and safe fast-forward instructions. No product suite, provider account or deployment was exercised. The preparation files are published in a documentation-only handoff commit so another session can fetch them; this does not authorize automatic implementation commits or deployment.
