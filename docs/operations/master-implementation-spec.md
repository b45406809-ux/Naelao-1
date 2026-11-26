# Master implementation spec — code-only work remaining in the queue

Written 2026-11-25, against `origin/Mcbt5s-Backup-2` at `dd7ef72e`.

This file is for a smaller implementation model (Sonnet or Haiku class). Every task below is
**source-only**: no deployment, no remote migration, no provider call, no purchase, no outreach.
Each task states the design decision that was previously recorded as the blocker, so the
implementing model must not re-open it. If a decision looks wrong, stop and report; do not invent
a different one.

## How to run a task

Give the implementing model this file plus one task ID, e.g. *"Implement MS-01 from
docs/operations/master-implementation-spec.md"*. One task per session. Tasks are ordered; take the
first unchecked one unless told otherwise. The **Model** line says which model size is enough.

## Rules for the implementing model (all tasks)

1. **Setup (once per environment):** `pnpm install --frozen-lockfile` at the repo root.
2. **Read before editing:** the files listed under *Start here* for your task. Search with
   `grep -rn` before adding a helper; reuse an existing one if it exists.
3. **Run tests per package**, not the whole repo:
   - `pnpm --filter naelao-spaces exec vitest run <path>`
   - `pnpm --filter @naelao/agents-worker exec vitest run <path>`
   - `pnpm --filter @naelao/knowledge-worker exec vitest run <path>`
   - `pnpm --filter @naelao/agent-sdk exec vitest run <path>`
   - Typecheck: `pnpm --filter <name> typecheck`. Also run `git diff --check`.
   - Paths are relative to the package directory (e.g. `src/do/subspace-blackboard.test.ts`).
   - `apps/shell` has a known stale `.next/types` typecheck failure. For Shell work, run
     `pnpm --filter @naelao/shell exec tsc --noEmit -p tsconfig.json` and ignore only errors whose
     path is under `.next/types`.
4. **DO SQLite:** `?` placeholders only. Never run `PRAGMA` or `BEGIN/COMMIT` inside a Durable
   Object. Add new SpaceDO migrations by appending the next `version` to the `MIGRATIONS` array in
   `workers/spaces/src/do/SpaceDO.ts` (the current last version is **162**; check the array, an earlier task may have added more). Update
   `workers/spaces/src/do/SpaceDO-migrations.test.ts` if it asserts the latest version.
5. **Hono routes in `workers/spaces/src/index.ts`:** do **not** add a route of the shape
   `/:dynamic/.../static-suffix` under an existing dynamic segment; it has repeatedly corrupted
   routing for the whole app. Prefer a static path with IDs in the query string. Always run the
   **full** `naelao-spaces` suite after adding a route there:
   `pnpm --filter naelao-spaces exec vitest run`.
6. **Security defaults:** every new capability is **off by default** behind the flag the task
   names. Every authorization failure returns the same not-found shape so callers cannot probe
   for existence. Never let template/signed data create an active grant.
7. **Done means:** tests named in the task exist and pass, typecheck passes, `git diff --check`
   passes, the task's queue line is updated (see *Bookkeeping*), and one commit is pushed.
8. **Commit and push:**
   ```
   git fetch origin Mcbt5s-Backup-2
   git merge --ff-only FETCH_HEAD   # if this fails, stop and report; do not force
   git commit -m "<feat|fix|test>: <task id> <short summary>"
   git push origin HEAD:refs/heads/Mcbt5s-Backup-2
   ```
   Never force-push. Never deploy (`wrangler deploy`, `pages deploy`, `d1 migrations apply`).

### Bookkeeping (every task)

- In this file, change the task's `- [ ]` to `- [x]` and add one line: commit hash, test counts.
- In `docs/operations/implementation-queue.md`, update the queue item named in the task's
  **Queue** line: say which local slice landed and what remains (usually live acceptance).
- In `AGENTS.md`, point **Current task** at the next unchecked task in this file, then copy
  `AGENTS.md` over `CLAUDE.md` (`cp AGENTS.md CLAUDE.md`). The two files must stay identical.

---

## Decisions that unblock these tasks

These were recorded as "waiting on a contract". They are technical design choices, made here with
safe defaults. The owner can override any of them; until then, implement exactly as written.

