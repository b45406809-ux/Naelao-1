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
   `workers/spaces/src/do/SpaceDO.ts` (the current last version is **162**). Update
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

### - [ ] MS-08 — Shell: Stop button on Project task detail

- **Queue:** item 2. **Model:** Haiku. **Depends on:** MS-07.
- **Do:**
  - Show **Stop task** only to users the API would allow: hide it on a 403 from a dry
    authorization, or use the role data already loaded on the page.
  - Reuse the warning copy from `StopDurableTaskButton`: *"It may finish or be interrupted;
    committed external effects are not undone."*
  - After stopping, show the receipt outcome. For `uncertain`, say *"We couldn't confirm the stop.
    Check the result before retrying."*
- **Done:** Shell typecheck passes (rule 3).

### - [ ] MS-09 — Deterministic worker-output conflict candidates

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

### - [ ] MS-10 — Versioned worker-definition parser (not host-bound)

- **Queue:** item 1/2, APW08. **Model:** Sonnet. **Decision:** D6.
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

### - [ ] MS-11 — Identity-complete semantic response-cache key

- **Queue:** item 8, K20. **Model:** Sonnet. **Decision:** D7.
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

### - [ ] MS-12 — AgentMail remaining local control tests

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

---

## Not in this spec (still needs you or live access)

| Queue item | Why it is not code-only |
|---|---|
| EP06 quotes, APW05 credit ceilings, CB06 payer/price | Need real prices and caps from you. |
| PW01 branch retention, APW04 memory retention | Need retention durations from you. Building a deletion mechanism with no policy would delete nothing. |
| TBR11 per-effect script ceiling | Code-only, but an atomic multi-effect reservation is subtle. It needs a stronger model and an owner-approved ceiling. |
| APW06 topology/budget preferences | Need an authority/precedence decision from you. |
| SPR, U/S erasure, K21, K15, APW02/05/09, CB04/CB06 provider, WhatsApp, SBB04.3 | Need staging, deployment or provider access you must authorize. |
| Cleaning, claims, Founder Growth | Need real practitioners or founders. |
