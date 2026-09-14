# AI Studio implementation prompt — batch 06, plan items 55–60

## Objective

Implement **all** behavior in plan items 55–60 end to end on the current accumulator branch.
The cohesive focus is: **Thread tiers, solo promotion, artifact CAS, locks, PRs, and rebases**. Treat the existing repository as evidence to audit, not as
proof that an item is complete. The accompanying Repomix pack contains full selected production
files and a generated `AUTHORITATIVE CONTEXT` section with the detailed source trail.

## Precedence and source-reading rule

Use this precedence from lowest to highest authority:

1. Existing repository code and old documentation describe current state only.
2. `CLAUDE.md` is an older implementation baseline.
3. Relevant expanded-gaps and Appendix A1 passages supplement the baseline.
4. The linked conversation files in each item's `Origin & Transition` trail are newer than
   `CLAUDE.md` and **override it when they conflict**. Read every named source from left to right;
   within a trail, the rightmost/later conversation wins. Never stop at the first proposal.
5. Explicitly named `avos1.json` chunks and the Master Blueprint final response are conversation
   authorities too; apply their position in the item's trail. The finalized/rightmost conversation
   decision wins unless the current user prompt explicitly changes it.

Do not average contradictory decisions. Record the conflict and implement the winning decision.
If a named source is absent, report that exact missing filename; do not silently substitute one.

## Items that must all be accounted for

- 55. 4-Tier Thread Hierarchy
- 56. Solo 2-Tier Cockpit vs. Multi-User 4-Tier Digital Office
- 57. Optimistic Concurrency Control (OCC) with SHA-256 Checkpoints
- 58. Distributed File-Level Mutex Locks (`ConcurrencyDO`)
- 59. Inline Pull Request (PR) Review Cards
- 60. Upstream Staleness Detection & Auto-Rebase

The short list above is only an index. Before editing, expand every item into an implementation
checklist from its complete linked conversation trail in `AUTHORITATIVE CONTEXT`. Preserve numeric
thresholds, state transitions, identity claims, failure behavior, Cloudflare primitive choices,
UI behavior, and deployment requirements found there even when the short `_BUILD_PLAN/plan.md`
summary omits them.

## Required working method

1. Build a requirements ledger for every item: authoritative decisions, production entry point,
   authorization, persistence/DO ownership, bindings/config/secrets, UI surface, telemetry,
   failure semantics, and integration/E2E evidence.
2. Trace the running request path before editing. Independently verify every existing claim; assume
   no item is complete merely because a helper, type, schema, comment, mock, or component exists.
3. Implement in dependency order. Reuse canonical workers/DOs instead of parallel standalone
   helpers. Scope state by tenant, space, project, invoker/user, and actor wherever applicable.
4. Fail closed for security-sensitive policy and conceal inaccessible private resources exactly
   like absent resources. Reauthorize at side-effect and merge boundaries.
5. Add real migrations and matching development, staging, and production Wrangler bindings,
   secrets documentation, service bindings, queues, workflows, R2/KV/Vectorize/Analytics datasets,
   and operational limits as required.
6. Wire UI into the actual shell route and real API/stream transport. Do not ship placeholders.
7. Add non-trivial contract, isolation, race, security, and router-to-worker tests using realistic
   Cloudflare behavior. Do not bypass authorization, transactions, expiry, namespaces, alarms,
   WebSockets, or service bindings with success-only mocks.
8. Run focused tests while developing, then typecheck, configuration parity, migration validation,
   and the relevant integration/E2E journeys. Fix failures rather than relabeling them.
9. Update `docs/requirements-trace-matrix.md` only after verification. Mark `IMPLEMENTED` only when
   the real request crosses router entry, auth, production worker/DO logic, scoped persistence and
   bindings, applicable shell UI, and meaningful integration/E2E tests.

## Response contract

Return one implementation response containing:

1. **Authority reconciliation** — one row per item, including conflicts and the winning source.
2. **Execution plan** — dependency-ordered and mapped to concrete files/request paths.
3. **Unified diffs** — complete, apply-ready patches for every changed/created/deleted file; do not
   use ellipses, pseudo-code, TODO-only stubs, comments standing in for code, or omitted boilerplate.
4. **Migration/deployment operations** — exact commands, binding creation, secret ownership and
   rotation order, rollout/backfill order, and rollback strategy.
5. **Verification** — exact commands and expected security/race/E2E assertions.
6. **Release ledger** — `IMPLEMENTED`, `PARTIAL`, or `MISSING` per item with honest remaining gaps.

Do not claim completion if any production boundary is absent. If the complete implementation cannot
fit one response, stop only at an atomic commit boundary and provide the exact continuation prompt
with the remaining ledger; never silently omit later items.