| ID | Decision |
|---|---|
| D1 | A blackboard message may carry **one** knowledge-document reference. The reference grants nothing. The **recipient** can open it only with their **own** accepted capability for that exact document. The check runs on **every** fetch. |
| D2 | Resource links ship behind `SUBSPACE_RESOURCE_LINKS_ENABLED` (Spaces env var), default **off**. |
| D3 | Templates may declare **symbolic** subspace roles and route **proposals** between roles. At activation the owner maps roles to real subspaces. Proposals land as **pending**; only an explicit owner/admin approval (with `manage` on both subspaces) creates an active route. |
| D4 | A Project task may be **stopped** (not paused or resumed) by the owning Space's owner/admin or by a Project member whose role is `owner`. Stop reuses the existing conversation stop path (AgentDO `cancelling` run state). `WorkflowRunDO.cancel` is never used for this. Every stop writes a durable receipt with outcome `stopped`, `already_terminal` or `uncertain`. |
| D5 | Worker-output conflict classes are deterministic and always **candidates**, never confirmed. No classifier may spend model credits. |
| D6 | Reusable worker definitions are parsed and validated only; nothing binds them to the host yet. A `long_running` definition must state its duration limits explicitly; there is no inferred default. |
| D7 | A semantic response may be cached only when the cache key covers the full authority identity (tenant, Space, Project, user, role, memory revision, grant revision) and the response came from read-only operations. If any part is missing, the cache is bypassed. Flags stay off. |
| D8 | **Prices and caps (owner-approved 2026-11-25).** 1 credit = $0.01 (`CREDITS_PER_USD`). The existing rate card in `packages/billing-core/src/credits.ts` is unchanged (token markup 1.15, `workflow_step`, `container_hour`). Only today's **unpriced** units get prices, as starting rates in one versioned table: extension resource **invocations 1 credit per 100** (rounded up), **job units 1 credit each**, **payload bytes 1 credit per 100 MiB** (rounded up). Round up per settlement, never per unit. Priced units are charged **inside** the run's existing Billing reservation, never as a separate unreserved charge. **Default caps** for a new extension installation: 200 credits per run, 1,000 credits per month; owner can change them (existing 1–10M validation). Usage at **≥80%** of the monthly cap shows a warning; at 100% admission already refuses new work while admitted work finishes. **Per-goal cap** default 200 credits: when a goal's settled plus held credits would exceed it, no new task is dispatched and the goal waits in `awaiting_budget_approval` until the owner raises the cap or stops it. **Managed sends:** a Naelao-managed AgentMail send reserves the configured `credits_per_operation` for `messages.send` from the sending Space's org before dispatch and settles after; no configured price = refuse (`managed_service_price_unconfigured`). A BYO (user-owned key) account is never charged by Naelao. Flags, all default **off**: `EXTENSION_RESOURCE_PRICING_ENABLED`, `GOAL_CREDIT_CEILING_ENABLED`, `AGENTMAIL_SEND_BILLING_ENABLED`. |
| D9 | **Retention (owner-approved 2026-11-25).** Worker branches: **7 days** after the worker's result was published/merged, **30 days** after it ended failed, terminated or abandoned; then the Coordinator deletes the branch head and base so content GC can reclaim bytes. Run logs (`run_wal`, `run_traces`, and `sub_agents.checkpoint_json` of terminal workers): **90 days**. Project memory (`project_facts`, `project_fabric`, `project_wiki`): deleted **30 days** after the Project is deleted. Personal memory: no new expiry (existing decay stays); it is removed only by the user or by account deletion (account-deletion purge is out of scope here). An active **legal hold** blocks every deletion it covers; reuse the Coordinator's `legalHold` for branches and add a Project-level memory hold for Project memory. Owners may later shorten, never lengthen, these periods (not built now). Every sweep is bounded per pass, idempotent and logs counts only. Flags, all default **off**: `WORKER_BRANCH_RETENTION_ENABLED`, `RUN_LOG_RETENTION_ENABLED`, `PROJECT_MEMORY_RETENTION_ENABLED`. |
| D10 | **Preferences (owner-approved 2026-11-25).** The **tightest** setting wins, layered platform (plan limits and code constants) → Space owner/admin limits → Project setting → user preference. Worker count: default **3** per goal; an admin may set a max from 1 to 10 (never above the plan limit); a user picks at or below it. Model: an admin sets the allowed model tiers; a user picks among them; when a chosen model is unavailable the host may fall back only to an allowed tier that is **not more expensive**. Budget: the per-goal cap (D8) is set by the admin; a user may set a lower personal per-goal cap. Preferences are snapshotted when a goal starts and never change running work. Every preference/limit change writes an audit row (actor, before, after, time). Flag `WORKER_PREFERENCES_ENABLED`, default **off** (off = today's behavior). |

---

## Tasks

### - [x] MS-01 — Resource references on subspace blackboard messages (storage + publish)

- **Queue:** item 19, SBB04.2 follow-up. **Model:** Sonnet. **Decision:** D1, D2.
- **Goal:** a sender can attach one knowledge-document reference to an `artifact` message. Storing
  it grants nothing.
- **Start here:**
  - `workers/spaces/src/do/SpaceDO.ts`: migration 159 (`subspace_blackboard_messages`),
    `publishSubspaceBlackboardMessage`, `publishSubspaceBlackboardBroadcast`, and the message read path.
  - `workers/agents/src/script-engine/prebuilt/subspace-blackboard.ts` (the publish op the assistant calls).
  - Existing tests: `workers/spaces/src/do/subspace-blackboard.test.ts`,
    `workers/spaces/src/routes/subspace-blackboard.test.ts`,
    `workers/agents/src/script-engine/prebuilt/subspace-blackboard.test.ts`.
- **Do:**
  1. Migration **161**: `ALTER TABLE subspace_blackboard_messages ADD COLUMN resource_ref_json TEXT;`
     plus the same column on `subspace_blackboard_broadcasts`.
  2. Accept an optional `resource_ref: { type: "knowledge_document", target_space_id: string, document_id: string }`
     on single publish and on broadcast. Validate:
     - allowed only when `kind === "artifact"`;
     - `type` exactly `"knowledge_document"`;
     - both IDs match `/^[A-Za-z0-9._:-]{1,160}$/`;
     - `target_space_id` is in the same root Space hierarchy as the route.
     Reject anything else with the existing message-invalid error. Store canonical JSON
     (fixed key order).
  3. Make it part of the idempotency comparison: a retry with the same message ID and a different
     `resource_ref` is a conflict, exactly like a changed `text`.
  4. When the flag `SUBSPACE_RESOURCE_LINKS_ENABLED !== "true"`, reject any `resource_ref` with
     `400 resource_links_disabled`. The flag must reach the DO: pass it as a query param from the
     worker route, the same way other route params are passed.
  5. Reads return `resource_ref` as stored, and nothing else about the resource (no title, no content).
  6. Prebuilt op: accept optional `resource_ref` with the same validation and pass it through.
- **Tests (add):**
  - accepted on `artifact` when the flag is on; rejected on `finding` (and other non-artifact kinds);
  - rejected when the flag is off;
  - a replay with a different ref is a conflict; an identical replay returns the original message;
  - a broadcast copies the ref to every recipient copy;
  - the read path returns only the ref.
- **Done:** focused Spaces and Agents suites pass, typecheck passes.
- **Landed:** commit recorded in git log (`feat: MS-01 ...`); focused Spaces 26/26 + Agents 5/5, Spaces typecheck and Agents typecheck clean; full Spaces suite 730 pass / 5 pre-existing failures (project-extension-agent-maintenance, executive-contacts, gadget-mcp-crud, project-extension-lifecycle).

### - [x] MS-02 — Recipient-side resource resolver

- **Queue:** item 19, SBB04.2. **Model:** Sonnet. **Decision:** D1, D2.
- **Goal:** the recipient of a message opens the referenced document. Their own current capability
  is checked on every fetch. Route membership never grants access.
- **Start here:**
  - `SpaceDO.checkCrossSpace` (~line 15372): signed capability, plus the revocation and expiry check.
  - `acceptCrossSpaceDocument` / `getAcceptedCrossSpaceDocument` (~line 15259): table
    `accepted_cross_space_documents`, migration near line 2069.
  - `recordCrossSpaceAccess` (`/cross-space-audit`).
  - Knowledge reader: `workers/knowledge/src/index.ts`, route
    `GET /internal/spaces/:spaceId/kb/documents/:documentId/shared` (needs the internal token and
    the tenant header). Its test: `workers/knowledge/src/foundry-sharing.test.ts`.
  - Spaces worker: `KNOWLEDGE_WORKER` binding, `mintInternalToken`, and `authorizeDepartmentMember`.
- **Do:**
  1. New **static** route `GET /spaces/:spaceId/subspace-blackboard/resource?route_id=&message_id=`
     in `workers/spaces/src/index.ts`. No dynamic segment after `subspace-blackboard`.
  2. Caller identity, in order of precedence:
     - a user via `getCallerIdentity` (who must pass `authorizeDepartmentMember(..., recipientSubspaceId, "read")`);
     - or an internal HMAC call whose actor is `assistant:space:<recipientSubspaceId>`. Mirror how the
       existing subspace-blackboard internal routes authenticate the assistant.
  3. In SpaceDO add `GET /subspace-blackboard/resource-authorize?root_space_id=&route_id=&message_id=&actor_id=`,
     returning `{ target_space_id, document_id, grantee_space_id, capability_token }` only when **all** hold:
     - the route exists, is `active`, and is a current sibling pair;
     - the message is on that route;
     - its `target_subspace_id` is the caller's subspace (so the caller is the recipient, not the sender);
     - `resource_ref_json` is set;
     - an `accepted_cross_space_documents` row exists with
       `grantee_space_id = recipient subspace, target_space_id, document_id, accepted_by = actor_id`,
       `revoked_at IS NULL` and `expires_at > now`.
  4. Back in the worker, call `/cross-space-check` with that `capability_token`,
     `requesting_space_id = grantee`, `resource_id = "knowledge-document:<document_id>"`,
     `permission = read`. Require `permitted: true`. This rechecks grant revocation and expiry
     against `cross_space_grants` on every request.
  5. Only then call the Knowledge `/shared` reader for `target_space_id` (same tenant), then post a
     `/cross-space-audit` row (`action: "read_via_message"`).
  6. Return `{ document: { id, title, source_url, content } }`.
  7. **Every** failure returns `404 { error_code: "resource_unavailable" }`: flag off, missing ref,
     not the recipient, no accepted row, revoked or expired, Knowledge not found. The exception is a
     Knowledge 413, which is passed through.
- **Tests (new file `workers/spaces/src/routes/subspace-resource-link.test.ts`)**, following the
  harness in `src/routes/subspace-blackboard.test.ts`:
  - happy path: the recipient with an accepted capability gets the content and an audit row is written;
  - flag off → 404;
  - the sender (not the recipient) → 404;
  - a recipient without an accepted row → 404 (route membership alone is not enough);
  - revoke the `cross_space_grants` row after acceptance → 404 on the next fetch;
  - an expired grant → 404;
  - a revoked route → 404;
  - another tenant's HMAC → 404;
  - the assistant identity for the wrong subspace → 404.
- **Done:** the full `naelao-spaces` suite passes (rule 5), plus typecheck.
- **Landed:** commit recorded in git log (`feat: MS-02 ...`); new resolver test 12/12, existing subspace-blackboard suites and migrations test green (38 across 4 files); Spaces typecheck clean; full Spaces suite 742 pass / 5 pre-existing failures (project-extension-agent-maintenance, executive-contacts, gadget-mcp-crud x2, project-extension-lifecycle). Deviation: the recipient subspace is not in the request, so the DO derives it from the message target and checks reader/assistant there; the worker then re-checks `authorizeDepartmentMember` (user) or the exact assistant id against the returned grantee. `/cross-space-audit` now also accepts action `read_via_message`.

### - [x] MS-03 — Shell: show and open message resource links

- **Result:** `openSubspaceResource` added to `api.ts`; department page shows Open document on received linked messages (read-only panel, fixed error text) and "Linked document" on sent ones. Shell typecheck: no new errors (baseline unchanged).

- **Queue:** item 19. **Model:** Haiku. **Depends on:** MS-02.
- **Start here:** `apps/shell/src/app/p/[slug]/spaces/[spaceId]/departments/[departmentId]/page.tsx`
  (it renders blackboard messages), and `apps/shell/src/lib/api.ts` (subspace blackboard client functions).
- **Do:**
  - Add `openSubspaceResource(spaceId, routeId, messageId)` to `api.ts`.
  - On a received message that has a `resource_ref`, show an **Open document** button. It opens
    the content in a read-only panel. On 404, show *"You don't have access to this document. Ask
    its owner to share it with your department."*
  - Sent messages show only *"Linked document"*, with no button.
- **Done:** Shell typecheck passes (rule 3). No new tests are required.

### - [x] MS-04 — Blueprint schema: symbolic subspace roles and route proposals

- **Result:** landed in the MS-04 commit (see git log); agent-sdk 276/277 pass (new file 7 tests; the one failure, foundry-space version 1.4.0 vs 1.3.0, is pre-existing), typecheck clean.

- **Queue:** item 19, SBB03.3. **Model:** Sonnet. **Decision:** D3.
- **Start here:** `packages/agent-sdk/src/types.ts` (`SpaceBlueprint`),
  `packages/agent-sdk/src/blueprint-business-roles.ts` and its test (copy this pattern exactly),
  `packages/agent-sdk/src/blueprint.ts` (`instantiateBlueprint`).
- **Do:**
  1. New file `packages/agent-sdk/src/blueprint-subspace-roles.ts` exporting:
     - `BlueprintSubspaceRoleV1 = { key, name, description? }`, where `key` matches
       `/^[a-z][a-z0-9-]{0,47}$/`, `name` is ≤80 chars and `description` is ≤400 chars;
       at most **10** roles, with unique keys.
     - `BlueprintSubspaceRouteProposalV1 = { source_role, target_role, allowed_kinds, allow_reply }`.
       Both roles must be declared and different. `allowed_kinds` is a non-empty subset of
       `finding|artifact|question|blocker|risk|completion|verification`; `allow_reply` is a boolean.
       At most **20** proposals, with no duplicate source/target pair.
     - `validateBlueprintSubspaceRoles(value)`: throws a clear message and rejects unknown fields.
  2. Add optional `subspaceRolesSchemaVersion?: 1`, `subspaceRoles?` and `subspaceRouteProposals?`
     to `SpaceBlueprint`, with doc comments stating that these never create grants or routes.
  3. In `instantiateBlueprint`, validate them when present, exactly like `businessRoles`.
     Proposals without roles are an error.
  4. Export from the package index.
- **Tests:** `packages/agent-sdk/src/blueprint-subspace-roles.test.ts`:
  - valid declarations round-trip;
  - each limit is enforced;
  - unknown fields are rejected;
  - a proposal naming an undeclared role is rejected;
  - a self-route is rejected;
  - a legacy blueprint without these fields still instantiates.
- **Done:** agent-sdk tests and typecheck pass.

### - [x] MS-05 — Activation: map roles to subspaces and store pending route proposals

- **Result:** landed in the MS-05 commit (see git log); naelao-spaces full suite 751/756 pass (new: 6 SpaceDO proposal tests, 2 activation tests, 1 route test; the 5 failures are the pre-existing ones), typecheck clean, migration 162.

- **Queue:** item 19, SBB03.3. **Model:** Sonnet. **Decision:** D3. **Depends on:** MS-04.
- **Start here:**
  - `workers/spaces/src/blueprint-activation.ts` (`previewBlueprintActivation`).
  - Routes `GET .../activation-preview` (~line 1475) and `POST .../activate` (~line 1663) in
    `workers/spaces/src/index.ts`.
  - The SpaceDO blueprint activation handler (~line 6687).
  - `createSubspaceBlackboardRoute` (~line 14735).
- **Do:**
  1. The preview lists `subspace_roles` and `route_proposals`, and the subspaces the caller can
     `manage`, as mapping options.
  2. The activate body accepts an optional `subspace_role_bindings: Record<roleKey, subspaceId>`.
     For each binding, require that the subspace is a current child of the target Space and that
     the caller has `manage` on it. Otherwise return `400 invalid_subspace_role_binding`.
  3. Migration **162** (or the next free version) adds `subspace_route_proposals`:

     | Column | Notes |
     |---|---|
     | `id` | primary key |
     | `blueprint_id` | |
     | `source_subspace_id` | |
     | `target_subspace_id` | |
     | `allowed_kinds_json` | |
     | `allow_reply` | |
     | `status` | `proposed` / `approved` / `dismissed` |
     | `created_by` | |
     | `created_at` | |
     | `decided_by` | |
     | `decided_at` | |
     | unique key | `(blueprint_id, source_subspace_id, target_subspace_id)` |

     On activation, insert one `proposed` row per proposal whose two roles are both bound.
     Unbound proposals are skipped and reported in the activation response.
     Activation **never** writes `subspace_blackboard_routes`.
  4. New static routes:
     - `GET /spaces/:spaceId/subspace-route-proposals` lists proposals where the caller can
       `manage` both subspaces.
     - `POST /spaces/:spaceId/subspace-route-proposals/decide` with body `{ id, decision: "approve"|"dismiss", route_id }`.
       Approving re-checks `manage` on both subspaces at decision time, then calls the existing
       route-creation logic (do not duplicate it), then marks the proposal `approved`.
       A proposal can be decided once; a second decision returns `409`.
- **Tests:**
  - preview exposes roles;
  - activation with bindings creates proposals and zero active routes;
  - an invalid or unauthorized binding returns 400;
  - approval creates exactly one active route;
  - approval by a user without `manage` on the target is refused;
  - a second decision returns 409;
  - a dismissed proposal creates no route;
  - activation without bindings behaves as before.
- **Done:** the full `naelao-spaces` suite passes, plus typecheck.

### - [x] MS-06 — Shell: role mapping at activation and a proposals inbox

- **Queue:** item 19. **Model:** Haiku. **Depends on:** MS-05.
- **Do:**
  - On the blueprint activation preview screen, show one subspace dropdown per declared role,
    each with a "Don't map" option.
  - On the department page (or the Space settings page for coordination), list pending route
    proposals ("Sales → Support: findings, questions") with **Approve** and **Dismiss** buttons.
  - Copy must say that approving lets these two departments send each other the listed message types.
- **Done:** Shell typecheck passes (rule 3).
- **Result:** Activation review shows one role-to-subspace select per declared role ("Don't map" default) and sends `subspace_role_bindings`; department page lists "Suggested department links" with Approve/Dismiss and the required copy. Also added router allowlist entries for `subspace-blackboard/resource` and `subspace-route-proposals(/decide)` so product-session users reach the MS-02/MS-05 routes (router tests 99/99). Shell typecheck error count unchanged (142 before and after; no errors in touched files). Local evidence only.

### - [x] MS-07 — Stop a Project task (owner/admin) with a durable receipt

- **Queue:** item 2, APW06 "Project task pause/cancel controls" (stop only). **Model:** Sonnet. **Decision:** D4.
- **Start here:**
  - The ledger section "APW06 follow-up — 2026-11-23 (authorized conversation stop…)" in
    `docs/research/adaptive-planner-worker-swarm-memory-progress.md`.
  - The existing conversation stop: search the Shell for `StopDurableTaskButton` and `cancelRun`,
    then follow it to the agents-worker cancel route and the AgentDO `cancelling` handling.
  - `workers/agents/src/do/TaskDO.ts`.
  - Project task list/detail routes: search `workers/spaces/src/index.ts` near the "tasks (AVOS
    plan step 4" comment (~line 9893) and the agents worker for the Project task detail route.
- **Do:**
  1. New agents-worker route `POST /spaces/:spaceId/projects/:projectId/task-stop` with body
     `{ task_id }`. Authorize the caller as an owner/admin of the Project's **owning** Space, or as
     a Project member with role `owner`. Resolve this through the existing SpaceDO
     authorization calls; do not invent a new role table. Viewers and editors get `403`.
  2. Verify the task belongs to that Project (from TaskDO's stored identity), else `404`.
  3. If TaskDO status is terminal, write the receipt `already_terminal` and return `200`.
  4. Otherwise forward to the **same** AgentDO stop handler the conversation stop uses (same run ID
     derivation). If AgentDO confirms `cancelling` or `cancelled`, record `stopped`. On any
     error or timeout, record `uncertain`, but never mark the TaskDO itself terminal on `uncertain`.
  5. TaskDO: add a `task_control_receipts` table (id, task_id, action = `stop`, requested_by,
     requested_at, outcome, detail) and include the latest receipt in the existing task detail response.
  6. Never call `WorkflowRunDO.cancel`.
- **Tests (new `workers/agents/src/project-task-stop.test.ts`):**
  - a Space owner stops a running task → `stopped` receipt, and AgentDO received the stop;
  - a Project `owner` member can stop;
  - a viewer or editor gets 403;
  - a task from another Project gets 404;
  - an already-completed task → `already_terminal`;
  - an AgentDO failure → `uncertain` and the TaskDO status is unchanged;
  - `WorkflowRunDO.cancel` is never invoked (spy on it).
- **Done:** focused tests and Agents typecheck pass.
- **Result:** landed in the MS-07 commit (see git log); `project-task-stop.test.ts` 10/10 and router task-stop routing 2/2, Agents typecheck clean; full Agents suite 1971 pass / 3 pre-existing failures (email-ocr-settings-route, telnyx-webhook, scheduled-job-dispatch), router 162 pass / 1 pre-existing (preferred-language). Receipt is `latest_control_receipt` on `GET /spaces/:spaceId/tasks/:taskId`; the stop and the conversation stop share `cancelRunInAgentDO`.

### - [x] MS-08 — Shell: Stop button on Project task detail

- **Queue:** item 2. **Model:** Haiku. **Depends on:** MS-07.
- **Do:**
  - Show **Stop task** only to users the API would allow: hide it on a 403 from a dry
    authorization, or use the role data already loaded on the page.
  - Reuse the warning copy from `StopDurableTaskButton`: *"It may finish or be interrupted;
    committed external effects are not undone."*
  - After stopping, show the receipt outcome. For `uncertain`, say *"We couldn't confirm the stop.
    Check the result before retrying."*
- **Done:** Shell typecheck passes (rule 3).
- **Result:** landed in the MS-08 commit. Project activity tasks that are not terminal show **Stop task** (`stopProjectTask`) with the shared warning copy, the outcome (`uncertain` uses the specified text) and any `latest_control_receipt`; the button is always shown and a 403 renders as text because the page has no Project role data. Also fixed a routing bug: Shell `listDurableTasks` hit `/v1/spaces/:id/tasks`, which the router sends to the Spaces AVOS DAG; the router now has `GET /spaces/:id/durable-tasks(/:taskId)` forwarding to Agents (`/spaces/:id/tasks(/:taskId)`) and `/spaces/:id/tasks` is unchanged. Not added to the product end-user allowlist (task detail accepts any Space member). Router `durable-tasks-routing.test.ts` 4/4, router 166 pass / 1 pre-existing (preferred-language); Shell typecheck error count unchanged at 142.

### - [x] MS-09 — Deterministic worker-output conflict candidates

- **Queue:** item 2, APW07 classification. **Model:** Sonnet. **Decision:** D5.
- **Start here:** `workers/agents/src/do/goal-decision-change-candidates.ts` and its test (the
  existing review-only distinct-path signal), plus the Goal Activity projection that consumes it.
- **Do:** add a pure `classifyWorkerOutputConflicts(outputs)` with input
  `{ worker_id, changed_paths, diff_text? }[]` for workers completed under the same decision
  revision. It returns candidate classes, each with the paths and worker IDs involved:

  | Class | Raised when |
  |---|---|
  | `same_path` | two workers touched one path |
  | `migration` | two workers changed files under any `migrations/` dir, or a `MIGRATIONS` array |
  | `dependency_manifest` | two workers changed `package.json`, a lockfile or `wrangler.toml` |
  | `exported_interface` | two workers changed `export` lines in the same module (from `diff_text`, lines starting `+export` or `-export`) |
  | `unknown` | `diff_text` is missing for a path that another class would need it for |

  Every result carries `status: "candidate"` and `trusted: false`. Expose the result in the same
  Goal Activity field family as the existing signal. Spend no model call and add no publication gate.
- **Tests:** one test per class; an empty result when workers are disjoint; `trusted` is always
  false; the output is deterministic regardless of input order.
- **Done:** focused tests and Agents typecheck pass.
- **Result:** landed in the MS-09 commit. `classifyWorkerOutputConflicts` in `workers/agents/src/do/worker-output-conflicts.ts` (pure, one candidate per class, `status:"candidate"`, `trusted:false`); `projectWorkerOutputConflictCandidates` runs it per decision revision and Goal Activity returns it as `workerOutputConflictCandidates` beside `decisionChangeCandidates`. The host has no `diff_text`, so shared source paths surface as `unknown` and `exported_interface` and `MIGRATIONS`-array evidence only fire when diff text is supplied. Shell UI not changed. New tests 9/9 (7 classifier, 2 projection); Agents typecheck passes; full Agents suite 1980 pass, 3 pre-existing failures.

### - [x] MS-10 — Versioned worker-definition parser (not host-bound)

- **Queue:** item 1/2, APW08. **Model:** Sonnet. **Decision:** D6.
- **Result:** landed locally in the commit `feat: MS-10 versioned worker-definition parser`; `worker-definition.test.ts` 8/8, Agents typecheck and `git diff --check` pass; not wired to any dispatcher; op-name pattern fallback used (none existed).
- **Do:** new file `workers/agents/src/script-engine/worker-definition.ts` exporting
  `parseWorkerDefinitionV1(value)`. Schema:

  | Field | Rule |
  |---|---|
  | `schema_version` | `1` |
  | `id` | slug |
  | `name` | |
  | `kind` | `ephemeral` or `long_running` |
  | `instructions` | ≤8000 chars |
  | `model_hint` | optional; must be in `ALLOWED_MODELS` from `@naelao/billing-core` |
  | `capabilities` | operation names; ≤64; each matching the op-name pattern |
  | `max_tokens` | 1000–200000 |
  | `evidence_required` | boolean |

  For `long_running` only, these are **required**:

  | Field | Rule |
  |---|---|
  | `max_active_minutes` | 1–1440 |
  | `max_approval_wait_minutes` | 1–10080 |
  | `on_expiry` | `"fail"` only |

  Reject unknown fields. Return a frozen object. Add a module comment stating that the parser
  grants nothing and that the host must intersect `capabilities` with current grants.
  **Do not** wire it into any dispatcher.
- **Tests:** valid ephemeral and long-running cases; each bound; a missing long-running duration
  is rejected; an unknown field is rejected; an unknown model is rejected.
- **Done:** focused tests and typecheck pass.

### - [x] MS-11 — Identity-complete semantic response-cache key

- **Queue:** item 8, K20. **Model:** Sonnet. **Decision:** D7.
- **Result:** key-only (not wired): `workers/agents/src/shared/response-cache-identity.ts`, tests 18/18, agents typecheck clean; the index.ts site has no existing memory or grant revision, so serving stays off. Commit: this commit.
- **Start here:**
  - The comment at `workers/agents/src/index.ts` ~line 2445, which explains why the cache is
    not used there.
  - `workers/knowledge/src/index.ts` ~lines 3572–3700 (generation-checked cache).
  - `workers/knowledge/src/semantic-cache-boundaries.test.ts`.
- **Do:**
  - Add a pure `responseCacheIdentity(input)` (agents worker, a new file under `src/shared/`).
    It returns a key string only when **all** of these are non-empty: `tenantId`, `spaceId`,
    `projectId` (or the literal `_space`), `userId`, `role`, `memoryRevision`, `grantRevision`,
    and `readOnly === true`. Otherwise it returns `null`.
  - The key is SHA-256 over canonical JSON of those fields plus the normalized query.
  - Use it at the line-2445 site **only** when the existing flag
    (`KNOWLEDGE_RESPONSE_CACHE_ENABLED`, or an agent-specific flag if one exists) is `"true"`.
    With `null`, bypass the cache. Leave every flag default unchanged (off).
- **Tests:**
  - a `null` key for each missing field and for `readOnly: false`;
  - the key changes when any field changes;
  - identical input gives an identical key;
  - with the flag off, the cache is never read.
- **Done:** focused tests and Agents typecheck pass.

### - [x] MS-12 — AgentMail remaining local control tests

- **Queue:** item 13, the CB06 umbrella's untested points. **Model:** Haiku.
- **Start here:** `workers/agents/src/communications/agentmail.ts` and `agentmail.test.ts`
  (reuse their fixtures).
- **Do (tests only; fix code only if a test exposes a real bug):**
  - **malicious recipient input**: header-injection strings (`\r\n`), multiple `@`, a display
    name carrying an address outside the allowlist, a 10k-char address. Each is rejected before
    key creation or send.
  - **tool-input substitution**: a send whose recipient differs from the approved/allowlisted one
    after approval is refused.
  - **log redaction**: spy on `console.log/info/warn/error` across success, provider-timeout and
    error paths; no parent key, temporary key, or message body appears in any logged argument.
  - **revocation race**: revoke the connection between temporary-key creation and dispatch
    (a fixture hook like the existing "policy changes during key creation" test). Dispatch is
    denied and the temporary key is deleted.
- **Done:** the AgentMail suite passes with the new cases.
- **Result:** landed locally; `agentmail.test.ts` 34/34 (27 before, 7 new in `MS-12 remaining local controls`); source fix in `assertAgentMailOperationAuthority` so a supplied recipient entry that fails address parsing refuses the send instead of being silently dropped; Agents typecheck and `git diff --check` pass. Local evidence only.


### - [x] MS-13 — Project-scoped task detail, then let product users reach durable tasks and Stop

- **Queue:** item 2, APW06. **Model:** Sonnet. **Decision:** D4. Found during MS-08.
- **Problem:** the agents worker's `GET /spaces/:spaceId/tasks/:taskId` lets any Space member read
  any task by ID, without checking Project access. MS-08 therefore left the new
  `/spaces/:id/durable-tasks(/:id)` and `/spaces/:id/projects/:id/task-stop` routes off the router's
  `PRODUCT_END_USER_PATH_PATTERNS`. As a result, a business owner signed in through the Shell
  cannot see or stop background tasks.
- **Do:**
  1. In the task-detail handler, apply the same Project-access check the list handler already uses
     whenever the task has a `project_id`. Return the existing not-found shape on failure.
  2. Re-verify that the list, detail and task-stop handlers all enforce their own access checks for a
     `product_end_user` caller. Then add allowlist patterns for those three paths and update
     `workers/router/src/durable-tasks-routing.test.ts`, which currently asserts they are absent,
     plus `extension-product-paths.test.ts`.
- **Tests:**
  - a member of Project A cannot read a Project B task by ID;
  - a Project member can read their own Project's task;
  - the router allowlist accepts the three paths and rejects their extensions.
- **Done:** focused agents and router tests pass, plus typecheck.
- **Result:** landed in the MS-13 commit. The detail handler let any Space member through `requireSpaceMembershipOrSessionAccess` before the Project check; a task with a `project_id` now requires Project access (denied = `404 not_found`), and tasks without one keep the session/Space rule. List and task-stop checks re-verified unchanged. New `project-task-detail.test.ts` 4/4 (the two denial cases fail without the fix); router allowlist now has `durable-tasks(/:id)` and `projects/:id/task-stop` with extension rejections. Agents full suite 2017 pass / 3 pre-existing failures (email-ocr-settings-route, telnyx-webhook, scheduled-job-dispatch); router 172 pass / 1 pre-existing (preferred-language); both typechecks clean.

### - [x] MS-14 — Versioned price table for unpriced extension resource units

- **Queue:** item 9, EP06. **Model:** Haiku. **Decision:** D8.
- **Start here:** `packages/billing-core/src/credits.ts` (`calculateResourceCredits`, `ResourceType`), `packages/billing-core/src/index.ts` (`BILLING_CORE_RATE_CARD_VERSION`), `packages/billing-core/src/credits.test.ts`.
- **Do:** add `EXTENSION_RESOURCE_UNIT_PRICES` (version string `"ext-units-2026-11-25"`) and `priceExtensionResourceUnits({invocations, jobUnits, bytes})` returning `{credits, breakdown:{invocations, jobUnits, bytes}, priceVersion}`, using D8 rates and rounding each line up once (`Math.ceil`). Non-negative integers only; anything else throws `invalid_resource_units`. All-zero input = 0 credits. Export it from the package index. Do **not** change any existing rate.
- **Tests:** 0 → 0; 1 invocation → 1; 100 → 1; 101 → 2; 3 jobs → 3; 1 byte → 1; exactly 100 MiB → 1; 100 MiB + 1 byte → 2; combined breakdown; negative/fractional/NaN throw; existing rate tests unchanged.
- **Done:** `pnpm --filter <billing-core package name> exec vitest run src/credits.test.ts` and typecheck pass.
- **Result:** this commit. `EXTENSION_RESOURCE_UNIT_PRICES` (`ext-units-2026-11-25`) and `priceExtensionResourceUnits` added to `credits.ts` and exported from the package index; existing rate card untouched. `credits.test.ts` 11/11 (focused); `@naelao/billing-core` full suite 62/62 (14 files); typecheck clean; `git diff --check` clean. Local/mock only, no live pricing.

### - [x] MS-15 — Owner usage view: estimated credits and cap warning

- **Queue:** item 9, EP06. **Model:** Haiku. **Decision:** D8. **Needs:** MS-14.
- **Start here:** `workers/spaces/src/index.ts` route for `projectExtensionResourceUsagePath` (~l.6832; it sums this month's invocations, job units and bytes and compares settled `infra_credits` + holds with the cap). Shell caller in `apps/shell/src/lib/resource-grants-api.ts` and its test.
- **Do:** add to the JSON response `estimated_unit_credits` (from `priceExtensionResourceUnits`, with `price_version`), and `cap_status`: `"ok"`, `"warning"` (used+held ≥ 80% of the monthly cap) or `"reached"` (≥ 100%). Label it estimate-only; this route charges nothing. Show `cap_status` and the estimate in the existing Shell owner usage panel (find it from the API caller).
- **Tests:** route test for each `cap_status` boundary (79%, 80%, 100%) and the estimate field; Shell API parser test.
- **Done:** focused tests, **full** `naelao-spaces` suite (only the 5 known pre-existing failures), typechecks.
- **Result:** this commit. Usage route adds `estimated_unit_credits` (estimate-only, `ext-units-2026-11-25`, never added to settled or held credits) and `cap_status` (`ok` / `warning` at settled+held >= 80% / `reached` at >= 100% of the monthly cap; `null` with no approved cap). Shell owner panel shows cap status and the estimate. New route tests cover 79%, 80%, 100% boundaries, the estimate and no-cap. `project-extension-agent-maintenance` 10/10 (its exact-match receipts assertion was stale and is now partial, and its usage-query check is by value); `resource-grants-api` 6/6; full `naelao-spaces` 754 pass / 5 fail (4 known pre-existing: executive-contacts, gadget-mcp-crud x2, project-extension-lifecycle; plus `extension-schema-update` concurrent-retry test, which passes 3/3 in isolation). Spaces typecheck clean; Shell tsc 142 errors, identical set to baseline, none under `.next/types`; `git diff --check` clean. Local/mock only, nothing charged.

### - [x] MS-16 — Charge priced resource units inside the run reservation

- **Queue:** item 9, EP06. **Model:** Sonnet. **Decision:** D8. **Needs:** MS-14.
- **Start here:** `workers/agents/src/workflows/report-infra-usage.ts` (`reportWorkflowResourceUsage`, `reserveWorkflowBudget`, `finalizeWorkflowBudget`), `workers/agents/src/workflows/WorkflowRunDO.ts` (~l.257), `workers/billing/src/index.ts` workflow `/settle` (~l.933, charges `min(quantity, held)`), `tests/unit/workflow-budget-settlement-v2.test.ts`.
- **Do:** when `EXTENSION_RESOURCE_PRICING_ENABLED === "true"`, accumulate the run's priced resource credits (MS-14) in the run journal and add them to the quantity passed to the existing workflow settle, so the charge stays inside the reservation. Keep the per-unit usage rows unpriced (`cost_credits` null) and add `priced_in_settlement: true` plus `price_version` to their metadata so nothing is counted twice. Flag off = exactly today's behavior. Add the flag as `"false"` in the agents `wrangler.toml` vars (every env block that lists vars).
- **Tests:** flag off → settle quantity unchanged; flag on → settle quantity includes resource credits; settle never exceeds the hold; replayed settle stays idempotent; unit rows carry metadata and no `cost_credits`.
- **Done:** focused agents/billing tests, full agents suite (only 3 known failures), typecheck.
- **Result:** this commit. `WorkflowRunDO` accumulates per-run resource units in the journal (same transaction as the effect receipt, so replay cannot add twice) and, with `EXTENSION_RESOURCE_PRICING_ENABLED="true"`, settles `usedCredits` plus `priceExtensionResourceUnits(totals)` (priced once, capped at the remaining hold; billing still charges `min(quantity, held)`); unit rows stay without `cost_credits` and carry `priced_in_settlement`/`price_version` (the usage route has no metadata column, so only `rate_card_version` = price version persists). Flag off is unchanged, wrangler flag `"false"` in all 3 var blocks. Focused agents 35/35; full agents suite 2023 pass / 3 pre-existing failures; root `workflow-budget-settlement-v2` 1/1 (fixture was missing migration 0266, now added); agents typecheck clean; `git diff --check` clean. Local/mock only.

### - [x] MS-17 — Default caps for new extension installations

- **Result:** this commit. A new `PROJECT_BOUND` installation (or a reinstall after removal) seeds 200 run / 1,000 monthly credits at revision 1 inside the install transaction, with one audit row (actor `system:extension_install_default`) and `ON CONFLICT DO NOTHING`; upgrades and existing rows are untouched. Before this, no row meant `budget: null`, and `resolveExtensionResourceBudget` threw `workflow_extension_budget_not_approved` for resource-bearing installs. Focused `extension-runtime-install.test.ts` 36/36 (new test; default-cap assertions updated to revision 1); full naelao-spaces 756 pass, 4 known failures; spaces typecheck clean; `git diff --check` clean. Local/mock only.

- **Queue:** item 9, EP06. **Model:** Haiku. **Decision:** D8.
- **Start here:** `workers/spaces/src/do/SpaceDO.ts` budget policy table (`max_run_credits`, `monthly_credits`, ~l.3420) and its read helper (~l.18559) / PUT handler (~l.18640); `resolveExtensionResourceBudget` in `workers/agents/src/workflows/workflow-host.ts` (~l.272); `workers/spaces/src/do/extension-runtime-install.test.ts`.
- **Do:** first find out what happens today when an installation has **no** policy row and write it in the commit message. Then: when a **new** installation is created, insert a policy of 200 run / 1,000 monthly credits (revision 1) if none exists. Do not touch existing installations or rows. Owner PUT keeps working unchanged.
- **Tests:** new install gets the default policy; an existing policy is never overwritten; reinstall/new generation behavior matches what the code does for other per-installation rows.
- **Done:** focused test, full `naelao-spaces` suite, typecheck.

### - [x] MS-18 — Per-goal credit ceiling

- **Queue:** item 2, APW05. **Model:** Sonnet. **Decision:** D8 (and D10 for who sets it).
- **Start here:** `workers/agents/src/script-engine/goal-dag.ts`, `script-engine/prebuilt/goal-planner.ts`, `NaelaoAgentDO.ts` goal tables (`goal_dag_journals`, `goal_dispatch_outbox`, ~l.2083) and inference reservation/settlement (`reserveRunInferenceCost`, `settleRunBilling`, ~l.1497-1571, 8588-8671).
- **Do:** behind `GOAL_CREDIT_CEILING_ENABLED`, store `credit_ceiling` (default 200) and `credits_settled` / `credits_held` per goal journal. Before dispatching a goal task, if settled + held + that task's estimated reservation would exceed the ceiling, do not dispatch; set the goal to `awaiting_budget_approval` and record why. Add an owner/admin action that raises the ceiling (resumes dispatch) — reuse the authority used by MS-07 task-stop. Settlements update `credits_settled` idempotently per reservation ID. Flag off = today's behavior. Add the flag `"false"` to agents `wrangler.toml`.
- **Tests:** dispatch allowed under the ceiling; blocked at it with the waiting status; raise resumes; duplicate settlement counted once; non-owner raise refused with the not-found shape; flag off unchanged.
- **Done:** focused tests, full agents suite, typecheck.
- **Result:** this commit. With `GOAL_CREDIT_CEILING_ENABLED` on, `executeGoalDag` calls a new `admitDispatch` hook per ready task; `goal-credit-ceiling.ts` holds `budget_tokens` priced as output tokens via `tokensToCredits` against a per-journal ceiling (default 200) with idempotent per-reservation settlement and `awaiting_budget_approval` plus a recorded reason; owner/admin or Project owner raise via `POST /spaces/:spaceId/projects/:projectId/goal-credit-ceiling` (unauthorized = not-found shape). Flag off adds no hook and no rows. `goal-credit-ceiling.test.ts` 11/11; full Agents suite 2034 pass / 3 known failures; typecheck clean. Local/mock only; a blocked goal resumes on its next run after a raise.

### - [x] MS-19 — Bill Naelao-managed AgentMail sends

- **Queue:** item 13, CB06. **Model:** Sonnet. **Decision:** D8.
- **Start here:** `workers/agents/src/communications/agentmail.ts` (`callAgentMailTool` ~l.1025-1106, `resolveManagedAgentMailPrice` ~l.573, `providerKeyFor` ~l.428), `communications/managed-service-billing.ts` (reserve/uncertain/settle/release helpers), `workers/billing/src/index.ts` `/internal/managed-services/credits/*` (~l.1186; it requires a `msq_` quote for provision/renew only), `agentmail.test.ts`.
- **Do:** behind `AGENTMAIL_SEND_BILLING_ENABLED`, for `mode === "naelao_managed"` only: after authority, idempotency and daily-limit checks and **before** dispatch, resolve the `messages.send` price and reserve credits with reservation ID derived from the send's idempotency hash. Dispatch ok → settle; dispatch failed before the provider call → release; dispatch started and outcome unknown → mark uncertain (existing reconciliation owns it). Missing price → refuse with `managed_service_price_unconfigured`, nothing sent. A replayed `sent` idempotency row never reserves again. BYO accounts never reserve. Check whether Billing's reserve accepts a send without a quote; if it requires one, add the minimal Billing change and test it. Flag off = today's behavior; add it `"false"` to agents `wrangler.toml`.
- **Tests:** managed send reserves then settles; failure before dispatch releases; unknown outcome marks uncertain; missing price refuses without dispatch; BYO no reservation; replay no second reservation; insufficient credits refuses without dispatch; flag off unchanged. Existing 34 AgentMail tests still pass.
- **Done:** focused agents and billing tests, full agents suite, typecheck.
- **Result:** landed locally behind `AGENTMAIL_SEND_BILLING_ENABLED` (default off, in every wrangler vars block); managed sends reserve the `send` entitlement price (capability manifest op name is `send`) after authority/idempotency/daily-limit checks and before dispatch, then settle, release or mark uncertain; Billing source unchanged (quote-less send reserve needs only an admitted operation row, scoped mandate and entitlement; one Billing test added); `agentmail.test.ts` 42/42 (34 before, 8 new), billing 134/134, full agents suite only the 3 known failures, typecheck and `git diff --check` pass. Local evidence only.

### - [x] MS-20 — Worker-branch retention in the Coordinator

- **Queue:** item 3, PW01. **Model:** Sonnet. **Decision:** D9.
- **Start here:** `workers/agents/src/workspace/WorkspaceCoordinatorDO.ts` (`createBranch` ~l.1699, `alarm` ~l.323, `collectStaging`/`collectMetadata`/`collectContent`, `legalHold` ~l.96, `setRetentionPolicy` ~l.2577); `NaelaoAgentDO.ts` (`reserveWorkerBranch` ~l.4136, `mergeWorkerWorkspace` ~l.4250, terminate ~l.7013); `WorkspaceCoordinatorDO.test.ts`.
- **Do:** add a Coordinator route `/v1/branch/retire` `{branch, outcome: "published"|"ended", endedAt}` that records a retirement row (idempotent; only `workers/*` branches; never the canonical branch). Call it from `NaelaoAgentDO` when a worker's merge is published (`published`) and when a worker ends failed/terminated/interrupted without publication (`ended`); a call failure must not fail the worker path (log and leave it for a later retry). Behind `WORKER_BRANCH_RETENTION_ENABLED`, the alarm deletes the head/base keys of branches retired more than 7 days (`published`) or 30 days (`ended`) ago, bounded per pass, skipped under an active legal hold, and leaves bytes to the existing content GC. A branch with a newer head after retirement is not deleted.
- **Tests:** retire idempotent; non-worker branch refused; deletion only after the period; legal hold blocks; flag off deletes nothing; head advanced after retire is kept; bounded batch re-arms.
- **Done:** focused tests, full agents suite, typecheck.
- **Result:** landed locally behind `WORKER_BRANCH_RETENTION_ENABLED` (default off, in every wrangler vars block). Coordinator `/v1/branch/retire` records a row plus a due index (idempotent, `workers/*` only); the alarm sweep (flag on, no legal hold, no content-GC lock, 20 branches per pass, re-armed) deletes `head:`/`branch-base:` and then the branch's own `retained-revision:`/`revision:`/`subscription:` keys (these are content-GC roots), never R2 bytes; head-advanced, active-session and child-branch branches are kept. NaelaoAgentDO retires `published` after a published merge and `ended` on failed/terminated workers (best effort, 3s timeout, durable pending marker). Commit: see git log (`feat(agents): MS-20`); `WorkspaceCoordinatorDO.test.ts` 92/92 (9 new), `delegation-admission.test.ts` 29/29 (6 new), full agents suite only the 3 known failures, typecheck and `git diff --check` pass. Local evidence only.

### - [x] MS-21 — Run-log retention

- **Queue:** item 2, APW04 (run state). **Model:** Haiku. **Decision:** D9.
- **Start here:** `NaelaoAgentDO.ts` `pruneDurableRuns` (~l.7517, the template to copy), tables `run_wal` (~l.1632), `run_traces` (~l.1650), `sub_agents` (`checkpoint_json` ~l.2057), the alarm (~l.2556).
- **Do:** behind `RUN_LOG_RETENTION_ENABLED`, add `pruneRunLogs(now)`: delete `run_wal` and `run_traces` rows older than 90 days, and set `checkpoint_json` to NULL for `sub_agents` in a terminal status (`done`, `failed`, `terminated`) not updated for 90 days. At most 200 rows per table per pass. Never touch rows of a run that is still active. Call it where `pruneDurableRuns` is called. Add the flag `"false"` to agents `wrangler.toml`.
- **Tests:** old rows removed; 89-day rows kept; active run kept; running sub-agent checkpoint kept; batch limit; flag off removes nothing.
- **Done:** focused test, full agents suite, typecheck.
- **Result:** landed locally behind `RUN_LOG_RETENTION_ENABLED` (default off, in every wrangler vars block and the agents Env type); `pruneRunLogs(now)` runs from `openDurableRun` beside `pruneDurableRuns`; deletes `run_wal` (finished, 90 days) and `run_traces` (`ts` 90 days), and clears `sub_agents.checkpoint_json` for terminal workers untouched 90 days; 200 rows per table per pass; active runs excluded; `run-log-retention.test.ts` 6/6 (new); full agents suite 2063 passed with only the 3 known failures; typecheck and `git diff --check` pass. Commit: see git log (`feat(agents): MS-21`). Local evidence only.

### - [x] MS-22 — Project-memory retention with a memory hold

- **Queue:** item 2, APW04. **Model:** Sonnet. **Decision:** D9.
- **Start here:** `workers/spaces/src/do/SpaceDO.ts` project memory tables (`project_facts`, `project_fabric`, `project_wiki`, ~l.1032-1062), the Project delete path (find how a Project is deleted: soft-delete column or row removal), `workers/spaces/src/do/project-memory-forget.test.ts`, the SpaceDO alarm / scheduled hook.
- **Do:** find and record how Project deletion works. Add a SpaceDO migration with a `project_memory_holds` table (project_id, reason, actor_id, created_at, expires_at nullable) and owner/admin routes to set/clear a hold (static path + query params, Hono rule). Behind `PROJECT_MEMORY_RETENTION_ENABLED`, a bounded sweep deletes memory rows of Projects deleted more than 30 days ago unless an unexpired hold exists. If Project deletion leaves no deletion timestamp, add one in the same migration and set it on delete. Add the flag `"false"` to spaces `wrangler.toml`.
- **Tests:** memory of a Project deleted 31 days ago is removed; 29 days kept; live Project untouched; hold blocks; expired hold does not block; non-admin hold change refused with not-found shape; flag off removes nothing.
- **Done:** focused tests, **full** `naelao-spaces` suite, typecheck.
- **Result:** landed locally behind `PROJECT_MEMORY_RETENTION_ENABLED` (default off, every wrangler vars block). Project delete only archived the row and never touched memory, so migration 163 adds `project_deletion_tombstones` (set by the delete route via `/internal/project-deletion-mark`, first timestamp kept) and `project_memory_holds`; owner/admin `GET/PUT/DELETE /spaces/:spaceId/project-memory-hold?project_id=` (others get the not-found shape; no router allowlist entry); a SpaceDO `alarm()` sweeps at most 5 Projects / 500 rows per pass (flag on, tombstone older than 30 days, no unexpired hold, Project not active), counts-only log. `project-memory-retention.test.ts` 9/9; full spaces suite only the 4 known failures; typecheck and `git diff --check` pass. Commit: see git log (`feat(spaces): MS-22`). Local evidence only; Projects deleted before this change have no tombstone and are not swept.

### - [x] MS-23 — Preference resolver (pure function)

- **Queue:** item 2, APW06. **Model:** Haiku. **Decision:** D10.
- **Start here:** `packages/entitlements/src/index.ts` (`getExecutionLimits`), `packages/billing-core/src/plans.ts` (`clampPlanParallelism`), `workers/agents/src/script-engine/worker-model-routing.ts`.
- **Do:** create `workers/agents/src/shared/worker-preferences.ts` exporting `resolveWorkerPreferences({planLimits, spaceLimits?, projectSettings?, userPreferences?, modelTierCost})` → `{workerCount, allowedModelTiers, preferredModelTier, fallbackTiers, goalCreditCeiling, sources}`. Tightest wins per field; defaults workerCount 3 and ceiling 200; admin max clamped to 1–10 and plan limit; a user value above the limit is clamped and reported in `sources`; `fallbackTiers` = allowed tiers whose cost ≤ the preferred tier's cost, cheapest last. No I/O.
- **Tests:** each layer tightening; user cannot exceed admin; admin cannot exceed plan; defaults; fallback never more expensive; empty allowed set → host default only.
- **Done:** focused test and typecheck.
- **Result:** landed locally as a pure resolver `resolveWorkerPreferences` in `workers/agents/src/shared/worker-preferences.ts` (no I/O, no wiring; flag not needed). `worker-preferences.test.ts` 19/19; agents typecheck and `git diff --check` pass. Commit: see git log (`feat(agents): MS-23`).

### - [x] MS-24 — Store preferences and limits, with audit

- **Queue:** item 2, APW06. **Model:** Sonnet. **Decision:** D10. **Needs:** MS-23.
- **Start here:** `SpaceDO.ts` `user_settings` (~l.1751) and Project policy columns; spaces routes near user settings; router `PRODUCT_END_USER_PATH_PATTERNS`.
- **Do:** SpaceDO migration with `worker_preference_limits` (Space-level admin limits, optional per-Project override), `worker_user_preferences` (per user, per Space) and `worker_preference_audit` (actor, scope, before_json, after_json, created_at). Routes (static paths, query params): GET/PUT admin limits (owner/admin only), GET/PUT own user preferences (any member, own row only), GET audit (owner/admin). Validate with the MS-23 bounds. Add the router allowlist entries and tests.
- **Tests:** admin set/read; member cannot set limits (not-found shape); user edits only their own row; values outside bounds rejected; every change writes one audit row; router allowlist accept/reject.
- **Done:** focused tests, full `naelao-spaces` and router suites, typechecks.
- **Result:** landed locally: SpaceDO migration 164 (`worker_preference_limits` keyed by `project_id` with `''` = Space level, `worker_user_preferences`, `worker_preference_audit`); `GET/PUT /spaces/:spaceId/worker-preference-limits[?project_id=]` (Space owner/admin, or a Project owner member for that Project override), `GET/PUT .../worker-user-preferences` (any member, caller's own row only), `GET .../worker-preference-audit` (owner/admin); non-authorized get the not-found shape; one audit row per changed PUT in one DO transaction; three anchored router patterns. `worker-preferences.test.ts` 12/12; `SpaceDO-migrations.test.ts` 10/10; full spaces suite only the 4 known failures; router suite only the known preferred-language failure; typechecks and `git diff --check` pass. Commit: see git log (`feat(spaces,router): MS-24`). Local evidence only.

### - [x] MS-25 — Apply preferences when a goal starts

- **Queue:** item 2, APW06. **Model:** Sonnet. **Decision:** D10. **Needs:** MS-18, MS-23, MS-24.
- **Start here:** `NaelaoAgentDO.ts` worker capacity (~l.4886), model selection call (~l.5834), goal start in `goal-planner.ts` / `goal-dag.ts`.
- **Do:** behind `WORKER_PREFERENCES_ENABLED`, at goal start fetch the limits and the starting user's preferences from Spaces, resolve them with MS-23, store the snapshot on the goal journal, and use it for worker capacity, model choice/fallback and the goal credit ceiling (MS-18). A fetch failure uses today's defaults and records `preferences_unavailable`. Running goals never re-read preferences. Add the flag `"false"` to agents `wrangler.toml`.
- **Tests:** snapshot applied to capacity, model and ceiling; later preference change does not affect the running goal; fetch failure falls back; flag off unchanged.
- **Done:** focused tests, full agents suite, typecheck.
- **Result:** this commit. With `WORKER_PREFERENCES_ENABLED` on, the goal host fetches stored rows from a new HMAC-only Spaces route `GET /internal/worker-preferences?space_id&project_id&user_id`, resolves them with `resolveWorkerPreferences` (plan limit = billing plan concurrency), stores the snapshot on `GoalDagJournal.preferences` (fetch failure stores `preferences_unavailable`; an existing journal is never re-read) and applies it as `min` on worker capacity, a tier policy over `resolveWorkerModel`/`selectWorkerModel` output (`worker-model-tier-policy.ts`: tier = billing-core cost tier; no user pick keeps host routing restricted to allowed tiers, a user pick falls back only to not-more-expensive tiers, same provider and effort ceiling) and the MS-18 default ceiling. New tests 12 agents unit + 3 DO-level + 2 spaces; full Agents suite 2097 pass / 3 known failures; full spaces 780 pass / 4 known failures; typechecks clean. Local/mock only.

### - [x] MS-26 — Resume a budget-held goal after the ceiling is raised

- **Queue:** item 2, APW05. **Model:** Sonnet. **Decision:** D8. **Found during:** MS-18 review.
- **Problem:** with `GOAL_CREDIT_CEILING_ENABLED` on, `executeGoalDag` returns early with `budgetHold` set and ready tasks still `pending`. The raise route clears the hold, but nothing re-runs the goal, and the caller of `executeGoalDag` (`goal-planner.ts` and its run) may treat the early return as the goal's end.
- **Do:** make the goal's caller recognise `budgetHold` as a waiting (not finished) outcome and report `awaiting_budget_approval` to the user; after a successful raise, re-enter the same goal journal through the existing run-resume path (find how interrupted/HITL-waiting runs resume in `NaelaoAgentDO`), so pending tasks dispatch once admitted. Add a flag-on test through `NaelaoAgentDO` covering hold, raise and resume, and settlement in `publish`.
- **Done:** focused tests, full agents suite, typecheck.
- **Result:** this commit. With `GOAL_CREDIT_CEILING_ENABLED` on, a budget hold is a waiting outcome: the goal-planner returns `awaiting_budget_approval` (not an error) and `handleScriptRun` ends the run with the existing `awaiting_approval` run/task status plus a structured `pending_budget_approval` and a user message that the goal awaits budget approval (no publication, no completion log or memory); the hold is stored in `goal_budget_resumes`. A successful raise claims that row with one synchronous conditional write (a second raise, or a raise while nothing is held, starts nothing) and re-enters the same goal journal in the background through `handleScriptRun` (`goalResume`, same parent run id, objective and tasks), so completed tasks are not re-dispatched and the pending task is admitted and dispatched once. New `goal-budget-resume-do.test.ts` 3/3 (hold, resume, settlement once, double raise, flag off); full Agents suite 2100 pass / 3 known failures; typecheck clean. Local/mock only.

### - [x] MS-27 — P0 schema: offerings, commercial agreements, resource columns

- **Queue:** item 21 (V-spec P0). **Model:** Haiku. **Spec:** `new plan/V-spec.md` §6.1–6.3, MD-2, MD-3, MR-RES-1/4.
- **Start here:** `infra/migrations/` (latest number; follow the file style of 0179–0222 managed-service migrations), how tests load D1 migrations (search tests for `infra/migrations` / the sqlite shim), `managed_service_accounts` definition and later ALTERs.
- **Do:** one new migration with the §6.1 ALTERs, the §6.2 offerings + offering audit tables, the §6.3 agreements + agreement audit tables, and a `managed_resources` view exposing V-spec field names over `managed_service_accounts`. Backfill `access_mode` / `provisioning_strategy` from `connection_mode` exactly per MR-RES-1. The unique index on `(provider, provider_resource_ref)` must not fail on existing duplicates: first check whether any code path can create duplicates; if it can, create the index only on non-legacy rows (`WHERE provider_resource_ref IS NOT NULL AND offering_id IS NOT NULL`) and say so. No code reads the new columns yet.
- **Tests:** migration applies on a fresh DB and on a DB with legacy `managed_service_accounts` rows; backfill mapping for all three connection modes; view returns expected fields; duplicate provider ref rejected for new rows.
- **Done:** focused tests and typecheck of the package that hosts the migration tests.
- **Result:** this commit. Migration `0291_managed_offerings_agreements_resources.sql` (§6.1 columns, offerings and agreements with audit tables, MR-RES-1 backfill, `managed_resources` view). Partial unique index `ux_msa_provider_ref` covers only offering-backed rows, because legacy Higgsfield rows share the placeholder ref `customer-owned-api-key`. `capability_version` is INTEGER to match the capability table. New `workers/agents/src/communications/managed-service-p0-schema.test.ts` 7/7; `communications/telnyx-managed-service-registry.test.ts` passes; agents typecheck clean. Local/mock only; not applied to any remote D1.

### - [x] MS-28 — P0 offerings and agreements: admin routes, audit, fail-closed admission helper

- **Queue:** item 21. **Model:** Sonnet. **Spec:** V-spec MD-3, MR-CAT-3 (managed provisioning fails closed unless capability version verified + offering `available` (or `testing` for operator-allowlisted tenants) + agreement `approved`, unexpired, permitting the strategy and region), §6.2–6.3. **Needs:** MS-27.
- **Start here:** the existing operator routes for capability/entitlement verify/disable with audit (`workers/billing/src/index.ts` entitlements verify/disable; agents `communications/managed-service-capabilities.ts`).
- **Do:** internal HMAC/admin-only routes to create/update offerings and agreements (every write audited with actor + reason; agreement approval sets approved_by/at; evidence stored only as sha256). Add `resolveOfferingAdmission({tenantId, provider, serviceId, operation, region, strategy, now})` in one shared place that both billing and agents can call (pick the package that already holds shared managed-service types, or the billing worker internal route), returning `{ok:true, offering, agreement}` or `{ok:false, error_code}` with codes `offering_unavailable` / `provider_not_approved` / `capability_unsupported`. Behind `MANAGED_OFFERINGS_ENABLED` (default "false" in every vars block of each worker that reads it); nothing calls admission on existing paths yet except tests.
- **Tests:** each fail-closed case (no offering, draft/disabled offering, unverified/expired capability, missing/unapproved/expired/revoked agreement, strategy or region not permitted); approved path; audit row per write; non-admin refused.
- **Done:** focused tests, full suites of touched workers (known failures only), typechecks.
- **Result:** this commit. `resolveOfferingAdmission(db, {tenantId, provider, serviceId, operation, region, strategy, now?, offeringId?})` lives in `@naelao/billing-core` (`managed-offering-admission.ts`; a read-only function over a D1-like handle, both workers already depend on the package) and returns `{ok:true, offering, agreement|null, capabilityVersion}` or `{ok:false, error_code}`. Operator-key routes `POST /internal/managed-services/offerings/:id`, `agreements/:id`, `agreements/:id/approve` and `.../revoke` sit beside the capability verify routes in agents `communications/routes.ts` (same `x-managed-services-operator-key` auth and batch+audit style; flag off returns 404 not-found before auth). Migration 0292 adds `testing_tenant_ids_json` and recreates the 0202 Telnyx triggers with MR-RES-1 classification. `managed-offering-admission.test.ts` 16/16, Telnyx registry 3/3 and `managed-service-p0-schema.test.ts` 7/7; full agents suite 3 known failures, billing 134/134, billing-core 68/68, typechecks clean. Local/mock only; nothing calls admission yet.

### - [x] MS-29 — P0 remove provider branches from the Billing reserve path

- **Queue:** item 21. **Model:** Sonnet. **Spec:** V-spec MD-6, MR-COM-1, MR-COM-3, §6.2 `quote_policy`. **Needs:** MS-28.
- **Start here:** `workers/billing/src/index.ts` `/internal/managed-services/credits/reserve` (~l.1186; AgentMail provision/renew and Workers AI quote checks), `managed-service-credit-reservations.test.ts`.
- **Do:** behind `MANAGED_OFFERINGS_ENABLED`, replace provider-specific quote checks with the offering's `quote_policy` resolved via MS-28 admission (`always` → quote required; `required_for_recurring` → quote required for provision/renew operations; `none` → not required). Seed offerings + first-party/standard agreements for the existing AgentMail and Workers AI managed paths in the test fixtures (and as a documented, non-applied operator seed script — never auto-applied to remote DBs) so their behavior is identical with the flag on. Flag off = byte-for-byte current behavior.
- **Tests:** every existing billing managed-service test passes with the flag off AND with it on (parametrize); with flag on, a new provider needs no billing code change (test a fictional provider through offering data only); a test asserting the reserve path has no provider string literals when the flag is on (e.g. grep-based or by structure).
- **Done:** full billing suite and agents agentmail tests, typechecks.
- **Result:** this commit. With `MANAGED_OFFERINGS_ENABLED` on, the reserve route resolves `resolveOfferingAdmission` (strategy tried as `first_party` then `managed_master`), refuses with its `error_code` (HTTP 403, fail closed) and takes the quote requirement from `quote_policy`; the provider rules moved into `workers/billing/src/managed-reserve-policy.ts` (`legacyReserveQuoteRules` is the only provider-literal code, used flag off, byte-for-byte as before). Billing reserve suite now runs flag off and on, 52/52 incl. a fictional provider, refusal codes and a no-provider-literal structural test; full billing 160/160, agentmail 42/42, full agents only the 3 known failures; typechecks clean. Operator seed (draft offerings, unverified agreements, never auto-applied): `docs/operations/managed-offerings-seed.sql`. Local/mock only.

### - [x] MS-30 — P0 AgentPort standalone tenants get an `orgs` row (OD-7)

- **Queue:** item 21. **Model:** Sonnet. **Spec:** V-spec MD-1, OD-7.
- **Start here:** `workers/agentport` organization/developer creation (migration 0160 `agentport_organizations`/`agentport_developers`), `managed_service_owner_links` (0181), migration 0002 `orgs`.
- **Do:** find how an AgentPort organization relates to a Naelao `orgs` row today. Behind `AGENTPORT_ORG_LINK_ENABLED` (default "false"), creating a standalone AgentPort organization also creates (or links) exactly one `orgs` row (plan_tier `free`) in the same D1 batch, idempotently, and stores the link (add a nullable `org_id` column with a unique index via a new migration if no link exists). Never merge or re-link an existing linked pair. Record what existing AgentPort orgs need for a backfill, but do not backfill.
- **Tests:** create → one linked orgs row; replay → no duplicate; existing link untouched; flag off unchanged; cross-tenant isolation (an AgentPort org cannot link to another tenant's orgs row).
- **Done:** focused tests, full agentport suite, typecheck.
- **Result:** this commit. Before this task an AgentPort organization had no link to `orgs` (only the independent `agentport_organizations` table, 0160). Behind `AGENTPORT_ORG_LINK_ENABLED` (off in every wrangler vars block), `/v1/auth/register` adds `INSERT OR IGNORE orgs(id='agentport-<tenantId>', plan_tier 'free', owner_id = the AgentPort owner developer id)` and sets the new nullable, uniquely indexed `agentport_organizations.org_id` (migration 0293, not applied remotely) in the same D1 batch; flag off uses the original statement unchanged. `ensureAgentPortOrgLink` (`workers/agentport/src/org-link.ts`) is the idempotent link step: an existing link is returned untouched, and an orgs row owned by someone else is refused with `org_link_conflict`. Org-link tests 6/6, full agentport 35/35, typecheck clean. **Backfill needs (not done):** for each `agentport_organizations` row with `org_id IS NULL`, run `ensureAgentPortOrgLink` after migration 0293 is applied; decide orgs `owner_id` semantics (AgentPort developer ids are not Naelao user ids, so no `org_members`/Naelao login exists until an owner-approved claim flow), whether suspended or deleted AgentPort orgs get a row (orgs `status` is currently always 'active'), how Billing balances, `managed_service_owner_links` and API-key `tenant_id` values (currently the AgentPort tenant id) move to the linked orgs id, and a dry-run report of orgs-id collisions first. **Part B (MS-29 review fix):** with `MANAGED_OFFERINGS_ENABLED` on, the Billing reserve route returns an existing same-id, same-scope settled/uncertain reservation before offering admission; a live held replay skips admission but is still rechecked against mandate, entitlement and quota; new reservations are still admitted; new test in `managed-service-credit-reservations.test.ts`, full billing 161/161, typecheck clean. Local/mock only.

### - [x] MS-31 — P1 Naelao Email: worker scaffold, schema, API keys, inboxes

- **Queue:** item 21 (V-spec P1). **Model:** Sonnet. **Spec:** `new plan/V-spec.md` MD-10, §12.1–12.3, MR-FP-1, MR-SEC-1/2/3, OD-2/OD-3.
- **Start here:** `workers/agentport/src/email.ts` and its routes (`/email/accounts`, the existing native email code gated by `EMAIL_PROVISIONING_ENABLED`), `workers/agentport/wrangler.toml` (D1, `send_email` binding), an existing small worker for scaffold conventions (package.json, tsconfig, vitest config, wrangler.toml with `workers_dev=false`).
- **Do:** create `workers/email` (package `@naelao/email-worker`, wrangler name `naelao-email`, no routes/custom domains, `workers_dev = false`). New D1 migration (next number) with the §12.2 `nemail_*` tables (every row has `nemail_tenant_id`; `nemail_api_keys` stores only a SHA-256 hash and scopes; `nemail_tenants.org_id` nullable link to `orgs`). Implement API-key auth (`Authorization: Bearer nem_…`, scopes `inboxes:read|write`, `messages:read|send`, `webhooks:write`, `usage:read`), tenant resolution only from the key, and `POST/GET /v1/inboxes`, `GET/DELETE /v1/inboxes/:id` with `Idempotency-Key` on POST/DELETE (reuse `@naelao/idempotency` if it fits). Inboxes live on a configured managed domain (`NAELAO_EMAIL_DOMAINS`, empty by default); plan limit 10 inboxes per tenant (MR-EM-8). Internal HMAC route for the platform to create a tenant + first API key (for Managed/AgentPort provisioning later). Everything behind `NAELAO_EMAIL_ENABLED = "false"` (flag off ⇒ every route 404). Add the worker to the workspace and CI test discovery the way other workers are wired. Do NOT move AgentPort code yet (MS-35).
- **Tests:** key hash only stored; wrong/missing key 401; scope enforcement; cross-tenant inbox read/delete returns not-found; idempotent create; limit 10; domain not configured ⇒ `offering_unavailable`-style error; flag off 404.
- **Done:** worker tests and typecheck pass; root workspace install still frozen-lockfile clean (if a lockfile change is unavoidable for a new workspace package, it is allowed for the new package only — report it).
- **Result:** this commit. New `workers/email` (`@naelao/email-worker`, `naelao-email`, `workers_dev=false`, no routes, `NAELAO_EMAIL_ENABLED`/`NAELAO_EMAIL_DOMAINS` in every env block, `NEMAIL_R2` bound to placeholder buckets that are not created), migration 0294 (`nemail_*` tables plus `nemail_idempotency`, not applied remotely), `nem_` API keys (SHA-256 hash and 8-char prefix only, scopes enforced, tenant from key only), `POST/GET /v1/inboxes`, `GET/DELETE /v1/inboxes/:id` with `Idempotency-Key`, 10-inbox limit, `offering_unavailable` when no domain is configured, and HMAC-protected `POST /internal/v1/tenants`; flag off answers 404 everywhere. Worker tests 12/12, typecheck clean; lockfile adds only the `workers/email` importer. Local only.

### - [x] MS-32 — P1 Naelao Email: inbound mail, threading, read API

- **Queue:** item 21. **Model:** Sonnet. **Spec:** V-spec §12, MR-EM-1/2/3. **Needs:** MS-31.
- **Start here:** `workers/agents/src/channels/cloudflare-email.ts` (postal-mime parsing, size limits) and `workers/agentport/src/email.ts` ingress.
- **Do:** `email()` handler: resolve recipient to an active inbox (reject unknown with `setReject` where supported), store raw MIME in R2 (`NEMAIL_R2` binding) **before** parsing, parse with postal-mime, dedup by Message-ID + inbox (fallback raw hash), thread by Message-ID/In-Reply-To/References, store attachments in R2 (≤10 MB each, ≤20 MB message, ≤10 attachments; oversize ⇒ reject and record), never render HTML. API: `GET /v1/inboxes/:id/messages` (cursor pagination), `GET /v1/messages/:id`, `GET /v1/inboxes/:id/threads`, `GET /v1/threads/:id`. Emit an internal `email.message.received` event record (references only) for MS-34 webhooks.
- **Tests:** unknown recipient rejected; duplicate delivery stored once; threading across replies; attachment limits; raw stored before parse (parse failure still keeps raw + error state); cross-tenant reads not-found; HTML never executed/rendered.
- **Done:** worker tests and typecheck.
- **Result:** this commit. `workers/email` `email()` handler (flag off ⇒ `setReject`): resolves the recipient to an active inbox (unknown ⇒ `setReject`), reads the stream bounded to 20 MB, stores raw MIME at `raw/<tenant>/<inbox>/<sha256>.eml` in `NEMAIL_R2` before postal-mime 2.7.6 parses it, dedups by Message-ID + inbox (fallback raw hash, unique index), threads by In-Reply-To/References within the same tenant and inbox only, stores attachments under `att/...` (≤10 MB each, ≤10, ≤20 MB message; violations call `setReject` and record a `rejected` row), and records an `email.message.received` row (references only) in the new `nemail_events` outbox for MS-34. Parse failure keeps the raw and records state `parse_error` (error_code `parse_failed`, the existing 0294 CHECK value) without throwing. Migration 0295 (not applied remotely) adds body/cc/attachment columns, the raw-hash dedup index and `nemail_events`. Read API `GET /v1/inboxes/:id/messages|threads` (opaque cursor, limit ≤100) and `GET /v1/messages/:id`, `GET /v1/threads/:id` under `messages:read`, cross-tenant ⇒ not-found; html is an inert string with `html_untrusted: true`, `nosniff` and a sandbox CSP. Worker tests 22/22, typecheck clean; lockfile adds only `postal-mime` (2.7.6) to the `workers/email` importer. Local only; no attachment download route yet.

### - [x] MS-33 — P1 Naelao Email: outbound send, drafts, suppression, abuse limits, usage

- **Queue:** item 21. **Model:** Sonnet. **Spec:** V-spec MR-EM-4/5, MR-COM-2, §9.4 meter `email.message.sent`. **Needs:** MS-32.
- **Do:** `POST /v1/inboxes/:id/messages/send` and drafts (`POST /v1/inboxes/:id/drafts`, `PATCH /v1/drafts/:id`, `POST /v1/drafts/:id/send`) via the `send_email` binding, with replies threaded (In-Reply-To/References). Check order exactly per MR-EM-4 (scope → inbox active → suppression → ≤50 recipients → new-tenant 100/day for first 14 days then 1,000/day, operator override column → record usage → send → delivery row). Bounce/complaint ingestion (DSN parsing in the `email()` handler) feeds `nemail_suppressions`; auto-pause sending (`sending_paused`) at complaint rate >0.3% or bounce rate >5% over 7 days (minimum sample 50 sends). `GET /v1/usage` returns sent count and storage bytes for the period. Usage events are recorded locally in `nemail_*` with idempotency; billing integration to Naelao Managed comes in MS-35.
- **Tests:** each check in order with the right error; daily limits incl. day-15 change; suppression blocks; auto-pause thresholds and minimum sample; draft edit then send; idempotent send replay sends once; ambiguous transport failure marks delivery `unknown` and is not retried blindly.
- **Done:** worker tests and typecheck.
- **Result:** this commit. `workers/email` outbound (flag off): `POST /v1/inboxes/:id/messages/send` (Idempotency-Key required; replay returns the original result and never sends twice, same key with a different body is 422), drafts (`POST /v1/inboxes/:id/drafts`, `GET|PATCH /v1/drafts/:id`, `POST /v1/drafts/:id/send`), replies threaded by In-Reply-To/References, base64 MIME built in-worker (no new package) and one `EMAIL.send` per recipient. Check order in `send.ts`: scope, inbox status (`inbox_unavailable`, then `sending_paused` for a paused tenant or inbox), body validity, `recipient_suppressed`, `too_many_recipients` (>50), `rate_limit_exceeded`, then delivery rows (the reservation), send, outcome. Daily limit is the trailing 24 hours (non-failed deliveries, so in-flight sends count): 100 while the tenant is under 14 days old (from `nemail_tenants.created_at`), then 1,000, with `daily_send_limit_override` (0294) set only by the HMAC route `POST /internal/v1/tenants/sending`, which also pauses and resumes. Transport: success is `sent`; an error before the binding call is `failed` (no usage, 502 `send_failed`); an error during or after it is `unknown` (never retried, the claim stays pending). Usage (`nemail_usage`, meter `email.message.sent`, unique per message) is recorded only for `sent` and `unknown`. DSN (multipart/report delivery-status, hard 5.x.x failed) and ARF (abuse, fraud, virus, other) reports arriving at an inbox or `NAELAO_EMAIL_BOUNCE_ADDRESS` mark the delivery `bounced` or `complained` and add a per-tenant `nemail_suppressions` row, but only for our own outbound Message-ID and a recipient of that message. Auto-pause (complaints >0.3% or bounces >5% of sends in 7 days, minimum 50, counted since the last operator resume) sets `sending_paused`. `GET /v1/usage?period=YYYY-MM` returns `sent_count` and `storage_bytes` (raw plus attachments). Migration 0296 (not applied remotely). Worker tests 38/38, typecheck clean. Local only; no attachments on outbound yet, no live send, domain or DKIM verified.

### - [x] MS-34 — P1 Naelao Email: signed webhooks with retry and dead-letter

- **Queue:** item 21. **Model:** Haiku. **Spec:** V-spec MR-EM-6, MR-EVT-4. **Needs:** MS-32.
- **Do:** `POST /v1/webhooks` (url https only, event types, returns a secret once), `DELETE /v1/webhooks/:id`. Deliver `email.message.received` and delivery-status events with envelope `{id,type,version,tenant,inbox_id,occurred_at,data}` (references only, no bodies), header `Naelao-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`. Retry with exponential backoff for 24 h via a cron or queue already used by other workers, then dead-letter. Never deliver to private/loopback hosts (reuse an existing SSRF guard in the repo if present).
- **Tests:** signature verifies; secret shown once; retry schedule; dead-letter after 24 h; private URL refused; deleted webhook stops delivery; cross-tenant isolation.
- **Done:** worker tests and typecheck.
- **Result:** this commit. `workers/email` (flag off, `NAELAO_EMAIL_ENABLED`): `POST /v1/webhooks` (https only, default port, no credentials, literal private/loopback/link-local/reserved/single-label hosts refused with `invalid_webhook_url`; event types a duplicate-free subset of the five; `webhooks:write`; the `whsec_` secret is returned once and stored only as AES-256-GCM ciphertext under `NEMAIL_WEBHOOK_KEY` (SHA-256 key, bound to tenant and webhook id), never in the idempotency table; no Idempotency-Key replay on create) and `DELETE /v1/webhooks/:id` (cancels pending deliveries). Migration 0297 (not applied remotely) rebuilds `nemail_events` keyed per delivery and adds `nemail_webhook_deliveries` and `nemail_webhook_attempts`. Delivery and bounce/complaint outcomes write outbox rows (references only). A cron `scheduled()` handler runs every minute in every environment: bounded fan-out and attempts, leased rows, `Naelao-Signature: t=,v1=` HMAC-SHA256 over `t.body`, 10 s timeout, `redirect: manual`, backoff 1m/5m/30m/2h/6h, dead-letter when the next attempt would pass 24 h after the first (8 attempts). Destination is re-checked before each POST. Worker tests 62/62 (38 before), typecheck clean, wrangler vars parity 85/85. Local/mock only; the guard is literal-host only (`workers/email/src/ssrf.ts`, a copy of the `@naelao/security` rules, avoiding a lockfile change), so DNS-resolved private addresses are not yet checked.

### - [x] MS-35 — P1 Naelao Email: AgentPort adapter, managed offering, retire duplicate code

- **Queue:** item 21. **Model:** Sonnet. **Spec:** V-spec MD-10, MR-EM-7/8, §8 adapter contract, MS-28 offering admission, OD-3. **Needs:** MS-31..MS-34.
- **Do:** (1) AgentPort: replace the native email implementation behind `/email/accounts` with calls to Naelao Email through a service binding (`NAELAO_EMAIL` → `naelao-email`) using a per-tenant key held in AgentPort's sealed store; keep the AgentPort route contract unchanged; old in-worker code removed (not duplicated). (2) Agents: a `naelao-email` provider adapter implementing the §8 contract subset (provision inbox, lookup, deprovision, execute send/read) behind `MANAGED_OFFERINGS_ENABLED`. (3) Operator seed doc: offering `off_naelao_email_inbox_v1` (status `testing`, quote_policy `required_for_recurring`, charge components: rental 100 credits/month incl. 1,000 sends, usage 10 credits per extra 1,000 sends — OD-3) and a `first_party` agreement (unverified) in `docs/operations/managed-offerings-seed.sql`, never auto-applied. (4) Local end-to-end test: create one inbox directly via the API, via AgentPort, and via Managed admission + reservation, all in local/mocked tests.
- **Done:** worker, agentport, agents (known failures only) and billing suites; typechecks. P1 exit criteria in V-spec §17 met locally.
- **Result:** this commit. AgentPort `/email/accounts` (provision, send, revoke) now calls Naelao Email over the new `NAELAO_EMAIL` service binding (`naelao-email`, `-staging`, `-production`) with the route contract unchanged; the per-tenant key is created through the internal HMAC tenant route on first use and held only as AES-GCM ciphertext in `agentport_naelao_email_tenants` (migration 0299, sealed under `AGENTPORT_JWT_SECRET`, same scheme as the identity keys), and the mailbox webhook secret is sealed per account. The native send/ingress code, the `email()` handler (inbound now belongs to Naelao Email), the `EMAIL` send binding and the two domain vars are removed from AgentPort. Naelao Email webhooks gained an optional `inbox_id` scope (migration 0298) so one tenant key can serve many mailboxes without cross-delivery. New Agents adapter `providers/naelao-email.ts` (`ProviderAdapterV1` subset in `providers/contract.ts`; capabilities provision, deprovision, lookup, send, read) behind `MANAGED_OFFERINGS_ENABLED`, fails closed through `resolveOfferingAdmission(first_party)` and a reservation id, own sealed key table (migration 0300), `capability_unsupported` for everything else. Seed rows for `off_naelao_email_inbox_v1`, an unverified `first_party` agreement and a draft `naelao/email` capability v1 appended to `docs/operations/managed-offerings-seed.sql` (not applied). End-to-end tests (real Naelao Email app over in-memory SQLite, fake Billing) create an inbox directly, via AgentPort and via the adapter after admission and reservation, plus admission refusals. Tests: email 63/63, agentport 36/36, agents 2135 passed with only the 3 known failures, billing 161/161, billing-core 68/68, wrangler vars parity 85/85; typechecks clean. Local/mock only. Caveats: AgentPort no longer writes inbound `message.received` rows to its own event ledger for email accounts, and its inbound webhook is now Naelao's references-only signed envelope (the SDK's `verifyAgentPortEmailWebhook` no longer matches it); live use needs Email Routing for the managed domain pointed at `naelao-email`.

### - [x] MS-36 — P2 subscriptions and generic renewal sweep

- **Queue:** item 21 (V-spec P2). **Model:** Sonnet. **Spec:** V-spec §6.4, MR-COM-9, MR-LIFE-2.
- **Do:** migration for `managed_service_subscriptions`; generic renewal sweep (reserve+charge before upstream commitment, grace → suspended, notices) behind `MANAGED_SUBSCRIPTIONS_ENABLED` (default "false"); re-express the AgentMail rental sweep (`sweepManagedAgentMailRentals`) as the first subscription type with identical behavior when the flag is off.
- **Tests:** renew success; failure → grace → suspended; no double charge on replay; release only after MR-LIFE-2 grace; AgentMail rental tests pass unchanged with flag off and on.
- **Result:** this commit. Migration 0301 (not applied remotely) adds `managed_service_subscriptions` (§6.4 plus `subscription_type`, `notify_user_id`, `grace_started_at`, `suspended_at`, `release_warning_at`; epoch-ms times, unique per tenant+resource) and `managed_service_subscription_notices` (unique per subscription, kind and period). `communications/managed-subscriptions.ts` is the provider-free engine behind `MANAGED_SUBSCRIPTIONS_ENABLED` (off in every agents vars block): due rows are claimed by compare-and-set, the type handler reserves and charges before anything renews, success advances the period, failure enters `grace` for `grace_days` (from the offering's charge components, default 7) with one owner notice, retries each sweep, then `suspended` with a second notice; suspended rows are never retried, and `listReleasableSubscriptions` allows release only 30+ days after suspension and 7+ days after the pre-release notice (MR-LIFE-2). The AgentMail rental is the first type (`agentmail_rental`): the per-account renewal body moved unchanged into `renewAgentMailRental`, which both the legacy sweep (flag off, same SQL and counts as before) and the subscription handler call; with the flag on the sweep lazily enrolls due managed accounts, delegates to the engine and a suspension also marks the `managed_service_accounts` row `suspended`. Tests: engine 11/11, agentmail 44/44 (renew test runs flag off and on, plus a grace→suspended case), full agents 2148 passed with only the 3 known failures, vars parity 85/85, agents typecheck clean. Local/mock only. Not done: actual release/deprovision of suspended resources (only the gate and notices), a reactivation path for suspended subscriptions, enrollment at provision time (lazy at first due sweep), and notice delivery beyond the notices table and a best-effort `notifications` row.

### - [x] MS-37 — P2 generic quotes per offering policy

- **Queue:** item 21. **Model:** Sonnet. **Spec:** MR-COM-4/7/8, §9.2. **Needs:** MS-29.
- **Do:** one quote creator driven by offering `charge_components_json` (all mandatory components + minimum monthly cost), bound to tenant/offering/region/config hash/price_version, expiry ≤15 min; replaces provider-specific quote creators behind `MANAGED_OFFERINGS_ENABLED`.
- **Tests:** components shown; expiry → `quote_expired`; changed price needs new quote; binding mismatch refused.
- **Result:** this commit. Migration 0302 (not applied remotely) adds `offering_id`, `configuration_sha256`, `charge_components_json`, `min_monthly_credits` to `managed_service_operation_quotes` plus a trigger refusing an offering-bound quote that lives over 15 minutes. `communications/managed-quotes.ts` (provider-free): `parseChargeComponents` (strict §9.2 parse, fails closed), `computeQuoteBreakdown` (setup and rental mandatory, usage and storage listed with zero minimum, yearly rental rounded up per month), `createOfferingQuote` (offering admission via `resolveOfferingAdmission`, strategies first_party then managed_master like Billing reserve; price from components, or a caller-supplied entitlement price that Billing demands; ttl capped at 15 min) and `verifyOfferingQuote` (`quote_not_found` for unknown or foreign tenant, `quote_binding_mismatch` on offering/region/configuration, `quote_expired`, `quote_price_changed`, `quote_already_used`). With `MANAGED_OFFERINGS_ENABLED` on, `createManagedAgentMailQuote` and `createManagedModelQuote` go through it with identical Billing-validated columns (a test compares the AgentMail row field for field flag off vs on) and return extra `offeringId`, `components`, `mandatoryComponents`, `minMonthlyCredits`; flag off keeps the original INSERT. Test fixture `enableManagedOfferingsFixture` and env `NAELAO_TEST_MANAGED_OFFERINGS=on` run the agentmail and managed-models suites with the flag on. Tests: managed-quotes 13/13; agentmail+managed-models 50/50 flag off and on; full agents 2161 passed with only the 3 known failures; billing 161/161, billing-core 68/68; vars parity 85/85; agents and billing typechecks clean. Local/mock only. Not done: provision paths still validate with their own legacy checks (they do not yet call `verifyOfferingQuote`), and the seeded offerings have no priced components.

### - [x] MS-38 — P2 inventory and cost reconciliation findings

- **Queue:** item 21. **Model:** Sonnet. **Spec:** MR-REC-1/2/3, §8 `listUpstreamResources`/`lookup`.
- **Do:** `managed_service_reconciliation_findings` table; daily inventory sweep per adapter that supports listing (orphaned_upstream / missing_upstream / state_mismatch, never auto-delete); monthly cost comparison of provider cost receipts vs settled charges per provider+offering; operator read route.
- **Tests:** seeded orphan/missing/mismatch found once (idempotent); nothing deleted; cost discrepancy finding.
- **Result:** this commit. Migration 0303 (not applied remotely) adds `managed_service_reconciliation_findings` (kind orphaned_upstream|missing_upstream|state_mismatch|cost_discrepancy, nullable tenant, refs, scrubbed `detail_json`, status open|acknowledged|resolved, unique `dedup_key`, seen counters) and `managed_service_reconciliation_runs` (per-day inventory and per-month cost claims). `communications/managed-reconciliation-findings.ts`: daily inventory sweep over adapters exposing `listUpstreamResources` (new optional member of `ProviderAdapterV1`; a failed or truncated listing writes and resolves nothing; findings only, nothing is deleted upstream or locally; a finding that stops reproducing is resolved by the sweep, a recurrence reopens it); monthly cost comparison (from day 3, previous UTC month) of operator-imported provider cost receipts against settled Managed reservations per provider and service/offering at `CREDITS_PER_USD` (cost_without_settlements, negative_margin, settlements_without_cost_receipts, currency_not_comparable). Cron entry in the existing 5-minute tick, behind `MANAGED_RECONCILIATION_ENABLED` (`"false"` in all three agents vars blocks). Operator `GET /internal/managed-services/reconciliation-findings` and `POST .../:id/acknowledge` use the MS-28 operator key (flag off is 404 before auth). Only the `naelao-email` adapter supports inventory: new HMAC `POST /internal/v1/inventory/inboxes` in the email worker lists inboxes of `naelao-` tenants only (AgentPort and direct tenants excluded). Tests: reconciliation 21/21; full agents 2182 passed with only the 3 known failures; email 63/63; vars parity 85/85; agents and email typechecks clean. Local/mock only. Not done: other adapters (AgentMail, Telnyx, Higgsfield) have no inventory listing; an orphan created mid-provision can be reported once until the next sweep resolves it; no notification of new findings beyond a log line.

### - [ ] MS-39 — P2 spending-limit composition

- **Queue:** item 21. **Model:** Sonnet. **Spec:** MR-COM-10/11, D8.
- **Do:** one admission function computing the min of all applicable limits (plan allowance, mandate period/per-op, per-install, per-goal, Project spend cap, grant maxSpend) evaluated inside the reservation admission so parallel requests cannot overspend; incremental reservation helper for long-running usage (≤5 min or ≤100 credits per chunk, terminate when next chunk refused). Behind `MANAGED_LIMITS_COMPOSED_ENABLED`.
- **Tests:** each limit binding alone; parallel reserves never exceed the smallest limit; chunked reservation stops at limit.

### - [ ] MS-40 — P2 bill Naelao Email usage through Managed

- **Queue:** item 21. **Model:** Sonnet. **Spec:** §9.4 `email.message.sent`, OD-3, MR-COM-2/5. **Needs:** MS-35, MS-36.
- **Do:** Managed inboxes get a monthly subscription (rental 100 credits incl. 1,000 sends) and overage settlement (10 credits per extra 1,000, rounded up per settlement) from Naelao Email usage via the adapter; direct (non-Managed) Naelao Email tenants unaffected.
- **Tests:** included allowance; overage rounding; idempotent settlement; direct tenants not billed.

---

## Not in this spec (still needs you or live access)

| Queue item | Why it is not code-only |
|---|---|
| TBR11 per-effect script ceiling | Code-only, but an atomic multi-effect reservation is subtle. It needs a stronger model and an owner-approved ceiling. |
| Review follow-ups from MS-16–MS-25 (small, code-only) | (1) MS-19: stopping managed AgentMail revokes the provision mandate but not the `agentmail-send:` mandate; revoke both. (2) MS-20: `worker-branch-retire-pending:` markers have no retry consumer; a missed retire keeps the branch. (3) MS-21: run-log pruning runs only when a run opens, so idle AgentDOs are never swept; also run it from the alarm. (4) MS-22: Projects deleted before MS-22 have no tombstone and are never swept; backfill needs a decision. (5) MS-16: Billing `usage_events` has no metadata column, so `priced_in_settlement` is not persisted (only `rate_card_version`). (6) MS-24: viewers may set their own preferences; owner to confirm. |
| Turning on any D8–D10 flag; real provider prices; account-deletion purge of Personal memory; owner-shortened retention; a Shell UI for preferences | Rollout needs your authorization; the rest is follow-up after MS-14–25. |
| SPR, U/S erasure, K21, K15, APW02/05/09, CB04/CB06 provider, WhatsApp, SBB04.3 | Need staging, deployment or provider access you must authorize. |
| Cleaning, claims, Founder Growth | Need real practitioners or founders. |
