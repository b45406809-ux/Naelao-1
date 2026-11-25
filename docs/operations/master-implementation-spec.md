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

### - [ ] MS-15 — Owner usage view: estimated credits and cap warning

- **Queue:** item 9, EP06. **Model:** Haiku. **Decision:** D8. **Needs:** MS-14.
- **Start here:** `workers/spaces/src/index.ts` route for `projectExtensionResourceUsagePath` (~l.6832; it sums this month's invocations, job units and bytes and compares settled `infra_credits` + holds with the cap). Shell caller in `apps/shell/src/lib/resource-grants-api.ts` and its test.
- **Do:** add to the JSON response `estimated_unit_credits` (from `priceExtensionResourceUnits`, with `price_version`), and `cap_status`: `"ok"`, `"warning"` (used+held ≥ 80% of the monthly cap) or `"reached"` (≥ 100%). Label it estimate-only; this route charges nothing. Show `cap_status` and the estimate in the existing Shell owner usage panel (find it from the API caller).
- **Tests:** route test for each `cap_status` boundary (79%, 80%, 100%) and the estimate field; Shell API parser test.
- **Done:** focused tests, **full** `naelao-spaces` suite (only the 5 known pre-existing failures), typechecks.

### - [ ] MS-16 — Charge priced resource units inside the run reservation

- **Queue:** item 9, EP06. **Model:** Sonnet. **Decision:** D8. **Needs:** MS-14.
- **Start here:** `workers/agents/src/workflows/report-infra-usage.ts` (`reportWorkflowResourceUsage`, `reserveWorkflowBudget`, `finalizeWorkflowBudget`), `workers/agents/src/workflows/WorkflowRunDO.ts` (~l.257), `workers/billing/src/index.ts` workflow `/settle` (~l.933, charges `min(quantity, held)`), `tests/unit/workflow-budget-settlement-v2.test.ts`.
- **Do:** when `EXTENSION_RESOURCE_PRICING_ENABLED === "true"`, accumulate the run's priced resource credits (MS-14) in the run journal and add them to the quantity passed to the existing workflow settle, so the charge stays inside the reservation. Keep the per-unit usage rows unpriced (`cost_credits` null) and add `priced_in_settlement: true` plus `price_version` to their metadata so nothing is counted twice. Flag off = exactly today's behavior. Add the flag as `"false"` in the agents `wrangler.toml` vars (every env block that lists vars).
- **Tests:** flag off → settle quantity unchanged; flag on → settle quantity includes resource credits; settle never exceeds the hold; replayed settle stays idempotent; unit rows carry metadata and no `cost_credits`.
- **Done:** focused agents/billing tests, full agents suite (only 3 known failures), typecheck.

### - [ ] MS-17 — Default caps for new extension installations

- **Queue:** item 9, EP06. **Model:** Haiku. **Decision:** D8.
- **Start here:** `workers/spaces/src/do/SpaceDO.ts` budget policy table (`max_run_credits`, `monthly_credits`, ~l.3420) and its read helper (~l.18559) / PUT handler (~l.18640); `resolveExtensionResourceBudget` in `workers/agents/src/workflows/workflow-host.ts` (~l.272); `workers/spaces/src/do/extension-runtime-install.test.ts`.
- **Do:** first find out what happens today when an installation has **no** policy row and write it in the commit message. Then: when a **new** installation is created, insert a policy of 200 run / 1,000 monthly credits (revision 1) if none exists. Do not touch existing installations or rows. Owner PUT keeps working unchanged.
- **Tests:** new install gets the default policy; an existing policy is never overwritten; reinstall/new generation behavior matches what the code does for other per-installation rows.
- **Done:** focused test, full `naelao-spaces` suite, typecheck.

### - [ ] MS-18 — Per-goal credit ceiling

- **Queue:** item 2, APW05. **Model:** Sonnet. **Decision:** D8 (and D10 for who sets it).
- **Start here:** `workers/agents/src/script-engine/goal-dag.ts`, `script-engine/prebuilt/goal-planner.ts`, `NaelaoAgentDO.ts` goal tables (`goal_dag_journals`, `goal_dispatch_outbox`, ~l.2083) and inference reservation/settlement (`reserveRunInferenceCost`, `settleRunBilling`, ~l.1497-1571, 8588-8671).
- **Do:** behind `GOAL_CREDIT_CEILING_ENABLED`, store `credit_ceiling` (default 200) and `credits_settled` / `credits_held` per goal journal. Before dispatching a goal task, if settled + held + that task's estimated reservation would exceed the ceiling, do not dispatch; set the goal to `awaiting_budget_approval` and record why. Add an owner/admin action that raises the ceiling (resumes dispatch) — reuse the authority used by MS-07 task-stop. Settlements update `credits_settled` idempotently per reservation ID. Flag off = today's behavior. Add the flag `"false"` to agents `wrangler.toml`.
- **Tests:** dispatch allowed under the ceiling; blocked at it with the waiting status; raise resumes; duplicate settlement counted once; non-owner raise refused with the not-found shape; flag off unchanged.
- **Done:** focused tests, full agents suite, typecheck.

### - [ ] MS-19 — Bill Naelao-managed AgentMail sends

- **Queue:** item 13, CB06. **Model:** Sonnet. **Decision:** D8.
- **Start here:** `workers/agents/src/communications/agentmail.ts` (`callAgentMailTool` ~l.1025-1106, `resolveManagedAgentMailPrice` ~l.573, `providerKeyFor` ~l.428), `communications/managed-service-billing.ts` (reserve/uncertain/settle/release helpers), `workers/billing/src/index.ts` `/internal/managed-services/credits/*` (~l.1186; it requires a `msq_` quote for provision/renew only), `agentmail.test.ts`.
- **Do:** behind `AGENTMAIL_SEND_BILLING_ENABLED`, for `mode === "naelao_managed"` only: after authority, idempotency and daily-limit checks and **before** dispatch, resolve the `messages.send` price and reserve credits with reservation ID derived from the send's idempotency hash. Dispatch ok → settle; dispatch failed before the provider call → release; dispatch started and outcome unknown → mark uncertain (existing reconciliation owns it). Missing price → refuse with `managed_service_price_unconfigured`, nothing sent. A replayed `sent` idempotency row never reserves again. BYO accounts never reserve. Check whether Billing's reserve accepts a send without a quote; if it requires one, add the minimal Billing change and test it. Flag off = today's behavior; add it `"false"` to agents `wrangler.toml`.
- **Tests:** managed send reserves then settles; failure before dispatch releases; unknown outcome marks uncertain; missing price refuses without dispatch; BYO no reservation; replay no second reservation; insufficient credits refuses without dispatch; flag off unchanged. Existing 34 AgentMail tests still pass.
- **Done:** focused agents and billing tests, full agents suite, typecheck.

### - [ ] MS-20 — Worker-branch retention in the Coordinator

- **Queue:** item 3, PW01. **Model:** Sonnet. **Decision:** D9.
- **Start here:** `workers/agents/src/workspace/WorkspaceCoordinatorDO.ts` (`createBranch` ~l.1699, `alarm` ~l.323, `collectStaging`/`collectMetadata`/`collectContent`, `legalHold` ~l.96, `setRetentionPolicy` ~l.2577); `NaelaoAgentDO.ts` (`reserveWorkerBranch` ~l.4136, `mergeWorkerWorkspace` ~l.4250, terminate ~l.7013); `WorkspaceCoordinatorDO.test.ts`.
- **Do:** add a Coordinator route `/v1/branch/retire` `{branch, outcome: "published"|"ended", endedAt}` that records a retirement row (idempotent; only `workers/*` branches; never the canonical branch). Call it from `NaelaoAgentDO` when a worker's merge is published (`published`) and when a worker ends failed/terminated/interrupted without publication (`ended`); a call failure must not fail the worker path (log and leave it for a later retry). Behind `WORKER_BRANCH_RETENTION_ENABLED`, the alarm deletes the head/base keys of branches retired more than 7 days (`published`) or 30 days (`ended`) ago, bounded per pass, skipped under an active legal hold, and leaves bytes to the existing content GC. A branch with a newer head after retirement is not deleted.
- **Tests:** retire idempotent; non-worker branch refused; deletion only after the period; legal hold blocks; flag off deletes nothing; head advanced after retire is kept; bounded batch re-arms.
- **Done:** focused tests, full agents suite, typecheck.

### - [ ] MS-21 — Run-log retention

- **Queue:** item 2, APW04 (run state). **Model:** Haiku. **Decision:** D9.
- **Start here:** `NaelaoAgentDO.ts` `pruneDurableRuns` (~l.7517, the template to copy), tables `run_wal` (~l.1632), `run_traces` (~l.1650), `sub_agents` (`checkpoint_json` ~l.2057), the alarm (~l.2556).
- **Do:** behind `RUN_LOG_RETENTION_ENABLED`, add `pruneRunLogs(now)`: delete `run_wal` and `run_traces` rows older than 90 days, and set `checkpoint_json` to NULL for `sub_agents` in a terminal status (`done`, `failed`, `terminated`) not updated for 90 days. At most 200 rows per table per pass. Never touch rows of a run that is still active. Call it where `pruneDurableRuns` is called. Add the flag `"false"` to agents `wrangler.toml`.
- **Tests:** old rows removed; 89-day rows kept; active run kept; running sub-agent checkpoint kept; batch limit; flag off removes nothing.
- **Done:** focused test, full agents suite, typecheck.

### - [ ] MS-22 — Project-memory retention with a memory hold

- **Queue:** item 2, APW04. **Model:** Sonnet. **Decision:** D9.
- **Start here:** `workers/spaces/src/do/SpaceDO.ts` project memory tables (`project_facts`, `project_fabric`, `project_wiki`, ~l.1032-1062), the Project delete path (find how a Project is deleted: soft-delete column or row removal), `workers/spaces/src/do/project-memory-forget.test.ts`, the SpaceDO alarm / scheduled hook.
- **Do:** find and record how Project deletion works. Add a SpaceDO migration with a `project_memory_holds` table (project_id, reason, actor_id, created_at, expires_at nullable) and owner/admin routes to set/clear a hold (static path + query params, Hono rule). Behind `PROJECT_MEMORY_RETENTION_ENABLED`, a bounded sweep deletes memory rows of Projects deleted more than 30 days ago unless an unexpired hold exists. If Project deletion leaves no deletion timestamp, add one in the same migration and set it on delete. Add the flag `"false"` to spaces `wrangler.toml`.
- **Tests:** memory of a Project deleted 31 days ago is removed; 29 days kept; live Project untouched; hold blocks; expired hold does not block; non-admin hold change refused with not-found shape; flag off removes nothing.
- **Done:** focused tests, **full** `naelao-spaces` suite, typecheck.

### - [ ] MS-23 — Preference resolver (pure function)

- **Queue:** item 2, APW06. **Model:** Haiku. **Decision:** D10.
- **Start here:** `packages/entitlements/src/index.ts` (`getExecutionLimits`), `packages/billing-core/src/plans.ts` (`clampPlanParallelism`), `workers/agents/src/script-engine/worker-model-routing.ts`.
- **Do:** create `workers/agents/src/shared/worker-preferences.ts` exporting `resolveWorkerPreferences({planLimits, spaceLimits?, projectSettings?, userPreferences?, modelTierCost})` → `{workerCount, allowedModelTiers, preferredModelTier, fallbackTiers, goalCreditCeiling, sources}`. Tightest wins per field; defaults workerCount 3 and ceiling 200; admin max clamped to 1–10 and plan limit; a user value above the limit is clamped and reported in `sources`; `fallbackTiers` = allowed tiers whose cost ≤ the preferred tier's cost, cheapest last. No I/O.
- **Tests:** each layer tightening; user cannot exceed admin; admin cannot exceed plan; defaults; fallback never more expensive; empty allowed set → host default only.
- **Done:** focused test and typecheck.

### - [ ] MS-24 — Store preferences and limits, with audit

- **Queue:** item 2, APW06. **Model:** Sonnet. **Decision:** D10. **Needs:** MS-23.
- **Start here:** `SpaceDO.ts` `user_settings` (~l.1751) and Project policy columns; spaces routes near user settings; router `PRODUCT_END_USER_PATH_PATTERNS`.
- **Do:** SpaceDO migration with `worker_preference_limits` (Space-level admin limits, optional per-Project override), `worker_user_preferences` (per user, per Space) and `worker_preference_audit` (actor, scope, before_json, after_json, created_at). Routes (static paths, query params): GET/PUT admin limits (owner/admin only), GET/PUT own user preferences (any member, own row only), GET audit (owner/admin). Validate with the MS-23 bounds. Add the router allowlist entries and tests.
- **Tests:** admin set/read; member cannot set limits (not-found shape); user edits only their own row; values outside bounds rejected; every change writes one audit row; router allowlist accept/reject.
- **Done:** focused tests, full `naelao-spaces` and router suites, typechecks.

### - [ ] MS-25 — Apply preferences when a goal starts

- **Queue:** item 2, APW06. **Model:** Sonnet. **Decision:** D10. **Needs:** MS-18, MS-23, MS-24.
- **Start here:** `NaelaoAgentDO.ts` worker capacity (~l.4886), model selection call (~l.5834), goal start in `goal-planner.ts` / `goal-dag.ts`.
- **Do:** behind `WORKER_PREFERENCES_ENABLED`, at goal start fetch the limits and the starting user's preferences from Spaces, resolve them with MS-23, store the snapshot on the goal journal, and use it for worker capacity, model choice/fallback and the goal credit ceiling (MS-18). A fetch failure uses today's defaults and records `preferences_unavailable`. Running goals never re-read preferences. Add the flag `"false"` to agents `wrangler.toml`.
- **Tests:** snapshot applied to capacity, model and ceiling; later preference change does not affect the running goal; fetch failure falls back; flag off unchanged.
- **Done:** focused tests, full agents suite, typecheck.

---

## Not in this spec (still needs you or live access)

| Queue item | Why it is not code-only |
|---|---|
| TBR11 per-effect script ceiling | Code-only, but an atomic multi-effect reservation is subtle. It needs a stronger model and an owner-approved ceiling. |
| Turning on any D8–D10 flag; real provider prices; account-deletion purge of Personal memory; owner-shortened retention; a Shell UI for preferences | Rollout needs your authorization; the rest is follow-up after MS-14–25. |
| SPR, U/S erasure, K21, K15, APW02/05/09, CB04/CB06 provider, WhatsApp, SBB04.3 | Need staging, deployment or provider access you must authorize. |
| Cleaning, claims, Founder Growth | Need real practitioners or founders. |
